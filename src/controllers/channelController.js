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

      // WICHTIG: getUpdates ist im Webhook-Modus nicht verfügbar!
      // Stattdessen: Für alle bekannten Channels getChatAdministrators aufrufen
      // und Bot-Mitgliedschaft verifizieren
      const meResp = await axios.get(`${base}/getMe`, { timeout: 8000 });
      const botId  = meResp.data?.result?.id;

      const { data: existingChannels } = await supabase_local.from("bot_channels").select("id, title");
      let registered = 0;

      // Für jeden gespeicherten Channel: aktuellen Status prüfen
      for (const existing of (existingChannels || [])) {
        try {
          const memberResp = await axios.get(`${base}/getChatMember`, {
            params: { chat_id: existing.id, user_id: botId },
            timeout: 5000
          });
          const status = memberResp.data?.result?.status;
          const isAdmin = ["administrator","creator"].includes(status);

          // Update is_active based on current admin status
          await supabase_local.from("bot_channels")
            .update({ is_active: isAdmin, updated_at: new Date() }).eq("id", existing.id);
          if (isAdmin) registered++;
        } catch (_) {
          // Channel nicht mehr erreichbar → als inaktiv markieren
          await supabase_local.from("bot_channels")
            .update({ is_active: false }).eq("id", existing.id).catch(() => {});
        }
      }

      // Dann alle gespeicherten Channels neu laden
      const { data: channels } = await supabase_local.from("bot_channels").select("*")
        .order("added_at", { ascending: false });

      res.json({ scanned: (existingChannels || []).length, registered, channels: channels || [] });
    } catch (e) { next(e); }
  },

  // ── Manuell Channel nach ID registrieren ─────────────────────────────────
  async registerChannelById(req, res, next) {
    try {
      const { chat_id } = req.body;
      if (!chat_id) return res.status(400).json({ error: "chat_id fehlt" });

      const { data: s } = await require("../config/supabase").from("settings")
        .select("smalltalk_bot_token").maybeSingle();
      const token = s?.smalltalk_bot_token;
      if (!token) return res.status(400).json({ error: "Kein Bot-Token" });

      const axios = require("axios");
      const base  = `https://api.telegram.org/bot${token}`;

      // Chat-Info direkt von Telegram holen
      const chatResp = await axios.get(`${base}/getChat`, {
        params: { chat_id }, timeout: 8000
      });
      const chat = chatResp.data?.result;
      if (!chat) return res.status(400).json({ error: "Chat nicht gefunden" });

      const supabase_local = require("../config/supabase");
      const { data: existing } = await supabase_local.from("bot_channels")
        .select("id").eq("id", String(chat.id)).maybeSingle();

      const payload = {
        title:      chat.title || String(chat.id),
        username:   chat.username || null,
        type:       chat.type,
        bot_type:   "smalltalk",
        is_active:  false,
        is_approved:false,
        updated_at: new Date()
      };

      let result;
      if (existing) {
        result = await supabase_local.from("bot_channels").update(payload).eq("id", String(chat.id)).select().single();
      } else {
        result = await supabase_local.from("bot_channels").insert([{ id: chat.id, ...payload }]).select().single();
      }

      if (result.error) return res.status(500).json({ error: result.error.message });
      this._channelCache[String(chat.id)] = null;
      res.json({ success: true, channel: result.data });
    } catch (e) {
      next(e);
    }
  },

  // ── Channel-Gruppen Verwaltung ───────────────────────────────────────────
  async getChannelGroups(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { data } = await supa.from("channel_groups")
        .select("*, channel_group_members(channel_id, is_primary, bot_channels(id, title, type)))")
        .order("created_at", { ascending: false });
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async createChannelGroup(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { name, channel_ids } = req.body;
      if (!name || !channel_ids?.length) return res.status(400).json({ error: "Name und Channels pflicht" });
      const { data: grp } = await supa.from("channel_groups").insert([{ name }]).select().single();
      for (let i = 0; i < channel_ids.length; i++) {
        await supa.from("channel_group_members").insert([{ group_id: grp.id, channel_id: channel_ids[i], is_primary: i === 0 }]).catch(() => {});
        await supa.from("bot_channels").update({ channel_group_id: grp.id }).eq("id", channel_ids[i]).catch(() => {});
      }
      res.json({ success: true, group: grp });
    } catch (e) { next(e); }
  },

  async removeFromScamlist(req, res, next) {
    try {
      const { channel_id, user_id } = req.body;
      if (!channel_id || !user_id) return res.status(400).json({ error: "channel_id und user_id pflicht" });
      const safelistService = require("../services/adminHelper/safelistService");
      await safelistService.removeFromScamlist(channel_id, user_id, req.user?.id || 0);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getScamlist(req, res, next) {
    try {
      const supabase_local = require("../config/supabase");
      const { channel_id } = req.query;
      let q = supabase_local.from("scam_entries").select("*").order("created_at", { ascending: false });
      if (channel_id) q = q.eq("channel_id", String(channel_id));
      const { data } = await q.limit(50);
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async deleteChannelGroup(req, res, next) {
    try {
      const supa = require("../config/supabase");
      // Remove group membership from channels
      await supa.from("bot_channels").update({ channel_group_id: null }).eq("channel_group_id", req.params.id);
      await supa.from("channel_groups").delete().eq("id", req.params.id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── AI + Safelist Toggle ─────────────────────────────────────────────────
  async toggleAI(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { ai_enabled, safelist_enabled, welcome_msg, goodbye_msg, system_prompt, ai_model } = req.body;
      const patch = { updated_at: new Date() };
      if (ai_enabled        !== undefined) patch.ai_enabled        = Boolean(ai_enabled);
      if (safelist_enabled  !== undefined) patch.safelist_enabled  = Boolean(safelist_enabled);
      if (welcome_msg       !== undefined) patch.welcome_msg       = welcome_msg;
      if (goodbye_msg       !== undefined) patch.goodbye_msg       = goodbye_msg;
      if (system_prompt     !== undefined) patch.system_prompt     = system_prompt;
      if (ai_model          !== undefined) patch.ai_model          = ai_model;

      const { data, error } = await supa.from("bot_channels")
        .update(patch).eq("id", req.params.id).select().single();
      if (error) throw new Error(error.message);
      this._channelCache[req.params.id] = null;
      res.json(data);
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
