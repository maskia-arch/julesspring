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

  // ── Safelist Endpoints ───────────────────────────────────────────────────
  async getSafelistReviews(req, res, next) {
    try {
      const safelistService = require("../services/adminHelper/safelistService");
      const data = await safelistService.getPendingReviews(req.query.channel_id || null);
      res.json(data);
    } catch (e) { next(e); }
  },

  async reviewSafelist(req, res, next) {
    try {
      const { action, list_type } = req.body;
      const safelistService = require("../services/adminHelper/safelistService");
      if (action === "approve") {
        const data = await safelistService.approve(req.params.id, req.user?.id || 0, list_type);
        res.json({ success: true, data });
      } else {
        await safelistService.reject(req.params.id, req.user?.id || 0);
        res.json({ success: true });
      }
    } catch (e) { next(e); }
  },

  // ── Scheduled Messages ─────────────────────────────────────────────────────
  async getScheduledMessages(req, res, next) {
    try {
      const { data } = await require("../config/supabase").from("scheduled_messages")
        .select("*").eq("channel_id", req.params.id).order("next_run_at");
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async createScheduledMessage(req, res, next) {
    try {
      const { message, cron_expr, repeat, next_run_at, photo_url } = req.body;
      if (!message) return res.status(400).json({ error: "Nachricht fehlt" });
      const { data } = await require("../config/supabase").from("scheduled_messages").insert([{
        channel_id:  req.params.id,
        message,     cron_expr: cron_expr || null,
        repeat:      !!repeat,
        next_run_at: next_run_at || null,
        photo_url:   photo_url || null,
        is_active:   true
      }]).select().single();
      res.json(data);
    } catch (e) { next(e); }
  },

  async deleteScheduledMessage(req, res, next) {
    try {
      await require("../config/supabase").from("scheduled_messages")
        .delete().eq("id", req.params.msgId).eq("channel_id", req.params.id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── AI Toggle ─────────────────────────────────────────────────────────────
  async toggleAI(req, res, next) {
    try {
      const { ai_enabled, safelist_enabled, welcome_msg, goodbye_msg } = req.body;
      const patch = { updated_at: new Date() };
      if (ai_enabled         !== undefined) patch.ai_enabled        = ai_enabled;
      if (safelist_enabled   !== undefined) patch.safelist_enabled  = safelist_enabled;
      if (welcome_msg        !== undefined) patch.welcome_msg       = welcome_msg;
      if (goodbye_msg        !== undefined) patch.goodbye_msg       = goodbye_msg;
      const { data } = await require("../config/supabase").from("bot_channels")
        .update(patch).eq("id", req.params.id).select().single();
      this._channelCache[req.params.id] = null;
      res.json(data);
    } catch (e) { next(e); }
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
