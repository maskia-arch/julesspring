-- schema9.sql – Admin Notifications
ALTER TABLE settings ADD COLUMN IF NOT EXISTS admin_telegram_id  TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_new_chat    BOOLEAN DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_every_msg   BOOLEAN DEFAULT false;
