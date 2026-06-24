const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");
// telegramService wurde beim Berater-Split entfernt. Der Import wird hier NICHT
// mehr benötigt (Versand läuft über tgAdminHelper). Optional laden, damit das
// Modul auch ohne die Datei lädt — sonst crasht die komplette Smalltalk-KI.
let telegramService = null;
try { telegramService = require("../telegramService"); } catch (_) { telegramService = null; }

// Formatter direkt importieren — garantiert Markdown→HTML unabhängig
// vom Deployment-Zustand von telegramService.js
let _markdownToHtml = null;
let _splitHtml = null;
try {
  const fmt = require("../../utils/telegramFormatter");
  _markdownToHtml = fmt.markdownToHtml;
  _splitHtml      = fmt.splitHtmlMessage;
} catch (_) {
  // Fallback: kein Formatter → Text bleibt wie er ist
  _markdownToHtml = t => String(t || "");
  _splitHtml      = (t, n) => t ? [t] : [];
}

/**
 * Sendet eine AI-Antwort in den Telegram-Chat mit garantiertem HTML-Parsing.
 * Konvertiert Markdown→HTML, splittet bei >4000 Zeichen, setzt parse_mode: HTML.
 * Fallback: sendet ohne parse_mode wenn HTML invalide.
 */
async function _sendAiReply(chatId, text, options = {}) {
  const token    = process.env.TELEGRAM_BOT_TOKEN || process.env.ADMINHELPER_TOKEN;
  const htmlText = _markdownToHtml(String(text || ""));
  const chunks   = _splitHtml(htmlText, 4000);
  if (!chunks.length) return null;

  let lastMsg = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id:                  chatId,
      text:                     chunks[i],
      parse_mode:               "HTML",
      disable_web_page_preview: true
    };
    if (options.message_thread_id) payload.message_thread_id = options.message_thread_id;
    if (i === 0 && options.reply_to_message_id) payload.reply_to_message_id = options.reply_to_message_id;

    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        payload,
        { timeout: 15000 }
      );
      lastMsg = r.data?.result;
    } catch (err) {
      const desc = err.response?.data?.description || "";
      if (desc.includes("can't parse entities") || desc.includes("Bad Request")) {
        // HTML invalide → plain-text Fallback
        const plain = chunks[i].replace(/<[^>]+>/g, "");
        const p2 = { chat_id: chatId, text: plain };
        if (options.message_thread_id) p2.message_thread_id = options.message_thread_id;
        const r2 = await axios.post(
          `https://api.telegram.org/bot${token}/sendMessage`, p2, { timeout: 15000 }
        ).catch(() => null);
        lastMsg = r2?.data?.result;
      }
    }
    if (chunks.length > 1 && i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return lastMsg;
}

// Reale Token-Preise pro Modell (USD pro Token).
// Stand Juni 2026. Schlüssel = tatsächliche API-Modell-Strings.
const MODEL_PRICES = {
  "deepseek-v4-flash":             { input: 0.00000014, output: 0.00000028 }, // V4 Flash
  "gpt-5.4-nano":                  { input: 0.00000020, output: 0.00000125 }, // GPT 5.4 Nano
  "grok-4.20-0309-non-reasoning":  { input: 0.00000020, output: 0.00000050 }, // Grok AI
  // Legacy-Fallbacks (falls noch alte Werte in der DB stehen)
  "deepseek-chat":     { input: 0.00000014, output: 0.00000028 },
  "deepseek-reasoner": { input: 0.00000014, output: 0.00000028 },
  "gpt-4o-mini":       { input: 0.00000015, output: 0.0000006  },
};

/**
 * Credits-Multiplikator pro Modell, wie sie dem Channel verrechnet werden.
 *   "AutoActsAi Fast"  (deepseek-v4-flash, non-thinking) → 1.00
 *   "AutoActsAi Think" (deepseek-v4-flash, thinking)     → 1.25
 *   "OpenAI"           (gpt-5.4-nano)                    → 1.20
 *   "Grok AI"          (grok-4.20-0309-non-reasoning)    → 1.50
 *
 * Der Multiplikator skaliert die verrechneten Credits; das USD-Tracking
 * (usd_spent) bleibt real. Für Thinking wird zusätzlich der Think-Multiplikator
 * (siehe _resolveModel) angewandt.
 */
const MODEL_CREDIT_MULTIPLIER = {
  "deepseek-v4-flash":             1.00,
  "gpt-5.4-nano":                  1.20,
  "grok-4.20-0309-non-reasoning":  1.50,
  // Legacy
  "deepseek-chat":                 1.00,
  "deepseek-reasoner":             1.25,
  "gpt-4o-mini":                   1.20,
};

/**
 * Mappt DB-Werte (alt wie neu) auf das tatsächliche API-Modell + Provider.
 * Gibt { model, provider, thinking } zurück.
 *   thinking: true  → DeepSeek V4 Flash im Thinking-Modus
 *   thinking: false → DeepSeek V4 Flash ohne Thinking
 *   thinking: null  → für Provider ohne Thinking-Toggle (OpenAI/xAI)
 *
 * Channel-Modelle (v2.0.2):
 *   "autoacts-fast"  → AutoActsAi Fast  = deepseek-v4-flash (non-thinking)
 *   "autoacts-think" → AutoActsAi Think = deepseek-v4-flash (thinking)
 *   "openai"         → GPT 5.4 Nano     = gpt-5.4-nano
 *   "grok"           → Grok AI          = grok-4.20-0309-non-reasoning
 */
function _resolveModel(rawModel) {
  const DS = "deepseek-v4-flash";
  if (!rawModel) return { model: DS, provider: "deepseek", thinking: false };
  const r = String(rawModel).toLowerCase().trim();

  // ── Grok (xAI) – nur noch EIN Modell "Grok AI" ──────────────────────────
  if (r === "grok" || r === "grok ai" || r === "grok-ai" ||
      r === "grok-4.20-0309-non-reasoning" || r.startsWith("grok"))
    return { model: "grok-4.20-0309-non-reasoning", provider: "xai", thinking: null };

  // ── OpenAI → GPT 5.4 Nano ───────────────────────────────────────────────
  if (r === "openai" || r === "gpt-5.4-nano" || r.startsWith("gpt-"))
    return { model: "gpt-5.4-nano", provider: "openai", thinking: null };

  // ── AutoActsAi Think (DeepSeek V4 Flash, Thinking) ──────────────────────
  if (r === "autoacts-think" || r === "autoactsai-think" || r === "autoactsai think" ||
      r === "deepseek-reasoner" || r === "v4-flash-thinking")
    return { model: DS, provider: "deepseek", thinking: true };

  // ── AutoActsAi Fast (DeepSeek V4 Flash, non-Thinking) ───────────────────
  if (r === "autoacts-fast" || r === "autoactsai-fast" || r === "autoactsai fast" ||
      r === "autoactsai-chat" || r === "autoactsai chat" ||
      r === "deepseek" || r === "deepseek-chat" || r === "deepseek-v4-flash" || r === "v4-flash")
    return { model: DS, provider: "deepseek", thinking: false };

  // Default: AutoActsAi Fast
  return { model: DS, provider: "deepseek", thinking: false };
}

const DEFAULT_PROMPT = `Du bist ein offener, freundlicher KI-Assistent. Du chattest gerne über alles: Witze, Fakten, Alltagsthemen, Unterhaltung, Reisen, Technik, Sport. Halte deine Antworten kurz und locker (max. 3–4 Sätze).`;

const BERATER_TRIGGERS = /\b(esim|e-sim|e sim|tarif|preis|€|eur|dollar|\$|gb|gigabyte|megabyte|mb|roaming|kaufen|bestell|sim-karte|sim karte|laufzeit|angebot|rabatt|coupon|datenplan|datenvolumen|mobilfunk|netz|provider|prepaid|postpaid|aktivier)/i;

const smalltalkAgent = {

  async handle({ chatId, text, settings, metadata = {}, userId = null, username = null, history = [], channelRecord = null }) {
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
      return { reply: msg, limitReached: true, threadId };
    }

    // ── Spam-Check ────────────────────────────────────────────────────────
    if (userId) {
      try {
        const spam = require('./spamDetectionService');

        const { muted, until } = await spam.isMuted(chatId, userId);
        if (muted) {
          const mutedMsg = `⛔ Du bist bis ${spam.formatMuteUntil(until)} stummgeschaltet (KI-Spam-Schutz).`;
          return { reply: mutedMsg, muted: true, threadId };
        }

        const spamResult = await spam.checkSpam(chatId, userId, text);
        if (spamResult.spam) {
          const action = await spam.recordViolation(chatId, userId);

          if (action === 'mute') {
            const tgApi = metadata?._tg;
            if (tgApi) await spam.muteInTelegram(tgApi, chatId, userId);
            const muteMsg = `⛔ @${username || userId} wurde für 12 Stunden stummgeschaltet (KI-Spam-Schutz).`;
            return { reply: muteMsg, spamMuted: true, threadId };
          } else {
            const warnMsg = `⚠️ @${username || userId}: Bitte die Channel-KI nicht für Spam verwenden. Bei weiteren Verstößen wirst du für 12 Stunden stummgeschaltet.`;
            return { reply: warnMsg, spamWarning: true, threadId };
          }
        }

        void spam.recordMessage(chatId, userId, text);
      } catch (e) {
        logger.warn(`[Smalltalk] Spam-Check Fehler: ${e.message}`);
      }
    }

    if (BERATER_TRIGGERS.test(text)) {
      const deflectMsg = (s?.smalltalk_deflect_msg) || "Wende dich bitte direkt an den Support! 📱";
      return { reply: deflectMsg, mode: "deflect", threadId };
    }

    const systemPrompt = channel?.system_prompt || s?.smalltalk_system_prompt || DEFAULT_PROMPT;
    const rawModel = channel?.ai_model || channel?.smalltalk_model || s?.smalltalk_model || "deepseek-chat";
    const { model, provider, thinking } = _resolveModel(rawModel);
    const maxTokens   = parseInt(s?.smalltalk_max_tokens) || 500;
    const temperature = parseFloat(s?.smalltalk_temperature) || 0.7;

    let kbContext = "";
    try {
      const channelKB = require("./channelKnowledgeEnricher");
      const results = await channelKB.search(String(chatId), text, 0.40, 4);
      if (results?.length) kbContext = results.join("\n\n").substring(0, 1500);
    } catch (e) {
      logger.warn(`[Smalltalk] KB Fehler: ${e.message}`);
    }

    // Live-Kontext: Safelist/Scamliste/Feedbacks zu erwähnten Usernames
    // Dieser Kontext hat VORRANG vor der allgemeinen KB — wenn @user auf
    // der Channel-Safelist steht, soll die AI das wissen bevor sie antwortet.
    let liveContext = "";
    try {
      const channelCtx = require("./channelContextService");
      liveContext = await channelCtx.getContextForQuery(String(chatId), text);
    } catch (e) {
      logger.warn(`[Smalltalk] LiveCtx Fehler: ${e.message}`);
    }

    // User-Memory: Was die AI über diesen User bereits weiß (personalisierter Kontext)
    let userMemoryCtx = "";
    if (userId) {
      try {
        const userMem = require("./userMemoryService");
        userMemoryCtx = await userMem.getMemoryContext(String(chatId), userId, username);
      } catch (e) {
        logger.warn(`[Smalltalk] UserMemory Fehler: ${e.message}`);
      }
    }

    // ─── (1.6.74) Reactions des Users auf vorherige Bot-Antworten ────────────
    let reactionCtx = "";
    if (userId) {
      try {
        const reactionSvc = require("../adminHelper/reactionTrackingService");
        const supabase = require("../../config/supabase");
        reactionCtx = await reactionSvc.buildReactionContext(supabase, String(chatId), userId);
      } catch (e) {
        logger.warn(`[Smalltalk] Reaction-Ctx Fehler: ${e.message}`);
      }
    }

    // ─── (1.6.74) Speaker-Identity-Block IMMER prominent vorn ─────────────────
    // Verhindert dass die AI den Chatpartner mit einer Person aus dem
    // Channel-Wissen oder System-Prompt verwechselt (z.B. dem Owner).
    // Wird im System-Prompt SEPARAT (vor anderem Kontext) eingefügt damit die
    // AI eindeutig weiß WER fragt — unabhängig von User-Memory.
    let speakerBlock = "";
    if (userId) {
      const safeUsername = username ? String(username).replace(/[<>&]/g, "") : null;
      const handle = safeUsername ? `@${safeUsername}` : "(kein @username)";
      speakerBlock =
        `==== AKTUELLER GESPRÄCHSPARTNER ====\n` +
        `Du sprichst gerade mit: ${handle} (Telegram-ID: ${userId})\n` +
        `WICHTIG: Diese Person ist NICHT zwangsläufig der Channel-Owner, ` +
        `Admin oder eine andere im System-Prompt erwähnte Person. ` +
        `Auch wenn der System-Prompt einen "Meister" / "Owner" / "Chef" nennt — ` +
        `der Chatpartner ist NUR ${handle}, sonst niemand. ` +
        `Schmeichele dem Chatpartner nicht indem du ihm Eigenschaften einer anderen ` +
        `Person zuschreibst. Wenn du Fragen wie "wer ist dein Owner/Meister" beantwortest, ` +
        `nenne den korrekten Namen aus deinem Channel-Wissen — NICHT den Chatpartner.\n` +
        `====================================`;
    }

    // ─── (1.6.74) Zeitstempel der eingehenden Nachricht ───────────────────────
    // Damit die AI Fragen wie "wie spät ist es" / "welcher Tag ist heute"
    // beantworten kann ohne zu raten.
    const msgTs = metadata?.messageDate
      ? new Date(metadata.messageDate * 1000)   // Telegram liefert Unix-Seconds
      : new Date();
    const timeBlock =
      `==== ZEITKONTEXT ====\n` +
      `Aktuelle Zeit (Europe/Berlin): ${msgTs.toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      })} Uhr\n` +
      `Wenn der User nach Zeit/Tag/Datum fragt, nutze EXAKT diesen Wert.\n` +
      `====================`;

    const fullContext = [
      speakerBlock,
      timeBlock,
      kbContext     ? `Wissensdatenbank:\n${kbContext}` : "",
      liveContext   ? liveContext                        : "",
      reactionCtx   ? reactionCtx                        : "",
      userMemoryCtx ? userMemoryCtx                     : ""
    ].filter(Boolean).join("\n\n").substring(0, 4500);

    // History (vergangene Konversation) zwischen System und aktueller Frage einfügen.
    // Ermöglicht zusammenhängende Gespräche: AI sieht was zuvor besprochen wurde.
    // Maximale Länge pro Message-Content begrenzt damit Tokens nicht explodieren.
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter(h => h && (h.role === "user" || h.role === "assistant") && h.content)
      .map(h => ({ role: h.role, content: String(h.content).substring(0, 800) }));

    const messages = [
      { role: "system", content: systemPrompt + (fullContext ? `\n\n${fullContext}` : "") },
      ...safeHistory,
      { role: "user",   content: text }
    ];

    try {
      // Provider-Routing: xAI / OpenAI / DeepSeek
      let apiUrl, apiKey;
      if (provider === "xai") {
        apiUrl = "https://api.x.ai/v1/chat/completions";
        apiKey = process.env.XAI_API_KEY;
      } else if (provider === "openai") {
        apiUrl = "https://api.openai.com/v1/chat/completions";
        apiKey = process.env.OPENAI_API_KEY;
      } else {
        apiUrl = "https://api.deepseek.com/v1/chat/completions";
        apiKey = process.env.DEEPSEEK_API_KEY;
      }

      if (!apiKey) throw new Error(`API Key für Provider '${provider}' fehlt`);

      // ── Provider-spezifischen Request-Body bauen ───────────────────────────
      const body = { model, messages };
      if (provider === "openai") {
        // GPT-5.4 Nano: nutzt max_completion_tokens, KEIN temperature
        body.max_completion_tokens = maxTokens;
      } else if (provider === "deepseek") {
        // DeepSeek V4 Flash: Thinking per Parameter togglen
        body.max_tokens = maxTokens;
        if (thinking === true) {
          body.thinking = { type: "enabled" };
          body.reasoning_effort = "high";
          // Hinweis: temperature wird im Thinking-Modus ignoriert → weglassen
        } else {
          body.thinking = { type: "disabled" };
          body.temperature = temperature;
        }
      } else {
        // xAI / Grok
        body.max_tokens = maxTokens;
        body.temperature = temperature;
      }

      const resp = await axios.post(apiUrl, body, {
        headers: { Authorization: "Bearer " + apiKey },
        timeout: 25000
      });

      const reply  = resp.data?.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new Error("Leere API-Antwort");
      const usage  = resp.data.usage || {};
      const realTokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

      const prices = MODEL_PRICES[model] || MODEL_PRICES["deepseek-chat"];
      const usd = (usage.prompt_tokens || 0) * prices.input + (usage.completion_tokens || 0) * prices.output;

      // Credits-Multiplikator anwenden — der Channel zahlt für teurere
      // Modelle entsprechend mehr Credits, der USD-Wert bleibt real.
      let multiplier = MODEL_CREDIT_MULTIPLIER[model] ?? 1.0;
      if (provider === "deepseek" && thinking === true) multiplier = 1.25; // V4 Flash Thinking
      const billedTokens = Math.ceil(realTokens * multiplier);

      // KEIN Selbst-Send mehr — commandHandler sendet via tg.send() (tgAdminHelper)
      // damit der Formatter GARANTIERT angewendet wird
      await this._trackUsage(String(chatId), billedTokens, usd, {
        tokens_in:  usage.prompt_tokens     || 0,
        tokens_out: usage.completion_tokens || 0,
        model
      });

      if (userId) {
        try {
          const userMem = require("./userMemoryService");
          void userMem.updateMemoryAsync(String(chatId), userId, username, text, reply);
        } catch (_) {}
      }

      logger.info(`[Smalltalk] ${chatId}: model=${model} real=${realTokens}tok billed=${billedTokens}tok (×${multiplier}) $${usd.toFixed(5)}`);
      return { reply, tokens: billedTokens, realTokens, usd, multiplier, model, threadId };

    } catch (e) {
      logger.error("[Smalltalk] Agent Fehler:", e.message);
      const errMs = "Entschuldige, ich konnte keine Antwort generieren. Bitte versuche es gleich nochmal.";
      return { reply: errMs, error: true, threadId };
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

  async _trackUsage(chatId, tokens, usd, meta) {
    try {
      await supabase.rpc("consume_channel_credits", {
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

      // Kontoauszug-Log (fire-and-forget) — sichtbar im Credits → Kontoauszug
      try {
        const creditLogService = require("../creditLogService");
        creditLogService.log(supabase, chatId, {
          category:   "smalltalk_ai",
          credits:    parseInt(tokens) || 0,
          tokens_in:  meta?.tokens_in  || 0,
          tokens_out: meta?.tokens_out || 0,
          usd:        usd || 0,
          model:      meta?.model || null,
          description: meta?.description || null
        });
      } catch (_) {}
    } catch (e) {
      logger.warn("[Smalltalk] Usage Tracking Fehler:", e.message);
    }
  }
};

module.exports = smalltalkAgent;
// Exposed für Tests und für Settings-Anzeige
module.exports.MODEL_CREDIT_MULTIPLIER = MODEL_CREDIT_MULTIPLIER;
module.exports._resolveModel = _resolveModel;
