/**
 * i18n.js v1.5.38
 * ----------------------------------------------------------------------------
 * Echtes Translation-Tool für den AdminHelper-Bot.
 *
 * Konzept:
 *   • Eine einzige Source of Truth in DEUTSCH (Object T_DE unten).
 *   • Alle anderen Sprachen werden zur Laufzeit via DeepSeek-API übersetzt.
 *   • Persistenter Cache in der Tabelle `translation_cache` (Supabase).
 *   • In-Memory-Cache für O(1) Lookups nach dem Preload.
 *   • `t(key, lang, params)` ist synchron (Telegram-Pfade müssen nicht warten).
 *     Fehlt eine Übersetzung im Cache, wird der deutsche Originaltext sofort
 *     zurückgegeben und parallel im Hintergrund eine Übersetzung erzeugt
 *     (Stale-while-revalidate). Beim nächsten Aufruf ist sie dann da.
 *   • `preloadTranslations()` füllt den Cache beim Server-Start.
 *
 * Platzhalter-Konvention:
 *   Strings enthalten Platzhalter in der Form `{name}`.
 *   Die Übersetzungs-API wird angewiesen, Platzhalter unverändert zu lassen.
 * ----------------------------------------------------------------------------
 */

const axios = require("axios");
const supabase = require("../config/supabase");
const { deepseek } = require("../config/env");
const logger = require("../utils/logger");

// ─── Sprachen ───────────────────────────────────────────────────────────────
const SUPPORTED_LANGUAGES = {
  de: "🇩🇪 Deutsch",
  en: "🇬🇧 English",
  es: "🇪🇸 Español",
  zh: "🇨🇳 中文",
  ar: "🇸🇦 العربية",
  fr: "🇫🇷 Français",
  ru: "🇷🇺 Русский",
  tr: "🇹🇷 Türkçe",
};

const LANG_NAMES = {
  en: "English",
  es: "Spanish",
  zh: "Simplified Chinese",
  ar: "Arabic",
  fr: "French",
  ru: "Russian",
  tr: "Turkish",
};

// ─── Source of Truth: ALLE Texte in Deutsch ──────────────────────────────────
// Sammelt alle bisher in den lokalen DICTs verstreuten Strings an einem Ort.
const T_DE = {
  // ── Allgemeine Status & Buttons ────────────────────────────────────────────
  status_approved: "🟢 Freigeschaltet",
  status_pending: "🔴 Ausstehend",
  ai_active: "✅ Aktiv",
  ai_inactive: "❌ Inaktiv",
  choose_action: "Wähle was du verwalten möchtest:",
  back: "◀️ Zurück",
  main_menu: "◀️ Hauptmenü",
  cancel: "❌ Abbrechen",

  // ── Welcome (Privat-Chat /start) ───────────────────────────────────────────
  welcome_intro: "👋 Hallo{name}!\n\nFüge mich als Admin zu deinem Channel/Gruppe hinzu und schreibe dann /start hier.\n\nBefehle: /menu · /settings · /dashboard · /help",

  // ── Sprache wählen ─────────────────────────────────────────────────────────
  language_menu: "🌐 <b>Bot-Sprache wählen</b>\n\nWähle die Sprache für Menüs und Nachrichten in diesem Channel:",
  language_set: "✅ Sprache auf {lang} gesetzt.",
  btn_language: "🌐 Sprache",

  // ── Tagesbericht ───────────────────────────────────────────────────────────
  summary_creating: "⏳ Erstelle Tageszusammenfassung… (~{est} Token)",
  summary_cooldown: "⏳ Tageszusammenfassung nur 1x pro 24h.\nNächste möglich um {nextAt}.",

  // ── Settings-Hauptmenü ─────────────────────────────────────────────────────
  settings_title: "⚙️ <b>{name}</b>\n\nKI: {ai} | Safelist: {sl} | Feedback: {fb}\n\nWähle eine Kategorie:",
  settings_ch: "📋 Channel-Einstellungen",
  settings_mod: "🔒 Moderation",
  settings_ai: "🤖 AI Features",

  // ── Channel-Untermenü ──────────────────────────────────────────────────────
  ch_title: "📋 <b>Channel-Einstellungen</b> — {name}",
  ch_welcome: "👋 Willkommen",
  ch_goodbye: "👋 Abschied",
  ch_schedule: "📅 Zeitplan",
  ch_repeat: "🔁 Wiederholungen",
  ch_clean: "🧹 Bereinigen",
  ch_stats: "📊 Statistik",

  // ── Moderation-Untermenü ───────────────────────────────────────────────────
  mod_title: "🔒 <b>Moderation</b> — {name}",
  mod_locked: "🔒 <b>Moderation</b> — Gesperrt\n\nDein Kanal ist noch nicht verifiziert.\nBitte melde dich bei @autoacts für die Freischaltung.",
  mod_safelist: "🛡 Safelist {sl}",
  mod_feedback: "💬 Feedback {fb}",
  mod_blacklist: "🚫 Blacklist",
  mod_userinfo: "🔍 UserInfo",
  mod_banned: "🚫 Gebannte User",
  mod_fb_mgr: "👤 User-Feedbacks verwalten",

  // ── AI-Features-Untermenü ──────────────────────────────────────────────────
  ai_title: "🤖 <b>AI Features</b> — {name}",
  ai_locked: "🤖 <b>AI Features</b> — Gesperrt\n\nNutze <b>/buy</b> um ein Paket zu kaufen.",
  ai_daily: "📰 Tagesbericht",
  ai_smalltalk: "💬 Smalltalk AI",
  ai_kb: "📚 Wissensdatenbank",
  ai_adwriter: "✍️ WerbeTexter",
  ai_blacklist: "🤖 Blacklist Enhancer 🔒",
  ai_groupgames: "🎮 Gruppenspiele 🔜",
  ai_groupgames_info: "🎮 <b>Gruppenspiele</b>\n\n<i>Dieses Feature wird bald verfügbar!</i>\n\nGruppenspiele aktivieren deine Community:\n\n• 🎯 Quiz-Runden mit Auswertung\n• 🃏 Wortspiele & Rätsel\n• 🏆 Ranglisten & Punkte-System\n• 🎲 Mini-Games\n\nUpdates: @autoacts",

  // ── AdminHelper-Schnellmenü (tgAdminHelper) ────────────────────────────────
  ah_menu: "⚙️ <b>Admin-Menü</b>\nWähle eine Funktion:",
  ah_clean: "🧹 Gelöschte Accounts entfernen",
  ah_pin: "📌 Nachricht pinnen",
  ah_count: "📋 Mitglieder-Anzahl",
  ah_del_last: "🗑 Letzte Nachricht löschen",
  ah_sched: "⏰ Geplante Nachrichten",
  ah_safe: "🛡 Safelist verwalten",
  ah_no_admin: "❌ Nur für Admins.",
  ah_clean_res: "🧹 Ergebnis: {checked} Mitglieder geprüft, {removed} gelöschte Accounts entfernt.",
  ah_count_res: "👥 Aktuelle Mitgliederzahl: <b>{count}</b>",
  ah_pin_ok: "📌 Nachricht angeheftet!",
  ah_pin_err: "Antworte auf die Nachricht die gepinnt werden soll mit /pin",
  ah_sched_none: "⏰ Keine geplanten Nachrichten.\n\nNutze das Dashboard um Nachrichten zu planen.",
  ah_sched_list: "⏰ <b>Geplante Nachrichten:</b>\n{list}",

  // ── Common Action-Texte ────────────────────────────────────────────────────
  no_permission: "❌ Keine Berechtigung für diesen Channel.",
  saved: "✅ Gespeichert",
  removed: "✅ Entfernt",
  updated: "✅ Aktualisiert",

  // ── Blacklist-Durchsetzung ─────────────────────────────────────────────────
  bl_warn_msg: "⚠️ <b>Blacklist Wort erkannt!</b>\nKonsequenzen werden durchgeführt…",
  bl_action_deleted: "Nachricht gelöscht",
  bl_action_muted: "Stummgeschaltet ({hours}h)",
  bl_action_banned: "Gebannt",
  bl_action_none: "Keine Aktion",
  bl_admin_alert: "🛡 <b>Blacklist-Eingriff</b>\n\nGruppe/Kanal: {channel}\nUser: {user}\nWort: <code>{word}</code>\nAktionen: {actions}\n\nNachricht:\n<i>{text}</i>",
};

// ─── In-Memory-Cache: Map<lang, Map<key, value>> ────────────────────────────
const memCache = new Map();
memCache.set("de", new Map(Object.entries(T_DE)));

// Tracking, welche Übersetzungen gerade im Hintergrund laufen, damit wir nicht
// dieselbe Übersetzung 100x parallel triggern.
const inFlight = new Set(); // "key|lang"

// ─── DB-Helper: Cache lesen / schreiben ─────────────────────────────────────
async function _loadFromDb() {
  try {
    const { data, error } = await supabase
      .from("translation_cache")
      .select("source_key, target_lang, translated_text");
    if (error) {
      logger.warn(`[i18n] DB-Cache laden fehlgeschlagen: ${error.message}`);
      return 0;
    }
    let n = 0;
    for (const row of data || []) {
      if (!memCache.has(row.target_lang)) memCache.set(row.target_lang, new Map());
      memCache.get(row.target_lang).set(row.source_key, row.translated_text);
      n++;
    }
    return n;
  } catch (e) {
    logger.warn(`[i18n] DB-Cache laden fehlgeschlagen: ${e.message}`);
    return 0;
  }
}

async function _saveToDb(key, lang, text, sourceText) {
  try {
    await supabase.from("translation_cache").upsert(
      {
        source_key: key,
        target_lang: lang,
        source_text: sourceText,
        translated_text: text,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_key,target_lang" }
    );
  } catch (e) {
    logger.warn(`[i18n] DB-Cache speichern fehlgeschlagen: ${e.message}`);
  }
}

async function _invalidateForKey(key) {
  // Wenn der deutsche Source-String sich geändert hat, müssen alte
  // Übersetzungen verworfen werden.
  try {
    await supabase.from("translation_cache").delete().eq("source_key", key);
  } catch (e) {}
  for (const [lang, langMap] of memCache.entries()) {
    if (lang !== "de") langMap.delete(key);
  }
}

// ─── DeepSeek-Aufruf zum Übersetzen ─────────────────────────────────────────
async function _translate(text, targetLang) {
  if (!deepseek?.apiKey) {
    logger.warn("[i18n] DEEPSEEK_API_KEY fehlt – keine Übersetzungen möglich.");
    return null;
  }

  const langName = LANG_NAMES[targetLang] || targetLang;
  const sys =
    `You are a precise translator for a Telegram bot UI. ` +
    `Translate the user's German text into ${langName}.\n` +
    `STRICT RULES:\n` +
    `1) Keep ALL placeholders like {name}, {count}, {est} EXACTLY as-is.\n` +
    `2) Keep ALL HTML tags (<b>, <i>, <code>) and emojis exactly.\n` +
    `3) Keep newlines (\\n) at the same positions.\n` +
    `4) Output ONLY the translation – no quotes, no notes, no explanations.`;

  try {
    const r = await axios.post(
      `${deepseek.baseUrl}/v1/chat/completions`,
      {
        model: "deepseek-chat",
        max_tokens: 500,
        temperature: 0.1,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${deepseek.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 25000,
      }
    );
    let out = r.data?.choices?.[0]?.message?.content?.trim() || null;
    if (!out) return null;
    // Leading/trailing quotes wegtrimmen, falls das Modell sie doch ausgibt
    out = out.replace(/^["'`]+|["'`]+$/g, "").trim();
    return out;
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    logger.warn(`[i18n] DeepSeek-Übersetzung (${targetLang}) fehlgeschlagen: ${msg}`);
    return null;
  }
}

async function _translateAndCache(key, lang) {
  const flightKey = `${key}|${lang}`;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  try {
    const sourceText = T_DE[key];
    if (typeof sourceText !== "string") return; // nur Strings übersetzen
    const translated = await _translate(sourceText, lang);
    if (translated) {
      if (!memCache.has(lang)) memCache.set(lang, new Map());
      memCache.get(lang).set(key, translated);
      await _saveToDb(key, lang, translated, sourceText);
    }
  } finally {
    inFlight.delete(flightKey);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Synchroner Lookup. Gibt sofort den übersetzten String zurück, falls im
 * Cache. Ansonsten Fallback auf Deutsch und Übersetzung im Hintergrund.
 *
 * @param {string} key   - Schlüssel aus T_DE
 * @param {string} lang  - z.B. "en", "ru" oder "en-US"
 * @param {object} [params] - optionales Object mit Werten für {placeholder}
 */
function t(key, lang, params) {
  const langCode = String(lang || "de").split("-")[0].toLowerCase();
  const fallback = T_DE[key];
  if (fallback === undefined) return key;

  let val;
  if (langCode === "de") {
    val = fallback;
  } else {
    val = memCache.get(langCode)?.get(key);
    if (val === undefined) {
      // Cache-Miss: Hintergrund-Übersetzung anstoßen, sofort Deutsch liefern
      void _translateAndCache(key, langCode);
      val = fallback;
    }
  }

  // Platzhalter-Substitution (akzeptiert sowohl Object als auch positional)
  if (typeof val === "string" && params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp("\\{" + k + "\\}", "g"), String(v ?? ""));
    }
  }
  return val;
}

/**
 * Async-Variante. Wartet auf eine echte Übersetzung und liefert garantiert
 * die Zielsprache (sofern DeepSeek erreichbar ist). Wird intern z.B. von
 * preloadTranslations() genutzt.
 */
async function tAsync(key, lang, params) {
  const langCode = String(lang || "de").split("-")[0].toLowerCase();
  const fallback = T_DE[key];
  if (fallback === undefined) return key;

  let val;
  if (langCode === "de") {
    val = fallback;
  } else {
    val = memCache.get(langCode)?.get(key);
    if (val === undefined) {
      await _translateAndCache(key, langCode);
      val = memCache.get(langCode)?.get(key) || fallback;
    }
  }

  if (typeof val === "string" && params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp("\\{" + k + "\\}", "g"), String(v ?? ""));
    }
  }
  return val;
}

/**
 * Beim Server-Start aufrufen. Lädt den DB-Cache in den Memory-Cache und
 * stößt fehlende Übersetzungen für alle SUPPORTED_LANGUAGES an.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.eager=false] - true = wartet bis alle Übersetzungen
 *                                        fertig sind. Default: feuert sie
 *                                        async ab.
 */
async function preloadTranslations(opts = {}) {
  const t0 = Date.now();
  const loaded = await _loadFromDb();
  logger.info(`[i18n] DB-Cache geladen: ${loaded} Einträge`);

  // Source-Hash check: wenn Source-Text sich vs. DB unterscheidet → invalidate
  // (light: prüft nur das aktuell deutsche Source vs. das vorhandene)
  // Für den ersten Rollout reicht der einfache Ansatz: fehlende ergänzen.

  const targetLangs = Object.keys(SUPPORTED_LANGUAGES).filter(l => l !== "de");
  const tasks = [];
  for (const key of Object.keys(T_DE)) {
    if (typeof T_DE[key] !== "string") continue;
    for (const lang of targetLangs) {
      const cached = memCache.get(lang)?.get(key);
      if (!cached) tasks.push(_translateAndCache(key, lang));
    }
  }

  if (!tasks.length) {
    logger.info(`[i18n] Alle Übersetzungen sind bereits vorhanden.`);
    return;
  }

  logger.info(`[i18n] ${tasks.length} fehlende Übersetzungen werden erzeugt…`);

  if (opts.eager) {
    // Sequentiell, damit DeepSeek-Ratelimits nicht überschritten werden
    for (const task of tasks) {
      try { await task; } catch (_) {}
    }
    logger.info(`[i18n] Preload abgeschlossen in ${Date.now() - t0} ms`);
  } else {
    // Im Hintergrund, gestaffelt
    (async () => {
      let i = 0;
      for (const task of tasks) {
        try { await task; } catch (_) {}
        if (++i % 10 === 0) await new Promise(r => setTimeout(r, 250));
      }
      logger.info(`[i18n] Background-Preload abgeschlossen (${tasks.length} Einträge) in ${Date.now() - t0} ms`);
    })();
  }
}

/**
 * Ad-hoc-Übersetzung beliebiger Texte (z.B. dynamische Inhalte aus der DB).
 * Wird ebenfalls cached.
 */
async function translateText(text, targetLang) {
  if (!text) return text;
  const langCode = String(targetLang || "de").split("-")[0].toLowerCase();
  if (langCode === "de") return text;

  // Cache-Lookup über pseudo-Key (Hash des Texts)
  const key = "ad_hoc_" + _hash(text);
  const cached = memCache.get(langCode)?.get(key);
  if (cached) return cached;

  const out = await _translate(text, langCode);
  if (out) {
    if (!memCache.has(langCode)) memCache.set(langCode, new Map());
    memCache.get(langCode).set(key, out);
    await _saveToDb(key, langCode, out, text);
    return out;
  }
  return text;
}

function _hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function detectLang(telegramUser) {
  if (!telegramUser?.language_code) return "de";
  const code = telegramUser.language_code.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES[code] ? code : "de";
}

module.exports = {
  t,
  tAsync,
  detectLang,
  preloadTranslations,
  translateText,
  SUPPORTED_LANGUAGES,
  T_DE,
};
