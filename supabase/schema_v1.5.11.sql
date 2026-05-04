-- ============================================================================
-- AI_AUTO Schema-Update v1.5.11
-- ============================================================================
-- 1) UserInfo-Aktivität: last_seen wird jetzt bei JEDER Group-Message
--    aktualisiert (siehe smalltalkBotRoutes.js). Außerdem zählen wir, wie
--    aktiv ein User in den letzten 7 Tagen war.
--
-- 2) Tageszusammenfassung: Sammel-Tabelle für ALLE Group-Messages (nicht
--    nur AI-Konversationen). Nachrichten älter als 48h werden vom
--    Hintergrund-Cleanup automatisch entfernt.
--
-- 3) SangMata-Imports: Tabelle für aus @SangMata_Bot weitergeleitete
--    Namens-Historien.
-- ============================================================================

-- ─── (1) channel_members um Aktivitäts-Counter ──────────────────────────────
ALTER TABLE channel_members
  ADD COLUMN IF NOT EXISTS message_count        BIGINT      DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_message_at      TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT        DEFAULT NULL;

-- ─── (2) Group-Message-Sampling für Tageszusammenfassung ────────────────────
CREATE TABLE IF NOT EXISTS channel_message_log (
  id           BIGSERIAL   PRIMARY KEY,
  channel_id   TEXT        NOT NULL,
  user_id      BIGINT      NOT NULL,
  username     TEXT,
  first_name   TEXT,
  content      TEXT        NOT NULL,
  msg_id       BIGINT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_message_log_chan_time
  ON channel_message_log(channel_id, created_at DESC);

-- Cleanup-Funktion: Lösche alle Group-Messages älter als 48h.
-- Vom Server-Scheduler stündlich aufgerufen (Wartung in safelistService).
CREATE OR REPLACE FUNCTION prune_channel_message_log() RETURNS void AS $$
BEGIN
  DELETE FROM channel_message_log
  WHERE created_at < NOW() - INTERVAL '48 hours';
END;
$$ LANGUAGE plpgsql;

-- ─── (3) SangMata-Imports ───────────────────────────────────────────────────
-- Eingehende Forwards von @SangMata_Bot werden hier zur User-ID-Zuordnung
-- abgelegt. Dient als History-Quelle für UserInfo, parallel zu unserem
-- eigenen user_name_history (das nur Daten erfasst, die UNSER Bot selber
-- gesehen hat).
CREATE TABLE IF NOT EXISTS sangmata_imports (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  raw_text     TEXT        NOT NULL,        -- vollständiger SangMata-Bericht
  imported_by  BIGINT,                       -- Telegram-User der's geforwarded hat
  imported_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sangmata_imports_user
  ON sangmata_imports(user_id, imported_at DESC);
