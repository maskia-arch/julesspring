/**
 * smalltalkBotRoutes.js — ADMINHELPER Bot
 * Token: settings.smalltalk_bot_token (DB)
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
      
      await commandHandler.handleMessage(tg, supabase, msg, ADMINHELPER_TOKEN, settings);
      
    } catch (e) {
      logger.error('[Webhook/AdminHelper] ' + e.message);
    }
  });
});

module.exports = router;