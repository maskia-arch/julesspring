const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const safelistService = require("./safelistService");
const { tgAdminHelper } = require("./tgAdminHelper");
const settingsHandler = require("./settingsHandler");
const packageService = require("../packageService");
const { toGermanDateTime } = require("../../utils/telegramFormatter");

const pendingInputs = global.pendingInputs = global.pendingInputs || {};

/**
 * Extrahiert Klartext aus Telegram-HTML (gespeicherte Texte mit <tg-emoji>, <b>, etc.)
 * Diese dürfen NICHT direkt in weitere HTML-Tags gewickelt werden → 400 Fehler.
 */
function _stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}


async function _getBotUsername(tg, supabase_db, settings) {
  const fromDb = settings?.smalltalk_bot_username || settings?.bot_username;
  if (fromDb && fromDb.length > 2) return fromDb;
  try {
    const me = await tg.call("getMe", {});
    if (me?.username) {
      void supabase_db.from("settings")
        .update({ smalltalk_bot_username: me.username }).eq("id", 1)
        .then(() => {}, () => {});
      return me.username;
    }
  } catch (_) {}
  return settings?.bot_name || "AIAdminHelperx1_bot";
}

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

exports.handle = async function handle(tg, supabase_db, q, token, settings) {
  const qChatId = String(q.message?.chat?.id || "");
  const qUserId = q.from?.id;
  const data = q.data || "";

  let answered = false;
  const answerCb = async (opts = {}) => {
    if (answered) return;
    answered = true;
    return tg.call("answerCallbackQuery", { callback_query_id: q.id, ...opts }).catch(() => {});
  };

  if (data === "cfg_noop") {
    return answerCb();
  }

  // ── (1.6.76) Diss Battle Buttons im Original-Channel ──────────────────────
  if (data.startsWith("dissjoin_")) {
    const battleId = parseInt(data.substring("dissjoin_".length));
    if (!Number.isFinite(battleId)) return answerCb({ text: "❌ Ungültig.", show_alert: true });
    const dissBattle = require("./dissBattleService");
    await dissBattle.handleJoinClick(tg, supabase_db, battleId, q.from, q.id);
    answered = true;
    return;
  }

  if (data.startsWith("disscancel_")) {
    const battleId = parseInt(data.substring("disscancel_".length));
    if (!Number.isFinite(battleId)) return answerCb({ text: "❌ Ungültig.", show_alert: true });
    const dissBattle = require("./dissBattleService");
    await dissBattle.handleCancelClick(tg, supabase_db, battleId, q.from, q.id);
    answered = true;
    return;
  }

  if (data.startsWith("uinfo_sangmata_")) {
    const targetId = data.split("_")[2];
    await answerCb();
    
    const botName = "SangMata_BOT";
    const cmdText = `<code>/allhistory ${targetId}</code>`;
    
    await tg.call("sendMessage", { 
      chat_id: qChatId, 
      text: `🔍 <b>SangMata Namenshistorie</b>\n\nKopiere diesen Befehl (durch Antippen) und sende ihn direkt an den SangMata Bot:\n\n${cmdText}`, 
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "💬 Zu @SangMata_BOT wechseln", url: `https://t.me/${botName}` }]] }
    });
    return;
  }

  if (data.startsWith("uinfo_names_")) {
    const targetId = data.split("_")[2];
    const { data: history } = await supabase_db.from("user_name_history").select("*").eq("user_id", targetId).order("detected_at", { ascending: false }).limit(10);
    if (!history?.length) {
      return answerCb({ text: "❌ Keine Namenshistorie gefunden.", show_alert: true });
    }
    await answerCb();
    const list = history.map(h => `• ${new Date(h.detected_at).toLocaleDateString("de-DE")}: ${h.first_name||""} ${h.last_name||""} ${h.username?"(@"+h.username+")":""}`).join("\n");
    await tg.call("sendMessage", { chat_id: qChatId, text: `📜 <b>Namenshistorie für <code>${targetId}</code></b>\n\n${list}`, parse_mode: "HTML" });
    return;
  }

  if (data.startsWith("settings_here_") || data.startsWith("settings_private_")) {
    const parts = data.split("_");
    const sendPriv = data.startsWith("settings_private_");
    const targetChannelId = parts[2];
    const ownerId = parts[3] ? parseInt(parts[3]) : null;

    if (sendPriv && ownerId && qUserId !== ownerId) return answerCb({ text: "❌ Nur für den Befehlsausführer.", show_alert: true });
    if (!await isGroupAdmin(tg, targetChannelId, qUserId)) return answerCb({ text: "❌ Keine Berechtigung.", show_alert: true });

    const ch = await getChannel(targetChannelId);
    if (ch && ch.is_active === false) {
      return answerCb({ text: "⚠️ Dein Channel/Gruppe wurde deaktiviert, melde dich bei @autoacts", show_alert: true });
    }

    await answerCb();
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});

    const sendTarget = sendPriv ? String(qUserId) : targetChannelId;
    await settingsHandler.sendSettingsMenu(tg, sendTarget, targetChannelId, ch, null);
    return;
  }

  if (data.startsWith("fb_mgr_user_")) {
    const channelId = data.split("_").pop();
    await answerCb();
    pendingInputs[String(qUserId)] = { action: "fb_mgr_await_user", channelId: channelId };
    await tg.call("sendMessage", { 
      chat_id: String(qUserId), 
      text: "👤 <b>User-Feedbacks verwalten</b>\n\nSende mir den <b>@username</b> oder die <b>Telegram-ID</b> des Users, dessen Feedbacks du verwalten oder löschen möchtest.\n\n/cancel zum Abbrechen", 
      parse_mode: "HTML" 
    });
    return;
  }

  if (data.startsWith("fb_mgr_del_")) {
    const parts = data.split("_");
    const channelId = parts.pop();
    const feedbackId = parts.pop();
    await answerCb();
    if (safelistService.deleteFeedback) {
      await safelistService.deleteFeedback(channelId, feedbackId);
      await tg.call("sendMessage", { chat_id: String(qUserId), text: `✅ Feedback mit der ID ${feedbackId} wurde gelöscht. Der Trust Score wurde neu berechnet.` });
    }
    return;
  }

  if (data.startsWith("fb_mgr_reset_")) {
    const parts = data.split("_");
    const channelId = parts.pop();
    const targetUser = parts.slice(3).join("_");
    await answerCb();
    if (safelistService.resetUserReputation) {
      await safelistService.resetUserReputation(channelId, targetUser);
      await tg.call("sendMessage", { chat_id: String(qUserId), text: `✅ <b>Erfolg:</b> Alle Feedbacks, Safelist- und Scamlist-Einträge für ${targetUser} wurden restlos gelöscht.\nDer Score wurde auf 0 zurückgesetzt.`, parse_mode: "HTML" });
    }
    return;
  }

  if (data.startsWith("fb_confirm_")) {
    const parts = data.split("_");
    const chanId3 = parts.pop();
    const submitterId = parts.pop();
    const fbType = parts[2];
    const targetUname = parts.slice(3).join("_");

    if (String(qUserId) !== String(submitterId)) {
      return answerCb({ text: "❌ Nur der Verfasser darf das auswählen.", show_alert: true });
    }

    if (fbType === "no") {
      await answerCb();
      await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    const ch = await getChannel(chanId3);
    if (!ch || !ch.is_approved || ch.is_active === false) {
      await answerCb({ text: "❌ Kanal ist nicht verifiziert oder deaktiviert.", show_alert: true });
      await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    await answerCb();
    await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});

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
    } catch (e) {
      logger && logger.warn?.(`[Feedback] submitFeedback Fehler: ${e.message}`);
    }

    if (!fbId) {
      await tg.call("sendMessage", {
        chat_id: q.message.chat.id, parse_mode: "HTML",
        text: `❌ <b>Feedback konnte nicht gespeichert werden.</b>\n\nBitte versuche es nochmal.`
      }).catch(() => {});
      return;
    }

    // Proof-Frage in der GRUPPE (1.6.13+)
    const proofKb = [[
      { text: "📎 Ja, Proofs senden", callback_data: `fb_want_proof_${fbId}_${submitterId}_${chanId3}` },
      { text: "✌️ Nein, reicht mir",  callback_data: `fb_no_proof_${fbId}_${submitterId}_${chanId3}` }
    ]];
    const proofMsg = await tg.call("sendMessage", {
      chat_id:      q.message.chat.id,
      text:         feedbackType === "positive"
        ? `✅ <b>Positives Feedback</b> für @${targetUname} gespeichert!\n\nMöchtest du Beweise/Screenshots als Proof beifügen?`
        : `⚠️ <b>Negatives Feedback</b> für @${targetUname} gespeichert.\n\nNegative Feedbacks ohne Proof werden oft nicht berücksichtigt. Möchtest du Beweise beifügen?`,
      parse_mode:   "HTML",
      reply_markup: { inline_keyboard: proofKb }
    }).catch(() => null);

    if (proofMsg?.message_id) {
      void safelistService.trackBotMessage(q.message.chat.id, proofMsg.message_id, "temp", 5*60*1000);
    }
    return;
  }

  if (data.startsWith("sched_opt_")) {
    const parts2 = data.split("_");
    const subOpt = parts2[2];
    const chanId2 = parts2[3];
    const key = String(qUserId);
    if (pendingInputs[key]) {
      if (subOpt === "pin") pendingInputs[key].pinAfterSend = !pendingInputs[key].pinAfterSend;
      if (subOpt === "delprev") pendingInputs[key].deletePrevious = !pendingInputs[key].deletePrevious;
    }
    await answerCb({ text: subOpt === "pin" ? "📌 Anpinnen geändert" : "🔄 Löschen geändert" });
    
    const p2 = pendingInputs[key] || {};
    const pinOpt2 = "📌 Anpinnen: " + (p2.pinAfterSend ? "✅" : "❌");
    const delPrevOpt2 = "🔄 Vorherige löschen: " + (p2.deletePrevious ? "✅" : "❌");
    await tg.call("editMessageReplyMarkup", {
      chat_id: String(qUserId), message_id: q.message?.message_id,
      reply_markup: { inline_keyboard: [
        [{ text: pinOpt2, callback_data: "sched_opt_pin_" + chanId2 }, { text: delPrevOpt2, callback_data: "sched_opt_delprev_" + chanId2 }],
        [{ text: "✅ Nachricht jetzt einplanen", callback_data: "sched_save_final_" + chanId2 }],
        [{ text: "❌ Abbrechen", callback_data: `cfg_back_${chanId2}` }]
      ]}
    }).catch(() => {});
    return;
  }

  if (data.startsWith("sched_save_final_")) {
    await answerCb();
    const chanId2 = data.split("_")[3];
    const wizard = pendingInputs[String(qUserId)];
    
    if (!wizard || !wizard.action.startsWith("sched_wizard")) return;
    delete pendingInputs[String(qUserId)];

    const isRepeat = !!wizard.intervalMinutes;

    try {
      // message enthält bereits konvertiertes HTML (Premium-Emojis als <tg-emoji>)
      const insertData = {
        channel_id:       chanId2,
        message:          wizard.msgText || "",
        photo_file_id:    wizard.fileId  || null,
        file_type:        wizard.fileType || null,
        cron_expr:        null,
        interval_minutes: wizard.intervalMinutes || null,
        end_at:           wizard.endAt    || null,
        next_run_at:      wizard.nextRunAt || new Date().toISOString(),
        repeat:           isRepeat,
        is_active:        true,
        pin_after_send:   wizard.pinAfterSend   || false,
        delete_previous:  wizard.deletePrevious || false
      };
      // inline_buttons nur wenn Migration bereits ausgeführt
      if (wizard.inlineButtons) insertData.inline_buttons = wizard.inlineButtons;

      let { error: insertError } = await supabase_db.from("scheduled_messages").insert([insertData]);

      // Fallback: inline_buttons entfernen wenn Spalte fehlt
      if (insertError && /column/i.test(String(insertError.message || ""))) {
        delete insertData.inline_buttons;
        const r2 = await supabase_db.from("scheduled_messages").insert([insertData]);
        insertError = r2.error;
      }

      if (insertError) throw insertError;

      const dt = wizard.nextRunAt ? toGermanDateTime(wizard.nextRunAt) : "sofort";
      let repeatLabel = "einmalig";
      if (wizard.intervalMinutes) {
        repeatLabel = wizard.intervalMinutes >= 60 ? `alle ${wizard.intervalMinutes/60}h` : `alle ${wizard.intervalMinutes}m`;
      }
      const endLabel = wizard.endAt ? `\n🏁 Endet: ${toGermanDateTime(wizard.endAt)}` : "";
      // Klartext-Vorschau: HTML-Tags entfernen damit keine Tag-Verschachtelung → 400 vermeiden
      const previewTxt = _stripHtml(wizard.msgText || "").substring(0, 60) || "(kein Text)";
      const confirmTxt =
        `✅ <b>Geplante Nachricht gespeichert!</b>\n\n` +
        `📝 Text: ${previewTxt}${wizard.fileId ? "\n📎 Medien: ✅" : ""}\n` +
        `📅 Start: ${dt}\n🔁 Wiederholung: ${repeatLabel}${endLabel}`;
      const confirmKb = { inline_keyboard: [[{ text: "◀️ Zurück zu Wiederholungen", callback_data: `cfg_repeat_${chanId2}` }]] };

      await tg.call("editMessageText", {
        chat_id: String(qUserId), message_id: q.message?.message_id,
        text: confirmTxt, parse_mode: "HTML", reply_markup: confirmKb
      }).catch(async () => {
        await tg.call("sendMessage", {
          chat_id: String(qUserId), text: confirmTxt, parse_mode: "HTML", reply_markup: confirmKb
        }).catch(e => logger.warn(`[sched_save] Bestätigung fehlgeschlagen: ${e.message}`));
      });
    } catch (e2) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Fehler beim Speichern der geplanten Nachricht:\n" + e2.message });
      logger.error("[Schedule Save Error]", e2.message);
    }
    return;
  }

  if (data.startsWith("refill_chan_")) {
    await answerCb();
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
      await tg.call("sendMessage", { chat_id: String(qUserId), text: `🔋 Refill-Optionen für "${chStat?.title||refChanId}":`, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    });
    return;
  }

  if (data.startsWith("refill_opt_")) {
    await answerCb();
    const roMatch = data.match(/^refill_opt_(\d+)_(-?\d+)$/);
    if (!roMatch) return;
    const refillId = parseInt(roMatch[1]);
    const roChanId = roMatch[2];
    delete pendingInputs[String(qUserId)];
    
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
    const { data: refill } = await (async () => { try { return await supabase_db.from("channel_refills").select("*").eq("id", refillId).single(); } catch { return { data: null }; } })();
    if (!refill) { await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Refill nicht gefunden." }); return; }
    
    await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });
    try {
      const result = await packageService.generateRefillUrl(refill, roChanId);
      if (result.checkoutUrl) {
        await tg.call("sendMessage", { chat_id: String(qUserId),
          text: `🔋 <b>${refill.name}</b>\n\n+${refill.credits.toLocaleString()} Credits\n💰 ${parseFloat(refill.price_eur).toFixed(2)} €\n\nCredits werden sofort nach Zahlung gutgeschrieben.`,
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt nachladen", url: result.checkoutUrl }]] }
        });
      }
    } catch (e2) { await tg.call("sendMessage", { chat_id: String(qUserId), text: `❌ Refill fehlgeschlagen:\n<i>${e2.message}</i>`, parse_mode: "HTML" }); }
    return;
  }

  if (data.startsWith("buy_chan_")) {
    await answerCb();
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
    const pkgKb = activePkgs.map(p => [{ text: `📦 ${p.name} — ${p.credits.toLocaleString()} Credits · ${parseFloat(p.price_eur).toFixed(2)} €`, callback_data: "buy_pkg_" + p.id + "_" + buyChanId }]);
    pkgKb.push([{ text: "❌ Abbrechen", callback_data: "buy_cancel" }]);
    
    const chTitle = (await supabase_db.from("bot_channels").select("title").eq("id", buyChanId).maybeSingle()).data?.title || buyChanId;
    await tg.call("editMessageText", { chat_id: String(qUserId), message_id: q.message?.message_id, text: `🛒 <b>Paket für "${chTitle}" wählen:</b>\n\nAlle Pakete laufen 30 Tage.`, parse_mode: "HTML", reply_markup: { inline_keyboard: pkgKb } }).catch(async () => {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: `🛒 <b>Paket für "${chTitle}" wählen:</b>\n\nAlle Pakete laufen 30 Tage.`, parse_mode: "HTML", reply_markup: { inline_keyboard: pkgKb } });
    });
    return;
  }

  if (data.startsWith("buy_pkg_")) {
    await answerCb();
    const parts4 = data.match(/^buy_pkg_(\d+)_(-?\d+)$/);
    if (!parts4) return;
    const pkgId = parseInt(parts4[1]);
    const chanId4 = parts4[2];
    delete pendingInputs[String(qUserId)];

    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
    const { data: pkg } = await (async () => { try { return await supabase_db.from("channel_packages").select("*").eq("id", pkgId).single(); } catch { return { data: null }; } })();
    if (!pkg) { await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Paket nicht gefunden." }); return; }

    await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });
    try {
      const result = await packageService.generateCheckoutUrl(pkg, chanId4);
      if (result.checkoutUrl) {
        await tg.call("sendMessage", { chat_id: String(qUserId),
          text: `✅ <b>${pkg.name} — ${pkg.credits.toLocaleString()} Credits</b>\n\n💰 Preis: ${parseFloat(pkg.price_eur).toFixed(2)} €\n📅 Laufzeit: ${pkg.duration_days || 30} Tage <i>(ab Kaufdatum)</i>\nℹ️ Während dein Paket läuft, kannst du Refills als Notfall-Vorrat kaufen.\n\nZum Bezahlen tippst du auf den Button:`,
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt kaufen", url: result.checkoutUrl }]] }
        });
      }
    } catch (e2) { await tg.call("sendMessage", { chat_id: String(qUserId), text: `❌ Checkout fehlgeschlagen:\n<i>${e2.message}</i>`, parse_mode: "HTML" }); }
    return;
  }

if (data === "buy_cancel") {
    await answerCb();
    await tg.call("deleteMessage", { chat_id: String(qUserId), message_id: q.message?.message_id }).catch(() => {});
    delete pendingInputs[String(qUserId)];
    return;
  }

  // ─── DONATE: User aus Gruppe spendiert dem Channel ein Paket ────────
  // callback_data Format: donate_pkg_<pkgId>_<channelId>_<donorUserId>
  if (data.startsWith("donate_pkg_")) {
    await answerCb();
    const dParts = data.match(/^donate_pkg_(\d+)_(-?\d+)_(\d+)$/);
    if (!dParts) return;
    const dPkgId = parseInt(dParts[1]);
    const dChanId = dParts[2];
    const dDonorId = dParts[3];

    if (String(qUserId) !== String(dDonorId)) {
      return answerCb({ text: "❌ Dieser Button gehört nicht dir.", show_alert: true });
    }

    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});

    let pkg = null;
    try {
      const { data: p } = await supabase_db.from("channel_packages").select("*").eq("id", dPkgId).single();
      pkg = p;
    } catch (_) {}
    if (!pkg) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Paket nicht gefunden." });
      return;
    }

    let dChannel = null;
    try {
      const { data } = await supabase_db.from("bot_channels")
        .select("id, title, is_active").eq("id", String(dChanId)).maybeSingle();
      dChannel = data;
    } catch (_) {}
    if (!dChannel || dChannel.is_active === false) {
      await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Channel nicht (mehr) verfügbar." });
      return;
    }

    await tg.call("sendMessage", { chat_id: String(qUserId), text: "⏳ Erstelle Checkout…" });
    try {
      const result = await packageService.generateDonationUrl(pkg, dChanId, qUserId);
      if (result?.checkoutUrl) {
        const chTitle = dChannel.title || `Channel ${dChanId}`;
        await tg.call("sendMessage", {
          chat_id: String(qUserId),
          text: `❤️ <b>Spende für „${chTitle}"</b>\n\n📦 ${pkg.name} — ${pkg.credits.toLocaleString()} Credits\n💰 Preis: ${parseFloat(pkg.price_eur).toFixed(2)} €\n\nNach erfolgreicher Bezahlung werden die Credits automatisch dem Channel gutgeschrieben — sie werden auf das bestehende Guthaben aufaddiert.\n\nKlick auf den Button zum Bezahlen:`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt spendieren", url: result.checkoutUrl }]] }
        });
      }
    } catch (e) {
      await tg.call("sendMessage", {
        chat_id: String(qUserId),
        text: `❌ Checkout fehlgeschlagen:\n<i>${e.message || String(e)}</i>`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  if (data.startsWith("donate_cancel_")) {
    const cParts = data.match(/^donate_cancel_(\d+)$/);
    const cDonorId = cParts ? cParts[1] : null;
    if (cDonorId && String(qUserId) !== String(cDonorId)) {
      return answerCb({ text: "❌ Nicht für dich.", show_alert: true });
    }
    await answerCb({ text: "Abgebrochen." });
    await tg.call("deleteMessage", { chat_id: String(qUserId), message_id: q.message?.message_id }).catch(() => {});
    return;
  }

  if (data.startsWith("sel_channel_")) {
    const selChanId = data.split("_")[2];
    const ch = await getChannel(selChanId);
    if (ch && ch.is_active === false) {
      return answerCb({ text: "⚠️ Dein Channel/Gruppe wurde deaktiviert, melde dich bei @autoacts", show_alert: true });
    }
    await answerCb();
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
    await settingsHandler.sendSettingsMenu(tg, String(qUserId), selChanId, ch, null);
    return;
  }

  // ── Wizard-Skip-Button: simuliert /skip für alle Wizard-Schritte ────────────
  if (data.startsWith("cfg_skip_wiz_")) {
    await answerCb();
    const wizard = pendingInputs[String(qUserId)];
    if (!wizard) return;
    const inputWizardHandler = require("./inputWizardHandler");
    await inputWizardHandler.handle(tg, supabase_db, qUserId, "/skip", settings, {
      ...q.message,
      text: "/skip",
      from: q.from
    });
    return;
  }

  if (data.startsWith("cfg_")) {
    const parts = data.split("_");
    const channelId = parts[parts.length - 1];
    const ch = await getChannel(channelId);
    if (ch && ch.is_active === false) {
      return answerCb({ text: "⚠️ Dein Channel/Gruppe wurde deaktiviert, melde dich bei @autoacts", show_alert: true });
    }
    await answerCb();
    await settingsHandler.handleSettingsCallback(tg, supabase_db, data, q, qUserId);
    return;
  }

  if (data.startsWith("fb_want_proof_")) {
    const parts = data.split("_");
    const chanId4 = parts.pop();
    const submitterId = parts.pop();
    const fbId2 = parts.pop();

    if (String(qUserId) !== String(submitterId)) {
      return answerCb({ text: "❌ Nicht für dich.", show_alert: true });
    }
    
    const ch4 = await getChannel(chanId4);
    if (!ch4 || !ch4.is_approved || ch4.is_active === false) {
      await answerCb({ text: "❌ Kanal ist nicht verifiziert oder deaktiviert.", show_alert: true });
      await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
      return;
    }

    await answerCb();
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
    
    try {
      await supabase_db.from("proof_sessions").insert([{ feedback_id: parseInt(fbId2), user_id: parseInt(qUserId), channel_id: chanId4, status: "collecting" }]);
    } catch (_) {}
    
    pendingInputs[String(qUserId)] = { action: "collecting_proofs", feedbackId: fbId2, channelId: chanId4, proofCount: 0 };
    const botName = await _getBotUsername(tg, supabase_db, settings);

    // Zuerst versuchen direkt in Privatchat zu senden
    const privMsg = await tg.call("sendMessage", {
      chat_id: String(qUserId),
      text: `📎 <b>Proofs einreichen</b>\n\nSende deine Beweise hier direkt (Fotos, Videos, Screenshots, Text).\n\nWenn du fertig bist: /done\nAbbrechen: /cancel`,
      parse_mode: "HTML"
    }).catch(() => null);

    if (privMsg) {
      // Bestätigung in Gruppe
      await tg.call("sendMessage", {
        chat_id: qChatId,
        text: `📎 @${q.from?.username || qUserId}: Proofs werden im Privatchat des Bots eingereicht.`,
        parse_mode: "HTML"
      }).catch(() => null);
    } else {
      // User hat Bot noch nicht gestartet → Deep-Link
      await tg.call("sendMessage", {
        chat_id: qChatId,
        text: `📎 Um Proofs einzureichen, starte den Bot zuerst privat:`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "💬 Bot starten & Proofs senden", url: `https://t.me/${botName}?start=proofs_${fbId2}` }]] }
      }).catch(() => null);
    }
    return;
  }

  if (data === "proof_done_btn") {
    await answerCb();
    const inputWizardHandler = require("./inputWizardHandler");
    await inputWizardHandler.handle(tg, supabase_db, qUserId, "/done", settings, q.message);
    return;
  }

  if (data.startsWith("fb_no_proof_")) {
    const parts = data.split("_");
    const chanId5     = parts.pop();
    const submitterId = parts.pop();
    const fbId3       = parts.pop();

    if (String(qUserId).trim() !== String(submitterId).trim()) {
      return answerCb({ text: "❌ Nicht für dich.", show_alert: true });
    }

    const ch5 = await getChannel(chanId5);
    if (!ch5 || !ch5.is_approved || ch5.is_active === false) {
      await answerCb({ text: "❌ Kanal ist nicht verifiziert oder deaktiviert.", show_alert: true });
      await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
      return;
    }

    await answerCb();
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});

    // Feedback aus DB laden — mit Fehler-Logging
    let fbRow = null;
    try {
      const { data: fbData, error: fbErr } = await supabase_db
        .from("user_feedbacks")
        .select("id, feedback_type, target_user_id, target_username, feedback_text, submitted_by")
        .eq("id", fbId3)
        .maybeSingle();
      if (fbErr) {
        logger.warn(`[Feedback] fb_no_proof: DB-Fehler beim Laden von ID ${fbId3}: ${fbErr.message}`);
      }
      fbRow = fbData;
    } catch (e) {
      logger.warn(`[Feedback] fb_no_proof: Exception beim Laden: ${e.message}`);
    }

    if (!fbRow) {
      // Feedback existiert nicht mehr — trotzdem dem User antworten
      await tg.call("sendMessage", {
        chat_id: String(submitterId), parse_mode: "HTML",
        text: "⚠️ Feedback wurde bereits verarbeitet oder ist nicht mehr vorhanden."
      }).catch(() => {});
      return;
    }

    const isPos = fbRow.feedback_type === "positive";

    // Auto-Approve prüfen
    const autoApprove = isPos
      ? await safelistService.hasHighReputation(chanId5, fbRow.target_username, fbRow.target_user_id).catch(() => false)
      : false;

    if (autoApprove) {
      await safelistService.approveFeedback(fbId3, qUserId, ch5);
      await tg.call("sendMessage", {
        chat_id: String(submitterId), parse_mode: "HTML",
        text: "✅ Positives Feedback wurde automatisch bestätigt (Trusted User)!"
      }).catch(() => {});
      return;
    }

    // Admin + Co-Admins benachrichtigen
    let chAdmin = null;
    try {
      const { data } = await supabase_db.from("bot_channels")
        .select("added_by_user_id, title").eq("id", String(chanId5)).maybeSingle();
      chAdmin = data;
    } catch (e) {
      logger.warn(`[Feedback] fb_no_proof: Admin-Lookup Fehler: ${e.message}`);
    }

    const emoji = isPos ? "✅" : "⚠️";
    const adminNotifyPayload = {
      parse_mode: "HTML",
      text:
        `📋 <b>Neues Feedback zur Prüfung</b>\n\n` +
        `Channel: <b>${chAdmin?.title || chanId5}</b>\n` +
        `ID: <code>${fbId3}</code>\n` +
        `Ziel: @${fbRow.target_username || fbRow.target_user_id}\n` +
        `Von: @${q.from?.username || qUserId}\n` +
        `Typ: ${emoji} ${isPos ? "Positiv" : "Negativ"}\n\n` +
        (fbRow.feedback_text ? `<i>${fbRow.feedback_text.substring(0, 200)}</i>` : "<i>(Kein Text)</i>"),
      reply_markup: { inline_keyboard: [[
        { text: "✅ Bestätigen", callback_data: `fb_approve_${fbId3}` },
        { text: "❌ Ablehnen",   callback_data: `fb_reject_${fbId3}` }
      ]]}
    };

    // Owner
    if (chAdmin?.added_by_user_id) {
      await tg.call("sendMessage", {
        chat_id: String(chAdmin.added_by_user_id), ...adminNotifyPayload
      }).catch(e => logger.warn(`[Feedback] Owner-Notify Fehler: ${e.message}`));
    } else {
      logger.warn(`[Feedback] fb_no_proof: Kein Owner für Channel ${chanId5} gefunden!`);
    }

    // Co-Admins
    try {
      const { data: coAdmins } = await supabase_db.from("channel_co_admins")
        .select("user_id").eq("channel_id", String(chanId5));
      for (const ca of (coAdmins || [])) {
        if (String(ca.user_id) !== String(chAdmin?.added_by_user_id)) {
          await tg.call("sendMessage", {
            chat_id: String(ca.user_id), ...adminNotifyPayload
          }).catch(() => {});
        }
      }
    } catch (_) {}

    // Bestätigung an Verfasser (im Privatchat, nicht Gruppe)
    await tg.call("sendMessage", {
      chat_id: String(submitterId), parse_mode: "HTML",
      text: "✅ Feedback gespeichert und zur Admin-Prüfung weitergeleitet."
    }).catch(() => {});

    return;
  }

  if (data.startsWith("fb_manual_pos_") || data.startsWith("fb_manual_neg_")) {
    const parts = data.split("_");
    const chanId6 = parts.pop();
    const targetId = parts.pop();
    const fbType = parts[2];
    const targetU = parts.slice(3).join("_");
    
    const ch6 = await getChannel(chanId6);
    if (!ch6 || !ch6.is_approved || ch6.is_active === false) {
      await answerCb({ text: "❌ Kanal ist nicht verifiziert oder deaktiviert.", show_alert: true });
      await tg.call("deleteMessage", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    await answerCb();
    try {
      const fbR = await safelistService.submitFeedback({
        channelId: chanId6, submittedBy: qUserId, submittedByUsername: q.from?.username || null,
        targetUsername: targetU, targetUserId: parseInt(targetId) || null, feedbackType: fbType, feedbackText: "Manuell eingetragen (Admin)"
      });
      if (fbR?.id) {
        await safelistService.approveFeedback(fbR.id, qUserId, ch6);
      }
    } catch (_) {}
    await tg.call("editMessageText", { chat_id: String(qUserId), message_id: q.message.message_id, text: `${fbType === "positive" ? "✅ Positives" : "⚠️ Negatives"} Feedback für @${targetU} manuell eingetragen.`, parse_mode: "HTML" }).catch(() => {});
    return;
  }

  if (data.startsWith("fb_approve_") || data.startsWith("fb_reject_")) {
    const feedbackId = data.split("_")[2];
    
    const { data: fbData } = await supabase_db.from("user_feedbacks").select("channel_id").eq("id", feedbackId).maybeSingle();
    if (fbData) {
      const chFb = await getChannel(fbData.channel_id);
      if (!chFb || !chFb.is_approved || chFb.is_active === false) {
        await answerCb({ text: "❌ Kanal ist nicht verifiziert oder deaktiviert.", show_alert: true });
        await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});
        return;
      }
    }

    await answerCb();
    await tg.call("deleteMessage", { chat_id: qChatId, message_id: q.message?.message_id }).catch(() => {});

    // ch2 = echter Channel (nicht leeres Objekt!) damit approveFeedback korrekt arbeitet
    const ch2 = fbData ? (await getChannel(fbData.channel_id)) || {} : {};

    if (data.startsWith("fb_approve_")) {
      await safelistService.approveFeedback(feedbackId, qUserId, ch2);
      await tg.call("sendMessage", { chat_id: String(qUserId), parse_mode: "HTML",
        text: `✅ <b>Feedback bestätigt</b> (ID: <code>${feedbackId}</code>)\n\nReputation des Users wurde aktualisiert.` }).catch(() => {});
    } else {
      await safelistService.rejectFeedback(feedbackId, qUserId);
      await tg.call("sendMessage", { chat_id: String(qUserId), parse_mode: "HTML",
        text: `❌ <b>Feedback abgelehnt</b> (ID: <code>${feedbackId}</code>)` }).catch(() => {});
    }
    return;
  }

  const chData = await getChannel(qChatId);
  if (q.message?.chat?.type !== "private" && chData && chData.is_active === false) {
    return answerCb({ text: "❌ Kanal ist deaktiviert.", show_alert: true });
  }

  if (q.data && (q.data.startsWith("admin_") || q.data.startsWith("del_safelist_") || q.data.startsWith("safelist_del_"))) {
     const parts = q.data.split("_");
     const extractedChannelId = parts[parts.length - 1];
     if (extractedChannelId && extractedChannelId.startsWith("-")) {
         q.extractedChannelId = extractedChannelId;
     }
  }
  
  await answerCb();
  await tgAdminHelper.handleCallback(token, q, chData);
};
