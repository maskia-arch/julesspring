const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const safelistService = require("./safelistService");
const { tgAdminHelper } = require("./tgAdminHelper");
const settingsHandler = require("./settingsHandler");
const packageService = require("../packageService");

const pendingInputs = global.pendingInputs = global.pendingInputs || {};

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function isGroupAdmin(tg, chatId, userId) {
  try {
    const admins = await tg.getAdmins(chatId);
    return admins.some(a => a.user?.id === userId);
  } catch { return false; }
}

async function handle(tg, supabase_db, q, token, settings) {
  const qChatId = String(q.message?.chat?.id || "");
  const qUserId = q.from?.id;
  const data = q.data || "";

  if (q.message?.message_id && q.message?.chat?.id) {
    await tg.call("deleteMessage", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id
    }).catch(() => {});
  }
  await tg.call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});

  if (data.startsWith("settings_here_") || data.startsWith("settings_private_")) {
    const parts = data.split("_");
    const sendPriv = data.startsWith("settings_private_");
    const targetChannelId = parts[2];
    const ownerId = parts[3] ? parseInt(parts[3]) : null;

    if (sendPriv && ownerId && qUserId !== ownerId) return;
    if (!await isGroupAdmin(tg, targetChannelId, qUserId)) return;

    const ch = await getChannel(targetChannelId);
    const sendTarget = sendPriv ? String(qUserId) : targetChannelId;

    await settingsHandler.sendSettingsMenu(tg, sendTarget, targetChannelId, ch);
    return;
  }

  if (data.startsWith("fb_confirm_")) {
    const parts3 = data.split("_");
    const fbType = parts3[2];
    const targetUname = parts3[3];
    const submitterId = parts3[4];
    const chanId3 = parts3[parts3.length - 1];

    if (String(qUserId) !== String(submitterId)) {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Nur die Person die das Feedback geschrieben hat kann es bestätigen.", show_alert: true });
      return;
    }

    if (fbType === "no") {
      const origMsg = q.message?.text || "";
      const { data: chAdmin } = await supabase_db.from("bot_channels").select("added_by_user_id").eq("id", String(chanId3)).maybeSingle().catch(() => ({ data: null }));
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

    const feedbackType = fbType === "pos" ? "positive" : "negative";
    const origText = q.message?.reply_to_message?.text?.substring(0, 300) || "";
    let fbId = null;

    try {
      const fbResult = await safelistService.submitFeedback({
        channelId: chanId3, submittedBy: submitterId,
        submittedByUsername: q.from?.username || null,
        targetUsername: targetUname, feedbackType, feedbackText: origText
      });
      fbId = fbResult?.id;
    } catch (_) {}

    await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});

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

    if (proofMsg?.message_id) {
      void safelistService.trackBotMessage(q.message.chat.id, proofMsg.message_id, "temp", 5*60*1000);
    }

    await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: feedbackType === "positive" ? "✅ Positiv gespeichert" : "⚠️ Negativ gespeichert" });
    return;
  }

  if (data.startsWith("sched_repeat_") || data === "sched_noop") {
    if (data === "sched_noop") {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "⚠️ Free-Limit erreicht", show_alert: true });
      return;
    }
    const rMatch = data.match(/^sched_repeat_([a-z]+)_(-?\d+)$/);
    const repeatType = rMatch ? rMatch[1] : "once";
    const chanId2 = rMatch ? rMatch[2] : data.split("_").pop();
    const wizard = pendingInputs[String(qUserId)];
    
    if (!wizard || !wizard.action.startsWith("sched_wizard")) {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id });
      return;
    }
    delete pendingInputs[String(qUserId)];

    if (repeatType === "opt") {
      const parts2 = data.split("_");
      const subOpt = parts2[3];
      const key = String(qUserId);
      if (pendingInputs[key]) {
        if (subOpt === "pin") pendingInputs[key].pinAfterSend = !pendingInputs[key].pinAfterSend;
        if (subOpt === "delprev") pendingInputs[key].deletePrevious = !pendingInputs[key].deletePrevious;
      }
      await tg.call("answerCallbackQuery", {
        callback_query_id: q.id,
        text: subOpt === "pin" ? "📌 Anpinnen geändert" : "🔄 Löschen geändert"
      });
      const p2 = pendingInputs[key] || {};
      const pinOpt2 = "📌 Anpinnen: " + (p2.pinAfterSend ? "✅" : "❌");
      const delPrevOpt2 = "🔄 Vorherige löschen: " + (p2.deletePrevious ? "✅" : "❌");
      await tg.call("editMessageReplyMarkup", {
        chat_id: String(qUserId),
        message_id: q.message?.message_id,
        reply_markup: { inline_keyboard: [
          [{ text: "1x – Einmalig", callback_data: "sched_repeat_once_" + chanId2 },
           { text: "Täglich", callback_data: "sched_repeat_daily_" + chanId2 }],
          [{ text: "Wöchentlich", callback_data: "sched_repeat_weekly_" + chanId2 },
           { text: "Monatlich", callback_data: "sched_repeat_monthly_" + chanId2 }],
          [{ text: pinOpt2, callback_data: "sched_opt_pin_" + chanId2 },
           { text: delPrevOpt2, callback_data: "sched_opt_delprev_" + chanId2 }]
        ]}
      }).catch(() => {});
      return;
    }

    const cronMap = { daily: "0 9 * * *", weekly: "0 9 * * 1", monthly: "0 9 1 * *" };
    const isRepeat = repeatType !== "once";
    const cronExpr = isRepeat ? cronMap[repeatType] || null : null;

    try {
      await supabase_db.from("scheduled_messages").insert([{
        channel_id: chanId2,
        message: wizard.msgText || "",
        photo_file_id: wizard.fileId || null,
        photo_url: null,
        cron_expr: cronExpr,
        next_run_at: wizard.nextRunAt || new Date().toISOString(),
        repeat: isRepeat,
        is_active: true,
        pin_after_send: wizard.pinAfterSend || false,
        delete_previous: wizard.deletePrevious || false
      }]);
      const repeatLabel = { once: "einmalig", daily: "täglich", weekly: "wöchentlich", monthly: "monatlich" }[repeatType] || repeatType;
      const dt = wizard.nextRunAt ? new Date(wizard.nextRunAt).toLocaleString("de-DE") : "sofort";
      await tg.call("sendMessage", { chat_id: String(qUserId),
        text: `✅ <b>Geplante Nachricht gespeichert!</b>\n\n📝 Text: ${(wizard.msgText||"").substring(0,80)}${wizard.fileId ? "\n📎 Medien: ✅" : ""}\n📅 Zeit: ${dt}\n🔁 Wiederholung: ${repeatLabel}`,
        parse_mode: "HTML" });
    } catch (e2) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Fehler beim Speichern: " + e2.message });
    }
    return;
  }

  if (data.startsWith("refill_chan_")) {
    const refChanId = data.split("_")[2];
    const pend = pendingInputs[String(qUserId)] || {};
    let showRefills = pend.refills || [];
    
    if (!showRefills.length) {
      const { data: r } = await supabase_db.from("channel_refills").select("*").eq("is_active", true).order("sort_order");
      showRefills = r || [];
    }
    
    const { data: chStat } = await (async () => { try { return await supabase_db.from("bot_channels").select("token_used, token_limit, credits_expire_at, title").eq("id", refChanId).maybeSingle(); } catch { return { data: null }; } })();
    const used = chStat?.token_used || 0;
    const lim = chStat?.token_limit || 0;
    const exp = chStat?.credits_expire_at ? new Date(chStat.credits_expire_at).toLocaleDateString("de-DE") : "–";
    
    const kb = showRefills.map(r => [{
      text: `🔋 ${r.name} — ${r.credits.toLocaleString()} Credits · ${parseFloat(r.price_eur).toFixed(2)} €`,
      callback_data: "refill_opt_" + r.id + "_" + refChanId
    }]);
    kb.push([{ text: "❌ Abbrechen", callback_data: "buy_cancel" }]);
    
    await tg.call("editMessageText", {
      chat_id: String(qUserId), message_id: q.message?.message_id,
      text: `🔋 <b>Credits nachladen für "${chStat?.title||refChanId}"</b>\n\nVerbraucht: ${used.toLocaleString()} / ${lim.toLocaleString()} Credits\nGültig bis: ${exp}\n\nℹ️ Refills verlängern NICHT die Laufzeit.\n💎 Ungenutzte Refills laufen NIE ab und dienen als Notfallreserve.`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
    }).catch(async () => {
      await tg.call("sendMessage", { chat_id: String(qUserId),
        text: `🔋 Refill-Optionen für "${chStat?.title||refChanId}":`,
        parse_mode: "HTML", reply_markup: { inline_keyboard: kb }
      });
    });
    return;
  }

  if (data.startsWith("refill_opt_")) {
    const roMatch = data.match(/^refill_opt_(\d+)_(-?\d+)$/);
    if (!roMatch) return;
    const refillId = parseInt(roMatch[1]);
    const roChanId = roMatch[2];
    delete pendingInputs[String(qUserId)];
    
    const { data: refill } = await (async () => { try { return await supabase_db.from("channel_refills").select("*").eq("id", refillId).single(); } catch { return { data: null }; } })();
    if (!refill) { await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Refill nicht gefunden." }); return; }
    
    await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });
    
    try {
      const result = await packageService.generateRefillUrl(refill, roChanId);
      if (result.checkoutUrl) {
        await tg.call("sendMessage", { chat_id: String(qUserId),
          text: `🔋 <b>${refill.name}</b>\n\n+${refill.credits.toLocaleString()} Credits\n💰 ${parseFloat(refill.price_eur).toFixed(2)} €\n\nCredits werden sofort nach Zahlung gutgeschrieben.`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt nachladen", url: result.checkoutUrl }]] }
        });
      } else {
        await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Checkout konnte nicht erstellt werden. Kontaktiere @autoacts." });
      }
    } catch (e2) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: `❌ Refill fehlgeschlagen:\n<i>${e2.message}</i>\n\nKontaktiere @autoacts.`, parse_mode: "HTML" });
    }
    return;
  }

  if (data.startsWith("buy_chan_")) {
    const buyChanId = data.split("_")[2];
    const pend = pendingInputs[String(qUserId)] || {};
    let pkgs = pend.packages;
    
    if (!pkgs?.length) {
      const { data: pkgsFresh } = await supabase_db.from("channel_packages").select("*").eq("is_active", true).order("sort_order");
      pkgs = pkgsFresh;
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
    
    const chTitle = (await supabase_db.from("bot_channels").select("title").eq("id", buyChanId).maybeSingle()).data?.title || buyChanId;
    
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

  if (data.startsWith("buy_pkg_")) {
    const parts4 = data.match(/^buy_pkg_(\d+)_(-?\d+)$/);
    if (!parts4) return;
    const pkgId = parseInt(parts4[1]);
    const chanId4 = parts4[2];
    delete pendingInputs[String(qUserId)];

    const { data: pkg } = await (async () => { try { return await supabase_db.from("channel_packages").select("*").eq("id", pkgId).single(); } catch { return { data: null }; } })();
    if (!pkg) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Paket nicht gefunden." });
      return;
    }

    await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });

    try {
      const result = await packageService.generateCheckoutUrl(pkg, chanId4);
      if (result.checkoutUrl) {
        await tg.call("sendMessage", { chat_id: String(qUserId),
          text: `✅ <b>${pkg.name} — ${pkg.credits.toLocaleString()} Credits</b>\n\n💰 Preis: ${parseFloat(pkg.price_eur).toFixed(2)} €\n📅 Laufzeit: ${pkg.duration_days || 30} Tage <i>(ab Kaufdatum)</i>\nℹ️ Während dein Paket läuft, kannst du Refills als Notfall-Vorrat kaufen.\n\nZum Bezahlen tippst du auf den Button:`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt kaufen", url: result.checkoutUrl }]] }
        });
      } else {
        await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Checkout konnte nicht erstellt werden. Kontaktiere @autoacts." });
      }
    } catch (e2) {
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

  if (data.startsWith("sel_channel_")) {
    const selChanId = data.split("_")[2];
    const ch = await getChannel(selChanId);
    await settingsHandler.sendSettingsMenu(tg, String(qUserId), selChanId, ch);
    return;
  }

  if (data.startsWith("cfg_")) {
    await settingsHandler.handleSettingsCallback(tg, supabase_db, data, q, qUserId);
    return;
  }

  if (data.startsWith("fb_want_proof_")) {
    const pm = data.match(/^fb_want_proof_(-?\d+)_(-?\d+)_(-?\d+)$/);
    if (!pm || String(qUserId) !== pm[2]) {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Nicht für dich.", show_alert: true });
      return;
    }
    const [, fbId2, , chanId4] = pm;
    try {
      await supabase_db.from("proof_sessions").insert([{
        feedback_id: parseInt(fbId2), user_id: parseInt(qUserId),
        channel_id: chanId4, status: "collecting"
      }]);
    } catch (_) {}
    
    pendingInputs[String(qUserId)] = { action: "collecting_proofs", feedbackId: fbId2, channelId: chanId4, proofCount: 0 };
    const botName = settings?.bot_name || "AdminHelper";
    
    await tg.call("editMessageText", {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: `📎 <b>Proofs einreichen</b>\n\nSchreibe dem Bot <b>direkt privat</b> und sende deine Beweise (Fotos, Videos, Screenshots, Text).\n\nWenn du fertig bist: /done\nAbbrechen: /cancel`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "💬 Dem Bot schreiben", url: `https://t.me/${botName}?start=proofs_${fbId2}` }]] }
    }).catch(async () => {
      await tg.call("sendMessage", { chat_id: q.message.chat.id, text: `📎 Schreibe dem Bot privat um deine Beweise einzureichen. Wenn fertig: /done`, parse_mode: "HTML" });
    });
    await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "📎 Bitte sende Proofs dem Bot privat." });
    return;
  }

  if (data.startsWith("fb_no_proof_")) {
    const npm = data.match(/^fb_no_proof_(-?\d+)_(-?\d+)_(-?\d+)$/);
    if (!npm || String(qUserId) !== npm[2]) {
      await tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Nicht für dich.", show_alert: true });
      return;
    }
    const [, fbId3, , chanId5] = npm;
    try {
      const { data: fbRow } = await supabase_db.from("user_feedbacks").select("feedback_type, target_user_id, target_username").eq("id", fbId3).maybeSingle();
      if (fbRow) {
        const ch5 = await getChannel(chanId5);
        await safelistService.approveFeedback(parseInt(fbId3), qUserId, ch5);
        if (fbRow.target_user_id) {
          const delta = fbRow.feedback_type === "positive" ? 1 : -10;
          await supabase_db.rpc("update_user_reputation", {
            p_channel_id: chanId5, p_user_id: fbRow.target_user_id,
            p_username: fbRow.target_username, p_delta: delta
          }).catch(() => {});
        }
        if (fbRow.feedback_type === "negative" && fbRow.target_user_id) {
          await supabase_db.from("scam_entries").upsert([{
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
        await supabase_db.rpc("update_user_reputation", {
          p_channel_id: chanId6, p_user_id: parseInt(targetId) || 0,
          p_username: targetU, p_delta: delta6
        }).catch(() => {});
        if (fbType === "negative") {
          await supabase_db.from("scam_entries").upsert([{
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
    const ch2 = {}; 
    if (data.startsWith("fb_approve_")) {
      await safelistService.approveFeedback(feedbackId, qUserId, ch2);
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "✅ Meldung bestätigt. User wurde auf Scamliste gesetzt." });
    } else {
      await safelistService.rejectFeedback(feedbackId, qUserId);
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Meldung abgelehnt." });
    }
    return;
  }

  const chData = await getChannel(qChatId);
  await tgAdminHelper.handleCallback(token, q, chData);
}

module.exports = { handle };
