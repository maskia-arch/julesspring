const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController');
const auth    = require('../middleware/auth');

// ─── ÖFFENTLICH ──────────────────────────────────────────────────────────────
router.post('/login', ctrl.login);

// ─── GESCHÜTZT (JWT) ─────────────────────────────────────────────────────────
router.use(auth);

// Stats & Settings
router.get('/stats',          ctrl.getStats);
router.get('/settings',       ctrl.getSettings);
router.post('/settings',      ctrl.updateSettings);

// Chat-Management
router.get('/chats',                    ctrl.getChats);
router.get('/chats/:chatId/messages',   ctrl.getChatMessages);
router.patch('/chats/:chatId/status',   ctrl.updateChatStatus);
router.post('/manual-message',          ctrl.sendManualMessage);

// Learning Center
router.get('/learning',          ctrl.getLearningQueue);
router.post('/learning/resolve', ctrl.resolveLearning);
router.delete('/learning/:id',   ctrl.deleteLearning);   // Ablehnen / Löschen

// ─── Wissensdatenbank ────────────────────────────────────────────────────────
// Kategorien
router.get('/knowledge/categories',       ctrl.getKnowledgeCategories);
router.post('/knowledge/categories',      ctrl.createKnowledgeCategory);
router.delete('/knowledge/categories/:id',ctrl.deleteKnowledgeCategory);

// Einträge
router.get('/knowledge/entries',     ctrl.getKnowledgeEntries);
router.delete('/knowledge/entries/:id',      ctrl.deleteKnowledgeEntry);
router.put('/knowledge/entries/:id',         ctrl.updateKnowledgeEntry);
router.post('/knowledge/entries/:id/sync',   ctrl.syncKnowledgeEntry);
router.get('/knowledge/entries/:id/related', ctrl.getRelatedEntries);

// Manuell + Scraper
router.post('/knowledge/manual',    ctrl.addManualKnowledge);
router.post('/knowledge/discover',  ctrl.discoverLinks);
router.post('/scrape',              ctrl.startScraping);

// ─── Sellauth Integration ────────────────────────────────────────────────────
router.post('/sellauth/test',     ctrl.testSellauthConnection);
router.post('/sellauth/sync',         ctrl.syncSellauth);
router.get('/sellauth/invoice/:invoiceId', ctrl.lookupInvoice);
router.get('/sellauth/sync-status/:jobId', ctrl.getSyncStatus);
router.get('/sellauth/preview',   ctrl.previewSellauthProducts);

// Legacy-Route (Kompatibilität)
router.post('/sync-sellauth',     ctrl.syncSellauth);

// ─── Telegram Setup ──────────────────────────────────────────────────────────
router.post('/telegram/webhook',  ctrl.setupWebhook);
router.get('/telegram/webhook',   ctrl.getWebhookInfo);

// ─── Sicherheit & Blacklist ──────────────────────────────────────────────────
router.get('/blacklist',       ctrl.getBlacklist);
router.post('/blacklist',      ctrl.banUser);
router.delete('/blacklist/:id',ctrl.removeBan);

// Push
router.post('/push-subscription',    ctrl.savePushSubscription);
router.get('/push/vapid-key',        ctrl.getVapidPublicKey);
router.post('/push/test',            ctrl.sendTestPush);

// Traffic
router.get('/traffic',               ctrl.getTrafficStats);
router.get('/traffic/live',          ctrl.getLiveVisitors);

// Visitor / IP
router.get('/visitors',              ctrl.getVisitorList);
router.get('/visitors/ip/:ip',       ctrl.lookupVisitorIp);
router.post('/visitors/ip/:ip/ban',  ctrl.banVisitorIp);

// Invoice
router.get('/sellauth/invoice/:invoiceId', ctrl.lookupInvoice);

// Coupons
router.get('/coupons/schedule',       ctrl.getCouponSchedule);
router.put('/coupons/schedule',       ctrl.saveCouponSchedule);
router.get('/coupons/active',         ctrl.getActiveCoupon);
router.post('/coupons/create-now',    ctrl.createCouponNow);
router.get('/coupons/history',        ctrl.getCouponHistory);

// Sessions
router.get('/traffic/sessions',       ctrl.getSessions);

// ── Channels ──────────────────────────────────────────────────────────────
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
router.delete('/channels/:id',           channelCtrl.deleteChannel.bind(channelCtrl));

router.get('/smalltalk/status',   ctrl.testSmallTalkBot);
router.post('/smalltalk/connect',  ctrl.testSmallTalkBot);

// ── Channel-Gruppen ───────────────────────────────────────────────────────
router.get('/channel-groups',          channelCtrl.getChannelGroups.bind(channelCtrl));
router.post('/channel-groups',         channelCtrl.createChannelGroup.bind(channelCtrl));
router.delete('/channel-groups/:id',   channelCtrl.deleteChannelGroup.bind(channelCtrl));

// Scamlist Management
router.get('/scamlist',              channelCtrl.getScamlist.bind(channelCtrl));
router.post('/scamlist/remove',      channelCtrl.removeFromScamlist.bind(channelCtrl));

// UserInfo Pro
router.get('/userinfo-pro',               channelCtrl.getProUsers.bind(channelCtrl));
router.post('/userinfo-pro',              channelCtrl.addProUser.bind(channelCtrl));
router.delete('/userinfo-pro/:userId',    channelCtrl.removeProUser.bind(channelCtrl));

// Channel packages
router.get('/packages',          channelCtrl.getPackages.bind(channelCtrl));
router.post('/packages',         channelCtrl.upsertPackage.bind(channelCtrl));
router.delete('/packages/:id',   channelCtrl.deletePackage.bind(channelCtrl));

// Manual channel management
router.get('/channels/admin-list',          channelCtrl.getChannelAdminList.bind(channelCtrl));
router.post('/channels/manual-credits',     channelCtrl.manualCreditPatch.bind(channelCtrl));
router.post('/channels/manual-package',     channelCtrl.manualPackageBook.bind(channelCtrl));

// Refill routes
router.get('/refills',         channelCtrl.getRefills.bind(channelCtrl));
router.post('/refills',        channelCtrl.upsertRefill.bind(channelCtrl));
router.delete('/refills/:id',  channelCtrl.deleteRefill.bind(channelCtrl));

// Sellauth webhook for package purchases (no auth required - Sellauth signs it)
router.post('/webhooks/sellauth-packages', async (req, res) => {
  res.sendStatus(200); // respond first
  try {
    const packageService = require("../services/packageService");
    // Detect if this is a refill or a full package
    const body = req.body;
    const invoiceId = String(body?.data?.id || body?.id || "");
    const customFields = body?.data?.custom_fields || body?.custom_fields || [];
    const isRefill = customFields.some(f => f.name === "type" && f.value === "refill");
    let result;
    if (isRefill) {
      const cfChannel = customFields.find(f => f.name === "channel_id");
      const channelId = cfChannel?.value;
      // Get credits from pending purchase
      const { data: purch } = await require("../config/supabase").from("channel_purchases")
        .select("credits_added").eq("sellauth_invoice_id", invoiceId).maybeSingle().catch(() => ({ data: null }));
      const credits = purch?.credits_added || 0;
      result = await packageService.handleRefillWebhook(invoiceId, channelId, credits);
    } else {
      result = await packageService.handleWebhook(body);
    }
    if (result.handled && result.adminId) {
      // Notify admin via Telegram
      const supabase = require("../config/supabase");
      const axios    = require("axios");
      const { data: settings } = await supabase.from("settings").select("smalltalk_bot_token").single().catch(() => ({ data: null }));
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

module.exports = router;
