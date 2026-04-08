const supabase = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const telegramService = require('../services/telegramService');
const embeddingService = require('../services/embeddingService');

const chatController = {
  async handleIncomingMessage(req, res, next) {
    try {
      const { platform, chatId, message, metadata } = req.body;

      let { data: chat, error: chatError } = await supabase
        .from('chats')
        .select('*')
        .eq('external_id', chatId)
        .single();

      if (!chat) {
        const { data: newChat } = await supabase
          .from('chats')
          .insert([{ 
            external_id: chatId, 
            platform, 
            metadata, 
            is_manual_mode: false 
          }])
          .select()
          .single();
        chat = newChat;
      }

      await supabase.from('messages').insert([{
        chat_id: chat.id,
        role: 'user',
        content: message
      }]);

      if (chat.is_manual_mode) {
        return res.json({ status: 'manual_mode_active' });
      }

      const vector = await embeddingService.createEmbedding(message);
      
      const { data: context } = await supabase.rpc('match_knowledge', {
        query_embedding: vector,
        match_threshold: 0.7,
        match_count: 3
      });

      const { data: history } = await supabase
        .from('messages')
        .select('role, content')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(10);

      const aiResponse = await deepseekService.generateResponse(
        message, 
        history.reverse(), 
        context
      );

      await supabase.from('messages').insert([{
        chat_id: chat.id,
        role: 'assistant',
        content: aiResponse
      }]);

      if (platform === 'telegram') {
        await telegramService.sendMessage(chatId, aiResponse);
      }

      res.json({ response: aiResponse });
    } catch (error) {
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
        content: message
      }]);

      if (chat.platform === 'telegram') {
        await telegramService.sendMessage(chat.external_id, message);
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = chatController;
