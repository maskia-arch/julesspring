const messageProcessor = require('../services/messageProcessor');
const supabase = require('../config/supabase');

const chatController = {

  // Verwendet vom Web-Widget (Telegram läuft direkt über webhookRoutes)
  async handleIncomingMessage(req, res, next) {
    try {
      const { platform = 'web_widget', chatId, message, metadata } = req.body;

      if (!chatId || !message) {
        return res.status(400).json({ error: 'chatId und message erforderlich' });
      }

      const response = await messageProcessor.handle({
        platform,
        chatId,
        text: message,
        metadata: metadata || {}
      });

      res.json({ response: response || '' });
    } catch (error) {
      next(error);
    }
  },

  async toggleManualMode(req, res, next) {
    try {
      const { chatId } = req.params;
      const { enabled } = req.body;
      const { data, error } = await supabase
        .from('chats').update({ is_manual_mode: enabled, updated_at: new Date() }).eq('id', chatId).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (error) { next(error); }
  }
};

module.exports = chatController;
