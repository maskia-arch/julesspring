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

async function editOrSend(tg, sendTo, msgId, text, kb) {
  if (msgId) {
    return tg.call("editMessageText", {
      chat_id: sendTo, message_id: msgId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
    }).catch(() => {
      return tg.call("sendMessage", { chat_id: sendTo, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    });
  }
  return tg.call("sendMessage", { chat_id: sendTo, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

async function sendSettingsMenu(tg, sendTo, channelId, ch, msgId = null) {
  const aiText = ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv";
  const text = `⚙️ <b>${ch?.title || channelId}</b>\n\nKI: ${aiText} | Safelist: ${ch?.safelist_enabled ? "✅" : "❌"} | Feedback: ${ch?.feedback_enabled ? "✅" : "❌"}\n\nWähle eine Kategorie:`;
  const kb = [
    [{ text: "📋 Channel-Einstellungen", callback_data: `cfg_menu_channel_${channelId}` }],
    [{ text: "🔒 Moderation", callback_data: `cfg_menu_mod_${channelId}` }],
    [{ text: ch?.ai_enabled ? "🤖 AI Features" : "🤖 AI Features 🔒", callback_data: `cfg_menu_ai_${channelId}` }]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendChannelMenu(tg, sendTo, channelId, ch, msgId = null) {
  const text = `📋 <b>Channel-Einstellungen</b> — ${ch?.title || channelId}`;
  const kb = [
    [{ text: "👋 Willkommen", callback_data: `cfg_welcome_${channelId}` }, { text: "👋 Abschied", callback_data: `cfg_goodbye_${channelId}` }],
    [{ text: "📅 Zeitplan", callback_data: `cfg_schedule_${channelId}` }, { text: "🔁 Wiederholungen", callback_data: `cfg_repeat_${channelId}` }],
    [{ text: "🌐 Sprache", callback_data: `cfg_lang_${channelId}` }],
    [{ text: "🧹 Bereinigen", callback_data: `cfg_clean_${channelId}` }, { text: "📊 Statistik", callback_data: `cfg_stats_${channelId}` }],
    [_menuBackBtn(channelId)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendModerationMenu(tg, sendTo, channelId, ch, msgId = null) {
  const text = `🔒 <b>Moderation</b> — ${ch?.title || channelId}`;
  const kb = [
    [{ text: `🛡 Safelist ${ch?.safelist_enabled ? "✅" : "❌"}`, callback_data: `cfg_safelist_${channelId}` }, { text: `💬 Feedback ${ch?.feedback_enabled ? "✅" : "❌"}`, callback_data: `cfg_feedback_${channelId}` }],
    [{ text: "🚫 Blacklist", callback_data: `cfg_blacklist_${channelId}` }, { text: "🔍 UserInfo", callback_data: `cfg_userinfo_${channelId}` }],
    [_menuBackBtn(channelId)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendAiMenu(tg, sendTo, channelId, ch, msgId = null) {
  if (!ch?.ai_enabled) {
    const text = `🤖 <b>AI Features</b> — Gesperrt\n\nAI Features sind nur mit einem aktiven Paket verfügbar.\nNutze <b>/buy</b> um ein Paket zu kaufen.`;
    return editOrSend(tg, sendTo, msgId, text, [[_menuBackBtn(channelId)]]);
  }
  const text = `🤖 <b>AI Features</b> — ${ch?.title || channelId}`;
  const kb = [
    [{ text: "📰 Tagesbericht", callback_data: `cfg_daily_${channelId}` }, { text: "💬 Smalltalk AI", callback_data: `cfg_smalltalk_${channelId}` }],
    [{ text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${channelId}` }],
    [{ text: "✍️ WerbeTexter", callback_data: `cfg_adwriter_${channelId}` }, { text: "🤖 Blacklist Enhancer 🔒", callback_data: `cfg_bl_ai_${channelId}` }],
    [_menuBackBtn(channelId)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}
async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  const parts = data.split("_");
  const channelId = parts[parts.length - 1];
  let action = parts[1];
  
  const compositePrefixes = ["menu", "sl", "fb", "rep", "bl", "st", "aw", "kb", "daily"];
  if (compositePrefixes.includes(parts[1]) && parts.length >= 4) {
    action = parts[1] + "_" + parts[2];
  }

  const ch = await getChannel(channelId);
  const lang = ch?.bot_language || "de";
  const msgId = q.message?.message_id;
  const deleteOld = () => tg.call("deleteMessage", { chat_id: String(userId), message_id: msgId }).catch(() => {});

  switch (action) {
    case "mainmenu": case "back": await sendSettingsMenu(tg, String(userId), channelId, ch, msgId); break;
    case "menu_channel": await sendChannelMenu(tg, String(userId), channelId, ch, msgId); break;
    case "menu_mod": await sendModerationMenu(tg, String(userId), channelId, ch, msgId); break;
    case "menu_ai": await sendAiMenu(tg, String(userId), channelId, ch, msgId); break;
    
    case "lang": {
      const kb = [];
      const codes = Object.keys(SUPPORTED_LANGUAGES);
      for (let i = 0; i < codes.length; i += 2) {
        const row = [{ text: SUPPORTED_LANGUAGES[codes[i]], callback_data: `cfg_setlang_${codes[i]}_${channelId}` }];
        if (codes[i+1]) row.push({ text: SUPPORTED_LANGUAGES[codes[i+1]], callback_data: `cfg_setlang_${codes[i+1]}_${channelId}` });
        kb.push(row);
      }
      kb.push([_menuBackBtn(channelId)]);
      await editOrSend(tg, String(userId), msgId, `🌐 <b>Sprache wählen</b>\n\nAktuell: ${SUPPORTED_LANGUAGES[lang] || lang}`, kb);
      break;
    }
    case "setlang": {
      const m = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (m) {
        await supabase_db.from("bot_channels").update({ bot_language: m[1], updated_at: new Date() }).eq("id", m[2]);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ ${SUPPORTED_LANGUAGES[m[1]]}` }).catch(()=>{});
        const updated = await getChannel(m[2]);
        await sendChannelMenu(tg, String(userId), m[2], updated, msgId);
      }
      break;
    }
    case "welcome": case "goodbye": {
      const isW = action === "welcome";
      await editOrSend(tg, String(userId), msgId, `📝 <b>${isW ? "Willkommen" : "Abschied"} bearbeiten</b>\n\nAktuell: <i>${(isW ? ch?.welcome_msg : ch?.goodbye_msg) || "(leer)"}</i>\n\nSende neuen Text oder /cancel.`, [[backBtn(channelId, lang)[0]]]);
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
      const u = await getChannel(channelId); await sendModerationMenu(tg, String(userId), channelId, u, msgId);
      break;
    }
    case "sl_safeview": {
      const { data: sList } = await supabase_db.from("channel_safelist").select("id, user_id, username, score").eq("channel_id", channelId).limit(25);
      if (!sList?.length) { await editOrSend(tg, String(userId), msgId, "✅ Safelist ist leer.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = sList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_safedel_${e.id}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]);
      await editOrSend(tg, String(userId), msgId, `✅ <b>Safelist</b>\n\n` + sList.map((e, i) => `${i+1}. ✅ @${e.username || e.user_id}`).join("\n"), kb);
      break;
    }
    case "sl_scamview": {
      const { data: scList } = await supabase_db.from("scam_entries").select("id, user_id, username, reason").eq("channel_id", channelId).limit(25);
      if (!scList?.length) { await editOrSend(tg, String(userId), msgId, "⛔ Scamliste ist leer.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = scList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_scamdel_${e.id}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]);
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
      await deleteOld();
      for (const r of reviews.slice(0, 5)) {
        await tg.call("sendMessage", { chat_id: String(userId), text: `${r.feedback_type === "positive" ? "✅" : "⚠️"} <b>@${r.target_username||r.target_user_id||"?"}</b>\nVon: @${r.submitted_by_username||r.submitted_by||"?"}\n<i>${(r.feedback_text||"").substring(0,150)}</i>`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Bestätigen", callback_data: `fb_approve_${r.id}` }, { text: "❌ Ablehnen", callback_data: `fb_reject_${r.id}` }]] } });
      }
      break;
    }
    case "feedback": {
      await editOrSend(tg, String(userId), msgId, `💬 <b>Feedback-System</b>\n\nManuell: /safelist @user · /scamlist @user`, [
        [{ text: ch?.feedback_enabled ? "🔴 Deaktivieren" : "🟢 Aktivieren", callback_data: `cfg_fb_toggle_${channelId}` }],
        [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` }, { text: "🏆 Top 10", callback_data: `cfg_fb_ranking_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "fb_toggle": {
      const newVal = !ch?.feedback_enabled;
      await supabase_db.from("bot_channels").update({ feedback_enabled: newVal }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: newVal ? "💬 Aktiviert" : "💬 Deaktiviert" }).catch(()=>{});
      const u = await getChannel(channelId); await sendModerationMenu(tg, String(userId), channelId, u, msgId);
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
        bl_add: "🚫 <b>Blacklist</b>\n\nFormat: <code>Wort | Aktion | Kategorie</code>",
        bl_addsoft: "🟡 <b>Toleriertes Wort</b>\n\nFormat: <code>Wort | Stunden</code>",
        schedule: "📅 <b>Sende Nachrichtentext:</b>\n\nOder /skip für nur Medien.",
        aw_new: "✍️ <b>WerbeTexter</b>\n\nSende Originaltext (Kosten: 30 Credits).",
        st_prompt: "✏️ <b>System-Prompt</b>\n\nSende neuen Prompt."
      };
      await deleteOld();
      await tg.call("sendMessage", { chat_id: String(userId), text: msgs[action] + "\n\n/cancel zum Abbrechen.", parse_mode: "HTML" });
      const actionsMap = { sl_adduser: "safelist_add_user", sl_addscam: "scamlist_add_user", userinfo: "userinfo_awaiting", kb_add: "kb_add_entry", bl_add: "bl_add_word", bl_addsoft: "bl_add_soft", schedule: "sched_wizard_text", aw_new: "adwriter_new", st_prompt: "set_ai_prompt" };
      global.pendingInputs[String(userId)] = { action: actionsMap[action], channelId, aiOn: ch?.ai_enabled, freeMode: !ch?.ai_enabled };
      break;
    }
    case "repeat": {
      const { data: s } = await supabase_db.from("scheduled_messages").select("id, message, cron_expr, is_active").eq("channel_id", channelId).limit(20);
      const kb = (s||[]).map(m => [{ text: `${m.is_active?"✅":"⏸"} ${(m.message||"").substring(0,35)}…`, callback_data: `cfg_rep_edit_${m.id}_${channelId}` }]);
      kb.unshift([{ text: "➕ Neue Nachricht", callback_data: `cfg_schedule_${channelId}` }]);
      kb.push([_menuBackBtn(channelId)]);
      await editOrSend(tg, String(userId), msgId, "🔁 <b>Wiederholende Nachrichten</b>", kb);
      break;
    }
    case "rep_edit": {
      const m = data.match(/^cfg_rep_edit_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", m[1]).maybeSingle();
        if (!s) break;
        await editOrSend(tg, String(userId), msgId, `🔁 <b>${(s.message||"").substring(0,60)}</b>\n\nStatus: ${s.is_active?"Aktiv":"Pausiert"}`, [
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
      await editOrSend(tg, String(userId), msgId, `🚫 <b>Blacklist</b>\n\n🔴 Hart: ${hc||0} | 🟡 Toleriert: ${sc||0}`, [
        [{ text: "➕ Wort hinzufügen", callback_data: `cfg_bl_add_${channelId}` }, { text: "➕ Toleriertes Wort", callback_data: `cfg_bl_addsoft_${channelId}` }],
        [{ text: `📋 Harte Liste`, callback_data: `cfg_bl_list_${channelId}` }, { text: `🟡 Light-Liste`, callback_data: `cfg_bl_listsoft_${channelId}` }],
        [_menuBackBtn(channelId)]
      ]);
      break;
    }
    case "bl_list": case "bl_listsoft": {
      const isSoft = action === "bl_listsoft";
      const { data: bList } = await supabase_db.from("channel_blacklist").select("id, word, severity, delete_after_hours").eq("channel_id", channelId).eq("severity", isSoft ? "tolerated" : "mute").limit(25);
      if (!bList?.length) { await editOrSend(tg, String(userId), msgId, "Liste ist leer.", [[backBtn(channelId, lang)[0]]]); break; }
      const kb = bList.map(e => [{ text: `🗑 ${e.word}`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      await editOrSend(tg, String(userId), msgId, `${isSoft?"🟡":"🔴"} <b>Blacklist</b>\n\n` + bList.map(e=>`• <code>${e.word}</code>`).join("\n"), kb);
      break;
    }
    case "bl_del": {
      const m = data.match(/^cfg_bl_del_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) { await supabase_db.from("channel_blacklist").delete().eq("id", m[1]); handleSettingsCallback(tg, supabase_db, `cfg_blacklist_${channelId}`, q, userId); }
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
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_knowledge_${channelId}` }]);
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
        [_menuBackBtn(channelId)]
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
        [_menuBackBtn(channelId)]
      ]);
      break;
    }
    case "daily_now": {
      if (!ch?.ai_enabled) break;
      await deleteOld();
      await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ Erstelle Tagesbericht..." });
      await dailySummaryService.runDailySummary(supabase_db, channelId, userId, tg, ch, lang);
      break;
    }
    case "adwriter": {
      if (!ch?.ai_enabled) break;
      const { data: ads } = await supabase_db.from("scheduled_messages").select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(5);
      const kb = (ads||[]).map(s => [{ text: `✍️ ${(s.message||"").substring(0,30)}…`, callback_data: `cfg_aw_vary_${s.id}_${channelId}` }]);
      kb.unshift([{ text: "✍️ Neu (30 Credits)", callback_data: `cfg_aw_new_${channelId}` }]);
      kb.push([_menuBackBtn(channelId)]);
      await editOrSend(tg, String(userId), msgId, `✍️ <b>WerbeTexter</b>`, kb);
      break;
    }
    case "aw_vary": {
      const m = data.match(/^cfg_aw_vary_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("message").eq("id", m[1]).maybeSingle();
        global.pendingInputs[String(userId)] = { action: "adwriter_vary", channelId, origText: s?.message };
        await editOrSend(tg, String(userId), msgId, `✍️ <b>Variationen</b>\n\n<i>${(s?.message||"").substring(0,100)}</i>\n\nKosten: 30 Credits`, [[{ text: "✅ Ausführen", callback_data: `cfg_aw_run_${m[1]}_${channelId}` }]]);
      }
      break;
    }
    case "aw_run": {
      const m = data.match(/^cfg_aw_run_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (m) {
        const { data: s } = await supabase_db.from("scheduled_messages").select("message").eq("id", m[1]).maybeSingle();
        if (!s?.message) break;
        await deleteOld();
        await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ WerbeTexter arbeitet..." });
        try {
          const axios = require("axios");
          const r = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 1200, messages: [{ role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Trenne die Variationen mit ---." }, { role: "user", content: s.message }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } });
          const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
          await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
          for (let i = 0; i < Math.min(variations.length, 3); i++) {
            await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `📅 Als Nachricht einplanen`, callback_data: `cfg_schedule_${channelId}` }]] } });
          }
        } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message }); }
      }
      break;
    }
    case "noop": break;
  }
}

module.exports = { sendSettingsMenu, sendChannelMenu, sendModerationMenu, sendAiMenu, handleSettingsCallback };
