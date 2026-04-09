const supabase = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const telegramService = require('../services/telegramService');
const embeddingService = require('../services/embeddingService');

const chatController = {

  async handleIncomingMessage(req, res, next) {
    try {
      const { platform, chatId, message, metadata } = req.body;

      // BUGFIX: Schema hat `id text primary key` = Telegram Chat-ID
      // Deshalb query nach `id`, nicht nach `external_id`
      let { data: chat } = await supabase
        .from('chats')
        .select('*')
        .eq('id', chatId)
        .single();

      if (!chat) {
        const { data: newChat, error: insertError } = await supabase
          .from('chats')
          .insert([{
            id: chatId,         // id = Telegram Chat ID (text primary key)
            platform,
            metadata: metadata || {},
            is_manual_mode: false
          }])
          .select()
          .single();

        if (insertError) {
          console.error('Chat-Insert Error:', insertError);
          return res.sendStatus(200); // Trotzdem 200 an Telegram
        }
        chat = newChat;
      }

      // Nachricht speichern
      await supabase.from('messages').insert([{
        chat_id: chat.id,
        role: 'user',
        content: message
      }]);

      // Manuell-Modus: KI schweigt, nur Admin antwortet
      if (chat.is_manual_mode) {
        return res.json({ status: 'manual_mode_active' });
      }

      // Kontext aus Wissensdatenbank holen (RAG)
      let context = [];
      try {
        const vector = await embeddingService.createEmbedding(message);
        const { data: contextData } = await supabase.rpc('match_knowledge', {
          query_embedding: vector,
          match_threshold: 0.65,
          match_count: 4
        });
        context = contextData || [];
      } catch (embErr) {
        console.warn('Embedding/RAG Fehler (nicht kritisch):', embErr.message);
      }

      // Chat-Verlauf (letzte 10 Nachrichten)
      const { data: history } = await supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(10);

      // KI-Antwort generieren
      const aiResponse = await deepseekService.generateResponse(
        message,
        (history || []).reverse(),
        context,
        chat.id
      );

      // Antwort + Token-Verbrauch speichern
      await supabase.from('messages').insert([{
        chat_id: chat.id,
        role: 'assistant',
        content: aiResponse.text,
        prompt_tokens: aiResponse.promptTokens,
        completion_tokens: aiResponse.completionTokens
      }]);

      // Telegram: Nachricht senden
      if (platform === 'telegram') {
        await telegramService.sendMessage(chatId, aiResponse.text);
      }

      res.json({ response: aiResponse.text });
    } catch (error) {
      console.error('handleIncomingMessage Error:', error);
      next(error);
    }
  },

  async toggleManualMode(req, res, next) {
    try {
      const { chatId } = req.params;
      const { enabled } = req.body;

      const { data, error } = await supabase
        .from('chats')
        .update({ is_manual_mode: enabled, updated_at: new Date() })
        .eq('id', chatId)
        .select();

      if (error) throw error;
      res.json(data[0]);
    } catch (error) {
      next(error);
    }
  },

  async sendManualMessage(req, res, next) {
    try {
      const { chatId, message } = req.body;

      const { data: chat } = await supabase
        .from('chats')
        .select('*')
        .eq('id', chatId)
        .single();

      await supabase.from('messages').insert([{
        chat_id: chatId,
        role: 'assistant',
        content: message,
        is_manual: true
      }]);

      if (chat && chat.platform === 'telegram') {
        await telegramService.sendMessage(chatId, message);
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = chatController;
