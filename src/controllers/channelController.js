/**
 * channelController.js  v1.4.0-2
 */
const supabase = require("../config/supabase");
const logger   = require("../utils/logger");

const channelController = {

  async getChannels(req, res, next) {
    try {
      const { data } = await supabase.from("bot_channels").select("*").order("added_at", { ascending: false });
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async updateChannel(req, res, next) {
    try {
      const { id } = req.params;
      const { mode, is_active, is_approved, ai_command, token_limit, usd_limit, limit_message } = req.body;

      const patch = { updated_at: new Date() };
      if (mode         !== undefined) patch.mode          = mode;
      if (is_active    !== undefined) patch.is_active     = is_active;
      if (ai_command   !== undefined) patch.ai_command    = ai_command;
      if (limit_message!== undefined) patch.limit_message = limit_message;
      // Token-Limits: null = unbegrenzt
      if (token_limit  !== undefined) patch.token_limit   = token_limit === "" || token_limit === null ? null : parseInt(token_limit);
      if (usd_limit    !== undefined) patch.usd_limit     = usd_limit   === "" || usd_limit   === null ? null : parseFloat(usd_limit);

      // Freischalten
      if (is_approved !== undefined) {
        patch.is_approved = is_approved;
        if (is_approved) {
          patch.is_active  = true;
          patch.approved_at = new Date();
        }
      }

      const { data, error } = await supabase.from("bot_channels").update(patch).eq("id", id).select().single();
      if (error) throw error;
      this._channelCache[id] = null; // Cache invalidieren
      res.json(data);
    } catch (e) { next(e); }
  },

  async resetChannelUsage(req, res, next) {
    try {
      const { id } = req.params;
      await supabase.from("bot_channels").update({ token_used: 0, usd_spent: 0 }).eq("id", id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async deleteChannel(req, res, next) {
    try {
      await supabase.from("bot_channels").delete().eq("id", req.params.id);
      delete this._channelCache[req.params.id];
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async registerChannel(chat, botStatus) {
    if (!["administrator","creator"].includes(botStatus)) return;
    if (!["channel","supergroup","group"].includes(chat.type)) return;
    try {
      await supabase.from("bot_channels").upsert([{
        id: chat.id, title: chat.title || String(chat.id),
        username: chat.username || null, type: chat.type,
        bot_type: "berater", is_active: false, is_approved: false,
        updated_at: new Date()
      }], { onConflict: "id" });
      logger.info(`[Channel] Registriert (Berater-Bot): ${chat.title}`);
    } catch (e) { logger.warn("[Channel] Register:", e.message); }
  },

  // ── Channel-KB Endpoints ─────────────────────────────────────────────────
  async getChannelKB(req, res, next) {
    try {
      const channelKB = require("../services/ai/channelKnowledgeEnricher");
      const entries = await channelKB.getEntries(req.params.id);
      res.json(entries);
    } catch (e) { next(e); }
  },

  async addChannelKBEntry(req, res, next) {
    try {
      const { content, source } = req.body;
      if (!content) return res.status(400).json({ error: "Inhalt fehlt" });
      const channelKB = require("../services/ai/channelKnowledgeEnricher");
      const saved = await channelKB.addEntry(req.params.id, content, source || "manual");
      res.json({ success: true, saved });
    } catch (e) { next(e); }
  },

  async deleteChannelKBEntry(req, res, next) {
    try {
      const channelKB = require("../services/ai/channelKnowledgeEnricher");
      await channelKB.deleteEntry(req.params.id, req.params.entryId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Active Scan: Prüft für alle bekannten Channels ob Bot noch Admin ist ──
  async scanChannels(req, res, next) {
    try {
      const supabase_local = require("../config/supabase");
      const { data: s } = await supabase_local.from("settings")
        .select("smalltalk_bot_token").maybeSingle();
      const token = s?.smalltalk_bot_token;
      if (!token) return res.status(400).json({ error: "Kein Bot-Token konfiguriert" });

      const axios = require("axios");
      const base  = `https://api.telegram.org/bot${token}`;

      // getUpdates um recent my_chat_member events zu holen (falls verpasst)
      const updResp = await axios.get(`${base}/getUpdates`, {
        params: { allowed_updates: ["my_chat_member"], limit: 100, timeout: 5 },
        timeout: 10000
      }).catch(() => ({ data: { result: [] } }));

      const updates = updResp.data?.result || [];
      let registered = 0;

      for (const upd of updates) {
        const mcm = upd.my_chat_member;
        if (!mcm) continue;
        const isAdmin = ["administrator","creator"].includes(mcm.new_chat_member?.status);
        if (!isAdmin) continue;
        const chat = mcm.chat;
        if (!["channel","supergroup","group"].includes(chat.type)) continue;

        const addedBy = mcm.from;
        const token2  = require("crypto").randomBytes(16).toString("hex");

        await supabase_local.from("bot_channels").upsert([{
          id:               chat.id,
          title:            chat.title || String(chat.id),
          username:         chat.username || null,
          type:             chat.type,
          bot_type:         "smalltalk",
          is_active:        false,
          is_approved:      false,
          ai_enabled:       false,
          added_by_user_id: addedBy?.id   || null,
          added_by_username:addedBy?.username || null,
          settings_token:   token2,
          updated_at:       new Date()
        }], { onConflict: "id" });
        registered++;
      }

      // Dann alle gespeicherten Channels neu laden
      const { data: channels } = await supabase_local.from("bot_channels").select("*")
        .order("added_at", { ascending: false });

      res.json({ scanned: updates.length, registered, channels: channels || [] });
    } catch (e) { next(e); }
  },

  _channelCache: {},
  async getChannelSettings(chatId) {
    const c = this._channelCache[chatId];
    if (c && Date.now() - c.ts < 300000) return c.data;
    try {
      const { data } = await supabase.from("bot_channels").select("*").eq("id", chatId).maybeSingle();
      this._channelCache[chatId] = { data, ts: Date.now() };
      return data;
    } catch { return null; }
  }
};

module.exports = channelController;
