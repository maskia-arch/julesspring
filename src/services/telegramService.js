/**
 * telegramService.js v1.1.11
 *
 * Fixes:
 * - Kein parse_mode=Markdown → keine 400-Fehler durch KI-Formatierung
 * - Nachrichten >4096 Zeichen werden aufgeteilt (Telegram-Limit)
 * - Alle Fehler nicht-fatal: wirft nie mehr, loggt nur
 */

const axios = require('axios');
const { telegram } = require('../config/env');

const TG_MAX_LENGTH = 4000; // Telegram-Limit ist 4096, wir nutzen 4000 als Puffer

const telegramService = {

  async sendMessage(chatId, text) {
    if (!text || !chatId) return null;

    // Lange Nachrichten aufteilen
    const parts = this._splitMessage(String(text));

    for (const part of parts) {
      const sent = await this._sendPart(chatId, part);
      if (!sent) break; // Bei Fehler nicht weiter versuchen
    }
    return true;
  },

  async _sendPart(chatId, text) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${telegram.token}/sendMessage`,
        {
          chat_id:    chatId,
          text:       text,
          // KEIN parse_mode → kein Markdown-Parsing → keine 400-Fehler
          // KI-Antworten mit ** oder ### werden als normaler Text angezeigt
        },
        { timeout: 15000 }
      );
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const desc   = error.response?.data?.description || error.message;

      if (status === 403) {
        console.warn(`[Telegram] Bot geblockt von: ${chatId}`);
        return null;
      }
      if (status === 400) {
        console.warn(`[Telegram] 400 Fehler (${chatId}): ${desc}`);
        return null;
      }
      // Netzwerkfehler etc. — nicht werfen
      console.error(`[Telegram] sendMessage Fehler (${chatId}): ${desc}`);
      return null;
    }
  },

  // Nachricht an Telegram-Limit anpassen (4096 Zeichen max)
  _splitMessage(text) {
    if (text.length <= TG_MAX_LENGTH) return [text];

    const parts = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= TG_MAX_LENGTH) {
        parts.push(remaining);
        break;
      }
      // An Absatz oder Satz trennen, nicht mitten im Wort
      let cutAt = TG_MAX_LENGTH;
      const lastNewline = remaining.lastIndexOf('\n', TG_MAX_LENGTH);
      const lastPeriod  = remaining.lastIndexOf('. ', TG_MAX_LENGTH);

      if (lastNewline > TG_MAX_LENGTH * 0.6) cutAt = lastNewline;
      else if (lastPeriod > TG_MAX_LENGTH * 0.6) cutAt = lastPeriod + 1;

      parts.push(remaining.substring(0, cutAt).trim());
      remaining = remaining.substring(cutAt).trim();
    }

    return parts.filter(p => p.length > 0);
  },

  async sendTypingAction(chatId) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${telegram.token}/sendChatAction`,
        { chat_id: chatId, action: 'typing' },
        { timeout: 5000 }
      );
    } catch (_) {}
  },

  async setWebhook(url) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${telegram.token}/setWebhook`,
        { url: `${url}/api/webhooks/telegram` },
        { timeout: 20000 } // 20s – Render braucht beim Kaltstart länger
      );
      return response.data;
    } catch (error) {
      console.error('[Telegram] setWebhook Fehler:', error.message);
      return { ok: false, description: error.message };
    }
  },

  async getWebhookInfo() {
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${telegram.token}/getWebhookInfo`,
        { timeout: 10000 }
      );
      return response.data;
    } catch (error) {
      return { result: { url: null, last_error_message: error.message } };
    }
  }
};

module.exports = telegramService;
