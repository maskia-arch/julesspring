const axios = require("axios");
const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");

const safelistService = {
  async getFeedbacks(channelId, targetUsername, targetUserId) {
    let q = supabase.from("user_feedbacks")
      .select("feedback_type, feedback_text, ai_summary, status, created_at, submitted_by_username")
      .eq("channel_id", String(channelId)).eq("status", "approved");
    if (targetUserId) q = q.eq("target_user_id", targetUserId);
    else if (targetUsername) q = q.ilike("target_username", targetUsername);
    const { data } = await q.order("created_at", { ascending: false }).limit(20);
    return data || [];
  },

  buildStatsText(feedbacks, username) {
    const pos = feedbacks.filter(f => f.feedback_type === "positive").length;
    const neg = feedbacks.filter(f => f.feedback_type === "negative").length;
    if (!feedbacks.length) return `❓ Keine Feedbacks für @${username} gefunden.`;
    return `📊 <b>@${username}</b>\n✅ ${pos} positive · ⚠️ ${neg} negative Feedbacks`;
  },

  buildFullText(feedbacks, username, aiSummary) {
    const pos = feedbacks.filter(f => f.feedback_type === "positive");
    const neg = feedbacks.filter(f => f.feedback_type === "negative");
    let text = `📊 <b>@${username}</b>\n✅ ${pos.length} positiv · ⚠️ ${neg.length} negativ\n`;
    if (aiSummary) text += `\n🤖 <b>KI-Zusammenfassung:</b>\n${aiSummary}\n`;
    const quotes = [...neg.slice(0, 3), ...pos.slice(0, 2)];
    if (quotes.length) {
      text += `\n💬 <b>Letzte Feedbacks:</b>\n`;
      quotes.forEach(f => {
        const e = f.feedback_type === "positive" ? "✅" : "⚠️";
        const by = f.submitted_by_username ? `@${f.submitted_by_username}` : "anonym";
        text += `${e} <i>${(f.feedback_text || "").substring(0, 100)}</i> — ${by}\n`;
      });
    }
    return text;
  },

  async generateAiSummary(channelId, username, userId) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const feedbacks = await this.getFeedbacks(channelId, username, userId);
    if (!feedbacks.length) return null;

    let q = supabase.from("user_reputation").select("ai_summary, ai_summary_updated_at").eq("channel_id", String(channelId));
    if (userId) q = q.eq("user_id", userId);
    else if (username) q = q.ilike("username", username);
    const { data: rep } = await q.maybeSingle();

    const newestFeedbackTime = new Date(feedbacks[0].created_at).getTime();
    const cacheTime = rep?.ai_summary_updated_at ? new Date(rep.ai_summary_updated_at).getTime() : 0;

    if (rep && rep.ai_summary && cacheTime >= newestFeedbackTime) {
      return rep.ai_summary;
    }

    const allText = feedbacks.map(f => `[${f.feedback_type === "positive" ? "+" : "-"}] ${f.feedback_text || ""}`).join("\n");
    try {
      const resp = await axios.post("https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini", max_tokens: 200, temperature: 0.1,
          messages: [
            { role: "system", content: "Du fasst Handels-Feedbacks extrem präzise zusammen. Kein 'Die Feedbacks zeigen' – direkt zur Sache. Max 3 kurze Sätze." },
            { role: "user", content: `Zusammenfassung der Feedbacks für @${username}:\n${allText}` }
          ]
        },
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 15000 });
      
      const summary = resp.data.choices[0].message.content.trim();

      if (rep) {
        let updateQ = supabase.from("user_reputation").update({
            ai_summary: summary, ai_summary_updated_at: new Date().toISOString()
        }).eq("channel_id", String(channelId));
        if (userId) updateQ = updateQ.eq("user_id", userId);
        else updateQ = updateQ.ilike("username", username);
        await updateQ;
      }
      return summary;
    } catch { return null; }
  },

  async submitFeedback({ channelId, submittedBy, submittedByUsername, targetUserId, targetUsername, feedbackType, feedbackText }) {
    const { data } = await supabase.from("user_feedbacks").insert([{
      channel_id: String(channelId), target_user_id: targetUserId || null,
      target_username: targetUsername || null, feedback_type: feedbackType,
      feedback_text: feedbackText, submitted_by: submittedBy,
      submitted_by_username: submittedByUsername || null, status: "pending"
    }]).select("id").single();
    return data;
  },

  async addProof({ feedbackId, submittedBy, proofType, fileId, caption, content }) {
    await supabase.from("feedback_proofs").insert([{
      feedback_id: feedbackId, proof_type: proofType,
      file_id: fileId || null, caption: caption || null, content: content || null, submitted_by: submittedBy
    }]);
    let cur = { proof_count: 0 };
    try { const r = await supabase.from("user_feedbacks").select("proof_count").eq("id", feedbackId).single(); if (r.data) cur = r.data; } catch (_) { }
    await supabase.from("user_feedbacks").update({ has_proofs: true, proof_count: (cur?.proof_count || 0) + 1 }).eq("id", feedbackId);
  },

  async getProofs(feedbackId) {
    const { data } = await supabase.from("feedback_proofs").select("*").eq("feedback_id", feedbackId).order("created_at");
    return data || [];
  },

  async _recalculateUserReputation(channelId, targetUsername, targetUserId) {
    try {
      let q = supabase.from("user_feedbacks").select("feedback_type").eq("channel_id", String(channelId)).eq("status", "approved");
      
      if (targetUserId) {
        q = q.eq("target_user_id", targetUserId);
      } else if (targetUsername) {
        q = q.ilike("target_username", targetUsername);
      } else {
        return;
      }

      const { data: feedbacks } = await q;
      
      if (!feedbacks || feedbacks.length === 0) {
        let delQ = supabase.from("user_reputation").delete().eq("channel_id", String(channelId));
        if (targetUserId) delQ = delQ.eq("user_id", targetUserId);
        else delQ = delQ.ilike("username", targetUsername);
        await delQ;
        return;
      }

      const posCount = feedbacks.filter(f => f.feedback_type === "positive").length;
      const negCount = feedbacks.filter(f => f.feedback_type === "negative").length;
      const newScore = posCount - (negCount * 10);

      let updateQ = supabase.from("user_reputation").update({
        score: newScore,
        pos_count: posCount,
        neg_count: negCount,
        updated_at: new Date().toISOString()
      }).eq("channel_id", String(channelId));

      if (targetUserId) updateQ = updateQ.eq("user_id", targetUserId);
      else updateQ = updateQ.ilike("username", targetUsername);
      
      const { data: updateRes } = await updateQ.select();
      
      if (!updateRes || updateRes.length === 0) {
        await supabase.from("user_reputation").insert([{
          channel_id: String(channelId),
          user_id: targetUserId || null,
          username: targetUsername || null,
          score: newScore,
          pos_count: posCount,
          neg_count: negCount
        }]);
      }
      
    } catch (e) {
      logger.warn(`Fehler bei Neuberechnung der Reputation: ${e.message}`);
    }
  },

  async deleteFeedback(channelId, feedbackId) {
    try {
      const { data: fb } = await supabase.from("user_feedbacks").select("target_user_id, target_username").eq("id", feedbackId).eq("channel_id", String(channelId)).single();
      
      if (fb) {
        await supabase.from("user_feedbacks").delete().eq("id", feedbackId).eq("channel_id", String(channelId));
        await this._recalculateUserReputation(channelId, fb.target_username, fb.target_user_id);
      }
    } catch (e) {
      logger.warn(`Fehler beim Löschen des Feedbacks ${feedbackId}: ${e.message}`);
    }
  },

  async resetUserReputation(channelId, targetIdentifier) {
    try {
      let isId = /^\d+$/.test(targetIdentifier);
      
      let delFbQ = supabase.from("user_feedbacks").delete().eq("channel_id", String(channelId));
      if (isId) delFbQ = delFbQ.eq("target_user_id", targetIdentifier);
      else delFbQ = delFbQ.ilike("target_username", targetIdentifier);
      await delFbQ;

      let delRepQ = supabase.from("user_reputation").delete().eq("channel_id", String(channelId));
      if (isId) delRepQ = delRepQ.eq("user_id", targetIdentifier);
      else delRepQ = delRepQ.ilike("username", targetIdentifier);
      await delRepQ;

      let delSafeQ = supabase.from("channel_safelist").delete().eq("channel_id", String(channelId));
      if (isId) delSafeQ = delSafeQ.eq("user_id", targetIdentifier);
      else delSafeQ = delSafeQ.ilike("username", targetIdentifier);
      await delSafeQ;

      let delScamQ = supabase.from("scam_entries").delete().eq("channel_id", String(channelId));
      if (isId) delScamQ = delScamQ.eq("user_id", targetIdentifier);
      else delScamQ = delScamQ.ilike("username", targetIdentifier);
      await delScamQ;

    } catch (e) {
      logger.warn(`Fehler beim Resetten des Users ${targetIdentifier}: ${e.message}`);
    }
  },

  async approveFeedback(feedbackId, adminUserId, channel) {
    let fb = null;
    try { const r2 = await supabase.from("user_feedbacks").select("*").eq("id", feedbackId).single(); fb = r2.data; } catch (_) { }
    if (!fb) return null;

    await supabase.from("user_feedbacks").update({ status: "approved", reviewed_by: adminUserId, updated_at: new Date() }).eq("id", feedbackId);

    const isPos = fb.feedback_type === "positive";
    const delta = isPos ? 1 : -10;

    let currentScore = 0;
    try {
      await supabase.rpc("update_user_reputation", {
         p_channel_id: String(fb.channel_id), p_user_id: fb.target_user_id || 0,
         p_username: fb.target_username, p_delta: delta
      });
      const repCheck = await supabase.from("user_reputation").select("score").eq("channel_id", String(fb.channel_id)).ilike("username", fb.target_username).maybeSingle();
      currentScore = repCheck.data?.score || 0;
    } catch (e) { logger.warn("Reputation Update Error: ", e.message); }

    if (currentScore <= -50) {
      await supabase.from("scam_entries").upsert([{
        channel_id: String(fb.channel_id), user_id: fb.target_user_id,
        username: fb.target_username, reason: "🤖 Automatisch gesperrt: Score ist auf -50 gefallen.", added_by: adminUserId
      }], { onConflict: "channel_id,user_id" }).catch(()=>{});
    }

    return { approved: true };
  },

  async rejectFeedback(feedbackId, adminUserId) {
    await supabase.from("user_feedbacks").update({ status: "rejected", reviewed_by: adminUserId, updated_at: new Date() }).eq("id", feedbackId);
  },

  async removeFromScamlist(channelId, userId, adminUserId) {
    await supabase.from("scam_entries").delete().eq("channel_id", String(channelId)).eq("user_id", userId);
  },

  async checkScamlist(channelId, username, userId) {
    let q = supabase.from("scam_entries").select("*").eq("channel_id", String(channelId));
    if (userId) q = q.eq("user_id", userId);
    else if (username) q = q.ilike("username", username);
    const { data } = await q.limit(1);
    return data?.[0] || null;
  },

  async hasHighReputation(channelId, targetUsername, targetUserId) {
    try {
      let qSafe = supabase.from("channel_safelist").select("id").eq("channel_id", String(channelId));
      if (targetUserId) qSafe = qSafe.eq("user_id", targetUserId);
      else if (targetUsername) qSafe = qSafe.ilike("username", targetUsername);
      const { data: safeData } = await qSafe.maybeSingle();
      
      if (safeData) return true;

      let q = supabase.from("user_reputation").select("score").eq("channel_id", String(channelId));
      if (targetUserId) q = q.eq("user_id", targetUserId);
      else if (targetUsername) q = q.ilike("username", targetUsername);
      const { data } = await q.maybeSingle();
      
      return (data && data.score >= 3);
    } catch (_) { return false; }
  },

  async sendSafelistMenu(token, channelId, targetChatId, msgId) {
    targetChatId = targetChatId || channelId;
    const { data } = await supabase.from("user_feedbacks").select("target_username, target_user_id").eq("channel_id", String(channelId)).eq("feedback_type", "positive").eq("status", "approved");
    const uniqueUsers = [];
    const seen = new Set();
    
    for (const row of (data || [])) {
      const id = row.target_username || row.target_user_id;
      if (id && !seen.has(id)) { 
        seen.add(id); 
        uniqueUsers.push({ username: row.target_username, id: row.target_user_id }); 
      }
    }
    
    let text = `✅ <b>Safelist (${uniqueUsers.length})</b>\n\n`;
    const keyboard = { inline_keyboard: [] };
    
    if (uniqueUsers.length === 0) {
      text += "Die Safelist ist aktuell leer.";
    } else {
      uniqueUsers.forEach((u, i) => {
        const display = u.username ? `@${u.username}` : String(u.id);
        const cbData = u.username ? u.username : String(u.id);
        text += `${i + 1}. ✅ ${display}\n`;
        keyboard.inline_keyboard.push([{ text: `🗑 ${display}`, callback_data: `safelist_del_${cbData}_${channelId}` }]);
      });
    }
    
    keyboard.inline_keyboard.push([{ text: "◀️ Zurück", callback_data: `admin_menu_${channelId}` }]);
    const base = `https://api.telegram.org/bot${token}`;
    
    if (msgId) {
      await axios.post(`${base}/editMessageText`, { chat_id: targetChatId, message_id: msgId, text: text, parse_mode: "HTML", reply_markup: keyboard }).catch(() => { });
    } else {
      await axios.post(`${base}/sendMessage`, { chat_id: targetChatId, text: text, parse_mode: "HTML", reply_markup: keyboard }).catch(() => { });
    }
  },

  async removeFromSafelist(channelId, target) {
    try {
      const cleanTarget = target.replace('@', '');
      let q = supabase.from("user_feedbacks").delete().eq("channel_id", String(channelId)).eq("feedback_type", "positive");
      if (/^\d+$/.test(cleanTarget)) q = q.eq("target_user_id", cleanTarget);
      else q = q.ilike("target_username", cleanTarget);
      await q;
    } catch (e) { logger.warn("[Safelist] Fehler beim Löschen:", e.message); }
  },

  async getPendingReviews(channelId) {
    const { data } = await supabase.from("user_feedbacks").select("*").eq("channel_id", String(channelId)).eq("status", "pending").order("created_at", { ascending: false }).limit(20);
    return data || [];
  },

  async trackBotMessage(channelId, messageId, msgType, deleteAfterMs) {
    const deleteAfter = deleteAfterMs ? new Date(Date.now() + deleteAfterMs).toISOString() : null;
    try { await supabase.from("bot_messages").insert([{ channel_id: String(channelId), message_id: messageId, msg_type: msgType, delete_after: deleteAfter }]); } catch (_) { }
  },

  async runAutoDelete(token) {
    if (!token) return;
    const { data: msgs } = await supabase.from("bot_messages").select("*").lte("delete_after", new Date().toISOString()).not("delete_after", "is", null).limit(50);
    if (!msgs?.length) return;
    const base = `https://api.telegram.org/bot${token}`;
    for (const m of msgs) {
      try { await axios.post(`${base}/deleteMessage`, { chat_id: m.channel_id, message_id: m.message_id }, { timeout: 5000 }); } catch (_) { }
      try { await supabase.from("bot_messages").delete().eq("id", m.id); } catch (_) { }
    }
  },

  async saveUserMessage(channelId, userId, content, msgId) {
    if (!content?.trim()) return;
    try {
      await supabase.from("channel_chat_history").insert([{ channel_id: String(channelId), user_id: userId, role: "user", content: content.substring(0, 1000), msg_id: msgId || null }]);
      await this._pruneHistory(channelId, userId);
    } catch (_) { }
  },

  async saveAssistantMessage(channelId, userId, content, msgId) {
    if (!content?.trim()) return;
    try { await supabase.from("channel_chat_history").insert([{ channel_id: String(channelId), user_id: userId, role: "assistant", content: content.substring(0, 2000), msg_id: msgId || null }]); } catch (_) { }
  },

  async getConversationHistory(channelId, userId, maxPairs) {
    maxPairs = maxPairs || 5;
    try {
      const { data } = await supabase.from("channel_chat_history").select("role, content").eq("channel_id", String(channelId)).eq("user_id", userId).order("created_at", { ascending: false }).limit(maxPairs * 2);
      return (data || []).reverse().map(function (m) { return { role: m.role, content: m.content }; });
    } catch (_) { return []; }
  },

  async isBotMessage(channelId, msgId) {
    if (!msgId) return false;
    try {
      const { data } = await supabase.from("channel_chat_history").select("id").eq("channel_id", String(channelId)).eq("msg_id", msgId).eq("role", "assistant").maybeSingle();
      return !!data;
    } catch (_) { return false; }
  },

  async _pruneHistory(channelId, userId) {
    try {
      const { data: all } = await supabase.from("channel_chat_history").select("id").eq("channel_id", String(channelId)).eq("user_id", userId).order("created_at", { ascending: false });
      if (all?.length > 20) { await supabase.from("channel_chat_history").delete().in("id", all.slice(20).map(function (r) { return r.id; })); }
    } catch (_) { }
  },

  async saveContextMsg(channelId, userId, username, message) { await this.saveUserMessage(channelId, userId, message, null); },

  async getContextMsgs(channelId, userId) {
    const hist = await this.getConversationHistory(channelId, userId, 3);
    return hist.filter(function (m) { return m.role === "user"; }).map(function (m) { return { message: m.content }; });
  },

  async _fetchTgProfile(userId, token) {
    if (!token || !userId) return {};
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${token}/getChat`, { params: { chat_id: userId }, timeout: 5000 });
      const r = resp.data?.result || {};
      return { id: r.id, first_name: r.first_name, last_name: r.last_name, username: r.username, bio: r.bio, fetched_at: new Date().toISOString() };
    } catch { return {}; }
  },

  /**
   * Räumt channel_message_log auf — wird vom Server-Scheduler stündlich
   * aufgerufen. Löscht Group-Messages älter als 48h, damit die Tabelle
   * nicht ins Unermessliche wächst (300+ Nachrichten/Tag/Channel).
   */
  async pruneOldMessageLog() {
    try {
      // Bevorzugt: SQL-Funktion (effizient, einmaliger Roundtrip)
      const { error } = await supabase.rpc("prune_channel_message_log");
      if (!error) return;
    } catch (_) {}
    // Fallback: direktes DELETE über die JS-Schnittstelle
    try {
      const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      await supabase.from("channel_message_log").delete().lt("created_at", cutoff);
    } catch (_) {}
  }
};

module.exports = safelistService;

