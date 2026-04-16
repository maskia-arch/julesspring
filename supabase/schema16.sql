-- schema_v16.sql  ──  v1.4.0-2 Dual-Bot + Channel Management + Token Limits
-- Alle Statements sind idempotent

CREATE TABLE IF NOT EXISTS bot_channels (
  id              BIGINT PRIMARY KEY,
  title           TEXT,
  username        TEXT,
  type            TEXT,
  bot_type        TEXT DEFAULT 'smalltalk',
  mode            TEXT DEFAULT 'smalltalk',
  is_active       BOOLEAN DEFAULT false,
  ai_command      TEXT DEFAULT '/ai',
  token_limit     INTEGER DEFAULT NULL,
  token_used      INTEGER DEFAULT 0,
  usd_limit       NUMERIC DEFAULT NULL,
  usd_spent       NUMERIC DEFAULT 0,
  limit_message   TEXT DEFAULT 'Deine Token sind verbraucht. Melde dich bei @autoacts für weitere Nutzung.',
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  approved_at     TIMESTAMPTZ,
  last_active_at  TIMESTAMPTZ
);

-- is_approved als separate Migration (Tabelle könnte schon ohne diese Spalte existieren)
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_system_prompt    TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_model             TEXT    DEFAULT 'deepseek-chat';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_max_tokens        INTEGER DEFAULT 200;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_temperature       NUMERIC DEFAULT 0.8;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_kb_category_id    INTEGER;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_bot_token         TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_bot_username      TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_require_approval  BOOLEAN DEFAULT true;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS clarity_score  NUMERIC;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_mode     TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_channels_active ON bot_channels(is_active, is_approved);
