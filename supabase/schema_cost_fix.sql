-- Cost Fix: Stelle sicher dass embedding_tokens Spalte existiert
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_tokens INTEGER DEFAULT 0;

-- Zeige aktuelle Token-Summen zur Diagnose (optional ausführen)
-- SELECT 
--   SUM(prompt_tokens) as total_prompt,
--   SUM(completion_tokens) as total_completion, 
--   SUM(embedding_tokens) as total_embedding,
--   COUNT(*) as total_messages
-- FROM messages;
