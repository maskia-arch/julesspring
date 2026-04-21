-- Schema v35: Dedicated safelist table (replaces user_feedbacks for safelist view)
-- Unique constraint per channel+user, cross-list enforcement via DB trigger.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS channel_safelist (
  id          BIGSERIAL    PRIMARY KEY,
  channel_id  TEXT         NOT NULL,
  user_id     BIGINT,
  username    TEXT,
  score       INTEGER      NOT NULL DEFAULT 0,
  added_by    BIGINT,
  note        TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(channel_id, user_id),
  UNIQUE(channel_id, username)
);

CREATE INDEX IF NOT EXISTS idx_safelist_channel ON channel_safelist(channel_id);

-- Ensure scam_entries also has UNIQUE constraint (idempotent)
-- Already exists from schema_v21: UNIQUE(channel_id, user_id)
-- Add UNIQUE on username too (best effort)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='scam_entries' AND indexname='idx_scam_channel_username'
  ) THEN
    CREATE UNIQUE INDEX idx_scam_channel_username ON scam_entries(channel_id, username)
      WHERE username IS NOT NULL;
  END IF;
END $$;

-- Migrate existing approved positive feedbacks → channel_safelist
-- Only migrate rows that have a target_username (skip anonymous)
INSERT INTO channel_safelist (channel_id, user_id, username, added_by, note, created_at)
SELECT DISTINCT ON (channel_id, COALESCE(target_user_id, 0), target_username)
  channel_id,
  target_user_id,
  target_username,
  submitted_by,
  feedback_text,
  created_at
FROM user_feedbacks
WHERE feedback_type = 'positive'
  AND status = 'approved'
  AND (target_user_id IS NOT NULL OR target_username IS NOT NULL)
ON CONFLICT (channel_id, user_id) DO NOTHING;

-- Sync reputation scores into safelist
UPDATE channel_safelist sl
SET score = ur.score
FROM user_reputation ur
WHERE sl.channel_id = ur.channel_id
  AND sl.user_id = ur.user_id
  AND ur.score <> 0;
