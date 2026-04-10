-- schema10.sql – Abuse Detection & Flagging System
-- Führe nach allen vorherigen Schemas aus

-- 1. User-Flags Tabelle
CREATE TABLE IF NOT EXISTS user_flags (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     TEXT    NOT NULL,
  reason      TEXT    NOT NULL,       -- 'troll', 'spam', 'abuse', 'manual'
  auto_flagged BOOLEAN DEFAULT false,
  flagged_by  TEXT    DEFAULT 'system',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flags_chat_id ON user_flags(chat_id);

-- 2. Chats: Abuse-Tracking Spalten
ALTER TABLE chats ADD COLUMN IF NOT EXISTS flag_count     INTEGER DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS auto_muted     BOOLEAN DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS mute_reason    TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS msg_count_1h   INTEGER DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_msg_burst TIMESTAMPTZ;

-- 3. Settings: Abuse-Schwellwerte (konfigurierbar)
ALTER TABLE settings ADD COLUMN IF NOT EXISTS abuse_max_msgs_per_hour INTEGER DEFAULT 30;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS abuse_auto_ban_flags    INTEGER DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS abuse_min_msg_length    INTEGER DEFAULT 1;

-- 4. Blacklist: Sicherstellen dass reason-Spalte existiert
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS auto_banned BOOLEAN DEFAULT false;

-- 5. Index für schnelle Flag-Abfragen
CREATE INDEX IF NOT EXISTS idx_chats_flag_count ON chats(flag_count) WHERE flag_count > 0;
CREATE INDEX IF NOT EXISTS idx_chats_auto_muted ON chats(auto_muted) WHERE auto_muted = true;
