const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/stats', adminController.getStats);
router.get('/chats', adminController.getChats);
router.patch('/chats/:chatId/status', adminController.updateChatStatus);
router.get('/settings', adminController.getSettings);
router.post('/settings', adminController.updateSettings);

router.post('/manual-message', adminController.sendManualMessage);

module.exports = router;
