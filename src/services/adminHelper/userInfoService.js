const axios = require("axios");

async function checkDailyLimit(supabase_db, userId) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const { data } = await supabase_db.from("user_daily_usage")
      .select("*").eq("user_id", userId).eq("usage_date", today).maybeSingle();
      
    if (data && data.userinfo_count >= 5) {
      const { data: adminCheck } = await supabase_db.from("bot_channels")
        .select("id").eq("added_by_user_id", String(userId)).limit(1);
      if (!adminCheck || adminCheck.length === 0) {
        return false;
      }
    }
    
    await supabase_db.from("user_daily_usage").upsert([{
      user_id: userId,
      usage_date: today,
      userinfo_count: (data?.userinfo_count || 0) + 1
    }], { onConflict: "user_id,usage_date" });
    
    return true;
  } catch (_) {
    return true;
  }
}

async function runUserInfo(tg, supabase_db, callerUserId, targetInput, channelId, msg, replyChatId) {
  const chatId = replyChatId || channelId || callerUserId;
  
  const canUse = await checkDailyLimit(supabase_db, callerUserId);
  if (!canUse) {
    await tg.call("sendMessage", {
      chat_id: String(chatId),
      text: "❌ <b>Limit erreicht</b>\n\nDu hast dein kostenloses Limit von 5 UserInfo-Abfragen für heute aufgebraucht.",
      parse_mode: "HTML"
    });
    return;
  }

  let targetUsername = null;
  let targetId = null;

  if (typeof targetInput === "string" && targetInput.startsWith("@")) {
    targetUsername = targetInput.replace("@", "").toLowerCase();
  } else if (!isNaN(targetInput) && String(targetInput).trim() !== "") {
    targetId = parseInt(targetInput);
  }

  const waitMsg = await tg.call("sendMessage", { chat_id: String(chatId), text: "🔍 Sammle Informationen..." }).catch(() => null);

  let scamData = null, safeData = null, repData = null;

  try {
    if (targetId) {
      scamData = await supabase_db.from("scam_entries").select("*").eq("user_id", targetId).maybeSingle().then(r => r.data);
      safeData = await supabase_db.from("channel_safelist").select("*").eq("user_id", targetId).maybeSingle().then(r => r.data);
      repData = await supabase_db.from("user_reputation").select("*").eq("user_id", targetId).maybeSingle().then(r => r.data);
    } else if (targetUsername) {
      scamData = await supabase_db.from("scam_entries").select("*").ilike("username", targetUsername).maybeSingle().then(r => r.data);
      safeData = await supabase_db.from("channel_safelist").select("*").ilike("username", targetUsername).maybeSingle().then(r => r.data);
      repData = await supabase_db.from("user_reputation").select("*").ilike("username", targetUsername).maybeSingle().then(r => r.data);
    }
  } catch (_) {}

  let tgProfile = null;
  if (targetId) {
    tgProfile = await tg.call("getChat", { chat_id: targetId }).catch(() => null);
  }

  let text = `🔍 <b>UserInfo Report</b>\n\n`;
  
  if (tgProfile) {
    text += `👤 <b>Profil:</b>\n`;
    text += `Name: ${tgProfile.first_name || ""} ${tgProfile.last_name || ""}\n`;
    text += `Username: ${tgProfile.username ? "@" + tgProfile.username : "Keiner"}\n`;
    text += `ID: <code>${tgProfile.id}</code>\n`;
    if (tgProfile.bio) text += `Bio: <i>${tgProfile.bio}</i>\n`;
  } else {
    text += `👤 <b>Profil:</b>\nZiel: ${targetUsername ? "@" + targetUsername : targetId}\n`;
    text += `<i>(Erweiterte Telegram-Profildaten konnten nicht abgerufen werden)</i>\n`;
  }

  text += `\n📊 <b>Plattform-Daten:</b>\n`;
  if (scamData) {
    text += `⛔ <b>Auf Scamliste!</b>\nGrund: ${scamData.reason || "Unbekannt"}\n`;
  } else if (safeData) {
    text += `✅ <b>Auf Safelist!</b>\nScore: ${safeData.score || 0}\n`;
  } else {
    text += `⚪ Weder auf Safelist noch auf Scamliste verzeichnet.\n`;
  }

  if (repData) {
    text += `\n💬 <b>Bestätigte Feedbacks:</b>\n✅ Positiv: ${repData.pos_count || 0}\n⚠️ Negativ: ${repData.neg_count || 0}\n`;
  }

  if (waitMsg?.message_id) {
    await tg.call("editMessageText", {
      chat_id: String(chatId),
      message_id: waitMsg.message_id,
      text: text,
      parse_mode: "HTML"
    }).catch(async () => {
      await tg.call("sendMessage", { chat_id: String(chatId), text: text, parse_mode: "HTML" });
    });
  } else {
    await tg.call("sendMessage", { chat_id: String(chatId), text: text, parse_mode: "HTML" });
  }
}

module.exports = { runUserInfo };
