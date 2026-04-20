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
    // v1.4.48: Filter by expires_at > now() — an expired coupon must never surface,
    // even if is_active still true in the DB. Auto-deactivate expired ones.
    try {
      const nowIso = new Date().toISOString();
      const { data } = await supabase
        .from('daily_coupons')
        .select('*')
        .eq('is_active', true)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Fire-and-forget cleanup of expired-but-still-flagged-active rows
      try {
        await supabase.from('daily_coupons')
          .update({ is_active: false })
          .eq('is_active', true)
          .lte('expires_at', nowIso);
      } catch (_) {}

      return data || null;
    } catch (e) {
      logger.warn('[Coupon] getActiveCoupon Fehler:', e.message || String(e));
      return null;
    }
  },

  // v1.4.48: Explicit bypass-cache variant. The AI coupon flow always uses this.
  async getActiveCouponFresh() {
    return this.getActiveCoupon();  // Current impl already has no cache, but the
    // wrapper exists so callers can reason about "no caching" semantics.
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
        for (const coupon of actives) {
          // Sellauth DELETE benötigt die NUMERISCHE ID (nicht den Code-String!)
          const numericId = coupon.sellauth_id ? parseInt(coupon.sellauth_id) : null;

          if (!numericId) {
            logger.info(`[Coupon] ${coupon.code}: keine Sellauth-ID gespeichert – überspringe Löschung`);
            continue;
          }

          try {
            await this._client(apiKey).delete(`/shops/${shopId}/coupons/${numericId}`);
            logger.info(`[Coupon] Gelöscht in Sellauth: ${coupon.code} (ID: ${numericId})`);
          } catch (e) {
            const status = e.response?.status;
            const msg    = e.response?.data?.message || e.message;
            if (status === 404 || /not found/i.test(msg)) {
              logger.info(`[Coupon] ${coupon.code} (ID: ${numericId}) nicht in Sellauth – bereits gelöscht oder abgelaufen`);
            } else {
              logger.warn(`[Coupon] Löschen fehlgeschlagen (${coupon.code}, ID: ${numericId}): ${msg}`);
            }
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
  async createDailyCoupon(force = false) {
    const settings = await this._loadSettings();

    if (!force && !settings.coupon_enabled) {
      logger.info('[Coupon] Deaktiviert in Settings – nutze force:true zum manuellen Erstellen');
      return null;
    }

    if (!settings.sellauth_api_key || !settings.sellauth_shop_id) {
      logger.warn('[Coupon] Sellauth nicht konfiguriert (API Key / Shop ID fehlt)');
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

    // Sellauth Regel: expiration_date MUSS nach heute liegen (nicht heute selbst!)
    // → Wir schicken morgen an Sellauth, löschen aber beim nächsten Coupon aktiv
    // Effektive Laufzeit: heute (wird um 00:00 durch neuen Coupon ersetzt)
    const today    = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expiresDate = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD (morgen → Sellauth-Pflicht)

    // Dashboard-Anzeige: heute 23:59 (wann der Coupon effektiv ersetzt wird)
    const expiresAt = new Date(today);
    expiresAt.setHours(23, 59, 59, 0);

    logger.info(`[Coupon] Erstelle: ${code} (${discount}${type === 'percentage' ? '%' : '€'} Rabatt, Sellauth-Ablauf: ${expiresDate})`);

    // 1. Alten Coupon ZUERST in Sellauth löschen (vor dem neuen erstellen)
    await this._deactivateOld(settings.sellauth_api_key, settings.sellauth_shop_id);

    // 2. Neuen Coupon in Sellauth erstellen
    let sellauthId = null;
    try {
      const body = {
        code,
        global:           true,
        discount:         discount,
        type:             type,
        expiration_date:  expiresDate,   // Heute – läuft heute Nacht ab
        disable_if_volume_discount: false
      };
      if (maxUses) body.max_uses = maxUses;

      const { data: created } = await this._client(settings.sellauth_api_key)
        .post(`/shops/${settings.sellauth_shop_id}/coupons`, body);

      sellauthId = created?.id || null;
      logger.info(`[Coupon] Sellauth erstellt: ${code} (ID: ${sellauthId}, läuft ab: ${expiresDate})`);
    } catch (e) {
      logger.error(`[Coupon] Sellauth-Fehler: ${e.response?.data?.message || e.message}`);
    }

    // 3. In DB speichern

    const { data: saved } = await supabase.from('daily_coupons').insert([{
      code,
      discount,
      type,
      description,
      sellauth_id: String(sellauthId || ''),
      expires_at:  expiresAt.toISOString(),
      is_active:   true,
      used_count:  0
    }]).select().single();

    logger.info(`[Coupon] ✅ Tages-Coupon aktiv: ${code}`);
    return saved;
  },

  // ── Scheduler: läuft täglich zur eingestellten Stunde ────────────────────
  startDailyScheduler() {
    // Beim Start: prüfen ob der heutige Coupon fehlt (nach SIGTERM/Neustart)
    this._checkMissedCoupon();

    const scheduleNext = async () => {
      try {
        const settings = await this._loadSettings();
        if (!settings.coupon_enabled) {
          logger.info('[Coupon] System deaktiviert – Scheduler pausiert. Prüfe in 30min erneut.');
          setTimeout(scheduleNext, 30 * 60 * 1000);
          return;
        }

        const targetHour = parseInt(settings.coupon_schedule_hour) || 0;
        const now  = new Date();
        let next   = new Date();
        next.setHours(targetHour, 0, 5, 0);

        if (next <= now) next.setDate(next.getDate() + 1);

        const delay = next.getTime() - now.getTime();
        logger.info(`[Coupon] Nächste Erneuerung: ${next.toISOString()} UTC (in ${Math.round(delay/60000)} min)`);

        setTimeout(async () => {
          logger.info('[Coupon] ⏰ Tägliche Rotation wird ausgeführt...');
          try {
            await this.createDailyCoupon();
          } catch (e) {
            logger.error('[Coupon] Rotation fehlgeschlagen:', e.message);
          }
          scheduleNext();
        }, delay);

      } catch (e) {
        logger.warn(`[Coupon] Scheduler-Fehler: ${e.message}`);
        setTimeout(scheduleNext, 60 * 60 * 1000);
      }
    };

    scheduleNext();
    logger.info('[Coupon] Daily Scheduler gestartet');
  },

  // Prüft beim Serverstart ob der Coupon für heute schon erstellt wurde
  async _checkMissedCoupon() {
    try {
      await new Promise(r => setTimeout(r, 5000)); // 5s warten bis DB-Verbindung steht

      const settings = await this._loadSettings();
      if (!settings.coupon_enabled) return;

      const targetHour = parseInt(settings.coupon_schedule_hour) || 0;
      const now = new Date();
      const todayTarget = new Date();
      todayTarget.setHours(targetHour, 0, 0, 0);

      // Nur prüfen wenn wir NACH der geplanten Zeit starten
      if (now < todayTarget) return;

      // Prüfen ob heute schon ein aktiver Coupon existiert
      const activeCoupon = await this.getActiveCoupon();
      if (activeCoupon) {
        logger.info(`[Coupon] Startup-Check: Coupon ${activeCoupon.code} bereits aktiv.`);
        return;
      }

      // Kein Coupon für heute → nachholen
      logger.info('[Coupon] Startup-Check: Kein Coupon für heute – erstelle jetzt (SIGTERM-Recovery)...');
      await this.createDailyCoupon(true);
    } catch (e) {
      logger.warn('[Coupon] Startup-Check fehlgeschlagen:', e.message);
    }
  }
};

module.exports = couponService;
