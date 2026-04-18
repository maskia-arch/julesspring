/**
 * smalltalkAgent.js  v1.4.0-2
 *
 * Separater Smalltalk-Bot (eigener Bot-Token, eigene Persönlichkeit).
 * - Jeder Channel muss manuell im Dashboard freigeschaltet werden
 * - Token/USD-Limits pro Channel
 * - Bei Limit-Erreichen: Hinweis an @autoacts
 */

const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

// DeepSeek Preise ($/1M Tokens) – günstigstes Modell
const PRICE_PER_TOKEN = { input: 0.00000027, output: 0.0000011 }; // deepseek-chat

const DEFAULT_PROMPT = `Du bist ein freundlicher, witziger KI-Assistent.
Antworte locker und kurz – maximal 3–4 Sätze.
Wenn jemand nach eSIMs, Tarifen, Preisen oder Produkten fragt, weise ihn an: @ValueShop25Support_bot
Antworte auf Deutsch, außer der User schreibt auf Englisch.`;

const BERATER_TRIGGERS = /\b(esim|tarif|preis|gb|daten|roaming|kaufen|bestell|sim|laufzeit|angebot|rabatt|coupon)/i;

const smalltalkAgent = {

  async handle({ chatId, text, settings, channelRecord = null }) {
    const s = settings || {};

    // 1. Channel-Freischaltung prüfen
    const channel = channelRecord || await this._getChannel(String(chatId));
    if (!channel) {
      // Neuer Channel – in DB eintragen, warten auf Freischaltung
      await this._registerNewChannel(chatId, text);
      return { reply: null }; // Keine Antwort, bis freigeschalten
    }
    if (!channel.is_approved || !channel.is_active) {
      return { reply: null }; // Noch nicht freigeschalten
    }

    // 2. Token/USD-Limit prüfen
    const limitHit = this._checkLimit(channel);
    if (limitHit) {
      const msg = channel.limit_message || "Deine Token sind verbraucht. Melde dich bei @autoacts.";
      return { reply: msg, limitReached: true };
    }

    // 3. Berater-Trigger → Weiterleitung
    if (BERATER_TRIGGERS.test(text)) {
      return { reply: "Für eSIM-Fragen bin ich nicht zuständig 😄 Schreib @ValueShop25Support_bot direkt an – der hilft dir mit Tarifen und Preisen! 📱" };
    }

    // 4. KI-Antwort generieren
    // Channel-spezifischer System-Prompt hat Vorrang vor globalem
    const systemPrompt = channel?.system_prompt || s.smalltalk_system_prompt || DEFAULT_PROMPT;
    const model        = s.smalltalk_model     || "deepseek-chat";
    const maxTokens    = parseInt(s.smalltalk_max_tokens) || 200;
    const temperature  = parseFloat(s.smalltalk_temperature) || 0.8;

    // Per-Channel KB laden (semantische Suche in channel_knowledge Tabelle)
    let kbContext = "";
    try {
      const channelKB = require("./channelKnowledgeEnricher");
      const results = await channelKB.search(String(chatId), text, 0.50, 4);
      if (results.length) kbContext = results.join("\n\n").substring(0, 1000);
    } catch (_) {}

    const messages = [
      { role: "system", content: systemPrompt + (kbContext ? "\n\nKontext:\n" + kbContext : "") },
      { role: "user",   content: text }
    ];

    const apiKey = s.smalltalk_bot_token ? null : process.env.DEEPSEEK_API_KEY;
    const dsKey  = process.env.DEEPSEEK_API_KEY;

    if (!dsKey) {
      logger.warn("[Smalltalk] Kein DEEPSEEK_API_KEY konfiguriert");
      return { reply: null };
    }

    try {
      const resp = await axios.post(
        "https://api.deepseek.com/v1/chat/completions",
        { model, max_tokens: maxTokens, temperature, messages },
        { headers: { Authorization: "Bearer " + dsKey, "Content-Type": "application/json" }, timeout: 20000 }
      );

      const reply  = resp.data.choices[0].message.content.trim();
      const usage  = resp.data.usage || {};
      const inTok  = usage.prompt_tokens     || 0;
      const outTok = usage.completion_tokens || 0;
      const usd    = inTok * PRICE_PER_TOKEN.input + outTok * PRICE_PER_TOKEN.output;

      // 5. Kosten tracken (Volumen = nur Output-Token; USD = vollständig)
      await this._trackUsage(String(chatId), outTok, usd);

      logger.info(`[Smalltalk] ${chatId}: ${inTok + outTok} Tokens ($${usd.toFixed(5)})`);
      return { reply, tokens: inTok + outTok, usd };

    } catch (e) {
      logger.error("[Smalltalk] Fehler:", e.message);
      return { reply: "Kurze Pause – probier's gleich nochmal! 🙂" };
    }
  },

  _checkLimit(channel) {
    if (channel.token_limit !== null && channel.token_used >= channel.token_limit) return true;
    if (channel.usd_limit   !== null && channel.usd_spent  >= channel.usd_limit)   return true;
    return false;
  },

  async _getChannel(chatId) {
    try {
      const { data } = await supabase.from("bot_channels").select("*").eq("id", chatId).maybeSingle();
      return data || null;
    } catch { return null; }
  },

  async _registerNewChannel(chatId, firstMsg) {
    try {
      await supabase.from("bot_channels").upsert([{
        id:          chatId,
        title:       String(chatId),
        type:        "private",
        bot_type:    "smalltalk",
        is_active:   false,
        is_approved: false,
        added_at:    new Date(),
        updated_at:  new Date()
      }], { onConflict: "id", ignoreDuplicates: true });
      logger.info(`[Smalltalk] Neuer Channel registriert (wartet auf Freischaltung): ${chatId}`);
    } catch (e) {
      logger.warn("[Smalltalk] Register-Fehler:", e.message);
    }
  },

  async _trackUsage(chatId, tokens, usd) {
    // Sofort zählen – kein void (fire & forget kann Race Conditions erzeugen)
    try {
      const result = await supabase.rpc("increment_channel_usage", { p_id: String(chatId), p_tokens: tokens, p_usd: usd });
      if (result.error) throw result.error;
    } catch (rpcErr) {
      // Fallback: direktes atomares Update
      try {
        const { data: ch } = await supabase.from("bot_channels")
          .select("token_used, usd_spent").eq("id", String(chatId)).maybeSingle();
        if (ch) {
          await supabase.from("bot_channels").update({
            token_used:     (ch.token_used || 0) + tokens,
            usd_spent:      parseFloat(((ch.usd_spent || 0) + usd).toFixed(6)),
            last_active_at: new Date()
          }).eq("id", String(chatId));
        }
      } catch (fallbackErr) {
        require("../../utils/logger").warn("[Smalltalk] Token-Tracking fehlgeschlagen:", fallbackErr.message);
      }
    }
  },

  async _loadKB(channelId) {
    // Per-channel KB laden (isoliert vom Berater)
    return ""; // Wird in handle() via channelKnowledgeEnricher geladen
  }
};

module.exports = smalltalkAgent;
