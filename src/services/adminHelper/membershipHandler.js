const crypto = require("crypto");
const { tgAdminHelper } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const logger = require("../../utils/logger");

async function handleBotAdded(tg, supabase, mcm, token) {
  const status = mcm.new_chat_member?.status;
  const chat = mcm.chat;
  const chatIdStr = String(chat.id);

  // 1. Bot wurde entfernt, gekickt oder hat seine Admin-Rechte verloren
  if (["left", "kicked", "member", "restricted"].includes(status)) {
    try {
      await supabase.from("bot_channels").update({
        is_active: false,
        updated_at: new Date()
      }).eq("id", chatIdStr);
      logger.info(`Bot wurde aus ${chatIdStr} entfernt. Status auf inaktiv gesetzt.`);
    } catch (e) {}
    return;
  }

  // 2. Bot wurde als Admin hinzugefügt
  if (["administrator", "creator"].includes(status)) {
    const addedBy = mcm.from;
    const settingsToken = crypto.randomBytes(16).toString("hex");

    try {
      const { data: existing } = await supabase.from("bot_channels").select("id").eq("id", chatIdStr).maybeSingle();

      const channelData = {
        title: chat.title || chatIdStr,
        username: chat.username || null,
        type: chat.type,
        is_active: true,
        ai_enabled: false,
        added_by_user_id: addedBy?.id ? String(addedBy.id) : null,
        added_by_username: addedBy?.username || null,
        settings_token: settingsToken,
        updated_at: new Date()
      };

      if (existing) {
        await supabase.from("bot_channels").update(channelData).eq("id", chatIdStr);
      } else {
        await supabase.from("bot_channels").insert([{
          id: chatIdStr,
          ...channelData
        }]);
      }
    } catch (dbErr) {
      logger.error(`[handleBotAdded] DB Error: ${dbErr.message}`);
    }

    // Erfolgsmeldung im Channel (allgemein, mit Hinweis auf @autoacts für AI)
    // Auto-Delete nach 10 Min via safelistService.trackBotMessage
    const successText =
      `✅ <b>AdminHelper erfolgreich hinzugefügt!</b>\n\n` +
      `Schreibe <code>/admin</code> oder <code>/menu</code> für das Verwaltungs-Menü.\n\n` +
      `🤖 <b>KI-Features (Smalltalk, Wissensdatenbank, Auto-Antworten, Tagesbericht)</b> ` +
      `können bei <a href="https://t.me/autoacts">@autoacts</a> freigeschaltet werden.\n\n` +
      `<i>Diese Nachricht wird in 10 Minuten automatisch gelöscht.</i>`;

    try {
      const sentChannel = await tg.send(chat.id, successText);
      if (sentChannel?.message_id) {
        // 10 Min = 600.000 ms → safelistService.runAutoDelete übernimmt
        await safelistService.trackBotMessage(chat.id, sentChannel.message_id, "bot_added", 600_000);
      }
    } catch (e) {
      logger?.warn?.(`[handleBotAdded] Channel-Nachricht fehlgeschlagen: ${e.message}`);
    }

    if (addedBy?.id) {
      try {
        const sentPm = await tg.send(String(addedBy.id),
          `✅ <b>AdminHelper zu "${chat.title}" hinzugefügt!</b>\n\n` +
          `Tippe in der Gruppe <code>/admin</code> oder <code>/menu</code> für das Verwaltungs-Menü.\n\n` +
          `🤖 Für KI-Features (Smalltalk, Wissensdatenbank, Auto-Antworten, Tagesbericht): ` +
          `<a href="https://t.me/autoacts">@autoacts</a> kontaktieren.`
        );
        // PM bleibt stehen — User soll Hinweis nicht verlieren
      } catch (e) {
        logger?.debug?.(`[handleBotAdded] PM an Admin fehlgeschlagen: ${e.message}`);
      }
    }
  }
}

async function handleMemberChanges(tg, supabase, msg, token) {
  const chatId = String(msg.chat.id);
  const ch = await supabase.from("bot_channels").select("*").eq("id", chatId).maybeSingle().then(res => res.data || null);

  if (msg.new_chat_members) {
    for (const u of msg.new_chat_members) {
      await tgAdminHelper.trackMember(chatId, u);
      if (ch) await tgAdminHelper.sendWelcome(token, chatId, u, ch);
    }
    return;
  }

  if (msg.left_chat_member) {
    await tgAdminHelper.trackLeft(chatId, msg.left_chat_member.id);
    if (ch) await tgAdminHelper.sendGoodbye(token, chatId, msg.left_chat_member, ch);
    return;
  }
}

module.exports = {
  handleBotAdded,
  handleMemberChanges
};
