const supabase = require("../../config/supabase");
const { tgAdminHelper } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const dailySummaryService = require("./dailySummaryService");
const { SUPPORTED_LANGUAGES, t } = require("../i18n");

// ─── Lokales DICT entfernt – nun zentrales Translation-Tool aus services/i18n.js
// Schlüssel-Mapping (alt → neu):
//   title         → settings_title
//   ch_settings   → settings_ch
//   mod           → settings_mod
//   ai_feat       → settings_ai
//   welcome       → ch_welcome
//   goodbye       → ch_goodbye
//   sched         → ch_schedule
//   rep           → ch_repeat
//   lang          → btn_language
//   clean         → ch_clean
//   stats         → ch_stats
//   sl_btn        → mod_safelist
//   fb_btn        → mod_feedback
//   bl            → mod_blacklist
//   ui            → mod_userinfo
//   fb_mgr        → mod_fb_mgr
//   ai_locked     → ai_locked
//   mod_locked    → mod_locked
//   daily         → ai_daily
//   st            → ai_smalltalk
//   kb            → ai_kb
//   aw            → ai_adwriter
//   bl_ai         → ai_blacklist
//   group_games   → ai_groupgames
//   banned_users  → mod_banned
//   back          → back
//   main          → main_menu

async function getSettings() {
  try { const { data } = await supabase.from("settings").select("*").maybeSingle(); return data || null; } catch { return null; }
}

async function getChannel(chatId) {
  try { const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle(); return data || null; } catch { return null; }
}

function backBtn(channelId, lang) {
  return [{ text: t("back", lang), callback_data: `cfg_back_${channelId || "0"}` }];
}

function _menuBackBtn(channelId, lang) {
  return { text: t("main_menu", lang), callback_data: `cfg_mainmenu_${channelId}` };
}

async function editOrSend(tg, sendTo, msgId, text, kb) {
  if (msgId) {
    return tg.call("editMessageText", { chat_id: sendTo, message_id: msgId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }).catch(() => {
      return tg.call("sendMessage", { chat_id: sendTo, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    });
  }
  return tg.call("sendMessage", { chat_id: sendTo, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

async function sendSettingsMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  const aiText = ch?.ai_enabled ? "✅" : "❌";
  const text = t("settings_title", l, {
    name: ch?.title || channelId,
    ai: aiText,
    sl: ch?.safelist_enabled ? "✅" : "❌",
    fb: ch?.feedback_enabled ? "✅" : "❌",
  });
  const kb = [
    [{ text: t("settings_ch", l), callback_data: `cfg_menu_channel_${channelId}` }],
    [{ text: ch?.is_approved ? t("settings_mod", l) : t("settings_mod", l) + " 🔒", callback_data: `cfg_menu_mod_${channelId}` }],
    [{ text: ch?.ai_enabled ? t("settings_ai", l) : t("settings_ai", l) + " 🔒", callback_data: `cfg_menu_ai_${channelId}` }]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendChannelMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  const text = t("ch_title", l, { name: ch?.title || channelId });
  const kb = [
    [{ text: t("ch_welcome", l), callback_data: `cfg_welcome_${channelId}` }, { text: t("ch_goodbye", l), callback_data: `cfg_goodbye_${channelId}` }],
    [{ text: t("ch_schedule", l), callback_data: `cfg_schedule_${channelId}` }, { text: t("ch_repeat", l), callback_data: `cfg_repeat_${channelId}` }],
    [{ text: t("btn_language", l), callback_data: `cfg_lang_${channelId}` }, { text: t("ch_stats", l), callback_data: `cfg_stats_${channelId}` }],
    [_menuBackBtn(channelId, l)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendModerationMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  if (!ch?.is_approved) return editOrSend(tg, sendTo, msgId, t("mod_locked", l), [[_menuBackBtn(channelId, l)]]);
  const text = t("mod_title", l, { name: ch?.title || channelId });
  const kb = [
    [
      { text: t("mod_safelist", l, { sl: ch?.safelist_enabled ? "✅" : "❌" }), callback_data: `cfg_safelist_${channelId}` },
      { text: t("mod_feedback", l, { fb: ch?.feedback_enabled ? "✅" : "❌" }), callback_data: `cfg_feedback_${channelId}` }
    ],
    [{ text: t("mod_blacklist", l), callback_data: `cfg_blacklist_${channelId}` }, { text: t("mod_userinfo", l), callback_data: `cfg_userinfo_${channelId}` }],
    [{ text: t("mod_banned", l), callback_data: `cfg_banned_${channelId}` }, { text: t("ch_clean", l), callback_data: `cfg_clean_${channelId}` }],
    [_menuBackBtn(channelId, l)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendAiMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  if (!ch?.ai_enabled) return editOrSend(tg, sendTo, msgId, t("ai_locked", l), [[_menuBackBtn(channelId, l)]]);
  const text = t("ai_title", l, { name: ch?.title || channelId });
  const kb = [
    [{ text: t("ai_daily", l), callback_data: `cfg_daily_${channelId}` }, { text: t("ai_smalltalk", l), callback_data: `cfg_smalltalk_${channelId}` }],
    [{ text: t("ai_kb", l), callback_data: `cfg_knowledge_${channelId}` }],
    [{ text: t("ai_adwriter", l), callback_data: `cfg_adwriter_${channelId}` }, { text: t("ai_blacklist", l), callback_data: `cfg_bl_ai_${channelId}` }],
    [{ text: t("ai_groupgames", l), callback_data: `cfg_groupgames_${channelId}` }],
    [_menuBackBtn(channelId, l)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  const parts = data.split("_");
  const channelId = parts[parts.length - 1];
  let action = parts[1];

  if (parts[1] === "bl" && parts[2] === "tgl") {
    action = parts.slice(1, 5).join("_");
  } else if (parts[1] === "bl" && parts[2] === "cfg") {
    action = parts.slice(1, 4).join("_");
  } else if (["menu", "sl", "fb", "rep", "bl", "st", "aw", "kb", "daily", "clean"].includes(parts[1]) && parts.length >= 4) {
    action = parts[1] + "_" + parts[2];
  }

  const ch = await getChannel(channelId);

  if (ch && String(ch.added_by_user_id) !== String(userId)) {
    return tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Keine Berechtigung für diesen Channel.", show_alert: true }).catch(()=>{});
  }

  const userLang = q.from?.language_code?.substring(0, 2) || "de";
  const lang = ch?.bot_language || userLang;
  const msgId = q.message?.message_id;

  switch (action) {
    case "mainmenu": case "back": await sendSettingsMenu(tg, String(userId), channelId, ch, msgId, userLang); break;
    case "menu_channel": await sendChannelMenu(tg, String(userId), channelId, ch, msgId, userLang); break;
    case "menu_mod": await sendModerationMenu(tg, String(userId), channelId, ch, msgId, userLang); break;
    case "menu_ai": await sendAiMenu(tg, String(userId), channelId, ch, msgId, userLang); break;

    case "lang": {
      const kb = [];
      const codes = Object.keys(SUPPORTED_LANGUAGES);
      for (let i = 0; i < codes.length; i += 2) {
        const row = [{ text: SUPPORTED_LANGUAGES[codes[i]], callback_data: `cfg_setlang_${codes[i]}_${channelId}` }];
        if (codes[i+1]) row.push({ text: SUPPORTED_LANGUAGES[codes[i+1]], callback_data: `cfg_setlang_${codes[i+1]}_${channelId}` });
        kb.push(row);
      }
      kb.push([_menuBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, `${t("language_menu", lang)}\n\nAktuell: ${SUPPORTED_LANGUAGES[lang] || lang}`, kb);
      break;
    }
    case "setlang": {
      const m = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (m) {
        await supabase_db.from("bot_channels").update({ bot_language: m[1], updated_at: new Date() }).eq("id", m[2]);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: t("language_set", m[1], { lang: SUPPORTED_LANGUAGES[m[1]] }) }).catch(()=>{});
        const updated = await getChannel(m[2]);
        await sendChannelMenu(tg, String(userId), m[2], updated, msgId, userLang);
      }
      break;
    }
    case "welcome": case "goodbye": {
      const isW = action === "welcome";
      const currentText = (isW ? ch?.welcome_msg : ch?.goodbye_msg) || "(leer)";
      // Header mit Variablen-Liste, damit der Admin sieht was er einbauen kann.
      // Bei welcome: Mitglieder-Beitrittstexte; bei goodbye: User existiert evtl.
      // nicht mehr in der Gruppe — daher dieselben Variablen, aber mit Hinweis.
      const headerText =
        `📝 <b>${isW ? "Willkommens" : "Abschieds"}-Nachricht bearbeiten</b>\n\n` +
        `<b>Verfügbare Platzhalter</b> – beliebig oft im Text einsetzbar:\n` +
        `• <code>{name}</code> – Name fett markiert\n` +
        `• <code>{first_name}</code> – Vorname (klar)\n` +
        `• <code>{last_name}</code> – Nachname\n` +
        `• <code>{username}</code> – @-Handle (z.B. @max)\n` +
        `• <code>{user_id}</code> – Telegram-ID\n` +
        `• <code>{chat_title}</code> – Channel-/Gruppentitel\n` +
        `• <code>{member_count}</code> – aktuelle Mitgliederzahl\n` +
        `• <code>{time}</code> – Uhrzeit (HH:MM)\n` +
        `• <code>{date}</code> – Datum (TT.MM.JJJJ)\n\n` +
        `<b>Beispiel:</b>\n` +
        `<code>Willkommen {name}! Du bist Mitglied #{member_count} – schön dass du um {time} dabei bist. 🎉</code>\n\n` +
        `<b>Aktuell:</b>\n<i>${currentText}</i>\n\n` +
        `Sende den neuen Text oder /cancel.`;
      const sent = await editOrSend(tg, String(userId), msgId, headerText, [[backBtn(channelId, lang)[0]]]);
      global.pendingInputs[String(userId)] = { action: `set_${action}`, channelId, wizardMsgId: sent?.message_id || msgId };
      break;
    }
    case "banned": {
      const { data: bList } = await supabase_db.from("channel_banned_users").select("user_id, username, reason").eq("channel_id", channelId).limit(25);
      if (!bList?.length) { await editOrSend(tg, String(userId), msgId, "✅ Keine gebannten User gefunden.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = bList.map(e => [{ text: `🟢 Entbannen: @${e.username || e.user_id}`, callback_data: `cfg_unban_${e.user_id}_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, `🚫 <b>Gebannte User</b>\n\nKlicke auf einen User, um ihn zu entbannen.`, kb);
      break;
    }
    case "unban": {
      const m = data.match(/^cfg_unban_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        await tg.call("unbanChatMember", { chat_id: m[2], user_id: m[1], only_if_banned: false }).catch(()=>{});
        await supabase_db.from("channel_banned_users").delete().eq("user_id", m[1]).eq("channel_id", m[2]);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ User entbannt" }).catch(()=>{});
        handleSettingsCallback(tg, supabase_db, `cfg_banned_${channelId}`, q, userId);
      }
      break;
    }
    case "clean": {
      const interval = ch?.auto_clean_interval || "off";
      let statusText = "Deaktiviert";
      if (interval === "daily") statusText = "Täglich";
      if (interval === "weekly") statusText = "Wöchentlich";
      await editOrSend(tg, String(userId), msgId, `🧹 <b>Bereinigen</b>\n\nEntfernt gelöschte Accounts aus dem Channel.\n\nAktueller Auto-Modus: <b>${statusText}</b>`, [
        [{ text: "▶️ Jetzt bereinigen", callback_data: `cfg_clean_now_${channelId}` }],
        [{ text: interval === "daily" ? "✅ Auto: Täglich" : "⏱ Auto: Täglich", callback_data: `cfg_clean_daily_${channelId}` }],
        [{ text: interval === "weekly" ? "✅ Auto: Wöchentlich" : "⏱ Auto: Wöchentlich", callback_data: `cfg_clean_weekly_${channelId}` }],
        [{ text: interval === "off" || !interval ? "✅ Auto: Aus" : "❌ Auto: Aus", callback_data: `cfg_clean_off_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "clean_now": {
      await editOrSend(tg, String(userId), msgId, "🔍 Bereinigung läuft...", []);
      const settings = await getSettings();
      const res = await tgAdminHelper.cleanDeletedAccounts(settings?.smalltalk_bot_token, channelId);
      await editOrSend(tg, String(userId), msgId, `🧹 Fertig! ${res.removed} Accounts entfernt.`, [[backBtn(channelId, lang)[0]]]);
      break;
    }
    case "clean_daily":
    case "clean_weekly":
    case "clean_off": {
      const intervalMap = { clean_daily: "daily", clean_weekly: "weekly", clean_off: "off" };
      const newInterval = intervalMap[action];
      await supabase_db.from("bot_channels").update({ auto_clean_interval: newInterval }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Gespeichert" }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_clean_${channelId}`, q, userId);
      break;
    }
    case "stats": {
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const [{ count: mC }, { count: jC }, { count: lC }] = await Promise.all([
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).is("left_at", null),
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("joined_at", yesterday),
        supabase_db.from("channel_members").select("id", {count:"exact"}).eq("channel_id", channelId).gte("left_at", yesterday)
      ]);
      await editOrSend(tg, String(userId), msgId, `📊 <b>Statistik</b>\n\n👥 Gesamt: ${mC||0}\n📈 +${jC||0} | 📉 -${lC||0} (24h)`, [[backBtn(channelId, lang)[0]]]);
      break;
    }
    case "safelist": {
      const slEnabled = ch?.safelist_enabled || false;
      const [{ count: sl }, { count: sc }] = await Promise.all([
        supabase_db.from("channel_safelist").select("id", { count: "exact" }).eq("channel_id", channelId),
        supabase_db.from("scam_entries").select("id", { count: "exact" }).eq("channel_id", channelId)
      ]);
      await editOrSend(tg, String(userId), msgId, `🛡 <b>Safelist & Scamliste</b>\n\n✅ Safelist: ${sl||0} | ⛔ Scamliste: ${sc||0}`, [
        [{ text: slEnabled ? "🔴 Deaktivieren" : "🟢 Aktivieren", callback_data: `cfg_sl_toggle_${channelId}` }],
        [{ text: `✅ Safelist`, callback_data: `cfg_sl_safeview_${channelId}` }, { text: `⛔ Scamliste`, callback_data: `cfg_sl_scamview_${channelId}` }],
        [{ text: "➕ User hinzufügen", callback_data: `cfg_sl_adduser_${channelId}` }, { text: "📋 Reviews", callback_data: `cfg_sl_reviews_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "sl_toggle": {
      const newVal = !ch?.safelist_enabled;
      await supabase_db.from("bot_channels").update({ safelist_enabled: newVal }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: newVal ? "🛡 Aktiviert" : "🛡 Deaktiviert" }).catch(()=>{});
      const u = await getChannel(channelId); await sendModerationMenu(tg, String(userId), channelId, u, msgId, userLang);
      break;
    }
    case "sl_safeview": {
      const { data: sList } = await supabase_db.from("channel_safelist").select("id, user_id, username, score").eq("channel_id", channelId).limit(25);
      if (!sList?.length) { await editOrSend(tg, String(userId), msgId, "✅ Safelist ist leer.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = sList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_safedel_${e.id}_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, `✅ <b>Safelist</b>\n\n` + sList.map((e, i) => `${i+1}. ✅ @${e.username || e.user_id}`).join("\n"), kb);
      break;
    }
    case "sl_scamview": {
      const { data: scList } = await supabase_db.from("scam_entries").select("id, user_id, username, reason").eq("channel_id", channelId).limit(25);
      if (!scList?.length) { await editOrSend(tg, String(userId), msgId, "⛔ Scamliste ist leer.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = scList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_scamdel_${e.id}_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, `⛔ <b>Scamliste</b>\n\n` + scList.map((e, i) => `${i+1}. ⛔ @${e.username || e.user_id}`).join("\n"), kb);
      break;
    }
    case "sl_safedel": {
      const m = data.match(/^cfg_sl_safedel_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) { await supabase_db.from("channel_safelist").delete().eq("id", m[1]).eq("channel_id", m[2]); await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Entfernt" }).catch(()=>{}); handleSettingsCallback(tg, supabase_db, `cfg_sl_safeview_${channelId}`, q, userId); }
      break;
    }
    case "sl_scamdel": {
      const m = data.match(/^cfg_sl_scamdel_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) { await supabase_db.from("scam_entries").delete().eq("id", m[1]).eq("channel_id", m[2]); await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Entfernt" }).catch(()=>{}); handleSettingsCallback(tg, supabase_db, `cfg_sl_scamview_${channelId}`, q, userId); }
      break;
    }
    case "sl_reviews": {
      const reviews = await safelistService.getPendingReviews(channelId);
      if (!reviews.length) { await editOrSend(tg, String(userId), msgId, "📋 Keine offenen Reviews.", [[backBtn(channelId, lang)[0]]]); break; }
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msgId }).catch(() => {});
      for (const r of reviews.slice(0, 5)) {
        await tg.call("sendMessage", { chat_id: String(userId), text: `${r.feedback_type === "positive" ? "✅" : "⚠️"} <b>@${r.target_username||r.target_user_id||"?"}</b>\nVon: @${r.submitted_by_username||r.submitted_by||"?"}\n<i>${(r.feedback_text||"").substring(0,150)}</i>`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Bestätigen", callback_data: `fb_approve_${r.id}` }, { text: "❌ Ablehnen", callback_data: `fb_reject_${r.id}` }]] } });
      }
      break;
    }
    case "feedback": {
      await editOrSend(tg, String(userId), msgId, `💬 <b>Feedback-System</b>\n\nManuell: /safelist @user · /scamlist @user`, [
        [{ text: ch?.feedback_enabled ? "🔴 Deaktivieren" : "🟢 Aktivieren", callback_data: `cfg_fb_toggle_${channelId}` }],
        [{ text: t("mod_fb_mgr", lang), callback_data: `fb_mgr_user_${channelId}` }],
        [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` }, { text: "🏆 Top 10", callback_data: `cfg_fb_ranking_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "fb_toggle": {
      const newVal = !ch?.feedback_enabled;
      await supabase_db.from("bot_channels").update({ feedback_enabled: newVal }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: newVal ? "💬 Aktiviert" : "💬 Deaktiviert" }).catch(()=>{});
      const u = await getChannel(channelId); await sendModerationMenu(tg, String(userId), channelId, u, msgId, userLang);
      break;
    }
    case "fb_ranking": {
      const { data: top } = await supabase_db.rpc("get_top_sellers", { p_channel_id: channelId, p_limit: 10 });
      if (!top?.length) { await editOrSend(tg, String(userId), msgId, "🏆 Kein Ranking.", [[backBtn(channelId, lang)[0]]]); break; }
      const lines = top.map((u, i) => `${["🥇","🥈","🥉"][i]||`${i+1}.`} @${u.username||u.user_id} — ${u.score} Pkt`).join("\n");
      await editOrSend(tg, String(userId), msgId, `🏆 <b>Top 10 Verkäufer</b>\n\n${lines}`, [[backBtn(channelId, lang)[0]]]);
      break;
    }
    case "sl_adduser": case "sl_addscam": case "userinfo": case "kb_add": case "bl_add": case "bl_addsoft": case "schedule": case "aw_new": case "st_prompt": {
      const msgs = {
        sl_adduser: "✅ <b>Safelist</b>\n\nSende @username oder Telegram-ID.",
        sl_addscam: "⛔ <b>Scamliste</b>\n\nSende @username oder Telegram-ID.",
        userinfo: "🔍 <b>UserInfo</b>\n\nSende ID, @username oder leite eine Nachricht weiter.",
        kb_add: "📚 <b>Wissensdatenbank</b>\n\nSende FAQ, Preise, Regeln etc. (KI sortiert automatisch ein).",
        bl_add: "🚫 <b>Wort zur Harte Liste hinzufügen</b>\n\nSende das Wort (oder /cancel)",
        bl_addsoft: "🟡 <b>Wort zur Toleriert-Liste hinzufügen</b>\n\nSende das Wort (oder /cancel)",
        schedule: "📅 <b>Schritt 1/6: Nachrichtentext</b>\n\nSende den Text der Nachricht.\n\n<i>✨ Tipp: Du kannst beliebige Formatierungen verwenden — fett, kursiv, Spoiler, Links und auch <b>animierte Premium-Emojis</b>. Alles, was du in der Nachricht sehen kannst, wird vom Bot 1:1 übernommen.</i>\n\nOder /skip für nur Medien.",
        aw_new: "✍️ <b>WerbeTexter</b>\n\nSende Originaltext (Kosten: 30 Credits).",
        st_prompt: "✏️ <b>System-Prompt</b>\n\nSende neuen Prompt."
      };
      const sent = await editOrSend(tg, String(userId), msgId, msgs[action] + "\n\n/cancel zum Abbrechen.", [[{ text: "❌ Abbrechen", callback_data: `cfg_back_${channelId}` }]]);
      const actionsMap = { sl_adduser: "safelist_add_user", sl_addscam: "scamlist_add_user", userinfo: "userinfo_awaiting", kb_add: "kb_add_entry", bl_add: "bl_add_word", bl_addsoft: "bl_add_soft", schedule: "sched_wizard_text", aw_new: "adwriter_new", st_prompt: "set_ai_prompt" };
      global.pendingInputs[String(userId)] = { action: actionsMap[action], channelId, aiOn: ch?.ai_enabled, freeMode: !ch?.ai_enabled, wizardMsgId: sent?.message_id || msgId };
      break;
    }
    case "repeat": {
      const { data: s } = await supabase_db.from("scheduled_messages").select("id, message, cron_expr, is_active").eq("channel_id", channelId).limit(20);
      const kb = (s||[]).map(m => [{ text: `${m.is_active?"✅":"⏸"} ${(m.message||"").substring(0,35)}…`, callback_data: `cfg_rep_edit_${m.id}_${channelId}` }]);
      kb.unshift([{ text: "➕ Neue Nachricht", callback_data: `cfg_schedule_${channelId}` }]);
      kb.push([_menuBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, "🔁 <b>Wiederholende Nachrichten</b>", kb);
      break;
    }
    case "rep_edit": {
      const m = data.match(/^cfg_rep_edit_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", m[1]).maybeSingle();
        if (!s) break;
        let intervalText = "Einmalig";
        if (s.interval_minutes) intervalText = s.interval_minutes >= 60 ? `alle ${s.interval_minutes/60} Stunden` : `alle ${s.interval_minutes} Minuten`;
        const endText = s.end_at ? new Date(s.end_at).toLocaleString("de-DE") : "Nie (Endlos)";
        await editOrSend(tg, String(userId), msgId, `🔁 <b>${(s.message||"").substring(0,60)}</b>\n\nStatus: ${s.is_active?"Aktiv":"Pausiert"}\nIntervall: ${intervalText}\nEnddatum: ${endText}`, [
          [{ text: s.is_active?"⏸ Pausieren":"▶️ Aktivieren", callback_data: `cfg_rep_toggle_${m[1]}_${channelId}` }],
          [{ text: "🗑 Löschen", callback_data: `cfg_rep_del_${m[1]}_${channelId}` }],
          [{ text: "◀️ Zurück", callback_data: `cfg_repeat_${channelId}` }]
        ]);
      }
      break;
    }
    case "rep_toggle": {
      const m = data.match(/^cfg_rep_toggle_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("is_active").eq("id", m[1]).maybeSingle();
        await supabase_db.from("scheduled_messages").update({ is_active: !s?.is_active }).eq("id", m[1]);
        handleSettingsCallback(tg, supabase_db, `cfg_rep_edit_${m[1]}_${channelId}`, q, userId);
      }
      break;
    }
    case "rep_del": {
      const m = data.match(/^cfg_rep_del_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) { await supabase_db.from("scheduled_messages").delete().eq("id", m[1]); handleSettingsCallback(tg, supabase_db, `cfg_repeat_${channelId}`, q, userId); }
      break;
    }
    case "blacklist": {
      const [{ count: hc }, { count: sc }] = await Promise.all([
        supabase_db.from("channel_blacklist").select("id", { count: "exact" }).eq("channel_id", channelId).neq("severity", "tolerated"),
        supabase_db.from("channel_blacklist").select("id", { count: "exact" }).eq("channel_id", channelId).eq("severity", "tolerated")
      ]);
      await editOrSend(tg, String(userId), msgId, `🚫 <b>Blacklist</b>\n\n🔴 Harte Liste: ${hc||0} | 🟡 Toleriert-Liste: ${sc||0}`, [
        [{ text: `🔴 Harte Liste verwalten`, callback_data: `cfg_bl_list_${channelId}` }],
        [{ text: `🟡 Toleriert-Liste verwalten`, callback_data: `cfg_bl_listsoft_${channelId}` }],
        [{ text: "⚙️ Konsequenzen einstellen", callback_data: `cfg_bl_settings_${channelId}` }],
        [{ text: "🌐 Auf alle meine Kanäle anwenden", callback_data: `cfg_bl_globalapply_${channelId}` }],
        [_menuBackBtn(channelId, lang)]
      ]);
      break;
    }
    case "bl_settings": {
      await editOrSend(tg, String(userId), msgId, `⚙️ <b>Blacklist Konsequenzen</b>\n\nWähle, für welche Liste du das Verhalten ändern möchtest:`, [
        [{ text: "🔴 Harte Liste konfigurieren", callback_data: `cfg_bl_cfg_hard_${channelId}` }],
        [{ text: "🟡 Toleriert-Liste konfigurieren", callback_data: `cfg_bl_cfg_soft_${channelId}` }],
        [{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]
      ]);
      break;
    }
    case "bl_cfg_hard": {
      const hardCons = ch?.bl_hard_consequences || [];
      const hasDel = hardCons.includes("delete");
      const hasMute = hardCons.includes("mute");
      const hasBan = hardCons.includes("ban");
      await editOrSend(tg, String(userId), msgId, `🔴 <b>Konsequenzen: Harte Liste</b>\n\nWas soll passieren, wenn jemand ein Wort aus der Harten Liste postet?`, [
        [{ text: `🗑 Nachricht löschen: ${hasDel ? "✅" : "❌"}`, callback_data: `cfg_bl_tgl_hard_delete_${channelId}` }],
        [{ text: `🔇 User stummschalten (12h): ${hasMute ? "✅" : "❌"}`, callback_data: `cfg_bl_tgl_hard_mute_${channelId}` }],
        [{ text: `🚫 User bannen: ${hasBan ? "✅" : "❌"}`, callback_data: `cfg_bl_tgl_hard_ban_${channelId}` }],
        [{ text: "◀️ Zurück", callback_data: `cfg_bl_settings_${channelId}` }]
      ]);
      break;
    }
    case "bl_cfg_soft": {
      const softHours = ch?.bl_soft_delete_hours || 0;
      await editOrSend(tg, String(userId), msgId, `🟡 <b>Konsequenzen: Toleriert-Liste</b>\n\nNachrichten mit diesen Wörtern bleiben zunächst stehen.\n\nSollen sie automatisch gelöscht werden?`, [
        [{ text: softHours === 1 ? "✅ Nach 1 Stunde löschen" : "⏱ Nach 1 Stunde löschen", callback_data: `cfg_bl_tgl_soft_1_${channelId}` }],
        [{ text: softHours === 24 ? "✅ Nach 24 Stunden löschen" : "⏱ Nach 24 Stunden löschen", callback_data: `cfg_bl_tgl_soft_24_${channelId}` }],
        [{ text: softHours === 0 ? "✅ Nie löschen (Nur Warnung)" : "❌ Nie löschen", callback_data: `cfg_bl_tgl_soft_0_${channelId}` }],
        [{ text: "◀️ Zurück", callback_data: `cfg_bl_settings_${channelId}` }]
      ]);
      break;
    }
    case "bl_tgl_hard_delete":
    case "bl_tgl_hard_mute":
    case "bl_tgl_hard_ban": {
      const toggleAction = action.split("_").pop();
      let currentCons = ch?.bl_hard_consequences || [];
      if (currentCons.includes(toggleAction)) {
        currentCons = currentCons.filter(c => c !== toggleAction);
      } else {
        currentCons.push(toggleAction);
      }
      await supabase_db.from("bot_channels").update({ bl_hard_consequences: currentCons }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Aktualisiert" }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_bl_cfg_hard_${channelId}`, q, userId);
      break;
    }
    case "bl_tgl_soft_0":
    case "bl_tgl_soft_1":
    case "bl_tgl_soft_24": {
      const hours = parseInt(action.split("_").pop());
      await supabase_db.from("bot_channels").update({ bl_soft_delete_hours: hours }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Gespeichert" }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_bl_cfg_soft_${channelId}`, q, userId);
      break;
    }
    case "bl_globalapply": {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "⏳ Wende auf alle Kanäle an..." }).catch(()=>{});
      try {
        const { data: myChannels } = await supabase_db.from("bot_channels").select("id").eq("added_by_user_id", String(userId));
        if (myChannels && myChannels.length > 1) {
          const { data: currentWords } = await supabase_db.from("channel_blacklist").select("word, severity, delete_after_hours, category").eq("channel_id", channelId);
          const currentHardCons = ch?.bl_hard_consequences || [];
          const currentSoftHours = ch?.bl_soft_delete_hours || 0;
          for (const myCh of myChannels) {
            if (myCh.id === channelId) continue;
            await supabase_db.from("bot_channels").update({ bl_hard_consequences: currentHardCons, bl_soft_delete_hours: currentSoftHours }).eq("id", myCh.id);
            if (currentWords && currentWords.length > 0) {
              const wordsToInsert = currentWords.map(w => ({ channel_id: myCh.id, word: w.word, severity: w.severity, delete_after_hours: w.delete_after_hours, category: w.category, created_by: userId }));
              await supabase_db.from("channel_blacklist").upsert(wordsToInsert, { onConflict: "channel_id,word" });
            }
          }
          await editOrSend(tg, String(userId), msgId, `✅ <b>Erfolgreich!</b>\n\nDie Blacklist-Wörter und Konsequenzen wurden auf alle deine Kanäle übertragen.`, [[backBtn(channelId, lang)[0]]]);
        } else {
          await editOrSend(tg, String(userId), msgId, `ℹ️ Du hast keine weiteren aktiven Kanäle, auf die das angewendet werden kann.`, [[backBtn(channelId, lang)[0]]]);
        }
      } catch (e) {
        await editOrSend(tg, String(userId), msgId, `❌ Fehler beim Synchronisieren: ${e.message}`, [[backBtn(channelId, lang)[0]]]);
      }
      break;
    }
    case "bl_list": case "bl_listsoft": {
      const isSoft = action === "bl_listsoft";
      const { data: bList } = await supabase_db.from("channel_blacklist").select("id, word, severity").eq("channel_id", channelId).eq("severity", isSoft ? "tolerated" : "mute").limit(25);
      const kb = [];
      kb.push([{ text: isSoft ? "➕ Wort zu Toleriert hinzufügen" : "➕ Wort zu Hart hinzufügen", callback_data: `cfg_bl_${isSoft ? 'addsoft' : 'add'}_${channelId}` }]);
      if (bList?.length) { bList.forEach(e => kb.push([{ text: `🗑 ${e.word}`, callback_data: `cfg_bl_${isSoft ? 'delsoft' : 'del'}_${e.id}_${channelId}` }])); }
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      const textIntro = bList?.length ? `${isSoft?"🟡":"🔴"} <b>Blacklist</b>\n\n` + bList.map(e=>`• <code>${e.word}</code>`).join("\n") : `${isSoft?"🟡":"🔴"} Liste ist aktuell leer.`;
      await editOrSend(tg, String(userId), msgId, textIntro, kb);
      break;
    }
    case "bl_del": case "bl_delsoft": {
      const isSoft = action === "bl_delsoft";
      const regex = isSoft ? /^cfg_bl_delsoft_([a-zA-Z0-9-]+)_(-?\d+)$/ : /^cfg_bl_del_([a-zA-Z0-9-]+)_(-?\d+)$/;
      const m = data.match(regex);
      if (m) { await supabase_db.from("channel_blacklist").delete().eq("id", m[1]); handleSettingsCallback(tg, supabase_db, `cfg_bl_${isSoft ? 'listsoft' : 'list'}_${channelId}`, q, userId); }
      break;
    }
    case "knowledge": {
      const { data: kbList } = await supabase_db.from("channel_knowledge").select("id, title").eq("channel_id", channelId).limit(20);
      await editOrSend(tg, String(userId), msgId, `📚 <b>Wissen</b> (${kbList?.length||0} Einträge)`, [
        [{ text: "➕ Eintrag", callback_data: `cfg_kb_add_${channelId}` }, { text: "🗑 Löschen", callback_data: `cfg_kb_delete_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "kb_delete": {
      const { data: kbList } = await supabase_db.from("channel_knowledge").select("id, title").eq("channel_id", channelId).limit(20);
      if (!kbList?.length) { await editOrSend(tg, String(userId), msgId, "Keine Einträge.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = kbList.map(e => [{ text: `🗑 ${(e.title||"").substring(0,40)}`, callback_data: `cfg_kb_del_${e.id}_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, `🗑 <b>Löschen</b>`, kb);
      break;
    }
    case "kb_del": {
      const m = data.match(/^cfg_kb_del_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) { await supabase_db.from("channel_knowledge").delete().eq("id", m[1]); handleSettingsCallback(tg, supabase_db, `cfg_kb_delete_${channelId}`, q, userId); }
      break;
    }
    case "smalltalk": {
      if (!ch?.ai_enabled) break;
      await editOrSend(tg, String(userId), msgId, `💬 <b>Smalltalk</b>\n\nModell: ${ch?.smalltalk_model === "openai" ? "OpenAI" : "AutoActsAI"}`, [
        [{ text: "✏️ System-Prompt", callback_data: `cfg_st_prompt_${channelId}` }],
        [{ text: "🔄 Modell wechseln", callback_data: `cfg_st_model_${channelId}` }],
        [_menuBackBtn(channelId, lang)]
      ]);
      break;
    }
    case "st_model": {
      const newModel = ch?.smalltalk_model === "openai" ? "deepseek" : "openai";
      await supabase_db.from("bot_channels").update({ smalltalk_model: newModel }).eq("id", channelId);
      handleSettingsCallback(tg, supabase_db, `cfg_smalltalk_${channelId}`, q, userId);
      break;
    }
    case "daily": {
      if (!ch?.ai_enabled) break;
      await editOrSend(tg, String(userId), msgId, `📰 <b>Tagesbericht</b>`, [
        [{ text: "📰 Jetzt erstellen", callback_data: `cfg_daily_now_${channelId}` }],
        [_menuBackBtn(channelId, lang)]
      ]);
      break;
    }
    case "daily_now": {
      if (!ch?.ai_enabled) break;
      await editOrSend(tg, String(userId), msgId, "⏳ Erstelle Tagesbericht...", []);
      await dailySummaryService.runDailySummary(supabase_db, channelId, userId, tg, ch, lang);
      break;
    }
    case "groupgames": {
      await editOrSend(tg, String(userId), msgId, t("ai_groupgames_info", lang), [[_menuBackBtn(channelId, lang)]]);
      break;
    }
    case "adwriter": {
      if (!ch?.ai_enabled) break;
      const { data: ads } = await supabase_db.from("scheduled_messages").select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(5);
      const kb = (ads||[]).map(s => [{ text: `✍️ ${(s.message||"").substring(0,30)}…`, callback_data: `cfg_aw_vary_${s.id}_${channelId}` }]);
      kb.unshift([{ text: "✍️ Neu (30 Credits)", callback_data: `cfg_aw_new_${channelId}` }]);
      kb.push([_menuBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, `✍️ <b>WerbeTexter</b>`, kb);
      break;
    }
    case "aw_vary": {
      const m = data.match(/^cfg_aw_vary_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("message").eq("id", m[1]).maybeSingle();
        const sent = await editOrSend(tg, String(userId), msgId, `✍️ <b>Variationen</b>\n\n<i>${(s?.message||"").substring(0,100)}</i>\n\nKosten: 30 Credits`, [[{ text: "✅ Ausführen", callback_data: `cfg_aw_run_${m[1]}_${channelId}` }]]);
        global.pendingInputs[String(userId)] = { action: "adwriter_vary", channelId, origText: s?.message, wizardMsgId: sent?.message_id || msgId };
      }
      break;
    }
    case "aw_run": {
      const m = data.match(/^cfg_aw_run_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("message").eq("id", m[1]).maybeSingle();
        if (!s?.message) break;
        await editOrSend(tg, String(userId), msgId, "⏳ WerbeTexter arbeitet...", []);
        try {
          const axios = require("axios");
          const r = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 1200, messages: [{ role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Trenne die Variationen mit ---." }, { role: "user", content: s.message }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } });
          const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
          await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).then(r=>r, ()=>{});
          await tg.call("deleteMessage", { chat_id: String(userId), message_id: msgId }).catch(() => {});
          for (let i = 0; i < Math.min(variations.length, 3); i++) {
            await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `📅 Als Nachricht einplanen`, callback_data: `cfg_schedule_${channelId}` }]] } });
          }
        } catch (e) { await editOrSend(tg, String(userId), msgId, "❌ Fehler: " + e.message, [[backBtn(channelId, lang)[0]]]); }
      }
      break;
    }
    case "noop": break;
  }
}

module.exports = { sendSettingsMenu, sendChannelMenu, sendModerationMenu, sendAiMenu, handleSettingsCallback };
