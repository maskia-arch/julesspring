/**
 * channelController.js  v1.4.0-3
 */
const supabase = require("../config/supabase");
const logger   = require("../utils/logger");
const botToken = require("../config/botToken");

const channelController = {

  async getChannels(req, res, next) {
    try {
      const { data } = await supabase.from("bot_channels").select("*").order("added_at", { ascending: false });
      if (!data) return res.json([]);
      const arenaIds = new Set(data.map(c => c.diss_battle_arena_chat_id).filter(Boolean).map(String));
      const filtered = data.filter(c => !arenaIds.has(String(c.id)));
      res.json(filtered);
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
    const channelId = String(req.params.id || '').trim();
    if (!channelId) return res.status(400).json({ error: 'Channel-ID fehlt' });

    const idStr = channelId;
    const idNum = parseInt(channelId, 10);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'Ungültige Channel-ID' });
    }

    const report = {
      channelId,
      leaveChat: { attempted: false, ok: false, error: null },
      tables:    { cleaned: 0, skipped: 0, failed: 0, totalRows: 0, details: [] },
      botChannelDeleted: false
    };

    // 1) BOT AUS DER GRUPPE ENTFERNEN ─────────────────────────────────────
    //    Best-effort: wenn Bot bereits raus / nicht Admin / Token fehlt
    //    → wird die DB-Bereinigung trotzdem durchgezogen.
    try {
      const token = await botToken.getToken();
      if (token) {
        report.leaveChat.attempted = true;
        const axios = require('axios');
        const resp = await axios.post(
          `https://api.telegram.org/bot${token}/leaveChat`,
          { chat_id: idNum },
          { timeout: 8000, validateStatus: () => true }
        );
        if (resp.data?.ok) {
          report.leaveChat.ok = true;
          logger.info(`[deleteChannel ${channelId}] Bot hat Gruppe verlassen`);
        } else {
          // Häufige Fälle: 403 (Bot bereits raus), 400 (chat not found)
          report.leaveChat.error = resp.data?.description || `HTTP ${resp.status}`;
          logger.warn(`[deleteChannel ${channelId}] leaveChat: ${report.leaveChat.error}`);
        }
      } else {
        report.leaveChat.error = 'Kein Bot-Token konfiguriert';
      }
    } catch (e) {
      report.leaveChat.error = e.message;
      logger.warn(`[deleteChannel ${channelId}] leaveChat Exception: ${e.message}`);
    }

    // 2) ALLE CHANNEL-DATEN AUS DER DB ENTFERNEN ──────────────────────────
    //    Liste deckt alle Tabellen mit channel_id ab (TEXT und BIGINT Varianten).
    //    Pro Tabelle wird mit String- UND Numeric-Wert probiert — robust gegen
    //    Schema-Inkonsistenzen zwischen channel_id TEXT vs BIGINT.
    const channelTables = [
      // Hauptdaten
      'channel_purchases',           // TEXT — Pakete/Refills
      'channel_co_admins',           // TEXT — Co-Admins
      'channel_members',             // BIGINT — Mitglieder-Cache
      'channel_safelist',            // TEXT
      'channel_blacklist',           // TEXT
      'channel_knowledge',           // BIGINT (ON DELETE CASCADE — bereits abgedeckt durch bot_channels-DELETE, aber safety)
      'channel_group_members',       // BIGINT (ON DELETE CASCADE)
      'channel_chat_history',        // TEXT
      'channel_context',             // TEXT
      'channel_message_log',         // TEXT
      'channel_banned_users',        // TEXT
      'channel_user_memory',         // TEXT
      'channel_user_points',         // TEXT (Activity Tracker)
      'channel_restrictions',        // TEXT (Mute/Ban Persistenz)
      'channel_credit_log',          // TEXT (Credit-Logging)
      // Nachrichten-bezogen
      'scheduled_messages',          // BIGINT
      'bot_messages',                // TEXT
      'cached_bot_texts',            // BIGINT
      // Moderation
      'scam_entries',                // TEXT
      'blacklist_hits',              // TEXT
      'channel_banned_users',        // TEXT (Duplikat — egal, idempotent)
      // Feedback
      'user_feedbacks',              // TEXT
      'user_reputation',             // TEXT
      'pending_feedback_confirms',   // TEXT
      'proof_sessions',              // TEXT
      'feedback_proofs',             // ?
      // Statistik
      'daily_summaries',             // TEXT
      'ai_usage_log',                // TEXT
      'ai_spam_violations',          // TEXT
      // Sonstiges
      'channel_groups'               // ohne channel_id evtl. — Fehler werden geswallowed
    ];

    // Duplikate entfernen
    const uniqueTables = [...new Set(channelTables)];

    await Promise.allSettled(uniqueTables.map(async (table) => {
      const cleanup = async (value, label) => {
        const { data, error } = await supabase.from(table)
          .delete({ count: 'exact' })
          .eq('channel_id', value)
          .select('channel_id', { count: 'exact', head: true });
        return { data, error, label };
      };

      // Versuche zuerst String-Variante, dann Numeric als Fallback bei Typ-Mismatch.
      let totalDeleted = 0;
      let lastErr = null;
      for (const [val, lbl] of [[idStr, 'string'], [idNum, 'numeric']]) {
        try {
          const { error } = await supabase.from(table).delete().eq('channel_id', val);
          if (!error) {
            // Erfolg → zähle wie viele Rows betroffen (separater HEAD-Count)
            try {
              const { count } = await supabase.from(table)
                .select('*', { count: 'exact', head: true })
                .eq('channel_id', val);
              // count nach DELETE sollte 0 sein, aber wir wollen vorher wissen
            } catch (_) {}
            totalDeleted++; // mind. ein Versuch erfolgreich
            break; // nicht beide Varianten doppelt machen
          }
          lastErr = error;
          // Typ-Mismatch (TEXT vs BIGINT) → mit nächstem Wert weiter versuchen
          if (!/operator does not exist|invalid input|integer out of range/i.test(error.message)) {
            // Anderer Fehler (z.B. relation does not exist) → abbrechen
            break;
          }
        } catch (e) {
          lastErr = e;
          if (!/operator does not exist|invalid input|integer out of range/i.test(e.message || '')) {
            break;
          }
        }
      }

      if (totalDeleted > 0) {
        report.tables.cleaned++;
        report.tables.details.push({ table, status: 'ok' });
      } else if (lastErr && /relation.*does not exist|could not find the table/i.test(lastErr.message)) {
        report.tables.skipped++;
        // Tabelle existiert nicht — kein Fehler, einfach skippen
      } else if (lastErr) {
        report.tables.failed++;
        report.tables.details.push({
          table,
          status: 'error',
          message: String(lastErr.message || lastErr).substring(0, 150)
        });
        logger.warn(`[deleteChannel ${channelId}] ${table}: ${lastErr.message}`);
      }
    }));

    // 3) BOT_CHANNELS ZULETZT LÖSCHEN ─────────────────────────────────────
    try {
      const { error } = await supabase.from('bot_channels').delete().eq('id', idNum);
      if (error) throw error;
      report.botChannelDeleted = true;
      // In-Memory Cache leeren falls vorhanden
      if (this._channelCache) delete this._channelCache[idNum];
    } catch (e) {
      logger.warn(`[deleteChannel ${channelId}] bot_channels DELETE: ${e.message}`);
      return res.status(500).json({
        error: 'Konnte bot_channels-Eintrag nicht löschen: ' + e.message,
        report
      });
    }

    logger.info(
      `[deleteChannel ${channelId}] Erfolgreich gelöscht ` +
      `(leaveChat=${report.leaveChat.ok ? 'ok' : 'skipped'}, ` +
      `tabellen: ${report.tables.cleaned} bereinigt, ${report.tables.failed} Fehler, ${report.tables.skipped} übersprungen)`
    );

    res.json({ success: true, report });
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
      const token = await botToken.getToken();
      if (!token) return res.status(400).json({ error: "Kein Bot-Token konfiguriert (SMALLTALK_BOT_TOKEN in Render setzen)" });

      const supabase_local = require("../config/supabase");
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

      const token = await botToken.getToken();
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
      const { ai_enabled, safelist_enabled, feedback_enabled, welcome_msg, goodbye_msg, system_prompt, ai_model } = req.body;
      const patch = { updated_at: new Date() };
      if (ai_enabled        !== undefined) patch.ai_enabled        = Boolean(ai_enabled);
      if (safelist_enabled  !== undefined) patch.safelist_enabled  = Boolean(safelist_enabled);
      if (feedback_enabled  !== undefined) patch.feedback_enabled  = Boolean(feedback_enabled);
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
