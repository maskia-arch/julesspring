/**
 * deepseekService.js v1.1.2
 *
 * - Model, Max-Tokens, Temperature aus Settings (konfigurierbar)
 * - Verbesserter System-Prompt: KI wird explizit angewiesen Kontext zu nutzen
 * - Bessere Fehlerbehandlung
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const { deepseek, openai } = require('../config/env');
const logger  = require('../utils/logger');

const deepseekService = {

  /**
   * Hauptfunktion: KI-Antwort generieren
   * @param {string}   userMessage
   * @param {Array}    history       - [{role, content}, ...]
   * @param {Array}    contextDocs   - RAG-Ergebnisse aus Supabase
   * @param {string}   chatId
   * @param {Object}   settings      - aus messageProcessor._loadSettings()
   */
  async generateResponse(userMessage, history = [], contextDocs = [], chatId = null, settings = {}) {
    const model       = settings.ai_model       || 'deepseek-chat';
    const maxTokens   = parseInt(settings.ai_max_tokens)  || 1024;
    const temperature = parseFloat(settings.ai_temperature) || 0.5;

    try {
      const systemContent = this._buildSystemPrompt(settings, contextDocs);

      const messages = [
        { role: 'system',    content: systemContent },
        ...(history || []).slice(-10), // max 10 History-Einträge
        { role: 'user',      content: userMessage }
      ];

      const response = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        { model, messages, temperature, max_tokens: maxTokens },
        {
          headers: { 'Authorization': `Bearer ${deepseek.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 40000
        }
      );

      const choice = response.data.choices[0].message.content;
      const usage  = response.data.usage || {};

      // Wissenslücke erkannt → Learning Queue
      if (choice.includes('[UNKLAR]') && chatId) {
        await supabase.from('learning_queue').insert([{
          original_chat_id:    chatId,
          unanswered_question: userMessage,
          status:              'pending'
        }]).catch(() => {});

        return {
          text: 'Ich bin bei dieser Frage nicht sicher genug. Ich habe soeben einen Mitarbeiter informiert, der sich so schnell wie möglich meldet. 🙏',
          promptTokens:     usage.prompt_tokens     || 0,
          completionTokens: usage.completion_tokens || 0
        };
      }

      return {
        text:             choice,
        promptTokens:     usage.prompt_tokens     || 0,
        completionTokens: usage.completion_tokens || 0
      };
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      logger.error(`[DeepSeek] generateResponse Error (${model}): ${msg}`);
      throw new Error(`KI-Fehler: ${msg}`);
    }
  },

  // ── System-Prompt aufbauen ──────────────────────────────────────────────
  _buildSystemPrompt(settings, contextDocs) {
    const basePrompt    = settings.system_prompt   || 'Du bist ein hilfreicher Assistent.';
    const negativePrompt= settings.negative_prompt || '';

    // Kontext aus Wissensdatenbank formatieren
    let contextSection = '';
    if (contextDocs && contextDocs.length > 0) {
      const contextText = contextDocs
        .map((doc, i) => `[${i + 1}] ${doc.content}`)
        .join('\n\n---\n\n');

      contextSection = `

════════════════════════════════════════
WISSENSDATENBANK – DEINE INFORMATIONSQUELLE:
════════════════════════════════════════
${contextText}
════════════════════════════════════════

PFLICHTREGELN FÜR DIE NUTZUNG DES WISSENS:
• Wenn die Antwort in der Wissensdatenbank steht: antworte IMMER daraus.
• Produktempfehlungen: gib IMMER den vollständigen Kauflink aus der Wissensdatenbank.
• Nenne IMMER den konkreten Preis wenn vorhanden.
• Wenn mehrere Produkte passen: liste alle mit Preis und Kauflink auf.
• Erfinde KEINE Produkte, Preise oder Links die nicht im Kontext stehen.`;
    }

    const negSection = negativePrompt
      ? `\n\nVERBOTENE VERHALTENSWEISEN:\n${negativePrompt}`
      : '';

    const fallbackInstruction = `

AUSGABE-FORMAT (STRIKT EINHALTEN):
Du antwortest immer in reinem Plain-Text ohne jegliche Formatierungszeichen.

VERBOTEN (erscheinen als Zeichensalat in Telegram):
- Kein **fett** oder __fett__ (kein **, kein __)
- Kein *kursiv* oder _kursiv_ (kein *, kein _)
- Keine ###-Header oder ##-Header oder #-Header
- Kein \`code\` und kein \`\`\`codeblock\`\`\`
- Keine [Links](url) – stattdessen direkte URLs: https://...
- Kein ~~durchgestrichen~~

ERLAUBT:
- Einfache Listen mit - oder Zahlen: 1. 2. 3.
- Absätze mit Leerzeilen
- Direkte URLs

BEISPIEL KORREKTE ANTWORT:
"Der Tarif kostet 9.99 EUR pro Monat und beinhaltet 10 GB Daten.
Kauflink: https://valueshop25.com/product/..."

BESTELLSTATUS-FUNKTION:
Wenn ein Kunde nach dem Status seiner Bestellung fragt, nach einer Invoice-ID sucht,
oder wissen möchte wo seine eSIM ist, antworte IMMER mit dieser Erklärung:
"Um deinen Bestellstatus abzufragen, sende: /order DEINE_INVOICE_ID
Beispiele: /order 12345 oder /order 05d0bb6ed687d-0000011429923
Die Invoice-ID findest du in der Bestätigungs-E-Mail von Sellauth."

UNSICHERHEITS-REGELN:
1. Wenn die Antwort nicht aus dem Kontext hervorgeht: Präfix [UNKLAR] verwenden
2. NIEMALS raten, erfinden oder spekulieren
3. NIEMALS "Ausverkauft" ohne expliziten Hinweis im Kontext`;

    return basePrompt + contextSection + negSection + fallbackInstruction;
  },

  // ── Embedding für Vektorsuche ───────────────────────────────────────────
  async generateEmbedding(text) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: text.replace(/\n/g, ' ').substring(0, 8000) },
        { headers: { 'Authorization': `Bearer ${openai.apiKey}` }, timeout: 15000 }
      );
      return response.data.data[0].embedding;
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      logger.error(`[DeepSeek] Embedding Error: ${msg}`);
      throw new Error(`Embedding fehlgeschlagen: ${msg}`);
    }
  },

  // ── Learning: Admin-Antwort → Wissensdatenbank ──────────────────────────
  async processLearningResponse(adminAnswer, questionId) {
    const { data: question } = await supabase.from('learning_queue').select('*').eq('id', questionId).single();
    if (!question) throw new Error('Frage nicht gefunden');

    const content   = `Frage: ${question.unanswered_question}\nAntwort: ${adminAnswer}`;
    const embedding = await this.generateEmbedding(content);

    await supabase.from('knowledge_base').insert([{ content, embedding, source: 'learning_chat' }]);
    await supabase.from('learning_queue').update({ status: 'resolved' }).eq('id', questionId);
    return true;
  }
};

module.exports = deepseekService;
