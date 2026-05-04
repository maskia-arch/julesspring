/**
 * smalltalkBotRoutes.js — ADMINHELPER Bot
 * Token: settings.smalltalk_bot_token (DB)
 * Webhook: /api/webhooks/smalltalk
 *
 * v1.5.42:
 *   • Aktivitäts-Tracking (last_seen, message_count) bei JEDER eingehenden
 *     Gruppen-Nachricht — nicht mehr nur beim Beitritt. Damit zeigt UserInfo
 *     wirklich aktuelle Daten.
 *   • Sammeln aller Group-Messages in `channel_message_log` für die
 *     Tageszusammenfassung — vorher hatte sie nur AI-Konversationen gesehen.
 *   • Erkennt aus @SangMata_Bot weitergeleitete Nachrichten und legt sie
 *     in `sangmata_imports` ab.
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

// SangMata Bot identifiers (Username case-insensitive Vergleich).
// Akzeptiert verschiedene Schreibweisen (manche Forwards verwenden Variationen).
const SANGMATA_USERNAMES = new Set(["sangmata_bot", "sangmata_beta_bot", "sangmatasebot"]);

/**
 * Versucht, aus einem von SangMata weitergeleiteten Bericht die User-ID des
 * Targets zu extrahieren. SangMata-Berichte enthalten typischerweise eine
 * Zeile mit "ID: <code>123456789</code>" oder einen tg://user?id=… Link.
 */
function _extractSangMataUserId(text) {
  if (!text) return null;
  let m = text.match(/(?:^|[^a-z0-9])(?:id|🆔)\s*[:=]?\s*(\d{6,15})/i);
  if (m) return parseInt(m[1]);
  m = text.match(/tg:\/\/user\?id=(\d{6,15})/i);
  if (m) return parseInt(m[1]);
  m = text.match(/[?&]id=(\d{6,15})\b/);
  if (m) return parseInt(m[1]);
  m = text.match(/\b(\d{8,12})\b/);
  if (m) return parseInt(m[1]);
  return null;
}

/**
 * Erkennt, ob die eingehende Nachricht ein Forward von @SangMata_Bot ist.
 * Telegram setzt `forward_from` für ältere User-Forwards und
 * `forward_origin` (neueres Format) für alle.
 */
function _isSangMataForward(msg) {
  if (msg.forward_from?.is_bot) {
    const u = (msg.forward_from.username || "").toLowerCase();
    if (SANGMATA_USERNAMES.has(u)) return true;
  }
  if (msg.forward_origin?.type === "user" && msg.forward_origin.sender_user?.is_bot) {
    const u = (msg.forward_origin.sender_user.username || "").toLowerCase();
    if (SANGMATA_USERNAMES.has(u)) return true;
  }
  return false;
}

/**
 * Aktualisiert channel_members (last_seen, message_count) und legt einen
 * Eintrag in channel_message_log für die Tageszusammenfassung ab.
 */
async function _trackActivity(msg) {
  const from = msg.from;
  const chat = msg.chat;
  if (!from?.id || from.is_bot || from.id === 777000) return;
  if (!chat?.id || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const text = (msg.text || msg.caption || "").trim();
  const channelId = chat.id;
  const now = new Date();
  const preview = text ? text.substring(0, 200) : null;

  // (1) channel_members upsert mit last_seen + Counter
  try {
    const { data: existing } = await supabase.from("channel_members")
      .select("message_count").eq("channel_id", channelId).eq("user_id", from.id).maybeSingle();

    if (existing) {
      await supabase.from("channel_members").update({
        username: from.username || null,
        first_name: from.first_name || null,
        last_seen: now.toISOString(),
        last_message_at: now.toISOString(),
        last_message_preview: preview,
        message_count: (existing.message_count || 0) + 1,
        is_deleted: false
      }).eq("channel_id", channelId).eq("user_id", from.id);
    } else {
      await supabase.from("channel_members").insert([{
        channel_id: channelId, user_id: from.id,
        username: from.username || null,
        first_name: from.first_name || null,
        joined_at: now.toISOString(),
        last_seen: now.toISOString(),
        last_message_at: now.toISOString(),
        last_message_preview: preview,
        message_count: 1,
        is_deleted: false
      }]);
      try {
        await supabase.from("user_name_history").insert([{
          user_id: from.id, username: from.username || null,
          first_name: from.first_name || null, last_name: from.last_name || null
        }]);
      } catch (_) {}
    }
  } catch (e) {
    // last_seen ist nicht kritisch für Bot-Funktionalität
  }

  // (2) Group-Message-Log für Tageszusammenfassung
  if (text) {
    try {
      await supabase.from("channel_message_log").insert([{
        channel_id: String(channelId),
        user_id: from.id,
        username: from.username || null,
        first_name: from.first_name || null,
        content: text.substring(0, 500),
        msg_id: msg.message_id,
        created_at: now.toISOString()
      }]);
    } catch (_) {}
  }
}

/**
 * Behandelt einen erkannten SangMata-Forward. Schreibt in `sangmata_imports`
 * + ergänzt user_name_history mit den extrahierten Aliassen, dankt dem User.
 */
async function _handleSangMataForward(tg, msg) {
  const fromId = msg.from?.id;
  const text = msg.text || msg.caption || "";
  const targetUserId = _extractSangMataUserId(text);

  if (!targetUserId) {
    await tg.call("sendMessage", {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: "🤔 Ich konnte keine Telegram-ID im SangMata-Bericht erkennen. Bitte einen Bericht weiterleiten, der eine numerische ID enthält.",
      parse_mode: "HTML"
    }).catch(() => {});
    return;
  }

  try {
    await supabase.from("sangmata_imports").insert([{
      user_id: targetUserId,
      raw_text: text.substring(0, 4000),
      imported_by: fromId || null
    }]);
  } catch (e) {
    logger.warn(`[SangMata] insert failed: ${e.message}`);
    return;
  }

  // SangMata-Berichte enthalten oft "Old Username: @foo / New Username: @bar".
  // Wir versuchen mit best-effort Parsing, diese Aliasse in unser
  // user_name_history einzuspielen — falls noch nicht vorhanden.
  const aliasMatches = [];
  const userPatterns = [
    /(?:old|former|previous)\s+(?:user)?name[:\s]+@?(\w{4,32})/gi,
    /(?:new|current)\s+(?:user)?name[:\s]+@?(\w{4,32})/gi,
    /name\s+(?:was|war)[:\s]+(.+?)(?:\n|$)/gi,
  ];
  for (const re of userPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const alias = m[1]?.trim();
      if (alias && alias.length <= 64) aliasMatches.push(alias);
    }
  }
  for (const alias of aliasMatches.slice(0, 10)) {
    try {
      const isUsername = /^\w+$/.test(alias);
      const col = isUsername ? "username" : "first_name";
      const { data: existing } = await supabase.from("user_name_history")
        .select("id")
        .eq("user_id", targetUserId)
        .eq(col, alias)
        .limit(1);
      if (!existing?.length) {
        await supabase.from("user_name_history").insert([{
          user_id: targetUserId,
          username: isUsername ? alias : null,
          first_name: isUsername ? null : alias,
        }]);
      }
    } catch (_) {}
  }

  await tg.call("sendMessage", {
    chat_id: msg.chat.id,
    reply_to_message_id: msg.message_id,
    text: `✅ <b>Danke für den SangMata-Bericht!</b>\n\nIch habe die Daten zur Telegram-ID <code>${targetUserId}</code> gespeichert${aliasMatches.length ? ` (${aliasMatches.length} Alias${aliasMatches.length === 1 ? "" : "se"} ergänzt)` : ""}.\n\nDie Information taucht jetzt in <code>/userinfo ${targetUserId}</code> auf.`,
    parse_mode: "HTML"
  }).catch(() => {});
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

      // ─── SangMata-Forward erkennen (vor allem anderen Processing!) ──────
      // Wenn ein User im DM mit dem Bot einen SangMata-Bericht weiterleitet,
      // verarbeiten wir das speziell und brechen alle anderen Pfade ab.
      // In Gruppen wird der Forward ignoriert (würde Spam erzeugen).
      if (msg.chat?.type === "private" && _isSangMataForward(msg)) {
        try { await _handleSangMataForward(tg, msg); } catch (e) {
          logger.warn(`[SangMata] handler failed: ${e.message}`);
        }
        return;
      }

      // ─── Aktivitäts-Tracking auf JEDER Group-Message ─────────────────────
      // Vorher wurde last_seen nur bei Channel-Beitritt aktualisiert. Damit
      // war UserInfo permanent veraltet. Jetzt: jede Nachricht touched es.
      // Async, blockiert die weitere Pipeline nicht.
      _trackActivity(msg).catch(e => logger.warn(`[Activity] ${e.message}`));

      // ─── Blacklist-Durchsetzung (nur Gruppen/Supergruppen) ─────────────
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
