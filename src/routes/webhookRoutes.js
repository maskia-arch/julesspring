const express = require('express');
const router = express.Router();

const channelController = require('../controllers/channelController');
const smalltalkAgent = require('../services/ai/smalltalkAgent');

const _processedUpdates = new Map();
const _UPDATE_CACHE_MS = 5 * 60 * 1000;

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
        return;
      }
      if (update_id) _rememberUpdate(update_id);
      
      const { chat_join_request, my_chat_member } = req.body;
      const msg = req.body.message || req.body.channel_post;
      
      const supabase = require('../config/supabase');
      const { tgApi } = require('../services/adminHelper/tgAdminHelper');
      
      // SICHERHEITS-UPDATE: Wenn der Bot neue Berechtigungen bekommt, 
      // soll er NIEMALS die Datenbank überschreiben und das Abo löschen.
      // Wir aktualisieren nur, oder legen ihn neu an, FALLS er noch nicht existiert.
      if (my_chat_member) {
        const chatId = my_chat_member.chat.id.toString();
        const userId = my_chat_member.from.id.toString();
        const newStatus = my_chat_member.new_chat_member.status;
        const chatTitle = my_chat_member.chat.title || 'Channel';

        if (['administrator', 'member', 'creator'].includes(newStatus)) {
           // Wir prüfen, ob der Kanal schon in der DB existiert
           const { data: existingChannel } = await supabase.from('bot_channels').select('id, is_approved').eq('id', chatId).maybeSingle();
           
           if (!existingChannel) {
             // Nur wenn der Kanal GÄNZLICH NEU ist, wird er angelegt
             await supabase.from('bot_channels').insert([{
               id: chatId,
               title: chatTitle,
               added_by_user_id: userId,
               is_approved: false, // Bei neuen Kanälen immer false (muss gekauft werden)
               ai_enabled: false,
               is_active: true
             }]);
           } else {
             // Falls er existiert, aktualisieren wir NUR den is_active Status (falls er z.B. reaktiviert wurde)
             await supabase.from('bot_channels').update({ is_active: true, title: chatTitle }).eq('id', chatId);
           }
        } else if (['left', 'kicked'].includes(newStatus)) {
           // Wenn der Bot entfernt wird, setzen wir ihn auf inaktiv
           await supabase.from('bot_channels').update({ is_active: false }).eq('id', chatId);
        }
        return; // Nach Berechtigungs-Updates ist hier Schluss, kein Message-Processing.
      }

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
            return;
          }
        } catch (e) {}
        return;
      }
      
      if (!msg) return;
      
      const chatId = msg.chat?.id?.toString();
      const text = msg.text?.trim() || msg.caption?.trim(); // FIX: Caption (Bilder/Videos) auch für Blacklist prüfen
      const from = msg.from || { id: msg.sender_chat?.id || 0, first_name: msg.sender_chat?.title || 'Channel' };
      
      if (!chatId || !text) return;
      
      if (text.startsWith('/mute') || text.startsWith('/ban') || text.startsWith('/unban')) {
        const { data: settings } = await supabase.from('settings').select('smalltalk_bot_token').single().catch(() => ({ data: null }));
        const tg = tgApi(settings?.smalltalk_bot_token || process.env.TELEGRAM_BOT_TOKEN);
        
        let isAdmin = false;
        if (msg.chat.type === 'channel') {
          isAdmin = true;
        } else {
          try {
            const member = await tg.call('getChatMember', { chat_id: chatId, user_id: from.id });
            if (['creator', 'administrator'].includes(member.status)) isAdmin = true;
          } catch (e) {}
        }
        
        if (isAdmin && msg.reply_to_message && msg.reply_to_message.from) {
          const targetUserId = msg.reply_to_message.from.id;
          const command = text.split(' ')[0].toLowerCase();
          const reason = text.substring(command.length).trim() || 'Manuell vom Admin';
          
          if (command === '/mute') {
            await tg.call('restrictChatMember', {
              chat_id: chatId,
              user_id: targetUserId,
              permissions: { can_send_messages: false },
              until_date: Math.floor(Date.now() / 1000) + (12 * 3600)
            }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, text: `🔇 User stummgeschaltet.\nGrund: ${reason}` }).catch(() => {});
          } else if (command === '/ban') {
            await tg.call('banChatMember', { chat_id: chatId, user_id: targetUserId }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, text: `🚫 User gebannt.\nGrund: ${reason}` }).catch(() => {});
            await supabase.from("channel_banned_users").upsert([{
              channel_id: String(chatId),
              user_id: String(targetUserId),
              username: msg.reply_to_message.from.username || null,
              reason: reason,
              banned_at: new Date().toISOString()
            }], { onConflict: "channel_id,user_id" }).catch(() => {});
          } else if (command === '/unban') {
            await tg.call('unbanChatMember', { chat_id: chatId, user_id: targetUserId, only_if_banned: false }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, text: `✅ User entbannt.` }).catch(() => {});
            await supabase.from("channel_banned_users").delete().eq("user_id", String(targetUserId)).eq("channel_id", String(chatId)).catch(() => {});
          }
        }
        return;
      }
      
      const telegramService = require('../services/telegramService');
      const messageProcessor = require('../services/messageProcessor');
      
      const { data: channelData } = await supabase.from('bot_channels').select('id, added_by_user_id').eq('id', chatId).maybeSingle();
      
      // BLACKLIST LOGIK
      if (channelData && !from.is_bot && (from.id !== 0 && from.id !== 777000)) { // 777000 ist die offizielle Telegram "Anonymous Channel Post" ID
        const blacklistService = require('../services/adminHelper/blacklistService');
        const { data: settings } = await supabase.from('settings').select('smalltalk_bot_token').single().catch(() => ({ data: null }));
        const tg = tgApi(settings?.smalltalk_bot_token || process.env.TELEGRAM_BOT_TOKEN);
        
        const blacklistResult = await blacklistService.checkBlacklist(
          supabase,
          chatId,
          text,
          from,
          chatId,
          msg.message_id,
          tg,
          settings?.smalltalk_bot_token
        );
        
        if (blacklistResult) {
          if (blacklistResult.action !== "tolerated" && blacklistResult.action.includes("delete")) {
            return; // Wenn die Nachricht gelöscht wurde, stoppen wir die weitere Verarbeitung
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
          if (status === 404) {
            await telegramService.sendMessage(chatId,
              'Bestellung ' + invoiceId + ' wurde nicht gefunden. Bitte prüfe ob die Invoice-ID korrekt ist.\n\nDie ID steht in der Bestätigungs-E-Mail von Sellauth (Format: xxxxxxx-0000000000000)');
          } else if (status === 401 || status === 403) {
            await telegramService.sendMessage(chatId,
              'Bestellabfrage konnte nicht durchgeführt werden. Bitte wende dich an den Support: @autoacts');
          } else {
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
    } catch (err) {}
  });
});

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
    } catch (err) {}
  });
});

module.exports = router;
