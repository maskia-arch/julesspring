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
  const cid = channelId || "0";
  return [{ text: labels[lang] || "◀️ Zurück", callback_data: `cfg_back_${cid}` }];
}

function _menuBackBtn(channelId) {
  return { text: "◀️ Hauptmenü", callback_data: `cfg_mainmenu_${channelId}` };
}

async function sendSettingsMenu(tg, sendTo, channelId, ch) {
  const aiText = ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv";
  const slText = ch?.safelist_enabled ? "✅" : "❌";
  const fbText = ch?.feedback_enabled ? "✅" : "❌";
  const hasAI = ch?.ai_enabled || false;

  return await tg.call("sendMessage", {
    chat_id: sendTo,
    text: `⚙️ <b>${ch?.title || channelId}</b>\n\nKI: ${aiText} | Safelist: ${slText} | Feedback: ${fbText}\n\nWähle eine Kategorie:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📋 Channel-Einstellungen", callback_data: `cfg_menu_channel_${channelId}` }],
      [{ text: "🔒 Moderation", callback_data: `cfg_menu_mod_${channelId}` }],
      [{ text: hasAI ? "🤖 AI Features" : "🤖 AI Features 🔒", callback_data: `cfg_menu_ai_${channelId}` }],
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
      [{ text: "📅 Zeitplan / Nachtmodus", callback_data: `cfg_schedule_${channelId}` }],
      [{ text: "🔁 Wiederholende Nachrichten", callback_data: `cfg_repeat_${channelId}` }],
      [{ text: "🌐 Sprache", callback_data: `cfg_lang_${channelId}` }],
      [{ text: "🧹 Bereinigen", callback_data: `cfg_clean_${channelId}` }, { text: "📊 Statistik", callback_data: `cfg_stats_${channelId}` }],
      [_menuBackBtn(channelId)],
    ]}
  });
}

async function sendModerationMenu(tg, sendTo, channelId, ch) {
  const slText = ch?.safelist_enabled ? "✅" : "❌";
  const fbText = ch?.feedback_enabled ? "✅" : "❌";
  return tg.call("sendMessage", {
    chat_id: sendTo,
    text: `🔒 <b>Moderation</b> — ${ch?.title || channelId}\n\nSafelist: ${slText} | Feedback: ${fbText}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: `🛡 Safelist ${slText}`, callback_data: `cfg_safelist_${channelId}` }, { text: `💬 Feedback ${fbText}`, callback_data: `cfg_feedback_${channelId}` }],
      [{ text: "🚫 Blacklist", callback_data: `cfg_blacklist_${channelId}` }],
      [{ text: "🔍 UserInfo", callback_data: `cfg_userinfo_${channelId}` }],
      [_menuBackBtn(channelId)],
    ]}
  });
}

async function sendAiMenu(tg, sendTo, channelId, ch) {
  const hasAI = ch?.ai_enabled || false;
  if (!hasAI) {
    return tg.call("sendMessage", {
      chat_id: sendTo,
      text: `🤖 <b>AI Features</b> — Gesperrt\n\nAI Features sind nur mit einem aktiven Paket verfügbar.\n\nNutze <b>/buy</b> um ein Paket zu kaufen.`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[_menuBackBtn(channelId)]] }
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
      [_menuBackBtn(channelId)],
    ]}
  });
}

async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  const withoutPrefix = data.replace(/^cfg_/, "");
  const chanMatch = withoutPrefix.match(/_(-?\d+)$/);
  const channelId = chanMatch ? chanMatch[1] : withoutPrefix.split("_").pop();
  const action = chanMatch ? withoutPrefix.slice(0, withoutPrefix.length - chanMatch[0].length) : withoutPrefix.split("_").slice(0, -1).join("_");
  const ch = await getChannel(channelId);

  switch (action) {
    case "welcome": {
      const cur = ch?.welcome_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Willkommensnachricht</b>\n\nAktuell:\n<i>${cur}</i>\n\nSende die neue Nachricht oder /cancel zum Abbrechen.\n\n<b>Verfügbare Variablen:</b>\n<code>{name}</code> — Vorname des Users\n<code>{username}</code> — @Username (oder Vorname)\n<code>{id}</code> — Telegram-ID\n<code>{channel}</code> — Channel-Name\n<code>{count}</code> — Aktuelle Mitgliederzahl`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
      });
      global.pendingInputs[String(userId)] = { action: "set_welcome", channelId };
      break;
    }
    case "goodbye": {
      const cur = ch?.goodbye_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Abschiedsnachricht</b>\n\nAktuell:\n<i>${cur}</i>\n\nSende die neue Nachricht oder /cancel zum Abbrechen.\n\n<b>Verfügbare Variablen:</b>\n<code>{name}</code> — Vorname des Users\n<code>{username}</code> — @Username (oder Vorname)\n<code>{id}</code> — Telegram-ID\n<code>{channel}</code> — Channel-Name`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
      });
      global.pendingInputs[String(userId)] = { action: "set_goodbye", channelId };
      break;
    }
    case "clean": {
      await tg.call("sendMessage", { chat_id: String(userId), text: "🔍 Starte Bereinigung gelöschter Accounts...", parse_mode: "HTML" });
      const settings = await getSettings();
      const result = await tgAdminHelper.cleanDeletedAccounts(settings.smalltalk_bot_token, channelId);
      await tg.call("sendMessage", { chat_id: String(userId), text: `🧹 Fertig! ${result.checked} geprüft, ${result.removed} gelöschte Accounts entfernt.`, parse_mode: "HTML" });
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
        const left24 = leftRes?.count || leftRes?.data?.length || 0;
        const fb24 = fbRes?.count || fbRes?.data?.length || 0;
        const credits = (ch?.token_limit||0) - (ch?.token_used||0);
        await tg.call("sendMessage", { chat_id: String(userId),
          text: `📊 <b>Statistik</b> — ${ch?.title || channelId}\n\n👥 Mitglieder gesamt: <b>${members}</b>\n📈 Beitritte (24h): <b>+${joined24}</b>\n📉 Austritte (24h): <b>-${left24}</b>\n💬 Feedbacks (24h): <b>${fb24}</b>\n🤖 KI-Credits verbleibend: <b>${credits.toLocaleString()}</b>\n⚡ KI: ${ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv"}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] }
        });
      } catch(e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }
    case "safelist": {
      const slEnabled = ch?.safelist_enabled || false;
      const { data: safeRows } = await supabase_db.from("channel_safelist").select("id", { count: "exact" }).eq("channel_id", channelId);
      const { data: scamRows } = await supabase_db.from("scam_entries").select("id", { count: "exact" }).eq("channel_id", channelId);
      const sl = safeRows?.length || 0;
      const sc = scamRows?.length || 0;

      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🛡 <b>Safelist & Scamliste</b> — ${ch?.title || channelId}\n\nStatus: ${slEnabled ? "✅ Aktiv" : "❌ Inaktiv"}\n✅ Safelist: ${sl} Einträge | ⛔ Scamliste: ${sc} Einträge\n\nJeder User kann nur einmal pro Liste stehen.\nEin User kann nicht gleichzeitig auf der Safeliste UND Scamliste stehen.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: slEnabled ? "🔴 Deaktivieren" : "🟢 Aktivieren", callback_data: `cfg_sl_toggle_${channelId}` }],
          [{ text: `✅ Safelist (${sl})`, callback_data: `cfg_sl_safeview_${channelId}` }, { text: `⛔ Scamliste (${sc})`, callback_data: `cfg_sl_scamview_${channelId}` }],
          [{ text: "➕ Zur Safelist", callback_data: `cfg_sl_adduser_${channelId}` }, { text: "➕ Zur Scamliste", callback_data: `cfg_sl_addscam_${channelId}` }],
          [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` }],
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "sl_toggle": {
      const newVal = !(ch?.safelist_enabled);
      await supabase_db.from("bot_channels").update({ safelist_enabled: newVal, updated_at: new Date() }).eq("id", channelId);
      await tg.call("sendMessage", { chat_id: String(userId), text: `🛡 Safelist ${newVal ? "✅ aktiviert" : "❌ deaktiviert"}.`, parse_mode: "HTML" });
      break;
    }
    case "sl_adduser": {
      global.pendingInputs[String(userId)] = { action: "safelist_add_user", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>User zur Safelist hinzufügen</b>\n\nSende <code>@username</code> oder Telegram-ID.\nOptionaler Kommentar: <code>@username | Kommentar</code>\n\n⚠️ Nicht möglich wenn der User bereits auf der Scamliste steht.\n/cancel zum Abbrechen`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] } });
      break;
    }
    case "sl_addscam": {
      global.pendingInputs[String(userId)] = { action: "scamlist_add_user", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `⛔ <b>User zur Scamliste hinzufügen</b>\n\nSende <code>@username</code> oder Telegram-ID.\nOptionaler Grund: <code>@username | Grund</code>\n\n⚠️ Nicht möglich wenn der User bereits auf der Safeliste steht.\n/cancel zum Abbrechen`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] } });
      break;
    }
    case "sl_reviews": {
      const reviews = await safelistService.getPendingReviews(channelId);
      if (!reviews.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "📋 Keine offenen Reviews.", parse_mode: "HTML" });
      } else {
        for (const r of reviews.slice(0, 5)) {
          const emoji = r.feedback_type === "positive" ? "✅" : "⚠️";
          await tg.call("sendMessage", {
            chat_id: String(userId),
            text: `${emoji} <b>@${r.target_username||r.target_user_id||"?"}</b>\nVon: @${r.submitted_by_username||r.submitted_by||"?"}\nBeweise: ${r.proof_count||0}\n<i>${(r.feedback_text||"").substring(0,150)}</i>`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "✅ Bestätigen", callback_data: `fb_approve_${r.id}` },
              { text: "❌ Ablehnen", callback_data: `fb_reject_${r.id}` }
            ]]}
          });
        }
      }
      break;
    }
    case "sl_safeview": {
      const { data: safeList } = await supabase_db.from("channel_safelist").select("id, user_id, username, score, note, created_at").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(25);
      if (!safeList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Safelist ist leer.", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]] } });
        break;
      }
      const lines = safeList.map((e, i) => {
        const scoreTag = e.score ? ` [${e.score > 0 ? "+" : ""}${e.score} Pkt]` : "";
        return `${i+1}. ✅ @${e.username || e.user_id}${scoreTag}`;
      }).join("\n");
      const kb = safeList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_safedel_${e.id}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>Safelist</b> (${safeList.length})\n\n${lines}`, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "sl_safedel": {
      const m = data.match(/^cfg_sl_safedel_(\d+)_(-?\d+)$/);
      if (m) {
        try {
          await supabase_db.from("channel_safelist").delete().eq("id", m[1]).eq("channel_id", m[2]);
          await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Von der Safelist entfernt.", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_sl_safeview_${m[2]}` }]] } });
        } catch(e) {
          await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
        }
      }
      break;
    }
    case "sl_scamview": {
      const { data: scamList } = await supabase_db.from("scam_entries").select("id, user_id, username, reason, created_at").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(25);
      if (!scamList?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "⛔ Scamliste ist leer.", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]] } });
        break;
      }
      const lines = scamList.map((e, i) => `${i+1}. ⛔ @${e.username || e.user_id}${e.reason ? ` — <i>${e.reason.substring(0,50)}</i>` : ""}`).join("\n");
      const kb = scamList.map(e => [{ text: `🗑 @${e.username || e.user_id}`, callback_data: `cfg_sl_scamdel_${e.id}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `⛔ <b>Scamliste</b> (${scamList.length})\n\n${lines}`, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "sl_scamdel": {
      const m2 = data.match(/^cfg_sl_scamdel_(\d+)_(-?\d+)$/);
      if (m2) {
        try {
          await supabase_db.from("scam_entries").delete().eq("id", m2[1]).eq("channel_id", m2[2]);
          await tg.call("sendMessage", { chat_id: String(userId), text: "⛔ Von der Scamliste entfernt.", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_sl_scamview_${m2[2]}` }]] } });
        } catch(e) {
          await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
        }
      }
      break;
    }
    case "feedback": {
      const fbEnabled = ch?.feedback_enabled || false;
      const { data: fbStats } = await supabase_db.from("user_reputation").select("pos_count, neg_count").eq("channel_id", channelId);
      const totalPos = fbStats?.reduce((a,b) => a + (b.pos_count||0), 0) || 0;
      const totalNeg = fbStats?.reduce((a,b) => a + (b.neg_count||0), 0) || 0;
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `💬 <b>Feedback-System</b> — ${ch?.title || channelId}\n\nStatus: ${fbEnabled ? "✅ Aktiv" : "❌ Inaktiv"}\n✅ Positive Feedbacks: ${totalPos}\n⚠️ Negative Feedbacks: ${totalNeg}\n\nWenn aktiviert erkennt der Bot Feedbacks automatisch im Channel und fragt den User nach Bestätigung.\n\nManuell: <code>/safelist @user</code> · <code>/scamlist @user</code>`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: fbEnabled ? "🔴 Feedback deaktivieren" : "🟢 Feedback aktivieren", callback_data: `cfg_fb_toggle_${channelId}` }],
          [{ text: "📋 Offene Reviews", callback_data: `cfg_sl_reviews_${channelId}` }],
          [{ text: "🏆 Top 10 Ranking", callback_data: `cfg_fb_ranking_${channelId}` }],
          backBtn(channelId, ch?.bot_language||"de")
        ]}
      });
      break;
    }
    case "fb_toggle": {
      const fbNew = !(ch?.feedback_enabled);
      await supabase_db.from("bot_channels").update({ feedback_enabled: fbNew, updated_at: new Date() }).eq("id", channelId);
      await tg.call("sendMessage", { chat_id: String(userId), text: `💬 Feedback-System ${fbNew ? "✅ aktiviert" : "❌ deaktiviert"}.`, parse_mode: "HTML" });
      break;
    }
    case "fb_ranking": {
      const { data: top } = await supabase_db.rpc("get_top_sellers", { p_channel_id: channelId, p_limit: 10 });
      if (!top?.length) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🏆 Noch kein Ranking verfügbar." });
        break;
      }
      const medals = ["🥇","🥈","🥉"];
      const lines = top.map((u, i) => `${medals[i] || `${i+1}.`} @${u.username || u.user_id} — ${u.score} Pkt (✅ ${u.pos_count} | ⚠️ ${u.neg_count})`).join("\n");
      await tg.call("sendMessage", { chat_id: String(userId), text: `🏆 <b>Top 10 Verkäufer</b> — ${ch?.title || channelId}\n\n${lines}`, parse_mode: "HTML" });
      break;
    }
    case "mainmenu": { await sendSettingsMenu(tg, String(userId), channelId, ch); break; }
    case "menu_channel": { await sendChannelMenu(tg, String(userId), channelId, ch); break; }
    case "menu_mod": { await sendModerationMenu(tg, String(userId), channelId, ch); break; }
    case "menu_ai": { await sendAiMenu(tg, String(userId), channelId, ch); break; }
    case "repeat": {
      const { data: scheds } = await supabase_db.from("scheduled_messages").select("id, message, cron_expr, is_active, repeat").eq("channel_id", channelId).order("created_at", { ascending: false }).limit(20);
      const active = scheds?.filter(s => s.is_active) || [];
      const inactive = scheds?.filter(s => !s.is_active) || [];
      const isFree = !ch?.ai_enabled;
      const MAX_FREE = 3;
      let txt = `🔁 <b>Wiederholende Nachrichten</b>\n\nAktiv: ${active.length} | Pausiert: ${inactive.length}\n`;
      if (isFree) txt += `\n⚠️ Free Limit: max ${MAX_FREE} gleichzeitig, max 3x täglich.\n`;
      const kb = (scheds || []).slice(0, 10).map(s => [{ text: `${s.is_active ? "✅" : "⏸"} ${(s.message||"(kein Text)").substring(0,35)}… [${s.cron_expr||"1x"}]`, callback_data: `cfg_rep_edit_${s.id}_${channelId}` }]);
      if (!isFree || active.length < MAX_FREE) {
        kb.unshift([{ text: "➕ Neue Nachricht einrichten", callback_data: `cfg_schedule_${channelId}` }]);
      } else {
        kb.unshift([{ text: `🔒 Limit erreicht (${MAX_FREE})`, callback_data: "cfg_noop" }]);
      }
      kb.push([_menuBackBtn(channelId)]);
      await tg.call("sendMessage", { chat_id: String(userId), text: txt, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "rep_edit": {
      const repMatch = data.match(/^cfg_rep_edit_(\d+)_(-?\d+)$/);
      if (!repMatch) break;
      const schedId = repMatch[1];
      const { data: s } = await supabase_db.from("scheduled_messages").select("*").eq("id", schedId).maybeSingle();
      if (!s) break;
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `🔁 <b>${(s.message||"(kein Text)").substring(0,60)}</b>\n\nStatus: ${s.is_active ? "✅ Aktiv" : "⏸ Pausiert"}\nIntervall: ${s.cron_expr || "Einmalig"}\nWiederholen: ${s.repeat ? "Ja" : "Nein"}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: s.is_active ? "⏸ Pausieren" : "▶️ Aktivieren", callback_data: `cfg_rep_toggle_${schedId}_${channelId}` }],
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
        await tg.call("sendMessage", { chat_id: String(userId), text: `${newActive ? "▶️ Aktiviert" : "⏸ Pausiert"}.` });
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
    case "noop": { break; }
    case "schedule": {
      global.pendingInputs[String(userId)] = { action: "sched_wizard_text", channelId, aiOn: ch?.ai_enabled, freeMode: !ch?.ai_enabled };
      await tg.call("sendMessage", { chat_id: String(userId), text: `📅 <b>Nachricht einplanen</b>\n\n<b>Schritt 1/4: Text</b>\n\nSende den Text der Nachricht.\nOder /skip für nur ein Bild/GIF/Video.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]] } });
      break;
    }
    case "blacklist": {
      const { data: blEntries } = await supabase_db.from("channel_blacklist").select("id, word, severity, category, delete_after_hours").eq("channel_id", channelId).order("severity").limit(30);
      const hard = blEntries?.filter(e => e.severity !== "tolerated") || [];
      const soft = blEntries?.filter(e => e.severity === "tolerated") || [];
      let txt = `🚫 <b>Blacklist</b> — ${ch?.title || channelId}\n\n🔴 Blacklist: ${hard.length} Einträge\n🟡 Blacklist Light (toleriert): ${soft.length} Einträge\n\nSyntax: <code>Wort | Aktion | Kategorie</code>\nAktionen: <code>warn</code> · <code>mute</code> · <code>ban</code> · <code>tolerated</code>\nToleriert: Automatisch gelöscht nach X Stunden.`;
      const kb = [[{ text: "➕ Wort hinzufügen", callback_data: `cfg_bl_add_${channelId}` }], [{ text: "➕ Toleriertes Wort", callback_data: `cfg_bl_addsoft_${channelId}` }]];
      if (hard.length) kb.push([{ text: `📋 Liste anzeigen (${hard.length})`, callback_data: `cfg_bl_list_${channelId}` }]);
      if (soft.length) kb.push([{ text: `🟡 Light-Liste (${soft.length})`, callback_data: `cfg_bl_listsoft_${channelId}` }]);
      kb.push([{ text: "🤖 KI Blacklist füllen 🔒", callback_data: `cfg_bl_ai_${channelId}` }]);
      kb.push([_menuBackBtn(channelId)]);
      await tg.call("sendMessage", { chat_id: String(userId), text: txt, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "bl_add": {
      global.pendingInputs[String(userId)] = { action: "bl_add_word", channelId, severity: "mute" };
      await tg.call("sendMessage", { chat_id: String(userId), text: `🚫 <b>Blacklist-Eintrag hinzufügen</b>\n\nFormat: <code>Wort | Aktion | Kategorie</code>\n\nAktionen: <code>warn</code> · <code>mute</code> · <code>ban</code>\n\nBeispiel: <code>Spam | ban | Werbung</code>\n/cancel zum Abbrechen`, parse_mode: "HTML" });
      break;
    }
    case "bl_addsoft": {
      global.pendingInputs[String(userId)] = { action: "bl_add_soft", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `🟡 <b>Toleriertes Wort hinzufügen</b>\n\nFormat: <code>Wort | Stunden</code>\n\nBeispiel: <code>Werbung | 24</code> → Nachricht wird nach 24h gelöscht.\n/cancel zum Abbrechen`, parse_mode: "HTML" });
      break;
    }
    case "bl_list": {
      const { data: hardList } = await supabase_db.from("channel_blacklist").select("id, word, severity, category").eq("channel_id", channelId).neq("severity", "tolerated").order("word").limit(25);
      if (!hardList?.length) { await tg.call("sendMessage", { chat_id: String(userId), text: "🚫 Blacklist ist leer." }); break; }
      const kb2 = hardList.map(e => [{ text: `🗑 ${e.word} [${e.severity}]`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb2.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `🚫 <b>Blacklist</b>\n\n` + hardList.map(e => `• <code>${e.word}</code> [${e.severity}/${e.category||"–"}]`).join("\n"), parse_mode: "HTML", reply_markup: { inline_keyboard: kb2 } });
      break;
    }
    case "bl_listsoft": {
      const { data: softList } = await supabase_db.from("channel_blacklist").select("id, word, delete_after_hours").eq("channel_id", channelId).eq("severity", "tolerated").order("word").limit(25);
      if (!softList?.length) { await tg.call("sendMessage", { chat_id: String(userId), text: "🟡 Light-Liste ist leer." }); break; }
      const kb3 = softList.map(e => [{ text: `🗑 ${e.word} [${e.delete_after_hours||24}h]`, callback_data: `cfg_bl_del_${e.id}_${channelId}` }]);
      kb3.push([{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `🟡 <b>Blacklist Light</b>\n\n` + softList.map(e => `• <code>${e.word}</code> — löschen nach ${e.delete_after_hours||24}h`).join("\n"), parse_mode: "HTML", reply_markup: { inline_keyboard: kb3 } });
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
    case "smalltalk": {
      if (!ch?.ai_enabled) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "🔒 Smalltalk AI ist nur mit aktivem Paket verfügbar." }); break;
      }
      const model = ch?.smalltalk_model || "deepseek";
      const modelName = model === "openai" ? "OpenAI (GPT-4o Mini) — Faktor x1.2" : "AutoActsAI (Standard) — Faktor x1.0";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `💬 <b>Smalltalk AI</b> — ${ch?.title || channelId}\n\nModell: ${modelName}\nSystem-Prompt gesetzt: ${ch?.system_prompt ? "✅" : "❌"}\nMax Tokens: ${ch?.smalltalk_max_tokens || 200}\nTemperature: ${ch?.smalltalk_temperature || 0.8}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "✏️ System-Prompt bearbeiten", callback_data: `cfg_st_prompt_${channelId}` }],
          [{ text: model === "openai" ? "🔄 Zu AutoActsAI wechseln (Standard)" : "🔄 Zu OpenAI wechseln (x1.2)", callback_data: `cfg_st_model_${channelId}` }],
          [{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }],
        ]}
      });
      break;
    }
    case "st_prompt": {
      global.pendingInputs[String(userId)] = { action: "set_ai_prompt", channelId };
      const cur = ch?.system_prompt || "(kein)";
      await tg.call("sendMessage", { chat_id: String(userId), text: `✏️ <b>System-Prompt</b>\n\nAktuell: <i>${cur.substring(0,200)}</i>\n\nSende den neuen System-Prompt:\n/cancel zum Abbrechen`, parse_mode: "HTML" });
      break;
    }
    case "st_model": {
      const curModel = ch?.smalltalk_model || "deepseek";
      const newModel = curModel === "openai" ? "deepseek" : "openai";
      await supabase_db.from("bot_channels").update({ smalltalk_model: newModel, updated_at: new Date() }).eq("id", channelId);
      const newName = newModel === "openai" ? "OpenAI (GPT-4o Mini) — Faktor x1.2" : "AutoActsAI — Faktor x1.0";
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ Modell gewechselt zu <b>${newName}</b>.`, parse_mode: "HTML" });
      break;
    }
    case "daily": {
      if (!ch?.ai_enabled) { await tg.call("sendMessage", { chat_id: String(userId), text: "🔒 Nur mit aktivem Paket." }); break; }
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `📰 <b>Tagesbericht</b> — ${ch?.title || channelId}\n\nDer Bot erstellt täglich eine KI-Zusammenfassung relevanter, wichtiger oder riskanter Ereignisse im Channel.\n\nJetzt Bericht anfordern:`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "📰 Jetzt Bericht erstellen", callback_data: `cfg_daily_now_${channelId}` }], [{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }]] }
      });
      break;
    }
    case "daily_now": {
      if (!ch?.ai_enabled) break;
      await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ Erstelle Tagesbericht…" });
      try {
        await dailySummaryService.runDailySummary(supabase_db, channelId, userId, tg, ch, ch?.bot_language||"de");
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }
    case "adwriter": {
      if (!ch?.ai_enabled) { await tg.call("sendMessage", { chat_id: String(userId), text: "🔒 Nur mit aktivem Paket." }); break; }
      const { data: ads } = await supabase_db.from("scheduled_messages").select("id, message").eq("channel_id", channelId).eq("is_active", true).limit(10);
      const kb = (ads||[]).map(s => [{ text: `✍️ ${(s.message||"(kein Text)").substring(0,40)}…`, callback_data: `cfg_aw_vary_${s.id}_${channelId}` }]);
      kb.unshift([{ text: "✍️ Neuen WerbeText erstellen (30 Credits)", callback_data: `cfg_aw_new_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>WerbeTexter</b>\n\nLasse bestehende Werbetexte variieren oder neue erstellen.\nJeder Einsatz erstellt <b>3 Variationen</b> und kostet <b>30 Credits</b>.`, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      break;
    }
    case "aw_new": {
      global.pendingInputs[String(userId)] = { action: "adwriter_new", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Neuer WerbeText</b>\n\nSende deinen Ausgangstext. Der WerbeTexter erstellt 3 Variationen.\n\n<i>Kosten: 30 Credits</i>\n/cancel zum Abbrechen`, parse_mode: "HTML" });
      break;
    }
    case "aw_vary": {
      const awm = data.match(/^cfg_aw_vary_(\d+)_(-?\d+)$/);
      if (!awm) break;
      const { data: sched } = await supabase_db.from("scheduled_messages").select("message").eq("id", awm[1]).maybeSingle();
      if (!sched?.message) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Nachricht nicht gefunden." }); break; }
      global.pendingInputs[String(userId)] = { action: "adwriter_vary", channelId, schedId: awm[1], origText: sched.message };
      await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variationen erstellen</b>\n\nOriginaltext:\n<i>${sched.message.substring(0,200)}</i>\n\nBestätige um 3 Variationen zu erstellen (30 Credits):\n/cancel zum Abbrechen`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Jetzt variieren (30 Credits)", callback_data: `cfg_aw_run_${awm[1]}_${channelId}` }]] } });
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
        const r = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 1200, messages: [{ role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Der Inhalt muss identisch bleiben, aber Formulierungen, Satzstruktur und Stil sollen variieren. Trenne die Variationen mit ---." }, { role: "user", content: s3.message }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
        const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
        await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
        for (let i = 0; i < Math.min(variations.length, 3); i++) {
          await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `📅 Als Nachricht einplanen`, callback_data: `cfg_aw_schedule_${arm[1]}_${i}_${channelId}` }]] } });
        }
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
      }
      break;
    }
    case "bl_ai": {
      await tg.call("sendMessage", { chat_id: String(userId), text: `🤖 <b>Blacklist Enhancer</b> — 🔒 Bald verfügbar\n\nDieses Feature wird freigeschaltet, sobald GrokAI integriert ist.\n\nBitte schau bald nochmal vorbei!`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "◀️ Zurück", callback_data: `cfg_menu_ai_${channelId}` }]] } });
      break;
    }
    case "back": {
      await sendSettingsMenu(tg, String(userId), channelId, ch);
      break;
    }
    case "userinfo": {
      global.pendingInputs[String(userId)] = { action: "userinfo_awaiting", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `🔍 <b>UserInfo</b>\n\nDrei Möglichkeiten:\n1. <b>Nachricht weiterleiten</b> — leite eine Nachricht des gesuchten Users weiter\n2. <b>Telegram-ID eingeben</b> — z.B. <code>123456789</code>\n3. <b>@Username eingeben</b> — z.B. <code>@autoacts</code>\n\n/cancel zum Abbrechen`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] } });
      break;
    }
    case "knowledge": {
      const lang2 = ch?.bot_language || "de";
      try {
        const { data: kbEntries } = await supabase_db.from("channel_knowledge").select("id, title, category, content, created_at").eq("channel_id", String(channelId)).order("created_at", { ascending: false }).limit(20);
        const count = kbEntries?.length || 0;
        let preview = "";
        if (count > 0) {
          preview = "\n\n<b>Letzte Einträge:</b>\n" + kbEntries.slice(0, 5).map((e, i) => `${i+1}. <i>${(e.title || e.content.substring(0,40)+"…").substring(0,50)}</i>`).join("\n");
        }
        const kb = [[{ text: "➕ Neuer Wissenseintrag", callback_data: `cfg_kb_add_${channelId}` }]];
        if (count > 0) {
          kb.push([{ text: `🗑 Eintrag löschen (${count} total)`, callback_data: `cfg_kb_delete_${channelId}` }]);
        }
        kb.push(backBtn(channelId, lang2));
        await tg.call("sendMessage", { chat_id: String(userId), text: `📚 <b>Wissensdatenbank</b> — ${ch?.title || channelId}\n\n<b>${count} Einträge</b> in der Channel-KI hinterlegt.` + preview + "\n\nNeue Einträge werden von OpenAI analysiert, kategorisiert und als Vektoreinbettung gespeichert. Die Smalltalk-AI nutzt das Wissen automatisch bei passenden Fragen.", parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
      } catch (e) {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler beim Laden der Wissensdatenbank: " + e.message });
      }
      break;
    }
    case "kb_add": {
      global.pendingInputs[String(userId)] = { action: "kb_add_entry", channelId };
      await tg.call("sendMessage", { chat_id: String(userId), text: `📚 <b>Neuer Wissenseintrag</b>\n\nSende den Text den du in die Wissensdatenbank aufnehmen möchtest.\n\nBeispiele:\n• FAQs und typische Fragen\n• Preise und Produktinfos\n• Regeln und Hinweise\n• Kontaktdaten\n\n<i>OpenAI analysiert den Eintrag, erstellt eine Zusammenfassung und kategorisiert ihn automatisch.</i>\n\n/cancel zum Abbrechen`, parse_mode: "HTML", reply_markup: { inline_keyboard: [backBtn(channelId, ch?.bot_language||"de")] } });
      break;
    }
    case "kb_delete": {
      try {
        const { data: kbAll } = await supabase_db.from("channel_knowledge").select("id, title, content, category").eq("channel_id", String(channelId)).order("created_at", { ascending: false }).limit(20);
        if (!kbAll?.length) { await tg.call("sendMessage", { chat_id: String(userId), text: "📚 Keine Einträge vorhanden." }); break; }
        const delKb = kbAll.map(e => [{ text: `🗑 ${(e.title || e.content.substring(0,35)+"…").substring(0,45)} [${e.category||"–"}]`, callback_data: `cfg_kb_del_${e.id}_${channelId}` }]);
        delKb.push(backBtn(channelId, ch?.bot_language||"de"));
        await tg.call("sendMessage", { chat_id: String(userId), text: `🗑 <b>Eintrag löschen</b>\n\nWähle einen Eintrag zum Löschen:`, parse_mode: "HTML", reply_markup: { inline_keyboard: delKb } });
      } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message }); }
      break;
    }
    case "kb_del": {
      const kbDelMatch = data.match(/^cfg_kb_del_(-?\d+)_(-?\d+)$/);
      if (kbDelMatch) {
        const entryId2 = kbDelMatch[1];
        const chanId2 = kbDelMatch[2];
        try {
          await supabase_db.from("channel_knowledge").delete().eq("id", entryId2).eq("channel_id", chanId2);
          await tg.call("sendMessage", { chat_id: String(userId), text: "✅ Eintrag gelöscht.", reply_markup: { inline_keyboard: [[{ text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${chanId2}` }]] } });
        } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Löschen fehlgeschlagen: " + e.message }); }
      }
      break;
    }
    case "setlang": {
      const setLangMatch = data.match(/^cfg_setlang_([a-z]{2,3})_(-?\d+)$/);
      if (setLangMatch) {
        const newLangCode = setLangMatch[1];
        const setLangChanId = setLangMatch[2];
        if (SUPPORTED_LANGUAGES[newLangCode]) {
          await supabase_db.from("bot_channels").update({ bot_language: newLangCode, updated_at: new Date() }).eq("id", setLangChanId);
          await tg.call("sendMessage", { chat_id: String(userId), text: `✅ ${SUPPORTED_LANGUAGES[newLangCode]}`, parse_mode: "HTML" });
        }
      }
      break;
    }
  }
}

module.exports = {
  sendSettingsMenu,
  sendChannelMenu,
  sendModerationMenu,
  sendAiMenu,
  handleSettingsCallback
};
