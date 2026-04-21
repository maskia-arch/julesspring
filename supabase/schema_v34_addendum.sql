-- Schema v34 addendum: new columns for v1.4.50 features
-- Safe to re-run on top of schema_v34

-- Smalltalk model preference per channel (deepseek = standard x1.0, openai = x1.2)
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS smalltalk_model TEXT DEFAULT 'deepseek';

-- Blacklist: delete_after_hours for tolerated words
ALTER TABLE channel_blacklist ADD COLUMN IF NOT EXISTS delete_after_hours INTEGER DEFAULT 24;

-- Reputation table (in case schema_v34 wasn't applied yet)
CREATE TABLE IF NOT EXISTS user_reputation (
  id              BIGSERIAL     PRIMARY KEY,
  channel_id      TEXT          NOT NULL,
  user_id         BIGINT        NOT NULL,
  username        TEXT,
  display_name    TEXT,
  score           INTEGER       NOT NULL DEFAULT 0,
  pos_count       INTEGER       NOT NULL DEFAULT 0,
  neg_count       INTEGER       NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_rep_channel_score ON user_reputation(channel_id, score DESC);

-- get_top_sellers RPC (idempotent)
CREATE OR REPLACE FUNCTION get_top_sellers(p_channel_id TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE(rank BIGINT, user_id BIGINT, username TEXT, display_name TEXT, score INTEGER, pos_count INTEGER, neg_count INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT ROW_NUMBER() OVER (ORDER BY score DESC, pos_count DESC),
         user_id, username, display_name, score, pos_count, neg_count
  FROM user_reputation
  WHERE channel_id = p_channel_id AND score > 0
  ORDER BY score DESC, pos_count DESC LIMIT p_limit;
$$;
