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
    autoRegisterWebhook();
    startKeepAlive();
    
    try {
      const couponService = require('./services/couponService');
      couponService.startDailyScheduler();
    } catch(e) { logger.warn(e.message); }

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

async function autoRegisterWebhook() {
  try {
    const supabase = require('./config/supabase');
    const telegramService = require('./services/telegramService');

    let appUrl = process.env.APP_URL || '';

    if (!appUrl) {
      const { data: settings } = await supabase.from('settings').select('webhook_url').single();
      appUrl = settings?.webhook_url || '';
    }

    if (!appUrl) {
      return;
    }

    const result = await telegramService.setWebhook(appUrl);
    if (result.ok) {
      logger.info(`[Webhook] ✅ Auto-registriert: ${appUrl}/api/webhooks/telegram`);
      try {
        await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() });
      } catch (_) {}
    } else {
      logger.warn(`[Webhook] Auto-Registrierung fehlgeschlagen: ${result.description}`);
    }
  } catch (err) {
    logger.warn(err.message);
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
