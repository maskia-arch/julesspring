/**
 * widgetRoutes.js v1.3
 * - /init        → Besucher registrieren, ChatID zurückgeben, Ban-Check
 * - /message     → Nachricht senden → KI Antwort
 * - /history     → Chatverlauf
 * - /activity    → Seitenbesuch loggen (unsichtbar)
 * - /faq         → Zufällige FAQ für Vorschläge
 * - /order/:id   → Bestellstatus
 */

const express        = require('express');
const router         = express.Router();
const messageProcessor = require('../services/messageProcessor');
const visitorService   = require('../services/visitorService');
const sellauthService  = require('../services/sellauthService');
const supabase         = require('../config/supabase');
const logger           = require('../utils/logger');

// CORS für Widget (andere Domain erlaubt)
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Chat-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 1. Init: Besucher registrieren, ChatID zurückgeben ────────────────────────
router.post('/init', async (req, res) => {
  try {
    const ip          = visitorService._getClientIp(req);
    const userAgent   = req.headers['user-agent'] || '';
    const fingerprint = req.body.fingerprint || null;
    const pageUrl     = req.body.pageUrl     || '';
    const pageTitle   = req.body.pageTitle   || '';

    // Ban-Check ZUERST
    const { chatId: tempId } = await visitorService.getOrCreateVisitor(ip, userAgent, fingerprint);
    const banCheck = await visitorService.isBanned(ip, tempId);
    if (banCheck.banned) {
      return res.json({ banned: true, message: 'Zugang gesperrt.' });
    }

    const { chatId, visitor, isNew } = await visitorService.getOrCreateVisitor(ip, userAgent, fingerprint);

    // Seitenbesuch loggen
    if (pageUrl || pageTitle) {
      const activity = pageTitle ? `Besucht: ${pageTitle}` : `Besucht: ${pageUrl}`;
      await visitorService.logActivity(chatId, activity, pageUrl, pageTitle);
    }

    // Welcome-Nachricht aus Settings
    let welcome = 'Hallo! 👋 Wie kann ich dir helfen?';
    try {
      const { data: s } = await supabase.from('settings').select('welcome_message').single();
      if (s?.welcome_message) welcome = s.welcome_message;
    } catch (_) {}

    res.json({
      chatId,
      isNew,
      welcome,
      banned: false
    });
  } catch (err) {
    logger.error('[Widget/init]', err.message);
    res.status(500).json({ error: 'Initialisierung fehlgeschlagen' });
  }
});

// ── 2. Nachricht senden ────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const chatId    = req.headers['x-chat-id'] || req.body.chatId;
    const text      = (req.body.message || '').trim();
    const ip        = visitorService._getClientIp(req);

    if (!chatId || !text) return res.status(400).json({ error: 'chatId und message erforderlich' });

    // Ban-Check
    const banCheck = await visitorService.isBanned(ip, chatId);
    if (banCheck.banned) return res.json({ banned: true, reply: 'Zugang gesperrt.' });

    // Human-Handover: Kunde möchte echten Mitarbeiter
    const HANDOVER_PATTERNS = [
      /ich\s+m[öo]chte?\s+(mit\s+)?(einen?\s+)?(echten?\s+)?mitarbeiter/i,
      /menschlichen?\s+(mitarbeiter|support|hilfe)/i,
      /kein\s+(bot|ki|chatbot|automatik)/i,
      /echte[rn]?\s+person/i,
      /menschliche[rn]?\s+(hilfe|beratung|support)/i,
      /mensch.*sprechen/i,
      /sprechen.*mensch/i,
      /human\s+(agent|support|help)/i,
      /speak\s+(to|with)\s+(a\s+)?(human|person|agent)/i,
      /connect\s+me\s+with/i,
    ];

    if (HANDOVER_PATTERNS.some(p => p.test(text))) {
      // KI abschalten für diesen Chat
      await supabase.from('chats').upsert({
        id: chatId, platform: 'web_widget', is_manual_mode: true, updated_at: new Date()
      }).catch(() => {});

      // Admin Push senden
      const notifService = require('../services/notificationService');
      await notifService.sendNewMessageNotification({
        chatId, text: '🙋 Kunde möchte echten Mitarbeiter sprechen: ' + text.substring(0, 60),
        firstName: 'Widget-Besucher', platform: 'web_widget', isFirstMessage: false
      }).catch(() => {});

      return res.json({
        reply: 'Kein Problem! Ein Mitarbeiter wurde benachrichtigt und meldet sich so schnell wie möglich bei dir. Die KI ist jetzt deaktiviert für diesen Chat.',
        handover: true
      });
    }

    // Bestellstatus-Abfrage direkt im Widget
    const UNIQUE_ID_RE = /[a-f0-9]{8,}-[0-9]{10,}/i;
    const ID_PATTERN   = '([a-f0-9]+-[0-9]+|[0-9]+)';
    const orderMatch   = text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i')) ||
                         text.match(new RegExp('^(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i')) ||
                         (text.match(UNIQUE_ID_RE) ? [null, text.match(UNIQUE_ID_RE)[0]] : null);

    if (orderMatch) {
      const invoiceId = orderMatch[1];
      try {
        const { data: s } = await supabase.from('settings')
          .select('sellauth_api_key, sellauth_shop_id, sellauth_shop_url').single();
        if (s?.sellauth_api_key && s?.sellauth_shop_id) {
          const invoice  = await sellauthService.getInvoice(s.sellauth_api_key, s.sellauth_shop_id, invoiceId);
          const response = sellauthService.formatInvoiceForCustomer(invoice, s.sellauth_shop_url);
          return res.json({ reply: response, type: 'order' });
        }
      } catch (err) {
        const status = err.response?.status;
        const msg = status === 404
          ? `Bestellung ${invoiceId} nicht gefunden. Bitte prüfe die Invoice-ID.`
          : 'Bestellabfrage momentan nicht verfügbar.';
        return res.json({ reply: msg, type: 'order_error' });
      }
    }

    // KI-Antwort via messageProcessor
    const reply = await messageProcessor.handle({
      platform: 'web_widget',
      chatId,
      text,
      metadata: {
        ip,
        user_agent: req.headers['user-agent'] || null
      }
    });

    res.json({ reply: reply || 'Ich verarbeite deine Anfrage...', type: 'ai' });
  } catch (err) {
    logger.error('[Widget/message]', err.message);
    res.status(500).json({ error: 'Nachricht konnte nicht verarbeitet werden' });
  }
});

// ── 3. Chatverlauf ─────────────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.query.chatId;
    if (!chatId) return res.json({ messages: [] });

    const { data: msgs } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('chat_id', chatId)
      .neq('role', 'system')           // System-Nachrichten (Aktivitäten) ausblenden
      .order('created_at', { ascending: true })
      .limit(50);

    res.json({ messages: msgs || [] });
  } catch (err) {
    res.json({ messages: [] });
  }
});

// ── 4. Aktivität tracken (Seitenbesuch etc.) ──────────────────────────────────
router.post('/activity', async (req, res) => {
  res.sendStatus(200); // Sofort antworten
  setImmediate(async () => {
    try {
      const chatId    = req.headers['x-chat-id'] || req.body.chatId;
      const pageUrl   = req.body.pageUrl   || '';
      const pageTitle = req.body.pageTitle || '';
      if (!chatId) return;
      const activity = pageTitle ? `Besucht: ${pageTitle}` : `Besucht: ${pageUrl}`;
      await visitorService.logActivity(chatId, activity, pageUrl, pageTitle);
    } catch (_) {}
  });
});

// ── 5. FAQ-Vorschläge ─────────────────────────────────────────────────────────
router.get('/faq', async (req, res) => {
  try {
    // Zufällige häufige Fragen aus knowledge_base (Titel als Frage formatiert)
    const { data: entries } = await supabase
      .from('knowledge_base')
      .select('title, content')
      .not('title', 'is', null)
      .in('source', ['sellauth_blog', 'manual_entry', 'sellauth_category'])
      .limit(20);

    if (!entries?.length) {
      // Fallback: Standard-FAQ
      return res.json({
        faqs: [
          'Welche eSIMs habt ihr für Deutschland?',
          'Wie aktiviere ich meine eSIM?',
          'Wie frage ich meinen Bestellstatus ab?',
          'Was ist der Unterschied zwischen Unlimited und Travel?',
          'Wie lange ist die eSIM gültig?'
        ]
      });
    }

    // Shuffle + 5 auswählen
    const shuffled = entries.sort(() => Math.random() - 0.5).slice(0, 5);
    const faqs = shuffled.map(e => {
      // Titel als Frage formulieren
      const t = e.title || '';
      if (t.startsWith('Kategorie:')) return `Was bietet ihr in "${t.replace('Kategorie:', '').trim()}" an?`;
      if (t.startsWith('Artikel:'))   return t.replace('Artikel:', '').trim();
      return `Erzähl mir mehr über: ${t}`;
    });

    res.json({ faqs });
  } catch (err) {
    res.json({ faqs: [] });
  }
});

// ── 6. Human Handover (manuell per Schalter) ────────────────────────────────
router.post('/handover', async (req, res) => {
  try {
    const chatId  = req.headers['x-chat-id'] || req.body.chatId;
    const request = req.body.request !== false; // true = handover anfordern, false = zurücksetzen
    if (!chatId) return res.status(400).json({ error: 'chatId fehlt' });

    await supabase.from('chats').upsert({
      id: chatId, platform: 'web_widget',
      is_manual_mode: request, updated_at: new Date()
    });

    if (request) {
      // Push an Admin
      const notifService = require('../services/notificationService');
      await notifService.sendNewMessageNotification({
        chatId,
        text: '🙋 Widget-Besucher möchte mit Mitarbeiter sprechen',
        firstName: 'Widget-Besucher', platform: 'web_widget', isFirstMessage: false
      }).catch(() => {});

      await supabase.from('messages').insert([{
        chat_id: chatId, role: 'assistant',
        content: 'Ein Mitarbeiter wurde benachrichtigt und meldet sich bald. Die KI ist jetzt deaktiviert.'
      }]).catch(() => {});
    }

    res.json({ success: true, manualMode: request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. Config ─────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const { data: s } = await supabase.from('settings').select('welcome_message').single();
    res.json({
      enabled:        true,
      botName:        'ValueShop25 Support',
      welcomeMessage: s?.welcome_message || 'Hallo! 👋 Wie kann ich dir helfen?',
      version:        '1.3'
    });
  } catch {
    res.json({ enabled: true, botName: 'Support', welcomeMessage: 'Hallo! 👋' });
  }
});

module.exports = router;
