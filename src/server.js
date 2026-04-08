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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FIX: Da die server.js in /src liegt, zeigt __dirname auf /src. 
// 'public' zeigt also direkt auf /src/public.
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/widget', widgetRoutes);

// FIX: Auch hier den Pfad zu index.html anpassen
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all für das Dashboard (falls du darin navigierst)
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

app.use(errorHandler);

app.listen(port, () => {
  logger.info(`Server läuft auf Port ${port}`);
  logger.info(`Admin-Dashboard unter /admin erreichbar`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});
