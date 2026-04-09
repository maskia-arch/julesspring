const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegramService');
const supabase = require('../config/supabase');
const messageProcessor = require('../services/messageProcessor');

// ─── Telegram Webhook ────────────────────────────────────────────────────────
//
// KRITISCH: Telegram erwartet eine 200-Antwort innerhalb von 5 Sekunden.
// Wenn die KI-Verarbeitung länger dauert, schickt Telegram den Webhook
// erneut → Endlos-Loop. Lösung: Sofort 200 antworten, dann async verarbeiten.
//
router.post('/telegram', async (req, res) => {
  // Sofort 200 zurückgeben – egal was danach passiert
  res.sendStatus(200);

  const { message } = req.body;
  if (!message) return;

  const chatId   = message.chat?.id?.toString();
  const text     = message.text?.trim();
  const from     = message.from || {};

  if (!chatId || !text) return;

  try {
    // /start → Willkommensnachricht
    if (text === '/start') {
      const { data: settings } = await supabase
        .from('settings').select('welcome_message').single();

      const welcome = settings?.welcome_message ||
        'Willkommen! 👋 Wie kann ich dir helfen?';

      await telegramService.sendMessage(chatId, welcome);
      return;
    }

    // Alle anderen Nachrichten → MessageProcessor
    await messageProcessor.handle({
      platform: 'telegram',
      chatId,
      text,
      metadata: {
        username:   from.username   || null,
        first_name: from.first_name || 'Nutzer',
        language:   from.language_code || 'de'
      }
    });
  } catch (err) {
    console.error('[Webhook/Telegram] Verarbeitungsfehler:', err.message);
    // Fehler-Fallback: Nutzer über Problem informieren
    try {
      await telegramService.sendMessage(chatId,
        'Entschuldigung, ich konnte deine Nachricht gerade nicht verarbeiten. Bitte versuche es gleich nochmal. 🙏');
    } catch (_) {}
  }
});

// ─── Sellauth Webhook ─────────────────────────────────────────────────────────
router.post('/sellauth', async (req, res) => {
  res.sendStatus(200); // Sofort bestätigen
  try {
    const event = req.body;
    await supabase.from('integration_logs').insert([{
      source: 'sellauth',
      event_type: event.type || 'unknown',
      payload: event,
      created_at: new Date()
    }]);
  } catch (err) {
    console.error('[Webhook/Sellauth]', err.message);
  }
});

module.exports = router;
