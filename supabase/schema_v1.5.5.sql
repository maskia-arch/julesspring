ALTER TABLE bot_channels 
ADD COLUMN auto_clean_interval text DEFAULT 'off',
ADD COLUMN last_clean_at timestamptz;
