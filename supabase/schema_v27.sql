-- schema_v27.sql  --  Bot language + summary token tracking

ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS bot_language         TEXT    DEFAULT 'de';
ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS last_summary_tokens  INTEGER DEFAULT 0;

NOTIFY pgrst, 'reload schema';
