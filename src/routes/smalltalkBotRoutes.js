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
  try {
    const { data } = await supabase.from("settings").select("*").maybeSingle();
    return data || null;
  } catch { return null; }
}

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function isGroupAdmin(token, chatId, userId) {
  try {
    const admins = await tgApi(token).getAdmins(chatId);
    return admins.some(a => a.user?.id === userId);
  } catch { return false; }
}


// ══════════════════════════════════════════════════════════════════════════════
// Bot-Einstellungsmenü (nur für Channel-Admins, kein Dashboard-Zugriff nötig)
// ══════════════════════════════════════════════════════════════════════════════

async function sendSettingsMenu(tg, sendTo, channelId, ch) {
  const aiActive    = ch?.ai_enabled    ? "✅ Aktiv"     : "❌ Inaktiv";
  const safeActive  = ch?.safelist_enabled ? "✅ Aktiv"  : "❌ Inaktiv";
  const approved    = ch?.is_approved   ? "🟢 Freigeschaltet" : "🔴 Ausstehend";

  await tg.call("sendMessage", {
    chat_id: sendTo,
    text: `⚙️ <b>Einstellungen für: ${(ch?.title || channelId)}</b>\n\n` +
          `Status: ${approved}\n` +
          `KI-Features: ${aiActive}\n` +
          `Safelist: ${safeActive}\n\n` +
          `Wähle was du verwalten möchtest:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "👋 Willkommensnachricht",   callback_data: `cfg_welcome_${channelId}` },
       { text: "👋 Abschiedsnachricht",     callback_data: `cfg_goodbye_${channelId}` }],
      [{ text: "⏰ Geplante Nachrichten",   callback_data: `cfg_schedule_${channelId}` }],
      [{ text: "🧹 Gelöschte bereinigen",   callback_data: `cfg_clean_${channelId}` },
       { text: "📊 Statistiken",            callback_data: `cfg_stats_${channelId}` }],
      [{ text: "🛡 Safelist",               callback_data: `cfg_safelist_${channelId}` }],
      [{ text: "🤖 KI-Features",            callback_data: `cfg_ai_${channelId}` }],
    ]}
  });
}

async function handleSettingsCallback(tg, supabase_db, data, q, userId) {
  const parts     = data.split("_");
  const action    = parts[1];
  const channelId = parts[2];

  // Admin-Check bereits beim settings_* callback durchgeführt

  const ch = await getChannel(channelId);

  switch (action) {
    case "welcome": {
      const cur = ch?.welcome_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Willkommensnachricht</b>\n\nAktuell: <i>${cur}</i>\n\nSende deine neue Willkommensnachricht (nutze {name} für den Nutzernamen):\nOder /cancel zum Abbrechen.`,
        parse_mode: "HTML"
      });
      // Store pending state
      pendingInputs[String(userId)] = { action: "set_welcome", channelId };
      break;
    }
    case "goodbye": {
      const cur = ch?.goodbye_msg || "(keine)";
      await tg.call("sendMessage", {
        chat_id: String(userId),
        text: `👋 <b>Abschiedsnachricht</b>\n\nAktuell: <i>${cur}</i>\n\nSende deine neue Abschiedsnachricht (nutze {name} für den Nutzernamen):\nOder /cancel zum Abbrechen.`,
        parse_mode: "HTML"
      });
      pendingInputs[String(userId)] = { action: "set_goodbye", channelId };
      break;
    }
    case "clean": {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: "🔍 Starte Bereinigung gelöschter Accounts...", parse_mode: "HTML" });
      const settings = await getSettings();
      const { tgAdminHelper: helper } = require("../services/adminHelper/tgAdminHelper");
      const result = await helper.cleanDeletedAccounts(settings.smalltalk_bot_token, channelId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🧹 Fertig! ${result.checked} geprüft, ${result.removed} gelöschte Accounts entfernt.`, parse_mode: "HTML" });
      break;
    }
    case "stats": {
      const { data: memberCount } = await supabase_db.from("channel_members")
        .select("id", { count: "exact", head: true }).eq("channel_id", channelId).catch(() => ({ data: null }));
      const { data: schedCount } = await supabase_db.from("scheduled_messages")
        .select("id", { count: "exact", head: true }).eq("channel_id", channelId).eq("is_active", true).catch(() => ({ data: null }));
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📊 <b>Statistiken: ${ch?.title || channelId}</b>\n\n` +
              `👥 Verfolgte Mitglieder: ${memberCount || 0}\n` +
              `⏰ Aktive geplante Nachrichten: ${schedCount || 0}\n` +
              `📚 KB-Einträge: ${ch?.kb_entry_count || 0}`,
        parse_mode: "HTML" });
      break;
    }
    case "safelist": {
      const safelistService = require("../services/adminHelper/safelistService");
      const reviews = await safelistService.getPendingReviews(channelId);
      if (!reviews.length) {
        await tg.call("sendMessage", { chat_id: String(userId),
          text: "🛡 Keine offenen Safelist-Reviews.", parse_mode: "HTML" });
      } else {
        for (const r of reviews.slice(0, 5)) {
          const emoji = r.list_type === "safe" ? "✅" : "⚠️";
          await tg.call("sendMessage", {
            chat_id: String(userId),
            text: `${emoji} <b>@${r.username || r.user_id}</b>\n${r.summary || r.feedback_text || ""}`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[
              { text: "✅ Bestätigen", callback_data: `safe_approve_${r.id}_${r.list_type}` },
              { text: "❌ Ablehnen",  callback_data: `safe_reject_${r.id}` }
            ]]}
          });
        }
      }
      break;
    }
    case "ai": {
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `🤖 <b>KI-Features</b>\n\nStatus: ${ch?.ai_enabled ? "✅ Aktiv" : "❌ Inaktiv"}\n\nFür Aktivierung/Deaktivierung wende dich an @autoacts.`,
        parse_mode: "HTML" });
      break;
    }
  }
}

// In-Memory: Pending text inputs (welcome/goodbye Nachricht setzen)
const pendingInputs = {};

async function handlePendingInput(tg, supabase_db, userId, text, settings) {
  const pending = pendingInputs[String(userId)];
  if (!pending) return false;

  if (text === "/cancel") {
    delete pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Abgebrochen." });
    return true;
  }

  const { action, channelId } = pending;
  delete pendingInputs[String(userId)];

  if (action === "set_welcome" || action === "set_goodbye") {
    const field = action === "set_welcome" ? "welcome_msg" : "goodbye_msg";
    await supabase_db.from("bot_channels").update({ [field]: text, updated_at: new Date() }).eq("id", channelId);
    await tg.call("sendMessage", {
      chat_id: String(userId),
      text: `✅ ${action === "set_welcome" ? "Willkommens" : "Abschied"}snachricht gespeichert!`,
      parse_mode: "HTML"
    });
    return true;
  }
  return false;
}


router.post("/smalltalk", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const update  = req.body;
      if (!update)  return;
      const settings = await getSettings();
      const token    = settings?.smalltalk_bot_token;
      if (!token) {
        logger.info("[SmallTalk-Bot] Kein Bot-Token konfiguriert – Update ignoriert");
        return;
      }
      const tg = tgApi(token);

      // ── Bot als Admin hinzugefügt ──────────────────────────────────────────
      if (update.my_chat_member) {
        const mcm = update.my_chat_member;
        if (["administrator","creator"].includes(mcm.new_chat_member?.status)) {
          const chat     = mcm.chat;
          const addedBy  = mcm.from;   // Der User der den Bot hinzugefügt hat
          const settingsToken = require('crypto').randomBytes(16).toString('hex');

          await supabase.from("bot_channels").upsert([{
            id:               chat.id,
            title:            chat.title || String(chat.id),
            username:         chat.username || null,
            type:             chat.type,
            bot_type:         "smalltalk",
            is_active:        false,
            is_approved:      false,
            ai_enabled:       false,
            added_by_user_id: addedBy?.id   || null,
            added_by_username:addedBy?.username || null,
            settings_token:   settingsToken,
            updated_at:       new Date()
          }], { onConflict: "id" });

          // Nachricht an den Channel
          await tg.send(chat.id,
            `✅ <b>TG Admin-Helper aktiv!</b>\n\n` +
            `Verfügbare Befehle für Admins:\n` +
            `• /admin oder /menu – Verwaltungstools\n` +
            `• /settings – Channel-Einstellungen\n` +
            `• /clean – Gelöschte Accounts entfernen\n` +
            `• /safelist @user – User verifizieren\n` +
            `• /scamlist @user – Scammer melden\n\n` +
            `🔒 AI-Features → @autoacts kontaktieren.`
          );

          // Private Willkommensnachricht an den Admin
          if (addedBy?.id) {
            await tg.send(String(addedBy.id),
              `✅ <b>Bot wurde zu "${chat.title}" hinzugefügt!</b>\n\n` +
              `Schreibe <b>/settings</b> im Channel um die Einstellungen zu öffnen.\n` +
              `Du kannst das Menü direkt hier (privat) oder im Channel anzeigen lassen.\n\n` +
              `🤖 <b>Kostenlose Tools sind sofort aktiv.</b>\n` +
              `Für KI-Features: @autoacts kontaktieren.`
            ).catch(() => {});
          }

          logger.info(`[SmallTalk-Bot] Channel registriert: ${chat.title} (von @${addedBy?.username || addedBy?.id})`);
        }
        return;
      }

      // ── Callback-Queries (Inline-Buttons) ────────────────────────────────
      if (update.callback_query) {
        const q      = update.callback_query;
        const qChatId = String(q.message?.chat?.id || "");
        const qUserId = q.from?.id;
        const data   = q.data || "";

        await tg.call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});

        // Settings-Menu: Hier oder Privat
        if (data.startsWith("settings_here_") || data.startsWith("settings_private_")) {
          const parts     = data.split("_");
          const sendPriv  = data.startsWith("settings_private_");
          const targetChannelId = parts[2];
          const ownerId   = parts[3] ? parseInt(parts[3]) : null;

          // Nur der Admin der /settings aufrief darf antworten
          if (sendPriv && ownerId && qUserId !== ownerId) return;
          if (!await isGroupAdmin(token, targetChannelId, qUserId)) return;

          const ch = await getChannel(targetChannelId);
          const sendTarget = sendPriv ? String(qUserId) : targetChannelId;

          await sendSettingsMenu(tg, sendTarget, targetChannelId, ch);
          return;
        }

        // Settings sub-callbacks
        if (data.startsWith("cfg_")) {
          await handleSettingsCallback(tg, supabase, data, q, qUserId);
          return;
        }

        // Safelist approve/reject callbacks
        if (data.startsWith("safe_approve_") || data.startsWith("safe_reject_")) {
          const parts = data.split("_");
          const action = parts[1]; // approve / reject
          const entryId = parts[2];
          const listType = parts[3] || null;
          const safelistService = require("../services/adminHelper/safelistService");
          if (action === "approve") {
            await safelistService.approve(entryId, qUserId, listType);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "✅ Bestätigt!" });
          } else {
            await safelistService.reject(entryId, qUserId);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Abgelehnt." });
          }
          return;
        }

        // Admin tools callbacks
        const ch = await getChannel(qChatId);
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
        // Check for pending text input (e.g. setting welcome/goodbye message)
        if (text && !(text.startsWith("/"))) {
          const handled = await handlePendingInput(tg, supabase, from.id, text, settings);
          if (handled) return;
        }
        if (text === "/cancel") {
          await handlePendingInput(tg, supabase, from.id, "/cancel", settings);
          return;
        }
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

      // /settings – Frage: Privat oder Hier?
      if (text === "/settings" || text.startsWith("/settings@")) {
        if (!await isGroupAdmin(token, chatId, from.id)) return;
        await tg.call("sendMessage", {
          chat_id: chatId,
          text: "⚙️ Wo soll das Einstellungs-Menü geöffnet werden?",
          reply_markup: { inline_keyboard: [[
            { text: "💬 Hier im Chat", callback_data: `settings_here_${chatId}` },
            { text: "🔒 Privat (nur für mich)", callback_data: `settings_private_${chatId}_${from.id}` }
          ]]}
        });
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
      const msg = e?.response?.data?.description || e?.message || String(e) || "Unbekannter Fehler";
      const stk = e?.stack ? e.stack.split('\n').slice(0,4).join(' → ') : "kein Stack";
      logger.error(`[SmallTalk-Bot] Fehler: ${msg}`);
      logger.error(`[SmallTalk-Bot] Stack: ${stk}`);
    }
  });
});

module.exports = router;
