-- 1. Blacklist Tabelle um 'consequences' (Array) erweitern (falls nicht schon passiert)
ALTER TABLE channel_blacklist 
ADD COLUMN IF NOT EXISTS consequences text[] DEFAULT '{}';

-- 2. Neue Tabelle für gebannte User erstellen (falls nicht schon passiert)
CREATE TABLE IF NOT EXISTS channel_banned_users (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id text NOT NULL,
    user_id text NOT NULL,
    username text,
    reason text,
    banned_at timestamptz DEFAULT now(),
    UNIQUE(channel_id, user_id)
);

-- 3. Bestehende bot_messages Tabelle um unsere neuen Spalten erweitern
ALTER TABLE bot_messages 
ADD COLUMN IF NOT EXISTS msg_type text,
ADD COLUMN IF NOT EXISTS delete_after timestamptz;
