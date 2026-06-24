/**
 * userIdentityService.js — User-Identity-Verlauf (1.6.73)
 *
 * Telegram-User können Username, First/Last-Name jederzeit ändern. Damit die
 * Channel-AI später konsistent über Personen sprechen kann, wird bei jeder
 * eingehenden Nachricht die aktuelle Identity erfasst:
 *
 *   - Initial-Log beim ersten Auftreten eines Users
 *   - Folgende Logs nur wenn Username/Name sich GEÄNDERT haben (dedupliziert)
 *
 * Tabelle: user_identity_log
 *   (channel_id, user_id, username, first_name, last_name, source, observed_at)
 */
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

// In-Memory Cache der zuletzt gesehenen Identity pro User
// Verhindert dass jede einzelne Nachricht eine DB-Query auslöst.
// Form: { "<userId>": { username, firstName, lastName, lastSeen } }
const _identityCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min

function _cacheKey(userId, channelId) {
  return `${userId}:${channelId || "global"}`;
}

function _identicalIdentity(a, b) {
  return (a.username || "") === (b.username || "")
      && (a.firstName || "") === (b.firstName || "")
      && (a.lastName || "") === (b.lastName || "");
}

/**
 * Loggt eine User-Identity in user_identity_log, aber nur wenn sich der
 * Username oder Name seit dem letzten bekannten Eintrag verändert hat.
 * Fire-and-forget — Fehler werden geloggt aber nicht weitergegeben.
 */
async function logIdentity({ channelId, userId, username, firstName, lastName, source = "message" }) {
  if (!userId) return;
  userId = parseInt(userId);
  if (!Number.isFinite(userId)) return;

  const incoming = {
    username:  username  ? String(username).toLowerCase()  : null,
    firstName: firstName ? String(firstName).substring(0, 100) : null,
    lastName:  lastName  ? String(lastName).substring(0, 100)  : null
  };

  const ck     = _cacheKey(userId, channelId);
  const cached = _identityCache.get(ck);
  if (cached && (Date.now() - cached.lastSeen) < CACHE_TTL_MS && _identicalIdentity(cached, incoming)) {
    // Cache-Hit + identische Identity → nicht loggen
    cached.lastSeen = Date.now();
    return;
  }

  try {
    // Letzten DB-Eintrag prüfen falls Cache leer war
    const { data: last } = await supabase.from("user_identity_log")
      .select("username, first_name, last_name")
      .eq("user_id", userId)
      .eq("channel_id", channelId ? String(channelId) : null)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastDb = last
      ? { username: last.username ? last.username.toLowerCase() : null,
          firstName: last.first_name, lastName: last.last_name }
      : null;

    if (lastDb && _identicalIdentity(lastDb, incoming)) {
      // Keine Änderung → nur Cache aktualisieren
      _identityCache.set(ck, { ...incoming, lastSeen: Date.now() });
      return;
    }

    // INSERT — neue oder geänderte Identity
    await supabase.from("user_identity_log").insert([{
      channel_id: channelId ? String(channelId) : null,
      user_id:    userId,
      username:   incoming.username,
      first_name: incoming.firstName,
      last_name:  incoming.lastName,
      source:     source
    }]);

    _identityCache.set(ck, { ...incoming, lastSeen: Date.now() });
  } catch (e) {
    logger.warn(`[userIdentityService] logIdentity Fehler: ${e.message}`);
  }
}

/**
 * Holt die History eines Users für die Channel-AI.
 * Returns: Array { username, first_name, last_name, observed_at }
 */
async function getUserHistory(channelId, userId, limit = 5) {
  try {
    let q = supabase.from("user_identity_log")
      .select("username, first_name, last_name, observed_at")
      .eq("user_id", parseInt(userId))
      .order("observed_at", { ascending: false })
      .limit(limit);
    if (channelId) q = q.eq("channel_id", String(channelId));
    const { data } = await q;
    return data || [];
  } catch (e) {
    logger.warn(`[userIdentityService] getUserHistory Fehler: ${e.message}`);
    return [];
  }
}

/**
 * Baut einen kurzen Kontext-String über einen User für die AI.
 * Beispiel-Output:
 *   "User: Fearqlf (@fearqlf), bekannt unter den Usernames: fearqlf, fear_qlf2024"
 */
async function buildUserContext(channelId, userId, currentUsername, currentFirstName) {
  if (!userId) return "";
  const history = await getUserHistory(channelId, userId, 8);
  if (!history.length) return "";

  const uniqueUsernames = [...new Set(history.map(h => h.username).filter(Boolean))];
  const uniqueNames     = [...new Set(history.map(h => h.first_name).filter(Boolean))];

  const cur = currentFirstName || uniqueNames[0] || "User";
  const handleNow = currentUsername ? `@${currentUsername}` : "(kein Username)";

  let ctx = `User: ${cur} ${handleNow}`;
  if (uniqueUsernames.length > 1) {
    ctx += `\nFrühere Usernames: ${uniqueUsernames.slice(1, 5).map(u => "@" + u).join(", ")}`;
  }
  if (uniqueNames.length > 1) {
    ctx += `\nFrühere Anzeigenamen: ${uniqueNames.slice(1, 4).join(", ")}`;
  }
  return ctx;
}

/**
 * Findet einen User per Username — auch wenn der User den Username inzwischen
 * geändert hat (Lookup über alle historischen Usernames).
 */
async function findByUsername(channelId, username) {
  if (!username) return null;
  const cleanU = String(username).replace(/^@/, "").toLowerCase();
  try {
    let q = supabase.from("user_identity_log")
      .select("user_id, username, first_name, last_name, observed_at")
      .ilike("username", cleanU)
      .order("observed_at", { ascending: false })
      .limit(1);
    if (channelId) q = q.eq("channel_id", String(channelId));
    const { data } = await q;
    return data?.[0] || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  logIdentity,
  getUserHistory,
  buildUserContext,
  findByUsername
};
