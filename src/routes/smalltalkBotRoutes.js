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
           { text: "📊 Übersicht",      callback_data: `cfg_sl_overview_${channelId}` }]
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
      const { data: scamList } = await supabase_db.from("scam_entries").select("username, user_id").eq("channel_id", channelId).limit(20);
      const { data: safeList } = await supabase_db.from("user_feedbacks").select("target_username").eq("channel_id", channelId).eq("feedback_type", "positive").eq("status", "approved").limit(20);
      let txt = `📊 <b>Safelist-Übersicht</b>\n\n`;
      txt += `✅ Verifizierte User: ${safeList?.length || 0}\n`;
      txt += `⛔ Scamliste: ${scamList?.length || 0}\n\n`;
      if (scamList?.length) txt += `⛔ Scammer:\n` + scamList.slice(0,5).map(s => `• @${s.username||s.user_id}`).join("\n");
      await tg.call("sendMessage", { chat_id: String(userId), text: txt, parse_mode: "HTML" });
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
          ...(schedMsgs?.length ? [[{ text: "🗑 Nachricht löschen", callback_data: `cfg_sched_del_${channelId}` }]] : [])
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
        ? `🔋 Token-Budget: ${ch.token_used||0} / ${ch.token_limit} (${Math.round((ch.token_used||0)/ch.token_limit*100)}%)`
        : "🔋 Token-Budget: unbegrenzt";
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
          [{ text: "📊 Mein Token-Verbrauch", callback_data: `cfg_ai_stats_${channelId}` }],
          [{ text: "🔇 Gesperrte Themen",    callback_data: `cfg_ai_threads_${channelId}` }]
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
        text: `📊 <b>Token-Verbrauch</b>\n\n` +
              `🔋 ${tUsed.toLocaleString()} / ${tLimit ? tLimit.toLocaleString() : "∞"} Token\n` +
              (bar ? `${bar}\n` : "") +
              `\nStatus: ${exhausted ? "⛔ Budget erschöpft" : "✅ Aktiv"}\n\n` +
              (exhausted
                ? "⚠️ Dein Token-Budget ist aufgebraucht. Kontaktiere @autoacts um Token aufzuladen."
                : `Für Token-Aufladung: @autoacts`),
        parse_mode: "HTML" });
      break;
    }
    case "ai_summary": {
      // Cooldown only if last summary was successful (≥10 Token verbraucht)
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
      // Schätzung: ~300 Output-Token, x2 für Admin = 600 Token
      const SUMMARY_TOKEN_EST = 300;
      const SUMMARY_BILLED    = SUMMARY_TOKEN_EST * 2;  // Admin zahlt 2x Output-Token
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
          ]]}
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
        reply_markup: { inline_keyboard: langButtons }
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


// ── Token-Budget prüfen und ggf. AI deaktivieren ──────────────────────────────
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
        text: `⚠️ <b>Token-Budget für "${channel.title}" erschöpft!</b>\n\n` +
              `Verbraucht: ${channel.token_used.toLocaleString()} / ${channel.token_limit.toLocaleString()} Token\n\n` +
              `KI-Features wurden deaktiviert. Alle anderen Features laufen weiter.\n` +
              `Token aufladen: @autoacts`,
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

  // Format: [Zeit] User-ID/Username: Nachricht
  const lines = ctxMsgs.map(m => {
    const t = new Date(m.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return `[${t}] User${m.user_id}: ${(m.content || "").substring(0, 200)}`;
  }).join("\n").substring(0, 5000);

  try {
    const axios = require("axios");
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 500,
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

  // x2 Output-Token für Admin abrechnen (Summary-Premium)
  const rawOutTokens    = result.outTokens || 0;
  const billedTokens    = rawOutTokens * 2;       // Admin zahlt doppelt
  const actualUsd       = result.usd || 0;

  // last_summary_at NUR setzen wenn echte Token verbraucht (≥10 = Erfolg)
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
      note = "\n\n⚠️ Token-Budget überschritten. KI vorübergehend deaktiviert. Token aufladen: @autoacts";
    }
  } catch (_) {}

  // Zusammenfassung senden (erst nach Abrechnung → zeigt korrekten Verbrauch)
  await tg.call("sendMessage", { chat_id: String(adminUserId),
    text: result.text + `\n\n<i>📊 ${billedTokens} Token berechnet (${rawOutTokens} × 2)</i>` + note,
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

      // /ban – Reply auf Nachricht zum Bannen (nur Admins)
      if ((text === "/ban" || text.startsWith("/ban ") || text.startsWith("/ban@")) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        const banTarget = msg.reply_to_message.from;
        if (!banTarget?.id) return;
        const banReason = text.replace(/^\/ban(@\w+)?\s*/i, "").trim() || "Kein Grund angegeben";
        try {
          await tg.call("banChatMember", { chat_id: chatId, user_id: banTarget.id, revoke_messages: false });
          const banMsg = await tg.send(chatId,
            `🚫 @${banTarget.username || banTarget.first_name || banTarget.id} wurde gebannt.\nGrund: ${banReason.substring(0,100)}`
          );
          // Auto-delete Bestätigung nach 5 Minuten
          if (banMsg?.message_id) {
            void safelistService.trackBotMessage(chatId, banMsg.message_id, "temp", 5 * 60 * 1000);
          }
          // Original-Nachricht löschen
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e2) {
          logger.warn("[Ban] Fehler:", e2.message);
        }
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
