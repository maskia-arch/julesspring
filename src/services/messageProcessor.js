/**
 * messageProcessor.js v1.1.2
 *
 * Fixes:
 * - RAG-Threshold und Match-Count aus Settings (konfigurierbar)
 * - Breitere Suche wenn wenig Treffer (Fallback mit niedrigerem Threshold)
 * - last_message / message_count in chats aktualisieren
 */

const supabase         = require('../config/supabase');
const deepseekService  = require('./deepseekService');
const telegramService  = require('./telegramService');
const embeddingService = require('./embeddingService');
const logger           = require('../utils/logger');

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {

    // 1. Chat holen oder anlegen
    let chat = await this._getOrCreateChat(chatId, platform, metadata);
    if (!chat) throw new Error('Chat konnte nicht angelegt werden');

    // 2. Nutzer-Nachricht speichern + Chat-Vorschau aktualisieren
    await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
    this._updateChatPreview(chat.id, text, 'user').catch(() => {});

    // 3. Manuell-Modus → KI schweigt
    if (chat.is_manual_mode) return null;

    // 4. Typing-Indikator
    if (platform === 'telegram') telegramService.sendTypingAction(chatId).catch(() => {});

    // 5. AI-Einstellungen aus DB laden (mit Defaults)
    const settings = await this._loadSettings();

    // 6. RAG-Kontext: smart search mit Fallback
    const context = await this._searchKnowledge(text, settings);
    logger.info(`[MP] RAG: ${context.length} Treffer für "${text.substring(0,40)}"`);

    // 7. Chat-Verlauf
    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: false })
      .limit(settings.ai_context_messages || 12);

    // 8. KI-Antwort
    const aiResult = await deepseekService.generateResponse(
      text,
      (history || []).reverse(),
      context,
      chat.id,
      settings
    );

    // 9. KI-Antwort speichern
    await supabase.from('messages').insert([{
      chat_id:           chat.id,
      role:              'assistant',
      content:           aiResult.text,
      prompt_tokens:     aiResult.promptTokens     || 0,
      completion_tokens: aiResult.completionTokens || 0
    }]);

    // 10. Chat-Vorschau und Zähler aktualisieren
    this._updateChatPreview(chat.id, aiResult.text, 'assistant').catch(() => {});

    // 11. Telegram senden
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    return aiResult.text;
  },

  // ── Smarte Wissenssuche mit 2-Stufen-Fallback ──────────────────────────
  async _searchKnowledge(query, settings) {
    try {
      const vector    = await embeddingService.createEmbedding(query);
      const threshold = parseFloat(settings.rag_threshold) || 0.45;
      const count     = parseInt(settings.rag_match_count) || 8;

      // Stufe 1: Normale Suche
      const { data: results } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: threshold,
        match_count:     count
      });

      if (results?.length >= 2) return results;

      // Stufe 2: Fallback – breitere Suche mit niedrigerem Threshold
      logger.info(`[MP] RAG Fallback (nur ${results?.length||0} Treffer bei ${threshold})`);
      const { data: fallback } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: Math.max(threshold - 0.15, 0.25),
        match_count:     count + 4
      });

      return fallback || results || [];
    } catch (err) {
      logger.warn(`[MP] Embedding-Fehler (kein RAG-Kontext): ${err.message}`);
      return [];
    }
  },

  // ── Settings mit Defaults laden ────────────────────────────────────────
  async _loadSettings() {
    try {
      const { data } = await supabase.from('settings').select('*').single();
      return {
        system_prompt:       data?.system_prompt       || 'Du bist ein hilfreicher Assistent.',
        negative_prompt:     data?.negative_prompt     || '',
        ai_model:            data?.ai_model            || 'deepseek-chat',
        ai_max_tokens:       data?.ai_max_tokens       || 1024,
        ai_temperature:      data?.ai_temperature      || 0.5,
        rag_threshold:       data?.rag_threshold       || 0.45,
        rag_match_count:     data?.rag_match_count     || 8,
        ai_context_messages: 12
      };
    } catch {
      return {
        system_prompt: 'Du bist ein hilfreicher Assistent.',
        negative_prompt: '',
        ai_model: 'deepseek-chat',
        ai_max_tokens: 1024,
        ai_temperature: 0.5,
        rag_threshold: 0.45,
        rag_match_count: 8,
        ai_context_messages: 12
      };
    }
  },

  // ── Chat-Vorschau für Dashboard aktualisieren ──────────────────────────
  async _updateChatPreview(chatId, message, role) {
    const preview = message.substring(0, 120);
    await supabase.from('chats').update({
      last_message:      preview,
      last_message_role: role,
      updated_at:        new Date(),
      message_count:     supabase.rpc ? undefined : undefined // Inkrementierung via SQL
    }).eq('id', chatId);

    // message_count inkrementieren
    await supabase.rpc('increment_message_count', { chat_id_param: chatId }).catch(() => {});
  },

  // ── Chat holen oder anlegen ─────────────────────────────────────────────
  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase
        .from('chats').select('id, is_manual_mode, platform').eq('id', chatId).maybeSingle();

      if (existing) return existing;

      const { data: created, error } = await supabase.from('chats').insert([{
        id: chatId, platform,
        metadata:  metadata || {},
        first_name: metadata?.first_name || null,
        username:   metadata?.username   || null
      }]).select('id, is_manual_mode, platform').single();

      if (error?.code === '23505') {
        // Race condition
        const { data: retry } = await supabase.from('chats').select('id, is_manual_mode, platform').eq('id', chatId).single();
        return retry;
      }
      if (error) throw error;
      return created || { id: chatId, is_manual_mode: false, platform };
    } catch (err) {
      logger.error(`[MP] _getOrCreateChat: ${err.message}`);
      return { id: chatId, is_manual_mode: false, platform };
    }
  }
};

module.exports = messageProcessor;
