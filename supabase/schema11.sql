-- schema11.sql – Widget v1.3: Visitor Tracking & IP Management
-- Führe nach schema10.sql aus

-- 1. Visitor Fingerprints: IP → persistent ChatID Mapping
CREATE TABLE IF NOT EXISTS widget_visitors (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      TEXT        NOT NULL UNIQUE,  -- generierte ChatID für diesen Besucher
  ip           TEXT        NOT NULL,
  ip_hash      TEXT        NOT NULL,          -- SHA256 des IPs für Ban-Checks
  user_agent   TEXT,
  fingerprint  TEXT,                          -- Browser-Fingerprint (optional)
  country      TEXT,
  first_seen   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  page_count   INTEGER     DEFAULT 1,
  is_banned    BOOLEAN     DEFAULT false,
  ban_reason   TEXT,
  banned_at    TIMESTAMPTZ,
  metadata     JSONB       DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_visitors_ip       ON widget_visitors(ip);
CREATE INDEX IF NOT EXISTS idx_visitors_ip_hash  ON widget_visitors(ip_hash);
CREATE INDEX IF NOT EXISTS idx_visitors_chat_id  ON widget_visitors(chat_id);
CREATE INDEX IF NOT EXISTS idx_visitors_banned   ON widget_visitors(is_banned) WHERE is_banned = true;

-- 2. Aktivitäts-Log: unsichtbare Admin-Notizen
CREATE TABLE IF NOT EXISTS visitor_activities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      TEXT        NOT NULL,
  activity     TEXT        NOT NULL,    -- z.B. "Besucht: Germany eSIM"
  page_url     TEXT,
  page_title   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_chat_id   ON visitor_activities(chat_id);
CREATE INDEX IF NOT EXISTS idx_activities_created   ON visitor_activities(created_at DESC);

-- 3. Chats: IP-Referenz hinzufügen
ALTER TABLE chats ADD COLUMN IF NOT EXISTS visitor_ip    TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS visitor_id    UUID REFERENCES widget_visitors(id);

-- 4. Blacklist: IP-Eintrag unterstützen
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS ip_hash    TEXT;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS ban_scope  TEXT DEFAULT 'id'; -- 'id' | 'ip' | 'fingerprint'

CREATE INDEX IF NOT EXISTS idx_blacklist_ip_hash ON blacklist(ip_hash) WHERE ip_hash IS NOT NULL;
