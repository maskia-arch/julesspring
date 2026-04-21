const axios = require("axios");

async function createDailySummary(supabase_db, channelId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const since = new Date(Date.now() - 86400000).toISOString();
  let ctxMsgs = [], members = [];

  try {
    const { data: hist } = await supabase_db
      .from("channel_chat_history")
      .select("user_id, content, created_at")
      .eq("channel_id", String(channelId))
      .eq("role", "user")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(300);
    ctxMsgs = hist || [];
  } catch (_) {}

  try {
    const { data: m } = await supabase_db
      .from("channel_members")
      .select("is_deleted")
      .eq("channel_id", String(channelId));
    members = m || [];
  } catch (_) {}

  const joins = members.filter(m => !m.is_deleted).length;
  const leaves = members.filter(m => m.is_deleted).length;

  if (!ctxMsgs.length) {
    return {
      text: `📰 <b>Tageszusammenfassung</b>\n\nKeine User-Nachrichten in den letzten 24h.\n\n👥 Eintritte: ${joins} · Austritte: ${leaves}`,
      outTokens: 0, inTokens: 0, usd: 0
    };
  }

  let userNames = {};
  try {
    const { data: memberList } = await supabase_db.from("channel_members").select("user_id, username, first_name").eq("channel_id", String(channelId));
    (memberList || []).forEach(m => {
      userNames[String(m.user_id)] = m.username ? "@" + m.username : (m.first_name || String(m.user_id));
    });
  } catch (_) {}

  const lines = ctxMsgs.map(m => {
    const ts = new Date(m.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const who = userNames[String(m.user_id)] || String(m.user_id);
    return `[${ts}] ${who}: ${(m.content || "").substring(0, 200)}`;
  }).join("\n").substring(0, 5000);

  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 5000,
        temperature: 0.3,
        messages: [
          { role: "system", content: "Du bist ein Assistent der Telegram-Gruppen-Tagesberichte erstellt. Fasse die Aktivitäten in 5-8 prägnanten Stichpunkten zusammen. Zensiere Beleidigungen oder unangemessene Inhalte mit [***]. Verwende keine echten Usernamen. Schreibe auf Deutsch." },
          { role: "user", content: `Erstelle einen Tagesbericht für diesen Telegram-Channel.\n\nNachrichten der letzten 24h:\n${lines}\n\nMitglieder-Statistik: ${joins} aktiv, ${leaves} ausgetreten.` }
        ]
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 45000 }
    );

    const usage = resp.data?.usage || {};
    const outTokens = usage.completion_tokens || 0;
    const inTokens = usage.prompt_tokens || 0;
    const summaryTxt = resp.data?.choices?.[0]?.message?.content?.trim() || "(Keine Zusammenfassung)";

    return {
      text: `📰 <b>Tageszusammenfassung</b>\n\n${summaryTxt}\n\n👥 ${joins} aktive Mitglieder · ${leaves} ausgetreten`,
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
