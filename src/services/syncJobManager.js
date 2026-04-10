/**
 * syncJobManager.js
 * 
 * Verwaltet Hintergrund-Sync-Jobs im Server-Speicher.
 * Der Sync läuft serverseitig weiter – egal ob der Browser-Tab offen ist.
 * Frontend pollt den Status per GET /api/admin/sellauth/sync-status/:jobId
 */

const crypto = require('crypto');

// Aktive Jobs: { jobId: { status, progress, log, startedAt, finishedAt, result } }
const jobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000; // Jobs nach 30 Minuten aus Speicher entfernen

const syncJobManager = {

  // Neuen Job anlegen, sofort ID zurückgeben
  createJob() {
    const jobId = crypto.randomBytes(8).toString('hex');
    jobs.set(jobId, {
      id:         jobId,
      status:     'running',   // running | done | error
      progress:   0,           // 0–100
      step:       'Starte Sync...',
      log:        [],
      startedAt:  new Date().toISOString(),
      finishedAt: null,
      result:     null
    });
    // Cleanup nach TTL
    setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
    return jobId;
  },

  // Job-Status abrufen
  getJob(jobId) {
    return jobs.get(jobId) || null;
  },

  // Fortschritt aktualisieren
  updateProgress(jobId, progress, step) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
    job.step     = step || job.step;
    job.log.push(`[${new Date().toLocaleTimeString('de-DE')}] ${step}`);
    // Log auf max. 50 Einträge begrenzen
    if (job.log.length > 50) job.log = job.log.slice(-50);
  },

  // Job als abgeschlossen markieren
  finishJob(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status     = 'done';
    job.progress   = 100;
    job.step       = 'Sync abgeschlossen';
    job.finishedAt = new Date().toISOString();
    job.result     = result;
    job.log.push(`[${new Date().toLocaleTimeString('de-DE')}] ✅ Fertig: ${result?.saved || 0} Einträge gespeichert`);
  },

  // Job als fehlgeschlagen markieren
  failJob(jobId, errorMsg) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status     = 'error';
    job.step       = `Fehler: ${errorMsg}`;
    job.finishedAt = new Date().toISOString();
    job.log.push(`[${new Date().toLocaleTimeString('de-DE')}] ❌ ${errorMsg}`);
  }
};

module.exports = syncJobManager;
