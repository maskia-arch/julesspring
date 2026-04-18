-- schema_v25.sql  ──  Per-User Channel Chat History

-- Vollständiger Gesprächsverlauf pro User pro Channel
CREATE TABLE IF NOT EXISTS channel_chat_history (
  id          BIGSERIAL    PRIMARY KEY,
  channel_id  TEXT         NOT NULL,
  user_id     BIGINT       NOT NULL,
  role        TEXT         NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT         NOT NULL,
  msg_id      BIGINT,      -- Telegram message_id für Reply-Erkennung
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user    ON channel_chat_history(channel_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_history_msg_id  ON channel_chat_history(channel_id, msg_id) WHERE msg_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
