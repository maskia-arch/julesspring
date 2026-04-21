const supabase = require("../../config/supabase");
const { tgAdminHelper } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const dailySummaryService = require("./dailySummaryService");
const { SUPPORTED_LANGUAGES } = require("../i18n");

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

function backBtn(channelId, lang) {
  const labels = { de: "◀️ Zurück", en: "◀️ Back", es: "◀️ Volver", zh: "◀️ 返回", ar: "◀️ عودة", fr: "◀️ Retour" };
  return [{ text: labels[lang] || "◀️ Zurück", callback_data: `cfg_back_${channelId || "0"}` }];
}

function _menuBackBtn(channelId) {
  return { text: "◀️ Hauptmenü", callback_data: `cfg_mainmenu_${channelId}` };
}

async function sendSettingsMenu(tg, sendTo, channelId, ch) {
  const aiText = ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv";
  return await tg.call("sendMessage", {
    chat_id: sendTo,
    text: `⚙️ <b>${ch?.title || channelId}</b>\n\nKI: ${aiText} | Safelist: ${ch?.safelist_enabled ? "✅" : "❌"}\n\nWähle eine Kategorie:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📋 Channel-Einstellungen", callback_data: `cfg_menu_channel_${channelId}` }],
      [{ text: "🔒 Moderation", callback_data: `cfg_menu_mod_${channelId}` }],
      [{ text: ch?.ai_enabled ? "🤖 AI Features" : "🤖 AI Features 🔒", callback_data: `cfg_menu_ai_${channelId}` }]
    ]}
  });
}

async function sendChannelMenu(tg, sendTo, channelId, ch) {
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `📋 <b>Channel-Einstellungen</b> — ${ch?.title || channelId}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "👋 Willkommen", callback_data: `cfg_welcome_${channelId}` }, { text: "👋 Abschied", callback_data: `cfg_goodbye_${channelId}` }],
      [{ text: "📅 Zeitplan", callback_data: `cfg_schedule_${channelId}` }, { text: "🔁 Wiederholungen", callback_data: `cfg_repeat_${channelId}` }],
      [{ text: "🌐 Sprache", callback_data: `cfg_lang_${channelId}` }],
      [{ text: "🧹 Bereinigen", callback_data: `cfg_clean_${channelId}` }, { text: "📊 Statistik", callback_data: `cfg_stats_${channelId}` }],
      [_menuBackBtn(channelId)]
    ]}
  });
}

async function sendModerationMenu(tg, sendTo, channelId, ch) {
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `🔒 <b>Moderation</b> — ${ch?.title || channelId}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: `🛡 Safelist ${ch?.safelist_enabled ? "✅" : "❌"}`, callback_data: `cfg_safelist_${channelId}` }, { text: `💬 Feedback ${ch?.feedback_enabled ? "✅" : "❌"}`, callback_data: `cfg_feedback_${channelId}` }],
      [{ text: "🚫 Blacklist", callback_data: `cfg_blacklist_${channelId}` }, { text: "🔍 UserInfo", callback_data: `cfg_userinfo_${channelId}` }],
      [_menuBackBtn(channelId)]
    ]}
  });
}

async function sendAiMenu(tg, sendTo, channelId, ch) {
  if (!ch?.ai_enabled) {
    return tg.call("sendMessage", {
      chat_id: sendTo,
      text: `🤖 <b>AI Features</b> — Gesperrt\n\nAI Features sind nur mit einem aktiven Paket verfügbar.\nNutze <b>/buy</b> um ein Paket zu kaufen.`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[_menuBackBtn(channelId)]] }
    });
  }
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `🤖 <b>AI Features</b> — ${ch?.title || channelId}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📰 Tagesbericht", callback_data: `cfg_daily_${channelId}` }, { text: "💬 Smalltalk AI", callback_data: `cfg_smalltalk_${channelId}` }],
      [{ text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${channelId}` }],
      [{ text: "✍️ WerbeTexter", callback_data: `cfg_adwriter_${channelId}` }, { text: "🤖 Blacklist Enhancer 🔒", callback_data: `cfg_bl_ai_${channelId}` }],
      [_menuBackBtn(channelId)]
    ]}
  });
}
async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  const withoutPrefix = data.replace(/^cfg_/, "");
  const chanMatch = withoutPrefix.match(/_(-?\d+)$/);
  const channelId = chanMatch ? chanMatch[1] : withoutPrefix.split("_").pop();
  const action = chanMatch ? withoutPrefix.slice(0, withoutPrefix.length - chanMatch[0].length) : withoutPrefix.split("_").slice(0, -1).join("_");
  const ch = await getChannel(channelId);
  const lang = ch?.bot_language || "de";

  const deleteOld = () => tg.call("deleteMessage", { chat_id: String(userId), message_id: q.message?.message_id }).catch(() => {});

  switch (action) {
    case "mainmenu": case "back": await deleteOld(); await sendSettingsMenu(tg, String(userId), channelId, ch); break;
    case "menu_channel": await deleteOld(); await sendChannelMenu(tg, String(userId), channelId, ch); break;
    case "menu_mod": await deleteOld(); await sendModerationMenu(tg, String(userId), channelId, ch); break;
    case "menu_ai": await deleteOld(); await sendAiMenu(tg, String(userId), channelId, ch); break;
    
    case "lang": {
      const kb = [];
      const codes = Object.keys(SUPPORTED_LANGUAGES);
      for (let i = 0; i < codes.length; i += 2) {
        const row = [{ text: SUPPORTED_LANGUAGES[codes[i]], callback_data: `cfg_setlang_${codes[i]}_${channelId}` }];
        if (codes[i+1]) row.push({ text: SUPPORTED_LANGUAGES[codes[i+1]], callback_data: `cfg_setlang_${codes[i+1]}_${channelId}` });
        kb.push(row);
      }
      kb.push([_menuBackBtn(channelId)]);
      await deleteOld();
      await tg.call("sendMessage", { chat_id: String(userId), text: `🌐 <b>Sprache wählen</b>\n\nAktuell: ${SUPPORTED_LANGUAGES[lang] || lang}`, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "setlang": {
      const m = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (m) {
        await supabase_db.from("bot_channels").update({ bot_language: m[1], updated_at: new Date() }).eq("id", m[2]);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ ${SUPPORTED_LANGUAGES[m[1]]}` });
        const updated = await getChannel(m[2]);
        await deleteOld(); await sendChannelMenu(tg, String(userId), m[2], updated);
      }
      break;
    }
    case "welcome": case "goodbye": {
      const isW = action === "welcome";
      await tg.call("sendMessage", { chat_id: String(userId), text: `📝 <b>${isW ? "Willkommen" : "Abschied"} bearbeiten</b>\n\nAktuell: <i>${(isW ? ch?.welcome_msg : ch?.goodbye_msg) || "(leer)"}</i>\n\nSende neuen Text oder /cancel.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, lang)] } });
      global.pendingInputs[String(userId)] = { action: `set_${action}`, channelId };
      break;
    }
    case "clean": {
      await tg.call("sendMessage", { chat_id: String(userId), text: "🔍 Bereinigung läuft..." });
      const settings = await getSettings();
      const res = await tgAdminHelper.cleanDeletedAccounts(settings?.smalltalk_bot_token, channelId);
      await tg.call("sendMessage", { chat_id: String(userId), text: `🧹 Fertig! ${res.removed} Accounts entfernt.` });
      break;
    }
    case "stats": {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const [{ count: mC }, { count: jC }, { count: lC }] = await Promise.all([
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).is("left_at", null),
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("joined_at", yesterday),
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("left_at", yesterday)
      ]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `📊 <b>Statistik</b>\n\n👥 Gesamt: ${mC||0}\n📈 +${jC||0} | 📉 -${lC||0} (24h)`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, lang)] } });
      break;
    }
    case "sl_toggle": {
      const newVal = !ch?.safelist_enabled;
      await supabase_db.from("bot_channels").update({ safelist_enabled: newVal }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: newVal ? "🛡 Aktiviert" : "🛡 Deaktiviert" });
      const u = await getChannel(channelId); await deleteOld(); await sendModerationMenu(tg, String(userId), channelId, u);
      break;
    }
    case "daily_now": {
      if (!ch?.ai_enabled) break;
      await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ Erstelle Bericht..." });
      await dailySummaryService.runDailySummary(supabase_db, channelId, userId, tg, ch, lang);
      break;
    }
    // ... (Andere Cases wie blacklist, knowledge etc. folgen der gleichen Struktur)
  }
}

module.exports = { sendSettingsMenu, sendChannelMenu, sendModerationMenu, sendAiMenu, handleSettingsCallback };
