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
const MODEL_PRICES = {
  "deepseek-chat":     { input: 0.00000027, output: 0.0000011  },
  "deepseek-reasoner": { input: 0.0000014,  output: 0.0000022  },
  "gpt-4o-mini":       { input: 0.00000015, output: 0.0000006  },
};

const DEFAULT_PROMPT = `Du bist ein offener, freundlicher KI-Assistent in diesem Telegram-Channel.
Du chattest gerne über alles: Witze, Fakten, Alltagsthemen, Unterhaltung, Reisen, Technik, Sport – was immer die Community interessiert.
Halte deine Antworten kurz und locker (max. 3–4 Sätze). Antworte auf Deutsch, außer der User schreibt in einer anderen Sprache.`;

// Jedes dieser Keywords löst sofort die Weiterleitung aus – kein KI-Aufruf
const BERATER_TRIGGERS = /\b(esim|e-sim|e sim|tarif|preis|€|eur|dollar|\$|gb|gigabyte|megabyte|mb|roaming|kaufen|bestell|sim-karte|sim karte|laufzeit|angebot|rabatt|coupon|datenplan|datenvolumen|mobilfunk|netz|provider|prepaid|postpaid|aktivier)/i;

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
    // is_active kann false sein wenn Bot als Admin entfernt wurde –
    // AI läuft trotzdem solange is_approved && ai_enabled gesetzt sind
    if (!channel.is_approved) {
      return { reply: null }; // Nicht freigeschaltet
    }
    if (!channel.ai_enabled) {
      return { reply: null }; // AI nicht aktiviert
    }

    // 2. Token/USD-Limit prüfen
    const limitHit = this._checkLimit(channel);
    if (limitHit) {
      const msg = channel.limit_message || "Deine Token sind verbraucht. Melde dich bei @autoacts.";
      return { reply: msg, limitReached: true };
    }

    // 3. Berater-Trigger → sofortige Weiterleitung, KEIN KI-Aufruf
    if (BERATER_TRIGGERS.test(text)) {
      const deflectMsg = (s?.smalltalk_deflect_msg) ||
        "Für Produkt- und Tarifanfragen bin ich nicht zuständig. Wende dich direkt an den Support! 📱";
      return { reply: deflectMsg, mode: "deflect" };
    }

    // 4. KI-Antwort generieren
    // Channel-spezifischer System-Prompt hat Vorrang vor globalem
    // Channel-eigenes Modell hat Vorrang, dann globale Setting, dann Default
    const systemPrompt = channel?.system_prompt || s?.smalltalk_system_prompt || DEFAULT_PROMPT;
    const model        = channel?.ai_model || s?.smalltalk_model || "deepseek-chat";
    const maxTokens    = parseInt(s?.smalltalk_max_tokens) || 200;
    const temperature  = parseFloat(s?.smalltalk_temperature) || 0.8;
    const isGPT        = model.startsWith("gpt-");

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
      let apiUrl, apiKey2;
      if (isGPT) {
        apiUrl  = "https://api.openai.com/v1/chat/completions";
        apiKey2 = process.env.OPENAI_API_KEY;
      } else {
        apiUrl  = "https://api.deepseek.com/v1/chat/completions";
        apiKey2 = dsKey;
      }
      if (!apiKey2) {
        logger.warn(`[Smalltalk] Kein API-Key für Modell ${model}`);
        return { reply: null };
      }

      const resp = await axios.post(
        apiUrl,
        { model, max_tokens: maxTokens, temperature, messages },
        { headers: { Authorization: "Bearer " + apiKey2, "Content-Type": "application/json" }, timeout: 20000 }
      );

      const reply  = resp.data.choices[0].message.content.trim();
      const usage  = resp.data.usage || {};
      const inTok  = usage.prompt_tokens     || 0;
      const outTok = usage.completion_tokens || 0;
      const prices  = MODEL_PRICES[model] || MODEL_PRICES["deepseek-chat"];
      const usd     = inTok * prices.input + outTok * prices.output;

      // 5. Credits tracken: 1 Token = 1 Credit (input+output together)
      await this._trackUsage(String(chatId), inTok + outTok, usd);

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
    const logger = require("../../utils/logger");
    // v1.4.47: Consume credits from oldest active package (FIFO).
    // Starts 30-day lifetime on first consumption (activated_at set by RPC).
    try {
      const { data: result, error } = await supabase.rpc("consume_channel_credits", {
        p_channel_id: String(chatId),
        p_tokens:     tokens
      });
      if (error) throw error;
      // Always also track USD spend directly
      try {
        const { data: ch } = await supabase.from("bot_channels")
          .select("usd_spent").eq("id", String(chatId)).maybeSingle();
        if (ch) {
          await supabase.from("bot_channels").update({
            usd_spent: parseFloat(((ch.usd_spent || 0) + usd).toFixed(6))
          }).eq("id", String(chatId));
        }
      } catch (_) {}
      if (result?.remaining_unpaid > 0) {
        logger.warn(`[Smalltalk] Channel ${chatId} consumed ${result.consumed}/${tokens} tokens (${result.remaining_unpaid} over limit)`);
      }
      return;
    } catch (rpcErr) {
      logger.warn("[Smalltalk] consume_channel_credits RPC failed, falling back:", rpcErr.message);
    }
    // Fallback: legacy direct update (pre-v33 schema)
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
      logger.warn("[Smalltalk] Token-Tracking fehlgeschlagen:", fallbackErr.message);
    }
  },

  async _loadKB(channelId) {
    // Per-channel KB laden (isoliert vom Berater)
    return ""; // Wird in handle() via channelKnowledgeEnricher geladen
  }
};

module.exports = smalltalkAgent;
