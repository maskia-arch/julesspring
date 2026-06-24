/**
 * telegramFormatter.js
 * ============================================================================
 * Konvertiert Text (Markdown, Plain, HTML-Gemisch) in Telegram-kompatibles HTML.
 *
 * Telegram HTML-Mode unterstützt NUR diese Tags:
 *   <b>  <strong>  <i>  <em>  <u>  <ins>  <s>  <strike>  <del>
 *   <code>  <pre>  <pre><code class="language-…">
 *   <a href="…">  <tg-spoiler>  <tg-emoji emoji-id="…">
 *
 * Pflicht-Escaping im Text (außerhalb von Tags):
 *   &  →  &amp;    <  →  &lt;    >  →  &gt;
 *
 * Strategie: "Save → Escape → Convert → Restore"
 *   Schritt 0: Bestehende gültige HTML-Tags als Platzhalter sichern
 *   Schritt 1: Code-Blöcke sichern
 *   Schritt 2: Resttext escapen (&  <  >)
 *   Schritt 3: Markdown-Syntax konvertieren
 *   Schritt 4: Alles wiederherstellen
 * ============================================================================
 */

const TG_MSG_MAX     = 4000;
const TG_CAPTION_MAX = 1000;

/** Erlaubte Telegram-HTML-Tags (exakte Liste laut API-Docs) */
const TG_TAGS = new Set([
  'b','strong','i','em','u','ins','s','strike','del',
  'code','pre','a','tg-spoiler','tg-emoji',
]);

/** Escaped &, <, > in reinem Text-Inhalt */
function escHtml(t) {
  return String(t)
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Haupt-Konverter: Markdown + gemischtes HTML → sauberes Telegram-HTML.
 *
 * Funktioniert korrekt für:
 *  - Reine KI-Markdown-Ausgabe ("**bold** `code`")
 *  - Pre-built HTML aus settingsHandler ("<b>Text</b>")
 *  - Gemischten Text ("<b>Header</b>\n\n**weiteres** Markdown")
 */
function markdownToHtml(text) {
  if (!text) return '';
  const raw  = String(text);
  const saved = [];

  const ph = (val) => {
    saved.push(val);
    return `\x00${saved.length - 1}\x00`;
  };

  // ── S0: Bestehende gültige Telegram-HTML-Tags retten ─────────────────────
  // Regex matcht öffnende und schließende Tags aller erlaubten Elemente.
  // Attribute (z.B. href="...") werden mitgenommen.
  let t = raw.replace(
    /<(\/?)([a-zA-Z][\w-]*)(\s[^>]*)?\/?>/g,
    (match, slash, tagName) => {
      if (TG_TAGS.has(tagName.toLowerCase())) {
        return ph(match); // gültiger TG-Tag → sichern
      }
      return match; // unbekannter Tag → wird in S2 escaped
    }
  );

  // ── S1: Code-Blöcke sichern (``` … ``` und `…`) ───────────────────────
  t = t.replace(/```([\w]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const safe = escHtml(code.trimEnd());
    return ph(lang
      ? `<pre><code class="language-${lang}">${safe}</code></pre>`
      : `<pre>${safe}</pre>`);
  });

  t = t.replace(/`([^`\n]+)`/g, (_, code) => ph(`<code>${escHtml(code)}</code>`));

  // ── S2: Resttext escapen ────────────────────────────────────────────────
  // Platzhalter (\x00N\x00) enthalten kein & < > → werden nicht doppelt escaped.
  t = t
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // ── S3: Markdown → HTML ─────────────────────────────────────────────────

  // Überschriften: # bis ######
  t = t.replace(/^#{1,6}\s+(.+)$/gm, (_, h) => `<b>${h.trim()}</b>`);

  // Horizontale Linie
  t = t.replace(/^(\s*[-*_]{3,}\s*)$/gm, '──────────');

  // Fett: **text**
  t = t.replace(/\*\*(.+?)\*\*/gs, (_, inner) => `<b>${inner}</b>`);

  // Kursiv: *text*  (nur wenn kein Sternchen direkt daneben)
  t = t.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, (_, inner) => `<i>${inner}</i>`);

  // Kursiv: _text_  (Wortgrenzen)
  t = t.replace(/(?<=\s|^)_([^_\n]+?)_(?=\s|$|[.,!?;:])/gm, (_, inner) => `<i>${inner}</i>`);

  // Durchgestrichen: ~~text~~
  t = t.replace(/~~(.+?)~~/g, (_, inner) => `<s>${inner}</s>`);

  // Links: [text](url)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label, url) => `<a href="${url}">${label}</a>`);

  // Aufzählungszeichen
  t = t.replace(/^\*\s+/gm, '• ');
  t = t.replace(/^-\s+/gm,  '• ');

  // ── S4: Gesicherte Elemente wiederherstellen ────────────────────────────
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => saved[+i] ?? '');

  // ── S5: Mehrfache Leerzeilen kürzen ────────────────────────────────────
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  return t;
}

/**
 * Teilt HTML-Text HTML-sicher in Chunks auf.
 */
function splitHtmlMessage(text, maxLen = TG_MSG_MAX) {
  if (!text || text.length <= maxLen) return text ? [text] : [];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = -1;

    const pp = remaining.lastIndexOf('\n\n', maxLen);
    if (pp > maxLen * 0.3) cut = pp;

    if (cut === -1) {
      const nl = remaining.lastIndexOf('\n', maxLen);
      if (nl > maxLen * 0.3) cut = nl;
    }

    if (cut === -1) {
      for (const end of ['. ', '! ', '? ']) {
        const pos = remaining.lastIndexOf(end, maxLen);
        if (pos > maxLen * 0.3) { cut = pos + 1; break; }
      }
    }

    if (cut === -1) {
      const sp = remaining.lastIndexOf(' ', maxLen);
      if (sp > maxLen * 0.3) cut = sp;
    }

    if (cut === -1) cut = maxLen;

    const chunk = remaining.slice(0, cut).trimEnd();
    const safe  = _closeOpenTags(chunk);
    if (safe) chunks.push(safe);

    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.trim()) chunks.push(_closeOpenTags(remaining.trim()));
  return chunks.filter(Boolean);
}

/** Schließt offene HTML-Tags am Chunk-Ende. */
function _closeOpenTags(html) {
  const closeable = ['b','strong','i','em','u','ins','s','strike','del','code','pre','a'];
  const opened    = [];
  const tagRe     = /<\/?([a-zA-Z][\w-]*)[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[0].startsWith('</');
    const tag     = m[1].toLowerCase();
    if (!closeable.includes(tag)) continue;
    if (isClose) {
      const idx = opened.lastIndexOf(tag);
      if (idx !== -1) opened.splice(idx, 1);
    } else {
      opened.push(tag);
    }
  }
  let result = html;
  for (let k = opened.length - 1; k >= 0; k--) result += `</${opened[k]}>`;
  return result;
}

/** Komplette Pipeline: Markdown → HTML → gesplittet (für AI-Texte). */
function formatAndSplit(text, isCaption = false) {
  const html   = markdownToHtml(text);
  const maxLen = isCaption ? TG_CAPTION_MAX : TG_MSG_MAX;
  return splitHtmlMessage(html, maxLen);
}

/**
 * Konvertiert Telegram Message Entities + raw Text in Telegram-HTML.
 *
 * Telegram verwendet UTF-16 Code Units für entity offsets/length.
 * JavaScript String.slice() ist ebenfalls UTF-16-basiert → kompatibel.
 *
 * Unterstützt: bold, italic, underline, strikethrough, spoiler, code, pre,
 *              text_link, text_mention, custom_emoji (Premium ⭐)
 *
 * custom_emoji → <tg-emoji emoji-id="...">Fallback</tg-emoji>
 * Telegram rendert die Premium-Version, Fallback zeigt das Basis-Emoji.
 *
 * @param {string} text     - Rohtext der Nachricht
 * @param {Array}  entities - Telegram entities Array
 * @returns {string} Telegram-kompatibles HTML
 */
function entitiesToHtml(text, entities) {
  if (!text) return '';
  if (!entities || !entities.length) return escHtml(text);

  // Alle Grenzpositionen sammeln (UTF-16 Units, wie Telegram sie zählt)
  const boundaries = new Set([0, text.length]);
  for (const ent of entities) {
    boundaries.add(ent.offset);
    boundaries.add(ent.offset + ent.length);
  }
  const pts = [...boundaries].sort((a, b) => a - b);

  // Open/Close-Tags pro Position aufbauen
  const openAt  = {};
  const closeAt = {};
  const addOpen  = (pos, tag) => { (openAt[pos]  = openAt[pos]  || []).push(tag); };
  const addClose = (pos, tag) => { (closeAt[pos] = closeAt[pos] || []).unshift(tag); };

  // Nach offset sortieren (äußere Entities zuerst bei gleichem offset)
  const sorted = [...entities].sort((a, b) =>
    a.offset !== b.offset ? a.offset - b.offset : b.length - a.length
  );

  for (const ent of sorted) {
    const { type, offset, length } = ent;
    const end = offset + length;
    switch (type) {
      case 'bold':
        addOpen(offset, '<b>');         addClose(end, '</b>'); break;
      case 'italic':
        addOpen(offset, '<i>');         addClose(end, '</i>'); break;
      case 'underline':
        addOpen(offset, '<u>');         addClose(end, '</u>'); break;
      case 'strikethrough':
        addOpen(offset, '<s>');         addClose(end, '</s>'); break;
      case 'spoiler':
        addOpen(offset, '<tg-spoiler>');addClose(end, '</tg-spoiler>'); break;
      case 'code':
        addOpen(offset, '<code>');      addClose(end, '</code>'); break;
      case 'pre':
        addOpen(offset, ent.language
          ? `<pre><code class="language-${ent.language}">`
          : '<pre>');
        addClose(end, ent.language ? '</code></pre>' : '</pre>');
        break;
      case 'text_link':
        if (ent.url) { addOpen(offset, `<a href="${escHtml(ent.url)}">`);}  addClose(end, '</a>'); break;
      case 'text_mention':
        if (ent.user?.id) { addOpen(offset, `<a href="tg://user?id=${ent.user.id}">`); addClose(end, '</a>'); }
        break;
      case 'custom_emoji':
        // Premium-Emoji: <tg-emoji emoji-id="ID">base_emoji</tg-emoji>
        if (ent.custom_emoji_id) {
          addOpen(offset,  `<tg-emoji emoji-id="${ent.custom_emoji_id}">`);
          addClose(end, '</tg-emoji>');
        }
        break;
      // Andere Typen (mention, hashtag, url, ...) brauchen kein HTML-Tag
    }
  }

  // HTML aufbauen: Segment für Segment zwischen den Grenzpunkten
  let result = '';
  for (let i = 0; i < pts.length; i++) {
    const pos = pts[i];
    // Schließende Tags zuerst (Reihenfolge: innerste zuerst)
    if (closeAt[pos]) result += closeAt[pos].join('');
    // Öffnende Tags
    if (openAt[pos])  result += openAt[pos].join('');
    // Text-Segment bis zum nächsten Grenzpunkt
    if (i < pts.length - 1) {
      result += escHtml(text.slice(pos, pts[i + 1]));
    }
  }
  return result;
}

/**
 * Formatiert einen ISO-/Date-Wert als deutsche Datums-Zeit-Anzeige in MEZ/MESZ.
 * Render läuft in UTC → wir erzwingen die Berliner Zeitzone für die Anzeige.
 * @param {string|Date|number} value  ISO-String, Date oder Timestamp
 * @returns {string} z.B. "31.12.2026, 23:59 Uhr" oder "" bei ungültigem Wert
 */
function toGermanDateTime(value) {
  if (!value) return "";
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  try {
    const s = d.toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    return `${s} Uhr`;
  } catch (_) {
    // Fallback ohne Zeitzone falls Intl-Daten fehlen
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())} Uhr`;
  }
}

/**
 * Parst eine deutsche Datums-Eingabe ("DD.MM.YYYY HH:MM" oder "DD.MM.YYYY")
 * als MEZ/MESZ-Zeit und gibt einen ISO-String (UTC) zurück.
 * Berücksichtigt Sommer-/Winterzeit über den Europe/Berlin-Offset.
 * @param {string} input  z.B. "31.12.2026 23:59" oder "31.12.2026"
 * @returns {string|null}  ISO-String (UTC) oder null bei ungültiger Eingabe
 */
function parseGermanDateTime(input) {
  if (!input) return null;
  const str = String(input).trim();
  // DD.MM.YYYY [HH:MM]
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;

  const day    = parseInt(m[1], 10);
  const month  = parseInt(m[2], 10);
  const year   = parseInt(m[3], 10);
  const hour   = m[4] != null ? parseInt(m[4], 10) : 0;
  const minute = m[5] != null ? parseInt(m[5], 10) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  // Berlin-Offset für das gegebene Datum bestimmen (MEZ=+1, MESZ=+2).
  // Wir bauen ein UTC-Datum und korrigieren um den Berliner Offset.
  // Trick: ein Date als UTC interpretieren, dann via toLocaleString den
  // Offset zum Zielzeitpunkt berechnen.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Wie spät ist es in Berlin wenn die UTC-Uhr utcGuess zeigt?
  const berlinAtGuess = new Date(utcGuess).toLocaleString("en-US", { timeZone: "Europe/Berlin" });
  const utcAtGuess     = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs = new Date(berlinAtGuess).getTime() - new Date(utcAtGuess).getTime();

  // Die Eingabe war Berliner Zeit → echte UTC = utcGuess - offset
  const realUtc = utcGuess - offsetMs;
  const result  = new Date(realUtc);
  if (isNaN(result.getTime())) return null;
  return result.toISOString();
}

module.exports = { markdownToHtml, splitHtmlMessage, formatAndSplit, escHtml, entitiesToHtml, toGermanDateTime, parseGermanDateTime };
