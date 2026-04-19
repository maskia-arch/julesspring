-- schema_v32.sql  --  Refill options

CREATE TABLE IF NOT EXISTS channel_refills (
  id                   SERIAL      PRIMARY KEY,
  name                 TEXT        NOT NULL,         -- z.B. "1.000 Credits", "5.000 Credits"
  credits              INTEGER     NOT NULL,
  price_eur            NUMERIC     NOT NULL,
  sellauth_product_id  TEXT,
  sellauth_variant_id  TEXT,
  description          TEXT,
  is_active            BOOLEAN     DEFAULT true,
  sort_order           INTEGER     DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

NOTIFY pgrst, 'reload schema';
