const axios = require("axios");
const supabase = require("../../config/supabase");
const safelistService = require("./safelistService");
const { t } = require("../i18n");

// ─── Lokales DICT entfernt – nun zentrales Translation-Tool aus services/i18n.js
// Schlüssel-Mapping (alt → neu):
//   admin_menu  → ah_menu
//   clean       → ah_clean
//   pin         → ah_pin
//   count       → ah_count
//   del_last    → ah_del_last
//   sched       → ah_sched
//   safe        → ah_safe
//   no_admin    → ah_no_admin
//   clean_res   → ah_clean_res
//   count_res   → ah_count_res
//   pin_ok      → ah_pin_ok
//   pin_err     → ah_pin_err
//   sched_none  → ah_sched_none
//   sched_list  → ah_sched_list

function tgApi(token) {
  const base = `https://api.telegram.org/bot${token}`;

  // Wenn der Aufrufer entities/caption_entities mitgibt, dürfen wir KEINEN
  // parse_mode setzen — Telegram lehnt sonst die Nachricht mit
  // "Bad Request: can't parse entities" ab. Diese Logik macht das
  // transparent, sodass alle bestehenden send*-Aufrufe weiterhin den
  // HTML-Parse-Mode bekommen, NUR wenn keine entities präsent sind.
  function _withParseMode(extra, entityField) {
    if (extra && (Array.isArray(extra.entities) || Array.isArray(extra.caption_entities))) {
      const out = { ...extra };
      delete out.parse_mode;
      return out;
    }
    return { parse_mode: "HTML", ...(extra || {}) };
  }

  return {
    async call(method, params = {}) { const r = await axios.post(`${base}/${method}`, params, { timeout: 10000 }); return r.data?.result; },
    async send(chatId, text, extra = {}) {
      return this.call("sendMessage", { chat_id: chatId, text, ..._withParseMode(extra, "entities") });
    },
    async sendPhoto(chatId, photo, caption, extra = {}) {
      return this.call("sendPhoto", { chat_id: chatId, photo, caption, ..._withParseMode(extra, "caption_entities") });
    },
    async sendVideo(chatId, video, caption, extra = {}) {
      return this.call("sendVideo", { chat_id: chatId, video, caption, ..._withParseMode(extra, "caption_entities") });
    },
    async sendAnimation(chatId, animation, caption, extra = {}) {
      return this.call("sendAnimation", { chat_id: chatId, animation, caption, ..._withParseMode(extra, "caption_entities") });
    },
    async kick(chatId, userId) { return this.call("banChatMember", { chat_id: chatId, user_id: userId, revoke_messages: false }); },
    async unban(chatId, userId) { return this.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true }); },
    async getMember(chatId, userId) { return this.call("getChatMember", { chat_id: chatId, user_id: userId }); },
    async getAdmins(chatId) { return this.call("getChatAdministrators", { chat_id: chatId }) || []; },
    async deleteMessage(chatId, msgId) { return this.call("deleteMessage", { chat_id: chatId, message_id: msgId }); },
    async pinMessage(chatId, msgId, disableNotif = false) { return this.call("pinChatMessage", { chat_id: chatId, message_id: msgId, disable_notification: disableNotif }); },
    async restrictMember(chatId, userId, permissions, until = 0) { return this.call("restrictChatMember", { chat_id: chatId, user_id: userId, permissions, until_date: until }); },
    async isUserAdmin(chatId, userId) {
      try {
        const admins = await this.getAdmins(chatId);
        return admins.some(a => String(a.user?.id) === String(userId));
      } catch (e) {
        return false;
      }
    }
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
        [{ text: t("ah_clean", userLang), callback_data: "admin_clean" }],
        [{ text: t("ah_pin", userLang), callback_data: "admin_pin_last" }],
        [{ text: t("ah_count", userLang), callback_data: "admin_count" }],
        [{ text: t("ah_del_last", userLang), callback_data: "admin_del_last" }],
        [{ text: t("ah_sched", userLang), callback_data: "admin_schedule" }],
        [{ text: t("ah_safe", userLang), callback_data: "admin_safelist" }]
      ]
    };
    return tg.send(chatId, t("ah_menu", userLang), { reply_markup: keyboard, ...(msgId ? { reply_to_message_id: msgId } : {}) });
  },

  async handleCallback(token, query, channel) {
    const tg = tgApi(token);
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    const targetChatId = query.extractedChannelId || chatId;
    const baseData = query.extractedChannelId ? data.replace('_' + query.extractedChannelId, '') : data;
    const lang = channel?.bot_language || query.from?.language_code?.substring(0, 2) || "de";

    const isAdmin = await tg.isUserAdmin(targetChatId, userId);
    if (!isAdmin) {
      await tg.call("answerCallbackQuery", { callback_query_id: query.id, text: t("ah_no_admin", lang) });
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
        await tg.send(chatId, t("ah_clean_res", lang, { checked, removed }));
        break;
      }
      case "admin_count": {
        const count = await tg.call("getChatMembersCount", { chat_id: targetChatId }).catch(() => "?");
        await tg.send(chatId, t("ah_count_res", lang, { count }));
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
          await tg.send(chatId, t("ah_pin_ok", lang));
        } else {
          await tg.send(chatId, t("ah_pin_err", lang));
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
          await tg.send(chatId, t("ah_sched_none", lang));
        } else {
          const list = msgs.map(m => `• ${m.message.substring(0, 50)}… → ${m.next_run_at ? new Date(m.next_run_at).toLocaleString(lang === "en" ? "en-US" : "de-DE") : "einmalig"}`).join("\n");
          await tg.send(chatId, t("ah_sched_list", lang, { list }));
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
          chat_id: chatId, message_id: query.message.message_id, text: t("ah_menu", lang), parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t("ah_clean", lang), callback_data: "admin_clean" + suffix }],
              [{ text: t("ah_pin", lang), callback_data: "admin_pin_last" + suffix }],
              [{ text: t("ah_count", lang), callback_data: "admin_count" + suffix }],
              [{ text: t("ah_del_last", lang), callback_data: "admin_del_last" + suffix }],
              [{ text: t("ah_sched", lang), callback_data: "admin_schedule" + suffix }],
              [{ text: t("ah_safe", lang), callback_data: "admin_safelist" + suffix }]
            ]
          }
        }).catch(() => {});
        break;
      }
    }
  },

  /**
   * Substituiert die unterstützten Platzhalter in einem Welcome/Goodbye-Text.
   *
   * Unterstützte Platzhalter:
   *   {name}        → erste-name (HTML-bold) — "fallback chain"
   *   {first_name}  → user.first_name (escaped)
   *   {last_name}   → user.last_name (escaped, leer wenn nicht gesetzt)
   *   {username}    → "@user" wenn vorhanden, sonst leer
   *   {user_id}     → numerische Telegram-ID
   *   {chat_title}  → Channel/Gruppen-Titel
   *   {chat}        → Chat-ID (numerisch, behavior wie bisher)
   *   {time}        → aktuelle Uhrzeit HH:MM (Server-Zeit)
   *   {date}        → aktuelles Datum DD.MM.YYYY
   *   {member_count}→ aktuelle Mitgliederzahl (best effort, leer bei Fehler)
   *
   * Mehrfaches Vorkommen wird ersetzt.
   */
  _renderTemplate(template, user, channel, chatId, memberCount) {
    if (!template) return "";
    const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const firstName = esc(user?.first_name || "");
    const lastName  = esc(user?.last_name || "");
    const usernameHandle = user?.username ? "@" + esc(user.username) : "";
    const display = firstName || (user?.username ? "@" + esc(user.username) : "Mitglied");

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const MM = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();

    const map = {
      "{name}":         `<b>${display}</b>`,
      "{first_name}":   firstName,
      "{last_name}":    lastName,
      "{username}":     usernameHandle,
      "{user_id}":      String(user?.id || ""),
      "{chat_title}":   esc(channel?.title || ""),
      "{chat}":         String(chatId || ""),
      "{time}":         `${hh}:${mm}`,
      "{date}":         `${dd}.${MM}.${yyyy}`,
      "{member_count}": String(memberCount ?? "")
    };
    let out = String(template);
    for (const [k, v] of Object.entries(map)) {
      out = out.split(k).join(v);
    }
    return out;
  },

  async sendWelcome(token, chatId, user, channel) {
    if (!channel?.welcome_msg) return;
    const tg = tgApi(token);
    let memberCount = null;
    try {
      memberCount = await tg.call("getChatMembersCount", { chat_id: chatId });
    } catch (_) {}
    const msg = this._renderTemplate(channel.welcome_msg, user, channel, chatId, memberCount);
    await tg.send(chatId, msg).catch(() => {});
  },

  async sendGoodbye(token, chatId, user, channel) {
    if (!channel?.goodbye_msg) return;
    const tg = tgApi(token);
    let memberCount = null;
    try {
      memberCount = await tg.call("getChatMembersCount", { chat_id: chatId });
    } catch (_) {}
    const msg = this._renderTemplate(channel.goodbye_msg, user, channel, chatId, memberCount);
    await tg.send(chatId, msg).catch(() => {});
  },

  async runAutoClean(token) {
    const now = new Date();
    try {
      const { data: channels } = await supabase.from("bot_channels")
        .select("id, auto_clean_interval, last_clean_at")
        .in("auto_clean_interval", ["daily", "weekly"])
        .eq("is_active", true);

      if (!channels || channels.length === 0) return;

      for (const ch of channels) {
        let shouldClean = false;
        
        if (!ch.last_clean_at) {
          shouldClean = true;
        } else {
          const lastClean = new Date(ch.last_clean_at);
          const hoursDiff = (now - lastClean) / (1000 * 60 * 60);

          if (ch.auto_clean_interval === "daily" && hoursDiff >= 24) shouldClean = true;
          if (ch.auto_clean_interval === "weekly" && hoursDiff >= 168) shouldClean = true;
        }

        if (shouldClean) {
          const { removed } = await this.cleanDeletedAccounts(token, ch.id);
          await supabase.from("bot_channels").update({ last_clean_at: now.toISOString() }).eq("id", ch.id);
          
          if (removed > 0) {
            const tg = tgApi(token);
            await tg.send(ch.id, `🧹 <b>Auto-Bereinigung:</b>\nEs wurden ${removed} gelöschte Accounts automatisch aus dem Kanal entfernt.`).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("[AutoClean Error]", e.message);
    }
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

          // Inline-Buttons rekonstruieren falls in DB hinterlegt.
          // Format aus Wizard: Array<Array<{text, url}>>
          let inlineKb = null;
          if (msg.inline_buttons) {
            try {
              const raw = typeof msg.inline_buttons === "string"
                ? JSON.parse(msg.inline_buttons)
                : msg.inline_buttons;
              if (Array.isArray(raw) && raw.length) inlineKb = raw;
            } catch (_) {}
          }

          // Message-Entities (bold/italic/custom_emoji etc.) rekonstruieren.
          // Diese wurden 1:1 aus der eingehenden Admin-Nachricht übernommen
          // und werden hier als entities (sendMessage) bzw. caption_entities
          // (sendPhoto/Video/Animation) wieder mitgegeben — dadurch werden
          // Premium/Custom Emojis korrekt animiert dargestellt.
          let entities = null;
          if (msg.entities) {
            try {
              const raw = typeof msg.entities === "string"
                ? JSON.parse(msg.entities)
                : msg.entities;
              if (Array.isArray(raw) && raw.length) entities = raw;
            } catch (_) {}
          }

          const extra = {};
          if (inlineKb) extra.reply_markup = { inline_keyboard: inlineKb };

          let sentMsg = null;
          const hasMedia = !!(msg.photo_file_id || msg.photo_url);

          if (hasMedia) {
             // Bei Mediennachrichten wird der Text als caption mitgesendet,
             // entities entsprechend als caption_entities.
             if (entities) extra.caption_entities = entities;
             const mediaId = msg.photo_file_id || msg.photo_url;
             if (msg.file_type === "video") {
                sentMsg = await tg.sendVideo(msg.channel_id, mediaId, msg.message, extra);
             } else if (msg.file_type === "animation") {
                sentMsg = await tg.sendAnimation(msg.channel_id, mediaId, msg.message, extra);
             } else {
                sentMsg = await tg.sendPhoto(msg.channel_id, mediaId, msg.message, extra);
             }
          } else {
             if (entities) extra.entities = entities;
             sentMsg = await tg.send(msg.channel_id, msg.message, extra);
          }
          
          if (msg.pin_after_send && sentMsg?.message_id) { await tg.pinMessage(msg.channel_id, sentMsg.message_id).catch(() => {}); }
          
          const updatePatch = { run_count: (msg.run_count || 0) + 1, last_sent_msg_id: sentMsg?.message_id || null };
          if (msg.repeat && msg.interval_minutes) {
             const nextRun = new Date(now.getTime() + (msg.interval_minutes * 60000));
             if (msg.end_at && nextRun > new Date(msg.end_at)) { updatePatch.is_active = false; } else { updatePatch.next_run_at = nextRun.toISOString(); }
          } else { updatePatch.is_active = false; }
          await supabase.from("scheduled_messages").update(updatePatch).eq("id", msg.id);
        } catch (e) {
          console.error(`Fehler beim Senden der geplanten Nachricht (ID: ${msg.id}): ${e.message}`);
        }
      }
    } catch (e) {}
  }
};

module.exports = { tgAdminHelper, tgApi };
