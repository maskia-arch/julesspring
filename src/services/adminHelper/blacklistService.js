const supabase = require("../../config/supabase");

function normalizeForBlacklist(text) {
  return text.toLowerCase()
    .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/1/g, 'i').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[@$]/g, 'a').replace(/[^a-z0-9äöüß]/g, '');
}

async function checkBlacklist(supabase_db, channelId, messageText, from, chatId, tg, token) {
  if (!messageText?.trim()) return;
  let entries;
  try {
    const { data } = await supabase_db.from("channel_blacklist")
      .select("word, severity, tolerate_hours, category").eq("channel_id", String(channelId));
    entries = data || [];
  } catch (_) { return; }
  if (!entries.length) return;

  const normMsg = normalizeForBlacklist(messageText);
  let hit = null;
  for (const e of entries) {
    const normWord = normalizeForBlacklist(e.word);
    if (normMsg.includes(normWord)) { hit = e; break; }
  }
  if (!hit) return;

  const targetName = from.username ? "@" + from.username : (from.first_name || String(from.id));
  let action = hit.severity;

  try {
    await supabase_db.from("blacklist_hits").insert([{
      channel_id: String(channelId), user_id: from.id,
      username: from.username || null, word_hit: hit.word,
      message_text: messageText.substring(0, 200), action_taken: action
    }]);
  } catch (_) {}

  if (action === "tolerated") {
    return;
  }

  let actionText = "";
  if (action === "mute" || action === "warn") {
    const muteSec = 12 * 3600;
    try {
      await tg.call("restrictChatMember", {
        chat_id: chatId, user_id: from.id,
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + muteSec
      });
      actionText = "12h stummgeschaltet";
    } catch (_) {}
  } else if (action === "ban") {
    try {
      await tg.call("banChatMember", { chat_id: chatId, user_id: from.id, until_date: 0 });
      actionText = "gebannt";
    } catch (_) {}
  }

  try {
    const { data: ch } = await supabase_db.from("bot_channels").select("added_by_user_id").eq("id", String(channelId)).maybeSingle();
    if (ch?.added_by_user_id) {
      await tg.call("sendMessage", { chat_id: String(ch.added_by_user_id),
        text: `⚠️ <b>Blacklist-Treffer</b>\n\nUser: ${targetName}\nWort: <code>${hit.word}</code> (${hit.category})\nAktion: ${actionText || "Nachricht gelöscht"}\nNachricht: <i>${messageText.substring(0, 100)}</i>`,
        parse_mode: "HTML" });
    }
  } catch (_) {}

  return { hit, action, actionText };
}

module.exports = {
  normalizeForBlacklist,
  checkBlacklist
};
