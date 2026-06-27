const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const { tgApi } = require("./tgAdminHelper");
const safelistService = require("./safelistService");
const settingsHandler = require("./settingsHandler");
const inputWizardHandler = require("./inputWizardHandler");
const userInfoService = require("./userInfoService");
const blacklistService = require("./blacklistService");
const groupGameService = require("./groupGameService");
const adminReportService = require("./adminReportService");
const userIdentityService = require("./userIdentityService");
const { detectLang, t } = require("../i18n");

const pendingInputs = global.pendingInputs = global.pendingInputs || {};

async function getChannel(chatId) {
  try {
    const { data } = await supabase.from("bot_channels").select("*").eq("id", String(chatId)).maybeSingle();
    return data || null;
  } catch { return null; }
}

async function isGroupAdmin(tg, chatId, userId) {
  return tg.isUserAdmin(chatId, userId);
}

/**
 * Löst das Ziel eines Moderations-Befehls (/ban /unban /mute /unmute) auf.
 * Reihenfolge der Auflösung:
 *   1. Reply-to-message  → direkt aus msg.reply_to_message.from
 *   2. Text-Mentions in Entities (für klickbare Namens-Tags ohne Username)
 *   3. Numerische user_id im Text (z.B. "/ban 12345678")
 *   4. @username im Text → channel_members DB-Lookup mit Fallback auf historischen Identity-Verlauf
 *
 * @returns {Promise<{id:number, username:string|null, first_name:string|null}|null>}
 */
async function _resolveTargetUser(supabase_db, chatId, msg, text) {
  // 1. Reply auf Nachricht
  if (msg?.reply_to_message?.from?.id) {
    const f = msg.reply_to_message.from;
    return { id: f.id, username: f.username || null, first_name: f.first_name || null };
  }

  // 2. Text-Mentions in Entities
  if (msg?.entities) {
    const mentionEntity = msg.entities.find(e => e.type === "text_mention" && e.user?.id);
    if (mentionEntity) {
      const u = mentionEntity.user;
      return { id: u.id, username: u.username || null, first_name: u.first_name || null };
    }
  }

  // 3. Numerische ID im Text — z.B. "/ban 123456789" oder "/ban 123456789 Grund..."
  const idMatch = text.match(/^\/(?:ban|unban|mute|unmute)(?:@\w+)?\s+(\d{4,})(?:\s|$)/i);
  if (idMatch) {
    const uid = parseInt(idMatch[1]);
    try {
      const { data } = await supabase_db.from("channel_members")
        .select("username, first_name")
        .eq("channel_id", String(chatId))
        .eq("user_id", uid)
        .limit(1).maybeSingle();
      return { id: uid, username: data?.username || null, first_name: data?.first_name || null };
    } catch (_) {
      try {
        const resolved = await userIdentityService.findByUsername(String(chatId), String(uid));
        if (resolved) {
          return { id: uid, username: resolved.username || null, first_name: resolved.first_name || null };
        }
      } catch (_) {}
      return { id: uid, username: null, first_name: null };
    }
  }

  // 4. @username im Text → channel_members Lookup
  const userMatch = text.match(/@([a-zA-Z0-9_]{3,32})/);
  if (userMatch) {
    const uname = userMatch[1];
    try {
      const { data } = await supabase_db.from("channel_members")
        .select("user_id, username, first_name")
        .eq("channel_id", String(chatId))
        .ilike("username", uname)
        .limit(1).maybeSingle();
      if (data?.user_id) {
        return { id: data.user_id, username: data.username, first_name: data.first_name };
      }
    } catch (_) {}
    try {
      const resolved = await userIdentityService.findByUsername(String(chatId), uname);
      if (resolved?.user_id) {
        return { id: resolved.user_id, username: resolved.username, first_name: resolved.first_name };
      }
    } catch (_) {}
  }
  return null;
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

/**
 * Gibt den echten Telegram-Username des Bots zurück.
 * 1. settings.smalltalk_bot_username (aus DB, bei testSmallTalkBot gesetzt)
 * 2. Telegram getMe() API
 * 3. Fallback auf bot_name oder Default
 */
async function _getBotUsername(tg, supabase_db, settings) {
  const fromDb = settings?.smalltalk_bot_username || settings?.bot_username;
  if (fromDb && fromDb.length > 2) return fromDb;
  try {
    const me = await tg.call("getMe", {});
    if (me?.username) {
      void supabase_db.from("settings")
        .update({ smalltalk_bot_username: me.username }).eq("id", 1)
        .then(() => {}, () => {});
      return me.username;
    }
  } catch (_) {}
  return settings?.bot_name || "AIAdminHelperx1_bot";
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
            .select("id, title, is_active").eq("id", String(donateChanId)).maybeSingle();
          donateChannel = data;
        } catch (_) {}

        if (!donateChannel || donateChannel.is_active === false) {
          await tg.send(chatId, "❌ Channel nicht (mehr) verfügbar.");
          return;
        }

        const { data: pkgs } = await supabase_db.from("channel_packages")
          .select("id, name, credits, price_eur, duration_days, is_active")
          .eq("is_active", true).order("price_eur", { ascending: true });
        const activePkgs = (pkgs || []).filter(p => p.is_active !== false);

        if (!activePkgs.length) {
          await tg.send(chatId, "❌ Aktuell sind keine Pakete verfügbar.");
          return;
        }

        const chTitle = donateChannel.title || `Channel ${donateChanId}`;
        const pkgKb = activePkgs.map(p => [{
          text: `📦 ${p.name} — ${p.credits.toLocaleString()} Credits · ${parseFloat(p.price_eur).toFixed(2)} €`,
          callback_data: `donate_pkg_${p.id}_${donateChanId}_${from.id}`
        }]);
        pkgKb.push([{ text: "❌ Abbrechen", callback_data: `donate_cancel_${from.id}` }]);

        await tg.call("sendMessage", {
          chat_id: chatId,
          text: `❤️ <b>Credit-Paket für „${chTitle}" spendieren</b>\n\nVielen Dank für deine Unterstützung! Wähle ein Paket:`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: pkgKb }
        });
        return;
      }

      if (/^\/(?:start|menu|settings|dashboard)(?:@\w+)?/i.test(text)) {
        // Eigene Channels (Owner)
        const { data: ownedChannels } = await supabase_db
          .from("bot_channels")
          .select("id, title, type, is_approved, ai_enabled, bot_language, is_active")
          .eq("added_by_user_id", String(from.id));

        // Co-Admin Channels laden und zusammenführen
        let coAdminChannels = [];
        try {
          const { data: coAdminRows } = await supabase_db
            .from("channel_co_admins").select("channel_id").eq("user_id", parseInt(from.id));
          if (coAdminRows?.length) {
            const coIds = coAdminRows.map(r => r.channel_id);
            const { data: coChans } = await supabase_db
              .from("bot_channels")
              .select("id, title, type, is_approved, ai_enabled, bot_language, is_active")
              .in("id", coIds);
            coAdminChannels = (coChans || []).map(c => ({ ...c, _isCoAdmin: true }));
          }
        } catch (_) {}

        // Zusammenführen (Duplikate entfernen)
        const seenIds = new Set();
        let allMyChannels = [...(ownedChannels || []), ...coAdminChannels].filter(c => {
          if (seenIds.has(String(c.id))) return false;
          seenIds.add(String(c.id)); return true;
        });

        // Arena-Kanäle ausfiltern
        try {
          const { data: allArenas } = await supabase_db
            .from("bot_channels")
            .select("diss_battle_arena_chat_id")
            .not("diss_battle_arena_chat_id", "is", null);
          const arenaIds = new Set(allArenas?.map(a => String(a.diss_battle_arena_chat_id)) || []);
          allMyChannels = allMyChannels.filter(c => !arenaIds.has(String(c.id)));
        } catch (_) {}

        if (!allMyChannels?.length) {
          const userLang = detectLang(from);
          await tg.send(chatId, t("welcome_intro", userLang, from?.first_name ? " " + from.first_name : ""));
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
          const keyboard = activeChannels.map(ch2 => [{
            text: (ch2.type === "channel" ? "📢" : "👥") + " " + (ch2.title || ch2.id) + (ch2._isCoAdmin ? " 👤" : ""),
            callback_data: "sel_channel_" + ch2.id
          }]);
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

      const { data: pkgs } = await supabase_db.from("channel_packages")
        .select("id, name, credits, price_eur, duration_days, is_active")
        .eq("is_active", true).order("price_eur", { ascending: true });

      const activePkgs = (pkgs || []).filter(p => p.is_active !== false);
      if (!activePkgs.length) {
        await tg.send(chatId, "❌ Aktuell sind keine Credit-Pakete verfügbar.");
        return;
      }

      const chTitle = ch.title || chat.title || `Channel ${chatId}`;
      const pkgKb = activePkgs.map(p => [{
        text: `📦 ${p.name} — ${p.credits.toLocaleString()} Credits · ${parseFloat(p.price_eur).toFixed(2)} €`,
        callback_data: `donate_pkg_${p.id}_${chatId}_${from.id}`
      }]);
      pkgKb.push([{ text: "❌ Abbrechen", callback_data: `donate_cancel_${from.id}` }]);

      const donorMsg = `❤️ <b>Credit-Paket für „${chTitle}" spendieren</b>\n\nDu möchtest dem Channel ein Paket schenken — vielen Dank!\n\nWähle ein Paket:`;
      try {
        await tg.call("sendMessage", {
          chat_id: String(from.id),
          text: donorMsg,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: pkgKb }
        });
        const groupMsg = await tg.send(chatId,
          `❤️ ${from.first_name || "Spender:in"} möchte für diesen Channel spendieren — ich habe dir die Pakete privat geschickt.`,
          { reply_to_message_id: msg.message_id }
        );
        if (groupMsg?.message_id) {
          void safelistService.trackBotMessage(chatId, groupMsg.message_id, "temp", 60 * 1000);
        }
      } catch (e) {
        const botName = await _getBotUsername(tg, supabase_db, settings);
        await tg.call("sendMessage", {
          chat_id: chatId,
          text: `❤️ <b>Spendieren möglich!</b>\n\n${from.first_name || "Du"}, schreib mir bitte einmal kurz privat (Klick auf den Button), dann kann ich dir die Pakete zur Auswahl schicken:`,
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
      // Befehlsliste für alle — Admins bekommen zusätzliche Admin-Befehle
      const helpText =
        `📋 <b>Verfügbare Befehle</b>\n\n` +
        (ch?.ai_enabled
          ? `🤖 <b>/ai [Frage]</b> — KI-Assistent befragen\n`
          : "") +
        (ch?.safelist_enabled
          ? `🛡 <b>/check</b> — Eigenen Status prüfen\n` +
            `🛡 <b>/check @user</b> — User-Status prüfen (Reply möglich)\n` +
            `📊 <b>/feedbacks @user</b> — Feedback-Details ansehen\n` +
            `📋 <b>/safeliste</b> — Safelist anzeigen\n` +
            `⛔ <b>/scamliste</b> — Scamliste anzeigen\n`
          : "") +
        `🔍 <b>/userinfo [ID|@user]</b> — User-Informationen\n` +
        (isAdm
          ? `\n👮 <b>Admin-Befehle:</b>\n` +
            `⚙️ <b>/admin</b> — Admin-Schnellmenü\n` +
            `📌 <b>/pin</b> — Nachricht anpinnen (Reply)\n` +
            `🗑 <b>/del</b> — Nachricht löschen (Reply)\n` +
            `🚫 <b>/ban @user</b> — User sperren\n` +
            `🔓 <b>/unban @user</b> — User entsperren\n` +
            `⏰ <b>/mute @user</b> — User stummschalten\n` +
            `🛡 <b>/safeliste @user</b> — User auf Safelist setzen\n` +
            `⛔ <b>/scamliste @user</b> — User als Scammer melden\n` +
            `🌙 <b>/quiet</b> — Nachtruhe-Status\n`
          : "");

      const helpMsg = await tg.call("sendMessage", {
        chat_id: chatId, parse_mode: "HTML",
        text: helpText,
        reply_to_message_id: msg.message_id
      }).catch(() => null);
      if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 5 * 60 * 1000);
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

    // Feedback-Erkennung: NUR aktiv wenn Channel-Admin explizit aktiviert hat.
    // Früher: `ch?.feedback_enabled || ch?.safelist_enabled` — falscher Check.
    // Prüft jetzt sowohl Boolean true als auch String "true" (Supabase-Kompatibilität).
    const fbEnabled = ch?.feedback_enabled === true || ch?.feedback_enabled === "true";
    if (text && from?.id && !text.startsWith("/") && fbEnabled && !from.is_bot && ch?.is_approved) {
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

    // ─── User-Identity-Tracking (1.6.73) ──────────────────────────────────────
    // Jede Nachricht im Channel loggt aktuellen Username/Name. Damit kennt die
    // Channel-AI später den vollständigen Username-Verlauf jedes Chatpartners.
    if (from?.id && ch?.is_approved) {
      void userIdentityService.logIdentity({
        channelId: String(chatId),
        userId:    from.id,
        username:  from.username,
        firstName: from.first_name,
        lastName:  from.last_name,
        source:    "message"
      });
    }

    // ─── @admin-Mention-Detection (1.6.73) ────────────────────────────────────
    // Nur in Gruppen, nicht im DM zum Bot, und User darf sich nicht selbst melden.
    if (ch?.is_approved && ch?.admin_report_enabled
        && adminReportService.detectAdminMention(text)
        && (chat.type === "group" || chat.type === "supergroup")) {
      try {
        await adminReportService.handleAdminReport(tg, chatId, msg, ch);
      } catch (e) {
        logger.warn(`[commandHandler] @admin report Fehler: ${e.message}`);
      }
      return;  // Befehl ist behandelt — nicht weiterprozessieren
    }

    if (/^\/safeliste?(?:@\w+)?(?:\s+.+)?$/i.test(text) && safelistActive && ch?.is_approved) {
      const slArg = (text.match(/^\/safeliste?(?:@\w+)?\s+@?(.+)$/i) || [])[1]?.trim();

      // OHNE Argument: Liste zeigen
      if (!slArg) {
        const { data: sl2 } = await supabase_db.from("channel_safelist").select("username, user_id, score, created_at").eq("channel_id", chatId).order("created_at", { ascending: false }).limit(20);
        let slText = "🛡 <b>Safelist</b>\n\n";
        slText += sl2?.length ? sl2.map((e,i) => `${i+1}. ✅ @${e.username||e.user_id}` + (e.score ? ` (${e.score} Pkt)` : "")).join("\n") : "<i>Noch keine Einträge.</i>";
        const slMsg = await tg.call("sendMessage", { chat_id: chatId, text: slText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (slMsg?.message_id) void safelistService.trackBotMessage(chatId, slMsg.message_id, "temp", 5*60*1000);
        return;
      }

      // MIT Argument: Admin → User auf Liste setzen; sonst → /check
      const isAdminUser = await isGroupAdmin(tg, chatId, from.id);
      if (isAdminUser) {
        const tgt = await _resolveTargetUser(supabase_db, chatId, msg, "/ban " + slArg); // resolve nutzt gleiche Logik
        if (!tgt?.id && !slArg.match(/^[a-zA-Z0-9_]{3,32}$/)) {
          const errMsg = await tg.send(chatId, "❌ Bitte @username oder Telegram-ID angeben (z.B. <code>/safelist @user</code>).");
          if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
          return;
        }
        try {
          await safelistService.addToSafelist(chatId, {
            userId:    tgt?.id || null,
            username:  tgt?.username || slArg.replace(/^@/, ""),
            firstName: tgt?.first_name || null,
            reason:    "Manuell via /safelist von Admin",
            adminUserId: from.id
          });
          const okMsg = await tg.send(chatId, `🛡 @${tgt?.username || slArg} wurde auf die Safeliste gesetzt.`);
          if (okMsg?.message_id) void safelistService.trackBotMessage(chatId, okMsg.message_id, "temp", 30000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e) {
          await tg.send(chatId, "❌ Fehler: " + String(e.message).substring(0, 100));
        }
        return;
      }

      // Nicht-Admin: wie /check
      const fakeCheckText = "/check " + slArg;
      msg.text = fakeCheckText;
      text = fakeCheckText;
      // weiter zur /check-Logik unten
    }

    if (/^\/scamliste?(?:@\w+)?(?:\s+.+)?$/i.test(text) && safelistActive && ch?.is_approved) {
      const scArg = (text.match(/^\/scamliste?(?:@\w+)?\s+@?(.+)$/i) || [])[1]?.trim();

      // OHNE Argument: Liste zeigen
      if (!scArg) {
        const { data: sc2 } = await supabase_db.from("scam_entries").select("username, user_id, reason, created_at").eq("channel_id", chatId).order("created_at", { ascending: false }).limit(20);
        let scText = "⛔ <b>Scamliste</b>\n\n";
        scText += sc2?.length ? sc2.map((e,i) => `${i+1}. ⛔ @${e.username||e.user_id}` + (e.reason ? ` — <i>${e.reason.substring(0,60)}</i>` : "")).join("\n") : "<i>Noch keine Einträge.</i>";
        const scMsg = await tg.call("sendMessage", { chat_id: chatId, text: scText, parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(() => null);
        if (scMsg?.message_id) void safelistService.trackBotMessage(chatId, scMsg.message_id, "temp", 5*60*1000);
        return;
      }

      // MIT Argument: Admin → User auf Scamliste; sonst → /check
      const isAdminUser2 = await isGroupAdmin(tg, chatId, from.id);
      if (isAdminUser2) {
        const tgt = await _resolveTargetUser(supabase_db, chatId, msg, "/ban " + scArg);
        if (!tgt?.id && !scArg.match(/^[a-zA-Z0-9_]{3,32}$/)) {
          const errMsg = await tg.send(chatId, "❌ Bitte @username oder Telegram-ID angeben (z.B. <code>/scamlist @user</code>).");
          if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
          return;
        }
        try {
          await safelistService.addToScamlist(chatId, {
            userId:    tgt?.id || null,
            username:  tgt?.username || scArg.replace(/^@/, ""),
            firstName: tgt?.first_name || null,
            reason:    "Manuell via /scamlist von Admin",
            adminUserId: from.id
          });
          const okMsg = await tg.send(chatId, `⛔ @${tgt?.username || scArg} wurde auf die Scamliste gesetzt.`);
          if (okMsg?.message_id) void safelistService.trackBotMessage(chatId, okMsg.message_id, "temp", 30000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        } catch (e) {
          await tg.send(chatId, "❌ Fehler: " + String(e.message).substring(0, 100));
        }
        return;
      }

      // Nicht-Admin: wie /check
      const fakeCheckText = "/check " + scArg;
      msg.text = fakeCheckText;
      text = fakeCheckText;
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

    // ── /check — 3 Modi: /check @user, Reply auf Nachricht, /check (selbst) ──
    if (/^\/check(?:@\w+)?(?:\s+@?\w+)?$/i.test(text) && safelistActive && ch?.is_approved && ch?.is_active !== false) {

      // Target ermitteln: 1. @username im Befehl  2. Reply-User  3. Selbst
      let targetUsername = null;
      let targetUserId   = null;

      const cmdMatch = text.match(/^\/check(?:@\w+)?\s+@?(\w+)/i);
      if (cmdMatch) {
        // /check @username
        targetUsername = cmdMatch[1].toLowerCase().trim();
      } else if (msg.reply_to_message?.from) {
        // Reply auf eine Nachricht → User der Nachricht
        const replyFrom = msg.reply_to_message.from;
        if (replyFrom.is_bot) {
          const botReply = await tg.send(chatId, "❌ Bots können nicht gecheckt werden.");
          if (botReply?.message_id) void safelistService.trackBotMessage(chatId, botReply.message_id, "temp", 8000);
          await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
          return;
        }
        targetUserId   = replyFrom.id;
        targetUsername = replyFrom.username?.toLowerCase() || null;
      } else {
        // /check ohne Parameter → Selbst-Check
        targetUserId   = from.id;
        targetUsername = from.username?.toLowerCase() || null;
      }

      if (!targetUsername && !targetUserId) {
        const r = await tg.send(chatId, "❌ Kein User gefunden. Nutze <code>/check @username</code> oder antworte auf eine Nachricht.", { parse_mode: "HTML" });
        if (r?.message_id) void safelistService.trackBotMessage(chatId, r.message_id, "temp", 8000);
        return;
      }

      // Reputation NUR aus DB laden — KEINE KI-Halluzination
      let score = 0, pos = 0, neg = 0;
      try {
        let repQ = supabase_db.from("user_reputation")
          .select("score, pos_count, neg_count")
          .eq("channel_id", chatId);
        // Zuerst nach user_id, dann nach username suchen
        if (targetUserId) {
          repQ = repQ.eq("user_id", targetUserId);
        } else if (targetUsername) {
          repQ = repQ.ilike("username", targetUsername);
        }
        const { data: rep } = await repQ.maybeSingle();
        if (rep) { score = rep.score ?? 0; pos = rep.pos_count ?? 0; neg = rep.neg_count ?? 0; }
      } catch (_) {}

      // Safelist + Scamliste prüfen
      const scamEntry = await safelistService.checkScamlist(chatId, targetUsername, targetUserId || null).catch(() => null);
      let safeEntry = null;
      try {
        let safeQ = supabase_db.from("channel_safelist").select("note, created_at").eq("channel_id", chatId);
        if (targetUserId) safeQ = safeQ.eq("user_id", targetUserId);
        else safeQ = safeQ.ilike("username", targetUsername || "");
        const { data: sd } = await safeQ.maybeSingle();
        safeEntry = sd;
      } catch (_) {}

      // Nur ECHTE bestätigte Feedbacks aus DB
      let approvedFeedbacks = [];
      try {
        let fbQ = supabase_db.from("user_feedbacks")
          .select("feedback_type, feedback_text, created_at")
          .eq("channel_id", chatId)
          .eq("status", "approved")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(5);
        if (targetUserId) fbQ = fbQ.eq("target_user_id", targetUserId);
        else if (targetUsername) fbQ = fbQ.ilike("target_username", targetUsername);
        const { data: fbs } = await fbQ;
        approvedFeedbacks = fbs || [];
      } catch (_) {}

      const displayName = targetUsername ? `@${targetUsername}` : `User ${targetUserId}`;
      const SAFELIST_DISCLAIMER = safeEntry
        ? `\n\n⚠️ <i>Hinweis: Die Safelist-Listung stellt <b>keine Garantie</b> dar und übernimmt <b>keinerlei Haftung</b>. Vertraue deinem Bauchgefühl.</i>`
        : "";

      let replyText = "";

      if (scamEntry) {
        replyText  = `⛔ <b>ACHTUNG: ${displayName} steht auf der Scamliste!</b>\n\n`;
        replyText += `Score: ${score} Pkt (✅ ${pos} | ⚠️ ${neg})\n`;
        if (scamEntry.reason) replyText += `<i>Grund: ${scamEntry.reason.substring(0, 150)}</i>`;
      } else {
        replyText  = `📊 <b>${displayName}</b>\n\n`;
        if (safeEntry) replyText += `✅ <b>Auf der Channel-Safelist</b>${safeEntry.note ? ` (${safeEntry.note})` : ""}\n`;
        replyText += `⭐️ Score: <b>${score > 0 ? "+" : ""}${score}</b> Pkt (✅ ${pos} Positiv · ⚠️ ${neg} Negativ)\n`;

        if (pos === 0 && neg === 0) {
          replyText += `\n<i>Noch keine bestätigten Feedbacks vorhanden.</i>`;
        } else {
          // KI-Zusammenfassung NUR wenn echte Feedbacks vorhanden
          if (ch?.ai_enabled && approvedFeedbacks.length > 0) {
            const aiSummary = await safelistService.generateAiSummary(chatId, targetUsername, targetUserId || null).catch(() => null);
            if (aiSummary) {
              replyText += `\n🤖 <b>KI-Zusammenfassung:</b>\n${aiSummary}`;
            }
          }
          // Letzte echte Feedbacks anzeigen
          if (approvedFeedbacks.length > 0) {
            replyText += `\n\n💬 <b>Letzte Feedbacks:</b>`;
            approvedFeedbacks.slice(0, 3).forEach(f => {
              const emoji = f.feedback_type === "positive" ? "✅" : "⚠️";
              const txt   = (f.feedback_text || "").substring(0, 80);
              if (txt) replyText += `\n${emoji} <i>${txt}</i>`;
            });
          }
        }
        replyText += SAFELIST_DISCLAIMER;
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

    // ── /top: Gruppenspiele Top-Liste ─────────────────────────────────────────
    // Nur in Gruppen, nur wenn Feature aktiviert. Stille Ignorierung falls disabled.
    if (chat.type !== "private" && /^\/top(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (ch?.group_game_enabled) {
        const topText = await groupGameService.buildTopText(tg, supabase_db, chatId, ch, 10);
        await tg.send(chatId, topText);
      }
      return;
    }

    // ── /id: Chat-ID anzeigen (Helfer fuer Diss-Battle Arena-Setup) ──────────
    if (/^\/id(?:@\w+)?(?:\s|$)/i.test(text) && chat.type !== "private") {
      const txt = `🆔 <b>Chat-Info</b>\n\n` +
                  `<b>Chat-ID:</b> <code>${chatId}</code>\n` +
                  `<b>Typ:</b> ${chat.type}\n` +
                  (chat.title ? `<b>Titel:</b> ${chat.title}\n` : "");
      const sent = await tg.send(chatId, txt, { reply_to_message_id: msg.message_id });
      if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 60000);
      return;
    }


    if (chat.type !== "private" && /^\/topdiss(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (!ch?.diss_battle_enabled) return;
      try {
        const dissBattle = require("./dissBattleService");
        const top = await dissBattle.getTopDissers(supabase_db, chatId, 10);
        let topText;
        if (!top.length) {
          topText = "🏆 <b>Diss Battle Ranking</b>\n\n<i>Noch keine Sieger.</i> Eröffne ein Battle mit /dissbattle!";
        } else {
          topText = "🏆 <b>Diss Battle — Top 10</b>\n\n" + top.map((r, i) => {
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i+1}.`;
            return `${medal} @${r.username || r.user_id} — <b>${r.score}</b> Punkte (${r.wins}W / ${r.losses}L)`;
          }).join("\n");
        }
        const sent = await tg.send(chatId, topText, { reply_to_message_id: msg.message_id });
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 5*60*1000);
      } catch (e) {
        logger.warn(`[/topdiss] ${e.message}`);
      }
      return;
    }

    // ── /dissbattle: Battle eröffnen ──────────────────────────────────────────
    //   /dissbattle              → offene Runde, jeder kann joinen
    //   /dissbattle @user        → gezielter Gegner
    //   Reply auf User-Msg + /dissbattle → gezielter Gegner
    if (chat.type !== "private" && /^\/dissbattle(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (!ch?.diss_battle_enabled) {
        const sent = await tg.send(chatId, "⚔️ Diss Battle ist in diesem Channel nicht aktiviert.");
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 15000);
        return;
      }
      if (!ch.diss_battle_arena_chat_id) {
        const sent = await tg.send(chatId,
          "⚠️ Es ist noch keine Battle-Arena verlinkt.\nDer Channel-Admin muss in den Settings unter \"🎮 Gruppenspiele → Diss Battle\" eine separate Arena-Gruppe verknüpfen.");
        if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 30000);
        return;
      }

      // Ziel-User ermitteln: Reply ODER @username-Argument
      let target = null;
      const arg = text.replace(/^\/dissbattle(?:@\w+)?\s*/i, "").trim();
      if (msg.reply_to_message?.from && msg.reply_to_message.from.id !== from.id) {
        target = {
          id: msg.reply_to_message.from.id,
          username: msg.reply_to_message.from.username,
          first_name: msg.reply_to_message.from.first_name
        };
      } else if (arg) {
        // Per @username oder numerischer ID auflösen
        const resolvedTarget = await _resolveTargetUser(supabase_db, chatId, msg, "/ban " + arg);
        if (resolvedTarget?.id && resolvedTarget.id !== from.id) {
          target = resolvedTarget;
        }
      }

      try {
        const dissBattle = require("./dissBattleService");
        const result = await dissBattle.createBattle(tg, supabase_db, {
          channelId:        String(chatId),
          channelTitle:     chat.title || "",
          arenaChatId:      String(ch.diss_battle_arena_chat_id),
          durationMinutes:  ch.diss_battle_duration_min || 5,
          challenger:       { id: from.id, username: from.username, first_name: from.first_name },
          target:           target,
          originalMessageId: msg.message_id
        });
        if (!result.ok) {
          const sent = await tg.send(chatId, `⚔️ ${result.error}`);
          if (sent?.message_id) void safelistService.trackBotMessage(chatId, sent.message_id, "temp", 20000);
          return;
        }
        // (1.6.76) Erfolgsfall: createBattle hat Channel-Nachricht selbst gepostet
        // Das Original-Command vom User loeschen damit der Chat aufgeraeumt aussieht
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e) {
        logger.warn(`[/dissbattle] ${e.message}`);
        await tg.send(chatId, "❌ Battle konnte nicht gestartet werden: " + e.message.substring(0, 100));
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
      const banTarget = await _resolveTargetUser(supabase_db, chatId, msg, text);
      if (!banTarget?.id) {
        const helpMsg = await tg.send(chatId,
          "❌ Kein Ziel erkannt. Nutze:\n" +
          "• <code>/ban</code> als Antwort auf die Nachricht\n" +
          "• <code>/ban @username</code>\n" +
          "• <code>/ban 12345678</code> (User-ID)");
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      const banReason = text.replace(/^\/ban(?:@\w+)?(?:\s+@?\S+)?\s*/i, "").trim() || "Kein Grund angegeben";
      try {
        await tg.call("banChatMember", { chat_id: chatId, user_id: banTarget.id, until_date: 0, revoke_messages: false });
        const target = banTarget.username ? "@" + banTarget.username : (banTarget.first_name || String(banTarget.id));
        const banMsg = await tg.send(chatId, `🚫 ${target} wurde gebannt.\nGrund: ${banReason.substring(0,100)}`);
        if (banMsg?.message_id) void safelistService.trackBotMessage(chatId, banMsg.message_id, "temp", 5 * 60 * 1000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});

        // ─── 1.6.73: Ban-Awareness ───────────────────────────────────────────
        // a) Activity-Tracker Punkte stornieren (Ranking nicht durch gebannten User verfälschen)
        try {
          await groupGameService.deletePlayer(supabase_db, chatId, banTarget.id);
          logger.info(`[Ban] Activity-Punkte für ${banTarget.id} in Channel ${chatId} entfernt`);
        } catch (e) {
          logger.warn(`[Ban] deletePlayer Fehler: ${e.message}`);
        }
        // b) Status für Channel-AI markieren (damit AI weiß: User ist gebannt)
        try {
          await supabase_db.from("channel_user_status").upsert([{
            channel_id:  String(chatId),
            user_id:     banTarget.id,
            status:      "banned",
            reason:      banReason.substring(0, 200),
            by_admin_id: from.id,
            created_at:  new Date().toISOString(),
            expires_at:  null
          }], { onConflict: "channel_id,user_id" });
        } catch (e) {
          logger.warn(`[Ban] channel_user_status: ${e.message}`);
        }
        // b-2) In channel_banned_users eintragen für Dashboard und Blacklist-Abgleich
        try {
          await supabase_db.from("channel_banned_users").upsert([{
            channel_id: String(chatId),
            user_id:    banTarget.id,
            username:   banTarget.username || null,
            reason:     banReason.substring(0, 200),
            added_by:   String(from.id)
          }], { onConflict: "channel_id,user_id" });
        } catch (e) {
          logger.warn(`[Ban] channel_banned_users: ${e.message}`);
        }
        // c) Identity-Log: Ban als Source markieren (Audit)
        if (banTarget.username || banTarget.first_name) {
          void userIdentityService.logIdentity({
            channelId: String(chatId),
            userId:    banTarget.id,
            username:  banTarget.username,
            firstName: banTarget.first_name,
            source:    "ban"
          });
        }
      } catch (e2) {
        logger.warn("[Ban]", e2.message);
        const apiErr = e2.response?.data?.description || e2.message || "unbekannter Fehler";
        const errMsg = await tg.send(chatId, `❌ Bannen fehlgeschlagen: ${apiErr.substring(0, 80)}`);
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
      }
      return;
    }

    if (/^\/unban(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const unbanTarget = await _resolveTargetUser(supabase_db, chatId, msg, text);
      if (!unbanTarget?.id) {
        const helpMsg = await tg.send(chatId,
          "❌ Kein Ziel erkannt. Nutze:\n" +
          "• <code>/unban @username</code>\n" +
          "• <code>/unban 12345678</code> (User-ID)");
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      try {
        await tg.call("unbanChatMember", { chat_id: chatId, user_id: unbanTarget.id, only_if_banned: false });
        const target = unbanTarget.username ? "@" + unbanTarget.username : String(unbanTarget.id);
        const unbanMsg = await tg.send(chatId, `✅ ${target} wurde entbannt.`);
        if (unbanMsg?.message_id) void safelistService.trackBotMessage(chatId, unbanMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});

        // ─── 1.6.73: Ban-Awareness rückgängig ────────────────────────────────
        // channel_user_status entfernen → AI sieht User wieder als "active"
        try {
          await supabase_db.from("channel_user_status")
            .delete().eq("channel_id", String(chatId)).eq("user_id", unbanTarget.id);
        } catch (_) {}
        // Also remove from channel_banned_users
        try {
          await supabase_db.from("channel_banned_users")
            .delete().eq("channel_id", String(chatId)).eq("user_id", unbanTarget.id);
        } catch (_) {}
      } catch (e2) {
        const apiErr = e2.response?.data?.description || e2.message || "unbekannter Fehler";
        const errMsg = await tg.send(chatId, `❌ Entbannen fehlgeschlagen: ${apiErr.substring(0, 80)}`);
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 10000);
      }
      return;
    }

    if (/^\/mute(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const muteTarget = await _resolveTargetUser(supabase_db, chatId, msg, text);
      if (!muteTarget?.id) {
        const helpMsg = await tg.send(chatId,
          "❌ Kein Ziel erkannt. Nutze:\n" +
          "• <code>/mute</code> als Antwort auf die Nachricht\n" +
          "• <code>/mute @username [Dauer]</code>\n" +
          "• <code>/mute 12345678 [Dauer]</code>\n\n" +
          "Dauer-Beispiele: <code>30m</code>, <code>2h</code>, <code>1d</code>, <code>permanent</code>");
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      // Dauer + Grund aus Resttext extrahieren (nach Befehl + optionalem Ziel)
      const rest = text.replace(/^\/mute(?:@\w+)?\s*(?:@?\w+\s*|\d{4,}\s*)?/i, "").trim();
      const durMatch = rest.match(/^(\d+[smhd]|permanent)\b/i);
      const durationStr = durMatch ? durMatch[1].toLowerCase() : "24h";
      const muteReason  = durMatch ? rest.slice(durMatch[0].length).trim() : rest;

      const targetName = muteTarget.username
        ? "@" + muteTarget.username
        : (muteTarget.first_name || `<code>${muteTarget.id}</code>`);
      const durationSeconds = blacklistService.parseDuration ? blacklistService.parseDuration(durationStr) : 86400;
      const untilDate  = durationSeconds === -1 ? 0 : Math.floor(Date.now() / 1000) + durationSeconds;
      const displayDur = durationSeconds === -1 ? "permanent" : durationStr;
      try {
        await tg.call("restrictChatMember", {
          chat_id: chatId, user_id: muteTarget.id,
          permissions: { can_send_messages: false, can_send_other_messages: false, can_add_web_page_previews: false },
          until_date: untilDate
        });
        const muteMsg = await tg.send(chatId,
          `🔇 ${targetName} wurde ${displayDur} stummgeschaltet.${muteReason ? "\nGrund: " + muteReason.substring(0,100) : ""}`);
        if (muteMsg?.message_id) void safelistService.trackBotMessage(chatId, muteMsg.message_id, "temp", 5 * 60 * 1000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e2) {
        logger.warn("[Mute]", e2.message);
        const apiErr = e2.response?.data?.description || e2.message || "unbekannter Fehler";
        const errMsg = await tg.send(chatId, `❌ Stummschalten fehlgeschlagen: ${apiErr.substring(0, 80)}`);
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 15000);
      }
      return;
    }

    if (/^\/unmute(?:@\w+)?(?:\s|$)/i.test(text) && ch?.is_approved) {
      if (!await isGroupAdmin(tg, chatId, from.id)) return;
      const umTarget = await _resolveTargetUser(supabase_db, chatId, msg, text);
      if (!umTarget?.id) {
        const helpMsg = await tg.send(chatId,
          "❌ Kein Ziel erkannt. Nutze:\n" +
          "• <code>/unmute</code> als Antwort auf die Nachricht\n" +
          "• <code>/unmute @username</code>\n" +
          "• <code>/unmute 12345678</code>");
        if (helpMsg?.message_id) void safelistService.trackBotMessage(chatId, helpMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
        return;
      }
      try {
        await tg.call("restrictChatMember", {
          chat_id: chatId, user_id: umTarget.id,
          permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_change_info: false, can_invite_users: true, can_pin_messages: false }
        });
        const target = umTarget.username ? "@" + umTarget.username : (umTarget.first_name || String(umTarget.id));
        const okMsg = await tg.send(chatId, `🔊 ${target} wurde wieder freigeschaltet.`);
        if (okMsg?.message_id) void safelistService.trackBotMessage(chatId, okMsg.message_id, "temp", 15000);
        await tg.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      } catch (e2) {
        const apiErr = e2.response?.data?.description || e2.message || "unbekannter Fehler";
        const errMsg = await tg.send(chatId, `❌ Freischalten fehlgeschlagen: ${apiErr.substring(0, 80)}`);
        if (errMsg?.message_id) void safelistService.trackBotMessage(chatId, errMsg.message_id, "temp", 10000);
      }
      return;
    }

    const blockedThreads = Array.isArray(ch?.blocked_thread_ids) ? ch.blocked_thread_ids : [];
    const currentThread = msg.message_thread_id || 0;
    const threadBlocked = currentThread && blockedThreads.includes(currentThread);

    const isAiEmptyCmd = /^\/ai(?:@\w+)?$/i.test(text);
    if (isAiEmptyCmd && ch?.is_approved && ch?.ai_enabled && !threadBlocked) {
      // parse_mode wird von tg.send() intern gesetzt via markdownToHtml
      const sentAiPrompt = await tg.send(chatId,
        "🤖 **KI-Assistent**\n\nBitte antworte direkt auf **diese Nachricht** mit deiner Frage.",
        { reply_to_message_id: msg.message_id, message_thread_id: msg.message_thread_id || undefined }
      );
      // Prompt-Nachricht als Bot-Message speichern damit Reply erkannt wird
      if (sentAiPrompt?.message_id) {
        void safelistService.trackBotMessage(chatId, sentAiPrompt.message_id, "ai_prompt", 5 * 60 * 1000);
      }
      return;
    }

    // isReplyToBot: User antwortet auf eine AI-Nachricht ODER einen AI-Prompt
    const isReplyToBot = msg.reply_to_message?.message_id
      ? await safelistService.isBotMessage(chatId, msg.reply_to_message.message_id)
      : false;

    const aiMatch    = text.match(/^\/ai(?:@\w+)?\s+(.*)/i);
    const aiQuestion = aiMatch
      ? aiMatch[1].trim()
      : (isReplyToBot && !text.startsWith("/") ? text : null);

    if (aiQuestion && ch?.is_approved && ch?.ai_enabled && !threadBlocked) {
      // Gesprächsverlauf laden (max. 8 Paare = 16 Nachrichten — für besseren Kontext)
      const history = from?.id
        ? await safelistService.getConversationHistory(chatId, from.id, 8)
        : [];

      // User-Nachricht VOR dem API-Call speichern
      if (from?.id) void safelistService.saveUserMessage(chatId, from.id, aiQuestion, msg.message_id);

      // Wenn Reply auf Bot-Nachricht: deren Text als letzten AI-Turn ins History injizieren
      let enrichedHistory = history;
      if (isReplyToBot && msg.reply_to_message?.text) {
        const prevText = msg.reply_to_message.text;
        if (!history.some(h => h.content === prevText)) {
          enrichedHistory = [...history, { role: "assistant", content: prevText.substring(0, 600) }];
        }
      }

      const smalltalkAgent = require("../ai/smalltalkAgent");
      const result = await smalltalkAgent.handle({
        chatId,
        text:          aiQuestion,
        settings,
        channelRecord: ch,
        history:       enrichedHistory,
        userId:        from?.id            || null,
        username:      from?.username || from?.first_name || null,
        metadata:      { message_thread_id: msg.message_thread_id, _tg: tg, messageDate: msg.date }
      });

      if (result?.reply) {
        const replyExtra = {};
        if (msg.message_id) replyExtra.reply_to_message_id = msg.message_id;
        // threadId aus result (für alle Reply-Typen konsistent)
        const effectiveThread = result.threadId || msg.message_thread_id;
        if (effectiveThread) replyExtra.message_thread_id = effectiveThread;
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

    // ── Gruppenspiele: Scoring am Ende (non-blocking, fail silently) ─────────
    if (chat.type !== "private" && ch?.group_game_enabled) {
      void groupGameService.scoreMessage(tg, supabase_db, msg, ch).catch(() => {});
    }
  }
};

module.exports = commandHandler;