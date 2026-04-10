/**
 * messageProcessor.js v1.1.4
 *
 * Optimierungen:
 * - Settings + Chat parallel laden
 * - Embedding + History parallel abrufen
 * - Telegram-Nachricht sofort senden, DB-Saves danach (fire-and-forget)
 * - Settings-Cache (30s) → kein DB-Hit pro Nachricht
 * - Learning Queue: bei leerem Kontext UND bei [UNKLAR]
 */

const supabase         = require('../config/supabase');
const deepseekService  = require('./deepseekService');
const telegramService  = require('./telegramService');
const embeddingService = require('./embeddingService');
const logger           = require('../utils/logger');

// Settings-Cache: lädt max. alle 30 Sekunden neu
let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL_MS     = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();

    // ── 1. Chat + Settings PARALLEL laden ────────────────────────────────
    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);

    if (!chat) throw new Error('Chat konnte nicht angelegt werden');

    // ── 2. Nutzer-Nachricht speichern (fire & forget) ─────────────────────
    supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]).catch(e => logger.warn('[MP] msg insert:', e.message));
    this._updateChatPreview(chat.id, text, 'user');

    // ── 3. Manuell-Modus → KI schweigt ────────────────────────────────────
    if (chat.is_manual_mode) return null;

    // ── 4. Typing-Indikator sofort senden ─────────────────────────────────
    if (platform === 'telegram') telegramService.sendTypingAction(chatId).catch(() => {});

    // ── 5. Embedding + History PARALLEL ───────────────────────────────────
    const [context, history] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content').eq('chat_id', chat.id)
        .order('created_at', { ascending: false }).limit(10)
        .then(r => (r.data || []).reverse())
    ]);

    logger.info(`[MP] t=${Date.now()-t0}ms RAG:${context.length} hist:${history.length} "${text.substring(0,30)}"`);

    // ── 6. KI-Antwort generieren ──────────────────────────────────────────
    const aiResult = await deepseekService.generateResponse(text, history, context, chat.id, settings);

    // ── 7. Telegram sofort senden (bevor DB-Saves) ────────────────────────
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    logger.info(`[MP] Gesamt: ${Date.now()-t0}ms`);

    // ── 8. DB-Saves fire & forget ─────────────────────────────────────────
    supabase.from('messages').insert([{
      chat_id: chat.id, role: 'assistant', content: aiResult.text,
      prompt_tokens: aiResult.promptTokens || 0,
      completion_tokens: aiResult.completionTokens || 0
    }]).catch(e => logger.warn('[MP] ai msg insert:', e.message));

    this._updateChatPreview(chat.id, aiResult.text, 'assistant');

    // ── 9. Learning Queue: bei leerem Kontext ODER [UNKLAR] ──────────────
    const noContext = context.length === 0;
    const unclear   = aiResult.text.includes('[UNKLAR]');

    if ((noContext || unclear) && chat.id) {
      supabase.from('learning_queue').insert([{
        original_chat_id:    chat.id,
        unanswered_question: text,
        status:              'pending'
      }]).catch(() => {});
      logger.info(`[MP] Learning Queue: "${text.substring(0,50)}" (noContext=${noContext}, unclear=${unclear})`);
    }

    return aiResult.text;
  },

  // ── Smart-Suche mit automatischem Fallback ─────────────────────────────
  async _searchKnowledge(query, settings) {
    try {
      const vector    = await embeddingService.createEmbedding(query);
      const threshold = parseFloat(settings.rag_threshold)  || 0.45;
      const count     = parseInt(settings.rag_match_count)  || 8;

      const { data: r1 } = await supabase.rpc('match_knowledge', {
        query_embedding: vector, match_threshold: threshold, match_count: count
      });

      if (r1?.length >= 2) return r1;

      // Fallback: niedrigerer Threshold
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

  // ── Settings mit Cache (30s) ───────────────────────────────────────────
  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL_MS) {
      return _settingsCache;
    }
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

  // ── Chat-Vorschau (fire & forget) ────────────────────────────────────
  _updateChatPreview(chatId, message, role) {
    supabase.from('chats').update({
      last_message:      (message || '').substring(0, 120),
      last_message_role: role,
      updated_at:        new Date()
    }).eq('id', chatId).catch(() => {});
  },

  // ── Chat holen oder anlegen ───────────────────────────────────────────
  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase
        .from('chats').select('id, is_manual_mode, platform').eq('id', chatId).maybeSingle();
      if (existing) return existing;

      const ins = { id: chatId, platform, metadata: metadata || {} };
      // Optionale Felder nur wenn Spalte existiert (graceful)
      if (metadata?.first_name) ins.first_name = metadata.first_name;
      if (metadata?.username)   ins.username   = metadata.username;

      const { data: created, error } = await supabase
        .from('chats').insert([ins]).select('id, is_manual_mode, platform').single();

      if (error?.code === '23505') {
        const { data: retry } = await supabase.from('chats').select('id, is_manual_mode, platform').eq('id', chatId).single();
        return retry;
      }
      if (error) {
        logger.warn(`[MP] Chat insert Fehler (nicht fatal): ${error.message}`);
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
