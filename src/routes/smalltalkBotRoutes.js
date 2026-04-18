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
      let memberCount = null, schedCount = null;
      try { const r1 = await supabase_db.from("channel_members").select("id", { count: "exact", head: true }).eq("channel_id", channelId); memberCount = r1.count; } catch (_) {}
      try { const r2 = await supabase_db.from("scheduled_messages").select("id", { count: "exact", head: true }).eq("channel_id", channelId).eq("is_active", true); schedCount = r2.count; } catch (_) {}
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

async function handlePendingInput(tg, supabase_db, userId, text, settings, msg) {
  const pending = pendingInputs[String(userId)];
  if (!pending) return false;

  if (text === "/cancel") {
    delete pendingInputs[String(userId)];
    await tg.call("sendMessage", { chat_id: String(userId), text: "❌ Abgebrochen." });
    return true;
  }

  const { action, channelId, entryId, targetUsername } = pending;

  // ── Welcome/Goodbye Nachricht setzen ──────────────────────────────────────
  if (action === "set_welcome" || action === "set_goodbye") {
    delete pendingInputs[String(userId)];
    const field = action === "set_welcome" ? "welcome_msg" : "goodbye_msg";
    await supabase_db.from("bot_channels").update({ [field]: text, updated_at: new Date() }).eq("id", channelId);
    await tg.call("sendMessage", { chat_id: String(userId),
      text: `✅ ${action === "set_welcome" ? "Willkommens" : "Abschied"}snachricht gespeichert!`, parse_mode: "HTML" });
    return true;
  }

  // ── Proof-Einreichung: User startet mit /proofs_ENTRYID ───────────────────
  if (action === "awaiting_proofs_start" && text && text.startsWith("/proofs_")) {
    const inputEntryId = text.split("_")[1];
    if (inputEntryId === String(entryId)) {
      pendingInputs[String(userId)] = { ...pending, action: "collecting_proofs", proofCount: 0 };
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `📎 <b>Beweise einreichen für @${targetUsername}</b>\n\nSende jetzt bis zu <b>5 Beweise</b> als:\n• Screenshot (Foto)\n• Textnachricht\n• Dokument/Video\n\nSchreibe /fertig wenn du alle Beweise eingereicht hast.`,
        parse_mode: "HTML" });
    }
    return true;
  }

  // ── Proofs sammeln ─────────────────────────────────────────────────────────
  if (action === "collecting_proofs") {
    if (text === "/fertig") {
      delete pendingInputs[String(userId)];
      const proofs = await safelistService.getProofs(entryId);
      await tg.call("sendMessage", { chat_id: String(userId),
        text: `✅ <b>${proofs.length} Beweis(e) eingegangen.</b>\n\nVielen Dank! Ein Admin prüft die Meldung. Du wirst informiert.`,
        parse_mode: "HTML" });

      // Admin benachrichtigen
      let fbEntry = null, chData = null;
      try { const rA = await supabase_db.from("user_feedbacks").select("*").eq("id", entryId).single(); fbEntry = rA.data; } catch (_) {}
      try { const rB = await supabase_db.from("bot_channels").select("added_by_user_id").eq("id", String(pending.channelId||0)).maybeSingle(); chData = rB.data; } catch (_) {}
      const adminId = chData?.added_by_user_id;
      if (adminId) {
        await tg.call("sendMessage", { chat_id: String(adminId),
          text: `⚠️ <b>Neue Scam-Meldung</b>\n\nZiel: @${targetUsername}\nVon: @${pending.reporterUsername || userId}\nBeweise: ${proofs.length}\n\nInhalt:\n${proofs.filter(p=>p.content||p.caption).slice(0,3).map(p => "• " + (p.content || p.caption || "[Medien]")).join("\n")}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[
            { text: "✅ Als Scammer bestätigen", callback_data: "safe_approve_" + entryId + "_scam" },
            { text: "❌ Ablehnen",               callback_data: "safe_reject_" + entryId }
          ]]}
        });
        // Medien-Beweise weiterleiten
        for (const p of proofs.filter(pr => pr.file_id)) {
          try {
            if (p.proof_type === "photo")    await tg.call("sendPhoto",    { chat_id: String(adminId), photo:    p.file_id, caption: p.caption || "" });
            if (p.proof_type === "video")    await tg.call("sendVideo",    { chat_id: String(adminId), video:    p.file_id, caption: p.caption || "" });
            if (p.proof_type === "document") await tg.call("sendDocument", { chat_id: String(adminId), document: p.file_id, caption: p.caption || "" });
          } catch (_) {}
        }
      }
      return true;
    }

    // Proof entgegennehmen (Text oder Medien)
    const count = pending.proofCount || 0;
    if (count >= 5) {
      await tg.call("sendMessage", { chat_id: String(userId), text: "Maximal 5 Beweise möglich. Schreibe /fertig um abzuschließen." });
      return true;
    }

    let proofType = "text";
    let fileId = null;
    let caption = null;
    let content = text || null;

    if (msg?.photo) {
      proofType = "photo"; fileId = msg.photo[msg.photo.length - 1]?.file_id; caption = msg.caption || null; content = null;
      // Sofort aus dem privaten Chat löschen
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    } else if (msg?.video) {
      proofType = "video"; fileId = msg.video.file_id; caption = msg.caption || null; content = null;
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    } else if (msg?.document) {
      proofType = "document"; fileId = msg.document.file_id; caption = msg.caption || null; content = null;
      await tg.call("deleteMessage", { chat_id: String(userId), message_id: msg.message_id }).catch(() => {});
    }

    await safelistService.addProof({ entryId, submittedBy: userId, proofType, fileId, caption, content });
    pendingInputs[String(userId)].proofCount = count + 1;

    await tg.call("sendMessage", { chat_id: String(userId),
      text: `📎 Beweis ${count + 1}/5 erhalten${count + 1 < 5 ? ". Weitere senden oder /fertig." : ". Maximal erreicht – schreibe /fertig."}` });
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

          // ── Robuste Speicherung mit vollständigem Logging ─────────────────
          const chatIdStr = String(chat.id); // Sicherstellen: String für DB-Konsistenz
          logger.info(`[SmallTalk-Bot] Speichere Channel: ${chat.title} (id=${chatIdStr}, type=${chat.type})`);

          try {
            // Erst prüfen ob bereits vorhanden
            const { data: existing } = await supabase.from("bot_channels")
              .select("id").eq("id", chatIdStr).maybeSingle();

            let dbResult;
            if (existing) {
              // Update vorhandenen Eintrag (ohne optionale Spalten)
              dbResult = await supabase.from("bot_channels").update({
                title:      chat.title || chatIdStr,
                username:   chat.username || null,
                type:       chat.type,
                updated_at: new Date()
              }).eq("id", chatIdStr).select("id");
              logger.info(`[SmallTalk-Bot] Channel UPDATE: ${JSON.stringify(dbResult.error || "OK")}`);
            } else {
              // Neuen Eintrag anlegen - nur Kern-Spalten die garantiert existieren
              dbResult = await supabase.from("bot_channels").insert([{
                id:          chat.id,
                title:       chat.title || chatIdStr,
                username:    chat.username || null,
                type:        chat.type,
                is_active:   false,
                updated_at:  new Date()
              }]).select("id");
              logger.info(`[SmallTalk-Bot] Channel INSERT: ${JSON.stringify(dbResult.error || "OK")}`);
            }

            if (dbResult.error) {
              logger.error(`[SmallTalk-Bot] DB Fehler: code=${dbResult.error.code} msg=${dbResult.error.message}`);
            } else {
              // Erweiterte Felder optional updaten
              await supabase.from("bot_channels").update({
                ai_enabled:        false,
                added_by_user_id:  addedBy?.id   || null,
                added_by_username: addedBy?.username || null,
                settings_token:    settingsToken
              }).eq("id", chatIdStr).then(
                r  => r.error ? logger.warn("[SmallTalk-Bot] Extended fields:", r.error.message) : null
              );

              logger.info(`[SmallTalk-Bot] ✅ Channel erfolgreich gespeichert: ${chat.title} (${chatIdStr})`);
            }
          } catch (dbErr) {
            logger.error(`[SmallTalk-Bot] DB Exception: ${dbErr?.message || String(dbErr)}`);
          }

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

        // Channel selection in private chat
        if (data.startsWith("sel_channel_")) {
          const selChanId = data.split("_")[2];
          const ch = await getChannel(selChanId);
          await sendSettingsMenu(tg, String(qUserId), selChanId, ch);
          return;
        }

        // Settings sub-callbacks
        if (data.startsWith("cfg_")) {
          await handleSettingsCallback(tg, supabase, data, q, qUserId);
          return;
        }

        // Feedback approve/reject callbacks
        if (data.startsWith("fb_approve_") || data.startsWith("fb_reject_")) {
          const feedbackId = data.split("_")[2];
          const ch2 = {}; // We'll load channel from feedback
          if (data.startsWith("fb_approve_")) {
            await safelistService.approveFeedback(feedbackId, qUserId, ch2);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "✅ Meldung bestätigt. User wurde auf Scamliste gesetzt." });
          } else {
            await safelistService.rejectFeedback(feedbackId, qUserId);
            await tg.call("sendMessage", { chat_id: String(qUserId), text: "❌ Meldung abgelehnt." });
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
        // Pending input (welcome/goodbye/proof text OR media)
        const hasPending = pendingInputs[String(from.id)];
        if (hasPending?.action === "collecting_proofs" && (msg?.photo || msg?.video || msg?.document)) {
          await handlePendingInput(tg, supabase, from.id, "", settings, msg);
          return;
        }
        if (text && !text.startsWith("/")) {
          const handled = await handlePendingInput(tg, supabase, from.id, text, settings, msg);
          if (handled) return;
        }
        if (text === "/cancel") {
          await handlePendingInput(tg, supabase, from.id, "/cancel", settings, null);
          return;
        }
        if (text === "/start" || text.startsWith("/start ")) {
          await tg.send(chatId, WELCOME_INTRO);
          return;
        }

        // /settings in private chat: show all channels this user admins
        if (text === "/settings" || text.startsWith("/settings@")) {
          const { data: myChannels } = await supabase.from("bot_channels")
            .select("id, title, type, is_approved, ai_enabled").eq("added_by_user_id", String(from.id));
          if (!myChannels?.length) {
            await tg.send(chatId, "Du hast noch keinen Channel/Gruppe mit diesem Bot verknüpft.\nFüge mich als Admin in deiner Gruppe/Channel ein und schreibe dann /settings dort.");
            return;
          }
          if (myChannels.length === 1) {
            const ch = await getChannel(String(myChannels[0].id));
            await sendSettingsMenu(tg, chatId, String(myChannels[0].id), ch);
            return;
          }
          // Mehrere Channels → Auswahl
          const keyboard = myChannels.map(ch => [{
            text: (ch.type === "channel" ? "📢" : "👥") + " " + (ch.title || ch.id) + (ch.is_approved ? " ✅" : " ⏳"),
            callback_data: "sel_channel_" + ch.id
          }]);
          await tg.call("sendMessage", { chat_id: chatId, text: "Wähle den Channel/Gruppe für die Einstellungen:", reply_markup: { inline_keyboard: keyboard } });
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

      // User tracken bei jeder Nachricht (from kann bei Channel-Posts fehlen)
      if (from?.id) await tgAdminHelper.trackMember(chatId, from).catch(() => {});

      if (!text) return;

      // ── Admin-Befehle ─────────────────────────────────────────────────────
      const adminCmds = ["/admin", "/menu", "/help"];
      if (adminCmds.some(cmd => text.startsWith(cmd))) {
        if (await isGroupAdmin(token, chatId, from.id)) {
          await tgAdminHelper.sendAdminMenu(token, chatId, msg.message_id);
        } else {
          // Nicht-Admin bekommt neutrale Meldung
          await tg.send(chatId, "🔧 Hier wird gerade gearbeitet.");
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

      // ── Kontext-Tracking: alle User-Nachrichten speichern ─────────────────
      if (text && from?.id && !text.startsWith("/")) {
        void safelistService.saveContextMsg(chatId, from.id, from.username, text).catch(() => {});
      }

      // ── Safelist/Scamlist: nur wenn aktiviert ────────────────────────────
      const safelistActive = ch?.safelist_enabled || false;
      const aiActive       = ch?.ai_enabled       || false;

      // ── /feedbacks @user oder /check @user ────────────────────────────────
      const feedbackCmds = /^\/(?:feedbacks?|check)\s+@?(\w+)/i;
      const feedbackMatch = text.match(feedbackCmds);
      if (feedbackMatch && safelistActive) {
        const targetUsername = feedbackMatch[1];
        const feedbacks = await safelistService.getFeedbacks(chatId, targetUsername, null);
        const scamEntry  = await safelistService.checkScamlist(chatId, targetUsername, null);

        let replyText;
        if (scamEntry) {
          replyText = `⛔ <b>@${targetUsername} steht auf der Scamliste!</b>
${scamEntry.reason ? scamEntry.reason.substring(0,150) : ""}
`;
          if (scamEntry.ai_summary) replyText += `
🤖 ${scamEntry.ai_summary}`;
        } else if (ch?.ai_enabled) {
          const aiSummary = await safelistService.generateAiSummary(chatId, targetUsername, null);
          replyText = safelistService.buildFullText(feedbacks, targetUsername, aiSummary);
        } else {
          replyText = safelistService.buildStatsText(feedbacks, targetUsername);
        }

        const sentMsg = await tg.send(chatId, replyText);
        // Auto-delete nach 5 Minuten
        if (sentMsg?.message_id) {
          void safelistService.trackBotMessage(chatId, sentMsg.message_id, "check_result", 5 * 60 * 1000);
        }
        return;
      }

      // ── /feedbacks ohne @user → eigene Liste ─────────────────────────────
      if (/^\/feedbacks?$/i.test(text)) {
        const all = await safelistService.getFeedbacks(chatId, null, null);
        const pos = all.filter(f => f.feedback_type === "positive").length;
        const neg = all.filter(f => f.feedback_type === "negative").length;
        const sent = await tg.send(chatId, `📋 <b>Feedback-Übersicht</b>\n✅ ${pos} positive · ⚠️ ${neg} negative bestätigte Einträge.`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        return;
      }

      // ── /safelist @user – NUR FÜR ADMINS ─────────────────────────────────
      const safelistAdminMatch = text.match(/^\/safe?list[e]?\s+@?(\w+)\s*(.*)/i);
      if (safelistAdminMatch && safelistActive) {
        if (!await isGroupAdmin(token, chatId, from.id)) {
          const sent = await tg.send(chatId, "🔒 Nur Channel-Admins können Mitglieder verifizieren.");
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 10000);
          return;
        }
        const [, username, feedback] = safelistAdminMatch;
        const fb = await safelistService.submitFeedback({
          channelId: chatId, submittedBy: from?.id, submittedByUsername: from?.username,
          targetUsername: username, feedbackType: "positive",
          feedbackText: feedback || "Vom Channel-Admin verifiziert"
        });
        if (fb?.id) {
          const ch2 = await getChannel(chatId);
          await safelistService.approveFeedback(fb.id, from.id, ch2);
        }
        const sent = await tg.send(chatId, `✅ @${username} wurde auf die Safelist gesetzt.`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
        return;
      }

      // ── /scamlist @user – Scam-Meldung mit Proofs ────────────────────────
      const scamMatch = text.match(/^\/scam?list[e]?\s+@?(\w+)\s*(.*)/i);
      if (scamMatch && safelistActive) {
        const [, username, reason] = scamMatch;
        const fb = await safelistService.submitFeedback({
          channelId: chatId, submittedBy: from?.id, submittedByUsername: from?.username,
          targetUsername: username, feedbackType: "negative",
          feedbackText: reason || "Scam-Verdacht"
        });
        if (fb?.id) {
          // Pending-State für Proof-Bestätigung im Channel
          pendingInputs["scam_confirm_" + String(from?.id) + "_" + chatId] = {
            action: "await_proof_confirm", feedbackId: fb.id,
            targetUsername: username, channelId: chatId, reporterUsername: from?.username
          };
          const sent = await tg.send(chatId,
            `⚠️ Scam-Meldung gegen @${username} eingereicht.\n\n` +
            `Hast du Beweise (Screenshots, Videos, Texte)?\n` +
            `Antworte mit <b>"Ich habe Proofs"</b> um Beweise privat einzureichen.\n\n` +
            `<i>Ohne Beweise wird die Meldung möglicherweise abgelehnt.</i>`
          );
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 60000);
        }
        return;
      }

      // ── "Ich habe Proofs" Bestätigung im Channel ─────────────────────────
      if (/ich habe proofs?/i.test(text) && from?.id && safelistActive) {
        const key = "scam_confirm_" + String(from.id) + "_" + chatId;
        const pending = pendingInputs[key];
        if (pending) {
          delete pendingInputs[key];
          // Proof-State im privaten Chat aktivieren
          pendingInputs[String(from.id)] = {
            action: "collecting_proofs", feedbackId: pending.feedbackId,
            channelId: chatId, targetUsername: pending.targetUsername,
            reporterUsername: pending.reporterUsername, proofCount: 0
          };
          const sent = await tg.send(chatId,
            `📩 Bitte schicke deine Beweise <b>direkt im privaten Chat</b> mit @${settings?.smalltalk_bot_username || "dem Bot"}.\n` +
            `→ Öffne den Bot-Chat und tippe /start falls noch nicht geschehen.`
          );
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 30000);
        }
        return;
      }

      // ── /scamlist ohne @user → Scamliste anzeigen ────────────────────────
      if (/^\/scam?list[e]?(@\w+)?$/i.test(text) && safelistActive) {
        const { data: scamList } = await supabase.from("scam_entries").select("username, user_id, reason").eq("channel_id", chatId).limit(20);
        if (!scamList?.length) {
          const sent = await tg.send(chatId, "⚠️ <b>Scamliste</b>\n\nNoch keine bestätigten Einträge.");
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        } else {
          const lines = scamList.map(s => `⛔ @${s.username || s.user_id}${s.reason ? " – " + s.reason.substring(0, 60) : ""}`).join("\n");
          const sent = await tg.send(chatId, `⚠️ <b>Scamliste (${scamList.length})</b>\n\n${lines}`);
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "check_result", 5 * 60 * 1000);
        }
        return;
      }

      // /ai [Frage] – Nur wenn AI freigeschaltet
      const aiMatch = text.match(/^\/ai\s+(.*)/i);
      if (aiMatch && ch?.is_approved && ch?.ai_enabled) {
        const question = aiMatch[1].trim();
        // Kontext: letzte 3 Nachrichten des Users
        const ctxMsgs = from?.id ? await safelistService.getContextMsgs(chatId, from.id) : [];
        const ctxText = ctxMsgs.length ? "\nKontext (letzte Nachrichten):\n" + ctxMsgs.map(m => `${m.username||"User"}: ${m.message}`).join("\n") : "";
        const enrichedQuestion = question + ctxText;

        const smalltalkAgent = require("../services/ai/smalltalkAgent");
        const result = await smalltalkAgent.handle({ chatId, text: enrichedQuestion, settings, channelRecord: ch });
        if (result.reply) {
          // AI-Antworten bleiben dauerhaft
          await tg.send(chatId, result.reply);
        }
      } else if (aiMatch && ch && !ch.ai_enabled) {
        const sent = await tg.send(chatId, "🔒 AI-Features sind für diesen Channel noch nicht freigeschaltet.\n\nWende dich an @autoacts für die Aktivierung.");
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
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
