/**
 * deepseekService.js v1.3.5
 * Cache-optimierter Prompt-Aufbau für maximale DeepSeek Cache-Hits.
 * Statischer Teil (Regeln) zuerst → Cache-Hit-Rate ~60-80%.
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const { deepseek, openai } = require('../config/env');
const logger  = require('../utils/logger');

// Statische Formatierungsregeln – werden von DeepSeek gecacht (0.01$/M statt 0.28$/M)
const FORMAT_RULES = `

AUSGABE-FORMAT:
Antworte immer in reinem Plain-Text ohne Formatierungszeichen.
VERBOTEN: **fett**, *kursiv*, ###Header, \`code\`, [Link](url)
ERLAUBT: Listen mit - oder 1., Leerzeilen, direkte URLs

UNSICHERHEITS-REGELN:
1. Nicht aus Kontext beantwortbar → Präfix [UNKLAR]
2. NIEMALS raten oder erfinden
3. NIEMALS "Ausverkauft" ohne expliziten Hinweis

BESTELLSTATUS: Wenn Kunde nach Bestellung fragt →
"Sende: /order DEINE_INVOICE_ID (aus Bestätigungs-E-Mail)"

TAGES-COUPON: Wenn Kunde nach Rabatt, Coupon, Angebot oder Aktion fragt →
Der aktuelle Coupon-Code wird dir als Teil des Kontexts mitgeteilt (AKTUELLER COUPON).
Wenn ein Coupon aktiv ist: Nenne den Code und die Beschreibung. Weise auf ValueShop25.com hin.
Wenn kein Coupon-Kontext vorhanden: "Gerade haben wir keinen aktiven Code. Schau morgen wieder vorbei!"`

const deepseekService = {

  async generateResponse(userMessage, history = [], contextDocs = [], chatId = null, settings = {}, chatSummary = null) {
    const model       = settings.ai_model         || 'deepseek-chat';
    const maxTokens   = parseInt(settings.ai_max_tokens)    || 1024;
    const temperature = parseFloat(settings.ai_temperature) || 0.5;

    try {
      const systemContent = this._buildSystemPrompt(settings, contextDocs, chatSummary);

      const messages = [
        { role: 'system', content: systemContent },
        ...(history || []),
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        { model, messages, temperature, max_tokens: maxTokens },
        {
          headers: { 'Authorization': `Bearer ${deepseek.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 55000
        }
      );

      const choice = response.data.choices[0].message.content;
      const usage  = response.data.usage || {};

      if (choice.includes('[UNKLAR]') && chatId) {
        void supabase.from('learning_queue').insert([{
          original_chat_id: chatId, unanswered_question: userMessage, status: 'pending'
        }]).catch(() => {});
      }

      return {
        text:             choice,
        promptTokens:     usage.prompt_tokens          || 0,
        completionTokens: usage.completion_tokens       || 0,
        cachedTokens:     usage.prompt_cache_hit_tokens || 0
      };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error(`[DS] Error: ${msg}`);
      throw new Error(`KI-Fehler: ${msg}`);
    }
  },

  // Cache-Strategie: statisch → semi-statisch → dynamisch
  _buildSystemPrompt(settings, contextDocs, chatSummary) {
    const base = settings.system_prompt  || 'Du bist ein hilfreicher Assistent.';
    const neg  = settings.negative_prompt || '';

    // 1. Basis-Prompt (statisch – geht in Cache)
    let p = base + FORMAT_RULES;

    if (neg) p += `\n\nVERBOTENE VERHALTENSWEISEN:\n${neg}`;

    // 2. RAG-Kontext (semi-statisch – ändert sich nur bei DB-Updates)
    const PRODUCT_RULES = `\n\n${'▶'.repeat(3)} PRODUKT-REGELN (STRIKT) ${'◀'.repeat(3)}
VERBOTEN: Produkte, Tarife, Links oder Preise ERFINDEN oder SCHÄTZEN.
VERBOTEN: URLs erfinden – nur Links aus der Wissensdatenbank verwenden.
ERLAUBT: Nur Produkte empfehlen die EXPLIZIT in der Wissensdatenbank stehen.
Kein passendes Produkt gefunden → Antworte: "Für diesen speziellen Tarif/Land haben wir aktuell kein passendes Angebot. Für individuelle Beratung wende dich bitte an @autoacts."
[UNKLAR] → wird als Wissenslücke gespeichert, NIEMALS erfinden!`;

    if (contextDocs && contextDocs.length > 0) {
      const ctx = contextDocs.map((d, i) => `[${i+1}] ${d.content}`).join('\n\n---\n\n');
      p += `\n\n${'═'.repeat(38)}\nWISSENSDATENBANK:\n${'═'.repeat(38)}\n${ctx}\n${'═'.repeat(38)}\nNur diese Produkte empfehlen. Kauflink + Preis IMMER aus DB übernehmen.`;
      p += PRODUCT_RULES;
    } else {
      // KEINE RAG-Docs → explizit kein Produkt empfehlen
      p += PRODUCT_RULES;
      p += `\n\nFÜR DIESE ANFRAGE: Keine passenden Produkte in der Datenbank. Verweise an @autoacts.`;
    }

    // 3. Chat-Zusammenfassung (pro Chat, aber stabil zwischen Updates)
    if (chatSummary) {
      p += `\n\nKONTEXT (frühere Nachrichten):\n${chatSummary}`;
    }

    return p;
  },

  // Asynchrone Chat-Zusammenfassung (spart Input-Tokens)
  async summarizeChat(messages, existingSummary = null) {
    if (!messages || messages.length < 2) return null;
    const text = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Kunde' : 'KI'}: ${(m.content||'').substring(0, 300)}`)
      .join('\n');

    const prompt = existingSummary
      ? `Bisherige Zusammenfassung:\n${existingSummary}\n\nNeue Nachrichten:\n${text}\n\nAktualisiere kompakt (max 120 Wörter). Behalte wichtige Fakten: Produktinteresse, Fragen, Bestellnummern.`
      : `Fasse kompakt zusammen (max 120 Wörter). Wichtig: Produktinteresse, offene Fragen, Bestellnummern.\n\n${text}`;

    try {
      const r = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        {
          model: 'deepseek-chat', max_tokens: 180, temperature: 0.1,
          messages: [
            { role: 'system', content: 'Kompakte deutsche Chat-Zusammenfassung. Nur Fakten, kein Fließtext.' },
            { role: 'user',   content: prompt }
          ]
        },
        { headers: { 'Authorization': `Bearer ${deepseek.apiKey}` }, timeout: 20000 }
      );
      return r.data.choices[0].message.content.trim();
    } catch (e) {
      logger.warn(`[DS] Summary Error: ${e.message}`);
      return existingSummary;
    }
  },

  async generateEmbedding(text) {
    try {
      const r = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: text.replace(/\n/g, ' ').substring(0, 8000) },
        { headers: { 'Authorization': `Bearer ${openai.apiKey}` }, timeout: 15000 }
      );
      return {
        embedding: r.data.data[0].embedding,
        tokens:    r.data.usage?.total_tokens || 0
      };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error(`[DS] Embedding Error: ${msg}`);
      throw new Error(`Embedding fehlgeschlagen: ${msg}`);
    }
  },

  async processLearningResponse(adminAnswer, questionId) {
    const { data: q } = await supabase.from('learning_queue').select('*').eq('id', questionId).single();
    if (!q) throw new Error('Frage nicht gefunden');
    const content    = `Frage: ${q.unanswered_question}\nAntwort: ${adminAnswer}`;
    const { embedding } = await this.generateEmbedding(content);
    await supabase.from('knowledge_base').insert([{ content, embedding, source: 'learning_chat' }]);
    await supabase.from('learning_queue').update({ status: 'resolved' }).eq('id', questionId);
    return true;
  }
};

module.exports = deepseekService;
