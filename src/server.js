/**
 * AI AdminHelper Server (Standalone)
 * ─────────────────────────────────────────────────────────────────────────────
 * Telegram-Bot fuer Gruppenadministration. Verwaltet:
 *   - Channels, Co-Admins, Pakete
 *   - Smalltalk-AI (Channel-AI)
 *   - Safelist / Scamliste / Blacklist
 *   - @admin-Meldungen, Diss Battle, Activity Tracker
 *   - Nachtruhe, Wiederkehrende Nachrichten
 *
 * Dashboard: GET /admin   (Eigene Login + Channel-Verwaltung)
 * Webhook:   POST /api/webhooks/smalltalk
 */
const express = require('express');
const cors = require('cors');

// PostgREST im Hintergrund starten (falls self-hosted)
try {
  const { launchPostgREST } = require('./config/postgrestLauncher');
  launchPostgREST();
} catch (launcherErr) {
  console.error('⚠️ Fehler beim Starten des PostgREST-Launchers:', launcherErr.message);
}
const path = require('path');
const { port } = require('./config/env');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const adminRoutes = require('./routes/adminRoutes');
const smalltalkBotRoutes = require('./routes/smalltalkBotRoutes');
const botToken = require('./config/botToken');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', smalltalkBotRoutes);

// Dashboard immer frisch ausliefern (kein Stale-Cache nach Deploy)
function sendDashboard(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
}
app.get('/admin',     sendDashboard);
app.get('/admin/*',   sendDashboard);
app.get('/health',    (req, res) => res.json({ status: 'ok', service: 'adminhelper', version: require('./utils/versionLoader').getVersion(), ts: new Date().toISOString() }));
app.get('/',          (req, res) => res.redirect('/admin'));

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info(`[AdminHelper] Server läuft auf Port ${port}`);

  // Diagnose für lokale PostgREST-Anbindung
  try {
    const http = require('http');
    setTimeout(() => {
      http.get('http://localhost:3000/', (res) => {
        logger.info(`📡 [PostgREST Diagnostic] Lokaler PostgREST-Server geantwortet mit Status: ${res.statusCode}`);
      }).on('error', (err) => {
        logger.warn(`⚠️ [PostgREST Diagnostic] Lokaler PostgREST-Server nicht erreichbar: ${err.message}`);
      });
    }, 4000);
  } catch (diagErr) {
    logger.warn(`[PostgREST Diagnostic] Fehler bei Initialisierung: ${diagErr.message}`);
  }

  setTimeout(() => {
    autoRegisterWebhook();
    setAutoCommands();
    startKeepAlive();

    // i18n: DB-Cache laden + fehlende Übersetzungen im Hintergrund erzeugen
    try {
      const i18n = require('./services/i18n');
      i18n.preloadTranslations({ eager: false }).catch(e => logger.warn(`[i18n] preload error: ${e.message}`));
    } catch(e) { logger.warn(`[i18n] preload init failed: ${e.message}`); }

    // Scheduled-Tasks fuer AdminHelper
    try {
      const { tgAdminHelper, tgApi } = require('./services/adminHelper/tgAdminHelper');
      const supabase = require('./config/supabase');

      // Geplante Nachrichten: 1 min
      setInterval(async () => {
        try {
          const _tok = await botToken.getToken();
          if (_tok) await tgAdminHelper.fireScheduled(_tok);
        } catch (_) {}
      }, 60000);

      // Auto-Clean: 30 min
      setInterval(async () => {
        try {
          const _tok = await botToken.getToken();
          if (_tok) await tgAdminHelper.runAutoClean(_tok);
        } catch (_) {}
      }, 30 * 60 * 1000);

      // Bot-Message-Auto-Delete: 1 min
      setInterval(async () => {
        try {
          const _tok = await botToken.getToken();
          if (_tok) {
            const now = new Date().toISOString();
            const { data: msgs } = await supabase.from('bot_messages').select('*').lte('delete_after', now);
            if (msgs && msgs.length > 0) {
              const tg = tgApi(_tok);
              for (const m of msgs) {
                await tg.call('deleteMessage', { chat_id: m.channel_id, message_id: m.message_id }).catch(() => {});
                try { await supabase.from('bot_messages').delete().eq('id', m.id); } catch(_){}
              }
            }
          }
        } catch (_) {}
      }, 60000);

      // Channel-Message-Log Pruner: 1h
      try {
        const safelistService = require('./services/adminHelper/safelistService');
        const messageLogPruner = async () => {
          try { await safelistService.pruneOldMessageLog(); }
          catch (e) { logger.warn(`[MessageLogPrune] ${e.message}`); }
        };
        setTimeout(messageLogPruner, 2 * 60 * 1000);
        setInterval(messageLogPruner, 60 * 60 * 1000);
      } catch (e) { logger.warn(`[MessageLogPrune init] ${e.message}`); }

      // Quiet-Hours: 1 min
      try {
        const quietHoursService = require('./services/adminHelper/quietHoursService');
        const runQuietCheck = async () => {
          try {
            const _tok = await botToken.getToken();
            if (!_tok) return;
            const tg = tgApi(_tok);
            await quietHoursService.runQuietHoursCheck(tg, supabase);
          } catch (e) { logger.warn(`[QuietHours] ${e.message}`); }
        };
        setInterval(runQuietCheck, 60 * 1000);
      } catch (e) { logger.warn(`[QuietHours init] ${e.message}`); }

      // Activity Tracker Rankings: 10 min
      try {
        const groupGameService = require('./services/adminHelper/groupGameService');
        const runActivityCheck = async () => {
          try {
            const _tok = await botToken.getToken();
            if (!_tok) return;
            const tg = tgApi(_tok);
            await groupGameService.runActivityRankings(tg, supabase);
          } catch (e) { logger.warn(`[ActivityRanking] ${e.message}`); }
        };
        setTimeout(runActivityCheck, 2 * 60 * 1000);
        setInterval(runActivityCheck, 10 * 60 * 1000);
      } catch (e) { logger.warn(`[ActivityRanking init] ${e.message}`); }

      // Coupon Daily Scheduler (Channel-Coupons werden in Berater verwaltet, hier nicht)
      // Package Expiry Sweeper: 1h
      try {
        const runSweep = async () => {
          try {
            const { data, error } = await supabase.rpc('expire_channel_packages');
            if (error) throw error;
            if (data && data > 0) logger.info(`[PackageExpiry] ${data} channel(s) had packages expired`);
          } catch (e) { logger.warn(e.message); }
        };
        setTimeout(runSweep, 30000);
        setInterval(runSweep, 60 * 60 * 1000);
      } catch (e) { logger.warn(e.message); }

      logger.info('[AdminHelper] Alle Scheduled-Tasks aktiv: Scheduled, AutoClean, AutoDelete, MsgLogPrune, QuietHours, ActivityRanking, PackageExpiry');
    } catch(e) { logger.warn(e.message); }
  }, 5000);
});

async function autoRegisterWebhook() {
  const supabase = require('./config/supabase');
  const axios = require('axios');

  // URL-Auflösung mit Fallback-Kette:
  //   1) APP_URL (manuell gesetzt)
  //   2) RENDER_EXTERNAL_URL (von Render automatisch gesetzt) ← Auto-Fix
  //   3) settings.webhook_url (im Dashboard gespeichert)
  let appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
  if (!appUrl) {
    try {
      const { data: settings } = await supabase.from('settings').select('webhook_url').single();
      appUrl = settings?.webhook_url || '';
    } catch (e) {}
  }
  if (!appUrl) {
    logger.warn('[Webhook] Keine URL gefunden (weder APP_URL noch RENDER_EXTERNAL_URL noch settings.webhook_url). Bitte APP_URL setzen oder App-URL im Dashboard speichern.');
    return;
  }
  appUrl = appUrl.replace(/\/$/, '');

  let adminToken = await botToken.getToken();

  if (adminToken) {
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${adminToken}/setWebhook`,
        {
          url: `${appUrl}/api/webhooks/smalltalk`,
          allowed_updates: ['message','callback_query','my_chat_member','chat_member','channel_post','message_reaction'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      if (r.data?.ok) {
        logger.info(`[Webhook/AdminHelper] ✅ Registriert: ${appUrl}/api/webhooks/smalltalk`);
        try { await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() }); } catch(_){}
        // Diagnose: aktuellen Webhook-Status loggen (zeigt pending/last_error)
        try {
          const info = await axios.get(`https://api.telegram.org/bot${adminToken}/getWebhookInfo`, { timeout: 10000 });
          const w = info.data?.result || {};
          logger.info(`[Webhook/AdminHelper] Info: url=${w.url || '-'} | pending=${w.pending_update_count ?? '?'} | allowed=${(w.allowed_updates||[]).join(',') || 'default'}${w.last_error_message ? ' | last_error=' + w.last_error_message : ''}`);
        } catch (_) {}
      } else logger.warn(`[Webhook/AdminHelper] Fehler: ${r.data?.description}`);
    } catch (e) { logger.warn(`[Webhook/AdminHelper] ${e.response?.data?.description || e.message}`); }
  } else logger.warn('[Webhook/AdminHelper] Kein Bot-Token gefunden - bitte SMALLTALK_BOT_TOKEN als Environment-Variable in Render setzen.');
}

async function setAutoCommands() {
  const axios = require('axios');

  let adminToken = await botToken.getToken();

  if (adminToken) {
    const privateCommands = [
      { command: 'menu',      description: 'Hauptmenü öffnen' },
      { command: 'settings',  description: 'Channel-Einstellungen' },
      { command: 'help',      description: 'Alle Admin-Befehle anzeigen' },
      { command: 'check',     description: 'Feedback eines Users prüfen (/check @user)' },
      { command: 'scamliste', description: 'Scamliste anzeigen oder Scammer melden' },
      { command: 'safeliste', description: 'Verifizierte Mitglieder' },
      { command: 'userinfo',  description: 'User analysieren (5x/Tag kostenlos)' },
      { command: 'ai',        description: 'KI-Assistent befragen (/ai Frage)' },
      { command: 'buy',       description: 'Credit-Paket für eigenen Channel kaufen' },
      { command: 'refill',    description: 'Credits nachladen' }
    ];
    const groupCommands = [
      { command: 'donate',    description: '❤️ Credit-Paket für diese Gruppe spendieren' },
      { command: 'help',      description: 'Übersicht der Befehle' },
      { command: 'check',     description: 'Feedback eines Users prüfen (/check @user)' },
      { command: 'safeliste', description: 'Verifizierte Mitglieder' },
      { command: 'scamliste', description: 'Scamliste ansehen' },
      { command: 'userinfo',  description: 'User analysieren (5x/Tag kostenlos)' },
      { command: 'ai',        description: 'KI-Assistent befragen (/ai Frage)' },
      { command: 'dissbattle',description: '⚔️ Diss-Battle herausfordern' },
      { command: 'topdiss',   description: '🏆 Diss-Battle Top-10' }
    ];
    try {
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: privateCommands, scope: { type: 'all_private_chats' } }, { timeout: 8000 });
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: groupCommands,   scope: { type: 'all_group_chats' } }, { timeout: 8000 });
      await axios.post(`https://api.telegram.org/bot${adminToken}/setMyCommands`, { commands: groupCommands,   scope: { type: 'default' } }, { timeout: 8000 });
      logger.info('[AdminHelper] Autocomplete-Befehle registriert');
    } catch (err) { logger.warn(`[AdminHelper] setMyCommands: ${err.response?.data?.description || err.message}`); }
  }
}

function startKeepAlive() {
  const appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!appUrl) return;
  const http = require('http');
  const https = require('https');
  function ping() {
    try {
      const url = new URL(`${appUrl}/health`);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url.href, { timeout: 8000 }, (res) => logger.info(`[KeepAlive] ${res.statusCode}`));
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
