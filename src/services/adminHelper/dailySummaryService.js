/**
 * dailySummaryService.js v1.5.42
 * ----------------------------------------------------------------------------
 * Erstellt eine Tageszusammenfassung für eine Gruppe.
 *
 * v1.5.42-Änderungen:
 *   • Datenquelle ist jetzt PRIMÄR `channel_message_log` (alle Group-
 *     Messages, gesammelt im Webhook seit 1.5.42), mit `channel_chat_history`
 *     als Fallback für Bestandsdaten.
 *   • Prompt ist neu: Fokus auf das Wesentliche (Highlights statt Protokoll).
 *     Statt 5-8 Stichpunkten gibt's jetzt höchstens 3-5 Kernaussagen, mit
 *     klarer Struktur (Themen, Stimmung, wichtige Vorfälle).
 * ----------------------------------------------------------------------------
 */

const axios = require("axios");

async function _loadMessages(supabase_db, channelId, sinceISO) {
  // Primär aus dem neuen channel_message_log (ALLE Group-Messages)
  let messages = [];
  try {
    const { data } = await supabase_db
      .from("channel_message_log")
      .select("user_id, username, first_name, content, created_at")
      .eq("channel_id", String(channelId))
      .gte("created_at", sinceISO)
      .order("created_at", { ascending: true })
      .limit(500);
    messages = data || [];
  } catch (_) {}

  // Fallback: alte AI-Konversationen (Backwards-Compat)
  if (!messages.length) {
    try {
      const { data: hist } = await supabase_db
        .from("channel_chat_history")
        .select("user_id, content, created_at")
        .eq("channel_id", String(channelId))
        .eq("role", "user")
        .gte("created_at", sinceISO)
        .order("created_at", { ascending: true })
        .limit(300);
      messages = (hist || []).map(m => ({
        user_id: m.user_id, username: null, first_name: null,
        content: m.content, created_at: m.created_at
      }));
    } catch (_) {}
  }

  return messages;
}

async function createDailySummary(supabase_db, channelId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const since = new Date(Date.now() - 86400000).toISOString();
  const ctxMsgs = await _loadMessages(supabase_db, channelId, since);

  // Mitglieder-Zähler (für Statistik)
  let joins = 0, leaves = 0, activeMembers = 0;
  try {
    const { data: m } = await supabase_db
      .from("channel_members")
      .select("is_deleted, joined_at, last_message_at")
      .eq("channel_id", String(channelId));
    if (m) {
      const dayAgo = Date.now() - 86400000;
      m.forEach(row => {
        if (!row.is_deleted) {
          if (row.joined_at && new Date(row.joined_at).getTime() > dayAgo) joins++;
          if (row.last_message_at && new Date(row.last_message_at).getTime() > dayAgo) activeMembers++;
        } else {
          leaves++;
        }
      });
    }
  } catch (_) {}

  if (!ctxMsgs.length) {
    return {
      text: `📰 <b>Tageszusammenfassung</b>\n\nIn den letzten 24h gab es keine erfassten Nachrichten in dieser Gruppe.\n\n👥 Eintritte: ${joins} · Austritte: ${leaves}`,
      outTokens: 0, inTokens: 0, usd: 0
    };
  }

  // Username-Map für schöneren Kontext (anonymisiert vor LLM)
  const userIdToAlias = {};
  let aliasCounter = 1;
  ctxMsgs.forEach(m => {
    const key = String(m.user_id);
    if (!userIdToAlias[key]) {
      userIdToAlias[key] = `User${aliasCounter++}`;
    }
  });

  const lines = ctxMsgs.map(m => {
    const ts = new Date(m.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const alias = userIdToAlias[String(m.user_id)] || "User?";
    return `[${ts}] ${alias}: ${(m.content || "").substring(0, 200)}`;
  }).join("\n").substring(0, 6000);

  // Aktive Teilnehmer-Anzahl (eindeutige User in den 24h)
  const uniqueUsers = Object.keys(userIdToAlias).length;

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 800,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Du erstellst Tageshighlights für eine Telegram-Gruppe. " +
              "Ziel: Der Admin will in 30 Sekunden wissen, was wichtig war.\n\n" +
              "REGELN:\n" +
              "1. Maximal 4-6 Kernpunkte als ⚡-Bullets — keine Plauder-Liste.\n" +
              "2. Fokus auf: Themen, Vorfälle, Trends, häufige Fragen, Stimmung.\n" +
              "3. KEINE Protokollform ('Um 14:32 sagte X dass Y'). Stattdessen: " +
              "verdichten zur Aussage ('Wiederholte Beschwerden über Lieferzeiten').\n" +
              "4. Wenn alles ruhig war: 1-2 Sätze und kein Drumherum.\n" +
              "5. Beleidigungen/Vulgärsprache mit [***] zensieren.\n" +
              "6. Keine echten Usernames — die User sind ohnehin anonymisiert (User1, User2…).\n" +
              "7. Kein Vorwort, kein Nachwort, keine Floskel. Direkt rein.\n" +
              "8. Auf Deutsch. Verwende ⚡ als Bullet-Symbol."
          },
          {
            role: "user",
            content:
              `Erstelle die Tageshighlights für diese Telegram-Gruppe.\n\n` +
              `Letzte 24h: ${ctxMsgs.length} Nachrichten von ${uniqueUsers} aktiven Usern.\n\n` +
              `Inhalt:\n${lines}`
          }
        ]
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 45000 }
    );

    const usage = resp.data?.usage || {};
    const outTokens = usage.completion_tokens || 0;
    const inTokens = usage.prompt_tokens || 0;
    const summaryTxt = resp.data?.choices?.[0]?.message?.content?.trim() || "(Keine Zusammenfassung)";

    const stats = `\n\n👥 ${activeMembers} aktive · 📈 +${joins} · 📉 -${leaves} · 💬 ${ctxMsgs.length} Nachrichten`;

    return {
      text: `📰 <b>Tageshighlights</b>\n\n${summaryTxt}${stats}`,
      outTokens, inTokens, usd: inTokens * 0.00000015 + outTokens * 0.0000006
    };
  } catch (e) { return null; }
}

async function runDailySummary(supabase_db, channelId, adminUserId, tg, ch, lang) {
  const result = await createDailySummary(supabase_db, channelId);
  if (!result) {
    await tg.call("sendMessage", { chat_id: String(adminUserId), text: "❌ Fehler bei der Zusammenfassung. Bitte später erneut versuchen." });
    return;
  }

  const rawOutTokens = result.outTokens || 0;
  const billedTokens = rawOutTokens * 2;
  const actualUsd = result.usd || 0;

  if (rawOutTokens >= 10) {
    try {
      await supabase_db.from("bot_channels").update({ last_summary_at: new Date(), last_summary_tokens: rawOutTokens }).eq("id", String(channelId));
    } catch (_) {}
  }

  try {
    const rpcResult = await supabase_db.rpc("increment_channel_usage", { p_id: String(channelId), p_tokens: billedTokens, p_usd: actualUsd });
    if (rpcResult.error) throw rpcResult.error;
  } catch {
    try {
      const { data: cur } = await supabase_db.from("bot_channels").select("token_used, usd_spent").eq("id", String(channelId)).maybeSingle();
      if (cur) {
        await supabase_db.from("bot_channels").update({ token_used: (cur.token_used || 0) + billedTokens, usd_spent: parseFloat(((cur.usd_spent || 0) + actualUsd).toFixed(6)) }).eq("id", String(channelId));
      }
    } catch (_) {}
  }

  let note = "";
  try {
    const { data: updated } = await supabase_db.from("bot_channels").select("token_used, token_limit").eq("id", String(channelId)).maybeSingle();
    if (updated?.token_limit && updated.token_used > updated.token_limit) {
      try { await supabase_db.from("bot_channels").update({ ai_enabled: false, token_budget_exhausted: true }).eq("id", String(channelId)); } catch (_) {}
      note = "\n\n⚠️ Credit-Budget überschritten. KI vorübergehend deaktiviert. Credits aufladen: @autoacts";
    }
  } catch (_) {}

  await tg.call("sendMessage", { chat_id: String(adminUserId), text: result.text + `\n\n<i>📊 Dir wurden ${billedTokens} Credits berechnet.</i>` + note, parse_mode: "HTML" });
}

module.exports = { createDailySummary, runDailySummary };
