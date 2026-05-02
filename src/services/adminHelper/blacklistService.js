/**
 * blacklistService.js v1.5.39
 * ----------------------------------------------------------------------------
 * Erkennt Blacklist-Wörter in Channel/Gruppen-Nachrichten und setzt die
 * pro Channel konfigurierten Konsequenzen (Delete / Mute / Ban) durch.
 *
 * Quelle: bot_channels.bl_hard_consequences (text[]) für "mute"-Severity,
 *         bot_channels.bl_soft_delete_hours (int)   für "tolerated"-Severity.
 *
 * Aufruf siehe routes/smalltalkBotRoutes.js — VOR commandHandler.handleMessage.
 * ----------------------------------------------------------------------------
 */

const supabase = require("../../config/supabase");
const logger = require("../../utils/logger");
const { t } = require("../i18n");

// ─── Konfiguration ──────────────────────────────────────────────────────────
const MUTE_HOURS_DEFAULT = 12;          // Wenn "mute" Konsequenz aktiv → Dauer in Stunden
const WARN_AUTODELETE_MS = 5000;        // Warn-Hinweis im Channel selbst löschen nach N ms
const ADMIN_NOTIFY = true;              // Admin per DM informieren bei Hit

// ─── Normalisierung ─────────────────────────────────────────────────────────
function normalizeForBlacklist(text) {
  return String(text || "").toLowerCase()
    .replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/1/g, 'i').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[@$]/g, 'a').replace(/[^a-z0-9äöüß]/g, '');
}

// ─── Duration-Parser für /mute-Befehle (z.B. "30m", "2h", "1d", "permanent") ──
function parseDuration(s) {
  if (!s) return 24 * 3600;
  const str = String(s).trim().toLowerCase();
  if (str === "permanent" || str === "perm" || str === "forever") return -1;
  const m = str.match(/^(\d+)\s*([smhd])?$/);
  if (!m) return 24 * 3600;
  const n = parseInt(m[1], 10);
  const unit = m[2] || "h";
  switch (unit) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default:  return 24 * 3600;
  }
}

// ─── Auto-Delete für tolerated-Treffer ──────────────────────────────────────
async function handleMessageAutoDelete(supabase_db, channelId, messageId, hours) {
  if (!hours || hours <= 0) return;
  const deleteAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  try {
    await supabase_db.from("bot_messages").insert([{
      channel_id: String(channelId),
      message_id: messageId,
      msg_type: "tolerated_blacklist",
      delete_after: deleteAt
    }]);
  } catch (e) {
    logger.warn(`[Blacklist] Auto-Delete-Eintrag fehlgeschlagen: ${e.message}`);
  }
}

// ─── Blacklist-Wörter holen ─────────────────────────────────────────────────
async function _loadWords(supabase_db, channelId) {
  try {
    const { data } = await supabase_db.from("channel_blacklist")
      .select("word, severity").eq("channel_id", String(channelId));
    return data || [];
  } catch (e) {
    logger.warn(`[Blacklist] Wörter-Lookup fehlgeschlagen: ${e.message}`);
    return [];
  }
}

// ─── Hauptlogik ─────────────────────────────────────────────────────────────
/**
 * Prüft den Text auf Blacklist-Treffer und setzt Konsequenzen durch.
 *
 * @returns {Promise<null | { hit, severity, action, actionsTaken, deleted }>}
 *   - null bei: kein Text, Bot, kein Treffer, Admin-User
 *   - Object bei Treffer mit Details
 */
async function checkBlacklist(supabase_db, channelId, messageText, from, chatId, msgId, tg, token) {
  if (!messageText?.trim()) return null;
  if (!from?.id || from.is_bot) return null;

  const entries = await _loadWords(supabase_db, channelId);
  if (!entries.length) return null;

  // ── Wort-Match ─────────────────────────────────────────────────────────
  const normMsg = normalizeForBlacklist(messageText);
  let hit = null;
  for (const e of entries) {
    const w = normalizeForBlacklist(e.word);
    if (w && normMsg.includes(w)) { hit = e; break; }
  }
  if (!hit) return null;

  // ── Admin-Skip (nach Treffer, um getChatMember nur bei Hits zu rufen) ────
  try {
    const member = await tg.call("getChatMember", { chat_id: chatId, user_id: from.id });
    const status = member?.status;
    if (status === "creator" || status === "administrator") {
      // Admins werden nicht sanktioniert. Loggen wir trotzdem mit "skipped".
      try {
        await supabase_db.from("blacklist_hits").insert([{
          channel_id: String(channelId), user_id: from.id,
          username: from.username || null, word_hit: hit.word,
          message_text: messageText.substring(0, 200),
          action_taken: "skipped_admin"
        }]);
      } catch (_) {}
      return null;
    }
  } catch (_) {
    // getChatMember-Fehler: weiter so, als wäre kein Admin
  }

  // ── Channel-Daten holen ────────────────────────────────────────────────
  let ch = null;
  try {
    const { data } = await supabase_db.from("bot_channels")
      .select("added_by_user_id, title, bl_hard_consequences, bl_soft_delete_hours, bot_language")
      .eq("id", String(channelId)).maybeSingle();
    ch = data;
  } catch (_) {}

  const lang = ch?.bot_language || "de";
  const targetName = from.username ? "@" + from.username : (from.first_name || String(from.id));
  const isTolerated = hit.severity === "tolerated";

  // ─── Variante A: Tolerated (sanftere Konsequenz) ────────────────────────
  if (isTolerated) {
    const softHours = ch?.bl_soft_delete_hours || 0;

    try {
      await supabase_db.from("blacklist_hits").insert([{
        channel_id: String(channelId), user_id: from.id,
        username: from.username || null, word_hit: hit.word,
        message_text: messageText.substring(0, 200),
        action_taken: softHours > 0 ? `tolerated_delete_${softHours}h` : "tolerated_warn"
      }]);
    } catch (_) {}

    if (softHours > 0) {
      await handleMessageAutoDelete(supabase_db, channelId, msgId, softHours);
    }

    logger.info(`[Blacklist] tolerated hit "${hit.word}" by ${targetName} in ${channelId} (delete in ${softHours}h)`);

    return {
      hit, severity: "tolerated",
      action: softHours > 0 ? "delete_later" : "warn_only",
      actionsTaken: softHours > 0 ? [`Auto-Delete in ${softHours}h`] : ["Nur protokolliert"],
      deleted: false
    };
  }

  // ─── Variante B: Hard Hit (echte Konsequenzen) ──────────────────────────
  // Default: wenn keine Konsequenzen konfiguriert sind, mindestens "delete"
  // anwenden — sonst ist die Hard-Blacklist toter Code.
  let consequences = Array.isArray(ch?.bl_hard_consequences) ? ch.bl_hard_consequences.slice() : [];
  if (!consequences.length) consequences = ["delete"];

  const actionsTaken = [];
  let deleted = false;

  // Dem Channel signalisieren, dass ein Eingriff folgt.
  let warnMsg = null;
  try {
    warnMsg = await tg.call("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: msgId,
      text: t("bl_warn_msg", lang),
      parse_mode: "HTML"
    });
  } catch (_) {}

  // Aktion: Nachricht löschen
  if (consequences.includes("delete")) {
    try {
      await tg.call("deleteMessage", { chat_id: chatId, message_id: msgId });
      actionsTaken.push(t("bl_action_deleted", lang));
      deleted = true;
    } catch (e) {
      logger.warn(`[Blacklist] delete failed for msg ${msgId} in ${chatId}: ${e.message}`);
    }
  }

  // Aktion: User stummschalten
  if (consequences.includes("mute") && from.id > 0) {
    try {
      const muteHours = MUTE_HOURS_DEFAULT;
      await tg.call("restrictChatMember", {
        chat_id: chatId,
        user_id: from.id,
        permissions: {
          can_send_messages: false,
          can_send_other_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_add_web_page_previews: false
        },
        until_date: Math.floor(Date.now() / 1000) + (muteHours * 3600)
      });
      actionsTaken.push(t("bl_action_muted", lang, { hours: muteHours }));
    } catch (e) {
      logger.warn(`[Blacklist] mute failed for ${from.id} in ${chatId}: ${e.message}`);
    }
  }

  // Aktion: User bannen
  if (consequences.includes("ban") && from.id > 0) {
    try {
      await tg.call("banChatMember", { chat_id: chatId, user_id: from.id, until_date: 0, revoke_messages: false });
      try {
        await supabase_db.from("channel_banned_users").upsert([{
          channel_id: String(channelId),
          user_id: String(from.id),
          username: from.username || null,
          reason: `Blacklist Wort: ${hit.word}`,
          banned_at: new Date().toISOString()
        }], { onConflict: "channel_id,user_id" });
      } catch (_) {}
      actionsTaken.push(t("bl_action_banned", lang));
    } catch (e) {
      logger.warn(`[Blacklist] ban failed for ${from.id} in ${chatId}: ${e.message}`);
    }
  }

  // Hit in DB protokollieren
  try {
    await supabase_db.from("blacklist_hits").insert([{
      channel_id: String(channelId), user_id: from.id,
      username: from.username || null, word_hit: hit.word,
      message_text: messageText.substring(0, 200),
      action_taken: actionsTaken.length ? actionsTaken.join(",") : "none"
    }]);
  } catch (_) {}

  // Warn-Hinweis im Channel selbst nach 5s wieder löschen
  if (warnMsg?.message_id) {
    setTimeout(() => {
      tg.call("deleteMessage", { chat_id: chatId, message_id: warnMsg.message_id }).catch(() => {});
    }, WARN_AUTODELETE_MS);
  }

  // Admin per DM informieren
  if (ADMIN_NOTIFY && ch?.added_by_user_id) {
    try {
      const adminText = t("bl_admin_alert", lang, {
        channel: ch.title || channelId,
        user: targetName,
        word: hit.word,
        actions: actionsTaken.length ? actionsTaken.join(", ") : t("bl_action_none", lang),
        text: messageText.substring(0, 150)
      });
      await tg.call("sendMessage", {
        chat_id: String(ch.added_by_user_id),
        text: adminText,
        parse_mode: "HTML"
      });
    } catch (e) {
      logger.warn(`[Blacklist] admin DM failed: ${e.message}`);
    }
  }

  logger.info(`[Blacklist] hard hit "${hit.word}" by ${targetName} in ${channelId} → ${actionsTaken.join(",") || "none"}`);

  return {
    hit, severity: "hard",
    action: consequences.join(","),
    actionsTaken,
    deleted
  };
}

module.exports = {
  normalizeForBlacklist,
  parseDuration,
  checkBlacklist,
};
