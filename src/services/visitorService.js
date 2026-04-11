/**
 * visitorService.js v1.3
 * IP-Fingerprinting, persistente ChatID, Ban-Check, Activity-Tracking
 */

const crypto   = require('crypto');
const supabase  = require('../config/supabase');
const logger   = require('../utils/logger');

const visitorService = {

  // ── IP → ChatID Mapping ───────────────────────────────────────────────────
  // Gibt eine persistente ChatID für diese IP zurück (oder erstellt eine neue)
  async getOrCreateVisitor(ip, userAgent, fingerprint) {
    const ipHash = this._hashIp(ip);

    try {
      // Bestehenden Besucher suchen (IP-Hash)
      const { data: existing } = await supabase
        .from('widget_visitors')
        .select('*')
        .eq('ip_hash', ipHash)
        .single();

      if (existing) {
        // Letzten Besuch aktualisieren
        await supabase.from('widget_visitors').update({
          last_seen:  new Date(),
          page_count: (existing.page_count || 0) + 1,
          user_agent: userAgent || existing.user_agent,
          fingerprint: fingerprint || existing.fingerprint
        }).eq('id', existing.id);

        return { chatId: existing.chat_id, visitor: existing, isNew: false };
      }

      // Neuen Besucher anlegen
      const chatId = `web_${ipHash.substring(0, 12)}_${Date.now().toString(36)}`;

      const { data: created } = await supabase.from('widget_visitors').insert([{
        chat_id:     chatId,
        ip:          ip,
        ip_hash:     ipHash,
        user_agent:  userAgent || null,
        fingerprint: fingerprint || null,
        first_seen:  new Date(),
        last_seen:   new Date()
      }]).select().single();

      return { chatId, visitor: created, isNew: true };
    } catch (err) {
      // Fallback: temporäre ChatID ohne DB-Persistenz
      logger.warn(`[Visitor] getOrCreate Fehler: ${err.message}`);
      const chatId = `web_tmp_${ipHash.substring(0, 8)}_${Date.now().toString(36)}`;
      return { chatId, visitor: null, isNew: true };
    }
  },

  // ── Ban-Check (IP + ID) ────────────────────────────────────────────────────
  async isBanned(ip, chatId) {
    const ipHash = this._hashIp(ip);
    try {
      // Check 1: IP-Hash in blacklist
      const { data: ipBan } = await supabase
        .from('blacklist')
        .select('id, reason')
        .eq('ip_hash', ipHash)
        .maybeSingle();
      if (ipBan) return { banned: true, reason: ipBan.reason || 'IP gebannt', by: 'ip' };

      // Check 2: ChatID in blacklist
      const { data: idBan } = await supabase
        .from('blacklist')
        .select('id, reason')
        .eq('identifier', chatId)
        .maybeSingle();
      if (idBan) return { banned: true, reason: idBan.reason || 'Nutzer gebannt', by: 'id' };

      // Check 3: Visitor-Tabelle
      const { data: visitor } = await supabase
        .from('widget_visitors')
        .select('is_banned, ban_reason')
        .eq('ip_hash', ipHash)
        .maybeSingle();
      if (visitor?.is_banned) return { banned: true, reason: visitor.ban_reason || 'Gebannt', by: 'visitor' };

      return { banned: false };
    } catch (err) {
      logger.warn(`[Visitor] Ban-Check Fehler: ${err.message}`);
      return { banned: false }; // Im Zweifel: nicht bannen
    }
  },

  // ── Aktivität loggen (unsichtbar für Besucher) ─────────────────────────────
  async logActivity(chatId, activity, pageUrl, pageTitle) {
    try {
      await supabase.from('visitor_activities').insert([{
        chat_id:    chatId,
        activity,
        page_url:   pageUrl  || null,
        page_title: pageTitle || null,
        created_at: new Date()
      }]);

      // Unsichtbare System-Nachricht im Chat (für Dashboard sichtbar)
      await supabase.from('messages').insert([{
        chat_id:  chatId,
        role:     'system',
        content:  `📍 ${activity}`,
        is_manual: false
      }]);
    } catch (err) {
      // Non-fatal
    }
  },

  // ── IP-Lookup (Dashboard) ──────────────────────────────────────────────────
  async lookupIp(ip) {
    const ipHash = this._hashIp(ip);

    const [visitorRes, activitiesRes, blacklistRes, chatsRes] = await Promise.all([
      supabase.from('widget_visitors').select('*').eq('ip_hash', ipHash).maybeSingle(),
      supabase.from('visitor_activities')
        .select('*')
        .eq('chat_id',
          supabase.from('widget_visitors').select('chat_id').eq('ip_hash', ipHash).limit(1)
        )
        .order('created_at', { ascending: false })
        .limit(50)
        .catch(() => ({ data: [] })),
      supabase.from('blacklist').select('*').eq('ip_hash', ipHash).maybeSingle(),
      supabase.from('chats').select('*').eq('visitor_ip', ip).order('updated_at', { ascending: false }).limit(20).catch(() => ({ data: [] }))
    ]);

    const visitor    = visitorRes.data;
    const blacklist  = blacklistRes.data;

    // Aktivitäten über ChatID laden
    let activities = [];
    if (visitor?.chat_id) {
      const { data: acts } = await supabase
        .from('visitor_activities')
        .select('*')
        .eq('chat_id', visitor.chat_id)
        .order('created_at', { ascending: false })
        .limit(50);
      activities = acts || [];
    }

    return {
      ip,
      ipHash,
      visitor: visitor || null,
      chatId:  visitor?.chat_id || null,
      isBanned: !!(blacklist || visitor?.is_banned),
      blacklistEntry: blacklist || null,
      activities,
      chats: chatsRes.data || [],
      summary: {
        firstSeen:  visitor?.first_seen || null,
        lastSeen:   visitor?.last_seen  || null,
        pageCount:  visitor?.page_count || 0,
        country:    visitor?.country    || null,
        userAgent:  visitor?.user_agent || null
      }
    };
  },

  // ── IP bannen (IP-Hash + ChatID + visitor_visitors) ────────────────────────
  async banIp(ip, reason) {
    const ipHash = this._hashIp(ip);

    // 1. Blacklist-Eintrag mit IP-Hash
    await supabase.from('blacklist').insert([{
      identifier:  ip,
      ip_hash:     ipHash,
      reason:      reason || 'IP-Bann',
      ban_scope:   'ip',
      auto_banned: false
    }]);

    // 2. Visitor als gebannt markieren
    await supabase.from('widget_visitors').update({
      is_banned:  true,
      ban_reason: reason || 'IP-Bann',
      banned_at:  new Date()
    }).eq('ip_hash', ipHash);

    // 3. Alle Chats dieser IP in Manuell-Modus
    const { data: visitor } = await supabase
      .from('widget_visitors').select('chat_id').eq('ip_hash', ipHash).maybeSingle();
    if (visitor?.chat_id) {
      await supabase.from('chats').update({
        auto_muted: true,
        mute_reason: reason || 'IP-Bann'
      }).eq('id', visitor.chat_id);
    }

    return { success: true, ipHash };
  },

  // ── Helfer ─────────────────────────────────────────────────────────────────
  _hashIp(ip) {
    return crypto.createHash('sha256').update(ip + 'vs25_salt').digest('hex').substring(0, 32);
  },

  _getClientIp(req) {
    return (
      req.headers['cf-connecting-ip'] ||           // Cloudflare
      req.headers['x-real-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      '0.0.0.0'
    );
  }
};

module.exports = visitorService;
