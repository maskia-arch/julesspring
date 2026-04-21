const axios = require("axios");

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

async function runUserInfo(tg, supabase_db, callerUserId, targetInput, channelId, msg, replyChatId) {
  const sendTo = replyChatId || callerUserId;
  
  if (!(await checkDailyLimit(supabase_db, callerUserId))) {
    await tg.call("sendMessage", { chat_id: String(sendTo), text: "❌ <b>Limit erreicht</b>\n\nDu hast dein kostenloses Limit von 5 Abfragen erreicht.", parse_mode: "HTML" });
    return;
  }

  let tUname = typeof targetInput === "string" && targetInput.startsWith("@") ? targetInput.replace("@", "").toLowerCase() : null;
  let tId = !isNaN(targetInput) && String(targetInput).trim() !== "" ? parseInt(targetInput) : null;

  const waitMsg = await tg.call("sendMessage", { chat_id: String(sendTo), text: "🔍 Sammle Informationen..." }).catch(() => null);

  let p = null;
  if (tId) p = await tg.call("getChat", { chat_id: tId }).catch(() => null);

  if (p) {
    tId = p.id;
    tUname = p.username ? p.username.toLowerCase() : tUname;
  }

  let cMem = null;
  if (tId && channelId) cMem = await supabase_db.from("channel_members").select("*").eq("channel_id", channelId).eq("user_id", tId).maybeSingle().then(r=>r.data);
  if (!cMem && tUname && channelId) cMem = await supabase_db.from("channel_members").select("*").eq("channel_id", channelId).ilike("username", tUname).maybeSingle().then(r=>r.data);

  if (cMem && !tId) tId = cMem.user_id;

  let safeC = 0, scamC = 0, fbPos = 0, fbNeg = 0;
  if (tId) {
    safeC = await supabase_db.from("channel_safelist").select("id", {count:"exact"}).eq("user_id", tId).then(r=>r.count||0);
    scamC = await supabase_db.from("scam_entries").select("id", {count:"exact"}).eq("user_id", tId).then(r=>r.count||0);
    const {data: rep} = await supabase_db.from("user_reputation").select("pos_count, neg_count").eq("user_id", tId);
    if(rep) rep.forEach(r => { fbPos += r.pos_count; fbNeg += r.neg_count; });
  } else if (tUname) {
    safeC = await supabase_db.from("channel_safelist").select("id", {count:"exact"}).ilike("username", tUname).then(r=>r.count||0);
    scamC = await supabase_db.from("scam_entries").select("id", {count:"exact"}).ilike("username", tUname).then(r=>r.count||0);
    const {data: rep} = await supabase_db.from("user_reputation").select("pos_count, neg_count").ilike("username", tUname);
    if(rep) rep.forEach(r => { fbPos += r.pos_count; fbNeg += r.neg_count; });
  }

  let text = `🔍 <b>UserInfo Report</b>\n\n👤 <b>Profil:</b>\n`;
  if (p) {
    text += `Name: ${p.first_name||""} ${p.last_name||""}\nUsername: ${p.username?"@"+p.username:"-"}\nID: <code>${p.id}</code>\n`;
    if (p.bio) text += `Bio: <i>${p.bio}</i>\n`;
  } else {
    text += `Ziel: ${tUname?"@"+tUname:tId}\n<i>(Erweiterte Telegram-Profildaten nicht abrufbar)</i>\n`;
  }

  if (cMem) {
    text += `\n📍 <b>Channel-Status:</b>\nErstmals gesehen: ${new Date(cMem.joined_at).toLocaleString("de-DE")}\nZuletzt aktiv: ${new Date(cMem.last_seen).toLocaleString("de-DE")}\n`;
  }

  text += `\n📊 <b>Globale Plattform-Daten:</b>\n`;
  text += `✅ Auf <b>${safeC}</b> Safelisten\n`;
  text += `⛔ Auf <b>${scamC}</b> Scamlisten\n`;
  text += `💬 <b>Feedbacks:</b> ${fbPos} Positiv | ${fbNeg} Negativ\n`;

  const kb = tId ? [[{ text: "📜 Namenshistorie", callback_data: `uinfo_names_${tId}` }]] : [];

  if (waitMsg?.message_id) {
    await tg.call("editMessageText", { chat_id: String(sendTo), message_id: waitMsg.message_id, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }).catch(async () => {
      await tg.call("sendMessage", { chat_id: String(sendTo), text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    });
  } else {
    await tg.call("sendMessage", { chat_id: String(sendTo), text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
  }
}

module.exports = { runUserInfo };
