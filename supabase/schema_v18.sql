-- schema_v18.sql  ──  TG Admin Helper + Safelist

-- Geplante Nachrichten
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id           BIGSERIAL PRIMARY KEY,
  channel_id   BIGINT NOT NULL,
  message      TEXT NOT NULL,
  photo_url    TEXT,
  photo_file_id TEXT,
  cron_expr    TEXT,                    -- "0 9 * * 1" = Mo 09:00
  next_run_at  TIMESTAMPTZ,
  is_active    BOOLEAN DEFAULT true,
  repeat       BOOLEAN DEFAULT false,
  run_count    INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Member-Tracking (für Deleted-Account-Cleanup)
CREATE TABLE IF NOT EXISTS channel_members (
  id         BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL,
  user_id    BIGINT NOT NULL,
  username   TEXT,
  first_name TEXT,
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen  TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT false,
  UNIQUE(channel_id, user_id)
);

-- Safelist / Scamlist
CREATE TABLE IF NOT EXISTS safelist_entries (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    BIGINT,                 -- NULL = global
  user_id       BIGINT,                 -- Telegram user_id
  username      TEXT,
  list_type     TEXT NOT NULL,          -- 'safe' | 'scam' | 'pending'
  feedback_text TEXT,
  summary       TEXT,                   -- KI-Zusammenfassung
  evidence_msgs JSONB DEFAULT '[]',     -- Beweisnachrichten
  submitted_by  BIGINT,                 -- Telegram user_id des Einreichers
  reviewed_by   BIGINT,                 -- Admin user_id
  status        TEXT DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Channel AI-Aktivierung Flags
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS ai_enabled        BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS safelist_enabled  BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS welcome_msg       TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS goodbye_msg       TEXT;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS safelist_channel  BIGINT;  -- Wohin Safelist-Reviews gesendet werden

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_channel ON scheduled_messages(channel_id, is_active);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel    ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_safelist_entries_type      ON safelist_entries(list_type, status);
