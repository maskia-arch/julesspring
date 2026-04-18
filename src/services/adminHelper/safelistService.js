/**
 * safelistService.js  v1.4.17-2
 * Feedback-System: Statistiken, Proofs, Auto-Delete, Kontext-Tracking
 */
const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

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
      text += `\n💬 <b>Feedbacks:</b>\n`;
      quotes.forEach(f => {
        const e = f.feedback_type === "positive" ? "✅" : "⚠️";
        const by = f.submitted_by_username ? `@${f.submitted_by_username}` : "anonym";
        text += `${e} <i>${(f.feedback_text||"").substring(0,100)}</i> — ${by}\n`;
      });
    }
    return text;
  },

  async generateAiSummary(channelId, username, userId) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    const feedbacks = await this.getFeedbacks(channelId, username, userId);
    if (!feedbacks.length) return null;
    const allText = feedbacks.map(f => `[${f.feedback_type === "positive" ? "+" : "-"}] ${f.feedback_text||""}`).join("\n");
    try {
      const resp = await axios.post("https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", max_tokens: 200, temperature: 0.1,
          messages: [{ role: "user", content: `Fasse alle Feedbacks für @${username} in 3 Sätzen zusammen:\n${allText}\nNur Zusammenfassung.` }]},
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 15000 });
      return resp.data.choices[0].message.content.trim();
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
      file_id: fileId||null, caption: caption||null, content: content||null, submitted_by: submittedBy
    }]);
    const { data: cur } = await supabase.from("user_feedbacks").select("proof_count").eq("id", feedbackId).single().catch(() => ({ data: { proof_count: 0 } }));
    await supabase.from("user_feedbacks").update({ has_proofs: true, proof_count: (cur?.proof_count||0) + 1 }).eq("id", feedbackId);
  },

  async getProofs(feedbackId) {
    const { data } = await supabase.from("feedback_proofs").select("*").eq("feedback_id", feedbackId).order("created_at");
    return data || [];
  },

  async approveFeedback(feedbackId, adminUserId, channel) {
    const { data: fb } = await supabase.from("user_feedbacks").select("*").eq("id", feedbackId).single().catch(() => ({ data: null }));
    if (!fb) return null;
    let aiSummary = null;
    if (channel?.ai_enabled) aiSummary = await this.generateAiSummary(fb.channel_id, fb.target_username, fb.target_user_id);
    await supabase.from("user_feedbacks").update({ status: "approved", reviewed_by: adminUserId, ai_summary: aiSummary, updated_at: new Date() }).eq("id", feedbackId);
    if (fb.feedback_type === "negative") {
      const token = channel?.smalltalk_bot_token || (await supabase.from("settings").select("smalltalk_bot_token").single().catch(() => ({ data: null }))).data?.smalltalk_bot_token;
      const tgProfile = fb.target_user_id ? await this._fetchTgProfile(fb.target_user_id, token) : {};
      await supabase.from("scam_entries").upsert([{
        channel_id: String(fb.channel_id), user_id: fb.target_user_id,
        username: fb.target_username, tg_profile: tgProfile,
        reason: fb.feedback_text, ai_summary: aiSummary, added_by: adminUserId, feedback_ids: [feedbackId]
      }], { onConflict: "channel_id,user_id" });
    }
    return { approved: true, aiSummary };
  },

  async rejectFeedback(feedbackId, adminUserId) {
    await supabase.from("user_feedbacks").update({ status: "rejected", reviewed_by: adminUserId, updated_at: new Date() }).eq("id", feedbackId);
  },

  async removeFromScamlist(channelId, userId, adminUserId) {
    await supabase.from("scam_entries").delete().eq("channel_id", String(channelId)).eq("user_id", userId);
    logger.info(`[Safelist] Entfernt: user=${userId} channel=${channelId} by=${adminUserId}`);
  },

  async checkScamlist(channelId, username, userId) {
    let q = supabase.from("scam_entries").select("*").eq("channel_id", String(channelId));
    if (userId) q = q.eq("user_id", userId);
    else if (username) q = q.ilike("username", username);
    const { data } = await q.limit(1);
    return data?.[0] || null;
  },

  async getPendingReviews(channelId) {
    const { data } = await supabase.from("user_feedbacks")
      .select("*").eq("channel_id", String(channelId)).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(20);
    return data || [];
  },

  // Auto-Delete Tracking
  async trackBotMessage(channelId, messageId, msgType, deleteAfterMs) {
    const deleteAfter = deleteAfterMs ? new Date(Date.now() + deleteAfterMs).toISOString() : null;
    await supabase.from("bot_messages").insert([{
      channel_id: String(channelId), message_id: messageId, msg_type: msgType, delete_after: deleteAfter
    }]).catch(() => {});
  },

  async runAutoDelete(token) {
    if (!token) return;
    const { data: msgs } = await supabase.from("bot_messages").select("*").lte("delete_after", new Date().toISOString()).not("delete_after", "is", null).limit(50);
    if (!msgs?.length) return;
    const base = `https://api.telegram.org/bot${token}`;
    for (const m of msgs) {
      try { await axios.post(`${base}/deleteMessage`, { chat_id: m.channel_id, message_id: m.message_id }, { timeout: 5000 }); } catch (_) {}
      await supabase.from("bot_messages").delete().eq("id", m.id).catch(() => {});
    }
    if (msgs.length) logger.info(`[AutoDelete] ${msgs.length} Nachrichten gelöscht`);
  },

  // Kontext für /ai
  async saveContextMsg(channelId, userId, username, message) {
    if (!message?.trim()) return;
    await supabase.from("channel_context").upsert([{
      channel_id: String(channelId), user_id: userId,
      username: username||null, message: message.substring(0, 500), msg_date: new Date()
    }], { onConflict: "channel_id,user_id,message" }).catch(() => {});
    const { data: all } = await supabase.from("channel_context").select("id").eq("channel_id", String(channelId)).eq("user_id", userId).order("msg_date", { ascending: false });
    if (all?.length > 3) await supabase.from("channel_context").delete().in("id", all.slice(3).map(r => r.id)).catch(() => {});
  },

  async getContextMsgs(channelId, userId) {
    const { data } = await supabase.from("channel_context").select("message, username, msg_date")
      .eq("channel_id", String(channelId)).eq("user_id", userId).order("msg_date", { ascending: false }).limit(3);
    return (data || []).reverse();
  },

  async _fetchTgProfile(userId, token) {
    if (!token || !userId) return {};
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${token}/getChat`, { params: { chat_id: userId }, timeout: 5000 });
      const r = resp.data?.result || {};
      return { id: r.id, first_name: r.first_name, last_name: r.last_name, username: r.username, bio: r.bio, fetched_at: new Date().toISOString() };
    } catch { return {}; }
  }
};

module.exports = safelistService;
