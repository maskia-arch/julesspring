const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/auth');

// ─── ÖFFENTLICHE ROUTEN ───────────────────────────────────────────────────
router.post('/login', adminController.login);

// ─── GESCHÜTZTE ROUTEN (JWT erforderlich) ────────────────────────────────
router.use(auth);

// Dashboard & System
router.get('/stats', adminController.getStats);
router.get('/settings', adminController.getSettings);
router.post('/settings', adminController.updateSettings);

// Chat-Management
router.get('/chats', adminController.getChats);
router.get('/chats/:chatId/messages', adminController.getChatMessages);
router.patch('/chats/:chatId/status', adminController.updateChatStatus);
router.post('/manual-message', adminController.sendManualMessage);

// Learning Center
router.get('/learning', adminController.getLearningQueue);
router.post('/learning/resolve', adminController.resolveLearning);

// Wissensdatenbank
router.post('/knowledge/manual', adminController.addManualKnowledge);   // BUGFIX: war fehlend
router.post('/knowledge/discover', adminController.discoverLinks);
router.post('/scrape', adminController.startScraping);
router.post('/sync-sellauth', adminController.syncSellauth);

// Sicherheit & Blacklist
router.get('/blacklist', adminController.getBlacklist);
router.post('/blacklist', adminController.banUser);
router.delete('/blacklist/:id', adminController.removeBan);

// Push-Benachrichtigungen
router.post('/push-subscription', adminController.savePushSubscription);

module.exports = router;
