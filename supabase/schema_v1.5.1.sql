CREATE TABLE IF NOT EXISTS user_name_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_name_history_user ON user_name_history(user_id, detected_at DESC);
NOTIFY pgrst, 'reload schema';
