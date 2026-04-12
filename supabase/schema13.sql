-- schema13.sql – v1.3.6: Session-Tracking & Dedup
-- Führe nach schema12.sql aus

-- 1. Besucher-Sessions (eine Session = ein kontinuierlicher Website-Besuch)
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      TEXT        NOT NULL,
  visitor_id   UUID        REFERENCES widget_visitors(id),
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  duration_sec INTEGER     DEFAULT 0,
  page_count   INTEGER     DEFAULT 1,
  entry_page   TEXT,
  last_page    TEXT,
  is_active    BOOLEAN     DEFAULT true,
  had_chat     BOOLEAN     DEFAULT false,  -- Hat der Besucher gechattet?
  push_sent    BOOLEAN     DEFAULT false   -- Wurde Push schon gesendet?
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_id  ON visitor_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active   ON visitor_sessions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_sessions_started  ON visitor_sessions(started_at DESC);

-- 2. Activity-Tabelle: session_id Referenz
ALTER TABLE visitor_activities ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES visitor_sessions(id);

-- 3. Chats: is_manual_mode Timestamp (für Message-Filterung)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS manual_mode_started_at TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS manual_mode_ended_at   TIMESTAMPTZ;

-- 4. Messages: Flag für "gesendet während Manual Mode"
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_during_manual BOOLEAN DEFAULT false;
