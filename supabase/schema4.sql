-- ============================================================
-- SCHEMA v4 – Knowledge Categories + Sellauth Shop Config
-- Führe ZUERST schema3.sql aus, dann dieses Script
-- ============================================================

-- 1. Wissens-Kategorien
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#4a9eff',
  icon TEXT DEFAULT '📌',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Standard-Kategorien einfügen
INSERT INTO knowledge_categories (name, color, icon) VALUES
  ('Allgemein',       '#4a9eff', '📌'),
  ('Produkte',        '#28a745', '🛒'),
  ('Preise',          '#f59e0b', '💰'),
  ('Support',         '#8b5cf6', '🛠'),
  ('FAQ',             '#ec4899', '❓'),
  ('Sellauth Import', '#ef4444', '🔗')
ON CONFLICT (name) DO NOTHING;

-- 2. knowledge_base: category_id Spalte hinzufügen
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL;
ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS title TEXT;

-- 3. settings: Sellauth Shop-Konfiguration
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_shop_id TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_shop_url TEXT DEFAULT '';

-- 4. Chats: updated_at sicherstellen (Fallback)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 5. Index für Knowledge-Kategorie-Abfragen
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_base(category_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_base(source);
