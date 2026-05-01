/**
 * channelAiService.js  v1.4.20
 *
 * KI-Dienste für Channel-Admins:
 *  - Tageszusammenfassung (datensparsam, zensiert)
 *  - Token-Volumen-Tracking + Limit-Enforcement
 *  - Output-Token-Verbrauch pro Channel
 */

const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

// Zensierungs-Regex: Beleidigungen, Hate-Speech etc
const CENSOR_PATTERNS = [
  /\b(fuck|shit|ass|bitch|bastard|arschloch|hurensohn|scheiß\w*|fick\w*|wichser|nazi|idiot)\b/gi,
  /\b(hate|töte|stirb|umbringen|angriff)\b/gi
];

function censorText(text) {
  let t = text || "";
  for (const p of CENSOR_PATTERNS) t = t.replace(p, "[***]");
  return t;
}

const channelAiService = {

  // ── Token-Volumen: Output-Tokens tracken ─────────────────────────────────
  async trackOutputTokens(channelId, outputTokens) {
    if (!outputTokens || outputTokens <= 0) return { limitReached: false };
    try {
      const { data: ch } = await supabase.from("bot_channels")
        .select("token_limit, output_tokens_used, token_notified, ai_enabled, added_by_user_id, title")
        .eq("id", String(channelId)).maybeSingle();
      if (!ch) return { limitReached: false };

      const newTotal = (ch.output_tokens_used || 0) + outputTokens;
      await supabase.from("bot_channels")
        .update({ output_tokens_used: newTotal, last_active_at: new Date() })
        .eq("id", String(channelId));

      // Limit erreicht?
      if (ch.token_limit && newTotal >= ch.token_limit && ch.ai_enabled) {
        await supabase.from("bot_channels")
          .update({ ai_enabled: false, token_notified: true }).eq("id", String(channelId));
        // Admin benachrichtigen
        if (ch.added_by_user_id) {
          const { data: s } = await supabase.from("settings").select("smalltalk_bot_token").single().then(r=>r, ()=>({data:null}));
          if (s?.smalltalk_bot_token) {
            await axios.post(`https://api.telegram.org/bot${s.smalltalk_bot_token}/sendMessage`, {
              chat_id: String(ch.added_by_user_id),
              text: `⚠️ <b>Token-Volumen aufgebraucht</b>\n\nDas KI-Budget für <b>${ch.title || channelId}</b> ist erschöpft (${ch.token_limit} Output-Tokens).\n\nAI-Features wurden automatisch deaktiviert. Alle anderen Features laufen weiter.\n\n👉 Kontaktiere @autoacts um das Volumen aufzuladen.`,
              parse_mode: "HTML"
            }, { timeout: 8000 }).catch(() => {});
          }
        }
        return { limitReached: true, total: newTotal };
      }
      return { limitReached: false, total: newTotal };
    } catch (e) {
      logger.warn("[ChannelAI] trackOutputTokens:", e.message);
      return { limitReached: false };
    }
  },

  // ── Prüfen ob AI noch verfügbar ───────────────────────────────────────────
  async checkAiAvailable(channelId) {
    try {
      const { data: ch } = await supabase.from("bot_channels")
        .select("ai_enabled, token_limit, output_tokens_used").eq("id", String(channelId)).maybeSingle();
      if (!ch?.ai_enabled) return false;
      if (ch.token_limit && ch.output_tokens_used >= ch.token_limit) return false;
      return true;
    } catch { return false; }
  },

  // ── Tageszusammenfassung ───────────────────────────────────────────────────
  async generateDailySummary(channelId, requestedBy, token) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { error: "Kein OpenAI-Key konfiguriert" };

    // Prüfen ob heute schon eine Zusammenfassung existiert
    const today = new Date().toISOString().split("T")[0];
    const { data: existing } = await supabase.from("daily_summaries")
      .select("id, summary_text, created_at").eq("channel_id", String(channelId))
      .gte("created_at", today + "T00:00:00Z").maybeSingle().then(r=>r, ()=>({data:null}));

    if (existing) {
      return { cached: true, summary: existing.summary_text, created_at: existing.created_at };
    }

    // Letzte 24h User-Nachrichten aus channel_context laden (datensparsam!)
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: contextMsgs } = await supabase.from("channel_context")
      .select("message, username, msg_date")
      .eq("channel_id", String(channelId)).gte("msg_date", since)
      .order("msg_date").limit(200);

    // Member-Statistiken
    const { data: newMembers } = await supabase.from("channel_members")
      .select("id", { count: "exact", head: true }).eq("channel_id", String(channelId))
      .gte("joined_at", since).then(r=>r, ()=>({data:null}));
    const { data: leftMembers } = await supabase.from("channel_members")
      .select("id", { count: "exact", head: true }).eq("channel_id", String(channelId))
      .eq("is_deleted", true).gte("last_seen", since).then(r=>r, ()=>({data:null}));

    const msgCount = contextMsgs?.length || 0;
    const newCount  = newMembers?.count  || 0;
    const leftCount = leftMembers?.count || 0;

    if (msgCount === 0) {
      return { summary: "Keine User-Nachrichten in den letzten 24h.", msgCount: 0, newCount, leftCount };
    }

    // Zensieren + anonymisieren (nur Text, keine Usernamen)
    const cleanMsgs = (contextMsgs || [])
      .map(m => censorText(m.message))
      .filter(t => t.length > 2)
      .slice(0, 100) // Max 100 Nachrichten
      .join("\n");

    const prompt = `Erstelle einen knappen Tagesbericht (max 200 Wörter) für diesen Telegram-Channel basierend auf den Nachrichten der letzten 24h.

Statistiken: ${msgCount} Nachrichten, ${newCount} neue Mitglieder, ${leftCount} ausgetreten.

Nachrichten (anonymisiert):
${cleanMsgs.substring(0, 3000)}

Berichte über: Hauptthemen, Aktivitätsniveau, besondere Ereignisse. Keine Nutzernamen nennen.`;

    try {
      const resp = await axios.post("https://api.openai.com/v1/chat/completions",
        { model: "gpt-4o-mini", max_tokens: 300, temperature: 0.3,
          messages: [{ role: "user", content: prompt }]},
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 25000 }
      );
      const summary = resp.data.choices[0].message.content.trim();

      // Speichern
      try {
        await supabase.from("daily_summaries").insert([{
          channel_id: String(channelId), summary_text: summary,
          msg_count: msgCount, new_members: newCount, left_members: leftCount,
          requested_by: requestedBy
        }]);
      } catch (_) {}

      return { summary, msgCount, newCount, leftCount };
    } catch (e) {
      logger.error("[ChannelAI] Summary:", e.message);
      return { error: "Zusammenfassung fehlgeschlagen: " + e.message };
    }
  },

  // ── Scheduled Message: Pin + Delete-Previous ──────────────────────────────
  async sendScheduledMsg(token, msg) {
    if (!token || !msg) return;
    const base = `https://api.telegram.org/bot${token}`;

    // Vorherige Nachricht desselben Inhalts löschen
    if (msg.delete_previous && msg.last_message_id) {
      await axios.post(`${base}/deleteMessage`, {
        chat_id: msg.channel_id, message_id: msg.last_message_id
      }, { timeout: 5000 }).catch(() => {});
    }

    let sentMsgId = null;
    try {
      const payload = { chat_id: msg.channel_id, parse_mode: "HTML" };
      let method = "sendMessage";

      if (msg.photo_file_id || msg.photo_url) {
        method = "sendPhoto";
        payload.photo   = msg.photo_file_id || msg.photo_url;
        payload.caption = msg.message;
      } else {
        payload.text = msg.message;
      }

      const resp = await axios.post(`${base}/${method}`, payload, { timeout: 10000 });
      sentMsgId = resp.data?.result?.message_id;

      // Pinnen
      if (msg.pin_message && sentMsgId) {
        await axios.post(`${base}/pinChatMessage`, {
          chat_id: msg.channel_id, message_id: sentMsgId, disable_notification: true
        }, { timeout: 5000 }).catch(() => {});
      }

      // last_message_id für Delete-Previous speichern
      if (sentMsgId) {
        try {
          await supabase.from("scheduled_messages")
            .update({ last_message_id: sentMsgId }).eq("id", msg.id);
        } catch (_) {}
      }
    } catch (e) {
      logger.warn("[ChannelAI] sendScheduledMsg:", e.message);
    }
    return sentMsgId;
  }
};

module.exports = channelAiService;
