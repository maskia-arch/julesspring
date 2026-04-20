-- Schema v34: Enhanced Feedback System + Safe/Scam Lists
-- Run after v33-2. Safe to re-run.

-- ── Add feedback_enabled toggle per channel ───────────────────────────────────
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS feedback_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── Add feedback_score per user (aggregate) ───────────────────────────────────
-- We track score in user_feedbacks via computed view, but also cache it
CREATE TABLE IF NOT EXISTS user_reputation (
  id              BIGSERIAL     PRIMARY KEY,
  channel_id      TEXT          NOT NULL,
  user_id         BIGINT        NOT NULL,
  username        TEXT,
  display_name    TEXT,
  score           INTEGER       NOT NULL DEFAULT 0,  -- +1 pos, -10 neg
  pos_count       INTEGER       NOT NULL DEFAULT 0,
  neg_count       INTEGER       NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rep_channel_score ON user_reputation(channel_id, score DESC);

-- ── Add pending_feedback_confirm table for 5-min confirmation window ──────────
CREATE TABLE IF NOT EXISTS pending_feedback_confirms (
  id              BIGSERIAL     PRIMARY KEY,
  channel_id      TEXT          NOT NULL,
  channel_msg_id  BIGINT        NOT NULL,  -- message_id of the prompt in channel
  submitter_id    BIGINT        NOT NULL,  -- who submitted the original message
  target_username TEXT          NOT NULL,
  original_text   TEXT,
  expires_at      TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  resolved        BOOLEAN       NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pfc_channel ON pending_feedback_confirms(channel_id, resolved);
CREATE INDEX IF NOT EXISTS idx_pfc_expires ON pending_feedback_confirms(expires_at) WHERE resolved = false;

-- ── Add proof_session for DM proof collection ─────────────────────────────────
-- (in-memory is fine, but DB fallback for persistence)
CREATE TABLE IF NOT EXISTS proof_sessions (
  id              BIGSERIAL     PRIMARY KEY,
  feedback_id     BIGINT        NOT NULL REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  user_id         BIGINT        NOT NULL,
  channel_id      TEXT          NOT NULL,
  status          TEXT          NOT NULL DEFAULT 'collecting', -- 'collecting'|'done'|'cancelled'
  proof_count     INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ── RPC: update user reputation (called after feedback approved) ──────────────
CREATE OR REPLACE FUNCTION update_user_reputation(
  p_channel_id  TEXT,
  p_user_id     BIGINT,
  p_username    TEXT,
  p_delta       INTEGER         -- +1 for positive, -10 for negative
) RETURNS INTEGER               -- new score
LANGUAGE plpgsql AS $$
DECLARE v_score INTEGER;
BEGIN
  INSERT INTO user_reputation(channel_id, user_id, username, score,
    pos_count, neg_count, last_updated)
  VALUES (p_channel_id, p_user_id, p_username, p_delta,
    CASE WHEN p_delta > 0 THEN 1 ELSE 0 END,
    CASE WHEN p_delta < 0 THEN 1 ELSE 0 END,
    NOW())
  ON CONFLICT(channel_id, user_id) DO UPDATE
    SET score        = user_reputation.score + p_delta,
        pos_count    = user_reputation.pos_count + CASE WHEN p_delta > 0 THEN 1 ELSE 0 END,
        neg_count    = user_reputation.neg_count + CASE WHEN p_delta < 0 THEN 1 ELSE 0 END,
        username     = COALESCE(p_username, user_reputation.username),
        last_updated = NOW()
  RETURNING score INTO v_score;
  RETURN v_score;
END;
$$;

-- ── RPC: top 10 seller ranking for a channel ─────────────────────────────────
CREATE OR REPLACE FUNCTION get_top_sellers(p_channel_id TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE(
  rank        BIGINT,
  user_id     BIGINT,
  username    TEXT,
  display_name TEXT,
  score       INTEGER,
  pos_count   INTEGER,
  neg_count   INTEGER
) LANGUAGE sql STABLE AS $$
  SELECT
    ROW_NUMBER() OVER (ORDER BY score DESC, pos_count DESC) AS rank,
    user_id, username, display_name, score, pos_count, neg_count
  FROM user_reputation
  WHERE channel_id = p_channel_id
    AND score > 0
  ORDER BY score DESC, pos_count DESC
  LIMIT p_limit;
$$;
