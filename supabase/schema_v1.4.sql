-- ════════════════════════════════════════════════════════════════════════════
-- schema_v1.4.sql  ──  AI Assistant Platform – Vollständiges Installations-Schema
-- Version: 1.4.1  |  Datum: April 2026
--
-- Führe dieses Script für eine NEUINSTALLATION aus.
-- Alle Statements sind idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Reihenfolge:
--   1. Extensions
--   2. Kern-Tabellen  (settings, chats, messages, knowledge_base, ...)
--   3. Feature-Tabellen (coupons, bot_channels, safelist, ...)
--   4. Indizes
--   5. Funktionen (RPC)
--   6. Standard-Daten
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. EXTENSIONS ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;


-- ── 2. KERN-TABELLEN ─────────────────────────────────────────────────────────

-- Settings (genau 1 Zeile)
CREATE TABLE IF NOT EXISTS settings (
  id                         INT          PRIMARY KEY DEFAULT 1,
  -- Bot / KI
  system_prompt              TEXT         NOT NULL DEFAULT 'Du bist ein hilfreicher Assistent.',
  negative_prompt            TEXT         DEFAULT '',
  welcome_message            TEXT         DEFAULT 'Willkommen! 👋 Ich bin dein KI-Assistent. Wie kann ich dir helfen?',
  manual_msg_template        TEXT         DEFAULT 'Ein Mitarbeiter wird gleich übernehmen.',
  -- AI-Modell
  ai_model                   TEXT         DEFAULT 'deepseek-chat',
  ai_max_tokens              INTEGER      DEFAULT 1024,
  ai_temperature             NUMERIC      DEFAULT 0.5,
  ai_max_input_tokens        INTEGER      DEFAULT 4096,
  -- RAG / Wissensdatenbank
  rag_threshold              NUMERIC      DEFAULT 0.45,
  rag_match_count            INTEGER      DEFAULT 8,
  max_history_msgs           INTEGER      DEFAULT 4,
  summary_interval           INTEGER      DEFAULT 5,
  -- Sellauth
  sellauth_api_key           TEXT         DEFAULT '',
  sellauth_shop_id           TEXT         DEFAULT '',
  sellauth_shop_url          TEXT         DEFAULT '',
  -- Telegram
  admin_telegram_id          TEXT         DEFAULT '',
  notify_new_chat            BOOLEAN      DEFAULT true,
  notify_every_msg           BOOLEAN      DEFAULT false,
  webhook_url                TEXT         DEFAULT '',
  -- Widget
  widget_powered_by          TEXT         DEFAULT 'Powered by ValueShop25 AI',
  -- Abuse
  abuse_max_msgs_per_hour    INTEGER      DEFAULT 30,
  abuse_auto_ban_flags       INTEGER      DEFAULT 3,
  abuse_min_msg_length       INTEGER      DEFAULT 1,
  -- Coupon-System
  coupon_enabled             BOOLEAN      DEFAULT false,
  coupon_discount            INTEGER      DEFAULT 10,
  coupon_type                TEXT         DEFAULT 'percentage',
  coupon_description         TEXT         DEFAULT '10% Rabatt auf alle Produkte',
  coupon_max_uses            INTEGER      DEFAULT NULL,
  coupon_schedule_hour       INTEGER      DEFAULT 0,
  -- Smalltalk-Bot
  smalltalk_system_prompt    TEXT,
  smalltalk_model            TEXT         DEFAULT 'deepseek-chat',
  smalltalk_max_tokens       INTEGER      DEFAULT 200,
  smalltalk_temperature      NUMERIC      DEFAULT 0.8,
  smalltalk_kb_category_id   INTEGER,
  smalltalk_bot_token        TEXT,
  smalltalk_bot_username     TEXT,
  smalltalk_bot_firstname    TEXT,
  smalltalk_require_approval BOOLEAN      DEFAULT true,
  --
  updated_at                 TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- Chats (Telegram + Widget Sessions)
CREATE TABLE IF NOT EXISTS chats (
  id                    TEXT         PRIMARY KEY,
  platform              TEXT         NOT NULL DEFAULT 'telegram',
  status                TEXT         DEFAULT 'ki' CHECK (status IN ('ki', 'manual')),
  is_manual_mode        BOOLEAN      DEFAULT false,
  metadata              JSONB        DEFAULT '{}',
  -- Vorschau
  last_message          TEXT,
  last_message_role     TEXT         DEFAULT 'user',
  message_count         INTEGER      DEFAULT 0,
  first_name            TEXT,
  username              TEXT,
  -- Chat-Zusammenfassung (Token-Optimierung)
  chat_summary          TEXT,
  summary_msg_count     INTEGER      DEFAULT 0,
  last_summarized_at    TIMESTAMPTZ,
  -- Abuse-Tracking
  flag_count            INTEGER      DEFAULT 0,
  auto_muted            BOOLEAN      DEFAULT false,
  mute_reason           TEXT,
  msg_count_1h          INTEGER      DEFAULT 0,
  last_msg_burst        TIMESTAMPTZ,
  -- Widget-Referenzen
  visitor_ip            TEXT,
  visitor_id            UUID,
  -- Manual-Mode Timestamps
  manual_mode_started_at TIMESTAMPTZ,
  manual_mode_ended_at   TIMESTAMPTZ,
  -- Learning
  is_learning_session   BOOLEAN      DEFAULT false,
  --
  created_at            TIMESTAMPTZ  DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id             TEXT         REFERENCES chats(id) ON DELETE CASCADE,
  role                TEXT         NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content             TEXT         NOT NULL,
  -- Token-Tracking
  prompt_tokens       INTEGER      DEFAULT 0,
  completion_tokens   INTEGER      DEFAULT 0,
  embedding_tokens    INTEGER      DEFAULT 0,
  is_manual           BOOLEAN      DEFAULT false,
  sent_during_manual  BOOLEAN      DEFAULT false,
  -- Klarheits-Tracking (v1.4)
  clarity_score       NUMERIC,
  agent_mode          TEXT,
  --
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- Wissensdatenbank
CREATE TABLE IF NOT EXISTS knowledge_base (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  content     TEXT         NOT NULL,
  embedding   VECTOR(1536),
  source      TEXT,
  external_id TEXT         UNIQUE,
  title       TEXT,
  category_id INTEGER,
  metadata    JSONB        DEFAULT '{}',
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Wissens-Kategorien
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id         SERIAL       PRIMARY KEY,
  name       TEXT         NOT NULL UNIQUE,
  color      TEXT         DEFAULT '#4a9eff',
  icon       TEXT         DEFAULT '📌',
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- Blacklist
CREATE TABLE IF NOT EXISTS blacklist (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  TEXT         UNIQUE,
  reason      TEXT,
  ip_hash     TEXT,
  ban_scope   TEXT         DEFAULT 'id',
  auto_banned BOOLEAN      DEFAULT false,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Lernqueue
CREATE TABLE IF NOT EXISTS learning_queue (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  original_chat_id     TEXT,
  unanswered_question  TEXT,
  context              TEXT,
  status               TEXT         DEFAULT 'pending',
  created_at           TIMESTAMPTZ  DEFAULT NOW()
);

-- Admin Push-Abonnements
CREATE TABLE IF NOT EXISTS admin_subscriptions (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_data JSONB        NOT NULL,
  created_at        TIMESTAMPTZ  DEFAULT NOW()
);

-- Integration-Logs (Sellauth)
CREATE TABLE IF NOT EXISTS integration_logs (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  source     TEXT,
  event_type TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- User-Flags (Abuse)
CREATE TABLE IF NOT EXISTS user_flags (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      TEXT         NOT NULL,
  reason       TEXT         NOT NULL,
  auto_flagged BOOLEAN      DEFAULT false,
  flagged_by   TEXT         DEFAULT 'system',
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);


-- ── 3. FEATURE-TABELLEN ───────────────────────────────────────────────────────

-- Widget-Besucher
CREATE TABLE IF NOT EXISTS widget_visitors (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     TEXT         NOT NULL UNIQUE,
  ip          TEXT         NOT NULL,
  ip_hash     TEXT         NOT NULL,
  user_agent  TEXT,
  fingerprint TEXT,
  country     TEXT,
  first_seen  TIMESTAMPTZ  DEFAULT NOW(),
  last_seen   TIMESTAMPTZ  DEFAULT NOW(),
  page_count  INTEGER      DEFAULT 1,
  is_banned   BOOLEAN      DEFAULT false,
  ban_reason  TEXT,
  banned_at   TIMESTAMPTZ,
  metadata    JSONB        DEFAULT '{}'
);

-- Besucher-Aktivitäten
CREATE TABLE IF NOT EXISTS visitor_activities (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    TEXT         NOT NULL,
  session_id UUID,
  activity   TEXT         NOT NULL,
  page_url   TEXT,
  page_title TEXT,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- Besucher-Sessions
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     TEXT         NOT NULL,
  visitor_id  UUID         REFERENCES widget_visitors(id),
  started_at  TIMESTAMPTZ  DEFAULT NOW(),
  last_seen   TIMESTAMPTZ  DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  duration_sec INTEGER     DEFAULT 0,
  page_count  INTEGER      DEFAULT 1,
  entry_page  TEXT,
  last_page   TEXT,
  is_active   BOOLEAN      DEFAULT true,
  had_chat    BOOLEAN      DEFAULT false,
  push_sent   BOOLEAN      DEFAULT false
);

-- Tages-Coupons
CREATE TABLE IF NOT EXISTS daily_coupons (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT         NOT NULL UNIQUE,
  discount     INTEGER      NOT NULL,
  type         TEXT         NOT NULL DEFAULT 'percentage',
  description  TEXT,
  sellauth_id  TEXT,
  ki_call_count INTEGER     DEFAULT 0,
  weekday      INTEGER,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN      DEFAULT true,
  used_count   INTEGER      DEFAULT 0
);

-- Coupon Wochenplan
CREATE TABLE IF NOT EXISTS coupon_schedule (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday     INTEGER      NOT NULL UNIQUE,
  enabled     BOOLEAN      DEFAULT true,
  discount    INTEGER      NOT NULL DEFAULT 10,
  type        TEXT         NOT NULL DEFAULT 'percentage',
  description TEXT,
  max_uses    INTEGER      DEFAULT NULL,
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── BOT-CHANNELS (v1.4) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_channels (
  id                 BIGINT       PRIMARY KEY,
  title              TEXT,
  username           TEXT,
  type               TEXT,
  bot_type           TEXT         DEFAULT 'smalltalk',
  mode               TEXT         DEFAULT 'smalltalk',
  is_active          BOOLEAN      DEFAULT false,
  is_approved        BOOLEAN      DEFAULT false,
  ai_enabled         BOOLEAN      DEFAULT false,
  safelist_enabled   BOOLEAN      DEFAULT false,
  ai_command         TEXT         DEFAULT '/ai',
  -- Persönlichkeit
  system_prompt      TEXT,
  -- Nachrichten
  welcome_msg        TEXT,
  goodbye_msg        TEXT,
  -- Token-Limits
  token_limit        INTEGER      DEFAULT NULL,
  token_used         INTEGER      DEFAULT 0,
  usd_limit          NUMERIC      DEFAULT NULL,
  usd_spent          NUMERIC      DEFAULT 0,
  limit_message      TEXT         DEFAULT 'Deine Token sind verbraucht. Melde dich bei @autoacts.',
  -- KB-Status
  kb_initialized     BOOLEAN      DEFAULT false,
  kb_entry_count     INTEGER      DEFAULT 0,
  -- Admin-Tracking
  added_by_user_id   BIGINT,
  added_by_username  TEXT,
  admin_user_ids     JSONB        DEFAULT '[]',
  settings_token     TEXT,
  -- Referenzen
  safelist_channel   BIGINT,
  -- Timestamps
  added_at           TIMESTAMPTZ  DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  DEFAULT NOW(),
  approved_at        TIMESTAMPTZ,
  last_active_at     TIMESTAMPTZ
);

-- Channel-eigene Wissensdatenbank (isoliert vom Berater)
CREATE TABLE IF NOT EXISTS channel_knowledge (
  id          BIGSERIAL    PRIMARY KEY,
  channel_id  BIGINT       NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  category    TEXT         NOT NULL DEFAULT 'allgemein',
  title       TEXT,
  content     TEXT         NOT NULL,
  embedding   VECTOR(1536),
  source      TEXT         DEFAULT 'manual',
  metadata    JSONB        DEFAULT '{}',
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Geplante Nachrichten
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            BIGSERIAL    PRIMARY KEY,
  channel_id    BIGINT       NOT NULL,
  message       TEXT         NOT NULL,
  photo_url     TEXT,
  photo_file_id TEXT,
  cron_expr     TEXT,
  next_run_at   TIMESTAMPTZ,
  is_active     BOOLEAN      DEFAULT true,
  repeat        BOOLEAN      DEFAULT false,
  run_count     INTEGER      DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Member-Tracking
CREATE TABLE IF NOT EXISTS channel_members (
  id          BIGSERIAL    PRIMARY KEY,
  channel_id  BIGINT       NOT NULL,
  user_id     BIGINT       NOT NULL,
  username    TEXT,
  first_name  TEXT,
  joined_at   TIMESTAMPTZ  DEFAULT NOW(),
  last_seen   TIMESTAMPTZ  DEFAULT NOW(),
  is_deleted  BOOLEAN      DEFAULT false,
  UNIQUE(channel_id, user_id)
);

-- Safelist / Scamliste
CREATE TABLE IF NOT EXISTS safelist_entries (
  id            BIGSERIAL    PRIMARY KEY,
  channel_id    BIGINT,
  user_id       BIGINT,
  username      TEXT,
  list_type     TEXT         NOT NULL,
  feedback_text TEXT,
  summary       TEXT,
  evidence_msgs JSONB        DEFAULT '[]',
  submitted_by  BIGINT,
  reviewed_by   BIGINT,
  status        TEXT         DEFAULT 'pending',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);


-- ── 4. INDIZES ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_chat_id         ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at      ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created    ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at         ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_flag_count         ON chats(flag_count) WHERE flag_count > 0;
CREATE INDEX IF NOT EXISTS idx_chats_auto_muted         ON chats(auto_muted) WHERE auto_muted = true;
CREATE INDEX IF NOT EXISTS idx_knowledge_category       ON knowledge_base(category_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source         ON knowledge_base(source);
CREATE INDEX IF NOT EXISTS idx_flags_chat_id            ON user_flags(chat_id);
CREATE INDEX IF NOT EXISTS idx_visitors_ip              ON widget_visitors(ip);
CREATE INDEX IF NOT EXISTS idx_visitors_ip_hash         ON widget_visitors(ip_hash);
CREATE INDEX IF NOT EXISTS idx_visitors_chat_id         ON widget_visitors(chat_id);
CREATE INDEX IF NOT EXISTS idx_visitors_banned          ON widget_visitors(is_banned) WHERE is_banned = true;
CREATE INDEX IF NOT EXISTS idx_activities_chat_id       ON visitor_activities(chat_id);
CREATE INDEX IF NOT EXISTS idx_activities_created       ON visitor_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_id         ON visitor_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active          ON visitor_sessions(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_sessions_started         ON visitor_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_blacklist_ip_hash        ON blacklist(ip_hash) WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_daily_coupons_active     ON daily_coupons(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bot_channels_active      ON bot_channels(is_active, is_approved);
CREATE INDEX IF NOT EXISTS idx_bot_channels_added_by    ON bot_channels(added_by_user_id);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_channel ON channel_knowledge(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_knowledge_embedding ON channel_knowledge
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_channel ON scheduled_messages(channel_id, is_active);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel  ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_safelist_entries_type    ON safelist_entries(list_type, status);


-- ── 5. FUNKTIONEN (RPC) ───────────────────────────────────────────────────────

-- Haupt-Vektorsuche (Berater / Website-Widget)
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count     INT
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  metadata    JSONB,
  similarity  FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT id, content, metadata,
         1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_base
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- Per-Channel Vektorsuche (Smalltalk-Agent)
CREATE OR REPLACE FUNCTION match_channel_knowledge(
  p_channel_id    BIGINT,
  query_embedding VECTOR(1536),
  match_threshold FLOAT  DEFAULT 0.50,
  match_count     INT    DEFAULT 4
)
RETURNS TABLE (
  id          BIGINT,
  category    TEXT,
  title       TEXT,
  content     TEXT,
  similarity  FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT id, category, title, content,
         1 - (embedding <=> query_embedding) AS similarity
  FROM channel_knowledge
  WHERE channel_id = p_channel_id
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;


-- ── 6. STANDARD-DATEN ────────────────────────────────────────────────────────

-- Settings: Initialer Datensatz
INSERT INTO settings (id, system_prompt)
VALUES (1, 'Du bist der offizielle Support-Bot von ValueShop25. Antworte höflich und präzise. Erfinde NIEMALS Produkte, Links oder Preise.')
ON CONFLICT (id) DO NOTHING;

-- Wissens-Kategorien
INSERT INTO knowledge_categories (name, color, icon) VALUES
  ('Allgemein',       '#4a9eff', '📌'),
  ('Produkte',        '#28a745', '🛒'),
  ('Preise',          '#f59e0b', '💰'),
  ('Support',         '#8b5cf6', '🛠'),
  ('FAQ',             '#ec4899', '❓'),
  ('Sellauth Import', '#ef4444', '🔗'),
  ('Smalltalk',       '#06b6d4', '💬')
ON CONFLICT (name) DO NOTHING;

-- Coupon Wochenplan (Standard)
INSERT INTO coupon_schedule (weekday, enabled, discount, type, description) VALUES
  (0, true,  10, 'percentage', '10% Montags-Rabatt auf alle eSIMs'),
  (1, true,  10, 'percentage', '10% Dienstags-Rabatt auf alle eSIMs'),
  (2, true,  10, 'percentage', '10% Mittwochs-Rabatt auf alle eSIMs'),
  (3, true,  10, 'percentage', '10% Donnerstags-Rabatt auf alle eSIMs'),
  (4, true,  15, 'percentage', '15% Freitags-Rabatt – Happy Friday!'),
  (5, true,  20, 'percentage', '20% Wochenend-Rabatt auf alle eSIMs'),
  (6, true,  20, 'percentage', '20% Wochenend-Rabatt auf alle eSIMs')
ON CONFLICT (weekday) DO NOTHING;


-- ── Schema-Cache aktualisieren ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
