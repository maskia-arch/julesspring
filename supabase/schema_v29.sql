-- schema_v29.sql  --  Blacklist system

CREATE TABLE IF NOT EXISTS channel_blacklist (
  id           BIGSERIAL   PRIMARY KEY,
  channel_id   TEXT        NOT NULL,
  word         TEXT        NOT NULL,
  category     TEXT        DEFAULT 'allgemein',
  severity     TEXT        DEFAULT 'warn',   -- warn | mute | ban | tolerated
  tolerate_hours INTEGER   DEFAULT NULL,     -- only for severity=tolerated
  created_by   BIGINT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, word)
);

CREATE INDEX IF NOT EXISTS idx_blacklist_channel ON channel_blacklist(channel_id);

-- Blacklist hits log
CREATE TABLE IF NOT EXISTS blacklist_hits (
  id          BIGSERIAL   PRIMARY KEY,
  channel_id  TEXT        NOT NULL,
  user_id     BIGINT,
  username    TEXT,
  word_hit    TEXT,
  message_text TEXT,
  action_taken TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

NOTIFY pgrst, 'reload schema';
