const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

function launchPostgREST() {
  if (process.env.DB_SELF_HOSTED !== 'true' && !process.env.DATABASE_URL) {
    logger.info('[PostgREST Launcher] Bypassed (not self-hosted / DATABASE_URL not set)');
    return;
  }

  const dbUri = process.env.DATABASE_URL || 'postgres://postgres:dein_sicheres_db_passwort@localhost:5432/postgres';
  const jwtSecret = process.env.JWT_SECRET || 'ai-adminhelper-secret-change-me-32-chars-long';

  // --- Auto-Migration ---
  try {
    const schemaPath = path.join(__dirname, '../../supabase/schema_full.sql');
    if (fs.existsSync(schemaPath)) {
      logger.info('[PostgREST Launcher] Führe Auto-Migration / Schema-Check aus...');
      execSync(`psql "${dbUri}" -f "${schemaPath}"`, { stdio: 'ignore' });
      logger.info('[PostgREST Launcher] Auto-Migration / Schema-Check erfolgreich abgeschlossen.');
    } else {
      logger.warn('[PostgREST Launcher] schema_full.sql nicht gefunden, überspringe Auto-Migration.');
    }
  } catch (err) {
    logger.error(`[PostgREST Launcher] Fehler bei der Auto-Migration: ${err.message}`);
  }

  logger.info('[PostgREST Launcher] Starte PostgREST-Prozess auf Port 3000...');

  const pgProcess = spawn('postgrest', [], {
    env: {
      ...process.env,
      PGRST_DB_URI: dbUri,
      PGRST_DB_SCHEMA: 'public',
      PGRST_DB_ANON_ROLE: 'postgres',
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_PORT: '3000'
    }
  });

  pgProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      logger.info(`[PostgREST] ${line}`);
    });
  });

  pgProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
      logger.error(`[PostgREST Error] ${line}`);
    });
  });

  pgProcess.on('close', (code) => {
    logger.warn(`[PostgREST Launcher] Prozess mit Code ${code} beendet.`);
  });

  // Damit der Node-Prozess nicht auf das Beenden von PostgREST warten muss
  pgProcess.unref();

  global._postgrestProcess = pgProcess;
}

module.exports = { launchPostgREST };
