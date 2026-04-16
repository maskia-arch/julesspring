/**
 * smalltalkBotRoutes.js  v1.4.0-2
 * Separater Webhook für den Smalltalk-Bot (eigener Bot-Token via Bot-Father)
 * Route: POST /api/webhooks/smalltalk
 */

const express       = require("express");
const router        = express.Router();
const smalltalkAgent = require("../services/ai/smalltalkAgent");
const supabase      = require("../config/supabase");
const logger        = require("../utils/logger");

let _telegramService = null;
function getTgService(botToken) {
  if (!_telegramService || _telegramService._token !== botToken) {
    const TelegramService = require("../services/telegramService");
    _telegramService = new TelegramService(botToken);
    _telegramService._token = botToken;
  }
  return _telegramService;
}

router.post("/smalltalk", (req, res) => {
  res.sendStatus(200); // Immer sofort antworten

  setImmediate(async () => {
    try {
      const update = req.body;
      if (!update) return;

      // my_chat_member: Bot wurde als Admin hinzugefügt
      if (update.my_chat_member) {
        const mcm = update.my_chat_member;
        if (["administrator","creator"].includes(mcm.new_chat_member?.status)) {
          const chat = mcm.chat;
          const { data: s } = await supabase.from("settings").select("smalltalk_require_approval").single().catch(() => ({ data: null }));
          const needsApproval = s?.smalltalk_require_approval !== false;
          await supabase.from("bot_channels").upsert([{
            id:          chat.id,
            title:       chat.title || String(chat.id),
            username:    chat.username || null,
            type:        chat.type,
            bot_type:    "smalltalk",
            is_active:   !needsApproval,
            is_approved: !needsApproval,
            updated_at:  new Date()
          }], { onConflict: "id" });
          logger.info(`[SmallTalk-Bot] Channel registriert: ${chat.title} – wartet auf Freischaltung: ${needsApproval}`);
        }
        return;
      }

      const msg  = update.message || update.channel_post;
      if (!msg) return;

      const chat = msg.chat || {};
      const from = msg.from || {};
      const text = msg.text?.trim() || "";
      if (!text) return;

      // Settings + Bot-Token laden
      const { data: settings } = await supabase.from("settings").select("*").single().catch(() => ({ data: null }));
      const botToken = settings?.smalltalk_bot_token;
      if (!botToken) return; // Nicht konfiguriert

      const tg = getTgService(botToken);

      // Trigger-Prüfung für Channels/Gruppen
      if (["channel","supergroup","group"].includes(chat.type)) {
        const { data: channelSettings } = await supabase.from("bot_channels")
          .select("*").eq("id", String(chat.id)).maybeSingle().catch(() => ({ data: null }));
        const cmd = channelSettings?.ai_command || "/ai";
        const aiMatch = text.match(new RegExp("^" + cmd.replace("/", "\\/") + "[@\\w]*\\s*(.*)", "i"));
        if (!aiMatch) return; // Keine relevante Nachricht
        const question = aiMatch[1]?.trim() || text;
        if (question.length < 2) return;

        const result = await smalltalkAgent.handle({ chatId: String(chat.id), text: question, settings });
        if (result.reply) await tg.sendMessage(String(chat.id), result.reply);
        return;
      }

      // Privat-Chat mit dem Smalltalk-Bot
      const chatId = String(from.id || chat.id);
      const result = await smalltalkAgent.handle({ chatId, text, settings });
      if (result.reply) await tg.sendMessage(chatId, result.reply);

    } catch (e) {
      logger.error("[SmallTalk-Bot]", e.message);
    }
  });
});

module.exports = router;
