const axios = require("axios");
const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const safelistService = require("./safelistService");
const userInfoService = require("./userInfoService");
const { entitiesToHtml } = require("../../utils/telegramFormatter");

/**
 * Parst Inline-Button-Definitionen aus User-Text.
 * Format pro Zeile: "Button Text | https://link.de"
 * Leere Zeilen werden ignoriert. /skip → leeres Markup.
 * @returns {object|null} Telegram inline_keyboard Markup oder null
 */
function _parseInlineButtons(text) {
  if (!text || text === "/skip") return null;
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const btns = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)\s*$/);
    if (m) btns.push({ text: m[1].trim(), url: m[2].trim() });
  }
  const chunked = [];
  for (let i = 0; i < btns.length; i += 2) {
    chunked.push(btns.slice(i, i + 2));
  }
  return chunked.length ? { inline_keyboard: chunked } : null;
}

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function _getRepeatCount(channelId) {
  try {
    const { data } = await supabase.from("scheduled_messages").select("id").eq("channel_id", String(channelId)).eq("is_active", true).eq("repeat", true);
    return data?.length || 0;
  } catch { return 0; }
}

async function nextStep(tg, userId, pending, text, kb = []) {
  const params = { chat_id: String(userId), text, parse_mode: "HTML" };
  if (kb.length) params.reply_markup = { inline_keyboard: kb };

  if (pending.wizardMsgId) {
    params.message_id = pending.wizardMsgId;
    const res = await tg.call("editMessageText", params).catch(() => null);
    if (res?.message_id) return res.message_id;
  }
  delete params.message_id;
  const res = await tg.call("sendMessage", params).catch(() => null);
  return res?.message_id || pending.wizardMsgId;
}

/**
 * Konvertiert DE-Datum/Zeit korrekt in UTC (berücksichtigt MEZ/MESZ).
 */
function _parseGermanDateTime(day, month, year, hour, minute) {
  try {
    // Ermittle aktuellen Berlin-Offset per Intl
    const probe = new Date(Date.UTC(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hour), parseInt(minute)));
    const de  = probe.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour12: false });
    const utc = probe.toLocaleString('de-DE', { timeZone: 'UTC',           hour12: false });
    const dh  = parseInt((de.match(/(\d+):(\d+)/)  || [])[1] || 0);
    const uh  = parseInt((utc.match(/(\d+):(\d+)/) || [])[1] || 0);
    let diff = dh - uh;
    if (diff > 12) diff -= 24; if (diff < -12) diff += 24;
    // DE-Eingabe zu UTC: subtract offset
    const naive = new Date(Date.UTC(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hour), parseInt(minute)));
    return new Date(naive.getTime() - diff * 3600000).toISOString();
  } catch (_) {}
  return new Date(parseInt(year), parseInt(month)-1, parseInt(day), parseInt(hour), parseInt(minute)).toISOString();
}

async function handle(tg, supabase_db, userId, text, settings, msg) {
  const pending = global.pendingInputs[String(userId)];
  if (!pending) return false;

  if (msg?.message_id) {
    await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
  }

  if (text === "/cancel") {
    delete global.pendingInputs[String(userId)];
    await nextStep(tg, userId, pending, "❌ Abgebrochen.", [[{ text: "◀️ Zurück zum Menü", callback_data: `cfg_back_${pending.channelId||"0"}` }]]);
    return true;
  }

  const { action, channelId, entryId, targetUsername } = pending;



  // ── Blacklist Enhancer: Worttyp-Eingabe ──────────────────────────────────
  if (action === "bl_enhancer_type") {
    const wordType  = (msg?.text || text || "").trim();
    const channelId = pending.channelId;
    if (!wordType || wordType.length < 3 || wordType.startsWith("/cancel")) {
      delete global.pendingInputs[String(userId)];
      return true;
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "bl_enhancer_run_wait", blWordType: wordType };
    await nextStep(tg, userId, pending,
      `✨ <b>Worttyp:</b> <i>${wordType}</i>\n\nWieviele Wörter soll Grok vorschlagen?`,
      [
        [{ text: "10 Wörter", callback_data: `cfg_bl_enhancer_run_10_${channelId}` },
         { text: "20 Wörter", callback_data: `cfg_bl_enhancer_run_20_${channelId}` }],
        [{ text: "30 Wörter", callback_data: `cfg_bl_enhancer_run_30_${channelId}` },
         { text: "50 Wörter", callback_data: `cfg_bl_enhancer_run_50_${channelId}` }],
        [{ text: "❌ Abbrechen", callback_data: `cfg_bl_ai_${channelId}` }]
      ]
    );
    return true;
  }

  if (action === "sched_wizard_text") {
    if (text.length > 3800) {
      await nextStep(tg, userId, pending, "❌ Text zu lang (max. 3800 Zeichen). Bitte kürzen.");
      return true;
    }
    // Premium-Emojis (custom_emoji) + Formatierung (bold/italic/etc.) werden
    // als Telegram-Entities mitgeliefert. Wir konvertieren sie hier zu
    // Telegram-HTML, damit sie beim Senden mit parse_mode "HTML" korrekt
    // gerendert werden — inkl. <tg-emoji emoji-id="..."> für Premium-Emojis.
    const msgTextHtml  = entitiesToHtml(text, msg?.entities || []);
    const textEntities = msg?.entities ? JSON.stringify(msg.entities) : null;
    global.pendingInputs[String(userId)] = {
      ...pending,
      action: "sched_wizard_file",
      msgText: msgTextHtml,
      msgEntities: textEntities
    };
    await nextStep(tg, userId, pending,
      "📎 <b>Schritt 2/6: Mediendatei (optional)</b>\n\nSende ein Foto, GIF oder Video – oder überspringe diesen Schritt:",
      [[{ text: "⏭ Überspringen", callback_data: `cfg_skip_wiz_${pending.channelId}` }]]
    );
    return true;
  }

  if (action === "sched_wizard_file") {
    let fileId = null, fileType = null, captionEntities = null;
    if (text !== "/skip") {
      if (msg?.photo) {
        fileId = msg.photo[msg.photo.length - 1]?.file_id; fileType = "photo";
      } else if (msg?.animation) {
        fileId = msg.animation.file_id; fileType = "animation";
      } else if (msg?.video) {
        fileId = msg.video.file_id; fileType = "video";
      } else {
        await nextStep(tg, userId, pending,
          "❌ Bitte sende ein Foto, GIF oder Video – oder überspringe:",
          [[{ text: "⏭ Überspringen", callback_data: `cfg_skip_wiz_${pending.channelId}` }]]
        );
        return true;
      }
      if (msg?.caption_entities) captionEntities = JSON.stringify(msg.caption_entities);
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_buttons", fileId, fileType, captionEntities };
    await nextStep(tg, userId, pending,
      "🖇 <b>Schritt 3/6: Buttons (optional)</b>\n\nFüge Inline-Buttons hinzu. Jede Zeile = ein Button:\n<code>Button Text | https://link.de</code>\n\nOder überspringe für keine Buttons:",
      [[{ text: "⏭ Ohne Buttons", callback_data: `cfg_skip_wiz_${pending.channelId}` }]]
    );
    return true;
  }

  if (action === "sched_wizard_buttons") {
    let inlineButtons = null;
    if (text !== "/skip") {
      const parsed = _parseInlineButtons(text);
      if (!parsed) {
        await nextStep(tg, userId, pending,
          "❌ Kein gültiger Button erkannt.\nFormat: <code>Button Text | https://link.de</code>\n\nOder überspringe:",
          [[{ text: "⏭ Ohne Buttons", callback_data: `cfg_skip_wiz_${pending.channelId}` }]]
        );
        return true;
      }
      inlineButtons = JSON.stringify(parsed);
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", inlineButtons };
    await nextStep(tg, userId, pending,
      "📅 <b>Schritt 4/6: Startzeit</b>\n\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\nOder sofort starten:",
      [[{ text: "⚡ Sofort starten", callback_data: `cfg_skip_wiz_${pending.channelId}` }]]
    );
    return true;
  }

  if (action === "sched_wizard_time") {
    let nextRunAt = null;
    if (text !== "/skip") {
      const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        nextRunAt = _parseGermanDateTime(m[1], m[2], m[3], m[4], m[5]);
      } else {
        await nextStep(tg, userId, pending, "❌ Ungültiges Format. Bitte: <code>DD.MM.YYYY HH:MM</code>\nz.B. <code>20.04.2026 09:00</code>\nOder /skip für sofort.");
        return true;
      }
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_interval", nextRunAt };
    await nextStep(tg, userId, pending, "🔁 <b>Schritt 5/6: Intervall</b>\n\nSende das Wiederholungs-Intervall:\n<code>30m</code> (alle 30 Minuten)\n<code>2h</code> (alle 2 Stunden)\n<code>24h</code> (Täglich)\n\nOder einmalig:", [[{text:"🚫 Einmalig (kein Wiederholung)", callback_data:`cfg_skip_wiz_${pending.channelId}`}]]);
    return true;
  }

  if (action === "sched_wizard_interval") {
    let intervalMinutes = null;
    if (text !== "/skip") {
      const m = text.trim().toLowerCase().match(/^(\d+)(m|h)$/);
      if (m) {
        const val = parseInt(m[1]);
        intervalMinutes = m[2] === "h" ? val * 60 : val;
        if (intervalMinutes < 5) {
          await nextStep(tg, userId, pending, "❌ Das Minimum sind 5 Minuten. Bitte erneute Eingabe oder /skip.");
          return true;
        }
      } else {
        await nextStep(tg, userId, pending, "❌ Ungültiges Format. Bitte z.B. <code>30m</code> oder <code>2h</code> senden. Oder /skip.");
        return true;
      }
    }
    
    if (!intervalMinutes) {
      global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_options", intervalMinutes: null, endAt: null };
      await _sendSchedOptions(tg, userId, global.pendingInputs[String(userId)]);
      return true;
    }
    
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_end", intervalMinutes };
    await nextStep(tg, userId, pending, "🛑 <b>Schritt 6/6: Enddatum</b>\n\nBis wann soll wiederholt werden?\n<code>14d</code> (In 14 Tagen)\n<code>48h</code> (In 48 Stunden)\n<code>20.05.2026 12:00</code> (Exaktes Datum)\n\nOder endlos:", [[{text:"♾ Endlos (kein Enddatum)", callback_data:`cfg_skip_wiz_${pending.channelId}`}]]);
    return true;
  }

  if (action === "sched_wizard_end") {
    let endAt = null;
    if (text !== "/skip") {
      const mDate = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      const mRel = text.trim().toLowerCase().match(/^(\d+)(d|h)$/);
      
      if (mDate) {
        endAt = _parseGermanDateTime(mDate[1], mDate[2], mDate[3], mDate[4], mDate[5]);
      } else if (mRel) {
        const val = parseInt(mRel[1]);
        const ms = mRel[2] === "d" ? val * 86400000 : val * 3600000;
        endAt = new Date(Date.now() + ms).toISOString();
      } else {
        await nextStep(tg, userId, pending, "❌ Ungültiges Format. Bitte z.B. <code>14d</code> oder <code>20.05.2026 12:00</code> senden. Oder /skip.");
        return true;
      }
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_options", endAt };
    await _sendSchedOptions(tg, userId, global.pendingInputs[String(userId)]);
    return true;
  }

  if (action === "collecting_proofs") {
    const { feedbackId, channelId: fbChanId } = pending;
    if (text === "/done" || text === "/fertig" || text === "proof_done_btn") {
      delete global.pendingInputs[String(userId)];
      const count = pending.proofCount || 0;
      try {
        await supabase_db.from("proof_sessions").update({ status: "done", proof_count: count, updated_at: new Date() }).eq("feedback_id", feedbackId).eq("user_id", userId);
        const { data: fb7 } = await supabase_db.from("user_feedbacks").select("feedback_type, target_user_id, target_username, feedback_text").eq("id", feedbackId).maybeSingle();
        if (fb7) {
          let autoApprove = false;
          let repCheck = null;
          
          if (fb7.feedback_type === "positive") {
            repCheck = await supabase_db.from("user_reputation").select("score").eq("channel_id", fbChanId).ilike("username", fb7.target_username).maybeSingle();
            if (repCheck?.data && repCheck.data.score >= 3) autoApprove = true;
          }
          
          if (fb7.feedback_type === "negative") {
             const scamCheck = await safelistService.checkScamlist(fbChanId, fb7.target_username, fb7.target_user_id);
             if (scamCheck) autoApprove = true;
          }

          if (autoApprove) {
             const ch7 = await getChannel(fbChanId);
             await safelistService.approveFeedback(parseInt(feedbackId), userId, ch7);
             await nextStep(tg, userId, pending, `✅ ${count} Proof(s) eingereicht! Feedback wurde direkt bestätigt (Auto-Approve Regel erfüllt).`, []);
             return true;
          } else {
             const { data: admSet } = await supabase_db.from("bot_channels").select("added_by_user_id, title").eq("id", String(fbChanId)).maybeSingle();
             if (admSet?.added_by_user_id) {
               const { proofs } = await (async () => {
                 try { const r = await supabase_db.from("feedback_proofs").select("*").eq("feedback_id", feedbackId).order("created_at"); return { proofs: r.data || [] }; } catch { return { proofs: [] }; }
               })();
               const emoji = fb7.feedback_type === "positive" ? "✅" : "⚠️";
               await tg.call("sendMessage", { chat_id: String(admSet.added_by_user_id),
                 text: `📎 <b>Neues Feedback (ID: <code>${feedbackId}</code>) mit ${count} Proof(s)</b>\n\nChannel: ${admSet.title || fbChanId}\nZiel: @${fb7.target_username}\nTyp: ${emoji} ${fb7.feedback_type}\n\n<i>${(fb7.feedback_text||"").substring(0,150)}</i>\n\nBitte überprüfe die Beweise unten.`,
                 parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Bestätigen", callback_data: `fb_approve_${feedbackId}` }, { text: "❌ Ablehnen", callback_data: `fb_reject_${feedbackId}` }]] }
               });
               for (const p of proofs.slice(0, 5)) {
                 try {
                   if (p.proof_type === "photo") await tg.call("sendPhoto", { chat_id: String(admSet.added_by_user_id), photo: p.file_id, caption: p.caption||"" });
                   if (p.proof_type === "video") await tg.call("sendVideo", { chat_id: String(admSet.added_by_user_id), video: p.file_id, caption: p.caption||"" });
                   if (p.proof_type === "document") await tg.call("sendDocument", { chat_id: String(admSet.added_by_user_id), document: p.file_id, caption: p.caption||"" });
                   if (p.proof_type === "text") await tg.call("sendMessage", { chat_id: String(admSet.added_by_user_id), text: `📝 ${p.content?.substring(0,1000)||""}` });
                 } catch (_) {}
               }
             }
             await nextStep(tg, userId, pending, `✅ ${count} Proof(s) eingereicht! Der Admin wird benachrichtigt.`, []);
             return true;
          }
        }
      } catch (_) {}
    }
    
    if (text !== "proof_done_btn") {
      const proofType = msg?.photo ? "photo" : msg?.video ? "video" : msg?.document ? "document" : "text";
      const fileId = msg?.photo ? msg.photo[msg.photo.length-1]?.file_id : msg?.video ? msg.video.file_id : msg?.document ? msg.document.file_id : null;
      try {
        await supabase_db.from("feedback_proofs").insert([{ feedback_id: parseInt(feedbackId), proof_type: proofType, fileId: fileId || null, content: proofType === "text" ? (text||"").substring(0,1000) : null, caption: msg?.caption || null, submitted_by: parseInt(userId) }]);
        global.pendingInputs[String(userId)] = { ...pending, proofCount: (pending.proofCount||0) + 1 };
        await nextStep(tg, userId, pending, `✅ Proof ${(pending.proofCount||0)+1} gespeichert.\nWeitere senden oder "Fertig" tippen.`, [[{text:"✅ Fertig (/done)", callback_data:`proof_done_btn`}]]);
      } catch (e) { await nextStep(tg, userId, pending, "❌ Fehler: " + e.message); }
    }
    return true;
  }

  if (action === "fb_mgr_await_user") {
    delete global.pendingInputs[String(userId)];
    let target = text.replace(/^@/, "").trim();
    if (!target) {
      await nextStep(tg, userId, pending, "❌ Bitte @username oder Telegram-ID eingeben.");
      return true;
    }

    try {
      let q = supabase_db.from("user_feedbacks").select("id, feedback_type, feedback_text, status, created_at").eq("channel_id", channelId);
      if (/^\d+$/.test(target)) q = q.eq("target_user_id", target);
      else q = q.ilike("target_username", target);
      
      const { data: feedbacks } = await q.order("created_at", { ascending: false }).limit(10);
      
      if (!feedbacks || feedbacks.length === 0) {
        await nextStep(tg, userId, pending, `ℹ️ Keine Feedbacks für <b>@${target}</b> gefunden.`, [[{ text: "◀️ Zurück zum Menü", callback_data: `cfg_menu_channel_${channelId}` }]]);
        return true;
      }

      let msgText = `📋 <b>Letzte Feedbacks für @${target}</b>\n\n`;
      const kb = [];

      feedbacks.forEach((fb, index) => {
        const emoji = fb.feedback_type === "positive" ? "✅" : "⚠️";
        const status = fb.status === "approved" ? "🟢" : fb.status === "pending" ? "🟡" : "🔴";
        const shortText = (fb.feedback_text || "").substring(0, 40) + "...";
        msgText += `${index + 1}. ${status} ${emoji} ID: <code>${fb.id}</code> - <i>${shortText}</i>\n`;
        kb.push([{ text: `🗑 Lösche ID ${fb.id}`, callback_data: `fb_mgr_del_${fb.id}_${channelId}` }]);
      });

      kb.push([{ text: `⚠️ User komplett zurücksetzen`, callback_data: `fb_mgr_reset_${target}_${channelId}` }]);
      kb.push([{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]);

      await nextStep(tg, userId, pending, msgText, kb);
    } catch (e) {
      await nextStep(tg, userId, pending, `❌ Fehler: ${e.message}`, [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]]);
    }
    return true;
  }

  if (action === "safelist_add_user") {
    delete global.pendingInputs[String(userId)];
    
    const ch = await getChannel(channelId);
    if (!ch || !ch.is_approved) {
      await nextStep(tg, userId, pending, "❌ <b>Kanal nicht verifiziert</b>\n\nDieser Kanal ist noch nicht verifiziert. Du kannst erst Benutzer zur Safelist hinzufügen, wenn dein Kanal freigegeben wurde.", [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]]);
      return true;
    }

    const parts = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target = parts[0];
    const note = parts[1] || "Manuell durch Admin";
    if (!target) { await nextStep(tg, userId, pending, "❌ Bitte @username oder Telegram-ID eingeben."); return true; }
    const isId = /^\d+$/.test(target);
    const uid = isId ? parseInt(target) : null;
    const uname = isId ? null : target.toLowerCase();
    const { data: existing } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().then(r=>r, ()=>({data:null}));
    if (existing) { await nextStep(tg, userId, pending, `⚠️ <b>@${target}</b> steht bereits auf der Safelist!`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); return true; }
    const { data: scamConflict } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().then(r=>r, ()=>({data:null}));
    if (scamConflict) {
      await nextStep(tg, userId, pending, `⛔ <b>@${target}</b> steht bereits auf der <b>Scamliste</b>!\nBitte zuerst dort entfernen.`, [[{ text: "⛔ Von Scamliste entfernen", callback_data: `cfg_sl_scamview_${channelId}` }, { text: "◀️ Abbrechen", callback_data: `cfg_safelist_${channelId}` }]]);
      return true;
    }
    try {
      await supabase_db.from("channel_safelist").insert([{ channel_id: channelId, user_id: uid, username: uname, score: 0, added_by: parseInt(userId), note }]);
      await nextStep(tg, userId, pending, `✅ <b>@${target}</b> wurde zur Safelist hinzugefügt.`, [[{ text: "◀️ Safelist", callback_data: `cfg_sl_safeview_${channelId}` }]]);
    } catch (e) { await nextStep(tg, userId, pending, `❌ Fehler: ${e.message}`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); }
    return true;
  }
  
  if (action === "scamlist_add_user") {
    delete global.pendingInputs[String(userId)];
    
    const ch = await getChannel(channelId);
    if (!ch || !ch.is_approved) {
      await nextStep(tg, userId, pending, "❌ <b>Kanal nicht verifiziert</b>\n\nDieser Kanal ist noch nicht verifiziert. Du kannst erst Scammer melden, wenn dein Kanal freigegeben wurde.", [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]]);
      return true;
    }

    const parts2 = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target2 = parts2[0];
    const reason = parts2[1] || "Manuell vom Admin eingetragen";
    if (!target2) { await nextStep(tg, userId, pending, "❌ Bitte @username oder Telegram-ID eingeben."); return true; }
    const isId2 = /^\d+$/.test(target2);
    const uid2 = isId2 ? parseInt(target2) : null;
    const uname2 = isId2 ? null : target2.toLowerCase();
    const { data: existing2 } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().then(r=>r, ()=>({data:null}));
    if (existing2) { await nextStep(tg, userId, pending, `⚠️ <b>@${target2}</b> steht bereits auf der Scamliste!`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); return true; }
    const { data: safeConflict } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().then(r=>r, ()=>({data:null}));
    if (safeConflict) {
      await nextStep(tg, userId, pending, `✅ <b>@${target2}</b> steht bereits auf der <b>Safelist</b>!\nBitte zuerst dort entfernen.`, [[{ text: "✅ Von Safelist entfernen", callback_data: `cfg_sl_safeview_${channelId}` }, { text: "◀️ Abbrechen", callback_data: `cfg_safelist_${channelId}` }]]);
      return true;
    }
    try {
      await supabase_db.from("scam_entries").insert([{ channel_id: channelId, user_id: uid2, username: uname2, reason, added_by: parseInt(userId) }]);
      await nextStep(tg, userId, pending, `⛔ <b>@${target2}</b> wurde zur Scamliste hinzugefügt.`, [[{ text: "◀️ Scamliste", callback_data: `cfg_sl_scamview_${channelId}` }]]);
    } catch (e) { await nextStep(tg, userId, pending, `❌ Fehler: ${e.message}`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); }
    return true;
  }

  if (action === "bl_add_soft") {
    delete global.pendingInputs[String(userId)];
    const word = text.split("|")[0].trim();
    if (!word) { await nextStep(tg, userId, pending, "❌ Kein Wort angegeben."); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), severity: "tolerated", category: "toleriert", created_by: userId }], { onConflict: "channel_id,word" });
      await nextStep(tg, userId, pending, `🟡 <b>${word}</b> zur Toleriert-Liste hinzugefügt.`, [[{ text: "◀️ Zurück zur Liste", callback_data: `cfg_bl_listsoft_${channelId}` }]]);
    } catch (e) { await nextStep(tg, userId, pending, "❌ " + e.message); }
    return true;
  }

  if (action === "adwriter_new" || action === "adwriter_vary") {
    const origText = pending.origText || text;
    delete global.pendingInputs[String(userId)];
    await nextStep(tg, userId, pending, "⏳ WerbeTexter erstellt Variationen…");
    try {
      const r = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 1200, messages: [{ role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Der Inhalt muss identisch bleiben, aber Formulierungen, Satzstruktur und Stil sollen variieren. Trenne jede Variation mit ---." }, { role: "user", content: origText }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
      const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
      await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).then(r=>r, ()=>{});
      
      await nextStep(tg, userId, pending, `✅ 3 Variationen generiert.`, [[{ text: "◀️ Zurück zum Menü", callback_data: `cfg_adwriter_${channelId}` }]]);
      for (let i = 0; i < Math.min(variations.length, 3); i++) {
        await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📅 Einplanen", callback_data: `cfg_schedule_${channelId}` }]] } });
      }
    } catch (e) { await nextStep(tg, userId, pending, "❌ Fehler: " + e.message, [[{ text: "◀️ Zurück", callback_data: `cfg_adwriter_${channelId}` }]]); }
    return true;
  }

  if (action === "kb_add_entry") {
    delete global.pendingInputs[String(userId)];
    const rawText = (msg?.text || text || "").trim();
    if (!rawText || rawText.length < 5) {
      await nextStep(tg, userId, pending, "❌ Bitte einen aussagekräftigen Text senden (mindestens 5 Zeichen).");
      return true;
    }
    await nextStep(tg, userId, pending, "⏳ <b>OpenAI verarbeitet deinen Eintrag…</b>\n\n• Analyse & Kategorisierung\n• Vektoreinbettung wird erstellt");
    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error("OPENAI_API_KEY fehlt");
      const aiRes = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 300, messages: [{ role: "system", content: 'Du bist ein Wissensmanager für Telegram-Channel-Bots. Analysiere den folgenden Wissenseintrag und antworte NUR mit einem JSON-Objekt ohne Markdown-Blöcke: {"title": "kurzer Titel (max 60 Zeichen)", "category": "passende Kategorie (z.B. FAQ, Preise, Kontakt, Regeln, Produkte, Öffnungszeiten, Allgemein)", "summary": "optimierte Version des Eintrags für die AI (max 300 Zeichen)"}' }, { role: "user", content: rawText }] }, { headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" }, timeout: 20000 });
      let aiData = { title: rawText.substring(0, 60), category: "Allgemein", summary: rawText };
      try {
        const raw = aiRes.data.choices[0].message.content.trim().replace(/^```json|^```|```$/gm, "");
        aiData = JSON.parse(raw);
      } catch (_) {}
      const embedRes = await axios.post("[https://api.openai.com/v1/embeddings](https://api.openai.com/v1/embeddings)", { input: (aiData.summary || rawText).replace(/\n/g, " ").substring(0, 8000), model: "text-embedding-3-small" }, { headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" }, timeout: 15000 });
      const embedding = embedRes.data.data[0].embedding;
      const { error: dbErr } = await supabase_db.from("channel_knowledge").insert([{ channel_id: String(channelId), title: aiData.title || rawText.substring(0, 60), category: aiData.category || "Allgemein", content: aiData.summary || rawText, embedding: JSON.stringify(embedding), source: "bot_admin", metadata: { original_length: rawText.length, added_by: String(userId) } }]);
      if (dbErr) throw new Error(dbErr.message);
      
      await nextStep(tg, userId, pending, `✅ <b>Wissenseintrag hinzugefügt!</b>\n\n📌 <b>Titel:</b> ${aiData.title}\n🏷 <b>Kategorie:</b> ${aiData.category}\n📝 <b>Inhalt:</b> <i>${(aiData.summary||rawText).substring(0, 150)}${(aiData.summary||rawText).length > 150 ? "…" : ""}</i>\n\nDie Smalltalk-AI verwendet dieses Wissen ab sofort automatisch.`, [[{ text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${channelId}` }, { text: "➕ Weiterer Eintrag", callback_data: `cfg_kb_add_${channelId}` }]]);
    } catch (e) {
      await nextStep(tg, userId, pending, `❌ <b>Fehler beim Verarbeiten:</b> ${e.message}\n\nBitte erneut versuchen.`, [[{ text: "◀️ Zurück", callback_data: `cfg_knowledge_${channelId}` }]]);
    }
    return true;
  }

  if (action === "set_welcome" || action === "set_goodbye" || action === "set_ai_prompt") {
    delete global.pendingInputs[String(userId)];
    let field, label;
    if (action === "set_welcome") { field = "welcome_msg"; label = "Willkommensnachricht"; }
    if (action === "set_goodbye") { field = "goodbye_msg"; label = "Abschiedsnachricht"; }
    if (action === "set_ai_prompt") { field = "system_prompt"; label = "System-Prompt"; }
    await supabase_db.from("bot_channels").update({ [field]: text, updated_at: new Date() }).eq("id", channelId);
    await nextStep(tg, userId, pending, `✅ <b>${label}</b> gespeichert!`, [[{ text: "◀️ Zurück", callback_data: `cfg_menu_channel_${channelId}` }]]);
    return true;
  }

  if (action === "userinfo_awaiting") {
    let targetId = null;
    if (msg?.forward_from) {
      targetId = String(msg.forward_from.id);
    } else if (msg?.forward_sender_name && !msg?.forward_from) {
      delete global.pendingInputs[String(userId)];
      await nextStep(tg, userId, pending, `🔒 Dieser User hat das Weiterleiten blockiert.\n\nBitte gib die Telegram-ID manuell ein oder versuche es mit /userinfo @username`, [[{ text: "◀️ Zurück", callback_data: `cfg_userinfo_${channelId}` }]]);
      global.pendingInputs[String(userId)] = { action: "userinfo_awaiting", channelId, wizardMsgId: pending.wizardMsgId };
      return true;
    } else if (text && text.startsWith("@")) {
      targetId = text.trim();
    } else if (text && /^\d+$/.test(text.trim())) {
      targetId = text.trim();
    } else {
      await nextStep(tg, userId, pending, "❓ Bitte leite eine Nachricht weiter, gib eine Telegram-ID ein (z.B. <code>123456789</code>) oder einen @username.");
      return true;
    }
    delete global.pendingInputs[String(userId)];
    
    await nextStep(tg, userId, pending, "🔍 Analysiere User...", []);
    await userInfoService.runUserInfo(tg, supabase_db, userId, targetId, channelId, null, null);
    return true;
  }

  if (action === "bl_add_word") {
    delete global.pendingInputs[String(userId)];
    const word = text.split("|")[0].trim();
    if (!word) { await nextStep(tg, userId, pending, "❌ Kein Wort angegeben."); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), severity: "mute", category: "allgemein", created_by: userId }], { onConflict: "channel_id,word" });
      await nextStep(tg, userId, pending, `🔴 <b>${word}</b> zur Harten Liste hinzugefügt.`, [[{ text: "◀️ Zurück zur Liste", callback_data: `cfg_bl_list_${channelId}` }]]);
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ Fehler: " + e.message, [[{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]]);
    }
    return true;
  }

  // ── Activity Tracker: Spielzeitraum Start/End-Datum setzen ─────────────────
  if (action === "activity_period_set") {
    delete global.pendingInputs[String(userId)];
    const dbField = pending.dbField; // "activity_game_starts_at" oder "activity_game_ends_at"
    const isStart = dbField === "activity_game_starts_at";

    // Format 1: "Xd" / "X Tage" — relativ ab JETZT
    // Format 2: "DD.MM.YYYY HH:MM" — exaktes Datum (Europe/Berlin)
    const mDays = text.trim().match(/^(\d+)\s*(?:d|days?|tage?|t)$/i);
    const mDate = text.trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})\s+(\d{1,2}):(\d{2})$/);

    let parsedDate, parsedIso;
    if (mDays) {
      const addDays = parseInt(mDays[1]);
      if (addDays <= 0 || addDays > 3650) {
        await nextStep(tg, userId, pending,
          "❌ Anzahl Tage muss zwischen 1 und 3650 liegen.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]);
        return true;
      }
      parsedDate = new Date(Date.now() + addDays * 24 * 3600 * 1000);
      parsedIso  = parsedDate.toISOString();
    } else if (mDate) {
      parsedIso  = _parseGermanDateTime(mDate[1], mDate[2], mDate[3], mDate[4], mDate[5]);
      parsedDate = parsedIso ? new Date(parsedIso) : null;
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        await nextStep(tg, userId, pending,
          "❌ Datum konnte nicht geparst werden.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
        );
        return true;
      }
    } else {
      await nextStep(tg, userId, pending,
        "❌ Ungültiges Format. Erlaubt:\n" +
        "• <code>30d</code>, <code>7d</code>, <code>14d</code> (Tage hinzufügen)\n" +
        "• <code>31.12.2026 23:59</code> (exaktes Datum)",
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
      );
      return true;
    }

    const now = new Date();

    // Validierung: Enddatum muss in der Zukunft liegen
    if (!isStart && parsedDate.getTime() <= now.getTime()) {
      await nextStep(tg, userId, pending,
        "❌ Das Enddatum muss in der Zukunft liegen.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
      );
      return true;
    }

    // Konsistenz-Check: end > start (falls beide gesetzt)
    try {
      const { data: existing } = await supabase_db.from("bot_channels")
        .select("activity_game_starts_at, activity_game_ends_at")
        .eq("id", channelId).maybeSingle();
      if (existing) {
        if (isStart && existing.activity_game_ends_at
            && parsedDate.getTime() >= new Date(existing.activity_game_ends_at).getTime()) {
          await nextStep(tg, userId, pending,
            "❌ Startdatum muss vor dem Enddatum liegen.",
            [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
          );
          return true;
        }
        if (!isStart && existing.activity_game_starts_at
            && parsedDate.getTime() <= new Date(existing.activity_game_starts_at).getTime()) {
          await nextStep(tg, userId, pending,
            "❌ Enddatum muss nach dem Startdatum liegen.",
            [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
          );
          return true;
        }
      }
    } catch (_) {}

    // Speichern. Bei neuem Startdatum: Reset von started_posted damit der
    // Scheduler die Start-Mitteilung erneut posten kann. Bei neuem Enddatum:
    // final_ranking_posted zurücksetzen.
    const updatePatch = { [dbField]: parsedIso };
    if (isStart) updatePatch.activity_game_started_posted = false;
    if (!isStart) updatePatch.activity_final_ranking_posted = false;
    try {
      await supabase_db.from("bot_channels").update(updatePatch).eq("id", channelId);
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]);
      return true;
    }

    const label = isStart ? "Startdatum" : "Enddatum";
    const dateStr = parsedDate.toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    await nextStep(tg, userId, pending,
      `✅ ${label} gesetzt auf <b>${dateStr} Uhr</b>`,
      [[{ text: "◀️ Zurück zum Zeitraum", callback_data: `cfg_groupgames_activity_period_${channelId}` }]]
    );
    return true;
  }

  // ── Activity Tracker: Aktivierung MIT Enddatum (Eingabe wie 30d oder Datum)
  if (action === "activity_activate_with_end") {
    delete global.pendingInputs[String(userId)];

    const mDays = text.trim().match(/^(\d+)\s*(?:d|days?|tage?|t)$/i);
    const mDate = text.trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})\s+(\d{1,2}):(\d{2})$/);

    let parsedDate, parsedIso;
    if (mDays) {
      const addDays = parseInt(mDays[1]);
      if (addDays <= 0 || addDays > 3650) {
        await nextStep(tg, userId, pending,
          "❌ Anzahl Tage muss zwischen 1 und 3650 liegen.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
        return true;
      }
      parsedDate = new Date(Date.now() + addDays * 24 * 3600 * 1000);
      parsedIso  = parsedDate.toISOString();
    } else if (mDate) {
      parsedIso  = _parseGermanDateTime(mDate[1], mDate[2], mDate[3], mDate[4], mDate[5]);
      parsedDate = parsedIso ? new Date(parsedIso) : null;
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        await nextStep(tg, userId, pending,
          "❌ Datum konnte nicht geparst werden.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
        return true;
      }
    } else {
      await nextStep(tg, userId, pending,
        "❌ Ungültiges Format. Erlaubt:\n" +
        "• <code>30d</code>, <code>7d</code>, <code>14d</code> (Tage hinzufügen)\n" +
        "• <code>31.12.2026 23:59</code> (exaktes Datum)",
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
      return true;
    }

    if (parsedDate.getTime() <= Date.now()) {
      await nextStep(tg, userId, pending,
        "❌ Das Enddatum muss in der Zukunft liegen.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
      return true;
    }

    // Spiel aktivieren + Enddatum setzen + Start-Mitteilung-Flag false
    try {
      await supabase_db.from("bot_channels").update({
        group_game_enabled:            true,
        activity_game_starts_at:       null, // sofortiger Start
        activity_game_ends_at:         parsedIso,
        activity_game_started_posted:  false,
        activity_final_ranking_posted: false
      }).eq("id", channelId);
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
      return true;
    }

    // Start-Mitteilung sofort im Channel posten (tg ist bereits der korrekte Bot-Client)
    try {
      const groupGameService = require("./groupGameService");
      const { data: chRefresh } = await supabase_db.from("bot_channels")
        .select("activity_game_ends_at, activity_powered_by").eq("id", channelId).maybeSingle();
      await groupGameService.postGameStartMessage(tg, supabase_db, channelId, chRefresh);
      await supabase_db.from("bot_channels")
        .update({ activity_game_started_posted: true })
        .eq("id", channelId);
    } catch (e) {
      // Falls Start-Mitteilung fehlschlägt: Scheduler postet sie beim nächsten Lauf
    }

    const dateStr = parsedDate.toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    await nextStep(tg, userId, pending,
      `✅ Spiel gestartet! Enddatum: <b>${dateStr} Uhr</b>\nDie Start-Mitteilung wurde im Channel gepostet.`,
      [[{ text: "◀️ Zurück zum Spielmenü", callback_data: `cfg_groupgames_activity_${channelId}` }]]
    );
    return true;
  }

  // ── Activity Tracker: Spieler-Punkte manuell setzen ───────────────────────
  // Akzeptiert:
  //   "50"   → exakt auf 50 setzen
  //   "+10"  → +10 Punkte
  //   "-5"   → −5 Punkte (clamp auf 0)
  if (action === "ggap_set_points") {
    delete global.pendingInputs[String(userId)];
    const playerUserId = pending.playerUserId;
    const txt = text.trim();

    // Parse
    const mRel = txt.match(/^([+\-])\s*(\d+)$/);
    const mAbs = txt.match(/^(\d+)$/);
    if (!mRel && !mAbs) {
      await nextStep(tg, userId, pending,
        "❌ Ungültiges Format. Erlaubt:\n" +
        "• <code>50</code> (exakt setzen)\n" +
        "• <code>+10</code> oder <code>-5</code> (relativ)",
        [[{ text: "◀️ Zurück", callback_data: `cfg_ggap_e_${playerUserId}_${channelId}` }]]);
      return true;
    }

    const groupGameService = require("./groupGameService");
    let newPoints;
    if (mRel) {
      const delta = parseInt(mRel[1] + mRel[2]); // "+10" → 10, "-5" → -5
      newPoints = await groupGameService.adjustPlayerPoints(
        supabase_db, channelId, playerUserId, delta
      );
    } else {
      const target = parseInt(mAbs[1]);
      if (target > 999999) {
        await nextStep(tg, userId, pending,
          "❌ Maximum: 999.999 Punkte.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_ggap_e_${playerUserId}_${channelId}` }]]);
        return true;
      }
      newPoints = await groupGameService.setPlayerPoints(
        supabase_db, channelId, playerUserId, target
      );
    }

    if (newPoints === false) {
      await nextStep(tg, userId, pending,
        "❌ Spieler nicht gefunden oder DB-Fehler.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_ggap_${channelId}` }]]);
      return true;
    }

    await nextStep(tg, userId, pending,
      `✅ Neue Punktzahl: <b>${newPoints}</b>`,
      [[{ text: "◀️ Zurück zum Spieler", callback_data: `cfg_ggap_e_${playerUserId}_${channelId}` }]]
    );
    return true;
  }

  // ── Activity Tracker: Powered-By Schriftzug setzen ────────────────────────
  if (action === "activity_powered_set") {
    delete global.pendingInputs[String(userId)];
    const raw = String(text || "").trim();

    // /clear oder "-" → Schriftzug entfernen
    if (raw === "/clear" || raw === "-" || raw === "") {
      try {
        await supabase_db.from("bot_channels")
          .update({ activity_powered_by: null })
          .eq("id", channelId);
      } catch (e) {
        await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
        return true;
      }
      await nextStep(tg, userId, pending,
        "🗑 Powered-By Schriftzug entfernt.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
      return true;
    }

    // Validierung: Länge
    if (raw.length > 100) {
      await nextStep(tg, userId, pending,
        `❌ Zu lang (${raw.length} Zeichen, max. 100). Bitte kürzer fassen.`,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_powered_${channelId}` }]]);
      return true;
    }

    // Speichern
    try {
      await supabase_db.from("bot_channels")
        .update({ activity_powered_by: raw })
        .eq("id", channelId);
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
      return true;
    }

    // Vorschau (HTML-escape)
    const safePreview = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    await nextStep(tg, userId, pending,
      `✅ Powered-By Schriftzug gesetzt!\n\n<b>Vorschau:</b>\n✨ <i>${safePreview}</i>\n\n` +
      `<i>Erscheint ab sofort in Spielstart-Mitteilung, /top, Auto-Posting und Final-Ranking.</i>`,
      [[{ text: "◀️ Zurück zum Spielmenü", callback_data: `cfg_groupgames_activity_${channelId}` }]]);
    return true;
  }

  // ── Wiederholende Nachricht: Text nachträglich bearbeiten ─────────────────
  // Premium-Emojis (custom_emoji) + Formatierung werden zu HTML konvertiert.
  if (action === "rep_edit_text") {
    delete global.pendingInputs[String(userId)];
    const schedId = pending.schedId;
    if (text.length > 3800) {
      await nextStep(tg, userId, pending, "❌ Text zu lang (max. 3800 Zeichen).",
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }
    const newTextHtml = entitiesToHtml(text, msg?.entities || []);
    const newEntities = msg?.entities ? JSON.stringify(msg.entities) : null;
    try {
      await supabase_db.from("scheduled_messages").update({
        message: newTextHtml,
        message_entities: newEntities
      }).eq("id", schedId);
    } catch (e) {
      // Fallback: message_entities Spalte fehlt → nur message updaten
      if (/column.*message_entities/i.test(String(e.message || ""))) {
        try {
          await supabase_db.from("scheduled_messages").update({ message: newTextHtml }).eq("id", schedId);
        } catch (e2) {
          await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e2.message,
            [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
          return true;
        }
      } else {
        await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
          [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
        return true;
      }
    }

    const hasPremium = Array.isArray(msg?.entities)
      && msg.entities.some(e => e.type === "custom_emoji");
    const previewInfo = hasPremium ? " <i>(inkl. Premium-Emojis ⭐)</i>" : "";
    await nextStep(tg, userId, pending,
      `✅ Text aktualisiert!${previewInfo}\nDie Änderung gilt ab dem nächsten Sendezeitpunkt.`,
      [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]
    );
    return true;
  }

  // ── Wiederholende Nachricht: Medium nachträglich ändern ───────────────────
  if (action === "rep_edit_media") {
    delete global.pendingInputs[String(userId)];
    const schedId = pending.schedId;

    let fileId = null, fileType = null;
    if (text === "/skip" || text === "-") {
      // Medium entfernen
      try {
        await supabase_db.from("scheduled_messages").update({
          photo_file_id: null, file_type: null
        }).eq("id", schedId);
      } catch (e) {
        await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
          [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
        return true;
      }
      await nextStep(tg, userId, pending,
        "🗑 Medium entfernt — die Nachricht wird ab jetzt nur als Text gesendet.",
        [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    if (msg?.photo)          { fileId = msg.photo[msg.photo.length - 1]?.file_id; fileType = "photo"; }
    else if (msg?.animation) { fileId = msg.animation.file_id; fileType = "animation"; }
    else if (msg?.video)     { fileId = msg.video.file_id;     fileType = "video"; }
    else {
      await nextStep(tg, userId, pending,
        "❌ Bitte sende ein Foto, GIF oder Video — oder <code>/skip</code> zum Entfernen.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    try {
      await supabase_db.from("scheduled_messages").update({
        photo_file_id: fileId, file_type: fileType
      }).eq("id", schedId);
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    const typeLabel = fileType === "video" ? "Video" : fileType === "animation" ? "GIF" : "Foto";
    await nextStep(tg, userId, pending,
      `✅ Medium aktualisiert! <b>${typeLabel}</b> wird ab dem nächsten Sendezeitpunkt mitgesendet.`,
      [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]
    );
    return true;
  }

  // ── Wiederholende Nachricht: Inline-Buttons nachträglich bearbeiten ───────
  if (action === "rep_edit_btns") {
    delete global.pendingInputs[String(userId)];
    const schedId = pending.schedId;

    const buttons = _parseInlineButtons(text);
    try {
      await supabase_db.from("scheduled_messages")
        .update({ inline_buttons: buttons })
        .eq("id", schedId);
    } catch (e) {
      // Fallback bei fehlender Spalte
      if (/column.*inline_buttons/i.test(String(e.message || ""))) {
        await nextStep(tg, userId, pending,
          "❌ Die Spalte <code>inline_buttons</code> existiert noch nicht in der DB. " +
          "Bitte schema_v1.6.29.sql ausführen.",
          [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
        return true;
      }
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    const count = buttons?.inline_keyboard?.length || 0;
    await nextStep(tg, userId, pending,
      count > 0
        ? `✅ ${count} Button${count === 1 ? "" : "s"} gespeichert.`
        : `🗑 Alle Buttons entfernt.`,
      [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]
    );
    return true;
  }

  // ── Wiederholende Nachricht: Enddatum nachträglich ändern ─────────────────
  if (action === "rep_edit_enddate") {
    delete global.pendingInputs[String(userId)];
    const schedId = pending.schedId;
    const raw = String(text || "").trim();

    // /clear → Enddatum entfernen
    if (raw === "/clear" || raw === "-") {
      try {
        await supabase_db.from("scheduled_messages").update({ end_at: null }).eq("id", schedId);
      } catch (e) {
        await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
          [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
        return true;
      }
      await nextStep(tg, userId, pending,
        "🗑 Enddatum entfernt — die Nachricht läuft jetzt endlos.",
        [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    let newEndIso = null;

    // Relative Eingabe: +7d / +2w / +1m / +24h
    const rel = raw.match(/^\+(\d+)\s*([dwmh])$/i);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const unit = rel[2].toLowerCase();
      const base = Date.now();
      const ms = unit === "h" ? n*3600000
               : unit === "d" ? n*86400000
               : unit === "w" ? n*7*86400000
               : /* m */        n*30*86400000;
      newEndIso = new Date(base + ms).toISOString();
    } else {
      // Absolute Eingabe: TT.MM.JJJJ [HH:MM]
      const mDate = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?$/);
      if (mDate) {
        const hh = mDate[4] != null ? mDate[4] : "23";
        const mm = mDate[5] != null ? mDate[5] : "59";
        newEndIso = _parseGermanDateTime(mDate[1], mDate[2], mDate[3], hh, mm);
      }
    }

    if (!newEndIso) {
      await nextStep(tg, userId, pending,
        "❌ Ungültiges Format.\n\nNutze:\n" +
        "• <code>31.12.2026 23:59</code>\n" +
        "• <code>31.12.2026</code>\n" +
        "• <code>+7d</code> / <code>+2w</code> / <code>+1m</code>\n\n" +
        "oder <code>/clear</code> zum Entfernen.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_eend_${schedId}_${channelId}` }]]);
      return true;
    }

    // Plausibilität: Enddatum muss in der Zukunft liegen
    if (new Date(newEndIso).getTime() <= Date.now()) {
      await nextStep(tg, userId, pending,
        "❌ Das Enddatum liegt in der Vergangenheit. Bitte ein zukünftiges Datum wählen.",
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_eend_${schedId}_${channelId}` }]]);
      return true;
    }

    try {
      const { error } = await supabase_db.from("scheduled_messages")
        .update({ end_at: newEndIso }).eq("id", schedId);
      if (error) throw error;
    } catch (e) {
      await nextStep(tg, userId, pending, "❌ DB-Fehler: " + e.message,
        [[{ text: "◀️ Zurück", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
      return true;
    }

    const display = new Date(newEndIso).toLocaleString("de-DE", {
      timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit",
      year: "numeric", hour: "2-digit", minute: "2-digit"
    }) + " Uhr";
    await nextStep(tg, userId, pending,
      `✅ Enddatum gesetzt auf:\n🏁 <b>${display}</b>\n\n` +
      `<i>Die Nachricht wird ab diesem Zeitpunkt nicht mehr gesendet.</i>`,
      [[{ text: "◀️ Zurück zur Nachricht", callback_data: `cfg_rep_edit_${schedId}_${channelId}` }]]);
    return true;
  }

  // ── Diss Battle: Arena-Chat-ID setzen ───────────────────────────────────────
  if (action === "diss_arena_set") {
    delete global.pendingInputs[String(userId)];
    const channelId = pending.channelId;
    const raw = String(text || "").trim();

    // Validierung: muss eine negative Telegram-Group-ID sein
    if (!/^-?\d{4,}$/.test(raw)) {
      await nextStep(tg, userId, pending,
        `❌ Ungültige Chat-ID.\n\nEine Gruppen-Chat-ID ist eine negative Zahl ` +
        `wie z.B. <code>-1001234567890</code>.\n\n` +
        `<i>Tipp: Sende <code>/id</code> in der Arena-Gruppe — der Bot antwortet mit der ID.</i>`,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
      return true;
    }

    // Verifizieren: kann der Bot in dieser Gruppe etwas? getChat versuchen
    try {
      const chatInfo = await tg.call("getChat", { chat_id: raw });
      const chatTitle = chatInfo?.result?.title || chatInfo?.title || "?";
      const chatType  = chatInfo?.result?.type  || chatInfo?.type  || "?";
      if (chatType !== "group" && chatType !== "supergroup") {
        await nextStep(tg, userId, pending,
          `❌ Die angegebene Chat-ID gehört zu einem ${chatType}, nicht zu einer Gruppe.`,
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
        return true;
      }
      // Bot-Member-Status prüfen
      const me = await tg.call("getMe");
      const botId = me?.result?.id || me?.id;
      const memberInfo = await tg.call("getChatMember", { chat_id: raw, user_id: botId });
      const status = memberInfo?.result?.status || memberInfo?.status;
      if (status !== "administrator" && status !== "creator") {
        await nextStep(tg, userId, pending,
          `⚠️ Ich bin in der Gruppe <b>${chatTitle}</b>, aber kein Admin.\n` +
          `Bitte gib mir Admin-Rechte (Mitglieder einladen + einschränken) und ` +
          `sende die ID erneut.`,
          [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
        return true;
      }

      // OK — speichern
      await supabase_db.from("bot_channels").update({
        diss_battle_arena_chat_id: raw
      }).eq("id", channelId);

      await nextStep(tg, userId, pending,
        `✅ Arena-Gruppe verlinkt!\n\n` +
        `📍 <b>${chatTitle}</b>\n` +
        `🆔 <code>${raw}</code>\n\n` +
        `<i>Jetzt kannst du Diss Battle aktivieren. ` +
        `Stelle sicher dass die Standard-Permissions der Gruppe "Nachrichten senden = AUS" sind, ` +
        `damit nur die Battle-Teilnehmer schreiben können.</i>`,
        [[{ text: "◀️ Zurück zu Diss Battle", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
    } catch (e) {
      await nextStep(tg, userId, pending,
        `❌ Konnte die Gruppe nicht erreichen.\n\nFehler: <code>${String(e.message).substring(0, 150)}</code>\n\n` +
        `Stelle sicher dass:\n` +
        `• Die Chat-ID korrekt ist (mit Minuszeichen)\n` +
        `• Ich Mitglied der Gruppe bin\n` +
        `• Ich in der Gruppe Admin bin`,
        [[{ text: "◀️ Zurück", callback_data: `cfg_groupgames_diss_${channelId}` }]]);
    }
    return true;
  }

  return false;
}

async function _sendSchedOptions(tg, userId, p) {
  const pinOpt = "📌 Anpinnen: " + (p.pinAfterSend ? "✅" : "❌");
  const delPrevOpt = "🔄 Vorherige löschen: " + (p.deletePrevious ? "✅" : "❌");
  
  await nextStep(tg, userId, p, "⚙️ <b>Letzter Schritt: Optionen prüfen</b>\n\nPasst alles?", [
    [{ text: pinOpt, callback_data: "sched_opt_pin_" + p.channelId }, { text: delPrevOpt, callback_data: "sched_opt_delprev_" + p.channelId }],
    [{ text: "✅ Nachricht jetzt einplanen", callback_data: "sched_save_final_" + p.channelId }],
    [{ text: "❌ Abbrechen", callback_data: `cfg_back_${p.channelId}` }]
  ]);
}

module.exports = { handle };
