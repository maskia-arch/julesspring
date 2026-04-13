-- schema14b.sql – Wochentag-Coupon-Planung
-- Führe nach schema14.sql aus

CREATE TABLE IF NOT EXISTS coupon_schedule (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday      INTEGER NOT NULL UNIQUE,  -- 0=Mo, 1=Di, 2=Mi, 3=Do, 4=Fr, 5=Sa, 6=So
  enabled      BOOLEAN DEFAULT true,
  discount     INTEGER NOT NULL DEFAULT 10,
  type         TEXT    NOT NULL DEFAULT 'percentage',
  description  TEXT,
  max_uses     INTEGER DEFAULT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Standard-Einträge für alle 7 Tage
INSERT INTO coupon_schedule (weekday, enabled, discount, type, description) VALUES
  (0, true,  10, 'percentage', '10% Montags-Rabatt auf alle eSIMs'),
  (1, true,  10, 'percentage', '10% Dienstags-Rabatt auf alle eSIMs'),
  (2, true,  10, 'percentage', '10% Mittwochs-Rabatt auf alle eSIMs'),
  (3, true,  10, 'percentage', '10% Donnerstags-Rabatt auf alle eSIMs'),
  (4, true,  15, 'percentage', '15% Freitags-Rabatt – Happy Friday!'),
  (5, true,  20, 'percentage', '20% Wochenend-Rabatt auf alle eSIMs'),
  (6, true,  20, 'percentage', '20% Wochenend-Rabatt auf alle eSIMs')
ON CONFLICT (weekday) DO NOTHING;
