const crypto = require("crypto");
const { tgAdminHelper } = require("./tgAdminHelper");

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

      let dbResult;
      if (existing) {
        dbResult = await supabase.from("bot_channels").update({
          title: chat.title || chatIdStr,
          username: chat.username || null,
          type: chat.type,
          is_active: true, // Wird wieder aktiviert, falls er neu hinzugefügt wurde
          updated_at: new Date()
        }).eq("id", chatIdStr).select("id");
      } else {
        dbResult = await supabase.from("bot_channels").insert([{
          id: chat.id,
          title: chat.title || chatIdStr,
          username: chat.username || null,
          type: chat.type,
          is_active: true, // Standardmäßig aktiv beim Hinzufügen
          updated_at: new Date()
        }]).select("id");
      }

      if (!dbResult?.error) {
        await supabase.from("bot_channels").update({
          ai_enabled: false,
          added_by_user_id: addedBy?.id || null,
          added_by_username: addedBy?.username || null,
          settings_token: settingsToken
        }).eq("id", chatIdStr);
      }
    } catch (dbErr) {
    }

    await tg.send(chat.id, `✅ <b>TG Admin-Helper aktiv!</b>\n\nVerfügbare Befehle für Admins:\n• /admin oder /menu – Verwaltungstools\n• /settings – Channel-Einstellungen\n• /clean – Gelöschte Accounts entfernen\n• /safelist @user – User verifizieren\n• /scamlist @user – Scammer melden\n\n🔒 AI-Features → @autoacts kontaktieren.`);

    if (addedBy?.id) {
      await tg.send(String(addedBy.id), `✅ <b>Bot wurde zu "${chat.title}" hinzugefügt!</b>\n\nSchreibe <b>/settings</b> im Channel um die Einstellungen zu öffnen.\nDu kannst das Menü direkt hier (privat) oder im Channel anzeigen lassen.\n\n🤖 <b>Kostenlose Tools sind sofort aktiv.</b>\nFür KI-Features: @autoacts kontaktieren.`).catch(() => {});
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
