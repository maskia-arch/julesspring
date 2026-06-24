# 🗑 Lösch-Checkliste — ungenutzte Dateien (AdminHelper-only, Stand v2.0.1)

Diese Dateien werden vom AdminHelper **nicht** geladen/benötigt (per Require-Graph
ab `src/server.js` geprüft). Sie stammen aus dem abgetrennten AI-Berater bzw. sind
tote Duplikate. Du kannst sie gefahrlos löschen.

## Backend (von server.js nicht erreichbar)
- [ ] `src/config/deepseek.js`            → wird nirgends require()'d
- [ ] `src/services/ai/channelAiService.js` → nur Selbstreferenz, kein Import
- [ ] `src/services/ai/clarityDetector.js`  → nur Selbstreferenz, kein Import
- [ ] `src/utils/textSplitter.js`           → nur Selbstreferenz, kein Import
- [ ] `src/services/adminHelper/spamDetectionService.js`
        → DUPLIKAT. Genutzt wird `src/services/ai/spamDetectionService.js`
          (von `smalltalkAgent.js`). Diese adminHelper-Kopie wird nicht importiert.

## Frontend (Berater-only, vom AdminHelper-Dashboard nicht referenziert)
- [ ] `src/public/widget.js`         → Web-Chat-Widget des eSIM-Beraters
- [ ] `src/public/js/push-config.js` → alter Push-Helper mit Platzhalter-VAPID-Key;
        die echte Push-Logik liegt in `js/dashboard.js`

## Hinweis
- `dashboard.js` wurde in v2.0.1 vollständig von Berater-Code befreit
  (Chats, Traffic, Coupons/Wochenplan, KB-Browser, Learning-Queue, Sellauth-Sync,
  Widget-Embed). `function renderWeekSchedule()` bleibt als Pflicht-Stub erhalten.
- Optional (DB): Die Berater-Tabellen/Spalten räumt das bereits vorhandene
  `supabase/SPLIT_cleanup_adminhelper.sql` auf.
