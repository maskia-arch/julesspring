const supabase = require("../../config/supabase");
const { tgAdminHelper } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const dailySummaryService = require("./dailySummaryService");
const groupGameService = require("./groupGameService");
const { SUPPORTED_LANGUAGES } = require("../i18n");
const logger = require("../../utils/logger");

/**
 * HTML-Escape für User-Input das in Telegram-HTML eingebettet wird.
 * Verhindert dass z.B. ein Channel-Title "Tom & Jerry" die parse_mode:HTML
 * Verarbeitung bricht ("can't parse entities: unexpected '&'").
 *
 * Kritisch: bisher führten Channel-Titles mit & < > zu komplett stummen
 * UI-Failures (kein Render, kein Log) weil editOrSend den Fallback-Fehler
 * geswallowed hat.
 */
function _escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function _runBlacklistEnhancer(tg, supabase_db, userId, channelId, wordType, count, msgId, lang) {
  const xaiService = require("../xaiService");
  const workMsg = await tg.call("sendMessage", {
    chat_id: String(userId), parse_mode: "HTML",
    text: `⏳ <b>Grok Think arbeitet…</b>\n\n✨ ${count} ${wordType}\n\n<i>Dies dauert einige Sekunden.</i>`
  }).catch(() => null);

  // Bestehende Blacklist-Wörter als Kontext laden (Duplikate vermeiden)
  let existingWords = [];
  try {
    const { data: existing } = await supabase_db.from("channel_blacklist")
      .select("word").eq("channel_id", String(channelId)).limit(200);
    existingWords = (existing || []).map(e => e.word).filter(Boolean);
  } catch (_) {}

  const result = await xaiService.generateBlacklist(wordType, count, lang || "de", existingWords);

  if (!result.words?.length) {
    await tg.call("editMessageText", {
      chat_id: String(userId), message_id: workMsg?.message_id || msgId, parse_mode: "HTML",
      text: `❌ <b>Blacklist Enhancer fehlgeschlagen</b>\n\n${result.error || "Unbekannter Fehler"}`
    }).catch(() => {});
    return;
  }
  const billedCredits = result.billedCredits || 0;
  try { await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: billedCredits }); } catch (_) {}
  global.pendingInputs[String(userId)] = {
    action: "bl_review_active", channelId, blWords: result.words, blWordType: wordType, blAdded: 0, blSkipped: 0
  };
  const preview = result.words.slice(0, 10).map(w => `• <code>${w}</code>`).join("\n");
  const more    = result.words.length > 10 ? `\n<i>… und ${result.words.length - 10} weitere</i>` : "";
  const existHint = existingWords.length > 0 ? `\n<i>(${existingWords.length} bestehende Wörter ausgeschlossen)</i>` : "";
  await tg.call("editMessageText", {
    chat_id: String(userId), message_id: workMsg?.message_id || msgId, parse_mode: "HTML",
    text:
      `✅ <b>Grok Think hat ${result.words.length} neue Wörter vorgeschlagen:</b>${existHint}\n\n${preview}${more}\n\n` +
      `💳 ${billedCredits.toLocaleString("de-DE")} Credits verbraucht\n\n` +
      `Jetzt kannst du jedes Wort einzeln zur Blacklist hinzufügen und die Schwere bestimmen.`,
    reply_markup: { inline_keyboard: [
      [{ text: "📝 Wörter zur Blacklist hinzufügen", callback_data: `cfg_bl_revw_0_${channelId}` }],
      [{ text: "◀️ Zurück", callback_data: `cfg_ai_${channelId}` }]
    ]}
  }).catch(async () => {
    await tg.call("sendMessage", { chat_id: String(userId), parse_mode: "HTML",
      text: `✅ ${result.words.length} Wörter generiert.`,
      reply_markup: { inline_keyboard: [[{ text: "📝 Zur Blacklist hinzufügen", callback_data: `cfg_bl_revw_0_${channelId}` }]] } });
  });
}

const { t, getLangInstruction, SUPPORTED_LANGUAGES: _LANGS } = require("../i18n");

async function getSettings() {
  try { const { data } = await supabase.from("settings").select("*").maybeSingle(); return data || null; } catch { return null; }
}

async function getChannel(chatId) {
  try { const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle(); return data || null; } catch { return null; }
}

function backBtn(channelId, lang) {
  return [{ text: t("back", lang), callback_data: `cfg_back_${channelId || "0"}` }];
}

/** Zurück zum AI-Features-Menü — für alle Sub-Menüs von sendAiMenu */
function _aiBackBtn(channelId, lang) {
  return { text: t("back", lang), callback_data: `cfg_ai_${channelId || "0"}` };
}

function _menuBackBtn(channelId, lang) {
  return { text: t("main", lang), callback_data: `cfg_mainmenu_${channelId}` };
}

async function editOrSend(tg, sendTo, msgId, text, kb) {
  // Formatter importieren damit auch Texte mit Markdown-Syntax korrekt dargestellt werden
  let safeText = text;
  try {
    const { markdownToHtml } = require("../../utils/telegramFormatter");
    safeText = markdownToHtml(String(text || ""));
  } catch (_) { safeText = String(text || ""); }

  const payload = { chat_id: sendTo, text: safeText, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } };

  // Plain-Text-Variante als Notfall-Fallback wenn HTML-Parsing failt
  // (z.B. wegen unescaped <, > oder & im Channel-Titel)
  const fallbackPlain = async (reason) => {
    logger.warn(`[editOrSend] HTML-parse failed (${reason}) — Plain-Text Fallback an ${sendTo}`);
    const plain = String(text || "").replace(/<[^>]+>/g, ""); // alle HTML-Tags entfernen
    try {
      return await tg.call("sendMessage", {
        chat_id: sendTo, text: plain, reply_markup: { inline_keyboard: kb }
      });
    } catch (e) {
      logger.warn(`[editOrSend] Plain-Text Fallback ebenfalls fehlgeschlagen: ${e.message}`);
      return null;
    }
  };

  if (msgId) {
    try {
      return await tg.call("editMessageText", { ...payload, message_id: msgId });
    } catch (eEdit) {
      // editMessageText kann auch fehlschlagen wenn die Nachricht nicht geändert wurde
      // ("message is not modified") — das ist kein echter Fehler.
      if (/not modified/i.test(eEdit.message || "")) return null;
      // Bei HTML-Parse-Fehler direkt Plain-Text Fallback (keine zweite sendMessage)
      if (/can'?t parse entities|bad request.*parse/i.test(eEdit.message || "")) {
        return fallbackPlain("edit:" + eEdit.message.substring(0, 80));
      }
      // Sonst: sendMessage probieren (Original-Logik)
      try {
        return await tg.call("sendMessage", payload);
      } catch (eSend) {
        if (/can'?t parse entities|bad request.*parse/i.test(eSend.message || "")) {
          return fallbackPlain("send:" + eSend.message.substring(0, 80));
        }
        logger.warn(`[editOrSend] sendMessage an ${sendTo} fehlgeschlagen: ${eSend.message}`);
        return null;
      }
    }
  }

  // Direkt-Send (kein msgId vorhanden)
  try {
    return await tg.call("sendMessage", payload);
  } catch (eSend) {
    if (/can'?t parse entities|bad request.*parse/i.test(eSend.message || "")) {
      return fallbackPlain("send:" + eSend.message.substring(0, 80));
    }
    logger.warn(`[editOrSend] direct sendMessage an ${sendTo} fehlgeschlagen: ${eSend.message}`);
    return null;
  }
}

async function sendSettingsMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  const aiText  = ch?.ai_enabled ? t("ai_active", l) : t("ai_inactive", l);
  const slState = ch?.safelist_enabled ? "✅" : "❌";
  const fbState = ch?.feedback_enabled ? "✅" : "❌";
  const text    = t("title", l, ch?.title || channelId, aiText, slState, fbState);
  const kb = [
    [{ text: t("ch_settings", l), callback_data: `cfg_menu_channel_${channelId}` }],
    [{ text: ch?.is_approved ? t("mod", l) : t("mod", l) + " 🔒", callback_data: `cfg_menu_mod_${channelId}` }],
    [{ text: ch?.ai_enabled ? t("ai_feat", l) : t("ai_feat", l) + " 🔒", callback_data: `cfg_menu_ai_${channelId}` }]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendChannelMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  const text = `${t("ch_settings", l).split(" ")[0]} <b>${t("ch_settings", l).replace(/^[^\s]+\s/, "")}</b> — ${_escapeHtml(ch?.title || channelId)}`;
  const kb = [
    [{ text: t("welcome", l), callback_data: `cfg_welcome_${channelId}` }, { text: t("goodbye", l), callback_data: `cfg_goodbye_${channelId}` }],
    [{ text: t("sched", l), callback_data: `cfg_schedule_${channelId}` }, { text: t("rep", l), callback_data: `cfg_repeat_${channelId}` }],
    [{ text: t("lang", l), callback_data: `cfg_lang_${channelId}` }, { text: t("stats", l), callback_data: `cfg_stats_${channelId}` }],
    [{ text: "👥 Admins verwalten", callback_data: `cfg_admins_${channelId}` }],
    [_menuBackBtn(channelId, l)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendModerationMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  if (!ch?.is_approved) return editOrSend(tg, sendTo, msgId, t("mod_locked", l), [[_menuBackBtn(channelId, l)]]);
  const text = `${t("mod", l).split(" ")[0]} <b>${t("mod", l).replace(/^[^\s]+\s/, "")}</b> — ${_escapeHtml(ch?.title || channelId)}`;
  const kb = [
    [{ text: t("sl_btn", l).replace("{sl}", ch?.safelist_enabled ? "✅" : "❌"), callback_data: `cfg_safelist_${channelId}` },
     { text: t("fb_btn", l).replace("{fb}", ch?.feedback_enabled ? "✅" : "❌"), callback_data: `cfg_feedback_${channelId}` }],
    [{ text: t("bl", l), callback_data: `cfg_blacklist_${channelId}` }, { text: t("ui", l), callback_data: `cfg_userinfo_${channelId}` }],
    [{ text: t("banned_users", l), callback_data: `cfg_banned_${channelId}` }, { text: t("clean", l), callback_data: `cfg_clean_${channelId}` }],
    [_menuBackBtn(channelId, l)]
  ];
  return editOrSend(tg, sendTo, msgId, text, kb);
}

async function sendAiMenu(tg, sendTo, channelId, ch, msgId = null, userLang = "de") {
  const l = ch?.bot_language || userLang;
  if (!ch?.ai_enabled) return editOrSend(tg, sendTo, msgId, t("ai_locked", l), [[_menuBackBtn(channelId, l)]]);
  const text = `${t("ai_feat", l).split(" ")[0]} <b>${t("ai_feat", l).replace(/^[^\s]+\s/, "")}</b> — ${_escapeHtml(ch?.title || channelId)}`;

  // Credits-Kurzstatus für den Button
  const tokenLimit = parseInt(ch?.token_limit) || 0;
  const tokenUsed  = parseInt(ch?.token_used)  || 0;
  const tokenLeft  = Math.max(0, tokenLimit - tokenUsed);
  const creditsLabel = tokenLimit > 0
    ? `💳 Credits: ${tokenLeft.toLocaleString("de-DE")} / ${tokenLimit.toLocaleString("de-DE")}`
    : `💳 Credits verwalten`;

  const kb = [
    [{ text: t("daily", l), callback_data: `cfg_daily_${channelId}` }, { text: t("st", l), callback_data: `cfg_smalltalk_${channelId}` }],
    [{ text: t("kb", l), callback_data: `cfg_knowledge_${channelId}` }],
    [{ text: t("aw", l), callback_data: `cfg_adwriter_${channelId}` }, { text: t("bl_ai", l), callback_data: `cfg_bl_ai_${channelId}` }],
    [{ text: `🚨 AI @admin${ch?.admin_report_enabled ? " ✅" : ""}`, callback_data: `cfg_adminrep_${channelId}` }],
    [{ text: creditsLabel, callback_data: `cfg_credits_${channelId}` }],
    [{ text: "🎮 Gruppenspiele", callback_data: `cfg_groupgames_${channelId}` }],
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
  } else if (parts[1] === "bl" && parts[2] === "enhancer" && parts.length >= 5) {
    action = "bl_enhancer_" + parts[3];
  } else if (parts[1] === "aw" && parts[2] === "plan" && parts.length >= 5) {
    action = "aw_plan";
  } else if (parts[1] === "st" && parts[2] === "setmodel" && parts.length >= 5) {
    action = "st_setmodel";
  } else if (parts[1] === "st" && parts[2] === "selector" && parts.length >= 4) {
    action = "st_selector";
  } else if (parts[1] === "admins") {
    if      (parts[2] === "del") action = "admins_del";
    else if (parts[2] === "tog") action = "admins_tog";
    else if (parts[2] === "add") action = "admins_add";
    else                         action = "admins";
  } else if (parts[1] === "aw" && parts[2] === "addvar") {
    action = "aw_addvar";
  } else if (parts[1] === "aw" && parts[2] === "plan") {
    action = "aw_plan";
  } else if (parts[1] === "quiet") {
    if      (parts[2] === "mode")  action = `quiet_mode_${parts[3]}`;
    else if (parts[2] === "stars" && parts[3] === "set") action = "quiet_stars_set";
    else if (parts[2] === "stars") action = "quiet_stars";
    else if (parts[2] === "start") action = "quiet_start";
    else if (parts[2] === "end")   action = "quiet_end";
    else if (parts[2] === "clear") action = "quiet_clear";
    else                           action = "quiet_" + parts[2];
  } else if (parts[1] === "groupgames") {
    // cfg_groupgames_<chanId>                                       → "groupgames"
    // cfg_groupgames_activity_<chanId>                              → "groupgames_activity"
    // cfg_groupgames_activity_toggle_<chanId>                       → "groupgames_activity_toggle"
    // cfg_groupgames_activity_reset_<chanId>                        → "groupgames_activity_reset"
    // cfg_groupgames_activity_reset_confirm_<chanId>                → "groupgames_activity_reset_confirm"
    // cfg_groupgames_activity_ranking_<chanId>                      → "groupgames_activity_ranking"
    // cfg_groupgames_activity_autopost_<chanId>                     → "groupgames_activity_autopost"
    // cfg_groupgames_activity_autopost_set_<hours>_<chanId>         → "groupgames_activity_autopost_set"
    // cfg_groupgames_activity_period_<chanId>                       → "groupgames_activity_period"
    // cfg_groupgames_activity_period_setstart_<chanId>              → "groupgames_activity_period_setstart"
    // cfg_groupgames_activity_period_setend_<chanId>                → "groupgames_activity_period_setend"
    // cfg_groupgames_activity_period_clear_<chanId>                 → "groupgames_activity_period_clear"
    if (parts.length === 3) {
      action = "groupgames";
    } else if (parts[2] === "activity") {
      if (parts.length === 4) {
        action = "groupgames_activity";
      } else if (parts[3] === "toggle" && parts.length >= 5) {
        action = "groupgames_activity_toggle";
      } else if (parts[3] === "act" && parts[4] === "now" && parts.length >= 6) {
        action = "groupgames_activity_act_now";
      } else if (parts[3] === "act" && parts[4] === "end" && parts.length >= 6) {
        action = "groupgames_activity_act_end";
      } else if (parts[3] === "powered" && parts[4] === "clear" && parts.length >= 6) {
        action = "groupgames_activity_powered_clear";
      } else if (parts[3] === "powered" && parts.length >= 5) {
        action = "groupgames_activity_powered";
      } else if (parts[3] === "reset" && parts[4] === "confirm" && parts.length >= 6) {
        action = "groupgames_activity_reset_confirm";
      } else if (parts[3] === "reset" && parts.length >= 5) {
        action = "groupgames_activity_reset";
      } else if (parts[3] === "ranking" && parts.length >= 5) {
        action = "groupgames_activity_ranking";
      } else if (parts[3] === "autopost" && parts[4] === "set") {
        action = "groupgames_activity_autopost_set";
      } else if (parts[3] === "autopost" && parts.length >= 5) {
        action = "groupgames_activity_autopost";
      } else if (parts[3] === "period" && parts[4] === "setstart") {
        action = "groupgames_activity_period_setstart";
      } else if (parts[3] === "period" && parts[4] === "setend") {
        action = "groupgames_activity_period_setend";
      } else if (parts[3] === "period" && parts[4] === "clear") {
        action = "groupgames_activity_period_clear";
      } else if (parts[3] === "period" && parts.length >= 5) {
        action = "groupgames_activity_period";
      }
    } else if (parts[2] === "diss") {
      // cfg_groupgames_diss_<chanId>                       → "groupgames_diss"
      // cfg_groupgames_diss_toggle_<chanId>                → "groupgames_diss_toggle"
      // cfg_groupgames_diss_dur_<min>_<chanId>             → "groupgames_diss_dur"
      // cfg_groupgames_diss_arena_<chanId>                 → "groupgames_diss_arena"
      // cfg_groupgames_diss_arena_clear_<chanId>           → "groupgames_diss_arena_clear"
      // cfg_groupgames_diss_ranking_<chanId>               → "groupgames_diss_ranking"
      if (parts.length === 4) {
        action = "groupgames_diss";
      } else if (parts[3] === "toggle") {
        action = "groupgames_diss_toggle";
      } else if (parts[3] === "dur" && parts.length >= 6) {
        action = "groupgames_diss_dur";
      } else if (parts[3] === "arena" && parts[4] === "clear") {
        action = "groupgames_diss_arena_clear";
      } else if (parts[3] === "arena") {
        action = "groupgames_diss_arena";
      } else if (parts[3] === "ranking") {
        action = "groupgames_diss_ranking";
      }
    }
  } else if (parts[1] === "adminrep" && parts[2] === "toggle") {
    action = "adminrep_toggle";
  } else if (parts[1] === "adminrep" && parts[2] === "aitoggle") {
    action = "adminrep_aitoggle";
  } else if (parts[1] === "adminrep" && parts[2] === "cat" && parts.length >= 5) {
    // cfg_adminrep_cat_<category>_<action>_<channelId>
    action = "adminrep_cat";
  } else if (parts[1] === "adminrep" && parts[2] === "catmenu" && parts.length >= 5) {
    action = "adminrep_catmenu";
  } else if (parts[1] === "adminrep") {
    action = "adminrep";
  } else if (parts[1] === "rep" && parts[2] === "eend" && parts[3] === "clear") {
    action = "rep_eend_clear";
  } else if (parts[1] === "rep" && parts[2] === "eend") {
    action = "rep_eend";
  } else if (parts[1] === "rep" && parts[2] === "emedia" && parts[3] === "del") {
    action = "rep_emedia_del";
  } else if (parts[1] === "rep" && parts[2] === "ebtns" && parts[3] === "del") {
    action = "rep_ebtns_del";
  } else if (parts[1] === "rep" && parts[2] === "test") {
    action = "rep_test";
  } else if (parts[1] === "ggap") {
    // Spielerverwaltung (Activity Tracker)
    if (parts.length === 3) {
      action = "ggap_list";
    } else if (parts[2] === "p" && parts.length >= 5) {
      action = "ggap_page";
    } else if (parts[2] === "e" && parts.length >= 5) {
      action = "ggap_edit";
    } else if (parts[2] === "a" && parts.length >= 6) {
      action = "ggap_adjust";
    } else if (parts[2] === "s" && parts.length >= 5) {
      action = "ggap_set";
    } else if (parts[2] === "dc" && parts.length >= 5) {
      action = "ggap_delconfirm";
    } else if (parts[2] === "d" && parts.length >= 5) {
      action = "ggap_del";
    }
  } else if (parts[1] === "credits" && parts[2] === "log") {
    // cfg_credits_log_<range>_<chanId> → credits_log_today|yesterday|week|month|all
    // cfg_credits_log_<chanId>          → credits_log (Default heute)
    if (parts.length >= 5 && ["today","yesterday","week","month","all"].includes(parts[3])) {
      action = `credits_log_${parts[3]}`;
    } else {
      action = "credits_log";
    }
  } else if (["menu", "sl", "fb", "rep", "bl", "st", "aw", "kb", "daily", "clean"].includes(parts[1]) && parts.length >= 4) {
    action = parts[1] + "_" + parts[2];
  }

  const ch = await getChannel(channelId);

  // Permission: Owner ODER Co-Admin darf Channel-Einstellungen bearbeiten
  if (ch && String(ch.added_by_user_id) !== String(userId)) {
    try {
      const { data: coAdmin } = await supabase_db.from("channel_co_admins")
        .select("id").eq("channel_id", String(channelId)).eq("user_id", parseInt(userId)).maybeSingle();
      if (!coAdmin) {
        return tg.call("answerCallbackQuery", {
          callback_query_id: q.id,
          text: "❌ Keine Berechtigung für diesen Channel.",
          show_alert: true
        }).catch(()=>{});
      }
    } catch (_) {
      return tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "❌ Keine Berechtigung für diesen Channel.",
        show_alert: true
      }).catch(()=>{});
    }
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
      await editOrSend(tg, String(userId), msgId, `🌐 <b>Sprache / Language</b>\n\nAktuell: ${SUPPORTED_LANGUAGES[lang] || lang}`, kb);
      break;
    }
    case "setlang": {
      const m = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (m) {
        await supabase_db.from("bot_channels").update({ bot_language: m[1], updated_at: new Date() }).eq("id", m[2]);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ ${SUPPORTED_LANGUAGES[m[1]]}` }).catch(()=>{});
        const updated = await getChannel(m[2]);
        await sendChannelMenu(tg, String(userId), m[2], updated, msgId, userLang);
      }
      break;
    }
    case "welcome": case "goodbye": {
      const isW       = action === "welcome";
      const fieldKey  = isW ? "welcome_msg" : "goodbye_msg";
      const current   = ch?.[fieldKey] || "";
      const labelKey  = isW ? "welcome" : "goodbye";
      const label     = t(labelKey, lang);

      // Variablen-Guide je Sprache
      const varGuide = {
        de: "📌 <b>Verfügbare Variablen:</b>\n<code>{name}</code> — Vorname fett\n<code>{firstname}</code> — Vorname\n<code>{username}</code> — @username\n<code>{user_id}</code> — Telegram-ID\n<code>{mention}</code> — Verlinkter Name\n<code>{fullname}</code> — Vor- &amp; Nachname\n<code>{chat_id}</code> — Gruppen-ID",
        en: "📌 <b>Available variables:</b>\n<code>{name}</code> — First name (bold)\n<code>{firstname}</code> — First name\n<code>{username}</code> — @username\n<code>{user_id}</code> — Telegram ID\n<code>{mention}</code> — Linked mention\n<code>{fullname}</code> — Full name\n<code>{chat_id}</code> — Group ID",
        es: "📌 <b>Variables disponibles:</b>\n<code>{name}</code> — Nombre (negrita)\n<code>{firstname}</code> — Nombre\n<code>{username}</code> — @usuario\n<code>{user_id}</code> — ID de Telegram\n<code>{mention}</code> — Mención vinculada\n<code>{fullname}</code> — Nombre completo\n<code>{chat_id}</code> — ID del grupo",
        zh: "📌 <b>可用变量：</b>\n<code>{name}</code> — 名字（粗体）\n<code>{firstname}</code> — 名字\n<code>{username}</code> — @用户名\n<code>{user_id}</code> — Telegram ID\n<code>{mention}</code> — 链接提及\n<code>{fullname}</code> — 全名\n<code>{chat_id}</code> — 群组ID",
        ar: "📌 <b>المتغيرات المتاحة:</b>\n<code>{name}</code> — الاسم (عريض)\n<code>{firstname}</code> — الاسم الأول\n<code>{username}</code> — @المستخدم\n<code>{user_id}</code> — معرّف تيليغرام\n<code>{mention}</code> — إشارة مرتبطة\n<code>{fullname}</code> — الاسم الكامل\n<code>{chat_id}</code> — معرّف المجموعة",
        fr: "📌 <b>Variables disponibles :</b>\n<code>{name}</code> — Prénom (gras)\n<code>{firstname}</code> — Prénom\n<code>{username}</code> — @utilisateur\n<code>{user_id}</code> — ID Telegram\n<code>{mention}</code> — Mention liée\n<code>{fullname}</code> — Nom complet\n<code>{chat_id}</code> — ID du groupe",
        ru: "📌 <b>Доступные переменные:</b>\n<code>{name}</code> — Имя жирным\n<code>{firstname}</code> — Имя\n<code>{username}</code> — @имя_пользователя\n<code>{user_id}</code> — Telegram ID\n<code>{mention}</code> — Упоминание со ссылкой\n<code>{fullname}</code> — Полное имя\n<code>{chat_id}</code> — ID группы",
        tr: "📌 <b>Kullanılabilir değişkenler:</b>\n<code>{name}</code> — Adı (kalın)\n<code>{firstname}</code> — Adı\n<code>{username}</code> — @kullanıcı\n<code>{user_id}</code> — Telegram ID\n<code>{mention}</code> — Bağlantılı bahsetme\n<code>{fullname}</code> — Tam adı\n<code>{chat_id}</code> — Grup ID",
      };
      const guide = varGuide[lang] || varGuide["de"];

      const exampleText = isW
        ? `<i>Beispiel: Willkommen {mention}! 👋 Schön dass du bei uns bist.</i>`
        : `<i>Beispiel: Tschüss {name}, wir werden dich vermissen! 👋</i>`;

      const promptText = {
        de: "Sende den neuen Text oder /cancel zum Abbrechen.",
        en: "Send the new text or /cancel to abort.",
        es: "Envía el nuevo texto o /cancel para cancelar.",
        zh: "发送新文本或 /cancel 取消。",
        ar: "أرسل النص الجديد أو /cancel للإلغاء.",
        fr: "Envoyez le nouveau texte ou /cancel pour annuler.",
        ru: "Отправьте новый текст или /cancel для отмены.",
        tr: "Yeni metni gönderin veya iptal için /cancel.",
      };

      const msgText =
        `📝 <b>${label} bearbeiten</b>\n\n` +
        `Aktuell:\n<i>${current ? current.substring(0, 300) : "(leer)"}</i>\n\n` +
        `${guide}\n\n${exampleText}\n\n` +
        `${promptText[lang] || promptText["de"]}`;

      const sent = await editOrSend(tg, String(userId), msgId, msgText, [[backBtn(channelId, lang)[0]]]);
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
      const res = await tgAdminHelper.cleanDeletedAccounts(await require("../../config/botToken").getToken(), channelId);
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
        supabase_db.from("channel_members").select("id",{count:"exact"}).eq("channel_id", channelId).is("left_at", null),
        supabase_db.from("channel_members").select("id",{count:"exact"}).eq("channel_id", channelId).gte("joined_at", yesterday),
        supabase_db.from("channel_members").select("id",{count:"exact"}).eq("channel_id", channelId).gte("left_at", yesterday)
      ]);

      // Credits-Block
      const tokenLimit = parseInt(ch?.token_limit) || 0;
      const tokenUsed  = parseInt(ch?.token_used)  || 0;
      const tokenLeft  = Math.max(0, tokenLimit - tokenUsed);
      const pct        = tokenLimit > 0 ? Math.min(100, Math.round((tokenUsed / tokenLimit) * 100)) : 0;
      const bar        = tokenLimit > 0
        ? "▓".repeat(Math.round(pct/10)) + "░".repeat(10 - Math.round(pct/10))
        : "░".repeat(10);
      const expireAt   = ch?.credits_expire_at
        ? new Date(ch.credits_expire_at).toLocaleDateString("de-DE", {day:"2-digit",month:"2-digit",year:"numeric"})
        : null;

      // Modell-Label
      const rawM = ch?.ai_model || ch?.smalltalk_model || "autoacts-fast";
      const _nm = String(rawM).toLowerCase();
      const mLabel = _nm.indexOf("grok") === 0                                   ? "Grok AI"
                   : (_nm === "openai" || _nm.indexOf("gpt-") === 0)             ? "OpenAI"
                   : (_nm === "autoacts-think" || _nm === "deepseek-reasoner")   ? "AutoActsAi Think"
                   :                                                              "AutoActsAi Fast";

      const creditLine = tokenLimit > 0
        ? `💳 Credits: ${tokenLeft.toLocaleString("de-DE")} übrig / ${tokenLimit.toLocaleString("de-DE")}\n   [${bar}] ${pct}%${expireAt ? `\n   Gültig bis: ${expireAt}` : ""}`
        : `💳 Credits: Kein aktives Paket`;

      await editOrSend(tg, String(userId), msgId,
        `📊 <b>Statistik</b>\n\n` +
        `👥 Mitglieder: ${mC||0}\n📈 +${jC||0} | 📉 -${lC||0} (24h)\n\n` +
        `${creditLine}\n\n` +
        `🤖 KI: ${ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv"} · Modell: ${mLabel}\n` +
        `🛡 Safelist: ${ch?.safelist_enabled ? "✅" : "❌"} · 💬 Feedback: ${ch?.feedback_enabled ? "✅" : "❌"}`,
        [[backBtn(channelId, lang)[0]]]
      );
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
      const kb = [];
      const text = !sList?.length
        ? "✅ <b>Safelist</b>\n\n<i>Noch keine User auf der Safeliste.</i>"
        : `✅ <b>Safelist</b>\n\n` + sList.map((e, i) => `${i+1}. ✅ @${e.username || e.user_id}`).join("\n");
      if (sList?.length) {
        sList.forEach(e => kb.push([{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_safedel_${e.id}_${channelId}` }]));
      }
      kb.push([{ text: "➕ User auf Safeliste setzen", callback_data: `cfg_sl_adduser_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, text, kb);
      break;
    }
    case "sl_scamview": {
      const { data: scList } = await supabase_db.from("scam_entries").select("id, user_id, username, reason").eq("channel_id", channelId).limit(25);
      const kb = [];
      const text = !scList?.length
        ? "⛔ <b>Scamliste</b>\n\n<i>Noch keine User auf der Scamliste.</i>"
        : `⛔ <b>Scamliste</b>\n\n` + scList.map((e, i) => `${i+1}. ⛔ @${e.username || e.user_id}`).join("\n");
      if (scList?.length) {
        scList.forEach(e => kb.push([{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_scamdel_${e.id}_${channelId}` }]));
      }
      kb.push([{ text: "➕ User auf Scamliste setzen", callback_data: `cfg_sl_addscam_${channelId}` }]);
      kb.push([backBtn(channelId, lang)[0]]);
      await editOrSend(tg, String(userId), msgId, text, kb);
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
        [{ text: t("fb_mgr", lang), callback_data: `fb_mgr_user_${channelId}` }],
        [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` }, { text: "🏆 Top 10", callback_data: `cfg_fb_ranking_${channelId}` }],
        [backBtn(channelId, lang)[0]]
      ]);
      break;
    }
    case "fb_toggle": {
      const newVal = !ch?.feedback_enabled;
      await supabase_db.from("bot_channels").update({ feedback_enabled: newVal }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: newVal ? "💬 Feedback-Erkennung aktiviert" : "💬 Feedback-Erkennung deaktiviert" }).catch(()=>{});
      // Feedback-Menü neu laden (nicht Moderation-Menü)
      handleSettingsCallback(tg, supabase_db, `cfg_feedback_${channelId}`, q, userId);
      break;
    }
    case "fb_ranking": {
      const { data: top } = await supabase_db.rpc("get_top_sellers", { p_channel_id: channelId, p_limit: 10 });
      if (!top?.length) { await editOrSend(tg, String(userId), msgId, "🏆 Kein Ranking.", [[backBtn(channelId, lang)[0]]]); break; }
      const lines = top.map((u, i) => `${["🥇","🥈","🥉"][i]||`${i+1}.`} @${u.username||u.user_id} — ${u.score} Pkt`).join("\n");
      await editOrSend(tg, String(userId), msgId, `🏆 <b>Top 10 Verkäufer</b>\n\n${lines}`, [[backBtn(channelId, lang)[0]]]);
      break;
    }
    // ── Nachtruhe (Zeitplan) ────────────────────────────────────────────────
    case "schedule": {
      const qS = ch?.quiet_start, qE = ch?.quiet_end, qMode = ch?.quiet_mode || "lock";
      const starsAmt = ch?.quiet_stars_amount || 1;
      const active = ch?.quiet_active ? "⏸ Aktiv gerade" : "💤 Inaktiv";
      const modeLabel = qMode === "stars" ? `⭐ Sterne (${starsAmt}/Nachricht)` : "🔒 Schreibsperre";

      let statusText = qS && qE
        ? `🕐 ${qS} – ${qE} (${modeLabel})\n${active}`
        : "<i>Keine Nachtruhe eingestellt.</i>";

      await editOrSend(tg, String(userId), msgId,
        `🌙 <b>Nachtruhe</b>\n\n${statusText}\n\n` +
        `Wähle den Modus:\n\n` +
        `<b>🔒 Schreibsperre</b> — niemand kann während der Nachtruhe schreiben.\n` +
        `<b>⭐ Schreiben für Sterne</b> — Telegram-Sterne werden pro Nachricht gefordert.`,
        [
          [{ text: "🔒 Modus: Schreibsperre",     callback_data: `cfg_quiet_mode_lock_${channelId}` },
           { text: "⭐ Modus: Sterne",              callback_data: `cfg_quiet_mode_stars_${channelId}` }],
          [{ text: "🕐 Startzeit setzen",           callback_data: `cfg_quiet_start_${channelId}` },
           { text: "🕑 Endzeit setzen",             callback_data: `cfg_quiet_end_${channelId}` }],
          ...(qMode === "stars" ? [[{ text: `⭐ Sterne/Msg: ${starsAmt} (ändern)`, callback_data: `cfg_quiet_stars_${channelId}` }]] : []),
          ...(qS && qE ? [[{ text: "🗑 Nachtruhe deaktivieren", callback_data: `cfg_quiet_clear_${channelId}` }]] : []),
          [{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]
        ]
      );
      break;
    }

    case "quiet_mode_lock": {
      await supabase_db.from("bot_channels").update({ quiet_mode: "lock" }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Modus: Schreibsperre gesetzt." }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_schedule_${channelId}`, q, userId);
      break;
    }

    case "quiet_mode_stars": {
      await supabase_db.from("bot_channels").update({ quiet_mode: "stars" }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Modus: Sterne gesetzt. Stelle noch die Sterne-Anzahl ein." }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_schedule_${channelId}`, q, userId);
      break;
    }

    case "quiet_stars": {
      const sentQS = await editOrSend(tg, String(userId), msgId,
        `⭐ <b>Sterne pro Nachricht</b>\n\nWähle wieviele Telegram-Sterne pro Nachricht gefordert werden:\n\n<i>(1 Stern ≈ 0,013 €)</i>`,
        [
          [{ text: "⭐ 1 Stern",  callback_data: `cfg_quiet_stars_set_1_${channelId}` },
           { text: "⭐ 3 Sterne", callback_data: `cfg_quiet_stars_set_3_${channelId}` },
           { text: "⭐ 5 Sterne", callback_data: `cfg_quiet_stars_set_5_${channelId}` }],
          [{ text: "⭐ 10 Sterne",callback_data: `cfg_quiet_stars_set_10_${channelId}` },
           { text: "⭐ 25 Sterne",callback_data: `cfg_quiet_stars_set_25_${channelId}` },
           { text: "⭐ 50 Sterne",callback_data: `cfg_quiet_stars_set_50_${channelId}` }],
          [{ text: "◀️ Zurück", callback_data: `cfg_schedule_${channelId}` }]
        ]
      );
      break;
    }

    case "quiet_stars_set": {
      // cfg_quiet_stars_set_<amount>_<channelId>
      const mQSS = data.match(/^cfg_quiet_stars_set_(\d+)_(-?\d+)$/);
      if (!mQSS) break;
      const stars = parseInt(mQSS[1]);
      await supabase_db.from("bot_channels").update({ quiet_stars_amount: stars }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ ${stars} Stern(e) pro Nachricht gesetzt.` }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_schedule_${channelId}`, q, userId);
      break;
    }

    case "quiet_start": {
      const sentQSt = await editOrSend(tg, String(userId), msgId,
        `🕐 <b>Nachtruhe Startzeit</b>\n\nSende die Startzeit im Format <code>HH:MM</code> (24h, z.B. <code>22:00</code>).\n\n/cancel zum Abbrechen.`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_schedule_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = { action: "set_quiet_start", channelId, wizardMsgId: sentQSt?.message_id || msgId };
      break;
    }

    case "quiet_end": {
      const sentQE = await editOrSend(tg, String(userId), msgId,
        `🕑 <b>Nachtruhe Endzeit</b>\n\nSende die Endzeit im Format <code>HH:MM</code> (24h, z.B. <code>06:00</code>).\n\n/cancel zum Abbrechen.`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_schedule_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = { action: "set_quiet_end", channelId, wizardMsgId: sentQE?.message_id || msgId };
      break;
    }

    case "quiet_clear": {
      await supabase_db.from("bot_channels")
        .update({ quiet_start: null, quiet_end: null, quiet_active: false, quiet_mode: null }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "🗑 Nachtruhe deaktiviert." }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_schedule_${channelId}`, q, userId);
      break;
    }

    case "sl_adduser": case "sl_addscam": case "userinfo": case "kb_add": case "bl_add": case "bl_addsoft": case "aw_new": case "st_prompt": {
      const msgs = {
        sl_adduser: "✅ <b>Safelist</b>\n\nSende @username oder Telegram-ID.",
        sl_addscam: "⛔ <b>Scamliste</b>\n\nSende @username oder Telegram-ID.",
        userinfo: "🔍 <b>UserInfo</b>\n\nSende ID, @username oder leite eine Nachricht weiter.",
        kb_add: "📚 <b>Wissensdatenbank</b>\n\nSende FAQ, Preise, Regeln etc. (KI sortiert automatisch ein).",
        bl_add: "🚫 <b>Wort zur Harte Liste hinzufügen</b>\n\nSende das Wort (oder /cancel)",
        bl_addsoft: "🟡 <b>Wort zur Toleriert-Liste hinzufügen</b>\n\nSende das Wort (oder /cancel)",
        aw_new: "✍️ <b>WerbeTexter</b>\n\nSende Originaltext (Kosten: 30 Credits).",
        st_prompt: "✏️ <b>System-Prompt</b>\n\nSende neuen Prompt."
      };
      const sent = await editOrSend(tg, String(userId), msgId, msgs[action] + "\n\n/cancel zum Abbrechen.", [[{ text: "❌ Abbrechen", callback_data: `cfg_back_${channelId}` }]]);
      const actionsMap = { sl_adduser: "safelist_add_user", sl_addscam: "scamlist_add_user", userinfo: "userinfo_awaiting", kb_add: "kb_add_entry", bl_add: "bl_add_word", bl_addsoft: "bl_add_soft", aw_new: "adwriter_new", st_prompt: "set_ai_prompt" };
      global.pendingInputs[String(userId)] = { action: actionsMap[action], channelId, aiOn: ch?.ai_enabled, freeMode: !ch?.ai_enabled, wizardMsgId: sent?.message_id || msgId };
      break;
    }
    case "repeat": {
      const { data: s } = await supabase_db.from("scheduled_messages").select("id, message, cron_expr, is_active").eq("channel_id", channelId).limit(20);
      // HTML-Klartext für Button-Labels: Tags entfernen, Emojis behalten
      const _safeLabel = (txt) => {
        if (!txt) return "(kein Text)";
        const plain = txt
          .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1") // Premium-Emoji → Fallback
          .replace(/<[^>]+>/g, "")                                  // alle anderen Tags
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/[\u0000-\u001F\uFE00-\uFE0F\u200B-\u200F\uFEFF]/g, "")
          .trim();
        return plain.substring(0, 35) || "(Medien)";
      };
      const kb = (s||[]).map(m => [{
        text: `${m.is_active?"✅":"⏸"} ${_safeLabel(m.message)}…`,
        callback_data: `cfg_rep_edit_${m.id}_${channelId}`
      }]);
      kb.unshift([{ text: "➕ Neue Nachricht", callback_data: `cfg_rep_new_${channelId}` }]);
      kb.push([_menuBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, "🔁 <b>Wiederholende Nachrichten</b>", kb);
      break;
    }
    case "rep_new": {
      // Startet den Sched-Wizard für eine neue Wiederholende Nachricht
      const sentNew = await editOrSend(tg, String(userId), msgId,
        `📝 <b>Neue Wiederholende Nachricht — Schritt 1/6: Text</b>\n\nSende den Nachrichtentext.\nOder überspringe für nur Medien:\n\n/cancel zum Abbrechen.`,
        [[{ text: "⏭ Nur Medien (kein Text)", callback_data: `cfg_skip_wiz_${channelId}` },
          { text: "❌ Abbrechen",             callback_data: `cfg_repeat_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "sched_wizard_text", channelId, wizardMsgId: sentNew?.message_id || msgId
      };
      break;
    }

    case "rep_edit": {
      const m = data.match(/^cfg_rep_edit_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!m) break;
      const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", m[1]).maybeSingle();
      if (!s) break;
      let intervalText = "Einmalig";
      if (s.interval_minutes) intervalText = s.interval_minutes >= 60 ? `alle ${s.interval_minutes/60} Stunden` : `alle ${s.interval_minutes} Minuten`;
      // Zeit-Bug Fix: explizit Europe/Berlin Timezone verwenden
      // (Render läuft auf UTC, toLocaleString ohne timeZone zeigte UTC-Zeit an → -2h Bug)
      const fmtDE = (iso) => new Date(iso).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      }) + " Uhr";
      const endText   = s.end_at ? fmtDE(s.end_at) : "Nie (Endlos)";
      const startText = s.next_run_at ? fmtDE(s.next_run_at) : "—";
      const hasMedia  = s.photo_file_id ? `✅ (${s.file_type || "Datei"})` : "❌ Kein Medium";
      const varCount  = s.variation_count || (s.variations?.length ? s.variations.length : 1);
      // HTML für Vorschau strippen damit keine Tag-Verschachtelung (→ 400)
      const _stripH = (h) => (h||"").replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g,"$1").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
      const previewMsg = _stripH(s.message);
      await editOrSend(tg, String(userId), msgId,
        `🔁 <b>Geplante Nachricht</b>\n\n` +
        `📝 Text: <i>${previewMsg.substring(0,80)}${previewMsg.length>80?"…":""}</i>\n` +
        `📎 Medien: ${hasMedia}\n` +
        `🔢 Varianten: ${varCount}\n` +
        `📅 Nächste Ausführung: ${startText}\n` +
        `🔁 Intervall: ${intervalText}\n` +
        `🛑 Enddatum: ${endText}\n` +
        `Status: ${s.is_active?"✅ Aktiv":"⏸ Pausiert"}`,
        [
          [{ text: "🧪 Test-Vorschau senden", callback_data: `cfg_rep_test_${m[1]}_${channelId}` }],
          [{ text: "✏️ Text bearbeiten",   callback_data: `cfg_rep_etext_${m[1]}_${channelId}` },
           { text: "📎 Medium ändern",     callback_data: `cfg_rep_emedia_${m[1]}_${channelId}` }],
          [{ text: "🖇 Buttons bearbeiten", callback_data: `cfg_rep_ebtns_${m[1]}_${channelId}` }],
          [{ text: "🏁 Enddatum ändern",    callback_data: `cfg_rep_eend_${m[1]}_${channelId}` }],
          [{ text: s.is_active ? "⏸ Pausieren" : "▶️ Aktivieren", callback_data: `cfg_rep_toggle_${m[1]}_${channelId}` }],
          [{ text: "🗑 Löschen",            callback_data: `cfg_rep_del_${m[1]}_${channelId}` }],
          [{ text: "◀️ Zurück",             callback_data: `cfg_repeat_${channelId}` }]
        ]
      );
      break;
    }

    case "rep_test": {
      // Sendet die wiederholende Nachricht als Vorschau in den PrivatChat des Admins.
      // Replikat der Logik aus tgAdminHelper.fireScheduled (Text/Foto/Video/Animation, Inline-Buttons).
      const mTest = data.match(/^cfg_rep_test_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mTest) break;
      const { data: sTest } = await supabase_db.from("scheduled_messages")
        .select("*").eq("id", mTest[1]).maybeSingle();
      if (!sTest) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Nachricht nicht gefunden", show_alert: true
        }).catch(()=>{});
        break;
      }

      // Variations-Rotation wie in fireScheduled — erste Variante zeigen
      let sendText = sTest.message || "";
      if (Array.isArray(sTest.variations) && sTest.variations.length > 0) {
        const idx = (sTest.variation_index || 0) % sTest.variations.length;
        sendText = sTest.variations[idx] || sendText;
      }
      // Inline-Buttons
      let replyMarkup = undefined;
      if (sTest.inline_buttons) {
        try {
          let parsed = typeof sTest.inline_buttons === "string"
            ? JSON.parse(sTest.inline_buttons)
            : sTest.inline_buttons;
          if (parsed && Array.isArray(parsed.inline_keyboard)) {
            const flatButtons = parsed.inline_keyboard.flat().filter(Boolean);
            const chunked = [];
            for (let i = 0; i < flatButtons.length; i += 2) {
              chunked.push(flatButtons.slice(i, i + 2));
            }
            parsed.inline_keyboard = chunked;
            replyMarkup = parsed;
          }
        } catch (_) {}
      }

      // Header-Banner vor der Vorschau senden
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🧪 <b>Vorschau</b> — so erscheint die Nachricht im Channel:`,
        parse_mode: "HTML"
      }).catch(()=>{});

      // Eigentliche Nachricht — gleiche Logik wie fireScheduled
      try {
        if (sTest.photo_file_id || sTest.photo_url) {
          const mediaId   = sTest.photo_file_id || sTest.photo_url;
          const mediaOpts = { caption: sendText, parse_mode: "HTML" };
          if (replyMarkup) mediaOpts.reply_markup = replyMarkup;
          if (sTest.file_type === "video") {
            await tg.call("sendVideo",     { chat_id: String(userId), video:     mediaId, ...mediaOpts });
          } else if (sTest.file_type === "animation") {
            await tg.call("sendAnimation", { chat_id: String(userId), animation: mediaId, ...mediaOpts });
          } else {
            await tg.call("sendPhoto",     { chat_id: String(userId), photo:     mediaId, ...mediaOpts });
          }
        } else {
          const txtOpts = { parse_mode: "HTML" };
          if (replyMarkup) txtOpts.reply_markup = replyMarkup;
          await tg.call("sendMessage", { chat_id: String(userId), text: sendText, ...txtOpts });
        }
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "✅ Vorschau gesendet"
        }).catch(()=>{});
      } catch (e) {
        const errMsg = e?.response?.data?.description || e.message;
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: `❌ Vorschau fehlgeschlagen: ${errMsg}`, show_alert: true
        }).catch(()=>{});
      }
      break;
    }
    case "rep_etext": {
      // Text bearbeiten
      const mT = data.match(/^cfg_rep_etext_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mT) break;
      const sentT = await editOrSend(tg, String(userId), msgId,
        `✏️ <b>Text bearbeiten</b>\n\nSende den neuen Text für diese Nachricht.\n\n/cancel zum Abbrechen.`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_rep_edit_${mT[1]}_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "rep_edit_text", channelId, schedId: mT[1], wizardMsgId: sentT?.message_id || msgId
      };
      break;
    }
    case "rep_emedia": {
      // Medium ändern
      const mM = data.match(/^cfg_rep_emedia_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mM) break;
      const sentM = await editOrSend(tg, String(userId), msgId,
        `📎 <b>Medium ändern</b>\n\nSende ein Foto, GIF oder Video.\nOder überspringe um das Medium zu entfernen.\n\n/cancel zum Abbrechen.`,
        [[{ text: "🗑 Medium entfernen", callback_data: `cfg_rep_emedia_del_${mM[1]}_${channelId}` }],
         [{ text: "❌ Abbrechen", callback_data: `cfg_rep_edit_${mM[1]}_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "rep_edit_media", channelId, schedId: mM[1], wizardMsgId: sentM?.message_id || msgId
      };
      break;
    }
    case "rep_emedia_del": {
      // Medium löschen
      const mMD = data.match(/^cfg_rep_emedia_del_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mMD) break;
      await supabase_db.from("scheduled_messages").update({ photo_file_id: null, file_type: null }).eq("id", mMD[1]);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "🗑 Medium entfernt." }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_rep_edit_${mMD[1]}_${channelId}`, q, userId);
      break;
    }
    case "rep_ebtns": {
      // Buttons bearbeiten
      const mB = data.match(/^cfg_rep_ebtns_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mB) break;
      const sentB = await editOrSend(tg, String(userId), msgId,
        `🖇 <b>Buttons bearbeiten</b>\n\nSende Buttons im Format:\n<code>Button Text | https://link.de</code>\n<code>Button 2 | https://link2.de</code>\n\nJede Zeile = ein Button. /skip zum Entfernen aller Buttons.\n\n/cancel zum Abbrechen.`,
        [[{ text: "🗑 Alle Buttons entfernen", callback_data: `cfg_rep_ebtns_del_${mB[1]}_${channelId}` }],
         [{ text: "❌ Abbrechen", callback_data: `cfg_rep_edit_${mB[1]}_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "rep_edit_btns", channelId, schedId: mB[1], wizardMsgId: sentB?.message_id || msgId
      };
      break;
    }
    case "rep_ebtns_del": {
      const mBD = data.match(/^cfg_rep_ebtns_del_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mBD) break;
      await supabase_db.from("scheduled_messages").update({ inline_buttons: null }).eq("id", mBD[1]);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "🗑 Buttons entfernt." }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_rep_edit_${mBD[1]}_${channelId}`, q, userId);
      break;
    }
    case "rep_eend": {
      // Enddatum nachträglich anpassen
      const mE = data.match(/^cfg_rep_eend_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mE) break;
      const { data: s } = await supabase_db.from("scheduled_messages")
        .select("end_at").eq("id", mE[1]).maybeSingle();
      const curEnd = s?.end_at
        ? new Date(s.end_at).toLocaleString("de-DE", {
            timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit",
            year: "numeric", hour: "2-digit", minute: "2-digit"
          }) + " Uhr"
        : "Nie (Endlos)";
      const sentE = await editOrSend(tg, String(userId), msgId,
        `🏁 <b>Enddatum ändern</b>\n\n` +
        `Aktuelles Enddatum: <b>${curEnd}</b>\n\n` +
        `Sende das neue Enddatum im Format:\n` +
        `   <code>TT.MM.JJJJ HH:MM</code>  (z.B. <code>31.12.2026 23:59</code>)\n` +
        `   <code>TT.MM.JJJJ</code>  (z.B. <code>31.12.2026</code> → 23:59 Uhr)\n\n` +
        `Relativ:\n` +
        `   <code>+7d</code> = in 7 Tagen   <code>+2w</code> = in 2 Wochen   <code>+1m</code> = in 1 Monat\n\n` +
        `<i>Sende <code>/clear</code> um das Enddatum zu entfernen (Endlos-Modus).</i>`,
        [[{ text: "🗑 Endlos (kein Enddatum)", callback_data: `cfg_rep_eend_clear_${mE[1]}_${channelId}` }],
         [{ text: "❌ Abbrechen", callback_data: `cfg_rep_edit_${mE[1]}_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "rep_edit_enddate", channelId, schedId: mE[1],
        wizardMsgId: sentE?.message_id || msgId
      };
      break;
    }
    case "rep_eend_clear": {
      const mEC = data.match(/^cfg_rep_eend_clear_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!mEC) break;
      try {
        await supabase_db.from("scheduled_messages").update({ end_at: null }).eq("id", mEC[1]);
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "🗑 Enddatum entfernt — läuft jetzt endlos."
        }).catch(()=>{});
      } catch (e) {
        logger.warn(`[rep_eend_clear] ${e.message}`);
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: `❌ Fehler: ${String(e.message).substring(0,80)}`, show_alert: true
        }).catch(()=>{});
      }
      delete global.pendingInputs[String(userId)];
      handleSettingsCallback(tg, supabase_db, `cfg_rep_edit_${mEC[1]}_${channelId}`, q, userId);
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
      const rawM = ch?.smalltalk_model || ch?.ai_model || "autoacts-fast";
      const _nm = String(rawM).toLowerCase();
      const smLabel = _nm.indexOf("grok") === 0                                 ? "Grok AI (×1.5)"
                    : (_nm === "openai" || _nm.indexOf("gpt-") === 0)           ? "OpenAI (×1.2)"
                    : (_nm === "autoacts-think" || _nm === "deepseek-reasoner") ? "AutoActsAi Think (×1.25)"
                    :                                                            "AutoActsAi Fast (×1.0)";
      await editOrSend(tg, String(userId), msgId, `💬 <b>Smalltalk</b>\n\nAktuelles Modell: <b>${smLabel}</b>`, [
        [{ text: "✏️ System-Prompt",  callback_data: `cfg_st_prompt_${channelId}` }],
        [{ text: "🔄 Modell wechseln", callback_data: `cfg_st_selector_${channelId}` }],
        [_aiBackBtn(channelId, lang)]
      ]);
      break;
    }
    case "st_selector": {
      // 4-Wege-Modellauswahl (v2.0.2)
      if (!ch?.ai_enabled) break;
      const cur = String(ch?.smalltalk_model || ch?.ai_model || "autoacts-fast").toLowerCase();
      const isGrok   = cur.indexOf("grok") === 0;
      const isOpenAI = cur === "openai" || cur.indexOf("gpt-") === 0;
      const isThink  = cur === "autoacts-think" || cur === "deepseek-reasoner";
      const isFast   = !isGrok && !isOpenAI && !isThink;
      await editOrSend(tg, String(userId), msgId,
        `💬 <b>Modell wählen</b>\n\nDer Multiplikator bestimmt den Credit-Verbrauch pro Antwort.\n\nAktuell: <b>${
          isGrok ? "Grok AI (×1.5)" : isOpenAI ? "OpenAI (×1.2)" : isThink ? "AutoActsAi Think (×1.25)" : "AutoActsAi Fast (×1.0)"}</b>`,
        [
          [{ text: (isFast   ? "✅ " : "🔘 ") + "AutoActsAi Fast (×1.0)",   callback_data: `cfg_st_setmodel_fast_${channelId}` }],
          [{ text: (isThink  ? "✅ " : "🔘 ") + "AutoActsAi Think (×1.25)", callback_data: `cfg_st_setmodel_think_${channelId}` }],
          [{ text: (isOpenAI ? "✅ " : "🔘 ") + "OpenAI (×1.2)",            callback_data: `cfg_st_setmodel_openai_${channelId}` }],
          [{ text: (isGrok   ? "✅ " : "🔘 ") + "Grok AI (×1.5)",           callback_data: `cfg_st_setmodel_grok_${channelId}` }],
          [{ text: "◀️ Zurück",  callback_data: `cfg_smalltalk_${channelId}` }]
        ]
      );
      break;
    }
    case "st_setmodel": {
      const m = data.match(/^cfg_st_setmodel_(fast|think|openai|grok)_(-?\d+)$/);
      if (!m) break;
      const variant  = m[1];
      const newModel = variant === "think"  ? "autoacts-think"
                     : variant === "openai" ? "openai"
                     : variant === "grok"   ? "grok"
                     :                        "autoacts-fast";
      await supabase_db.from("bot_channels")
        .update({ smalltalk_model: newModel, ai_model: newModel }).eq("id", channelId);
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Modell gespeichert" }).catch(() => {});
      handleSettingsCallback(tg, supabase_db, `cfg_st_selector_${channelId}`, q, userId);
      break;
    }
    // Legacy-Toggle (Backwards-Compat)
    case "st_model": {
      handleSettingsCallback(tg, supabase_db, `cfg_st_selector_${channelId}`, q, userId);
      break;
    }
    case "daily": {
      if (!ch?.ai_enabled) break;
      await editOrSend(tg, String(userId), msgId, `📰 <b>Tagesbericht</b>`, [
        [{ text: "📰 Jetzt erstellen", callback_data: `cfg_daily_now_${channelId}` }],
        [_aiBackBtn(channelId, lang)]
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
      // ── Spiele-Auswahl-Menü ────────────────────────────────────────────────
      // Activity Tracker und Diss Battle können einzeln ODER gleichzeitig aktiv sein.
      const activityEnabled = !!ch?.group_game_enabled;
      const dissEnabled     = !!ch?.diss_battle_enabled;

      await editOrSend(tg, String(userId), msgId,
        `🎮 <b>Gruppenspiele</b>\n\n` +
        `Wähle ein Spiel zur Verwaltung aus.\n\n` +
        `<i>Hinweis: Activity Tracker und Diss Battle können parallel aktiv sein.</i>`,
        [
          [{ text: `🎯 Activity Tracker ${activityEnabled ? "🟢" : "⚫"}`,
             callback_data: `cfg_groupgames_activity_${channelId}` }],
          [{ text: `⚔️ Diss Battle ${dissEnabled ? "🟢" : "⚫"}`,
             callback_data: `cfg_groupgames_diss_${channelId}` }],
          [_aiBackBtn(channelId, lang)]
        ]
      );
      break;
    }

    // ── Diss Battle ─────────────────────────────────────────────────────────
    case "groupgames_diss": {
      const enabled  = !!ch?.diss_battle_enabled;
      const dur      = ch?.diss_battle_duration_min || 5;
      const arenaId  = ch?.diss_battle_arena_chat_id;

      // Total Battles und Spieler
      let totalBattles = 0, topPlayers = 0;
      try {
        const r1 = await supabase_db.from("channel_diss_battles")
          .select("id", { count: "exact", head: true })
          .eq("channel_id", channelId);
        totalBattles = r1.count || 0;
        const r2 = await supabase_db.from("channel_diss_scores")
          .select("id", { count: "exact", head: true })
          .eq("channel_id", channelId).gt("score", 0);
        topPlayers = r2.count || 0;
      } catch (_) {}

      const txt =
        `⚔️ <b>Diss Battle</b> — ${_escapeHtml(ch?.title || channelId)}\n\n` +
        `<b>Status:</b> ${enabled ? "🟢 Aktiv" : "⚫ Inaktiv"}\n` +
        `<b>Battle-Dauer:</b> ${dur} Minuten\n` +
        `<b>Arena-Gruppe:</b> ${arenaId ? `<code>${_escapeHtml(arenaId)}</code> ✅` : "❌ <i>Nicht konfiguriert</i>"}\n\n` +
        `<b>📊 Statistik:</b>\n` +
        `• Battles insgesamt: ${totalBattles}\n` +
        `• Spieler im Ranking: ${topPlayers}\n\n` +
        `<i>Spieler nutzen <code>/dissbattle</code> bzw. <code>/dissbattle @user</code> ` +
        `um ein Battle zu eröffnen. Ranking via <code>/topdiss</code>.</i>`;

      const kb = [
        [{ text: enabled ? "⏸ Deaktivieren" : "▶️ Aktivieren",
           callback_data: `cfg_groupgames_diss_toggle_${channelId}` }],
        [{ text: `⏱ Dauer: ${dur === 5 ? "✅ " : "    "}5 Min`,  callback_data: `cfg_groupgames_diss_dur_5_${channelId}` },
         { text: `${dur === 10 ? "✅ " : "    "}10 Min`,        callback_data: `cfg_groupgames_diss_dur_10_${channelId}` },
         { text: `${dur === 15 ? "✅ " : "    "}15 Min`,        callback_data: `cfg_groupgames_diss_dur_15_${channelId}` }]
      ];
      if (arenaId) {
        kb.push([{ text: "🗑 Arena entfernen", callback_data: `cfg_groupgames_diss_arena_clear_${channelId}` }]);
      } else {
        kb.push([{ text: "🔗 Arena-Gruppe verlinken", callback_data: `cfg_groupgames_diss_arena_${channelId}` }]);
      }
      kb.push([{ text: "🏆 Aktuelles Ranking ansehen", callback_data: `cfg_groupgames_diss_ranking_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück zu Gruppenspielen", callback_data: `cfg_groupgames_${channelId}` }]);

      await editOrSend(tg, String(userId), msgId, txt, kb);
      break;
    }

    case "groupgames_diss_toggle": {
      const newVal = !ch?.diss_battle_enabled;
      // Warnung wenn aktiviert wird ohne Arena
      if (newVal && !ch?.diss_battle_arena_chat_id) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id,
          text: "⚠️ Bitte verlinke zuerst eine Arena-Gruppe.",
          show_alert: true
        }).catch(() => {});
        handleSettingsCallback(tg, supabase_db, `cfg_groupgames_diss_${channelId}`, q, userId);
        break;
      }
      await supabase_db.from("bot_channels").update({ diss_battle_enabled: newVal }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: newVal ? "✅ Diss Battle aktiviert" : "⏸ Deaktiviert"
      }).catch(() => {});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_diss_${channelId}`, q, userId);
      break;
    }

    case "groupgames_diss_dur": {
      const newDur = parseInt(parts[4]) || 5;
      if (![5, 10, 15].includes(newDur)) break;
      await supabase_db.from("bot_channels").update({ diss_battle_duration_min: newDur }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: `⏱ Dauer auf ${newDur} Min gesetzt`
      }).catch(() => {});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_diss_${channelId}`, q, userId);
      break;
    }

    case "groupgames_diss_arena": {
      // Wizard öffnen: Channel-Admin soll Chat-ID der Arena einsenden
      const sent = await editOrSend(tg, String(userId), msgId,
        `🔗 <b>Arena-Gruppe verlinken</b>\n\n` +
        `So richtest du eine Battle-Arena ein:\n\n` +
        `<b>1.</b> Erstelle eine neue Telegram-Gruppe (eigene, separat vom Channel).\n` +
        `<b>2.</b> Füge mich (den Bot) als <b>Admin</b> hinzu mit den Rechten:\n` +
        `   • <i>Mitglieder einladen</i>\n` +
        `   • <i>Mitglieder einschränken/bannen</i>\n` +
        `   • <i>Nachrichten senden</i>\n` +
        `<b>3.</b> Setze die Standard-Gruppen-Permissions auf <b>"Nachrichten senden = AUS"</b> ` +
        `(über Telegram-Gruppen-Einstellungen → Berechtigungen).\n` +
        `<b>4.</b> Sende mir hier die <b>Chat-ID</b> der Arena (z.B. <code>-1001234567890</code>).\n\n` +
        `<i>Tipp: Die Chat-ID findest du indem du in der Arena <code>/id</code> tippst — ich antworte mit der ID.</i>`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_groupgames_diss_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "diss_arena_set", channelId,
        wizardMsgId: sent?.message_id || msgId
      };
      break;
    }

    case "groupgames_diss_arena_clear": {
      await supabase_db.from("bot_channels").update({
        diss_battle_arena_chat_id: null,
        diss_battle_enabled: false
      }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id, text: "🗑 Arena entfernt + Feature deaktiviert"
      }).catch(() => {});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_diss_${channelId}`, q, userId);
      break;
    }

    case "groupgames_diss_ranking": {
      const { data: top } = await supabase_db.from("channel_diss_scores")
        .select("user_id, username, wins, losses, score")
        .eq("channel_id", channelId)
        .gt("score", 0)
        .order("score", { ascending: false })
        .limit(10);

      let txt = `🏆 <b>Diss Battle — Top 10</b>\n\n`;
      if (!top?.length) {
        txt += `<i>Noch keine gewerteten Battles.</i>`;
      } else {
        txt += top.map((r, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
          const handle = r.username ? "@" + _escapeHtml(r.username) : `User ${r.user_id}`;
          return `${medal} ${handle} — <b>${r.score}</b> (${r.wins}W / ${r.losses}L)`;
        }).join("\n");
      }
      await editOrSend(tg, String(userId), msgId, txt,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
      break;
    }

    case "groupgames_activity": {
      // ── Activity Tracker Verwaltung ────────────────────────────────────────
      const enabled = !!ch?.group_game_enabled;
      let participantCount = 0;
      try {
        const { count } = await supabase_db.from("channel_user_points")
          .select("user_id", { count: "exact", head: true })
          .eq("channel_id", channelId);
        participantCount = count || 0;
      } catch (_) {}

      // Hilfs-Formatter (Europe/Berlin)
      const fmtDateBerlin = (iso) => new Date(iso).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      }) + " Uhr";

      const intervalH = parseInt(ch?.activity_ranking_interval_hours) || 0;
      const autoPostText = intervalH > 0
        ? (intervalH < 24
            ? `alle ${intervalH}h`
            : (intervalH === 24 ? "täglich" : (intervalH === 168 ? "wöchentlich" : `alle ${intervalH/24} Tage`)))
        : "aus";

      let periodText = "kein Zeitraum (läuft unbefristet)";
      if (ch?.activity_game_starts_at || ch?.activity_game_ends_at) {
        const s = ch?.activity_game_starts_at ? fmtDateBerlin(ch.activity_game_starts_at) : "—";
        const e = ch?.activity_game_ends_at   ? fmtDateBerlin(ch.activity_game_ends_at)   : "endlos";
        periodText = `${s} → ${e}`;
      }

      const stateLine = enabled ? `Status: <b>🟢 Aktiv</b>` : `Status: <b>⚫ Inaktiv</b>`;
      const partLine = (enabled && participantCount > 0)
        ? `\nAktive Teilnehmer: <b>${participantCount}</b>` : "";

      // Globale Lerncache-Statistik (kanalübergreifend) — sichtbar wenn aktiviert
      let cacheLine = "";
      if (enabled) {
        try {
          const stats = await groupGameService.getClassificationStats(supabase_db);
          if (stats.totalEntries > 0) {
            const pct = Math.round(stats.savedRatio * 100);
            cacheLine = `\n💾 AI-Lerncache: <b>${stats.totalEntries.toLocaleString("de-DE")}</b> Einträge, ` +
                        `<b>${stats.totalHits.toLocaleString("de-DE")}</b> Treffer (${pct}% gespart)`;
          }
        } catch (_) {}
      }

      const buttons = [];
      buttons.push([{
        text: enabled ? "⏸ Spiel deaktivieren" : "▶️ Spiel aktivieren",
        callback_data: `cfg_groupgames_activity_toggle_${channelId}`
      }]);
      if (enabled) {
        buttons.push([{ text: "🏆 Aktuelle Rangliste",
                        callback_data: `cfg_groupgames_activity_ranking_${channelId}` }]);
        buttons.push([{ text: `📅 Auto-Posting (${autoPostText})`,
                        callback_data: `cfg_groupgames_activity_autopost_${channelId}` }]);
        buttons.push([{ text: "⏳ Zeitraum festlegen",
                        callback_data: `cfg_groupgames_activity_period_${channelId}` }]);
        buttons.push([{ text: "✨ Powered-By Schriftzug",
                        callback_data: `cfg_groupgames_activity_powered_${channelId}` }]);
      }
      if (enabled && participantCount > 0) {
        buttons.push([{ text: "👥 Spieler verwalten",
                        callback_data: `cfg_ggap_${channelId}` }]);
        buttons.push([{ text: "🔄 Ranking zurücksetzen",
                        callback_data: `cfg_groupgames_activity_reset_${channelId}` }]);
      }
      buttons.push([{ text: "◀️ Zurück zu Gruppenspiele",
                      callback_data: `cfg_groupgames_${channelId}` }]);

      await editOrSend(tg, String(userId), msgId,
        `🎯 <b>Activity Tracker</b>\n\n` +
        `${stateLine}${partLine}\n` +
        `📅 Auto-Posting: <b>${autoPostText}</b>\n` +
        `⏳ Zeitraum: <i>${periodText}</i>${cacheLine}\n\n` +
        `<b>Punkte-System:</b>\n` +
        `• Qualitäts-Nachricht (≥ 50 Zeichen): <b>+3</b>\n` +
        `• Kurze Nachricht / Smalltalk: <b>+1</b>\n` +
        `• Antwort auf einen Admin: mindestens <b>+2</b>\n\n` +
        `<i>🤖 Jede Nachricht wird von Grok-AI auf Echtheit geprüft. ` +
        `Nonsense (Emoji-Spam, sinnlose Zeichen) erhält 0 Punkte.</i>\n` +
        `<i>💡 Wiederholte Nachrichten kommen aus dem globalen Lerncache (kostenlos). ` +
        `Bei neuen Nachrichten werden Input + Output mit Faktor <b>×1.0</b> als Credits abgerechnet ` +
        `(typisch 100–200 Credits pro Klassifikation).</i>\n\n` +
        `<i>Admins ausgeschlossen. Cooldown: 30s pro User. ` +
        `Mitglieder tippen <code>/top</code> für die Rangliste.</i>`,
        buttons
      );
      break;
    }

    case "groupgames_activity_ranking": {
      // Vorschau der aktuellen Rangliste in der PM
      const top = await groupGameService.getTopList(tg, supabase_db, channelId, 10);
      let text;
      if (!top.length) {
        text = "🏆 <b>Aktuelle Rangliste</b>\n\nNoch keine Punkte gesammelt.";
      } else {
        const lines = top.map((u, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `<b>${i+1}.</b>`;
          const name  = groupGameService.formatUserName(u);
          return `${medal} ${name} — <b>${u.points}</b> Punkte`;
        }).join("\n");
        text = `🏆 <b>Aktuelle Rangliste</b>\n\n${lines}`;
      }
      await editOrSend(tg, String(userId), msgId, text, [
        [{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]
      ]);
      break;
    }

    case "groupgames_activity_autopost": {
      // Intervall-Auswahl
      const current = parseInt(ch?.activity_ranking_interval_hours) || 0;
      const opts = [
        { hours: 0,   label: "🚫 Aus" },
        { hours: 6,   label: "⏰ Alle 6 Stunden" },
        { hours: 12,  label: "⏰ Alle 12 Stunden" },
        { hours: 24,  label: "📅 Täglich" },
        { hours: 72,  label: "📅 Alle 3 Tage" },
        { hours: 168, label: "📅 Wöchentlich" }
      ];
      const buttons = opts.map(o => [{
        text: (o.hours === current ? "✅ " : "") + o.label,
        callback_data: `cfg_groupgames_activity_autopost_set_${o.hours}_${channelId}`
      }]);
      buttons.push([{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]);
      await editOrSend(tg, String(userId), msgId,
        `📅 <b>Rangliste automatisch posten</b>\n\n` +
        `Wie oft soll der Bot die aktuelle Rangliste im Channel posten?`,
        buttons);
      break;
    }

    case "groupgames_activity_autopost_set": {
      // cfg_groupgames_activity_autopost_set_<hours>_<chanId>
      const mAP = data.match(/^cfg_groupgames_activity_autopost_set_(\d+)_(-?\d+)$/);
      if (!mAP) break;
      const hours = parseInt(mAP[1]);
      try {
        await supabase_db.from("bot_channels").update({
          activity_ranking_interval_hours: hours > 0 ? hours : null,
          activity_last_auto_ranking_at: hours > 0 ? new Date() : null
        }).eq("id", channelId);
      } catch (_) {}
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: hours > 0 ? `✅ Auto-Posting alle ${hours}h aktiviert` : "🚫 Auto-Posting deaktiviert"
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_${channelId}`, q, userId);
      break;
    }

    case "groupgames_activity_period": {
      const fmtDateBerlin = (iso) => new Date(iso).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      }) + " Uhr";
      const startTxt = ch?.activity_game_starts_at ? fmtDateBerlin(ch.activity_game_starts_at) : "<i>nicht gesetzt</i>";
      const endTxt   = ch?.activity_game_ends_at   ? fmtDateBerlin(ch.activity_game_ends_at)   : "<i>nicht gesetzt</i>";

      const buttons = [
        [{ text: "🚀 Startdatum setzen",  callback_data: `cfg_groupgames_activity_period_setstart_${channelId}` }],
        [{ text: "🏁 Enddatum setzen",     callback_data: `cfg_groupgames_activity_period_setend_${channelId}` }]
      ];
      if (ch?.activity_game_starts_at || ch?.activity_game_ends_at) {
        buttons.push([{ text: "🗑 Zeitraum löschen", callback_data: `cfg_groupgames_activity_period_clear_${channelId}` }]);
      }
      buttons.push([{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]);

      await editOrSend(tg, String(userId), msgId,
        `⏳ <b>Spielzeitraum festlegen</b>\n\n` +
        `🚀 Start: ${startTxt}\n` +
        `🏁 Ende:  ${endTxt}\n\n` +
        `Wenn das Enddatum erreicht wird, postet der Bot automatisch eine ` +
        `<b>finale Rangliste</b> im Channel und deaktiviert das Spiel.\n\n` +
        `<i>Ohne Zeitraum läuft das Spiel unbefristet.</i>`,
        buttons);
      break;
    }

    case "groupgames_activity_period_setstart":
    case "groupgames_activity_period_setend": {
      const isStart = action === "groupgames_activity_period_setstart";
      const label   = isStart ? "🚀 <b>Startdatum</b>" : "🏁 <b>Enddatum</b>";
      const dbField = isStart ? "activity_game_starts_at" : "activity_game_ends_at";

      const sentP = await editOrSend(tg, String(userId), msgId,
        `${label}\n\nSende das Datum im Format <code>DD.MM.YYYY HH:MM</code>\n` +
        `(Europe/Berlin Zeitzone)\n\nBeispiel: <code>31.12.2026 23:59</code>\n\n` +
        `/cancel zum Abbrechen.`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "activity_period_set",
        channelId,
        dbField,
        wizardMsgId: sentP?.message_id || msgId
      };
      break;
    }

    case "groupgames_activity_period_clear": {
      try {
        await supabase_db.from("bot_channels").update({
          activity_game_starts_at: null,
          activity_game_ends_at:   null,
          activity_final_ranking_posted: false
          // started_posted bleibt: das Spiel läuft ja weiter, Mitteilung wurde schon gepostet
        }).eq("id", channelId);
      } catch (_) {}
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id, text: "🗑 Zeitraum gelöscht"
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_period_${channelId}`, q, userId);
      break;
    }

    case "groupgames_activity_toggle": {
      // Wenn AKTIV → einfach deaktivieren
      if (ch?.group_game_enabled) {
        try {
          await supabase_db.from("bot_channels")
            .update({
              group_game_enabled: false,
              activity_game_started_posted: false  // Reset für nächste Aktivierung
            })
            .eq("id", channelId);
        } catch (e) {
          await tg.call("answerCallbackQuery", {
            callback_query_id: q.id, text: "❌ Fehler beim Speichern", show_alert: true
          }).catch(()=>{});
          break;
        }
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "⏸ Activity Tracker deaktiviert"
        }).catch(()=>{});
        const refreshed = await getChannel(channelId);
        if (ch) ch.group_game_enabled = refreshed?.group_game_enabled;
        handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_${channelId}`, q, userId);
        break;
      }

      // Wenn INAKTIV → Activation-Menü (Zeitraum wählen)
      await editOrSend(tg, String(userId), msgId,
        `▶️ <b>Activity Tracker aktivieren</b>\n\n` +
        `Möchtest du einen Spielzeitraum festlegen?\n\n` +
        `<b>♾ Ohne Enddatum</b>\n` +
        `   Das Spiel läuft unbefristet, bis du es manuell beendest.\n\n` +
        `<b>⏰ Mit Enddatum</b>\n` +
        `   Bei Erreichen des Enddatums postet der Bot automatisch eine ` +
        `<b>finale Rangliste</b> und beendet das Spiel.`,
        [
          [{ text: "♾ Ohne Enddatum (sofort starten)",
             callback_data: `cfg_groupgames_activity_act_now_${channelId}` }],
          [{ text: "⏰ Mit Enddatum",
             callback_data: `cfg_groupgames_activity_act_end_${channelId}` }],
          [{ text: "❌ Abbrechen",
             callback_data: `cfg_groupgames_activity_${channelId}` }]
        ]
      );
      break;
    }

    case "groupgames_activity_act_now": {
      // Sofort aktivieren ohne Enddatum
      try {
        await supabase_db.from("bot_channels")
          .update({
            group_game_enabled:           true,
            activity_game_started_posted: false,  // Scheduler postet sofort
            activity_final_ranking_posted: false
          })
          .eq("id", channelId);
      } catch (e) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Fehler: " + e.message, show_alert: true
        }).catch(()=>{});
        break;
      }

      // Sofort Start-Mitteilung posten (statt auf Scheduler zu warten)
      try {
        const { data: chRefresh } = await supabase_db.from("bot_channels")
          .select("activity_game_ends_at, activity_powered_by").eq("id", channelId).maybeSingle();
        await groupGameService.postGameStartMessage(tg, supabase_db, channelId, chRefresh);
        await supabase_db.from("bot_channels")
          .update({ activity_game_started_posted: true })
          .eq("id", channelId);
      } catch (_) {}

      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id, text: "✅ Spiel gestartet — Mitteilung im Channel"
      }).catch(()=>{});
      const refreshed = await getChannel(channelId);
      if (ch) ch.group_game_enabled = refreshed?.group_game_enabled;
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_${channelId}`, q, userId);
      break;
    }

    case "groupgames_activity_act_end": {
      // Wizard öffnen für Enddatum-Eingabe (mit Aktivierung danach)
      const sentAE = await editOrSend(tg, String(userId), msgId,
        `⏰ <b>Mit Enddatum starten</b>\n\n` +
        `Wann soll das Spiel enden?\n\n` +
        `<b>Schnelle Eingabe (Tage):</b>\n` +
        `   <code>7d</code> = +7 Tage\n` +
        `   <code>14d</code> = +14 Tage\n` +
        `   <code>30d</code> = +30 Tage\n` +
        `   <code>90d</code> = +90 Tage\n\n` +
        `<b>Exaktes Datum:</b>\n` +
        `   <code>DD.MM.YYYY HH:MM</code>\n` +
        `   Beispiel: <code>31.12.2026 23:59</code>\n\n` +
        `<i>Europe/Berlin Zeitzone. /cancel zum Abbrechen.</i>`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_groupgames_activity_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "activity_activate_with_end",
        channelId,
        wizardMsgId: sentAE?.message_id || msgId
      };
      break;
    }

    case "groupgames_activity_reset": {
      await editOrSend(tg, String(userId), msgId,
        `🔄 <b>Activity Tracker — Ranking zurücksetzen?</b>\n\n` +
        `Alle Punkte aller Mitglieder werden <b>unwiderruflich gelöscht</b>.\n` +
        `Das Spiel bleibt aktiv und sammelt ab sofort neue Punkte.`,
        [
          [{ text: "✅ Ja, zurücksetzen",
             callback_data: `cfg_groupgames_activity_reset_confirm_${channelId}` }],
          [{ text: "❌ Abbrechen",
             callback_data: `cfg_groupgames_activity_${channelId}` }]
        ]
      );
      break;
    }

    case "groupgames_activity_reset_confirm": {
      const ok = await groupGameService.resetChannelPoints(supabase_db, channelId);
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: ok ? "✅ Ranking zurückgesetzt!" : "❌ Fehler beim Zurücksetzen",
        show_alert: ok ? false : true
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_${channelId}`, q, userId);
      break;
    }

    // ═══ Activity Tracker — Powered-By Schriftzug ═══════════════════════════
    case "groupgames_activity_powered": {
      const current = ch?.activity_powered_by;
      const preview = current
        ? `Aktuell: <b>✨ ${String(current).substring(0, 100)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>`
        : `Aktuell: <i>kein Schriftzug</i>`;

      const sentP = await editOrSend(tg, String(userId), msgId,
        `✨ <b>Powered-By Schriftzug</b>\n\n${preview}\n\n` +
        `Sende einen Text der unter <b>allen</b> Spiel-Outputs angezeigt wird:\n` +
        `• 🎮 Spielstart-Mitteilung\n` +
        `• 🏆 Auto-Posting Rangliste\n` +
        `• 🏆 Final-Ranking bei Spielende\n` +
        `• <code>/top</code>-Befehl\n\n` +
        `<b>Beispiele:</b>\n` +
        `   <code>Powered by ValueShop25</code>\n` +
        `   <code>Preise gesponsert von XYZ Inc.</code>\n` +
        `   <code>Mit freundlicher Unterstützung von ABC</code>\n\n` +
        `<i>Max. 100 Zeichen. Sende <code>/clear</code> zum Entfernen.</i>`,
        [
          current ? [{ text: "🗑 Schriftzug entfernen",
                       callback_data: `cfg_groupgames_activity_powered_clear_${channelId}` }] : null,
          [{ text: "❌ Abbrechen",
             callback_data: `cfg_groupgames_activity_${channelId}` }]
        ].filter(Boolean)
      );
      global.pendingInputs[String(userId)] = {
        action: "activity_powered_set",
        channelId,
        wizardMsgId: sentP?.message_id || msgId
      };
      break;
    }

    case "groupgames_activity_powered_clear": {
      try {
        await supabase_db.from("bot_channels")
          .update({ activity_powered_by: null })
          .eq("id", channelId);
      } catch (_) {}
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id, text: "🗑 Powered-By Schriftzug entfernt"
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_groupgames_activity_${channelId}`, q, userId);
      break;
    }

    // ═══ Activity Tracker — Spielerverwaltung (ggap_*) ══════════════════════
    case "ggap_list":
    case "ggap_page": {
      let page = 1;
      if (action === "ggap_page") {
        const mPg = data.match(/^cfg_ggap_p_(\d+)_(-?\d+)$/);
        if (mPg) page = parseInt(mPg[1]);
      }
      const PAGE_SIZE = 10;
      const allPlayers = await groupGameService.getAllPlayers(tg, supabase_db, channelId);
      const total = allPlayers.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      page = Math.max(1, Math.min(totalPages, page));
      const offset = (page - 1) * PAGE_SIZE;
      const pageItems = allPlayers.slice(offset, offset + PAGE_SIZE);

      const headerLine = total === 0
        ? `<i>Noch keine Spieler im Ranking.</i>`
        : `Wähle einen Spieler zum Bearbeiten:`;

      const playerButtons = pageItems.map((u, idx) => {
        const globalRank = offset + idx + 1;
        const medal = globalRank === 1 ? "🥇" : globalRank === 2 ? "🥈" : globalRank === 3 ? "🥉" : `${globalRank}.`;
        const name  = groupGameService.formatUserName(u);
        const cleanName = name.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        const truncName = cleanName.length > 22 ? cleanName.substring(0, 22) + "…" : cleanName;
        return [{
          text: `${medal} ${truncName} — ${u.points} P.`,
          callback_data: `cfg_ggap_e_${u.user_id}_${channelId}`
        }];
      });

      const navRow = [];
      if (page > 1)         navRow.push({ text: "◀️ Vorherige", callback_data: `cfg_ggap_p_${page-1}_${channelId}` });
      if (totalPages > 1)   navRow.push({ text: `📄 ${page}/${totalPages}`, callback_data: `cfg_ggap_${channelId}` });
      if (page < totalPages) navRow.push({ text: "▶️ Nächste", callback_data: `cfg_ggap_p_${page+1}_${channelId}` });

      const allButtons = [...playerButtons];
      if (navRow.length) allButtons.push(navRow);
      allButtons.push([{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]);

      await editOrSend(tg, String(userId), msgId,
        `👥 <b>Spielerverwaltung</b>` +
        (total > 0 ? ` <i>(${total} Spieler)</i>` : "") +
        `\n\n${headerLine}`,
        allButtons
      );
      break;
    }

    case "ggap_edit": {
      const mE = data.match(/^cfg_ggap_e_(\d+)_(-?\d+)$/);
      if (!mE) break;
      const playerUserId = mE[1];

      const player = await groupGameService.getPlayer(supabase_db, channelId, playerUserId);
      if (!player) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Spieler nicht mehr im Ranking", show_alert: true
        }).catch(()=>{});
        handleSettingsCallback(tg, supabase_db, `cfg_ggap_${channelId}`, q, userId);
        break;
      }

      const fmtRel = (iso) => {
        if (!iso) return "—";
        const diff = Date.now() - new Date(iso).getTime();
        if (diff < 60_000) return "gerade eben";
        if (diff < 3600_000) return `vor ${Math.floor(diff/60_000)} Min`;
        if (diff < 86400_000) return `vor ${Math.floor(diff/3600_000)} Std`;
        return `vor ${Math.floor(diff/86400_000)} ${Math.floor(diff/86400_000) === 1 ? "Tag" : "Tagen"}`;
      };
      const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("de-DE", {
        timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric"
      }) : "—";

      const name = groupGameService.formatUserName(player);
      await editOrSend(tg, String(userId), msgId,
        `👤 <b>${name}</b>\n` +
        `🆔 <code>${player.user_id}</code>\n\n` +
        `💎 Punkte: <b>${player.points}</b>\n` +
        `💬 Nachrichten: ${player.message_count || 0}\n` +
        `📅 Erstmals aktiv: ${fmtDate(player.created_at)}\n` +
        `⏱ Letzte Aktivität: ${fmtRel(player.last_point_at)}\n\n` +
        `<b>Punkte ändern:</b>`,
        [
          [
            { text: "+1", callback_data: `cfg_ggap_a_p1_${playerUserId}_${channelId}` },
            { text: "+3", callback_data: `cfg_ggap_a_p3_${playerUserId}_${channelId}` },
            { text: "+5", callback_data: `cfg_ggap_a_p5_${playerUserId}_${channelId}` }
          ],
          [
            { text: "−1", callback_data: `cfg_ggap_a_n1_${playerUserId}_${channelId}` },
            { text: "−3", callback_data: `cfg_ggap_a_n3_${playerUserId}_${channelId}` },
            { text: "−5", callback_data: `cfg_ggap_a_n5_${playerUserId}_${channelId}` }
          ],
          [{ text: "✏️ Manuell setzen", callback_data: `cfg_ggap_s_${playerUserId}_${channelId}` }],
          [{ text: "🗑 Spieler löschen", callback_data: `cfg_ggap_d_${playerUserId}_${channelId}` }],
          [{ text: "◀️ Zurück zur Liste", callback_data: `cfg_ggap_${channelId}` }]
        ]
      );
      break;
    }

    case "ggap_adjust": {
      const mA = data.match(/^cfg_ggap_a_([pn])(\d+)_(\d+)_(-?\d+)$/);
      if (!mA) break;
      const sign = mA[1], amount = parseInt(mA[2]);
      const playerUserId = mA[3];
      const delta = sign === "p" ? amount : -amount;

      const newPoints = await groupGameService.adjustPlayerPoints(
        supabase_db, channelId, playerUserId, delta
      );
      if (newPoints === false) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Spieler nicht gefunden", show_alert: true
        }).catch(()=>{});
      } else {
        const sym = delta >= 0 ? `+${delta}` : `${delta}`;
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: `✅ ${sym} → neue Punkte: ${newPoints}`
        }).catch(()=>{});
      }
      handleSettingsCallback(tg, supabase_db, `cfg_ggap_e_${playerUserId}_${channelId}`, q, userId);
      break;
    }

    case "ggap_set": {
      const mS = data.match(/^cfg_ggap_s_(\d+)_(-?\d+)$/);
      if (!mS) break;
      const playerUserId = mS[1];
      const player = await groupGameService.getPlayer(supabase_db, channelId, playerUserId);

      const sentS = await editOrSend(tg, String(userId), msgId,
        `✏️ <b>Punkte manuell anpassen</b>\n\n` +
        (player ? `Aktuelle Punkte: <b>${player.points}</b>\n\n` : "") +
        `Sende einen der folgenden Werte:\n\n` +
        `<b>Direkter Wert:</b>\n   <code>50</code> = Punkte auf 50 setzen\n\n` +
        `<b>Relative Änderung:</b>\n` +
        `   <code>+10</code> = +10 Punkte\n` +
        `   <code>-5</code>  = −5 Punkte\n\n` +
        `<i>Min: 0, Max: 999.999. /cancel zum Abbrechen.</i>`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_ggap_e_${playerUserId}_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "ggap_set_points",
        channelId,
        playerUserId,
        wizardMsgId: sentS?.message_id || msgId
      };
      break;
    }

    case "ggap_del": {
      const mD = data.match(/^cfg_ggap_d_(\d+)_(-?\d+)$/);
      if (!mD) break;
      const playerUserId = mD[1];
      const player = await groupGameService.getPlayer(supabase_db, channelId, playerUserId);
      if (!player) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Spieler nicht mehr im Ranking", show_alert: true
        }).catch(()=>{});
        handleSettingsCallback(tg, supabase_db, `cfg_ggap_${channelId}`, q, userId);
        break;
      }
      const name = groupGameService.formatUserName(player);
      await editOrSend(tg, String(userId), msgId,
        `🗑 <b>Spieler löschen?</b>\n\n` +
        `${name} mit <b>${player.points}</b> Punkten wird <b>unwiderruflich</b> ` +
        `aus dem Ranking entfernt.\n\n` +
        `<i>Hinweis: Der Spieler kann nach Löschung erneut Punkte sammeln, ` +
        `wenn er weiter aktiv ist.</i>`,
        [
          [{ text: "✅ Ja, löschen",  callback_data: `cfg_ggap_dc_${playerUserId}_${channelId}` }],
          [{ text: "❌ Abbrechen",   callback_data: `cfg_ggap_e_${playerUserId}_${channelId}` }]
        ]
      );
      break;
    }

    case "ggap_delconfirm": {
      const mDC = data.match(/^cfg_ggap_dc_(\d+)_(-?\d+)$/);
      if (!mDC) break;
      const playerUserId = mDC[1];
      const ok = await groupGameService.deletePlayer(supabase_db, channelId, playerUserId);
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: ok ? "🗑 Spieler gelöscht" : "❌ Löschen fehlgeschlagen",
        show_alert: ok ? false : true
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_ggap_${channelId}`, q, userId);
      break;
    }

    case "adwriter": {
      if (!ch?.ai_enabled) break;
      const { data: ads } = await supabase_db.from("scheduled_messages").select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(5);
      const kb = (ads||[]).map(s => [{ text: `✍️ ${(s.message||"").substring(0,30)}…`, callback_data: `cfg_aw_vary_${s.id}_${channelId}` }]);
      kb.unshift([{ text: "✍️ Frischen Text eingeben", callback_data: `cfg_aw_new_${channelId}` }]);
      kb.push([_aiBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, `✍️ <b>WerbeTexter</b>`, kb);
      break;
    }
    case "aw_plan": {
      // cfg_aw_plan_<varIdx>_<channelId>
      const mP = data.match(/^cfg_aw_plan_(\d+)_(-?\d+)$/);
      if (!mP) break;
      const varIdx  = parseInt(mP[1]);
      const varText = global.awVariations?.[`${userId}_${channelId}_${varIdx}`] || null;
      if (!varText) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Variation abgelaufen. Bitte WerbeTexter neu starten.", show_alert: true }).catch(()=>{});
        break;
      }
      const wMsgId = q.message?.message_id;
      global.pendingInputs[String(userId)] = {
        action: "sched_wizard_file", channelId, msgText: varText, wizardMsgId: wMsgId
      };
      await tg.call("editMessageText", {
        chat_id: String(userId), message_id: wMsgId,
        text: `📎 <b>Schritt 2/5: Mediendatei (optional)</b>\n\n<b>Text:</b> <i>${varText.substring(0,80)}…</i>\n\nSende ein Foto, GIF oder Video – oder überspringe diesen Schritt.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⏭ Überspringen", callback_data: `cfg_skip_wiz_${channelId}` }]] }
      }).catch(() => {});
      break;
    }
    case "aw_vary": {
      // Varianten einer BESTEHENDEN geplanten Nachricht → als Textvarianten speichern
      if (!ch?.ai_enabled) break;
      const m = data.match(/^cfg_aw_vary_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (!m) break;
      const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", m[1]).maybeSingle();
      if (!s?.message) break;
      await editOrSend(tg, String(userId), msgId, "⏳ WerbeTexter generiert Textvarianten...", []);
      try {
        const axios = require("axios");
        const r = await axios.post("https://api.openai.com/v1/chat/completions", {
          model: "gpt-4o-mini", max_tokens: 1200,
          messages: [
            { role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des Werbetextes. Trenne mit ---. Nur die Texte, keine Nummerierung oder Erklärungen." },
            { role: "user",   content: s.message }
          ]
        }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } });

        const usage = r.data.usage || {};
        const inTok = usage.prompt_tokens || 0;
        const outTok = usage.completion_tokens || 0;
        const billed = Math.ceil((inTok + outTok) * 1.2);
        void (async()=>{try{await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: billed });}catch(_){}})();

        const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
        const existingVars = Array.isArray(s.variations) ? s.variations : (s.message ? [s.message] : []);

        global.awVariations = global.awVariations || {};
        global.awVariations[`${userId}_${channelId}_vary`] = { schedId: m[1], vars: variations };

        await tg.call("deleteMessage", { chat_id: String(userId), message_id: msgId }).catch(() => {});
        for (let i = 0; i < Math.min(variations.length, 3); i++) {
          await tg.call("sendMessage", {
            chat_id: String(userId),
            text: `✍️ <b>Textvariante ${i+1}</b>\n\n${variations[i].substring(0, 1000)}`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "➕ Als Textvariante hinzufügen", callback_data: `cfg_aw_addvar_${i}_${channelId}` }]] }
          });
        }
        // Kosten-Zusammenfassung als 4. Nachricht
        await tg.call("sendMessage", {
          chat_id: String(userId), parse_mode: "HTML",
          text:
            `📊 <b>Credit-Verbrauch (WerbeTexter)</b>\n\n` +
            `📥 Input:  ${inTok.toLocaleString("de-DE")} Tokens × 1.2 = ${Math.ceil(inTok*1.2).toLocaleString("de-DE")} Credits\n` +
            `📤 Output: ${outTok.toLocaleString("de-DE")} Tokens × 1.2 = ${Math.ceil(outTok*1.2).toLocaleString("de-DE")} Credits\n` +
            `💳 Gesamt: <b>${billed.toLocaleString("de-DE")} Credits</b> (OpenAI ×1.2)\n\n` +
            `📋 Vorhandene Varianten: ${existingVars.length} → nach dem Hinzufügen: ${existingVars.length + variations.length}`,
          reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück zu Wiederholungen", callback_data: `cfg_repeat_${channelId}` }]] }
        });
      } catch (e) { await editOrSend(tg, String(userId), msgId, "❌ Fehler: " + e.message, [[backBtn(channelId, lang)[0]]]); }
      break;
    }

    case "aw_addvar": {
      // cfg_aw_addvar_<varIdx>_<channelId> — Textvariante zu bestehender Nachricht hinzufügen
      const mAV = data.match(/^cfg_aw_addvar_(\d+)_(-?\d+)$/);
      if (!mAV) break;
      const varIdx  = parseInt(mAV[1]);
      const cache   = global.awVariations?.[`${userId}_${channelId}_vary`];
      if (!cache?.schedId || !cache.vars?.[varIdx]) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Session abgelaufen.", show_alert: true }).catch(()=>{});
        break;
      }
      try {
        const { data: sm } = await supabase_db.from("scheduled_messages").select("variations, message").eq("id", cache.schedId).maybeSingle();
        const existing = Array.isArray(sm?.variations) ? sm.variations : (sm?.message ? [sm.message] : []);
        await supabase_db.from("scheduled_messages").update({ variations: [...existing, cache.vars[varIdx]] }).eq("id", cache.schedId);
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ Textvariante gespeichert! (${existing.length + 1} Varianten gesamt)` }).catch(()=>{});
        await tg.call("editMessageReplyMarkup", {
          chat_id: String(userId), message_id: q.message?.message_id,
          reply_markup: { inline_keyboard: [[{ text: `✅ Variante ${varIdx+1} gespeichert`, callback_data: "cfg_noop" }]] }
        }).catch(()=>{});
      } catch (e) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Fehler: " + e.message, show_alert: true }).catch(()=>{});
      }
      break;
    }

    case "aw_plan": {
      // cfg_aw_plan_<varIdx>_<channelId> — NEUE Nachricht mit Variation einplanen (voller Wizard)
      const mP = data.match(/^cfg_aw_plan_(\d+)_(-?\d+)$/);
      if (!mP) break;
      const varIdx  = parseInt(mP[1]);
      const cache   = global.awVariations?.[`${userId}_${channelId}_new`];
      const varText = cache?.vars?.[varIdx];
      if (!varText) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Session abgelaufen.", show_alert: true }).catch(()=>{});
        break;
      }
      const wMsgId = q.message?.message_id;
      global.pendingInputs[String(userId)] = { action: "sched_wizard_file", channelId, msgText: varText, wizardMsgId: wMsgId };
      await tg.call("editMessageText", {
        chat_id: String(userId), message_id: wMsgId,
        text: `📎 <b>Schritt 2/5: Mediendatei</b>\n\n<b>Text:</b> <i>${varText.substring(0,80)}…</i>\n\nSende Foto/Video/GIF – oder überspringe:`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⏭ Überspringen", callback_data: `cfg_skip_wiz_${channelId}` }]] }
      }).catch(() => {});
      break;
    }

    case "aw_run": {
      // Legacy — leitet auf aw_vary weiter
      const mR = data.match(/^cfg_aw_run_([a-zA-Z0-9-]+)_(-?\d+)$/);
      if (mR) handleSettingsCallback(tg, supabase_db, `cfg_aw_vary_${mR[1]}_${channelId}`, q, userId);
      break;
    }
    // ── Zurück zu AI-Features-Menü ─────────────────────────────────────────────
    case "ai": {
      await sendAiMenu(tg, String(userId), channelId, ch, msgId, lang);
      break;
    }

    // ── AI @admin Meldungs-Feature ─────────────────────────────────────────────
    case "adminrep": {
      const enabled    = !!ch?.admin_report_enabled;
      const aiEnabled  = !!ch?.admin_report_ai_enabled;
      const actions    = ch?.admin_report_actions || {};
      const fmtAction  = (cat) => {
        const a = actions[cat];
        if (!a || a === "none") return "<i>keine</i>";
        const map = {
          warn: "⚠️ Verwarnen", delete: "🗑 Nachricht löschen",
          mute_1h: "🔇 1h Mute", mute_6h: "🔇 6h Mute",
          mute_24h: "🔇 24h Mute", mute_perm: "🔇 Permanent Mute",
          ban: "⛔ Ban"
        };
        return map[a] || a;
      };
      const txt =
        `🚨 <b>AI @admin Meldungen</b> — ${_escapeHtml(ch?.title || channelId)}\n\n` +
        `Wenn User <code>@admin</code> auf eine Nachricht antworten, wird das automatisch ` +
        `an Channel-Admins per Privatnachricht weitergeleitet.\n\n` +
        `<b>Status:</b> ${enabled ? "✅ Aktiv" : "❌ Deaktiviert"}\n` +
        `<b>AI-Bewertung:</b> ${aiEnabled ? "✅ Grok bewertet Meldungen automatisch" : "❌ Keine AI-Bewertung"}\n\n` +
        (aiEnabled ? `<b>Auto-Konsequenzen pro Kategorie:</b>\n` +
          `• 📢 Werbung: ${fmtAction("advertising")}\n` +
          `• ⚠️ Scam: ${fmtAction("scam")}\n` +
          `• 🚫 Spam: ${fmtAction("spam")}\n` +
          `• 😠 Beleidigung: ${fmtAction("insult")}\n` +
          `• 📦 Sonstiges: ${fmtAction("other")}\n` : "");
      const kb = [
        [{ text: enabled ? "⏸ Feature deaktivieren" : "▶️ Feature aktivieren",
           callback_data: `cfg_adminrep_toggle_${channelId}` }],
        [{ text: aiEnabled ? "🤖 AI-Bewertung deaktivieren" : "🤖 AI-Bewertung aktivieren",
           callback_data: `cfg_adminrep_aitoggle_${channelId}` }]
      ];
      if (aiEnabled) {
        kb.push([{ text: `📢 Werbung: ${fmtAction("advertising").replace(/<[^>]+>/g,"")}`, callback_data: `cfg_adminrep_catmenu_advertising_${channelId}` }]);
        kb.push([{ text: `⚠️ Scam: ${fmtAction("scam").replace(/<[^>]+>/g,"")}`,           callback_data: `cfg_adminrep_catmenu_scam_${channelId}` }]);
        kb.push([{ text: `🚫 Spam: ${fmtAction("spam").replace(/<[^>]+>/g,"")}`,           callback_data: `cfg_adminrep_catmenu_spam_${channelId}` }]);
        kb.push([{ text: `😠 Beleidigung: ${fmtAction("insult").replace(/<[^>]+>/g,"")}`,  callback_data: `cfg_adminrep_catmenu_insult_${channelId}` }]);
        kb.push([{ text: `📦 Sonstiges: ${fmtAction("other").replace(/<[^>]+>/g,"")}`,     callback_data: `cfg_adminrep_catmenu_other_${channelId}` }]);
      }
      kb.push([_menuBackBtn(channelId, lang)]);
      await editOrSend(tg, String(userId), msgId, txt, kb);
      break;
    }
    case "adminrep_toggle": {
      await supabase_db.from("bot_channels").update({ admin_report_enabled: !ch?.admin_report_enabled }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: refreshed?.admin_report_enabled ? "✅ Aktiviert" : "⏸ Deaktiviert" }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_adminrep_${channelId}`, q, userId);
      break;
    }
    case "adminrep_aitoggle": {
      await supabase_db.from("bot_channels").update({ admin_report_ai_enabled: !ch?.admin_report_ai_enabled }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: refreshed?.admin_report_ai_enabled ? "🤖 AI-Bewertung aktiv" : "🤖 AI-Bewertung aus" }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_adminrep_${channelId}`, q, userId);
      break;
    }
    case "adminrep_catmenu": {
      // cfg_adminrep_catmenu_<category>_<channelId>
      const cat = parts[3];
      const catLabels = { advertising: "📢 Werbung", scam: "⚠️ Scam", spam: "🚫 Spam", insult: "😠 Beleidigung", other: "📦 Sonstiges" };
      const current = ch?.admin_report_actions?.[cat] || "none";
      const opts = [
        { v: "none",      l: "❌ Nur Meldung an Admin (keine Auto-Aktion)" },
        { v: "warn",      l: "⚠️ Verwarnen (öffentliche Nachricht)" },
        { v: "delete",    l: "🗑 Nachricht löschen" },
        { v: "mute_1h",   l: "🔇 1 Stunde stummschalten" },
        { v: "mute_6h",   l: "🔇 6 Stunden stummschalten" },
        { v: "mute_24h",  l: "🔇 24 Stunden stummschalten" },
        { v: "mute_perm", l: "🔇 Permanent stummschalten" },
        { v: "ban",       l: "⛔ Sofortiger Ban" }
      ];
      const kb = opts.map(o => [{
        text: (o.v === current ? "✅ " : "    ") + o.l,
        callback_data: `cfg_adminrep_cat_${cat}_${o.v}_${channelId}`
      }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_adminrep_${channelId}` }]);
      await editOrSend(tg, String(userId), msgId,
        `${catLabels[cat] || cat} — <b>Konsequenz auswählen</b>\n\n` +
        `Was soll automatisch passieren, wenn die AI eine Meldung als <b>${(catLabels[cat]||cat).replace(/^.+ /,"")}</b> einstuft?`,
        kb);
      break;
    }
    case "adminrep_cat": {
      // cfg_adminrep_cat_<category>_<action>_<channelId>
      const cat    = parts[3];
      const actVal = parts[4];
      const cur    = ch?.admin_report_actions || {};
      cur[cat]     = actVal;
      await supabase_db.from("bot_channels").update({ admin_report_actions: cur }).eq("id", channelId);
      const refreshed = (await supabase_db.from("bot_channels").select("*").eq("id", channelId).maybeSingle()).data;
      Object.assign(ch || {}, refreshed || {});
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: `✅ ${cat} → ${actVal}` }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_adminrep_${channelId}`, q, userId);
      break;
    }

    // ── Credits verwalten ──────────────────────────────────────────────────────
    case "credits": {
      const tokenLimit = parseInt(ch?.token_limit) || 0;
      const tokenUsed  = parseInt(ch?.token_used)  || 0;
      const tokenLeft  = Math.max(0, tokenLimit - tokenUsed);
      const expireAt   = ch?.credits_expire_at
        ? new Date(ch.credits_expire_at).toLocaleDateString("de-DE", {day:"2-digit",month:"2-digit",year:"numeric"})
        : null;
      const pct = tokenLimit > 0 ? Math.min(100, Math.round((tokenUsed/tokenLimit)*100)) : 0;
      const bar = "▓".repeat(Math.round(pct/10)) + "░".repeat(10-Math.round(pct/10));

      const credText = tokenLimit > 0
        ? `💳 <b>Credits</b>\n\n${tokenLeft.toLocaleString("de-DE")} verbleibend von ${tokenLimit.toLocaleString("de-DE")}\n[${bar}] ${pct}%${expireAt ? `\nGültig bis: ${expireAt}` : ""}`
        : `💳 <b>Credits</b>\n\nKein aktives Paket — wähle unten eine Option.`;

      const hasCredits = tokenLimit > 0 && tokenLeft > 0;
      await editOrSend(tg, String(userId), msgId, credText, [
        hasCredits
          ? [{ text: "🔋 Credits aufladen (Refill)", callback_data: `refill_chan_${channelId}` }]
          : [{ text: "📦 Paket kaufen",              callback_data: `buy_chan_${channelId}` }],
        [{ text: "📊 Kontoauszug",                   callback_data: `cfg_credits_log_${channelId}` }],
        [_aiBackBtn(channelId, lang)]
      ]);
      break;
    }

    // ── Credits Kontoauszug ─────────────────────────────────────────────────
    case "credits_log":
    case "credits_log_today":
    case "credits_log_yesterday":
    case "credits_log_week":
    case "credits_log_month":
    case "credits_log_all": {
      const creditLogService = require("../creditLogService");
      const range = action === "credits_log" ? "today" : action.replace("credits_log_", "");

      // Zeitraum ermitteln (Europe/Berlin Tagesgrenzen)
      const now = new Date();
      // Heute 00:00 Europe/Berlin = ungefähre Annäherung über UTC+2
      const startOfTodayBerlin = () => {
        const berlinNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
        const d = new Date(berlinNow);
        d.setHours(0, 0, 0, 0);
        // Offset von Berlin zu UTC zurückrechnen
        const offsetMs = berlinNow.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
        return new Date(d.getTime() - offsetMs);
      };
      let sinceDate, rangeLabel;
      if (range === "today")       { sinceDate = startOfTodayBerlin();                                         rangeLabel = "Heute"; }
      else if (range === "yesterday") {
        const t = startOfTodayBerlin();
        sinceDate = new Date(t.getTime() - 24*3600*1000);
        rangeLabel = "Gestern";
      }
      else if (range === "week")   { sinceDate = new Date(now.getTime() - 7  * 24 * 3600 * 1000); rangeLabel = "Letzte 7 Tage"; }
      else if (range === "month")  { sinceDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000); rangeLabel = "Letzte 30 Tage"; }
      else                         { sinceDate = new Date(0);                                       rangeLabel = "Gesamt"; }

      // Bei "yesterday" zusätzlich UpperBound auf today_start
      let upperBoundISO = null;
      if (range === "yesterday") {
        upperBoundISO = startOfTodayBerlin().toISOString();
      }

      // Summary mit ggf. Upper Bound
      let entries = [];
      try {
        let qry = supabase_db.from("channel_credit_log")
          .select("category, credits")
          .eq("channel_id", channelId)
          .gte("created_at", sinceDate.toISOString());
        if (upperBoundISO) qry = qry.lt("created_at", upperBoundISO);
        const { data } = await qry;
        entries = data || [];
      } catch (_) {}

      const map = new Map();
      let total = 0;
      for (const r of entries) {
        total += r.credits || 0;
        const cur = map.get(r.category) || { category: r.category, credits: 0, count: 0 };
        cur.credits += (r.credits || 0);
        cur.count++;
        map.set(r.category, cur);
      }
      const byCat = [...map.values()].sort((a, b) => b.credits - a.credits);

      let body;
      if (!byCat.length) {
        body = `\n\n<i>Keine Verbräuche in diesem Zeitraum.</i>`;
      } else {
        body = "\n\n" + byCat.map(c => {
          const label = creditLogService.CATEGORY_LABELS[c.category] || c.category;
          return `${label}\n   <b>${c.credits.toLocaleString("de-DE")}</b> Credits · ${c.count}× Aufruf`;
        }).join("\n\n");
        body += `\n\n━━━━━━━━━━━━━━━━━━━━\n💳 <b>Gesamt: ${total.toLocaleString("de-DE")} Credits</b>`;
      }

      const rangeBtns = [
        ["today", "Heute"], ["yesterday", "Gestern"],
        ["week", "7 Tage"], ["month", "30 Tage"],
        ["all", "Gesamt"]
      ];
      const row1 = rangeBtns.slice(0, 2).map(([r, l]) => ({
        text: (r === range ? "✅ " : "") + l,
        callback_data: `cfg_credits_log_${r}_${channelId}`
      }));
      const row2 = rangeBtns.slice(2).map(([r, l]) => ({
        text: (r === range ? "✅ " : "") + l,
        callback_data: `cfg_credits_log_${r}_${channelId}`
      }));

      await editOrSend(tg, String(userId), msgId,
        `📊 <b>Kontoauszug — ${rangeLabel}</b>${body}`,
        [
          row1, row2,
          [{ text: "◀️ Zurück zu Credits", callback_data: `cfg_credits_${channelId}` }]
        ]
      );
      break;
    }

    // ── Blacklist Enhancer ──────────────────────────────────────────────────────
    case "bl_ai": {
      if (!ch?.ai_enabled) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ AI-Features müssen erst freigeschaltet sein.", show_alert: true }).catch(()=>{});
        break;
      }
      let hasKey = false;
      try { hasKey = require("../xaiService").isConfigured(); } catch (_) {}
      await editOrSend(tg, String(userId), msgId,
        `✨ <b>Blacklist Enhancer</b>\n\n` +
        `Grok Think analysiert und schlägt passende Blacklist-Wörter vor.\n` +
        `Du entscheidest anschließend pro Wort ob es hart oder toleriert gilt.\n\n` +
        `Modell: <b>Grok Think</b> · Credit-Faktor: ×1.5\n\n` +
        (hasKey ? `✅ xAI API-Key konfiguriert` : `❌ XAI_API_KEY fehlt — bitte in Render hinterlegen`),
        [
          ...(hasKey ? [[{ text: "✨ Blacklist Enhancer starten", callback_data: `cfg_bl_enhancer_start_${channelId}` }]] : []),
          [_aiBackBtn(channelId, lang)]
        ]
      );
      break;
    }
    case "bl_enhancer_start": {
      if (!ch?.ai_enabled) break;
      const sentBl = await editOrSend(tg, String(userId), msgId,
        `✨ <b>Blacklist Enhancer — Schritt 1/2</b>\n\n` +
        `Welche <b>Art von Wörtern</b> soll Grok vorschlagen?\n\n` +
        `Beispiele:\n• <i>Beleidigungen auf Deutsch</i>\n• <i>Crypto-Spam und Investment-Werbung</i>\n` +
        `• <i>Phishing und Betrugsversuche</i>\n• <i>Sexuelle Inhalte</i>\n• <i>Politische Hetze</i>\n\n/cancel zum Abbrechen.`,
        [[{ text: "❌ Abbrechen", callback_data: `cfg_bl_ai_${channelId}` }]]
      );
      global.pendingInputs[String(userId)] = {
        action: "bl_enhancer_type", channelId, wizardMsgId: sentBl?.message_id || msgId
      };
      break;
    }
    case "bl_enhancer_run": {
      if (!ch?.ai_enabled) break;
      const mRun = data.match(/^cfg_bl_enhancer_run_(\d+)_(-?\d+)$/);
      if (!mRun) break;
      const runCount = parseInt(mRun[1]);
      const runPending = global.pendingInputs?.[String(userId)];
      if (!runPending?.blWordType) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Session abgelaufen. Bitte neu starten.", show_alert: true }).catch(()=>{});
        break;
      }
      delete global.pendingInputs[String(userId)];
      await tg.call("answerCallbackQuery", { callback_query_id: q.id }).catch(()=>{});
      await _runBlacklistEnhancer(tg, supabase_db, userId, channelId, runPending.blWordType, runCount, msgId, ch?.bot_language);
      break;
    }

    // ── Wort-für-Wort Review ────────────────────────────────────────────────────
    case "bl_revw": {
      const mR = data.match(/^cfg_bl_revw_(\d+)_(-?\d+)$/);
      if (!mR) break;
      const wordIdx = parseInt(mR[1]);
      const review  = global.pendingInputs?.[String(userId)];
      if (!review?.blWords?.length) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Session abgelaufen.", show_alert: true }).catch(()=>{});
        break;
      }
      if (wordIdx >= review.blWords.length) {
        delete global.pendingInputs[String(userId)];
        await editOrSend(tg, String(userId), msgId,
          `✅ <b>Review abgeschlossen!</b>\n\n📋 ${review.blAdded||0} Wörter hinzugefügt · ⏭ ${review.blSkipped||0} übersprungen`,
          [[_aiBackBtn(channelId, lang)]]
        );
        break;
      }
      const word = review.blWords[wordIdx];
      await tg.call("answerCallbackQuery", { callback_query_id: q.id }).catch(()=>{});
      await editOrSend(tg, String(userId), msgId,
        `📝 <b>Wort ${wordIdx+1} von ${review.blWords.length}</b>\n\n<code>${word}</code>\n\nSchwere für die Blacklist wählen:\n⛔ <b>Hart</b> — Nachricht wird gelöscht\n⚠️ <b>Toleriert</b> — wird protokolliert`,
        [
          [{ text: "⛔ Hart",        callback_data: `cfg_bl_hard_${wordIdx}_${channelId}` },
           { text: "⚠️ Toleriert",  callback_data: `cfg_bl_soft_${wordIdx}_${channelId}` }],
          [{ text: "⏭ Überspringen", callback_data: `cfg_bl_skip_${wordIdx}_${channelId}` }]
        ]
      );
      break;
    }
    case "bl_hard":
    case "bl_soft":
    case "bl_skip": {
      const mS = data.match(/^cfg_bl_(hard|soft|skip)_(\d+)_(-?\d+)$/);
      if (!mS) break;
      const severity = mS[1];
      const wIdx     = parseInt(mS[2]);
      const review   = global.pendingInputs?.[String(userId)];
      if (!review?.blWords) {
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Session abgelaufen.", show_alert: true }).catch(()=>{});
        break;
      }
      if (severity !== "skip") {
        // Schema-korrekte Severity: "mute" = hart sperren, "tolerated" = toleriert
        const dbSeverity = severity === "hard" ? "mute" : "tolerated";
        try {
          const word = review.blWords[wIdx];
          if (word) {
            await supabase_db.from("channel_blacklist").insert([{
              channel_id: String(channelId),
              word:       word.toLowerCase().trim(),
              severity:   dbSeverity,
              category:   "grok_enhancer",
              created_by: parseInt(userId) || 0
            }]);
            global.pendingInputs[String(userId)].blAdded = (review.blAdded || 0) + 1;
          }
        } catch (e) {
          // Duplikat ignorieren (unique constraint), andere Fehler loggen
          if (!String(e.message).includes("duplicate") && !String(e.code).includes("23505")) {
            logger && logger.warn?.(`[BL Enhancer] Insert Fehler: ${e.message}`);
          } else {
            // Duplikat → trotzdem zählen (Wort existiert schon)
            global.pendingInputs[String(userId)].blAdded = (review.blAdded || 0) + 1;
          }
        }
      } else {
        global.pendingInputs[String(userId)].blSkipped = (review.blSkipped || 0) + 1;
      }
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: severity === "skip" ? "⏭ Übersprungen" : severity === "hard" ? "⛔ Hart gespeichert" : "⚠️ Toleriert gespeichert"
      }).catch(()=>{});
      handleSettingsCallback(tg, supabase_db, `cfg_bl_revw_${wIdx + 1}_${channelId}`, q, userId);
      break;
    }

    // ── Admins verwalten ────────────────────────────────────────────────────────
    // Defensive Owner-Prüfung:
    //   1. Wenn ch.added_by_user_id gesetzt → muss === userId sein (Owner-Check)
    //   2. Wenn null/undefined → Fallback: klickender User muss Telegram-Admin sein
    //      (verhindert dass uralte Channels ohne Owner-Eintrag unbedienbar werden)
    case "admins": {
      let isOwner = false;
      if (ch?.added_by_user_id != null) {
        isOwner = String(ch.added_by_user_id) === String(userId)
               || parseInt(ch.added_by_user_id) === parseInt(userId);
      } else {
        // Fallback: Wer ist Telegram-Admin in der Gruppe?
        try {
          const allAdmins = await tg.call("getChatAdministrators", { chat_id: String(channelId) }) || [];
          isOwner = allAdmins.some(a =>
            !a.user?.is_bot && String(a.user?.id) === String(userId)
          );
        } catch (e) {
          logger.warn(`[admins] Owner-Fallback fehlgeschlagen für ${channelId}: ${e.message}`);
        }
      }
      if (!isOwner) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id,
          text: ch?.added_by_user_id == null
            ? "❌ Owner ist nicht gesetzt — bitte Bot neu hinzufügen."
            : "❌ Nur der Owner kann Admins verwalten.",
          show_alert: true
        }).catch(()=>{});
        break;
      }

      // Echte Telegram-Admins des Channels laden — bei Fehler konkrete Ursache loggen + im UI zeigen
      let tgAdmins = [];
      let loadError = null;
      try {
        tgAdmins = await tg.call("getChatAdministrators", { chat_id: String(channelId) }) || [];
      } catch (e) {
        loadError = e.message || String(e);
        logger.warn(`[admins] getChatAdministrators failed für ${channelId}: ${loadError}`);
      }

      // Bestehende Co-Admins aus DB laden — Fehler hier sind kritisch
      let existingCoAdmins = [];
      let dbError = null;
      try {
        const { data, error } = await supabase_db.from("channel_co_admins")
          .select("user_id, username").eq("channel_id", String(channelId));
        if (error) throw error;
        existingCoAdmins = data || [];
      } catch (e) {
        dbError = e.message || String(e);
        logger.warn(`[admins] channel_co_admins SELECT failed: ${dbError}`);
      }
      const coAdminIds = new Set(existingCoAdmins.map(a => String(a.user_id)));

      // Buttons: alle TG-Admins außer Owner und Bots
      const ownerIdStr = ch?.added_by_user_id != null ? String(ch.added_by_user_id) : String(userId);
      const adminButtons = tgAdmins
        .filter(a => a.user && !a.user.is_bot && String(a.user.id) !== ownerIdStr)
        .map(a => {
          const name      = a.user.username ? `@${a.user.username}` : (a.user.first_name || `ID:${a.user.id}`);
          const isCoAdmin = coAdminIds.has(String(a.user.id));
          return [{ text: `${isCoAdmin ? "✅" : "➕"} ${name}`, callback_data: `cfg_admins_tog_${a.user.id}_${channelId}` }];
        });

      let infoText = `👥 <b>Admins für ${_escapeHtml(ch?.title || channelId)}</b>\n\n`;
      if (dbError) {
        infoText += `<i>⚠️ DB-Fehler beim Laden der Co-Admins:</i>\n<code>${_escapeHtml(String(dbError).substring(0, 200))}</code>\n\n` +
                    `<i>Bitte schema_v1.6.13.sql in Supabase ausführen.</i>\n\n`;
      } else if (loadError) {
        // Konkrete Fehlerursache zeigen statt nur generischer Hinweis
        const reason = /not.*admin|forbidden|chat.*not.*found/i.test(loadError)
          ? "Der Bot ist <b>kein Admin</b> in dieser Gruppe."
          : `Telegram-Fehler: <code>${_escapeHtml(String(loadError).substring(0, 100))}</code>`;
        infoText += `<i>⚠️ Admins konnten nicht geladen werden.</i>\n${reason}\n\n` +
                    `<b>So funktioniert's:</b>\n` +
                    `1. Gehe in die Gruppe → Bot zum Admin machen\n` +
                    `2. Berechtigungen: <i>Mitglieder verwalten</i> + <i>Nachrichten löschen</i>\n` +
                    `3. Hier den Button erneut klicken\n\n`;
      } else if (!adminButtons.length) {
        infoText += `<i>Keine weiteren Admins gefunden (außer dir als Owner).</i>\n\n` +
                    `Füge weitere Admins direkt in den Telegram-Gruppen-Einstellungen hinzu, ` +
                    `dann kannst du sie hier als Co-Admin freischalten.\n\n`;
      } else {
        infoText += `<b>✅</b> = Aktuell Co-Admin  <b>➕</b> = Noch kein Co-Admin\n\n` +
                    `Klicke auf einen Admin um ihn hinzuzufügen oder zu entfernen:`;
      }

      await editOrSend(tg, String(userId), msgId, infoText, [
        ...adminButtons,
        [{ text: "🔄 Neu laden", callback_data: `cfg_admins_${channelId}` }],
        [{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]
      ]);
      break;
    }

    case "admins_tog": {
      // cfg_admins_tog_<targetUserId>_<channelId>
      // Owner-Check mit gleichem Fallback-Pattern
      let isOwner = false;
      if (ch?.added_by_user_id != null) {
        isOwner = String(ch.added_by_user_id) === String(userId)
               || parseInt(ch.added_by_user_id) === parseInt(userId);
      } else {
        try {
          const allAdmins = await tg.call("getChatAdministrators", { chat_id: String(channelId) }) || [];
          isOwner = allAdmins.some(a => !a.user?.is_bot && String(a.user?.id) === String(userId));
        } catch (_) {}
      }
      if (!isOwner) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Nur der Owner kann Admins verwalten.", show_alert: true
        }).catch(()=>{});
        break;
      }

      const targetId = parts[3];
      if (!targetId || !/^\d+$/.test(targetId)) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Ungültige Ziel-ID.", show_alert: true
        }).catch(()=>{});
        break;
      }

      // Prüfen ob bereits Co-Admin — DB-Fehler korrekt aufgreifen
      let existing = null;
      try {
        const { data, error } = await supabase_db.from("channel_co_admins")
          .select("id, username")
          .eq("channel_id", String(channelId))
          .eq("user_id", parseInt(targetId))
          .maybeSingle();
        if (error) throw error;
        existing = data;
      } catch (e) {
        logger.warn(`[admins_tog] SELECT failed: ${e.message}`);
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id,
          text: `❌ DB-Fehler: ${String(e.message).substring(0, 100)}`,
          show_alert: true
        }).catch(()=>{});
        break;
      }

      if (existing) {
        // Entfernen
        try {
          const { error } = await supabase_db.from("channel_co_admins").delete().eq("id", existing.id);
          if (error) throw error;
          await tg.call("answerCallbackQuery", {
            callback_query_id: q.id, text: `🗑 @${existing.username || targetId} entfernt.`
          }).catch(()=>{});
        } catch (e) {
          logger.warn(`[admins_tog] DELETE failed: ${e.message}`);
          await tg.call("answerCallbackQuery", {
            callback_query_id: q.id, text: `❌ Entfernen fehlgeschlagen: ${String(e.message).substring(0, 80)}`,
            show_alert: true
          }).catch(()=>{});
        }
      } else {
        // Hinzufügen — Username aus Telegram-Admins ermitteln
        let targetUsername = `user_${targetId}`;
        try {
          const admins = await tg.call("getChatAdministrators", { chat_id: String(channelId) }) || [];
          const found  = admins.find(a => String(a.user?.id) === String(targetId));
          if (found?.user?.username) targetUsername = found.user.username;
          else if (found?.user?.first_name) targetUsername = found.user.first_name;
        } catch (_) {}

        try {
          const { error } = await supabase_db.from("channel_co_admins").upsert([{
            channel_id: String(channelId),
            user_id:    parseInt(targetId),
            username:   targetUsername,
            added_by:   parseInt(userId) || 0
          }], { onConflict: "channel_id,user_id" });
          if (error) throw error;
          await tg.call("answerCallbackQuery", {
            callback_query_id: q.id, text: `✅ @${targetUsername} als Co-Admin hinzugefügt.`
          }).catch(()=>{});
        } catch (e) {
          logger.warn(`[admins_tog] UPSERT failed: ${e.message}`);
          await tg.call("answerCallbackQuery", {
            callback_query_id: q.id,
            text: `❌ Hinzufügen fehlgeschlagen: ${String(e.message).substring(0, 80)}`,
            show_alert: true
          }).catch(()=>{});
        }
      }

      // Menü neu laden
      handleSettingsCallback(tg, supabase_db, `cfg_admins_${channelId}`, q, userId);
      break;
    }

    case "admins_del": {
      // Legacy — leitet auf admins_tog weiter falls id bekannt
      let isOwner = false;
      if (ch?.added_by_user_id != null) {
        isOwner = String(ch.added_by_user_id) === String(userId)
               || parseInt(ch.added_by_user_id) === parseInt(userId);
      }
      if (!isOwner) {
        await tg.call("answerCallbackQuery", {
          callback_query_id: q.id, text: "❌ Nur der Owner kann Admins entfernen.", show_alert: true
        }).catch(()=>{});
        break;
      }
      const delRowId = parts[3];
      if (!delRowId) break;
      try {
        await supabase_db.from("channel_co_admins").delete()
          .eq("id", parseInt(delRowId)).eq("channel_id", String(channelId));
        await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Co-Admin entfernt." }).catch(()=>{});
      } catch (e) {
        logger.warn(`[admins_del] failed: ${e.message}`);
      }
      handleSettingsCallback(tg, supabase_db, `cfg_admins_${channelId}`, q, userId);
      break;
    }

    case "admins_add": {
      // Nicht mehr genutzt — leitet auf admins weiter
      handleSettingsCallback(tg, supabase_db, `cfg_admins_${channelId}`, q, userId);
      break;
    }

    case "noop": break;
  }
}

module.exports = { sendSettingsMenu, sendChannelMenu, sendModerationMenu, sendAiMenu, handleSettingsCallback };