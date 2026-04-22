CREATE OR REPLACE FUNCTION delete_channel_data()
RETURNS TRIGGER AS $$
BEGIN
  -- Löscht alle Einträge, bei denen die channel_id mit der gelöschten ID übereinstimmt
  DELETE FROM channel_safelist WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM scam_entries WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM user_feedbacks WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM channel_members WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM scheduled_messages WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM channel_knowledge WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM channel_blacklist WHERE channel_id::TEXT = OLD.id::TEXT;
  DELETE FROM user_reputation WHERE channel_id::TEXT = OLD.id::TEXT;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_delete_channel_data ON bot_channels;

CREATE TRIGGER trigger_delete_channel_data
AFTER DELETE ON bot_channels
FOR EACH ROW
EXECUTE FUNCTION delete_channel_data();
