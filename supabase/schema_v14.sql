-- schema_v14.sql  ──  v1.4 Dual-Agent + Channel Management
-- Alle Statements sind idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- ── Bot-Channels (Telegram-Gruppen/Channels wo der Bot Admin ist) ─────────
CREATE TABLE IF NOT EXISTS bot_channels (
  id          BIGINT PRIMARY KEY,        -- Telegram chat_id (negativ bei Gruppen/Channels)
  title       TEXT,
  username    TEXT,
  type        TEXT,                      -- 'channel', 'supergroup', 'group'
  mode        TEXT    DEFAULT 'smalltalk', -- 'smalltalk' | 'berater'
  is_active   BOOLEAN DEFAULT true,
  ai_command  TEXT    DEFAULT '/ai',     -- Trigger-Befehl
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Smalltalk-Einstellungen in settings-Tabelle ────────────────────────────
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_system_prompt  TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_model           TEXT    DEFAULT 'deepseek-chat';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_max_tokens      INTEGER DEFAULT 200;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_temperature     NUMERIC DEFAULT 0.8;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smalltalk_kb_category_id  INTEGER;  -- ID der "Smalltalk" Kategorie

-- ── Klarheits-Tracking in messages ────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS clarity_score    NUMERIC;  -- 0.0–1.0, null = nicht geprüft
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_mode       TEXT;     -- 'berater' | 'smalltalk'
