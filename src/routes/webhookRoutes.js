const express = require('express');
const router  = express.Router();

// ── Telegram Webhook ──────────────────────────────────────────────────────────
// REGEL: res.sendStatus(200) ist die allererste synchrone Operation.
// Alles danach läuft in setImmediate() – kein Crash kann die 200 blockieren.
router.post('/telegram', (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const { message } = req.body;
      if (!message) return;

      const chatId = message.chat?.id?.toString();
      const text   = message.text?.trim();
      const from   = message.from || {};
      if (!chatId || !text) return;

      const telegramService  = require('../services/telegramService');
      const supabase         = require('../config/supabase');
      const messageProcessor = require('../services/messageProcessor');

      if (text === '/start') {
        // FIX: kein .catch() auf Supabase-Query
        let welcome = 'Willkommen! 👋 Wie kann ich dir helfen?';
        try {
          const { data: settings } = await supabase
            .from('settings').select('welcome_message').single();
          if (settings?.welcome_message) welcome = settings.welcome_message;
        } catch (_) {}
        await telegramService.sendMessage(chatId, welcome);
        return;
      }

      // Human-Handover: Kunde möchte echten Mitarbeiter
      const HANDOVER_RE = /ich\s+m.chte?.*(mit|einen?).*mitarbeiter|menschlich|kein\s+bot|echte\s+person|speak.*human|connect.*agent/i;
      if (HANDOVER_RE.test(text)) {
        try {
          await supabase.from('chats').upsert({
            id: chatId, platform: 'telegram', is_manual_mode: true, updated_at: new Date()
          });
          // Push an Admin
          const notifService = require('../services/notificationService');
          await notifService.sendNewMessageNotification({
            chatId,
            text: '🙋 Telegram-Nutzer möchte Mitarbeiter: ' + text.substring(0, 60),
            firstName: from.first_name || 'Nutzer', platform: 'telegram', isFirstMessage: false
          }).catch(() => {});

          await telegramService.sendMessage(chatId,
            'Verstanden! Ein Mitarbeiter wurde benachrichtigt und meldet sich so bald wie möglich. Die KI-Unterstützung ist jetzt pausiert.');
        } catch (_) {}
        return;
      }

      await messageProcessor.handle({
        platform: 'telegram',
        chatId,
        text,
        metadata: {
          username:   from.username     || null,
          first_name: from.first_name   || 'Nutzer',
          language:   from.language_code || 'de'
        }
      });
    } catch (err) {
      console.error('[Webhook/Telegram]', err.message);
    }
  });
});

// ── Sellauth Webhook ──────────────────────────────────────────────────────────
router.post('/sellauth', (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const supabase = require('../config/supabase');
      const event    = req.body;
      await supabase.from('integration_logs').insert([{
        source:     'sellauth',
        event_type: event.type || 'unknown',
        payload:    event,
        created_at: new Date()
      }]);
    } catch (err) {
      console.error('[Webhook/Sellauth]', err.message);
    }
  });
});

module.exports = router;
