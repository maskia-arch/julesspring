const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const supabase = require('../config/supabase');

router.post('/telegram', async (req, res, next) => {
  try {
    const { message } = req.body;

    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatData = {
      body: {
        platform: 'telegram',
        chatId: message.chat.id.toString(),
        message: message.text,
        metadata: {
          username: message.from.username,
          first_name: message.from.first_name
        }
      }
    };

    await chatController.handleIncomingMessage(chatData, res, next);
  } catch (error) {
    next(error);
  }
});

router.post('/sellauth', async (req, res, next) => {
  try {
    const event = req.body;
    
    await supabase.from('integration_logs').insert([{
      source: 'sellauth',
      event_type: event.type,
      payload: event,
      created_at: new Date()
    }]);

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
