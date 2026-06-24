/**
 * xaiService.js — Zentraler Service für xAI/Grok-Modelle
 * ============================================================================
 * Basis-URL:  https://api.x.ai/v1  (vollständig OpenAI-kompatibel)
 * API-Key:    process.env.XAI_API_KEY
 *
 * Aktuelle Modelle (Stand Mai 2026):
 *   Chat:
 *     grok-4.20-0309-non-reasoning  → "Grok Fast"  ($0.20/$0.50 per 1M)
 *     grok-4.20-0309-non-reasoning      → "Grok Think" ($0.20/$0.50 per 1M)
 *
 *   HINWEIS: grok-4-1-fast, grok-4-fast, grok-4 werden am 15.05.2026
 *   retired. Die -reasoning/-non-reasoning Varianten sind die aktuellen
 *   stabilen Versionen.
 *
 * Zukünftig ausgebaut werden kann (Struktur bereits vorbereitet):
 *   Images:  Imagine API  → grok-imagine-image-quality  ($0.05/image)
 *   Video:   Imagine API  → grok-imagine-video          ($0.05/sec)
 *   Voice:   Voice API    → Realtime / TTS / STT
 *
 * Credit-Faktor: ×1.5 für alle Grok-Modelle (Smalltalk + Tagesbericht)
 * ============================================================================
 */

const axios  = require('axios');
const logger = require('../utils/logger');

// ─── Konstanten ──────────────────────────────────────────────────────────────

const XAI_BASE_URL = 'https://api.x.ai/v1';

/**
 * Chat-Modelle (OpenAI-kompatibel via /v1/chat/completions)
 */
const MODELS = {
  // Grok 4.1 Fast — für Smalltalk und alle Bot-Funktionen
  FAST:  'grok-4.20-0309-non-reasoning',  // Grok Fast: schnelle Antworten, kein Reasoning
  THINK: 'grok-4.20-0309-non-reasoning',      // Grok Think: mit Reasoning-Schritten

  // ── Zukünftige Erweiterungen (auskommentiert bis aktiv) ───────────────────
  // IMAGE_STANDARD: 'grok-imagine-image',           // Imagine API, $0.02/Bild
  // IMAGE_QUALITY:  'grok-imagine-image-quality',   // Imagine API, $0.05/Bild
  // VIDEO:          'grok-imagine-video',            // Imagine API, $0.05/Sek
};

/**
 * Credit-Multiplikator für Grok — gilt für alle Modelle
 * Höher als ×1.0 (Chat) / ×1.2 (OpenAI) wegen anders gearteter Preisstruktur
 */
const CREDIT_MULTIPLIER = 1.5;

/**
 * Token-Preise (USD per Token) — für USD-Tracking (nicht für Credit-Anzeige)
 * Grok 4.1 Fast: $0.20 Input / $0.50 Output per 1M Tokens
 */
const TOKEN_PRICES = {
  [MODELS.FAST]:  { input: 0.0000002, output: 0.0000005 },
  [MODELS.THINK]: { input: 0.0000002, output: 0.0000005 },
};

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Prüft ob der xAI API-Key konfiguriert ist.
 * Gibt true zurück wenn vorhanden, wirft keinen Fehler.
 */
function isConfigured() {
  return !!process.env.XAI_API_KEY;
}

/**
 * Mappt DB-Modell-Strings auf den echten API-Modell-String.
 * Unterstützt Display-Namen, DB-Werte und direktes API-Format.
 */
function resolveModel(rawModel) {
  if (!rawModel) return MODELS.FAST;
  const r = String(rawModel).toLowerCase().trim();

  if (r === 'grok-4.20-0309-non-reasoning' || r === 'grok fast' || r === 'grok_fast') return MODELS.FAST;
  if (r === 'grok-4.20-0309-non-reasoning' || r === 'grok think' || r === 'grok_think') return MODELS.THINK;

  // Alte/abgekündigte Modelle → auf FAST mappen (sicheres Fallback)
  if (r.startsWith('grok-4-1-fast') || r === 'grok-4-fast' || r === 'grok-4' || r === 'grok-4-1') return MODELS.FAST;

  return MODELS.FAST; // Default
}

/**
 * Berechnet die verrechneten Credits für einen Grok-API-Aufruf.
 * @param {number} inTokens  - usage.prompt_tokens aus API-Antwort
 * @param {number} outTokens - usage.completion_tokens aus API-Antwort
 * @returns {{ billedCredits: number, usd: number }}
 */
function calcBilling(inTokens, outTokens, model) {
  const realTokens = (inTokens || 0) + (outTokens || 0);
  const billedCredits = Math.ceil(realTokens * CREDIT_MULTIPLIER);
  const prices = TOKEN_PRICES[model] || TOKEN_PRICES[MODELS.FAST];
  const usd = (inTokens || 0) * prices.input + (outTokens || 0) * prices.output;
  return { billedCredits, realTokens, usd };
}

// ─── Chat Completions ────────────────────────────────────────────────────────

/**
 * Ruft die xAI Chat Completions API auf (OpenAI-kompatibel).
 *
 * @param {Array}  messages   - [{role, content}] Konversationshistorie
 * @param {object} opts
 * @param {string} opts.model     - Modell-String (default: MODELS.FAST)
 * @param {number} opts.maxTokens - Max. Output-Tokens (default: 1024)
 * @param {number} opts.temperature - 0.0-1.0 (default: 0.7)
 * @param {number} opts.timeoutMs - Request-Timeout (default: 55000)
 *
 * @returns {Promise<{
 *   text: string|null,
 *   inTokens: number,
 *   outTokens: number,
 *   billedCredits: number,
 *   usd: number,
 *   model: string,
 *   error?: string
 * }>}
 */
async function chat(messages, opts = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    logger.warn('[xAI] XAI_API_KEY nicht gesetzt.');
    return { text: null, inTokens: 0, outTokens: 0, billedCredits: 0, usd: 0, model: opts.model || MODELS.FAST, error: 'no_api_key' };
  }

  const model       = resolveModel(opts.model);
  const maxTokens   = opts.maxTokens   || 1024;
  const temperature = opts.temperature ?? 0.7;
  const timeoutMs   = opts.timeoutMs   || 55000;

  let response = null;
  try {
    response = await axios.post(
      `${XAI_BASE_URL}/chat/completions`,
      {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      }
    );
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || 'Timeout/Aborted';
    logger.error(`[xAI] Chat-Fehler (${model}): ${msg}`);
    return { text: null, inTokens: 0, outTokens: 0, billedCredits: 0, usd: 0, model, error: msg };
  }

  const text = response?.data?.choices?.[0]?.message?.content ?? null;
  if (!text) {
    logger.error('[xAI] Leere Antwort (kein choices[0])');
    return { text: null, inTokens: 0, outTokens: 0, billedCredits: 0, usd: 0, model, error: 'empty_response' };
  }

  const usage    = response.data.usage || {};
  const inTokens  = usage.prompt_tokens     || 0;
  const outTokens = usage.completion_tokens || 0;
  const { billedCredits, realTokens, usd } = calcBilling(inTokens, outTokens, model);

  logger.info(`[xAI] ${model}: in=${inTokens} out=${outTokens} billed=${billedCredits} (×${CREDIT_MULTIPLIER}) $${usd.toFixed(6)}`);

  return { text, inTokens, outTokens, realTokens, billedCredits, usd, model };
}

// ─── Blacklist Enhancer ──────────────────────────────────────────────────────

/**
 * Generiert Blacklist-Wörter via Grok (grok-4.20-0309-non-reasoning).
 * Gibt ein Array von Strings zurück, bereit für den DB-Insert.
 *
 * @param {string} wordType   - Beschreibung: "Beleidigungen auf Deutsch"
 * @param {number} count      - Gewünschte Anzahl (5-50)
 * @param {string} language   - Sprach-Hinweis (z.B. "de", "en")
 * @returns {Promise<{
 *   words: string[],
 *   inTokens: number,
 *   outTokens: number,
 *   billedCredits: number,
 *   error?: string
 * }>}
 */
async function generateBlacklist(wordType, count = 20, language = 'de', existingWords = []) {
  const langHint = language === 'de' ? 'auf Deutsch' : `in language "${language}"`;

  // Bestehende Wörter als Ausschluss-Kontext
  const exclusionHint = existingWords.length > 0
    ? `\n\nFolgende Wörter sind bereits in der Blacklist und dürfen NICHT vorkommen:\n${existingWords.slice(0, 100).join(', ')}`
    : '';

  const messages = [
    {
      role: 'system',
      content:
        'Du bist ein Moderations-Assistent für Telegram-Gruppen. ' +
        'Deine Aufgabe ist es, eine Liste von Wörtern oder kurzen Phrasen zu erstellen, ' +
        'die in einer Community-Blacklist gesperrt werden sollen. ' +
        'Antworte AUSSCHLIESSLICH mit den Wörtern/Phrasen — jedes auf einer eigenen Zeile. ' +
        'Keine Nummerierung, keine Erklärungen, keine leeren Zeilen, kein Vorwort. ' +
        'Schlage keine Wörter vor, die bereits in der bestehenden Blacklist stehen.'
    },
    {
      role: 'user',
      content:
        `Erstelle ${count} ${wordType} ${langHint} für eine Blacklist. ` +
        `Nur die Wörter/Phrasen, je eine pro Zeile.` +
        exclusionHint
    }
  ];

  // Timeout skaliert mit Anzahl der Wörter:
  //   ≤10 Wörter → 60s, ≤25 → 90s, >25 → 120s
  // Grok Think (Reasoning) benötigt bei vielen Wörtern deutlich länger
  const timeoutMs = count <= 10 ? 60000 : count <= 25 ? 90000 : 120000;

  const result = await chat(messages, {
    model: MODELS.THINK,
    maxTokens: Math.max(800, count * 30),
    temperature: 0.3,
    timeoutMs,
  });

  if (!result.text) {
    return { words: [], inTokens: 0, outTokens: 0, billedCredits: 0, error: result.error };
  }

  // Robustes Parsen: Nummerierungen, Sonderzeichen, leere Zeilen entfernen
  const words = result.text
    .split(/\r?\n/)
    .map(line => line.replace(/^[\d\.\-\*•\s]+/, '').trim())
    .filter(line => line.length >= 2 && line.length <= 100)
    .slice(0, Math.max(count, 50));

  return {
    words,
    inTokens:      result.inTokens,
    outTokens:     result.outTokens,
    billedCredits: result.billedCredits,
    usd:           result.usd,
  };
}

// ─── Tagesbericht / Summary ──────────────────────────────────────────────────

/**
 * Erstellt eine Tageszusammenfassung via Grok.
 * Gleiche Schnittstelle wie dailySummaryService, aber mit Grok-Modell.
 *
 * @param {string} promptContent - Vollständiger Prompt-Text
 * @param {string} model         - Grok-Modell (default: MODELS.FAST)
 * @returns {Promise<{ text: string|null, inTokens: number, outTokens: number, billedCredits: number, usd: number }>}
 */
async function summarize(promptContent, model) {
  const result = await chat(
    [{ role: 'user', content: promptContent }],
    {
      model: model || MODELS.FAST,
      maxTokens: 700,
      temperature: 0.25,
      timeoutMs: 60000,
    }
  );
  return result;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Core
  chat,
  generateBlacklist,
  summarize,
  isConfigured,
  resolveModel,
  calcBilling,

  // Modell-Konstanten (für settingsHandler, smalltalkAgent etc.)
  MODELS,
  CREDIT_MULTIPLIER,
  TOKEN_PRICES,

  // Display-Namen für UI
  MODEL_LABELS: {
    [MODELS.FAST]:  'Grok Fast',
    [MODELS.THINK]: 'Grok Think',
  },
};
