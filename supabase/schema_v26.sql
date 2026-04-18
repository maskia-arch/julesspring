-- schema_v26.sql  --  Blocked threads per channel

ALTER TABLE bot_channels ADD COLUMN IF NOT EXISTS blocked_thread_ids JSONB DEFAULT '[]';

NOTIFY pgrst, 'reload schema';
