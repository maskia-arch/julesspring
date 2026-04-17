-- schema_v19.sql  ──  Channel Admin tracking

-- Admin-User-ID und Dashboard-Zugriff pro Channel
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS added_by_user_id   BIGINT;   -- Telegram user_id des Admins
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS added_by_username   TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS admin_user_ids      JSONB DEFAULT '[]'; -- Alle admins
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS settings_token      TEXT;    -- Einmaliger Deep-Link-Token

CREATE INDEX IF NOT EXISTS idx_bot_channels_added_by ON bot_channels(added_by_user_id);
