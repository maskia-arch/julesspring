const supabase        = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const scraperService  = require('../services/scraperService');
const sellauthService  = require('../services/sellauthService');
const syncJobManager   = require('../services/syncJobManager');
const telegramService = require('../services/telegramService');
const { getVersion }      = require('../utils/versionLoader');
const notificationService = require('../services/notificationService');
// abuseDetector wird lazy geladen - verhindert Crash wenn schema10.sql noch nicht ausgeführt
function getAbuseDetector() {
  try { return require('../services/abuseDetector'); }
  catch(e) { return null; }
}
const jwt = require('jsonwebtoken');

const adminController = {

  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'ai-assistant-secret', { expiresIn: '24h' });
        return res.json({ success: true, token });
      }
      res.status(401).json({ error: 'Falsche Zugangsdaten' });
    } catch (e) { next(e); }
  },

  async getStats(req, res, next) {
    try {
      const [
        { count: totalChats },
        { count: activeManual },
        { count: totalKnowledge },
        { count: pendingLearning },
        { data: tokenUsage }
      ] = await Promise.all([
        supabase.from('chats').select('*', { count: 'exact', head: true }),
        supabase.from('chats').select('*', { count: 'exact', head: true }).eq('is_manual_mode', true),
        supabase.from('knowledge_base').select('*', { count: 'exact', head: true }),
        supabase.from('learning_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('messages').select('prompt_tokens, completion_tokens')
      ]);
      const tin   = (tokenUsage||[]).reduce((s,m) => s+(m.prompt_tokens||0), 0);
      const tout  = (tokenUsage||[]).reduce((s,m) => s+(m.completion_tokens||0), 0);
      const temb  = (tokenUsage||[]).reduce((s,m) => s+(m.embedding_tokens||0), 0);

      // Aktuelle Preise (April 2026):
      // DeepSeek V3.2: $0.28/M input (cache miss), $0.42/M output
      // OpenAI text-embedding-3-small: $0.020/M tokens
      const costDeepseek  = (tin  / 1_000_000) * 0.28 + (tout / 1_000_000) * 0.42;
      const costEmbedding = (temb / 1_000_000) * 0.020;
      const cost = (costDeepseek + costEmbedding).toFixed(4);
      res.json({
        version: getVersion(),
        stats: {
          totalChats: totalChats||0, activeManual: activeManual||0,
          knowledgeEntries: totalKnowledge||0, pendingLearning: pendingLearning||0,
          totalCost: `${cost} $`, totalTokens: tin+tout, embeddingTokens: temb
        }
      });
    } catch (e) { next(e); }
  },

  async getChats(req, res, next) {
    try {
      const { data, error } = await supabase.from('chats').select('*').order('updated_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json((data||[]).map(c => ({
        ...c,
        is_manual_mode:    c.is_manual_mode    ?? false,
        last_message:      c.last_message      ?? null,
        last_message_role: c.last_message_role ?? 'user',
        first_name:        c.first_name        ?? c.metadata?.first_name ?? null,
        username:          c.username          ?? c.metadata?.username   ?? null,
      })));
    } catch (e) { next(e); }
  },

  async getChatMessages(req, res, next) {
    try {
      const { chatId } = req.params;
      const [{ data: chat }, { data: msgs, error }] = await Promise.all([
        supabase.from('chats').select('*').eq('id', chatId).single(),
        supabase.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: true }).limit(200)
      ]);
      if (error) throw error;
      res.json({ is_manual: chat?.is_manual_mode ?? false, chat_info: chat || {}, messages: msgs || [] });
    } catch (e) { next(e); }
  },

  async updateChatStatus(req, res, next) {
    try {
      const { is_manual_mode } = req.body;
      const { data, error } = await supabase.from('chats').update({ is_manual_mode, updated_at: new Date() }).eq('id', req.params.chatId).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },

  async sendManualMessage(req, res, next) {
    try {
      const { chatId, content } = req.body;
      if (!chatId || !content) return res.status(400).json({ error: 'Fehlende Felder' });
      const { data: chat } = await supabase.from('chats').select('platform').eq('id', chatId).single();
      // FIX: void async IIFE statt .catch() (Supabase v2 hat kein .catch())
      void (async () => { try { await supabase.from('messages').insert([{ chat_id: chatId, role: 'assistant', content, is_manual: true }]); } catch (_) {} })();
      void (async () => { try { await supabase.from('chats').update({ last_message: content.substring(0,120), last_message_role: 'assistant', updated_at: new Date() }).eq('id', chatId); } catch (_) {} })();
      if (chat?.platform === 'telegram') await telegramService.sendMessage(chatId, content);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (e) { next(e); }
  },

  async updateSettings(req, res, next) {
    try {
      const body = req.body;

      // Strategie: Zuerst alle bekannten sicheren Felder updaten,
      // dann unbekannte/neue Felder einzeln versuchen.
      // So schlägt das Speichern nie still fehl.

      const coreFields = {
        id:                   1,
        updated_at:           new Date(),
        system_prompt:        body.system_prompt        ?? undefined,
        negative_prompt:      body.negative_prompt      ?? undefined,
        welcome_message:      body.welcome_message      ?? undefined,
        manual_msg_template:  body.manual_msg_template  ?? undefined,
        sellauth_api_key:     body.sellauth_api_key     ?? undefined,
        sellauth_shop_id:     body.sellauth_shop_id     ?? undefined,
        sellauth_shop_url:    body.sellauth_shop_url    ?? undefined,
        webhook_url:          body.webhook_url          ?? undefined,
        ai_model:             body.ai_model             ?? undefined,
        ai_max_tokens:        body.ai_max_tokens        !== undefined ? parseInt(body.ai_max_tokens)    : undefined,
        ai_temperature:       body.ai_temperature       !== undefined ? parseFloat(body.ai_temperature) : undefined,
        rag_threshold:        body.rag_threshold        !== undefined ? parseFloat(body.rag_threshold)  : undefined,
        rag_match_count:      body.rag_match_count      !== undefined ? parseInt(body.rag_match_count)  : undefined,
      };

      // undefined-Felder entfernen (nicht überschreiben wenn nicht gesendet)
      Object.keys(coreFields).forEach(k => coreFields[k] === undefined && delete coreFields[k]);

      const { data, error } = await supabase.from('settings').upsert(coreFields).select();

      if (error) {
        console.error('[Settings] Save Fehler:', error.message);
        return res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden: ' + error.message });
      }

      // Geladene Settings zurückgeben damit Frontend sync bleibt
      const { data: fresh } = await supabase.from('settings').select('*').eq('id', 1).single();
      res.json(fresh || data?.[0] || {});
    } catch (e) { next(e); }
  },

  // ── Telegram Webhook ──────────────────────────────────────────────────────
  // FIX: Webhook-URL wird in settings.webhook_url gespeichert
  async setupWebhook(req, res, next) {
    try {
      const { appUrl } = req.body;
      if (!appUrl) return res.status(400).json({ error: 'appUrl fehlt' });

      const result = await telegramService.setWebhook(appUrl);

      if (result.ok) {
        // URL persistent in DB speichern
        await supabase.from('settings')
          .upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() })
          .catch(e => console.warn('[Webhook] DB-Speicherung fehlgeschlagen:', e.message));
      }

      res.json({ success: result.ok, description: result.description || '' });
    } catch (e) { next(e); }
  },

  async getWebhookInfo(req, res, next) {
    try {
      const info = await telegramService.getWebhookInfo();
      res.json(info.result || info);
    } catch (e) { next(e); }
  },

  // ── Blacklist ──────────────────────────────────────────────────────────────
  async getBlacklist(req, res, next) {
    try {
      const { data, error } = await supabase.from('blacklist').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },
  async banUser(req, res, next) {
    try {
      const { identifier, reason } = req.body;
      if (!identifier) return res.status(400).json({ error: 'Identifikator fehlt' });
      const { data, error } = await supabase.from('blacklist').insert([{ identifier, reason: reason||'' }]).select();
      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (e) { next(e); }
  },
  async removeBan(req, res, next) {
    try {
      const { error } = await supabase.from('blacklist').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Learning ───────────────────────────────────────────────────────────────
  async getLearningQueue(req, res, next) {
    try {
      const { data, error } = await supabase.from('learning_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },
  async resolveLearning(req, res, next) {
    try {
      const { questionId, adminAnswer } = req.body;
      if (!questionId || !adminAnswer) return res.status(400).json({ error: 'Fehlende Felder' });
      await deepseekService.processLearningResponse(adminAnswer, questionId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async deleteLearning(req, res, next) {
    try {
      const { error } = await supabase.from('learning_queue').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Abuse / Flagging ───────────────────────────────────────────────────

  async getFlags(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('user_flags').select('*, chats(id, platform, first_name, username, flag_count, auto_muted)')
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async flagChat(req, res, next) {
    try {
      const { chatId, reason } = req.body;
      if (!chatId) return res.status(400).json({ error: 'chatId fehlt' });
      const ad = getAbuseDetector(); if (!ad) return res.status(503).json({ error: 'Abuse-System nicht verfügbar (schema10.sql ausführen)' });
      const result = await ad.flagByAdmin(chatId, reason || 'manual');
      res.json({ success: true, ...result });
    } catch (e) { next(e); }
  },

  async unflagChat(req, res, next) {
    try {
      const { chatId } = req.params;
      await supabase.from('user_flags').delete().eq('chat_id', chatId);
      await supabase.from('chats').update({ flag_count: 0, auto_muted: false, mute_reason: null }).eq('id', chatId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async unmuteChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const ad2 = getAbuseDetector(); if (ad2) await ad2.unmute(chatId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getFlaggedChats(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('chats')
        .select('id, platform, first_name, username, flag_count, auto_muted, mute_reason, updated_at')
        .gt('flag_count', 0)
        .order('flag_count', { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  // ── Knowledge Categories ──────────────────────────────────────────────────
  async getKnowledgeCategories(req, res, next) {
    try {
      const { data, error } = await supabase.from('knowledge_categories').select('*').order('name');
      if (error) { return res.json([]); }
      res.json(data || []);
    } catch (e) { res.json([]); }
  },
  async createKnowledgeCategory(req, res, next) {
    try {
      const { name, color, icon } = req.body;
      if (!name) return res.status(400).json({ error: 'Name fehlt' });
      const { data, error } = await supabase.from('knowledge_categories').insert([{ name, color: color||'#4a9eff', icon: icon||'📌' }]).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },
  async deleteKnowledgeCategory(req, res, next) {
    try {
      const { error } = await supabase.from('knowledge_categories').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Knowledge Entries ─────────────────────────────────────────────────────
  async getKnowledgeEntries(req, res, next) {
    try {
      const { category_id } = req.query;
      let q = supabase.from('knowledge_base').select('id, title, content, source, category_id, created_at')
        .order('created_at', { ascending: false }).limit(200);
      if (category_id) q = q.eq('category_id', category_id);
      const { data, error } = await q;
      if (error) throw error;
      let cats = [];
      try { const { data: c } = await supabase.from('knowledge_categories').select('id, name, color, icon'); cats = c||[]; } catch {}
      const catMap = {};
      cats.forEach(c => { catMap[c.id] = c; });
      res.json((data||[]).map(e => ({ ...e, content_preview: (e.content||'').substring(0,200), knowledge_categories: e.category_id ? catMap[e.category_id]||null : null })));
    } catch (e) { next(e); }
  },
  async deleteKnowledgeEntry(req, res, next) {
    try {
      const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },
  async addManualKnowledge(req, res, next) {
    try {
      const { title, content, category_id } = req.body;
      if (!content) return res.status(400).json({ error: 'Inhalt fehlt' });
      const fullContent = title ? `### ${title}\n${content}` : content;
      const embedding   = await deepseekService.generateEmbedding(fullContent);
      const ins = { content: fullContent, title: title||null, embedding, source: 'manual_entry' };
      if (category_id) ins.category_id = parseInt(category_id);
      const { data, error } = await supabase.from('knowledge_base').insert([ins]).select();
      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (e) { next(e); }
  },

  // ── Scraper ───────────────────────────────────────────────────────────────
  async discoverLinks(req, res, next) {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL fehlt' });
      res.json({ links: await scraperService.discoverLinks(url) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },
  async startScraping(req, res, next) {
    try {
      const { urls, category_id } = req.body;
      if (!urls?.length) return res.status(400).json({ error: 'Keine URLs' });
      const scraped = await scraperService.processMultipleUrls(urls);
      let saved = 0;
      for (const page of scraped) {
        for (const chunk of page.chunks) {
          try {
            const emb = await deepseekService.generateEmbedding(chunk);
            const ins = { content: `Quelle: ${page.url}\n${chunk}`, title: page.title, embedding: emb, source: 'web_scrape', metadata: { url: page.url } };
            if (category_id) ins.category_id = parseInt(category_id);
            await supabase.from('knowledge_base').insert([ins]);
            saved++;
          } catch {}
        }
      }
      res.json({ success: true, savedChunks: saved, processedUrls: scraped.length });
    } catch (e) { next(e); }
  },

  // ── Sellauth ──────────────────────────────────────────────────────────────
  async testSellauthConnection(req, res, next) {
    try {
      const { apiKey, shopId } = req.body;
      if (!apiKey || !shopId) return res.status(400).json({ error: 'API Key und Shop ID erforderlich' });
      res.json(await sellauthService.testConnection(apiKey, shopId));
    } catch (e) { next(e); }
  },
  // Sync startet als Hintergrund-Job, gibt sofort jobId zurück
  async syncSellauth(req, res, next) {
    try {
      let { apiKey, shopId, shopUrl } = req.body || {};
      if (!apiKey || !shopId || !shopUrl) {
        const { data: s } = await supabase.from('settings').select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
        apiKey  = apiKey  || s?.sellauth_api_key  || '';
        shopId  = shopId  || s?.sellauth_shop_id  || '';
        shopUrl = shopUrl || s?.sellauth_shop_url || '';
      }
      if (!apiKey)  return res.status(400).json({ error: 'Kein API Key. Settings → Sellauth.' });
      if (!shopId)  return res.status(400).json({ error: 'Keine Shop ID. Settings → Sellauth.' });
      if (!shopUrl) return res.status(400).json({ error: 'Keine Shop URL. Settings → Sellauth.' });

      // Job anlegen + sofort antworten
      const jobId = syncJobManager.createJob();
      res.json({ success: true, jobId, message: 'Sync gestartet' });

      // Im Hintergrund weiterlaufen – unabhängig vom Browser
      setImmediate(async () => {
        try {
          const results = await sellauthService.syncToKnowledgeBase(apiKey, shopId, shopUrl, jobId);
          syncJobManager.finishJob(jobId, results);
        } catch (err) {
          syncJobManager.failJob(jobId, err.message);
        }
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  // Sync-Status abfragen
  async getSyncStatus(req, res, next) {
    try {
      const job = syncJobManager.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job nicht gefunden oder abgelaufen' });
      res.json(job);
    } catch (e) { next(e); }
  },
  async previewSellauthProducts(req, res, next) {
    try {
      const { data: s } = await supabase.from('settings').select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
      if (!s?.sellauth_api_key || !s?.sellauth_shop_id) return res.status(400).json({ error: 'Sellauth nicht konfiguriert' });
      const products = await sellauthService.getAllProducts(s.sellauth_api_key, s.sellauth_shop_id);
      res.json({
        products: products.map(p => ({
          id: p.id, name: p.name, type: p.type, price: p.price, currency: p.currency,
          stock: p.stock_count,
          url: s.sellauth_shop_url ? sellauthService.buildProductUrl(s.sellauth_shop_url, p.path) : p.path,
          variants: (p.variants||[]).length, visibility: p.visibility
        })),
        total: products.length
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  async savePushSubscription(req, res, next) {
    try {
      const { subscription } = req.body;
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Ungültige Subscription' });

      // Subscription als JSON-String speichern für web-push Kompatibilität
      const subData = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);

      // Zuerst alte Einträge für diesen Endpoint entfernen
      await supabase.from('admin_subscriptions').delete()
        .filter('subscription_data->endpoint', 'eq', subscription.endpoint);

      await supabase.from('admin_subscriptions').insert([{
        subscription_data: subData
      }]);

      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getVapidPublicKey(req, res, next) {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY nicht konfiguriert' });
    res.json({ publicKey: key });
  },

  async sendTestPush(req, res, next) {
    try {
      await notificationService.sendTestNotification();
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async updateNotificationSettings(req, res, next) {
    try {
      const { notify_new_chat, notify_every_msg } = req.body;
      await supabase.from('settings').upsert({
        id: 1,
        notify_new_chat:  notify_new_chat  !== undefined ? Boolean(notify_new_chat)  : true,
        notify_every_msg: notify_every_msg !== undefined ? Boolean(notify_every_msg) : false,
        updated_at: new Date()
      });
      res.json({ success: true });
    } catch (e) { next(e); }
  }
};

module.exports = adminController;
