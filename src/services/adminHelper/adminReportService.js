/**
 * adminReportService.js — @admin-Meldungs-Feature (1.6.73)
 *
 * Workflow:
 *  1. User antwortet auf eine Nachricht mit "@admin" → commandHandler erkennt es
 *  2. handleAdminReport() wird aufgerufen:
 *     a) Channel-Bestätigung "Meldung an Admins erfolgreich!"
 *     b) Wenn admin_report_ai_enabled: Grok bewertet (advertising/scam/spam/insult/other)
 *     c) Wenn admin_report_actions[category] gesetzt: automatische Konsequenz ausführen
 *     d) Privatnachricht an alle Channel-Owner mit Zusammenfassung
 *     e) Audit-Eintrag in admin_reports
 */
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");
const xaiService = require("../xaiService");

const REPORT_CATEGORIES = ["advertising", "scam", "spam", "insult", "other"];
const REPORT_CATEGORY_LABELS = {
  advertising: "📢 Werbung",
  scam:        "⚠️ Scam",
  spam:        "🚫 Spam",
  insult:      "😠 Beleidigung",
  other:       "📦 Sonstiges"
};

/**
 * Erkennt @admin-Mention in einer Nachricht.
 * Akzeptiert: "@admin", "@admins", "@admin bitte mal schauen", etc.
 * Case-insensitive.
 */
function detectAdminMention(text) {
  if (!text) return false;
  return /(?:^|\s)@admins?(?:\b|\s|$)/i.test(String(text));
}

/**
 * Klassifiziert eine gemeldete Nachricht via Grok.
 * Returns: { category, confidence, summary } oder null bei Fehler.
 */
async function classifyReport(reportedText, contextText) {
  if (!reportedText) return null;

  const systemPrompt =
    "Du bist ein Moderationssystem für eine Telegram-Gruppe. " +
    "Du bekommst eine Nachricht die ein User mit @admin gemeldet hat. " +
    "Klassifiziere die GEMELDETE Nachricht in genau EINE Kategorie:\n" +
    "- advertising = unerlaubte Werbung (Links zu externen Shops, Promo-Codes, fremde Telegram-Gruppen die nichts mit dem Channel zu tun haben)\n" +
    "- scam = Betrugsversuch (Phishing, fake Produkte, falsche Versprechen, Geldforderungen)\n" +
    "- spam = Spam-Nachrichten (Wiederholungen, Off-Topic-Massen, Bot-Nachrichten)\n" +
    "- insult = Beleidigungen, Hetze, persönliche Angriffe\n" +
    "- other = sonstiges/unklar/legitime Frage/kein klares Vergehen\n\n" +
    "Antworte AUSSCHLIESSLICH als JSON: {\"category\":\"...\",\"confidence\":0.0-1.0,\"summary\":\"kurze Begründung (max 80 Zeichen)\"}";

  const userPrompt =
    `Gemeldete Nachricht:\n"${String(reportedText).substring(0, 500)}"\n\n` +
    (contextText ? `Kontext (was der Melder geschrieben hat):\n"${String(contextText).substring(0, 200)}"\n\n` : "") +
    `Klassifiziere die gemeldete Nachricht.`;

  try {
    const res = await xaiService.chat([
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ], { model: "grok-4.20-0309-non-reasoning", max_tokens: 200, temperature: 0.1 });

    const txt = res?.content || res?.text || "";
    // JSON aus Antwort extrahieren (Grok wrapped manchmal in ```json oder Vorworten)
    const jsonMatch = txt.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!REPORT_CATEGORIES.includes(parsed.category)) parsed.category = "other";
    parsed.confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0));
    parsed.summary    = String(parsed.summary || "").substring(0, 200);
    return parsed;
  } catch (e) {
    logger.warn(`[adminReportService] AI-Klassifizierung Fehler: ${e.message}`);
    return null;
  }
}

/**
 * Führt die konfigurierte Konsequenz aus (mute/ban/delete/warn/none).
 * Returns: ausgeführte Aktion oder "none".
 */
async function executeAction(tg, channelId, action, target, reportedMsgId, reason) {
  if (!action || action === "none") return "none";
  if (!target?.id) return "none";

  const now = Math.floor(Date.now() / 1000);
  try {
    switch (action) {
      case "warn":
        await tg.call("sendMessage", {
          chat_id: channelId,
          text: `⚠️ <b>Verwarnung</b> für ${target.username ? "@" + target.username : "User " + target.id}\n<i>${reason || "Verstoß gegen Community-Regeln"}</i>`,
          parse_mode: "HTML",
          ...(reportedMsgId ? { reply_to_message_id: reportedMsgId } : {})
        }).catch(()=>{});
        return "warn";
      case "delete":
        if (reportedMsgId) {
          await tg.call("deleteMessage", { chat_id: channelId, message_id: reportedMsgId }).catch(()=>{});
        }
        return "delete";
      case "mute_1h":
      case "mute_6h":
      case "mute_24h": {
        const durations = { mute_1h: 3600, mute_6h: 21600, mute_24h: 86400 };
        await tg.call("restrictChatMember", {
          chat_id: channelId,
          user_id: target.id,
          permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false },
          until_date: now + durations[action]
        }).catch(()=>{});
        return action;
      }
      case "mute_perm":
        await tg.call("restrictChatMember", {
          chat_id: channelId,
          user_id: target.id,
          permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false }
        }).catch(()=>{});
        return "mute_perm";
      case "ban":
        await tg.call("banChatMember", {
          chat_id: channelId,
          user_id: target.id
        }).catch(()=>{});
        return "ban";
    }
  } catch (e) {
    logger.warn(`[adminReportService] executeAction ${action} fehlgeschlagen: ${e.message}`);
  }
  return "none";
}

/**
 * Sendet die Privatnachricht an alle Channel-Admins.
 */
async function notifyChannelAdmins(tg, channelId, payload) {
  // Owner aus bot_channels.added_by_user_id
  const { data: ch } = await supabase.from("bot_channels")
    .select("added_by_user_id, title")
    .eq("id", channelId).maybeSingle();
  const owners = new Set();
  if (ch?.added_by_user_id) owners.add(String(ch.added_by_user_id));

  // Co-Admins
  try {
    const { data: cos } = await supabase.from("channel_co_admins")
      .select("user_id").eq("channel_id", String(channelId));
    (cos || []).forEach(c => owners.add(String(c.user_id)));
  } catch (_) {}

  if (!owners.size) {
    logger.warn(`[adminReportService] Keine Admins für Channel ${channelId}`);
    return 0;
  }

  const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const cat = payload.aiCategory ? REPORT_CATEGORY_LABELS[payload.aiCategory] || payload.aiCategory : "—";
  let text =
    `🚨 <b>@admin-Meldung</b> in <b>${esc(ch?.title || channelId)}</b>\n\n` +
    `<b>Wer hat gemeldet:</b> ${payload.reporterName ? "@" + esc(payload.reporterName) : "User " + payload.reporterId}\n` +
    `<b>Wen:</b> ${payload.targetName ? "@" + esc(payload.targetName) : (payload.targetId ? "User " + payload.targetId : "—")}\n` +
    `<b>Gemeldete Nachricht:</b>\n<blockquote>${esc(String(payload.reportedText || "").substring(0, 400))}</blockquote>\n`;
  if (payload.contextText) {
    text += `<b>Kommentar des Melders:</b> <i>${esc(String(payload.contextText).substring(0, 200))}</i>\n`;
  }
  if (payload.aiCategory) {
    text += `\n🤖 <b>AI-Bewertung:</b> ${esc(cat)} (Vertrauen: ${Math.round((payload.aiConfidence || 0) * 100)}%)\n`;
    if (payload.aiSummary) text += `<i>${esc(payload.aiSummary)}</i>\n`;
  }
  if (payload.actionTaken && payload.actionTaken !== "none") {
    const actionLabels = {
      warn: "⚠️ Verwarnt", delete: "🗑 Nachricht gelöscht",
      mute_1h: "🔇 1h stummgeschaltet", mute_6h: "🔇 6h stummgeschaltet",
      mute_24h: "🔇 24h stummgeschaltet", mute_perm: "🔇 Permanent stumm",
      ban: "⛔ Gebannt"
    };
    text += `\n⚙️ <b>Auto-Konsequenz:</b> ${actionLabels[payload.actionTaken] || payload.actionTaken}\n`;
  }

  let sent = 0;
  for (const adminId of owners) {
    try {
      await tg.call("sendMessage", { chat_id: adminId, text, parse_mode: "HTML" });
      sent++;
    } catch (e) {
      // Häufigster Fall: 403 (User hat Bot blockiert oder nie gestartet)
      logger.warn(`[adminReportService] DM an ${adminId} fehlgeschlagen: ${e.message}`);
    }
  }
  return sent;
}

/**
 * Hauptfunktion — wird aus commandHandler aufgerufen wenn @admin-Mention erkannt wurde.
 *
 * @param tg              - tgAdminHelper instance
 * @param channelId       - chat.id (Group ID)
 * @param msg             - Telegram-Message (die mit der @admin-Mention)
 * @param channelConfig   - bot_channels Row
 */
async function handleAdminReport(tg, channelId, msg, channelConfig) {
  if (!channelConfig?.admin_report_enabled) return false;

  const reply = msg.reply_to_message;
  if (!reply) {
    // @admin ohne Reply → Bestätigung mit Hinweis
    await tg.call("sendMessage", {
      chat_id: channelId,
      text: "ℹ️ Bitte antworte mit <code>@admin</code> auf eine konkrete Nachricht.",
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id
    }).catch(()=>{});
    return true;
  }

  // Kurze Bestätigung in der Gruppe (10s sichtbar)
  let confMsgId = null;
  try {
    const conf = await tg.call("sendMessage", {
      chat_id: channelId,
      text: "✅ <b>Meldung an die Admins erfolgreich!</b>",
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id
    });
    confMsgId = conf?.result?.message_id || conf?.message_id;
  } catch (_) {}
  // Auto-Delete nach 10s
  if (confMsgId) {
    setTimeout(() => {
      tg.call("deleteMessage", { chat_id: channelId, message_id: confMsgId }).catch(()=>{});
    }, 10000);
  }

  const reportedText  = reply.text || reply.caption || "(kein Text — Medien)";
  const contextText   = String(msg.text || "").replace(/(?:^|\s)@admins?\b/gi, "").trim();
  const reporter      = msg.from || {};
  const target        = reply.from || {};

  // Klassifizierung (wenn aktiviert)
  let classification = null;
  if (channelConfig.admin_report_ai_enabled) {
    classification = await classifyReport(reportedText, contextText);
  }

  // Auto-Konsequenz (wenn AI klassifiziert hat UND eine Aktion konfiguriert ist)
  let actionTaken = "none";
  if (classification && channelConfig.admin_report_actions) {
    const cfgAction = channelConfig.admin_report_actions[classification.category];
    if (cfgAction && cfgAction !== "none") {
      actionTaken = await executeAction(
        tg, channelId, cfgAction, target, reply.message_id,
        `Auto-Aktion wegen ${REPORT_CATEGORY_LABELS[classification.category] || classification.category}`
      );
    }
  }

  // Admin-DM
  const adminsSent = await notifyChannelAdmins(tg, channelId, {
    reporterId:    reporter.id,
    reporterName:  reporter.username,
    targetId:      target.id,
    targetName:    target.username,
    reportedText,
    contextText,
    aiCategory:    classification?.category || null,
    aiConfidence:  classification?.confidence || null,
    aiSummary:     classification?.summary || null,
    actionTaken
  });

  // Audit-Log
  try {
    await supabase.from("admin_reports").insert([{
      channel_id:      String(channelId),
      reporter_id:     reporter.id,
      reporter_name:   reporter.username,
      target_id:       target.id || null,
      target_name:     target.username || null,
      reported_msg_id: reply.message_id,
      reported_text:   String(reportedText).substring(0, 1000),
      context_text:    contextText.substring(0, 500),
      ai_category:     classification?.category || null,
      ai_confidence:   classification?.confidence || null,
      ai_summary:      classification?.summary || null,
      action_taken:    actionTaken
    }]);
  } catch (e) {
    logger.warn(`[adminReportService] admin_reports insert: ${e.message}`);
  }

  logger.info(`[adminReportService] Channel ${channelId}: Meldung von ${reporter.id} → AI=${classification?.category || "-"} Aktion=${actionTaken} (${adminsSent} Admins benachrichtigt)`);
  return true;
}

module.exports = {
  detectAdminMention,
  classifyReport,
  executeAction,
  notifyChannelAdmins,
  handleAdminReport,
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS
};
