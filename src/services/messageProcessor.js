/**
 * messageProcessor.js v1.1.6
 * FIX: Alle supabase.query().catch() → try/catch oder void async IIFE
 * Supabase JS v2 QueryBuilder hat kein .catch() Methode
 */

const supabase         = require('../config/supabase');
const deepseekService  = require('./deepseekService');
const telegramService  = require('./telegramService');
const embeddingService = require('./embeddingService');
const logger           = require('../utils/logger');

// Settings-Cache (30s)
let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL_MS     = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();

    // 1. Chat + Settings parallel laden
    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);
    if (!chat) throw new Error('Chat konnte nicht angelegt werden');

    // 2. Nutzer-Nachricht speichern (fire & forget — kein .catch() auf Query)
    void (async () => {
      try {
        await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
      } catch (e) { logger.warn('[MP] user msg insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, text, 'user');

    // 3. Manuell-Modus
    if (chat.is_manual_mode) return null;

    // 4. Typing-Indikator
    if (platform === 'telegram') {
      // telegramService ist ein normaler Promise, .catch() ist hier OK
      telegramService.sendTypingAction(chatId).catch(() => {});
    }

    // 5. Embedding + History parallel
    const [context, history] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(10)
        .then(r => (r.data || []).reverse())
    ]);

    logger.info(`[MP] t=${Date.now()-t0}ms RAG:${context.length} hist:${history.length}`);

    // 6. KI-Antwort – mit Gesamt-Timeout (60s)
    const aiResult = await Promise.race([
      deepseekService.generateResponse(text, history, context, chat.id, settings),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('KI-Antwort Timeout nach 60s')), 60000)
      )
    ]);

    // 7. Telegram sofort senden
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    logger.info(`[MP] Gesamt: ${Date.now()-t0}ms`);

    // 8. DB-Saves fire & forget
    void (async () => {
      try {
        await supabase.from('messages').insert([{
          chat_id:           chat.id,
          role:              'assistant',
          content:           aiResult.text,
          prompt_tokens:     aiResult.promptTokens     || 0,
          completion_tokens: aiResult.completionTokens || 0
        }]);
      } catch (e) { logger.warn('[MP] ai msg insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, aiResult.text, 'assistant');

    // 9. Learning Queue bei leerem Kontext ODER [UNKLAR]
    const noContext = context.length === 0;
    const unclear   = aiResult.text.includes('[UNKLAR]');
    if (noContext || unclear) {
      void (async () => {
        try {
          await supabase.from('learning_queue').insert([{
            original_chat_id:    chat.id,
            unanswered_question: text,
            status:              'pending'
          }]);
        } catch (_) {}
      })();
      logger.info(`[MP] Learning Queue: "${text.substring(0,50)}" (noCtx=${noContext}, unklar=${unclear})`);
    }

    return aiResult.text;
  },

  async _searchKnowledge(query, settings) {
    try {
      const vector    = await embeddingService.createEmbedding(query);
      const threshold = parseFloat(settings.rag_threshold)  || 0.45;
      const count     = parseInt(settings.rag_match_count)  || 8;

      const { data: r1 } = await supabase.rpc('match_knowledge', {
        query_embedding: vector, match_threshold: threshold, match_count: count
      });
      if (r1?.length >= 2) return r1;

      const { data: r2 } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: Math.max(threshold - 0.15, 0.20),
        match_count:     count + 5
      });
      return r2?.length ? r2 : (r1 || []);
    } catch (err) {
      logger.warn(`[MP] Embedding Fehler: ${err.message}`);
      return [];
    }
  },

  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL_MS) return _settingsCache;
    try {
      const { data } = await supabase.from('settings').select('*').single();
      _settingsCache = {
        system_prompt:   data?.system_prompt   || 'Du bist ein hilfreicher Assistent.',
        negative_prompt: data?.negative_prompt || '',
        ai_model:        data?.ai_model        || 'deepseek-chat',
        ai_max_tokens:   data?.ai_max_tokens   || 1024,
        ai_temperature:  data?.ai_temperature  || 0.5,
        rag_threshold:   data?.rag_threshold   || 0.45,
        rag_match_count: data?.rag_match_count || 8,
      };
      _settingsCacheTime = now;
      return _settingsCache;
    } catch {
      return {
        system_prompt: 'Du bist ein hilfreicher Assistent.',
        negative_prompt: '', ai_model: 'deepseek-chat',
        ai_max_tokens: 1024, ai_temperature: 0.5,
        rag_threshold: 0.45, rag_match_count: 8
      };
    }
  },

  // FIX: kein .catch() auf Supabase-Query
  _updateChatPreview(chatId, message, role) {
    void (async () => {
      try {
        await supabase.from('chats').update({
          last_message:      (message || '').substring(0, 120),
          last_message_role: role,
          updated_at:        new Date()
        }).eq('id', chatId);
      } catch (_) {}
    })();
  },

  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase
        .from('chats').select('id, is_manual_mode, platform').eq('id', chatId).maybeSingle();
      if (existing) return existing;

      const ins = { id: chatId, platform, metadata: metadata || {} };
      if (metadata?.first_name) ins.first_name = metadata.first_name;
      if (metadata?.username)   ins.username   = metadata.username;

      const { data: created, error } = await supabase
        .from('chats').insert([ins]).select('id, is_manual_mode, platform').single();

      if (error?.code === '23505') {
        const { data: retry } = await supabase
          .from('chats').select('id, is_manual_mode, platform').eq('id', chatId).single();
        return retry;
      }
      if (error) {
        logger.warn(`[MP] Chat insert (nicht fatal): ${error.message}`);
        return { id: chatId, is_manual_mode: false, platform };
      }
      return created || { id: chatId, is_manual_mode: false, platform };
    } catch (err) {
      logger.error(`[MP] _getOrCreateChat: ${err.message}`);
      return { id: chatId, is_manual_mode: false, platform };
    }
  }
};

module.exports = messageProcessor;
