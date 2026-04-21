CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  system_prompt TEXT NOT NULL DEFAULT 'Du bist ein hilfreicher Assistent.',
  negative_prompt TEXT DEFAULT '',
  welcome_message TEXT DEFAULT 'Willkommen! 👋 Ich bin dein KI-Assistent.',
  manual_msg_template TEXT DEFAULT 'Ein Mitarbeiter wird gleich übernehmen.',
  ai_model TEXT DEFAULT 'deepseek-chat',
  ai_max_tokens INTEGER DEFAULT 1024,
  ai_temperature NUMERIC DEFAULT 0.5,
  ai_max_input_tokens INTEGER DEFAULT 4096,
  rag_threshold NUMERIC DEFAULT 0.45,
  rag_match_count INTEGER DEFAULT 8,
  max_history_msgs INTEGER DEFAULT 4,
  summary_interval INTEGER DEFAULT 5,
  sellauth_api_key TEXT DEFAULT '',
  sellauth_shop_id TEXT DEFAULT '',
  sellauth_shop_url TEXT DEFAULT '',
  admin_telegram_id TEXT DEFAULT '',
  notify_new_chat BOOLEAN DEFAULT true,
  notify_every_msg BOOLEAN DEFAULT false,
  webhook_url TEXT DEFAULT '',
  widget_powered_by TEXT DEFAULT 'Powered by ValueShop25 AI',
  abuse_max_msgs_per_hour INTEGER DEFAULT 30,
  abuse_auto_ban_flags INTEGER DEFAULT 3,
  abuse_min_msg_length INTEGER DEFAULT 1,
  coupon_enabled BOOLEAN DEFAULT false,
  coupon_discount INTEGER DEFAULT 10,
  coupon_type TEXT DEFAULT 'percentage',
  coupon_description TEXT DEFAULT '10% Rabatt',
  coupon_max_uses INTEGER DEFAULT NULL,
  coupon_schedule_hour INTEGER DEFAULT 0,
  smalltalk_system_prompt TEXT,
  smalltalk_model TEXT DEFAULT 'deepseek-chat',
  smalltalk_max_tokens INTEGER DEFAULT 200,
  smalltalk_temperature NUMERIC DEFAULT 0.8,
  smalltalk_kb_category_id INTEGER,
  smalltalk_bot_token TEXT,
  smalltalk_bot_username TEXT,
  smalltalk_bot_firstname TEXT,
  smalltalk_require_approval BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'telegram',
  status TEXT DEFAULT 'ki' CHECK (status IN ('ki', 'manual')),
  is_manual_mode BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  last_message TEXT,
  last_message_role TEXT DEFAULT 'user',
  message_count INTEGER DEFAULT 0,
  first_name TEXT,
  username TEXT,
  chat_summary TEXT,
  summary_msg_count INTEGER DEFAULT 0,
  last_summarized_at TIMESTAMPTZ,
  flag_count INTEGER DEFAULT 0,
  auto_muted BOOLEAN DEFAULT false,
  mute_reason TEXT,
  msg_count_1h INTEGER DEFAULT 0,
  last_msg_burst TIMESTAMPTZ,
  visitor_ip TEXT,
  visitor_id UUID,
  manual_mode_started_at TIMESTAMPTZ,
  manual_mode_ended_at TIMESTAMPTZ,
  is_learning_session BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  embedding_tokens INTEGER DEFAULT 0,
  is_manual BOOLEAN DEFAULT false,
  sent_during_manual BOOLEAN DEFAULT false,
  clarity_score NUMERIC,
  agent_mode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#4a9eff',
  icon TEXT DEFAULT '📌',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  source TEXT,
  external_id TEXT UNIQUE,
  title TEXT,
  category_id INTEGER REFERENCES knowledge_categories(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT UNIQUE,
  reason TEXT,
  ip_hash TEXT,
  ban_scope TEXT DEFAULT 'id',
  auto_banned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_chat_id TEXT,
  unanswered_question TEXT,
  context TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT,
  event_type TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  auto_flagged BOOLEAN DEFAULT false,
  flagged_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS widget_visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL UNIQUE,
  ip TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  fingerprint TEXT,
  country TEXT,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  page_count INTEGER DEFAULT 1,
  is_banned BOOLEAN DEFAULT false,
  ban_reason TEXT,
  banned_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS visitor_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  session_id UUID,
  activity TEXT NOT NULL,
  page_url TEXT,
  page_title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visitor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  visitor_id UUID REFERENCES widget_visitors(id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_sec INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 1,
  entry_page TEXT,
  last_page TEXT,
  is_active BOOLEAN DEFAULT true,
  had_chat BOOLEAN DEFAULT false,
  push_sent BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS daily_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'percentage',
  description TEXT,
  sellauth_id TEXT,
  ki_call_count INTEGER DEFAULT 0,
  weekday INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  used_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coupon_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday INTEGER NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT true,
  discount INTEGER NOT NULL DEFAULT 10,
  type TEXT NOT NULL DEFAULT 'percentage',
  description TEXT,
  max_uses INTEGER DEFAULT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_channels (
  id BIGINT PRIMARY KEY,
  title TEXT,
  username TEXT,
  type TEXT,
  bot_type TEXT DEFAULT 'smalltalk',
  mode TEXT DEFAULT 'smalltalk',
  is_active BOOLEAN DEFAULT false,
  is_approved BOOLEAN DEFAULT false,
  ai_enabled BOOLEAN DEFAULT false,
  safelist_enabled BOOLEAN DEFAULT false,
  feedback_enabled BOOLEAN NOT NULL DEFAULT false,
  ai_command TEXT DEFAULT '/ai',
  system_prompt TEXT,
  welcome_msg TEXT,
  goodbye_msg TEXT,
  token_limit INTEGER DEFAULT NULL,
  token_used INTEGER DEFAULT 0,
  usd_limit NUMERIC DEFAULT NULL,
  usd_spent NUMERIC DEFAULT 0,
  limit_message TEXT DEFAULT 'Deine Token sind verbraucht.',
  kb_initialized BOOLEAN DEFAULT false,
  kb_entry_count INTEGER DEFAULT 0,
  added_by_user_id BIGINT,
  added_by_username TEXT,
  admin_user_ids JSONB DEFAULT '[]',
  settings_token TEXT,
  safelist_channel BIGINT,
  channel_group_id BIGINT REFERENCES channel_groups(id),
  token_budget_exhausted BOOLEAN DEFAULT false,
  last_summary_at TIMESTAMPTZ,
  ai_model TEXT DEFAULT 'deepseek-chat',
  smalltalk_model TEXT DEFAULT 'deepseek',
  blocked_thread_ids JSONB DEFAULT '[]',
  bot_language TEXT DEFAULT 'de',
  last_summary_tokens INTEGER DEFAULT 0,
  credits_expire_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS channel_group_members (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, channel_id)
);

CREATE TABLE IF NOT EXISTS channel_knowledge (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'allgemein',
  title TEXT,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  source TEXT DEFAULT 'manual',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  photo_url TEXT,
  photo_file_id TEXT,
  cron_expr TEXT,
  next_run_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  repeat BOOLEAN DEFAULT false,
  run_count INTEGER DEFAULT 0,
  pin_after_send BOOLEAN DEFAULT false,
  delete_previous BOOLEAN DEFAULT false,
  previous_msg_id BIGINT DEFAULT NULL,
  last_sent_msg_id BIGINT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_members (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT false,
  UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_feedbacks (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  target_user_id BIGINT,
  target_username TEXT,
  target_tg_profile JSONB DEFAULT '{}',
  feedback_type TEXT NOT NULL,
  feedback_text TEXT,
  submitted_by BIGINT,
  submitted_by_username TEXT,
  has_proofs BOOLEAN DEFAULT false,
  proof_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  reviewed_by BIGINT,
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback_proofs (
  id BIGSERIAL PRIMARY KEY,
  feedback_id BIGINT NOT NULL REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  proof_type TEXT NOT NULL,
  file_id TEXT,
  caption TEXT,
  content TEXT,
  submitted_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scam_entries (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT,
  username TEXT,
  tg_profile JSONB DEFAULT '{}',
  reason TEXT,
  ai_summary TEXT,
  added_by BIGINT,
  feedback_ids JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id),
  UNIQUE(channel_id, username)
);

CREATE TABLE IF NOT EXISTS bot_messages (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  msg_type TEXT NOT NULL,
  delete_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_context (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  message TEXT NOT NULL,
  msg_date TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id, message)
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  member_joins INTEGER DEFAULT 0,
  member_leaves INTEGER DEFAULT 0,
  msg_count INTEGER DEFAULT 0,
  summary_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, summary_date)
);

CREATE TABLE IF NOT EXISTS channel_chat_history (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  msg_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS userinfo_queries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  query_date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 1,
  UNIQUE(user_id, query_date)
);

CREATE TABLE IF NOT EXISTS userinfo_pro_users (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  note TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_blacklist (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  word TEXT NOT NULL,
  category TEXT DEFAULT 'allgemein',
  severity TEXT DEFAULT 'warn',
  tolerate_hours INTEGER DEFAULT NULL,
  delete_after_hours INTEGER DEFAULT 24,
  created_by BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, word)
);

CREATE TABLE IF NOT EXISTS blacklist_hits (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT,
  username TEXT,
  word_hit TEXT,
  message_text TEXT,
  action_taken TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  credits INTEGER NOT NULL,
  price_eur NUMERIC NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  sellauth_product_id TEXT,
  sellauth_variant_id TEXT,
  duration_days INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_purchases (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  package_id INTEGER REFERENCES channel_packages(id),
  sellauth_invoice_id TEXT,
  credits_added INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  meta JSONB DEFAULT '{}',
  credits_used INTEGER NOT NULL DEFAULT 0,
  activated_at TIMESTAMPTZ,
  duration_days INTEGER NOT NULL DEFAULT 30,
  forfeited BOOLEAN NOT NULL DEFAULT false,
  kind TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_refills (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  credits INTEGER NOT NULL,
  price_eur NUMERIC NOT NULL,
  sellauth_product_id TEXT,
  sellauth_variant_id TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_reputation (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  display_name TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  pos_count INTEGER NOT NULL DEFAULT 0,
  neg_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS pending_feedback_confirms (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_msg_id BIGINT NOT NULL,
  submitter_id BIGINT NOT NULL,
  target_username TEXT NOT NULL,
  original_text TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proof_sessions (
  id BIGSERIAL PRIMARY KEY,
  feedback_id BIGINT NOT NULL REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting',
  proof_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_safelist (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id BIGINT,
  username TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  added_by BIGINT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, user_id),
  UNIQUE(channel_id, username)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_flag_count ON chats(flag_count) WHERE flag_count > 0;
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_base(category_id);
CREATE INDEX IF NOT EXISTS idx_visitors_ip ON widget_visitors(ip);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON visitor_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_channel ON channel_knowledge(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_embedding ON channel_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_channel ON scheduled_messages(channel_id, is_active);
CREATE INDEX IF NOT EXISTS idx_channel_group_members_group ON channel_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_user_feedbacks_target ON user_feedbacks(target_user_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_bot_messages_delete ON bot_messages(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON channel_chat_history(channel_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cp_channel_kind ON channel_purchases (channel_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_rep_channel_score ON user_reputation(channel_id, score DESC);
CREATE OR REPLACE FUNCTION match_knowledge(query_embedding VECTOR(1536), match_threshold FLOAT, match_count INT)
RETURNS TABLE (id UUID, content TEXT, metadata JSONB, similarity FLOAT) LANGUAGE sql STABLE AS $$
  SELECT id, content, metadata, 1 - (embedding <=> query_embedding) AS similarity FROM knowledge_base
  WHERE 1 - (embedding <=> query_embedding) > match_threshold ORDER BY similarity DESC LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_channel_knowledge(p_channel_id BIGINT, query_embedding VECTOR(1536), match_threshold FLOAT DEFAULT 0.50, match_count INT DEFAULT 4)
RETURNS TABLE (id BIGINT, category TEXT, title TEXT, content TEXT, similarity FLOAT) LANGUAGE sql STABLE AS $$
  SELECT id, category, title, content, 1 - (embedding <=> query_embedding) AS similarity FROM channel_knowledge
  WHERE channel_id = p_channel_id AND 1 - (embedding <=> query_embedding) > match_threshold ORDER BY embedding <=> query_embedding LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION increment_channel_usage(p_id TEXT, p_tokens INTEGER, p_usd NUMERIC) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bot_channels SET token_used = COALESCE(token_used, 0) + p_tokens, usd_spent = COALESCE(usd_spent, 0) + p_usd, last_active_at = NOW() WHERE id::TEXT = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_userinfo_count(p_user_id BIGINT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO userinfo_queries (user_id, query_date, query_count) VALUES (p_user_id, CURRENT_DATE, 1) ON CONFLICT (user_id, query_date) DO UPDATE SET query_count = userinfo_queries.query_count + 1 RETURNING query_count INTO v_count;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION get_active_package(p_channel_id text) RETURNS table(id bigint, credits_added integer, credits_used integer, activated_at timestamptz, expires_at timestamptz, duration_days integer) LANGUAGE sql STABLE AS $$
  SELECT cp.id, cp.credits_added, cp.credits_used, cp.activated_at, CASE WHEN cp.activated_at is null THEN null ELSE cp.activated_at + make_interval(days => coalesce(cp.duration_days, 30)) END as expires_at, cp.duration_days FROM channel_purchases cp
  WHERE cp.channel_id = p_channel_id AND cp.status = 'completed' AND cp.kind = 'package' AND coalesce(cp.forfeited, false) = false AND cp.credits_used < cp.credits_added AND (cp.activated_at is null OR cp.activated_at + make_interval(days => coalesce(cp.duration_days, 30)) > now()) ORDER BY cp.created_at desc LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION consume_channel_credits(p_channel_id text, p_tokens integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_remaining integer := p_tokens; v_total_used integer := 0; v_now timestamptz := now(); v_pkg record; v_pkg_active boolean := false; v_refill record; v_deduct integer;
BEGIN
  SELECT * INTO v_pkg FROM get_active_package(p_channel_id);
  IF v_pkg.id IS NOT NULL THEN
    v_pkg_active := true;
    IF v_pkg.activated_at IS NULL THEN UPDATE channel_purchases SET activated_at = v_now WHERE id = v_pkg.id; END IF;
    v_deduct := least(v_remaining, v_pkg.credits_added - v_pkg.credits_used);
    IF v_deduct > 0 THEN UPDATE channel_purchases SET credits_used = credits_used + v_deduct WHERE id = v_pkg.id; v_remaining := v_remaining - v_deduct; v_total_used := v_total_used + v_deduct; END IF;
  END IF;
  IF v_pkg_active AND v_remaining > 0 THEN
    FOR v_refill IN SELECT id, credits_added, credits_used, activated_at, duration_days FROM channel_purchases WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'refill' AND coalesce(forfeited, false) = false AND credits_used < credits_added AND (activated_at is null or activated_at + make_interval(days => coalesce(duration_days, 30)) > v_now) ORDER BY created_at asc FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      IF v_refill.activated_at IS NULL THEN UPDATE channel_purchases SET activated_at = v_now WHERE id = v_refill.id; END IF;
      v_deduct := least(v_remaining, v_refill.credits_added - v_refill.credits_used);
      IF v_deduct > 0 THEN UPDATE channel_purchases SET credits_used = credits_used + v_deduct WHERE id = v_refill.id; v_remaining := v_remaining - v_deduct; v_total_used := v_total_used + v_deduct; END IF;
    END LOOP;
  END IF;
  IF v_total_used > 0 THEN UPDATE bot_channels SET token_used = coalesce(token_used, 0) + v_total_used, last_active_at = v_now, updated_at = v_now WHERE id::TEXT = p_channel_id; END IF;
  RETURN jsonb_build_object('consumed', v_total_used, 'requested', p_tokens, 'remaining_unpaid', v_remaining, 'package_active', v_pkg_active);
END;
$$;

CREATE OR REPLACE FUNCTION recompute_channel_budget(p_channel_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_now timestamptz := now(); v_pkg_active boolean := false; v_pkg_credits integer := 0; v_pkg_used integer := 0; v_pkg_expires timestamptz; v_refill_credits integer := 0; v_refill_used integer := 0; v_total_credits integer; v_total_used integer;
BEGIN
  UPDATE channel_purchases SET forfeited = true WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'package' AND coalesce(forfeited, false) = false AND activated_at is not null AND activated_at + make_interval(days => coalesce(duration_days, 30)) < v_now;
  SELECT credits_added, credits_used, CASE WHEN activated_at is null THEN null ELSE activated_at + make_interval(days => coalesce(duration_days, 30)) END INTO v_pkg_credits, v_pkg_used, v_pkg_expires FROM channel_purchases WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'package' AND coalesce(forfeited, false) = false AND credits_used < credits_added AND (activated_at is null OR activated_at + make_interval(days => coalesce(duration_days, 30)) > v_now) ORDER BY created_at desc LIMIT 1;
  v_pkg_active := (v_pkg_credits is not null);
  IF not v_pkg_active THEN UPDATE channel_purchases SET forfeited = true WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'refill' AND coalesce(forfeited, false) = false AND activated_at is not null; ELSE UPDATE channel_purchases SET forfeited = true WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'refill' AND coalesce(forfeited, false) = false AND activated_at is not null AND activated_at + make_interval(days => coalesce(duration_days, 30)) < v_now; END IF;
  IF v_pkg_active THEN SELECT coalesce(sum(credits_added), 0), coalesce(sum(credits_used), 0) INTO v_refill_credits, v_refill_used FROM channel_purchases WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'refill' AND coalesce(forfeited, false) = false; ELSE SELECT coalesce(sum(credits_added), 0), 0 INTO v_refill_credits, v_refill_used FROM channel_purchases WHERE channel_id = p_channel_id AND status = 'completed' AND kind = 'refill' AND coalesce(forfeited, false) = false AND activated_at is null; END IF;
  v_total_credits := coalesce(v_pkg_credits, 0) + coalesce(v_refill_credits, 0); v_total_used := coalesce(v_pkg_used, 0) + coalesce(v_refill_used, 0);
  UPDATE bot_channels SET token_limit = v_total_credits, token_used = v_total_used, credits_expire_at = v_pkg_expires, token_budget_exhausted = (v_total_credits > 0 AND v_total_used >= v_total_credits), ai_enabled = (v_total_credits > 0 AND v_total_used < v_total_credits), updated_at = v_now WHERE id::TEXT = p_channel_id;
END;
$$;

CREATE OR REPLACE FUNCTION expire_channel_packages() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_expired_channels text[]; v_channel text; v_count integer := 0;
BEGIN
  SELECT array_agg(distinct channel_id) INTO v_expired_channels FROM channel_purchases WHERE status = 'completed' AND kind = 'package' AND coalesce(forfeited, false) = false AND activated_at is not null AND activated_at + make_interval(days => coalesce(duration_days, 30)) < now();
  IF v_expired_channels is null THEN return 0; END IF;
  FOREACH v_channel IN ARRAY v_expired_channels LOOP perform recompute_channel_budget(v_channel); v_count := v_count + 1; END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION update_user_reputation(p_channel_id TEXT, p_user_id BIGINT, p_username TEXT, p_delta INTEGER) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_score INTEGER;
BEGIN
  INSERT INTO user_reputation(channel_id, user_id, username, score, pos_count, neg_count, last_updated) VALUES (p_channel_id, p_user_id, p_username, p_delta, CASE WHEN p_delta > 0 THEN 1 ELSE 0 END, CASE WHEN p_delta < 0 THEN 1 ELSE 0 END, NOW()) ON CONFLICT(channel_id, user_id) DO UPDATE SET score = user_reputation.score + p_delta, pos_count = user_reputation.pos_count + CASE WHEN p_delta > 0 THEN 1 ELSE 0 END, neg_count = user_reputation.neg_count + CASE WHEN p_delta < 0 THEN 1 ELSE 0 END, username = COALESCE(p_username, user_reputation.username), last_updated = NOW() RETURNING score INTO v_score;
  RETURN v_score;
END;
$$;

CREATE OR REPLACE FUNCTION get_top_sellers(p_channel_id TEXT, p_limit INT DEFAULT 10) RETURNS TABLE(rank BIGINT, user_id BIGINT, username TEXT, display_name TEXT, score INTEGER, pos_count INTEGER, neg_count INTEGER) LANGUAGE sql STABLE AS $$
  SELECT ROW_NUMBER() OVER (ORDER BY score DESC, pos_count DESC) AS rank, user_id, username, display_name, score, pos_count, neg_count FROM user_reputation WHERE channel_id = p_channel_id AND score > 0 ORDER BY score DESC, pos_count DESC LIMIT p_limit;
$$;

INSERT INTO settings (id, system_prompt) VALUES (1, 'Du bist der offizielle Support-Bot von ValueShop25. Antworte höflich und präzise. Erfinde NIEMALS Produkte, Links oder Preise.') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_categories (name, color, icon) VALUES ('Allgemein', '#4a9eff', '📌'), ('Produkte', '#28a745', '🛒'), ('Preise', '#f59e0b', '💰'), ('Support', '#8b5cf6', '🛠'), ('FAQ', '#ec4899', '❓'), ('Sellauth Import', '#ef4444', '🔗'), ('Smalltalk', '#06b6d4', '💬') ON CONFLICT (name) DO NOTHING;
INSERT INTO coupon_schedule (weekday, enabled, discount, type, description) VALUES (0, true, 10, 'percentage', '10% Montags-Rabatt'), (1, true, 10, 'percentage', '10% Dienstags-Rabatt'), (2, true, 10, 'percentage', '10% Mittwochs-Rabatt'), (3, true, 10, 'percentage', '10% Donnerstags-Rabatt'), (4, true, 15, 'percentage', '15% Freitags-Rabatt'), (5, true, 20, 'percentage', '20% Wochenend-Rabatt'), (6, true, 20, 'percentage', '20% Wochenend-Rabatt') ON CONFLICT (weekday) DO NOTHING;

NOTIFY pgrst, 'reload schema';

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS interval_minutes INTEGER DEFAULT NULL;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
