/**
 * quietHoursService.js v1.5.45
 * ----------------------------------------------------------------------------
 * Nachtruhe-Funktion: Setzt/hebt die Schreibsperre für einen Channel zur
 * konfigurierten Zeit. Erzeugt variierende Ankündigungs-Nachrichten via GPT
 * und cached sie in `cached_bot_texts`.
 *
 * Ablauf:
 *   1. Server-Scheduler ruft `runQuietHoursCheck(tg, supabase, token)` jede
 *      Minute auf.
 *   2. Funktion lädt alle Channels mit konfigurierter Nachtruhe.
 *   3. Prüft für jeden Channel ob Start oder Ende jetzt fällig ist.
 *   4. Setzt/hebt via `restrictChatMember` + Telegram
 *      `setChatPermissions` die Schreibsperre.
 *   5. Schickt eine zufällige Variante der Ankündigung in den Channel.
 *
 * Text-Caching:
 *   - Beim ersten Aufruf einer Kategorie wird GPT für 6 Variationen gebeten.
 *   - Ergebnis wird in `cached_bot_texts` gespeichert.
 *   - Jeder weitere Aufruf wählt per Zufall eine der gespeicherten Texte.
 *   - Kein erneuter API-Call außer beim ersten Mal.
 * ----------------------------------------------------------------------------
 */

const axios = require("axios");
const logger = require("../../utils/logger");

// Anzahl Variationen die GPT pro Kategorie erzeugen soll
const VARIANTS_COUNT = 6;

// ─── Text-Definitionen ──────────────────────────────────────────────────────
// Prompt-Vorlagen für GPT.  {start} / {end} werden durch die konfigurierten
// Zeiten ersetzt bevor der Prompt an GPT geht.
const TEXT_PROMPTS = {
  quiet_start: (start, end, lang) =>
    `Erstelle ${VARIANTS_COUNT} freundliche, kurze Nachrichten für eine Telegram-Gruppe, ` +
    `die ankündigen dass jetzt die Nachtruhe beginnt und bis ${end} Uhr eine Schreibpause gilt. ` +
    `Ton: entspannt, einladend, freundlich — nicht schulmeisternd. ` +
    `Gerne mit passendem Emoji. Jede Variante maximal 2 Sätze. ` +
    `Sprache: ${lang === "de" ? "Deutsch" : lang}. ` +
    `Antworte NUR mit einem JSON-Array von ${VARIANTS_COUNT} Strings, ohne weitere Erklärung. ` +
    `Beispiel-Format: ["Text 1", "Text 2", ...]`,

  quiet_end: (start, end, lang) =>
    `Erstelle ${VARIANTS_COUNT} freundliche, kurze Nachrichten für eine Telegram-Gruppe, ` +
    `die ankündigen dass die Nachtruhe (seit ${start} Uhr) jetzt vorbei ist und ` +
    `alle wieder schreiben dürfen. ` +
    `Ton: fröhlich, begrüßend, energetisch. Gerne mit passendem Emoji. ` +
    `Jede Variante maximal 2 Sätze. ` +
    `Sprache: ${lang === "de" ? "Deutsch" : lang}. ` +
    `Antworte NUR mit einem JSON-Array von ${VARIANTS_COUNT} Strings, ohne weitere Erklärung. ` +
    `Beispiel-Format: ["Text 1", "Text 2", ...]`,
};

// ─── Timezone-Hilfsfunktionen ────────────────────────────────────────────────

/**
 * Gibt die aktuelle Ortszeit als "HH:MM"-String zurück, passend zur
 * angegebenen IANA-Timezone (z.B. "Europe/Berlin").
 * Fällt auf UTC zurück wenn die Timezone nicht erkannt wird.
 */
function _localHHMM(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("de-DE", {
      timeZone: tz || "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    const h = parts.find(p => p.type === "hour")?.value || "00";
    const m = parts.find(p => p.type === "minute")?.value || "00";
    return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  } catch {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2,"0")}:${String(now.getUTCMinutes()).padStart(2,"0")}`;
  }
}

/**
 * Vergleicht zwei "HH:MM"-Strings direkt.
 * Bei Zeitfenstern über Mitternacht (start > end) wird das korrekt behandelt.
 */
function _isInQuietWindow(start, end, current) {
  if (!start || !end || !current) return false;
  if (start < end) {
    // Normales Fenster z.B. 22:00 - 08:00 … nein, 22:00 > 08:00 wäre overnight
    return current >= start && current < end;
  }
  // Overnight: start=22:00, end=08:00
  return current >= start || current < end;
}

/**
 * Prüft ob HH:MM exakt in der aktuellen Minute liegt.
 * (Wir prüfen nur die Minuten-Granularität, da der Scheduler minütlich läuft)
 */
function _matchesNow(hhmm, tz) {
  return _localHHMM(tz) === hhmm;
}

// ─── Text-Caching ───────────────────────────────────────────────────────────

/**
 * Holt eine zufällige Text-Variante für `category` aus dem Cache.
 * Wenn noch kein Cache existiert, wird er via GPT befüllt.
 *
 * @param {object} supabase_db
 * @param {string} category   "quiet_start" | "quiet_end"
 * @param {object} ch         Channel-Objekt (für start/end/lang)
 * @returns {Promise<string>} Fertige Nachricht
 */
async function getVariantText(supabase_db, category, ch) {
  const lang = ch?.bot_language || "de";
  const chanId = ch?.id ? String(ch.id) : null;
  const start = ch?.quiet_start || "22:00";
  const end   = ch?.quiet_end   || "08:00";

  // Cache-Lookup — zuerst channel-spezifisch, dann global
  let cached = null;
  try {
    const { data } = await supabase_db.from("cached_bot_texts")
      .select("variants")
      .eq("category", category)
      .eq("lang", lang)
      .eq("channel_id", chanId)
      .maybeSingle();
    cached = data;
  } catch (_) {}

  if (!cached) {
    // Globalen Fallback versuchen (channel_id IS NULL)
    try {
      const { data } = await supabase_db.from("cached_bot_texts")
        .select("variants")
        .eq("category", category)
        .eq("lang", lang)
        .is("channel_id", null)
        .maybeSingle();
      if (data) cached = data;
    } catch (_) {}
  }

  if (cached?.variants?.length) {
    // Zufällige Variante aus dem Cache
    const variants = Array.isArray(cached.variants)
      ? cached.variants
      : JSON.parse(cached.variants);
    return variants[Math.floor(Math.random() * variants.length)];
  }

  // Kein Cache → GPT befragen
  logger.info(`[QuietHours] Generiere Texte für ${category}/${lang}...`);
  const promptFn = TEXT_PROMPTS[category];
  if (!promptFn) return _getFallbackText(category, start, end);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("[QuietHours] OPENAI_API_KEY fehlt, verwende Fallback-Texte.");
    return _getFallbackText(category, start, end);
  }

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 600,
        temperature: 0.9,
        messages: [
          { role: "user", content: promptFn(start, end, lang) }
        ]
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 20000 }
    );

    const content = resp.data?.choices?.[0]?.message?.content?.trim() || "";
    let variants;
    try {
      // GPT-Antwort als JSON-Array parsen
      const cleaned = content.replace(/```json|```/g, "").trim();
      variants = JSON.parse(cleaned);
      if (!Array.isArray(variants) || !variants.length) throw new Error("kein Array");
      variants = variants.filter(v => typeof v === "string" && v.trim()).slice(0, VARIANTS_COUNT);
    } catch {
      // Fallback: zeilenweise trennen
      variants = content.split("\n").map(l => l.replace(/^[\d\-•*."]+\s*/, "").trim()).filter(l => l.length > 5).slice(0, VARIANTS_COUNT);
    }

    if (!variants.length) {
      return _getFallbackText(category, start, end);
    }

    // In DB cachen
    try {
      await supabase_db.from("cached_bot_texts").upsert([{
        category, lang,
        channel_id: chanId,
        variants: JSON.stringify(variants),
        generated_at: new Date().toISOString()
      }], { onConflict: "category,lang,channel_id" });
    } catch (e) {
      logger.warn(`[QuietHours] Cache-Insert fehlgeschlagen: ${e.message}`);
    }

    return variants[Math.floor(Math.random() * variants.length)];

  } catch (e) {
    logger.warn(`[QuietHours] GPT-Fehler: ${e.message}`);
    return _getFallbackText(category, start, end);
  }
}

/**
 * Hardcoded Fallback-Texte, falls GPT nicht verfügbar ist.
 */
function _getFallbackText(category, start, end) {
  if (category === "quiet_start") {
    const variants = [
      `🌙 Gute Nacht! Ab jetzt gilt bis ${end} Uhr eine kurze Schreibpause — bis gleich!`,
      `😴 Die Nachtruhe beginnt. Wir sehen uns um ${end} Uhr wieder, schlaft gut!`,
      `🌛 Stille Zeit! Schreibpause bis ${end} Uhr. Gute Nacht zusammen! 💫`,
      `🌜 Wir machen eine Pause bis ${end} Uhr. Erholt euch, bis bald!`,
      `🔕 Ruhemodus aktiv bis ${end} Uhr. Gute Nacht und bis morgen! 🌙`,
      `💤 Nachtruhe von ${start} bis ${end} Uhr. Kommt morgen ausgeruht wieder!`,
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  const variants = [
    `☀️ Guten Morgen! Die Schreibpause ist vorbei — herzlich willkommen zurück!`,
    `🌤 Die Nachtruhe ist beendet. Jetzt kann wieder geschrieben werden, guten Morgen!`,
    `🌅 Aufgewacht! Ab jetzt ist der Chat wieder offen. Schönen Tag!`,
    `🎉 Der Chat ist wieder aktiv! Guten Morgen zusammen!`,
    `☀️ Nachtruhe vorbei — wir freuen uns auf euch! Guten Morgen!`,
    `🌞 Willkommen zurück! Die Schreibpause ist beendet.`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

// ─── Schreibsperre-Aktionen ─────────────────────────────────────────────────

/**
 * Setzt die Schreibsperre für den Channel (alle User stummschalten via
 * setChatPermissions). Sends Ankündigungs-Nachricht.
 */
async function activateQuietHours(tg, supabase_db, ch) {
  const chatId = ch.id;
  try {
    await tg.call("setChatPermissions", {
      chat_id: chatId,
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    });
  } catch (e) {
    logger.warn(`[QuietHours] setChatPermissions (restrict) fehlgeschlagen für ${chatId}: ${e.message}`);
    return; // Wenn wir nicht schreiben können, keine Ankündigung
  }

  // DB-Flag setzen
  try {
    await supabase_db.from("bot_channels")
      .update({ quiet_active: true })
      .eq("id", String(chatId));
  } catch (_) {}

  // Ankündigung senden
  try {
    const text = await getVariantText(supabase_db, "quiet_start", ch);
    await tg.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
  } catch (e) {
    logger.warn(`[QuietHours] Ankündigung (start) fehlgeschlagen: ${e.message}`);
  }
}

/**
 * Hebt die Schreibsperre wieder auf. Sends Willkommens-Nachricht.
 */
async function deactivateQuietHours(tg, supabase_db, ch) {
  const chatId = ch.id;
  try {
    await tg.call("setChatPermissions", {
      chat_id: chatId,
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    });
  } catch (e) {
    logger.warn(`[QuietHours] setChatPermissions (restore) fehlgeschlagen für ${chatId}: ${e.message}`);
    return;
  }

  // DB-Flag löschen
  try {
    await supabase_db.from("bot_channels")
      .update({ quiet_active: false })
      .eq("id", String(chatId));
  } catch (_) {}

  // Willkommensnachricht
  try {
    const text = await getVariantText(supabase_db, "quiet_end", ch);
    await tg.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
  } catch (e) {
    logger.warn(`[QuietHours] Ankündigung (end) fehlgeschlagen: ${e.message}`);
  }
}

// ─── Haupt-Scheduler-Funktion ────────────────────────────────────────────────

/**
 * Wird vom Server-Scheduler jede Minute aufgerufen.
 * Prüft alle Channels mit Nachtruhe-Konfiguration.
 */
async function runQuietHoursCheck(tg, supabase_db) {
  let channels = [];
  try {
    const { data } = await supabase_db.from("bot_channels")
      .select("id, title, quiet_start, quiet_end, quiet_tz, quiet_mode, quiet_allow_scheduled, quiet_active, bot_language, is_active, is_approved")
      .not("quiet_start", "is", null)
      .not("quiet_end", "is", null)
      .eq("is_active", true)
      .eq("is_approved", true);
    channels = data || [];
  } catch (e) {
    logger.warn(`[QuietHours] DB-Abfrage fehlgeschlagen: ${e.message}`);
    return;
  }

  for (const ch of channels) {
    const tz = ch.quiet_tz || "Europe/Berlin";
    const current = _localHHMM(tz);
    const { quiet_start: start, quiet_end: end, quiet_active: isActive } = ch;
    const isStarsMode = ch.quiet_mode === "stars";

    const shouldBeActive = _isInQuietWindow(start, end, current);
    const startNow = _matchesNow(start, tz);
    const endNow   = _matchesNow(end, tz);

    if (startNow && !isActive) {
      // Nachtruhe beginnt jetzt
      logger.info(`[QuietHours] START für Channel ${ch.id} (${ch.title}) um ${current}`);
      await activateQuietHours(tg, supabase_db, ch);
    } else if (endNow && isActive) {
      // Nachtruhe-Endzeit ist erreicht
      if (isStarsMode) {
        // STARS-MODUS: Endzeit ignorieren — Nachtruhe endet erst wenn Admin
        // den Sterne-Preis manuell auf 0 setzt (paid_message_price_changed Trigger)
        logger.info(`[QuietHours] Endzeit erreicht für ${ch.id} (Stars-Modus) — warte auf Preis=0 Trigger`);
      } else {
        // LOCK-MODUS: normal beenden
        logger.info(`[QuietHours] END für Channel ${ch.id} (${ch.title}) um ${current}`);
        await deactivateQuietHours(tg, supabase_db, ch);
      }
    } else if (!shouldBeActive && isActive && !endNow) {
      // Inkonsistenz: DB sagt aktiv, Zeit sagt inaktiv
      if (isStarsMode) {
        // Stars-Modus: legitimer Zustand — Endzeit ist vorbei, aber Admin hat
        // den Preis noch nicht auf 0 gesetzt → Nachtruhe bleibt aktiv.
        // KEINE Auto-Bereinigung hier.
      } else {
        // Lock-Modus: Schreibsperre leise aufheben ohne Ankündigung
        logger.info(`[QuietHours] Inkonsistenz behoben für ${ch.id} — deaktiviere`);
        try {
          await tg.call("setChatPermissions", {
            chat_id: ch.id,
            permissions: {
              can_send_messages: true, can_send_audios: true, can_send_documents: true,
              can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
              can_send_voice_notes: true, can_send_polls: true,
              can_send_other_messages: true, can_add_web_page_previews: true
            }
          });
          await supabase_db.from("bot_channels").update({ quiet_active: false }).eq("id", String(ch.id));
        } catch (_) {}
      }
    } else if (shouldBeActive && !isActive && !startNow) {
      // Inkonsistenz: Zeit sagt aktiv, DB sagt inaktiv (z.B. nach Neustart)
      // Schreibsperre leise setzen ohne Ankündigung
      logger.info(`[QuietHours] Inkonsistenz behoben für ${ch.id} — aktiviere`);
      try {
        await tg.call("setChatPermissions", {
          chat_id: ch.id,
          permissions: {
            can_send_messages: false, can_send_audios: false, can_send_documents: false,
            can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
            can_send_voice_notes: false, can_send_polls: false,
            can_send_other_messages: false, can_add_web_page_previews: false
          }
        });
        await supabase_db.from("bot_channels").update({ quiet_active: true }).eq("id", String(ch.id));
      } catch (_) {}
    }
  }
}

/**
 * Reagiert auf Telegrams Service-Nachricht "Preis für Nachrichten geändert"
 * (paid_message_price_changed). Wird ausgelöst wenn ein Admin in den
 * Gruppeneinstellungen "Sterne pro Nachricht" aktiviert/ändert/deaktiviert.
 *
 * Ablauf während aktiver Stars-Nachtruhe:
 *
 *   Preis > 0 (Stars aktiviert):
 *     1. Schreibsperre aufheben — User können wieder schreiben
 *     2. Telegrams System-Meldung löschen
 *     3. Eigene Bestätigung senden: "Ihr könnt jetzt für nur X Sterne
 *        pro Nachricht schreiben."
 *     4. Sterne-Preis in DB persistieren
 *
 *   Preis = 0 (Stars deaktiviert):
 *     → Das ist das offizielle ENDE der Nachtruhe in Stars-Modus.
 *     1. Schreibsperre aufheben (falls noch aktiv)
 *     2. Telegrams System-Meldung löschen
 *     3. quiet_end-Ankündigung senden ("Nachtruhe beendet")
 *     4. quiet_active = false in DB
 *
 * @returns {boolean} true wenn als Trigger verarbeitet, false sonst
 */
async function handleStarsPriceChanged(tg, supabase_db, msg) {
  const chatId = String(msg.chat?.id);
  if (!chatId) return false;

  // Preis aus Service-Nachricht extrahieren — Bot API kann das Feld auf
  // verschiedene Arten benennen, daher defensive Auswertung:
  const newPrice =
    msg.paid_message_price_changed?.paid_message_star_count ??
    msg.paid_message_price_changed?.star_count ??
    msg.paid_message_price_changed?.amount ??
    0;

  // Channel-State aus DB laden (alle Felder für deactivateQuietHours nötig)
  let ch;
  try {
    const { data } = await supabase_db.from("bot_channels")
      .select("id, title, quiet_active, quiet_mode, quiet_start, quiet_end, quiet_tz, bot_language")
      .eq("id", chatId).maybeSingle();
    ch = data;
  } catch (e) {
    logger.warn(`[QuietStars] DB-Abfrage fehlgeschlagen für ${chatId}: ${e.message}`);
    return false;
  }

  // Nur reagieren wenn Nachtruhe aktiv UND quiet_mode === "stars"
  if (!ch?.quiet_active || ch?.quiet_mode !== "stars") return false;

  // ── Fall A: Preis = 0 → Nachtruhe ENDEN ───────────────────────────────────
  if (!newPrice || newPrice <= 0) {
    logger.info(`[QuietStars] ${chatId}: Preis auf 0 — Nachtruhe wird beendet.`);

    // 1. Telegram-Systemnachricht löschen (Preisänderung-Ankündigung)
    await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id })
      .catch(e => logger.debug?.(`[QuietStars] deleteMessage: ${e.message}`));

    // 2. Schreibsperre aufheben (falls noch aktiv)
    try {
      await tg.call("setChatPermissions", {
        chat_id: chatId,
        permissions: {
          can_send_messages: true, can_send_audios: true, can_send_documents: true,
          can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
          can_send_voice_notes: true, can_send_polls: true,
          can_send_other_messages: true, can_add_web_page_previews: true
        }
      });
    } catch (e) {
      logger.warn(`[QuietStars] setChatPermissions (unlock final) fehlgeschlagen für ${chatId}: ${e.message}`);
    }

    // 3. DB: Nachtruhe beenden + Sterne-Preis zurücksetzen
    try {
      await supabase_db.from("bot_channels")
        .update({ quiet_active: false, quiet_stars_amount: 0 })
        .eq("id", chatId);
    } catch (_) {}

    // 4. "Nachtruhe beendet"-Ankündigung senden
    try {
      const text = await getVariantText(supabase_db, "quiet_end", ch);
      await tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    } catch (e) {
      logger.warn(`[QuietStars] quiet_end-Ankündigung fehlgeschlagen: ${e.message}`);
    }

    return true;
  }

  // ── Fall B: Preis > 0 → Stars aktivieren (Schreibsperre auf) ──────────────
  // 1. Schreibsperre aufheben
  try {
    await tg.call("setChatPermissions", {
      chat_id: chatId,
      permissions: {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true,
        can_send_other_messages: true, can_add_web_page_previews: true
      }
    });
  } catch (e) {
    logger.warn(`[QuietStars] setChatPermissions (unlock) fehlgeschlagen für ${chatId}: ${e.message}`);
    return false;
  }

  // 2. Telegram-Systemnachricht löschen
  await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id })
    .catch(e => logger.debug?.(`[QuietStars] deleteMessage: ${e.message}`));

  // 3. Eigene Stars-Bestätigung senden
  const text = `⭐ Ihr könnt jetzt für nur <b>${newPrice} Stern${newPrice !== 1 ? "e" : ""} pro Nachricht</b> schreiben.`;
  try {
    await tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  } catch (e) {
    logger.warn(`[QuietStars] sendMessage fehlgeschlagen für ${chatId}: ${e.message}`);
  }

  // 4. Sterne-Preis in DB persistieren
  try {
    await supabase_db.from("bot_channels")
      .update({ quiet_stars_amount: newPrice })
      .eq("id", chatId);
  } catch (_) {}

  logger.info(`[QuietStars] ${chatId}: ${newPrice} Stars aktiviert, Schreibsperre aufgehoben.`);
  return true;
}

module.exports = {
  runQuietHoursCheck,
  getVariantText,
  activateQuietHours,
  deactivateQuietHours,
  handleStarsPriceChanged,
  _localHHMM,
  _isInQuietWindow,
  _matchesNow,
  _getFallbackText,
};
