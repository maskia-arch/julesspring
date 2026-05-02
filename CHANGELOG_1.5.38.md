# Update 1.5.38

## Was ist neu

### 1) Echtes Translation-Tool für den AdminHelper
Das frühere fest verdrahtete Mehrsprachen-Wörterbuch ist durch ein echtes
Übersetzungs-Tool auf DeepSeek-Basis ersetzt:

- **Eine einzige Source of Truth** in `src/services/i18n.js` → `T_DE`
  (alle Strings nur noch auf Deutsch).
- **Alle anderen Sprachen** werden zur Laufzeit via DeepSeek-API übersetzt
  und in der Tabelle `translation_cache` (Supabase) persistent gecacht.
- **In-Memory-Cache** für O(1)-Lookups nach dem Preload.
- **Stale-while-revalidate**: Wenn ein String noch nicht übersetzt ist,
  wird sofort der deutsche Originaltext zurückgegeben und im Hintergrund
  übersetzt – beim nächsten Aufruf liegt die Übersetzung bereit.
- **Preload beim Server-Start** (`preloadTranslations`) füllt fehlende
  Übersetzungen für alle Sprachen einmalig nach.

Folge davon: Neue Sprachen ergänzt man jetzt nur noch in
`SUPPORTED_LANGUAGES`, neue Texte nur noch in `T_DE`.

### 2) Widget-Chat: Automatisches Aufräumen aus Kundensicht
Der Widget-Chat hält die Chat-ID jetzt in `sessionStorage` statt
`localStorage`. Konsequenz:

- Beim Verlassen der Seite (Tab schließen oder Domain wechseln) ist die
  Chat-ID weg → Kunde sieht beim nächsten Besuch einen leeren, neuen Chat.
- Innerhalb derselben Browser-Session (Navigation auf der Site) bleibt der
  Chat-Zustand erhalten – wie gewohnt.
- Zusätzlich räumt ein `pagehide`/`beforeunload`-Handler die Chat-ID
  proaktiv aus dem Storage.

Backend-seitig bleibt **die Historie unangetastet**: Im Dashboard sind alle
Chat-Verläufe weiterhin sichtbar – bis sie händisch gelöscht werden.

## Installation

1. **Datenbank-Migration laufen lassen:**
   `supabase/schema_v1.5.8.sql` in Supabase ausführen.
2. **Code-Dateien ersetzen** (alle 1:1 in den entsprechenden Pfad
   kopieren):
   - `src/server.js`
   - `src/services/i18n.js`
   - `src/services/adminHelper/tgAdminHelper.js`
   - `src/services/adminHelper/settingsHandler.js`
   - `src/public/widget.js`
3. **Server neu starten.**
   Im Log erscheint:
   ```
   [i18n] DB-Cache geladen: 0 Einträge
   [i18n] N fehlende Übersetzungen werden erzeugt…
   [i18n] Background-Preload abgeschlossen (N Einträge) in … ms
   ```

Beim ersten Start werden für 7 Sprachen × ~50 Strings ≈ 350 DeepSeek-
Aufrufe gemacht. Diese sind gestaffelt (250 ms Pause alle 10 Anfragen) und
landen im DB-Cache. Spätere Neustarts sind dann instant.

## Voraussetzung

- `DEEPSEEK_API_KEY` muss gesetzt sein (war es schon vorher; wird vom
  bestehenden Smalltalk-Bot bereits verwendet).

## Hinweise

- Die alte `welcome_intro`-Funktion verwendet jetzt einen `{name}`-Platz-
  halter, der vom bestehenden `commandHandler.js` korrekt befüllt wird –
  daher ist diese Datei unverändert.
- Möchtest du den Übersetzungs-Cache komplett zurücksetzen (z.B. nach
  Anpassung deutscher Source-Strings):
  `TRUNCATE TABLE translation_cache;` und Server neu starten.
