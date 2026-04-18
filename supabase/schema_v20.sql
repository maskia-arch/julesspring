-- schema_v20.sql  ──  Channel-Gruppen (Linking) + Safelist Proofs

-- Channel-Gruppen: mehrere Channels/Gruppen teilen Daten
CREATE TABLE IF NOT EXISTS channel_groups (
  id          BIGSERIAL    PRIMARY KEY,
  name        TEXT         NOT NULL,
  owner_id    BIGINT,              -- Telegram user_id des Erstellers
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_group_members (
  id          BIGSERIAL    PRIMARY KEY,
  group_id    BIGINT       NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
  channel_id  BIGINT       NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  is_primary  BOOLEAN      DEFAULT false,  -- Primary = Quelle der geteilten Daten
  joined_at   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(group_id, channel_id)
);

-- Safelist Proof-Medien (Beweise für Scam-Meldungen)
CREATE TABLE IF NOT EXISTS safelist_proofs (
  id           BIGSERIAL    PRIMARY KEY,
  entry_id     BIGINT       NOT NULL REFERENCES safelist_entries(id) ON DELETE CASCADE,
  proof_type   TEXT         NOT NULL,  -- 'text' | 'photo' | 'video' | 'document'
  file_id      TEXT,                   -- Telegram file_id
  caption      TEXT,
  content      TEXT,                   -- Bei Textbeweisen
  submitted_by BIGINT,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Safelist: submitted_by_username und submitted_at für Admin-Review
ALTER TABLE safelist_entries ADD COLUMN IF NOT EXISTS submitted_by_username TEXT;
ALTER TABLE safelist_entries ADD COLUMN IF NOT EXISTS submitted_at          TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE safelist_entries ADD COLUMN IF NOT EXISTS proof_count           INTEGER DEFAULT 0;

-- Channel: Gruppen-Zugehörigkeit
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS channel_group_id BIGINT REFERENCES channel_groups(id);

CREATE INDEX IF NOT EXISTS idx_channel_group_members_group   ON channel_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_channel_group_members_channel ON channel_group_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_safelist_proofs_entry         ON safelist_proofs(entry_id);

NOTIFY pgrst, 'reload schema';
