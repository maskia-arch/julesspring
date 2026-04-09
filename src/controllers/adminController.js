const supabase        = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const scraperService  = require('../services/scraperService');
const sellauthService = require('../services/sellauthService');
const telegramService = require('../services/telegramService');
const { getVersion }  = require('../utils/versionLoader');
const jwt = require('jsonwebtoken');

const adminController = {

  // ─── AUTH ──────────────────────────────────────────────────────────────
  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign(
          { role: 'admin' },
          process.env.JWT_SECRET || 'ai-assistant-secret',
          { expiresIn: '24h' }
        );
        return res.json({ success: true, token });
      }
      res.status(401).json({ error: 'Falsche Zugangsdaten' });
    } catch (e) { next(e); }
  },

  // ─── STATS ────────────────────────────────────────────────────────────
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

      const totalIn  = (tokenUsage || []).reduce((s, m) => s + (m.prompt_tokens     || 0), 0);
      const totalOut = (tokenUsage || []).reduce((s, m) => s + (m.completion_tokens || 0), 0);
      const cost     = ((totalIn / 1_000_000) * 0.14 + (totalOut / 1_000_000) * 0.28).toFixed(4);

      res.json({
        version: getVersion(),
        stats: {
          totalChats:      totalChats    || 0,
          activeManual:    activeManual  || 0,
          knowledgeEntries:totalKnowledge|| 0,
          pendingLearning: pendingLearning||0,
          totalCost:       `${cost} $`,
          totalTokens:     totalIn + totalOut
        }
      });
    } catch (e) { next(e); }
  },

  // ─── CHATS ────────────────────────────────────────────────────────────
  async getChats(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('chats').select('*').order('updated_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async getChatMessages(req, res, next) {
    try {
      const { chatId } = req.params;
      const { data: chat } = await supabase.from('chats').select('is_manual_mode').eq('id', chatId).single();
      const { data: msgs, error } = await supabase.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ is_manual: chat?.is_manual_mode || false, messages: msgs || [] });
    } catch (e) { next(e); }
  },

  async updateChatStatus(req, res, next) {
    try {
      const { chatId } = req.params;
      const { is_manual_mode } = req.body;
      const { data, error } = await supabase
        .from('chats').update({ is_manual_mode, updated_at: new Date() }).eq('id', chatId).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },

  async sendManualMessage(req, res, next) {
    try {
      const { chatId, content } = req.body;
      if (!chatId || !content) return res.status(400).json({ error: 'chatId und content erforderlich' });

      const { data: chat } = await supabase.from('chats').select('platform').eq('id', chatId).single();

      await supabase.from('messages').insert([{ chat_id: chatId, role: 'assistant', content, is_manual: true }]);

      if (chat?.platform === 'telegram') {
        await telegramService.sendMessage(chatId, content);
      }

      await supabase.from('chats').update({ updated_at: new Date() }).eq('id', chatId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ─── SETTINGS ────────────────────────────────────────────────────────
  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (e) { next(e); }
  },

  async updateSettings(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('settings').upsert({ id: 1, ...req.body, updated_at: new Date() }).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },

  // ─── BLACKLIST ────────────────────────────────────────────────────────
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
      const { data, error } = await supabase.from('blacklist').insert([{ identifier, reason: reason || '' }]).select();
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

  // ─── LEARNING ────────────────────────────────────────────────────────
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

  // ─── KNOWLEDGE CATEGORIES ─────────────────────────────────────────────
  async getKnowledgeCategories(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('knowledge_categories').select('*, knowledge_base(count)').order('name');
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async createKnowledgeCategory(req, res, next) {
    try {
      const { name, color, icon } = req.body;
      if (!name) return res.status(400).json({ error: 'Name fehlt' });
      const { data, error } = await supabase.from('knowledge_categories').insert([{ name, color: color || '#4a9eff', icon: icon || '📌' }]).select();
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

  // ─── KNOWLEDGE BASE ───────────────────────────────────────────────────
  async getKnowledgeEntries(req, res, next) {
    try {
      const { category_id } = req.query;
      let q = supabase.from('knowledge_base')
        .select('id, title, content, source, category_id, created_at, knowledge_categories(name, color, icon)')
        .order('created_at', { ascending: false })
        .limit(200);

      if (category_id) q = q.eq('category_id', category_id);

      const { data, error } = await q;
      if (error) throw error;

      // Inhalt kürzen für Listenansicht
      const result = (data || []).map(e => ({
        ...e,
        content_preview: (e.content || '').substring(0, 200) + ((e.content || '').length > 200 ? '...' : '')
      }));

      res.json(result);
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

      const { data, error } = await supabase.from('knowledge_base').insert([{
        content:     fullContent,
        title:       title || null,
        category_id: category_id ? parseInt(category_id) : null,
        embedding,
        source: 'manual_entry'
      }]).select();

      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (e) { next(e); }
  },

  // ─── WEB SCRAPER ──────────────────────────────────────────────────────
  async discoverLinks(req, res, next) {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL fehlt' });
      const links = await scraperService.discoverLinks(url);
      res.json({ links });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },

  async startScraping(req, res, next) {
    try {
      const { urls, category_id } = req.body;
      if (!urls?.length) return res.status(400).json({ error: 'Keine URLs angegeben' });

      const scraped = await scraperService.processMultipleUrls(urls);
      let saved = 0;

      for (const page of scraped) {
        for (const chunk of page.chunks) {
          try {
            const embedding = await deepseekService.generateEmbedding(chunk);
            await supabase.from('knowledge_base').insert([{
              content:     `Quelle: ${page.url}\n${chunk}`,
              title:       page.title,
              category_id: category_id ? parseInt(category_id) : null,
              embedding,
              source:   'web_scrape',
              metadata: { url: page.url, title: page.title }
            }]);
            saved++;
          } catch (e) {
            console.warn(`Chunk für ${page.url} fehlgeschlagen:`, e.message);
          }
        }
      }

      res.json({ success: true, savedChunks: saved, processedUrls: scraped.length });
    } catch (e) { next(e); }
  },

  // ─── SELLAUTH INTEGRATION ─────────────────────────────────────────────

  // Verbindung testen
  async testSellauthConnection(req, res, next) {
    try {
      const { apiKey, shopId } = req.body;
      if (!apiKey || !shopId) return res.status(400).json({ error: 'API Key und Shop ID erforderlich' });
      const result = await sellauthService.testConnection(apiKey, shopId);
      res.json(result);
    } catch (e) { next(e); }
  },

  // Vollständiger Sync
  async syncSellauth(req, res, next) {
    try {
      // Konfiguration aus Settings laden (oder aus Request-Body für manuelle Tests)
      let { apiKey, shopId, shopUrl } = req.body || {};

      if (!apiKey || !shopId || !shopUrl) {
        const { data: settings } = await supabase.from('settings').select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
        apiKey  = apiKey  || settings?.sellauth_api_key  || '';
        shopId  = shopId  || settings?.sellauth_shop_id  || '';
        shopUrl = shopUrl || settings?.sellauth_shop_url || '';
      }

      if (!apiKey)  return res.status(400).json({ error: 'Kein Sellauth API Key konfiguriert. Bitte in den Einstellungen eintragen.' });
      if (!shopId)  return res.status(400).json({ error: 'Keine Sellauth Shop ID konfiguriert. Bitte in den Einstellungen eintragen.' });
      if (!shopUrl) return res.status(400).json({ error: 'Keine Shop URL konfiguriert (z.B. https://meinshop.sellauth.com). Bitte in den Einstellungen eintragen.' });

      const results = await sellauthService.syncToKnowledgeBase(apiKey, shopId, shopUrl);

      res.json({
        success: true,
        message: `${results.saved} von ${results.total} Produkten erfolgreich importiert.`,
        details: results
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },

  // Produkte ohne Sync anzeigen (Vorschau)
  async previewSellauthProducts(req, res, next) {
    try {
      const { data: settings } = await supabase.from('settings').select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
      const apiKey  = settings?.sellauth_api_key  || '';
      const shopId  = settings?.sellauth_shop_id  || '';
      const shopUrl = settings?.sellauth_shop_url || '';

      if (!apiKey || !shopId) return res.status(400).json({ error: 'Sellauth nicht konfiguriert' });

      const products = await sellauthService.getAllProducts(apiKey, shopId);
      const preview  = products.map(p => ({
        id:        p.id,
        name:      p.name,
        type:      p.type,
        price:     p.price,
        currency:  p.currency,
        stock:     p.stock_count,
        url:       shopUrl ? sellauthService.buildProductUrl(shopUrl, p.path) : p.path,
        variants:  (p.variants || []).length,
        visibility:p.visibility
      }));

      res.json({ products: preview, total: preview.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },

  // ─── TELEGRAM SETUP ───────────────────────────────────────────────────
  async setupWebhook(req, res, next) {
    try {
      const { appUrl } = req.body;
      if (!appUrl) return res.status(400).json({ error: 'appUrl fehlt' });
      const result = await telegramService.setWebhook(appUrl);
      res.json({ success: result.ok, description: result.description });
    } catch (e) { next(e); }
  },

  async getWebhookInfo(req, res, next) {
    try {
      const info = await telegramService.getWebhookInfo();
      res.json(info.result || info);
    } catch (e) { next(e); }
  },

  // ─── PUSH ────────────────────────────────────────────────────────────
  async savePushSubscription(req, res, next) {
    try {
      const { subscription } = req.body;
      const { error } = await supabase
        .from('admin_subscriptions').upsert([{ subscription_data: subscription }], { onConflict: 'subscription_data' });
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  }
};

module.exports = adminController;
