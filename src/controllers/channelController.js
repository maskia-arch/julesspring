/**
 * channelController.js  v1.4.0-3
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
      // SICHERHEITS-CHECK: Existiert der Kanal schon?
      const { data: existing } = await supabase.from("bot_channels").select("id").eq("id", String(chat.id)).maybeSingle();

      if (existing) {
        // Wenn er existiert, NUR Update von Namen/Typ + Aktivierung (NIEMALS is_approved antasten!)
        await supabase.from("bot_channels").update({
          title: chat.title || String(chat.id),
          username: chat.username || null, 
          type: chat.type,
          is_active: true,
          updated_at: new Date()
        }).eq("id", String(chat.id));
        logger.info(`[Channel] Aktualisiert: ${chat.title}`);
      } else {
        // Wenn er komplett neu ist, dann frisch eintragen (is_approved = false)
        await supabase.from("bot_channels").insert([{
          id: chat.id, 
          title: chat.title || String(chat.id),
          username: chat.username || null, 
          type: chat.type,
          bot_type: "berater", 
          is_active: true, 
          is_approved: false,
          updated_at: new Date()
        }]);
        logger.info(`[Channel] Neu Registriert: ${chat.title}`);
      }
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

      const meResp = await axios.get(`${base}/getMe`, { timeout: 8000 });
      const botId  = meResp.data?.result?.id;

      const { data: existingChannels } = await supabase_local.from("bot_channels").select("id, title");
      let registered = 0;

      for (const existing of (existingChannels || [])) {
        try {
          const memberResp = await axios.get(`${base}/getChatMember`, {
            params: { chat_id: existing.id, user_id: botId },
            timeout: 5000
          });
          const status = memberResp.data?.result?.status;
          const isAdmin = ["administrator","creator"].includes(status);

          await supabase_local.from("bot_channels")
            .update({ is_active: isAdmin, updated_at: new Date() }).eq("id", existing.id);
          if (isAdmin) registered++;
        } catch (_) {
          await supabase_local.from("bot_channels")
            .update({ is_active: false }).eq("id", existing.id).catch(() => {});
        }
      }

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

      const chatResp = await axios.get(`${base}/getChat`, {
        params: { chat_id }, timeout: 8000
      });
      const chat = chatResp.data?.result;
      if (!chat) return res.status(400).json({ error: "Chat nicht gefunden" });

      const supabase_local = require("../config/supabase");
      const { data: existing } = await supabase_local.from("bot_channels")
        .select("id").eq("id", String(chat.id)).maybeSingle();

      const updatePayload = {
        title:      chat.title || String(chat.id),
        username:   chat.username || null,
        type:       chat.type,
        updated_at: new Date()
      };

      let result;
      if (existing) {
        // NUR Update, überschreibe niemals Abos oder Status!
        result = await supabase_local.from("bot_channels").update(updatePayload).eq("id", String(chat.id)).select().single();
      } else {
        // Neuer Channel
        result = await supabase_local.from("bot_channels").insert([{ 
          id: String(chat.id),
          ...updatePayload,
          bot_type: "smalltalk",
          is_active: true,
          is_approved: false
        }]).select().single();
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

  // ── Refill Options ──────────────────────────────────────────────────────────
  async getRefills(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { data } = await supa.from("channel_refills").select("*").eq("is_active", true).order("sort_order");
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async upsertRefill(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { id, name, credits, price_eur, description, sellauth_product_id, sellauth_variant_id, sort_order } = req.body;
      if (!name || !credits || !price_eur) return res.status(400).json({ error: "name, credits, price_eur erforderlich" });
      const patch = { name, credits: parseInt(credits), price_eur: parseFloat(price_eur),
        description: description || null, sellauth_product_id: sellauth_product_id || null,
        sellauth_variant_id: sellauth_variant_id || null, sort_order: sort_order || 0, updated_at: new Date() };
      let data;
      if (id) { const r = await supa.from("channel_refills").update(patch).eq("id", id).select().single(); data = r.data; }
      else     { const r = await supa.from("channel_refills").insert([patch]).select().single(); data = r.data; }
      res.json(data);
    } catch (e) { next(e); }
  },

  async deleteRefill(req, res, next) {
    try {
      const supa = require("../config/supabase");
      await supa.from("channel_refills").update({ is_active: false }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Channel Packages ────────────────────────────────────────────────────────
  async getPackages(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { data } = await supa.from("channel_packages").select("*").eq("is_active", true).order("sort_order");
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async upsertPackage(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { id, name, credits, price_eur, description, sort_order } = req.body;
      if (!name || !credits || !price_eur) return res.status(400).json({ error: "name, credits, price_eur erforderlich" });
      const patch = {
        name, credits: parseInt(credits), price_eur: parseFloat(price_eur),
        description: description || null, sort_order: sort_order || 0,
        sellauth_product_id: req.body.sellauth_product_id || null,
        sellauth_variant_id:  req.body.sellauth_variant_id  || null,
        duration_days: parseInt(req.body.duration_days) || 30,
        updated_at: new Date()
      };
      let data;
      if (id) {
        const r = await supa.from("channel_packages").update(patch).eq("id", id).select().single();
        data = r.data;
      } else {
        const r = await supa.from("channel_packages").insert([patch]).select().single();
        data = r.data;
      }
      res.json(data);
    } catch (e) { next(e); }
  },

  async deletePackage(req, res, next) {
    try {
      const supa = require("../config/supabase");
      await supa.from("channel_packages").update({ is_active: false }).eq("id", req.params.id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Manual Channel Management ──────────────────────────────────────────────
  async getChannelAdminList(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { data } = await supa.from("bot_channels")
        .select("id, title, type, token_used, token_limit, credits_expire_at, ai_enabled, token_budget_exhausted")
        .order("title");
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async manualCreditPatch(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { channelId, credits, expiresAt, aiEnabled } = req.body;
      if (!channelId) return res.status(400).json({ error: "channelId required" });

      const patch = { updated_at: new Date() };
      if (credits !== undefined)  patch.token_limit = parseInt(credits);
      if (expiresAt !== undefined) patch.credits_expire_at = expiresAt || null;
      if (aiEnabled !== undefined) {
        patch.ai_enabled = !!aiEnabled;
        if (aiEnabled) patch.token_budget_exhausted = false;
      }
      // Reset used counter if requested
      if (req.body.resetUsed) patch.token_used = 0;

      await supa.from("bot_channels").update(patch).eq("id", String(channelId));
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async manualPackageBook(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { channelId, packageId } = req.body;
      if (!channelId || !packageId) return res.status(400).json({ error: "channelId, packageId required" });

      const { data: pkg } = await supa.from("channel_packages").select("*").eq("id", packageId).single();
      if (!pkg) return res.status(404).json({ error: "Paket nicht gefunden" });

      // v1.4.47: Block if there's already an active package
      try {
        const { data: active } = await supa.rpc("get_active_package", { p_channel_id: String(channelId) });
        if (active && active.length > 0) {
          const a = active[0];
          const expStr = a.expires_at ? new Date(a.expires_at).toLocaleDateString("de-DE") : "–";
          return res.status(409).json({ error: `Channel hat bereits ein aktives Paket (läuft ${expStr}). Warte auf Ablauf oder verwende ein Refill.` });
        }
      } catch (_) {}

      const days = pkg.duration_days || 30;
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      // Insert completed package row (admin manual, 30-day countdown starts now)
      try {
        await supa.from("channel_purchases").insert([{
          channel_id:    String(channelId),
          package_id:    pkg.id,
          credits_added: pkg.credits,
          credits_used:  0,
          duration_days: days,
          activated_at:  nowIso,
          forfeited:     false,
          status:        "completed",
          kind:          "package",
          meta:          { booked_by: "admin_dashboard", package_name: pkg.name }
        }]);
      } catch (e) { return next(e); }

      // Recompute aggregates into bot_channels
      try {
        await supa.rpc("recompute_channel_budget", { p_channel_id: String(channelId) });
      } catch (_) {}

      res.json({ success: true, credits: pkg.credits, expiresAt, durationDays: days });
    } catch (e) { next(e); }
  },

  // ── UserInfo Pro Management ────────────────────────────────────────────────
  async getProUsers(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { data } = await supa.from("userinfo_pro_users")
        .select("*").order("created_at", { ascending: false });
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async addProUser(req, res, next) {
    try {
      const supa = require("../config/supabase");
      const { user_id, username, note, expires_at } = req.body;
      if (!user_id) return res.status(400).json({ error: "user_id erforderlich" });
      const { data } = await supa.from("userinfo_pro_users")
        .upsert([{ user_id, username: username || null, note: note || null, expires_at: expires_at || null, updated_at: new Date() }], { onConflict: "user_id" })
        .select().single();
      res.json(data);
    } catch (e) { next(e); }
  },

  async removeProUser(req, res, next) {
    try {
      const supa = require("../config/supabase");
      await supa.from("userinfo_pro_users").delete().eq("user_id", req.params.userId);
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
