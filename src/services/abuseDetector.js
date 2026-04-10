/**
 * abuseDetector.js v1.2
 * Troll-Detection, Auto-Mute, Flagging, 3-Strikes Auto-Ban
 *
 * Erkennungsmuster:
 * - Nachrichten-Flut (>N pro Stunde)
 * - Sehr kurze sinnlose Nachrichten in Serie
 * - Bekannte Spam/Troll-Muster
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// Troll-Muster: kurze nonsense Eingaben
const TROLL_PATTERNS = [
  /^(.)\1{4,}$/,                      // "aaaaa", "11111"
  /^[^a-zA-ZäöüÄÖÜ\d\s]{3,}$/,      // nur Sonderzeichen
  /^(test|asdf|qwer|zxcv|wasd){1,3}$/i,
  /^(hallo|hi|hey|yo)\s*\1+$/i,       // "hallo hallo hallo"
];

// In-Memory Burst-Tracking (reset nach Server-Neustart — ok, nur Schutz)
const _msgTimestamps = new Map(); // chatId → [timestamp, ...]

const abuseDetector = {

  /**
   * Prüft eine eingehende Nachricht auf Abuse.
   * @returns { blocked: bool, reason: string|null, flagged: bool }
   */
  async check(chatId, text) {
    try {
      const settings = await this._loadSettings();

      // 1. Nachricht auf Blacklist prüfen (bereits gebannt)
      const { data: ban } = await supabase.from('blacklist')
        .select('id').eq('identifier', chatId).maybeSingle();
      if (ban) return { blocked: true, reason: 'banned', flagged: false };

      // 2. Auto-Mute prüfen
      const { data: chat } = await supabase.from('chats')
        .select('auto_muted, flag_count, is_manual_mode')
        .eq('id', chatId).maybeSingle();

      if (chat?.auto_muted) return { blocked: true, reason: 'auto_muted', flagged: false };

      // 3. Nachrichten-Flut erkennen (in-memory, letzten 60 Minuten)
      const burstBlocked = this._checkBurst(chatId, settings.abuse_max_msgs_per_hour || 30);
      if (burstBlocked) {
        logger.warn(`[Abuse] Flut erkannt: ${chatId} (>${settings.abuse_max_msgs_per_hour}/h)`);
        await this._flagChat(chatId, 'spam_flood', true);
        const flagCount = (chat?.flag_count || 0) + 1;
        if (flagCount >= (settings.abuse_auto_ban_flags || 3)) {
          await this._autoBan(chatId, 'Automatischer Bann: Nachrichten-Flut');
          return { blocked: true, reason: 'auto_banned', flagged: true };
        }
        return { blocked: true, reason: 'rate_limit', flagged: true };
      }

      // 4. Troll-Muster erkennen (nur wenn Text sehr kurz oder Muster matcht)
      const trimmed = (text || '').trim();
      const isTroll = trimmed.length > 0 && trimmed.length <= 3 ? false : // kurze Texte ignorieren
        TROLL_PATTERNS.some(p => p.test(trimmed));

      if (isTroll) {
        logger.info(`[Abuse] Troll-Muster: ${chatId} -> "${trimmed.substring(0,30)}"`);
        // Nur loggen, nicht blockieren bei erstem Treffer — erst bei Häufung
        await this._incrementTrollScore(chatId, trimmed);
      }

      return { blocked: false, reason: null, flagged: false };
    } catch (err) {
      logger.warn(`[Abuse] Check-Fehler (nicht fatal): ${err.message}`);
      return { blocked: false, reason: null, flagged: false }; // Im Zweifel: durchlassen
    }
  },

  // ── Burst-Tracking (in-memory) ─────────────────────────────────────────
  _checkBurst(chatId, maxPerHour) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    let timestamps = _msgTimestamps.get(chatId) || [];
    // Alte Timestamps entfernen
    timestamps = timestamps.filter(t => t > oneHourAgo);
    timestamps.push(now);
    _msgTimestamps.set(chatId, timestamps);

    return timestamps.length > maxPerHour;
  },

  // ── Troll-Score erhöhen → ggf. Auto-Mute ─────────────────────────────
  async _incrementTrollScore(chatId, text) {
    const settings = await this._loadSettings();
    const { data: chat } = await supabase.from('chats')
      .select('flag_count').eq('id', chatId).maybeSingle();

    const currentFlags = chat?.flag_count || 0;
    const autoBanAt    = settings.abuse_auto_ban_flags || 3;

    await this._flagChat(chatId, 'troll_pattern', true);

    if (currentFlags + 1 >= autoBanAt) {
      await this._autoBan(chatId, 'Automatischer Bann: Wiederholtes Trolling');
    } else if (currentFlags + 1 >= 2) {
      // Ab 2 Flags: auto-muten
      await supabase.from('chats').update({
        auto_muted: true,
        mute_reason: 'Automatisch stumm geschaltet: verdächtige Aktivität'
      }).eq('id', chatId);
      logger.warn(`[Abuse] Auto-Mute: ${chatId} (${currentFlags + 1} Flags)`);
    }
  },

  // ── Flag hinzufügen ────────────────────────────────────────────────────
  async _flagChat(chatId, reason, autoFlagged = false) {
    await supabase.from('user_flags').insert([{
      chat_id:      chatId,
      reason,
      auto_flagged: autoFlagged,
      flagged_by:   autoFlagged ? 'system' : 'admin'
    }]);

    // flag_count im Chat erhöhen
    const { data: chat } = await supabase.from('chats').select('flag_count').eq('id', chatId).maybeSingle();
    await supabase.from('chats').update({
      flag_count: (chat?.flag_count || 0) + 1
    }).eq('id', chatId);
  },

  // ── Auto-Ban ────────────────────────────────────────────────────────────
  async _autoBan(chatId, reason) {
    await supabase.from('blacklist').insert([{
      identifier:   chatId,
      reason,
      auto_banned:  true
    }]);
    await supabase.from('chats').update({
      auto_muted:   true,
      is_manual_mode: false,
      mute_reason:  reason
    }).eq('id', chatId);
    logger.warn(`[Abuse] AUTO-BAN: ${chatId} — ${reason}`);
  },

  // ── Manuelles Flaggen durch Admin ──────────────────────────────────────
  async flagByAdmin(chatId, reason) {
    await this._flagChat(chatId, reason || 'manual', false);
    const settings = await this._loadSettings();
    const { data: chat } = await supabase.from('chats').select('flag_count').eq('id', chatId).maybeSingle();
    if ((chat?.flag_count || 0) >= (settings.abuse_auto_ban_flags || 3)) {
      await this._autoBan(chatId, `Admin-Bann nach ${chat.flag_count} Flags`);
      return { banned: true };
    }
    return { banned: false, flags: (chat?.flag_count || 0) };
  },

  // ── Auto-Mute aufheben (durch Admin) ──────────────────────────────────
  async unmute(chatId) {
    await supabase.from('chats').update({
      auto_muted: false, mute_reason: null
    }).eq('id', chatId);
    // Burst-Cache leeren
    _msgTimestamps.delete(chatId);
    logger.info(`[Abuse] Mute aufgehoben: ${chatId}`);
  },

  // ── Settings laden ─────────────────────────────────────────────────────
  async _loadSettings() {
    try {
      const { data } = await supabase.from('settings').select(
        'abuse_max_msgs_per_hour, abuse_auto_ban_flags, abuse_min_msg_length'
      ).single();
      return data || {};
    } catch { return {}; }
  }
};

module.exports = abuseDetector;
