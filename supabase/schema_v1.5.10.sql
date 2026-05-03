-- ============================================================================
-- AI_AUTO Schema-Update v1.5.10
-- ============================================================================
-- Custom-Emoji & Formatting-Erhalt für wiederholende/geplante Nachrichten.
--
-- Telegram liefert bei eingehenden Nachrichten ein `entities`-Array mit allen
-- Formatierungs-Hinweisen (bold, italic, custom_emoji mit IDs, links etc.).
-- Wenn wir dieses Array 1:1 mitspeichern und beim Wiedersenden mitgeben,
-- werden Premium/Custom Emojis und alle anderen Formate exakt erhalten —
-- ohne HTML/Markdown-Konvertierung.
--
-- Format (Telegram-eigen):
--   [
--     { "type": "custom_emoji", "offset": 6, "length": 2,
--       "custom_emoji_id": "5375248220636463728" },
--     { "type": "bold", "offset": 9, "length": 12 }
--   ]
--
-- Voraussetzung für Custom Emojis: Der Bot-Inhaber (Telegram-Account, dem
-- der Bot gehört) braucht eine aktive Telegram-Premium-Subscription. Andere
-- entity-Typen (bold/italic/links) funktionieren auch ohne Premium.
-- ============================================================================

ALTER TABLE scheduled_messages
ADD COLUMN IF NOT EXISTS entities jsonb DEFAULT NULL;

COMMENT ON COLUMN scheduled_messages.entities IS
  'Telegram message entities array (bold, italic, custom_emoji etc.) – 1:1 ' ||
  'übernommen von der eingehenden Nachricht beim Erstellen, beim Senden ' ||
  'wieder mitgegeben. Erlaubt animierte Premium-Emojis sofern der Bot-' ||
  'Owner Telegram Premium hat.';
