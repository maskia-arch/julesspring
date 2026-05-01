const express        = require('express');
const router         = express.Router();
const messageProcessor = require('../services/messageProcessor');
const visitorService   = require('../services/visitorService');
const sellauthService  = require('../services/sellauthService');
const supabase         = require('../config/supabase');
const logger           = require('../utils/logger');

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Chat-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

router.post('/beacon', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const ip = visitorService._getClientIp(req);
      const { chatId } = await visitorService.getOrCreateVisitor(ip, req.headers['user-agent'], req.body.fingerprint);
      const banCheck = await visitorService.isBanned(ip, chatId);
      if (banCheck.banned) return;

      const pageTitle = req.body.pageTitle || getSmartTitle(req.body.pageUrl, req.body.pageTitle);
      const notifService = require('../services/notificationService');
      await notifService._push({
        title: '👁 ' + (pageTitle || 'Seite'),
        body: 'Besucher auf deiner Website',
        icon: '/icon-192.png',
        tag: 'beacon-' + chatId.substring(0, 8),
        url: '/admin',
        silent: true
      });
    } catch (_) {}
  });
});

function getSmartTitle(url, titleFromBrowser) {
  if (titleFromBrowser) return titleFromBrowser.split(/\s[–|-]\s/)[0].trim().substring(0, 50);
  if (!url) return 'Seite';
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\/product\/([^/?#]+)/);
    if (m) return m[1].replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    if (path === '/' || path === '') return 'Startseite';
    return path.replace(/^\//, '').replace(/[-\/]/g, ' ');
  } catch { return 'Seite'; }
}

router.post('/init', async (req, res) => {
  try {
    const ip = visitorService._getClientIp(req);
    const { chatId, isNew } = await visitorService.getOrCreateVisitor(ip, req.headers['user-agent'], req.body.fingerprint);
    const banCheck = await visitorService.isBanned(ip, chatId);
    if (banCheck.banned) return res.json({ banned: true, message: 'Zugang gesperrt.' });

    const smartTitle = req.body.pageTitle || 'Website';
    await visitorService.logActivity(chatId, `Besucht: ${smartTitle}`, req.body.pageUrl, smartTitle);
    await _upsertSession(chatId, smartTitle, supabase, isNew);

    let welcome = 'Hallo! 👋 Wie kann ich dir helfen?';
    const { data: s } = await supabase.from('settings').select('welcome_message').single();
    if (s?.welcome_message) welcome = s.welcome_message;

    res.json({ chatId, isNew, welcome, banned: false });
  } catch (err) { res.status(500).json({ error: 'Fail' }); }
});

router.post('/message', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.body.chatId;
    const text = (req.body.message || '').trim();
    const ip = visitorService._getClientIp(req);

    if (!chatId || !text) return res.status(400).json({ error: 'Missing data' });
    const banCheck = await visitorService.isBanned(ip, chatId);
    if (banCheck.banned) return res.json({ banned: true, reply: 'Gesperrt.' });

    const reply = await messageProcessor.handle({
      platform: 'web_widget',
      chatId,
      text,
      metadata: { ip, user_agent: req.headers['user-agent'] }
    });

    res.json({ reply: reply || 'Bitte erneut senden.', type: 'ai' });
  } catch (err) { res.status(500).json({ error: 'Fail' }); }
});

router.get('/history', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.query.chatId;
    const { data: msgs } = await supabase.from('messages').select('role, content, created_at')
      .eq('chat_id', chatId).neq('role', 'system').order('created_at', { ascending: true });
    res.json({ messages: msgs || [] });
  } catch (err) { res.json({ messages: [] }); }
});

router.post('/activity', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const chatId = req.headers['x-chat-id'] || req.body.chatId;
      await visitorService.logActivity(chatId, `Besucht: ${req.body.pageTitle}`, req.body.pageUrl, req.body.pageTitle);
    } catch (_) {}
  });
});

router.get('/faq', async (req, res) => {
  const faqs = ['Welche eSIMs habt ihr?', 'Wie aktiviere ich?', 'Bestellstatus?', 'Unlimited vs Travel?', 'Gültigkeit?'];
  res.json({ faqs });
});

router.get('/config', async (req, res) => {
  try {
    const { data: s } = await supabase.from('settings').select('welcome_message, widget_powered_by').single();
    res.json({
      enabled: true,
      botName: 'ValueShop25 Support',
      welcomeMessage: s?.welcome_message || 'Hallo!',
      poweredBy: s?.widget_powered_by || 'ValueShop25 AI'
    });
  } catch { res.json({ enabled: true }); }
});

async function _upsertSession(chatId, pageTitle, supabase, isNew) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: active } = await supabase.from('visitor_sessions').select('id, page_count')
      .eq('chat_id', chatId).eq('is_active', true).gte('last_seen', cutoff).maybeSingle();

    if (active) {
      await supabase.from('visitor_sessions').update({ last_seen: new Date(), page_count: (active.page_count || 0) + 1, last_page: pageTitle }).eq('id', active.id);
      return active.id;
    }
    const { data: created } = await supabase.from('visitor_sessions').insert([{
      chat_id: chatId, started_at: new Date(), last_seen: new Date(), entry_page: pageTitle, last_page: pageTitle, is_active: true
    }]).select('id').single();
    return created?.id;
  } catch { return null; }
}

module.exports = router;
