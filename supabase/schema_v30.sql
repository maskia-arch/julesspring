-- schema_v30.sql  --  Channel packages

CREATE TABLE IF NOT EXISTS channel_packages (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  credits     INTEGER     NOT NULL,
  price_eur   NUMERIC     NOT NULL,
  description TEXT,
  is_active   BOOLEAN     DEFAULT true,
  sort_order  INTEGER     DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

NOTIFY pgrst, 'reload schema';
