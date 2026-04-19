-- schema_v28.sql  --  UserInfo rate limiting and Pro users

-- Daily query tracking (bot-wide)
CREATE TABLE IF NOT EXISTS userinfo_queries (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  query_date   DATE        NOT NULL DEFAULT CURRENT_DATE,
  query_count  INTEGER     DEFAULT 1,
  UNIQUE(user_id, query_date)
);
CREATE INDEX IF NOT EXISTS idx_userinfo_queries_user ON userinfo_queries(user_id, query_date);

-- Pro users (unlimited queries)
CREATE TABLE IF NOT EXISTS userinfo_pro_users (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL UNIQUE,
  username     TEXT,
  note         TEXT,
  expires_at   TIMESTAMPTZ,           -- NULL = unbegrenzt
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_userinfo_pro ON userinfo_pro_users(user_id);

-- Atomares increment für query count
CREATE OR REPLACE FUNCTION increment_userinfo_count(p_user_id BIGINT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO userinfo_queries (user_id, query_date, query_count)
  VALUES (p_user_id, CURRENT_DATE, 1)
  ON CONFLICT (user_id, query_date) DO UPDATE
    SET query_count = userinfo_queries.query_count + 1
  RETURNING query_count INTO v_count;
  RETURN v_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
