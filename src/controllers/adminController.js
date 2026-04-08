const supabase = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const scraperService = require('../services/scraperService');
const { getVersion } = require('../utils/versionLoader');

const adminController = {
  async getStats(req, res, next) {
    try {
      const { count: totalChats } = await supabase
        .from('chats')
        .select('*', { count: 'exact', head: true });

      const { count: activeManual } = await supabase
        .from('chats')
        .select('*', { count: 'exact', head: true })
        .eq('is_manual_mode', true);

      const { count: totalKnowledge } = await supabase
        .from('knowledge_base')
        .select('*', { count: 'exact', head: true });

      const { count: pendingLearning } = await supabase
        .from('learning_queue')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      const { data: tokenUsage } = await supabase
        .from('messages')
        .select('prompt_tokens, completion_tokens');

      const totalInput = tokenUsage ? tokenUsage.reduce((sum, m) => sum + (m.prompt_tokens || 0), 0) : 0;
      const totalOutput = tokenUsage ? tokenUsage.reduce((sum, m) => sum + (m.completion_tokens || 0), 0) : 0;

      const costInput = (totalInput / 1000000) * 0.28;
      const costOutput = (totalOutput / 1000000) * 0.42;
      const totalCost = (costInput + costOutput).toFixed(4);

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
    } catch (error) {
      next(error);
    }
  },

  async getChats(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('chats')
        .select('*')
        .order('updated_at', { ascending: false });

      if (error) throw error;
      res.json(data);
    } catch (error) {
      next(error);
    }
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
    } catch (error) {
      next(error);
    }
  },

  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      res.json(data || {});
    } catch (error) {
      next(error);
    }
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
    } catch (error) {
      next(error);
    }
  },

  async banUser(req, res, next) {
    try {
      const { identifier, reason } = req.body;
      const { data, error } = await supabase
        .from('blacklist')
        .insert([{ identifier, reason }])
        .select();

      if (error) throw error;
      res.json({ success: true, data: data[0] });
    } catch (error) {
      next(error);
    }
  },

  async getLearningQueue(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('learning_queue')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;
      res.json(data);
    } catch (error) {
      next(error);
    }
  },

  async resolveLearning(req, res, next) {
    try {
      const { questionId, adminAnswer } = req.body;
      await deepseekService.processLearningResponse(adminAnswer, questionId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },

  async savePushSubscription(req, res, next) {
    try {
      const { subscription } = req.body;
      const { error } = await supabase
        .from('admin_subscriptions')
        .upsert([{ subscription_data: subscription }], { onConflict: 'subscription_data' });

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },

  async startScraping(req, res, next) {
    try {
      const { urls } = req.body;
      if (!urls || !urls.length) return res.status(400).json({ error: 'Keine URLs angegeben' });

      const scrapedDataArray = await scraperService.processMultipleUrls(urls);
      const results = [];

      for (const data of scrapedDataArray) {
        for (const chunk of data.chunks) {
          const embedding = await deepseekService.generateEmbedding(chunk);

          await supabase.from('knowledge_base').insert([{
            content: `Quelle: ${data.url} (${data.title})\n\n${chunk}`,
            embedding: embedding,
            source: 'web_scrape',
            metadata: { url: data.url, title: data.title }
          }]);
        }
        results.push({ url: data.url, chunks: data.chunks.length });
      }

      res.json({ success: true, processed: results });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = adminController;
