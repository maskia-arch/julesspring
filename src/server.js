const express = require('express');
const cors = require('cors');
const path = require('path');
const { port } = require('./config/env');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const adminRoutes = require('./routes/adminRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const widgetRoutes = require('./routes/widgetRoutes');
const smalltalkBotRoutes = require('./routes/smalltalkBotRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);          // → Support AI (/telegram)
app.use('/api/webhooks', smalltalkBotRoutes);     // → AdminHelper (/smalltalk)
app.use('/api/widget', widgetRoutes);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/', (req, res) => res.redirect('/admin'));

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info(`Server läuft auf Port ${port}`);
  setTimeout(() => {
    autoRegisterWebhooks();           // BEIDE Bots registrieren
    setAutoCommands();                // BEIDE Bots Commands setzen
    startKeepAlive();
    
    try {
      const couponService = require('./services/couponService');
      couponService.startDailyScheduler();
    } catch(e) { logger.warn(e.message); }

    try {
      const { tgAdminHelper, tgApi } = require('./services/adminHelper/tgAdminHelper');
      const supabase = require('./config/supabase');
      
      // AdminHelper: Scheduled messages alle 60s
      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) {
            await tgAdminHelper.fireScheduled(s.smalltalk_bot_token);
          }
        } catch (_) {}
      }, 60000);

      // AdminHelper: AutoClean alle 30 min
      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) {
            await tgAdminHelper.runAutoClean(s.smalltalk_bot_token);
          }
        } catch (_) {}
      }, 30 * 60 * 1000);

      // AdminHelper: AutoDelete von markierten Messages
      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) {
            const now = new Date().toISOString();
            const { data: msgs } = await supabase.from('bot_messages').select('*').lte('delete_after', now);
            if (msgs && msgs.length > 0) {
              const tg = tgApi(s.smalltalk_bot_token);
              for (const m of msgs) {
                await tg.call('deleteMessage', { chat_id: m.channel_id, message_id: m.message_id }).catch(() => {});
                try { await supabase.from('bot_messages').delete().eq('id', m.id); } catch(_){}
              }
            }
          }
        } catch (_) {}
      }, 60000);

      logger.info('[AdminHelper] Scheduled messages, AutoClean & MsgAutoDelete: aktiv');
    } catch(e) { logger.warn(e.message); }

    try {
      const supabase = require('./config/supabase');
      const runSweep = async () => {
        try {
          const { data, error } = await supabase.rpc('expire_channel_packages');
          if (error) throw error;
          if (data && data > 0) logger.info(`[PackageExpiry] ${data} channel(s) had packages expired`);
        } catch (e) { logger.warn(e.message); }
      };
      setTimeout(runSweep, 30000);
      setInterval(runSweep, 60 * 60 * 1000);
      logger.info('[Server] Package expiry sweeper: aktiv');
    } catch(e) { logger.warn(e.message); }
  }, 5000);
});

/**
 * Registriert beide Bot-Webhooks bei Telegram.
 * - Support AI Bot   → TELEGRAM_BOT_TOKEN  → /api/webhooks/telegram
 * - AdminHelper Bot  → smalltalk_bot_token → /api/webhooks/smalltalk
 */
async function autoRegisterWebhooks() {
  const supabase = require('./config/supabase');
  const axios = require('axios');

  let appUrl = process.env.APP_URL || '';
  if (!appUrl) {
    try {
      const { data: settings } = await supabase.from('settings').select('webhook_url').single();
      appUrl = settings?.webhook_url || '';
    } catch (e) {}
  }
  if (!appUrl) {
    logger.warn('[Webhook] APP_URL nicht gesetzt - Webhooks nicht auto-registriert.');
    return;
  }
  appUrl = appUrl.replace(/\/$/, '');

  // ─── Support AI Bot Webhook ────────────────────────────────────
  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (supportToken) {
    try {
      const supportWebhook = `${appUrl}/api/webhooks/telegram`;
      const r = await axios.post(
        `https://api.telegram.org/bot${supportToken}/setWebhook`,
        {
          url: supportWebhook,
          allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post', 'chat_join_request'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      if (r.data?.ok) {
        logger.info(`[Webhook/Support] ✅ Registriert: ${supportWebhook}`);
        try {
          await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() });
        } catch (_) {}
      } else {
        logger.warn(`[Webhook/Support] Fehler: ${r.data?.description}`);
      }
    } catch (e) {
      logger.warn(`[Webhook/Support] ${e.response?.data?.description || e.message}`);
    }
  } else {
    logger.warn('[Webhook/Support] TELEGRAM_BOT_TOKEN nicht gesetzt.');
  }

  // ─── AdminHelper Bot Webhook ────────────────────────────────────
  let adminToken = null;
  try {
    const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
    adminToken = s?.smalltalk_bot_token;
  } catch (e) {}

  if (adminToken) {
    try {
      const adminWebhook = `${appUrl}/api/webhooks/smalltalk`;
      const r = await axios.post(
        `https://api.telegram.org/bot${adminToken}/setWebhook`,
        {
          url: adminWebhook,
          allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      if (r.data?.ok) {
        logger.info(`[Webhook/AdminHelper] ✅ Registriert: ${adminWebhook}`);
      } else {
        logger.warn(`[Webhook/AdminHelper] Fehler: ${r.data?.description}`);
      }
    } catch (e) {
      logger.warn(`[Webhook/AdminHelper] ${e.response?.data?.description || e.message}`);
    }
  } else {
    logger.info('[Webhook/AdminHelper] smalltalk_bot_token nicht gesetzt - übersprungen.');
  }
}

/**
 * Setzt die /-Befehle für BEIDE Bots (jeweils unterschiedlich!).
 * - Support AI:   /start, /help, /order
 * - AdminHelper:  /menu, /settings, /dashboard, /check, /scamliste, /feedbacks, /safeliste, /userinfo, /ai
 */
async function setAutoCommands() {
  const axios = require('axios');
  const supabase = require('./config/supabase');

  // ─── Support AI Bot Commands ──────────────────────────────────
  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (supportToken) {
    try {
      await axios.post(`https://api.telegram.org/bot${supportToken}/setMyCommands`, {
        commands: [
          { command: 'start', description: 'Begr\u00FC\u00DFung & Hilfe' },
          { command: 'help',  description: 'Was kann ich tun?' },
          { command: 'order', description: 'Bestellstatus pr\u00FCfen (/order INVOICE_ID)' }
        ]
      }, { timeout: 8000 });
      logger.info('[Telegram/Support] Autocomplete-Befehle registriert');
    } catch (err) {
      logger.warn(`[Telegram/Support] setMyCommands: ${err.response?.data?.description || err.message}`);
    }
  }

  // ─── AdminHelper Bot Commands ──────────────────────────────────
  let adminToken = null;
  try {
    const { data } = await supabase.from('settings').select('smalltalk_bot_token').single();
    adminToken = data?.smalltalk_bot_token;
  } catch (e) {}

  if (adminToken) {
    try {
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, {
        commands: [
          { command: 'menu',      description: 'Hauptmen\u00FC \u00F6ffnen' },
          { command: 'settings',  description: 'Channel-Einstellungen' },
          { command: 'dashboard', description: 'Channel-\u00DCbersicht' },
          { command: 'check',     description: 'Feedback eines Users pr\u00FCfen (/check @user)' },
          { command: 'scamliste', description: 'Scamliste anzeigen oder Scammer melden' },
          { command: 'feedbacks', description: 'Ranking der Top-Verk\u00E4ufer' },
          { command: 'safeliste', description: 'Verifizierte Mitglieder' },
          { command: 'userinfo',  description: 'User analysieren (5x/Tag kostenlos)' },
          { command: 'ai',        description: 'KI-Assistent befragen (/ai Frage)' },
          { command: 'buy',       description: 'Credit-Paket kaufen' }
        ]
      }, { timeout: 8000 });
      logger.info('[Telegram/AdminHelper] Autocomplete-Befehle registriert');
    } catch (err) {
      logger.warn(`[Telegram/AdminHelper] setMyCommands: ${err.response?.data?.description || err.message}`);
    }
  }
}

function startKeepAlive() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return;

  const http = require('http');
  const https = require('https');

  function ping() {
    try {
      const url = new URL(`${appUrl}/health`);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url.href, { timeout: 8000 }, (res) => {
        logger.info(`[KeepAlive] ${res.statusCode}`);
      });
      req.on('error', (e) => logger.warn(`[KeepAlive] ${e.message}`));
      req.end();
    } catch (e) {
      logger.warn(`[KeepAlive] ${e.message}`);
    }
  }

  setTimeout(() => { ping(); setInterval(ping, 14 * 60 * 1000); }, 30000);
  logger.info(`[KeepAlive] Aktiv → ${appUrl}/health`);
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} → Server wird beendet`);
  server.close(() => { logger.info('Server beendet'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('Unhandled Rejection:', r));
process.on('uncaughtException', (e) => { logger.error('Uncaught Exception:', e); shutdown('uncaughtException'); });

module.exports = app;
