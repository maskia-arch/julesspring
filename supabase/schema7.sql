-- ============================================================
-- SCHEMA v7 – Webhook URL persistent speichern
-- ============================================================
ALTER TABLE settings ADD COLUMN IF NOT EXISTS webhook_url TEXT DEFAULT '';

-- Aktuellen Wert aus APP_URL setzen falls vorhanden (optional)
-- UPDATE settings SET webhook_url = 'https://dein-bot.onrender.com' WHERE id = 1;
