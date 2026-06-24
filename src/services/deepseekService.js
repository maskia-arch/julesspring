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

AUSGABE-FORMAT (STRIKT):
Antworte ausschließlich in reinem Plain-Text — KEIN Markdown.
VERBOTEN: **fett**, *kursiv*, ***bold-italic***, __underline__, ###Header, \`code\`, [Link](url), - bullet
ERLAUBT: Listen mit "1." oder "•", Leerzeilen, direkte URLs als Plain-Text

UNSICHERHEITS-REGELN:
1. Antwort NICHT aus Kontext beantwortbar → Antwort beginnt mit [UNKLAR]
2. NIEMALS raten, schätzen oder Daten erfinden
3. NIEMALS "Ausverkauft" sagen ohne expliziten Hinweis in der Wissensdatenbank

BESTELLSTATUS: Wenn Kunde nach Bestellung fragt →
"Sende: /order DEINE_INVOICE_ID (aus Bestätigungs-E-Mail)"

TAGES-COUPON: Wenn Kunde nach Rabatt, Coupon, Angebot oder Aktion fragt →
Der aktuelle Coupon-Code wird dir als Teil des Kontexts mitgeteilt (AKTUELLER COUPON).
Wenn ein Coupon aktiv ist: Nenne den Code und die Beschreibung. Weise auf ValueShop25.com hin.
Wenn kein Coupon-Kontext vorhanden: "Gerade haben wir keinen aktiven Code. Schau morgen wieder vorbei!"`

// PRODUKT-REGELN — werden bei JEDER Antwort angewendet, mit oder ohne Kontext
const PRODUCT_RULES = `

▶▶▶ PRODUKT-REGELN (HÖCHSTE PRIORITÄT) ◀◀◀
DIESE REGELN GELTEN ÜBER ALLEM ANDEREN. NIE BRECHEN.

VERBOTEN — wird zu Halluzination führen:
• Tarife, Preise, GB-Mengen, Laufzeiten ERFINDEN oder SCHÄTZEN
• Auch wenn der Kunde mehrmals fragt: KEINE erfundenen Listen
• URLs erfinden — nur Links die WÖRTLICH in der Wissensdatenbank stehen
• Aus dem Gedächtnis/Training Tarif-Listen rekonstruieren

PFLICHT — wenn KEIN passender Tarif in der Wissensdatenbank:
Antworte WÖRTLICH (kein Ausweichen):
"Für diesen speziellen Tarif/dieses Land haben wir aktuell kein passendes Angebot in unserer Wissensdatenbank. Für individuelle Beratung wende dich bitte an @autoacts."

WICHTIG: Wenn du oben gesagt hast "kein Tarif vorhanden" und der Kunde danach
mit Worten wie "tarife", "Liste", "alle", "trotzdem" nachfragt, BLEIBE bei dieser
Aussage. Wiederhole nur: "Wir haben dazu nichts. @autoacts kann dir individuell helfen."

ERLAUBT:
• Nur Produkte/Tarife empfehlen die EXPLIZIT mit Namen UND Preis UND Link in der Wissensdatenbank stehen
• Kauflink + Preis IMMER 1:1 aus Wissensdatenbank-Eintrag übernehmen — kein Kürzen, kein Umformulieren`;

const deepseekService = {

  async generateResponse(userMessage, history = [], contextDocs = [], chatId = null, settings = {}, chatSummary = null) {
    const model       = settings.ai_model         || 'deepseek-chat';
    const maxTokens   = parseInt(settings.ai_max_tokens)    || 1024;
    // Sehr niedrige Temperatur reduziert Halluzinationen drastisch
    const temperature = parseFloat(settings.ai_temperature) || 0.2;

    let response = null;
    try {
      const systemContent = this._buildSystemPrompt(settings, contextDocs, chatSummary);

      const messages = [
        { role: 'system', content: systemContent },
        ...(history || []),
        { role: 'user', content: userMessage }
      ];

      response = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        { model, messages, temperature, max_tokens: maxTokens },
        {
          headers: { 'Authorization': `Bearer ${deepseek.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 55000
        }
      );
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message || 'Timeout/Aborted';
      logger.error(`[DS] Error: ${msg}`);
      // Kein throw — Aufrufer prüft text === null und wählt Fallback
      return { text: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, error: msg };
    }

    // Null-sicherer Zugriff — schützt gegen leere/unerwartete API-Responses
    const choice = response?.data?.choices?.[0]?.message?.content ?? null;
    if (!choice) {
      logger.error('[DS] Leere Antwort (kein choices[0])');
      return { text: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, error: 'empty_response' };
    }

    const usage = response.data.usage || {};

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
  },

  // Cache-Strategie: statisch → semi-statisch → dynamisch
  _buildSystemPrompt(settings, contextDocs, chatSummary) {
    const base = settings.system_prompt  || 'Du bist ein hilfreicher Assistent.';
    const neg  = settings.negative_prompt || '';

    // 1. Basis-Prompt + Format-Regeln + Produkt-Regeln (alles statisch, immer im Cache)
    // PRODUCT_RULES gelten IMMER — auch ohne Kontext-Treffer. Das verhindert, dass
    // das Modell aus seinem Training erfundene Tarif-Listen rekonstruiert.
    let p = base + FORMAT_RULES + PRODUCT_RULES;

    if (neg) p += `\n\nVERBOTENE VERHALTENSWEISEN:\n${neg}`;

    // 2. RAG-Kontext (semi-statisch – ändert sich nur bei DB-Updates)
    if (contextDocs && contextDocs.length > 0) {
      const ctx = contextDocs.map((d, i) => `[${i+1}] ${d.content}`).join('\n\n---\n\n');
      p += `\n\n${'═'.repeat(38)}\nWISSENSDATENBANK (einzige Quelle der Wahrheit):\n${'═'.repeat(38)}\n${ctx}\n${'═'.repeat(38)}\nNur diese Produkte empfehlen. Kauflink + Preis IMMER 1:1 aus DB übernehmen.`;
    } else {
      // KEIN Kontext gefunden → noch deutlicher: "DU HAST NICHTS"
      p += `\n\n${'═'.repeat(38)}\nWISSENSDATENBANK: LEER für diese Anfrage\n${'═'.repeat(38)}\nDu hast KEINE Produkt-Daten für diese Frage. Bei jeder Produkt-/Tarif-/Preis-Frage antwortest du wörtlich:\n"Für diesen speziellen Tarif/dieses Land haben wir aktuell kein passendes Angebot in unserer Wissensdatenbank. Für individuelle Beratung wende dich bitte an @autoacts."\nKEINE erfundenen Tarife, KEINE Listen aus dem Gedächtnis, KEINE Beispiele.`;
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
