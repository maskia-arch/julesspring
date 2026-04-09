-- ============================================================
-- SCHEMA v5 – AI Model Settings + Chat Previews
-- Führe nach schema4.sql aus
-- ============================================================

-- 1. KI-Modell Einstellungen in settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_model        TEXT    DEFAULT 'deepseek-chat';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_max_tokens   INTEGER DEFAULT 1024;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_temperature  NUMERIC DEFAULT 0.5;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS rag_threshold   NUMERIC DEFAULT 0.45;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS rag_match_count INTEGER DEFAULT 8;

-- 2. Chats: letzter Nachrichtentext für Chat-Vorschau
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_message      TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_message_role TEXT DEFAULT 'user';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS message_count     INTEGER DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS first_name        TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS username          TEXT;

-- 3. Settings Update mit Defaults
UPDATE settings SET
  ai_model       = COALESCE(NULLIF(ai_model,''), 'deepseek-chat'),
  ai_max_tokens  = COALESCE(ai_max_tokens, 1024),
  ai_temperature = COALESCE(ai_temperature, 0.5),
  rag_threshold  = COALESCE(rag_threshold, 0.45),
  rag_match_count= COALESCE(rag_match_count, 8)
WHERE id = 1;

-- 4. Bestehende Chats: last_message aus messages-Tabelle befüllen
UPDATE chats c
SET 
  last_message      = m.content,
  last_message_role = m.role,
  message_count     = mc.cnt
FROM (
  SELECT DISTINCT ON (chat_id) chat_id, content, role
  FROM messages
  ORDER BY chat_id, created_at DESC
) m,
(SELECT chat_id, COUNT(*) as cnt FROM messages GROUP BY chat_id) mc
WHERE c.id = m.chat_id AND c.id = mc.chat_id;
