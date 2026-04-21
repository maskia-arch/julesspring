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

// ── v1.4.50: Folder-style menu helpers ───────────────────────────────────────

function _menuBackBtn(channelId) {
  return { text: "◀️ Hauptmenü", callback_data: `cfg_mainmenu_${channelId}` };
}

async function sendSettingsMenu(tg, sendTo, channelId, ch) {
  const aiText   = ch?.ai_enabled       ? "✅ Aktiv" : "❌ Inaktiv";
  const slText   = ch?.safelist_enabled ? "✅"       : "❌";
  const fbText   = ch?.feedback_enabled ? "✅"       : "❌";
  const hasAI    = ch?.ai_enabled || false;

  return await tg.call("sendMessage", {
    chat_id: sendTo,
    text: `⚙️ <b>${ch?.title || channelId}</b>\n\n` +
          `KI: ${aiText} | Safelist: ${slText} | Feedback: ${fbText}\n\n` +
          `Wähle eine Kategorie:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📋 Channel-Einstellungen", callback_data: `cfg_menu_channel_${channelId}` }],
      [{ text: "🔒 Moderation",            callback_data: `cfg_menu_mod_${channelId}` }],
      [{ text: hasAI
           ? "🤖 AI Features"
           : "🤖 AI Features 🔒",          callback_data: `cfg_menu_ai_${channelId}` }],
    ]}
  });
}

// ── Category sub-menus ────────────────────────────────────────────────────────
async function sendChannelMenu(tg, sendTo, channelId, ch) {
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `📋 <b>Channel-Einstellungen</b> — ${ch?.title || channelId}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "👋 Willkommen",              callback_data: `cfg_welcome_${channelId}` },
       { text: "👋 Abschied",                callback_data: `cfg_goodbye_${channelId}` }],
      [{ text: "📅 Zeitplan / Nachtmodus",   callback_data: `cfg_schedule_${channelId}` }],
      [{ text: "🔁 Wiederholende Nachrichten", callback_data: `cfg_repeat_${channelId}` }],
      [{ text: "🌐 Sprache",                 callback_data: `cfg_lang_${channelId}` }],
      [{ text: "🧹 Bereinigen",              callback_data: `cfg_clean_${channelId}` },
       { text: "📊 Statistik",               callback_data: `cfg_stats_${channelId}` }],
      [_menuBackBtn(channelId)],
    ]}
  });
}

async function sendModerationMenu(tg, sendTo, channelId, ch) {
  const slText = ch?.safelist_enabled ? "✅" : "❌";
  const fbText = ch?.feedback_enabled ? "✅" : "❌";
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `🔒 <b>Moderation</b> — ${ch?.title || channelId}\n\n` +
          `Safelist: ${slText} | Feedback: ${fbText}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: `🛡 Safelist ${slText}`,      callback_data: `cfg_safelist_${channelId}` },
       { text: `💬 Feedback ${fbText}`,      callback_data: `cfg_feedback_${channelId}` }],
      [{ text: "🚫 Blacklist",               callback_data: `cfg_blacklist_${channelId}` }],
      [{ text: "🔍 UserInfo",                callback_data: `cfg_userinfo_${channelId}` }],
      [_menuBackBtn(channelId)],
    ]}
  });
}

async function sendAiMenu(tg, sendTo, channelId, ch) {
  const hasAI = ch?.ai_enabled || false;
  if (!hasAI) {
    return tg.call("sendMessage", {
      chat_id: sendTo,
      text: `🤖 <b>AI Features</b> — Gesperrt\n\n` +
            `AI Features sind nur mit einem aktiven Paket verfügbar.\n\n` +
            `Nutze <b>/buy</b> um ein Paket zu kaufen.`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[_menuBackBtn(channelId)]] }
    });
  }
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `🤖 <b>AI Features</b> — ${ch?.title || channelId}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📰 Tagesbericht",            callback_data: `cfg_daily_${channelId}` },
       { text: "💬 Smalltalk AI",            callback_data: `cfg_smalltalk_${channelId}` }],
      [{ text: "📚 Wissensdatenbank",        callback_data: `cfg_knowledge_${channelId}` }],
      [{ text: "✍️ WerbeTexter",             callback_data: `cfg_adwriter_${channelId}` },
       { text: "🤖 Blacklist Enhancer 🔒",  callback_data: `cfg_bl_ai_${channelId}` }],
      [_menuBackBtn(channelId)],
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
        text: `👋 <b>Willkommensnachricht</b>\n\nAktuell:\n<i>${cur}</i>\n\n` +
              `Sende die neue Nachricht oder /cancel zum Abbrechen.\n\n` +
              `<b>Verfügbare Variablen:</b>\n` +
              `<code>{name}</code> — Vorname des Users\n` +
              `<code>{username}</code> — @Username (oder Vorname)\n` +
              `<code>{id}</code> — Telegram-ID\n` +
              `<code>{channel}</code> — Channel-Name\n` +
              `<code>{count}</code> — Aktuelle Mitgliederzahl`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
      });
      pendingInputs[String(userId)] = { action: "set_welcome", channelId };
      break;
    }
    case "goodbye": {
      const cur = ch?.goodbye_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Abschiedsnachricht</b>\n\nAktuell:\n<i>${cur}</i>\n\n` +
              `Sende die neue Nachricht oder /cancel zum Abbrechen.\n\n` +
              `<b>Verfügbare Variablen:</b>\n` +
              `<code>{name}</code> — Vorname des Users\n` +
              `<code>{username}</code> — @Username (oder Vorname)\n` +
              `<code>{id}</code> — Telegram-ID\n` +
              `<code>{channel}</code> — Channel-Name`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
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
      try {
        const now = new Date();
        const yesterday = new Date(now - 24*60*60*1000).toISOString();
        const [membRes, joinRes, leftRes, fbRes] = await Promise.all([
          supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).is("left_at", null),
          supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("joined_at", yesterday),
          supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("left_at", yesterday),
          supabase_db.from("user_feedbacks").select("id", {count:"exact"}).eq("channel_id", channelId).gte("created_at", yesterday)
        ]);
        const members = membRes?.count || membRes?.data?.length || 0;
        const joined24 = joinRes?.count || joinRes?.data?.length || 0;
        const left24   = leftRes?.count || leftRes?.data?.length || 0;
        const fb24     = fbRes?.count   || fbRes?.data?.length   || 0;
        const credits  = (ch?.token_limit||0) - (ch?.token_used||0);
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `📊 <b>Statistik</b> — ${ch?.title || channelId}\n\n` +
                `👥 Mitglieder gesamt: <b>${members}</b>\n` +
                `📈 Beitritte (24h): <b>+${joined24}</b>\n` +
                `📉 Austritte (24h): <b>-${left24}</b>\n` +
                `💬 Feedbacks (24h): <b>${fb24}</b>\n` +
                `🤖 KI-Credits verbleibend: <b>${credits.toLocaleString()}</b>\n` +
                `⚡ KI: ${ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv"}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
        });
      } catch(e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }    case "safelist": {
      // ── 🛡 Safelist & Scamliste Hub ─────────────────────────────────────
      const lang2 = ch?.bot_language || "de";
      const slEnabled = ch?.safelist_enabled || false;

      const { data: safeCount } = await supabase_db.from("user_feedbacks")
        .select("id", { count: "exact" })
        .eq("channel_id", channelId).eq("feedback_type", "positive").eq("status", "approved");
      const { data: scamCount } = await supabase_db.from("scam_entries")
        .select("id", { count: "exact" }).eq("channel_id", channelId);
      const sl = safeCount?.length || 0;
      const sc = scamCount?.length || 0;

      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🛡 <b>Safelist & Scamliste</b> — ${ch?.title || channelId}\n\n` +
              `Status: ${slEnabled ? "✅ Aktiv" : "❌ Inaktiv"}\n` +
              `✅ Safelist: ${sl} Einträge\n` +
              `⛔ Scamliste: ${sc} Einträge\n\n` +
              `Mit <code>/safelist @username</code> oder <code>/scamlist @username</code> im Privat-Chat direkt eintragen.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: slEnabled ? "🔴 Deaktivieren" : "🟢 Aktivieren",
             callback_data: `cfg_sl_toggle_${channelId}` }],
          [{ text: `✅ Safelist (${sl})`,   callback_data: `cfg_sl_safeview_${channelId}` },
           { text: `⛔ Scamliste (${sc})`, callback_data: `cfg_sl_scamview_${channelId}` }],
          [{ text: "➕ User zur Safelist",   callback_data: `cfg_sl_adduser_${channelId}` },
           { text: "➕ User zur Scamliste", callback_data: `cfg_sl_addscam_${channelId}` }],
          [{ text: "📋 Offene Reviews",     callback_data: `cfg_sl_reviews_${channelId}` }],
          backBtn(channelId, lang2)
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
    case "sl_adduser": {
      // Scene: admin types @username or userId to add to safelist
      pendingInputs[String(userId)] = { action: "safelist_add_user", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>User zur Safelist hinzufügen</b>\n\nSende @username oder Telegram-ID:\n/cancel zum Abbrechen`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] }
      });
      break;
    }
    case "sl_addscam": {
      // Scene: admin types @username or userId to add to scamlist
      pendingInputs[String(userId)] = { action: "scamlist_add_user", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `⛔ <b>User zur Scamliste hinzufügen</b>\n\nSende @username oder Telegram-ID:\n/cancel zum Abbrechen`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] }
      });
      break;
    }
    case "sl_reviews": {
      const safelistSvc2 = require("../services/adminHelper/safelistService");
      const reviews = await safelistSvc2.getPendingReviews(channelId);
      if (!reviews.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "📋 Keine offenen Reviews.", parse_mode: "HTML" });
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
    case "sl_safeview": {
      const { data: safeList } = await supabase_db.from("user_feedbacks")
        .select("id, target_username, target_user_id, submitted_by_username, created_at")
        .eq("channel_id", channelId).eq("feedback_type", "positive").eq("status", "approved")
        .order("created_at", { ascending: false }).limit(25);
      if (!safeList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Safelist ist leer." });
        break;
      }
      const lines = safeList.map((e, i) =>
        `${i+1}. ✅ @${e.target_username || e.target_user_id} — <i>von @${e.submitted_by_username||"admin"}</i>`
      ).join("\n");
      const kb = safeList.map(e => [{
        text: `🗑 @${e.target_username||e.target_user_id}`,
        callback_data: `cfg_sl_safedel_${e.id}_${channelId}`
      }]);
      kb.push(backBtn(channelId, ch?.bot_language||"de"));
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>Safelist</b> (${safeList.length})\n\n${lines}`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "sl_safedel": {
      const m = data.match(/^cfg_sl_safedel_(\d+)_(-?\d+)$/);
      if (m) {
        await supabase_db.from("user_feedbacks").delete().eq("id", m[1]).eq("channel_id", m[2]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Safelist-Eintrag entfernt." });
      }
      break;
    }
    case "sl_scamview": {
      const { data: scamList } = await supabase_db.from("scam_entries")
        .select("user_id, username, reason, created_at").eq("channel_id", channelId)
        .order("created_at", { ascending: false }).limit(25);
      if (!scamList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "⛔ Scamliste ist leer." });
        break;
      }
      const lines = scamList.map((e, i) =>
        `${i+1}. ⛔ @${e.username||e.user_id}${e.reason ? ` — <i>${e.reason.substring(0,60)}</i>` : ""}`
      ).join("\n");
      const kb = scamList.map(e => [{
        text: `🗑 @${e.username||e.user_id}`,
        callback_data: `cfg_sl_scamdel_${e.user_id}_${channelId}`
      }]);
      kb.push(backBtn(channelId, ch?.bot_language||"de"));
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `⛔ <b>Scamliste</b> (${scamList.length})\n\n${lines}`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
      });
      break;
    }
    case "sl_scamdel": {
      const m2 = data.match(/^cfg_sl_scamdel_(-?\d+)_(-?\d+)$/);
      if (m2) {
        await supabase_db.from("scam_entries").delete().eq("user_id", m2[1]).eq("channel_id", m2[2]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "⛔ Scamliste-Eintrag entfernt." });
      }
      break;
    }
    case "feedback": {
      // ── 💬 Feedback-System Hub ────────────────────────────────────────────
      const fbEnabled = ch?.feedback_enabled || false;
      const { data: fbStats } = await supabase_db.from("user_reputation")
        .select("pos_count, neg_count")
        .eq("channel_id", channelId);
      const totalPos = fbStats?.reduce((a,b) => a + (b.pos_count||0), 0) || 0;
      const totalNeg = fbStats?.reduce((a,b) => a + (b.neg_count||0), 0) || 0;

      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `💬 <b>Feedback-System</b> — ${ch?.title || channelId}\n\n` +
              `Status: ${fbEnabled ? "✅ Aktiv" : "❌ Inaktiv"}\n` +
              `✅ Positive Feedbacks: ${totalPos}\n` +
              `⚠️ Negative Feedbacks: ${totalNeg}\n\n` +
              `Wenn aktiviert erkennt der Bot Feedbacks automatisch im Channel und fragt den User nach Bestätigung.\n\n` +
              `Manuell: <code>/safelist @user</code> · <code>/scamlist @user</code>`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: fbEnabled ? "🔴 Feedback deaktivieren" : "🟢 Feedback aktivieren",
             callback_data: `cfg_fb_toggle_${channelId}` }],
          [{ text: "📋 Offene Reviews",           callback_data: `cfg_sl_reviews_${channelId}` }],
          [{ text: "🏆 Top 10 Ranking",            callback_data: `cfg_fb_ranking_${channelId}` }],
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "fb_toggle": {
      const fbNew = !(ch?.feedback_enabled);
      await supabase_db.from("bot_channels").update({ feedback_enabled: fbNew, updated_at: new Date() }).eq("id", channelId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `💬 Feedback-System ${fbNew ? "✅ aktiviert" : "❌ deaktiviert"}.`, parse_mode: "HTML" });
      break;
    }
    case "fb_ranking": {
      const { data: top } = await supabase_db.rpc("get_top_sellers", { p_channel_id: channelId, p_limit: 10 });
      if (!top?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🏆 Noch kein Ranking verfügbar." });
        break;
      }
      const medals = ["🥇","🥈","🥉"];
      const lines = top.map((u, i) =>
        `${medals[i] || `${i+1}.`} @${u.username || u.user_id} — ${u.score} Pkt ` +
        `(✅ ${u.pos_count} | ⚠️ ${u.neg_count})`
      ).join("\n");
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🏆 <b>Top 10 Verkäufer</b> — ${ch?.title || channelId}\n\n${lines}`,
        parse_mode: "HTML" });
      break;
    }


    
    // ── Category folder navigation ──────────────────────────────────────────
    case "mainmenu": {
      await sendSettingsMenu(tg, String(userId), channelId, ch);
      break;
    }
    case "menu_channel": {
      await sendChannelMenu(tg, String(userId), channelId, ch);
      break;
    }
    case "menu_mod": {
      await sendModerationMenu(tg, String(userId), channelId, ch);
      break;
    }
    case "menu_ai": {
      await sendAiMenu(tg, String(userId), channelId, ch);
      break;
    }

    // ── Wiederholdende Nachrichten ─────────────────────────────────────────
    case "repeat": {
      const { data: scheds } = await supabase_db.from("scheduled_messages")
        .select("id, message, cron_expr, is_active, repeat")
        .eq("channel_id", channelId).order("created_at", { ascending: false }).limit(20);
      const active = scheds?.filter(s => s.is_active) || [];
      const inactive = scheds?.filter(s => !s.is_active) || [];
      const isFree = !ch?.ai_enabled;
      const MAX_FREE = 3;

      let txt = `🔁 <b>Wiederholende Nachrichten</b>\n\n`;
      txt += `Aktiv: ${active.length} | Pausiert: ${inactive.length}\n`;
      if (isFree) txt += `\n⚠️ Free Limit: max ${MAX_FREE} gleichzeitig, max 3x täglich.\n`;

      const kb = (scheds || []).slice(0, 10).map(s => [{
        text: `${s.is_active ? "✅" : "⏸"} ${(s.message||"(kein Text)").substring(0,35)}… [${s.cron_expr||"1x"}]`,
        callback_data: `cfg_rep_edit_${s.id}_${channelId}`
      }]);

      if (!isFree || active.length < MAX_FREE) {
        kb.unshift([{ text: "➕ Neue Nachricht einrichten", callback_data: `cfg_schedule_${channelId}` }]);
      } else {
        kb.unshift([{ text: `🔒 Limit erreicht (${MAX_FREE})`, callback_data: "cfg_noop" }]);
      }
      kb.push([_menuBackBtn(channelId)]);

      await tg.call("sendMessage", { chat_id: String(userId), text: txt,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "rep_edit": {
      // cfg_rep_edit_{schedId}_{channelId}
      const repMatch = data.match(/^cfg_rep_edit_(\d+)_(-?\d+)$/);
      if (!repMatch) break;
      const schedId = repMatch[1];
      const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", schedId).maybeSingle();
      if (!s) break;
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🔁 <b>${(s.message||"(kein Text)").substring(0,60)}</b>\n\n` +
              `Status: ${s.is_active ? "✅ Aktiv" : "⏸ Pausiert"}\n` +
              `Intervall: ${s.cron_expr || "Einmalig"}\n` +
              `Wiederholen: ${s.repeat ? "Ja" : "Nein"}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: s.is_active ? "⏸ Pausieren" : "▶️ Aktivieren",
             callback_data: `cfg_rep_toggle_${schedId}_${channelId}` }],
          [{ text: "🗑 Löschen", callback_data: `cfg_rep_del_${schedId}_${channelId}` }],
          [{ text: "◀️ Zurück", callback_data: `cfg_repeat_${channelId}` }],
        ]}
      });
      break;
    }
    case "rep_toggle": {
      const rtm = data.match(/^cfg_rep_toggle_(\d+)_(-?\d+)$/);
      if (rtm) {
        const { data: s2 } = await supabase_db.from("scheduled_messages").select("is_active").eq("id", rtm[1]).maybeSingle();
        const newActive = !s2?.is_active;
        await supabase_db.from("scheduled_messages").update({ is_active: newActive }).eq("id", rtm[1]);
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `${newActive ? "▶️ Aktiviert" : "⏸ Pausiert"}.` });
      }
      break;
    }
    case "rep_del": {
      const rdm = data.match(/^cfg_rep_del_(\d+)_(-?\d+)$/);
      if (rdm) {
        await supabase_db.from("scheduled_messages").delete().eq("id", rdm[1]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "🗑 Gelöscht." });
      }
      break;
    }
    case "noop": {
      break;
    }

    // ── Zeitplan / Nachtmodus ───────────────────────────────────────────────
    case "schedule": {
      // Re-use existing sched_wizard flow — start it
      const langSch = ch?.bot_language || "de";
      pendingInputs[String(userId)] = {
        action: "sched_wizard_text", channelId,
        aiOn: ch?.ai_enabled, freeMode: !ch?.ai_enabled
      };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📅 <b>Nachricht einplanen</b>\n\n<b>Schritt 1/4: Text</b>\n\nSende den Text der Nachricht.\nOder /skip für nur ein Bild/GIF/Video.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
      });
      break;
    }

    // ── Blacklist management ────────────────────────────────────────────────
    case "blacklist": {
      const { data: blEntries } = await supabase_db.from("channel_blacklist")
        .select("id, word, severity, category, delete_after_hours")
        .eq("channel_id", channelId).order("severity").limit(30);

      const hard = blEntries?.filter(e => e.severity !== "tolerated") || [];
      const soft = blEntries?.filter(e => e.severity === "tolerated") || [];

      let txt = `🚫 <b>Blacklist</b> — ${ch?.title || channelId}\n\n`;
      txt += `🔴 Blacklist: ${hard.length} Einträge\n`;
      txt += `🟡 Blacklist Light (toleriert): ${soft.length} Einträge\n\n`;
      txt += `Syntax: <code>Wort | Aktion | Kategorie</code>\n`;
      txt += `Aktionen: <code>warn</code> · <code>mute</code> · <code>ban</code> · <code>tolerated</code>\n`;
      txt += `Toleriert: Automatisch gelöscht nach X Stunden.`;

      const kb = [
        [{ text: "➕ Wort hinzufügen",      callback_data: `cfg_bl_add_${channelId}` }],
        [{ text: "➕ Toleriertes Wort",      callback_data: `cfg_bl_addsoft_${channelId}` }],
      ];
      if (hard.length) kb.push([{ text: `📋 Liste anzeigen (${hard.length})`, callback_data: `cfg_bl_list_${channelId}` }]);
      if (soft.length) kb.push([{ text: `🟡 Light-Liste (${soft.length})`,    callback_data: `cfg_bl_listsoft_${channelId}` }]);
      kb.push([{ text: "🤖 KI Blacklist füllen 🔒",                           callback_data: `cfg_bl_ai_${channelId}` }]);
      kb.push([_menuBackBtn(channelId)]);

      await tg.call("sendMessage", { chat_id: String(userId), text: txt,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "bl_add": {
      pendingInputs[String(userId)] = { action: "bl_add_word", channelId, severity: "mute" };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🚫 <b>Blacklist-Eintrag hinzufügen</b>\n\nFormat: <code>Wort | Aktion | Kategorie</code>\n\nAktionen: <code>warn</code> · <code>mute</code> · <code>ban</code>\n\nBeispiel: <code>Spam | ban | Werbung</code>\n/cancel zum Abbrechen`,
        parse_mode: "HTML" });
      break;
    }
    case "bl_addsoft": {
      pendingInputs[String(userId)] = { action: "bl_add_soft", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🟡 <b>Toleriertes Wort hinzufügen</b>\n\nFormat: <code>Wort | Stunden</code>\n\nBeispiel: <code>Werbung | 24</code> → Nachricht wird nach 24h gelöscht.\n/cancel zum Abbrechen`,
        parse_mode: "HTML" });
      break;
    }
    case "bl_list": {
      const { data: hardList } = await supabase_db.from("channel_blacklist")
        .select("id, word, severity, category").eq("channel_id", channelId)
        .neq("severity", "tolerated").order("word").limit(25);
      if (!hardList?.length) { await tg.call("sendMessage", { chat_id: String(userId), text: "🚫 Blacklist ist leer." }); break; }
      const kb2 = hardList.map(e => [{ text: `🗑 ${e.word} [${e.severity}]`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb2.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🚫 <b>Blacklist</b>\n\n` + hardList.map(e => `• <code>${e.word}</code> [${e.severity}/${e.category||"–"}]`).join("\n"),
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb2 } });
      break;
    }
    case "bl_listsoft": {
      const { data: softList } = await supabase_db.from("channel_blacklist")
        .select("id, word, delete_after_hours").eq("channel_id", channelId)
        .eq("severity", "tolerated").order("word").limit(25);
      if (!softList?.length) { await tg.call("sendMessage", { chat_id: String(userId), text: "🟡 Light-Liste ist leer." }); break; }
      const kb3 = softList.map(e => [{ text: `🗑 ${e.word} [${e.delete_after_hours||24}h]`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb3.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🟡 <b>Blacklist Light</b>\n\n` + softList.map(e => `• <code>${e.word}</code> — löschen nach ${e.delete_after_hours||24}h`).join("\n"),
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb3 } });
      break;
    }
    case "bl_del": {
      const bdm = data.match(/^cfg_bl_del_(\d+)_(-?\d+)$/);
      if (bdm) {
        await supabase_db.from("channel_blacklist").delete().eq("id", bdm[1]);
        await tg.call("sendMessage", { chat_id: String(userId), text: "🗑 Eintrag gelöscht." });
      }
      break;
    }

    // ── Smalltalk AI settings ─────────────────────────────────────────────
    case "smalltalk": {
      if (!ch?.ai_enabled) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "🔒 Smalltalk AI ist nur mit aktivem Paket verfügbar." }); break;
      }
      const model = ch?.smalltalk_model || "deepseek";
      const modelName = model === "openai" ? "OpenAI (GPT-4o Mini) — Faktor x1.2" : "AutoActsAI (Standard) — Faktor x1.0";
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `💬 <b>Smalltalk AI</b> — ${ch?.title || channelId}\n\n` +
              `Modell: ${modelName}\n` +
              `System-Prompt gesetzt: ${ch?.system_prompt ? "✅" : "❌"}\n` +
              `Max Tokens: ${ch?.smalltalk_max_tokens || 200}\n` +
              `Temperature: ${ch?.smalltalk_temperature || 0.8}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "✏️ System-Prompt bearbeiten", callback_data: `cfg_st_prompt_${channelId}` }],
          [{ text: model === "openai"
               ? "🔄 Zu AutoActsAI wechseln (Standard)"
               : "🔄 Zu OpenAI wechseln (x1.2)",        callback_data: `cfg_st_model_${channelId}` }],
          [{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }],
        ]}
      });
      break;
    }
    case "st_prompt": {
      pendingInputs[String(userId)] = { action: "set_ai_prompt", channelId };
      const cur = ch?.system_prompt || "(kein)";
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✏️ <b>System-Prompt</b>\n\nAktuell: <i>${cur.substring(0,200)}</i>\n\nSende den neuen System-Prompt:\n/cancel zum Abbrechen`,
        parse_mode: "HTML" });
      break;
    }
    case "st_model": {
      const curModel = ch?.smalltalk_model || "deepseek";
      const newModel = curModel === "openai" ? "deepseek" : "openai";
      await supabase_db.from("bot_channels").update({ smalltalk_model: newModel, updated_at: new Date() }).eq("id", channelId);
      const newName = newModel === "openai" ? "OpenAI (GPT-4o Mini) — Faktor x1.2" : "AutoActsAI — Faktor x1.0";
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ Modell gewechselt zu <b>${newName}</b>.`, parse_mode: "HTML" });
      break;
    }

    // ── Tagesbericht ────────────────────────────────────────────────────────
    case "daily": {
      if (!ch?.ai_enabled) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🔒 Nur mit aktivem Paket." }); break;
      }
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📰 <b>Tagesbericht</b> — ${ch?.title || channelId}\n\n` +
              `Der Bot erstellt täglich eine KI-Zusammenfassung relevanter, wichtiger oder riskanter Ereignisse im Channel.\n\n` +
              `Jetzt Bericht anfordern:`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "📰 Jetzt Bericht erstellen", callback_data: `cfg_daily_now_${channelId}` }],
          [{ text: "◀️ Zurück",                  callback_data: `cfg_menu_ai_${channelId}` }],
        ]}
      });
      break;
    }
    case "daily_now": {
      if (!ch?.ai_enabled) break;
      await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ Erstelle Tagesbericht…" });
      try {
        const _createDailySummary = require("./smalltalkBotRoutes")._createDailySummary || (() => {});
        await _runDailySummary(supabase_db, channelId, userId, tg, ch, ch?.bot_language||"de");
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }

    // ── WerbeTexter ─────────────────────────────────────────────────────────
    case "adwriter": {
      if (!ch?.ai_enabled) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🔒 Nur mit aktivem Paket." }); break;
      }
      const { data: ads } = await supabase_db.from("scheduled_messages")
        .select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(10);

      const kb = (ads||[]).map(s => [{
        text: `✍️ ${(s.message||"(kein Text)").substring(0,40)}…`,
        callback_data: `cfg_aw_vary_${s.id}_${channelId}`
      }]);
      kb.unshift([{ text: "✍️ Neuen WerbeText erstellen (30 Credits)", callback_data: `cfg_aw_new_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }]);

      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✍️ <b>WerbeTexter</b>\n\n` +
              `Lasse bestehende Werbetexte variieren oder neue erstellen.\n` +
              `Jeder Einsatz erstellt <b>3 Variationen</b> und kostet <b>30 Credits</b>.`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "aw_new": {
      pendingInputs[String(userId)] = { action: "adwriter_new", channelId };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✍️ <b>Neuer WerbeText</b>\n\nSende deinen Ausgangstext. Der WerbeTexter erstellt 3 Variationen.\n\n<i>Kosten: 30 Credits</i>\n/cancel zum Abbrechen`,
        parse_mode: "HTML" });
      break;
    }
    case "aw_vary": {
      const awm = data.match(/^cfg_aw_vary_(\d+)_(-?\d+)$/);
      if (!awm) break;
      const { data: sched } = await supabase_db.from("scheduled_messages").select("message").eq("id", awm[1]).maybeSingle();
      if (!sched?.message) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Nachricht nicht gefunden." }); break; }
      pendingInputs[String(userId)] = { action: "adwriter_vary", channelId, schedId: awm[1], origText: sched.message };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✍️ <b>Variationen erstellen</b>\n\nOriginaltext:\n<i>${sched.message.substring(0,200)}</i>\n\nBestätige um 3 Variationen zu erstellen (30 Credits):\n/cancel zum Abbrechen`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "✅ Jetzt variieren (30 Credits)", callback_data: `cfg_aw_run_${awm[1]}_${channelId}` }
        ]]}
      });
      break;
    }
    case "aw_run": {
      const arm = data.match(/^cfg_aw_run_(\d+)_(-?\d+)$/);
      if (!arm) break;
      const { data: s3 } = await supabase_db.from("scheduled_messages").select("message").eq("id", arm[1]).maybeSingle();
      if (!s3?.message) break;
      await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ WerbeTexter arbeitet…" });
      try {
        const axios = require("axios");
        const r = await axios.post("https://api.openai.com/v1/chat/completions", {
          model: "gpt-4o-mini", max_tokens: 1200,
          messages: [{
            role: "system",
            content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Der Inhalt muss identisch bleiben, aber Formulierungen, Satzstruktur und Stil sollen variieren. Trenne die Variationen mit ---."
          }, { role: "user", content: s3.message }]
        }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
        const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
        // Deduct 30 credits
        await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
        for (let i = 0; i < Math.min(variations.length, 3); i++) {
          await tg.call("sendMessage", { chat_id: String(userId),
            text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: `📅 Als Nachricht einplanen`, callback_data: `cfg_aw_schedule_${arm[1]}_${i}_${channelId}` }
            ]]}
          });
        }
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }


    case "bl_ai": {
      // 🔒 Blacklist Enhancer locked until GrokAI integration
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🤖 <b>Blacklist Enhancer</b> — 🔒 Bald verfügbar\n\nDieses Feature wird freigeschaltet, sobald GrokAI integriert ist.\n\nBitte schau bald nochmal vorbei!`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }]] }
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

    case "knowledge": {
      // ── 📚 Channel Wissensdatenbank ──────────────────────────────────────
      const lang2 = ch?.bot_language || "de";
      try {
        const { data: kbEntries } = await supabase_db
          .from("channel_knowledge")
          .select("id, title, category, content, created_at")
          .eq("channel_id", String(channelId))
          .order("created_at", { ascending: false })
          .limit(20);

        const count = kbEntries?.length || 0;
        let preview = "";
        if (count > 0) {
          preview = "\n\n<b>Letzte Einträge:</b>\n" +
            kbEntries.slice(0, 5).map((e, i) =>
              `${i+1}. <i>${(e.title || e.content.substring(0,40)+"…").substring(0,50)}</i>`
            ).join("\n");
        }

        const kb = [
          [{ text: "➕ Neuer Wissenseintrag",    callback_data: `cfg_kb_add_${channelId}` }],
        ];
        if (count > 0) {
          kb.push([{ text: `🗑 Eintrag löschen (${count} total)`, callback_data: `cfg_kb_delete_${channelId}` }]);
        }
        kb.push(backBtn(channelId, lang2));

        await tg.call("sendMessage", {
          chat_id: String(userId),
          text: `📚 <b>Wissensdatenbank</b> — ${ch?.title || channelId}\n\n` +
                `<b>${count} Einträge</b> in der Channel-KI hinterlegt.` +
                preview + "\n\n" +
                "Neue Einträge werden von OpenAI analysiert, kategorisiert und als Vektoreinbettung gespeichert. " +
                "Die Smalltalk-AI nutzt das Wissen automatisch bei passenden Fragen.",
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: kb }
        });
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "❌ Fehler beim Laden der Wissensdatenbank: " + e.message });
      }
      break;
    }
    case "kb_add": {
      pendingInputs[String(userId)] = { action: "kb_add_entry", channelId };
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `📚 <b>Neuer Wissenseintrag</b>\n\n` +
              `Sende den Text den du in die Wissensdatenbank aufnehmen möchtest.\n\n` +
              `Beispiele:\n` +
              `• FAQs und typische Fragen\n` +
              `• Preise und Produktinfos\n` +
              `• Regeln und Hinweise\n` +
              `• Kontaktdaten\n\n` +
              `<i>OpenAI analysiert den Eintrag, erstellt eine Zusammenfassung und kategorisiert ihn automatisch.</i>\n\n` +
              `/cancel zum Abbrechen`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] }
      });
      break;
    }
    case "kb_delete": {
      // Show paginated list of entries to delete
      try {
        const { data: kbAll } = await supabase_db
          .from("channel_knowledge")
          .select("id, title, content, category")
          .eq("channel_id", String(channelId))
          .order("created_at", { ascending: false })
          .limit(20);

        if (!kbAll?.length) {
          await tg.call("sendMessage", { chat_id: String(userId),
            text: "📚 Keine Einträge vorhanden." });
          break;
        }

        const delKb = kbAll.map(e => [{
          text: `🗑 ${(e.title || e.content.substring(0,35)+"…").substring(0,45)} [${e.category||"–"}]`,
          callback_data: `cfg_kb_del_${e.id}_${channelId}`
        }]);
        delKb.push(backBtn(channelId, ch?.bot_language||"de"));

        await tg.call("sendMessage", {
          chat_id: String(userId),
          text: `🗑 <b>Eintrag löschen</b>\n\nWähle einen Eintrag zum Löschen:`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: delKb }
        });
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message });
      }
      break;
    }
    case "kb_del": {
      // cfg_kb_del_{entryId}_{channelId} — smart parser extracted action=kb_del, channelId=last number
      // Entry ID is buried: re-parse to get both IDs
      const kbDelMatch = data.match(/^cfg_kb_del_(-?\d+)_(-?\d+)$/);
      if (kbDelMatch) {
        const entryId2   = kbDelMatch[1];
        const chanId2    = kbDelMatch[2];
        try {
          await supabase_db.from("channel_knowledge").delete().eq("id", entryId2).eq("channel_id", chanId2);
          await tg.call("sendMessage", { chat_id: String(userId),
            text: "✅ Eintrag gelöscht.",
            reply_markup: { inline_keyboard: [[{ text: "📚 Wissensdatenbank",
              callback_data: `cfg_knowledge_${chanId2}` }]] }
          });
        } catch (e) {
          await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Löschen fehlgeschlagen: " + e.message });
        }
      }
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



  // ── Proof collection scene ────────────────────────────────────────────────
  if (action === "collecting_proofs") {
    const { feedbackId, channelId: fbChanId } = pending;

    if (text === "/done" || text === "/fertig") {
      delete pendingInputs[String(userId)];
      const count = pending.proofCount || 0;
      // Mark session done
      try {
        await supabase_db.from("proof_sessions")
          .update({ status: "done", proof_count: count, updated_at: new Date() })
          .eq("feedback_id", feedbackId).eq("user_id", userId);
        // Auto-approve feedback and notify admin
        const ch7 = await getChannel(fbChanId);
        await safelistService.approveFeedback(parseInt(feedbackId), userId, ch7);
        // Update reputation
        const { data: fb7 } = await supabase_db.from("user_feedbacks")
          .select("feedback_type, target_user_id, target_username").eq("id", feedbackId).maybeSingle();
        if (fb7?.target_user_id) {
          const d7 = fb7.feedback_type === "positive" ? 1 : -10;
          await supabase_db.rpc("update_user_reputation", {
            p_channel_id: fbChanId, p_user_id: fb7.target_user_id,
            p_username: fb7.target_username, p_delta: d7
          }).catch(() => {});
          if (fb7.feedback_type === "negative") {
            await supabase_db.from("scam_entries").upsert([{
              channel_id: fbChanId, user_id: fb7.target_user_id,
              username: fb7.target_username, reason: "Bestätigtes negatives Feedback", added_by: userId
            }], { onConflict: "channel_id,user_id" }).catch(() => {});
          }
        }
        // Notify admin
        const { data: admSet } = await supabase_db.from("bot_channels")
          .select("added_by_user_id, title").eq("id", String(fbChanId)).maybeSingle();
        if (admSet?.added_by_user_id) {
          const settings5 = await getSettings();
          const { proofs } = await (async () => {
            try {
              const r = await supabase_db.from("feedback_proofs")
                .select("*").eq("feedback_id", feedbackId).order("created_at");
              return { proofs: r.data || [] };
            } catch { return { proofs: [] }; }
          })();
          await tg.call("sendMessage", { chat_id: String(admSet.added_by_user_id),
            text: `📎 <b>Neues Feedback mit ${count} Proof(s)</b>\n\nChannel: ${admSet.title || fbChanId}\nFeedback-ID: ${feedbackId}\n\nBitte überprüfe die Beweise unten.`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "✅ Bestätigen", callback_data: `fb_approve_${feedbackId}` },
              { text: "❌ Ablehnen",  callback_data: `fb_reject_${feedbackId}` }
            ]]}
          });
          for (const p of proofs.slice(0, 5)) {
            try {
              if (p.proof_type === "photo")    await tg.call("sendPhoto",    { chat_id: String(admSet.added_by_user_id), photo:    p.file_id, caption: p.caption||"" });
              if (p.proof_type === "video")    await tg.call("sendVideo",    { chat_id: String(admSet.added_by_user_id), video:    p.file_id, caption: p.caption||"" });
              if (p.proof_type === "document") await tg.call("sendDocument", { chat_id: String(admSet.added_by_user_id), document: p.file_id, caption: p.caption||"" });
              if (p.proof_type === "text")     await tg.call("sendMessage",  { chat_id: String(admSet.added_by_user_id), text: `📝 ${p.content?.substring(0,1000)||""}` });
            } catch (_) {}
          }
        }
      } catch (_) {}
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ ${count} Proof(s) eingereicht! Der Admin wird benachrichtigt. Danke!` });
      return true;
    }

    // Collect media / text proofs
    const proofType = msg?.photo ? "photo" : msg?.video ? "video" : msg?.document ? "document" : "text";
    const fileId = msg?.photo ? msg.photo[msg.photo.length-1]?.file_id
                 : msg?.video ? msg.video.file_id
                 : msg?.document ? msg.document.file_id : null;
    try {
      await supabase_db.from("feedback_proofs").insert([{
        feedback_id: parseInt(feedbackId), proof_type: proofType,
        file_id: fileId || null, content: proofType === "text" ? (text||"").substring(0,1000) : null,
        caption: msg?.caption || null, submitted_by: parseInt(userId)
      }]);
      pendingInputs[String(userId)] = { ...pending, proofCount: (pending.proofCount||0) + 1 };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ Proof ${(pending.proofCount||0)+1} gespeichert.\nWeitere senden oder /done zum Abschließen.` });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  // ── Safelist: add user by admin ───────────────────────────────────────────
  if (action === "safelist_add_user") {
    delete pendingInputs[String(userId)];
    const target = text.replace("@","").trim();
    if (!target) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Bitte @username oder ID eingeben." });
      return true;
    }
    try {
      await safelistService.submitFeedback({
        channelId, submittedBy: userId, submittedByUsername: null,
        targetUsername: target, targetUserId: /^\d+$/.test(target) ? parseInt(target) : null,
        feedbackType: "positive", feedbackText: "Manuell durch Admin zur Safelist hinzugefügt"
      }).then(async r => {
        if (r?.id) {
          const ch8 = await getChannel(channelId);
          await safelistService.approveFeedback(r.id, userId, ch8);
        }
      });
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ @${target} zur Safelist hinzugefügt!`, parse_mode: "HTML" });
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message }); }
    return true;
  }

  // ── Scamlist: add user by admin ───────────────────────────────────────────
  if (action === "scamlist_add_user") {
    delete pendingInputs[String(userId)];
    const target = text.replace("@","").trim();
    if (!target) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Bitte @username oder ID eingeben." });
      return true;
    }
    try {
      await supabase_db.from("scam_entries").upsert([{
        channel_id: channelId, user_id: /^\d+$/.test(target) ? parseInt(target) : null,
        username: /^\d+$/.test(target) ? null : target,
        reason: "Manuell vom Admin eingetragen", added_by: parseInt(userId)
      }], { onConflict: "channel_id,user_id" });
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `⛔ @${target} zur Scamliste hinzugefügt!`, parse_mode: "HTML" });
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message }); }
    return true;
  }


  // ── Blacklist Light: toleriertes Wort hinzufügen ────────────────────────
  if (action === "bl_add_soft") {
    delete pendingInputs[String(userId)];
    const parts = text.split("|").map(s => s.trim());
    const word  = parts[0];
    const hours = parseInt(parts[1]) || 24;
    if (!word) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Kein Wort angegeben." }); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{
        channel_id: String(channelId), word: word.toLowerCase(),
        severity: "tolerated", delete_after_hours: hours,
        category: "toleriert", created_by: userId
      }], { onConflict: "channel_id,word" });
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🟡 <b>${word}</b> hinzugefügt — wird nach ${hours}h gelöscht.`, parse_mode: "HTML" });
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message }); }
    return true;
  }

  // ── WerbeTexter: neuen Text eingeben + variieren ──────────────────────────
  if (action === "adwriter_new" || action === "adwriter_vary") {
    const origText = pending.origText || text;
    delete pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ WerbeTexter erstellt Variationen…" });
    try {
      const axios = require("axios");
      const r = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini", max_tokens: 1200,
        messages: [
          { role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Der Inhalt muss identisch bleiben, aber Formulierungen, Satzstruktur und Stil sollen variieren. Trenne jede Variation mit ---." },
          { role: "user", content: origText }
        ]
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
      const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
      await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
      for (let i = 0; i < Math.min(variations.length, 3); i++) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[
            { text: "📅 Einplanen", callback_data: `cfg_schedule_${channelId}` }
          ]]}
        });
      }
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message }); }
    return true;
  }

  // ── Wissensdatenbank: Eintrag hinzufügen ──────────────────────────────────
  if (action === "kb_add_entry") {
    delete pendingInputs[String(userId)];
    const rawText = (msg?.text || text || "").trim();
    if (!rawText || rawText.length < 5) {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "❌ Bitte einen aussagekräftigen Text senden (mindestens 5 Zeichen)." });
      return true;
    }

    // Show processing indicator
    const processingMsg = await tg.call("sendMessage", { chat_id: String(userId),
      text: "⏳ <b>OpenAI verarbeitet deinen Eintrag…</b>\n\n• Analyse & Kategorisierung\n• Vektoreinbettung wird erstellt",
      parse_mode: "HTML"
    });

    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error("OPENAI_API_KEY fehlt");

      // Step 1: Let GPT-4o-mini categorize + summarize the entry
      const axios = require("axios");
      const aiRes = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        max_tokens: 300,
        messages: [
          { role: "system", content:
            "Du bist ein Wissensmanager für Telegram-Channel-Bots. " +
            "Analysiere den folgenden Wissenseintrag und antworte NUR mit einem JSON-Objekt ohne Markdown-Blöcke: " +
            '{"title": "kurzer Titel (max 60 Zeichen)", "category": "passende Kategorie (z.B. FAQ, Preise, Kontakt, Regeln, Produkte, Öffnungszeiten, Allgemein)", "summary": "optimierte Version des Eintrags für die AI (max 300 Zeichen)"}' },
          { role: "user", content: rawText }
        ]
      }, {
        headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        timeout: 20000
      });

      let aiData = { title: rawText.substring(0, 60), category: "Allgemein", summary: rawText };
      try {
        const raw = aiRes.data.choices[0].message.content.trim().replace(/^```json|^```|```$/gm, "");
        aiData = JSON.parse(raw);
      } catch (_) {}

      // Step 2: Create embedding via OpenAI text-embedding-3-small
      const embedRes = await axios.post("https://api.openai.com/v1/embeddings", {
        input: (aiData.summary || rawText).replace(/\n/g, " ").substring(0, 8000),
        model: "text-embedding-3-small"
      }, {
        headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        timeout: 15000
      });
      const embedding = embedRes.data.data[0].embedding;

      // Step 3: Store in channel_knowledge
      const supabase2 = require("../config/supabase");
      const { error: dbErr } = await supabase2.from("channel_knowledge").insert([{
        channel_id: String(channelId),
        title:      aiData.title     || rawText.substring(0, 60),
        category:   aiData.category  || "Allgemein",
        content:    aiData.summary   || rawText,
        embedding:  JSON.stringify(embedding),
        source:     "bot_admin",
        metadata:   { original_length: rawText.length, added_by: String(userId) }
      }]);
      if (dbErr) throw new Error(dbErr.message);

      // Update the processing message with success
      await tg.call("editMessageText", {
        chat_id: String(userId),
        message_id: processingMsg?.result?.message_id,
        text: `✅ <b>Wissenseintrag hinzugefügt!</b>\n\n` +
              `📌 <b>Titel:</b> ${aiData.title}\n` +
              `🏷 <b>Kategorie:</b> ${aiData.category}\n` +
              `📝 <b>Inhalt:</b> <i>${(aiData.summary||rawText).substring(0, 150)}${(aiData.summary||rawText).length > 150 ? "…" : ""}</i>\n\n` +
              `Die Smalltalk-AI verwendet dieses Wissen ab sofort automatisch.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${channelId}` },
          { text: "➕ Weiterer Eintrag", callback_data: `cfg_kb_add_${channelId}` }
        ]] }
      }).catch(async () => {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `✅ Eintrag „${aiData.title}" gespeichert! Kategorie: ${aiData.category}`,
          parse_mode: "HTML" });
      });

    } catch (e) {
      require("../utils/logger").error("[KB] Eintrag speichern fehlgeschlagen:", e.message);
      await tg.call("editMessageText", {
        chat_id: String(userId),
        message_id: processingMsg?.result?.message_id,
        text: `❌ <b>Fehler beim Verarbeiten:</b> ${e.message}\n\nBitte erneut versuchen.`,
        parse_mode: "HTML"
      }).catch(async () => {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `❌ Fehler: ${e.message}` });
      });
    }
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

  let usedTodayCount = 0;
  try {
    const uqr = await supabase_db.from("userinfo_queries").select("query_count").eq("user_id", requesterId).eq("query_date", new Date().toISOString().split("T")[0]).maybeSingle();
    usedTodayCount = uqr.data?.query_count || 0;
  } catch (_) {}
  const remaining = access.unlimited ? "∞" : String(FREE_QUERIES_PER_DAY - usedTodayCount);
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
          const fbType      = parts3[2]; // pos | neg | no
          const targetUname = parts3[3];
          const submitterId = parts3[4];
          const chanId3     = parts3[parts3.length - 1];

          // SECURITY: only the original submitter can confirm
          if (String(qUserId) !== String(submitterId)) {
            await tg.call("answerCallbackQuery", { callback_query_id: q.id,
              text: "❌ Nur die Person die das Feedback geschrieben hat kann es bestätigen.", show_alert: true });
            return;
          }

          if (fbType === "no") {
            // Dismissed: forward to channel admin for manual review
            const origMsg = q.message?.text || "";
            const { data: chAdmin } = await supabase.from("bot_channels")
              .select("added_by_user_id").eq("id", String(chanId3)).maybeSingle().catch(() => ({ data: null }));
            if (chAdmin?.added_by_user_id) {
              await tg.call("sendMessage", { chat_id: String(chAdmin.added_by_user_id),
                text: `❓ <b>Feedback-Einordnung unklar</b>\n\n<i>${origMsg.substring(0,200)}</i>\n\nUser hat auf ❌ geklickt. Bitte manuell prüfen.`,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[
                  { text: "✅ Positiv buchen", callback_data: `fb_manual_pos_${targetUname}_0_${chanId3}` },
                  { text: "⚠️ Negativ buchen", callback_data: `fb_manual_neg_${targetUname}_0_${chanId3}` }
                ]]}
              });
            }
            await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Feedback nicht bestätigt." });
            return;
          }

          // pos or neg confirmed by original submitter
          const feedbackType = fbType === "pos" ? "positive" : "negative";
          const origText = q.message?.reply_to_message?.text?.substring(0, 300) || "";

          // Save to DB as pending
          let fbId = null;
          try {
            const fbResult = await safelistService.submitFeedback({
              channelId: chanId3, submittedBy: submitterId,
              submittedByUsername: q.from?.username || null,
              targetUsername: targetUname, feedbackType, feedbackText: origText
            });
            fbId = fbResult?.id;
          } catch (_) {}

          // Delete channel prompt message
          await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});

          // Ask about proofs — in the channel (reply visible to all)
          const proofKb = [[
            { text: "📎 Ja, Proofs senden", callback_data: `fb_want_proof_${fbId}_${submitterId}_${chanId3}` },
            { text: "✌️ Nein, reicht mir", callback_data: `fb_no_proof_${fbId}_${submitterId}_${chanId3}` }
          ]];
          const proofMsg = await tg.call("sendMessage", {
            chat_id: q.message.chat.id,
            text: feedbackType === "positive"
              ? `✅ <b>Positives Feedback</b> für @${targetUname} wurde gespeichert!\n\nMöchtest du Beweise/Screenshots als Proof beifügen?`
              : `⚠️ <b>Negatives Feedback</b> für @${targetUname} wurde gespeichert.\n\nNegative Feedbacks ohne Proof können oft nicht berücksichtigt werden. Möchtest du Beweise beifügen?`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: proofKb }
          }).catch(() => null);

          // Track for auto-delete after 5 min
          if (proofMsg?.message_id) {
            void safelistService.trackBotMessage(q.message.chat.id, proofMsg.message_id, "temp", 5*60*1000);
          }

          await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: feedbackType === "positive" ? "✅ Positiv gespeichert" : "⚠️ Negativ gespeichert" });
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

        // Refill: channel selected
        if (data.startsWith("refill_chan_")) {
          const refChanId = data.split("_")[2];
          const pend = pendingInputs[String(qUserId)] || {};
          const refills = pend.refills || [];
          let showRefills = refills;
          if (!showRefills.length) {
            const { data: r } = await supabase.from("channel_refills").select("*").eq("is_active", true).order("sort_order");
            showRefills = r || [];
          }
          // Get channel stats
          const { data: chStat } = await (async () => { try { return await supabase.from("bot_channels").select("token_used, token_limit, credits_expire_at, title").eq("id", refChanId).maybeSingle(); } catch { return { data: null }; } })();
          const used = chStat?.token_used || 0;
          const lim  = chStat?.token_limit || 0;
          const exp  = chStat?.credits_expire_at ? new Date(chStat.credits_expire_at).toLocaleDateString("de-DE") : "–";
          const kb = showRefills.map(r => [{
            text: `🔋 ${r.name} — ${r.credits.toLocaleString()} Credits · ${parseFloat(r.price_eur).toFixed(2)} €`,
            callback_data: "refill_opt_" + r.id + "_" + refChanId
          }]);
          kb.push([{ text: "❌ Abbrechen", callback_data: "buy_cancel" }]);
          await tg.call("editMessageText", {
            chat_id: String(qUserId), message_id: q.message?.message_id,
            text: `🔋 <b>Credits nachladen für "${chStat?.title||refChanId}"</b>\n\n` +
                  `Verbraucht: ${used.toLocaleString()} / ${lim.toLocaleString()} Credits\n` +
                  `Gültig bis: ${exp}\n\n` +
                  `ℹ️ Refills verlängern NICHT die Laufzeit.\n` +
                  `💎 Ungenutzte Refills laufen NIE ab und dienen als Notfallreserve.`,
            parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
          }).catch(async () => {
            await tg.call("sendMessage", { chat_id: String(qUserId),
              text: `🔋 Refill-Optionen für "${chStat?.title||refChanId}":`,
              parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
            });
          });
          return;
        }

        // Refill option selected → generate checkout
        if (data.startsWith("refill_opt_")) {
          const roMatch = data.match(/^refill_opt_(\d+)_(-?\d+)$/);
          if (!roMatch) return;
          const refillId = parseInt(roMatch[1]);
          const roChanId = roMatch[2];
          delete pendingInputs[String(qUserId)];
          const { data: refill } = await (async () => { try { return await supabase.from("channel_refills").select("*").eq("id", refillId).single(); } catch { return { data: null }; } })();
          if (!refill) { await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Refill nicht gefunden." }); return; }
          await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });
          try {
            const packageService = require("../services/packageService");
            const result = await packageService.generateRefillUrl(refill, roChanId);
            if (result.checkoutUrl) {
              await tg.call("sendMessage", { chat_id: String(qUserId),
                text: `🔋 <b>${refill.name}</b>\n\n` +
                      `+${refill.credits.toLocaleString()} Credits\n` +
                      `💰 ${parseFloat(refill.price_eur).toFixed(2)} €\n\n` +
                      `Credits werden sofort nach Zahlung gutgeschrieben.`,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt nachladen", url: result.checkoutUrl }]] }
              });
            } else {
              await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Checkout konnte nicht erstellt werden. Kontaktiere @autoacts." });
            }
          } catch (e2) {
            logger.error("[Refill] Fehler:", e2.message);
            await tg.call("sendMessage", { chat_id: String(qUserId),
              text: `❌ Refill fehlgeschlagen:\n<i>${e2.message}</i>\n\nKontaktiere @autoacts.`,
              parse_mode: "HTML" });
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

          const { data: pkg } = await (async () => { try { return await supabase.from("channel_packages").select("*").eq("id", pkgId).single(); } catch { return { data: null }; } })();
          if (!pkg) {
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Paket nicht gefunden." });
            return;
          }

          await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });

          try {
            const packageService = require("../services/packageService");
            const result = await packageService.generateCheckoutUrl(pkg, chanId4);

            if (result.checkoutUrl) {
              await tg.call("sendMessage", { chat_id: String(qUserId),
                text: `✅ <b>${pkg.name} — ${pkg.credits.toLocaleString()} Credits</b>\n\n` +
                      `💰 Preis: ${parseFloat(pkg.price_eur).toFixed(2)} €\n` +
                      `📅 Laufzeit: ${pkg.duration_days || 30} Tage <i>(ab Kaufdatum)</i>\n` +
                      `ℹ️ Während dein Paket läuft, kannst du Refills als Notfall-Vorrat kaufen.\n\n` +
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
              text: `❌ Checkout fehlgeschlagen:\n<i>${e2.message}</i>\n\nBitte überprüfe:\n• Sellauth API-Key korrekt?\n• Shop-ID korrekt?\n• Variant-ID im Paket eingetragen?\n\nKontaktiere @autoacts.`,
              parse_mode: "HTML" });
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
        // ── Proof wanted → invite user to DM the bot ──────────────────────────
        if (data.startsWith("fb_want_proof_")) {
          // fb_want_proof_{fbId}_{submitterId}_{channelId}
          const pm = data.match(/^fb_want_proof_(-?\d+)_(-?\d+)_(-?\d+)$/);
          if (!pm || String(qUserId) !== pm[2]) {
            await tg.call("answerCallbackQuery", { callback_query_id: q.id,
              text: "❌ Nicht für dich.", show_alert: true });
            return;
          }
          const [, fbId2, , chanId4] = pm;
          // Start proof session in DB
          try {
            await supabase.from("proof_sessions").insert([{
              feedback_id: parseInt(fbId2), user_id: parseInt(qUserId),
              channel_id: chanId4, status: "collecting"
            }]);
          } catch (_) {}
          // Store in memory so private DMs get handled as proofs
          pendingInputs[String(qUserId)] = { action: "collecting_proofs", feedbackId: fbId2, channelId: chanId4, proofCount: 0 };

          const settings4 = await getSettings();
          const botName = settings4?.bot_name || "AdminHelper";
          await tg.call("editMessageText", {
            chat_id: q.message.chat.id, message_id: q.message.message_id,
            text: `📎 <b>Proofs einreichen</b>\n\nSchreibe dem Bot <b>direkt privat</b> und sende deine Beweise (Fotos, Videos, Screenshots, Text).\n\nWenn du fertig bist: /done\nAbbrechen: /cancel`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "💬 Dem Bot schreiben", url: `https://t.me/${botName}?start=proofs_${fbId2}` }
            ]]}
          }).catch(async () => {
            await tg.call("sendMessage", { chat_id: q.message.chat.id,
              text: `📎 Schreibe dem Bot privat um deine Beweise einzureichen. Wenn fertig: /done`, parse_mode: "HTML" });
          });
          await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "📎 Bitte sende Proofs dem Bot privat." });
          return;
        }

        // ── No proof chosen ────────────────────────────────────────────────────
        if (data.startsWith("fb_no_proof_")) {
          const npm = data.match(/^fb_no_proof_(-?\d+)_(-?\d+)_(-?\d+)$/);
          if (!npm || String(qUserId) !== npm[2]) {
            await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Nicht für dich.", show_alert: true });
            return;
          }
          const [, fbId3, , chanId5] = npm;
          // Auto-approve positive; set pending for admin review on negative
          try {
            const { data: fbRow } = await supabase.from("user_feedbacks")
              .select("feedback_type, target_user_id, target_username").eq("id", fbId3).maybeSingle();
            if (fbRow) {
              const ch5 = await getChannel(chanId5);
              await safelistService.approveFeedback(parseInt(fbId3), qUserId, ch5);
              // Update reputation score
              if (fbRow.target_user_id) {
                const delta = fbRow.feedback_type === "positive" ? 1 : -10;
                await supabase.rpc("update_user_reputation", {
                  p_channel_id: chanId5, p_user_id: fbRow.target_user_id,
                  p_username: fbRow.target_username, p_delta: delta
                }).catch(() => {});
              }
              // Auto add to scamlist on negative confirmed
              if (fbRow.feedback_type === "negative" && fbRow.target_user_id) {
                await supabase.from("scam_entries").upsert([{
                  channel_id: chanId5, user_id: fbRow.target_user_id,
                  username: fbRow.target_username, reason: "Bestätigtes negatives Feedback",
                  added_by: qUserId
                }], { onConflict: "channel_id,user_id" }).catch(() => {});
              }
            }
          } catch (_) {}
          await tg.call("editMessageText", {
            chat_id: q.message.chat.id, message_id: q.message.message_id,
            text: "✅ Feedback gespeichert. Danke!", parse_mode: "HTML"
          }).catch(() => {});
          void safelistService.trackBotMessage(q.message.chat.id, q.message.message_id, "temp", 30*1000);
          await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Gespeichert." });
          return;
        }

        // ── Manual admin feedback booking (from DM after fb_confirm_no) ────────
        if (data.startsWith("fb_manual_pos_") || data.startsWith("fb_manual_neg_")) {
          const isMPos = data.startsWith("fb_manual_pos_");
          const mm = data.match(/^fb_manual_(pos|neg)_([\w]+)_(-?\d+)_(-?\d+)$/);
          if (!mm) return;
          const [, , targetU, targetId, chanId6] = mm;
          const fbType = isMPos ? "positive" : "negative";
          try {
            const fbR = await safelistService.submitFeedback({
              channelId: chanId6, submittedBy: qUserId,
              submittedByUsername: q.from?.username || null,
              targetUsername: targetU, targetUserId: parseInt(targetId) || null,
              feedbackType: fbType, feedbackText: "Manuell eingetragen (Admin)"
            });
            if (fbR?.id) {
              const ch6 = await getChannel(chanId6);
              await safelistService.approveFeedback(fbR.id, qUserId, ch6);
              const delta6 = fbType === "positive" ? 1 : -10;
              await supabase.rpc("update_user_reputation", {
                p_channel_id: chanId6, p_user_id: parseInt(targetId) || 0,
                p_username: targetU, p_delta: delta6
              }).catch(() => {});
              if (fbType === "negative") {
                await supabase.from("scam_entries").upsert([{
                  channel_id: chanId6, user_id: parseInt(targetId) || null,
                  username: targetU, reason: "Manuell vom Admin eingetragen", added_by: qUserId
                }], { onConflict: "channel_id,user_id" }).catch(() => {});
              }
            }
          } catch (_) {}
          await tg.call("editMessageText", {
            chat_id: String(qUserId), message_id: q.message.message_id,
            text: `${fbType === "positive" ? "✅ Positives" : "⚠️ Negatives"} Feedback für @${targetU} manuell eingetragen.`,
            parse_mode: "HTML"
          }).catch(() => {});
          await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Gespeichert." });
          return;
        }

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

        // ── /safelist [@user or ID] in private admin chat ─────────────────────
        if (/^\/safeliste?(?:\s+@?(.+))?$/i.test(text)) {
          const slMatch = text.match(/^\/safeliste?\s+@?(.+)/i);
          const slTarget = slMatch ? slMatch[1].trim() : null;
          // Check caller is admin of at least one channel
          const { data: myChForSl } = await supabase.from("bot_channels")
            .select("id, title").eq("added_by_user_id", chatId).eq("is_approved", true).limit(5);
          if (!myChForSl?.length) {
            await tg.send(chatId, "❌ Du hast keine freigeschalteten Channels.");
            return;
          }
          if (slTarget) {
            // If only one channel, use it directly; else ask which channel
            if (myChForSl.length === 1) {
              pendingInputs[String(chatId)] = {
                action: "safelist_add_user", channelId: String(myChForSl[0].id), prefilled: slTarget
              };
              // Auto-trigger the action with the prefilled target
              const fakeMsg = { ...msg, text: slTarget };
              await handlePendingInput(tg, supabase, chatId, slTarget, settings, fakeMsg);
            } else {
              const kb = myChForSl.map(ch2 => [{
                text: `📢 ${ch2.title||ch2.id}`,
                callback_data: `cfg_sl_adduser_${ch2.id}`
              }]);
              pendingInputs[String(chatId)] = { action: "safelist_add_user_pick", target: slTarget, channels: myChForSl };
              await tg.send(chatId, `Für welchen Channel soll @${slTarget} zur Safelist?\n\nWähle:`);
              await tg.call("sendMessage", { chat_id: chatId, text: "Channel auswählen:",
                reply_markup: { inline_keyboard: kb } });
            }
          } else {
            // No target: open safelist overview for first channel
            const ch2 = await getChannel(String(myChForSl[0].id));
            await handleSettingsCallback(tg, supabase, `cfg_sl_safeview_${myChForSl[0].id}`, { from: { id: chatId } }, chatId);
          }
          return;
        }

        // ── /scamlist [@user or ID] in private admin chat ──────────────────────
        if (/^\/scamliste?(?:\s+@?(.+))?$/i.test(text)) {
          const scMatch = text.match(/^\/scamliste?\s+@?(.+)/i);
          const scTarget = scMatch ? scMatch[1].trim() : null;
          const { data: myChForSc } = await supabase.from("bot_channels")
            .select("id, title").eq("added_by_user_id", chatId).eq("is_approved", true).limit(5);
          if (!myChForSc?.length) {
            await tg.send(chatId, "❌ Du hast keine freigeschalteten Channels.");
            return;
          }
          if (scTarget) {
            if (myChForSc.length === 1) {
              pendingInputs[String(chatId)] = {
                action: "scamlist_add_user", channelId: String(myChForSc[0].id)
              };
              await handlePendingInput(tg, supabase, chatId, scTarget, settings, msg);
            } else {
              const kb2 = myChForSc.map(ch2 => [{
                text: `📢 ${ch2.title||ch2.id}`, callback_data: `cfg_sl_addscam_${ch2.id}`
              }]);
              await tg.send(chatId, `Für welchen Channel soll @${scTarget} zur Scamliste?`);
              await tg.call("sendMessage", { chat_id: chatId, text: "Channel auswählen:",
                reply_markup: { inline_keyboard: kb2 } });
            }
          } else {
            await handleSettingsCallback(tg, supabase, `cfg_sl_scamview_${myChForSc[0].id}`, { from: { id: chatId } }, chatId);
          }
          return;
        }

        if (text === "/cancel") {
          await handlePendingInput(tg, supabase, from.id, "/cancel", settings, null);
          return;
        }
        // /refill – credit top-up (requires active subscription)
        if (/^\/refill(@\w+)?/i.test(text) || text.toLowerCase() === "credits nachladen") {
          const { data: refills } = await supabase.from("channel_refills")
            .select("*").eq("is_active", true).order("sort_order");
          if (!refills?.length) {
            await tg.send(chatId, "❌ Keine Refill-Optionen verfügbar. Kontaktiere @autoacts.");
            return;
          }
          const { data: myChans } = await supabase.from("bot_channels")
            .select("id, title, type, token_used, token_limit, credits_expire_at, ai_enabled")
            .eq("added_by_user_id", String(from.id));
          if (!myChans?.length) {
            await tg.send(chatId, "❌ Kein registrierter Channel gefunden.");
            return;
          }
          // v1.4.47-2: Refills can be stockpiled as emergency reserve even without active package.
          // Untouched refills never expire; they activate only once consumed.
          pendingInputs[String(from.id)] = { action: "refill_select_channel", refills };
          const chanKb = myChans.map(ch2 => {
            const used = ch2.token_used || 0;
            const lim  = ch2.token_limit || 0;
            const pct  = lim ? Math.round(used/lim*100) : 0;
            return [{ text: `${ch2.type==="channel"?"📢":"👥"} ${ch2.title||ch2.id} (${pct}% verbraucht)`,
                callback_data: "refill_chan_" + ch2.id }];
          });
          const rm = await tg.call("sendMessage", { chat_id: chatId,
            text: "🔋 <b>Credits nachladen</b>\n\nFür welchen Channel?",
            parse_mode: "HTML", reply_markup: { inline_keyboard: chanKb }
          });
          if (rm?.message_id) void safelistService.trackBotMessage(chatId, rm.message_id, "temp", 10*60*1000);
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
      // v1.4.49-3: use feedback_enabled for auto-detection
      if (text && from?.id && !text.startsWith("/") && (ch?.feedback_enabled || ch?.safelist_enabled) && !from.is_bot) {
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

        // ═══ Channel commands: /safelist, /scamlist, /feedbacks ═════════════
      const textLow = (text || "").toLowerCase().trim();

      // ── /safelist or /safeliste (no args) → show safelist with 5min autodelete
      if (/^\/safeliste?$/i.test(text) && safelistActive) {
        const { data: sl2 } = await supabase.from("user_feedbacks")
          .select("target_username, target_user_id, submitted_by_username, created_at")
          .eq("channel_id", chatId).eq("feedback_type", "positive").eq("status", "approved")
          .order("created_at", { ascending: false }).limit(20);
        let slText = "🛡 <b>Safelist</b>\n\n";
        slText += sl2?.length
          ? sl2.map((e,i) => `${i+1}. ✅ @${e.target_username||e.target_user_id}` +
              (e.submitted_by_username ? ` — von @${e.submitted_by_username}` : "")).join("\n")
          : "<i>Noch keine Einträge.</i>";
        const slMsg = await tg.call("sendMessage", { chat_id: chatId, text: slText,
          parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (slMsg?.message_id) void safelistService.trackBotMessage(chatId, slMsg.message_id, "temp", 5*60*1000);
        return;
      }

      // ── /scamlist or /scamliste (no args) → show scamlist with 5min autodelete
      if (/^\/scamliste?$/i.test(text) && safelistActive) {
        const { data: sc2 } = await supabase.from("scam_entries")
          .select("username, user_id, reason, created_at")
          .eq("channel_id", chatId).order("created_at", { ascending: false }).limit(20);
        let scText = "⛔ <b>Scamliste</b>\n\n";
        scText += sc2?.length
          ? sc2.map((e,i) => `${i+1}. ⛔ @${e.username||e.user_id}` +
              (e.reason ? ` — <i>${e.reason.substring(0,60)}</i>` : "")).join("\n")
          : "<i>Noch keine Einträge.</i>";
        const scMsg = await tg.call("sendMessage", { chat_id: chatId, text: scText,
          parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (scMsg?.message_id) void safelistService.trackBotMessage(chatId, scMsg.message_id, "temp", 5*60*1000);
        return;
      }

      // ── /feedbacks (no args) → Top 10 ranking with 5min autodelete
      if (/^\/feedbacks?$/i.test(text) && safelistActive) {
        const { data: top10 } = await supabase.rpc("get_top_sellers",
          { p_channel_id: chatId, p_limit: 10 }).catch(() => ({ data: null }));
        const medals = ["🥇","🥈","🥉"];
        let rankText = "🏆 <b>Top 10 Verkäufer</b>\n\n";
        rankText += top10?.length
          ? top10.map((u,i) => `${medals[i]||`${i+1}.`} @${u.username||u.user_id} — <b>${u.score} Pkt</b> (✅ ${u.pos_count} | ⚠️ ${u.neg_count})`).join("\n")
          : "<i>Noch kein Ranking verfügbar.</i>";
        const rkMsg = await tg.call("sendMessage", { chat_id: chatId, text: rankText,
          parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (rkMsg?.message_id) void safelistService.trackBotMessage(chatId, rkMsg.message_id, "temp", 5*60*1000);
        return;
      }

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
        const sent = await tg.send(chatId, "⚠️ KI aktuell nicht verfügbar. Credits erschöpft – der Channel-Admin kann Credits nachladen.");
        // PM to admin with refill offer
        if (ch?.added_by_user_id && token) {
          let refills2 = [];
          try { const r2 = await supabase.from("channel_refills").select("id, name, credits, price_eur").eq("is_active", true).order("credits").limit(3); refills2 = r2.data || []; } catch (_) {}
          if (refills2?.length) {
            const rfKb = refills2.map(r => [{ text: `🔋 ${r.name} +${r.credits.toLocaleString()} Credits · ${parseFloat(r.price_eur).toFixed(2)} €`, callback_data: "refill_opt_" + r.id + "_" + chatId }]);
            await tg.call("sendMessage", { chat_id: String(ch.added_by_user_id),
              text: `⚠️ <b>Credits für "${ch.title||chatId}" erschöpft!</b>\n\nChannel-Mitglieder können die KI nicht mehr nutzen. Lade jetzt Credits nach:`,
              parse_mode: "HTML", reply_markup: { inline_keyboard: rfKb }
            }).catch(() => {});
          }
        }
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
