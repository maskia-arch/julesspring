-- ============================================================
-- SCHEMA v6 – Fehlende Spalten sicher hinzufügen
-- Alle ALTER TABLE sind idempotent (IF NOT EXISTS)
-- Führe dieses Script aus, auch wenn vorherige Schemas fehlen
-- ============================================================

-- Settings: Sellauth Felder
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_api_key   TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_shop_id   TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_shop_url  TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS welcome_message    TEXT DEFAULT 'Willkommen! 👋 Wie kann ich dir helfen?';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS negative_prompt    TEXT DEFAULT '';

-- Settings: AI Modell Einstellungen
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_model          TEXT    DEFAULT 'deepseek-chat';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_max_tokens     INTEGER DEFAULT 1024;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_temperature    NUMERIC DEFAULT 0.5;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS rag_threshold     NUMERIC DEFAULT 0.45;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS rag_match_count   INTEGER DEFAULT 8;

-- Chats: Vorschau Spalten
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_manual_mode      BOOLEAN   DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_message        TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_message_role   TEXT      DEFAULT 'user';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS message_count       INTEGER   DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS first_name          TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS username            TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ DEFAULT NOW();

-- Messages: Token-Tracking
ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens     INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_manual         BOOLEAN DEFAULT false;

-- Knowledge Base: Kategorien und Titel
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS category_id INTEGER;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS title       TEXT;

-- Knowledge Categories Tabelle
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT DEFAULT '#4a9eff',
  icon       TEXT DEFAULT '📌',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO knowledge_categories (name, color, icon) VALUES
  ('Allgemein',       '#4a9eff', '📌'),
  ('Produkte',        '#28a745', '🛒'),
  ('Preise',          '#f59e0b', '💰'),
  ('Support',         '#8b5cf6', '🛠'),
  ('FAQ',             '#ec4899', '❓'),
  ('Sellauth Import', '#ef4444', '🔗')
ON CONFLICT (name) DO NOTHING;

-- Settings Defaults aktualisieren
UPDATE settings SET
  sellauth_api_key  = COALESCE(NULLIF(sellauth_api_key,''),  ''),
  sellauth_shop_id  = COALESCE(NULLIF(sellauth_shop_id,''),  ''),
  sellauth_shop_url = COALESCE(NULLIF(sellauth_shop_url,''), ''),
  ai_model          = COALESCE(NULLIF(ai_model,''),          'deepseek-chat'),
  ai_max_tokens     = COALESCE(ai_max_tokens,  1024),
  ai_temperature    = COALESCE(ai_temperature, 0.5),
  rag_threshold     = COALESCE(rag_threshold,  0.45),
  rag_match_count   = COALESCE(rag_match_count, 8)
WHERE id = 1;

-- Indizes für Performance
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_source ON knowledge_base(source);
