/**
 * userInfoService.js v1.5.42
 * ----------------------------------------------------------------------------
 * • Liest jetzt zusätzlich aus channel_message_log (echte Aktivität),
 *   sangmata_imports (extern beigetragene Namens-Historie) und nutzt
 *   die in 1.5.42 ergänzten Felder last_message_at/message_count.
 * • Gibt zurück, welche `message_id` als Antwort gepostet wurde, damit der
 *   Aufrufer sie zur Auto-Deletion (5-10 min) registrieren kann.
 * ----------------------------------------------------------------------------
 */

async function checkDailyLimit(supabase_db, userId) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const { data } = await supabase_db.from("user_daily_usage").select("*").eq("user_id", userId).eq("usage_date", today).maybeSingle();
    if (data && data.userinfo_count >= 5) {
      const { data: adminCheck } = await supabase_db.from("bot_channels").select("id").eq("added_by_user_id", String(userId)).limit(1);
      if (!adminCheck || adminCheck.length === 0) return false;
    }
    await supabase_db.from("user_daily_usage").upsert([{ user_id: userId, usage_date: today, userinfo_count: (data?.userinfo_count || 0) + 1 }], { onConflict: "user_id,usage_date" });
    return true;
  } catch (_) { return true; }
}

function _fmtRelative(date) {
  if (!date) return "noch nie";
  const d = new Date(date);
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const days = Math.floor(h / 24);
  if (days < 30) return `vor ${days} Tag${days === 1 ? "" : "en"}`;
  return d.toLocaleDateString("de-DE");
}

async function runUserInfo(tg, supabase_db, callerUserId, targetInput, channelId, msg, replyChatId) {
  const sendTo = replyChatId || callerUserId;

  if (!(await checkDailyLimit(supabase_db, callerUserId))) {
    const limitMsg = await tg.call("sendMessage", {
      chat_id: String(sendTo),
      text: "❌ <b>Limit erreicht</b>\n\nDu hast dein kostenloses Limit von 5 Abfragen erreicht.",
      parse_mode: "HTML"
    }).catch(() => null);
    return { messageId: limitMsg?.message_id || null };
  }

  let tUname = typeof targetInput === "string" && targetInput.startsWith("@") ? targetInput.replace("@", "").toLowerCase() : null;
  let tId = !isNaN(targetInput) && String(targetInput).trim() !== "" ? parseInt(targetInput) : null;

  const waitMsg = await tg.call("sendMessage", { chat_id: String(sendTo), text: "🔍 Sammle Informationen..." }).catch(() => null);

  // Direkter Telegram-Lookup (ergibt aktuelle Profil-Daten)
  let p = null;
  if (tId) p = await tg.call("getChat", { chat_id: tId }).catch(() => null);
  if (!p && tUname) p = await tg.call("getChat", { chat_id: "@" + tUname }).catch(() => null);

  if (p) {
    tId = p.id;
    tUname = p.username ? p.username.toLowerCase() : tUname;
  }

  // Channel-Mitgliedschaft (Aktivitäts-Daten)
  let cMem = null;
  if (tId && channelId) cMem = await supabase_db.from("channel_members").select("*").eq("channel_id", channelId).eq("user_id", tId).maybeSingle().then(r => r.data);
  if (!cMem && tUname && channelId) cMem = await supabase_db.from("channel_members").select("*").eq("channel_id", channelId).ilike("username", tUname).maybeSingle().then(r => r.data);

  if (cMem && !tId) tId = cMem.user_id;

  // Reputation, Listen
  let safeC = 0, scamC = 0, fbPos = 0, fbNeg = 0;
  if (tId) {
    safeC = await supabase_db.from("channel_safelist").select("id", { count: "exact" }).eq("user_id", tId).then(r => r.count || 0);
    scamC = await supabase_db.from("scam_entries").select("id", { count: "exact" }).eq("user_id", tId).then(r => r.count || 0);
    const { data: rep } = await supabase_db.from("user_reputation").select("pos_count, neg_count").eq("user_id", tId);
    if (rep) rep.forEach(r => { fbPos += r.pos_count; fbNeg += r.neg_count; });
  } else if (tUname) {
    safeC = await supabase_db.from("channel_safelist").select("id", { count: "exact" }).ilike("username", tUname).then(r => r.count || 0);
    scamC = await supabase_db.from("scam_entries").select("id", { count: "exact" }).ilike("username", tUname).then(r => r.count || 0);
    const { data: rep } = await supabase_db.from("user_reputation").select("pos_count, neg_count").ilike("username", tUname);
    if (rep) rep.forEach(r => { fbPos += r.pos_count; fbNeg += r.neg_count; });
  }

  // Aktivität in der aktuellen Gruppe (24h)
  let messages24h = 0;
  if (tId && channelId) {
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      messages24h = await supabase_db.from("channel_message_log")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", String(channelId))
        .eq("user_id", tId)
        .gte("created_at", since)
        .then(r => r.count || 0);
    } catch (_) {}
  }

  // SangMata-Imports
  let sangMataCount = 0;
  if (tId) {
    try {
      sangMataCount = await supabase_db.from("sangmata_imports")
        .select("id", { count: "exact", head: true })
        .eq("user_id", tId).then(r => r.count || 0);
    } catch (_) {}
  }

  // Namens-Historie
  let nameHistoryCount = 0;
  if (tId) {
    try {
      nameHistoryCount = await supabase_db.from("user_name_history")
        .select("id", { count: "exact", head: true })
        .eq("user_id", tId).then(r => r.count || 0);
    } catch (_) {}
  }

  // ─── Bericht zusammenbauen ─────────────────────────────────────────────
  let text = `🔍 <b>UserInfo Report</b>\n\n👤 <b>Profil:</b>\n`;
  if (p) {
    text += `Name: ${p.first_name || ""} ${p.last_name || ""}\n`;
    text += `Username: ${p.username ? "@" + p.username : "—"}\n`;
    text += `ID: <code>${p.id}</code>\n`;
    if (p.bio) text += `Bio: <i>${p.bio.substring(0, 200)}</i>\n`;
  } else {
    text += `Ziel: ${tUname ? "@" + tUname : "—"}\n`;
    text += `ID: <code>${tId || "Unbekannt"}</code>\n`;
  }

  if (cMem) {
    text += `\n📍 <b>Aktivität in dieser Gruppe:</b>\n`;
    text += `Beigetreten: ${new Date(cMem.joined_at).toLocaleString("de-DE")}\n`;
    text += `Zuletzt aktiv: ${_fmtRelative(cMem.last_message_at || cMem.last_seen)}\n`;
    if (cMem.message_count) {
      text += `Gesamt-Nachrichten: <b>${Number(cMem.message_count).toLocaleString("de-DE")}</b>`;
      if (messages24h) text += ` <i>(${messages24h} in 24h)</i>`;
      text += `\n`;
    }
  }

  text += `\n📊 <b>Globale Plattform-Daten:</b>\n`;
  text += `✅ Auf <b>${safeC}</b> Safelisten\n`;
  text += `⛔ Auf <b>${scamC}</b> Scamlisten\n`;
  text += `💬 <b>Feedbacks:</b> ${fbPos} Positiv | ${fbNeg} Negativ\n`;
  if (nameHistoryCount > 0 || sangMataCount > 0) {
    text += `\n📚 <b>History-Quellen:</b>\n`;
    if (nameHistoryCount > 0) text += `• ${nameHistoryCount === 1 ? "1 Eintrag" : nameHistoryCount + " Einträge"} in lokaler Namenshistorie\n`;
    if (sangMataCount > 0) text += `• ${sangMataCount} SangMata-Import${sangMataCount === 1 ? "" : "e"}\n`;
  }

  const kb = tId ? [
    [{ text: "📜 Namenshistorie", callback_data: `uinfo_names_${tId}` }],
  ] : [];
  if (sangMataCount > 0 && tId) {
    kb.push([{ text: `📥 SangMata-Imports (${sangMataCount})`, callback_data: `uinfo_sangmata_${tId}` }]);
  } else if (tId) {
    kb.push([{ text: "🔍 SangMata Anleitung", callback_data: `uinfo_sangmata_${tId}` }]);
  }

  let resultMessageId = null;
  if (waitMsg?.message_id) {
    const r = await tg.call("editMessageText", { chat_id: String(sendTo), message_id: waitMsg.message_id, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }).catch(async () => {
      return await tg.call("sendMessage", { chat_id: String(sendTo), text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    });
    resultMessageId = r?.message_id || waitMsg.message_id;
  } else {
    const r = await tg.call("sendMessage", { chat_id: String(sendTo), text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    resultMessageId = r?.message_id || null;
  }
  return { messageId: resultMessageId };
}

module.exports = { runUserInfo };
