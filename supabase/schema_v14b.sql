-- schema_v14b.sql  ──  Fehlende bot_channels Spalten nachträglich hinzufügen
-- Ausführen wenn bot_type Fehler im Log erscheint
-- Alle Statements idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS bot_type       TEXT    DEFAULT 'smalltalk';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS mode           TEXT    DEFAULT 'smalltalk';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS ai_command     TEXT    DEFAULT '/ai';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS is_approved    BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS ai_enabled     BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS safelist_enabled BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS welcome_msg    TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS goodbye_msg    TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS system_prompt  TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS kb_initialized BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS kb_entry_count INTEGER DEFAULT 0;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS token_limit    INTEGER DEFAULT NULL;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS token_used     INTEGER DEFAULT 0;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS usd_limit      NUMERIC DEFAULT NULL;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS usd_spent      NUMERIC DEFAULT 0;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS limit_message  TEXT    DEFAULT 'Deine Token sind verbraucht. Melde dich bei @autoacts.';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS added_by_user_id   BIGINT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS added_by_username   TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS admin_user_ids      JSONB DEFAULT '[]';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS settings_token      TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS last_active_at      TIMESTAMPTZ;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS safelist_channel    BIGINT;

-- Refresh Supabase Schema Cache (wichtig nach ALTER TABLE)
NOTIFY pgrst, 'reload schema';
