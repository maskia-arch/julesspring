/**
 * smalltalkBotRoutes.js — ADMINHELPER Bot
 * Token: ENV SMALLTALK_BOT_TOKEN (Fallback: settings.smalltalk_bot_token)
 * Webhook: /api/webhooks/smalltalk
 */
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const logger = require("../utils/logger");
const { tgApi } = require("../services/adminHelper/tgAdminHelper");

const membershipHandler = require("../services/adminHelper/membershipHandler");
const callbackHandler = require("../services/adminHelper/callbackHandler");
const commandHandler = require("../services/adminHelper/commandHandler");
const quietHoursService = require("../services/adminHelper/quietHoursService");
const botToken = require("../config/botToken");

const _processedUpdates = new Map();
const _UPDATE_CACHE_MS = 5 * 60 * 1000;

function _rememberUpdate(id) {
  _processedUpdates.set(id, Date.now());
  if (_processedUpdates.size > 500) {
    const cutoff = Date.now() - _UPDATE_CACHE_MS;
    for (const [k, t] of _processedUpdates)
      if (t < cutoff) _processedUpdates.delete(k);
  }
}

async function getSettings() {
  try {
    // Bevorzugt die kanonische Zeile id=1; Fallback auf erste Zeile.
    let { data } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
    if (!data) {
      const r = await supabase.from("settings").select("*").limit(1);
      data = r.data?.[0] || null;
    }
    return data || null;
  } catch {
    try {
      const r = await supabase.from("settings").select("*").limit(1);
      return r.data?.[0] || null;
    } catch { return null; }
  }
}

/** Stellt sicher dass smalltalk_bot_username in der DB steht */
async function _ensureBotUsername(token, settings) {
  if (settings?.smalltalk_bot_username) return; // schon gesetzt
  try {
    const axios = require("axios");
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 5000 });
    const username = r.data?.result?.username;
    if (username) {
      await supabase.from("settings")
        .update({ smalltalk_bot_username: username }).eq("id", 1);
    }
  } catch (_) {}
}

router.post("/smalltalk", (req, res) => {
  res.sendStatus(200);
  
  setImmediate(async () => {
    try {
      const update = req.body;
      if (!update) return;
      
      const update_id = update.update_id;
      if (update_id && _processedUpdates.has(update_id)) return;
      if (update_id) _rememberUpdate(update_id);
      
      const settings = await getSettings();
      const ADMINHELPER_TOKEN = await botToken.getToken();
      if (!ADMINHELPER_TOKEN) return;

      // Sicherstellen dass bot_username in DB steht (einmalig, fire-and-forget)
      void _ensureBotUsername(ADMINHELPER_TOKEN, settings);
      
      const tg = tgApi(ADMINHELPER_TOKEN);

      // ── (1.6.75) Beim ersten Webhook-Hit nach Bot-Restart: aktive Diss
      //    Battles wiederherstellen (Timer neu setzen oder verspätetes Ende).
      if (!global._dissBattleRecoveryDone) {
        global._dissBattleRecoveryDone = true;
        try {
          const dissBattle = require("../services/adminHelper/dissBattleService");
          void dissBattle._recoverActiveBattles(tg, supabase).catch(e => {
            require("../utils/logger").warn(`[DissBattle/recover] ${e.message}`);
          });
        } catch (_) {}
      }
      
      if (update.my_chat_member) {
        await membershipHandler.handleBotAdded(tg, supabase, update.my_chat_member, ADMINHELPER_TOKEN);
        return;
      }

      // ── (1.6.74) message_reaction: User reagiert auf eine Nachricht ─────────
      // Telegram sendet diese Updates nur wenn der Bot Admin in der Gruppe ist
      // UND wenn in der Bot-API "allowed_updates" message_reaction enthalten ist.
      // (Letzteres wird beim Webhook-Setup in adminController gesetzt.)
      if (update.message_reaction) {
        const reactionHandler = require("../services/adminHelper/reactionTrackingService");
        await reactionHandler.handleReactionUpdate(supabase, update.message_reaction, ADMINHELPER_TOKEN).catch(e => {
          require("../utils/logger").warn(`[Reaction] ${e.message}`);
        });
        return;
      }

      if (update.callback_query) {
        await callbackHandler.handle(tg, supabase, update.callback_query, ADMINHELPER_TOKEN, settings);
        return;
      }
      
      const msg = update.message || update.channel_post;
      if (!msg) return;

      // ── Stars-Nachtruhe Trigger: Admin hat Sterne-Preis geändert ───────────
      // Telegram sendet diese Service-Meldung wenn ein Admin in den
      // Gruppeneinstellungen "Sterne pro Nachricht" aktiviert/ändert.
      // Während aktiver Stars-Nachtruhe nutzen wir das als Trigger zum
      // Entsperren des Chats und ersetzen Telegrams System-Meldung durch eine
      // eigene Bestätigung.
      // MUSS VOR der Auto-Cleanup laufen — sonst würde die Service-Nachricht
      // bereits gelöscht bevor sie als Trigger gewertet werden kann.
      if (msg.paid_message_price_changed) {
        const handled = await quietHoursService.handleStarsPriceChanged(tg, supabase, msg);
        if (handled) return;
        // Wenn nicht als Trigger verwendet → durch normale Auto-Cleanup laufen lassen
      }

      // ── Bot-eigene Service-Messages aus dem Chat löschen ───────────────────
      // Wenn der Bot eine Aktion ausführt (Pin, Title-Change, Foto, etc.) erzeugt
      // Telegram automatisch eine Statusmeldung im Channel. Diese wird hier entfernt.
      // Bot-ID ist der numerische Teil VOR dem ":" im Token (TELEGRAM-STANDARD).
      const _botId = parseInt(String(ADMINHELPER_TOKEN).split(":")[0], 10);
      const isFromBot = msg.from?.id === _botId || msg.from?.is_bot === true;
      const isServiceMsg = !!(
        msg.pinned_message ||
        msg.new_chat_title ||
        msg.new_chat_photo ||
        msg.delete_chat_photo ||
        msg.group_chat_created ||
        msg.supergroup_chat_created ||
        msg.channel_chat_created ||
        msg.message_auto_delete_timer_changed ||
        msg.forum_topic_created ||
        msg.forum_topic_edited ||
        msg.forum_topic_closed ||
        msg.forum_topic_reopened ||
        msg.general_forum_topic_hidden ||
        msg.general_forum_topic_unhidden ||
        msg.video_chat_scheduled ||
        msg.video_chat_started ||
        msg.video_chat_ended ||
        msg.video_chat_participants_invited ||
        msg.web_app_data ||
        msg.paid_message_price_changed   // Stars-Preis-Änderung außerhalb Nachtruhe → einfach löschen
      );

      if (isFromBot && isServiceMsg) {
        // Service-Message vom Bot → löschen (kein weiteres Handling)
        await tg.call("deleteMessage", {
          chat_id: msg.chat.id,
          message_id: msg.message_id
        }).catch(e => {
          // 400 = bereits gelöscht oder zu alt (>48h); 403 = keine Rechte
          // → in beiden Fällen einfach ignorieren
          logger.debug?.(`[AutoCleanup] deleteMessage ${msg.chat.id}/${msg.message_id}: ${e.message}`);
        });
        return;
      }

      // ── (1.6.75) chat_member: User joint/verlässt Arena ─────────────────────
      // Wird nur empfangen wenn allowed_updates 'chat_member' enthält.
      // Wir nutzen es um beim Beitritt zur Diss-Battle-Arena zu reagieren.
      if (update.chat_member) {
        try {
          const cm = update.chat_member;
          // Nur "joined"-Events: alter Status war nicht-Mitglied, neuer ist Mitglied
          const oldStatus = cm.old_chat_member?.status;
          const newStatus = cm.new_chat_member?.status;
          const justJoined = (newStatus === "member" || newStatus === "restricted")
                          && oldStatus !== "member" && oldStatus !== "restricted"
                          && oldStatus !== "administrator" && oldStatus !== "creator";
          if (justJoined) {
            const dissBattle = require("../services/adminHelper/dissBattleService");
            await dissBattle.handleArenaJoin(tg, supabase, cm).catch(e => {
              require("../utils/logger").warn(`[DissBattle/join] ${e.message}`);
            });
          }
        } catch (_) {}
        return;
      }

      if (msg.new_chat_members || msg.left_chat_member) {
        if (msg.new_chat_members) {
          try {
            const dissBattle = require("../services/adminHelper/dissBattleService");
            for (const u of msg.new_chat_members) {
              const simulatedChatMember = {
                chat: msg.chat,
                old_chat_member: { status: "left" },
                new_chat_member: { status: "member", user: u }
              };
              await dissBattle.handleArenaJoin(tg, supabase, simulatedChatMember).catch(() => {});
            }
          } catch (_) {}
        }
        await membershipHandler.handleMemberChanges(tg, supabase, msg, ADMINHELPER_TOKEN);
        return;
      }

      // ── (1.6.75) Arena-Nachrichten tracken (falls die Nachricht in einer
      //    Diss-Battle-Arena landet — also einer Gruppe die als
      //    diss_battle_arena_chat_id konfiguriert ist).
      // Fire-and-forget; verhindert nicht das normale Command-Routing.
      try {
        const dissBattle = require("../services/adminHelper/dissBattleService");
        void dissBattle.trackArenaMessage(supabase, msg).catch(() => {});
      } catch (_) {}

      await commandHandler.handleMessage(tg, supabase, msg, ADMINHELPER_TOKEN, settings);
      
    } catch (e) {
      logger.error('[Webhook/AdminHelper] ' + e.message);
    }
  });
});

module.exports = router;