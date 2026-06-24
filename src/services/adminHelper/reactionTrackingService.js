/**
 * reactionTrackingService.js — Telegram message_reaction Handler (1.6.74)
 *
 * Telegram sendet ein "message_reaction"-Update wenn ein User auf eine
 * Nachricht reagiert (👍, ❤️, 🔥, etc.) — ABER nur wenn:
 *   1) Der Bot Admin in der Gruppe ist
 *   2) Bei setWebhook "message_reaction" in allowed_updates enthalten ist
 *
 * Die Reaction wird in message_reactions geloggt. Wenn die reaktive Nachricht
 * vom Bot stammt (bot_messages-Tabelle enthält die message_id), wird is_bot_message=true
 * gesetzt — die Channel-AI sieht später diese Reactions im Kontext-Build.
 */
const logger = require("../../utils/logger");

/**
 * @param  supabase  — Supabase-Client
 * @param  reaction  — update.message_reaction von Telegram
 *   Format: { chat: {id}, message_id, user: {id, username, ...},
 *             old_reaction: [...], new_reaction: [{type, emoji}, ...], date }
 */
async function handleReactionUpdate(supabase, reaction, botToken) {
  if (!reaction?.chat?.id || !reaction?.message_id) return;
  const channelId = String(reaction.chat.id);
  const msgId     = parseInt(reaction.message_id);
  const userObj   = reaction.user || reaction.actor_chat || {};
  const userId    = userObj?.id ? parseInt(userObj.id) : null;
  if (!userId) return;

  // Neu hinzugefügte Reactions = new_reaction MINUS old_reaction
  const oldSet = new Set((reaction.old_reaction || []).map(r => r.emoji || r.custom_emoji_id || JSON.stringify(r)));
  const added  = (reaction.new_reaction || []).filter(r => !oldSet.has(r.emoji || r.custom_emoji_id || JSON.stringify(r)));

  if (!added.length) return;  // Nur Entfernen, kein neues Reagieren → ignorieren

  // Prüfen ob die Nachricht vom Bot stammt:
  //   1) bot_messages-Tabelle (vom Auto-Cleanup-System getrackt)
  //   2) channel_chat_history mit role='assistant' (AI-Antworten)
  let isBotMsg = false;
  let botMsgText = null;
  try {
    const { data } = await supabase.from("bot_messages")
      .select("id")
      .eq("channel_id", channelId)
      .eq("message_id", msgId)
      .limit(1).maybeSingle();
    if (data) isBotMsg = true;
  } catch (_) {}

  if (!isBotMsg) {
    try {
      const { data: histRow } = await supabase.from("channel_chat_history")
        .select("content")
        .eq("channel_id", channelId)
        .eq("msg_id", msgId)
        .eq("role", "assistant")
        .limit(1).maybeSingle();
      if (histRow) {
        isBotMsg = true;
        botMsgText = String(histRow.content).substring(0, 200);
      }
    } catch (_) {}
  }

  // Pro hinzugefügter Reaction ein Eintrag
  const rows = added.map(r => ({
    channel_id:     channelId,
    message_id:     msgId,
    user_id:        userId,
    username:       userObj.username || null,
    reaction_emoji: r.emoji || (r.custom_emoji_id ? `[custom:${r.custom_emoji_id}]` : null),
    reaction_type:  r.type || "emoji",
    is_bot_message: isBotMsg,
    bot_msg_text:   botMsgText
  }));

  try {
    await supabase.from("message_reactions").insert(rows);
  } catch (e) {
    logger.warn(`[Reaction] insert: ${e.message}`);
    return;
  }

  if (isBotMsg) {
    const emojiList = added.map(r => r.emoji).filter(Boolean).join(" ");
    logger.info(`[Reaction] ${userObj.username || userId} reagierte auf Bot-Nachricht ${msgId} mit ${emojiList || "(custom)"}`);
  }
}

/**
 * Holt die letzten Reactions eines Users auf Bot-Nachrichten in einem Channel.
 * Die Channel-AI nutzt das im Kontext-Build.
 *
 * @returns Array<{ emoji, bot_msg_text, added_at, message_id }>
 */
async function getRecentReactionsForUser(supabase, channelId, userId, limit = 5) {
  if (!channelId || !userId) return [];
  try {
    const { data } = await supabase.from("message_reactions")
      .select("reaction_emoji, bot_msg_text, added_at, message_id")
      .eq("channel_id", String(channelId))
      .eq("user_id", parseInt(userId))
      .eq("is_bot_message", true)
      .order("added_at", { ascending: false })
      .limit(limit);
    return data || [];
  } catch (e) {
    logger.warn(`[Reaction] getRecentReactionsForUser: ${e.message}`);
    return [];
  }
}

/**
 * Baut einen kompakten Kontext-String über die letzten Reactions des Users.
 * Beispiel-Output:
 *   "Reaktionen dieses Users auf deine letzten Antworten:
 *    👍 auf "Hier ist die Bestellbestätigung..."
 *    🔥 auf "Du hast Glück, das Produkt ist verfügbar"
 *    😡 auf "Leider kann ich das nicht erstatten"
 *   Wenn relevant, gehe darauf ein."
 */
async function buildReactionContext(supabase, channelId, userId) {
  const reactions = await getRecentReactionsForUser(supabase, channelId, userId, 5);
  if (!reactions.length) return "";

  const lines = reactions.map(r => {
    const emoji   = r.reaction_emoji || "?";
    const snippet = r.bot_msg_text ? `"${String(r.bot_msg_text).substring(0, 80).replace(/"/g, "'")}"` : `(Nachricht ${r.message_id})`;
    return `  ${emoji} auf ${snippet}`;
  });

  return `==== USER-REAKTIONEN AUF DEINE LETZTEN ANTWORTEN ====\n` +
         lines.join("\n") +
         `\nWenn passend, kannst du im Gespräch implizit darauf eingehen (z.B. positives Feedback aufgreifen, Verärgerung respektvoll adressieren). ` +
         `Erwähne aber NICHT explizit dass du Reaktionen tracken kannst.\n` +
         `====================================================`;
}

module.exports = {
  handleReactionUpdate,
  getRecentReactionsForUser,
  buildReactionContext
};
