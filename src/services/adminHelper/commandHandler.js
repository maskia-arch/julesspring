const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const { tgApi } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const settingsHandler = require("./settingsHandler");
const inputWizardHandler = require("./inputWizardHandler");
const userInfoService = require("./userInfoService");
const blacklistService = require("./blacklistService");
const { detectLang, t } = require("../i18n");

const pendingInputs = global.pendingInputs = global.pendingInputs || {};

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function isGroupAdmin(tg, chatId, userId) {
  try {
    const admins = await tg.getAdmins(chatId);
    return admins.some(a => a.user?.id === userId);
  } catch { return false; }
}

/**
 * Prüft ob ein Channel ein laufendes Paket besitzt.
 *
 * Kriterien (alle müssen zutreffen):
 *   • bot_channels.token_limit > 0           (Paket wurde aktiviert)
 *   • bot_channels.credits_expire_at in der Zukunft  (oder NULL = endlos)
 *   • bot_channels.is_active !== false       (Channel selbst aktiv)
 *
 * Note: Nur weil token_used >= token_limit ist, gilt das Paket NICHT als
 *       inaktiv — der Owner kann ja Refills draufladen. Was zählt, ist die
 *       Laufzeit.
 */
function hasActivePackage(channel) {
  if (!channel) return false;
  if (channel.is_active === false) return false;
  if (!channel.token_limit || channel.token_limit <= 0) return false;
  if (!channel.credits_expire_at) return true; // endlos
  return new Date(channel.credits_expire_at).getTime() > Date.now();
}

/**
 * Schickt dem Spender (im Privatchat) das passende Donate-Menü:
 *   • Channel hat laufendes Paket → Refill-Liste (verlängert nicht die
 *     Laufzeit, aber stockt Credits auf)
 *   • Sonst → Paket-Liste (Aktiviert ein Paket für den Channel)
 *
 * @returns {Promise<{ ok: boolean, mode: "refill"|"package", reason?: string }>}
 */
async function sendDonationOptions(tg, supabase_db, donorChatId, donorUserId, channel) {
  const mode = hasActivePackage(channel) ? "refill" : "package";
  const chTitle = channel?.title || `Channel ${channel?.id}`;

  if (mode === "refill") {
    const { data: refills } = await supabase_db.from("channel_refills")
      .select("id, name, credits, price_eur, is_active, sort_order")
      .eq("is_active", true).order("sort_order", { ascending: true });
    const active = (refills || []).filter(r => r.is_active !== false);
    if (!active.length) return { ok: false, mode, reason: "no_refills" };

    const kb = active.map(r => [{
      text: `🔋 ${r.name} — ${r.credits.toLocaleString()} Credits · ${parseFloat(r.price_eur).toFixed(2)} €`,
      callback_data: `donate_refill_${r.id}_${channel.id}_${donorUserId}`
    }]);
    kb.push([{ text: "❌ Abbrechen", callback_data: `donate_cancel_${donorUserId}` }]);

    await tg.call("sendMessage", {
      chat_id: String(donorChatId),
      text: `❤️ <b>Refill für „${chTitle}" spendieren</b>\n\nDieser Channel hat bereits ein aktives Paket. Refills stocken die Credits auf, ohne die Laufzeit zurückzusetzen — vielen Dank für deine Unterstützung!\n\nWähle einen Refill:`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb }
    });
    return { ok: true, mode };
  }

  // mode === "package"
  const { data: pkgs } = await supabase_db.from("channel_packages")
    .select("id, name, credits, price_eur, duration_days, is_active")
    .eq("is_active", true).order("price_eur", { ascending: true });
  const active = (pkgs || []).filter(p => p.is_active !== false);
  if (!active.length) return { ok: false, mode, reason: "no_packages" };

  const kb = active.map(p => [{
    text: `📦 ${p.name} — ${p.credits.toLocaleString()} Credits · ${parseFloat(p.price_eur).toFixed(2)} €`,
    callback_data: `donate_pkg_${p.id}_${channel.id}_${donorUserId}`
  }]);
  kb.push([{ text: "❌ Abbrechen", callback_data: `donate_cancel_${donorUserId}` }]);

  await tg.call("sendMessage", {
    chat_id: String(donorChatId),
    text: `❤️ <b>Credit-Paket für „${chTitle}" spendieren</b>\n\nDieser Channel hat noch kein laufendes Paket. Ein Paket schaltet KI-Funktionen für 30 Tage frei — vielen Dank für deine Unterstützung!\n\nWähle ein Paket:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb }
  });
  return { ok: true, mode };
}


function _detectFeedback(text) {
  if (!text || text.length < 5 || text.length > 500) return null;
  const usernameMatch = text.match(/@([a-zA-Z0-9_]+)/);
  if (!usernameMatch) return null;

  const username = usernameMatch[1];
  const lower = text.toLowerCase();

  const posRegex = /\b(safe|seriös|serioes|vouch|vouched|vertrauenswürdig|empfehlung|empfehle|recommend|legit|trusted|zuverlässig|top|super|gut|bester|beste|bestätigt|verifiziert|real|echt|reibungslos|korrekt|einwandfrei|10\/10|100%|perfekt|danke|schnell)\b|\b(alles gut|hat geliefert|hat geklappt|hat funktioniert|pünktlich geliefert|bester mann|sehr guter service|guter service|sehr zufrieden|alles bestens|gerne wieder|alles super|hat gepasst)\b|[👍💯🤝🔥🚀❤️]/i;
  const negRegex = /\b(scam|scammer|betrug|betrüger|fake|unsicher|achtung|warning|vorsicht|ripper|gerippt|rip|abgezockt|abzocke|schwindler|unzuverlässig|gestohlen|lügt|falsch|unecht|blockiert|müll|schrott)\b|\b(nicht safe|nie wieder|schlechte erfahrung|keine empfehlung|nicht empfehlen|nicht zu empfehlen|nicht kaufen|hände weg|haende weg|finger weg|schlechter service|nichts bekommen|nicht bekommen|wurde betrogen)\b|[🤡💩👎🛑⛔]/i;

  const isPositive = posRegex.test(lower);
  const isNegative = negRegex.test(lower);

  if (isPositive && !isNegative) return { username, type: "positive" };
  if (isNegative && !isPositive) return { username, type: "negative" };

  return null;
}

const commandHandler = {
  async handleMessage(tg, supabase_db, msg, token, settings) {
    const chat = msg.chat || {};
    const from = msg.from || {};
    const text = msg.text?.trim() || "";
    const chatId = String(chat.id);

    const ch = await getChannel(chatId);

    if (chat.type !== "private" && ch && ch.is_active === false) {
       return;
    }

    if (chat.type === "private") {
      const hasPending = pendingInputs[String(from.id)];
      if (hasPending) {
        const handled = await inputWizardHandler.handle(tg, supabase_db, from.id, text, settings, msg);
        if (handled) return;
      }

      if (/^\/safeliste?(?:@\w+)?(?:\s+@?(.+))?$/i.test(text)) {
        const slMatch = text.match(/^\/safeliste?(?:@\w+)?\s+@?(.+)/i);
        const slTarget = slMatch ? slMatch[1].trim() : null;
        const { data: myChForSl } = await supabase.from("bot_channels").select("id, title").eq("added_by_user_id", chatId).eq("is_approved", true).eq("is_active", true).limit(5);
        if (!myChForSl?.length) {
          await tg.send(chatId, "❌ Du hast keine aktiven/freigeschalteten Channels.");
          return;
        }
        if (slTarget) {
          if (myChForSl.length === 1) {
            pendingInputs[String(chatId)] = { action: "safelist_add_user", channelId: String(myChForSl[0].id) };
            await inputWizardHandler.handle(tg, supabase_db, chatId, slTarget, settings, msg);
          } else {
            const kb = myChForSl.map(ch2 => [{ text: `📢 ${ch2.title||ch2.id}`, callback_data: `cfg_sl_adduser_${ch2.id}` }]);
            await tg.send(chatId, `Für welchen Channel soll @${slTarget} zur Safelist?`);
            await tg.call("sendMessage", { chat_id: chatId, text: "Channel auswählen:", reply_markup: { inline_keyboard: kb } });
          }
        } else {
          await settingsHandler.handleSettingsCallback(tg, supabase_db, `cfg_sl_safeview_${myChForSl[0].id}`, { from: { id: chatId } }, chatId);
        }
        return;
      }

      if (/^\/scamliste?(?:@\w+)?(?:\s+@?(.+))?$/i.test(text)) {
        const scMatch = text.match(/^\/scamliste?(?:@\w+)?\s+@?(.+)/i);
        const scTarget = scMatch ? scMatch[1].trim() : null;
        const { data: myChForSc } = await supabase.from("bot_channels").select("id, title").eq("added_by_user_id", chatId).eq("is_approved", true).eq("is_active", true).limit(5);
        if (!myChForSc?.length) {
          await tg.send(chatId, "❌ Du hast keine aktiven/freigeschalteten Channels.");
          return;
        }
        if (scTarget) {
          if (myChForSc.length === 1) {
            pendingInputs[String(chatId)] = { action: "scamlist_add_user", channelId: String(myChForSc[0].id) };
            await inputWizardHandler.handle(tg, supabase_db, chatId, scTarget, settings, msg);
          } else {
            const kb2 = myChForSc.map(ch2 => [{ text: `📢 ${ch2.title||ch2.id}`, callback_data: `cfg_sl_addscam_${ch2.id}` }]);
            await tg.send(chatId, `Für welchen Channel soll @${scTarget} zur Scamliste?`);
            await tg.call("sendMessage", { chat_id: chatId, text: "Channel auswählen:", reply_markup: { inline_keyboard: kb2 } });
          }
        } else {
          await settingsHandler.handleSettingsCallback(tg, supabase_db, `cfg_sl_scamview_${myChForSc[0].id}`, { from: { id: chatId } }, chatId);
        }
        return;
      }

      if (/^\/feedbacks?(?:@\w+)?$/i.test(text)) {
        const { data: myChans } = await supabase.from("bot_channels").select("id, title").eq("added_by_user_id", chatId).eq("is_approved", true).eq("is_active", true).limit(5);
        if (!myChans?.length) {
          await tg.send(chatId, "❌ Du hast keine aktiven/freigeschalteten Channels.");
          return;
        }
        if (myChans.length === 1) {
          await settingsHandler.handleSettingsCallback(tg, supabase_db, `cfg_feedback_${myChans[0].id}`, { from: { id: chatId, language_code: from.language_code } }, chatId);
        } else {
          const kb = myChans.map(ch2 => [{ text: `📢 ${ch2.title||ch2.id}`, callback_data: `cfg_feedback_${ch2.id}` }]);
          await tg.call("sendMessage", { chat_id: chatId, text: "Für welchen Channel möchtest du das Feedback-Menü öffnen?", reply_markup: { inline_keyboard: kb } });
        }
        return;
      }

      if (/^\/cancel(?:@\w+)?$/i.test(text)) {
        delete pendingInputs[String(from.id)];
        await tg.send(chatId, "❌ Abgebrochen.");
        return;
      }

      if (/^\/refill(?:@\w+)?/i.test(text) || text.toLowerCase() === "credits nachladen") {
        const { data: myChans } = await supabase_db.from("bot_channels").select("id, title, type, token_used, token_limit, credits_expire_at").eq("added_by_user_id", String(from.id)).eq("is_active", true);
        if (!myChans?.length) {
          await tg.send(chatId, "❌ Kein aktiver registrierter Channel gefunden.");
          return;
        }
        const chanKb = myChans.map(ch2 => {
          const used = ch2.token_used || 0;
          const lim = ch2.token_limit || 0;
          const pct = lim ? Math.round(used/lim*100) : 0;
          return [{ text: `${ch2.type==="channel"?"📢":"👥"} ${ch2.title||ch2.id} (${pct}% verbraucht)`, callback_data: "refill_chan_" + ch2.id }];
        });
        await tg.call("sendMessage", { chat_id: chatId, text: "🔋 <b>Credits nachladen</b>\n\nFür welchen Channel?", parse_mode: "HTML", reply_markup: { inline_keyboard: chanKb } });
        return;
      }

      if (/^\/buy(?:@\w+)?/i.test(text) || text.toLowerCase() === "credits kaufen") {
        const { data: myChans } = await supabase_db.from("bot_channels").select("id, title, type").eq("added_by_user_id", String(from.id)).eq("is_active", true);
        if (!myChans?.length) {
          await tg.send(chatId, "❌ Du hast noch keinen aktiven registrierten Channel.");
          return;
        }
        const chanKb = myChans.map(ch2 => [{ text: (ch2.type==="channel"?"📢":"👥") + " " + (ch2.title||ch2.id), callback_data: "buy_chan_" + ch2.id }]);
        await tg.call("sendMessage", { chat_id: chatId, text: "🛒 <b>Credit-Paket kaufen</b>\n\nFür welchen Channel?", parse_mode: "HTML", reply_markup: { inline_keyboard: chanKb } });
        return;
      }

      // ─── Deep-Link: /start donate_<channelId> ──────────────────────
      const donateStart = text.match(/^\/start(?:@\w+)?\s+donate_(-?\d+)$/i);
      if (donateStart) {
        const donateChanId = donateStart[1];
        let donateChannel = null;
        try {
          const { data } = await supabase_db.from("bot_channels")
            .select("*").eq("id", String(donateChanId)).maybeSingle();
          donateChannel = data;
        } catch (_) {}

        if (!donateChannel || donateChannel.is_active === false) {
          await tg.send(chatId, "❌ Channel nicht (mehr) verfügbar.");
          return;
        }

        const r = await sendDonationOptions(tg, supabase_db, chatId, from.id, donateChannel);
        if (!r.ok) {
          if (r.reason === "no_refills") {
            await tg.send(chatId, "❌ Aktuell sind keine Refills verfügbar.");
          } else {
            await tg.send(chatId, "❌ Aktuell sind keine Pakete verfügbar.");
          }
        }
        return;
      }

      // ─── /help im Privatchat → Übersicht aller Admin-Befehle ──────────
      if (/^\/help(?:@\w+)?$/i.test(text)) {
        const helpText =
          "📋 <b>Admin-Befehle</b>\n\n" +
          "<b>🛠 Verwaltung (im DM hier):</b>\n" +
          "<b>/menu</b> – Hauptmenü öffnen\n" +
          "<b>/settings</b> – Channel-Einstellungen\n" +
          "<b>/dashboard</b> – Channel-Übersicht\n" +
          "<b>/buy</b> – Credit-Paket kaufen\n" +
          "<b>/refill</b> – Credits nachladen\n\n" +
          "<b>👥 Moderation (in deiner Gruppe):</b>\n" +
          "<b>/ban [@user|ID|Reply] [Grund]</b> – User bannen\n" +
          "<b>/unban [@user|ID|Reply]</b> – User entbannen\n" +
          "<b>/mute [@user|ID|Reply] [Dauer] [Grund]</b> – User stummschalten\n" +
          "<i>Dauer: 30s, 5m, 2h, 1d, permanent</i>\n" +
          "<b>/unmute [@user|ID|Reply]</b> – Stummschaltung aufheben\n\n" +
          "<b>🔍 Recherche (überall):</b>\n" +
          "<b>/check @user</b> – Status & Feedbacks prüfen\n" +
          "<b>/userinfo [ID|@user]</b> – User analysieren\n" +
          "<b>/feedbacks</b> – Top 10 Verkäufer\n" +
          "<b>/safeliste</b> · <b>/scamliste</b> – Listen ansehen\n" +
          "<b>/ai &lt;Frage&gt;</b> – KI-Assistent befragen";
        await tg.call("sendMessage", { chat_id: chatId, text: helpText, parse_mode: "HTML" });
        return;
      }

      if (/^\/(?:start|menu|settings|dashboard)(?:@\w+)?/i.test(text)) {
        const { data: allMyChannels } = await supabase_db.from("bot_channels").select("id, title, type, is_approved, ai_enabled, bot_language, is_active").eq("added_by_user_id", String(from.id));

        if (!allMyChannels?.length) {
          const userLang = detectLang(from);
          await tg.send(chatId, t("welcome_intro", userLang).replace("{name}", from?.first_name ? " " + from.first_name : ""));
          return;
        }

        const deactivatedChannels = allMyChannels.filter(c => c.is_active === false);
        if (deactivatedChannels.length > 0 && allMyChannels.length === deactivatedChannels.length) {
          await tg.send(chatId, "⚠️ <b>Dein Channel/Gruppe wurde deaktiviert.</b>\n\nBitte melde dich bei @autoacts für weitere Informationen oder eine erneute Freischaltung.", { parse_mode: "HTML" });
          return;
        }

        const activeChannels = allMyChannels.filter(c => c.is_active !== false);

        if (activeChannels.length === 1) {
          const ch2 = await getChannel(String(activeChannels[0].id));
          await settingsHandler.sendSettingsMenu(tg, chatId, String(activeChannels[0].id), ch2, null, from?.language_code?.substring(0,2));
          return;
        }

        if (activeChannels.length > 1) {
          const keyboard = activeChannels.map(ch2 => [{ text: (ch2.type === "channel" ? "📢" : "👥") + " " + (ch2.title || ch2.id), callback_data: "sel_channel_" + ch2.id }]);
          await tg.call("sendMessage", { chat_id: chatId, text: "⚙️ Wähle deinen Channel:", reply_markup: { inline_keyboard: keyboard } });
          return;
        }
      }
    }

    if (from?.id) {
      await tgApi(token).call("getChatMember", { chat_id: chatId, user_id: from.id }).catch(() => {});
    }

    if (!text) return;

    // ─── /donate (NUR in Gruppen/Channels) ─────────────────────────────
    if (/^\/donate(?:@\w+)?$/i.test(text) && chat.type !== "private") {
      if (!ch) {
        await tg.send(chatId, "❌ Dieser Channel ist noch nicht registriert. Ein Admin muss zuerst /menu im Privat-Chat mit mir nutzen.");
        return;
      }
      if (ch.is_active === false) {
        await tg.send(chatId, "⚠️ Dieser Channel ist deaktiviert. Spendieren ist nicht möglich.");
        return;
      }

      // Versuche, dem Spender direkt eine PN zu schicken. Klappt nur, wenn
      // er den Bot vorher mindestens einmal angeschrieben hat.
      try {
        const r = await sendDonationOptions(tg, supabase_db, from.id, from.id, ch);
        if (!r.ok) {
          await tg.send(chatId, r.reason === "no_refills"
            ? "❌ Aktuell sind keine Refills verfügbar."
            : "❌ Aktuell sind keine Credit-Pakete verfügbar.");
          return;
        }
        const groupMsg = await tg.send(
          chatId,
          `❤️ ${from.first_name || "Spender:in"} möchte für diesen Channel spendieren — ich habe dir die ${r.mode === "refill" ? "Refill" : "Paket"}-Auswahl privat geschickt.`,
          { reply_to_message_id: msg.message_id }
        );
        if (groupMsg?.message_id) {
          void safelistService.trackBotMessage(chatId, groupMsg.message_id, "temp", 60 * 1000);
        }
      } catch (e) {
        // Spender hat den Bot noch nicht angeschrieben → Deep-Link-Button.
        const botName = settings?.bot_name || "AdminHelper_Bot";
        await tg.call("sendMessage", {
          chat_id: chatId,
          text: `❤️ <b>Spendieren möglich!</b>\n\n${from.first_name || "Du"}, schreib mir bitte einmal kurz privat (Klick auf den Button), dann kann ich dir die Auswahl schicken:`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "💬 Privat öffnen & spendieren", url: `https://t.me/${botName}?start=donate_${chatId}` }
            ]]
          },
          reply_to_message_id: msg.message_id
        });
      }
      return;
    }

    if (/^\/help(?:@\w+)?$/i.test(text)) {
      const isAdm = await isGroupAdmin(tg, chatId, from.id);
      if (isAdm) {
        const botName = settings?.bot_name || "AdminHelper_Bot";
        const msg = await tg.send(chatId, "⚙️ Ich habe dir das Admin-Schnellverwaltungsmenü als Privatnachricht gesendet.", { reply_markup: { inline_keyboard: [[{ text: "Zum Menü", url: `https://t.me/${botName}?start=menu` }]]}});
        if (msg?.message_id) void safelistService.trackBotMessage(chatId, msg.message_id, "temp", 15000);
        await tg.call("sendMessage", {
          chat_id: String(from.id),
          text: `⚙️ <b>Admin-Menü für ${ch?.title || "Gruppe"}</b>\nWähle eine Funktion:`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🧹 Gelöschte Accounts entfernen", callback_data: `admin_clean_${chatId}` }],
              [{ text: "📌 Letzte Nachricht pinnen",       callback_data: `admin_pin_last_${chatId}` }],
              [{ text: "📋 Mitglieder-Anzahl",             callback_data: `admin_count_${chatId}` }],
              [{ text: "🗑 Letzte Nachricht löschen",      callback_data: `admin_del_last_${chatId}` }],
              [{ text: "⏰ Geplante Nachrichten",          callback_data: `admin_schedule_${chatId}` }],
              [{ text: "🛡 Safelist verwalten",            callback_data: `admin_safelist_${chatId}` }]
            ]
          }
        });
      } else {
        const helpText = `📋 <b>Verfügbare Befehle</b>\n\n` +
          `<b>/donate</b> – ❤️ Dem Channel ein Credit-Paket spendieren\n` +
          (ch?.ai_enabled ? `<b>/ai [Frage]</b> – KI-Assistent befragen\n` : "") +
          (ch?.safelist_enabled ? `<b>/feedbacks @user</b> – Top 10 Verkäufer einsehen\n<b>/check @user</b> – Status & Feedbacks prüfen\n<b>/scamliste</b> – Scamliste ansehen\n<b>/safeliste</b> – Safelist ansehen\n` : "") +
          `<b>/userinfo [ID|@user]</b> – User-Info (5x/Tag kostenlos)`;
        const helpMsg = await tg.send(chatId, helpText);
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 5 * 60 * 1000);
      }
      return;
    }

    const adminCmds = ["/admin", "/menu"];
    if (adminCmds.some(cmd => text.startsWith(cmd) || new RegExp(`^${cmd}(?:@\\w+)?`, "i").test(text))) {
      if (await isGroupAdmin(tg, chatId, from.id)) {
        await tg.call("sendMessage", {
          chat_id: chatId,
          text: "⚙️ <b>Admin-Menü</b>\nWähle eine Funktion:",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🧹 Gelöschte Accounts entfernen", callback_data: "admin_clean" }],
              [{ text: "📌 Nachricht pinnen",              callback_data: "admin_pin_last" }],
              [{ text: "📋 Mitglieder-Anzahl",             callback_data: "admin_count" }],
              [{ text: "🗑 Letzte Nachricht löschen",      callback_data: "admin_del_last" }],
              [{ text: "⏰ Geplante Nachrichten",          callback_data: "admin_schedule" }],
              [{ text: "🛡 Safelist verwalten",            callback_data: "admin_safelist" }]
            ]
          },
          reply_to_message_id: msg.message_id
        });
      } else {
        await tg.send(chatId, "🔧 Hier wird gerade gearbeitet.");
      }
      return;
    }

    if (/^\/settings(?:@\w+)?$/i.test(text)) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      await tg.call("sendMessage", {
        chat_id: chatId,
        text: "⚙️ Wo soll das Einstellungs-Menü geöffnet werden?",
        reply_markup: { inline_keyboard: [[
          { text: "💬 Hier im Chat",        callback_data: `settings_here_${chatId}` },
          { text: "🔒 Privat (nur für mich)", callback_data: `settings_private_${chatId}_${from.id}` }
        ]]}
      });
      return;
    }

    if (/^\/clean(?:@\w+)?$/i.test(text)) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      await tg.send(chatId, "🔍 Prüfe Mitgliederliste...");
      const { data: members } = await supabase_db.from("channel_members")
        .select("user_id").eq("channel_id", chatId).eq("is_deleted", false).limit(200);
      let removed = 0, checked = 0;
      if (members?.length) {
        for (const m of members) {
          try {
            const cm = await tg.call("getChatMember", { chat_id: chatId, user_id: m.user_id });
            checked++;
            const isDeleted = !cm?.user?.first_name && !cm?.user?.username && cm?.status !== "left" && cm?.status !== "kicked";
            if (isDeleted || cm?.user?.is_deleted) {
              await tg.call("banChatMember", { chat_id: chatId, user_id: m.user_id, revoke_messages: false });
              await tg.call("unbanChatMember", { chat_id: chatId, user_id: m.user_id, only_if_banned: true });
              await supabase_db.from("channel_members").update({ is_deleted: true }).eq("channel_id", chatId).eq("user_id", m.user_id);
              removed++;
            }
          } catch {}
        }
      }
      await tg.send(chatId, `🧹 Fertig! ${checked} geprüft, ${removed} entfernt.`);
      return;
    }

    if (/^\/pin(?:@\w+)?$/i.test(text) && msg.reply_to_message) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      await tg.call("pinChatMessage", { chat_id: chatId, message_id: msg.reply_to_message.message_id, disable_notification: false });
      await tg.send(chatId, "📌 Gepinnt!");
      return;
    }

    if (/^\/del(?:@\w+)?$/i.test(text) && msg.reply_to_message) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.reply_to_message.message_id }).catch(() => {});
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return;
    }

    if (text && from?.id && !text.startsWith("/")) {
      void safelistService.saveContextMsg(chatId, from.id, from.username, text);
    }

    if (text && from?.id && !text.startsWith("/") && (ch?.feedback_enabled || ch?.safelist_enabled) && !from.is_bot && ch?.is_approved) {
      const fbDetect = _detectFeedback(text);
      if (fbDetect) {
        const confirmMsg = await tg.call("sendMessage", { chat_id: chatId,
          text: `💬 Feedback erkannt für @${fbDetect.username}\n<i>${text.substring(0,100)}</i>\n\nEinordnung:`,
          parse_mode: "HTML", reply_to_message_id: msg.message_id,
          reply_markup: { inline_keyboard: [[
            { text: "✅ Positiv", callback_data: `fb_confirm_pos_${fbDetect.username}_${from.id}_${chatId}` },
            { text: "⚠️ Negativ", callback_data: `fb_confirm_neg_${fbDetect.username}_${from.id}_${chatId}` },
            { text: "❌ Keins",   callback_data: `fb_confirm_no_${fbDetect.username}_${from.id}_${chatId}` }
          ]]}
        }).catch(() => null);
        if (confirmMsg?.message_id) void safelistService.trackBotMessage(chatId, confirmMsg.message_id, "temp", 2*60*1000);
      }
    }

    const safelistActive = ch?.safelist_enabled || false;

    if (/^\/safeliste?(?:@\w+)?$/i.test(text) && safelistActive && ch?.is_approved) {
      const { data: sl2 } = await supabase_db.from("channel_safelist").select("username, user_id, score, created_at").eq("channel_id", chatId).order("created_at", { ascending: false }).limit(20);
      let slText = "🛡 <b>Safelist</b>\n\n";
      slText += sl2?.length ? sl2.map((e,i) => `${i+1}. ✅ @${e.username||e.user_id}` + (e.score ? ` (${e.score} Pkt)` : "")).join("\n") : "<i>Noch keine Einträge.</i>";
      const slMsg = await tg.call("sendMessage", { chat_id: chatId, text: slText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
      if (slMsg?.message_id) void safelistService.trackBotMessage(chatId, slMsg.message_id, "temp", 5*60*1000);
      return;
    }

    if (/^\/scamliste?(?:@\w+)?$/i.test(text) && safelistActive && ch?.is_approved) {
      const { data: sc2 } = await supabase_db.from("scam_entries").select("username, user_id, reason, created_at").eq("channel_id", chatId).order("created_at", { ascending: false }).limit(20);
      let scText = "⛔ <b>Scamliste</b>\n\n";
      scText += sc2?.length ? sc2.map((e,i) => `${i+1}. ⛔ @${e.username||e.user_id}` + (e.reason ? ` — <i>${e.reason.substring(0,60)}</i>` : "")).join("\n") : "<i>Noch keine Einträge.</i>";
      const scMsg = await tg.call("sendMessage", { chat_id: chatId, text: scText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
      if (scMsg?.message_id) void safelistService.trackBotMessage(chatId, scMsg.message_id, "temp", 5*60*1000);
      return;
    }

    const isFeedbacksCmd = /^\/feedbacks?(?:@\w+)?(?:\s+.*)?$/i.test(text);
    if (isFeedbacksCmd && safelistActive && ch?.is_approved) {
      let targetUser = text.replace(/^\/feedbacks?(?:@\w+)?\s*/i, "").trim().replace(/^@/, "");
      if (!targetUser && msg.reply_to_message?.from) {
        targetUser = msg.reply_to_message.from.username || String(msg.reply_to_message.from.id);
      }
      if (!targetUser) {
        let top10 = null;
        try {
          const res = await supabase_db.rpc("get_top_sellers", { p_channel_id: chatId, p_limit: 10 });
          top10 = res.data;
        } catch (e) {}
        const medals = ["🥇","🥈","🥉"];
        let rankText = "🏆 <b>Top 10 Verkäufer</b>\n\n";
        rankText += top10?.length ? top10.map((u,i) => `${medals[i]||`${i+1}.`} @${u.username||u.user_id} — <b>${u.score} Pkt</b> (✅ ${u.pos_count} | ⚠️ ${u.neg_count})`).join("\n") : "<i>Noch kein Ranking verfügbar.</i>";
        const rkMsg = await tg.call("sendMessage", { chat_id: chatId, text: rankText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (rkMsg?.message_id) void safelistService.trackBotMessage(chatId, rkMsg.message_id, "temp", 5*60*1000);
      } else {
        let score = 0, pos = 0, neg = 0;
        const { data: rep } = await supabase_db.from("user_reputation").select("score, pos_count, neg_count").eq("channel_id", chatId).ilike("username", targetUser).maybeSingle();
        if (rep) { score = rep.score; pos = rep.pos_count; neg = rep.neg_count; }
        let detailText = `📊 <b>Feedback-Details für @${targetUser}</b>\n\n`;
        detailText += `⭐️ <b>Score:</b> ${score} Pkt\n`;
        detailText += `✅ ${pos} Positiv · ⚠️ ${neg} Negativ\n\n`;
        try {
          const feedbacks = await safelistService.getFeedbacks(chatId, targetUser, null);
          if (feedbacks && feedbacks.length > 0) {
            detailText += `💬 <b>Letzte Feedbacks:</b>\n`;
            feedbacks.slice(0, 10).forEach(f => {
              const emoji = f.feedback_type === "positive" ? "✅" : "⚠️";
              const by = f.submitted_by_username ? `@${f.submitted_by_username}` : "anonym";
              detailText += `${emoji} <i>"${(f.feedback_text || "").substring(0, 80)}"</i> — ${by}\n`;
            });
          } else {
            detailText += `<i>Keine detaillierten Einträge gefunden.</i>`;
          }
        } catch (e) {
          detailText += `<i>Keine detaillierten Einträge gefunden.</i>`;
        }
        const rkMsg = await tg.call("sendMessage", { chat_id: chatId, text: detailText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (rkMsg?.message_id) void safelistService.trackBotMessage(chatId, rkMsg.message_id, "temp", 5*60*1000);
      }
      return;
    }

    const feedbackMatch = text.match(/^\/(?:check)(?:@\w+)?\s+@?(\w+)/i);
    if (feedbackMatch && safelistActive && ch?.is_approved && ch?.is_active !== false) {
      const targetUsername = feedbackMatch[1];
      let score = 0, pos = 0, neg = 0;
      const { data: rep } = await supabase_db.from("user_reputation").select("score, pos_count, neg_count").eq("channel_id", chatId).ilike("username", targetUsername).maybeSingle();
      if (rep) { score = rep.score; pos = rep.pos_count; neg = rep.neg_count; }
      const scamEntry = await safelistService.checkScamlist(chatId, targetUsername, null);
      let replyText = `📊 <b>@${targetUsername}</b>\n`;
      if (scamEntry) {
        replyText = `⛔ <b>ACHTUNG: @${targetUsername} steht auf der Scamliste!</b>\n\n`;
        replyText += `⭐️ <b>Score:</b> ${score} Pkt (✅ ${pos} | ⚠️ ${neg})\n`;
        replyText += `<i>Grund: ${scamEntry.reason ? scamEntry.reason.substring(0,150) : "Kein Grund angegeben."}</i>\n`;
      } else {
        replyText += `⭐️ <b>Score:</b> ${score} Pkt\n`;
        replyText += `✅ ${pos} Positiv · ⚠️ ${neg} Negativ\n\n`;
        if (ch?.ai_enabled) {
          const aiSummary = await safelistService.generateAiSummary(chatId, targetUsername, null);
          if (aiSummary) replyText += `🤖 <b>KI-Zusammenfassung:</b>\n${aiSummary}`;
          else replyText += `<i>Noch nicht genug Text-Feedbacks für eine Zusammenfassung.</i>`;
        } else {
          replyText += `<i>KI-Zusammenfassung ist in diesem Channel nicht aktiviert.</i>`;
        }
      }
      const sentMsg = await tg.send(chatId, replyText);
      if (sentMsg?.message_id) void safelistService.trackBotMessage(chatId, sentMsg.message_id, "check_result", 5 * 60 * 1000);
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return;
    }

    const safelistAdminMatch = text.match(/^\/safe?list[e]?(?:@\w+)?\s+@?(\w+)\s*(.*)/i);
    if (safelistAdminMatch && safelistActive && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) {
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

    const scamMatch = text.match(/^\/scam?list[e]?(?:@\w+)?\s+@?(\w+)\s*(.*)/i);
    if (scamMatch && safelistActive && ch?.is_approved) {
      const [, username, reason] = scamMatch;
      const fb = await safelistService.submitFeedback({
        channelId: chatId, submittedBy: from?.id, submittedByUsername: from?.username,
        targetUsername: username, feedbackType: "negative",
        feedbackText: reason || "Scam-Verdacht"
      });
      if (fb?.id) {
        pendingInputs["scam_confirm_" + String(from?.id) + "_" + chatId] = {
          action: "await_proof_confirm", feedbackId: fb.id,
          targetUsername: username, channelId: chatId, reporterUsername: from?.username
        };
        const sent = await tg.send(chatId, `⚠️ Scam-Meldung gegen @${username} eingereicht.\n\nHast du Beweise (Screenshots, Videos, Texte)?\nAntworte mit <b>"Ich habe Proofs"</b> um Beweise privat einzureichen.\n\n<i>Ohne Beweise wird die Meldung möglicherweise abgelehnt.</i>`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 60000);
      }
      return;
    }

    if (/ich habe proofs?/i.test(text) && from?.id && safelistActive && ch?.is_approved) {
      const key = "scam_confirm_" + String(from.id) + "_" + chatId;
      const pending = pendingInputs[key];
      if (pending) {
        delete pendingInputs[key];
        pendingInputs[String(from.id)] = {
          action: "collecting_proofs", feedbackId: pending.feedbackId,
          channelId: chatId, targetUsername: pending.targetUsername,
          reporterUsername: pending.reporterUsername, proofCount: 0
        };
        const sent = await tg.send(chatId, `📩 Bitte schicke deine Beweise <b>direkt im privaten Chat</b>.\n→ Öffne den Bot-Chat und tippe /start falls noch nicht geschehen.`);
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 30000);
      }
      return;
    }

    const isUserinfoCmd = /^\/userinfo(?:@\w+)?/i.test(text);
    if (isUserinfoCmd) {
      let lookupId = null;
      const uiArg = text.replace(/^\/userinfo(?:@\w+)?\s*/i, "").trim();
      if (uiArg) {
        lookupId = uiArg;
      } else if (msg.reply_to_message?.from) {
        lookupId = String(msg.reply_to_message.from.id);
      }
      if (!lookupId) {
        const hint = await tg.send(chatId, "💡 Nutze /userinfo @username, /userinfo [ID] oder als Reply auf eine Nachricht mit /userinfo");
        if (hint?.message_id) void safelistService.trackBotMessage(chatId, hint.message_id, "temp", 10000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } else {
        await userInfoService.runUserInfo(tg, supabase_db, from.id, lookupId, chatId, null, chatId);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      }
      return;
    }

    if (/^\/ban(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const lang = ch?.bot_language || "de";

      // Drei Aufruf-Varianten:
      //   1) /ban (Reply auf User)              [Grund optional am Ende]
      //   2) /ban @username [Grund]
      //   3) /ban USER_ID [Grund]
      let banTargetId = null;
      let banTargetName = null;
      let banReason = "";

      if (msg.reply_to_message?.from) {
        const t2 = msg.reply_to_message.from;
        banTargetId = t2.id;
        banTargetName = t2.username ? "@" + t2.username : (t2.first_name || String(t2.id));
        banReason = text.replace(/^\/ban(?:@\w+)?\s*/i, "").trim();
      } else {
        const m = text.match(/^\/ban(?:@\w+)?\s+(\S+)(?:\s+(.+))?$/i);
        if (!m) {
          const usageMsg = await tg.send(chatId, "ℹ️ Verwendung: <code>/ban @user [Grund]</code>, <code>/ban USER_ID [Grund]</code> oder als Reply auf eine Nachricht.");
          if (usageMsg?.message_id) void safelistService.trackBotMessage(chatId, usageMsg.message_id, "temp", 15000);
          return;
        }
        const ref = m[1];
        banReason = (m[2] || "").trim();
        const resolved = await blacklistService.resolveUserRef(supabase_db, chatId, ref);
        banTargetId = resolved?.userId || (/^\d+$/.test(ref) ? ref : null);
        banTargetName = resolved?.username ? "@" + resolved.username : (banTargetId ? `<code>${banTargetId}</code>` : ref);
        if (!banTargetId) {
          const errMsg = await tg.send(chatId, t("cmd_user_not_found", lang, { ref }));
          if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
          return;
        }
      }

      const reasonShown = banReason ? banReason.substring(0, 200) : "Kein Grund angegeben";
      try {
        await tg.call("banChatMember", { chat_id: chatId, user_id: parseInt(banTargetId), until_date: 0, revoke_messages: false });
        try {
          await supabase_db.from("channel_banned_users").upsert([{
            channel_id: String(chatId),
            user_id: String(banTargetId),
            username: msg.reply_to_message?.from?.username || (banTargetName?.startsWith("@") ? banTargetName.slice(1) : null),
            reason: reasonShown,
            banned_at: new Date().toISOString()
          }], { onConflict: "channel_id,user_id" });
        } catch (_) {}
        const adminName = from.username ? "@" + from.username : (from.first_name || "Admin");
        const banMsg = await tg.call("sendMessage", {
          chat_id: chatId,
          text: `🚫 ${banTargetName} wurde gebannt.\n<b>Grund:</b> ${reasonShown}\n<i>Aktion durch ${adminName}</i>`,
          parse_mode: "HTML"
        });
        if (banMsg?.message_id) void safelistService.trackBotMessage(chatId, banMsg.message_id, "temp", 5 * 60 * 1000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e2) { logger.warn("[Ban]", e2.message); }
      return;
    }

    if (/^\/unban(?:@\w+)?(?:\s+(\S+))?/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const lang = ch?.bot_language || "de";
      const unbanRef = text.match(/^\/unban(?:@\w+)?\s+(\S+)/i)?.[1] || (msg.reply_to_message?.from ? String(msg.reply_to_message.from.id) : null);
      if (!unbanRef) {
        const usageMsg = await tg.send(chatId, t("cmd_unban_usage", lang));
        if (usageMsg?.message_id) void safelistService.trackBotMessage(chatId, usageMsg.message_id, "temp", 15000);
        return;
      }
      const resolved = await blacklistService.resolveUserRef(supabase_db, chatId, unbanRef);
      const targetUserId = resolved?.userId || (/^\d+$/.test(unbanRef) ? unbanRef : null);
      if (!targetUserId) {
        const errMsg = await tg.send(chatId, t("cmd_user_not_found", lang, { ref: unbanRef }));
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      const result = await blacklistService.unbanUser(supabase_db, tg, chatId, targetUserId);
      const display = resolved?.username ? "@" + resolved.username : `<code>${targetUserId}</code>`;
      if (result.ok) {
        const okMsg = await tg.send(chatId, t("cmd_unban_ok", lang, { user: display }));
        if (okMsg?.message_id) void safelistService.trackBotMessage(chatId, okMsg.message_id, "temp", 15000);
      } else {
        const errMsg = await tg.send(chatId, t("cmd_unban_fail", lang, { error: result.error || "?" }));
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 10000);
      }
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return;
    }

    // /unmute @username | USER_ID | (als Reply auf eine Nachricht)
    if (/^\/unmute(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const lang = ch?.bot_language || "de";
      const unmuteRef = text.match(/^\/unmute(?:@\w+)?\s+(\S+)/i)?.[1]
                        || (msg.reply_to_message?.from ? String(msg.reply_to_message.from.id) : null);
      if (!unmuteRef) {
        const usageMsg = await tg.send(chatId, t("cmd_unmute_usage", lang));
        if (usageMsg?.message_id) void safelistService.trackBotMessage(chatId, usageMsg.message_id, "temp", 15000);
        return;
      }
      const resolved = await blacklistService.resolveUserRef(supabase_db, chatId, unmuteRef);
      const targetUserId = resolved?.userId || (/^\d+$/.test(unmuteRef) ? unmuteRef : null);
      if (!targetUserId) {
        const errMsg = await tg.send(chatId, t("cmd_user_not_found", lang, { ref: unmuteRef }));
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      const result = await blacklistService.unmuteUser(tg, chatId, targetUserId);
      const display = resolved?.username
        ? "@" + resolved.username
        : (msg.reply_to_message?.from?.first_name || `<code>${targetUserId}</code>`);
      if (result.ok) {
        const okMsg = await tg.send(chatId, t("cmd_unmute_ok", lang, { user: display }));
        if (okMsg?.message_id) void safelistService.trackBotMessage(chatId, okMsg.message_id, "temp", 15000);
      } else {
        const errMsg = await tg.send(chatId, t("cmd_unmute_fail", lang, { error: result.error || "?" }));
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 10000);
      }
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      return;
    }

    // /mute Aufruf-Varianten:
    //   1) Als Reply:           /mute [Dauer] [Grund]
    //   2) Per @username:       /mute @user [Dauer] [Grund]
    //   3) Per ID:              /mute USER_ID [Dauer] [Grund]
    if (/^\/mute(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const lang = ch?.bot_language || "de";

      let targetId = null, targetName = null, durationStr = "24h", muteReason = "";

      if (msg.reply_to_message?.from) {
        // Variante 1: Reply
        const t2 = msg.reply_to_message.from;
        targetId = t2.id;
        targetName = t2.username ? "@" + t2.username : (t2.first_name || String(t2.id));
        const m1 = text.match(/^\/mute(?:@\w+)?(?:\s+(\d+[smhd]|permanent))?(?:\s+(.+))?$/i);
        durationStr = (m1 && m1[1]) || "24h";
        muteReason = (m1 && m1[2]) || "";
      } else {
        // Variante 2/3: erstes Token = Ref, optional Dauer, dann Grund
        const m = text.match(/^\/mute(?:@\w+)?\s+(\S+)(?:\s+(\d+[smhd]|permanent))?(?:\s+(.+))?$/i);
        if (!m) {
          const usageMsg = await tg.send(chatId, "ℹ️ Verwendung: <code>/mute @user [Dauer] [Grund]</code>\nDauer: <code>30s · 5m · 2h · 1d · permanent</code>\nOder als Reply auf eine Nachricht.");
          if (usageMsg?.message_id) void safelistService.trackBotMessage(chatId, usageMsg.message_id, "temp", 15000);
          return;
        }
        const ref = m[1];
        durationStr = m[2] || "24h";
        muteReason = (m[3] || "").trim();
        const resolved = await blacklistService.resolveUserRef(supabase_db, chatId, ref);
        targetId = resolved?.userId || (/^\d+$/.test(ref) ? ref : null);
        targetName = resolved?.username ? "@" + resolved.username : (targetId ? `<code>${targetId}</code>` : ref);
        if (!targetId) {
          const errMsg = await tg.send(chatId, t("cmd_user_not_found", lang, { ref }));
          if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
          return;
        }
      }

      const durationSeconds = blacklistService.parseDuration ? blacklistService.parseDuration(durationStr) : 86400;
      const untilDate = durationSeconds === -1 ? 0 : Math.floor(Date.now() / 1000) + durationSeconds;
      const displayDur = durationSeconds === -1 ? "permanent" : durationStr;
      const reasonShown = muteReason ? muteReason.substring(0, 200) : null;
      try {
        await tg.call("restrictChatMember", {
          chat_id: chatId, user_id: parseInt(targetId),
          permissions: { can_send_messages: false, can_send_other_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_add_web_page_previews: false },
          until_date: untilDate
        });
        const adminName = from.username ? "@" + from.username : (from.first_name || "Admin");
        const muteMsg = await tg.call("sendMessage", {
          chat_id: chatId,
          text: `🔇 ${targetName} wurde ${displayDur} stummgeschaltet.${reasonShown ? `\n<b>Grund:</b> ${reasonShown}` : ""}\n<i>Aktion durch ${adminName}</i>`,
          parse_mode: "HTML"
        });
        if (muteMsg?.message_id) void safelistService.trackBotMessage(chatId, muteMsg.message_id, "temp", 5 * 60 * 1000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e2) { logger.warn("[Mute]", e2.message); }
      return;
    }

    const blockedThreads = Array.isArray(ch?.blocked_thread_ids) ? ch.blocked_thread_ids : [];
    const currentThread = msg.message_thread_id || 0;
    const threadBlocked = currentThread && blockedThreads.includes(currentThread);

    const isAiEmptyCmd = /^\/ai(?:@\w+)?$/i.test(text);
    if (isAiEmptyCmd && ch?.is_approved && ch?.ai_enabled && !threadBlocked) {
      const sentAiPrompt = await tg.send(chatId, "🤖 <b>KI-Assistent</b>\n\nBitte antworte direkt auf <b>diese Nachricht</b> mit deiner Frage, um mit der AI zu sprechen.", { parse_mode: "HTML", reply_to_message_id: msg.message_id });
      if (sentAiPrompt?.message_id) void safelistService.trackBotMessage(chatId, sentAiPrompt.message_id, "temp", 60000);
      return;
    }

    const isReplyToBot = msg.reply_to_message && from?.id ? await safelistService.isBotMessage(chatId, msg.reply_to_message.message_id) : false;
    const aiMatch = text.match(/^\/ai(?:@\w+)?\s+(.*)/i);
    const aiQuestion = aiMatch ? aiMatch[1].trim() : (isReplyToBot && !text.startsWith("/") ? text : null);

    if (aiQuestion && ch?.is_approved && ch?.ai_enabled && !threadBlocked) {
      const history = from?.id ? await safelistService.getConversationHistory(chatId, from.id, 5) : [];
      if (from?.id) void safelistService.saveUserMessage(chatId, from.id, aiQuestion, msg.message_id);
      const smalltalkAgent = require("../ai/smalltalkAgent");
      const result = await smalltalkAgent.handle({ chatId, text: aiQuestion, settings, channelRecord: ch, history });
      if (result.reply) {
        const replyExtra = {};
        if (msg.message_id) replyExtra.reply_to_message_id = msg.message_id;
        if (msg.message_thread_id) replyExtra.message_thread_id = msg.message_thread_id;
        const sentAiMsg = await tg.send(chatId, result.reply, replyExtra);
        if (from?.id && sentAiMsg?.message_id) {
          void safelistService.saveAssistantMessage(chatId, from.id, result.reply, sentAiMsg.message_id);
        }
      }
    } else if (aiMatch && ch && ch.token_budget_exhausted) {
      const sent = await tg.send(chatId, "⚠️ KI aktuell nicht verfügbar. Credits erschöpft – der Channel-Admin kann Credits nachladen.");
      if (ch?.added_by_user_id && token) {
        let refills2 = [];
        try { const r2 = await supabase_db.from("channel_refills").select("id, name, credits, price_eur").eq("is_active", true).order("credits").limit(3); refills2 = r2.data || []; } catch (_) {}
        if (refills2?.length) {
          const rfKb = refills2.map(r => [{ text: `🔋 ${r.name} +${r.credits.toLocaleString()} Credits · ${parseFloat(r.price_eur).toFixed(2)} €`, callback_data: "refill_opt_" + r.id + "_" + chatId }]);
          await tg.call("sendMessage", { chat_id: String(ch.added_by_user_id), text: `⚠️ <b>Credits für "${ch.title||chatId}" erschöpft!</b>\n\nChannel-Mitglieder können die KI nicht mehr nutzen. Lade jetzt Credits nach:`, parse_mode: "HTML", reply_markup: { inline_keyboard: rfKb } }).catch(() => {});
        }
      }
      if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
    } else if (aiMatch && ch && !ch.ai_enabled) {
      const sent = await tg.send(chatId, "🔒 AI-Features sind für diesen Channel noch nicht freigeschaltet.\n\nWende dich an @autoacts für die Aktivierung.");
      if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
    }
  }
};

module.exports = commandHandler;