/**
 * safelistService.js  v1.4.5
 *
 * Community-Safelist: Nutzer können Feedback einreichen,
 * die KI fasst zusammen, Admin bestätigt → DB-Eintrag.
 *
 * Befehle:
 *   /safelist @user [Feedback]    → User als sicher melden
 *   /scamlist @user [Grund]       → User als Scammer melden
 *   /check @user                  → Status eines Users abfragen
 */

const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

const safelistService = {

  // ── Neues Feedback einreichen ─────────────────────────────────────────────
  async submitFeedback(channelId, submittedBy, targetUserId, targetUsername, listType, feedbackText, evidenceMsgs = []) {
    // Prüfen ob schon ein pending Entry für diesen User existiert
    const { data: existing } = await supabase.from("safelist_entries")
      .select("id").eq("user_id", targetUserId).eq("status", "pending").maybeSingle();

    if (existing) {
      // Beweis hinzufügen statt neuen Eintrag
      const { data: prev } = await supabase.from("safelist_entries")
        .select("evidence_msgs, feedback_text").eq("id", existing.id).single();
      const allEvidence = [...(prev?.evidence_msgs || []), ...evidenceMsgs];
      const combined = (prev?.feedback_text || "") + "\n" + feedbackText;
      await supabase.from("safelist_entries")
        .update({ evidence_msgs: allEvidence, feedback_text: combined, updated_at: new Date() })
        .eq("id", existing.id);
      return { updated: true, id: existing.id };
    }

    // Neuen Eintrag erstellen + KI-Zusammenfassung
    const summary = await this._summarize(targetUsername || String(targetUserId), listType, feedbackText, evidenceMsgs);

    const { data } = await supabase.from("safelist_entries").insert([{
      channel_id:    channelId,
      user_id:       targetUserId,
      username:      targetUsername,
      list_type:     listType,
      feedback_text: feedbackText,
      summary,
      evidence_msgs: evidenceMsgs,
      submitted_by:  submittedBy,
      status:        "pending"
    }]).select("id").single();

    return { created: true, id: data?.id, summary };
  },

  // ── Status abfragen ───────────────────────────────────────────────────────
  async checkUser(userId, username) {
    const query = userId
      ? supabase.from("safelist_entries").select("*").eq("user_id", userId).eq("status", "approved")
      : supabase.from("safelist_entries").select("*").ilike("username", username || "").eq("status", "approved");

    const { data } = await query.order("created_at", { ascending: false }).limit(1);
    return data?.[0] || null;
  },

  // ── Pending Reviews für Admin ─────────────────────────────────────────────
  async getPendingReviews(channelId) {
    const query = supabase.from("safelist_entries")
      .select("*").eq("status", "pending")
      .order("created_at", { ascending: false });
    if (channelId) query.or(`channel_id.eq.${channelId},channel_id.is.null`);
    const { data } = await query;
    return data || [];
  },

  // ── Admin bestätigt ───────────────────────────────────────────────────────
  async approve(entryId, adminUserId, finalListType) {
    const { data } = await supabase.from("safelist_entries").update({
      status:      "approved",
      list_type:   finalListType,
      reviewed_by: adminUserId,
      updated_at:  new Date()
    }).eq("id", entryId).select().single();
    return data;
  },

  async reject(entryId, adminUserId) {
    await supabase.from("safelist_entries").update({
      status:      "rejected",
      reviewed_by: adminUserId,
      updated_at:  new Date()
    }).eq("id", entryId);
  },

  // ── Für AI-Kontext: Safelist-Info zu einem User ───────────────────────────
  async getContextForUser(userId) {
    const entry = await this.checkUser(userId);
    if (!entry) return null;
    const emoji = entry.list_type === "safe" ? "✅" : "⚠️";
    return `${emoji} User-Status: ${entry.list_type === "safe" ? "VERIFIZIERT SICHER" : "GEMELDET ALS SCAMMER"}\nGrund: ${entry.summary || entry.feedback_text || ""}`;
  },

  // ── KI-Zusammenfassung (OpenAI) ───────────────────────────────────────────
  async _summarize(username, listType, feedback, evidence) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return feedback.substring(0, 200);

    const type = listType === "safe" ? "positiver Verifizierung" : "Scam-Meldung";
    const evText = evidence.length ? `\nBeweisnachrichten: ${evidence.slice(0, 3).map(e => e.text || "").join(" | ")}` : "";

    try {
      const resp = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          max_tokens: 150,
          temperature: 0.1,
          messages: [{
            role: "user",
            content: `Erstelle eine sachliche 2-Satz-Zusammenfassung dieser ${type} für @${username}:\n${feedback}${evText}\nNur die Zusammenfassung, keine Überschrift.`
          }]
        },
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 15000 }
      );
      return resp.data.choices[0].message.content.trim();
    } catch { return feedback.substring(0, 200); }
  }
};

module.exports = safelistService;
