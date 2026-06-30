-- ════════════════════════════════════════════════════════════════════════════
--   AdminHelper Datenbank-Schema (v2.0.24) - Komplette Neuinstallation
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  webhook_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── Push-Notifications ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL UNIQUE,
  subscription_data JSONB NOT NULL,
  device_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bot Channels (Gruppen und Channels) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_channels (
  id TEXT PRIMARY KEY,
  title TEXT,
  username TEXT,
  type TEXT,
  is_active BOOLEAN DEFAULT true,
  is_approved BOOLEAN DEFAULT false,
  ai_enabled BOOLEAN DEFAULT false,
  bot_language TEXT DEFAULT 'de',
  added_by_user_id TEXT,
  added_by_username TEXT,
  settings_token TEXT,
  auto_clean_interval TEXT,
  last_clean_at TIMESTAMPTZ,
  token_used INTEGER DEFAULT 0,
  token_limit INTEGER DEFAULT 50000,
  credits_expire_at TIMESTAMPTZ,
  welcome_msg TEXT,
  goodbye_msg TEXT,
  bl_hard_consequences BOOLEAN DEFAULT false,
  bl_soft_delete_hours INTEGER DEFAULT 24,
  diss_battle_arena_chat_id TEXT,
  quiet_start TEXT,
  quiet_end TEXT,
  quiet_tz TEXT DEFAULT 'Europe/Berlin',
  quiet_mode TEXT,
  quiet_allow_scheduled BOOLEAN DEFAULT false,
  quiet_active BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Channel Mitglieder ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  first_name TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT false,
  message_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_last_seen ON channel_members(last_seen DESC);

-- ─── Co-Admins ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_co_admins (
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- ─── KI-Wissensdatenbank (RAG) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  title TEXT,
  category TEXT,
  content TEXT,
  embedding vector(1536),
  source TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_embedding ON channel_knowledge 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── Safelist / Scamliste ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_safelist (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  score INTEGER DEFAULT 0,
  added_by BIGINT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safelist_user ON channel_safelist(channel_id, user_id);

CREATE TABLE IF NOT EXISTS channel_blacklist (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  added_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Multi-Gruppen / Verknüpfungen ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES channel_groups(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT false,
  CONSTRAINT unique_group_channel UNIQUE(group_id, channel_id)
);

-- ─── Credit Pakete & Käufe ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  credits INTEGER NOT NULL,
  price_eur NUMERIC(10, 2) NOT NULL,
  duration_days INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO channel_packages (id, name, credits, price_eur, duration_days, is_active) VALUES
  (1, 'Starter', 10000, 4.99, 30, true),
  (2, 'Pro',     50000, 19.99, 90, true),
  (3, 'Business', 250000, 79.99, 180, true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS channel_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES channel_packages(id) ON DELETE SET NULL,
  credits_added INTEGER,
  price_paid NUMERIC(10, 2),
  payment_id TEXT,
  payment_provider TEXT,
  status TEXT,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_refills (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  credits_added INTEGER,
  amount_eur NUMERIC(10, 2),
  payment_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Nachrichten Log / Auto-Delete ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_messages (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  msg_type TEXT,
  delete_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_messages_delete ON bot_messages(delete_after ASC);

-- ─── Geplante Nachrichten (Scheduled) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  message TEXT,
  variations TEXT[],
  variation_index INTEGER DEFAULT 0,
  inline_buttons TEXT,
  photo_file_id TEXT,
  photo_url TEXT,
  file_type TEXT,
  pin_after_send BOOLEAN DEFAULT false,
  delete_previous BOOLEAN DEFAULT false,
  last_sent_msg_id BIGINT,
  repeat BOOLEAN DEFAULT false,
  interval_minutes INTEGER,
  next_run_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_run ON scheduled_messages(is_active, next_run_at ASC);

-- ─── Scam Liste ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scam_entries (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  reason TEXT,
  added_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scam_user ON scam_entries(channel_id, user_id);

-- ─── Reputation ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_reputation (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  reputation INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reputation_user ON user_reputation(channel_id, user_id);

-- ─── Diss Battles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_diss_battles (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  challenger_id BIGINT,
  challenger_name TEXT,
  target_id BIGINT,
  target_name TEXT,
  status TEXT DEFAULT 'pending',
  winner_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_diss_battle_messages (
  id SERIAL PRIMARY KEY,
  battle_id INTEGER REFERENCES channel_diss_battles(id) ON DELETE CASCADE,
  user_id BIGINT,
  user_name TEXT,
  message TEXT,
  score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Admin Reports ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_reports (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  reporter_id BIGINT,
  reported_user_id BIGINT,
  reported_message_id BIGINT,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Logs & Verlauf ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_identity_log (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identity_log(user_id);

CREATE TABLE IF NOT EXISTS user_name_history (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_user_status (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  is_banned BOOLEAN DEFAULT false,
  is_muted BOOLEAN DEFAULT false,
  mute_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_channel_user UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS blacklist_hits (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  word TEXT,
  action_taken TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  summary_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_chat_history (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  role TEXT,
  content TEXT,
  msg_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_spam_violations (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  violation_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  tokens_used INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Feedbacks & Proofs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_feedbacks (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  user_id BIGINT,
  username TEXT,
  feedback_text TEXT,
  status TEXT DEFAULT 'pending',
  proof_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proof_sessions (
  id SERIAL PRIMARY KEY,
  feedback_id INTEGER REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  user_id BIGINT,
  channel_id TEXT,
  status TEXT DEFAULT 'collecting',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback_proofs (
  id SERIAL PRIMARY KEY,
  feedback_id INTEGER REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  proof_type TEXT,
  file_id TEXT,
  content TEXT,
  caption TEXT,
  submitted_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id SERIAL PRIMARY KEY,
  channel_id TEXT REFERENCES bot_channels(id) ON DELETE CASCADE,
  message_id BIGINT,
  user_id BIGINT,
  reaction TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── RPC-Funktionen ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expire_channel_packages()
RETURNS void AS $$
BEGIN
  -- Setze abgelaufene Käufe zurück oder markiere sie
  UPDATE bot_channels
  SET token_limit = 50000, credits_expire_at = NULL
  WHERE credits_expire_at < NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_channel_id text
) RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT ck.id, ck.title, ck.content,
         1 - (ck.embedding <=> query_embedding) AS similarity
  FROM channel_knowledge ck
  WHERE ck.channel_id = p_channel_id
    AND ck.embedding IS NOT NULL
    AND 1 - (ck.embedding <=> query_embedding) > match_threshold
  ORDER BY ck.embedding <=> query_embedding
  LIMIT match_count;
$$;
