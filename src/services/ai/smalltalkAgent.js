const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");
const telegramService = require("../telegramService");

const MODEL_PRICES = {
  "deepseek-chat":     { input: 0.00000027, output: 0.0000011  },
  "deepseek-reasoner": { input: 0.0000014,  output: 0.0000022  },
  "gpt-4o-mini":       { input: 0.00000015, output: 0.0000006  },
};

const DEFAULT_PROMPT = `Du bist ein offener, freundlicher KI-Assistent. Du chattest gerne über alles: Witze, Fakten, Alltagsthemen, Unterhaltung, Reisen, Technik, Sport. Halte deine Antworten kurz und locker (max. 3–4 Sätze).`;

const BERATER_TRIGGERS = /\b(esim|e-sim|e sim|tarif|preis|€|eur|dollar|\$|gb|gigabyte|megabyte|mb|roaming|kaufen|bestell|sim-karte|sim karte|laufzeit|angebot|rabatt|coupon|datenplan|datenvolumen|mobilfunk|netz|provider|prepaid|postpaid|aktivier)/i;

const smalltalkAgent = {

  async handle({ chatId, text, settings, metadata = {} }) {
    const s = settings || {};
    const threadId = metadata?.message_thread_id || null;

    const channel = await this._getChannel(String(chatId));
    if (!channel) {
      await this._registerNewChannel(chatId, text);
      return { reply: null };
    }
    
    if (!channel.is_approved || !channel.ai_enabled) return { reply: null };

    const limitHit = this._checkLimit(channel);
    if (limitHit) {
      const msg = channel.limit_message || "Token-Budget erreicht.";
      await telegramService.sendMessage(chatId, msg, { message_thread_id: threadId });
      return { reply: msg, limitReached: true };
    }

    if (BERATER_TRIGGERS.test(text)) {
      const deflectMsg = (s?.smalltalk_deflect_msg) || "Wende dich bitte direkt an den Support! 📱";
      await telegramService.sendMessage(chatId, deflectMsg, { message_thread_id: threadId });
      return { reply: deflectMsg, mode: "deflect" };
    }

    const systemPrompt = channel?.system_prompt || s?.smalltalk_system_prompt || DEFAULT_PROMPT;
    const model        = channel?.ai_model || s?.smalltalk_model || "deepseek-chat";
    const maxTokens    = parseInt(s?.smalltalk_max_tokens) || 500;
    const temperature  = parseFloat(s?.smalltalk_temperature) || 0.7;
    const isGPT        = model.startsWith("gpt-");

    let kbContext = "";
    try {
      const channelKB = require("./channelKnowledgeEnricher");
      const results = await channelKB.search(String(chatId), text, 0.40, 4);
      if (results?.length) kbContext = results.join("\n\n").substring(0, 1500);
    } catch (e) {
      logger.warn(`[Smalltalk] KB Fehler: ${e.message}`);
    }

    const messages = [
      { role: "system", content: systemPrompt + (kbContext ? "\n\nKontext aus Wissensdatenbank:\n" + kbContext : "") },
      { role: "user",   content: text }
    ];

    try {
      const apiUrl = isGPT ? "https://api.openai.com/v1/chat/completions" : "https://api.deepseek.com/v1/chat/completions";
      const apiKey = isGPT ? process.env.OPENAI_API_KEY : process.env.DEEPSEEK_API_KEY;

      if (!apiKey) throw new Error("API Key fehlt");

      const resp = await axios.post(apiUrl, { 
        model, 
        max_tokens: maxTokens, 
        temperature, 
        messages 
      }, { 
        headers: { Authorization: "Bearer " + apiKey }, 
        timeout: 25000 
      });

      const reply  = resp.data.choices[0].message.content.trim();
      const usage  = resp.data.usage || {};
      const totalTok = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      
      const prices = MODEL_PRICES[model] || MODEL_PRICES["deepseek-chat"];
      const usd = (usage.prompt_tokens || 0) * prices.input + (usage.completion_tokens || 0) * prices.output;

      await telegramService.sendMessage(chatId, reply, { message_thread_id: threadId });
      
      await this._trackUsage(String(chatId), totalTok, usd);

      logger.info(`[Smalltalk] ${chatId}: ${totalTok} Tokens ($${usd.toFixed(5)})`);
      return { reply, tokens: totalTok, usd };

    } catch (e) {
      logger.error("[Smalltalk] Agent Fehler:", e.message);
      const errMs = "Entschuldige, ich konnte keine Antwort generieren. Bitte versuche es gleich nochmal.";
      await telegramService.sendMessage(chatId, errMs, { message_thread_id: threadId });
      return { reply: errMs };
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
        id: chatId, title: String(chatId), type: "private", bot_type: "smalltalk",
        is_active: false, is_approved: false, updated_at: new Date()
      }], { onConflict: "id", ignoreDuplicates: true });
    } catch (e) { logger.warn("[Smalltalk] Register-Fehler:", e.message); }
  },

  async _trackUsage(chatId, tokens, usd) {
    try {
      const { error } = await supabase.rpc("consume_channel_credits", {
        p_channel_id: String(chatId),
        p_tokens:     parseInt(tokens)
      });
      
      const { data: ch } = await supabase.from("bot_channels").select("token_used, usd_spent").eq("id", String(chatId)).maybeSingle();
      if (ch) {
        await supabase.from("bot_channels").update({
          token_used: (ch.token_used || 0) + tokens,
          usd_spent: parseFloat(((ch.usd_spent || 0) + usd).toFixed(6)),
          last_active_at: new Date()
        }).eq("id", String(chatId));
      }
    } catch (e) {
      logger.warn("[Smalltalk] Usage Tracking Fehler:", e.message);
    }
  }
};

module.exports = smalltalkAgent;
