const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const logger = require("../utils/logger");
const { tgApi } = require("../services/adminHelper/tgAdminHelper");

const membershipHandler = require("../services/adminHelper/membershipHandler");
const callbackHandler = require("../services/adminHelper/callbackHandler");
const commandHandler = require("../services/adminHelper/commandHandler");

async function getSettings() {
  try {
    const { data } = await supabase.from("settings").select("*").maybeSingle();
    return data || null;
  } catch { return null; }
}

router.post("/smalltalk", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const update = req.body;
      if (!update) return;

      const settings = await getSettings();
      const token = settings?.smalltalk_bot_token;
      if (!token) return;

      const tg = tgApi(token);

      if (update.my_chat_member) {
        await membershipHandler.handleBotAdded(tg, supabase, update.my_chat_member, token);
        return;
      }

      if (update.callback_query) {
        await callbackHandler.handle(tg, supabase, update.callback_query, token, settings);
        return;
      }

      const msg = update.message || update.channel_post;
      if (!msg) return;

      if (msg.new_chat_members || msg.left_chat_member) {
        await membershipHandler.handleMemberChanges(tg, supabase, msg, token);
        return;
      }

      await commandHandler.handleMessage(tg, supabase, msg, token, settings);

    } catch (e) {
      logger.error(e.message);
    }
  });
});

module.exports = router;
