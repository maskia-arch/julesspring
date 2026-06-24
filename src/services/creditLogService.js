/**
 * creditLogService — zentrales Logging von Credit-Verbrauch pro Channel.
 *
 * Schreibt einen Eintrag in `channel_credit_log` für jeden AI-Aufruf.
 * Wird vom Admin im Kontoauszug pro Tag/Woche/Monat angezeigt.
 *
 * KATEGORIEN (stabile Werte, in Settings-UI gemappt zu Anzeige-Namen):
 *   smalltalk_ai          → Smalltalk-AI-Antworten
 *   group_game_classify   → Activity Tracker Nachrichten-Klassifikation
 *   daily_summary         → Tagesbericht
 *   channel_kb_embed      → Wissensdatenbank Embeddings
 *   blacklist_ai          → Blacklist Enhancer (Grok)
 *   adwriter              → Werbetexte/Variations
 *   other                 → Fallback
 *
 * Aufruf-Pattern (fire-and-forget, blockiert nie):
 *   creditLogService.log(supabase, chatId, {
 *     category: "group_game_classify",
 *     credits: 105,
 *     tokens_in: 100, tokens_out: 5,
 *     usd: 0.0000225,
 *     model: "grok-4.20-0309-non-reasoning"
 *   });
 */

const logger = require("../utils/logger");

const creditLogService = {
  /**
   * Loggt einen Credit-Verbrauch (fire-and-forget, kein await nötig vom Aufrufer).
   * @param {object} supabase_db Supabase-Client
   * @param {string|number} channelId
   * @param {object} entry
   * @param {string} entry.category   Pflicht — siehe oben
   * @param {number} entry.credits    verrechnete Credits (X1 oder höher, gerundet ↑)
   * @param {number} [entry.tokens_in]
   * @param {number} [entry.tokens_out]
   * @param {number} [entry.usd]
   * @param {string} [entry.model]
   * @param {string} [entry.description] optional Detailtext
   */
  log(supabase_db, channelId, entry) {
    if (!channelId || !entry?.category) return;
    // Fire-and-forget, blockiert nie den AI-Pfad
    void (async () => {
      try {
        await supabase_db.from("channel_credit_log").insert({
          channel_id:  String(channelId),
          category:    String(entry.category),
          description: entry.description || null,
          credits:     parseInt(entry.credits) || 0,
          tokens_in:   parseInt(entry.tokens_in)  || 0,
          tokens_out:  parseInt(entry.tokens_out) || 0,
          usd:         parseFloat(entry.usd) || 0,
          model:       entry.model || null
        });
      } catch (e) {
        logger.debug?.(`[CreditLog] insert ${entry.category} ${channelId}: ${e.message}`);
      }
    })();
  },

  /**
   * Gibt für die UI eine Zusammenfassung pro Kategorie zurück (gruppiert).
   * @param {object} supabase_db
   * @param {string|number} channelId
   * @param {Date} sinceDate
   * @returns {Promise<{ total: number, byCategory: Array<{category, credits, count}> }>}
   */
  async getSummary(supabase_db, channelId, sinceDate) {
    try {
      const { data } = await supabase_db.from("channel_credit_log")
        .select("category, credits")
        .eq("channel_id", String(channelId))
        .gte("created_at", sinceDate.toISOString());
      const rows = data || [];
      const map  = new Map();
      let total  = 0;
      for (const r of rows) {
        total += r.credits || 0;
        const cur = map.get(r.category) || { category: r.category, credits: 0, count: 0 };
        cur.credits += (r.credits || 0);
        cur.count++;
        map.set(r.category, cur);
      }
      const byCategory = [...map.values()].sort((a, b) => b.credits - a.credits);
      return { total, byCategory };
    } catch (e) {
      logger.warn?.(`[CreditLog] getSummary ${channelId}: ${e.message}`);
      return { total: 0, byCategory: [] };
    }
  },

  /**
   * Anzeige-Namen für UI (Mapping kategorie → Klartext).
   */
  CATEGORY_LABELS: {
    smalltalk_ai:        "💬 Smalltalk-Antworten",
    group_game_classify: "🎯 Activity Tracker (Klassifikation)",
    daily_summary:       "📰 Tagesbericht",
    channel_kb_embed:    "📚 Wissensdatenbank (Embeddings)",
    blacklist_ai:        "🚫 Blacklist Enhancer",
    adwriter:            "✍️ Werbetexte / Varianten",
    other:               "📦 Sonstiges"
  }
};

module.exports = creditLogService;
