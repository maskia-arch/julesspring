/**
 * botToken.js — Zentrale Auflösung des AdminHelper-Bot-Tokens.
 * ============================================================================
 * Quelle: Render Environment Variable (bevorzugt).
 *   SMALLTALK_BOT_TOKEN   ← empfohlen
 *   ADMINHELPER_BOT_TOKEN ← Alias
 *   TELEGRAM_BOT_TOKEN    ← Alias
 *
 * Fallback (Abwärtskompatibilität): settings.smalltalk_bot_token in der DB.
 * Sobald eine ENV-Variable gesetzt ist, hat sie IMMER Vorrang.
 * ============================================================================
 */
const supabase = require('./supabase');

const ENV_TOKEN =
  process.env.SMALLTALK_BOT_TOKEN ||
  process.env.ADMINHELPER_BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  '';

/** Synchron: nur die ENV-Variable (oder null). */
function getTokenSync() {
  return ENV_TOKEN || null;
}

/** Async: ENV bevorzugt, sonst DB-Fallback. */
async function getToken() {
  if (ENV_TOKEN) return ENV_TOKEN;
  try {
    const { data } = await supabase
      .from('settings').select('smalltalk_bot_token').eq('id', 1).maybeSingle();
    if (data?.smalltalk_bot_token) return data.smalltalk_bot_token;
  } catch (_) {}
  try {
    const r = await supabase.from('settings').select('smalltalk_bot_token').limit(1);
    return r.data?.[0]?.smalltalk_bot_token || null;
  } catch (_) { return null; }
}

module.exports = { getToken, getTokenSync, ENV_TOKEN, isFromEnv: !!ENV_TOKEN };
