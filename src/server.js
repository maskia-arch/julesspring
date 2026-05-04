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
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', smalltalkBotRoutes);
app.use('/api/widget', widgetRoutes);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/', (req, res) => res.redirect('/admin'));

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info(`Server läuft auf Port ${port}`);
  setTimeout(() => {
    autoRegisterWebhooks();
    setAutoCommands();
    startKeepAlive();

    // ─── i18n: DB-Cache laden + fehlende Übersetzungen im Hintergrund erzeugen ───
    try {
      const i18n = require('./services/i18n');
      i18n.preloadTranslations({ eager: false }).catch(e => logger.warn(`[i18n] preload error: ${e.message}`));
    } catch(e) { logger.warn(`[i18n] preload init failed: ${e.message}`); }

    try {
      const couponService = require('./services/couponService');
      couponService.startDailyScheduler();
    } catch(e) { logger.warn(e.message); }

    try {
      const { tgAdminHelper, tgApi } = require('./services/adminHelper/tgAdminHelper');
      const supabase = require('./config/supabase');

      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) await tgAdminHelper.fireScheduled(s.smalltalk_bot_token);
        } catch (_) {}
      }, 60000);

      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) await tgAdminHelper.runAutoClean(s.smalltalk_bot_token);
        } catch (_) {}
      }, 30 * 60 * 1000);

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

      // Stündlicher Cleanup des channel_message_log (>48h) damit die Tabelle
      // nicht ins Unermessliche wächst. Bei aktiven Gruppen kommen schnell
      // hunderte Einträge pro Tag rein.
      try {
        const safelistService = require('./services/adminHelper/safelistService');
        const messageLogPruner = async () => {
          try { await safelistService.pruneOldMessageLog(); }
          catch (e) { logger.warn(`[MessageLogPrune] ${e.message}`); }
        };
        // Erste Ausführung 2 Min nach Start, dann stündlich
        setTimeout(messageLogPruner, 2 * 60 * 1000);
        setInterval(messageLogPruner, 60 * 60 * 1000);
      } catch (e) { logger.warn(`[MessageLogPrune init] ${e.message}`); }

      logger.info('[Server] Scheduled messages, AutoClean, MsgAutoDelete & MessageLogPrune: aktiv');
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
  if (!appUrl) { logger.warn('[Webhook] APP_URL nicht gesetzt.'); return; }
  appUrl = appUrl.replace(/\/$/, '');

  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (supportToken) {
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${supportToken}/setWebhook`,
        { url: `${appUrl}/api/webhooks/telegram`, allowed_updates: ['message','callback_query','my_chat_member','channel_post','chat_join_request'], drop_pending_updates: false },
        { timeout: 10000 }
      );
      if (r.data?.ok) {
        logger.info(`[Webhook/Support] ✅ Registriert: ${appUrl}/api/webhooks/telegram`);
        try { await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() }); } catch(_){}
      } else logger.warn(`[Webhook/Support] Fehler: ${r.data?.description}`);
    } catch (e) { logger.warn(`[Webhook/Support] ${e.response?.data?.description || e.message}`); }
  } else logger.warn('[Webhook/Support] TELEGRAM_BOT_TOKEN nicht gesetzt.');

  let adminToken = null;
  try {
    const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
    adminToken = s?.smalltalk_bot_token;
  } catch (e) {}

  if (adminToken) {
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${adminToken}/setWebhook`,
        { url: `${appUrl}/api/webhooks/smalltalk`, allowed_updates: ['message','callback_query','my_chat_member','channel_post'], drop_pending_updates: false },
        { timeout: 10000 }
      );
      if (r.data?.ok) logger.info(`[Webhook/AdminHelper] ✅ Registriert: ${appUrl}/api/webhooks/smalltalk`);
      else logger.warn(`[Webhook/AdminHelper] Fehler: ${r.data?.description}`);
    } catch (e) { logger.warn(`[Webhook/AdminHelper] ${e.response?.data?.description || e.message}`); }
  } else logger.info('[Webhook/AdminHelper] smalltalk_bot_token nicht gesetzt — übersprungen.');
}

async function setAutoCommands() {
  const axios = require('axios');
  const supabase = require('./config/supabase');

  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (supportToken) {
    try {
      await axios.post(`https://api.telegram.org/bot${supportToken}/setMyCommands`, {
        commands: [
          { command: 'start', description: 'Begrüßung & Hilfe' },
          { command: 'help',  description: 'Was kann ich tun?' },
          { command: 'order', description: 'Bestellstatus prüfen (/order INVOICE_ID)' }
        ]
      }, { timeout: 8000 });
      logger.info('[Telegram/Support] Autocomplete-Befehle registriert');
    } catch (err) { logger.warn(`[Telegram/Support] setMyCommands: ${err.response?.data?.description || err.message}`); }
  }

  let adminToken = null;
  try {
    const { data } = await supabase.from('settings').select('smalltalk_bot_token').single();
    adminToken = data?.smalltalk_bot_token;
  } catch (e) {}

  if (adminToken) {
    const privateCommands = [
      { command: 'menu',      description: 'Hauptmenü öffnen' },
      { command: 'settings',  description: 'Channel-Einstellungen' },
      { command: 'dashboard', description: 'Channel-Übersicht' },
      { command: 'help',      description: 'Alle Admin-Befehle anzeigen' },
      { command: 'check',     description: 'Feedback eines Users prüfen (/check @user)' },
      { command: 'scamliste', description: 'Scamliste anzeigen oder Scammer melden' },
      { command: 'safeliste', description: 'Verifizierte Mitglieder' },
      { command: 'userinfo',  description: 'User analysieren (5x/Tag kostenlos)' },
      { command: 'ai',        description: 'KI-Assistent befragen (/ai Frage)' },
      { command: 'buy',       description: 'Credit-Paket für eigenen Channel kaufen' },
      { command: 'refill',    description: 'Credits nachladen' }
    ];
    // Group-Commands: nur was jeder User in der Gruppe sehen darf.
    // Admin-Tools (/ban, /unban, /mute, /unmute) sind absichtlich NICHT
    // in der Slashcommand-Liste — sie funktionieren weiterhin per Tippen,
    // tauchen aber nicht als Vorschlag auf, damit normale User sie nicht
    // verwirrt anwählen.
    const groupCommands = [
      { command: 'donate',    description: '❤️ Credit-Paket für diese Gruppe spendieren' },
      { command: 'help',      description: 'Übersicht der Befehle' },
      { command: 'check',     description: 'Feedback eines Users prüfen (/check @user)' },
      { command: 'safeliste', description: 'Verifizierte Mitglieder' },
      { command: 'scamliste', description: 'Scamliste ansehen' },
      { command: 'userinfo',  description: 'User analysieren (5x/Tag kostenlos)' },
      { command: 'ai',        description: 'KI-Assistent befragen (/ai Frage)' }
    ];
    try {
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: privateCommands, scope: { type: 'all_private_chats' } }, { timeout: 8000 });
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: groupCommands, scope: { type: 'all_group_chats' } }, { timeout: 8000 });
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: groupCommands, scope: { type: 'default' } }, { timeout: 8000 });
      logger.info('[Telegram/AdminHelper] Autocomplete-Befehle registriert (private + group scope)');
    } catch (err) { logger.warn(`[Telegram/AdminHelper] setMyCommands: ${err.response?.data?.description || err.message}`); }
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
    } catch (e) { logger.warn(`[KeepAlive] ${e.message}`); }
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
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('Unhandled Rejection:', r));
process.on('uncaughtException',  (e) => { logger.error('Uncaught Exception:', e); shutdown('uncaughtException'); });

module.exports = app;
