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
      
      const { data: settings } = await supabase.from('settings').select('smalltalk_bot_token, welcome_message').single().catch(() => ({ data: null }));
      
      if (my_chat_member) {
        const chatId = my_chat_member.chat.id.toString();
        const userId = my_chat_member.from.id.toString();
        const newStatus = my_chat_member.new_chat_member.status;
        const chatTitle = my_chat_member.chat.title || 'Channel';

        if (['administrator', 'member', 'creator'].includes(newStatus)) {
           const { data: existingChannel } = await supabase.from('bot_channels').select('id, is_approved').eq('id', chatId).maybeSingle();
           if (!existingChannel) {
             await supabase.from('bot_channels').insert([{
               id: chatId, title: chatTitle, added_by_user_id: userId,
               is_approved: false, ai_enabled: false, is_active: true
             }]);
           } else {
             await supabase.from('bot_channels').update({ is_active: true, title: chatTitle }).eq('id', chatId);
           }
        } else if (['left', 'kicked'].includes(newStatus)) {
           await supabase.from('bot_channels').update({ is_active: false }).eq('id', chatId);
        }
        return; 
      }

      if (chat_join_request) {
        const chatId = chat_join_request.chat.id.toString();
        const userId = chat_join_request.from.id.toString();
        try {
          const { data: bannedUser } = await supabase.from('channel_banned_users')
            .select('id').eq('channel_id', chatId).eq('user_id', userId).maybeSingle();
          if (bannedUser) {
            const tg = tgApi(process.env.TELEGRAM_BOT_TOKEN);
            await tg.call('declineChatJoinRequest', { chat_id: chatId, user_id: userId });
          }
        } catch (e) {}
        return;
      }
      
      if (!msg) return;
      
      const chatId = msg.chat?.id?.toString();
      const text = msg.text?.trim() || msg.caption?.trim();
      const from = msg.from || { id: msg.sender_chat?.id || 0, first_name: msg.sender_chat?.title || 'Channel' };
      const threadId = msg.message_thread_id || null;
      const isPrivate = msg.chat?.type === 'private';
      
      if (!chatId || !text) return;

      const activeToken = (isPrivate && settings?.smalltalk_bot_token) 
        ? settings.smalltalk_bot_token 
        : process.env.TELEGRAM_BOT_TOKEN;
        
      const tg = tgApi(activeToken);
      
      let isAdmin = false;
      if (msg.chat.type === 'channel') {
        isAdmin = true;
      } else if (from.id && from.id !== 777000) {
        try {
          const member = await tg.call('getChatMember', { chat_id: chatId, user_id: from.id });
          if (['creator', 'administrator'].includes(member?.status)) isAdmin = true;
        } catch (e) {}
      }
      
      if (!isPrivate && (text.startsWith('/mute') || text.startsWith('/ban') || text.startsWith('/unban'))) {
        if (isAdmin && msg.reply_to_message && msg.reply_to_message.from) {
          const targetUserId = msg.reply_to_message.from.id;
          const command = text.split(' ')[0].toLowerCase();
          const reason = text.substring(command.length).trim() || 'Manuell vom Admin';
          
          if (command === '/mute') {
            await tg.call('restrictChatMember', {
              chat_id: chatId, user_id: targetUserId,
              permissions: { can_send_messages: false },
              until_date: Math.floor(Date.now() / 1000) + (12 * 3600)
            }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: `🔇 User stummgeschaltet.\nGrund: ${reason}` }).catch(() => {});
          } else if (command === '/ban') {
            await tg.call('banChatMember', { chat_id: chatId, user_id: targetUserId }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: `🚫 User gebannt.\nGrund: ${reason}` }).catch(() => {});
            await supabase.from("channel_banned_users").upsert([{
              channel_id: String(chatId), user_id: String(targetUserId),
              username: msg.reply_to_message.from.username || null,
              reason: reason, banned_at: new Date().toISOString()
            }], { onConflict: "channel_id,user_id" }).catch(() => {});
          } else if (command === '/unban') {
            await tg.call('unbanChatMember', { chat_id: chatId, user_id: targetUserId, only_if_banned: false }).catch(() => {});
            await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: `✅ User entbannt.` }).catch(() => {});
            await supabase.from("channel_banned_users").delete().eq("user_id", String(targetUserId)).eq("channel_id", String(chatId)).catch(() => {});
          }
        }
        return;
      }
      
      const messageProcessor = require('../services/messageProcessor');
      const { data: channelData } = await supabase.from('bot_channels').select('id, is_approved, ai_enabled').eq('id', chatId).maybeSingle();
      
      if (!isPrivate && channelData && !from.is_bot && !isAdmin) { 
        const blacklistService = require('../services/adminHelper/blacklistService');
        const blacklistResult = await blacklistService.checkBlacklist(supabase, chatId, text, from, chatId, msg.message_id, tg, activeToken);
        if (blacklistResult?.action?.includes("delete")) return;
      }
      
      if (text === '/start') {
        const welcome = settings?.welcome_message || 'Willkommen! 👋 Wie kann ich dir helfen?';
        await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: welcome }).catch(() => {});
        return;
      }
      
      const ID_PATTERN = '([a-f0-9]+-[0-9]+|[0-9]+)';
      const orderMatch = text.match(new RegExp('(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i')) ||
                         text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i'));

      if (orderMatch) {
        const sellauthService = require('../services/sellauthService');
        const invoiceId = orderMatch[1];
        try {
          const { data: s } = await supabase.from('settings').select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single().catch(() => ({ data: null }));
          if (!s?.sellauth_api_key) {
            await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: 'Bestellabfrage derzeit nicht verfügbar.' }).catch(() => {});
            return;
          }
          const invoice = await sellauthService.getInvoice(s.sellauth_api_key, s.sellauth_shop_id, invoiceId);
          const response = sellauthService.formatInvoiceForCustomer(invoice, s.sellauth_shop_url);
          await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: response, parse_mode: "HTML" }).catch(() => {});
        } catch (err) {
          await tg.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: 'Bestellung nicht gefunden oder Fehler bei der Abfrage.' }).catch(() => {});
        }
        return;
      }
      
      await tg.call('sendChatAction', { chat_id: chatId, message_thread_id: threadId, action: 'typing' }).catch(() => {});
      
      await messageProcessor.handle({
        platform: 'telegram',
        chatId,
        text,
        metadata: {
          username: from.username || null,
          first_name: from.first_name || 'Nutzer',
          message_thread_id: threadId,
          token: activeToken
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
        source: 'sellauth', event_type: event.type || 'unknown', payload: event, created_at: new Date()
      }]);
    } catch (err) {}
  });
});

module.exports = router;
