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

async function getSettings() {
  try {
    const { data } = await supabase.from("settings").select("*").maybeSingle();
    return data || null;
  } catch { return null; }
}

async function _getRepeatCount(channelId) {
  try {
    const { data } = await supabase.from("scheduled_messages").select("id").eq("channel_id", String(channelId)).eq("is_active", true).eq("repeat", true);
    return data?.length || 0;
  } catch { return 0; }
}

async function handle(tg, supabase_db, userId, text, settings, msg) {
  const pending = global.pendingInputs[String(userId)];
  if (!pending) return false;

  if (text === "/cancel") {
    delete global.pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Abgebrochen." });
    return true;
  }

  const { action, channelId, entryId, targetUsername } = pending;

  if (action === "sched_wizard_text") {
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_file", msgText: text };
    const aiOn = pending.aiOn;
    if (aiOn) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "📎 <b>Schritt 2/4: Mediendatei (optional)</b>\n\nSende ein Foto, GIF oder Video – oder schreibe /skip um ohne Medien fortzufahren.", parse_mode: "HTML" });
    } else {
      global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", msgText: text, fileId: null, fileType: null };
      await tg.call("sendMessage", { chat_id: String(userId), text: "📅 <b>Schritt 3/4: Datum & Uhrzeit</b>\n\nWann soll die Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort (einmalig)", parse_mode: "HTML" });
    }
    return true;
  }

  if (action === "sched_wizard_file") {
    let fileId = null, fileType = null;
    if (text === "/skip") {
    } else if (msg?.photo) {
      fileId = msg.photo[msg.photo.length - 1]?.file_id; fileType = "photo";
    } else if (msg?.animation) {
      fileId = msg.animation.file_id; fileType = "animation";
    } else if (msg?.video) {
      fileId = msg.video.file_id; fileType = "video";
    } else {
      await tg.call("sendMessage", { chat_id: String(userId), text: "Bitte sende ein Foto, GIF oder Video – oder /skip." });
      return true;
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_time", fileId, fileType };
    await tg.call("sendMessage", { chat_id: String(userId), text: "📅 <b>Schritt 3/4: Datum & Uhrzeit</b>\n\nWann soll die Nachricht gesendet werden?\nFormat: <code>DD.MM.YYYY HH:MM</code>\nBeispiel: <code>20.04.2026 09:00</code>\n\n/skip für sofort (einmalig)", parse_mode: "HTML" });
    return true;
  }

  if (action === "sched_wizard_time") {
    let nextRunAt = null;
    if (text !== "/skip") {
      const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        nextRunAt = new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).toISOString();
      } else {
        await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Ungültiges Format. Bitte: <code>DD.MM.YYYY HH:MM</code>\nz.B. <code>20.04.2026 09:00</code>\nOder /skip für sofort.", parse_mode: "HTML" });
        return true;
      }
    }
    global.pendingInputs[String(userId)] = { ...pending, action: "sched_wizard_repeat", nextRunAt };
    const freeCount = await _getRepeatCount(channelId);
    const freeMode = pending.freeMode || !pending.aiOn;
    const atLimit = freeMode && freeCount >= 3;
    const pinOpt = "📌 Anpinnen: " + (pending.pinAfterSend ? "✅" : "❌");
    const delPrevOpt = "🔄 Vorherige löschen: " + (pending.deletePrevious ? "✅" : "❌");
    await tg.call("sendMessage", {
      chat_id: String(userId),
      text: "🔁 <b>Schritt 4/4: Wiederholung & Optionen</b>\n\n" + (atLimit ? "⚠️ Free-Limit: max. 3 Wiederholungs-Nachrichten ohne KI-Erweiterung.\n\n" : "") + (pending.aiOn ? "Unbegrenzte Wiederholungen verfügbar:" : "Free-Plan (max 3):"),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "1x – Einmalig", callback_data: "sched_repeat_once_" + channelId }, { text: "Täglich", callback_data: atLimit ? "sched_noop" : "sched_repeat_daily_" + channelId }],
        [{ text: "Wöchentlich", callback_data: atLimit ? "sched_noop" : "sched_repeat_weekly_" + channelId }, { text: "Monatlich", callback_data: atLimit ? "sched_noop" : "sched_repeat_monthly_" + channelId }],
        [{ text: pinOpt, callback_data: "sched_opt_pin_" + channelId }, { text: delPrevOpt, callback_data: "sched_opt_delprev_" + channelId }]
      ]}
    });
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
          if (fb7.feedback_type === "positive") {
             autoApprove = await safelistService.hasHighReputation(fbChanId, fb7.target_username, fb7.target_user_id);
          }

          if (autoApprove) {
             const ch7 = await getChannel(fbChanId);
             await safelistService.approveFeedback(parseInt(feedbackId), userId, ch7);
             if (fb7.target_user_id) {
               await supabase_db.rpc("update_user_reputation", { p_channel_id: fbChanId, p_user_id: fb7.target_user_id, p_username: fb7.target_username, p_delta: 1 }).catch(() => {});
             }
             await tg.call("sendMessage", { chat_id: String(userId), text: `✅ ${count} Proof(s) eingereicht! Feedback wurde direkt bestätigt (Trusted User).` });
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
             await tg.call("sendMessage", { chat_id: String(userId), text: `✅ ${count} Proof(s) eingereicht! Der Admin wird benachrichtigt und prüft das Feedback nun. Danke!` });
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
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ Proof ${(pending.proofCount||0)+1} gespeichert.\nWeitere senden oder /done zum Abschließen.` });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  if (action === "safelist_add_user") {
    delete global.pendingInputs[String(userId)];
    const parts = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target = parts[0];
    const note = parts[1] || "Manuell durch Admin";
    if (!target) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Bitte @username oder Telegram-ID eingeben." }); return true; }
    const isId = /^\d+$/.test(target);
    const uid = isId ? parseInt(target) : null;
    const uname = isId ? null : target.toLowerCase();
    const { data: existing } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().catch(() => ({ data: null }));
    if (existing) { await tg.call("sendMessage", { chat_id: String(userId), text: `⚠️ <b>@${target}</b> steht bereits auf der Safelist!`, parse_mode: "HTML" }); return true; }
    const { data: scamConflict } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid ? `user_id.eq.${uid}` : `username.eq.${uname}`).maybeSingle().catch(() => ({ data: null }));
    if (scamConflict) {
      await tg.call("sendMessage", { chat_id: String(userId), text: `⛔ <b>@${target}</b> steht bereits auf der <b>Scamliste</b>!\n\nEin User kann nicht gleichzeitig auf Safelist und Scamliste stehen.\nBitte zuerst von der Scamliste entfernen.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⛔ Von Scamliste entfernen", callback_data: `cfg_sl_scamview_${channelId}` }, { text: "◀️ Abbrechen", callback_data: `cfg_safelist_${channelId}` }]] } });
      return true;
    }
    try {
      await supabase_db.from("channel_safelist").insert([{ channel_id: channelId, user_id: uid, username: uname, score: 0, added_by: parseInt(userId), note }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>@${target}</b> wurde zur Safelist hinzugefügt.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "◀️ Safelist", callback_data: `cfg_sl_safeview_${channelId}` }]] } });
    } catch (e) {
      if (e.message?.includes("unique") || e.code === "23505") { await tg.call("sendMessage", { chat_id: String(userId), text: `⚠️ @${target} steht bereits auf der Safelist.`, parse_mode: "HTML" }); } else { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message }); }
    }
    return true;
  }
  if (action === "scamlist_add_user") {
    delete global.pendingInputs[String(userId)];
    const parts2 = text.replace(/^@/, "").split("|").map(s => s.trim());
    const target2 = parts2[0];
    const reason = parts2[1] || "Manuell vom Admin eingetragen";
    if (!target2) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Bitte @username oder Telegram-ID eingeben." }); return true; }
    const isId2 = /^\d+$/.test(target2);
    const uid2 = isId2 ? parseInt(target2) : null;
    const uname2 = isId2 ? null : target2.toLowerCase();
    const { data: existing2 } = await supabase_db.from("scam_entries").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().catch(() => ({ data: null }));
    if (existing2) { await tg.call("sendMessage", { chat_id: String(userId), text: `⚠️ <b>@${target2}</b> steht bereits auf der Scamliste!`, parse_mode: "HTML" }); return true; }
    const { data: safeConflict } = await supabase_db.from("channel_safelist").select("id").eq("channel_id", channelId).or(uid2 ? `user_id.eq.${uid2}` : `username.eq.${uname2}`).maybeSingle().catch(() => ({ data: null }));
    if (safeConflict) {
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>@${target2}</b> steht bereits auf der <b>Safelist</b>!\n\nEin User kann nicht gleichzeitig auf Safelist und Scamliste stehen.\nBitte zuerst von der Safelist entfernen.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Von Safelist entfernen", callback_data: `cfg_sl_safeview_${channelId}` }, { text: "◀️ Abbrechen", callback_data: `cfg_safelist_${channelId}` }]] } });
      return true;
    }
    try {
      await supabase_db.from("scam_entries").insert([{ channel_id: channelId, user_id: uid2, username: uname2, reason, added_by: parseInt(userId) }]);
      await tg.call("sendMessage", { chat_id: String(userId), text: `⛔ <b>@${target2}</b> wurde zur Scamliste hinzugefügt.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "◀️ Scamliste", callback_data: `cfg_sl_scamview_${channelId}` }]] } });
    } catch (e) {
      if (e.message?.includes("unique") || e.code === "23505") { await tg.call("sendMessage", { chat_id: String(userId), text: `⚠️ @${target2} steht bereits auf der Scamliste.`, parse_mode: "HTML" }); } else { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message }); }
    }
    return true;
  }

  if (action === "bl_add_soft") {
    delete global.pendingInputs[String(userId)];
    const parts = text.split("|").map(s => s.trim());
    const word = parts[0];
    const hours = parseInt(parts[1]) || 24;
    if (!word) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Kein Wort angegeben." }); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), severity: "tolerated", delete_after_hours: hours, category: "toleriert", created_by: userId }], { onConflict: "channel_id,word" });
      await tg.call("sendMessage", { chat_id: String(userId), text: `🟡 <b>${word}</b> hinzugefügt — wird nach ${hours}h gelöscht.`, parse_mode: "HTML" });
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ " + e.message }); }
    return true;
  }

  if (action === "adwriter_new" || action === "adwriter_vary") {
    const origText = pending.origText || text;
    delete global.pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ WerbeTexter erstellt Variationen…" });
    try {
      const r = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o-mini", max_tokens: 1200, messages: [{ role: "system", content: "Du bist ein professioneller WerbeTexter. Erstelle 3 verschiedene Variationen des folgenden Werbetextes. Der Inhalt muss identisch bleiben, aber Formulierungen, Satzstruktur und Stil sollen variieren. Trenne jede Variation mit ---." }, { role: "user", content: origText }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
      const variations = r.data.choices[0].message.content.split("---").map(v => v.trim()).filter(v => v.length > 10);
      await supabase_db.rpc("consume_channel_credits", { p_channel_id: channelId, p_tokens: 30 }).catch(() => {});
      for (let i = 0; i < Math.min(variations.length, 3); i++) {
        await tg.call("sendMessage", { chat_id: String(userId), text: `✍️ <b>Variation ${i+1}</b>\n\n${variations[i].substring(0,1000)}`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📅 Einplanen", callback_data: `cfg_schedule_${channelId}` }]] } });
      }
    } catch (e) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message }); }
    return true;
  }

  if (action === "kb_add_entry") {
    delete global.pendingInputs[String(userId)];
    const rawText = (msg?.text || text || "").trim();
    if (!rawText || rawText.length < 5) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Bitte einen aussagekräftigen Text senden (mindestens 5 Zeichen)." });
      return true;
    }
    const processingMsg = await tg.call("sendMessage", { chat_id: String(userId), text: "⏳ <b>OpenAI verarbeitet deinen Eintrag…</b>\n\n• Analyse & Kategorisierung\n• Vektoreinbettung wird erstellt", parse_mode: "HTML" });
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
      await tg.call("editMessageText", { chat_id: String(userId), message_id: processingMsg?.result?.message_id, text: `✅ <b>Wissenseintrag hinzugefügt!</b>\n\n📌 <b>Titel:</b> ${aiData.title}\n🏷 <b>Kategorie:</b> ${aiData.category}\n📝 <b>Inhalt:</b> <i>${(aiData.summary||rawText).substring(0, 150)}${(aiData.summary||rawText).length > 150 ? "…" : ""}</i>\n\nDie Smalltalk-AI verwendet dieses Wissen ab sofort automatisch.`, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📚 Wissensdatenbank", callback_data: `cfg_knowledge_${channelId}` }, { text: "➕ Weiterer Eintrag", callback_data: `cfg_kb_add_${channelId}` }]] } }).catch(async () => {
        await tg.call("sendMessage", { chat_id: String(userId), text: `✅ Eintrag „${aiData.title}" gespeichert! Kategorie: ${aiData.category}`, parse_mode: "HTML" });
      });
    } catch (e) {
      await tg.call("editMessageText", { chat_id: String(userId), message_id: processingMsg?.result?.message_id, text: `❌ <b>Fehler beim Verarbeiten:</b> ${e.message}\n\nBitte erneut versuchen.`, parse_mode: "HTML" }).catch(async () => {
        await tg.call("sendMessage", { chat_id: String(userId), text: `❌ Fehler: ${e.message}` });
      });
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
    await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>${label}</b> gespeichert!`, parse_mode: "HTML" });
    return true;
  }

  if (action === "userinfo_awaiting") {
    let targetId = null;
    if (msg?.forward_from) {
      targetId = String(msg.forward_from.id);
    } else if (msg?.forward_sender_name && !msg?.forward_from) {
      delete global.pendingInputs[String(userId)];
      await tg.call("sendMessage", { chat_id: String(userId), text: `🔒 Dieser User hat das Weiterleiten blockiert.\n\nBitte gib die Telegram-ID manuell ein oder versuche es mit /userinfo @username`, parse_mode: "HTML" });
      global.pendingInputs[String(userId)] = { action: "userinfo_awaiting", channelId };
      return true;
    } else if (text && text.startsWith("@")) {
      targetId = text.trim();
    } else if (text && /^\d+$/.test(text.trim())) {
      targetId = text.trim();
    } else {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❓ Bitte leite eine Nachricht weiter, gib eine Telegram-ID ein (z.B. <code>123456789</code>) oder einen @username.", parse_mode: "HTML" });
      return true;
    }
    delete global.pendingInputs[String(userId)];
    await userInfoService.runUserInfo(tg, supabase_db, userId, targetId, channelId, null, null);
    return true;
  }

  if (action === "bl_add_word") {
    delete global.pendingInputs[String(userId)];
    const parts = text.split("|").map(s => s.trim());
    const word = parts[0];
    const severity = ["warn","mute","ban","tolerated"].includes(parts[1]) ? parts[1] : "mute";
    const category = parts[2] || "allgemein";
    if (!word) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Kein Wort angegeben." }); return true; }
    try {
      await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word: word.toLowerCase(), category, severity, created_by: userId }], { onConflict: "channel_id,word" });
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>${word}</b> hinzugefügt (${severity}, ${category}).`, parse_mode: "HTML" });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  if (action === "bl_ai_category") {
    delete global.pendingInputs[String(userId)];
    const category = text.trim();
    if (!category) { await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Keine Kategorie angegeben." }); return true; }
    await tg.call("sendMessage", { chat_id: String(userId), text: `⏳ KI befüllt Blacklist für "${category}"…` });
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Kein OpenAI Key");
      const resp = await axios.post("[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)", { model: "gpt-4o-mini", max_tokens: 300, temperature: 0.2, messages: [{ role: "user", content: `Erstelle eine Liste von 20-30 deutschen Begriffen/Wörtern für die Kategorie "${category}". Gib NUR die Wörter aus, einen pro Zeile, keine Nummerierung, keine Erklärungen.` }] }, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 20000 });
      const words = resp.data.choices[0].message.content.trim().split("\n").map(w => w.trim().toLowerCase()).filter(w => w.length > 1 && w.length < 50);
      let added = 0;
      for (const word of words.slice(0, 30)) {
        try {
          await supabase_db.from("channel_blacklist").upsert([{ channel_id: String(channelId), word, category, severity: "mute", created_by: userId }], { onConflict: "channel_id,word" });
          added++;
        } catch (_) {}
      }
      await tg.call("sendMessage", { chat_id: String(userId), text: `✅ <b>${added} Wörter</b> für "${category}" zur Blacklist hinzugefügt.`, parse_mode: "HTML" });
    } catch (e) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Fehler: " + e.message });
    }
    return true;
  }

  if (action === "set_blocked_threads") {
    delete global.pendingInputs[String(userId)];
    const threadIds = text.split(/[\s,]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const { data: cur } = await supabase_db.from("bot_channels").select("blocked_thread_ids").eq("id", channelId).maybeSingle();
    const existing = Array.isArray(cur?.blocked_thread_ids) ? cur.blocked_thread_ids : [];
    const updated = [...new Set([...existing, ...threadIds])];
    await supabase_db.from("bot_channels").update({ blocked_thread_ids: updated, updated_at: new Date() }).eq("id", channelId);
    await tg.call("sendMessage", { chat_id: String(userId), text: `✅ Gesperrte Themen aktualisiert.\nAktive Sperren: ${updated.join(", ") || "keine"}`, parse_mode: "HTML" });
    return true;
  }

  if (action === "awaiting_proofs_start" && text && text.startsWith("/proofs_")) {
    const inputEntryId = text.split("_")[1];
    if (inputEntryId === String(entryId)) {
      global.pendingInputs[String(userId)] = { ...pending, action: "collecting_proofs", proofCount: 0 };
      await tg.call("sendMessage", { chat_id: String(userId), text: `📎 <b>Beweise einreichen für @${targetUsername}</b>\n\nSende jetzt bis zu <b>5 Beweise</b> als:\n• Screenshot (Foto)\n• Textnachricht\n• Dokument/Video\n\nSchreibe /fertig wenn du alle Beweise eingereicht hast.`, parse_mode: "HTML" });
    }
    return true;
  }

  return false;
}

module.exports = { handle };
