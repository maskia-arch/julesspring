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
