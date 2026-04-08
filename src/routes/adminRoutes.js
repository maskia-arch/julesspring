const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/auth');

// --- ÖFFENTLICHE ROUTEN ---
// Diese Route muss vor der auth-Middleware stehen
router.post('/login', adminController.login);

// --- GESCHÜTZTE ROUTEN ---
// Alle folgenden Routen prüfen das JWT-Token in der auth-Middleware
router.use(auth);

// Dashboard Statistiken & System-Einstellungen
router.get('/stats', adminController.getStats);
router.get('/settings', adminController.getSettings);
router.post('/settings', adminController.updateSettings);

// Chat-Management
router.get('/chats', adminController.getChats);
router.patch('/chats/:chatId/status', adminController.updateChatStatus);
router.post('/manual-message', adminController.sendManualMessage);
router.get('/chats/:chatId/messages', adminController.getChatMessages);

// Learning Center (KI-Wissenslücken)
router.get('/learning', adminController.getLearningQueue);
router.post('/learning/resolve', adminController.resolveLearning);

// Wissensdatenbank & Scraping
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
