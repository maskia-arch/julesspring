const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { port } = require('./config/env');
const logger  = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const adminRoutes        = require('./routes/adminRoutes');
const webhookRoutes      = require('./routes/webhookRoutes');
const widgetRoutes       = require('./routes/widgetRoutes');
const smalltalkBotRoutes = require('./routes/smalltalkBotRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/admin',    adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', smalltalkBotRoutes); // Smalltalk Bot: POST /api/webhooks/smalltalk
app.use('/api/widget',   widgetRoutes);

app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin/*',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health',   (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/',         (req, res) => res.redirect('/admin'));

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info(`Server läuft auf Port ${port}`);
  // Warte 5s bis Server stabil ist, dann Webhook + KeepAlive starten
  setTimeout(() => {
    autoRegisterWebhook();
    startKeepAlive();
    // Coupon Daily Scheduler
    try {
      const couponService = require('./services/couponService');
      couponService.startDailyScheduler();
    } catch(e) { logger.warn('[Server] Coupon Scheduler:', e.message); }

    // Smalltalk Bot: Geplante Nachrichten alle 60s prüfen
    try {
      const { tgAdminHelper } = require('./services/adminHelper/tgAdminHelper');
      const supabase = require('./config/supabase');
      setInterval(async () => {
        try {
          const { data: s } = await supabase.from('settings').select('smalltalk_bot_token').single();
          if (s?.smalltalk_bot_token) {
            await tgAdminHelper.fireScheduled(s.smalltalk_bot_token);
          }
        } catch (_) {}
      }, 60000);
      logger.info('[Server] Smalltalk scheduled messages: aktiv');
    } catch(e) { logger.warn('[Server] Smalltalk Scheduler:', e.message); }

    // Package Expiry: hourly sweep — marks expired packages as forfeited
    // and recomputes bot_channels budgets.  v1.4.47
    try {
      const supabase = require('./config/supabase');
      const runSweep = async () => {
        try {
          const { data, error } = await supabase.rpc('expire_channel_packages');
          if (error) throw error;
          if (data && data > 0) logger.info(`[PackageExpiry] ${data} channel(s) had packages expired`);
        } catch (e) { logger.warn('[PackageExpiry] sweep failed:', e.message); }
      };
      setTimeout(runSweep, 30000);            // first run 30s after boot
      setInterval(runSweep, 60 * 60 * 1000);  // hourly
      logger.info('[Server] Package expiry sweeper: aktiv');
    } catch(e) { logger.warn('[Server] Package Expiry Scheduler:', e.message); }
  }, 5000);
});

// ── Auto-Register Webhook ─────────────────────────────────────────────────────
// Liest APP_URL aus env ODER webhook_url aus der DB und setzt den Telegram-Webhook.
// Läuft einmalig beim Start – löst das 502-Problem bei Render.com Cold-Starts.
async function autoRegisterWebhook() {
  try {
    const supabase       = require('./config/supabase');
    const telegramService = require('./services/telegramService');

    // APP_URL aus env oder aus DB
    let appUrl = process.env.APP_URL || '';

    if (!appUrl) {
      const { data: settings } = await supabase
        .from('settings').select('webhook_url').single();
      appUrl = settings?.webhook_url || '';
    }

    if (!appUrl) {
      logger.info('[Webhook] Kein APP_URL gesetzt – Webhook wird nicht automatisch registriert.');
      logger.info('[Webhook] Trage APP_URL in Render.com Environment Variables ein oder setze es im Dashboard.');
      return;
    }

    // Webhook setzen
    const result = await telegramService.setWebhook(appUrl);
    if (result.ok) {
      logger.info(`[Webhook] ✅ Auto-registriert: ${appUrl}/api/webhooks/telegram`);
      // Persistent in DB speichern
      try {
        await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() });
      } catch (_) {}
    } else {
      logger.warn(`[Webhook] Auto-Registrierung fehlgeschlagen: ${result.description}`);
    }
  } catch (err) {
    logger.warn(`[Webhook] Auto-Registrierung Fehler (nicht fatal): ${err.message}`);
  }
}

// ── KeepAlive für Render.com ──────────────────────────────────────────────────
function startKeepAlive() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return;

  const http  = require('http');
  const https = require('https');

  function ping() {
    try {
      const url    = new URL(`${appUrl}/health`);
      const client = url.protocol === 'https:' ? https : http;
      const req    = client.get(url.href, { timeout: 8000 }, (res) => {
        logger.info(`[KeepAlive] ${res.statusCode}`);
      });
      req.on('error', (e) => logger.warn(`[KeepAlive] ${e.message}`));
      req.end();
    } catch (e) {
      logger.warn(`[KeepAlive] ${e.message}`);
    }
  }

  // Erst nach 30s, dann alle 14 Minuten
  setTimeout(() => { ping(); setInterval(ping, 14 * 60 * 1000); }, 30000);
  logger.info(`[KeepAlive] Aktiv → ${appUrl}/health`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
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
