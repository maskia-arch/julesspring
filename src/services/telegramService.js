/**
 * telegramService.js v1.2.1
 *
 * Kein parse_mode. Alle Markdown-Zeichen werden vor dem Senden entfernt.
 * Telegram zeigt plain text — keine Sternchen, keine Rauten, keine Formatierung.
 */

const axios = require('axios');
const { telegram } = require('../config/env');

const TG_MAX = 4000;

const telegramService = {

  async sendMessage(chatId, text) {
    if (!text || !chatId) return null;
    const clean = this._cleanForTelegram(String(text));
    const parts  = this._split(clean);
    for (const part of parts) {
      const ok = await this._send(chatId, part);
      if (!ok) break;
    }
    return true;
  },

  // ── Markdown → Plain Text ─────────────────────────────────────────────
  _cleanForTelegram(text) {
    return text
      // Fett: **text** oder __text__ → text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      // Kursiv: *text* oder _text_ → text (vorsichtig, keine Wörter mit _)
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/_([^_\n]+?)_/g, '$1')
      // Header: ### Titel → Titel (ohne #)
      .replace(/^#{1,6}\s+/gm, '')
      // Code-Blöcke: ```code``` → code
      .replace(/```[\s\S]*?```/g, function(m) { return m.replace(/```[a-z]*/g, '').replace(/```/g, '').trim(); })
      // Inline Code: `code` → code
      .replace(/`([^`]+)`/g, '$1')
      // Links: [text](url) → text: url
      .replace(/\[(.+?)\]\((.+?)\)/g, '$1: $2')
      // Strikethrough: ~~text~~ → text
      .replace(/~~(.+?)~~/g, '$1')
      // Übrig gebliebene einzelne * oder _ am Zeilenanfang (Bullet-ähnlich) → -
      .replace(/^\* /gm, '- ')
      // Mehrfache Leerzeilen → eine
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  // ── Senden ────────────────────────────────────────────────────────────
  async _send(chatId, text) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${telegram.token}/sendMessage`,
        { chat_id: chatId, text: text },
        { timeout: 15000 }
      );
      return true;
    } catch (err) {
      const st   = err.response?.status;
      const desc = err.response?.data?.description || err.message;
      if (st === 403) { console.warn(`[Telegram] Bot geblockt: ${chatId}`); return false; }
      console.error(`[Telegram] sendMessage (${chatId}): ${desc}`);
      return false;
    }
  },

  // ── Nachricht aufteilen ───────────────────────────────────────────────
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
      const r = await axios.post(
        `https://api.telegram.org/bot${telegram.token}/setWebhook`,
        { url: `${url}/api/webhooks/telegram` },
        { timeout: 20000 }
      );
      return r.data;
    } catch (e) {
      return { ok: false, description: e.message };
    }
  },

  async getWebhookInfo() {
    try {
      const r = await axios.get(
        `https://api.telegram.org/bot${telegram.token}/getWebhookInfo`,
        { timeout: 10000 }
      );
      return r.data;
    } catch (e) {
      return { result: { url: null, last_error_message: e.message } };
    }
  }
};

module.exports = telegramService;
