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
router.delete('/knowledge/entries/:id', ctrl.deleteKnowledgeEntry);

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

module.exports = router;
