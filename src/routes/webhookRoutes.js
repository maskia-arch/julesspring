const express = require('express');
const router  = express.Router();

// ── Telegram Webhook ──────────────────────────────────────────────────────────
//
// REGEL: res.sendStatus(200) muss die ALLERERSTE Operation sein.
// Telegram bricht ab wenn es keine 200 innerhalb von 5s bekommt.
// Jede weitere Verarbeitung läuft danach async – Fehler sind nicht fatal.
//
router.post('/telegram', (req, res) => {
  // ← Sofort 200 senden, SYNCHRON, bevor irgendwas anderes passiert
  res.sendStatus(200);

  // Danach alles async – kein await, kein throw der nach außen geht
  setImmediate(async () => {
    try {
      const { message } = req.body;
      if (!message) return;

      const chatId = message.chat?.id?.toString();
      const text   = message.text?.trim();
      const from   = message.from || {};

      if (!chatId || !text) return;

      // Lazy-require um Circular-Dependency zu vermeiden
      const telegramService  = require('../services/telegramService');
      const supabase         = require('../config/supabase');
      const messageProcessor = require('../services/messageProcessor');

      if (text === '/start') {
        const { data: settings } = await supabase
          .from('settings').select('welcome_message').single().catch(() => ({ data: null }));
        const welcome = settings?.welcome_message || 'Willkommen! 👋 Wie kann ich dir helfen?';
        await telegramService.sendMessage(chatId, welcome);
        return;
      }

      await messageProcessor.handle({
        platform: 'telegram',
        chatId,
        text,
        metadata: {
          username:   from.username    || null,
          first_name: from.first_name  || 'Nutzer',
          language:   from.language_code || 'de'
        }
      });
    } catch (err) {
      console.error('[Webhook/Telegram]', err.message);
      // Kein Re-throw – Fehler darf nicht nach außen
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
