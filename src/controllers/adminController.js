/**
 * AdminHelper - Admin Controller
 * Enthaelt nur Funktionen die im AdminHelper-Dashboard genutzt werden.
 */
const supabase           = require('../config/supabase');
const sellauthService    = require('../services/sellauthService');
const { getVersion }     = require('../utils/versionLoader');
const notificationService = require('../services/notificationService');
const botToken           = require('../config/botToken');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const adminController = {

  // ─── Auth ────────────────────────────────────────────────────────────────
  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'ai-adminhelper-secret', { expiresIn: '24h' });
        return res.json({ success: true, token });
      }
      res.status(401).json({ error: 'Falsche Zugangsdaten' });
    } catch (e) { next(e); }
  },

  // ─── Stats (Channels + AdminHelper) ──────────────────────────────────────
  // v2.0.0: liefert sowohl flache Felder (Rueckwaerts-Kompatibilitaet) als auch
  // ein verschachteltes `stats`-Objekt, das das Dashboard fuer die KPI-Leiste
  // erwartet. JEDE Teilabfrage ist gekapselt → ein fehlendes Tabellen-Schema
  // legt das Dashboard NICHT lahm.
  // Cache-Variablen
  _statsCache: null,
  _statsCacheTime: 0,

  async getStats(req, res, next) {
    try {
      const now = Date.now();
      // Cache für 10 Sekunden verwenden
      if (adminController._statsCache && (now - adminController._statsCacheTime < 10000)) {
        return res.json(adminController._statsCache);
      }

      const c = async (table, build) => {
        try {
          let q = supabase.from(table).select('*', { count: 'exact', head: true });
          if (typeof build === 'function') q = build(q);
          const { count } = await q;
          return count || 0;
        } catch (_) { return 0; }
      };

      const nowIso = new Date().toISOString();
      const [
        totalChannels, activeChannels, approvedChannels,
        kbEntries, totalMembers, scamEntries, safelistEntries,
        pendingFeedback, scheduledActive
      ] = await Promise.all([
        c('bot_channels'),
        c('bot_channels', q => q.eq('ai_enabled', true)),
        c('bot_channels', q => q.eq('is_approved', true)),
        c('channel_knowledge'),
        c('channel_members'),
        c('scam_entries'),
        c('channel_safelist'),
        c('user_feedbacks', q => q.eq('status', 'pending')),
        c('scheduled_messages', q => q.eq('is_active', true))
      ]);

      // Credits/Token aggregieren
      let creditsUsed = 0, creditLimit = 0;
      try {
        const { data: chans } = await supabase.from('bot_channels').select('token_used, token_limit');
        (chans || []).forEach(ch => {
          creditsUsed += parseInt(ch.token_used || 0) || 0;
          creditLimit += parseInt(ch.token_limit || 0) || 0;
        });
      } catch (_) {}

      const version = getVersion();

      const responseData = {
        // Flache Felder (alte Clients)
        totalChannels, activeChannels, kbEntries, version,
        // Verschachteltes Objekt fuer die KPI-Leiste
        stats: {
          totalChannels, activeChannels, approvedChannels,
          totalMembers, scamEntries, safelistEntries,
          pendingFeedback, scheduledActive,
          knowledgeEntries: kbEntries,
          creditsUsed, creditLimit
        }
      };

      // In den Cache schreiben
      adminController._statsCache = responseData;
      adminController._statsCacheTime = now;

      res.json(responseData);
    } catch (e) { next(e); }
  },

  // ─── Settings ────────────────────────────────────────────────────────────
  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase.from('settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      const safe = Object.assign({}, data || {});
      // Nicht alle sensitiven Daten im Browser exposen
      delete safe.sellauth_api_key;
      delete safe.smalltalk_bot_token; // Token kommt aus der Server-ENV, nie an den Client
      // Status, ob ein Bot-Token serverseitig verfügbar ist (ENV oder Legacy-DB)
      safe.smalltalk_token_set = botToken.isFromEnv || !!(data && data.smalltalk_bot_token);
      safe.smalltalk_token_source = botToken.isFromEnv ? 'env' : (data && data.smalltalk_bot_token ? 'db' : 'none');
      res.json(safe);
    } catch (e) { next(e); }
  },

  async updateSettings(req, res, next) {
    try {
      const allowed = [
        'webhook_url',
        // AdminHelper-spezifisch
        'smalltalk_system_prompt', 'smalltalk_model', 'smalltalk_max_tokens', 'smalltalk_temperature',
        'smalltalk_kb_category_id', 'smalltalk_bot_username', 'smalltalk_bot_firstname',
        'smalltalk_require_approval',
        'admin_report_enabled', 'admin_report_ai_enabled', 'admin_report_actions',
        // Sellauth Zugangsdaten fuer Channel-Pakete-Lookup
        'sellauth_api_key', 'sellauth_shop_id', 'sellauth_shop_url'
      ];
      const patch = {};
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
      patch.id = 1;
      patch.updated_at = new Date();
      const { error } = await supabase.from('settings').upsert(patch);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ─── Push-Notifications fuer das Dashboard ──────────────────────────────
  async getVapidPublicKey(req, res) {
    res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
  },

  async sendTestPush(req, res, next) {
    try {
      const ok = await notificationService.sendTestNotification();
      res.json({ ok: !!ok });
    } catch (e) { next(e); }
  },

  async savePushSubscription(req, res, next) {
    try {
      const { subscription, deviceLabel } = req.body || {};
      if (!subscription?.endpoint) return res.status(400).json({ error: 'endpoint fehlt' });
      const base = {
        endpoint: subscription.endpoint,
        subscription_data: subscription,
        updated_at: new Date()
      };
      // Erst mit device_label versuchen; falls die Spalte fehlt (Schema-Abweichung)
      // → ohne device_label erneut versuchen, damit Push nicht mit 500 scheitert.
      let { error } = await supabase.from('admin_subscriptions')
        .upsert({ ...base, device_label: deviceLabel || null }, { onConflict: 'endpoint' });
      if (error && /device_label/.test(error.message || '')) {
        ({ error } = await supabase.from('admin_subscriptions')
          .upsert(base, { onConflict: 'endpoint' }));
      }
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ─── Smalltalk-Bot Status / Connect ──────────────────────────────────────
  async testSmallTalkBot(req, res, next) {
    try {
      const token = await botToken.getToken();
      if (!token) return res.json({ connected: false, error: 'Kein Token konfiguriert. Bitte SMALLTALK_BOT_TOKEN als Environment-Variable in Render setzen.' });

      const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
      if (!r.data?.ok) return res.json({ connected: false, error: r.data?.description || 'Bot nicht erreichbar' });

      const info = r.data.result;
      // Username/Firstname zur Anzeige speichern (kein Token in der DB)
      try {
        await supabase.from('settings').upsert({
          id: 1,
          smalltalk_bot_username: info.username,
          smalltalk_bot_firstname: info.first_name,
          updated_at: new Date()
        });
      } catch (_) {}

      // Webhook (re)setzen — URL aus APP_URL oder Render-Auto-URL
      const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
      if (appUrl) {
        await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, {
          url: `${appUrl}/api/webhooks/smalltalk`,
          allowed_updates: ['message','callback_query','my_chat_member','chat_member','channel_post','message_reaction'],
          drop_pending_updates: false
        }, { timeout: 10000 }).catch(() => {});
      }
      res.json({ connected: true, source: botToken.isFromEnv ? 'env' : 'db', bot: { id: info.id, username: info.username, firstname: info.first_name } });
    } catch (e) {
      res.json({ connected: false, error: e.response?.data?.description || e.message });
    }
  }
};

module.exports = adminController;
