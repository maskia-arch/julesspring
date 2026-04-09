const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const telegramService = require('../services/telegramService');
const supabase = require('../config/supabase');

// ─── Telegram Webhook ────────────────────────────────────────────────────────
router.post('/telegram', async (req, res, next) => {
  try {
    const { message } = req.body;

    // Kein Text → ignorieren (z.B. Fotos, Sticker)
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    // /start Befehl: Willkommensnachricht senden
    if (text === '/start') {
      const { data: settings } = await supabase
        .from('settings')
        .select('welcome_message')
        .single();

      const welcomeMsg = settings?.welcome_message ||
        'Willkommen! 👋 Ich bin dein KI-Assistent. Wie kann ich dir helfen?';

      await telegramService.sendMessage(chatId, welcomeMsg);
      return res.sendStatus(200);
    }

    // Normaler Nachrichtenfluss
    const chatData = {
      body: {
        platform: 'telegram',
        chatId,
        message: text,
        metadata: {
          username: message.from?.username || null,
          first_name: message.from?.first_name || 'Nutzer'
        }
      }
    };

    await chatController.handleIncomingMessage(chatData, res, next);
  } catch (error) {
    console.error('Telegram Webhook Error:', error);
    // Immer 200 an Telegram zurückgeben, sonst flood von Wiederholungen
    res.sendStatus(200);
  }
});

// ─── Sellauth Webhook ─────────────────────────────────────────────────────────
router.post('/sellauth', async (req, res, next) => {
  try {
    const event = req.body;

    await supabase.from('integration_logs').insert([{
      source: 'sellauth',
      event_type: event.type || 'unknown',
      payload: event,
      created_at: new Date()
    }]);

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
