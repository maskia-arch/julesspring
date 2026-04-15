/**
 * clarityDetector.js  v1.4
 *
 * Erkennt unklare / fehlgeleitete KI-Antworten und erstellt
 * automatisch Wissenslücken-Einträge in der learning_queue.
 *
 * Heuristiken (kein KI-Call → 0 Tokenkosten):
 *  - Explizite [UNKLAR]-Marker
 *  - Niedrige RAG-Konfidenz kombiniert mit kurzer Antwort
 *  - Hedging-Phrasen in der Antwort
 *  - Themen-Mismatch: Frage enthält Begriff X, Antwort handelt von Y
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// Phrasen die auf Unsicherheit hindeuten
const HEDGE_PATTERNS = [
  /\[unklar\]/i,
  /kann ich (leider )?nicht (sagen|beantworten|bestätigen)/i,
  /keine (genauen? )?informationen? (darüber|dazu|vorhanden)/i,
  /nicht sicher (ob|wie|was|wann)/i,
  /schau (morgen |bitte |nochmal )?wieder vorbei/i,
  /wende dich an.*support/i,
  /kontaktiere.*@\w+/i,
  /dazu habe ich (leider )?keine/i,
  /das weiß ich (leider )?nicht/i,
];

// Themen-Mismatch-Paare: wenn Frage X enthält aber Antwort Y handelt von Z
const TOPIC_MISMATCH = [
  { questionContains: /login|anmeld|einlogg|passwort|konto|account/i,  answerContains: /bestellung|esim|lieferung|mail.*erhalten/i },
  { questionContains: /bestellung|order|invoice/i,                      answerContains: /login|anmeld/i },
  { questionContains: /preis|kosten|wie viel/i,                         answerContains: /nicht.*preis|preis.*nicht|kein.*preis/i },
];

const clarityDetector = {

  /**
   * Bewertet eine KI-Antwort und erstellt bei Bedarf einen Lernqueue-Eintrag.
   * Gibt clarity_score zurück (0.0 = unklar, 1.0 = klar).
   */
  async evaluate({ chatId, userText, aiReply, ragScore = null, agentMode = 'berater' }) {
    const score = this._computeScore(userText, aiReply, ragScore);

    // Unter 0.45: Wissenslücke eintragen
    if (score < 0.45) {
      await this._createLearningEntry(chatId, userText, aiReply, score, agentMode);
      logger.info(`[Clarity] Unklare Antwort erkannt (Score: ${score.toFixed(2)}) für: "${userText.substring(0, 60)}"`);
    }

    return score;
  },

  _computeScore(question, answer, ragScore) {
    let score = 1.0;

    // 1. Explizite Hedging-Phrasen in der Antwort
    const hedgeCount = HEDGE_PATTERNS.filter(p => p.test(answer)).length;
    if (hedgeCount >= 2) score -= 0.5;
    else if (hedgeCount === 1) score -= 0.25;

    // 2. Niedrige RAG-Konfidenz
    if (ragScore !== null) {
      if (ragScore < 0.35) score -= 0.35;
      else if (ragScore < 0.55) score -= 0.15;
    }

    // 3. Themen-Mismatch
    for (const pair of TOPIC_MISMATCH) {
      if (pair.questionContains.test(question) && pair.answerContains.test(answer)) {
        score -= 0.45;
        break;
      }
    }

    // 4. Sehr kurze Antwort bei langer Frage (oft = ausweichen)
    if (answer.length < 80 && question.length > 50) score -= 0.2;

    return Math.max(0, Math.min(1, score));
  },

  async _createLearningEntry(chatId, question, aiReply, score, agentMode) {
    try {
      // Prüfen ob ähnliche Frage schon in der Queue ist (Dedup, letzte 24h)
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data: existing } = await supabase
        .from('learning_queue')
        .select('id')
        .ilike('unanswered_question', `%${question.substring(0, 40)}%`)
        .gte('created_at', since)
        .limit(1);

      if (existing?.length) return; // Bereits vorhanden

      await supabase.from('learning_queue').insert([{
        chat_id:             chatId,
        unanswered_question: question,
        context:             `KI-Antwort (Score ${score.toFixed(2)}, Modus: ${agentMode}):\n${aiReply.substring(0, 400)}`,
        status:              'pending',
        created_at:          new Date()
      }]);
    } catch (e) {
      logger.warn('[Clarity] Learning-Entry fehlgeschlagen:', e.message);
    }
  }
};

module.exports = clarityDetector;
