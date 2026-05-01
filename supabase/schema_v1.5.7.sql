ALTER TABLE bot_channels 
ADD COLUMN IF NOT EXISTS bl_hard_consequences text[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS bl_soft_delete_hours int DEFAULT 0;
