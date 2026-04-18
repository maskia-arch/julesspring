-- schema_v22.sql  ──  Scheduled msg options, daily summary, channel token tracking

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS pin_after_send   BOOLEAN DEFAULT false;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS delete_previous  BOOLEAN DEFAULT false;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS previous_msg_id  BIGINT  DEFAULT NULL;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_sent_msg_id BIGINT  DEFAULT NULL;

-- Daily summary log
CREATE TABLE IF NOT EXISTS daily_summaries (
  id            BIGSERIAL    PRIMARY KEY,
  channel_id    TEXT         NOT NULL,
  summary_text  TEXT         NOT NULL,
  member_joins  INTEGER      DEFAULT 0,
  member_leaves INTEGER      DEFAULT 0,
  msg_count     INTEGER      DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(channel_id, (date_trunc('day', created_at)))
);

-- Channel token spent tracking (for cost display)
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS token_budget_exhausted   BOOLEAN DEFAULT false;
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS last_summary_at          TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
