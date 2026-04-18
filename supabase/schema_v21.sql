-- schema_v21.sql  ──  Safelist v2: Feedback-System + Auto-Delete Tracking

-- Feedback Tabelle (ersetzt safelist_entries für User-Feedbacks)
CREATE TABLE IF NOT EXISTS user_feedbacks (
  id            BIGSERIAL    PRIMARY KEY,
  channel_id    TEXT         NOT NULL,
  target_user_id BIGINT,
  target_username TEXT,
  target_tg_profile JSONB DEFAULT '{}', -- gespeichertes TG-Profil
  feedback_type TEXT         NOT NULL,  -- 'positive' | 'negative'
  feedback_text TEXT,
  submitted_by  BIGINT,
  submitted_by_username TEXT,
  has_proofs    BOOLEAN      DEFAULT false,
  proof_count   INTEGER      DEFAULT 0,
  status        TEXT         DEFAULT 'pending', -- 'pending'|'approved'|'rejected'
  reviewed_by   BIGINT,
  ai_summary    TEXT,         -- von OpenAI, nur wenn ai_enabled
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Proof-Medien zu Feedbacks
CREATE TABLE IF NOT EXISTS feedback_proofs (
  id           BIGSERIAL    PRIMARY KEY,
  feedback_id  BIGINT       NOT NULL REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  proof_type   TEXT         NOT NULL, -- 'text'|'photo'|'video'|'document'
  file_id      TEXT,
  caption      TEXT,
  content      TEXT,
  submitted_by BIGINT,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Scamlist (bestätigte Scammer, mit TG-Profil)
CREATE TABLE IF NOT EXISTS scam_entries (
  id            BIGSERIAL    PRIMARY KEY,
  channel_id    TEXT         NOT NULL,
  user_id       BIGINT,
  username      TEXT,
  tg_profile    JSONB        DEFAULT '{}',
  reason        TEXT,
  ai_summary    TEXT,
  added_by      BIGINT,
  feedback_ids  JSONB        DEFAULT '[]', -- Verknüpfte Feedback-IDs
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);

-- Bot-Nachrichten-Tracking für Auto-Delete
CREATE TABLE IF NOT EXISTS bot_messages (
  id           BIGSERIAL    PRIMARY KEY,
  channel_id   TEXT         NOT NULL,
  message_id   BIGINT       NOT NULL,
  msg_type     TEXT         NOT NULL, -- 'temp'|'permanent'|'check_result'
  delete_after TIMESTAMPTZ,           -- NULL = manuell, gesetzt = auto-delete
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Channel-Kontext-Cache (letzte Nachrichten pro User für /ai)
CREATE TABLE IF NOT EXISTS channel_context (
  id         BIGSERIAL    PRIMARY KEY,
  channel_id TEXT         NOT NULL,
  user_id    BIGINT       NOT NULL,
  username   TEXT,
  message    TEXT         NOT NULL,
  msg_date   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(channel_id, user_id, message)
);

CREATE INDEX IF NOT EXISTS idx_user_feedbacks_target  ON user_feedbacks(target_user_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_user_feedbacks_status  ON user_feedbacks(status, channel_id);
CREATE INDEX IF NOT EXISTS idx_scam_entries_channel   ON scam_entries(channel_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bot_messages_delete    ON bot_messages(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channel_context        ON channel_context(channel_id, user_id);

NOTIFY pgrst, 'reload schema';
