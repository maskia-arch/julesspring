const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/auth');

// --- ÖFFENTLICHE ROUTEN ---
// Diese Route muss VOR router.use(auth) stehen, damit man sich einloggen kann!
router.post('/login', adminController.login);

// --- GESCHÜTZTE ROUTEN ---
// Ab hier benötigen alle folgenden Routen ein gültiges JWT-Token
router.use(auth);

// Stats & Settings
router.get('/stats', adminController.getStats);
router.get('/settings', adminController.getSettings);
router.post('/settings', adminController.updateSettings);

// Chats
router.get('/chats', adminController.getChats);
router.patch('/chats/:chatId/status', adminController.updateChatStatus);
router.post('/manual-message', adminController.sendManualMessage);

// Learning Queue
router.get('/learning', adminController.getLearningQueue);
router.post('/learning/resolve', adminController.resolveLearning);

// Scraping & Knowledge
router.post('/scrape', adminController.startScraping);
router.post('/sync-sellauth', adminController.syncSellauth);

// Security / Blacklist
router.get('/blacklist', adminController.getBlacklist);
router.post('/blacklist', adminController.banUser);
router.delete('/blacklist/:id', adminController.removeBan);

// Push Notifications
router.post('/push-subscription', adminController.savePushSubscription);

module.exports = router;
