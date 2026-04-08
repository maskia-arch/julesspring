const axios = require('axios');
const { telegram } = require('../config/env');

const telegramService = {
  async sendMessage(chatId, text) {
    try {
      const response = await axios.post(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      });

      return response.data;
    } catch (error) {
      console.error('Telegram API Error:', error.response?.data || error.message);
      
      if (error.response?.status === 403) {
        console.warn(`Bot was blocked by user: ${chatId}`);
      }
      
      throw new Error('Nachricht konnte nicht an Telegram gesendet werden.');
    }
  },

  async sendTypingAction(chatId) {
    try {
      await axios.post(`https://api.telegram.org/bot${telegram.token}/sendChatAction`, {
        chat_id: chatId,
        action: 'typing'
      });
    } catch (error) {
      // Fehler beim "Tippen"-Indikator sind unkritisch, daher nur Logging
      console.error('Telegram ChatAction Error:', error.message);
    }
  },

  async setWebhook(url) {
    try {
      const response = await axios.post(`https://api.telegram.org/bot${telegram.token}/setWebhook`, {
        url: `${url}/webhooks/telegram`
      });
      return response.data;
    } catch (error) {
      console.error('Telegram Webhook Setup Error:', error.message);
      throw error;
    }
  }
};

module.exports = telegramService;
