const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController');
const auth    = require('../middleware/auth');

router.post('/login', ctrl.login);

router.post('/webhooks/sellauth-packages', async (req, res) => {
  res.sendStatus(200);
  try {
    const packageService = require("../services/packageService");
    const body = req.body;
    const invoiceId = String(body?.data?.id || body?.id || "");
    const customFields = body?.data?.custom_fields || body?.custom_fields || [];
    const isRefill = customFields.some(f => f.name === "type" && f.value === "refill");
    let result;
    if (isRefill) {
      const cfChannel = customFields.find(f => f.name === "channel_id");
      const channelId = cfChannel?.value;
      const { data: purch } = await require("../config/supabase").from("channel_purchases")
        .select("credits_added").eq("sellauth_invoice_id", invoiceId).maybeSingle().then(r=>r, ()=>({data:null}));
      const credits = purch?.credits_added || 0;
      result = await packageService.handleRefillWebhook(invoiceId, channelId, credits);
    } else {
      result = await packageService.handleWebhook(body);
    }
    if (result.handled && result.adminId) {
      const supabase = require("../config/supabase");
      const axios    = require("axios");
      const { data: settings } = await supabase.from("settings").select("smalltalk_bot_token").single().then(r=>r, ()=>({data:null}));
      const token = settings?.smalltalk_bot_token || process.env.TELEGRAM_BOT_TOKEN;
      if (token) {
        const exp = result.expiresAt ? new Date(result.expiresAt).toLocaleDateString("de-DE") : "?";
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: String(result.adminId),
          text: result.isRefill
            ? `🔋 <b>Credits aufgeladen!</b>\n\nChannel: ${result.title || result.channelId}\nNachgeladene Credits: ${(result.credits||0).toLocaleString()}\n\nDie KI läuft weiter! 🚀`
            : `✅ <b>Paket aktiviert!</b>\n\nChannel: ${result.title || result.channelId}\nCredits: ${(result.credits||0).toLocaleString()}\nLäuft bis: ${exp}\n\nKI-Features sind jetzt aktiv! 🚀`,
          parse_mode: "HTML"
        }, { timeout: 10000 }).catch(() => {});
      }
    }
  } catch (e) {
    require("../utils/logger").error("[Packages Webhook]", e.message);
  }
});

router.use(auth);

router.get('/stats',          ctrl.getStats);
router.get('/settings',       ctrl.getSettings);
router.post('/settings',      ctrl.updateSettings);

router.get('/chats',                    ctrl.getChats);
router.get('/chats/:chatId/messages',   ctrl.getChatMessages);
router.patch('/chats/:chatId/status',   ctrl.updateChatStatus);
router.post('/manual-message',          ctrl.sendManualMessage);

router.get('/learning',          ctrl.getLearningQueue);
router.post('/learning/resolve', ctrl.resolveLearning);
router.delete('/learning/:id',   ctrl.deleteLearning);

router.get('/knowledge/categories',       ctrl.getKnowledgeCategories);
router.post('/knowledge/categories',      ctrl.createKnowledgeCategory);
router.delete('/knowledge/categories/:id',ctrl.deleteKnowledgeCategory);

router.get('/knowledge/entries',     ctrl.getKnowledgeEntries);
router.delete('/knowledge/entries/:id',      ctrl.deleteKnowledgeEntry);
router.put('/knowledge/entries/:id',         ctrl.updateKnowledgeEntry);
router.post('/knowledge/entries/:id/sync',   ctrl.syncKnowledgeEntry);
router.get('/knowledge/entries/:id/related', ctrl.getRelatedEntries);

router.post('/knowledge/manual',    ctrl.addManualKnowledge);
router.post('/knowledge/discover',  ctrl.discoverLinks);
router.post('/scrape',              ctrl.startScraping);

router.post('/sellauth/test',     ctrl.testSellauthConnection);
router.post('/sellauth/sync',         ctrl.syncSellauth);
router.get('/sellauth/invoice/:invoiceId', ctrl.lookupInvoice);
router.get('/sellauth/sync-status/:jobId', ctrl.getSyncStatus);
router.get('/sellauth/preview',   ctrl.previewSellauthProducts);

router.post('/sync-sellauth',     ctrl.syncSellauth);

router.post('/telegram/webhook',  ctrl.setupWebhook);
router.get('/telegram/webhook',   ctrl.getWebhookInfo);

router.get('/blacklist',       ctrl.getBlacklist);
router.post('/blacklist',      ctrl.banUser);
router.delete('/blacklist/:id',ctrl.removeBan);

router.get('/feedbacks/pending', ctrl.getPendingFeedbacks);
router.post('/feedbacks/:id/approve', ctrl.approveFeedback);
router.post('/feedbacks/:id/reject', ctrl.rejectFeedback);

router.post('/push-subscription',    ctrl.savePushSubscription);
router.get('/push/vapid-key',        ctrl.getVapidPublicKey);
router.post('/push/test',            ctrl.sendTestPush);

router.get('/traffic',               ctrl.getTrafficStats);
router.get('/traffic/live',          ctrl.getLiveVisitors);

router.get('/visitors',              ctrl.getVisitorList);
router.get('/visitors/ip/:ip',       ctrl.lookupVisitorIp);
router.post('/visitors/ip/:ip/ban',  ctrl.banVisitorIp);

router.get('/coupons/schedule',       ctrl.getCouponSchedule);
router.put('/coupons/schedule',       ctrl.saveCouponSchedule);
router.get('/coupons/active',         ctrl.getActiveCoupon);
router.post('/coupons/create-now',    ctrl.createCouponNow);
router.get('/coupons/history',        ctrl.getCouponHistory);

router.get('/traffic/sessions',       ctrl.getSessions);

const channelCtrl = require('../controllers/channelController');
router.get('/channels',                  channelCtrl.getChannels.bind(channelCtrl));
router.put('/channels/:id/ai',           channelCtrl.toggleAI.bind(channelCtrl));
router.post('/channels/scan',            channelCtrl.scanChannels.bind(channelCtrl));
router.post('/channels/register',        channelCtrl.registerChannelById.bind(channelCtrl));
router.put('/channels/:id',              channelCtrl.updateChannel.bind(channelCtrl));
router.post('/channels/:id/reset-usage',         channelCtrl.resetChannelUsage.bind(channelCtrl));
router.get('/channels/:id/kb',                   channelCtrl.getChannelKB.bind(channelCtrl));
router.post('/channels/:id/kb',                  channelCtrl.addChannelKBEntry.bind(channelCtrl));
router.delete('/channels/:id/kb/:entryId',       channelCtrl.deleteChannelKBEntry.bind(channelCtrl));

// Hier fangen wir den Lösch-Befehl für den Channel ab und hängen die "Scorched Earth" Logik dazwischen
router.delete('/channels/:id', async (req, res, next) => {
  try {
    const channelId = req.params.id;
    const supabase = require('../config/supabase');
    
    // Lösche alles, was an dieser Channel-ID hängt
    const tablesToClean = [
      'user_feedbacks',
      'channel_safelist',
      'scam_entries',
      'user_reputation',
      'channel_blacklist',
      'channel_members',
      'channel_knowledge',
      'scheduled_messages',
      'channel_purchases',
      'bot_messages',
      'channel_chat_history'
    ];
    
    for (const table of tablesToClean) {
      await supabase.from(table).delete().eq('channel_id', channelId).then(r=>r, ()=>{});
    }
    
    next();
  } catch (e) {
    next();
  }
}, channelCtrl.deleteChannel.bind(channelCtrl));

router.get('/smalltalk/status',   ctrl.testSmallTalkBot);
router.post('/smalltalk/connect',  ctrl.testSmallTalkBot);

router.get('/channel-groups',          channelCtrl.getChannelGroups.bind(channelCtrl));
router.post('/channel-groups',         channelCtrl.createChannelGroup.bind(channelCtrl));
router.delete('/channel-groups/:id',   channelCtrl.deleteChannelGroup.bind(channelCtrl));

router.get('/scamlist',              channelCtrl.getScamlist.bind(channelCtrl));
router.post('/scamlist/remove',      channelCtrl.removeFromScamlist.bind(channelCtrl));

router.get('/userinfo-pro',               channelCtrl.getProUsers.bind(channelCtrl));
router.post('/userinfo-pro',              channelCtrl.addProUser.bind(channelCtrl));
router.delete('/userinfo-pro/:userId',    channelCtrl.removeProUser.bind(channelCtrl));

router.get('/sellauth/product/:productId/variants', async (req, res, next) => {
  try {
    const axios    = require("axios");
    const supabase = require("../config/supabase");
    const { productId } = req.params;

    let apiKey = null, shopId = null;
    try {
      const r = await supabase.from("settings").select("sellauth_api_key, sellauth_shop_id").single();
      apiKey = r.data?.sellauth_api_key || null;
      shopId = r.data?.sellauth_shop_id || null;
    } catch (_) {}
    apiKey = apiKey || process.env.SELLAUTH_API_KEY;
    shopId = shopId || process.env.SELLAUTH_SHOP_ID;

    if (!apiKey || !shopId) return res.status(400).json({ error: "API-Key oder Shop-ID fehlen" });

    const { data: product } = await axios.get(
      `https://api.sellauth.com/v1/shops/${shopId}/products/${productId}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, timeout: 10000 }
    );

    const variants = (product?.variants || []).map(v => ({
      id: v.id, name: v.name, price: v.price, stock: v.stock
    }));
    res.json({ product_id: product?.id, product_name: product?.name, variants });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    res.status(status || 500).json({ error: msg });
  }
});

router.get('/packages',          channelCtrl.getPackages.bind(channelCtrl));
router.post('/packages',         channelCtrl.upsertPackage.bind(channelCtrl));
router.delete('/packages/:id',   channelCtrl.deletePackage.bind(channelCtrl));

router.get('/channels/admin-list',          channelCtrl.getChannelAdminList.bind(channelCtrl));
router.post('/channels/manual-credits',     channelCtrl.manualCreditPatch.bind(channelCtrl));
router.post('/channels/manual-package',     channelCtrl.manualPackageBook.bind(channelCtrl));

router.get('/refills',         channelCtrl.getRefills.bind(channelCtrl));
router.post('/refills',        channelCtrl.upsertRefill.bind(channelCtrl));
router.delete('/refills/:id',  channelCtrl.deleteRefill.bind(channelCtrl));

module.exports = router;
