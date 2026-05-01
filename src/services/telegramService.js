const axios = require('axios');
const { telegram } = require('../config/env');

const TG_MAX = 4000;

const telegramService = {

  async sendMessage(chatId, text, options = {}) {
    if (!text || !chatId) return null;
    const clean = this._cleanForTelegram(String(text));
    const parts  = this._split(clean);
    
    // Wenn ein spezifisches Token übergeben wird (z.B. vom Support-Bot), nutze dieses.
    // Sonst Fallback auf das Standard-Token aus der ENV.
    const token = options.token || telegram.token;

    for (const part of parts) {
      const ok = await this._send(chatId, part, token, options.message_thread_id);
      if (!ok) break;
    }
    return true;
  },

  _cleanForTelegram(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/_([^_\n]+?)_/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/```[\s\S]*?```/g, function(m) { return m.replace(/```[a-z]*/g, '').replace(/```/g, '').trim(); })
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/^\* /gm, '- ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  async _send(chatId, text, token, threadId = null) {
    try {
      const payload = { chat_id: chatId, text: text };
      if (threadId) payload.message_thread_id = threadId;

      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        payload,
        { timeout: 15000 }
      );
      return true;
    } catch (err) {
      const st   = err.response?.status;
      const desc = err.response?.data?.description || err.message;
      if (st === 403) { return false; }
      console.error(`[Telegram] send Error (Bot-Token: ...${(token||'').substring((token||'').length-5)}): ${desc}`);
      return false;
    }
  },

  _split(text) {
    if (text.length <= TG_MAX) return [text];
    const parts = [];
    let rem = text;
    while (rem.length > 0) {
      if (rem.length <= TG_MAX) { parts.push(rem); break; }
      let cut = rem.lastIndexOf('\n', TG_MAX);
      if (cut < TG_MAX * 0.5) cut = rem.lastIndexOf('. ', TG_MAX);
      if (cut < TG_MAX * 0.5) cut = TG_MAX;
      parts.push(rem.substring(0, cut).trim());
      rem = rem.substring(cut).trim();
    }
    return parts.filter(Boolean);
  },

  async sendTypingAction(chatId, options = {}) {
    const token = options.token || telegram.token;
    try {
      const payload = { chat_id: chatId, action: 'typing' };
      if (options.message_thread_id) payload.message_thread_id = options.message_thread_id;

      await axios.post(
        `https://api.telegram.org/bot${token}/sendChatAction`,
        payload,
        { timeout: 5000 }
      );
    } catch (_) {}
  },

  /**
   * Registriert den Webhook beim Telegram-Server.
   * Wird beim Server-Start automatisch aufgerufen.
   */
  async setWebhook(appUrl, token = null) {
    const botToken = token || telegram.token;
    if (!botToken) {
      return { ok: false, description: 'Kein Bot-Token konfiguriert.' };
    }
    try {
      const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/webhooks/telegram`;
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post', 'chat_join_request'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      return response.data || { ok: false };
    } catch (err) {
      const desc = err.response?.data?.description || err.message;
      console.error(`[Telegram] setWebhook Error: ${desc}`);
      return { ok: false, description: desc };
    }
  },

  /**
   * Ruft aktuelle Webhook-Info von Telegram ab.
   */
  async getWebhookInfo(token = null) {
    const botToken = token || telegram.token;
    if (!botToken) {
      return { result: { url: '', last_error_message: 'Kein Bot-Token konfiguriert.' } };
    }
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${botToken}/getWebhookInfo`,
        { timeout: 8000 }
      );
      return response.data || {};
    } catch (err) {
      const desc = err.response?.data?.description || err.message;
      console.error(`[Telegram] getWebhookInfo Error: ${desc}`);
      return { result: { url: '', last_error_message: desc } };
    }
  },

  /**
   * Löscht den aktuell gesetzten Webhook.
   */
  async deleteWebhook(token = null) {
    const botToken = token || telegram.token;
    if (!botToken) return { ok: false, description: 'Kein Token.' };
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/deleteWebhook`,
        {},
        { timeout: 8000 }
      );
      return response.data || { ok: false };
    } catch (err) {
      return { ok: false, description: err.message };
    }
  }
};

module.exports = telegramService;
