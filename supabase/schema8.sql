-- schema8.sql – Embedding Token Tracking
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_tokens INTEGER DEFAULT 0;
