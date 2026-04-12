-- schema12.sql – v1.3.5: Token-Optimierung
-- Führe nach schema11.sql aus

-- 1. Chat-Zusammenfassung (ersetzt alte History-Tokens)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS chat_summary       TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS summary_msg_count  INTEGER DEFAULT 0;  -- Nachrichten beim letzten Summary
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_summarized_at TIMESTAMPTZ;

-- 2. Widget Powered-By Text in Settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS widget_powered_by TEXT DEFAULT 'Powered by ValueShop25 AI';

-- 3. Token-Konfiguration (erweiterbar im Dashboard)
ALTER TABLE settings ADD COLUMN IF NOT EXISTS max_history_msgs INTEGER DEFAULT 4;   -- Letzte N Nachrichten senden
ALTER TABLE settings ADD COLUMN IF NOT EXISTS summary_interval INTEGER DEFAULT 5;   -- Alle N Nachrichten zusammenfassen
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ai_max_input_tokens INTEGER DEFAULT 4096;  -- Max Input
