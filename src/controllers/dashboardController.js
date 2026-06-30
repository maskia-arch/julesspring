/**
 * AdminHelper – Dashboard Controller (v2.0.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Liefert alle Uebersichten, Einsichten und Verwaltungs-Endpunkte fuer das
 * Render-Dashboard des AI AdminHelper:
 *
 *   GET  /api/admin/overview                 → KPI-Kacheln + Aktivitaets-Feed
 *   GET  /api/admin/moderation/pending       → offene Feedback-Reviews (alle Channels)
 *   POST /api/admin/moderation/feedback/:id/approve
 *   POST /api/admin/moderation/feedback/:id/reject
 *   GET  /api/admin/moderation/scam[?channel_id]
 *   GET  /api/admin/moderation/banned[?channel_id]
 *   GET  /api/admin/moderation/spam[?channel_id]
 *   GET  /api/admin/moderation/reports[?channel_id]
 *   GET  /api/admin/moderation/blacklist-hits[?channel_id]
 *   GET  /api/admin/engagement/diss[?channel_id]
 *   GET  /api/admin/engagement/activity[?channel_id]
 *   GET  /api/admin/engagement/summaries
 *   GET  /api/admin/scheduled[?channel_id]
 *   POST /api/admin/scheduled
 *   DELETE /api/admin/scheduled/:id
 *   GET  /api/admin/members?channel_id
 *
 * Designprinzip: JEDE Teilabfrage ist gekapselt. Fehlt eine Tabelle oder
 * schlaegt eine Query fehl, liefert die Funktion einen leeren Wert statt den
 * gesamten Endpoint crashen zu lassen. So bleibt das Dashboard auch bei
 * unvollstaendigem Schema erreichbar.
 */
const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// ─── Defensive Helfer ───────────────────────────────────────────────────────
async function safeCount(table, build) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (typeof build === 'function') q = build(q);
    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch (_) { return 0; }
}

async function safeSelect(table, build) {
  try {
    let q = supabase.from(table).select('*');
    if (typeof build === 'function') q = build(q);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch (_) { return []; }
}

// Channel-ID → Titel Auflösung (einmal laden, dann mappen)
async function channelTitleMap() {
  const map = {};
  const rows = await safeSelect('bot_channels', q => q.select('id, title, type, username'));
  rows.forEach(c => { map[String(c.id)] = c; });
  return map;
}

const dashboardController = {

  // ═══════════════════════════════════════════════════════════════════════
  //  OVERVIEW – aggregierte KPIs + Aktivitaets-Feed
  // ═══════════════════════════════════════════════════════════════════════
  async getOverview(req, res, next) {
    try {
      const channels = await safeSelect('bot_channels', q => q.order('created_at', { ascending: false }));

      const totalChannels  = channels.length;
      const activeChannels  = channels.filter(c => c.ai_enabled).length;
      const approvedChannels = channels.filter(c => c.is_approved).length;
      const pendingChannels  = channels.filter(c => !c.is_approved).length;

      let creditsUsed = 0, creditLimit = 0;
      channels.forEach(c => {
        creditsUsed += parseInt(c.token_used || 0) || 0;
        creditLimit += parseInt(c.token_limit || 0) || 0;
      });

      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const nowIso = new Date().toISOString();

      const [
        totalMembers, scamEntries, safelistEntries, bannedUsers,
        pendingFeedback, adminReports7d, scheduledActive, dissBattlesTotal,
        kbEntries, blacklistHits7d
      ] = await Promise.all([
        safeCount('channel_members'),
        safeCount('scam_entries'),
        safeCount('channel_safelist'),
        safeCount('channel_banned_users'),
        safeCount('user_feedbacks', q => q.eq('status', 'pending')),
        safeCount('admin_reports', q => q.gte('created_at', sevenDaysAgo)),
        safeCount('scheduled_messages', q => q.eq('is_active', true)),
        safeCount('channel_diss_battles'),
        safeCount('channel_knowledge'),
        safeCount('blacklist_hits', q => q.gte('created_at', sevenDaysAgo))
      ]);

      // Aktive Spam-Mutes (muted_until in der Zukunft)
      const activeMutes = await safeCount('ai_spam_violations', q => q.gt('muted_until', nowIso));

      // Top-Channels nach Credit-Verbrauch
      const topChannels = [...channels]
        .sort((a, b) => (parseInt(b.token_used || 0) || 0) - (parseInt(a.token_used || 0) || 0))
        .slice(0, 5)
        .map(c => ({
          id: c.id, title: c.title || String(c.id), type: c.type,
          token_used: parseInt(c.token_used || 0) || 0,
          token_limit: c.token_limit || null,
          ai_enabled: !!c.ai_enabled, is_approved: !!c.is_approved
        }));

      // Aktivitaets-Feed: letzte Meldungen + Scam-Eintraege
      const map = await channelTitleMap();
      const feed = [];

      const recentReports = await safeSelect('admin_reports', q =>
        q.order('created_at', { ascending: false }).limit(8));
      recentReports.forEach(r => feed.push({
        kind: 'report', ts: r.created_at,
        channel: map[String(r.channel_id)]?.title || r.channel_id,
        text: `@admin-Meldung: ${r.ai_category || 'Sonstiges'}${r.target_name ? ' · ' + r.target_name : ''}`,
        meta: r.action_taken && r.action_taken !== 'none' ? r.action_taken : null
      }));

      const recentScam = await safeSelect('scam_entries', q =>
        q.order('created_at', { ascending: false }).limit(8));
      recentScam.forEach(s => feed.push({
        kind: 'scam', ts: s.created_at,
        channel: map[String(s.channel_id)]?.title || s.channel_id,
        text: `Scamliste: ${s.username ? '@' + s.username : (s.user_id || '?')}`,
        meta: s.reason ? String(s.reason).substring(0, 60) : null
      }));

      const recentFeedback = await safeSelect('user_feedbacks', q =>
        q.order('created_at', { ascending: false }).limit(8));
      recentFeedback.forEach(f => feed.push({
        kind: f.feedback_type === 'positive' ? 'feedback_pos' : 'feedback_neg', ts: f.created_at,
        channel: map[String(f.channel_id)]?.title || f.channel_id,
        text: `${f.feedback_type === 'positive' ? '👍' : '👎'} Feedback → ${f.target_username ? '@' + f.target_username : (f.target_user_id || '?')}`,
        meta: f.status
      }));

      feed.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));

      res.json({
        version: require('../utils/versionLoader').getVersion(),
        kpi: {
          totalChannels, activeChannels, approvedChannels, pendingChannels,
          totalMembers, creditsUsed, creditLimit,
          scamEntries, safelistEntries, bannedUsers,
          pendingFeedback, adminReports7d, activeMutes,
          scheduledActive, dissBattlesTotal, kbEntries, blacklistHits7d
        },
        topChannels,
        feed: feed.slice(0, 20)
      });
    } catch (e) { next(e); }
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  MODERATION
  // ═══════════════════════════════════════════════════════════════════════
  async getPendingFeedback(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('user_feedbacks', q =>
        q.eq('status', 'pending').order('created_at', { ascending: false }).limit(100));
      res.json(rows.map(f => ({
        id: f.id,
        channel_id: f.channel_id,
        channel_title: map[String(f.channel_id)]?.title || String(f.channel_id),
        feedback_type: f.feedback_type,
        feedback_text: f.feedback_text,
        ai_summary: f.ai_summary || null,
        target_username: f.target_username,
        target_user_id: f.target_user_id,
        submitted_by_username: f.submitted_by_username,
        has_proofs: f.has_proofs || false,
        proof_count: f.proof_count || 0,
        created_at: f.created_at
      })));
    } catch (e) { next(e); }
  },

  // v2.0.1: Direkte, robuste Updates. reviewed_by = NULL (Dashboard-Aktion),
  // damit es bei numerischen reviewed_by-Spalten keinen Typkonflikt gibt –
  // genau das ließ zuvor das Reject still fehlschlagen und die Liste neu laden.
  async approvePendingFeedback(req, res, next) {
    try {
      const id = req.params.id;
      const { data: fb } = await supabase.from('user_feedbacks').select('*').eq('id', id).maybeSingle();
      if (!fb) return res.status(404).json({ error: 'Feedback nicht gefunden' });

      const { error } = await supabase.from('user_feedbacks')
        .update({ status: 'approved', reviewed_by: null, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;

      // Reputation aktualisieren (best-effort)
      const delta = fb.feedback_type === 'positive' ? 1 : -10;
      try {
        await supabase.rpc('update_user_reputation', {
          p_channel_id: String(fb.channel_id),
          p_user_id:    fb.target_user_id || 0,
          p_username:   fb.target_username,
          p_delta:      delta
        });
      } catch (_) {}

      // Auto-Scam bei sehr negativem Score
      try {
        let repQ = supabase.from('user_reputation').select('score').eq('channel_id', String(fb.channel_id));
        repQ = fb.target_user_id ? repQ.eq('user_id', fb.target_user_id) : repQ.ilike('username', fb.target_username || '');
        const { data: rep } = await repQ.maybeSingle();
        if ((rep?.score || 0) <= -50) {
          await supabase.from('scam_entries').upsert([{
            channel_id: String(fb.channel_id),
            user_id:    fb.target_user_id,
            username:   fb.target_username,
            reason:     '🤖 Automatisch gesperrt: Score ist auf -50 gefallen.',
            added_by:   null
          }], { onConflict: 'channel_id,user_id' });
        }
      } catch (_) {}

      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async rejectPendingFeedback(req, res, next) {
    try {
      const { error } = await supabase.from('user_feedbacks')
        .update({ status: 'rejected', reviewed_by: null, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getScam(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('scam_entries', q => {
        let qq = q.order('created_at', { ascending: false }).limit(200);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(s => ({ ...s, channel_title: map[String(s.channel_id)]?.title || String(s.channel_id) })));
    } catch (e) { next(e); }
  },

  async getBanned(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('channel_banned_users', q => {
        let qq = q.order('created_at', { ascending: false }).limit(200);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(s => ({ ...s, channel_title: map[String(s.channel_id)]?.title || String(s.channel_id) })));
    } catch (e) { next(e); }
  },

  async getSpamViolations(req, res, next) {
    try {
      const map = await channelTitleMap();
      const nowIso = new Date().toISOString();
      const rows = await safeSelect('ai_spam_violations', q => {
        let qq = q.order('updated_at', { ascending: false }).limit(200);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(v => ({
        ...v,
        channel_title: map[String(v.channel_id)]?.title || String(v.channel_id),
        is_muted: v.muted_until ? (new Date(v.muted_until) > new Date(nowIso)) : false
      })));
    } catch (e) { next(e); }
  },

  async getAdminReports(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('admin_reports', q => {
        let qq = q.order('created_at', { ascending: false }).limit(100);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(r => ({ ...r, channel_title: map[String(r.channel_id)]?.title || String(r.channel_id) })));
    } catch (e) { next(e); }
  },

  async getBlacklistHits(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('blacklist_hits', q => {
        let qq = q.order('created_at', { ascending: false }).limit(100);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(r => ({ ...r, channel_title: map[String(r.channel_id)]?.title || String(r.channel_id) })));
    } catch (e) { next(e); }
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  ENGAGEMENT
  // ═══════════════════════════════════════════════════════════════════════
  async getDissScores(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('channel_diss_scores', q => {
        let qq = q.order('score', { ascending: false }).limit(100);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(r => ({ ...r, channel_title: map[String(r.channel_id)]?.title || String(r.channel_id) })));
    } catch (e) { next(e); }
  },

  async getActivityPoints(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('channel_user_points', q => {
        let qq = q.order('points', { ascending: false }).limit(100);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(r => ({ ...r, channel_title: map[String(r.channel_id)]?.title || String(r.channel_id) })));
    } catch (e) { next(e); }
  },

  async getSummaries(req, res, next) {
    try {
      // daily_summaries kann leer sein – Fallback: letzte Summary pro Channel aus bot_channels
      const channels = await safeSelect('bot_channels', q =>
        q.select('id, title, type, last_summary_at, last_summary_tokens')
         .not('last_summary_at', 'is', null)
         .order('last_summary_at', { ascending: false }));
      res.json(channels.map(c => ({
        channel_id: c.id, channel_title: c.title || String(c.id), type: c.type,
        last_summary_at: c.last_summary_at, last_summary_tokens: c.last_summary_tokens || 0
      })));
    } catch (e) { next(e); }
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  SCHEDULED MESSAGES (geplante Nachrichten)
  // ═══════════════════════════════════════════════════════════════════════
  async getScheduled(req, res, next) {
    try {
      const map = await channelTitleMap();
      const rows = await safeSelect('scheduled_messages', q => {
        let qq = q.order('next_run_at', { ascending: true }).limit(200);
        if (req.query.channel_id) qq = qq.eq('channel_id', String(req.query.channel_id));
        return qq;
      });
      res.json(rows.map(r => ({ ...r, channel_title: map[String(r.channel_id)]?.title || String(r.channel_id) })));
    } catch (e) { next(e); }
  },

  async createScheduled(req, res, next) {
    try {
      const { channel_id, message, next_run_at, repeat, end_at } = req.body || {};
      if (!channel_id || !message) return res.status(400).json({ error: 'channel_id und message erforderlich' });
      const row = {
        channel_id: String(channel_id),
        message:    String(message),
        next_run_at: next_run_at || new Date(Date.now() + 60000).toISOString(),
        repeat:     repeat || null,           // z.B. 'daily','weekly','hourly' oder null = einmalig
        end_at:     end_at || null,
        is_active:  true,
        created_at: new Date().toISOString()
      };
      const { data, error } = await supabase.from('scheduled_messages').insert([row]).select().single();
      if (error) throw error;
      res.json({ success: true, scheduled: data });
    } catch (e) { next(e); }
  },

  async deleteScheduled(req, res, next) {
    try {
      // Soft: deaktivieren statt loeschen, damit Historie erhalten bleibt
      const { error } = await supabase.from('scheduled_messages')
        .update({ is_active: false }).eq('id', req.params.id);
      if (error) {
        // Fallback hartes Loeschen
        await supabase.from('scheduled_messages').delete().eq('id', req.params.id);
      }
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ═══════════════════════════════════════════════════════════════════════
  //  MEMBERS
  // ═══════════════════════════════════════════════════════════════════════
  async getMembers(req, res, next) {
    try {
      if (!req.query.channel_id) return res.status(400).json({ error: 'channel_id erforderlich' });
      const rows = await safeSelect('channel_members', q =>
        q.eq('channel_id', String(req.query.channel_id))
         .order('last_seen', { ascending: false }).limit(500));
      res.json(rows);
    } catch (e) { next(e); }
  }
};

module.exports = dashboardController;
