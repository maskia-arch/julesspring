/**
 * couponService.js v1.3.10
 * Tägliche Coupon-Rotation via Sellauth API
 * - Zufälliger Code: z.B. "SAVE10-A3X7F"
 * - Alten Coupon deaktivieren → neuen erstellen
 * - Läuft täglich um die konfigurierte Stunde (Standard: 00:00 Uhr)
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const logger  = require('../utils/logger');

const SELLAUTH_API = 'https://api.sellauth.com/v1';

const couponService = {

  // ── Zufälligen Coupon-Code generieren ──────────────────────────────────────
  _generateCode(prefix) {
    const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I (Verwechslung)
    const random = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const base   = (prefix || 'SAVE').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
    return `${base}-${random}`;
  },

  // ── Sellauth HTTP Client ────────────────────────────────────────────────────
  _client(apiKey) {
    return axios.create({
      baseURL: SELLAUTH_API, timeout: 20000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  },

  // ── Settings laden ─────────────────────────────────────────────────────────
  async _loadSettings() {
    try {
      const { data } = await supabase.from('settings').select(
        'sellauth_api_key, sellauth_shop_id, coupon_enabled, coupon_discount, coupon_type, coupon_description, coupon_max_uses, coupon_schedule_hour'
      ).single();
      return data || {};
    } catch { return {}; }
  },

  // ── Aktiven Coupon aus DB holen ────────────────────────────────────────────
  async getActiveCoupon() {
    try {
      const { data } = await supabase
        .from('daily_coupons')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data || null;
    } catch { return null; }
  },

  // ── Alten Coupon in Sellauth löschen & in DB deaktivieren ─────────────────
  async _deactivateOld(apiKey, shopId) {
    try {
      // Alle aktiven Coupons in DB deaktivieren
      const { data: actives } = await supabase
        .from('daily_coupons')
        .select('code, sellauth_id')
        .eq('is_active', true);

      if (actives?.length) {
        for (const c of actives) {
          // Sellauth: Coupon löschen
          try {
            await this._client(apiKey).delete(`/shops/${shopId}/coupons/${c.code}`);
            logger.info(`[Coupon] Gelöscht in Sellauth: ${c.code}`);
          } catch (e) {
            logger.warn(`[Coupon] Löschen fehlgeschlagen (${c.code}): ${e.response?.data?.message || e.message}`);
          }
        }

        // DB: alle als inaktiv markieren
        await supabase.from('daily_coupons').update({ is_active: false }).eq('is_active', true);
      }
    } catch (e) {
      logger.warn(`[Coupon] _deactivateOld: ${e.message}`);
    }
  },

  // ── Neuen täglichen Coupon erstellen ──────────────────────────────────────
  async createDailyCoupon() {
    const settings = await this._loadSettings();

    if (!settings.coupon_enabled) {
      logger.info('[Coupon] Deaktiviert in Settings, kein Coupon erstellt');
      return null;
    }

    if (!settings.sellauth_api_key || !settings.sellauth_shop_id) {
      logger.warn('[Coupon] Sellauth nicht konfiguriert');
      return null;
    }

    // Wochentag-Planung prüfen (0=Mo ... 6=So, JS: 0=So → umrechnen)
    const jsDay     = new Date().getDay();                     // 0=So,1=Mo...6=Sa
    const weekday   = jsDay === 0 ? 6 : jsDay - 1;            // → 0=Mo...6=So
    let discount    = settings.coupon_discount    || 10;
    let type        = settings.coupon_type         || 'percentage';
    let description = settings.coupon_description  || `${discount}% Rabatt auf alle Produkte`;
    let maxUses     = settings.coupon_max_uses      || null;
    let dayEnabled  = true;

    try {
      const { data: schedule } = await supabase
        .from('coupon_schedule')
        .select('*')
        .eq('weekday', weekday)
        .single();

      if (schedule) {
        if (!schedule.enabled) {
          logger.info(`[Coupon] Wochentag ${weekday} deaktiviert – kein Coupon heute`);
          return null;
        }
        discount    = schedule.discount    || discount;
        type        = schedule.type        || type;
        description = schedule.description || description;
        maxUses     = schedule.max_uses    || null;
        logger.info(`[Coupon] Wochentag ${weekday}: ${discount}${type==='percentage'?'%':'€'} – ${description}`);
      }
    } catch (e) {
      logger.warn(`[Coupon] Schedule laden: ${e.message} – nutze Standard-Einstellungen`);
    }

    // Prefix aus Beschreibung: "10% Rabatt" → "SAVE10"
    const prefix = type === 'percentage' ? `SAVE${discount}` : `EUR${discount}`;
    const code   = this._generateCode(prefix);

    // Ablaufdatum: morgen 23:59 (UTC)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expiresDate = tomorrow.toISOString().slice(0, 10); // "YYYY-MM-DD"

    logger.info(`[Coupon] Erstelle: ${code} (${discount}${type === 'percentage' ? '%' : '€'} Rabatt)`);

    // 1. Alten Coupon deaktivieren
    await this._deactivateOld(settings.sellauth_api_key, settings.sellauth_shop_id);

    // 2. Neuen Coupon in Sellauth erstellen
    let sellauthId = null;
    try {
      const body = {
        code,
        global:           true,
        discount:         discount,
        type:             type,            // "percentage" oder "fixed"
        expiration_date:  expiresDate,
        disable_if_volume_discount: false
      };
      if (maxUses) body.max_uses = maxUses;

      const { data: created } = await this._client(settings.sellauth_api_key)
        .post(`/shops/${settings.sellauth_shop_id}/coupons`, body);

      sellauthId = created?.id || null;
      logger.info(`[Coupon] Sellauth erstellt: ${code} (ID: ${sellauthId})`);
    } catch (e) {
      logger.error(`[Coupon] Sellauth-Fehler: ${e.response?.data?.message || e.message}`);
      // Trotzdem in DB speichern (damit KI den Code kennt)
    }

    // 3. In DB speichern
    const expiresAt = new Date(tomorrow);
    expiresAt.setHours(23, 59, 59, 0);

    const { data: saved } = await supabase.from('daily_coupons').insert([{
      code,
      discount,
      type,
      description,
      sellauth_id: String(sellauthId || ''),
      expires_at:  expiresAt,
      is_active:   true,
      used_count:  0
    }]).select().single();

    logger.info(`[Coupon] ✅ Tages-Coupon aktiv: ${code}`);
    return saved;
  },

  // ── Scheduler: läuft täglich zur eingestellten Stunde ────────────────────
  startDailyScheduler() {
    const scheduleNext = async () => {
      try {
        const settings = await this._loadSettings();
        const targetHour = parseInt(settings.coupon_schedule_hour) || 0;

        const now  = new Date();
        let next   = new Date();
        next.setHours(targetHour, 0, 5, 0); // +5s Puffer

        if (next <= now) {
          next.setDate(next.getDate() + 1); // Morgen
        }

        const delay = next.getTime() - now.getTime();
        logger.info(`[Coupon] Nächste Erneuerung: ${next.toISOString()} (in ${Math.round(delay/60000)} min)`);

        setTimeout(async () => {
          await this.createDailyCoupon();
          scheduleNext(); // Für nächsten Tag
        }, delay);

      } catch (e) {
        logger.warn(`[Coupon] Scheduler-Fehler: ${e.message}`);
        // Bei Fehler: in 1h nochmal versuchen
        setTimeout(scheduleNext, 60 * 60 * 1000);
      }
    };

    scheduleNext();
    logger.info('[Coupon] Daily Scheduler gestartet');
  }
};

module.exports = couponService;
