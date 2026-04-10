const express = require('express');
const router  = express.Router();

// ── Telegram Webhook ──────────────────────────────────────────────────────────
router.post('/telegram', (req, res) => {
  // 200 sofort — Telegram wartet max. 5 Sekunden
  res.sendStatus(200);

  setImmediate(async () => {
    const telegramService = require('../services/telegramService');
    const supabase        = require('../config/supabase');
    const messageProcessor = require('../services/messageProcessor');
    const logger          = require('../utils/logger');

    const { message } = req.body;
    if (!message) return;

    const chatId = message.chat?.id?.toString();
    const text   = message.text?.trim();
    const from   = message.from || {};
    if (!chatId || !text) return;

    // /start → Willkommensnachricht
    if (text === '/start') {
      try {
        let welcome = 'Willkommen! 👋 Wie kann ich dir helfen?';
        const { data: s } = await supabase.from('settings').select('welcome_message').single();
        if (s?.welcome_message) welcome = s.welcome_message;
        await telegramService.sendMessage(chatId, welcome);
      } catch (_) {}
      return;
    }

    // Normale Nachricht verarbeiten
    try {
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
      // KRITISCH: Immer eine Antwort senden, egal was schiefläuft
      logger.error(`[Webhook] messageProcessor Fehler für ${chatId}: ${err.message}`);
      try {
        await telegramService.sendMessage(
          chatId,
          'Entschuldigung, ich konnte deine Anfrage gerade nicht verarbeiten. Bitte versuche es in einem Moment erneut. 🙏'
        );
      } catch (sendErr) {
        logger.error(`[Webhook] Fallback-Nachricht konnte nicht gesendet werden: ${sendErr.message}`);
      }
    }
  });
});

// ── Sellauth Webhook ──────────────────────────────────────────────────────────
router.post('/sellauth', (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const supabase = require('../config/supabase');
      await supabase.from('integration_logs').insert([{
        source: 'sellauth', event_type: req.body?.type || 'unknown',
        payload: req.body, created_at: new Date()
      }]);
    } catch (_) {}
  });
});

module.exports = router;
