const axios = require('axios');
const { telegram } = require('../config/env');

const telegramService = {
  async sendMessage(chatId, text) {
    try {
      // Markdown-Fehler abfangen und als Plaintext retry
      let parseMode = 'Markdown';
      try {
        const response = await axios.post(
          `https://api.telegram.org/bot${telegram.token}/sendMessage`,
          { chat_id: chatId, text, parse_mode: parseMode },
          { timeout: 10000 }
        );
        return response.data;
      } catch (mdError) {
        // Wenn Markdown-Parsing fehlschlägt → ohne parse_mode senden
        if (mdError.response?.data?.description?.includes('parse')) {
          const response = await axios.post(
            `https://api.telegram.org/bot${telegram.token}/sendMessage`,
            { chat_id: chatId, text },
            { timeout: 10000 }
          );
          return response.data;
        }
        throw mdError;
      }
    } catch (error) {
      const status = error.response?.status;
      const desc = error.response?.data?.description;

      if (status === 403) {
        console.warn(`[Telegram] Bot wurde von User blockiert: ${chatId}`);
        return null; // Kein Fehler werfen — Nutzer hat Bot geblockt
      }
      if (status === 400 && desc?.includes('chat not found')) {
        console.warn(`[Telegram] Chat nicht gefunden: ${chatId}`);
        return null;
      }

      console.error('[Telegram] sendMessage Error:', desc || error.message);
      throw new Error(`Telegram-Nachricht fehlgeschlagen: ${desc || error.message}`);
    }
  },

  async sendTypingAction(chatId) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${telegram.token}/sendChatAction`,
        { chat_id: chatId, action: 'typing' },
        { timeout: 5000 }
      );
    } catch (_) {
      // Typing-Indicator ist unkritisch
    }
  },

  async setWebhook(url) {
    const response = await axios.post(
      `https://api.telegram.org/bot${telegram.token}/setWebhook`,
      { url: `${url}/api/webhooks/telegram` },
      { timeout: 10000 }
    );
    return response.data;
  },

  async getWebhookInfo() {
    const response = await axios.get(
      `https://api.telegram.org/bot${telegram.token}/getWebhookInfo`,
      { timeout: 10000 }
    );
    return response.data;
  }
};

module.exports = telegramService;
