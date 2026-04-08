const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');

router.post('/message', async (req, res, next) => {
  try {
    const { userId, message, metadata } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const chatData = {
      body: {
        platform: 'web_widget',
        chatId: userId || 'anonymous',
        message: message,
        metadata: metadata || {}
      }
    };

    await chatController.handleIncomingMessage(chatData, res, next);
  } catch (error) {
    next(error);
  }
});

router.get('/config', (req, res) => {
  res.json({
    enabled: true,
    botName: 'KI Berater',
    welcomeMessage: 'Hallo! Wie kann ich dir heute helfen?'
  });
});

module.exports = router;
