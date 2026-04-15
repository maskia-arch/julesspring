/**
 * smalltalkAgent.js  v1.4
 *
 * Kosteneffizienter Smalltalk-Agent für Telegram-Channel.
 * - Antwortet auf /ai [Frage] in Channels
 * - Max 3-4 Sätze, locker und gesprächig
 * - Eigener System-Prompt, eigene Token-Limits
 * - Kann bei Bedarf auf den Berater-Modus hinweisen
 * - Zugriff auf separate "Smalltalk" Wissensdatenbank-Kategorie
 * - Bei Beratungsfragen → wechselt automatisch zum Berater-Prompt
 */

const axios    = require('axios');
const supabase = require('../../config/supabase');
const logger   = require('../../utils/logger');

const clarityDetector = require('./clarityDetector');

// Keywords die einen Wechsel zum Berater-Modus auslösen
const BERATER_TRIGGERS = /\b(esim|tarif|preis|gb|daten|roaming|data|kaufen|bestell|sim|laufzeit|anbiet|produkt|angebot|rabatt|coupon|code)/i;

const DEFAULT_SMALLTALK_PROMPT = `Du bist ein freundlicher, witziger KI-Assistent im Telegram-Channel von ValueShop25.
Antworte auf /ai-Befehle kurz und locker – maximal 3–4 Sätze.
Du kennst dich mit allgemeinen Themen aus und plauderst gern.
Wenn jemand nach eSIMs, Tarifen, Preisen oder Produkten fragt, weise ihn an den Support-Bot: @ValueShop25Support_bot
Antworte auf Deutsch außer der User schreibt auf Englisch.`;

const smalltalkAgent = {

  async handle({ chatId, text, from, settings, channelMode = 'smalltalk' }) {
    const s = settings;

    // Berater-Trigger im Channel → kurze Weiterleitung
    if (BERATER_TRIGGERS.test(text)) {
      const referral = `Für eSIM-Beratung bin ich nicht zuständig 😄 Schreib einfach @ValueShop25Support_bot direkt an – der hilft dir mit Tarifen, Preisen und allem rund um eSIMs! 📱`;
      return { reply: referral, mode: 'smalltalk_referral' };
    }

    // Smalltalk-KB laden (eigene Kategorie)
    let kbContext = '';
    if (s?.smalltalk_kb_category_id) {
      kbContext = await this._loadSmallTalkKB(text, s.smalltalk_kb_category_id);
    }

    const systemPrompt = s?.smalltalk_system_prompt || DEFAULT_SMALLTALK_PROMPT;
    const model        = s?.smalltalk_model     || 'deepseek-chat';
    const maxTokens    = s?.smalltalk_max_tokens || 200;
    const temperature  = parseFloat(s?.smalltalk_temperature || 0.8);

    const messages = [
      { role: 'system', content: systemPrompt + (kbContext ? `\n\nKontext:\n${kbContext}` : '') },
      { role: 'user',   content: text }
    ];

    try {
      // DeepSeek API (günstigstes Modell, wenig Tokens)
      const { data: settings_db } = await supabase.from('settings').select('deepseek_api_key, ai_provider').single().catch(() => ({ data: null }));
      const apiKey = process.env.DEEPSEEK_API_KEY || settings_db?.deepseek_api_key;

      const resp = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        { model, max_tokens: maxTokens, temperature, messages },
        { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
      );

      const reply = resp.data.choices[0].message.content.trim();
      const usage  = resp.data.usage || {};

      logger.info(`[Smalltalk] ${chatId}: ${usage.total_tokens || '?'} Tokens`);

      // Klarheitscheck
      const ragScore = kbContext ? 0.7 : null;
      void clarityDetector.evaluate({ chatId, userText: text, aiReply: reply, ragScore, agentMode: 'smalltalk' });

      return { reply, mode: 'smalltalk', tokens: usage.total_tokens || 0 };

    } catch (e) {
      logger.error('[Smalltalk] Fehler:', e.message);
      return { reply: 'Kurze Pause – probier\'s gleich nochmal! 🙂', mode: 'smalltalk_error' };
    }
  },

  async _loadSmallTalkKB(text, categoryId) {
    try {
      const embService = require('../embeddingService');
      const { embedding } = await embService.generateEmbedding(text);
      const { data } = await supabase.rpc('match_knowledge', {
        query_embedding: embedding, match_threshold: 0.55, match_count: 3
      });
      const filtered = (data || []).filter(d => d.category_id === categoryId);
      return filtered.map(d => d.content).join('\n\n').substring(0, 800);
    } catch { return ''; }
  }
};

module.exports = smalltalkAgent;
