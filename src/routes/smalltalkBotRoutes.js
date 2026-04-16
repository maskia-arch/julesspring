/**
 * smalltalkBotRoutes.js  v1.4.5
 * Vollständiger Admin-Helper-Bot mit AI-Features (wenn freigeschaltet)
 */
const express          = require("express");
const router           = express.Router();
const supabase         = require("../config/supabase");
const logger           = require("../utils/logger");
const { tgAdminHelper, tgApi } = require("../services/adminHelper/tgAdminHelper");
const safelistService  = require("../services/adminHelper/safelistService");

const WELCOME_INTRO = `👋 <b>Willkommen beim TG Admin-Helper!</b>

Ich helfe dir dabei, deinen Telegram-Channel oder deine Gruppe effizienter zu verwalten.

<b>So startest du:</b>
1️⃣ Füge mich als <b>Admin</b> in deinen Channel/Gruppe ein
2️⃣ Kontaktiere <b>@autoacts</b> um die Einrichtung abzuschließen
3️⃣ Nach Freischaltung kannst du im Dashboard alle Funktionen konfigurieren

<b>🆓 Kostenlose Tools (sofort verfügbar):</b>
• 🧹 Gelöschte Accounts automatisch entfernen
• 👋 Willkommens- & Abschiedsnachrichten
• ⏰ Geplante Nachrichten & Ankündigungen
• 📌 Nachrichten pinnen
• 🛡 Safelist / Scamliste (Community-Sicherheit)

<b>🤖 KI-Features (nach Freischaltung durch @autoacts):</b>
• Eigene Bot-Persönlichkeit & System-Prompt
• Channel-Wissensdatenbank
• KI-gestützte Antworten auf /ai [Frage]

Fragen? → @autoacts`;

async function getSettings() {
  const { data } = await supabase.from("settings").select("*").single().catch(() => ({ data: null }));
  return data;
}

async function getChannel(chatId) {
  const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle().catch(() => ({ data: null }));
  return data;
}

async function isGroupAdmin(token, chatId, userId) {
  try {
    const admins = await tgApi(token).getAdmins(chatId);
    return admins.some(a => a.user?.id === userId);
  } catch { return false; }
}

router.post("/smalltalk", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const update  = req.body;
      if (!update)  return;
      const settings = await getSettings();
      const token    = settings?.smalltalk_bot_token;
      if (!token)    return;
      const tg = tgApi(token);

      // ── Bot als Admin hinzugefügt ──────────────────────────────────────────
      if (update.my_chat_member) {
        const mcm = update.my_chat_member;
        if (["administrator","creator"].includes(mcm.new_chat_member?.status)) {
          const chat = mcm.chat;
          await supabase.from("bot_channels").upsert([{
            id:          chat.id, title: chat.title || String(chat.id),
            username:    chat.username || null, type: chat.type,
            bot_type:    "smalltalk", is_active: false, is_approved: false,
            ai_enabled:  false, updated_at: new Date()
          }], { onConflict: "id" });

          await tg.send(chat.id,
            `✅ Bot erfolgreich hinzugefügt!\n\nUm die Einrichtung abzuschließen und alle Funktionen freizuschalten, wende dich bitte an <b>@autoacts</b>.\n\nKostenlose Basis-Tools sind bereits aktiv.`
          );
          logger.info(`[SmallTalk-Bot] Channel registriert: ${chat.title}`);
        }
        return;
      }

      // ── Callback-Queries (Inline-Buttons) ────────────────────────────────
      if (update.callback_query) {
        const q      = update.callback_query;
        const chatId = q.message?.chat?.id;
        const ch     = await getChannel(String(chatId));
        await tgAdminHelper.handleCallback(token, q, ch);
        return;
      }

      const msg    = update.message || update.channel_post;
      if (!msg)    return;
      const chat   = msg.chat   || {};
      const from   = msg.from   || {};
      const text   = msg.text?.trim() || "";
      const chatId = String(chat.id);

      // ── Privat-Chat: /start Onboarding ───────────────────────────────────
      if (chat.type === "private") {
        if (text === "/start" || text.startsWith("/start ")) {
          await tg.send(chatId, WELCOME_INTRO);
          return;
        }

        // AI-Feature: Fragen beantworten (wenn Kanal freigeschaltet)
        const ch = await getChannel(chatId);
        if (ch?.is_approved && ch?.ai_enabled) {
          const smalltalkAgent = require("../services/ai/smalltalkAgent");
          const result = await smalltalkAgent.handle({ chatId, text, settings, channelRecord: ch });
          if (result.reply) await tg.send(chatId, result.reply);
        }
        return;
      }

      // ── Gruppen/Channel ───────────────────────────────────────────────────
      const ch = await getChannel(chatId);

      // Member-Tracking
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

      // User tracken bei jeder Nachricht
      if (from.id) await tgAdminHelper.trackMember(chatId, from).catch(() => {});

      if (!text) return;

      // ── Admin-Befehle ─────────────────────────────────────────────────────
      const adminCmds = ["/admin", "/menu", "/help"];
      if (adminCmds.some(cmd => text.startsWith(cmd))) {
        if (await isGroupAdmin(token, chatId, from.id)) {
          await tgAdminHelper.sendAdminMenu(token, chatId, msg.message_id);
        }
        return;
      }

      // /clean – Gelöschte Accounts entfernen
      if (text === "/clean" || text.startsWith("/clean@")) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.send(chatId, "🔍 Prüfe Mitgliederliste...");
        const result = await tgAdminHelper.cleanDeletedAccounts(token, chatId);
        await tg.send(chatId, `🧹 Fertig! ${result.checked} geprüft, ${result.removed} entfernt.`);
        return;
      }

      // /pin – Nachricht pinnen (Reply)
      if ((text === "/pin" || text.startsWith("/pin@")) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tgApi(token).pinMessage(chatId, msg.reply_to_message.message_id);
        await tg.send(chatId, "📌 Gepinnt!");
        return;
      }

      // /del – Nachricht löschen (Reply)
      if ((text === "/del" || text.startsWith("/del@")) && msg.reply_to_message) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.deleteMessage(chatId, msg.reply_to_message.message_id).catch(() => {});
        await tg.deleteMessage(chatId, msg.message_id).catch(() => {});
        return;
      }

      // /safelist @user Feedback
      const safeMatch = text.match(/^\/safelist\s+@?(\w+)\s*(.*)/i);
      if (safeMatch) {
        const [, username, feedback] = safeMatch;
        const result = await safelistService.submitFeedback(
          chatId, from.id, null, username, "safe", feedback || "Positives Feedback",
          msg.reply_to_message ? [{ text: msg.reply_to_message.text, from: msg.reply_to_message.from?.id }] : []
        );
        await tg.send(chatId, `✅ Feedback für @${username} eingereicht (ID: ${result.id}).\nEin Admin prüft und bestätigt den Eintrag.`);
        return;
      }

      // /scamlist @user Grund
      const scamMatch = text.match(/^\/scamlist\s+@?(\w+)\s*(.*)/i);
      if (scamMatch) {
        const [, username, reason] = scamMatch;
        const result = await safelistService.submitFeedback(
          chatId, from.id, null, username, "scam", reason || "Scam gemeldet",
          msg.reply_to_message ? [{ text: msg.reply_to_message.text, from: msg.reply_to_message.from?.id }] : []
        );
        await tg.send(chatId, `⚠️ Scam-Meldung für @${username} eingereicht (ID: ${result.id}).\nEin Admin prüft den Fall.`);
        return;
      }

      // /check @user
      const checkMatch = text.match(/^\/check\s+@?(\w+)/i);
      if (checkMatch) {
        const entry = await safelistService.checkUser(null, checkMatch[1]);
        if (entry) {
          const emoji = entry.list_type === "safe" ? "✅" : "⚠️";
          await tg.send(chatId, `${emoji} <b>@${entry.username}</b>\nStatus: ${entry.list_type === "safe" ? "Verifiziert sicher" : "Scammer gemeldet"}\n${entry.summary || entry.feedback_text || ""}`);
        } else {
          await tg.send(chatId, `❓ @${checkMatch[1]} ist nicht in der Safelist.`);
        }
        return;
      }

      // /ai [Frage] – Nur wenn AI freigeschaltet
      const aiMatch = text.match(/^\/ai\s+(.*)/i);
      if (aiMatch && ch?.is_approved && ch?.ai_enabled) {
        const question = aiMatch[1].trim();
        const smalltalkAgent = require("../services/ai/smalltalkAgent");
        const result = await smalltalkAgent.handle({ chatId, text: question, settings, channelRecord: ch });
        if (result.reply) await tg.send(chatId, result.reply);
      } else if (aiMatch && ch && !ch.ai_enabled) {
        await tg.send(chatId, "🔒 AI-Features sind für diesen Channel noch nicht freigeschaltet.\n\nWende dich an @autoacts für die Aktivierung.");
      }

    } catch (e) {
      logger.error("[SmallTalk-Bot]", e.message);
    }
  });
});

module.exports = router;
