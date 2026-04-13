-- schema14.sql – v1.3.10: Daily Coupon System

-- Coupon-Einstellungen in settings-Tabelle
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_enabled       BOOLEAN DEFAULT false;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_discount      INTEGER DEFAULT 10;         -- Prozent
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_type          TEXT    DEFAULT 'percentage'; -- 'percentage' | 'fixed'
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_description   TEXT    DEFAULT '10% Rabatt auf alle Produkte';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_max_uses      INTEGER DEFAULT NULL;        -- NULL = unbegrenzt
ALTER TABLE settings ADD COLUMN IF NOT EXISTS coupon_schedule_hour INTEGER DEFAULT 0;           -- Stunde der Erneuerung (0 = Mitternacht)

-- Aktueller aktiver Coupon (wird täglich erneuert)
CREATE TABLE IF NOT EXISTS daily_coupons (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL UNIQUE,
  discount     INTEGER     NOT NULL,
  type         TEXT        NOT NULL DEFAULT 'percentage',
  description  TEXT,
  sellauth_id  TEXT,                               -- ID aus Sellauth (für DELETE)
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN     DEFAULT true,
  used_count   INTEGER     DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_daily_coupons_active ON daily_coupons(is_active) WHERE is_active = true;
