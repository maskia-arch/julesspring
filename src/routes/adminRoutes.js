/**
 * AI AdminHelper - API-Routes
 * Endpoints fuer das Admin-Dashboard und Sellauth-Webhook fuer Channel-Pakete.
 */
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController');
const auth    = require('../middleware/auth');

// ─── Auth ───────────────────────────────────────────────────────────────────
router.post('/login', ctrl.login);

// ─── Sellauth-Webhook fuer Channel-Pakete (offen, ohne Auth) ───────────────
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
      const axios    = require("axios");
      const token = await require("../config/botToken").getToken();
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

// ─── Allgemeine Dashboard-Daten ────────────────────────────────────────────
router.get('/stats',         ctrl.getStats);
router.get('/settings',      ctrl.getSettings);
router.post('/settings',     ctrl.updateSettings);

// ─── AdminHelper Dashboard: Uebersicht / Einsichten / Verwaltung (v2.0.0) ──
const dash = require('../controllers/dashboardController');
router.get('/overview',                       dash.getOverview);

// Moderation
router.get('/moderation/pending',             dash.getPendingFeedback);
router.post('/moderation/feedback/:id/approve', dash.approvePendingFeedback);
router.post('/moderation/feedback/:id/reject',  dash.rejectPendingFeedback);
router.get('/moderation/scam',                dash.getScam);
router.get('/moderation/banned',              dash.getBanned);
router.get('/moderation/spam',                dash.getSpamViolations);
router.get('/moderation/reports',             dash.getAdminReports);
router.get('/moderation/blacklist-hits',      dash.getBlacklistHits);

// Engagement
router.get('/engagement/diss',                dash.getDissScores);
router.get('/engagement/activity',            dash.getActivityPoints);
router.get('/engagement/summaries',           dash.getSummaries);

// Geplante Nachrichten
router.get('/scheduled',                      dash.getScheduled);
router.post('/scheduled',                     dash.createScheduled);
router.delete('/scheduled/:id',               dash.deleteScheduled);

// Mitglieder
router.get('/members',                        dash.getMembers);

// ─── Push-Notifications fuer das Dashboard ────────────────────────────────
router.post('/push-subscription', ctrl.savePushSubscription);
router.get('/push/vapid-key',     ctrl.getVapidPublicKey);
router.post('/push/test',         ctrl.sendTestPush);

// ─── Smalltalk-Bot-Status ──────────────────────────────────────────────────
router.get('/smalltalk/status',   ctrl.testSmallTalkBot);
router.post('/smalltalk/connect', ctrl.testSmallTalkBot);

// ─── Channels: Verwaltung der Bot-Channels ────────────────────────────────
const channelCtrl = require('../controllers/channelController');
router.get('/channels',                  channelCtrl.getChannels.bind(channelCtrl));
router.put('/channels/:id/ai',           channelCtrl.toggleAI.bind(channelCtrl));
router.post('/channels/scan',            channelCtrl.scanChannels.bind(channelCtrl));
router.post('/channels/register',        channelCtrl.registerChannelById.bind(channelCtrl));
router.put('/channels/:id',              channelCtrl.updateChannel.bind(channelCtrl));
router.post('/channels/:id/reset-usage', channelCtrl.resetChannelUsage.bind(channelCtrl));
router.get('/channels/:id/kb',           channelCtrl.getChannelKB.bind(channelCtrl));
router.post('/channels/:id/kb',          channelCtrl.addChannelKBEntry.bind(channelCtrl));
router.delete('/channels/:id/kb/:entryId', channelCtrl.deleteChannelKBEntry.bind(channelCtrl));

router.delete('/channels/:id', async (req, res, next) => {
  try {
    const channelId = req.params.id;
    const supabase = require('../config/supabase');
    const tablesToClean = [
      'user_feedbacks', 'channel_safelist', 'scam_entries',
      'user_reputation', 'channel_blacklist', 'channel_members',
      'channel_knowledge', 'scheduled_messages', 'channel_purchases',
      'bot_messages', 'channel_chat_history'
    ];
    for (const table of tablesToClean) {
      await supabase.from(table).delete().eq('channel_id', channelId).then(r=>r, ()=>{});
    }
    next();
  } catch (e) { next(); }
}, channelCtrl.deleteChannel.bind(channelCtrl));

// ─── Channel-Gruppen (Shared Knowledge) ────────────────────────────────────
router.get('/channel-groups',         channelCtrl.getChannelGroups.bind(channelCtrl));
router.post('/channel-groups',        channelCtrl.createChannelGroup.bind(channelCtrl));
router.delete('/channel-groups/:id',  channelCtrl.deleteChannelGroup.bind(channelCtrl));

// ─── Scamlist (channel-uebergreifend) ─────────────────────────────────────
router.get('/scamlist',         channelCtrl.getScamlist.bind(channelCtrl));
router.post('/scamlist/remove', channelCtrl.removeFromScamlist.bind(channelCtrl));

// ─── Userinfo-Pro User (unlimitierte /userinfo-Calls) ─────────────────────
router.get('/userinfo-pro',            channelCtrl.getProUsers.bind(channelCtrl));
router.post('/userinfo-pro',           channelCtrl.addProUser.bind(channelCtrl));
router.delete('/userinfo-pro/:userId', channelCtrl.removeProUser.bind(channelCtrl));

// ─── Channel-Pakete + Refills (Sellauth-Integration fuer Channel-Credits) ─
router.get('/packages',        channelCtrl.getPackages.bind(channelCtrl));
router.post('/packages',       channelCtrl.upsertPackage.bind(channelCtrl));
router.delete('/packages/:id', channelCtrl.deletePackage.bind(channelCtrl));

router.get('/refills',        channelCtrl.getRefills.bind(channelCtrl));
router.post('/refills',       channelCtrl.upsertRefill.bind(channelCtrl));
router.delete('/refills/:id', channelCtrl.deleteRefill.bind(channelCtrl));

router.get('/channels/admin-list',       channelCtrl.getChannelAdminList.bind(channelCtrl));
router.post('/channels/manual-credits',  channelCtrl.manualCreditPatch.bind(channelCtrl));
router.post('/channels/manual-package',  channelCtrl.manualPackageBook.bind(channelCtrl));

// ─── Sellauth Variants Lookup (fuer Paket-Setup) ──────────────────────────
router.get('/sellauth/product/:productId/variants', async (req, res) => {
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

module.exports = router;
