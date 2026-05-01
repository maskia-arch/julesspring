const supabase = require("../../config/supabase");

function normalizeForBlacklist(text) {
  return text.toLowerCase()
    .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/1/g, 'i').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[@$]/g, 'a').replace(/[^a-z0-9äöüß]/g, '');
}

async function handleMessageAutoDelete(tg, supabase_db, channelId, messageId, hours) {
  const deleteAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  try {
    await supabase_db.from("bot_messages").insert([{
      channel_id: String(channelId),
      message_id: messageId,
      msg_type: "tolerated_blacklist",
      delete_after: deleteAt
    }]);
  } catch (_) {}
}

async function checkBlacklist(supabase_db, channelId, messageText, from, chatId, msgId, tg, token) {
  if (!messageText?.trim()) return;
  let entries;
  try {
    const { data } = await supabase_db.from("channel_blacklist")
      .select("word, severity").eq("channel_id", String(channelId));
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

  let ch = null;
  try {
    const { data } = await supabase_db.from("bot_channels")
      .select("added_by_user_id, title, bl_hard_consequences, bl_soft_delete_hours")
      .eq("id", String(channelId)).maybeSingle();
    ch = data;
  } catch (_) {}

  const targetName = from.username ? "@" + from.username : (from.first_name || String(from.id));
  const isTolerated = hit.severity === "tolerated";
  
  if (isTolerated) {
    const softHours = ch?.bl_soft_delete_hours || 0;
    try {
      await supabase_db.from("blacklist_hits").insert([{
        channel_id: String(channelId), user_id: from.id,
        username: from.username || null, word_hit: hit.word,
        message_text: messageText.substring(0, 200), action_taken: "tolerated"
      }]);
    } catch (_) {}

    if (softHours > 0) {
      await handleMessageAutoDelete(tg, supabase_db, channelId, msgId, softHours);
    }
    return { hit, action: "tolerated", actionText: softHours > 0 ? `Löschen nach ${softHours}h` : "Nur Warnung" };
  }

  const consequences = ch?.bl_hard_consequences || [];
  let actionsTaken = [];

  try {
    await supabase_db.from("blacklist_hits").insert([{
      channel_id: String(channelId), user_id: from.id,
      username: from.username || null, word_hit: hit.word,
      message_text: messageText.substring(0, 200), action_taken: consequences.join(",")
    }]);
  } catch (_) {}

  const sentWarn = await tg.call("sendMessage", {
    chat_id: chatId,
    reply_to_message_id: msgId,
    text: `⚠️ <b>Blacklist Wort erkannt!</b>\nKonsequenzen werden durchgeführt...`,
    parse_mode: "HTML"
  }).catch(() => null);

  if (consequences.includes("delete")) {
    await tg.call("deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => {});
    actionsTaken.push("Nachricht gelöscht");
  }

  if (consequences.includes("mute")) {
    try {
      await tg.call("restrictChatMember", {
        chat_id: chatId, user_id: from.id,
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + (12 * 3600)
      });
      actionsTaken.push("12h stummgeschaltet");
    } catch (_) {}
  }

  if (consequences.includes("ban")) {
    try {
      await tg.call("banChatMember", { chat_id: chatId, user_id: from.id, until_date: 0 });
      await supabase_db.from("channel_banned_users").upsert([{
        channel_id: String(channelId),
        user_id: String(from.id),
        username: from.username || null,
        reason: `Blacklist Wort: ${hit.word}`,
        banned_at: new Date().toISOString()
      }], { onConflict: "channel_id,user_id" });
      actionsTaken.push("Gebannt");
    } catch (_) {}
  }

  if (sentWarn?.message_id) {
    setTimeout(() => {
      tg.call("deleteMessage", { chat_id: chatId, message_id: sentWarn.message_id }).catch(() => {});
    }, 5000);
  }

  if (ch?.added_by_user_id) {
    try {
      await tg.call("sendMessage", { chat_id: String(ch.added_by_user_id),
        text: `🛡 <b>Blacklist-Eingriff</b>\n\nChannel: ${ch.title || channelId}\nUser: ${targetName}\nWort: <code>${hit.word}</code>\nAktionen: ${actionsTaken.length ? actionsTaken.join(", ") : "Keine"}\n\nNachricht:\n<i>${messageText.substring(0, 150)}</i>`,
        parse_mode: "HTML" });
    } catch (_) {}
  }

  return { hit, action: consequences.join(","), actionText: actionsTaken.join(", ") };
}

module.exports = {
  normalizeForBlacklist,
  checkBlacklist
};
