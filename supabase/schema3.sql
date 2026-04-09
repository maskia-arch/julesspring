-- ============================================================
-- SCHEMA MIGRATION v3 - Fehlende Spalten & Fixes
-- Führe dieses Script in Supabase SQL Editor aus
-- ============================================================

-- 1. chats: is_manual_mode Flag (war im Code aber nicht in DB)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_manual_mode BOOLEAN DEFAULT false;

-- 2. messages: Token-Tracking für Kostenübersicht
ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;

-- 3. settings: Fehlende Konfigurationsfelder
ALTER TABLE settings ADD COLUMN IF NOT EXISTS negative_prompt TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sellauth_api_key TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS welcome_message TEXT DEFAULT 'Willkommen! 👋 Ich bin dein KI-Assistent. Wie kann ich dir helfen?';

-- 4. Bestehende Settings-Zeile aktualisieren
UPDATE settings SET
  negative_prompt = COALESCE(negative_prompt, ''),
  sellauth_api_key = COALESCE(sellauth_api_key, ''),
  welcome_message = COALESCE(welcome_message, 'Willkommen! 👋 Ich bin dein KI-Assistent. Wie kann ich dir helfen?')
WHERE id = 1;

-- 5. Index für schnellere Chat-Abfragen
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
