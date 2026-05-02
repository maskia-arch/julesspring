-- ============================================================================
-- AI_AUTO Schema-Update v1.5.8
-- ============================================================================
-- Translation-Cache für das echte i18n-Tool (siehe src/services/i18n.js).
--
-- Ziel: Strings, die per DeepSeek-API übersetzt werden, persistent zwischen
-- Server-Neustarts cachen, damit pro String + Sprache nur einmal die
-- Übersetzungs-API aufgerufen werden muss.
--
-- Schlüssel: (source_key, target_lang) → translated_text
--   • source_key: Schlüssel aus T_DE in i18n.js, z.B. "ai_locked", "ah_clean".
--                 Für Ad-hoc-Übersetzungen (translateText()) wird ein
--                 Hash-Präfix "ad_hoc_…" verwendet.
--   • target_lang: ISO-Sprachcode (en, es, ru, …)
--   • source_text: Originaltext (Deutsch) zur Versionskontrolle
--   • translated_text: Übersetzung
-- ============================================================================

CREATE TABLE IF NOT EXISTS translation_cache (
  id              BIGSERIAL PRIMARY KEY,
  source_key      TEXT        NOT NULL,
  target_lang     TEXT        NOT NULL,
  source_text     TEXT        NOT NULL,
  translated_text TEXT        NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT translation_cache_unique UNIQUE (source_key, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_translation_cache_lang
  ON translation_cache(target_lang);

CREATE INDEX IF NOT EXISTS idx_translation_cache_key
  ON translation_cache(source_key);

-- Optionaler Maintenance-Helper: Cache komplett leeren
-- (z.B. nach grundlegender Änderung der Source-Strings)
-- SELECT 'TRUNCATE TABLE translation_cache;' AS hint;
