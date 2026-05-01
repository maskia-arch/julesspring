const supabase            = require('../config/supabase');
const deepseekService     = require('./deepseekService');
const telegramService     = require('./telegramService');
const embeddingService    = require('./embeddingService');
const notificationService = require('./notificationService');
const abuseDetector       = require('./abuseDetector');
const couponService       = require('./couponService');
const clarityDetector     = require('./ai/clarityDetector');
const logger              = require('../utils/logger');

let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL        = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();
    const threadId = metadata?.message_thread_id || null;
    const botToken = metadata?.token || null;

    const abuse = await abuseDetector.check(chatId, text);
    if (abuse.blocked) {
      if (abuse.reason === 'rate_limit' && platform === 'telegram') {
        await telegramService.sendMessage(chatId, 'Bitte kurz warten.', { 
          message_thread_id: threadId,
          token: botToken 
        }).catch(() => {});
      }
      return null;
    }

    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);
    if (!chat) return null;

    const isFirstMessage = !chat._existed;

    void (async () => {
      try {
        await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
      } catch (e) {}
    })();

    this._updateChatPreview(chat.id, text, 'user');

    if (chat.is_manual_mode) return null;

    if (platform === 'telegram') {
      telegramService.sendTypingAction(chatId, { 
        message_thread_id: threadId,
        token: botToken 
      }).catch(() => {});
    }

    const maxHistory     = parseInt(settings.max_history_msgs)  || 4;
    const summaryInterval = parseInt(settings.summary_interval) || 5;

    const [context, allHistory, chatData] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content')
        .eq('chat_id', chat.id)
        .neq('role', 'system')
        .order('created_at', { ascending: false })
        .limit(20)
        .then(r => (r.data || []).reverse()),
      supabase.from('chats').select('chat_summary').eq('id', chat.id).maybeSingle().then(r => r.data || {})
    ]);

    const recentHistory = allHistory.slice(-maxHistory);
    const chatSummary   = chatData.chat_summary || null;

    const COUPON_KEYWORDS = /rabatt|coupon|gutschein|code|angebot|deal/i;
    let couponContext = null;
    let recentHistoryForAI = recentHistory;

    if (COUPON_KEYWORDS.test(text)) {
      try {
        const activeCoupon = await couponService.getActiveCouponFresh();
        if (activeCoupon) {
          couponContext = `AKTUELLER COUPON: Code "${activeCoupon.code}" - ${activeCoupon.description}.`;
        }
      } catch (e) {}
    }

    const dateContext = `HEUTIGES DATUM: ${new Date().toLocaleDateString('de-DE')}`;
    const fullSummary = [chatSummary, dateContext, couponContext].filter(Boolean).join('\n\n') || null;

    let aiResult;
    try {
      aiResult = await deepseekService.generateResponse(text, recentHistoryForAI, context, chat.id, settings, fullSummary);
    } catch (aiErr) {
      aiResult = { text: 'Dienst kurzzeitig überlastet. Bitte gleich nochmal versuchen.', promptTokens: 0, completionTokens: 0 };
    }

    if (platform === 'telegram' && aiResult?.text) {
      await this._sendReliable(chatId, aiResult.text, 3, threadId, botToken);
    }

    void (async () => {
      try {
        await supabase.from('messages').insert([{
          chat_id: chat.id, role: 'assistant', content: aiResult.text,
          prompt_tokens: aiResult.promptTokens || 0,
          completion_tokens: aiResult.completionTokens || 0
        }]);
      } catch (e) {}
    })();

    this._updateChatPreview(chat.id, aiResult.text, 'assistant');

    return aiResult.text;
  },

  async _searchKnowledge(query, settings) {
    try {
      const embResult = await embeddingService.createEmbedding(query);
      if (!embResult) return [];
      
      const vector = embResult.embedding;
      const threshold = parseFloat(settings.rag_threshold) || 0.45;
      const maxCount = parseInt(settings.rag_match_count) || 6;

      const { data } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: threshold,
        match_count: maxCount
      });

      return data || [];
    } catch (err) {
      return [];
    }
  },

  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL) return _settingsCache;
    try {
      const { data } = await supabase.from('settings').select('*').single();
      _settingsCache = {
        system_prompt: data?.system_prompt || 'Du bist ein Assistent.',
        ai_model: data?.ai_model || 'deepseek-chat',
        ai_max_tokens: data?.ai_max_tokens || 1024,
        ai_temperature: data?.ai_temperature || 0.5,
        rag_threshold: data?.rag_threshold || 0.45,
        rag_match_count: data?.rag_match_count || 8,
        max_history_msgs: data?.max_history_msgs || 4,
        summary_interval: data?.summary_interval || 5,
      };
      _settingsCacheTime = now;
      return _settingsCache;
    } catch {
      return { system_prompt: 'Assistent', ai_model: 'deepseek-chat', max_history_msgs: 4 };
    }
  },

  _pendingDeliveries: new Map(),

  async _sendReliable(chatId, text, maxAttempts = 3, threadId = null, token = null) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await telegramService.sendMessage(chatId, text, { 
          message_thread_id: threadId,
          token: token 
        });
        return;
      } catch (e) {
        if (attempt === maxAttempts) logger.error(`[MP] Zustellung fehlgeschlagen: ${chatId}`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  },

  _updateChatPreview(chatId, message, role) {
    void (async () => {
      try {
        await supabase.from('chats').update({
          last_message: (message || '').substring(0, 120),
          last_message_role: role,
          updated_at: new Date()
        }).eq('id', chatId);
      } catch (_) {}
    })();
  },

  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase.from('chats').select('*').eq('id', chatId).maybeSingle();
      if (existing) return { ...existing, _existed: true };

      const ins = { id: chatId, platform, first_name: metadata?.first_name || 'Nutzer', username: metadata?.username || null };
      const { data: created } = await supabase.from('chats').insert([ins]).select().single();
      return { ...(created || { id: chatId }), _existed: false };
    } catch (err) {
      return { id: chatId, _existed: false };
    }
  }
};

module.exports = messageProcessor;
