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

  // UX Fix: Lösche die Benutzereingabe sofort, damit der Chat sauber bleibt
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
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_file", msgText: text };
    if (pending.aiOn) {
      await nextStep(tg, userId, pending, "📎 <b>Schritt 2/5: Mediendatei (optional)</b>\n\nSende ein Foto, GIF oder Video – oder schreibe /skip um ohne Medien fortzufahren.", [[{text:"⏭ Überspringen (/skip)", callback_data:`cfg_noop`}]]);
    } else {
      global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", msgText: text, fileId: null, fileType: null };
      await nextStep(tg, userId, pending, "📅 <b>Schritt 3/5: Start-Datum & Uhrzeit</b>\n\nWann soll die erste Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort.", [[{text:"⚡ Sofort senden (/skip)", callback_data:`cfg_noop`}]]);
    }
    return true;
  }

  if (action === "sched_wizard_file") {
    let fileId = null, fileType = null;
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
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", fileId, fileType };
    await nextStep(tg, userId, pending, "📅 <b>Schritt 3/5: Start-Datum & Uhrzeit</b>\n\nWann soll die erste Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort.", [[{text:"⚡ Sofort senden (/skip)", callback_data:`cfg_noop`}]]);
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
    await nextStep(tg, userId, pending, "🔁 <b>Schritt 4/5: Intervall (Minuten/Stunden)</b>\n\nSende das Wiederholungs-Intervall:\n\nBeispiele:\n<code>30m</code> (alle 30 Minuten)\n<code>2h</code> (alle 2 Stunden)\n<code>24h</code> (Täglich)\n\n/skip für einmalige Nachricht.", [[{text:"🚫 Einmalig (/skip)", callback_data:`cfg_noop`}]]);
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
    await nextStep(tg, userId, pending, "🛑 <b>Schritt 5/5: Enddatum</b>\n\nBis wann soll wiederholt werden?\nBeispiele:\n<code>14d</code> (In 14 Tagen)\n<code>48h</code> (In 48 Stunden)\n<code>20.05.2026 12:00</code> (Exaktes Datum)\n\n/skip für nie (Endlos).", [[{text:"♾ Endlos (/skip)", callback_data:`cfg_noop`}]]);
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
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_options", endAt };
    await _sendSchedOptions(tg, userId, global.pendingInputs[String(userId)]);
    return true;
  }

  if (action === "collecting_proofs") {
    const { feedbackId, channelId: fbChanId } = pending;
    if (text === "/done" || text === "/fertig") {
      delete global.pendingInputs[String(userId)];
      const count = pending.proofCount || 0;
      try {
        await supabase_db.from("proof_sessions").update({ status: "done", proof_count: count, updated_at: new Date() }).eq("feedback_id", feedbackId).eq("user_id", userId);
        const { data: fb7 } = await supabase_db.from("user_feedbacks").select("feedback_type, target_user_id, target_username, feedback_text").eq("id", feedbackId).maybeSingle();
        if (fb7) {
          let autoApprove = false;
          if (fb7.feedback_type === "positive") autoApprove = await safelistService.hasHighReputation(fbChanId, fb7.target_username, fb7.target_user_id);
          if (autoApprove) {
             const ch7 = await getChannel(fbChanId);
             await safelistService.approveFeedback(parseInt(feedbackId), userId, ch7);
             if (fb7.target_user_id) await supabase_db.rpc("update_user_reputation", { p_channel_id: fbChanId, p_user_id: fb7.target_user_id, p_username: fb7.target_username, p_delta: 1 }).catch(() => {});
             await nextStep(tg, userId, pending, `✅ ${count} Proof(s) eingereicht! Feedback wurde direkt bestätigt (Trusted User).`, [[{ text: "◀️ Zurück", callback_data: `cfg_back_${fbChanId}` }]]);
             return true;
          } else {
             const { data: admSet } = await supabase_db.from("bot_channels").select("added_by_user_id, title").eq("id", String(fbChanId)).maybeSingle();
             if (admSet?.added_by_user_id) {
               const { proofs } = await (async () => {
                 try { const r = await supabase_db.from("feedback_proofs").select("*").eq("feedback_id", feedbackId).order("created_at"); return { proofs: r.data || [] }; } catch { return { proofs: [] }; }
               })();
               const emoji = fb7.feedback_type === "positive" ? "✅" : "⚠️";
               await tg.call("sendMessage", { chat_id: String(admSet.added_by_user_id),
                 text: `📎 <b>Neues Feedback mit ${count} Proof(s)</b>\n\nChannel: ${admSet.title || fbChanId}\nFeedback-ID: ${feedbackId}\nZiel: @${fb7.target_username}\nTyp: ${emoji} ${fb7.feedback_type}\n\n<i>${(fb7.feedback_text||"").substring(0,150)}</i>\n\nBitte überprüfe die Beweise unten.`,
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
             await nextStep(tg, userId, pending, `✅ ${count} Proof(s) eingereicht! Der Admin wird benachrichtigt.`, [[{ text: "◀️ Zurück", callback_data: `cfg_back_${fbChanId}` }]]);
             return true;
          }
        }
      } catch (_) {}
    }
    const proofType = msg?.photo ? "photo" : msg?.video ? "video" : msg?.document ? "document" : "text";
    const fileId = msg?.photo ? msg.photo[msg.photo.length-1]?.file_id : msg?.video ? msg.video.file_id : msg?.document ? msg.document.file_id : null;
    try {
      await supabase_db.from("feedback_proofs").insert([{ feedback_id: parseInt(feedbackId), proof_type: proofType, fileId: fileId || null, content: proofType === "text" ? (text||"").substring(0,1000) : null, caption: msg?.caption || null, submitted_by: parseInt(userId) }]);
      global.pendingInputs[String(userId)] = { ...pending, proofCount: (pending.proofCount||0) + 1 };
      await nextStep(tg, userId, pending, `✅ Proof ${(pending.proofCount||0)+1} gespeichert.\nWeitere senden oder /done zum Abschließen.`, [[{text:"✅ Fertig (/done)", callback_data:`cfg_noop`}]]);
    } catch (e) { await nextStep(tg, userId, pending, "❌ Fehler: " + e.message); }
    return true;
  }

  if (action === "safelist_add_user") {
    delete global.pendingInputs[String(userId)];
    const parts = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target = parts[0];
    const note = parts[1] || "Manuell durch Admin";
    if (!target) { await nextStep(tg, userId, pending, "❌ Bitte @username oder Telegram-ID eingeben."); return true; }
    const isId = /^\d+$/.test(target);
    const uid = isId ? parseInt(target) : null;
    const uname = isId ? null : target.toLowerCase();
    const { data: existing } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().catch(() => ({ data: null }));
    if (existing) { await nextStep(tg, userId, pending, `⚠️ <b>@${target}</b> steht bereits auf der Safelist!`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); return true; }
    const { data: scamConflict } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().catch(() => ({ data: null }));
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
    const parts2 = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target2 = parts2[0];
    const reason = parts2[1] || "Manuell vom Admin eingetragen";
    if (!target2) { await nextStep(tg, userId, pending, "❌ Bitte @username oder Telegram-ID eingeben."); return true; }
    const isId2 = /^\d+$/.test(target2);
    const uid2 = isId2 ? parseInt(target2) : null;
    const uname2 = isId2 ? null : target2.toLowerCase();
    const { data: existing2 } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().catch(() => ({ data: null }));
    if (existing2) { await nextStep(tg, userId, pending, `⚠️ <b>@${target2}</b> steht bereits auf der Scamliste!`, [[{ text: "◀️ Zurück", callback_data: `cfg_safelist_${channelId}` }]]); return true; }
    const { data: safeConflict } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().catch(() => ({ data: null }));
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
    const parts = text.split("|").map(s => s.trim());
    const word = parts[0];
    const hours = parseInt(parts[1]) || 24;
    if (!word) { await nextStep(tg, userId, pending, "❌ Kein Wort angegeben."); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), severity: "tolerated", delete_after_hours: hours, category: "toleriert", created_by: userId }], { onConflict: "channel_id,word" });
      await nextStep(tg, userId, pending, `🟡 <b>${word}</b> hinzugefügt — wird nach ${hours}h gelöscht.`, [[{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]]);
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
      await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
      
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
    
    // Anstelle des Menüs schicken wir den Info-Report, deshalb die Box kurz updaten
    await nextStep(tg, userId, pending, "🔍 Analysiere User...", []);
    await userInfoService.runUserInfo(tg, supabase_db, userId, targetId, channelId, null, null);
    // UserInfo sendet aktuell eine eigene neue Box. Wir könnten das im userInfoService.js umschreiben, 
    // aber das reicht fürs Erste, um die Eingaben aufzuräumen.
    return true;
  }

  if (action === "bl_add_word") {
    delete global.pendingInputs[String(userId)];
    const parts = text.split("|").map(s => s.trim());
    const word = parts[0];
    const severity = ["warn","mute","ban","tolerated"].includes(parts[1]) ? parts[1] : "mute";
    const category = parts[2] || "allgemein";
    if (!word) { await nextStep(tg, userId, pending, "❌ Kein Wort angegeben."); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), category, severity, created_by: userId }], { onConflict: "channel_id,word" });
      await nextStep(tg, userId, pending, `✅ <b>${word}</b> hinzugefügt (${severity}, ${category}).`, [[{ text: "◀️ Zurück", callback_data: `cfg_blacklist_${channelId}` }]]);
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
  
  await nextStep(tg, userId, p, "⚙️ <b>Letzter Schritt: Optionen prüfen</b>\n\nPasst alles?", [
    [{ text: pinOpt, callback_data: "sched_opt_pin_" + p.channelId }, { text: delPrevOpt, callback_data: "sched_opt_delprev_" + p.channelId }],
    [{ text: "✅ Nachricht jetzt einplanen", callback_data: "sched_save_final_" + p.channelId }],
    [{ text: "❌ Abbrechen", callback_data: `cfg_back_${p.channelId}` }]
  ]);
}

module.exports = { handle };
