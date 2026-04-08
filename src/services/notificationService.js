const webpush = require('web-push');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { vapid } = require('../config/env');

if (vapid.publicKey && vapid.privateKey) {
  webpush.setVapidDetails(
    'mailto:admin@deine-domain.com',
    vapid.publicKey,
    vapid.privateKey
  );
}

const notificationService = {
  async sendAdminNotification(title, body, url = '/admin') {
    try {
      const { data: subscriptions, error } = await supabase
        .from('admin_subscriptions')
        .select('*');

      if (error) throw error;
      if (!subscriptions || subscriptions.length === 0) return;

      const payload = JSON.stringify({
        notification: {
          title: title,
          body: body,
          icon: '/assets/logo.png',
          data: { url: url }
        }
      });

      const notificationPromises = subscriptions.map(sub => {
        return webpush.sendNotification(sub.subscription_data, payload)
          .catch(async (err) => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await supabase
                .from('admin_subscriptions')
                .delete()
                .eq('id', sub.id);
            }
            logger.error('Push Notification Error für Sub ID ' + sub.id + ':', err.message);
          });
      });

      await Promise.all(notificationPromises);
    } catch (error) {
      logger.error('Global Notification Service Error:', error.message);
    }
  },

  async notifyNewLearningCase(question) {
    return this.sendAdminNotification(
      '🧠 Neuer Learning-Case',
      `Die KI benötigt Hilfe bei einer eSIM-Frage: "${question.substring(0, 50)}..."`,
      '/admin#learning'
    );
  },

  async notifyNewManualChat(chatId) {
    return this.sendAdminNotification(
      '👤 Manuelle Übernahme angefordert',
      `Ein Kunde (ID: ${chatId}) wartet auf eine Antwort im Live-Chat.`,
      `/admin#chat/${chatId}`
    );
  }
};

module.exports = notificationService;
