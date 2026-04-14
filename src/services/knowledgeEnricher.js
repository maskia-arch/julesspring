/**
 * knowledgeEnricher.js v1.3.24-2
 * 
 * Zentraler AI-Vorarbeiter: Jeder Wissenseintrag wird von GPT-4o-mini
 * intelligent kategorisiert, angereichert und aufgeteilt bevor er in die
 * Wissensdatenbank kommt.
 * 
 * Kostenoptimierung:
 * - gpt-4o-mini: ~$0.15/1M input tokens (sehr günstig)
 * - Max 400 Output-Tokens pro Aufruf
 * - Kategorien werden einmalig gecacht (30 Min)
 */

const axios    = require('axios');
const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

let _catCache     = null;
let _catCacheTime = 0;
const CAT_TTL = 30 * 60 * 1000;

const knowledgeEnricher = {

  // ── Kategorien laden (gecacht) ─────────────────────────────────────────
  async _getCategories() {
    const now = Date.now();
    if (_catCache && (now - _catCacheTime) < CAT_TTL) return _catCache;
    try {
      const { data } = await supabase.from('knowledge_categories').select('id, name, icon');
      _catCache = data || [];
      _catCacheTime = now;
      return _catCache;
    } catch { return []; }
  },

  // ── Einzelner Eintrag anreichern ───────────────────────────────────────
  async enrich(rawContent, source = 'unknown', hintCategoryId = null) {
    const { openai } = require('../config/env');
    if (!openai?.apiKey) {
      // Fallback ohne OpenAI: direkt speichern
      return [{ content: rawContent, category_id: hintCategoryId, title: null, enriched: false }];
    }

    const cats = await this._getCategories();
    const catList = cats.map(c => `${c.id}: ${c.name}`).join(', ');

    const prompt = `Du bist ein Wissensbank-Assistent für einen eSIM-Shop (ValueShop25.com).
Analysiere den folgenden Inhalt und erstelle strukturierte, auffindbare Einträge.

VERFÜGBARE KATEGORIEN: ${catList}

INHALT (Quelle: ${source}):
${rawContent.substring(0, 2000)}

AUFGABE: Erstelle 1-3 optimierte Einträge als JSON-Array. Jeder Eintrag:
- "category_id": beste passende Kategorie-ID (Zahl)
- "title": prägnanter Titel (max 60 Zeichen)  
- "content": optimierter Text auf Deutsch, SEO-freundlich, enthält Suchbegriffe

REGELN:
- Preise NIEMALS verändern oder erfinden
- Kauflinks IMMER aus Original übernehmen
- Bei Tarifen: auch englische Begriffe einfügen (z.B. "10GB 30 days")
- Maximal 3 Einträge, minimale Redundanz

Gib NUR das JSON-Array zurück, kein Markdown.`;

    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model:       'gpt-4o-mini',
          max_tokens:  600,
          temperature: 0.1,
          messages: [
            { role: 'system', content: 'Erstelle faktentreue, strukturierte Wissensbank-Einträge. Erfinde NIEMALS Preise oder Fakten.' },
            { role: 'user',   content: prompt }
          ]
        },
        { headers: { 'Authorization': `Bearer ${openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
      );

      const raw   = resp.data.choices[0].message.content.trim();
      const clean = raw.replace(/```json|```/g, '').trim();
      const entries = JSON.parse(clean);

      if (!Array.isArray(entries) || !entries.length) throw new Error('Leeres Ergebnis');

      return entries.map(e => ({
        content:     e.content     || rawContent,
        title:       e.title       || null,
        category_id: e.category_id || hintCategoryId || null,
        enriched:    true
      }));

    } catch (e) {
      logger.warn(`[Enricher] GPT fehlgeschlagen (${e.message}) – Original wird gespeichert`);
      return [{ content: rawContent, category_id: hintCategoryId, title: null, enriched: false }];
    }
  },

  // ── Eintrag direkt in KB speichern mit Embedding ───────────────────────
  async enrichAndStore(rawContent, source, hintCategoryId, extraMeta = {}) {
    const deepseekService = require('./deepseekService');
    const entries = await this.enrich(rawContent, source, hintCategoryId);
    const saved   = [];

    for (const entry of entries) {
      try {
        const embResult = await deepseekService.generateEmbedding(entry.content);
        const embedding = embResult.embedding || embResult;

        const { data } = await supabase.from('knowledge_base').insert([{
          content:     entry.content,
          title:       entry.title,
          embedding,
          source,
          category_id: entry.category_id,
          metadata:    { ...extraMeta, enriched: entry.enriched, source }
        }]).select('id, title, category_id');

        if (data?.[0]) saved.push(data[0]);
      } catch (e) {
        logger.warn(`[Enricher] Store fehlgeschlagen: ${e.message}`);
      }
    }

    logger.info(`[Enricher] ${source}: ${entries.length} Einträge → ${saved.length} gespeichert`);
    return saved;
  }
};

module.exports = knowledgeEnricher;
