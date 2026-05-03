const axios = require("axios");
const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const safelistService = require("./safelistService");
const userInfoService = require("./userInfoService");

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

  if (action === "sched_wizard_text") {
    // Telegram liefert `entities` (oder bei Mediennachrichten `caption_entities`)
    // mit allen Formatierungen — inkl. Premium-/Custom-Emojis. Wir nehmen das
    // Array 1:1 mit; beim Senden geben wir es zurück und Telegram rendert
    // alles wie ursprünglich vom Admin getippt.
    const incomingEntities = msg?.entities || msg?.caption_entities || null;
    global.pendingInputs[String(userId)] = {
      ...pending,
      action: "sched_wizard_file",
      msgText: text,
      msgEntities: incomingEntities && incomingEntities.length ? incomingEntities : null,
    };
    if (pending.aiOn) {
      await nextStep(tg, userId, pending, "📎 <b>Schritt 2/6: Mediendatei (optional)</b>\n\nSende ein Foto, GIF oder Video – oder schreibe /skip um ohne Medien fortzufahren.\n\n<i>Tipp: Schicke das Medium <b>mit Caption</b>, dann übernehme ich die Caption-Formatierung (inkl. Premium-Emojis) automatisch.</i>", [[{text:"⏭ Überspringen (/skip)", callback_data:`cfg_noop`}]]);
    } else {
      global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", msgText: text, msgEntities: incomingEntities && incomingEntities.length ? incomingEntities : null, fileId: null, fileType: null };
      await nextStep(tg, userId, pending, "📅 <b>Schritt 3/6: Start-Datum & Uhrzeit</b>\n\nWann soll die erste Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort.", [[{text:"⚡ Sofort senden (/skip)", callback_data:`cfg_noop`}]]);
    }
    return true;
  }

  if (action === "sched_wizard_file") {
    let fileId = null, fileType = null;
    let captionEntities = null;
    let captionText = null;
    if (text !== "/skip") {
      if (msg?.photo) {
        fileId = msg.photo[msg.photo.length - 1]?.file_id; fileType = "photo";
      } else if (msg?.animation) {
        fileId = msg.animation.file_id; fileType = "animation";
      } else if (msg?.video) {
        fileId = msg.video.file_id; fileType = "video";
      } else {
        await nextStep(tg, userId, pending, "❌ Bitte sende ein Foto, GIF oder Video – oder /skip.");
        return true;
      }
      // Falls der Admin direkt mit dem Medium eine Caption mitgeschickt hat,
      // die ist dann am Medium dran und ÜBERSCHREIBT den Text aus Schritt 1
      // — denn die Caption gehört semantisch zum Medium und enthält die
      // korrekten caption_entities-Offsets.
      if (msg?.caption) {
        captionText = msg.caption;
        if (msg.caption_entities && msg.caption_entities.length) {
          captionEntities = msg.caption_entities;
        }
      }
    }
    const patch = { ...pending, action: "sched_wizard_time", fileId, fileType };
    if (captionText !== null) {
      patch.msgText = captionText;
      patch.msgEntities = captionEntities;
    }
    global.pendingInputs[String(userId)] = patch;
    await nextStep(tg, userId, pending, "📅 <b>Schritt 3/6: Start-Datum & Uhrzeit</b>\n\nWann soll die erste Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort.", [[{text:"⚡ Sofort senden (/skip)", callback_data:`cfg_noop`}]]);
    return true;
  }

  if (action === "sched_wizard_time") {
    let nextRunAt = null;
    if (text !== "/skip") {
      const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        nextRunAt = new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).toISOString();
      } else {
        await nextStep(tg, userId, pending, "❌ Ungültiges Format. Bitte: <code>DD.MM.YYYY HH:MM</code>\nz.B. <code>20.04.2026 09:00</code>\nOder /skip für sofort.");
        return true;
      }
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_interval", nextRunAt };
    await nextStep(tg, userId, pending, "🔁 <b>Schritt 4/6: Intervall (Minuten/Stunden)</b>\n\nSende das Wiederholungs-Intervall:\n\nBeispiele:\n<code>30m</code> (alle 30 Minuten)\n<code>2h</code> (alle 2 Stunden)\n<code>24h</code> (Täglich)\n\n/skip für einmalige Nachricht.", [[{text:"🚫 Einmalig (/skip)", callback_data:`cfg_noop`}]]);
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
      // Einmalige Nachricht → trotzdem in Buttons-Step (kein Enddatum nötig)
      global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_buttons", intervalMinutes: null, endAt: null };
      await _sendButtonsPrompt(tg, userId, global.pendingInputs[String(userId)]);
      return true;
    }

    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_end", intervalMinutes };
    await nextStep(tg, userId, pending, "🛑 <b>Schritt 5/6: Enddatum</b>\n\nBis wann soll wiederholt werden?\nBeispiele:\n<code>14d</code> (In 14 Tagen)\n<code>48h</code> (In 48 Stunden)\n<code>20.05.2026 12:00</code> (Exaktes Datum)\n\n/skip für nie (Endlos).", [[{text:"♾ Endlos (/skip)", callback_data:`cfg_noop`}]]);
    return true;
  }

  if (action === "sched_wizard_end") {
    let endAt = null;
    if (text !== "/skip") {
      const mDate = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      const mRel = text.trim().toLowerCase().match(/^(\d+)(d|h)$/);

      if (mDate) {
        endAt = new Date(parseInt(mDate[3]), parseInt(mDate[2])-1, parseInt(mDate[1]), parseInt(mDate[4]), parseInt(mDate[5])).toISOString();
      } else if (mRel) {
        const val = parseInt(mRel[1]);
        const ms = mRel[2] === "d" ? val * 86400000 : val * 3600000;
        endAt = new Date(Date.now() + ms).toISOString();
      } else {
        await nextStep(tg, userId, pending, "❌ Ungültiges Format. Bitte z.B. <code>14d</code> oder <code>20.05.2026 12:00</code> senden. Oder /skip.");
        return true;
      }
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_buttons", endAt };
    await _sendButtonsPrompt(tg, userId, global.pendingInputs[String(userId)]);
    return true;
  }

  if (action === "sched_wizard_buttons") {
    let inlineButtons = null;
    if (text !== "/skip") {
      const parsed = _parseInlineButtonsSpec(text);
      if (!parsed.ok) {
        await nextStep(tg, userId, pending,
          `❌ ${parsed.error}\n\nFormat pro Zeile: <code>Button-Name, https://example.com</code>\nMaximal 8 Buttons. Oder /skip für keine Buttons.`,
          [[{ text: "⏭ Keine Buttons (/skip)", callback_data: `cfg_noop` }]]
        );
        return true;
      }
      inlineButtons = parsed.buttons;
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_options", inlineButtons };
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

  return false;
}

async function _sendSchedOptions(tg, userId, p) {
  const pinOpt = "📌 Anpinnen: " + (p.pinAfterSend ? "✅" : "❌");
  const delPrevOpt = "🔄 Vorherige löschen: " + (p.deletePrevious ? "✅" : "❌");

  const btnSummary = Array.isArray(p.inlineButtons) && p.inlineButtons.length
    ? `\n🔘 Inline-Buttons: ${p.inlineButtons.flat().length} konfiguriert`
    : "";

  await nextStep(tg, userId, p, `⚙️ <b>Letzter Schritt: Optionen prüfen</b>\n\nPasst alles?${btnSummary}`, [
    [{ text: pinOpt, callback_data: "sched_opt_pin_" + p.channelId }, { text: delPrevOpt, callback_data: "sched_opt_delprev_" + p.channelId }],
    [{ text: "✅ Nachricht jetzt einplanen", callback_data: "sched_save_final_" + p.channelId }],
    [{ text: "❌ Abbrechen", callback_data: `cfg_back_${p.channelId}` }]
  ]);
}

/**
 * Schritt 6/6: Buttons-Spezifikation entgegennehmen.
 *
 * Erwartetes Format (eine Zeile pro Button):
 *   Button-Name, https://example.com
 *   [Andere Zeile], [https://example.org]
 *
 * Eckige Klammern werden vor dem Parsing entfernt — das ermöglicht beide
 * Schreibweisen.
 */
async function _sendButtonsPrompt(tg, userId, p) {
  const promptText =
    "🔘 <b>Schritt 6/6: Inline-Buttons (optional)</b>\n\n" +
    "Möchtest du unter der Nachricht klickbare Buttons mit Links anzeigen?\n\n" +
    "Sende eine Zeile pro Button im Format:\n" +
    "<code>Button-Name, https://example.com</code>\n\n" +
    "Beispiel für mehrere Buttons (eine Zeile = ein Button):\n" +
    "<code>📢 Channel beitreten, https://t.me/example</code>\n" +
    "<code>🌐 Webseite, https://example.com</code>\n\n" +
    "Maximal 8 Buttons. Reine Telegram-Links (<code>https://t.me/…</code>) und HTTPS-URLs werden akzeptiert.\n\n" +
    "Oder /skip für keine Buttons.";
  await nextStep(tg, userId, p, promptText, [[{ text: "⏭ Keine Buttons (/skip)", callback_data: `cfg_noop` }]]);
}

/**
 * Parst die User-Eingabe in eine Telegram-kompatible inline_keyboard
 * Struktur: Array<Array<{text, url}>>.
 *
 * Jede nicht-leere Zeile = ein Button = eine eigene Tastatur-Zeile.
 * (Spätere Versionen könnten "|" als Trenner für mehrere Buttons in einer
 * Reihe einführen — für jetzt halten wir es einfach.)
 *
 * @returns {{ ok: boolean, buttons?: Array, error?: string }}
 */
function _parseInlineButtonsSpec(input) {
  if (!input || typeof input !== "string") return { ok: false, error: "Leere Eingabe." };

  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return { ok: false, error: "Keine Zeilen erkannt." };
  if (lines.length > 8) return { ok: false, error: "Maximal 8 Buttons erlaubt." };

  const buttons = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Eckige Klammern um die einzelnen Felder entfernen, falls der User
    // sie aus der Vorlage übernommen hat: "[Name], [Link]" → "Name, Link"
    line = line.replace(/^\s*\[\s*/, "").replace(/\s*\]\s*$/, "");
    line = line.replace(/\]\s*,\s*\[/g, ", ");
    line = line.replace(/\[/g, "").replace(/\]/g, "");

    // Letztes Komma als Trenner — der Button-Name darf selbst Kommas haben.
    const lastComma = line.lastIndexOf(",");
    if (lastComma === -1) {
      return { ok: false, error: `Zeile ${i + 1}: Kein Komma gefunden. Erwartetes Format: <code>Name, https://...</code>` };
    }

    const name = line.slice(0, lastComma).trim();
    const url  = line.slice(lastComma + 1).trim();

    if (!name) return { ok: false, error: `Zeile ${i + 1}: Button-Name fehlt.` };
    if (name.length > 64) return { ok: false, error: `Zeile ${i + 1}: Button-Name ist zu lang (max. 64 Zeichen).` };
    if (!url) return { ok: false, error: `Zeile ${i + 1}: URL fehlt.` };

    // URL-Validierung: muss https:// oder tg:// (für Telegram-Aktionen) sein.
    // http:// erlauben wir nicht, da Telegram das von Bots kommend oft blockt.
    let validUrl;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "tg:") {
        return { ok: false, error: `Zeile ${i + 1}: URL muss mit <code>https://</code> beginnen.` };
      }
      validUrl = u.toString();
    } catch (_) {
      return { ok: false, error: `Zeile ${i + 1}: <code>${url.substring(0, 60)}</code> ist keine gültige URL.` };
    }

    buttons.push([{ text: name, url: validUrl }]);
  }

  return { ok: true, buttons };
}

module.exports = { handle };
