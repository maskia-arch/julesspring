/**
 * smalltalkBotRoutes.js  v1.4.5
 * Vollständiger Admin-Helper-Bot mit AI-Features (wenn freigeschaltet)
 */
const express          = require("express");
const router           = express.Router();
const supabase         = require("../config/supabase");
const logger           = require("../utils/logger");
const { tgAdminHelper, tgApi } = require("../services/adminHelper/tgAdminHelper");
const safelistService  = require("../services/adminHelper/safelistService");
const { t, detectLang, SUPPORTED_LANGUAGES } = require("../services/i18n");

const WELCOME_INTRO = `👋 <b>Willkommen beim TG Admin-Helper!</b>

Ich helfe dir dabei, deinen Telegram-Channel oder deine Gruppe effizienter zu verwalten.

<b>So startest du:</b>
1️⃣ Füge mich als <b>Admin</b> in deinen Channel/Gruppe ein
2️⃣ Kontaktiere <b>@autoacts</b> um die Einrichtung abzuschließen
3️⃣ Nach Freischaltung kannst du im Dashboard alle Funktionen konfigurieren

<b>🆓 Kostenlose Tools (sofort verfügbar):</b>
• 🧹 Gelöschte Accounts automatisch entfernen
• 👋 Willkommens- & Abschiedsnachrichten
• ⏰ Geplante Nachrichten & Ankündigungen
• 📌 Nachrichten pinnen
• 🛡 Safelist / Scamliste (Community-Sicherheit)

<b>🤖 KI-Features (nach Freischaltung durch @autoacts):</b>
• Eigene Bot-Persönlichkeit & System-Prompt
• Channel-Wissensdatenbank
• KI-gestützte Antworten auf /ai [Frage]

Fragen? → @autoacts`;

async function getSettings() {
  try {
    const { data } = await supabase.from("settings").select("*").maybeSingle();
    return data || null;
  } catch { return null; }
}

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function isGroupAdmin(token, chatId, userId) {
  try {
    const admins = await tgApi(token).getAdmins(chatId);
    return admins.some(a => a.user?.id === userId);
  } catch { return false; }
}


// ══════════════════════════════════════════════════════════════════════════════
// Bot-Einstellungsmenü (nur für Channel-Admins, kein Dashboard-Zugriff nötig)
// ══════════════════════════════════════════════════════════════════════════════

function backBtn(channelId, lang) {
  const labels = { de: "◀️ Zurück", en: "◀️ Back", es: "◀️ Volver",
                   zh: "◀️ 返回", ar: "◀️ عودة", fr: "◀️ Retour" };
  const cid = channelId || "0";
  return [{ text: labels[lang] || "◀️ Zurück", callback_data: `cfg_back_${cid}` }];
}

async function sendSettingsMenu(tg, sendTo, channelId, ch) {
  // Resolve language first — everything depends on it
  const lang      = ch?.bot_language || "de";
  const aiActive  = t("ai_active",        lang);
  const aiOff     = t("ai_inactive",      lang);
  const safeOn    = t("ai_active",        lang);
  const safeOff   = t("ai_inactive",      lang);
  const approved  = t("status_approved",  lang);
  const pending   = t("status_pending",   lang);

  const statusText  = ch?.is_approved      ? approved : pending;
  const aiText      = ch?.ai_enabled       ? aiActive : aiOff;
  const safeText    = ch?.safelist_enabled ? safeOn   : safeOff;

  return await tg.call("sendMessage", {
    chat_id: sendTo,
    text: t("settings_header", lang, ch?.title || channelId) + "\n\n" +
          `Status: ${statusText}\n` +
          `KI-Features: ${aiText}\n` +
          `Safelist: ${safeText}\n\n` +
          t("choose_action", lang),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: t("btn_welcome",  lang), callback_data: `cfg_welcome_${channelId}` },
       { text: t("btn_goodbye",  lang), callback_data: `cfg_goodbye_${channelId}` }],
      [{ text: t("btn_schedule", lang), callback_data: `cfg_schedule_${channelId}` }],
      [{ text: t("btn_clean",    lang), callback_data: `cfg_clean_${channelId}` },
       { text: t("btn_stats",    lang), callback_data: `cfg_stats_${channelId}` }],
      [{ text: t("btn_safelist", lang), callback_data: `cfg_safelist_${channelId}` }],
      [{ text: t("btn_ai",       lang), callback_data: `cfg_ai_${channelId}` }],
      [{ text: t("btn_language", lang), callback_data: `cfg_lang_${channelId}` }],
      [{ text: "🔍 UserInfo",            callback_data: `cfg_userinfo_${channelId}` }],
        [{ text: "🚫 Blacklist",            callback_data: `cfg_blacklist_${channelId}` }],
    ]}
  });
}

async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  // Smart parse: cfg_{action}_{channelId}
  // channelId = last segment that is a number (or -number for groups)
  // action = everything between "cfg_" and "_{channelId}"
  const withoutPrefix = data.replace(/^cfg_/, ""); // "ai_summary_-100xxx"
  const chanMatch = withoutPrefix.match(/_(-?\d+)$/);
  const channelId = chanMatch ? chanMatch[1] : withoutPrefix.split("_").pop();
  const action    = chanMatch
    ? withoutPrefix.slice(0, withoutPrefix.length - chanMatch[0].length)
    : withoutPrefix.split("_").slice(0, -1).join("_");

  // Admin-Check bereits beim settings_* callback durchgeführt

  const ch = await getChannel(channelId);

  switch (action) {
    case "welcome": {
      const cur = ch?.welcome_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Willkommensnachricht</b>\n\nAktuell: <i>${cur}</i>\n\nSende deine neue Willkommensnachricht (nutze {name} für den Nutzernamen):\nOder /cancel zum Abbrechen.`,
        parse_mode: "HTML"
      });
      // Store pending state
      pendingInputs[String(userId)] = { action: "set_welcome", channelId };
      break;
    }
    case "goodbye": {
      const cur = ch?.goodbye_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Abschiedsnachricht</b>\n\nAktuell: <i>${cur}</i>\n\nSende deine neue Abschiedsnachricht (nutze {name} für den Nutzernamen):\nOder /cancel zum Abbrechen.`,
        parse_mode: "HTML"
      });
      pendingInputs[String(userId)] = { action: "set_goodbye", channelId };
      break;
    }
    case "clean": {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "🔍 Starte Bereinigung gelöschter Accounts...", parse_mode: "HTML" });
      const settings = await getSettings();
      const { tgAdminHelper: helper } = require("../services/adminHelper/tgAdminHelper");
      const result = await helper.cleanDeletedAccounts(settings.smalltalk_bot_token, channelId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🧹 Fertig! ${result.checked} geprüft, ${result.removed} gelöschte Accounts entfernt.`, parse_mode: "HTML" });
      break;
    }
    case "stats": {
      let memberCount = null, schedCount = null;
      try { const r1 = await supabase_db.from("channel_members").select("id", { count: "exact", head: true }).eq("channel_id", channelId); memberCount = r1.count; } catch (_) {}
      try { const r2 = await supabase_db.from("scheduled_messages").select("id", { count: "exact", head: true }).eq("channel_id", channelId).eq("is_active", true); schedCount = r2.count; } catch (_) {}
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📊 <b>Statistiken: ${ch?.title || channelId}</b>\n\n` +
              `👥 Verfolgte Mitglieder: ${memberCount || 0}\n` +
              `⏰ Aktive geplante Nachrichten: ${schedCount || 0}\n` +
              `📚 KB-Einträge: ${ch?.kb_entry_count || 0}`,
        parse_mode: "HTML" });
      break;
    }
    case "safelist": {
      const safelistSvc = require("../services/adminHelper/safelistService");
      const slEnabled = ch?.safelist_enabled || false;
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🛡 <b>Safelist-Einstellungen</b>\n\nStatus: ${slEnabled ? "✅ Aktiv" : "❌ Inaktiv"}\n\nWas möchtest du tun?`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: slEnabled ? "🔴 Safelist deaktivieren" : "🟢 Safelist aktivieren",
             callback_data: `cfg_sl_toggle_${channelId}` }],
          [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` },
           { text: "📊 Übersicht",      callback_data: `cfg_sl_overview_${channelId}` }],
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "sl_toggle": {
      const newVal = !(ch?.safelist_enabled);
      await supabase_db.from("bot_channels").update({ safelist_enabled: newVal, updated_at: new Date() }).eq("id", channelId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🛡 Safelist ${newVal ? "✅ aktiviert" : "❌ deaktiviert"}.`, parse_mode: "HTML" });
      break;
    }
    case "sl_reviews": {
      const safelistSvc2 = require("../services/adminHelper/safelistService");
      const reviews = await safelistSvc2.getPendingReviews(channelId);
      if (!reviews.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🛡 Keine offenen Reviews.", parse_mode: "HTML" });
      } else {
        for (const r of reviews.slice(0, 5)) {
          const emoji = r.feedback_type === "positive" ? "✅" : "⚠️";
          await tg.call("sendMessage", {
            chat_id: String(userId),
            text: `${emoji} <b>@${r.target_username||r.target_user_id||"?"}</b>\n` +
                  `Von: @${r.submitted_by_username||r.submitted_by||"?"}\n` +
                  `Beweise: ${r.proof_count||0}\n` +
                  `<i>${(r.feedback_text||"").substring(0,150)}</i>`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "✅ Bestätigen", callback_data: `fb_approve_${r.id}` },
              { text: "❌ Ablehnen",  callback_data: `fb_reject_${r.id}` }
            ]]}
          });
        }
      }
      break;
    }
    case "sl_overview": {
      const { data: safeList } = await supabase_db.from("user_feedbacks")
        .select("id, target_username, target_user_id, feedback_text")
        .eq("channel_id", channelId).eq("feedback_type", "positive").eq("status", "approved").limit(20);
      const { data: scamList } = await supabase_db.from("scam_entries")
        .select("user_id, username, reason").eq("channel_id", channelId).limit(20);

      let txt = `📊 <b>Listen-Übersicht</b>\n\n`;
      txt += `✅ Safelist: ${safeList?.length || 0} Einträge\n`;
      txt += `⛔ Scamliste: ${scamList?.length || 0} Einträge\n`;

      const kb = [
        [{ text: `✅ Safelist anzeigen (${safeList?.length||0})`,   callback_data: `cfg_sl_safeview_${channelId}` }],
        [{ text: `⛔ Scamliste anzeigen (${scamList?.length||0})`, callback_data: `cfg_sl_scamview_${channelId}` }],
        backBtn(channelId, ch?.bot_language||"de")
      ];
      await tg.call("sendMessage", { chat_id: String(userId), text: txt, parse_mode: "HTML",
        reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "sl_safeview": {
      const { data: safeList } = await supabase_db.from("user_feedbacks")
        .select("id, target_username, target_user_id, feedback_text, submitted_by_username")
        .eq("channel_id", channelId).eq("feedback_type", "positive").eq("status", "approved").limit(20);
      if (!safeList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Safelist ist leer." });
        break;
      }
      // Show paginated list with delete buttons
      const kb = safeList.map(e => [{
        text: `🗑 @${e.target_username||e.target_user_id}`,
        callback_data: `cfg_sl_safedel_${e.id}_${channelId}`
      }]);
      kb.push(backBtn(channelId, ch?.bot_language||"de"));
      const lines = safeList.map(e =>
        `✅ @${e.target_username||e.target_user_id}` +
        (e.feedback_text ? ` — ${e.feedback_text.substring(0,60)}` : "") +
        (e.submitted_by_username ? ` (von @${e.submitted_by_username})` : "")
      ).join("\n");
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>Safelist</b>\n\n${lines}\n\nZum Löschen tippe den Eintrag:`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "sl_safedel": {
      const slDelMatch = data.match(/^cfg_sl_safedel_(\d+)_(-?\d+)$/);
      if (slDelMatch) {
        await supabase_db.from("user_feedbacks").delete().eq("id", slDelMatch[1]).eq("channel_id", slDelMatch[2]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Safelist-Eintrag gelöscht." });
      }
      break;
    }
    case "sl_scamview": {
      const { data: scamList } = await supabase_db.from("scam_entries")
        .select("user_id, username, reason, created_at").eq("channel_id", channelId).limit(20);
      if (!scamList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "⛔ Scamliste ist leer." });
        break;
      }
      const kb = scamList.map(e => [{
        text: `🗑 @${e.username||e.user_id}`,
        callback_data: `cfg_sl_scamdel_${e.user_id}_${channelId}`
      }]);
      kb.push(backBtn(channelId, ch?.bot_language||"de"));
      const lines = scamList.map(e =>
        `⛔ @${e.username||e.user_id}` + (e.reason ? ` — ${e.reason.substring(0,60)}` : "")
      ).join("\n");
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `⛔ <b>Scamliste</b>\n\n${lines}\n\nZum Löschen tippe den Eintrag:`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "sl_scamdel": {
      const scamDelMatch = data.match(/^cfg_sl_scamdel_(\d+)_(-?\d+)$/);
      if (scamDelMatch) {
        await supabase_db.from("scam_entries").delete().eq("user_id", scamDelMatch[1]).eq("channel_id", scamDelMatch[2]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Scamliste-Eintrag gelöscht." });
      }
      break;
    }
    case "schedule": {
      // Zeige Übersicht + Optionen
      const { data: schedMsgs } = await supabase_db.from("scheduled_messages")
        .select("id, message, next_run_at, repeat, cron_expr, photo_url, photo_file_id")
        .eq("channel_id", channelId).eq("is_active", true).order("next_run_at");

      const aiOn = ch?.ai_enabled;
      const freeLimit = 3;
      const freeCount = (schedMsgs || []).filter(m => m.repeat).length;
      const canAddRepeat = aiOn || freeCount < freeLimit;

      let txt = `⏰ <b>Geplante Nachrichten</b>\n\n`;
      if (!schedMsgs?.length) {
        txt += "Noch keine geplanten Nachrichten.\n";
      } else {
        schedMsgs.slice(0, 8).forEach((m, i) => {
          const dt = m.next_run_at ? new Date(m.next_run_at).toLocaleString("de-DE") : "–";
          txt += `${i+1}. ${m.message.substring(0,60)}${m.message.length>60?"…":""}\n`;
          txt += `   📅 ${dt}${m.repeat ? " 🔁 " + (m.cron_expr||"") : ""}\n`;
        });
      }
      if (!aiOn) txt += `\n🆓 Free: ${freeCount}/${freeLimit} Wiederholungen · Keine Medien`;

      await tg.call("sendMessage", {
        chat_id: String(userId), text: txt, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "➕ Neue Nachricht erstellen", callback_data: `cfg_sched_new_${channelId}` }],
          ...(schedMsgs?.length ? [[{ text: "🗑 Nachricht löschen", callback_data: `cfg_sched_del_${channelId}` }]] : []),
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "sched_new": {
      // Wizard Schritt 1: Text eingeben
      pendingInputs[String(userId)] = {
        action: "sched_wizard_text", channelId, aiOn: ch?.ai_enabled,
        freeMode: !ch?.ai_enabled
      };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "📝 <b>Neue geplante Nachricht</b>\n\nSchritt 1/4: Gib den Nachrichtentext ein:\n\n/cancel zum Abbrechen",
        parse_mode: "HTML" });
      break;
    }
    case "sched_del": {
      const { data: msgs2 } = await supabase_db.from("scheduled_messages")
        .select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(10);
      if (!msgs2?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "Keine aktiven geplanten Nachrichten.", parse_mode: "HTML" });
      } else {
        const keyboard = msgs2.map(m => [{
          text: "🗑 " + m.message.substring(0, 40),
          callback_data: `cfg_sched_delid_${m.id}_${channelId}`
        }]);
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "Welche Nachricht soll gelöscht werden?",
          reply_markup: { inline_keyboard: keyboard } });
      }
      break;
    }
    case "sched_delid": {
      const msgId = parts[2];
      await supabase_db.from("scheduled_messages").update({ is_active: false }).eq("id", msgId);
      await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Gelöscht.", parse_mode: "HTML" });
      break;
    }
    case "ai": {
      if (!ch?.ai_enabled) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "🤖 <b>KI-Features</b>\n\nStatus: ❌ Inaktiv\n\nFür Aktivierung wende dich an @autoacts.",
          parse_mode: "HTML" });
        break;
      }
      const tokenInfo = ch.token_limit
        ? `🔋 Credit-Budget: ${ch.token_used||0} / ${ch.token_limit} (${Math.round((ch.token_used||0)/ch.token_limit*100)}%)`
        : "🔋 Credit-Budget: unbegrenzt";
      const lastSumm = ch.last_summary_at
        ? `Letzte Zusammenfassung: ${new Date(ch.last_summary_at).toLocaleDateString("de-DE")}`
        : "Noch keine Zusammenfassung erstellt";

      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🤖 <b>KI-Features Dashboard</b>\n\n${tokenInfo}\n${lastSumm}\n\nWas möchtest du einstellen?`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "✏️ System-Prompt",       callback_data: `cfg_ai_prompt_${channelId}` }],
          [{ text: "📰 Tageszusammenfassung", callback_data: `cfg_ai_summary_${channelId}` }],
          [{ text: "📊 Mein Credit-Verbrauch", callback_data: `cfg_ai_stats_${channelId}` }],
          [{ text: "🔇 Gesperrte Themen",    callback_data: `cfg_ai_threads_${channelId}` }],
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "ai_prompt": {
      pendingInputs[String(userId)] = { action: "set_ai_prompt", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✏️ <b>System-Prompt</b>\n\nAktuell:\n<i>${(ch?.system_prompt||"(kein)").substring(0,200)}</i>\n\nSende den neuen System-Prompt:\n/cancel zum Abbrechen`,
        parse_mode: "HTML" });
      break;
    }
    case "ai_stats": {
      const tUsed  = ch?.token_used  || 0;
      const tLimit = ch?.token_limit;
      const exhausted = ch?.token_budget_exhausted || false;
      const pct = tLimit ? Math.round(tUsed / tLimit * 100) : 0;
      const bar = tLimit ? `[${"█".repeat(Math.min(10, Math.round(pct/10)))}${"░".repeat(Math.max(0, 10 - Math.round(pct/10)))}] ${pct}%` : "";
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📊 <b>Credit-Verbrauch</b>\n\n` +
              `🔋 ${tUsed.toLocaleString()} / ${tLimit ? tLimit.toLocaleString() : "∞"} Token\n` +
              (bar ? `${bar}\n` : "") +
              `\nStatus: ${exhausted ? "⛔ Budget erschöpft" : "✅ Aktiv"}\n\n` +
              (exhausted
                ? "⚠️ Dein Credit-Budget ist aufgebraucht. Kontaktiere @autoacts um Token aufzuladen."
                : `Für Token-Aufladung: @autoacts`),
        parse_mode: "HTML" });
      break;
    }
    case "ai_summary": {
      // Cooldown only if last summary was successful (≥10 Credits verbraucht)
      const lastSummaryAt = ch?.last_summary_at ? new Date(ch.last_summary_at) : null;
      const lastSummaryTokens = ch?.last_summary_tokens || 0;
      const hoursSince = lastSummaryAt ? (Date.now() - lastSummaryAt.getTime()) / 3600000 : 99;
      const lang = ch?.bot_language || "de";
      if (hoursSince < 24 && lastSummaryTokens >= 10) {
        const nextAt = new Date(lastSummaryAt.getTime() + 86400000).toLocaleTimeString("de-DE");
        await tg.call("sendMessage", { chat_id: String(userId),
          text: t("summary_cooldown", lang, nextAt) });
        break;
      }
      // Schätzung: ~300 Credits, x2 für Admin = 600 Credits
      const SUMMARY_TOKEN_EST = 300;
      const SUMMARY_BILLED    = SUMMARY_TOKEN_EST * 2;  // Admin zahlt 2x Credits
      const tUsed2   = ch?.token_used  || 0;
      const tLimit2  = ch?.token_limit;
      const remaining = tLimit2 ? tLimit2 - tUsed2 : Infinity;
      const willGoNeg = tLimit2 && (tUsed2 + SUMMARY_BILLED) > tLimit2;

      if (willGoNeg) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `⚠️ <b>Achtung!</b> Diese Zusammenfassung kostet ca. <b>${SUMMARY_BILLED} Token</b>.\n` +
                `Dein verbleibendes Budget: <b>${remaining.toLocaleString()} Token</b>.\n\n` +
                `Nach der Zusammenfassung kann die KI vorübergehend deaktiviert werden.\n\nTrotzdem erstellen?`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[
            { text: "✅ Ja, erstellen",   callback_data: `cfg_ai_summary_confirm_${channelId}` },
            { text: "❌ Abbrechen",       callback_data: `cfg_ai_abort_${channelId}` }
          ], backBtn(channelId, ch?.bot_language||"de")]
          }
        });
        break;
      }

      await tg.call("sendMessage", { chat_id: String(userId),
        text: t("summary_creating", lang, SUMMARY_BILLED) });
      await _runDailySummary(supabase_db, channelId, userId, tg, ch, lang);
      break;
    }
    case "ai_summary_confirm": {
      const lang2 = ch?.bot_language || "de";
      await tg.call("sendMessage", { chat_id: String(userId),
        text: t("summary_creating", lang2, 600) });
      await _runDailySummary(supabase_db, channelId, userId, tg, ch, lang2);
      break;
    }
    case "ai_threads": {
      const blocked = Array.isArray(ch?.blocked_thread_ids) ? ch.blocked_thread_ids : [];
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🔇 <b>Gesperrte Themen</b>\n\n` +
              (blocked.length
                ? `Gesperrte Thread-IDs:\n${blocked.map(id => `• ${id}`).join("\n")}\n\n`
                : "Aktuell sind keine Themen gesperrt.\n\n") +
              `Um ein Thema zu sperren: Gehe in das Thema und sende einem beliebigen Mitglied die Nachricht mit der Thread-ID.\n\n` +
              `Thread-ID sperren/entsperren per Dashboard oder sende mir hier die ID.`,
        parse_mode: "HTML" });
      pendingInputs[String(userId)] = { action: "set_blocked_threads", channelId };
      break;
    }
    case "ai_abort": {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Abgebrochen." });
      break;
    }
    case "blacklist": {
      const aiOn = ch?.ai_enabled;
      const { data: blEntries } = await supabase_db.from("channel_blacklist")
        .select("word, severity, category").eq("channel_id", channelId).order("category").limit(30);

      let txt = `🚫 <b>Blacklist</b> — ${(blEntries||[]).length} Einträge\n\n`;
      if (blEntries?.length) {
        const byCategory = {};
        blEntries.forEach(e => {
          if (!byCategory[e.category]) byCategory[e.category] = [];
          byCategory[e.category].push(`<code>${e.word}</code> [${e.severity}]`);
        });
        Object.entries(byCategory).forEach(([cat, words]) => {
          txt += `<b>${cat}:</b> ${words.slice(0,8).join(", ")}\n`;
        });
      } else {
        txt += "Noch keine Einträge.\n";
      }
      txt += "\nAktion wählen:";

      const kb = [
        [{ text: "➕ Wort hinzufügen",  callback_data: `cfg_bl_add_${channelId}` }],
        [{ text: "🗑 Wort entfernen",   callback_data: `cfg_bl_remove_${channelId}` }],
      ];
      if (aiOn) {
        kb.push([{ text: "🤖 KI Blacklist füllen", callback_data: `cfg_bl_ai_${channelId}` }]);
      }
      kb.push(backBtn(channelId, ch?.bot_language||"de"));

      await tg.call("sendMessage", { chat_id: String(userId), text: txt, parse_mode: "HTML",
        reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "bl_add": {
      pendingInputs[String(userId)] = { action: "bl_add_word", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "🚫 <b>Wort hinzufügen</b>\n\nFormat: <code>Wort</code> oder <code>Wort|Schwere|Kategorie</code>\n\nSchwere: warn · mute · ban · tolerated\nBeispiele:\n<code>PayPal</code>\n<code>Betrug|ban|Scam</code>\n<code>Werbung|mute|Spam</code>\n\n/cancel zum Abbrechen",
        parse_mode: "HTML" });
      break;
    }
    case "bl_remove": {
      const { data: blList } = await supabase_db.from("channel_blacklist")
        .select("id, word, severity").eq("channel_id", channelId).limit(20);
      if (!blList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "Keine Einträge zum Löschen." });
        break;
      }
      const kb = blList.map(e => [{ text: `🗑 ${e.word} [${e.severity}]`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb.push(backBtn(channelId, ch?.bot_language||"de"));
      await tg.call("sendMessage", { chat_id: String(userId), text: "Welchen Eintrag löschen?",
        reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "bl_del": {
      // data = cfg_bl_del_{entryId}_{channelId} — smart parser may split wrong, use own regex
      const blDelFull = data.match(/^cfg_bl_del_(\d+)_(-?\d+)$/);
      if (blDelFull) {
        const delId = blDelFull[1];
        const delChan = blDelFull[2];
        try {
          await supabase_db.from("channel_blacklist").delete().eq("id", delId).eq("channel_id", delChan);
          await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Eintrag gelöscht.", parse_mode: "HTML" });
        } catch (e) {
          await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
        }
      }
      break;
    }
    case "bl_ai": {
      // AI fills blacklist by category
      if (!ch?.ai_enabled) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ KI-Features nicht aktiviert." }); break; }
      pendingInputs[String(userId)] = { action: "bl_ai_category", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "🤖 <b>KI Blacklist</b>\n\nWelche Kategorie soll die KI befüllen?\nBeispiele: Beleidigungen · Spam · Betrug · Werbung · Zahlungsanbieter\n\nGib die Kategorie ein:",
        parse_mode: "HTML" });
      break;
    }
    case "lang": {
      const currentLang = ch?.bot_language || "de";
      const langButtons = Object.entries(SUPPORTED_LANGUAGES).map(([code, label]) => [{
        text: (code === currentLang ? "✅ " : "") + label,
        callback_data: `cfg_setlang_${code}_${channelId}`
      }]);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: SUPPORTED_LANGUAGES[currentLang]
          ? `🌐 <b>Bot-Sprache</b> | <b>Bot Language</b>\n\nAktuell: ${SUPPORTED_LANGUAGES[currentLang]}`
          : "🌐 Sprache wählen",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [...langButtons, backBtn(channelId, currentLang)] }
      });
      break;
    }
    case "back": {
      // Back to main settings menu
      await sendSettingsMenu(tg, String(userId), channelId, ch);
      break;
    }
    case "userinfo": {
      // Start UserInfo scene — private chat only
      pendingInputs[String(userId)] = { action: "userinfo_awaiting", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🔍 <b>UserInfo</b>\n\nDrei Möglichkeiten:\n` +
              `1. <b>Nachricht weiterleiten</b> — leite eine Nachricht des gesuchten Users weiter\n` +
              `2. <b>Telegram-ID eingeben</b> — z.B. <code>123456789</code>\n` +
              `3. <b>@Username eingeben</b> — z.B. <code>@autoacts</code>\n\n` +
              `/cancel zum Abbrechen`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] }
      });
      break;
    }
    case "setlang": {
      // data = "cfg_setlang_{langcode}_{channelId}" - langcode may have no underscore
      // Smart parse already extracted action="setlang", but channelId may be wrong
      // Re-parse: cfg_setlang_{code}_{channelId}
      const setLangMatch = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (setLangMatch) {
        const newLangCode = setLangMatch[1];
        const setLangChanId = setLangMatch[2];
        if (SUPPORTED_LANGUAGES[newLangCode]) {
          await supabase_db.from("bot_channels")
            .update({ bot_language: newLangCode, updated_at: new Date() })
            .eq("id", setLangChanId);
          const langLabel = SUPPORTED_LANGUAGES[newLangCode];
          await tg.call("sendMessage", { chat_id: String(userId),
            text: `✅ ${langLabel}`, parse_mode: "HTML" });
        }
      }
      break;
    }
  }
}

// In-Memory: Pending text inputs (welcome/goodbye Nachricht setzen)
const pendingInputs = {};

async function handlePendingInput(tg, supabase_db, userId, text, settings, msg) {
  const pending = pendingInputs[String(userId)];
  if (!pending) return false;

  if (text === "/cancel") {
    delete pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Abgebrochen." });
    return true;
  }

  const { action, channelId, entryId, targetUsername } = pending;

  // ── Schedule-Wizard ────────────────────────────────────────────────────────
  if (action === "sched_wizard_text") {
    pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_file", msgText: text };
    const aiOn = pending.aiOn;
    if (aiOn) {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "📎 <b>Schritt 2/4: Mediendatei (optional)</b>\n\nSende ein Foto, GIF oder Video – oder schreibe /skip um ohne Medien fortzufahren.",
        parse_mode: "HTML" });
    } else {
      // Free: Skip media step
      pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", msgText: text, fileId: null, fileType: null };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "📅 <b>Schritt 3/4: Datum & Uhrzeit</b>\n\nWann soll die Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort (einmalig)",
        parse_mode: "HTML" });
    }
    return true;
  }

  if (action === "sched_wizard_file") {
    let fileId = null, fileType = null;
    if (text === "/skip") {
      // No file
    } else if (msg?.photo) {
      fileId = msg.photo[msg.photo.length - 1]?.file_id; fileType = "photo";
    } else if (msg?.animation) {
      fileId = msg.animation.file_id; fileType = "animation";
    } else if (msg?.video) {
      fileId = msg.video.file_id; fileType = "video";
    } else {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "Bitte sende ein Foto, GIF oder Video – oder /skip." });
      return true;
    }
    pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", fileId, fileType };
    await tg.call("sendMessage", { chat_id: String(userId),
      text: "📅 <b>Schritt 3/4: Datum & Uhrzeit</b>\n\nWann soll die Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort (einmalig)",
      parse_mode: "HTML" });
    return true;
  }

  if (action === "sched_wizard_time") {
    let nextRunAt = null;
    if (text !== "/skip") {
      // Parse DD.MM.YYYY HH:MM
      const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        nextRunAt = new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).toISOString();
      } else {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "❌ Ungültiges Format. Bitte: <code>DD.MM.YYYY HH:MM</code>\nz.B. <code>20.04.2026 09:00</code>\nOder /skip für sofort.",
          parse_mode: "HTML" });
        return true;
      }
    }
    pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_repeat", nextRunAt };
    const freeCount = await _getRepeatCount(channelId);
    const freeMode = pending.freeMode || !pending.aiOn;
    const atLimit = freeMode && freeCount >= 3;
    const pinOpt    = "📌 Anpinnen: " + (pending.pinAfterSend ? "✅" : "❌");
    const delPrevOpt = "🔄 Vorherige löschen: " + (pending.deletePrevious ? "✅" : "❌");
    await tg.call("sendMessage", {
      chat_id: String(userId),
      text: "🔁 <b>Schritt 4/4: Wiederholung & Optionen</b>\n\n" +
            (atLimit ? "⚠️ Free-Limit: max. 3 Wiederholungs-Nachrichten ohne KI-Erweiterung.\n\n" : "") +
            (pending.aiOn ? "Unbegrenzte Wiederholungen verfügbar:" : "Free-Plan (max 3):"),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "1x – Einmalig",  callback_data: "sched_repeat_once_" + channelId },
         { text: "Täglich",        callback_data: atLimit ? "sched_noop" : "sched_repeat_daily_" + channelId }],
        [{ text: "Wöchentlich",    callback_data: atLimit ? "sched_noop" : "sched_repeat_weekly_" + channelId },
         { text: "Monatlich",      callback_data: atLimit ? "sched_noop" : "sched_repeat_monthly_" + channelId }],
        [{ text: pinOpt,           callback_data: "sched_opt_pin_" + channelId },
         { text: delPrevOpt,       callback_data: "sched_opt_delprev_" + channelId }]
      ]}
    });
    return true;
  }

  // ── Welcome/Goodbye + AI Prompt setzen ──────────────────────────────────────
  if (action === "set_welcome" || action === "set_goodbye" || action === "set_ai_prompt") {
    delete pendingInputs[String(userId)];
    let field, label;
    if (action === "set_welcome")   { field = "welcome_msg";   label = "Willkommensnachricht"; }
    if (action === "set_goodbye")   { field = "goodbye_msg";   label = "Abschiedsnachricht"; }
    if (action === "set_ai_prompt") { field = "system_prompt"; label = "System-Prompt"; }
    await supabase_db.from("bot_channels").update({ [field]: text, updated_at: new Date() }).eq("id", channelId);
    await tg.call("sendMessage", { chat_id: String(userId),
      text: `✅ <b>${label}</b> gespeichert!`, parse_mode: "HTML" });
    return true;
  }

  // ── UserInfo scene ────────────────────────────────────────────────────────
  if (action === "userinfo_awaiting") {
    let targetId = null;
    let inputType = "manual";

    // Case 1: Forwarded message (has forward_from with user info)
    if (msg?.forward_from) {
      targetId = String(msg.forward_from.id);
      inputType = "forward";
    }
    // Case 2: Forwarded from user who blocked forwarding (forward_sender_name but no forward_from)
    // We can't get the ID in this case
    else if (msg?.forward_sender_name && !msg?.forward_from) {
      delete pendingInputs[String(userId)];
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🔒 Dieser User hat das Weiterleiten blockiert.\n\n` +
              `Bitte gib die Telegram-ID manuell ein oder versuche es mit /userinfo @username`,
        parse_mode: "HTML" });
      pendingInputs[String(userId)] = { action: "userinfo_awaiting", channelId };
      return true;
    }
    // Case 3: @username input
    else if (text && text.startsWith("@")) {
      targetId = text.trim();
      inputType = "username";
    }
    // Case 4: Numeric Telegram ID
    else if (text && /^\d+$/.test(text.trim())) {
      targetId = text.trim();
      inputType = "id";
    }
    else {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "❓ Bitte leite eine Nachricht weiter, gib eine Telegram-ID ein (z.B. <code>123456789</code>) oder einen @username.",
        parse_mode: "HTML" });
      return true;
    }

    delete pendingInputs[String(userId)];
    await _runUserInfo(tg, supabase_db, userId, targetId, channelId, null, null);
    return true;
  }

  // ── Blacklist word entry ────────────────────────────────────────────────────
  if (action === "bl_add_word") {
    delete pendingInputs[String(userId)];
    const parts = text.split("|").map(s => s.trim());
    const word     = parts[0];
    const severity = ["warn","mute","ban","tolerated"].includes(parts[1]) ? parts[1] : "mute";
    const category = parts[2] || "allgemein";
    if (!word) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Kein Wort angegeben." }); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{
        channel_id: String(channelId), word: word.toLowerCase(),
        category, severity, created_by: userId
      }], { onConflict: "channel_id,word" });
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>${word}</b> hinzugefügt (${severity}, ${category}).`, parse_mode: "HTML" });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  // ── Blacklist AI fill ─────────────────────────────────────────────────────
  if (action === "bl_ai_category") {
    delete pendingInputs[String(userId)];
    const category = text.trim();
    if (!category) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Keine Kategorie angegeben." }); return true; }
    await tg.call("sendMessage", { chat_id: String(userId), text: `⏳ KI befüllt Blacklist für "${category}"…` });
    try {
      const axios = require("axios");
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Kein OpenAI Key");
      const resp = await axios.post("https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", max_tokens: 300, temperature: 0.2,
          messages: [{ role: "user", content:
            `Erstelle eine Liste von 20-30 deutschen Begriffen/Wörtern für die Kategorie "${category}". ` +
            `Gib NUR die Wörter aus, einen pro Zeile, keine Nummerierung, keine Erklärungen.`
          }]},
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 20000 }
      );
      const words = resp.data.choices[0].message.content.trim().split("\n")
        .map(w => w.trim().toLowerCase()).filter(w => w.length > 1 && w.length < 50);

      let added = 0;
      for (const word of words.slice(0, 30)) {
        try {
          await supabase_db.from("channel_blacklist").upsert([{
            channel_id: String(channelId), word, category, severity: "mute", created_by: userId
          }], { onConflict: "channel_id,word" });
          added++;
        } catch (_) {}
      }
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>${added} Wörter</b> für "${category}" zur Blacklist hinzugefügt.`, parse_mode: "HTML" });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  if (action === "set_blocked_threads") {
    delete pendingInputs[String(userId)];
    const threadIds = text.split(/[\s,]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const { data: cur } = await supabase_db.from("bot_channels").select("blocked_thread_ids").eq("id", channelId).maybeSingle();
    const existing = Array.isArray(cur?.blocked_thread_ids) ? cur.blocked_thread_ids : [];
    const updated = [...new Set([...existing, ...threadIds])];
    await supabase_db.from("bot_channels").update({ blocked_thread_ids: updated, updated_at: new Date() }).eq("id", channelId);
    await tg.call("sendMessage", { chat_id: String(userId),
      text: `✅ Gesperrte Themen aktualisiert.\nAktive Sperren: ${updated.join(", ") || "keine"}`, parse_mode: "HTML" });
    return true;
  }

  // ── Proof-Einreichung: User startet mit /proofs_ENTRYID ───────────────────
  if (action === "awaiting_proofs_start" && text && text.startsWith("/proofs_")) {
    const inputEntryId = text.split("_")[1];
    if (inputEntryId === String(entryId)) {
      pendingInputs[String(userId)] = { ...pending, action: "collecting_proofs", proofCount: 0 };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📎 <b>Beweise einreichen für @${targetUsername}</b>\n\nSende jetzt bis zu <b>5 Beweise</b> als:\n• Screenshot (Foto)\n• Textnachricht\n• Dokument/Video\n\nSchreibe /fertig wenn du alle Beweise eingereicht hast.`,
        parse_mode: "HTML" });
    }
    return true;
  }

  // ── Proofs sammeln ─────────────────────────────────────────────────────────
  if (action === "collecting_proofs") {
    if (text === "/fertig") {
      delete pendingInputs[String(userId)];
      const proofs = await safelistService.getProofs(entryId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>${proofs.length} Beweis(e) eingegangen.</b>\n\nVielen Dank! Ein Admin prüft die Meldung. Du wirst informiert.`,
        parse_mode: "HTML" });

      // Admin benachrichtigen
      let fbEntry = null, chData = null;
      try { const rA = await supabase_db.from("user_feedbacks").select("*").eq("id", entryId).single(); fbEntry = rA.data; } catch (_) {}
      try { const rB = await supabase_db.from("bot_channels").select("added_by_user_id").eq("id", String(pending.channelId||0)).maybeSingle(); chData = rB.data; } catch (_) {}
      const adminId = chData?.added_by_user_id;
      if (adminId) {
        await tg.call("sendMessage", { chat_id: String(adminId),
          text: `⚠️ <b>Neue Scam-Meldung</b>\n\nZiel: @${targetUsername}\nVon: @${pending.reporterUsername || userId}\nBeweise: ${proofs.length}\n\nInhalt:\n${proofs.filter(p=>p.content||p.caption).slice(0,3).map(p => "• " + (p.content || p.caption || "[Medien]")).join("\n")}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[
            { text: "✅ Als Scammer bestätigen", callback_data: "safe_approve_" + entryId + "_scam" },
            { text: "❌ Ablehnen",               callback_data: "safe_reject_" + entryId }
          ]]}
        });
        // Medien-Beweise weiterleiten
        for (const p of proofs.filter(pr => pr.file_id)) {
          try {
            if (p.proof_type === "photo")    await tg.call("sendPhoto",    { chat_id: String(adminId), photo:    p.file_id, caption: p.caption || "" });
            if (p.proof_type === "video")    await tg.call("sendVideo",    { chat_id: String(adminId), video:    p.file_id, caption: p.caption || "" });
            if (p.proof_type === "document") await tg.call("sendDocument", { chat_id: String(adminId), document: p.file_id, caption: p.caption || "" });
          } catch (_) {}
        }
      }
      return true;
    }

    // Proof entgegennehmen (Text oder Medien)
    const count = pending.proofCount || 0;
    if (count >= 5) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "Maximal 5 Beweise möglich. Schreibe /fertig um abzuschließen." });
      return true;
    }

    let proofType = "text";
    let fileId = null;
    let caption = null;
    let content = text || null;

    if (msg?.photo) {
      proofType = "photo"; fileId = msg.photo[msg.photo.length - 1]?.file_id; caption = msg.caption || null; content = null;
      // Sofort aus dem privaten Chat löschen
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    } else if (msg?.video) {
      proofType = "video"; fileId = msg.video.file_id; caption = msg.caption || null; content = null;
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    } else if (msg?.document) {
      proofType = "document"; fileId = msg.document.file_id; caption = msg.caption || null; content = null;
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    }

    await safelistService.addProof({ entryId, submittedBy: userId, proofType, fileId, caption, content });
    pendingInputs[String(userId)].proofCount = count + 1;

    await tg.call("sendMessage", { chat_id: String(userId),
      text: `📎 Beweis ${count + 1}/5 erhalten${count + 1 < 5 ? ". Weitere senden oder /fertig." : ". Maximal erreicht – schreibe /fertig."}` });
    return true;
  }

  return false;
}


// ── Credit-Budget prüfen und ggf. AI deaktivieren ──────────────────────────────
async function _checkTokenBudget(supabase_db, channel, tg, token) {
  if (!channel?.token_limit || channel?.token_budget_exhausted) return;
  if ((channel.token_used || 0) >= channel.token_limit) {
    // Budget erschöpft → AI deaktivieren
    try {
      await supabase_db.from("bot_channels").update({
        ai_enabled: false, token_budget_exhausted: true
      }).eq("id", String(channel.id));
    } catch (_) {}

    // Admin benachrichtigen
    if (channel.added_by_user_id && token) {
      await tg.call("sendMessage", { chat_id: String(channel.added_by_user_id),
        text: `⚠️ <b>Credit-Budget für "${channel.title}" erschöpft!</b>\n\n` +
              `Verbraucht: ${channel.token_used.toLocaleString()} / ${channel.token_limit.toLocaleString()} Token\n\n` +
              `KI-Features wurden deaktiviert. Alle anderen Features laufen weiter.\n` +
              `Credits aufladen: @autoacts`,
        parse_mode: "HTML" }).catch(() => {});
    }
    return true; // Budget exhausted
  }
  return false;
}

// ── Tages-Zusammenfassung ─────────────────────────────────────────────────────
async function _createDailySummary(supabase_db, channelId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("[DailySummary] Kein OPENAI_API_KEY");
    return null;
  }

  const since = new Date(Date.now() - 86400000).toISOString();

  let ctxMsgs = [], members = [];
  try {
    // channel_chat_history hat alle User-Nachrichten seit v1.4.23
    const { data: hist } = await supabase_db
      .from("channel_chat_history")
      .select("user_id, content, created_at")
      .eq("channel_id", String(channelId))
      .eq("role", "user")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(300);
    ctxMsgs = hist || [];
  } catch (e) { logger.warn("[DailySummary] history read:", e.message); }

  try {
    const { data: m } = await supabase_db
      .from("channel_members")
      .select("is_deleted")
      .eq("channel_id", String(channelId));
    members = m || [];
  } catch (_) {}

  const joins  = members.filter(m => !m.is_deleted).length;
  const leaves = members.filter(m =>  m.is_deleted).length;

  if (!ctxMsgs.length) {
    return {
      text: `📰 <b>Tageszusammenfassung</b>\n\nKeine User-Nachrichten in den letzten 24h.` +
            `\n\n👥 Eintritte: ${joins} · Austritte: ${leaves}`,
      outTokens: 0, inTokens: 0, usd: 0
    };
  }

  // Build username lookup from channel_members
  let userNames = {};
  try {
    const { data: memberList } = await supabase_db.from("channel_members")
      .select("user_id, username, first_name").eq("channel_id", String(channelId));
    (memberList || []).forEach(m => {
      userNames[String(m.user_id)] = m.username ? "@" + m.username : (m.first_name || String(m.user_id));
    });
  } catch (_) {}

  // Format: [Zeit] @Username: Nachricht
  const lines = ctxMsgs.map(m => {
    const ts = new Date(m.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const who = userNames[String(m.user_id)] || String(m.user_id);
    return `[${ts}] ${who}: ${(m.content || "").substring(0, 200)}`;
  }).join("\n").substring(0, 5000);

  try {
    const axios = require("axios");
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 5000,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: "Du bist ein Assistent der Telegram-Gruppen-Tagesberichte erstellt. " +
                     "Fasse die Aktivitäten in 5-8 prägnanten Stichpunkten zusammen. " +
                     "Zensiere Beleidigungen oder unangemessene Inhalte mit [***]. " +
                     "Verwende keine echten Usernamen. Schreibe auf Deutsch."
          },
          {
            role: "user",
            content: `Erstelle einen Tagesbericht für diesen Telegram-Channel.\n\n` +
                     `Nachrichten der letzten 24h:\n${lines}\n\n` +
                     `Mitglieder-Statistik: ${joins} aktiv, ${leaves} ausgetreten.`
          }
        ]
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 45000
      }
    );

    const usage      = resp.data?.usage || {};
    const outTokens  = usage.completion_tokens || 0;
    const inTokens   = usage.prompt_tokens     || 0;
    const summaryTxt = resp.data?.choices?.[0]?.message?.content?.trim() || "(Keine Zusammenfassung)";

    return {
      text:      `📰 <b>Tageszusammenfassung</b>\n\n${summaryTxt}\n\n` +
                 `👥 ${joins} aktive Mitglieder · ${leaves} ausgetreten`,
      outTokens,
      inTokens,
      usd: inTokens * 0.00000015 + outTokens * 0.0000006
    };
  } catch (e) {
    logger.error("[DailySummary] OpenAI Fehler:", e.message, e.response?.data);
    return null;
  }
}

// ── _runDailySummary: Zusammenfassung ausführen + exakte Token abrechnen ────────
async function _runDailySummary(supabase_db, channelId, adminUserId, tg, ch, lang) {
  const result = await _createDailySummary(supabase_db, channelId);
  if (!result) {
    await tg.call("sendMessage", { chat_id: String(adminUserId),
      text: "❌ Fehler bei der Zusammenfassung. Bitte später erneut versuchen." });
    return;
  }

  // x2 Credits für Admin abrechnen (Summary-Premium)
  const rawOutTokens    = result.outTokens || 0;
  const billedTokens    = rawOutTokens * 2;       // Admin zahlt doppelt
  const actualUsd       = result.usd || 0;

  // last_summary_at NUR setzen wenn echte Credits verbraucht (≥10 = Erfolg)
  if (rawOutTokens >= 10) {
    try {
      await supabase_db.from("bot_channels").update({
        last_summary_at: new Date(),
        last_summary_tokens: rawOutTokens
      }).eq("id", String(channelId));
    } catch (_) {}
  }

  try {
    const rpcResult = await supabase_db.rpc("increment_channel_usage",
      { p_id: String(channelId), p_tokens: billedTokens, p_usd: actualUsd });
    if (rpcResult.error) throw rpcResult.error;
  } catch {
    try {
      const { data: cur } = await supabase_db.from("bot_channels")
        .select("token_used, usd_spent").eq("id", String(channelId)).maybeSingle();
      if (cur) {
        await supabase_db.from("bot_channels").update({
          token_used: (cur.token_used || 0) + billedTokens,
          usd_spent:  parseFloat(((cur.usd_spent || 0) + actualUsd).toFixed(6))
        }).eq("id", String(channelId));
      }
    } catch (fallbackErr) {
      logger.warn("[DailySummary] Token-Tracking Fallback fehlgeschlagen:", fallbackErr.message);
    }
  }

  // last_summary_at is set above (only on success ≥10 tokens)

  // Budget-Check nach Abrechnung
  let note = "";
  try {
    const { data: updated } = await supabase_db.from("bot_channels")
      .select("token_used, token_limit").eq("id", String(channelId)).maybeSingle();
    if (updated?.token_limit && updated.token_used > updated.token_limit) {
      try {
        await supabase_db.from("bot_channels")
          .update({ ai_enabled: false, token_budget_exhausted: true }).eq("id", String(channelId));
      } catch (_) {}
      note = "\n\n⚠️ Credit-Budget überschritten. KI vorübergehend deaktiviert. Credits aufladen: @autoacts";
    }
  } catch (_) {}

  // Zusammenfassung senden (erst nach Abrechnung → zeigt korrekten Verbrauch)
  await tg.call("sendMessage", { chat_id: String(adminUserId),
    text: result.text + `\n\n<i>📊 Dir wurden ${billedTokens} Credits berechnet.</i>` + note,
    parse_mode: "HTML" });
}

async function _getRepeatCount(channelId) {
  try {
    const { data } = await supabase.from("scheduled_messages")
      .select("id").eq("channel_id", String(channelId)).eq("is_active", true).eq("repeat", true);
    return data?.length || 0;
  } catch { return 0; }
}

// Handle media in wizard (file step)
async function _handleWizardMedia(tg, supabase_db, userId, pending, msg) {
  if (pending?.action !== "sched_wizard_file") return false;
  let fileId = null, fileType = null;
  if (msg?.photo) { fileId = msg.photo[msg.photo.length-1]?.file_id; fileType = "photo"; }
  else if (msg?.animation) { fileId = msg.animation.file_id; fileType = "animation"; }
  else if (msg?.video) { fileId = msg.video.file_id; fileType = "video"; }
  else return false;
  pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", fileId, fileType };
  await tg.call("sendMessage", { chat_id: String(userId),
    text: "📅 <b>Schritt 3/4: Datum & Uhrzeit</b>\n\nFormat: <code>DD.MM.YYYY HH:MM</code>\nOder /skip für sofort.",
    parse_mode: "HTML" });
  return true;
}

// ── UserInfo: Rate-limited Telegram lookup ────────────────────────────────────
const FREE_QUERIES_PER_DAY = 5;

async function _checkUserInfoAccess(supabase_db, requesterId, channelId) {
  // Admin with AI features → unlimited
  if (channelId) {
    try {
      const { data: ch } = await supabase_db.from("bot_channels")
        .select("ai_enabled, added_by_user_id").eq("id", String(channelId)).maybeSingle();
      if (ch?.ai_enabled && String(ch.added_by_user_id) === String(requesterId)) return { ok: true, unlimited: true };
    } catch (_) {}
  }
  // Pro user?
  try {
    const { data: pro } = await supabase_db.from("userinfo_pro_users")
      .select("expires_at").eq("user_id", requesterId).maybeSingle();
    if (pro) {
      if (!pro.expires_at || new Date(pro.expires_at) > new Date()) return { ok: true, unlimited: true };
    }
  } catch (_) {}
  // Daily limit
  try {
    const { data: q } = await supabase_db.from("userinfo_queries")
      .select("query_count").eq("user_id", requesterId).eq("query_date", new Date().toISOString().split("T")[0]).maybeSingle();
    const used = q?.query_count || 0;
    if (used >= FREE_QUERIES_PER_DAY) return { ok: false, used, limit: FREE_QUERIES_PER_DAY };
  } catch (_) {}
  return { ok: true };
}

async function _incrementQueryCount(supabase_db, userId) {
  try {
    const { data } = await supabase_db.rpc("increment_userinfo_count", { p_user_id: userId });
    return data || 1;
  } catch {
    try {
      const today = new Date().toISOString().split("T")[0];
      await supabase_db.from("userinfo_queries").upsert([{ user_id: userId, query_date: today, query_count: 1 }], { onConflict: "user_id,query_date" });
    } catch (_) {}
    return 1;
  }
}

async function _runUserInfo(tg, supabase_db, requesterId, targetId, channelId, replyToMsgId, targetChatId) {
  // targetChatId: where to send the result (channel or private)
  const sendTo = targetChatId || String(requesterId);

  // Rate limit check
  const access = await _checkUserInfoAccess(supabase_db, requesterId, channelId);
  if (!access.ok) {
    const msg = await tg.call("sendMessage", { chat_id: sendTo,
      text: `⛔ Tages-Limit erreicht (${access.used}/${access.limit} kostenlose Abfragen).\n\nFür unbegrenzte Abfragen: <b>UserInfo Pro</b> → @autoacts`,
      parse_mode: "HTML",
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {})
    });
    if (msg?.message_id) await safelistService.trackBotMessage(sendTo, msg.message_id, "temp", 15000);
    return;
  }

  // Increment counter (unless unlimited)
  if (!access.unlimited) await _incrementQueryCount(supabase_db, requesterId);

  // Query Telegram
  let chatData = null;
  try { chatData = await tg.call("getChat", { chat_id: targetId }); } catch (_) {}

  if (!chatData) {
    const msg = await tg.call("sendMessage", { chat_id: sendTo,
      text: `❌ Keine Daten gefunden für <code>${targetId}</code>\n\nMögliche Gründe:\n• User hat keinen öffentlichen Account\n• Falsche ID / Username\n• Kein gemeinsamer Chat mit dem Bot`,
      parse_mode: "HTML"
    }).catch(() => null);
    if (msg?.message_id && sendTo !== String(requesterId)) {
      await safelistService.trackBotMessage(sendTo, msg.message_id, "temp", 5 * 60 * 1000);
    }
    return;
  }

  const { id, first_name, last_name, username, bio, type, description, member_count } = chatData;

  let text = `👤 <b>UserInfo</b>\n`;
  text += `━━━━━━━━━━━━━━\n`;
  text += `🆔 <b>ID:</b> <code>${id}</code>\n`;
  if (first_name || last_name) {
    text += `📛 <b>Name:</b> ${[first_name, last_name].filter(Boolean).join(" ")}\n`;
  }
  if (username)   text += `🔗 <b>Username:</b> <a href="tg://user?id=${id}">@${username}</a>\n`;
  if (bio)        text += `📝 <b>Bio:</b> ${bio.substring(0, 200)}\n`;
  if (type && type !== "private") text += `📌 <b>Typ:</b> ${type}\n`;
  if (description) text += `📄 ${description.substring(0, 150)}\n`;
  if (member_count) text += `👥 <b>Mitglieder:</b> ${member_count.toLocaleString()}\n`;

  // Channel DB info
  if (channelId) {
    try {
      const { data: member } = await supabase_db.from("channel_members")
        .select("joined_at, last_seen, is_deleted").eq("channel_id", String(channelId)).eq("user_id", String(id)).maybeSingle();
      if (member) {
        text += `\n📅 <b>Im Channel seit:</b> ${member.joined_at ? new Date(member.joined_at).toLocaleDateString("de-DE") : "unbekannt"}\n`;
        text += `👁 <b>Zuletzt aktiv:</b> ${member.last_seen ? new Date(member.last_seen).toLocaleDateString("de-DE") : "–"}\n`;
        if (member.is_deleted) text += `🗑 <b>Account:</b> Gelöscht\n`;
      }
    } catch (_) {}

    // Safelist/Scamlist
    try {
      const { data: scamEntry } = await supabase_db.from("scam_entries").select("reason").eq("channel_id", String(channelId)).eq("user_id", id).maybeSingle();
      const { data: feedbacks } = await supabase_db.from("user_feedbacks").select("feedback_type").eq("channel_id", String(channelId)).eq("status", "approved").or(`target_user_id.eq.${id},target_username.ilike.${username||"__none__"}`).limit(10);
      if (scamEntry) {
        text += `\n⛔ <b>Scamliste:</b> ${(scamEntry.reason||"").substring(0,100)}\n`;
      }
      if (feedbacks?.length) {
        const pos = feedbacks.filter(f => f.feedback_type === "positive").length;
        const neg = feedbacks.filter(f => f.feedback_type === "negative").length;
        text += `📊 <b>Feedbacks:</b> ✅ ${pos} · ⚠️ ${neg}\n`;
      }
    } catch (_) {}
  }

  const remaining = access.unlimited ? "∞" : String(FREE_QUERIES_PER_DAY - ((await supabase_db.from("userinfo_queries").select("query_count").eq("user_id", requesterId).eq("query_date", new Date().toISOString().split("T")[0]).maybeSingle().catch(() => ({ data: null }))).data?.query_count || 0));
  text += `\n<i>Abfragen heute: ${access.unlimited ? "∞" : remaining + "/" + FREE_QUERIES_PER_DAY}</i>`;

  const sentMsgParams = { chat_id: sendTo, text: text.trim(), parse_mode: "HTML" };
  // Don't reply to command messages that may already be deleted
  // Only add reply if explicitly passed
  if (replyToMsgId) sentMsgParams.reply_to_message_id = replyToMsgId;
  const sentMsg = await tg.call("sendMessage", sentMsgParams).catch(async (e) => {
    if (e.message?.includes("reply") || e.message?.includes("not found")) {
      // Retry without reply
      delete sentMsgParams.reply_to_message_id;
      return await tg.call("sendMessage", sentMsgParams);
    }
    throw e;
  });

  // Auto-delete after 5 min in channels (not in private admin chat)
  if (sentMsg?.message_id && sendTo !== String(requesterId)) {
    await safelistService.trackBotMessage(sendTo, sentMsg.message_id, "temp", 5 * 60 * 1000);
  }
}


// ── Feedback-Erkennung ─────────────────────────────────────────────────────────
function _detectFeedback(text) {
  if (!text || text.length < 5 || text.length > 500) return null;

  // Must contain @username
  const usernameMatch = text.match(/@([\w\d_]+)/);
  if (!usernameMatch) return null;
  const username = usernameMatch[1];

  const lower = text.toLowerCase();

  // Positive indicators
  const posKeywords = /\b(safe|seriös|serioes|vertrauenswürdig|vertrauenswuerdig|empfehlung|empfehle|recommend|legit|trusted|zuverlässig|zuverlaessig|top|super|gut|guter|sehr gut|bestätigt|bestaetigt|verifiziert|real|echt|ok|alles gut|hat geliefert|hat gezahlt|pünktlich|puenktlich)\b/i;

  // Negative indicators
  const negKeywords = /\b(scam|betrug|betrüger|betrueger|fake|nicht safe|unsicher|achtung|warning|vorsicht|schwindler|unzuverlässig|unzuverlaessig|nie wieder|schlechte erfahrung|kein empfehlung|nicht empfehlen|gestohlen|abgezockt|lügt|luegt|abzocke|falsch|unecht)\b/i;

  const isPositive = posKeywords.test(lower);
  const isNegative = negKeywords.test(lower);

  // Need clear signal, not both
  if (isPositive && !isNegative) return { username, type: "positive" };
  if (isNegative && !isPositive) return { username, type: "negative" };

  return null; // Ambiguous or no feedback
}


// ── Duration parser ────────────────────────────────────────────────────────────
function _parseDuration(str) {
  if (!str || /^(perm|permanent)/i.test(str)) return -1; // permanent
  const m = String(str).match(/^(\d+)([smhd])$/i);
  if (!m) return 86400; // default 24h
  const n = parseInt(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': return Math.min(n, 2592000);
    case 'm': return Math.min(n * 60, 2592000);
    case 'h': return Math.min(n * 3600, 2592000);
    case 'd': return Math.min(n * 86400, 2592000); // max 30d
    default:  return 86400;
  }
}

// ── Blacklist engine ───────────────────────────────────────────────────────────
// Fuzzy match: normalize text (0→o, @→a, 3→e etc.) and check includes
function _normalizeForBlacklist(text) {
  return text.toLowerCase()
    .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/1/g, 'i').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[@$]/g, 'a').replace(/[^a-z0-9äöüß]/g, '');
}

async function _checkBlacklist(supabase_db, channelId, messageText, from, chatId, tg, token) {
  if (!messageText?.trim()) return;
  let entries;
  try {
    const { data } = await supabase_db.from("channel_blacklist")
      .select("word, severity, tolerate_hours, category").eq("channel_id", String(channelId));
    entries = data || [];
  } catch (_) { return; }
  if (!entries.length) return;

  const normMsg = _normalizeForBlacklist(messageText);
  let hit = null;
  for (const e of entries) {
    const normWord = _normalizeForBlacklist(e.word);
    if (normMsg.includes(normWord)) { hit = e; break; }
  }
  if (!hit) return;

  const targetName = from.username ? "@" + from.username : (from.first_name || String(from.id));
  let action = hit.severity;

  // Log hit
  try {
    await supabase_db.from("blacklist_hits").insert([{
      channel_id: String(channelId), user_id: from.id,
      username: from.username || null, word_hit: hit.word,
      message_text: messageText.substring(0, 200), action_taken: action
    }]);
  } catch (_) {}

  if (action === "tolerated") {
    // Delete after tolerate_hours
    const hours = hit.tolerate_hours || 24;
    // No immediate action, schedule delete
    return; // tolerated = allow for now
  }

  // Always delete the message first
  // Note: we need msg.message_id — passed as part of context
  // Action based on severity
  let actionText = "";
  if (action === "mute" || action === "warn") {
    const muteSec = 12 * 3600; // 12h default
    try {
      await tg.call("restrictChatMember", {
        chat_id: chatId, user_id: from.id,
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + muteSec
      });
      actionText = "12h stummgeschaltet";
    } catch (_) {}
  } else if (action === "ban") {
    try {
      await tg.call("banChatMember", { chat_id: chatId, user_id: from.id, until_date: 0 });
      actionText = "gebannt";
    } catch (_) {}
  }

  // Notify admin via PM
  try {
    const { data: ch } = await supabase_db.from("bot_channels").select("added_by_user_id").eq("id", String(channelId)).maybeSingle();
    if (ch?.added_by_user_id) {
      await tg.call("sendMessage", { chat_id: String(ch.added_by_user_id),
        text: `⚠️ <b>Blacklist-Treffer</b>\n\nUser: ${targetName}\nWort: <code>${hit.word}</code> (${hit.category})\nAktion: ${actionText || "Nachricht gelöscht"}\nNachricht: <i>${messageText.substring(0, 100)}</i>`,
        parse_mode: "HTML" });
    }
  } catch (_) {}

  return { hit, action, actionText };
}


router.post("/smalltalk", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const update  = req.body;
      if (!update)  return;
      const settings = await getSettings();
      const token    = settings?.smalltalk_bot_token;
      if (!token) {
        logger.info("[SmallTalk-Bot] Kein Bot-Token konfiguriert – Update ignoriert");
        return;
      }
      const tg = tgApi(token);

      // ── Bot als Admin hinzugefügt ──────────────────────────────────────────
      if (update.my_chat_member) {
        const mcm = update.my_chat_member;
        if (["administrator","creator"].includes(mcm.new_chat_member?.status)) {
          const chat     = mcm.chat;
          const addedBy  = mcm.from;   // Der User der den Bot hinzugefügt hat
          const settingsToken = require('crypto').randomBytes(16).toString('hex');

          // ── Robuste Speicherung mit vollständigem Logging ─────────────────
          const chatIdStr = String(chat.id); // Sicherstellen: String für DB-Konsistenz
          logger.info(`[SmallTalk-Bot] Speichere Channel: ${chat.title} (id=${chatIdStr}, type=${chat.type})`);

          try {
            // Erst prüfen ob bereits vorhanden
            const { data: existing } = await supabase.from("bot_channels")
              .select("id").eq("id", chatIdStr).maybeSingle();

            let dbResult;
            if (existing) {
              // Update vorhandenen Eintrag (ohne optionale Spalten)
              dbResult = await supabase.from("bot_channels").update({
                title:      chat.title || chatIdStr,
                username:   chat.username || null,
                type:       chat.type,
                updated_at: new Date()
              }).eq("id", chatIdStr).select("id");
              logger.info(`[SmallTalk-Bot] Channel UPDATE: ${JSON.stringify(dbResult.error || "OK")}`);
            } else {
              // Neuen Eintrag anlegen - nur Kern-Spalten die garantiert existieren
              dbResult = await supabase.from("bot_channels").insert([{
                id:          chat.id,
                title:       chat.title || chatIdStr,
                username:    chat.username || null,
                type:        chat.type,
                is_active:   false,
                updated_at:  new Date()
              }]).select("id");
              logger.info(`[SmallTalk-Bot] Channel INSERT: ${JSON.stringify(dbResult.error || "OK")}`);
            }

            if (dbResult.error) {
              logger.error(`[SmallTalk-Bot] DB Fehler: code=${dbResult.error.code} msg=${dbResult.error.message}`);
            } else {
              // Erweiterte Felder optional updaten
              await supabase.from("bot_channels").update({
                ai_enabled:        false,
                added_by_user_id:  addedBy?.id   || null,
                added_by_username: addedBy?.username || null,
                settings_token:    settingsToken
              }).eq("id", chatIdStr).then(
                r  => r.error ? logger.warn("[SmallTalk-Bot] Extended fields:", r.error.message) : null
              );

              logger.info(`[SmallTalk-Bot] ✅ Channel erfolgreich gespeichert: ${chat.title} (${chatIdStr})`);
            }
          } catch (dbErr) {
            logger.error(`[SmallTalk-Bot] DB Exception: ${dbErr?.message || String(dbErr)}`);
          }

          // Nachricht an den Channel
          await tg.send(chat.id,
            `✅ <b>TG Admin-Helper aktiv!</b>\n\n` +
            `Verfügbare Befehle für Admins:\n` +
            `• /admin oder /menu – Verwaltungstools\n` +
            `• /settings – Channel-Einstellungen\n` +
            `• /clean – Gelöschte Accounts entfernen\n` +
            `• /safelist @user – User verifizieren\n` +
            `• /scamlist @user – Scammer melden\n\n` +
            `🔒 AI-Features → @autoacts kontaktieren.`
          );

          // Private Willkommensnachricht an den Admin
          if (addedBy?.id) {
            await tg.send(String(addedBy.id),
              `✅ <b>Bot wurde zu "${chat.title}" hinzugefügt!</b>\n\n` +
              `Schreibe <b>/settings</b> im Channel um die Einstellungen zu öffnen.\n` +
              `Du kannst das Menü direkt hier (privat) oder im Channel anzeigen lassen.\n\n` +
              `🤖 <b>Kostenlose Tools sind sofort aktiv.</b>\n` +
              `Für KI-Features: @autoacts kontaktieren.`
            ).catch(() => {});
          }

          logger.info(`[SmallTalk-Bot] Channel registriert: ${chat.title} (von @${addedBy?.username || addedBy?.id})`);
        }
        return;
      }

      // ── Callback-Queries (Inline-Buttons) ────────────────────────────────
      if (update.callback_query) {
        const q      = update.callback_query;
        const qChatId = String(q.message?.chat?.id || "");
        const qUserId = q.from?.id;
        const data   = q.data || "";

        // Delete the menu message after processing to prevent stale button use
      if (q.message?.message_id && q.message?.chat?.id) {
        await tg.call("deleteMessage", {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
        }).catch(() => {});
      }
      await tg.call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});

        // Settings-Menu: Hier oder Privat
        if (data.startsWith("settings_here_") || data.startsWith("settings_private_")) {
          const parts     = data.split("_");
          const sendPriv  = data.startsWith("settings_private_");
          const targetChannelId = parts[2];
          const ownerId   = parts[3] ? parseInt(parts[3]) : null;

          // Nur der Admin der /settings aufrief darf antworten
          if (sendPriv && ownerId && qUserId !== ownerId) return;
          if (!await isGroupAdmin(token, targetChannelId, qUserId)) return;

          const ch = await getChannel(targetChannelId);
          const sendTarget = sendPriv ? String(qUserId) : targetChannelId;

          await sendSettingsMenu(tg, sendTarget, targetChannelId, ch);
          return;
        }

        // Feedback confirmation callbacks (fb_confirm_pos/neg/no)
        if (data.startsWith("fb_confirm_")) {
          const parts3 = data.split("_");
          // fb_confirm_{pos|neg|no}_{username}_{submitterId}_{channelId}
          const fbType = parts3[2]; // pos | neg | no
          if (fbType === "no") {
            // Forward to channel admin
            const qChanId = parts3[parts3.length - 1];
            const origMsg = q.message?.text || "";
            const { data: chAdmin } = await supabase.from("bot_channels")
              .select("added_by_user_id").eq("id", String(qChanId)).maybeSingle().catch(() => ({ data: null }));
            if (chAdmin?.added_by_user_id) {
              await tg.call("sendMessage", { chat_id: String(chAdmin.added_by_user_id),
                text: `❓ Feedback-Einordnung unklar\n\nNachricht:\n<i>${origMsg.substring(0,200)}</i>\n\nBitte manuell einordnen.`,
                parse_mode: "HTML" });
            }
            await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Weitergeleitet." });
            return;
          }
          // pos or neg
          const feedbackType = fbType === "pos" ? "positive" : "negative";
          const targetUsername = parts3[3];
          const submitterId    = parts3[4];
          const chanId3        = parts3[5];
          try {
            const fbResult = await safelistService.submitFeedback({
              channelId: chanId3, submittedBy: submitterId, submittedByUsername: null,
              targetUsername, feedbackType,
              feedbackText: q.message?.reply_to_message?.text?.substring(0, 300) || ""
            });
            if (fbResult?.id) {
              const ch3 = await getChannel(chanId3);
              await safelistService.approveFeedback(fbResult.id, qUserId, ch3);
            }
          } catch (_) {}
          await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
          await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: feedbackType === "positive" ? "✅ Als Positiv gespeichert" : "⚠️ Als Negativ gespeichert" });
          return;
        }

        // Schedule repeat selection callbacks
        if (data.startsWith("sched_repeat_") || data === "sched_noop") {
          if (data === "sched_noop") {
            await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "⚠️ Free-Limit erreicht", show_alert: true });
            return;
          }
          // Parse sched_repeat_{type}_{channelId}
          const rMatch = data.match(/^sched_repeat_([a-z]+)_(-?\d+)$/);
          const repeatType = rMatch ? rMatch[1] : "once";
          const chanId2    = rMatch ? rMatch[2] : data.split("_").pop();
          const wizard = pendingInputs[String(qUserId)];
          if (!wizard || !wizard.action.startsWith("sched_wizard")) {
            await tg.call("answerCallbackQuery", { callback_query_id: q.id });
            return;
          }
          delete pendingInputs[String(qUserId)];

          // Toggle pin/delprev options (keeps wizard state)
          if (repeatType === "opt") {
            const subOpt = parts2[3]; // pin or delprev
            const key = String(qUserId);
            if (pendingInputs[key]) {
              if (subOpt === "pin")     pendingInputs[key].pinAfterSend   = !pendingInputs[key].pinAfterSend;
              if (subOpt === "delprev") pendingInputs[key].deletePrevious = !pendingInputs[key].deletePrevious;
            }
            // Re-show the same step
            await tg.call("answerCallbackQuery", {
              callback_query_id: q.id,
              text: subOpt === "pin" ? "📌 Anpinnen geändert" : "🔄 Löschen geändert"
            });
            // Re-render options
            const p2 = pendingInputs[key] || {};
            const pinOpt2    = "📌 Anpinnen: " + (p2.pinAfterSend ? "✅" : "❌");
            const delPrevOpt2 = "🔄 Vorherige löschen: " + (p2.deletePrevious ? "✅" : "❌");
            await tg.call("editMessageReplyMarkup", {
              chat_id: String(qUserId),
              message_id: q.message?.message_id,
              reply_markup: { inline_keyboard: [
                [{ text: "1x – Einmalig",  callback_data: "sched_repeat_once_" + chanId2 },
                 { text: "Täglich",        callback_data: "sched_repeat_daily_" + chanId2 }],
                [{ text: "Wöchentlich",    callback_data: "sched_repeat_weekly_" + chanId2 },
                 { text: "Monatlich",      callback_data: "sched_repeat_monthly_" + chanId2 }],
                [{ text: pinOpt2,          callback_data: "sched_opt_pin_" + chanId2 },
                 { text: delPrevOpt2,      callback_data: "sched_opt_delprev_" + chanId2 }]
              ]}
            }).catch(() => {});
            return;
          }

          const cronMap = { daily: "0 9 * * *", weekly: "0 9 * * 1", monthly: "0 9 1 * *" };
          const isRepeat = repeatType !== "once";
          const cronExpr = isRepeat ? cronMap[repeatType] || null : null;

          try {
            await supabase.from("scheduled_messages").insert([{
              channel_id:      chanId2,
              message:         wizard.msgText || "",
              photo_file_id:   wizard.fileId || null,
              photo_url:       null,
              cron_expr:       cronExpr,
              next_run_at:     wizard.nextRunAt || new Date().toISOString(),
              repeat:          isRepeat,
              is_active:       true,
              pin_after_send:  wizard.pinAfterSend  || false,
              delete_previous: wizard.deletePrevious || false
            }]);
            const repeatLabel = { once: "einmalig", daily: "täglich", weekly: "wöchentlich", monthly: "monatlich" }[repeatType] || repeatType;
            const dt = wizard.nextRunAt ? new Date(wizard.nextRunAt).toLocaleString("de-DE") : "sofort";
            await tg.call("sendMessage", { chat_id: String(qUserId),
              text: `✅ <b>Geplante Nachricht gespeichert!</b>\n\n` +
                    `📝 Text: ${(wizard.msgText||"").substring(0,80)}${wizard.fileId ? "\n📎 Medien: ✅" : ""}\n` +
                    `📅 Zeit: ${dt}\n🔁 Wiederholung: ${repeatLabel}`,
              parse_mode: "HTML" });
          } catch (e2) {
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Fehler beim Speichern: " + e2.message });
          }
          return;
        }

        // Package purchase: channel selected
        if (data.startsWith("buy_chan_")) {
          const buyChanId = data.split("_")[2];
          const pend = pendingInputs[String(qUserId)] || {};
          const pkgs = pend.packages;
          if (!pkgs?.length) {
            const { data: pkgsFresh } = await supabase.from("channel_packages")
              .select("*").eq("is_active", true).order("sort_order");
            pendingInputs[String(qUserId)] = { action: "buy_select_pkg", channelId: buyChanId, packages: pkgsFresh };
          } else {
            pendingInputs[String(qUserId)] = { ...pend, action: "buy_select_pkg", channelId: buyChanId };
          }
          const activePkgs = (pkgs || []).filter(p => p.is_active !== false);
          const pkgKb = activePkgs.map(p => [{
            text: `📦 ${p.name} — ${p.credits.toLocaleString()} Credits · ${parseFloat(p.price_eur).toFixed(2)} €`,
            callback_data: "buy_pkg_" + p.id + "_" + buyChanId
          }]);
          pkgKb.push([{ text: "❌ Abbrechen", callback_data: "buy_cancel" }]);
          const chTitle = (await supabase.from("bot_channels").select("title").eq("id", buyChanId).maybeSingle()).data?.title || buyChanId;
          await tg.call("editMessageText", {
            chat_id: String(qUserId),
            message_id: q.message?.message_id,
            text: `🛒 <b>Paket für "${chTitle}" wählen:</b>\n\nAlle Pakete laufen 30 Tage.`,
            parse_mode: "HTML", reply_markup: { inline_keyboard: pkgKb }
          }).catch(async () => {
            await tg.call("sendMessage", { chat_id: String(qUserId),
              text: `🛒 <b>Paket für "${chTitle}" wählen:</b>\n\nAlle Pakete laufen 30 Tage.`,
              parse_mode: "HTML", reply_markup: { inline_keyboard: pkgKb }
            });
          });
          return;
        }

        // Package selected → generate checkout
        if (data.startsWith("buy_pkg_")) {
          const parts4 = data.match(/^buy_pkg_(\d+)_(-?\d+)$/);
          if (!parts4) return;
          const pkgId   = parseInt(parts4[1]);
          const chanId4 = parts4[2];
          delete pendingInputs[String(qUserId)];

          const { data: pkg } = await supabase.from("channel_packages").select("*").eq("id", pkgId).single().catch(() => ({ data: null }));
          const { data: settingsRow } = await supabase.from("settings").select("sellauth_api_key, sellauth_shop_id, sellauth_shop_url").single().catch(() => ({ data: null }));

          if (!pkg) {
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Paket nicht gefunden." });
            return;
          }

          await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });

          try {
            const packageService = require("../services/packageService");
            const result = await packageService.generateCheckoutUrl(
              pkg, chanId4,
              settingsRow?.sellauth_shop_url, settingsRow?.sellauth_api_key, settingsRow?.sellauth_shop_id
            );

            if (result.checkoutUrl) {
              await tg.call("sendMessage", { chat_id: String(qUserId),
                text: `✅ <b>${pkg.name} — ${pkg.credits.toLocaleString()} Credits</b>\n\n` +
                      `💰 Preis: ${parseFloat(pkg.price_eur).toFixed(2)} €\n` +
                      `📅 Laufzeit: ${pkg.duration_days || 30} Tage\n\n` +
                      `Zum Bezahlen tippst du auf den Button:`,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[
                  { text: "💳 Jetzt kaufen", url: result.checkoutUrl }
                ]]}
              });
            } else {
              await tg.call("sendMessage", { chat_id: String(qUserId),
                text: "❌ Checkout konnte nicht erstellt werden. Kontaktiere @autoacts." });
            }
          } catch (e2) {
            logger.error("[Buy] Checkout-Fehler:", e2.message);
            await tg.call("sendMessage", { chat_id: String(qUserId),
              text: `❌ Fehler: ${e2.message}\n\nBitte kontaktiere @autoacts.` });
          }
          return;
        }

        if (data === "buy_cancel") {
          await tg.call("deleteMessage", { chat_id: String(qUserId), message_id: q.message?.message_id }).catch(() => {});
          delete pendingInputs[String(qUserId)];
          return;
        }

        // Channel selection in private chat
        if (data.startsWith("sel_channel_")) {
          const selChanId = data.split("_")[2];
          const ch = await getChannel(selChanId);
          await sendSettingsMenu(tg, String(qUserId), selChanId, ch);
          return;
        }

        // Settings sub-callbacks
        if (data.startsWith("cfg_")) {
          await handleSettingsCallback(tg, supabase, data, q, qUserId);
          return;
        }

        // Feedback approve/reject callbacks
        if (data.startsWith("fb_approve_") || data.startsWith("fb_reject_")) {
          const feedbackId = data.split("_")[2];
          const ch2 = {}; // We'll load channel from feedback
          if (data.startsWith("fb_approve_")) {
            await safelistService.approveFeedback(feedbackId, qUserId, ch2);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "✅ Meldung bestätigt. User wurde auf Scamliste gesetzt." });
          } else {
            await safelistService.rejectFeedback(feedbackId, qUserId);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Meldung abgelehnt." });
          }
          return;
        }

        // Admin tools callbacks
        const ch = await getChannel(qChatId);
        await tgAdminHelper.handleCallback(token, q, ch);
        return;
      }

      const msg    = update.message || update.channel_post;
      if (!msg)    return;
      const chat   = msg.chat   || {};
      const from   = msg.from   || {};
      const text   = msg.text?.trim() || "";
      const chatId = String(chat.id);

      // ── Privat-Chat: /start Onboarding ───────────────────────────────────
      if (chat.type === "private") {
        // Pending input (welcome/goodbye/proof text OR media)
        const hasPending = pendingInputs[String(from.id)];
        // UserInfo: forwarded message handling
        if (hasPending?.action === "userinfo_awaiting" && (msg?.forward_from || msg?.forward_sender_name)) {
          await handlePendingInput(tg, supabase, from.id, msg?.text || "", settings, msg);
          return;
        }
        // Wizard media handling
        if (hasPending?.action === "sched_wizard_file" && (msg?.photo || msg?.animation || msg?.video)) {
          await _handleWizardMedia(tg, supabase, from.id, hasPending, msg);
          return;
        }
        if (hasPending?.action === "collecting_proofs" && (msg?.photo || msg?.video || msg?.document)) {
          await handlePendingInput(tg, supabase, from.id, "", settings, msg);
          return;
        }
        if (text && !text.startsWith("/")) {
          const handled = await handlePendingInput(tg, supabase, from.id, text, settings, msg);
          if (handled) return;
        }
        if (text === "/cancel") {
          await handlePendingInput(tg, supabase, from.id, "/cancel", settings, null);
          return;
        }
        // /buy – package purchase flow
        if (/^\/buy(@\w+)?/i.test(text) || text.toLowerCase() === "credits kaufen") {
          const { data: pkgs } = await supabase.from("channel_packages")
            .select("*").eq("is_active", true).order("sort_order");
          if (!pkgs?.length) {
            await tg.send(chatId, "❌ Keine Pakete verfügbar. Bitte kontaktiere @autoacts.");
            return;
          }
          // If user has channels, ask which one
          const { data: myChans } = await supabase.from("bot_channels")
            .select("id, title, type").eq("added_by_user_id", String(from.id));
          if (!myChans?.length) {
            await tg.send(chatId, "❌ Du hast noch keinen registrierten Channel. Füge mich erst als Admin hinzu.");
            return;
          }
          pendingInputs[String(from.id)] = { action: "buy_select_channel", packages: pkgs };
          const chanKb = myChans.map(ch2 => [{
            text: (ch2.type==="channel"?"📢":"👥") + " " + (ch2.title||ch2.id),
            callback_data: "buy_chan_" + ch2.id
          }]);
          const buyMsg = await tg.call("sendMessage", { chat_id: chatId,
            text: "🛒 <b>Credit-Paket kaufen</b>\n\nFür welchen Channel?",
            parse_mode: "HTML", reply_markup: { inline_keyboard: chanKb }
          });
          if (buyMsg?.message_id) void safelistService.trackBotMessage(chatId, buyMsg.message_id, "temp", 10*60*1000);
          return;
        }

        // All navigation commands → smart channel picker
        if (/^\/(?:start|menu|settings|dashboard|help)(@\w+)?/i.test(text)) {
          const { data: myChannels2 } = await supabase.from("bot_channels")
            .select("id, title, type, is_approved, ai_enabled").eq("added_by_user_id", String(from.id));

          if (!myChannels2?.length) {
            // Detect language from user's Telegram settings
            const userLang = detectLang(from);
            const introMsg = (typeof WELCOME_INTRO === "function" ? WELCOME_INTRO : null)
              || require("../services/i18n").t("welcome_intro", userLang, from?.first_name || "");
            const s2 = await tg.send(chatId, introMsg);
            if (s2?.message_id) void safelistService.trackBotMessage(chatId, s2.message_id, "temp", 10 * 60 * 1000);
            return;
          }

          if (myChannels2.length === 1) {
            const ch2 = await getChannel(String(myChannels2[0].id));
            const s2 = await sendSettingsMenu(tg, chatId, String(myChannels2[0].id), ch2);
            if (s2?.message_id) void safelistService.trackBotMessage(chatId, s2.message_id, "temp", 10 * 60 * 1000);
            return;
          }

          const keyboard = myChannels2.map(ch2 => [{
            text: (ch2.type === "channel" ? "📢" : "👥") + " " + (ch2.title || ch2.id),
            callback_data: "sel_channel_" + ch2.id
          }]);
          const s2 = await tg.call("sendMessage", { chat_id: chatId, text: "⚙️ Wähle deinen Channel:", reply_markup: { inline_keyboard: keyboard } });
          if (s2?.message_id) void safelistService.trackBotMessage(chatId, s2.message_id, "temp", 10 * 60 * 1000);
          return;
        }

        // /settings in private chat: show all channels this user admins
        if (text === "/settings" || text.startsWith("/settings@")) {
          const { data: myChannels } = await supabase.from("bot_channels")
            .select("id, title, type, is_approved, ai_enabled").eq("added_by_user_id", String(from.id));
          if (!myChannels?.length) {
            await tg.send(chatId, "Du hast noch keinen Channel/Gruppe mit diesem Bot verknüpft.\nFüge mich als Admin in deiner Gruppe/Channel ein und schreibe dann /settings dort.");
            return;
          }
          if (myChannels.length === 1) {
            const ch = await getChannel(String(myChannels[0].id));
            await sendSettingsMenu(tg, chatId, String(myChannels[0].id), ch);
            return;
          }
          // Mehrere Channels → Auswahl
          const keyboard = myChannels.map(ch => [{
            text: (ch.type === "channel" ? "📢" : "👥") + " " + (ch.title || ch.id) + (ch.is_approved ? " ✅" : " ⏳"),
            callback_data: "sel_channel_" + ch.id
          }]);
          await tg.call("sendMessage", { chat_id: chatId, text: "Wähle den Channel/Gruppe für die Einstellungen:", reply_markup: { inline_keyboard: keyboard } });
          return;
        }

        // AI-Feature: Fragen beantworten (wenn Kanal freigeschaltet)
        const ch = await getChannel(chatId);
        if (ch?.is_approved && ch?.ai_enabled) {
          const smalltalkAgent = require("../services/ai/smalltalkAgent");
          const result = await smalltalkAgent.handle({ chatId, text, settings, channelRecord: ch });
          if (result.reply) await tg.send(chatId, result.reply);
        }
        return;
      }

      // ── Gruppen/Channel ───────────────────────────────────────────────────
      const ch = await getChannel(chatId);

      // Member-Tracking
      if (msg.new_chat_members) {
        for (const u of msg.new_chat_members) {
          await tgAdminHelper.trackMember(chatId, u);
          if (ch) await tgAdminHelper.sendWelcome(token, chatId, u, ch);
        }
        return;
      }
      if (msg.left_chat_member) {
        await tgAdminHelper.trackLeft(chatId, msg.left_chat_member.id);
        if (ch) await tgAdminHelper.sendGoodbye(token, chatId, msg.left_chat_member, ch);
        return;
      }

      // User tracken bei jeder Nachricht (from kann bei Channel-Posts fehlen)
      if (from?.id) await tgAdminHelper.trackMember(chatId, from).catch(() => {});

      if (!text) return;

      // ── Admin-Befehle ─────────────────────────────────────────────────────
      const adminCmds = ["/admin", "/menu", "/help"];
      if (adminCmds.some(cmd => text.startsWith(cmd))) {
        if (await isGroupAdmin(token, chatId, from.id)) {
          await tgAdminHelper.sendAdminMenu(token, chatId, msg.message_id);
        } else {
          // Nicht-Admin bekommt neutrale Meldung
          await tg.send(chatId, "🔧 Hier wird gerade gearbeitet.");
        }
        return;
      }

      // /settings – Frage: Privat oder Hier?
      if (text === "/settings" || text.startsWith("/settings@")) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.call("sendMessage", {
          chat_id: chatId,
          text: "⚙️ Wo soll das Einstellungs-Menü geöffnet werden?",
          reply_markup: { inline_keyboard: [[
            { text: "💬 Hier im Chat", callback_data: `settings_here_${chatId}` },
            { text: "🔒 Privat (nur für mich)", callback_data: `settings_private_${chatId}_${from.id}` }
          ]]}
        });
        return;
      }

      // /clean – Gelöschte Accounts entfernen
      if (text === "/clean" || text.startsWith("/clean@")) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.send(chatId, "🔍 Prüfe Mitgliederliste...");
        const result = await tgAdminHelper.cleanDeletedAccounts(token, chatId);
        await tg.send(chatId, `🧹 Fertig! ${result.checked} geprüft, ${result.removed} entfernt.`);
        return;
      }

      // /pin – Nachricht pinnen (Reply)
      if ((text === "/pin" || text.startsWith("/pin@")) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tgApi(token).pinMessage(chatId, msg.reply_to_message.message_id);
        await tg.send(chatId, "📌 Gepinnt!");
        return;
      }

      // /del – Nachricht löschen (Reply)
      if ((text === "/del" || text.startsWith("/del@")) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.deleteMessage(chatId, msg.reply_to_message.message_id).catch(() => {});
        await tg.deleteMessage(chatId, msg.message_id).catch(() => {});
        return;
      }

      // ── Kontext-Tracking: alle User-Nachrichten speichern ─────────────────
      if (text && from?.id && !text.startsWith("/")) {
        void safelistService.saveContextMsg(chatId, from.id, from.username, text);
      }

      // ── Intelligente Feedback-Erkennung ──────────────────────────────────
      if (text && from?.id && !text.startsWith("/") && ch?.safelist_enabled && !from.is_bot) {
        const fbDetect = _detectFeedback(text);
        if (fbDetect) {
          const confirmMsg = await tg.call("sendMessage", { chat_id: chatId,
            text: `💬 Feedback erkannt für @${fbDetect.username}\n<i>${text.substring(0,100)}</i>\n\nEinordnung:`,
            parse_mode: "HTML", reply_to_message_id: msg.message_id,
            reply_markup: { inline_keyboard: [[
              { text: "✅ Positiv", callback_data: `fb_confirm_pos_${fbDetect.username}_${from.id}_${chatId}` },
              { text: "⚠️ Negativ", callback_data: `fb_confirm_neg_${fbDetect.username}_${from.id}_${chatId}` },
              { text: "❌ Keins",   callback_data: `fb_confirm_no_${chatId}` }
            ]]}
          }).catch(() => null);
          if (confirmMsg?.message_id) void safelistService.trackBotMessage(chatId, confirmMsg.message_id, "temp", 2*60*1000);
        }
      }

      // ── Safelist/Scamlist: nur wenn aktiviert ────────────────────────────
      const safelistActive = ch?.safelist_enabled || false;
      const aiActive       = ch?.ai_enabled       || false;

      // ── /feedbacks @user oder /check @user ────────────────────────────────
      const feedbackCmds = /^\/(?:feedbacks?|check)\s+@?(\w+)/i;
      const feedbackMatch = text.match(feedbackCmds);
      if (feedbackMatch && safelistActive) {
        const targetUsername = feedbackMatch[1];
        const feedbacks = await safelistService.getFeedbacks(chatId, targetUsername, null);
        const scamEntry  = await safelistService.checkScamlist(chatId, targetUsername, null);

        let replyText;
        if (scamEntry) {
          replyText = `⛔ <b>@${targetUsername} steht auf der Scamliste!</b>
${scamEntry.reason ? scamEntry.reason.substring(0,150) : ""}
`;
          if (scamEntry.ai_summary) replyText += `
🤖 ${scamEntry.ai_summary}`;
        } else if (ch?.ai_enabled) {
          const aiSummary = await safelistService.generateAiSummary(chatId, targetUsername, null);
          replyText = safelistService.buildFullText(feedbacks, targetUsername, aiSummary);
        } else {
          replyText = safelistService.buildStatsText(feedbacks, targetUsername);
        }

        const sentMsg = await tg.send(chatId, replyText);
        // Auto-delete nach 5 Minuten
        if (sentMsg?.message_id) {
          void safelistService.trackBotMessage(chatId, sentMsg.message_id, "check_result", 5 * 60 * 1000);
        }
        return;
      }

      // ── /feedbacks ohne @user → eigene Liste ─────────────────────────────
      if (/^\/feedbacks?$/i.test(text)) {
        const all = await safelistService.getFeedbacks(chatId, null, null);
        const pos = all.filter(f => f.feedback_type === "positive").length;
        const neg = all.filter(f => f.feedback_type === "negative").length;
        const sent = await tg.send(chatId, `📋 <b>Feedback-Übersicht</b>\n✅ ${pos} positive · ⚠️ ${neg} negative bestätigte Einträge.`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        return;
      }

      // ── /safelist @user – NUR FÜR ADMINS ─────────────────────────────────
      const safelistAdminMatch = text.match(/^\/safe?list[e]?\s+@?(\w+)\s*(.*)/i);
      if (safelistAdminMatch && safelistActive) {
        if (!await isGroupAdmin(token, chatId, from.id)) {
          const sent = await tg.send(chatId, "🔒 Nur Channel-Admins können Mitglieder verifizieren.");
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 10000);
          return;
        }
        const [, username, feedback] = safelistAdminMatch;
        const fb = await safelistService.submitFeedback({
          channelId: chatId, submittedBy: from?.id, submittedByUsername: from?.username,
          targetUsername: username, feedbackType: "positive",
          feedbackText: feedback || "Vom Channel-Admin verifiziert"
        });
        if (fb?.id) {
          const ch2 = await getChannel(chatId);
          await safelistService.approveFeedback(fb.id, from.id, ch2);
        }
        const sent = await tg.send(chatId, `✅ @${username} wurde auf die Safelist gesetzt.`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
        return;
      }

      // ── /scamlist @user – Scam-Meldung mit Proofs ────────────────────────
      const scamMatch = text.match(/^\/scam?list[e]?\s+@?(\w+)\s*(.*)/i);
      if (scamMatch && safelistActive) {
        const [, username, reason] = scamMatch;
        const fb = await safelistService.submitFeedback({
          channelId: chatId, submittedBy: from?.id, submittedByUsername: from?.username,
          targetUsername: username, feedbackType: "negative",
          feedbackText: reason || "Scam-Verdacht"
        });
        if (fb?.id) {
          // Pending-State für Proof-Bestätigung im Channel
          pendingInputs["scam_confirm_" + String(from?.id) + "_" + chatId] = {
            action: "await_proof_confirm", feedbackId: fb.id,
            targetUsername: username, channelId: chatId, reporterUsername: from?.username
          };
          const sent = await tg.send(chatId,
            `⚠️ Scam-Meldung gegen @${username} eingereicht.\n\n` +
            `Hast du Beweise (Screenshots, Videos, Texte)?\n` +
            `Antworte mit <b>"Ich habe Proofs"</b> um Beweise privat einzureichen.\n\n` +
            `<i>Ohne Beweise wird die Meldung möglicherweise abgelehnt.</i>`
          );
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 60000);
        }
        return;
      }

      // ── "Ich habe Proofs" Bestätigung im Channel ─────────────────────────
      if (/ich habe proofs?/i.test(text) && from?.id && safelistActive) {
        const key = "scam_confirm_" + String(from.id) + "_" + chatId;
        const pending = pendingInputs[key];
        if (pending) {
          delete pendingInputs[key];
          // Proof-State im privaten Chat aktivieren
          pendingInputs[String(from.id)] = {
            action: "collecting_proofs", feedbackId: pending.feedbackId,
            channelId: chatId, targetUsername: pending.targetUsername,
            reporterUsername: pending.reporterUsername, proofCount: 0
          };
          const sent = await tg.send(chatId,
            `📩 Bitte schicke deine Beweise <b>direkt im privaten Chat</b> mit @${settings?.smalltalk_bot_username || "dem Bot"}.\n` +
            `→ Öffne den Bot-Chat und tippe /start falls noch nicht geschehen.`
          );
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 30000);
        }
        return;
      }

      // ── /scamlist ohne @user → Scamliste anzeigen ────────────────────────
      if (/^\/scam?list[e]?(@\w+)?$/i.test(text) && safelistActive) {
        const { data: scamList } = await supabase.from("scam_entries").select("username, user_id, reason").eq("channel_id", chatId).limit(20);
        if (!scamList?.length) {
          const sent = await tg.send(chatId, "⚠️ <b>Scamliste</b>\n\nNoch keine bestätigten Einträge.");
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        } else {
          const lines = scamList.map(s => `⛔ @${s.username || s.user_id}${s.reason ? " – " + s.reason.substring(0, 60) : ""}`).join("\n");
          const sent = await tg.send(chatId, `⚠️ <b>Scamliste (${scamList.length})</b>\n\n${lines}`);
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        }
        return;
      }

      // /userinfo – Public user lookup (rate-limited)
      const isUserinfoCmd = /^\/userinfo(@\w+)?/i.test(text);
      if (isUserinfoCmd) {
        let lookupId = null;
        let replyMsgId = msg.message_id;

        // Extract ID from command: /userinfo 123456789 or /userinfo @username
        const uiArg = text.replace(/^\/userinfo(@\w+)?\s*/i, "").trim();
        if (uiArg) {
          lookupId = uiArg; // @username or numeric ID
        } else if (msg.reply_to_message?.from) {
          lookupId = String(msg.reply_to_message.from.id);
          replyMsgId = msg.reply_to_message.message_id;
        }

        if (!lookupId) {
          const hint = await tg.send(chatId, "💡 Nutze /userinfo @username, /userinfo [ID] oder als Reply auf eine Nachricht mit /userinfo");
          if (hint?.message_id) void safelistService.trackBotMessage(chatId, hint.message_id, "temp", 10000);
          // Delete command after hint
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } else {
          // Run first, then delete command
          await _runUserInfo(tg, supabase, from.id, lookupId, chatId, null, chatId);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        }
        return;
      }

      // ── /help – Rollenspezifische Befehle ─────────────────────────────────────
      if (/^\/help(@\w+)?$/i.test(text)) {
        const isAdm = await isGroupAdmin(token, chatId, from.id);
        let helpText;
        if (isAdm) {
          helpText = `📋 <b>Admin-Befehle</b>\n\n` +
            `<b>/ai [Frage]</b> – KI-Antwort anfordern\n` +
            `<b>/ban [Grund]</b> (Reply) – User dauerhaft bannen\n` +
            `<b>/unban [ID]</b> – User entbannen\n` +
            `<b>/mute [Dauer] [Grund]</b> (Reply) – User stummschalten\n` +
            `  Dauer: 1h / 12h / 24h / 7d / 30d / permanent\n` +
            `<b>/del</b> (Reply) – Nachricht löschen\n` +
            `<b>/pin</b> (Reply) – Nachricht pinnen\n` +
            `<b>/userinfo [ID|@user]</b> – User-Informationen abrufen\n` +
            `<b>/safelist @user</b> – User verifizieren\n` +
            `<b>/scamlist @user</b> – Scam melden\n` +
            `<b>/feedbacks @user</b> – Feedbacks einsehen\n` +
            `<b>/clean</b> – Gelöschte Accounts entfernen\n` +
            `<b>/settings</b> – Bot-Einstellungen (privat)`;
        } else {
          helpText = `📋 <b>Verfügbare Befehle</b>\n\n` +
            (ch?.ai_enabled ? `<b>/ai [Frage]</b> – KI-Assistent befragen\n` : "") +
            (ch?.safelist_enabled ? `<b>/feedbacks @user</b> – Feedbacks zu einem User\n<b>/check @user</b> – Status prüfen\n<b>/scamlist @user [Grund]</b> – Scammer melden\n` : "") +
            `<b>/userinfo [ID|@user]</b> – User-Info (5x/Tag kostenlos)\n` +
            `<b>/help</b> – Diese Hilfe`;
        }
        const helpMsg = await tg.send(chatId, helpText);
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 5 * 60 * 1000);
        return;
      }

      // ── /ban ─────────────────────────────────────────────────────────────────
      if (/^\/ban(@\w+)?/i.test(text) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        const banTarget = msg.reply_to_message.from;
        if (!banTarget?.id) return;
        const banReason = text.replace(/^\/ban(@\w+)?\s*/i, "").trim() || "Kein Grund angegeben";
        try {
          // Ban + prevent future joins (until_date=0 = permanent)
          await tg.call("banChatMember", { chat_id: chatId, user_id: banTarget.id, until_date: 0, revoke_messages: false });
          const target = banTarget.username ? "@" + banTarget.username : (banTarget.first_name || String(banTarget.id));
          const banMsg = await tg.send(chatId, `🚫 ${target} wurde gebannt.\nGrund: ${banReason.substring(0,100)}`);
          if (banMsg?.message_id) void safelistService.trackBotMessage(chatId, banMsg.message_id, "temp", 5 * 60 * 1000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e2) { logger.warn("[Ban]", e2.message); }
        return;
      }

      // ── /unban ────────────────────────────────────────────────────────────────
      if (/^\/unban(@\w+)?\s+(\S+)/i.test(text)) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        const unbanId = text.match(/^\/unban(@\w+)?\s+(\S+)/i)?.[2];
        if (!unbanId) return;
        try {
          await tg.call("unbanChatMember", { chat_id: chatId, user_id: unbanId, only_if_banned: false });
          const unbanMsg = await tg.send(chatId, `✅ User <code>${unbanId}</code> wurde entbannt.`);
          if (unbanMsg?.message_id) void safelistService.trackBotMessage(chatId, unbanMsg.message_id, "temp", 15000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e2) {
          const errMsg = await tg.send(chatId, `❌ Entbannen fehlgeschlagen: ${e2.message}`);
          if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 10000);
        }
        return;
      }

      // ── /mute ─────────────────────────────────────────────────────────────────
      const muteMatch = text.match(/^\/mute(@\w+)?(?:\s+(\d+[smhd]|permanent))?(?:\s+(.+))?/i);
      const muteTarget = msg.reply_to_message?.from || null;
      const muteByIdMatch = !msg.reply_to_message && text.match(/^\/mute(@\w+)?\s+(\d+)(?:\s+(\d+[smhd]|permanent))?(?:\s+(.+))?/i);

      if ((muteMatch && muteTarget) || muteByIdMatch) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        let targetId, targetName, durationStr, muteReason;

        if (muteByIdMatch) {
          targetId   = muteByIdMatch[2];
          durationStr = muteByIdMatch[3] || "24h";
          muteReason  = muteByIdMatch[4] || "";
          targetName  = `<code>${targetId}</code>`;
        } else {
          targetId    = muteTarget.id;
          targetName  = muteTarget.username ? "@" + muteTarget.username : (muteTarget.first_name || String(muteTarget.id));
          durationStr = muteMatch[2] || "24h";
          muteReason  = muteMatch[3] || "";
        }

        // Parse duration
        const durationSeconds = _parseDuration(durationStr);
        const untilDate = durationSeconds === -1 ? 0 : Math.floor(Date.now() / 1000) + durationSeconds;
        const displayDur = durationSeconds === -1 ? "permanent" : durationStr;

        try {
          await tg.call("restrictChatMember", {
            chat_id: chatId,
            user_id: targetId,
            permissions: { can_send_messages: false, can_send_other_messages: false, can_add_web_page_previews: false },
            until_date: untilDate
          });
          const muteMsg = await tg.send(chatId,
            `🔇 ${targetName} wurde ${displayDur} stummgeschaltet.${muteReason ? "\nGrund: " + muteReason.substring(0,100) : ""}`
          );
          if (muteMsg?.message_id) void safelistService.trackBotMessage(chatId, muteMsg.message_id, "temp", 5 * 60 * 1000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e2) { logger.warn("[Mute]", e2.message); }
        return;
      }

      // Reply auf Bot-Nachricht → impliziter /ai Befehl
      const isReplyToBot = msg.reply_to_message && from?.id
        ? await safelistService.isBotMessage(chatId, msg.reply_to_message.message_id)
        : false;

      // /ai [Frage] oder Reply auf Bot-Nachricht
      const aiMatch = text.match(/^\/ai\s+(.*)/i);
      const aiQuestion = aiMatch ? aiMatch[1].trim() : (isReplyToBot && !text.startsWith("/") ? text : null);

      // Check if this thread/topic is blocked for AI
      const blockedThreads = Array.isArray(ch?.blocked_thread_ids) ? ch.blocked_thread_ids : [];
      const currentThread  = msg.message_thread_id || 0;
      const threadBlocked  = currentThread && blockedThreads.includes(currentThread);

      if (aiQuestion && ch?.is_approved && ch?.ai_enabled && !threadBlocked) {
        // Kontext: vollständiger Gesprächsverlauf mit diesem User
        const history = from?.id ? await safelistService.getConversationHistory(chatId, from.id, 5) : [];

        // User-Nachricht vorab speichern
        if (from?.id) void safelistService.saveUserMessage(chatId, from.id, aiQuestion, msg.message_id);

        const smalltalkAgent = require("../services/ai/smalltalkAgent");
        const result = await smalltalkAgent.handle({ chatId, text: aiQuestion, settings, channelRecord: ch, history });
        if (result.reply) {
          // Reply to original message in same thread (forum topic support)
          const replyExtra = {};
          if (msg.message_id) replyExtra.reply_to_message_id = msg.message_id;
          if (msg.message_thread_id) replyExtra.message_thread_id = msg.message_thread_id;

          const sentAiMsg = await tg.send(chatId, result.reply, replyExtra);
          if (from?.id && sentAiMsg?.message_id) {
            void safelistService.saveAssistantMessage(chatId, from.id, result.reply, sentAiMsg.message_id);
          }
        }
      } else if (aiMatch && ch && ch.token_budget_exhausted) {
        const sent = await tg.send(chatId, "⚠️ KI aktuell nicht verfügbar. Richte dich an den Channel-Admin für mehr Informationen.");
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
      } else if (aiMatch && ch && !ch.ai_enabled) {
        const sent = await tg.send(chatId, "🔒 AI-Features sind für diesen Channel noch nicht freigeschaltet.\n\nWende dich an @autoacts für die Aktivierung.");
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
      }

    } catch (e) {
      const msg = e?.response?.data?.description || e?.message || String(e) || "Unbekannter Fehler";
      const stk = e?.stack ? e.stack.split('\n').slice(0,4).join(' → ') : "kein Stack";
      logger.error(`[SmallTalk-Bot] Fehler: ${msg}`);
      logger.error(`[SmallTalk-Bot] Stack: ${stk}`);
    }
  });
});

module.exports = router;
