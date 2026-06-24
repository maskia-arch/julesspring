/**
 * spamDetectionService.js v1.6.3
 * ============================================================================
 * Schützt die Channel-AI vor Missbrauch durch übermäßige oder sinnfreie
 * Nutzung (Token-Burning, Spam-Anfragen).
 *
 * Regeln:
 *   1. Dieselbe Nachricht 3× in 10 Minuten     → Warning
 *   2. Semantisch ähnliche Nachrichten 5× in 10 Min → Warning
 *   3. 12+ Nachrichten in 5 Minuten             → Warning
 *   4. 2. Warning innerhalb von 24h             → 12h Mute
 *
 * Warning-Level wird in `ai_spam_violations` gespeichert.
 * Mute erfolgt via Telegram `restrictChatMember`.
 * ============================================================================
 */

const supabase = require('../../config/supabase');
const logger   = require('../../utils/logger');

// ── Konfiguration ─────────────────────────────────────────────────────────────
const WINDOW_MS          = 10 * 60 * 1000;  // 10 Minuten
const SHORT_WINDOW_MS    =  5 * 60 * 1000;  //  5 Minuten
const MAX_SAME_MSG       = 2;               // 3. identische Nachricht = Spam
const MAX_SIMILAR_MSG    = 4;               // 5. semantisch ähnliche = Spam
const MAX_MSGS_SHORT_WIN = 11;              // 12. Nachricht in 5 Min = Spam
const MUTE_DURATION_SEC  = 12 * 60 * 60;   // 12 Stunden
const WARN_RESET_MS      = 24 * 60 * 60 * 1000; // Warning-Reset nach 24h

// In-Memory Cache (für Performance — kein DB-Hit bei jeder Prüfung)
// Key: `${channelId}:${userId}` → [{hash, time}]
const _recentMsgs = new Map();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Einfacher FNV-1a Hash für Nachrichteninhalt */
function _hash(text) {
  let h = 2166136261;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/**
 * Normalisierter Wort-Fingerprint für semantische Ähnlichkeit.
 * "Ist @x sicher?" und "Ist @x safe?" → ähnlicher Score
 */
function _wordFingerprint(text) {
  return text
    .toLowerCase()
    .replace(/@\w+/g, '@user')     // Alle @mentions vereinheitlichen
    .replace(/[^a-züöäß\s]/g, '')  // Nur Buchstaben + Leerzeichen
    .split(/\s+/)
    .filter(w => w.length > 2)
    .sort()
    .slice(0, 8)                   // Max 8 Wörter für Vergleich
    .join(' ');
}

/** Prozentualer Wort-Overlap zwischen zwei Nachrichten (0.0 – 1.0) */
function _similarity(a, b) {
  const fa = _wordFingerprint(a).split(' ');
  const fb = _wordFingerprint(b).split(' ');
  if (!fa.length || !fb.length) return 0;
  const setA = new Set(fa);
  const common = fb.filter(w => setA.has(w)).length;
  return common / Math.max(fa.length, fb.length);
}

/** Cache für einen User bereinigen (alte Einträge entfernen) */
function _pruneCache(key) {
  const now = Date.now();
  const entries = _recentMsgs.get(key) || [];
  const fresh = entries.filter(e => now - e.time < WINDOW_MS);
  if (fresh.length !== entries.length) _recentMsgs.set(key, fresh);
  return fresh;
}

// ── Haupt-API ─────────────────────────────────────────────────────────────────

/**
 * Prüft ob eine Nachricht als Spam gilt.
 *
 * @returns {{ spam: boolean, reason: string|null, shouldWarn: boolean, shouldMute: boolean }}
 */
async function checkSpam(channelId, userId, text) {
  const key     = `${channelId}:${userId}`;
  const now     = Date.now();
  const recent  = _pruneCache(key);
  const hash    = _hash(text);

  // ── Regel 1: Identische Nachricht ────────────────────────────────────
  const sameCount = recent.filter(e => e.hash === hash).length;
  if (sameCount >= MAX_SAME_MSG) {
    return { spam: true, reason: 'identical_repeat', shouldWarn: true };
  }

  // ── Regel 2: Semantisch ähnliche Nachrichten ─────────────────────────
  const similarCount = recent.filter(e =>
    e.hash !== hash && _similarity(e.text, text) > 0.75
  ).length;
  if (similarCount >= MAX_SIMILAR_MSG) {
    return { spam: true, reason: 'similar_repeat', shouldWarn: true };
  }

  // ── Regel 3: Rate-Limit (zu viele in kurzer Zeit) ─────────────────────
  const inShortWindow = recent.filter(e => now - e.time < SHORT_WINDOW_MS).length;
  if (inShortWindow >= MAX_MSGS_SHORT_WIN) {
    return { spam: true, reason: 'rate_limit', shouldWarn: true };
  }

  // Kein Spam
  return { spam: false, reason: null, shouldWarn: false, shouldMute: false };
}

/**
 * Gibt zurück ob ein User aktuell stummgeschaltet ist.
 * @returns {{ muted: boolean, until: Date|null }}
 */
async function isMuted(channelId, userId) {
  try {
    const { data } = await supabase.from('ai_spam_violations')
      .select('muted_until')
      .eq('channel_id', String(channelId))
      .eq('user_id', userId)
      .maybeSingle();

    if (!data?.muted_until) return { muted: false, until: null };
    const until = new Date(data.muted_until);
    if (until > new Date()) return { muted: true, until };
    return { muted: false, until: null };
  } catch (_) {
    return { muted: false, until: null };
  }
}

/**
 * Verarbeitet einen erkannten Spam-Verstoß.
 * Gibt zurück was getan werden soll: 'warn' oder 'mute'.
 *
 * @returns {'warn'|'mute'}
 */
async function recordViolation(channelId, userId) {
  try {
    const { data: existing } = await supabase.from('ai_spam_violations')
      .select('*')
      .eq('channel_id', String(channelId))
      .eq('user_id', userId)
      .maybeSingle();

    const now = new Date();

    if (!existing) {
      // Erster Verstoß → Warning
      await supabase.from('ai_spam_violations').insert([{
        channel_id:    String(channelId),
        user_id:       userId,
        warning_count: 1,
        last_violation: now,
        updated_at:    now
      }]);
      return 'warn';
    }

    // Warning-Count zurücksetzen wenn letzter Verstoß >24h her
    const lastViolation = existing.last_violation ? new Date(existing.last_violation) : null;
    const isOldViolation = !lastViolation || (now - lastViolation) > WARN_RESET_MS;

    if (isOldViolation) {
      await supabase.from('ai_spam_violations').update({
        warning_count: 1,
        last_violation: now,
        updated_at: now
      }).eq('channel_id', String(channelId)).eq('user_id', userId);
      return 'warn';
    }

    const newCount = (existing.warning_count || 0) + 1;

    if (newCount >= 2) {
      // 2. Verstoß innerhalb 24h → Mute für 12h
      const muteUntil = new Date(now.getTime() + MUTE_DURATION_SEC * 1000);
      await supabase.from('ai_spam_violations').update({
        warning_count:  newCount,
        muted_until:    muteUntil.toISOString(),
        last_violation: now,
        updated_at:     now
      }).eq('channel_id', String(channelId)).eq('user_id', userId);
      return 'mute';
    } else {
      await supabase.from('ai_spam_violations').update({
        warning_count:  newCount,
        last_violation: now,
        updated_at:     now
      }).eq('channel_id', String(channelId)).eq('user_id', userId);
      return 'warn';
    }
  } catch (e) {
    logger.warn(`[SpamDetect] recordViolation Fehler: ${e.message}`);
    return 'warn';
  }
}

/**
 * Protokolliert eine neue Nachricht im Cache und in der DB.
 */
async function recordMessage(channelId, userId, text) {
  const key  = `${channelId}:${userId}`;
  const hash = _hash(text);
  const now  = Date.now();

  // Cache aktualisieren
  const recent = _pruneCache(key);
  recent.push({ hash, text: text.substring(0, 100), time: now });
  // Max 50 Einträge im Cache
  if (recent.length > 50) recent.splice(0, recent.length - 50);
  _recentMsgs.set(key, recent);

  // DB-Log (fire-and-forget, async wrapper weil Supabase v2 kein .catch() unterstützt)
  void (async () => {
    try {
      await supabase.from('ai_usage_log').insert([{
        channel_id:  String(channelId),
        user_id:     userId,
        msg_hash:    hash,
        msg_preview: text.substring(0, 80),
        created_at:  new Date().toISOString()
      }]);
    } catch (_) {}
  })();
}

/**
 * Mutet einen User in der Telegram-Gruppe für 12 Stunden.
 * Setzt alle Send-Permissions auf false.
 */
async function muteInTelegram(tg, chatId, userId) {
  try {
    const until = Math.floor(Date.now() / 1000) + MUTE_DURATION_SEC;
    await tg.call('restrictChatMember', {
      chat_id:    chatId,
      user_id:    userId,
      until_date: until,
      permissions: {
        can_send_messages:         false,
        can_send_audios:           false,
        can_send_documents:        false,
        can_send_photos:           false,
        can_send_videos:           false,
        can_send_video_notes:      false,
        can_send_voice_notes:      false,
        can_send_polls:            false,
        can_send_other_messages:   false,
        can_add_web_page_previews: false
      }
    });
    logger.info(`[SpamDetect] User ${userId} in ${chatId} für 12h gemutet`);
    return true;
  } catch (e) {
    logger.warn(`[SpamDetect] Mute fehlgeschlagen: ${e.message}`);
    return false;
  }
}

/** Formatiert die Mute-Endzeit für die Anzeige */
function formatMuteUntil(until) {
  if (!until) return '12 Stunden';
  return until.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

module.exports = {
  checkSpam,
  isMuted,
  recordViolation,
  recordMessage,
  muteInTelegram,
  formatMuteUntil,
  MUTE_DURATION_SEC,
};
