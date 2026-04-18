-- schema_v24.sql  ──  Per-Channel AI Model

ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS ai_model TEXT DEFAULT 'deepseek-chat';

-- Supported values: 'deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini'
-- Default: deepseek-chat (günstigstes)

NOTIFY pgrst, 'reload schema';
