/**
 * notificationService.js v1.1.17
 * Sendet Web Push Notifications an alle registrierten Admin-Geräte
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

let webpush = null;
let vapidConfigured = false;

function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
    const pubKey  = process.env.VAPID_PUBLIC_KEY;
    const privKey = process.env.VAPID_PRIVATE_KEY;
    if (pubKey && privKey) {
      webpush.setVapidDetails('mailto:admin@valueshop25.com', pubKey, privKey);
      vapidConfigured = true;
      logger.info('[Push] VAPID konfiguriert');
    } else {
      logger.warn('[Push] VAPID_PUBLIC_KEY oder VAPID_PRIVATE_KEY fehlen → Push deaktiviert');
    }
  } catch (e) {
    logger.warn('[Push] web-push nicht installiert:', e.message);
  }
  return webpush;
}

const notificationService = {

  async sendNewMessageNotification({ chatId, text, firstName, platform, isFirstMessage }) {
    if (!vapidConfigured) {
      getWebPush(); // Versucht zu initialisieren
      if (!vapidConfigured) return;
    }

    const name = firstName || chatId || 'Unbekannt';
    const icon = platform === 'telegram' ? '✈️' : '🌐';

    const payload = JSON.stringify({
      title:  isFirstMessage
        ? `${icon} Neuer Chat: ${name}`
        : `${icon} ${name}: neue Nachricht`,
      body:   text.substring(0, 100) + (text.length > 100 ? '…' : ''),
      icon:   '/icon-192.png',
      tag:    `chat-${chatId}`,
      url:    '/admin',
      chatId: chatId
    });

    await notificationService._pushToAll(payload);
  },

  async _pushToAll(payload) {
    const wp = getWebPush();
    if (!wp) return;

    try {
      const { data: subs } = await supabase
        .from('admin_subscriptions')
        .select('id, subscription_data');

      if (!subs?.length) return;

      const invalid = [];

      await Promise.all(subs.map(async (row) => {
        try {
          const sub = typeof row.subscription_data === 'string'
            ? JSON.parse(row.subscription_data)
            : row.subscription_data;

          await wp.sendNotification(sub, payload, { TTL: 60 });
        } catch (err) {
          // 410 Gone = Subscription abgelaufen → löschen
          if (err.statusCode === 410 || err.statusCode === 404) {
            invalid.push(row.id);
          } else {
            logger.warn(`[Push] Senden fehlgeschlagen: ${err.message}`);
          }
        }
      }));

      // Abgelaufene Subscriptions entfernen
      if (invalid.length) {
        await supabase.from('admin_subscriptions').delete().in('id', invalid);
        logger.info(`[Push] ${invalid.length} abgelaufene Subscriptions entfernt`);
      }
    } catch (err) {
      logger.warn(`[Push] _pushToAll Fehler: ${err.message}`);
    }
  },

  // Testbenachrichtigung senden (aus dem Dashboard)
  async sendTestNotification() {
    const payload = JSON.stringify({
      title: '✅ Push Notifications aktiv!',
      body:  'Du erhältst jetzt Benachrichtigungen wenn Kunden schreiben.',
      icon:  '/icon-192.png',
      tag:   'test-notification',
      url:   '/admin'
    });
    await this._pushToAll(payload);
    return true;
  }
};

// Bei Serverstart VAPID initialisieren
getWebPush();

module.exports = notificationService;
