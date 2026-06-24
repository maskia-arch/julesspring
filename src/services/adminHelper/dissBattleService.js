/**
 * dissBattleService.js  (1.6.75)
 *
 * "Diss Battle" — zwei User dissen sich in einer abgeschlossenen Arena-Gruppe,
 * Grok bewertet hinterher Witz, Wortschatz, Einfallsreichtum etc. und kuert
 * den Gewinner.
 *
 * Setup:
 *   1) Admin erstellt einmalig eine Battle-Arena-Gruppe.
 *   2) Bot wird als Admin mit "Invite-Users" + "Restrict-Members"-Rechten
 *      eingeladen, der Channel-Owner ebenfalls als Admin (Backup).
 *   3) Im Channel-Settings -> Gruppenspiele -> Diss Battle wird die Arena-ID
 *      eingetragen (z.B. -1001234567890).
 *
 * Flow:
 *   /dissbattle           -> offene Runde, Invite-Link im Channel gepostet
 *   /dissbattle @user     -> Einladung an spezifischen Spieler
 *   (Reply auf Nachricht) -> Einladung an den User der Reply-To-Nachricht
 *
 *   Bot erstellt Invite-Link mit member_limit=2, postet ihn im Channel.
 *   Beide Spieler joinen -> Bot startet Timer (5/10/15 min).
 *   Waehrend der Zeit werden alle Arena-Nachrichten in channel_diss_battle_messages
 *   geloggt.
 *   Bei Ablauf: Bot restricted beide (read-only), schickt Verlauf an Grok.
 *   Grok kuert Gewinner -> Ranking-Update -> Ergebnis im Original-Channel.
 */
const logger = require("../../utils/logger");
const xaiService = require("../xaiService");

// In-Memory Timer-Registry (battleId -> setTimeout-Handle)
// Bei Server-Restart gehen laufende Battles in den "judging"-Status verloren —
// das ist akzeptabel weil Battles maximal 15 Minuten dauern und bei Restart
// sehr selten gleichzeitig aktiv sind. Recovery via _recoverActiveBattles().
const _battleTimers = new Map();

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _displayName(user) {
  if (!user) return "Unbekannt";
  return user.username ? "@" + user.username : (user.first_name || String(user.id));
}

/**
 * Sucht den letzten "offenen" Battle (waiting_join oder active) in einer Arena.
 * Es kann pro Arena nur ein Battle gleichzeitig laufen.
 */
async function _findActiveBattleInArena(supabase, arenaChatId) {
  // "Aktiv" für Arena-Sperrung = nur Battle das die Arena tatsaechlich belegt
  // (status='active' oder 'judging'). 'pending' (wartet auf Spieler-Join)
  // belegt die Arena NICHT — solche Battles werden im Channel angekuendigt,
  // ohne dass die Arena selbst gesperrt wird.
  const { data } = await supabase.from("channel_diss_battles")
    .select("*")
    .eq("arena_chat_id", arenaChatId)
    .in("status", ["active", "judging"])
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  return data || null;
}

/**
 * Sucht ein pending- oder queued-Battle in derselben Arena (fuer Queue-Decision).
 */
async function _findPendingOrQueuedInArena(supabase, arenaChatId) {
  const { data } = await supabase.from("channel_diss_battles")
    .select("*")
    .eq("arena_chat_id", arenaChatId)
    .in("status", ["pending", "queued"])
    .order("created_at", { ascending: true });
  return data || [];
}

/**
 * Sucht laufende Battles fuer Recovery beim Server-Start.
 */
async function _recoverActiveBattles(tg, supabase) {
  try {
    const { data } = await supabase.from("channel_diss_battles")
      .select("*").in("status", ["pending", "active", "queued"]);
    if (!data?.length) return;
    for (const b of data) {
      const now = Date.now();
      // ── pending: 5min-Auto-Cancel-Timer wiederherstellen ─────────────────
      if (b.status === "pending") {
        const expireAt = b.invite_expires_at ? new Date(b.invite_expires_at).getTime() : (now + 5*60*1000);
        if (expireAt <= now) {
          logger.info(`[DissBattle] Recovery: pending Battle ${b.id} abgelaufen, canceln`);
          cancelIfStillWaiting(tg, supabase, b.id).catch(() => {});
        } else {
          const remaining = expireAt - now;
          const t = setTimeout(() => cancelIfStillWaiting(tg, supabase, b.id).catch(() => {}), remaining);
          _battleTimers.set(`waiting:${b.id}`, t);
          logger.info(`[DissBattle] Recovery: pending Battle ${b.id} - Cancel-Timer ${Math.round(remaining/1000)}s`);
        }
        continue;
      }
      // ── active: Battle-End-Timer wiederherstellen ──────────────────────
      if (b.status === "active") {
        const endAt = b.ends_at ? new Date(b.ends_at).getTime() : null;
        if (!endAt || endAt < now) {
          logger.info(`[DissBattle] Recovery: active Battle ${b.id} abgelaufen, finalisieren`);
          finalizeBattle(tg, supabase, b.id).catch(e => logger.warn(`[DissBattle] Recovery finalize ${b.id}: ${e.message}`));
        } else {
          const remaining = endAt - now;
          _battleTimers.set(b.id, setTimeout(() => finalizeBattle(tg, supabase, b.id), remaining));
          logger.info(`[DissBattle] Recovery: active Battle ${b.id} - End-Timer ${Math.round(remaining/1000)}s`);
        }
      }
      // queued: nichts zu tun, wird beim naechsten finalizeBattle-Aufruf rausgenommen
    }
  } catch (e) {
    logger.warn(`[DissBattle] Recovery-Fehler: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Battle erstellen — /dissbattle [Command]
// ───────────────────────────────────────────────────────────────────────────

/**
 * Startet ein neues Diss-Battle. Postet den Invite-Link in der Original-Gruppe.
 *
 * @returns { ok, error, battle, inviteLink }
 */
async function createBattle(tg, supabase, {
  channelId,            // Original-Channel-ID wo /dissbattle gerufen wurde
  channelTitle,
  arenaChatId,
  durationMinutes,
  challenger,           // { id, username, first_name }
  target,               // optional: { id, username, first_name } - bei offener Runde null
  originalMessageId
}) {
  if (!arenaChatId) {
    return { ok: false, error: "Keine Battle-Arena konfiguriert. Channel-Admin muss zuerst eine Arena-Gruppe einrichten." };
  }
  if (target && challenger?.id === target?.id) {
    return { ok: false, error: "Du kannst dich nicht selbst herausfordern." };
  }

  // Pruefe ob Arena gerade aktiv belegt ist
  const activeBattle    = await _findActiveBattleInArena(supabase, arenaChatId);
  const pendingOrQueued = await _findPendingOrQueuedInArena(supabase, arenaChatId);

  // Bestimmen ob neues Battle direkt 'pending' oder in 'queued' geht
  const shouldQueue = !!activeBattle || pendingOrQueued.some(b => b.status === "pending");
  const initialStatus = shouldQueue ? "queued" : "pending";

  // Queue-Position berechnen (nur fuer 'queued')
  let queuePos = 0;
  if (shouldQueue) {
    const queuedOnly = pendingOrQueued.filter(b => b.status === "queued");
    queuePos = queuedOnly.length + 1;
  }

  // Invite-Link erstellen (5 Min Gueltigkeit, Limit 2)
  // ABER: nur wenn das Battle direkt startfaehig ist (pending).
  // Bei 'queued' wird der Link beim Aktivieren erstellt.
  let inviteLink = null;
  let inviteExpiresAt = null;
  if (initialStatus === "pending") {
    try {
      const expire = Math.floor(Date.now() / 1000) + 5 * 60;
      const resp = await tg.call("createChatInviteLink", {
        chat_id: arenaChatId,
        name: `DissBattle ${Date.now()}`,
        expire_date: expire,
        member_limit: 2,
        creates_join_request: false
      });
      inviteLink = resp?.invite_link || resp?.result?.invite_link;
      inviteExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    } catch (e) {
      logger.warn(`[DissBattle] createChatInviteLink: ${e.message}`);
      return { ok: false, error: "Battle-Arena nicht erreichbar. Ist der Bot dort Admin mit 'Invite-Users'-Recht?" };
    }
    if (!inviteLink) return { ok: false, error: "Invite-Link konnte nicht erstellt werden." };
  }

  // Battle in DB anlegen
  let battleId;
  try {
    const { data, error } = await supabase.from("channel_diss_battles").insert([{
      channel_id:        String(channelId),
      arena_chat_id:     arenaChatId,
      challenger_id:     challenger.id,
      challenger_name:   challenger.username || challenger.first_name,
      target_id:         target?.id || null,
      target_name:       target ? (target.username || target.first_name) : null,
      status:            initialStatus,
      invite_link:       inviteLink,
      invite_expires_at: inviteExpiresAt,
      duration_minutes:  durationMinutes || 5,
      queue_position:    queuePos
    }]).select("id").single();
    if (error) throw error;
    battleId = data.id;
  } catch (e) {
    logger.warn(`[DissBattle] insert battle: ${e.message}`);
    return { ok: false, error: "DB-Fehler beim Erstellen des Battles." };
  }

  if (initialStatus === "queued") {
    // Channel-Posting fuer Queue-Hinweis
    const qTxt =
      `⏳ <b>Diss Battle in Warteschlange</b>\n\n` +
      (target
        ? `🥊 @${_esc(challenger.username || challenger.first_name)} ⚔️ @${_esc(target.username || target.first_name)}\n\n`
        : `🥊 @${_esc(challenger.username || challenger.first_name)} sucht einen Gegner.\n\n`) +
      `📋 Position in der Warteschlange: <b>${queuePos}</b>\n\n` +
      `<i>Sobald das aktuelle Battle beendet ist, wird automatisch die nächste Einladung verschickt.</i>`;
    try {
      const sent = await tg.call("sendMessage", {
        chat_id: String(channelId),
        text:    qTxt,
        parse_mode: "HTML"
      });
      const msgId = sent?.result?.message_id || sent?.message_id;
      if (msgId) {
        await supabase.from("channel_diss_battles").update({ channel_announce_msg_id: msgId }).eq("id", battleId);
      }
    } catch (_) {}

    logger.info(`[DissBattle] Battle #${battleId} in Queue (Position ${queuePos})`);
    return { ok: true, queued: true, battle: { id: battleId, queuePos } };
  }

  // ─── status 'pending': Channel-Posting mit Join-Button ────────────────────
  const announceResult = await _postChannelAnnouncement(tg, supabase, {
    battleId, channelId, challenger, target, inviteLink, durationMinutes: durationMinutes || 5
  });

  if (!announceResult.ok) {
    // Cleanup: Battle wieder loeschen
    await supabase.from("channel_diss_battles").delete().eq("id", battleId);
    return { ok: false, error: announceResult.error };
  }

  // Auto-Expire-Timer: 5 Min lang darauf warten dass beide joinen
  const cancelTimer = setTimeout(() => cancelIfStillWaiting(tg, supabase, battleId)
    .catch(e => logger.warn(`[DissBattle] auto-cancel: ${e.message}`)), 5 * 60 * 1000);
  _battleTimers.set(`waiting:${battleId}`, cancelTimer);

  logger.info(`[DissBattle] Neues Battle #${battleId} pending in Arena ${arenaChatId} (Challenger: ${_displayName(challenger)}, Target: ${target ? _displayName(target) : "OFFEN"})`);

  return {
    ok:        true,
    battle:    { id: battleId, inviteLink, durationMinutes: durationMinutes || 5 },
    inviteLink
  };
}

/**
 * Postet die Channel-Ankuendigung mit Join-Button.
 * Wird sowohl beim initialen createBattle aufgerufen als auch beim Aktivieren
 * eines queued-Battles via _activateNextInQueue.
 */
async function _postChannelAnnouncement(tg, supabase, {
  battleId, channelId, challenger, target, inviteLink, durationMinutes
}) {
  const chName = _esc(challenger.username || challenger.first_name);
  const tgName = target ? _esc(target.username || target.first_name) : null;

  const isDirect = !!target;
  const txt = isDirect
    ? `⚔️ <b>DISS BATTLE — HERAUSFORDERUNG</b> ⚔️\n\n` +
      `🥊 @${chName} fordert @${tgName} heraus!\n\n` +
      `⏱ Battle-Dauer: <b>${durationMinutes} Min</b>\n` +
      `🕐 Einladung gültig: <b>5 Minuten</b>\n\n` +
      `Beide klicken auf den Button um zur Arena zu gehen. Sobald <b>beide</b> dort sind, startet das Battle automatisch.`
    : `⚔️ <b>OFFENES DISS BATTLE</b> ⚔️\n\n` +
      `🥊 @${chName} sucht einen Gegner!\n\n` +
      `⏱ Battle-Dauer: <b>${durationMinutes} Min</b>\n` +
      `🕐 Einladung gültig: <b>5 Minuten</b>\n\n` +
      `Jeder kann die Herausforderung annehmen. Klick auf den Button um zur Arena zu gehen.`;

  const kb = [
    [{ text: isDirect ? "🥊 Battle annehmen" : "🥊 Herausforderung annehmen",
       callback_data: `dissjoin_${battleId}` }],
    [{ text: "❌ Abbrechen", callback_data: `disscancel_${battleId}` }]
  ];

  try {
    const sent = await tg.call("sendMessage", {
      chat_id:      String(channelId),
      text:         txt,
      parse_mode:   "HTML",
      reply_markup: { inline_keyboard: kb }
    });
    const msgId = sent?.result?.message_id || sent?.message_id;
    if (msgId) {
      await supabase.from("channel_diss_battles").update({ channel_announce_msg_id: msgId }).eq("id", battleId);
    }
    return { ok: true, msgId };
  } catch (e) {
    logger.warn(`[DissBattle] _postChannelAnnouncement: ${e.message}`);
    return { ok: false, error: "Konnte Ankündigung im Channel nicht posten: " + e.message };
  }
}

/**
 * Cancellt ein Battle wenn nach Ablauf der Invite-Gueltigkeit
 * nicht beide Spieler beigetreten sind.
 */
async function cancelIfStillWaiting(tg, supabase, battleId) {
  const { data: b } = await supabase.from("channel_diss_battles").select("*").eq("id", battleId).maybeSingle();
  if (!b || (b.status !== "pending" && b.status !== "queued")) return;
  await supabase.from("channel_diss_battles").update({
    status: "expired", ended_at: new Date().toISOString()
  }).eq("id", battleId);

  // Channel-Ankündigung editieren (statt neue Nachricht)
  if (b.channel_announce_msg_id) {
    try {
      await tg.call("editMessageText", {
        chat_id: b.channel_id,
        message_id: b.channel_announce_msg_id,
        text: `⏰ <b>Diss Battle abgelaufen</b>\n\nDie Einladung von ${_esc(b.challenger_name ? "@"+b.challenger_name : "User "+b.challenger_id)} ist nach 5 Minuten ohne Beitritt abgelaufen.`,
        parse_mode: "HTML"
      });
    } catch (_) {
      // Fallback: neue Nachricht
      try {
        await tg.call("sendMessage", {
          chat_id: b.channel_id,
          text: `⏰ <b>Diss Battle abgelaufen</b>\n\nDie Einladung von ${_esc(b.challenger_name ? "@"+b.challenger_name : "User "+b.challenger_id)} ist nach 5 Minuten abgelaufen.`,
          parse_mode: "HTML"
        });
      } catch (_) {}
    }
  }
  _battleTimers.delete(`waiting:${battleId}`);

  // Naechstes queued-Battle aktivieren
  void _activateNextInQueue(tg, supabase, b.arena_chat_id, b.channel_id).catch(()=>{});
}

// ───────────────────────────────────────────────────────────────────────────
// Arena-Events: User joint die Arena
// ───────────────────────────────────────────────────────────────────────────

async function handleArenaJoin(tg, supabase, chatMember) {
  const arenaId = chatMember?.chat?.id;
  if (!arenaId) return;

  // Suche das pending-Battle dieser Arena (1.6.76: keine 'waiting_join' mehr)
  const { data: battle } = await supabase.from("channel_diss_battles")
    .select("*")
    .eq("arena_chat_id", String(arenaId))
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!battle) return;

  const newMember = chatMember.new_chat_member;
  const oldStatus = chatMember.old_chat_member?.status;
  const newStatus = newMember?.status;
  if (oldStatus !== "left" && oldStatus !== "kicked") return;
  if (newStatus !== "member" && newStatus !== "restricted") return;

  const userId = newMember?.user?.id;
  if (!userId) return;

  const isChallenger = (userId === battle.challenger_id);
  const isTarget     = (battle.target_id && userId === battle.target_id);

  if (!isChallenger && !isTarget) {
    // Unbekannter Joiner -> kurz kicken (z.B. jemand der einen alten Link irgendwo hat)
    try {
      await tg.call("banChatMember", {
        chat_id: arenaId, user_id: userId, until_date: Math.floor(Date.now()/1000) + 30
      });
    } catch (_) {}
    return;
  }

  // Join-Flag setzen
  const joins = battle.joined_users || {};
  joins[String(userId)] = true;
  const requiredIds = [battle.challenger_id, battle.target_id].filter(Boolean).map(String);
  const allJoined = requiredIds.length === 2 && requiredIds.every(id => joins[id]);

  await supabase.from("channel_diss_battles").update({
    joined_users: joins
  }).eq("id", battle.id);

  if (allJoined) {
    // Beide drin → Battle startet jetzt wirklich (= Arena wird gesperrt für andere Battles)
    await startBattle(tg, supabase, battle.id);
  } else {
    try {
      await tg.call("sendMessage", {
        chat_id: arenaId,
        text: `👋 Willkommen, ${_esc(_displayName(newMember.user))}!\n\nWarte auf den zweiten Spieler...`,
        parse_mode: "HTML"
      });
    } catch (_) {}
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Battle starten
// ───────────────────────────────────────────────────────────────────────────

async function startBattle(tg, supabase, battleId) {
  const { data: b } = await supabase.from("channel_diss_battles").select("*").eq("id", battleId).maybeSingle();
  if (!b || b.status !== "waiting_join") return;

  const now = new Date();
  const endsAt = new Date(now.getTime() + (b.duration_minutes || 10) * 60 * 1000);

  await supabase.from("channel_diss_battles").update({
    status: "active",
    started_at: now.toISOString(),
    ends_at: endsAt.toISOString()
  }).eq("id", battleId);

  // Waiting-Timer cancellen
  const waitingTimer = _battleTimers.get(`waiting:${battleId}`);
  if (waitingTimer) { clearTimeout(waitingTimer); _battleTimers.delete(`waiting:${battleId}`); }

  // End-Timer setzen
  const endTimer = setTimeout(() => finalizeBattle(tg, supabase, battleId)
    .catch(e => logger.warn(`[DissBattle] finalize ${battleId}: ${e.message}`)), (b.duration_minutes || 10) * 60 * 1000);
  _battleTimers.set(battleId, endTimer);

  // Battle-Start in der Arena ankuendigen
  const p1 = b.challenger_name ? "@" + b.challenger_name : "Spieler 1";
  const p2 = b.target_name     ? "@" + b.target_name     : "Spieler 2";
  try {
    await tg.call("sendMessage", {
      chat_id: b.arena_chat_id,
      text:
        `⚔️ <b>DISS BATTLE START!</b>\n\n` +
        `${_esc(p1)} 🆚 ${_esc(p2)}\n\n` +
        `⏱ Dauer: <b>${b.duration_minutes} Minuten</b>\n` +
        `🔥 Schreibt eure besten Disses, Beleidigungen und Wortspiele!\n\n` +
        `<i>Nach Ablauf der Zeit bewertet Grok-AI Witz, Wortschatz und Einfallsreichtum und kuert den Gewinner.</i>\n\n` +
        `Los geht's! 🎤`,
      parse_mode: "HTML"
    });
  } catch (e) {
    logger.warn(`[DissBattle] Start-Ankuendigung: ${e.message}`);
  }

  // Auch im Original-Channel kurz informieren
  try {
    await tg.call("sendMessage", {
      chat_id: b.channel_id,
      text: `⚔️ Das Diss Battle zwischen ${_esc(p1)} und ${_esc(p2)} hat begonnen!`,
      parse_mode: "HTML"
    });
  } catch (_) {}

  logger.info(`[DissBattle] Battle #${battleId} GESTARTET — endet in ${b.duration_minutes}min`);
}

// ───────────────────────────────────────────────────────────────────────────
// Nachrichten in der Arena tracken (waehrend "active")
// ───────────────────────────────────────────────────────────────────────────

async function trackArenaMessage(supabase, msg) {
  if (!msg?.chat?.id || !msg.from?.id) return;
  const arenaId = msg.chat.id;

  const battle = await _findActiveBattleInArena(supabase, arenaId);
  if (!battle || battle.status !== "active") return;

  const content = msg.text || msg.caption || "";
  if (!content.trim()) return;

  // Nur Teilnehmer-Nachrichten loggen
  const uid = msg.from.id;
  if (uid !== battle.challenger_id && uid !== battle.target_id) return;

  try {
    await supabase.from("channel_diss_battle_messages").insert([{
      battle_id:   battle.id,
      user_id:     uid,
      username:    msg.from.username || msg.from.first_name,
      content:     String(content).substring(0, 2000),
      message_id:  msg.message_id
    }]);
    await supabase.from("channel_diss_battles")
      .update({ msg_count: (battle.msg_count || 0) + 1 })
      .eq("id", battle.id);
  } catch (e) {
    logger.warn(`[DissBattle] trackArenaMessage: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Battle beenden, Grok auswerten, Ranking aktualisieren
// ───────────────────────────────────────────────────────────────────────────

async function finalizeBattle(tg, supabase, battleId) {
  const timer = _battleTimers.get(battleId);
  if (timer) { clearTimeout(timer); _battleTimers.delete(battleId); }

  const { data: b } = await supabase.from("channel_diss_battles").select("*").eq("id", battleId).maybeSingle();
  if (!b) return;
  if (b.status === "finished" || b.status === "cancelled") return;

  // Status -> judging damit nicht doppelt evaluiert wird
  await supabase.from("channel_diss_battles").update({ status: "judging" }).eq("id", battleId);

  // Beide Spieler in der Arena restricten (read-only) — sie sind ab jetzt Zuschauer
  const restrictPerms = {
    can_send_messages:        false,
    can_send_audios:          false,
    can_send_documents:       false,
    can_send_photos:          false,
    can_send_videos:          false,
    can_send_video_notes:     false,
    can_send_voice_notes:     false,
    can_send_polls:           false,
    can_send_other_messages:  false,
    can_add_web_page_previews: false
  };
  for (const uid of [b.challenger_id, b.target_id].filter(Boolean)) {
    try {
      await tg.call("restrictChatMember", {
        chat_id:     b.arena_chat_id,
        user_id:     uid,
        permissions: restrictPerms
      });
    } catch (e) {
      logger.warn(`[DissBattle] restrict ${uid}: ${e.message}`);
    }
  }

  // Nachrichten laden
  const { data: msgs } = await supabase.from("channel_diss_battle_messages")
    .select("user_id, username, content, sent_at")
    .eq("battle_id", battleId)
    .order("sent_at", { ascending: true });

  // Wenn niemand was gesagt hat: Battle als gescheitert markieren
  if (!msgs?.length) {
    await supabase.from("channel_diss_battles").update({
      status:    "cancelled",
      ended_at:  new Date().toISOString(),
      ai_verdict:   "Keine Nachrichten — Battle wertet ohne Sieger.",
      ai_highlight: "(kein Inhalt)"
    }).eq("id", battleId);
    try {
      await tg.call("sendMessage", {
        chat_id: b.arena_chat_id,
        text: "🤐 Das Battle ist vorbei — aber niemand hat ein Wort gesagt. Kein Sieger.",
        parse_mode: "HTML"
      });
      await tg.call("sendMessage", {
        chat_id: b.channel_id,
        text: "🤐 Diss Battle beendet — keiner der beiden hat etwas geschrieben.",
        parse_mode: "HTML"
      });
    } catch (_) {}
    return;
  }

  // Grok-Auswertung
  const verdict = await _judgeWithGrok(b, msgs);

  // Sieger ermitteln
  let winnerId = null, winnerName = null, loserId = null, loserName = null;
  if (verdict.winner_user_id) {
    winnerId = verdict.winner_user_id;
    if (winnerId === b.challenger_id) {
      winnerName = b.challenger_name; loserId = b.target_id;     loserName = b.target_name;
    } else {
      winnerName = b.target_name;     loserId = b.challenger_id; loserName = b.challenger_name;
    }
  }

  // Battle finalisieren
  await supabase.from("channel_diss_battles").update({
    status:       "finished",
    ended_at:     new Date().toISOString(),
    winner_id:    winnerId,
    winner_name:  winnerName,
    ai_verdict:   verdict.full_text,
    ai_highlight: verdict.highlight,
    ai_scores:    verdict.scores || null
  }).eq("id", battleId);

  // Ranking aktualisieren: Gewinner +1, Verlierer -1 (nur wenn Score > 0)
  if (winnerId && loserId) {
    await _updateScores(supabase, b.channel_id, winnerId, winnerName, loserId, loserName);
  }

  // Ergebnis in der Arena posten (ausfuehrlich)
  try {
    const winnerLabel = winnerName ? "@" + winnerName : "Unentschieden";
    await tg.call("sendMessage", {
      chat_id: b.arena_chat_id,
      text:
        `🏆 <b>BATTLE ENDE — Ergebnis</b>\n\n` +
        `👑 Sieger: <b>${_esc(winnerLabel)}</b>\n\n` +
        `<b>Bewertung:</b>\n${_esc(verdict.full_text).substring(0, 3500)}\n\n` +
        `<i>🎤 Highlight: ${_esc(verdict.highlight || "—").substring(0, 300)}</i>\n\n` +
        `Beide Teilnehmer sind nun nur noch Zuschauer in dieser Arena.`,
      parse_mode: "HTML"
    });
  } catch (e) {
    logger.warn(`[DissBattle] Ergebnis-Post Arena: ${e.message}`);
  }

  // Im Original-Channel kurze Bestaetigung
  try {
    const winnerLabel = winnerName ? "@" + winnerName : "Unentschieden";
    const challengerLabel = b.challenger_name ? "@" + b.challenger_name : "Spieler 1";
    const targetLabel     = b.target_name     ? "@" + b.target_name     : "Spieler 2";
    await tg.call("sendMessage", {
      chat_id: b.channel_id,
      text:
        `🏆 <b>Diss Battle beendet</b>\n\n` +
        `${_esc(challengerLabel)} 🆚 ${_esc(targetLabel)}\n` +
        `Gewinner: <b>${_esc(winnerLabel)}</b>\n\n` +
        `🎤 Highlight: <i>${_esc(verdict.highlight || "—").substring(0, 250)}</i>\n\n` +
        `<i>Mit /topdiss siehst du das Channel-Ranking.</i>`,
      parse_mode: "HTML"
    });
  } catch (e) {
    logger.warn(`[DissBattle] Ergebnis-Post Channel: ${e.message}`);
  }

  logger.info(`[DissBattle] Battle #${battleId} FINISHED — Gewinner: ${winnerName || "(none)"}`);

  // (1.6.76) Naechstes Battle in der Warteschlange aktivieren falls vorhanden
  void _activateNextInQueue(tg, supabase, b.arena_chat_id, b.channel_id).catch(e => {
    logger.warn(`[DissBattle] _activateNextInQueue: ${e.message}`);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Grok-AI-Auswertung
// ───────────────────────────────────────────────────────────────────────────

async function _judgeWithGrok(battle, msgs) {
  // Transcript bauen — pro Nachricht: "@user: <text>"
  const lines = msgs.map(m => `@${m.username || m.user_id}: ${m.content}`);
  const transcript = lines.join("\n").substring(0, 8000);

  const p1Name = battle.challenger_name || `User_${battle.challenger_id}`;
  const p2Name = battle.target_name     || `User_${battle.target_id}`;

  const systemPrompt =
    `Du bist ein Battle-Rap-Juror in einem Diss-Battle. Du bewertest zwei Spieler nach folgenden Kriterien:\n` +
    `- Wortwitz / Einfallsreichtum\n` +
    `- Wortschatz / Sprachgewandtheit\n` +
    `- Rhythmus & Pointen\n` +
    `- Schlagfertigkeit (Reaktion auf gegnerische Disses)\n` +
    `- Kreativitaet der Beleidigungen\n\n` +
    `Vergib pro Kriterium 0-10 Punkte fuer jeden Spieler. Kuere den Sieger mit hoeherem Gesamtscore.\n` +
    `Bei Gleichstand: Sieger durch Highlight-Moment.\n\n` +
    `Antworte AUSSCHLIESSLICH als JSON ohne Wrapper:\n` +
    `{\n` +
    `  "winner": "@${p1Name}" oder "@${p2Name}" oder "tie",\n` +
    `  "scores": {\n` +
    `    "@${p1Name}": {"witz": 0-10, "wortschatz": 0-10, "rhythmus": 0-10, "schlagfertigkeit": 0-10, "kreativitaet": 0-10},\n` +
    `    "@${p2Name}": {"witz": 0-10, "wortschatz": 0-10, "rhythmus": 0-10, "schlagfertigkeit": 0-10, "kreativitaet": 0-10}\n` +
    `  },\n` +
    `  "highlight": "Ein zitiertes Highlight aus dem Battle (max 200 Zeichen, mit Spielername)",\n` +
    `  "verdict": "Ausfuehrliche Begruendung warum dieser Sieger gekuert wurde (300-600 Zeichen, auf Deutsch, mit konkreten Verweisen auf Lines)"\n` +
    `}`;

  const userPrompt =
    `Diss Battle Transcript:\n${p1Name} vs ${p2Name}\n\n${transcript}\n\nBewerte und kuere den Sieger.`;

  try {
    const res = await xaiService.chat([
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ], { model: "grok-4.20-0309-non-reasoning", max_tokens: 1500, temperature: 0.7 });

    const txt = res?.content || res?.text || "";
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Keine JSON-Antwort von Grok");
    const parsed = JSON.parse(jsonMatch[0]);

    // Winner als TG-ID aufloesen
    let winnerUserId = null;
    const w = (parsed.winner || "").replace(/^@/, "").toLowerCase();
    if (w && w !== "tie") {
      if (w === String(p1Name).toLowerCase()) winnerUserId = battle.challenger_id;
      else if (w === String(p2Name).toLowerCase()) winnerUserId = battle.target_id;
    }

    return {
      winner_user_id: winnerUserId,
      scores:         parsed.scores || null,
      highlight:      String(parsed.highlight || "").substring(0, 400),
      full_text:      String(parsed.verdict || "(keine Begruendung)").substring(0, 2000)
    };
  } catch (e) {
    logger.warn(`[DissBattle] Grok-Fehler: ${e.message}`);
    // Fallback: meiste Nachrichten = Sieger
    const counts = {};
    for (const m of msgs) counts[m.user_id] = (counts[m.user_id] || 0) + 1;
    const ids = Object.keys(counts);
    const wId = ids.length ? parseInt(ids.sort((a,b) => counts[b]-counts[a])[0]) : null;
    return {
      winner_user_id: wId,
      scores:         null,
      highlight:      "(AI-Bewertung nicht verfuegbar — Sieger nach Nachrichtenzahl)",
      full_text:      "Die AI-Bewertung war leider nicht moeglich. Sieger wurde nach Anzahl der Beitraege ermittelt."
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Ranking aktualisieren
// ───────────────────────────────────────────────────────────────────────────

async function _updateScores(supabase, channelId, winnerId, winnerName, loserId, loserName) {
  // Gewinner: +1
  await _upsertScore(supabase, channelId, winnerId, winnerName, +1, "win");
  // Verlierer: -1 (nur wenn Score zuvor > 0)
  await _upsertScore(supabase, channelId, loserId, loserName, -1, "loss");
}

async function _upsertScore(supabase, channelId, userId, username, delta, kind) {
  if (!userId) return;
  try {
    const { data: current } = await supabase.from("channel_diss_scores")
      .select("*")
      .eq("channel_id", String(channelId))
      .eq("user_id", userId)
      .maybeSingle();

    const newScore = current
      ? Math.max(0, (current.score || 0) + (delta < 0 && current.score <= 0 ? 0 : delta))
      : Math.max(0, delta);
    const wins   = (current?.wins   || 0) + (kind === "win"  ? 1 : 0);
    const losses = (current?.losses || 0) + (kind === "loss" ? 1 : 0);

    await supabase.from("channel_diss_scores").upsert([{
      channel_id:  String(channelId),
      user_id:     userId,
      username:    username,
      score:       newScore,
      wins, losses,
      last_battle: new Date().toISOString(),
      updated_at:  new Date().toISOString()
    }], { onConflict: "channel_id,user_id" });
  } catch (e) {
    logger.warn(`[DissBattle] _upsertScore: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// /topdiss — Ranking abfragen
// ───────────────────────────────────────────────────────────────────────────

async function getTopDissers(supabase, channelId, limit = 10) {
  const { data } = await supabase.from("channel_diss_scores")
    .select("user_id, username, score, wins, losses")
    .eq("channel_id", String(channelId))
    .gt("score", 0)
    .order("score", { ascending: false })
    .order("wins", { ascending: false })
    .limit(limit);
  return data || [];
}

// ─── (1.6.76) Button-Callbacks ──────────────────────────────────────────────

/**
 * Wird vom callbackHandler aufgerufen bei "dissjoin_<battleId>".
 * Berechtigung pruefen + Arena-Link via answerCallbackQuery.url an User schicken.
 */
async function handleJoinClick(tg, supabase, battleId, fromUser, callbackQueryId) {
  const { data: b } = await supabase.from("channel_diss_battles").select("*").eq("id", battleId).maybeSingle();
  if (!b) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId, text: "❌ Battle nicht gefunden.", show_alert: true
    }).catch(() => {});
    return;
  }
  if (b.status !== "pending") {
    const txt = b.status === "queued"
      ? "⏳ Dieses Battle steht in der Warteschlange — sobald die Arena frei ist, geht es los."
      : b.status === "expired" || b.status === "cancelled"
        ? "⏰ Diese Einladung ist abgelaufen."
        : b.status === "active" || b.status === "judging"
          ? "▶️ Das Battle läuft bereits."
          : b.status === "finished"
            ? "🏁 Das Battle ist bereits beendet."
            : `Battle-Status: ${b.status}`;
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId, text: txt, show_alert: true
    }).catch(() => {});
    return;
  }

  // Berechtigungs-Check
  const userId   = fromUser.id;
  const userName = fromUser.username || fromUser.first_name;
  const isChallenger = (userId === b.challenger_id);
  const isTarget     = (b.target_id && userId === b.target_id);
  const isOpen       = !b.target_id;

  if (!isChallenger && !isTarget && !isOpen) {
    // Direkt-Einladung: weder Challenger noch Target -> nicht erlaubt
    const tgName = b.target_name ? "@" + b.target_name : "den eingeladenen Spieler";
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: `❌ Diese Einladung ist nur für ${tgName} bestimmt.`,
      show_alert: true
    }).catch(() => {});
    return;
  }

  // Bei offener Runde: ersten klickenden User als target setzen (atomisch)
  if (isOpen && !isChallenger) {
    const { data: updated, error } = await supabase.from("channel_diss_battles")
      .update({ target_id: userId, target_name: userName })
      .eq("id", battleId)
      .eq("status", "pending")
      .is("target_id", null)
      .select("*").maybeSingle();
    if (error || !updated) {
      // Jemand anderes war schneller
      await tg.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "❌ Jemand anderes war schneller — die Herausforderung wurde bereits angenommen.",
        show_alert: true
      }).catch(() => {});
      return;
    }
    b.target_id = userId; b.target_name = userName;

    // Channel-Nachricht editieren: jetzt mit beiden Namen
    if (b.channel_announce_msg_id) {
      try {
        await tg.call("editMessageText", {
          chat_id:    b.channel_id,
          message_id: b.channel_announce_msg_id,
          text:
            `⚔️ <b>DISS BATTLE — angenommen</b> ⚔️\n\n` +
            `🥊 @${_esc(b.challenger_name)} ⚔️ @${_esc(userName)}\n\n` +
            `⏱ Battle-Dauer: <b>${b.duration_minutes} Min</b>\n\n` +
            `<i>Beide Spieler haben jetzt 5 Minuten Zeit zur Arena zu gehen. Sobald beide da sind, beginnt das Battle.</i>`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "🥊 Zur Arena", callback_data: `dissjoin_${battleId}` }]
          ]}
        });
      } catch (_) {}
    }
  } else if (isOpen && isChallenger) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: "ℹ️ Du hast die Herausforderung selbst gestartet. Warte auf einen Herausforderer.",
      show_alert: true
    }).catch(() => {});
    return;
  }

  // Hat User schon gejoint?
  const joins = b.joined_users || {};
  if (joins[String(userId)]) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: "ℹ️ Du bist bereits in der Arena. Warte auf den anderen Spieler."
    }).catch(() => {});
    return;
  }

  // Invite-Link senden via answerCallbackQuery URL → oeffnet Telegram-Join-Dialog
  if (!b.invite_link) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: "❌ Es ist kein Einladungslink verfügbar. Battle abbrechen + neu erstellen.",
      show_alert: true
    }).catch(() => {});
    return;
  }
  try {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      url: b.invite_link
    });
  } catch (e) {
    // Fallback: Link als Alert anzeigen
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: "🔗 Arena-Link: " + b.invite_link,
      show_alert: true
    }).catch(() => {});
  }
}

/**
 * Wird vom callbackHandler aufgerufen bei "disscancel_<battleId>".
 * Nur der Challenger kann ein Battle abbrechen.
 */
async function handleCancelClick(tg, supabase, battleId, fromUser, callbackQueryId) {
  const { data: b } = await supabase.from("channel_diss_battles").select("*").eq("id", battleId).maybeSingle();
  if (!b) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId, text: "❌ Battle nicht gefunden.", show_alert: true
    }).catch(() => {});
    return;
  }
  if (b.status !== "pending" && b.status !== "queued") {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId, text: "❌ Dieses Battle kann nicht mehr abgebrochen werden.", show_alert: true
    }).catch(() => {});
    return;
  }
  if (fromUser.id !== b.challenger_id) {
    await tg.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId, text: "❌ Nur der Initiator kann das Battle abbrechen.", show_alert: true
    }).catch(() => {});
    return;
  }

  await supabase.from("channel_diss_battles").update({
    status: "cancelled", ended_at: new Date().toISOString()
  }).eq("id", battleId);

  // Channel-Ankündigung editieren
  if (b.channel_announce_msg_id) {
    try {
      await tg.call("editMessageText", {
        chat_id:    b.channel_id,
        message_id: b.channel_announce_msg_id,
        text:       `❌ <b>Diss Battle abgebrochen</b> von @${_esc(b.challenger_name || b.challenger_id)}.`,
        parse_mode: "HTML"
      });
    } catch (_) {}
  }

  const waitTimer = _battleTimers.get(`waiting:${battleId}`);
  if (waitTimer) { clearTimeout(waitTimer); _battleTimers.delete(`waiting:${battleId}`); }

  await tg.call("answerCallbackQuery", {
    callback_query_id: callbackQueryId, text: "✅ Abgebrochen."
  }).catch(() => {});

  // Naechstes queued-Battle aktivieren
  void _activateNextInQueue(tg, supabase, b.arena_chat_id, b.channel_id).catch(()=>{});
}

/**
 * Nach Battle-Ende oder Abbruch: pruefe Warteschlange dieser Arena und
 * aktiviere das vorderste queued-Battle (status='queued' -> 'pending'+Channel-Posting).
 */
async function _activateNextInQueue(tg, supabase, arenaChatId, originalChannelIdHint) {
  // Stelle sicher dass keine 'active'/'pending' Battles existieren
  const activeBlocker = await _findActiveBattleInArena(supabase, arenaChatId);
  if (activeBlocker) return;
  const pendingExists = await supabase.from("channel_diss_battles")
    .select("id").eq("arena_chat_id", String(arenaChatId)).eq("status", "pending").limit(1).maybeSingle();
  if (pendingExists?.data) return;

  // Naechstes queued-Battle
  const { data: next } = await supabase.from("channel_diss_battles")
    .select("*")
    .eq("arena_chat_id", String(arenaChatId))
    .eq("status", "queued")
    .order("queue_position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  if (!next) return;

  // Invite-Link erstellen
  let inviteLink = null;
  let inviteExpiresAt = null;
  try {
    const expire = Math.floor(Date.now() / 1000) + 5 * 60;
    const resp = await tg.call("createChatInviteLink", {
      chat_id: arenaChatId,
      name: `DissBattle ${Date.now()}`,
      expire_date: expire,
      member_limit: 2,
      creates_join_request: false
    });
    inviteLink = resp?.invite_link || resp?.result?.invite_link;
    inviteExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  } catch (e) {
    logger.warn(`[DissBattle] queue activate - createChatInviteLink: ${e.message}`);
    // Cancel das queued-Battle (Arena nicht erreichbar)
    await supabase.from("channel_diss_battles").update({
      status: "cancelled", ended_at: new Date().toISOString()
    }).eq("id", next.id);
    return;
  }
  if (!inviteLink) return;

  // Status auf 'pending' setzen
  await supabase.from("channel_diss_battles").update({
    status: "pending",
    invite_link: inviteLink,
    invite_expires_at: inviteExpiresAt,
    queue_position: 0
  }).eq("id", next.id);

  // Channel-Posting (alte Queue-Nachricht ersetzen ODER neue posten)
  const challenger = { id: next.challenger_id, username: next.challenger_name };
  const target     = next.target_id ? { id: next.target_id, username: next.target_name } : null;

  if (next.channel_announce_msg_id) {
    // Alte Queue-Nachricht editieren
    const chName = _esc(next.challenger_name);
    const tgName = next.target_name ? _esc(next.target_name) : null;
    const isDirect = !!next.target_id;
    const txt = isDirect
      ? `⚔️ <b>DISS BATTLE — JETZT BEREIT</b> ⚔️\n\n` +
        `🥊 @${chName} ⚔️ @${tgName}\n\n` +
        `⏱ Dauer: <b>${next.duration_minutes} Min</b>\n` +
        `🕐 Einladung: <b>5 Minuten</b>\n\n` +
        `Beide klicken jetzt auf den Button um zur Arena zu gehen.`
      : `⚔️ <b>OFFENES DISS BATTLE — JETZT BEREIT</b> ⚔️\n\n` +
        `🥊 @${chName} sucht einen Gegner!\n\n` +
        `⏱ Dauer: <b>${next.duration_minutes} Min</b>\n\n` +
        `Klick auf den Button um die Herausforderung anzunehmen.`;
    try {
      await tg.call("editMessageText", {
        chat_id: next.channel_id,
        message_id: next.channel_announce_msg_id,
        text: txt, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: isDirect ? "🥊 Battle annehmen" : "🥊 Herausforderung annehmen",
             callback_data: `dissjoin_${next.id}` }],
          [{ text: "❌ Abbrechen", callback_data: `disscancel_${next.id}` }]
        ]}
      });
    } catch (_) {
      // Fallback: neue Ankündigung
      await _postChannelAnnouncement(tg, supabase, {
        battleId: next.id, channelId: next.channel_id,
        challenger, target, inviteLink, durationMinutes: next.duration_minutes
      });
    }
  } else {
    await _postChannelAnnouncement(tg, supabase, {
      battleId: next.id, channelId: next.channel_id,
      challenger, target, inviteLink, durationMinutes: next.duration_minutes
    });
  }

  // Auto-Cancel-Timer 5 Min
  const cancelTimer = setTimeout(() => cancelIfStillWaiting(tg, supabase, next.id).catch(() => {}), 5 * 60 * 1000);
  _battleTimers.set(`waiting:${next.id}`, cancelTimer);

  // Queue-Positionen aller verbleibenden 'queued' Battles dekrementieren
  await supabase.rpc('decrement_diss_queue_positions', { p_arena_chat_id: String(arenaChatId) }).catch(() => {
    // Falls die RPC nicht existiert: manuell via SELECT + UPDATE
    void (async () => {
      const { data: remaining } = await supabase.from("channel_diss_battles")
        .select("id, queue_position")
        .eq("arena_chat_id", String(arenaChatId))
        .eq("status", "queued");
      for (const r of (remaining || [])) {
        await supabase.from("channel_diss_battles").update({
          queue_position: Math.max(1, (r.queue_position || 0) - 1)
        }).eq("id", r.id);
      }
    })();
  });

  logger.info(`[DissBattle] Queue: Battle #${next.id} aktiviert (pending)`);
}

module.exports = {
  createBattle,
  handleArenaJoin,
  trackArenaMessage,
  startBattle,
  finalizeBattle,
  cancelIfStillWaiting,
  getTopDissers,
  handleJoinClick,
  handleCancelClick,
  _activateNextInQueue,
  _recoverActiveBattles
};
