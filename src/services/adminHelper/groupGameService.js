/**
 * Gruppenspiele — Activity Tracker.
 *
 * Scoring (pro qualifizierter Nachricht):
 *   • Qualitätsnachricht (Länge ≥ Threshold):  +3 Punkte
 *   • Smalltalk / kurze Nachricht / Sticker:    +1 Punkt
 *   • Reply auf Admin-Nachricht: min. +2 Punkte (Quality-Cap bleibt)
 *
 * MANIPULATIONS-SCHUTZ via Grok-AI Klassifikation:
 *   Vor der Punktevergabe wird die Nachricht durch grok-4.20-0309-non-reasoning
 *   geprüft. Nur Nachrichten die Grok als "echt" einstuft (kein Nonsense,
 *   Emoji-Spam, Floor-Filler) erhalten Punkte.
 *
 * Admins werden vom Spiel komplett ausgeschlossen (keine Punkte, nicht in /top).
 * Anti-Spam: pro User Cooldown (30s) zwischen zwei Punkt-Vergaben.
 *
 * AUTO-POSTING:
 *   activity_ranking_interval_hours steuert das automatische Posten der
 *   Rangliste im Channel. Wird vom Scheduler (runActivityRankings) getrieben.
 *
 * ZEITRAUM (optional):
 *   activity_game_starts_at / activity_game_ends_at definieren ein Spielfenster.
 *   Bei Erreichen von ends_at postet der Bot eine FINALE Rangliste und
 *   deaktiviert das Spiel automatisch.
 *
 * Tabellen:
 *   channel_user_points (channel_id, user_id, points, ...)
 *   channel_credit_log  (channel_id, category, credits, ...)
 * Toggle: bot_channels.group_game_enabled
 */

const logger           = require("../../utils/logger");
const xaiService       = require("../xaiService");
const creditLogService = require("../creditLogService");
const crypto           = require("crypto");

const DEFAULT_QUALITY_MIN_CHARS = 50;
const COOLDOWN_MS                = 30 * 1000;       // 30s Anti-Spam Cooldown
const ADMIN_CACHE_TTL_MS         = 5 * 60 * 1000;   // 5min Admin-Cache

// Klassifikation Multiplikator: User hat "X1" explizit gefordert
// (Standard wäre 1.5 in xaiService — für ActivityTracker bewusst auf 1.0 gesetzt)
const CLASSIFY_CREDIT_MULTIPLIER = 1.0;

// Prompt-Version: invalidiert den globalen Lerncache wenn der Prompt geändert wird.
// Bei Änderung des System-Prompts in _classifyByAI → diese Zahl erhöhen.
const CLASSIFY_PROMPT_VERSION = 1;

const groupGameService = {
  // In-Memory Admin-Cache: chatId → { adminIds: Set<number>, expires: ms }
  _adminCache: new Map(),

  /**
   * Hauptfunktion: bewertet eine Nachricht und vergibt Punkte (wenn enabled).
   * Wird AM ENDE von commandHandler.handleMessage aufgerufen.
   * Throws nicht — fail silently.
   */
  async scoreMessage(tg, supabase_db, msg, ch) {
    try {
      if (!ch?.group_game_enabled) return;
      if (!msg?.from || msg.from.is_bot) return;

      // Commands nicht bewerten — sonst gibt /top selbst Punkte
      const text = msg.text || msg.caption || "";
      if (text.startsWith("/")) return;

      // Innerhalb Spielzeitraum? (wenn konfiguriert)
      if (!this._isInGamePeriod(ch)) return;

      const chatId = String(msg.chat.id);
      const userId = msg.from.id;

      // Admin → ausschließen
      const isAdmin = await this._isAdmin(tg, chatId, userId);
      if (isAdmin) return;

      // Cooldown prüfen (BEVOR AI-Call → spart Credits)
      const lastAt = await this._getLastPointAt(supabase_db, chatId, userId);
      if (lastAt && (Date.now() - lastAt.getTime()) < COOLDOWN_MS) {
        return;
      }

      // ── MANIPULATIONSSCHUTZ: Grok klassifiziert die Nachricht ─────────────
      // Nur "echte" Nachrichten erhalten Punkte. Nonsense (Emoji-Spam,
      // sinnlose Buchstabenfolgen, Floor-Filler "lol", "👍👍👍") gibt 0 Punkte.
      // AI-Call läuft Server-seitig → User kann es nicht umgehen.
      //
      // GLOBALER CACHE: Bei bereits klassifizierten Nachrichten kommt das
      // Result aus der DB (channel-übergreifendes Learning).
      // Cache-Hits haben tokens_in/out = 0 → kein Logging, keine Credits.
      const aiResult = await this._classifyByAI(text);

      // Credit-Log + Abbuchung NUR bei tatsächlichem AI-Call (Cache-Miss).
      // Cache-Hits sind gratis und tauchen nicht im Kontoauszug auf.
      // Credits: aiResult.credits = (inTokens + outTokens) × 1.0 — Faktor X1.
      if (aiResult.tokens_in || aiResult.tokens_out) {
        creditLogService.log(supabase_db, chatId, {
          category:   "group_game_classify",
          credits:    aiResult.credits,
          tokens_in:  aiResult.tokens_in,
          tokens_out: aiResult.tokens_out,
          usd:        aiResult.usd,
          model:      aiResult.model,
          description: `User ${userId} — ${aiResult.isReal ? "echt" : "Nonsense"} (in=${aiResult.tokens_in}+out=${aiResult.tokens_out}=${aiResult.credits}×1.0)`
        });
        // Channel-Credits abbuchen (unsichtbar)
        await this._chargeCredits(supabase_db, chatId, aiResult.credits, aiResult.usd);
      }

      // Bei AI-Fehler: fail-open — Punkte trotzdem vergeben (sonst blockiert
      // ein xAI-Ausfall das ganze Spiel)
      if (aiResult.error || aiResult.isReal === false) {
        if (aiResult.isReal === false) {
          logger.info?.(`[GroupGame] ${chatId}/${userId}: Nachricht als Nonsense klassifiziert — keine Punkte`);
          return;
        }
        // bei error → weiter scoren
      }

      // Klassifikation OK → Punkte vergeben
      const points = await this._classify(tg, msg, ch, chatId);
      if (points <= 0) return;

      await this._addPoints(supabase_db, chatId, userId, msg.from, points);
    } catch (e) {
      logger.warn?.(`[GroupGame] scoreMessage Fehler: ${e.message}`);
    }
  },

  /**
   * Grok-AI Klassifikation: ist die Nachricht eine echte/sinnvolle Nachricht?
   *
   * GLOBALER LERNCACHE (kontinuierliches Lernen über alle Channels):
   *   1. Normalisiere Text (lowercase, whitespace-collapse, trim)
   *   2. SHA-256 Hash des normalisierten Texts → 32-Hex-Lookup-Key
   *   3. DB-Lookup in ai_message_classifications
   *   4a. Cache-Hit  → Result aus DB, hit_count++, KEIN AI-Call (0 Credits)
   *   4b. Cache-Miss → AI-Call, Result speichern, hit_count = 1
   *
   * Nutzt grok-4.20-0309-non-reasoning ($0.20/$0.50 per 1M Tokens).
   * Credit-Berechnung: (inTokens + outTokens) × 1.0 — Faktor X1.
   *
   * @returns {Promise<{isReal: boolean|null, credits, tokens_in, tokens_out, usd, model, error?, cached?}>}
   */
  async _classifyByAI(text) {
    const cleanText = String(text || "").substring(0, 500); // Cap bei 500 chars
    if (!cleanText.trim()) {
      return { isReal: false, credits: 0, tokens_in: 0, tokens_out: 0, usd: 0, model: null };
    }

    // ── Globaler Cache-Lookup ──────────────────────────────────────────────
    const normalized = this._normalizeForCache(cleanText);
    const hash       = this._hashText(normalized);
    const supabase   = require("../../config/supabase");

    try {
      const { data: cached } = await supabase
        .from("ai_message_classifications")
        .select("is_real, hit_count, model")
        .eq("hash", hash)
        .eq("prompt_version", CLASSIFY_PROMPT_VERSION)
        .maybeSingle();

      if (cached) {
        // Cache-Hit → kein AI-Call. hit_count erhöhen (fire-and-forget).
        void (async () => {
          try {
            await supabase.from("ai_message_classifications")
              .update({
                hit_count:   (cached.hit_count || 1) + 1,
                last_hit_at: new Date()
              })
              .eq("hash", hash);
          } catch (_) {}
        })();

        logger.debug?.(`[GroupGame] Cache-HIT für hash ${hash.substring(0,8)}… (${cached.is_real ? "echt" : "nonsense"})`);
        return {
          isReal:     cached.is_real,
          credits:    0,                // KEINE Credits — Cache spart Kosten
          tokens_in:  0,
          tokens_out: 0,
          usd:        0,
          model:      cached.model,
          cached:     true
        };
      }
    } catch (e) {
      logger.debug?.(`[GroupGame] Cache-Lookup Fehler: ${e.message} — falle zurück auf AI`);
    }

    // ── Cache-Miss → AI-Call ───────────────────────────────────────────────
    const systemPrompt =
      "Du bist ein Klassifikator für Gruppenchat-Nachrichten. " +
      "Antworte AUSSCHLIESSLICH mit einem einzigen Wort: 'echt' oder 'nonsense'. " +
      "Klassifiziere als 'nonsense': reine Emoji-Spams (z.B. '👍👍👍'), " +
      "Buchstaben-Spam ('aaaaa'), Floor-Filler ohne Inhalt ('lol', 'ok', '+1'), " +
      "Wiederholungen, sinnlose Zeichenfolgen. " +
      "Klassifiziere als 'echt': alles andere — auch kurze inhaltliche Antworten, " +
      "Fragen, Begrüßungen mit Inhalt, Reaktionen mit Kontext.";

    const userPrompt = `Nachricht:\n"${cleanText}"\n\nAntwort:`;

    let resp;
    try {
      resp = await xaiService.chat([
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ], { model: "grok-4.20-0309-non-reasoning", maxTokens: 5, temperature: 0.0, timeoutMs: 8000 });
    } catch (e) {
      return { isReal: null, credits: 0, tokens_in: 0, tokens_out: 0, usd: 0, model: null, error: e.message };
    }

    if (resp.error || !resp.text) {
      return { isReal: null, credits: 0, tokens_in: 0, tokens_out: 0, usd: 0, model: resp.model, error: resp.error || "empty" };
    }

    // Strenger Parser — nicht der LLM-Antwort vertrauen, sondern matchen
    const lowered = resp.text.toLowerCase().trim();
    let isReal;
    if (/\becht\b/.test(lowered))           isReal = true;
    else if (/\bnonsense\b/.test(lowered))  isReal = false;
    else                                    isReal = true; // unbekannt → kulant

    // ── Result in globalen Cache schreiben (fire-and-forget) ──────────────
    // UPSERT für Race-Condition-Sicherheit
    void (async () => {
      try {
        await supabase.from("ai_message_classifications").upsert({
          hash,
          text_preview:   cleanText.substring(0, 200),
          is_real:        isReal,
          model:          resp.model,
          prompt_version: CLASSIFY_PROMPT_VERSION,
          last_hit_at:    new Date()
        }, { onConflict: "hash" });
      } catch (e) {
        logger.debug?.(`[GroupGame] Cache-Insert Fehler: ${e.message}`);
      }
    })();

    // Kosten X1 (User-Anforderung "Kostenfaktor X1"):
    // (inTokens + outTokens) × 1.0 = credits — NICHT resp.billedCredits (×1.5 default)
    const realTokens = (resp.inTokens || 0) + (resp.outTokens || 0);
    const credits    = Math.ceil(realTokens * CLASSIFY_CREDIT_MULTIPLIER);

    logger.debug?.(`[GroupGame] Cache-MISS, AI klassifiziert hash ${hash.substring(0,8)}… (${isReal ? "echt" : "nonsense"}, in=${resp.inTokens} out=${resp.outTokens} = ${credits} Credits ×1.0)`);
    return {
      isReal,
      credits,
      tokens_in:  resp.inTokens  || 0,
      tokens_out: resp.outTokens || 0,
      usd:        resp.usd       || 0,
      model:      resp.model,
      cached:     false
    };
  },

  /**
   * Normalisiert Text für Cache-Lookup.
   * Lowercase + Whitespace-Collapse + Trim. Behält Punktuation und Emojis,
   * damit "hi!" und "hi" unterschiedliche Klassifikationen erhalten können.
   */
  _normalizeForCache(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  },

  /**
   * SHA-256 Hash, getrunkt auf 32 Hex-Chars (16 Bytes).
   * Kollisionsrate: ~10^-19 — praktisch null bei realistischem Datenvolumen.
   */
  _hashText(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex").substring(0, 32);
  },

  /**
   * Globale Lerncache-Statistik für UI-Anzeige.
   * @returns {Promise<{ totalEntries: number, totalHits: number, savedRatio: number }>}
   */
  async getClassificationStats(supabase_db) {
    try {
      const { data, count } = await supabase_db
        .from("ai_message_classifications")
        .select("hit_count", { count: "exact" })
        .eq("prompt_version", CLASSIFY_PROMPT_VERSION);
      const totalEntries = count || 0;
      const totalHits    = (data || []).reduce((sum, r) => sum + (r.hit_count || 0), 0);
      const savedRatio = totalHits > 0 ? (totalHits - totalEntries) / totalHits : 0;
      return { totalEntries, totalHits, savedRatio };
    } catch (e) {
      logger.warn?.(`[GroupGame] getClassificationStats: ${e.message}`);
      return { totalEntries: 0, totalHits: 0, savedRatio: 0 };
    }
  },

  /**
   * Channel-Credits direkt abbuchen (zusätzlich zum Log).
   */
  async _chargeCredits(supabase_db, chatId, credits, usd) {
    if (!credits) return;
    try {
      const rpc = await supabase_db.rpc("increment_channel_usage", {
        p_id: String(chatId), p_tokens: credits, p_usd: usd || 0
      });
      if (rpc.error) throw rpc.error;
    } catch {
      // Fallback ohne RPC
      try {
        const { data: cur } = await supabase_db.from("bot_channels")
          .select("token_used, usd_spent").eq("id", String(chatId)).maybeSingle();
        if (cur) {
          await supabase_db.from("bot_channels").update({
            token_used: (cur.token_used || 0) + credits,
            usd_spent:  parseFloat(((cur.usd_spent || 0) + (usd || 0)).toFixed(6))
          }).eq("id", String(chatId));
        }
      } catch (_) {}
    }
  },

  /**
   * Klassifiziert Punkte (Quality vs Smalltalk + Admin-Reply-Bonus).
   */
  async _classify(tg, msg, ch, chatId) {
    const text     = msg.text || msg.caption || "";
    const minChars = ch?.group_game_quality_min_chars || DEFAULT_QUALITY_MIN_CHARS;
    const isQuality = text.length >= minChars;
    let points     = isQuality ? 3 : 1;

    const repliedUser = msg.reply_to_message?.from;
    if (repliedUser && !repliedUser.is_bot && repliedUser.id !== msg.from.id) {
      const repliedIsAdmin = await this._isAdmin(tg, chatId, repliedUser.id);
      if (repliedIsAdmin) points = Math.max(points, 2);
    }
    return points;
  },

  /**
   * Prüft ob jetzt im konfigurierten Spielzeitraum.
   */
  _isInGamePeriod(ch) {
    const now = Date.now();
    if (ch.activity_game_starts_at && new Date(ch.activity_game_starts_at).getTime() > now) return false;
    if (ch.activity_game_ends_at   && new Date(ch.activity_game_ends_at).getTime()   < now) return false;
    return true;
  },

  /**
   * Admin-Check mit 5-Minuten Cache.
   */
  async _isAdmin(tg, chatId, userId) {
    const now    = Date.now();
    const cached = this._adminCache.get(chatId);
    if (cached && cached.expires > now) return cached.adminIds.has(userId);
    try {
      const admins = await tg.call("getChatAdministrators", { chat_id: chatId });
      const ids    = new Set((admins || []).map(a => a?.user?.id).filter(Boolean));
      this._adminCache.set(chatId, { adminIds: ids, expires: now + ADMIN_CACHE_TTL_MS });
      return ids.has(userId);
    } catch (e) {
      logger.debug?.(`[GroupGame] getChatAdministrators ${chatId}: ${e.message}`);
      return false;
    }
  },

  async _getLastPointAt(supabase_db, chatId, userId) {
    try {
      const { data } = await supabase_db.from("channel_user_points")
        .select("last_point_at")
        .eq("channel_id", chatId).eq("user_id", userId).maybeSingle();
      return data?.last_point_at ? new Date(data.last_point_at) : null;
    } catch (_) { return null; }
  },

  async _addPoints(supabase_db, chatId, userId, user, points) {
    try {
      const { data: existing } = await supabase_db.from("channel_user_points")
        .select("points, message_count")
        .eq("channel_id", chatId).eq("user_id", userId).maybeSingle();

      const now = new Date();
      const base = {
        username:      user.username   || null,
        first_name:    user.first_name || null,
        last_point_at: now,
        updated_at:    now
      };
      if (existing) {
        await supabase_db.from("channel_user_points")
          .update({
            ...base,
            points:        (existing.points || 0) + points,
            message_count: (existing.message_count || 0) + 1
          })
          .eq("channel_id", chatId).eq("user_id", userId);
      } else {
        await supabase_db.from("channel_user_points").insert({
          channel_id: chatId, user_id: userId,
          points, message_count: 1,
          created_at: now,
          ...base
        });
      }
    } catch (e) {
      logger.warn?.(`[GroupGame] _addPoints fehlgeschlagen: ${e.message}`);
    }
  },

  /**
   * Top-Liste (Admins gefiltert).
   */
  async getTopList(tg, supabase_db, chatId, limit = 10) {
    const cid = String(chatId);
    let candidates = [];
    try {
      const { data } = await supabase_db.from("channel_user_points")
        .select("user_id, username, first_name, points, message_count")
        .eq("channel_id", cid)
        .order("points", { ascending: false })
        .limit(50);
      candidates = data || [];
    } catch (e) {
      logger.warn?.(`[GroupGame] getTopList Fehler: ${e.message}`);
      return [];
    }
    const result = [];
    for (const u of candidates) {
      if (result.length >= limit) break;
      const isAdmin = await this._isAdmin(tg, cid, u.user_id);
      if (!isAdmin) result.push(u);
    }
    return result;
  },

  /**
   * Baut die Powered-By Zeile (oder leer) für Spiel-Outputs.
   * Escapes HTML-Special-Chars damit User-Input nicht ausführbar wird (XSS-Schutz).
   */
  _buildPoweredByLine(ch) {
    if (!ch?.activity_powered_by) return "";
    const safe = String(ch.activity_powered_by)
      .substring(0, 100)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (!safe.trim()) return "";
    return `\n\n✨ <i>${safe}</i>`;
  },

  /**
   * Baut den Text einer Top-Liste (mit Enddatum + Powered-By, wenn gesetzt).
   * Zentrale Funktion damit /top und Auto-Posting konsistent aussehen.
   */
  async buildTopText(tg, supabase_db, chatId, ch, limit = 10) {
    const top = await this.getTopList(tg, supabase_db, chatId, limit);

    let body;
    if (!top.length) {
      body = "Noch keine Punkte gesammelt — sei der/die Erste!";
    } else {
      body = top.map((u, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `<b>${i+1}.</b>`;
        const name  = this.formatUserName(u);
        return `${medal} ${name} — <b>${u.points}</b> Punkte`;
      }).join("\n");
    }

    // Spielende-Zeile anhängen wenn Enddatum gesetzt
    let endLine = "";
    if (ch?.activity_game_ends_at) {
      const dtStr = new Date(ch.activity_game_ends_at).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
      const msLeft = new Date(ch.activity_game_ends_at).getTime() - Date.now();
      const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
      const tail = daysLeft > 0
        ? ` <i>(noch ${daysLeft} ${daysLeft === 1 ? "Tag" : "Tage"})</i>`
        : "";
      endLine = `\n\n🏁 <b>Spielende:</b> ${dtStr} Uhr${tail}`;
    }

    return `🎮 <b>Top-Ranking</b>\n\n${body}${endLine}${this._buildPoweredByLine(ch)}`;
  },

  /**
   * Postet die Rangliste im Channel (regulär oder als finale Rangliste am Spielende).
   * @param {boolean} isFinal Wenn true: als FINALE Rangliste posten (Spiel endet).
   */
  async postRankingToChannel(tg, supabase_db, chatId, isFinal = false) {
    // Channel-Record für end_at + powered_by laden
    let ch = null;
    try {
      const { data } = await supabase_db.from("bot_channels")
        .select("activity_game_ends_at, activity_powered_by")
        .eq("id", String(chatId)).maybeSingle();
      ch = data;
    } catch (_) {}

    let text;
    if (isFinal) {
      const top = await this.getTopList(tg, supabase_db, chatId, 10);
      const body = top.length
        ? top.map((u, i) => {
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `<b>${i+1}.</b>`;
            const name  = this.formatUserName(u);
            return `${medal} ${name} — <b>${u.points}</b> Punkte`;
          }).join("\n")
        : "Noch keine Punkte gesammelt.";
      text = `🏆 <b>FINALES Ranking — Activity Tracker</b>\n` +
             `<i>Das Spiel wurde beendet!</i>\n\n${body}${this._buildPoweredByLine(ch)}`;
    } else {
      text = await this.buildTopText(tg, supabase_db, chatId, ch, 10);
    }

    try {
      await tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    } catch (e) {
      logger.warn?.(`[GroupGame] postRanking ${chatId}: ${e.message}`);
    }
  },

  /**
   * Postet die Spielstart-Mitteilung im Channel mit Befehlsübersicht.
   * Wird bei sofortigem Aktivieren ODER beim Erreichen von activity_game_starts_at gepostet.
   */
  async postGameStartMessage(tg, supabase_db, chatId, ch) {
    let endLine = "";
    if (ch?.activity_game_ends_at) {
      const dtStr = new Date(ch.activity_game_ends_at).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
      endLine = `\n🏁 <b>Spielende:</b> ${dtStr} Uhr\n<i>Bei Ablauf wird automatisch eine finale Rangliste gepostet.</i>`;
    } else {
      endLine = `\n♾ <i>Das Spiel läuft unbefristet, bis es manuell beendet wird.</i>`;
    }

    const text =
      `🎮 <b>Activity Tracker startet jetzt!</b>\n\n` +
      `Sammle Punkte durch aktive Teilnahme im Channel:\n` +
      `• 📝 Qualitäts-Nachricht (≥ 50 Zeichen): <b>+3</b>\n` +
      `• 💬 Kurze Nachricht / Smalltalk: <b>+1</b>\n` +
      `• 💭 Antwort auf eine Admin-Nachricht: mindestens <b>+2</b>\n\n` +
      `<b>Befehle:</b>\n` +
      `• <code>/top</code> — aktuelle Rangliste anzeigen\n` +
      `${endLine}\n\n` +
      `<i>Channel-Admins nehmen nicht teil. Cooldown: 30s pro User.</i>` +
      `${this._buildPoweredByLine(ch)}`;

    try {
      await tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    } catch (e) {
      logger.warn?.(`[GroupGame] postGameStartMessage ${chatId}: ${e.message}`);
    }
  },

  /**
   * Setzt das Ranking eines Channels zurück.
   */
  async resetChannelPoints(supabase_db, chatId) {
    try {
      const { error } = await supabase_db.from("channel_user_points")
        .delete().eq("channel_id", String(chatId));
      if (error) throw error;
      return true;
    } catch (e) {
      logger.warn?.(`[GroupGame] reset fehlgeschlagen: ${e.message}`);
      return false;
    }
  },

  /**
   * Holt ALLE Spieler eines Channels sortiert nach Punkten (Admins gefiltert).
   * Für die paginierte Spielerverwaltung im Admin-Menü.
   */
  async getAllPlayers(tg, supabase_db, chatId) {
    const cid = String(chatId);
    let candidates = [];
    try {
      const { data } = await supabase_db.from("channel_user_points")
        .select("user_id, username, first_name, points, message_count, last_point_at, created_at")
        .eq("channel_id", cid)
        .order("points", { ascending: false })
        .limit(500);
      candidates = data || [];
    } catch (e) {
      logger.warn?.(`[GroupGame] getAllPlayers Fehler: ${e.message}`);
      return [];
    }
    const result = [];
    for (const u of candidates) {
      const isAdmin = await this._isAdmin(tg, cid, u.user_id);
      if (!isAdmin) result.push(u);
    }
    return result;
  },

  /**
   * Holt einen einzelnen Spieler (oder null).
   */
  async getPlayer(supabase_db, chatId, userId) {
    try {
      const { data } = await supabase_db.from("channel_user_points")
        .select("user_id, username, first_name, points, message_count, last_point_at, created_at")
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId))
        .maybeSingle();
      return data || null;
    } catch (e) {
      logger.warn?.(`[GroupGame] getPlayer Fehler: ${e.message}`);
      return null;
    }
  },

  /**
   * Addiert/subtrahiert Punkte. Negative Werte werden auf 0 geclampt.
   */
  async adjustPlayerPoints(supabase_db, chatId, userId, delta) {
    try {
      const { data: cur } = await supabase_db.from("channel_user_points")
        .select("points")
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId))
        .maybeSingle();
      if (!cur) return false;
      const newPoints = Math.max(0, (cur.points || 0) + parseInt(delta));
      await supabase_db.from("channel_user_points")
        .update({ points: newPoints, updated_at: new Date() })
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId));
      return newPoints;
    } catch (e) {
      logger.warn?.(`[GroupGame] adjustPlayerPoints Fehler: ${e.message}`);
      return false;
    }
  },

  /**
   * Setzt Punkte direkt auf einen Wert (0..999999).
   */
  async setPlayerPoints(supabase_db, chatId, userId, points) {
    const newPoints = Math.max(0, Math.min(999999, parseInt(points) || 0));
    try {
      const { data: cur } = await supabase_db.from("channel_user_points")
        .select("points")
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId))
        .maybeSingle();
      if (!cur) return false;
      await supabase_db.from("channel_user_points")
        .update({ points: newPoints, updated_at: new Date() })
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId));
      return newPoints;
    } catch (e) {
      logger.warn?.(`[GroupGame] setPlayerPoints Fehler: ${e.message}`);
      return false;
    }
  },

  /**
   * Entfernt einen Spieler komplett aus dem Channel-Ranking.
   */
  async deletePlayer(supabase_db, chatId, userId) {
    try {
      const { error } = await supabase_db.from("channel_user_points")
        .delete()
        .eq("channel_id", String(chatId))
        .eq("user_id", parseInt(userId));
      if (error) throw error;
      return true;
    } catch (e) {
      logger.warn?.(`[GroupGame] deletePlayer Fehler: ${e.message}`);
      return false;
    }
  },

  /**
   * Scheduler-Runner: prüft Auto-Posting, Spiel-Ende und Spiel-Start für alle Channels.
   * Wird alle ~10 Minuten aufgerufen.
   */
  async runActivityRankings(tg, supabase_db) {
    let channels = [];
    try {
      const { data } = await supabase_db.from("bot_channels")
        .select("id, group_game_enabled, activity_ranking_interval_hours, activity_last_auto_ranking_at, activity_game_starts_at, activity_game_ends_at, activity_final_ranking_posted, activity_game_started_posted, activity_powered_by, is_active, is_approved")
        .eq("group_game_enabled", true)
        .eq("is_active", true);
      channels = data || [];
    } catch (e) {
      logger.warn?.(`[GroupGame] runActivityRankings DB: ${e.message}`);
      return;
    }

    const now = Date.now();
    for (const ch of channels) {
      // 1. Spielende erreicht? → Final-Ranking posten + Spiel deaktivieren
      if (ch.activity_game_ends_at
          && !ch.activity_final_ranking_posted
          && new Date(ch.activity_game_ends_at).getTime() <= now) {
        logger.info(`[GroupGame] ${ch.id}: Spielende erreicht — poste finale Rangliste`);
        await this.postRankingToChannel(tg, supabase_db, ch.id, true);
        try {
          await supabase_db.from("bot_channels").update({
            activity_final_ranking_posted: true,
            group_game_enabled: false
          }).eq("id", String(ch.id));
        } catch (_) {}
        continue;
      }

      // 2. Spielstart erreicht? → Start-Mitteilung posten (genau einmal)
      // Triggert wenn: enabled + noch nicht gepostet + start_at fehlt ODER ist erreicht
      //                + end_at fehlt ODER ist noch nicht erreicht
      const startReached = !ch.activity_game_starts_at
        || new Date(ch.activity_game_starts_at).getTime() <= now;
      const endNotReached = !ch.activity_game_ends_at
        || new Date(ch.activity_game_ends_at).getTime() > now;
      if (!ch.activity_game_started_posted && startReached && endNotReached) {
        logger.info(`[GroupGame] ${ch.id}: Spielstart erreicht — poste Start-Mitteilung`);
        await this.postGameStartMessage(tg, supabase_db, ch.id, ch);
        try {
          await supabase_db.from("bot_channels").update({
            activity_game_started_posted: true
          }).eq("id", String(ch.id));
        } catch (_) {}
        // Nicht continue → Auto-Posting könnte gleichzeitig fällig sein
      }

      // 3. Regelmäßiges Auto-Posting?
      const intervalH = parseInt(ch.activity_ranking_interval_hours) || 0;
      if (intervalH <= 0) continue;

      const lastMs = ch.activity_last_auto_ranking_at
        ? new Date(ch.activity_last_auto_ranking_at).getTime()
        : 0;
      const elapsedMs = now - lastMs;
      const intervalMs = intervalH * 3600 * 1000;
      if (elapsedMs < intervalMs) continue;

      logger.info(`[GroupGame] ${ch.id}: Auto-Ranking (alle ${intervalH}h)`);
      await this.postRankingToChannel(tg, supabase_db, ch.id, false);
      try {
        await supabase_db.from("bot_channels").update({
          activity_last_auto_ranking_at: new Date()
        }).eq("id", String(ch.id));
      } catch (_) {}
    }
  },

  invalidateAdminCache(chatId) {
    this._adminCache.delete(String(chatId));
  },

  /**
   * HTML-escaped Anzeige-Name (Username bevorzugt, dann Vorname).
   */
  formatUserName(u) {
    const escape = (s) => String(s || "").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    if (u.username)   return `@${escape(u.username)}`;
    if (u.first_name) return escape(u.first_name);
    return `User ${u.user_id}`;
  }
};

module.exports = groupGameService;
