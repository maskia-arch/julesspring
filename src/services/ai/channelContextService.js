/**
 * channelContextService.js v1.6.1
 * ============================================================================
 * Verknüpft Safelist, Scamliste und Feedbacks mit der channel_knowledge-KB.
 *
 * ZWEI Hauptaufgaben:
 *
 * 1. ENRICHMENT (beim Schreiben):
 *    Wenn ein User auf Safelist/Scamliste kommt oder ein Feedback bestätigt
 *    wird, ruft OpenAI bestehende Infos zu dieser Person ab, validiert und
 *    fasst alles zusammen → schreibt einen `channel_knowledge`-Eintrag.
 *    Kategorie: "safelist" | "scamlist" | "feedback"
 *    Source:    "safelist_sync" | "scamlist_sync" | "feedback_sync"
 *
 * 2. LIVE-KONTEXT (beim Antworten):
 *    Smalltalk-Agent ruft `getContextForQuery()` auf bevor er antwortet.
 *    Gibt strukturierten Text zurück: Safelist-Status, Scam-Status, Reputation,
 *    Top-Feedbacks — alles was der AI helfen kann, eine faktisch korrekte
 *    Antwort zu geben.
 * ============================================================================
 */

const axios    = require('axios');
const supabase = require('../../config/supabase');
const logger   = require('../../utils/logger');

// Usernames aus einem Text extrahieren (@handles)
function _extractUsernames(text) {
  const matches = text.match(/@([\w]{3,32})/gi) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

// ─── 1. ENRICHMENT ──────────────────────────────────────────────────────────

/**
 * Wird aufgerufen wenn ein User zur Safelist/Scamliste hinzugefügt wird
 * ODER ein Feedback bestätigt wird.
 *
 * Lädt alle verfügbaren Infos zur Person (Safelist-Status, Scam-Einträge,
 * Feedbacks, bestehende KB-Einträge) und lässt OpenAI einen kompakten,
 * sachlichen Zusammenfassungs-Eintrag erstellen.
 *
 * @param {string}  channelId
 * @param {object}  person    { username?, userId? }
 * @param {'safelist'|'scamlist'|'feedback'} triggerType
 */
async function enrichPersonKnowledge(channelId, person, triggerType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const username = person.username?.toLowerCase()?.replace(/^@/, '') || null;
  const userId   = person.userId   ? parseInt(person.userId)         : null;
  if (!username && !userId) return;

  const identifier = username ? `@${username}` : `User-ID ${userId}`;

  try {
    // ─── Alle Quellen parallel laden ────────────────────────────────────
    const [safeEntry, scamEntry, feedbacks, repData, existingKB] = await Promise.all([
      // Safelist
      supabase.from('channel_safelist').select('username, note, created_at')
        .eq('channel_id', String(channelId))
        .or(userId ? `user_id.eq.${userId}` : `username.eq.${username}`)
        .maybeSingle().then(r => r.data),

      // Scamliste
      supabase.from('scam_entries').select('username, reason, created_at')
        .eq('channel_id', String(channelId))
        .or(userId ? `user_id.eq.${userId}` : `username.eq.${username}`)
        .maybeSingle().then(r => r.data),

      // Feedbacks (max. 10 neueste, NUR bestätigte)
      supabase.from('user_feedbacks').select('feedback_type, feedback_text, status, created_at')
        .eq('channel_id', String(channelId))
        .or(userId ? `target_user_id.eq.${userId}` : `target_username.eq.${username}`)
        .eq('status', 'approved')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(10)
        .then(r => r.data || []),

      // Reputation-Score
      supabase.from('user_reputation').select('score, pos_count, neg_count')
        .eq('channel_id', String(channelId))
        .or(userId ? `user_id.eq.${userId}` : `username.eq.${username}`)
        .maybeSingle().then(r => r.data),

      // Bestehende KB-Einträge zu dieser Person (für Kontext + Deduplizierung)
      supabase.from('channel_knowledge').select('content')
        .eq('channel_id', String(channelId))
        .ilike('content', `%${username || userId}%`)
        .limit(5)
        .then(r => r.data || []),
    ]);

    // ─── Datenpunkte in lesbaren Text aufbereiten ────────────────────────
    const lines = [];

    if (safeEntry)  lines.push(`✅ Auf Safelist: Ja (Notiz: "${safeEntry.note || '–'}")`);
    else            lines.push(`✅ Auf Safelist: Nein`);

    if (scamEntry)  lines.push(`⛔ Auf Scamliste: Ja (Grund: "${scamEntry.reason || '–'}")`);
    else            lines.push(`⛔ Auf Scamliste: Nein`);

    if (repData)    lines.push(`📊 Reputation-Score: ${repData.score} (${repData.pos_count} positiv / ${repData.neg_count} negativ)`);

    if (feedbacks.length) {
      lines.push(`\n💬 Feedbacks (${feedbacks.length}):`);
      feedbacks.slice(0, 5).forEach(f => {
        const emoji = f.feedback_type === 'positive' ? '✅' : '⚠️';
        const status = f.status === 'approved' ? 'bestätigt' : 'ausstehend';
        lines.push(`  ${emoji} ${f.feedback_type === 'positive' ? 'Positiv' : 'Negativ'} [${status}]: "${(f.feedback_text || '').substring(0, 120)}"`);
      });
    }

    if (existingKB.length) {
      lines.push(`\n📚 Vorhandene KB-Einträge zu dieser Person:`);
      existingKB.forEach(e => lines.push(`  "${e.content.substring(0, 200)}"`));
    }

    const rawData = lines.join('\n');
    if (lines.length < 3) return; // Zu wenig Daten für sinnvollen Eintrag

    // ─── OpenAI Validierung + Zusammenfassung ───────────────────────────
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              'Du pflegst die interne Wissensdatenbank einer Telegram-Gruppe. ' +
              'Erstelle einen sachlichen, kompakten Eintrag über eine Person, ' +
              'der aus vorhandenen Daten destilliert wird. ' +
              'Maximal 3-5 Sätze. Keine Wertungen außer was die Daten klar zeigen. ' +
              'Erwähne immer: Safelist/Scam-Status, Reputation, wichtigste Feedbacks. ' +
              'Falls widersprüchliche Infos: weise darauf hin. ' +
              'Kein Vorwort, direkt mit dem Inhalt beginnen.'
          },
          {
            role: 'user',
            content:
              `Erstelle einen KB-Eintrag für ${identifier} basierend auf:\n\n${rawData}`
          }
        ]
      },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const summary = resp.data?.choices?.[0]?.message?.content?.trim();
    if (!summary || summary.length < 20) return;

    const fullContent = `[Mitglieder-Info] ${identifier}\n${summary}`;

    // ─── In channel_knowledge speichern (upsert auf title) ───────────────
    // Zuerst prüfen ob bereits ein KB-Eintrag für diese Person existiert
    const { data: existing } = await supabase.from('channel_knowledge')
      .select('id')
      .eq('channel_id', String(channelId))
      .eq('category', 'mitglieder')
      .ilike('title', `%${identifier}%`)
      .maybeSingle();

    if (existing) {
      // Aktualisieren
      await supabase.from('channel_knowledge').update({
        content: fullContent,
        source: `${triggerType}_sync`,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
    } else {
      // Neu anlegen
      await supabase.from('channel_knowledge').insert([{
        channel_id: String(channelId),
        category:   'mitglieder',
        title:      `${identifier} — Mitglieder-Profil`,
        content:    fullContent,
        source:     `${triggerType}_sync`,
        metadata:   { auto_generated: true, trigger: triggerType }
      }]);
    }

    // KB-Zähler aktualisieren
    const { count } = await supabase.from('channel_knowledge')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', String(channelId));
    await supabase.from('bot_channels')
      .update({ kb_entry_count: count || 0 }).eq('id', String(channelId)).catch(() => {});

    logger.info(`[ChannelCtx] KB-Eintrag für ${identifier} in Channel ${channelId} gespeichert (${triggerType})`);

  } catch (e) {
    logger.warn(`[ChannelCtx] enrichPersonKnowledge fehlgeschlagen für ${identifier}: ${e.message}`);
  }
}

// ─── 2. LIVE-KONTEXT für Smalltalk-Agent ────────────────────────────────────

/**
 * Wird vom Smalltalk-Agent vor der Antwort aufgerufen.
 * Extrahiert @usernames aus dem eingehenden Text, prüft Safelist/Scamliste
 * und holt die Top-Feedbacks — alles als strukturierten Kontext-String.
 *
 * @param {string} channelId
 * @param {string} query     - Die Frage/Nachricht des Users
 * @returns {string}         - Kontext-String für den AI-Prompt, oder ""
 */
// Keywords: allgemeine Safelist-Anfragen ohne @mention
const SAFELIST_QUERY_RE = /safelist|safeliste|safe\s*list|wer.*sicher|wer.*safe|wer.*trusted|wer.*vertrau|alle.*safe|wer steht|safe.*mitglieder/i;

async function getContextForQuery(channelId, query) {
  const usernames = _extractUsernames(query);

  // ── Allgemeine Safelist-Abfrage (kein @mention) ────────────────────────────
  if (!usernames.length && SAFELIST_QUERY_RE.test(query)) {
    try {
      const { data: safeList } = await supabase.from('channel_safelist')
        .select('username, note')
        .eq('channel_id', String(channelId))
        .order('created_at', { ascending: false })
        .limit(25);
      if (!safeList?.length) {
        return '\n\n📋 Channel-Safelist: Noch keine Einträge vorhanden.';
      }
      const list = safeList.map((e, i) =>
        `${i + 1}. @${e.username}${e.note ? ` (${e.note})` : ''}`
      ).join('\n');
      return (
        '\n\n⚠️ WICHTIG — Channelinternes Wissen:\n' +
        `📋 Channel-Safelist (${safeList.length} Einträge):\n${list}\n\n` +
        'Weise in deiner Antwort darauf hin dass diese Listung keine Garantie darstellt ' +
        'und keine Haftung übernommen wird. Nenne NUR die obigen Einträge — erfinde keine.'
      );
    } catch (_) { return ''; }
  }

  if (!usernames.length) return '';

  const contextParts = [];

  for (const username of usernames.slice(0, 3)) {
    try {
      const [safeEntry, scamEntry, repData, topFeedbacks] = await Promise.all([
        supabase.from('channel_safelist').select('note, created_at')
          .eq('channel_id', String(channelId))
          .ilike('username', username)
          .maybeSingle().then(r => r.data),

        supabase.from('scam_entries').select('reason, created_at')
          .eq('channel_id', String(channelId))
          .ilike('username', username)
          .maybeSingle().then(r => r.data),

        supabase.from('user_reputation').select('score, pos_count, neg_count')
          .eq('channel_id', String(channelId))
          .ilike('username', username)
          .maybeSingle().then(r => r.data),

        // NUR bestätigte, nicht gelöschte Feedbacks
        supabase.from('user_feedbacks').select('feedback_type, feedback_text')
          .eq('channel_id', String(channelId))
          .ilike('target_username', username)
          .eq('status', 'approved')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(3)
          .then(r => r.data || []),
      ]);

      if (!safeEntry && !scamEntry && !repData && !topFeedbacks.length) continue;

      const lines = [`📋 Channelinternes Wissen über @${username}:`];

      if (safeEntry) {
        lines.push(`  ✅ Steht auf der CHANNEL-SAFELIST${safeEntry.note ? ` (Notiz: "${safeEntry.note}")` : ''} — von Channel-Admin als vertrauenswürdig eingestuft.`);
        lines.push(`  ⚠️ Weise darauf hin: Diese Listung stellt keine Garantie dar, keine Haftung übernommen.`);
      } else if (scamEntry) {
        lines.push(`  ⛔ Steht auf der CHANNEL-SCAMLISTE${scamEntry.reason ? ` (Grund: "${scamEntry.reason}")` : ''} — von Channel-Admin als Scammer markiert.`);
      }

      if (repData) {
        lines.push(`  📊 Reputation: ${repData.score > 0 ? '+' : ''}${repData.score} Punkte (${repData.pos_count} positiv, ${repData.neg_count} negativ)`);
      }

      if (topFeedbacks.length) {
        const pos = topFeedbacks.filter(f => f.feedback_type === 'positive');
        const neg = topFeedbacks.filter(f => f.feedback_type !== 'positive');
        if (pos.length) lines.push(`  ✅ ${pos.length} bestätigte positive Feedbacks`);
        if (neg.length) lines.push(`  ⚠️ ${neg.length} bestätigte negative Feedbacks`);
        const latest = topFeedbacks[0];
        if (latest?.feedback_text) {
          lines.push(`  Letztes Feedback: "${latest.feedback_text.substring(0, 100)}"`);
        }
      }

      if (lines.length > 1) contextParts.push(lines.join('\n'));
    } catch (e) {
      logger.warn(`[ChannelCtx] Kontext-Abfrage fehlgeschlagen für @${username}: ${e.message}`);
    }
  }

  return contextParts.length
    ? '\n\n⚠️ WICHTIG — Channelinternes Wissen (hat Vorrang vor allgemeinen Einschätzungen):\n' + contextParts.join('\n\n')
    : '';
}

module.exports = { enrichPersonKnowledge, getContextForQuery, _extractUsernames };
