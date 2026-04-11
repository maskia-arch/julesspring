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

      // /order <ID> oder "Bestellung 12345" – direkte Sellauth-Abfrage, keine KI-Kosten
      // Erkennt: /order 971 | /order 05d0bb6ed687d-0000011429923 | Bestellung 971 | invoice 12345
      const ID_PATTERN = '([a-f0-9]+-[0-9]+|[0-9]+)';
      const orderMatch = text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i')) ||
                         text.match(new RegExp('^(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i'));
      if (orderMatch) {
        const sellauthService = require('../services/sellauthService');
        const invoiceId = orderMatch[1];
        try {
          const { data: s } = await supabase.from('settings')
            .select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single().catch(() => ({ data: null }));

          if (!s?.sellauth_api_key || !s?.sellauth_shop_id) {
            await telegramService.sendMessage(chatId,
              'Bestellabfrage ist derzeit nicht verfügbar. Bitte wende dich an unseren Support.');
            return;
          }

          // unique_id Format (z.B. 05d0bb6ed687d-0000011429923) → numerische ID extrahieren
          const numericId = invoiceId.includes('-')
            ? (invoiceId.split('-').pop().replace(/^0+/, '') || '0')
            : invoiceId;

          const invoice = await sellauthService.getInvoice(
            s.sellauth_api_key, s.sellauth_shop_id, numericId
          );
          const response = sellauthService.formatInvoiceForCustomer(invoice, s.sellauth_shop_url);
          await telegramService.sendMessage(chatId, response);
        } catch (err) {
          const status = err.response?.status;
          if (status === 404) {
            await telegramService.sendMessage(chatId,
              'Bestellung ' + invoiceId + ' wurde nicht gefunden. Bitte prüfe die Bestellnummer.');
          } else {
            await telegramService.sendMessage(chatId,
              'Bestellabfrage fehlgeschlagen. Bitte versuche es in einem Moment erneut.');
          }
        }
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

// ── Bestellstatus-Abfrage ─────────────────────────────────────────────────────
async function handleOrderLookup(chatId, invoiceId, telegramService, supabase) {
  try {
    const sellauthService = require('../services/sellauthService');

    const { data: s } = await supabase.from('settings')
      .select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();

    if (!s?.sellauth_api_key || !s?.sellauth_shop_id) {
      await telegramService.sendMessage(chatId,
        'Bestellabfrage ist derzeit nicht verfügbar. Bitte wende dich an unseren Support.');
      return;
    }

    await telegramService.sendMessage(chatId, 'Einen Moment, ich suche deine Bestellung...');

    const invoice = await sellauthService.getInvoice(
      s.sellauth_api_key, s.sellauth_shop_id, invoiceId
    );

    const response = sellauthService.formatInvoiceForCustomer(invoice, s.sellauth_shop_url);
    await telegramService.sendMessage(chatId, response);

  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      await telegramService.sendMessage(chatId,
        'Bestellung ' + invoiceId + ' wurde nicht gefunden. Bitte prüfe die Bestellnummer und versuche es erneut.');
    } else {
      console.error('[Order Lookup]', err.message);
      await telegramService.sendMessage(chatId,
        'Bestellabfrage konnte nicht abgerufen werden. Bitte versuche es in einem Moment erneut.');
    }
  }
}

module.exports = router;
