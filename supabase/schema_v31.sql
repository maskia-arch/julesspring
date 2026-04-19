-- schema_v31.sql  --  Package expiry + Sellauth product IDs

ALTER TABLE channel_packages ADD COLUMN IF NOT EXISTS sellauth_product_id TEXT;
ALTER TABLE channel_packages ADD COLUMN IF NOT EXISTS sellauth_variant_id  TEXT;
ALTER TABLE channel_packages ADD COLUMN IF NOT EXISTS duration_days        INTEGER DEFAULT 30;

-- Channel purchase log
CREATE TABLE IF NOT EXISTS channel_purchases (
  id                  BIGSERIAL   PRIMARY KEY,
  channel_id          TEXT        NOT NULL,
  package_id          INTEGER     REFERENCES channel_packages(id),
  sellauth_invoice_id TEXT,
  credits_added       INTEGER     NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  status              TEXT        DEFAULT 'pending',
  meta                JSONB       DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS credits_expire_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_purchases_channel ON channel_purchases(channel_id);
CREATE INDEX IF NOT EXISTS idx_purchases_invoice ON channel_purchases(sellauth_invoice_id);

NOTIFY pgrst, 'reload schema';
