const supabase = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const scraperService = require('../services/scraperService');
const telegramService = require('../services/telegramService');
const { getVersion } = require('../utils/versionLoader');
const jwt = require('jsonwebtoken');

const adminController = {

  // ─── AUTH ──────────────────────────────────────────────────────────────────
  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign(
          { role: 'admin' },
          process.env.JWT_SECRET || 'super_secret_fallback_key',
          { expiresIn: '24h' }
        );
        return res.json({ success: true, token });
      }
      res.status(401).json({ error: 'Falsche Zugangsdaten' });
    } catch (error) {
      next(error);
    }
  },

  // ─── STATS ────────────────────────────────────────────────────────────────
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

      const totalInput = tokenUsage ? tokenUsage.reduce((s, m) => s + (m.prompt_tokens || 0), 0) : 0;
      const totalOutput = tokenUsage ? tokenUsage.reduce((s, m) => s + (m.completion_tokens || 0), 0) : 0;
      const totalCost = ((totalInput / 1_000_000) * 0.28 + (totalOutput / 1_000_000) * 0.42).toFixed(4);

      res.json({
        version: getVersion(),
        stats: {
          totalChats: totalChats || 0,
          activeManual: activeManual || 0,
          knowledgeEntries: totalKnowledge || 0,
          pendingLearning: pendingLearning || 0,
          totalCost: `${totalCost} $`,
          totalTokens: totalInput + totalOutput
        }
      });
    } catch (error) { next(error); }
  },

  // ─── CHATS ────────────────────────────────────────────────────────────────
  async getChats(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('chats')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      res.json(data || []);
    } catch (error) { next(error); }
  },

  async getChatMessages(req, res, next) {
    try {
      const { chatId } = req.params;
      const { data: chat } = await supabase
        .from('chats')
        .select('is_manual_mode')
        .eq('id', chatId)
        .single();

      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      res.json({
        is_manual: chat ? chat.is_manual_mode : false,
        messages: messages || []
      });
    } catch (error) { next(error); }
  },

  async updateChatStatus(req, res, next) {
    try {
      const { chatId } = req.params;
      const { is_manual_mode } = req.body;
      const { data, error } = await supabase
        .from('chats')
        .update({ is_manual_mode, updated_at: new Date() })
        .eq('id', chatId)
        .select();
      if (error) throw error;
      res.json(data[0]);
    } catch (error) { next(error); }
  },

  // BUGFIX: Sendet jetzt auch wirklich an Telegram
  async sendManualMessage(req, res, next) {
    try {
      const { chatId, content } = req.body;
      if (!chatId || !content) return res.status(400).json({ error: 'chatId und content erforderlich' });

      const { data: chat } = await supabase
        .from('chats')
        .select('platform')
        .eq('id', chatId)
        .single();

      // In DB speichern
      await supabase.from('messages').insert([{
        chat_id: chatId,
        role: 'assistant',
        content,
        is_manual: true
      }]);

      // An Telegram senden (chatId IS die Telegram-ID)
      if (chat && chat.platform === 'telegram') {
        await telegramService.sendMessage(chatId, content);
      }

      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ─── SETTINGS ────────────────────────────────────────────────────────────
  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (error) { next(error); }
  },

  async updateSettings(req, res, next) {
    try {
      const settings = req.body;
      const { data, error } = await supabase
        .from('settings')
        .upsert({ id: 1, ...settings, updated_at: new Date() })
        .select();
      if (error) throw error;
      res.json(data[0]);
    } catch (error) { next(error); }
  },

  // ─── BLACKLIST ────────────────────────────────────────────────────────────
  async getBlacklist(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('blacklist')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (error) { next(error); }
  },

  async banUser(req, res, next) {
    try {
      const { identifier, reason } = req.body;
      if (!identifier) return res.status(400).json({ error: 'Identifikator fehlt' });
      const { data, error } = await supabase
        .from('blacklist')
        .insert([{ identifier, reason: reason || '' }])
        .select();
      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (error) { next(error); }
  },

  async removeBan(req, res, next) {
    try {
      const { id } = req.params;
      const { error } = await supabase.from('blacklist').delete().eq('id', id);
      if (error) throw error;
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ─── LEARNING ────────────────────────────────────────────────────────────
  async getLearningQueue(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('learning_queue')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (error) { next(error); }
  },

  async resolveLearning(req, res, next) {
    try {
      const { questionId, adminAnswer } = req.body;
      if (!questionId || !adminAnswer) return res.status(400).json({ error: 'questionId und adminAnswer erforderlich' });
      await deepseekService.processLearningResponse(adminAnswer, questionId);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  // ─── WISSEN ───────────────────────────────────────────────────────────────
  async addManualKnowledge(req, res, next) {
    try {
      const { title, content } = req.body;
      if (!content) return res.status(400).json({ error: 'Inhalt fehlt' });

      const fullContent = title ? `### ${title}\n${content}` : content;
      const embedding = await deepseekService.generateEmbedding(fullContent);

      const { data, error } = await supabase
        .from('knowledge_base')
        .insert([{
          content: fullContent,
          embedding,
          source: 'manual_entry'
        }])
        .select();

      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (error) { next(error); }
  },

  async discoverLinks(req, res, next) {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL fehlt' });
      const links = await scraperService.discoverLinks(url);
      res.json({ links });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Link-Discovery fehlgeschlagen' });
    }
  },

  async startScraping(req, res, next) {
    try {
      const { urls } = req.body;
      if (!urls || !urls.length) return res.status(400).json({ error: 'Keine URLs angegeben' });

      const scrapedDataArray = await scraperService.processMultipleUrls(urls);
      let savedCount = 0;

      for (const data of scrapedDataArray) {
        for (const chunk of data.chunks) {
          try {
            const embedding = await deepseekService.generateEmbedding(chunk);
            await supabase.from('knowledge_base').insert([{
              content: `Quelle: ${data.url}\n${chunk}`,
              embedding,
              source: 'web_scrape',
              metadata: { url: data.url, title: data.title }
            }]);
            savedCount++;
          } catch (e) {
            console.warn(`Chunk für ${data.url} konnte nicht gespeichert werden:`, e.message);
          }
        }
      }

      res.json({ success: true, savedChunks: savedCount, processedUrls: scrapedDataArray.length });
    } catch (error) { next(error); }
  },

  async syncSellauth(req, res, next) {
    try {
      const { data: settings } = await supabase.from('settings').select('sellauth_api_key').single();
      if (!settings?.sellauth_api_key) {
        return res.status(400).json({ error: 'Kein Sellauth API Key in den Einstellungen konfiguriert.' });
      }
      // TODO: Sellauth API Integration implementieren
      res.status(501).json({ error: 'Sellauth-Sync noch nicht implementiert. Bitte Produkte manuell eingeben.' });
    } catch (error) { next(error); }
  },

  async savePushSubscription(req, res, next) {
    try {
      const { subscription } = req.body;
      const { error } = await supabase
        .from('admin_subscriptions')
        .upsert([{ subscription_data: subscription }], { onConflict: 'subscription_data' });
      if (error) throw error;
      res.json({ success: true });
    } catch (error) { next(error); }
  }
};

module.exports = adminController;
