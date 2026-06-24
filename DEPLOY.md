# AI_AUTO v1.6.73 — Deploy-Anleitung

## 1. Code deployen
Inhalte aus `src/` in das laufende Projekt kopieren — überschreibt vorhandene Dateien.

## 2. SQL ausführen
Im Supabase SQL-Editor: **`supabase/schema_v1.6.73_full.sql`** in EINEM Lauf ausführen.
- Idempotent — kann auch bei Bestandssystem ausgeführt werden.
- Bei Neu-Installation: ersetzt alle bisherigen Schema-Dateien.

## 3. Neue Features aktivieren
- **AI @admin Meldungen**: Im Channel-Menü → AI Features → "🚨 AI @admin" → aktivieren.
- **Scamliste**: Channel-Menü → Safelist/Scamliste → "➕ User auf Scamliste setzen".
- **/safelist @user** und **/scamlist @user** funktionieren jetzt auch in der Gruppe für Admins.

## 4. Was passiert automatisch
- Jede Channel-Nachricht loggt Identity (TG-ID ↔ Username) in `user_identity_log`.
- `/ban` löscht Activity-Punkte des gebannten Users und markiert ihn für die Channel-AI.
- `/unban` setzt Status zurück.

## 5. Optional konfigurieren
- AI-Bewertung im AI @admin-Menü einschalten → Grok klassifiziert Meldungen automatisch.
- Pro Kategorie (Werbung/Scam/Spam/Beleidigung/Sonstiges) eine Auto-Konsequenz wählen.
