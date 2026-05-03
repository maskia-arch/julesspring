-- ============================================================================
-- AI_AUTO Schema-Update v1.5.9
-- ============================================================================
-- Inline-Buttons für wiederholende & geplante Nachrichten.
--
-- Die Spalte hält ein Array von Button-Zeilen, jede Zeile ein Array von
-- Buttons:
--   [
--     [{"text": "Webseite", "url": "https://example.com"}],
--     [{"text": "Discord",  "url": "https://discord.gg/xy"}]
--   ]
--
-- Format passt 1:1 zu Telegrams `inline_keyboard` Struktur.
-- Wenn NULL oder leeres Array → kein reply_markup beim Senden.
-- ============================================================================

ALTER TABLE scheduled_messages
ADD COLUMN IF NOT EXISTS inline_buttons jsonb DEFAULT NULL;
