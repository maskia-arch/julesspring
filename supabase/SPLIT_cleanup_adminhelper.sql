-- ════════════════════════════════════════════════════════════════════════════
--   AdminHelper Datenbank-Cleanup nach Projekt-Split (Version 1.6.78)
-- ════════════════════════════════════════════════════════════════════════════
--
-- ZWECK
-- ─────
-- Dieses Script raeumt deine BESTEHENDE Supabase-Datenbank auf, nachdem
-- AdminHelper und eSIM-Berater in zwei getrennte Projekte aufgeteilt wurden.
-- Es entfernt alle Tabellen und Settings-Spalten, die nur der Berater nutzt.
--
-- WAS PASSIERT
-- ────────────
--   1) Alle BERATER-Tabellen werden DROP CASCADE: chats, messages,
--      knowledge_base, knowledge_categories, learning_queue, visitor_*,
--      widget_visitors, daily_coupons, coupon_schedule, blacklist,
--      integration_logs, user_flags, ai_message_classifications
--   2) BERATER-Spalten aus settings werden entfernt: system_prompt,
--      negative_prompt, welcome_message, ai_*, rag_*, coupon_*, abuse_*,
--      admin_telegram_id, notify_*, widget_powered_by, max_history_msgs,
--      summary_interval, manual_msg_template
--   3) ADMINHELPER-Tabellen bleiben unveraendert: bot_channels, channel_*,
--      scam_entries, scheduled_messages, bot_messages, user_*, daily_summaries,
--      userinfo_*, translation_cache, cached_bot_texts, ai_usage_log,
--      ai_spam_violations, admin_reports, message_reactions, sangmata_imports,
--      proof_sessions, feedback_proofs, pending_feedback_confirms, blacklist_hits
--   4) admin_subscriptions bleibt (Push-Notifications fuers Dashboard)
--
-- VOR DEM AUSFUEHREN
-- ──────────────────
--   ⚠️  BACKUP: Erstelle in Supabase einen Snapshot der Datenbank!
--   Settings → Backups → Create Backup
--
--   Nach erfolgreichem Backup: dieses Script im SQL-Editor ausfuehren.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── BERATER-Tabellen droppen ───────────────────────────────────────────────
DROP TABLE IF EXISTS messages                  CASCADE;
DROP TABLE IF EXISTS chats                     CASCADE;
DROP TABLE IF EXISTS learning_queue            CASCADE;
DROP TABLE IF EXISTS knowledge_base            CASCADE;
DROP TABLE IF EXISTS knowledge_categories      CASCADE;
DROP TABLE IF EXISTS blacklist                 CASCADE;
DROP TABLE IF EXISTS integration_logs          CASCADE;
DROP TABLE IF EXISTS user_flags                CASCADE;
DROP TABLE IF EXISTS widget_visitors           CASCADE;
DROP TABLE IF EXISTS visitor_activities        CASCADE;
DROP TABLE IF EXISTS visitor_sessions          CASCADE;
DROP TABLE IF EXISTS daily_coupons             CASCADE;
DROP TABLE IF EXISTS coupon_schedule           CASCADE;
DROP TABLE IF EXISTS ai_message_classifications CASCADE;

-- Falls vorhanden: weitere Berater-spezifische Tabellen
DROP TABLE IF EXISTS abuse_filter_log          CASCADE;
DROP TABLE IF EXISTS sellauth_sync_jobs        CASCADE;
DROP TABLE IF EXISTS sync_jobs                 CASCADE;
DROP TABLE IF EXISTS scraped_links             CASCADE;
DROP TABLE IF EXISTS discovered_links          CASCADE;
DROP TABLE IF EXISTS kb_visits                 CASCADE;
DROP TABLE IF EXISTS chat_summaries            CASCADE;

-- ─── BERATER-Spalten aus settings entfernen ─────────────────────────────────
-- Ueberschrift-Werte bleiben erhalten falls auch der AdminHelper Sellauth nutzt
-- (Channel-Pakete brauchen sellauth_api_key + sellauth_shop_id)
ALTER TABLE settings DROP COLUMN IF EXISTS system_prompt;
ALTER TABLE settings DROP COLUMN IF EXISTS negative_prompt;
ALTER TABLE settings DROP COLUMN IF EXISTS welcome_message;
ALTER TABLE settings DROP COLUMN IF EXISTS manual_msg_template;
ALTER TABLE settings DROP COLUMN IF EXISTS ai_model;
ALTER TABLE settings DROP COLUMN IF EXISTS ai_max_tokens;
ALTER TABLE settings DROP COLUMN IF EXISTS ai_temperature;
ALTER TABLE settings DROP COLUMN IF EXISTS ai_max_input_tokens;
ALTER TABLE settings DROP COLUMN IF EXISTS rag_threshold;
ALTER TABLE settings DROP COLUMN IF EXISTS rag_match_count;
ALTER TABLE settings DROP COLUMN IF EXISTS max_history_msgs;
ALTER TABLE settings DROP COLUMN IF EXISTS summary_interval;
ALTER TABLE settings DROP COLUMN IF EXISTS admin_telegram_id;
ALTER TABLE settings DROP COLUMN IF EXISTS notify_new_chat;
ALTER TABLE settings DROP COLUMN IF EXISTS notify_every_msg;
ALTER TABLE settings DROP COLUMN IF EXISTS widget_powered_by;
ALTER TABLE settings DROP COLUMN IF EXISTS abuse_max_msgs_per_hour;
ALTER TABLE settings DROP COLUMN IF EXISTS abuse_auto_ban_flags;
ALTER TABLE settings DROP COLUMN IF EXISTS abuse_min_msg_length;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_enabled;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_discount;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_type;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_description;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_max_uses;
ALTER TABLE settings DROP COLUMN IF EXISTS coupon_schedule_hour;

-- ─── Verifikation: erwarten AdminHelper-Tabellen sollten existieren ─────────
DO $$
DECLARE
  missing TEXT := '';
  required TEXT[] := ARRAY[
    'settings', 'admin_subscriptions',
    'bot_channels', 'channel_members', 'channel_co_admins',
    'channel_knowledge', 'channel_safelist', 'channel_blacklist',
    'channel_groups', 'channel_packages', 'channel_purchases',
    'bot_messages', 'scheduled_messages', 'scam_entries',
    'user_feedbacks', 'user_reputation',
    'channel_diss_battles', 'message_reactions',
    'admin_reports', 'user_identity_log', 'channel_user_status'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY required LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      missing := missing || t || ', ';
    END IF;
  END LOOP;
  IF missing != '' THEN
    RAISE NOTICE 'WARNUNG: AdminHelper-Tabellen fehlen: %', missing;
  ELSE
    RAISE NOTICE '✅ Alle AdminHelper-Tabellen vorhanden.';
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
--   FERTIG. Naechste Schritte:
--   1. AdminHelper-Code auf Render deployen (Render-Variable APP_URL setzen)
--   2. Bot-Token im AdminHelper-Dashboard hinterlegen (Settings → Smalltalk)
--   3. Webhook wird beim Server-Start automatisch registriert
-- ════════════════════════════════════════════════════════════════════════════
