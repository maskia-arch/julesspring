const express = require('express');
const router = express.Router();

// ── Telegram Webhook ──────────────────────────────────────────────────────────
// REGEL: res.sendStatus(200) ist die allererste synchrone Operation.
// Alles danach läuft in setImmediate() – kein Crash kann die 200 blockieren.
const channelController = require('../controllers/channelController');
const smalltalkAgent = require('../services/ai/smalltalkAgent');

// v1.4.48: in-memory dedup for Telegram update_id to guard against retries
const _processedUpdates = new Map();
const _UPDATE_CACHE_MS = 5 * 60 * 1000; // 5 min

function _rememberUpdate(id) {
  _processedUpdates.set(id, Date.now());
  if (_processedUpdates.size > 500) {
    const cutoff = Date.now() - _UPDATE_CACHE_MS;
    for (const [k, t] of _processedUpdates)
      if (t < cutoff) _processedUpdates.delete(k);
  }
}

router.post('/telegram', (req, res) => {
  res.sendStatus(200);
  
  setImmediate(async () => {
    try {
      const update_id = req.body?.update_id;
      if (update_id && _processedUpdates.has(update_id)) {
        require('../utils/logger').info(`[Webhook] dupe update_id ${update_id} — skip`);
        return;
      }
      if (update_id) _rememberUpdate(update_id);
      
      const { message, chat_join_request } = req.body;
      const supabase = require('../config/supabase');
      const { tgApi } = require('../services/adminHelper/tgAdminHelper');
      
      if (chat_join_request) {
        const chatId = chat_join_request.chat.id.toString();
        const userId = chat_join_request.from.id.toString();
        
        try {
          const { data: bannedUser } = await supabase.from('channel_banned_users')
            .select('id').eq('channel_id', chatId).eq('user_id', userId).maybeSingle();
          
          if (bannedUser) {
            const { data: settings } = await supabase.from('settings').select('smalltalk_bot_token').single().catch(() => ({ data: null }));
            const tg = tgApi(settings?.smalltalk_bot_token || process.env.TELEGRAM_BOT_TOKEN);
            
            await tg.call('declineChatJoinRequest', {
              chat_id: chatId,
              user_id: userId
            });
            require('../utils/logger').info(`[JoinRequest] Blocked banned user ${userId} from joining ${chatId}`);
            return;
          }
        } catch (e) {
          require('../utils/logger').warn(`[JoinRequest Check Error] ${e.message}`);
        }
        return;
      }
      
      if (!message) return;
      
      const chatId = message.chat?.id?.toString();
      const text = message.text?.trim();
      const from = message.from || {};
      if (!chatId || !text) return;
      
      require('../utils/logger').info(`[Webhook] ${chatId} → "${text.substring(0, 60)}"`);
      
      const telegramService = require('../services/telegramService');
      const messageProcessor = require('../services/messageProcessor');
      
      const { data: channelData } = await supabase.from('bot_channels').select('id, added_by_user_id').eq('id', chatId).maybeSingle();
      
      if (channelData && !from.is_bot) {
        const blacklistService = require('../services/adminHelper/blacklistService');
        const { data: settings } = await supabase.from('settings').select('smalltalk_bot_token').single().catch(() => ({ data: null }));
        const tg = tgApi(settings?.smalltalk_bot_token || process.env.TELEGRAM_BOT_TOKEN);
        
        const blacklistResult = await blacklistService.checkBlacklist(
          supabase,
          chatId,
          text,
          from,
          chatId,
          message.message_id,
          tg,
          settings?.smalltalk_bot_token
        );
        
        if (blacklistResult) {
          if (blacklistResult.action !== "tolerated" && blacklistResult.action.includes("delete")) {
            return;
          }
        }
      }
      
      if (text === '/start') {
        let welcome = 'Willkommen! 👋 Wie kann ich dir helfen?';
        try {
          const { data: settings } = await supabase
            .from('settings').select('welcome_message').single();
          if (settings?.welcome_message) welcome = settings.welcome_message;
        } catch (_) {}
        await telegramService.sendMessage(chatId, welcome);
        return;
      }
      
      const UNIQUE_ID_RE = /[a-f0-9]{8,}-[0-9]{10,}/i;
      const PLAIN_ID_RE = /\b(\d{5,})\b/;
      
      const ID_PATTERN = '([a-f0-9]+-[0-9]+|[0-9]+)';
      const explicitOrder = text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i')) ||
        text.match(new RegExp('^(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i'));
      
      const hasOrderContext = /(?:bestellung|bestell|order|invoice|rechnung|esim|status|wo ist|lieferung|kauft?e?|bezahlt?|meine bestellung|wann kommt|schon da|angekommen|erhalten)/i.test(text);
      const uniqueIdInText = text.match(UNIQUE_ID_RE);
      const plainIdInText = hasOrderContext && text.match(PLAIN_ID_RE);
      const implicitOrder = uniqueIdInText || plainIdInText;
      
      const orderMatch = explicitOrder || (implicitOrder ? [null, implicitOrder[0]] : null);
      if (orderMatch) {
        const sellauthService = require('../services/sellauthService');
        const invoiceId = orderMatch[1];
        try {
          let s = null;
          try {
            const { data: _s } = await supabase.from('settings')
              .select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
            s = _s;
          } catch (_) {}
          
          if (!s?.sellauth_api_key || !s?.sellauth_shop_id) {
            await telegramService.sendMessage(chatId,
              'Bestellabfrage ist derzeit nicht verfügbar. Bitte wende dich an unseren Support.');
            return;
          }
          
          const invoice = await sellauthService.getInvoice(
            s.sellauth_api_key, s.sellauth_shop_id, invoiceId
          );
          const response = sellauthService.formatInvoiceForCustomer(invoice, s.sellauth_shop_url);
          await telegramService.sendMessage(chatId, response);
        } catch (err) {
          const status = err.response?.status;
          console.error('[Order] Fehler für', invoiceId, '- Status:', status, '-', err.response?.data?.message || err.message);
          if (status === 404) {
            await telegramService.sendMessage(chatId,
              'Bestellung ' + invoiceId + ' wurde nicht gefunden. Bitte prüfe ob die Invoice-ID korrekt ist.\n\nDie ID steht in der Bestätigungs-E-Mail von Sellauth (Format: xxxxxxx-0000000000000)');
          } else if (status === 401 || status === 403) {
            await telegramService.sendMessage(chatId,
              'Bestellabfrage konnte nicht durchgeführt werden. Bitte wende dich an den Support: @autoacts');
          } else {
            console.error('[Order] Unerwarteter Fehler:', status, err.response?.data);
            await telegramService.sendMessage(chatId,
              'Bestellabfrage ist momentan nicht verfügbar (Code: ' + (status || 'timeout') + '). Bitte wende dich an @autoacts');
          }
        }
        return;
      }
      
      telegramService.sendTypingAction(chatId).catch(() => {});
      
      await messageProcessor.handle({
        platform: 'telegram',
        chatId,
        text,
        metadata: {
          username: from.username || null,
          first_name: from.first_name || 'Nutzer',
          language: from.language_code || 'de'
        }
      });
    } catch (err) {
      require('../utils/logger').error('[Webhook/Telegram]', err.message, err.stack);
      try {
        const tg = require('../services/telegramService');
        const cid = req.body?.message?.chat?.id;
        if (cid) {
          await tg.sendMessage(String(cid),
            'Es gab einen kurzen Fehler. Bitte versuche es in einem Moment erneut.');
        }
      } catch (_) {}
    }
  });
});

// ── Sellauth Webhook ──────────────────────────────────────────────────────────
router.post('/sellauth', (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const supabase = require('../config/supabase');
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