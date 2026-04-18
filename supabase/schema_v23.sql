-- schema_v23.sql  ──  Atomic token increment RPC

-- Atomares Increment (verhindert Race Conditions beim parallelen Schreiben)
CREATE OR REPLACE FUNCTION increment_channel_usage(
  p_id      TEXT,
  p_tokens  INTEGER,
  p_usd     NUMERIC
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bot_channels
  SET
    token_used     = COALESCE(token_used, 0)  + p_tokens,
    usd_spent      = COALESCE(usd_spent,  0)  + p_usd,
    last_active_at = NOW()
  WHERE id::TEXT = p_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
