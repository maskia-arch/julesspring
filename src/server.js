const express = require('express');
const cors = require('cors');
const path = require('path');
const { port } = require('./config/env');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const adminRoutes = require('./routes/adminRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const widgetRoutes = require('./routes/widgetRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Statische Dateien (src/public)
app.use(express.static(path.join(__dirname, 'public')));

// API Routen
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/widget', widgetRoutes);

// Admin Dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health-Check (für Render.com keepAlive)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root → Admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Fehlerbehandlung
app.use(errorHandler);

// Server starten
const server = app.listen(port, () => {
  logger.info(`Server läuft auf Port ${port}`);
  logger.info(`Admin-Dashboard: http://localhost:${port}/admin`);
  startKeepAlive();
});

// ─── KeepAlive für Render.com Free Tier ──────────────────────────────────────
// Verhindert dass der Container einschläft und Webhooks verpassen werden
function startKeepAlive() {
  const APP_URL = process.env.APP_URL; // z.B. https://dein-bot.onrender.com
  if (!APP_URL) {
    logger.info('KeepAlive deaktiviert (APP_URL nicht gesetzt)');
    return;
  }

  // Erste Ping nach 30 Sekunden, dann alle 14 Minuten
  setTimeout(() => {
    pingHealth(APP_URL);
    setInterval(() => pingHealth(APP_URL), 14 * 60 * 1000);
  }, 30000);

  logger.info(`KeepAlive aktiv → ${APP_URL}/health alle 14 Minuten`);
}

async function pingHealth(appUrl) {
  try {
    const http = require('http');
    const https = require('https');
    const url = new URL(`${appUrl}/health`);
    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.get(url.href, { timeout: 8000 }, (res) => {
      logger.info(`KeepAlive ping → ${res.statusCode}`);
    });
    req.on('error', (e) => logger.warn(`KeepAlive ping fehlgeschlagen: ${e.message}`));
    req.end();
  } catch (e) {
    logger.warn(`KeepAlive Error: ${e.message}`);
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`${signal} empfangen – fahre Server herunter...`);
  server.close(() => {
    logger.info('Server beendet.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

module.exports = app;
