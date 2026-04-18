/**
 * tgAdminHelper.js  v1.4.5
 *
 * Kostenlose Telegram-Gruppen-Verwaltungstools (kein AI nötig).
 * Nutzt ausschliesslich die offizielle Telegram Bot API.
 *
 * Verfügbare Tools:
 *  - Gelöschte Accounts entfernen (trackbasiert)
 *  - Welcome/Goodbye Nachrichten
 *  - Nachrichten löschen (auf Befehl)
 *  - Member-Tracking
 *  - Inline-Command-Menü für Admins
 */

const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

// Telegram API wrapper
function tgApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    async call(method, params = {}) {
      const r = await axios.post(`${base}/${method}`, params, { timeout: 10000 });
      return r.data?.result;
    },
    async send(chatId, text, extra = {}) {
      return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
    },
    async sendPhoto(chatId, photo, caption, extra = {}) {
      return this.call("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra });
    },
    async kick(chatId, userId) {
      return this.call("banChatMember", { chat_id: chatId, user_id: userId, revoke_messages: false });
    },
    async unban(chatId, userId) {
      return this.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
    },
    async getMember(chatId, userId) {
      return this.call("getChatMember", { chat_id: chatId, user_id: userId });
    },
    async getAdmins(chatId) {
      return this.call("getChatAdministrators", { chat_id: chatId }) || [];
    },
    async deleteMessage(chatId, msgId) {
      return this.call("deleteMessage", { chat_id: chatId, message_id: msgId });
    },
    async pinMessage(chatId, msgId, disableNotif = false) {
      return this.call("pinChatMessage", { chat_id: chatId, message_id: msgId, disable_notification: disableNotif });
    },
    async restrictMember(chatId, userId, permissions, until = 0) {
      return this.call("restrictChatMember", { chat_id: chatId, user_id: userId, permissions, until_date: until });
    }
  };
}

const tgAdminHelper = {

  // ── Member-Tracking ────────────────────────────────────────────────────────

  async trackMember(channelId, user) {
    if (!user?.id) return;
    try {
      await supabase.from("channel_members").upsert([{
        channel_id: channelId,
        user_id:    user.id,
        username:   user.username || null,
        first_name: user.first_name || null,
        last_seen:  new Date(),
        is_deleted: false
      }], { onConflict: "channel_id,user_id" });
    } catch (e) {
      logger.warn("[AdminHelper] trackMember:", e.message);
    }
  },

  async trackLeft(channelId, userId) {
    try {
      await supabase.from("channel_members")
        .delete().eq("channel_id", channelId).eq("user_id", userId);
    } catch (_) {}
  },

  // ── Gelöschte Accounts entfernen ──────────────────────────────────────────

  async cleanDeletedAccounts(token, channelId) {
    const tg = tgApi(token);
    const { data: members } = await supabase.from("channel_members")
      .select("user_id, first_name, username")
      .eq("channel_id", channelId).eq("is_deleted", false)
      .limit(200);

    if (!members?.length) return { removed: 0, checked: 0 };

    let removed = 0, checked = 0;

    for (const m of members) {
      try {
        const cm = await tg.getMember(channelId, m.user_id);
        checked++;

        // Gelöschter Account = kein Vorname, kein Username, first_name leer
        const isDeleted = !cm?.user?.first_name && !cm?.user?.username &&
                          cm?.status !== "left" && cm?.status !== "kicked";

        if (isDeleted || cm?.user?.is_deleted) {
          await tg.kick(channelId, m.user_id);
          await tg.unban(channelId, m.user_id); // Sofort entbannen (nur rauswerfen)
          await supabase.from("channel_members")
            .update({ is_deleted: true }).eq("channel_id", channelId).eq("user_id", m.user_id);
          removed++;
          logger.info(`[AdminHelper] Gelöschter Account entfernt: ${m.user_id} aus ${channelId}`);
          await new Promise(r => setTimeout(r, 300)); // Rate limit
        }
      } catch { /* Member nicht mehr erreichbar → überspringen */ }
    }

    return { removed, checked };
  },

  // ── Admin-Menü (Inline Buttons) ───────────────────────────────────────────

  ADMIN_MENU_ITEMS: [
    { text: "🧹 Gelöschte Accounts entfernen", cb: "admin_clean" },
    { text: "📌 Nachricht pinnen",             cb: "admin_pin_last" },
    { text: "📋 Mitglieder-Anzahl",             cb: "admin_count" },
    { text: "🗑 Letzte Nachricht löschen",     cb: "admin_del_last" },
    { text: "⏰ Geplante Nachrichten",         cb: "admin_schedule" },
    { text: "🛡 Safelist verwalten",           cb: "admin_safelist" },
  ],

  async sendAdminMenu(token, chatId, msgId = null) {
    const tg = tgApi(token);
    const keyboard = {
      inline_keyboard: this.ADMIN_MENU_ITEMS.map(i => [{ text: i.text, callback_data: i.cb }])
    };
    return tg.send(chatId, "⚙️ <b>Admin-Menü</b>\nWähle eine Funktion:", {
      reply_markup: keyboard,
      ...(msgId ? { reply_to_message_id: msgId } : {})
    });
  },

  // ── Callback-Query-Handler ─────────────────────────────────────────────────

  async handleCallback(token, query, channel) {
    const tg   = tgApi(token);
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;

    // Admin-Check
    const admins  = await tg.getAdmins(chatId).catch(() => []);
    const isAdmin = admins.some(a => a.user?.id === userId);
    if (!isAdmin) {
      await tg.call("answerCallbackQuery", { callback_query_id: query.id, text: "❌ Nur für Admins." });
      return;
    }

    await tg.call("answerCallbackQuery", { callback_query_id: query.id });

    switch (data) {
      case "admin_clean": {
        const { removed, checked } = await this.cleanDeletedAccounts(token, String(chatId));
        await tg.send(chatId, `🧹 Ergebnis: ${checked} Mitglieder geprüft, ${removed} gelöschte Accounts entfernt.`);
        break;
      }
      case "admin_count": {
        const count = await tg.call("getChatMembersCount", { chat_id: chatId }).catch(() => "?");
        await tg.send(chatId, `👥 Aktuelle Mitgliederzahl: <b>${count}</b>`);
        break;
      }
      case "admin_pin_last": {
        const msgToPin = query.message?.reply_to_message?.message_id;
        if (msgToPin) {
          await tg.pinMessage(chatId, msgToPin);
          await tg.send(chatId, "📌 Nachricht angeheftet!");
        } else {
          await tg.send(chatId, "Antworte auf die Nachricht die gepinnt werden soll mit /pin");
        }
        break;
      }
      case "admin_del_last": {
        const delId = query.message?.message_id - 1;
        if (delId) await tg.deleteMessage(chatId, delId).catch(() => {});
        await tg.deleteMessage(chatId, query.message.message_id).catch(() => {});
        break;
      }
      case "admin_schedule": {
        const { data: msgs } = await supabase.from("scheduled_messages")
          .select("id, message, next_run_at, repeat").eq("channel_id", String(chatId)).eq("is_active", true);
        if (!msgs?.length) {
          await tg.send(chatId, "⏰ Keine geplanten Nachrichten.\n\nNutze das Dashboard um Nachrichten zu planen.");
        } else {
          const list = msgs.map(m => `• ${m.message.substring(0, 50)}… → ${m.next_run_at ? new Date(m.next_run_at).toLocaleString("de-DE") : "einmalig"}`).join("\n");
          await tg.send(chatId, `⏰ <b>Geplante Nachrichten:</b>\n${list}`);
        }
        break;
      }
    }
  },

  // ── Welcome / Goodbye ─────────────────────────────────────────────────────

  async sendWelcome(token, chatId, user, channel) {
    if (!channel?.welcome_msg) return;
    const tg   = tgApi(token);
    const name = user.first_name || user.username || "Neues Mitglied";
    const msg  = channel.welcome_msg.replace("{name}", `<b>${name}</b>`).replace("{chat}", chatId);
    await tg.send(chatId, msg).catch(() => {});
  },

  async sendGoodbye(token, chatId, user, channel) {
    if (!channel?.goodbye_msg) return;
    const tg   = tgApi(token);
    const name = user.first_name || user.username || "Mitglied";
    const msg  = channel.goodbye_msg.replace("{name}", `<b>${name}</b>`);
    await tg.send(chatId, msg).catch(() => {});
  },

  // ── Geplante Nachrichten abfeuern ─────────────────────────────────────────

  async fireScheduled(token) {
    const now = new Date().toISOString();
    try {
      const { data: due } = await supabase.from("scheduled_messages")
        .select("*").eq("is_active", true).lte("next_run_at", now);

      for (const msg of (due || [])) {
        const tg = tgApi(token);
        try {
          if (msg.photo_file_id || msg.photo_url) {
            await tg.sendPhoto(msg.channel_id, msg.photo_file_id || msg.photo_url, msg.message);
          } else {
            await tg.send(msg.channel_id, msg.message);
          }

          if (msg.repeat && msg.cron_expr) {
            const next = this._nextCronRun(msg.cron_expr);
            await supabase.from("scheduled_messages")
              .update({ next_run_at: next, run_count: (msg.run_count || 0) + 1 }).eq("id", msg.id);
          } else {
            await supabase.from("scheduled_messages")
              .update({ is_active: false, run_count: (msg.run_count || 0) + 1 }).eq("id", msg.id);
          }
        } catch (e) {
          logger.warn(`[AdminHelper] Scheduled send fehlgeschlagen (${msg.id}): ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn("[AdminHelper] fireScheduled:", e.message);
    }
  },

  // Simplers Cron-Parsing (Stunde + Wochentag)
  _nextCronRun(cron) {
    // Format: "M H DOM MON DOW" – wir nutzen nur H und DOW
    try {
      const parts = cron.trim().split(/\s+/);
      const [min, hour] = [parseInt(parts[0]), parseInt(parts[1])];
      const dow = parts[4] !== "*" ? parseInt(parts[4]) : -1;
      const now = new Date();
      const next = new Date();
      next.setHours(hour, min || 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      if (dow >= 0) {
        while (next.getDay() !== dow) next.setDate(next.getDate() + 1);
      }
      return next.toISOString();
    } catch { return null; }
  }
};

module.exports = { tgAdminHelper, tgApi };
