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

// ── 0. Beacon: Passives Tracking (wird bei Seitenaufruf automatisch aufgerufen)
router.post('/beacon', async (req, res) => {
  res.sendStatus(200); // Sofort antworten, kein Warten
  setImmediate(async () => {
    try {
      const ip          = visitorService._getClientIp(req);
      const userAgent   = req.headers['user-agent'] || '';
      const fingerprint = req.body.fingerprint || null;
      const pageUrl     = req.body.pageUrl     || '';
      const pageTitle   = req.body.pageTitle   || getSmartTitle(pageUrl, req.body.pageTitle);
      const existingId  = req.body.chatId      || null;

      // Ban-Check
      const { chatId: tempId } = await visitorService.getOrCreateVisitor(ip, userAgent, fingerprint);
      const banCheck = await visitorService.isBanned(ip, tempId);
      if (banCheck.banned) return;

      const { chatId } = await visitorService.getOrCreateVisitor(ip, userAgent, fingerprint);

      // Nur lautlose Push, kein DB-Log (keep it light)
      const notifService = require('../services/notificationService');
      const smart = pageTitle || 'Seite';
      try {
        await notifService._push({
          title: '👁 ' + smart,
          body:  'Besucher auf deiner Website',
          icon:  '/icon-192.png',
          tag:   'beacon-' + chatId.substring(0, 8),
          url:   '/admin',
          silent: true
        });
      } catch (_) {}
    } catch (_) {}
  });
});

function getSmartTitle(url, titleFromBrowser) {
  if (titleFromBrowser) return titleFromBrowser.split(/\s[–|-]\s/)[0].trim().substring(0, 50);
  if (!url) return 'Seite';
  try {
    var path = new URL(url).pathname;
    var m = path.match(/\/product\/([^/?#]+)/);
    if (m) return m[1].replace(/-/g,' ').replace(/\w/g,function(c){return c.toUpperCase();});
    if (path === '/' || path === '') return 'Startseite';
    return path.replace(/^\//, '').replace(/[-\/]/g, ' ');
  } catch { return 'Seite'; }
}

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

    // Seitenbesuch loggen + lautlose Push-Benachrichtigung
    const smartTitle = pageTitle || (pageUrl ? pageUrl : 'Website');
    const activity   = `Besucht: ${smartTitle}`;
    if (smartTitle) {
      await visitorService.logActivity(chatId, activity, pageUrl, pageTitle);
    }

    // Session anlegen / aktualisieren
    const sessionId = await _upsertSession(chatId, smartTitle, supabase, isNew);

    // Silent Push – maximal 1x alle 5 Minuten pro Besucher (dedup via session.push_sent)
    void (async () => {
      try {
        let session = null;
        try {
          const { data: _s } = await supabase.from('visitor_sessions')
            .select('push_sent, started_at').eq('id', sessionId).single();
          session = _s;
        } catch (_) {}

        // Push nur wenn: neue Session ODER push_sent=false ODER Session > 5min alt ohne Push
        const needsPush = !session?.push_sent;
        if (!needsPush) return;

        try { await supabase.from('visitor_sessions').update({ push_sent: true }).eq('id', sessionId); } catch (_) {}

        const notifService = require('../services/notificationService');
        await notifService._push({
          title:  isNew ? `👁 Neuer Besucher` : `📍 ${smartTitle}`,
          body:   isNew ? `Besucht: ${smartTitle}` : `Bekannter Besucher auf: ${smartTitle}`,
          icon:   '/icon-192.png',
          tag:    `visit-${chatId.substring(0, 10)}`,
          url:    '/admin',
          silent: true,
          data:   { sessionId, chatId, url: '/admin' }
        });
      } catch (_) {}
    })();

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

    // Session als aktiv mit Chat markieren
    void (async () => { try { await supabase.from('visitor_sessions').update({ had_chat: true, last_seen: new Date() }).eq('chat_id', chatId).eq('is_active', true); } catch (_) {} })();

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
      try { await supabase.from('chats').upsert({ id: chatId, platform: 'web_widget', is_manual_mode: true, updated_at: new Date() }); } catch (_) {}

      // Admin Push senden
      const notifService = require('../services/notificationService');
      try { await notifService.sendNewMessageNotification({
        chatId, text: '🙋 Kunde möchte echten Mitarbeiter sprechen: ' + text.substring(0, 60),
        firstName: 'Widget-Besucher', platform: 'web_widget', isFirstMessage: false
      }); } catch (_) {}

      return res.json({
        reply: 'Kein Problem! Ein Mitarbeiter wurde benachrichtigt und meldet sich so schnell wie möglich bei dir. Die KI ist jetzt deaktiviert für diesen Chat.',
        handover: true
      });
    }

    // Bestellstatus-Abfrage direkt im Widget
    // Flexible Invoice-ID Erkennung (explizit + natürliche Sprache)
    const UNIQUE_ID_RE = /([a-f0-9]{5,}-[0-9]{6,})/i;
    const ID_PATTERN   = '([a-f0-9]{5,}-[0-9]{6,}|[0-9]{6,})';
    const orderMatch   = text.match(new RegExp('^\/order\s+' + ID_PATTERN, 'i')) ||
                         text.match(new RegExp('(?:bestellung|invoice|order|rechnung|nummer)[:\s#.]*' + ID_PATTERN, 'i')) ||
                         text.match(new RegExp('(?:meine|mein)\s+(?:code|id|nummer)\s*[:\s]*' + ID_PATTERN, 'i')) ||
                         (UNIQUE_ID_RE.test(text) ? [null, text.match(UNIQUE_ID_RE)[1]] : null);

    // Wenn Bestellkontext aber keine ID → nach ID fragen
    const hasOrderContext = /(?:bestellung|bestell|order|invoice|rechnung|meine esim|wann kommt|schon da|status|lieferung|wo ist)/i.test(text);
    if (hasOrderContext && !orderMatch) {
      return res.json({
        reply: 'Um deinen Bestellstatus abzufragen, benötige ich deine Invoice-ID aus der Bestätigungs-E-Mail von Sellauth.\n\nSende einfach: /order DEINE-INVOICE-ID\noder schreib direkt deine ID in den Chat (Format: xxxxxxx-0000000000000)',
        type: 'order_help'
      });
    }

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
        const apiMsg = err.response?.data?.message || err.message || '';
        console.error('[Widget/Order] Fehler:', status, apiMsg);
        const msg = status === 404
          ? `Bestellung ${invoiceId} nicht gefunden.\nBitte prüfe die Invoice-ID aus deiner Bestätigungs-E-Mail.`
          : `Bestellabfrage momentan nicht verfügbar (${status || 'Netzwerk'}).\nBitte versuche es später oder wende dich an den Support.`;
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

    res.json({ reply: reply || 'Bitte sende deine Nachricht erneut.', type: 'ai' });
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
      try { await notifService.sendNewMessageNotification({
        chatId,
        text: '🙋 Widget-Besucher möchte mit Mitarbeiter sprechen',
        firstName: 'Widget-Besucher', platform: 'web_widget', isFirstMessage: false
      }); } catch (_) {}

      try { await supabase.from('messages').insert([{
        chat_id: chatId, role: 'assistant',
        content: 'Ein Mitarbeiter wurde benachrichtigt und meldet sich bald. Die KI ist jetzt deaktiviert.'
      }]); } catch (_) {}
    }

    res.json({ success: true, manualMode: request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. Config ─────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const { data: s } = await supabase.from('settings').select('welcome_message, widget_powered_by').single();
    res.json({
      enabled:        true,
      botName:        'ValueShop25 Support',
      welcomeMessage: s?.welcome_message || 'Hallo! 👋 Wie kann ich dir helfen?',
      poweredBy:      s?.widget_powered_by !== undefined ? s.widget_powered_by : 'Powered by ValueShop25 AI',
      version:        '1.3.4'
    });
  } catch {
    res.json({ enabled: true, botName: 'Support', welcomeMessage: 'Hallo! 👋' });
  }
});

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

async function _upsertSession(chatId, pageTitle, supabase, isNew) {
  try {
    // Aktive Session suchen (letzte 30 Minuten)
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: active } = await supabase
      .from('visitor_sessions')
      .select('id, page_count')
      .eq('chat_id', chatId)
      .eq('is_active', true)
      .gte('last_seen', cutoff)
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (active) {
      // Session aktualisieren
      await supabase.from('visitor_sessions').update({
        last_seen:  new Date(),
        page_count: (active.page_count || 0) + 1,
        last_page:  pageTitle
      }).eq('id', active.id);
      return active.id;
    }

    // Alte Sessions schließen
    await supabase.from('visitor_sessions').update({
      is_active: false,
      ended_at:  new Date()
    }).eq('chat_id', chatId).eq('is_active', true);

    // Neue Session
    const { data: created } = await supabase.from('visitor_sessions').insert([{
      chat_id:    chatId,
      started_at: new Date(),
      last_seen:  new Date(),
      entry_page: pageTitle,
      last_page:  pageTitle,
      is_active:  true,
      push_sent:  false,
      had_chat:   false
    }]).select('id').single();

    return created?.id || null;
  } catch { return null; }
}

// ── KI-Status Endpoint (für Widget-Bubble Statusanzeige) ─────────────────────
router.get('/status', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.query.chatId;
    if (!chatId) return res.json({ status: 'online' });

    const { data: chat } = await supabase.from('chats')
      .select('is_manual_mode, auto_muted')
      .eq('id', chatId).maybeSingle();

    if (chat?.auto_muted) return res.json({ status: 'offline' });
    if (chat?.is_manual_mode) return res.json({ status: 'manual' });
    return res.json({ status: 'online' });
  } catch { res.json({ status: 'online' }); }
});

// ── Session-Details (für Dashboard) ──────────────────────────────────────────
router.get('/sessions', async (req, res) => {
  try {
    const { data } = await supabase
      .from('visitor_sessions')
      .select('id, chat_id, started_at, last_seen, page_count, entry_page, last_page, is_active, had_chat, duration_sec')
      .order('started_at', { ascending: false })
      .limit(100);
    res.json(data || []);
  } catch { res.json([]); }
});

module.exports = router;
