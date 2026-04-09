/**
 * messageProcessor.js
 *
 * Zentraler Service für die Verarbeitung eingehender Nachrichten.
 * Wird vom Telegram-Webhook und vom Web-Widget aufgerufen.
 * Kapselt: Chat anlegen/abrufen → Nachricht speichern → RAG-Kontext → KI → Antwort senden
 */

const supabase         = require('../config/supabase');
const deepseekService  = require('./deepseekService');
const telegramService  = require('./telegramService');
const embeddingService = require('./embeddingService');
const logger           = require('../utils/logger');

const messageProcessor = {

  /**
   * Verarbeitet eine eingehende Nachricht vollständig.
   * @param {Object} opts
   * @param {string} opts.platform  - 'telegram' | 'web_widget'
   * @param {string} opts.chatId    - Telegram Chat-ID oder Session-ID
   * @param {string} opts.text      - Die Nachricht des Nutzers
   * @param {Object} opts.metadata  - { username, first_name, ... }
   * @returns {string} Die generierte KI-Antwort
   */
  async handle({ platform, chatId, text, metadata = {} }) {

    // ── 1. Chat abrufen oder neu anlegen ──────────────────────────────────
    let chat = await this._getOrCreateChat(chatId, platform, metadata);

    if (!chat) {
      logger.error(`[MessageProcessor] Chat konnte nicht angelegt werden für ${chatId}`);
      throw new Error('Chat-Fehler');
    }

    // ── 2. Nutzer-Nachricht speichern ─────────────────────────────────────
    await supabase.from('messages').insert([{
      chat_id: chat.id,
      role:    'user',
      content: text
    }]);

    // ── 3. Manuell-Modus: KI schweigt ────────────────────────────────────
    if (chat.is_manual_mode) {
      logger.info(`[MessageProcessor] Chat ${chatId} ist im Manuell-Modus – KI pausiert`);
      return null;
    }

    // ── 4. Typing-Indikator senden ────────────────────────────────────────
    if (platform === 'telegram') {
      telegramService.sendTypingAction(chatId).catch(() => {});
    }

    // ── 5. Kontext aus Wissensdatenbank (RAG) ─────────────────────────────
    let context = [];
    try {
      const vector = await embeddingService.createEmbedding(text);
      const { data } = await supabase.rpc('match_knowledge', {
        query_embedding:  vector,
        match_threshold:  0.60,
        match_count:      5
      });
      context = data || [];
    } catch (embErr) {
      // Embedding-Fehler sind nicht fatal – KI antwortet ohne Kontext
      logger.warn(`[MessageProcessor] Embedding übersprungen: ${embErr.message}`);
    }

    // ── 6. Chat-Verlauf abrufen (letzte 12 Nachrichten) ──────────────────
    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: false })
      .limit(12);

    // ── 7. KI-Antwort generieren ──────────────────────────────────────────
    const aiResult = await deepseekService.generateResponse(
      text,
      (history || []).reverse(),
      context,
      chat.id
    );

    // ── 8. KI-Antwort speichern ───────────────────────────────────────────
    await supabase.from('messages').insert([{
      chat_id:           chat.id,
      role:              'assistant',
      content:           aiResult.text,
      prompt_tokens:     aiResult.promptTokens     || 0,
      completion_tokens: aiResult.completionTokens || 0
    }]);

    // ── 9. Antwort an Telegram senden ─────────────────────────────────────
    if (platform === 'telegram') {
      await telegramService.sendMessage(chatId, aiResult.text);
    }

    // ── 10. Chat-Zeitstempel aktualisieren ────────────────────────────────
    await supabase.from('chats')
      .update({ updated_at: new Date() })
      .eq('id', chat.id);

    return aiResult.text;
  },

  // ── Hilfsfunktion: Chat holen oder anlegen ─────────────────────────────
  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      // Bestehenden Chat suchen
      const { data: existing } = await supabase
        .from('chats')
        .select('id, is_manual_mode, platform')
        .eq('id', chatId)
        .maybeSingle();

      if (existing) return existing;

      // Neu anlegen – nur Felder die sicher existieren
      const insertData = {
        id:       chatId,
        platform: platform,
        metadata: metadata || {}
      };

      const { data: created, error } = await supabase
        .from('chats')
        .insert([insertData])
        .select('id, is_manual_mode, platform')
        .single();

      if (error) {
        // Wenn is_manual_mode Spalte fehlt → ohne Spalte nochmal versuchen
        if (error.message?.includes('is_manual_mode')) {
          logger.warn('[MessageProcessor] is_manual_mode Spalte fehlt – führe schema3.sql aus!');
          const { data: fallback } = await supabase
            .from('chats')
            .insert([{ id: chatId, platform, metadata }])
            .select('id, platform')
            .single();
          return fallback ? { ...fallback, is_manual_mode: false } : null;
        }
        // Race Condition: Chat wurde parallel angelegt
        if (error.code === '23505') {
          const { data: existing2 } = await supabase
            .from('chats')
            .select('id, is_manual_mode, platform')
            .eq('id', chatId)
            .single();
          return existing2;
        }
        throw error;
      }

      return created || { id: chatId, is_manual_mode: false, platform };
    } catch (err) {
      logger.error(`[MessageProcessor] _getOrCreateChat Error: ${err.message}`);
      return { id: chatId, is_manual_mode: false, platform };
    }
  }
};

module.exports = messageProcessor;
