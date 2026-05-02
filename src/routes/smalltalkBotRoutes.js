/**
 * smalltalkBotRoutes.js — ADMINHELPER Bot
 * Token: settings.smalltalk_bot_token (DB)
 * Webhook: /api/webhooks/smalltalk
 *
 * v1.5.39: Blacklist-Check wird vor dem regulären Command-Processing
 * ausgeführt. Wenn ein Wort getroffen wird und "delete" als Konsequenz
 * konfiguriert ist, wird die Nachricht weggeräumt und das weitere
 * Processing übersprungen.
 */
const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const logger = require("../utils/logger");
const { tgApi } = require("../services/adminHelper/tgAdminHelper");

const membershipHandler = require("../services/adminHelper/membershipHandler");
const callbackHandler = require("../services/adminHelper/callbackHandler");
const commandHandler = require("../services/adminHelper/commandHandler");
const blacklistService = require("../services/adminHelper/blacklistService");

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
    const { data } = await supabase.from("settings").select("*").maybeSingle();
    return data || null;
  } catch {
    return null;
  }
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
      const ADMINHELPER_TOKEN = settings?.smalltalk_bot_token;
      if (!ADMINHELPER_TOKEN) return;

      const tg = tgApi(ADMINHELPER_TOKEN);

      if (update.my_chat_member) {
        await membershipHandler.handleBotAdded(tg, supabase, update.my_chat_member, ADMINHELPER_TOKEN);
        return;
      }

      if (update.callback_query) {
        await callbackHandler.handle(tg, supabase, update.callback_query, ADMINHELPER_TOKEN, settings);
        return;
      }

      const msg = update.message || update.channel_post;
      if (!msg) return;

      if (msg.new_chat_members || msg.left_chat_member) {
        await membershipHandler.handleMemberChanges(tg, supabase, msg, ADMINHELPER_TOKEN);
        return;
      }

      // ─── Blacklist-Durchsetzung (nur Gruppen/Supergruppen) ─────────────
      // Skip-Bedingungen:
      //   • Privatchat → Blacklist greift nur in Channels/Gruppen
      //   • Channel-Post mit sender_chat → keine sinnvolle User-ID
      //   • Bot-Nachricht
      //   • Telegram-Service-User (777000)
      // Admin-Skip ist intern in checkBlacklist (nur bei Wort-Treffer geprüft).
      const chatType = msg.chat?.type;
      const text = (msg.text || msg.caption || "").trim();
      const from = msg.from;
      const isGroup = chatType === "group" || chatType === "supergroup";

      if (
        isGroup &&
        text &&
        from?.id &&
        !from.is_bot &&
        from.id !== 777000 &&
        !msg.sender_chat
      ) {
        try {
          const result = await blacklistService.checkBlacklist(
            supabase,
            String(msg.chat.id),
            text,
            from,
            String(msg.chat.id),
            msg.message_id,
            tg,
            ADMINHELPER_TOKEN
          );
          // Wenn die Nachricht gelöscht wurde → kein weiteres Processing.
          // (Kontextspeicher, Smalltalk-AI etc. dürfen das nicht mehr sehen.)
          if (result?.deleted) return;
        } catch (e) {
          logger.warn(`[Blacklist] check failed: ${e.message}`);
        }
      }

      await commandHandler.handleMessage(tg, supabase, msg, ADMINHELPER_TOKEN, settings);

    } catch (e) {
      logger.error('[Webhook/AdminHelper] ' + e.message);
    }
  });
});

module.exports = router;
