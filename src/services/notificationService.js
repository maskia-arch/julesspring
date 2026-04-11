/**
 * notificationService.js v1.2
 * Graceful Degradation: web-push ist optional.
 * Fehlendes Paket oder fehlende VAPID-Keys blockieren NIEMALS den Kern-Datenfluss.
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

let _wp           = null;
let _wpReady      = false;
let _wpInitTried  = false;

function _init() {
  if (_wpInitTried) return _wpReady;
  _wpInitTried = true;

  try {
    _wp = require('web-push');
  } catch {
    logger.info('[Push] web-push nicht installiert – Push deaktiviert (kein Fehler)');
    return false;
  }

  const pub  = process.env.VAPID_PUBLIC_KEY  || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';

  if (!pub || !priv) {
    logger.info('[Push] VAPID-Keys nicht gesetzt – Push deaktiviert');
    return false;
  }

  try {
    _wp.setVapidDetails('mailto:admin@valueshop25.com', pub, priv);
    _wpReady = true;
    logger.info('[Push] ✅ Web Push bereit');
  } catch (e) {
    logger.warn(`[Push] VAPID-Konfiguration fehlgeschlagen: ${e.message}`);
  }

  return _wpReady;
}

const notificationService = {

  isReady() { return _wpReady; },

  async sendNewMessageNotification({ chatId, text, firstName, platform, isFirstMessage }) {
    if (!_init()) return; // Lautlos ignorieren wenn nicht konfiguriert

    const name = firstName || chatId || 'Kunde';
    const icon = platform === 'telegram' ? '✈️' : '🌐';

    await this._push({
      title:  isFirstMessage ? `${icon} Neuer Chat: ${name}` : `${icon} ${name}`,
      body:   text.substring(0, 100) + (text.length > 100 ? '…' : ''),
      icon:   '/icon-192.png',
      tag:    `chat-${chatId}`,
      url:    '/admin',
      chatId
    });
  },

  async sendTestNotification() {
    if (!_init()) return false;
    await this._push({
      title: '✅ Push aktiv!',
      body:  'Benachrichtigungen funktionieren.',
      icon:  '/icon-192.png',
      tag:   'test',
      url:   '/admin'
    });
    return true;
  },

  async _push(payload) {
    if (!_wpReady || !_wp) return;

    let subs;
    try {
      const { data } = await supabase.from('admin_subscriptions').select('id, subscription_data');
      subs = data || [];
    } catch (e) {
      logger.warn('[Push] Subscriptions laden fehlgeschlagen:', e.message);
      return;
    }

    if (!subs.length) return;

    // silent: true → kein Sound/Vibration im Web Push (über Tag geregelt)
    const sendPayload = { ...payload };
    if (payload.silent) {
      sendPayload.silent = true;
      delete sendPayload.vibrate;
    }

    const json    = JSON.stringify(sendPayload);
    const expired = [];

    await Promise.allSettled(subs.map(async (row) => {
      try {
        const sub = typeof row.subscription_data === 'string'
          ? JSON.parse(row.subscription_data)
          : row.subscription_data;
        await _wp.sendNotification(sub, json, { TTL: 86400 });
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          expired.push(row.id);
        } else {
          logger.warn(`[Push] Senden fehlgeschlagen (${row.id}): ${e.message}`);
        }
      }
    }));

    if (expired.length) {
      await supabase.from('admin_subscriptions').delete().in('id', expired);
    }
  }
};

// Vorab-Initialisierung (non-blocking)
setImmediate(() => _init());

module.exports = notificationService;
