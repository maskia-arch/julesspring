/**
 * messageProcessor.js v1.2
 *
 * - Abuse-Check vor jeder Verarbeitung
 * - Human Handover: KI sofort aus wenn is_manual_mode
 * - Push-Benachrichtigung an Admin
 * - Graceful Degradation bei allen optionalen Modulen
 */

const supabase            = require('../config/supabase');
const deepseekService     = require('./deepseekService');
const telegramService     = require('./telegramService');
const embeddingService    = require('./embeddingService');
const notificationService = require('./notificationService');
const abuseDetector       = require('./abuseDetector');
const logger              = require('../utils/logger');

let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL        = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();

    // ── 1. Abuse-Check (vor allem anderen) ────────────────────────────────
    const abuse = await abuseDetector.check(chatId, text);
    if (abuse.blocked) {
      logger.info(`[MP] Blocked ${chatId}: ${abuse.reason}`);
      if (abuse.reason === 'rate_limit') {
        // Kurze Rückmeldung bei Rate-Limit (keine KI-Kosten)
        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId,
            'Bitte sende nicht so viele Nachrichten auf einmal. Warte kurz und versuche es erneut.').catch(() => {});
        }
      }
      return null;
    }

    // ── 2. Chat + Settings parallel ──────────────────────────────────────
    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);
    if (!chat) throw new Error('Chat konnte nicht angelegt werden');

    const isFirstMessage = !chat._existed;

    // ── 3. Nutzer-Nachricht speichern ─────────────────────────────────────
    void (async () => {
      try {
        await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
      } catch (e) { logger.warn('[MP] msg insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, text, 'user');

    // ── 4. Admin Push-Benachrichtigung ────────────────────────────────────
    void (async () => {
      try {
        await notificationService.sendNewMessageNotification({
          chatId: chat.id, text,
          firstName: metadata?.first_name || null,
          platform,
          isFirstMessage
        });
      } catch (_) {}
    })();

    // ── 5. Human Handover: KI sofort aus ──────────────────────────────────
    // Wenn Admin den Chat übernommen hat → keine KI-Antwort, keine Kosten
    if (chat.is_manual_mode) {
      logger.info(`[MP] Manuell-Modus: ${chatId} – KI pausiert`);
      return null;
    }

    // ── 6. Typing-Indikator ────────────────────────────────────────────────
    if (platform === 'telegram') telegramService.sendTypingAction(chatId).catch(() => {});

    // ── 7. RAG + History parallel ──────────────────────────────────────────
    const [context, historyResult] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(6)
        .then(r => (r.data || []).reverse())
    ]);

    logger.info(`[MP] ${Date.now()-t0}ms – RAG:${context.length} hist:${historyResult.length}`);

    // ── 8. KI-Antwort (mit 60s Gesamt-Timeout) ────────────────────────────
    const aiResult = await Promise.race([
      deepseekService.generateResponse(text, historyResult, context, chat.id, settings),
      new Promise((_, reject) => setTimeout(() => reject(new Error('KI-Timeout')), 60000))
    ]);

    // ── 9. Telegram senden ────────────────────────────────────────────────
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    logger.info(`[MP] Gesamt: ${Date.now()-t0}ms`);

    // ── 10. DB fire & forget ──────────────────────────────────────────────
    void (async () => {
      try {
        await supabase.from('messages').insert([{
          chat_id: chat.id, role: 'assistant', content: aiResult.text,
          prompt_tokens:     aiResult.promptTokens     || 0,
          completion_tokens: aiResult.completionTokens || 0,
          embedding_tokens:  this._lastEmbeddingTokens || 0
        }]);
        this._lastEmbeddingTokens = 0;
      } catch (e) { logger.warn('[MP] ai insert:', e.message); }
    })();

    this._updateChatPreview(chat.id, aiResult.text, 'assistant');

    // ── 11. Learning Queue bei [UNKLAR] ───────────────────────────────────
    if (aiResult.text.includes('[UNKLAR]')) {
      void (async () => {
        try {
          await supabase.from('learning_queue').insert([{
            original_chat_id: chat.id, unanswered_question: text, status: 'pending'
          }]);
        } catch (_) {}
      })();
    }

    return aiResult.text;
  },

  // ── RAG ─────────────────────────────────────────────────────────────────
  async _searchKnowledge(query, settings) {
    try {
      const embResult = await embeddingService.createEmbedding(query);
      const vector    = embResult.embedding || embResult;
      if (embResult.tokens) this._lastEmbeddingTokens = embResult.tokens;
      const threshold = parseFloat(settings.rag_threshold)  || 0.45;
      const count     = parseInt(settings.rag_match_count)  || 8;

      const { data: r1 } = await supabase.rpc('match_knowledge', {
        query_embedding: vector, match_threshold: threshold, match_count: count
      });
      if (r1?.length >= 2) return r1;

      const { data: r2 } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: Math.max(threshold - 0.15, 0.20),
        match_count: count + 5
      });
      return r2?.length ? r2 : (r1 || []);
    } catch (err) {
      logger.warn(`[MP] Embedding Fehler: ${err.message}`);
      return [];
    }
  },

  // ── Settings-Cache (30s) ──────────────────────────────────────────────
  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL) return _settingsCache;
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
      return { system_prompt: 'Du bist ein hilfreicher Assistent.', ai_model: 'deepseek-chat', ai_max_tokens: 1024, ai_temperature: 0.5, rag_threshold: 0.45, rag_match_count: 8 };
    }
  },

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
        .from('chats').select('id, is_manual_mode, platform, auto_muted, flag_count')
        .eq('id', chatId).maybeSingle();

      if (existing) return { ...existing, _existed: true };

      const ins = { id: chatId, platform, metadata: metadata || {} };
      if (metadata?.first_name) ins.first_name = metadata.first_name;
      if (metadata?.username)   ins.username   = metadata.username;

      const { data: created, error } = await supabase.from('chats')
        .insert([ins]).select('id, is_manual_mode, platform, auto_muted, flag_count').single();

      if (error?.code === '23505') {
        const { data: retry } = await supabase.from('chats')
          .select('id, is_manual_mode, platform, auto_muted, flag_count').eq('id', chatId).single();
        return retry ? { ...retry, _existed: true } : { id: chatId, is_manual_mode: false, platform, _existed: false };
      }
      if (error) {
        logger.warn(`[MP] Chat insert (nicht fatal): ${error.message}`);
        return { id: chatId, is_manual_mode: false, platform, _existed: false };
      }
      return { ...(created || { id: chatId, is_manual_mode: false, platform }), _existed: false };
    } catch (err) {
      logger.error(`[MP] _getOrCreateChat: ${err.message}`);
      return { id: chatId, is_manual_mode: false, platform, _existed: false };
    }
  }
};

module.exports = messageProcessor;
