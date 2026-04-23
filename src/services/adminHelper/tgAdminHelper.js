const axios = require("axios");
const supabase = require("../../config/supabase");
const safelistService = require("./safelistService");

const DICT = {
  de: {
    admin_menu: "⚙️ <b>Admin-Menü</b>\nWähle eine Funktion:",
    clean: "🧹 Gelöschte Accounts entfernen",
    pin: "📌 Nachricht pinnen",
    count: "📋 Mitglieder-Anzahl",
    del_last: "🗑 Letzte Nachricht löschen",
    sched: "⏰ Geplante Nachrichten",
    safe: "🛡 Safelist verwalten",
    no_admin: "❌ Nur für Admins.",
    clean_res: "🧹 Ergebnis: {checked} Mitglieder geprüft, {removed} gelöschte Accounts entfernt.",
    count_res: "👥 Aktuelle Mitgliederzahl: <b>{count}</b>",
    pin_ok: "📌 Nachricht angeheftet!",
    pin_err: "Antworte auf die Nachricht die gepinnt werden soll mit /pin",
    sched_none: "⏰ Keine geplanten Nachrichten.\n\nNutze das Dashboard um Nachrichten zu planen.",
    sched_list: "⏰ <b>Geplante Nachrichten:</b>\n{list}"
  },
  en: {
    admin_menu: "⚙️ <b>Admin Menu</b>\nSelect a function:",
    clean: "🧹 Remove deleted accounts",
    pin: "📌 Pin message",
    count: "📋 Member count",
    del_last: "🗑 Delete last message",
    sched: "⏰ Scheduled messages",
    safe: "🛡 Manage Safelist",
    no_admin: "❌ Admins only.",
    clean_res: "🧹 Result: {checked} members checked, {removed} deleted accounts removed.",
    count_res: "👥 Current member count: <b>{count}</b>",
    pin_ok: "📌 Message pinned!",
    pin_err: "Reply to the message you want to pin with /pin",
    sched_none: "⏰ No scheduled messages.\n\nUse the dashboard to schedule messages.",
    sched_list: "⏰ <b>Scheduled messages:</b>\n{list}"
  }
};

function t(key, lang) {
  const l = DICT[lang] ? lang : (DICT["en"] ? "en" : "de");
  return DICT[l]?.[key] || DICT["de"][key] || key;
}

function tgApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    async call(method, params = {}) { const r = await axios.post(`${base}/${method}`, params, { timeout: 10000 }); return r.data?.result; },
    async send(chatId, text, extra = {}) { return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra }); },
    async sendPhoto(chatId, photo, caption, extra = {}) { return this.call("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra }); },
    async kick(chatId, userId) { return this.call("banChatMember", { chat_id: chatId, user_id: userId, revoke_messages: false }); },
    async unban(chatId, userId) { return this.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true }); },
    async getMember(chatId, userId) { return this.call("getChatMember", { chat_id: chatId, user_id: userId }); },
    async getAdmins(chatId) { return this.call("getChatAdministrators", { chat_id: chatId }) || []; },
    async deleteMessage(chatId, msgId) { return this.call("deleteMessage", { chat_id: chatId, message_id: msgId }); },
    async pinMessage(chatId, msgId, disableNotif = false) { return this.call("pinChatMessage", { chat_id: chatId, message_id: msgId, disable_notification: disableNotif }); },
    async restrictMember(chatId, userId, permissions, until = 0) { return this.call("restrictChatMember", { chat_id: chatId, user_id: userId, permissions, until_date: until }); }
  };
}

const tgAdminHelper = {
  async trackMember(channelId, user) {
    if (!user?.id) return;
    try {
      const { data: ext } = await supabase.from("channel_members").select("username, first_name").eq("channel_id", channelId).eq("user_id", user.id).maybeSingle();
      if (ext && (ext.username !== user.username || ext.first_name !== user.first_name)) {
        await supabase.from("user_name_history").insert([{ user_id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name }]);
      } else if (!ext) {
        await supabase.from("user_name_history").insert([{ user_id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name }]);
      }
      await supabase.from("channel_members").upsert([{
        channel_id: channelId, user_id: user.id, username: user.username || null, first_name: user.first_name || null, last_seen: new Date(), is_deleted: false
      }], { onConflict: "channel_id,user_id" });
    } catch (e) {}
  },

  async trackLeft(channelId, userId) {
    try { await supabase.from("channel_members").delete().eq("channel_id", channelId).eq("user_id", userId); } catch (_) {}
  },

  async cleanDeletedAccounts(token, channelId) {
    const tg = tgApi(token);
    const { data: members } = await supabase.from("channel_members").select("user_id, first_name, username").eq("channel_id", channelId).eq("is_deleted", false).limit(200);
    if (!members?.length) return { removed: 0, checked: 0 };
    let removed = 0, checked = 0;
    for (const m of members) {
      try {
        const cm = await tg.getMember(channelId, m.user_id);
        checked++;
        const isDeleted = !cm?.user?.first_name && !cm?.user?.username && cm?.status !== "left" && cm?.status !== "kicked";
        if (isDeleted || cm?.user?.is_deleted) {
          await tg.kick(channelId, m.user_id); await tg.unban(channelId, m.user_id);
          await supabase.from("channel_members").update({ is_deleted: true }).eq("channel_id", channelId).eq("user_id", m.user_id);
          removed++; await new Promise(r => setTimeout(r, 300));
        }
      } catch { }
    }
    return { removed, checked };
  },

  async sendAdminMenu(token, chatId, msgId = null, userLang = "de") {
    const tg = tgApi(token);
    const keyboard = {
      inline_keyboard: [
        [{ text: t("clean", userLang), callback_data: "admin_clean" }],
        [{ text: t("pin", userLang), callback_data: "admin_pin_last" }],
        [{ text: t("count", userLang), callback_data: "admin_count" }],
        [{ text: t("del_last", userLang), callback_data: "admin_del_last" }],
        [{ text: t("sched", userLang), callback_data: "admin_schedule" }],
        [{ text: t("safe", userLang), callback_data: "admin_safelist" }]
      ]
    };
    return tg.send(chatId, t("admin_menu", userLang), { reply_markup: keyboard, ...(msgId ? { reply_to_message_id: msgId } : {}) });
  },

  async handleCallback(token, query, channel) {
    const tg = tgApi(token);
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    const targetChatId = query.extractedChannelId || chatId;
    const baseData = query.extractedChannelId ? data.replace('_' + query.extractedChannelId, '') : data;
    const lang = channel?.bot_language || query.from?.language_code?.substring(0, 2) || "de";

    const admins = await tg.getAdmins(targetChatId).catch(() => []);
    const isAdmin = admins.some(a => a.user?.id === userId);
    if (!isAdmin) {
      await tg.call("answerCallbackQuery", { callback_query_id: query.id, text: t("no_admin", lang) });
      return;
    }

    await tg.call("answerCallbackQuery", { callback_query_id: query.id });

    if (baseData.startsWith("safelist_del_") || baseData.startsWith("del_safelist_")) {
      const idToDel = baseData.split("_").pop();
      if (safelistService && safelistService.removeFromSafelist) {
        await safelistService.removeFromSafelist(String(targetChatId), idToDel);
        await safelistService.sendSafelistMenu(token, targetChatId, chatId, query.message.message_id);
      }
      return;
    }

    switch (baseData) {
      case "admin_clean": {
        const { removed, checked } = await this.cleanDeletedAccounts(token, String(targetChatId));
        await tg.send(chatId, t("clean_res", lang).replace("{checked}", checked).replace("{removed}", removed));
        break;
      }
      case "admin_count": {
        const count = await tg.call("getChatMembersCount", { chat_id: targetChatId }).catch(() => "?");
        await tg.send(chatId, t("count_res", lang).replace("{count}", count));
        break;
      }
      case "admin_pin_last": {
        if (targetChatId !== chatId) {
          await tg.send(chatId, "❌ Diese Funktion ist nur direkt im Channel/in der Gruppe als Reply auf eine Nachricht verfügbar.");
          break;
        }
        const msgToPin = query.message?.reply_to_message?.message_id;
        if (msgToPin) {
          await tg.pinMessage(chatId, msgToPin);
          await tg.send(chatId, t("pin_ok", lang));
        } else {
          await tg.send(chatId, t("pin_err", lang));
        }
        break;
      }
      case "admin_del_last": {
        if (targetChatId !== chatId) {
          await tg.send(chatId, "❌ Diese Funktion ist nur direkt im Channel/in der Gruppe verfügbar.");
          break;
        }
        const delId = query.message?.message_id - 1;
        if (delId) await tg.deleteMessage(chatId, delId).catch(() => {});
        await tg.deleteMessage(chatId, query.message.message_id).catch(() => {});
        break;
      }
      case "admin_schedule": {
        const { data: msgs } = await supabase.from("scheduled_messages").select("id, message, next_run_at, repeat").eq("channel_id", String(targetChatId)).eq("is_active", true);
        if (!msgs?.length) {
          await tg.send(chatId, t("sched_none", lang));
        } else {
          const list = msgs.map(m => `• ${m.message.substring(0, 50)}… → ${m.next_run_at ? new Date(m.next_run_at).toLocaleString(lang === "en" ? "en-US" : "de-DE") : "einmalig"}`).join("\n");
          await tg.send(chatId, t("sched_list", lang).replace("{list}", list));
        }
        break;
      }
      case "admin_safelist": {
        if (safelistService && safelistService.sendSafelistMenu) { 
          await safelistService.sendSafelistMenu(token, targetChatId, chatId, query.message.message_id); 
        }
        break;
      }
      case "admin_menu": {
        const suffix = query.extractedChannelId ? `_${query.extractedChannelId}` : "";
        await tg.call("editMessageText", {
          chat_id: chatId, message_id: query.message.message_id, text: t("admin_menu", lang), parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t("clean", lang), callback_data: "admin_clean" + suffix }],
              [{ text: t("pin", lang), callback_data: "admin_pin_last" + suffix }],
              [{ text: t("count", lang), callback_data: "admin_count" + suffix }],
              [{ text: t("del_last", lang), callback_data: "admin_del_last" + suffix }],
              [{ text: t("sched", lang), callback_data: "admin_schedule" + suffix }],
              [{ text: t("safe", lang), callback_data: "admin_safelist" + suffix }]
            ]
          }
        }).catch(() => {});
        break;
      }
    }
  },

  async sendWelcome(token, chatId, user, channel) {
    if (!channel?.welcome_msg) return;
    const tg = tgApi(token);
    const name = user.first_name || user.username || "Neues Mitglied";
    const msg = channel.welcome_msg.replace("{name}", `<b>${name}</b>`).replace("{chat}", chatId);
    await tg.send(chatId, msg).catch(() => {});
  },

  async sendGoodbye(token, chatId, user, channel) {
    if (!channel?.goodbye_msg) return;
    const tg = tgApi(token);
    const name = user.first_name || user.username || "Mitglied";
    const msg = channel.goodbye_msg.replace("{name}", `<b>${name}</b>`);
    await tg.send(chatId, msg).catch(() => {});
  },

  async fireScheduled(token) {
    const now = new Date();
    try {
      const { data: due } = await supabase.from("scheduled_messages").select("*").eq("is_active", true).lte("next_run_at", now.toISOString());
      for (const msg of (due || [])) {
        if (msg.end_at && new Date(msg.end_at) < now) { await supabase.from("scheduled_messages").update({ is_active: false }).eq("id", msg.id); continue; }
        const tg = tgApi(token);
        try {
          if (msg.delete_previous && msg.last_sent_msg_id) { await tg.call("deleteMessage", { chat_id: msg.channel_id, message_id: msg.last_sent_msg_id }).catch(() => {}); }
          let sentMsg = null;
          if (msg.photo_file_id || msg.photo_url) { sentMsg = await tg.sendPhoto(msg.channel_id, msg.photo_file_id || msg.photo_url, msg.message); } else { sentMsg = await tg.send(msg.channel_id, msg.message); }
          if (msg.pin_after_send && sentMsg?.message_id) { await tg.pinMessage(msg.channel_id, sentMsg.message_id).catch(() => {}); }
          const updatePatch = { run_count: (msg.run_count || 0) + 1, last_sent_msg_id: sentMsg?.message_id || null };
          if (msg.repeat && msg.interval_minutes) {
             const nextRun = new Date(now.getTime() + (msg.interval_minutes * 60000));
             if (msg.end_at && nextRun > new Date(msg.end_at)) { updatePatch.is_active = false; } else { updatePatch.next_run_at = nextRun.toISOString(); }
          } else { updatePatch.is_active = false; }
          await supabase.from("scheduled_messages").update(updatePatch).eq("id", msg.id);
        } catch (e) {}
      }
    } catch (e) {}
  }
};

module.exports = { tgAdminHelper, tgApi };