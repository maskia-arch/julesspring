-- schema15.sql – v1.3.18: KI-Aufruf-Tracking für Coupons
ALTER TABLE daily_coupons ADD COLUMN IF NOT EXISTS ki_call_count INTEGER DEFAULT 0;
ALTER TABLE daily_coupons ADD COLUMN IF NOT EXISTS weekday       INTEGER;  -- 0=Mo...6=So (gesetzt beim Erstellen)
