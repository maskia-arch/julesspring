# AI_AUTO — Konsolidiertes Changelog

Alle Versionen chronologisch von neu nach alt.

---

## v2.0.4 — Bot-Token aus Environment-Variable

**Token-Quelle umgestellt**
- Der AdminHelper-Bot-Token wird jetzt aus einer **Render Environment-Variable** gelesen statt aus der DB/dem Dashboard. Neue zentrale Auflösung in `src/config/botToken.js`:
  - Reihenfolge: `SMALLTALK_BOT_TOKEN` → `ADMINHELPER_BOT_TOKEN` → `TELEGRAM_BOT_TOKEN` → (Fallback) `settings.smalltalk_bot_token` aus der DB.
  - Sobald eine ENV-Variable gesetzt ist, hat sie immer Vorrang. Der DB-Fallback bleibt nur für Abwärtskompatibilität.
- Alle Stellen, die zuvor den Token aus der DB lasen, nutzen jetzt diesen Helper: Webhook-Handler, Webhook-Registrierung, alle Scheduled-Tasks (Geplant, Auto-Clean, Auto-Delete, Quiet-Hours, Activity-Ranking), `setMyCommands`, Channel-Scan/-Register, Credit-Refill-Benachrichtigung, Telegram-Account-Cleanup.

**Dashboard**
- Die Token-**Eingabe wurde entfernt**. Stattdessen zeigt der Bereich „Bot Token" nur noch einen Status: ✅ Token vorhanden (Quelle ENV/DB) bzw. ⚠️ kein Token — plus den Hinweis, `SMALLTALK_BOT_TOKEN` in Render zu setzen. Der „🔍 Verbindung testen"-Button bleibt.
- Der Token wird nie mehr an den Browser ausgeliefert (`getSettings` entfernt ihn) und kann nicht mehr über `/settings` geschrieben werden.
- Statusanzeige korrigiert (prüfte fälschlich `result.ok` statt `result.connected`).

**Nebenbei behoben**
- Push-Abo schlug mit 500 fehl, wenn die Spalte `device_label` in `admin_subscriptions` fehlt. Der Insert versucht es jetzt zuerst mit, dann ohne `device_label` → kein 500 mehr (`Could not find the 'device_label' column …`).

> Einrichtung: In Render unter **Environment → Add Environment Variable**: `SMALLTALK_BOT_TOKEN` = dein BotFather-Token. Nach dem Redeploy registriert sich der Webhook automatisch (via `RENDER_EXTERNAL_URL`); im Log erscheint `✅ Registriert …` + eine `Info:`-Zeile.

---

## v2.0.3 — Bot reagiert wieder (Webhook-Fix) + Detailfixes

- Webhook-Registrierung robust (`APP_URL` → `RENDER_EXTERNAL_URL` → `settings.webhook_url`) + `getWebhookInfo`-Diagnose im Log. `getSettings()` im Webhook bevorzugt `id=1`. „Hallo undefined" behoben.

---

## v2.0.2 — Modell-Umstellung + Smalltalk-KI-Fix

- Smalltalk-KI-Crash behoben (toter `require`). Neue Modelle: DeepSeek V4 Flash (Fast/Think), GPT 5.4 Nano, Grok AI.

---

## v2.0.1 — Mobile-Optimierung, Berater-Entfernung, Bugfixes

---

## v2.0.0 — Dashboard-Rewrite (AdminHelper Standalone)

---

## v2.0.1 — Mobile-Optimierung, Berater-Entfernung, Bugfixes

- KPI-Leiste mobil gefixt (feste Höhe → auto, 3 Spalten). Startseite = Channels. Reject-Review-Bug behoben (`reviewed_by`-Typkonflikt). `dashboard.js` von Berater-Code befreit. `DELETE_2.0.1.md` mit Lösch-Checkliste.

---

## v2.0.0 — Dashboard-Rewrite (AdminHelper Standalone)

- Lade-Gate-Fix (Dashboard war nicht erreichbar), neue Übersichten (Übersicht/Channels/Moderation/Engagement/Geplant/Einstellungen), neuer `dashboardController.js`.

---

## v1.6.73 — Konsolidierung + neue Features (Auszug)

---

## v1.6.73 — Konsolidierung + neue Features

**SQL-Konsolidierung**:
- Alle Schema-Migrations seit 1.5 in **`schema_v1.6.73_full.sql`** zusammengeführt — neu-installations-ready.

**Scamliste vervollständigt**:
- "User hinzufügen"-Button im Scamlisten-Menü (analog Safeliste).
- Befehle `/scamlist [@user]` und `/safelist [@user]` funktionieren jetzt für Channel-Admins (setzen User auf jeweilige Liste).
- Für Nicht-Admins funktionieren die Befehle wie `/check` (öffnen User-Übersicht).

**@admin-Meldungsfeature** (komplett neu):
- User-Reply mit `@admin`-Mention → Meldung an alle Channel-Owner per Privatnachricht (wer, was, wen).
- Im Channel kurze Bestätigung "Meldung an die Admins erfolgreich!".
- Optional: AI-Bewertung via Grok ("Werbung"/"Scam"/"Spam"/"Beleidigung"/"Sonstiges").
- Optional: automatische Konsequenzen pro Kategorie konfigurierbar (warn / mute_1h / mute_6h / mute_24h / mute_perm / ban / delete).
- Einstellungsmenü "AI @admin" unter AI Features.
- Tabellen: `admin_reports`, `bot_channels.admin_report_*`.

**Bessere Channel-AI-Nutzer-Identität**:
- TG-ID ↔ Username-Verlauf wird in `user_identity_log` geloggt (initial + bei jeder Erkennung einer Veränderung).
- Channel AI sieht den vollständigen Username-Verlauf des Chatpartners — verhindert Verwechslungen wie "AI hat @fearqlf 'angeprangert' und dann nicht erkannt dass sie persönlich mit ihm schreibt".

**Ban-Awareness**:
- Beim Ban eines Users werden seine Activity-Tracker-Punkte automatisch gelöscht (Ranking-Manipulation verhindert).
- Status wird in `channel_user_status` gespeichert; Channel-AI bekommt diese Info im Kontext.

---

## v1.6.72 — Premium-Emoji-Speicherfehler + Enddatum-Edit

- `toGermanDateTime` und `parseGermanDateTime` in `telegramFormatter.js` implementiert und exportiert — behebt `TypeError: toGermanDateTime is not a function` beim Speichern wiederholender Nachrichten.
- Sommer-/Winterzeit-aware (Europe/Berlin).
- Nachträgliches Bearbeiten des Enddatums via neuem "🏁 Enddatum ändern"-Button.
  - Absolute Eingabe (`31.12.2026 23:59` oder `31.12.2026`).
  - Relative Eingabe (`+7d`, `+2w`, `+1m`, `+24h`).
  - `/clear` für Endlos-Modus.
- Latenter Routing-Bug für `rep_emedia_del` und `rep_ebtns_del` mitgefixt (wurden fälschlich zu `rep_emedia` geroutet).

## v1.6.71 — Channel-Löschung komplett

- `deleteChannel` nutzt Telegram-API `leaveChat` (Bot verlässt Gruppe automatisch).
- Komplette DB-Bereinigung über 27 Channel-bezogene Tabellen.
- TEXT/BIGINT Type-Mismatch automatisch durch Doppel-Versuch abgefangen.
- Frontend: detaillierte Warnung + Erfolgs-Statistik im Toast.

## v1.6.70 — Traffic-Chart + Initial-Load

- Traffic-Chart-Title bei 24h korrigiert (war "30 Tage", jetzt "24 Stunden").
- Map-Lookup mit allen Range-Keys (`'24h'` war im 1.6.68-Fix nicht abgedeckt).
- 24h-Button-Style-Toggle korrigiert.
- Dashboard lädt jetzt **alle Daten parallel** beim Öffnen (statt 5+s staggered).
- `showSection` triggert Section-Reload bei Tab-Wechsel (Backup).
- `loadActivityFeed` mit Error-UI statt stillem "Lädt..."-Hang.

## v1.6.68 — Push-Notifications + Traffic-Chart-Title (1)

- Fehlende Methode `notifyNewLearningCase` in `notificationService` ergänzt.
- Service-Worker mit `install`/`skipWaiting`-Event (Updates sofort aktiv).
- Service-Worker `pushsubscriptionchange`-Handler für automatische Token-Erneuerung.
- Permission-Check in `subscribePush` mit klarer "Denied"-Anleitung.
- Erweiterte expired-Erkennung (401, 403, 404, 410).
- (Traffic-Title-Fix nicht greifend — siehe 1.6.70.)

## v1.6.67 — HTML-Escape im AdminHelper

- `_escapeHtml`-Helper für User-Input in Telegram-HTML-Templates.
- Channel-Titles mit `&`, `<`, `>` brachen vorher `parse_mode: HTML` → silent fail (Admin-Verwalten "reagierte nicht").
- `editOrSend` mit Plain-Text-Fallback bei HTML-Parse-Fehlern + Logging.

## v1.6.66 — Admin-Verwalten defensiv + SQL Function Fix

- Owner-Check mit String- UND Numeric-Vergleich (Typ-Robustheit).
- Fallback wenn `added_by_user_id` null: Telegram-Admin-Check als Owner-Beweis.
- DB-Fehler werden ins UI gerendert (`channel_co_admins` Tabelle fehlt → Hinweis auf schema_v1.6.13).
- Konkrete Fehlerursache statt generischer "Admins konnten nicht geladen werden"-Hinweise.
- `recompute_channel_budget` SQL-Function korrekt gefixt (mein 1.6.65-Fix war umgekehrter Bug — `channel_purchases.channel_id` ist TEXT, nicht BIGINT).

## v1.6.65 — /ban Username-Lookup + /order im Widget + SQL Function

- `_resolveTargetUser` Helper: 3-stufige Auflösung (Reply → numeric ID → @username via channel_members DB-Lookup).
- `/ban` `/unban` `/mute` `/unmute` funktionieren konsistent mit allen 3 Ziel-Formaten.
- `/order INVOICE_ID` direkt im Web-Widget gehandhabt (sellauthService.getInvoice).
- Auch natürlichsprachliche Varianten erkannt: "bestellung 123", "Invoice: abc".

## v1.6.64 — Premium-Emoji-Speicherung + 3 Edit-Handler

- `sched_wizard_text` konvertiert Premium-Emojis und Formatierung via `entitiesToHtml` zu Telegram-HTML — vorher wurden Premium-Emojis als normale Unicode-Zeichen gerendert.
- Neu implementiert: `rep_edit_text`, `rep_edit_media`, `rep_edit_btns` Wizard-Handler.

## v1.6.63 — Powered-By Schriftzug + Spielerverwaltung re-port

- Neuer Button "✨ Powered-By Schriftzug" im Activity-Tracker.
- Schriftzug erscheint in Spielstart, Auto-Posting, Final-Ranking und `/top`.
- XSS-sicher (HTML-escaped, max 100 Zeichen).
- Spielerverwaltung aus 1.6.60 re-portiert (war in 1.6.62 verloren).

## v1.6.62 — Activity-Tracker Game-Started-Flag

- `bot_channels.activity_game_started_posted` verhindert doppeltes Spielstart-Posting bei langsamen Auto-Scheduler-Läufen.

## v1.6.57 — Globaler AI-Lerncache

- `ai_message_classifications` (hash, is_real, prompt_version, hit_count) — gleiche Texte werden nicht mehrfach klassifiziert.

## v1.6.55-2 — Activity-Tracker Auto-Posting + Credit-Log

- `channel_credit_log` für transparente Kosten-Übersicht.
- `bot_channels.activity_*` (Auto-Ranking-Intervall, Spielzeitraum, Final-Ranking-Posted).

## v1.6.54 — Activity Tracker

- `channel_user_points` Tabelle.
- `bot_channels.group_game_enabled` + `group_game_quality_min_chars`.

## v1.6.44 — Stars-Mode für Nachtruhe (Erweiterung)

- `bot_channels.quiet_pause_scheduled` BOOLEAN.

## v1.6.41-2 — Stars-Mode für Nachtruhe

- `bot_channels.quiet_invoice_msg_id` BIGINT.

## v1.6.38-2 — Mute/Ban Persistenz

- `channel_restrictions` Tabelle für persistente Mute/Ban-States.

## v1.6.29 — Premium-Emoji-Storage

- `scheduled_messages.message_entities`, `caption_entities`, `inline_buttons` (JSONB).

## v1.6.26-2 — Nachtruhe Stars

- `bot_channels.quiet_mode` TEXT, `quiet_stars_amount` INTEGER.

## v1.6.13 — Channel Co-Admins

- `channel_co_admins` Tabelle: Owner kann weitere Telegram-Admins als Co-Admins berechtigen.

## v1.6.3 — Channel-spezifische AI-Features

- `channel_user_memory`, `ai_usage_log`, `ai_spam_violations`.



---

# Update 1.5.45

## Was neu ist

### 1) Nachtruhe-Funktion

Unter **Einstellungen → Channel → 📅 Zeitplan** gibt es jetzt ein neues
Untermenü mit zwei Optionen:

- **➕ Neue geplante Nachricht** (wie bisher)
- **🌙 Nachtruhe einrichten**

Die Nachtruhe setzt während des konfigurierten Zeitfensters automatisch
eine Schreibsperre für alle User per `setChatPermissions`. Beginn und Ende
werden mit einer freundlichen Ankündigung im Channel gemeldet.

**Einrichtung:**
1. Einstellungen → Channel → Zeitplan → 🌙 Nachtruhe einrichten
2. Zeit eingeben: `22:00 - 08:00` (oder `22:00-08:00`, En-Dash geht auch)
3. Bot textet: "✅ Nachtruhe eingerichtet: 22:00–08:00 Uhr"

**Konfigurierbar:**
- Start- und Endzeit (Fenster über Mitternacht wird korrekt erkannt)
- Timezone: `Europe/Berlin` als Standard (direkt in DB änderbar)
- Optional: Wiederholende Nachrichten laufen durch oder werden pausiert

**Wie der Scheduler arbeitet:**
- Läuft minütlich (Server-Cron-Block)
- Prüft `quiet_start`/`quiet_end` aller aktiven, freigeschalteten Channels
- Setzt Schreibsperre genau zur konfigurierten Minute
- Behandelt Inkonsistenzen nach Neustart (stellt korrekten Zustand leise wieder her)
- `quiet_active`-Flag in DB verhindert Doppel-Aktionen

### 2) Variierender Text — GPT-generiert und gecacht

Ankündigungs-Texte werden **nicht im Code fest hinterlegt**, sondern beim
ersten Bedarf via GPT generiert (6 Variationen pro Kategorie/Sprache) und
in der neuen Tabelle `cached_bot_texts` dauerhaft gespeichert.

Jeder Aufruf zieht eine zufällige Variante aus dem Cache — kein zweiter
GPT-API-Call bis du den Cache manuell löschst.

Beispiele für auto-generierte Variationen (`quiet_start`, `de`):
> 🌙 Gute Nacht zusammen! Bis 08:00 Uhr gilt eine kurze Schreibpause.
> 😴 Die Nachtruhe beginnt — bis morgen früh um 08:00, schlaft gut!
> 🔕 Ruhemodus an! Bis 08:00 Uhr ist Chat-Pause. Gute Nacht! 💫

Fallback-Texte (6 Varianten) sind für den Fall eingebaut, dass der
OpenAI-API-Key fehlt oder GPT nicht erreichbar ist.

### 3) Statistik-Button repariert

Der `📊 Statistik`-Button war kaputt — er versuchte, die nicht existierende
Spalte `left_at` zu lesen (`channel_members` hat diese Spalte nicht).

**Jetzt zeigt Statistik:**
```
📊 Statistik

👥 Mitglieder gesamt: 142
✍️ Heute aktiv: 23
📈 Eintritte (24h): +3
📉 Verlassen (24h): -1

🏆 Aktivste Mitglieder:
1. @max_m — 1.247 Nachrichten
2. Daniel — 891 Nachrichten
3. @anna_k — 634 Nachrichten
…
```

Der Austritt-Zähler nutzt `is_deleted=true` mit `last_seen >= yesterday`
als Proxy (da kein `left_at`-Feld existiert). Top-5 basiert auf
`channel_members.message_count` aus dem Activity-Tracker (1.5.42).

## Neue Dateien

- `src/services/adminHelper/quietHoursService.js` — Nachtruhe-Logik:
  Timezone-aware Zeitfenster-Checks, GPT-Texte generieren/cachen,
  Schreibsperre setzen/aufheben, Scheduler-Hook
- `supabase/schema_v1.5.13.sql` — neue Spalten in `bot_channels` +
  Tabelle `cached_bot_texts`

## Geänderte Dateien

- `src/services/adminHelper/settingsHandler.js` — Statistik-Fix;
  `cfg_sched_menu_*` öffnet Zeitplan-Übersicht; neue Cases `quiet`,
  `quiet_settime`, `quiet_off`, `quiet_toggle_sched`; Action-Parsing
  für `cfg_quiet_*`
- `src/services/adminHelper/inputWizardHandler.js` — `quiet_settime`
  Wizard-Schritt (Validierung, Normalisierung, Background-Text-Caching)
- `src/server.js` — minütlicher `runQuietHoursCheck`-Scheduler
- `src/services/i18n.js` — neue Strings für Nachtruhe

## Installation

1. **SQL ausführen:** `supabase/schema_v1.5.13.sql`
2. Code-Dateien ersetzen (5 bestehende + 1 neue)
3. Server neu starten

Beim ersten Aufruf der Nachtruhe-Ankündigung werden die Texte im
Hintergrund via GPT generiert (einmalig ~2s Verzögerung). Danach
kommt alles aus dem Cache.

## Tests

| Bereich | Tests | Status |
|---|---|---|
| `_isInQuietWindow` (Zeitfenster-Logik) | 10 Fälle (overnight, normal, null, edge) | 10/10 ✓ |
| `_localHHMM` (Timezone-Rendering) | 2 Fälle (gültig, ungültig/Fallback) | 2/2 ✓ |
| Text-Caching | 4 Szenarien (GPT-Call, Cache-Hit, kein API-Key, Variationen) | 4/4 ✓ |
| Zeitformat-Parsing im Wizard | 7 Eingaben (normales Format, kein Leerzeichen, En-Dash, einstellige Stunden, Fehleingaben) | 7/7 ✓ |
| Syntax-Check | 6 Dateien | 6/6 ✓ |

## Manueller Test

**Test 1 — Nachtruhe einrichten:**
1. Einstellungen → Channel → Zeitplan (neuer Bildschirm erscheint)
2. "🌙 Nachtruhe einrichten" antippen
3. `22:00 - 08:00` senden
4. Erwartung: Bestätigung + Link zu Nachtruhe-Einstellungen
5. In Nachtruhe-Einstellungen: Status "✅ Aktiv: 22:00–08:00 Uhr"

**Test 2 — Schreibsperre um 22:00 Uhr:**
1. Um 22:00 (Channel-Timezone) erscheint im Channel eine freundliche
   Ankündigung (auto-generierter Text via GPT, zufällige Variante)
2. User können nicht mehr schreiben
3. Um 08:00: neue Ankündigung, Chat wieder offen

**Test 3 — Statistik:**
1. Einstellungen → Channel-Hauptmenü → 📊 Statistik
2. Erwartung: Mitglieder-Zahlen + Top-5 Liste (keine Fehlermeldung mehr)


---

# Update 1.5.42

## Was sich geändert hat

### 1) `/feedbacks @user` entfernt

Der Befehl ist sowohl als Slash-Command (Telegram-Vorschlagsliste) als auch
als Funktion komplett entfernt. Die gleiche Information liefern weiterhin:

- `/check @user` — Score, Pos/Neg-Feedbacks, Scamlist-Status, KI-Zusammenfassung
- `/userinfo @user` — Namenshistorie, Beitritt, Aktivität

Im Settings-Menü ist die Top-10-Verkäufer-Liste weiterhin erreichbar
(Moderation → Feedback → 🏆 Top 10).

### 2) UserInfo arbeitet jetzt mit echten Aktivitätsdaten

**Das war das Hauptproblem**: `last_seen` wurde nur beim Channel-Beitritt
aktualisiert. Wenn ein Admin am 03.05. um 09:00 schrieb, stand trotzdem
"zuletzt aktiv: 20.04.".

**Behoben durch**:
- Neuer `_trackActivity`-Hook im AdminHelper-Webhook, der bei _jeder_
  Group-Message folgende Felder aktualisiert:
  - `last_seen` (jede Aktivität)
  - `last_message_at` (nur Text-Nachrichten, nicht Service-Messages)
  - `last_message_preview` (200 Zeichen für UserInfo-Anzeige)
  - `message_count` (inkrementell)
- UserInfo zeigt jetzt `last_message_at` statt `last_seen`, mit
  relativer Zeitanzeige: "vor 10 Min." / "vor 3 Std." / "vor 2 Tagen".
- Außerdem wird `Gesamt-Nachrichten: 247` angezeigt, plus die letzten
  24h-Aktivität.

Edge Cases sind getestet:
- Bot-Nachrichten werden ignoriert
- Privatchats werden ignoriert
- Telegram-Service-User (777000) wird ignoriert
- Service-Messages ohne Text aktualisieren `last_seen`, schreiben aber
  nichts ins Message-Log

### 3) Auto-Delete für UserInfo-/Check-Antworten (5 Minuten)

User-Anfragen und ihre Antworten werden nach 5 Minuten automatisch
gelöscht, damit der Chat sauber bleibt:

| Befehl                | Auto-Delete-Zeit |
|-----------------------|------------------|
| `/userinfo` Antwort   | 5 Min |
| `/userinfo` Anfrage   | sofort beim Antworten |
| `/check` Antwort      | 5 Min |
| `/safeliste` Antwort  | 5 Min |
| `/safeliste` Anfrage  | 5 Min (NEU — vorher blieb sie hängen) |
| `/scamliste` Antwort  | 5 Min |
| `/scamliste` Anfrage  | 5 Min (NEU) |
| Namenshistorie-Popup  | 5 Min (NEU) |
| SangMata-Popup        | 5 Min (NEU) |

**AI-Konversationen sind ausgenommen**: `/ai` und Replies an AI-
Antworten bleiben unangetastet — diese Gespräche sollen erhalten bleiben.

### 4) UserInfo & Tageszusammenfassung sammeln wieder Daten

Der Tagesbericht las bisher aus `channel_chat_history`, einer Tabelle,
die _nur_ AI-Konversationen enthält. Wenn keine `/ai` benutzt wurde, kam
nichts zurück.

**Neu**: Eigene Tabelle `channel_message_log`, in die der Webhook bei
_jeder_ Group-Message einen Eintrag schreibt. Der Tagesbericht greift
primär darauf zu, mit Fallback auf die alte Tabelle für Bestandsdaten.

Aufräumung läuft automatisch: Stündlicher Cleanup-Job löscht alle
Einträge älter als 48 Stunden.

### 5) Tagesbericht: Highlights statt Protokoll

Der bisherige Bericht las wie ein 5-8-Stichpunkte-Protokoll. Neuer
System-Prompt verlangt:

- Maximal 4-6 Kernpunkte (⚡-Bullets)
- Fokus auf Themen, Vorfälle, Trends, Stimmung
- Keine Zeit-stempel-Narrationen ("Um 14:32 sagte X dass Y")
- Verdichtung zur Aussage ("Wiederholte Beschwerden über Lieferzeiten")
- Wenn alles ruhig war: 1-2 Sätze ohne Drumherum
- User werden vor dem LLM zu `User1`, `User2`… anonymisiert
- Der Bericht wird mit `📰 Tageshighlights` betitelt (statt
  "Tageszusammenfassung")

### 6) SangMata-Forwards werden als eigene DB erkannt

Wenn der Channel-Admin im DM mit dem AdminHelper einen Bericht von
@SangMata_Bot weiterleitet, passiert folgendes:

1. Bot erkennt den Forward (über `forward_from` oder das neuere
   `forward_origin`). Akzeptiert Variationen: `SangMata_Bot`,
   `sangmata_bot`, `SangMata_BETA_BOT` etc.
2. Bot extrahiert die Telegram-ID aus dem Bericht (mehrere Patterns
   versucht: "ID: 123…", "🆔 123…", `tg://user?id=…`, Fallback auf
   8-12-stellige Zahl).
3. Eintrag in neuer Tabelle `sangmata_imports` (volltext, max 4000
   Zeichen).
4. Best-Effort-Parsing nach "Old/New Username: …" um Aliasse in
   `user_name_history` zu ergänzen.
5. Antwort an den User: "✅ Danke! Ich habe die Daten zur Telegram-ID
   123456789 gespeichert (3 Aliasse ergänzt). Die Information taucht
   jetzt in `/userinfo 123456789` auf."

Wichtig:
- **Nur weitergeleitete Nachrichten von @SangMata_Bot werden
  verarbeitet.** Eigene SangMata-ähnliche Texte werden ignoriert.
- **Nur im DM**, nicht in Gruppen (würde Spam erzeugen).
- Wenn keine ID erkennbar: höfliche Antwort, dass kein Bericht erkannt
  wurde.

UserInfo zeigt SangMata-Imports als Button (`📥 SangMata-Imports (3)`),
der die Berichte einsehen lässt.

## Geänderte Dateien

| Datei | Änderung |
|---|---|
| `src/server.js` | `/feedbacks` aus Slash-Command-Listen; neuer Cleanup-Scheduler für `channel_message_log` (stündlich) |
| `src/routes/smalltalkBotRoutes.js` | `_trackActivity()` für jede Group-Message; SangMata-Forward-Erkennung und -Handler im DM |
| `src/services/adminHelper/commandHandler.js` | `/feedbacks @user` und `/feedbacks` (DM) entfernt; `/userinfo` trackt Antwort + löscht User-Anfrage; `/safeliste` und `/scamliste` löschen User-Anfrage |
| `src/services/adminHelper/userInfoService.js` | Liest `last_message_at` und `message_count`; zählt SangMata-Imports und Namens-Historien-Einträge; relativer Zeit-Renderer |
| `src/services/adminHelper/dailySummaryService.js` | Primärquelle `channel_message_log`, Fallback `channel_chat_history`; neuer Highlights-Prompt; User-Anonymisierung |
| `src/services/adminHelper/callbackHandler.js` | `uinfo_sangmata_*` zeigt jetzt echte Imports; beide `uinfo_*`-Antworten werden auto-gelöscht |
| `src/services/adminHelper/safelistService.js` | Neuer `pruneOldMessageLog()`-Helper |
| `supabase/schema_v1.5.11.sql` | NEU: `channel_members.message_count/last_message_at/last_message_preview`; Tabellen `channel_message_log` und `sangmata_imports`; Cleanup-Funktion |

## Installation

1. **SQL ausführen**: `supabase/schema_v1.5.11.sql`
2. **Code-Dateien ersetzen** (8 Dateien)
3. **Server neu starten**

Nach dem Start:
- Slash-Command-Listen werden bei Telegram aktualisiert (`/feedbacks` ist weg)
- Erste Aktivitäten landen sofort im neuen `channel_message_log`
- Erster Cleanup-Run nach 2 Min, danach stündlich

## Tests

| Bereich | Tests | Status |
|---|---|---|
| SangMata-ID-Extraktion | 10 Patterns inkl. Negativ-Cases | 10/10 ✓ |
| SangMata-Forward-Erkennung | 8 forward_from / forward_origin Varianten | 8/8 ✓ |
| `_trackActivity` | 6 Szenarien (Insert, Update, Bot-Skip, Privat-Skip, 777000-Skip, kein-Text) | 6/6 ✓ |
| DailySummary-Datenquelle | 3 Szenarien (neue Tabelle, Fallback, leer) | 3/3 ✓ |
| UserInfo-Render | last_message_at vs. last_seen, message_count, History-Counts | ✓ |
| Syntax-Check aller Dateien | 8 Dateien | 8/8 ✓ |

## Manueller Test

**Test 1 — UserInfo zeigt Echtzeit-Aktivität**:
1. Schema-Migration ausführen, Code deployen, Server starten
2. Als User in der Gruppe etwas schreiben
3. Als Admin im DM mit Bot: `/userinfo @username` (oder ID)
4. Erwartet: "Zuletzt aktiv: vor X Min." (nicht mehr Tage zurück)
5. Erwartet: "Gesamt-Nachrichten: N" mit korrekter Zahl

**Test 2 — Tagesbericht funktioniert wieder**:
1. Im Channel/Gruppe normal schreiben (kein `/ai` nötig)
2. Settings → AI Features → 📰 Tagesbericht → "Jetzt erstellen"
3. Erwartet: ⚡-Bullets mit Themenfokus, kein Protokoll

**Test 3 — SangMata-Forward**:
1. Im DM mit @SangMata_BOT: `/allhistory 123456789`
2. Antwort von SangMata an den AdminHelper-Bot **weiterleiten**
3. Erwartet: "✅ Danke! Ich habe die Daten zur Telegram-ID 123456789
   gespeichert."
4. Anschließend `/userinfo 123456789` → unten "📥 SangMata-Imports (1)"
5. Klick → der Original-Bericht wird angezeigt


---

# Update 1.5.41

## Worum geht es

Wenn der Channel-Admin in einer wiederholenden Nachricht **animierte
Premium-Emojis** verwendet, soll der Bot diese 1:1 mit-versenden — nicht
als statische Text-Emojis. Außerdem sollen alle anderen Formatierungen
(fett, kursiv, Spoiler, Links etc.) erhalten bleiben.

## Geht das überhaupt?

**Ja**, seit dem Telegram Bot API Update vom **9. Februar 2026**:

> "Allowed bots to use custom emoji in messages directly sent by the bot
> to private, group and supergroup chats if the owner of the bot has a
> Telegram Premium subscription."

Vorher mussten Bots einen NFT-Username auf Fragment kaufen (~10 000 €).
Jetzt reicht es, dass der **Telegram-Account, dem der Bot gehört**, eine
aktive Premium-Subscription hat.

## Wie es technisch funktioniert

Telegram liefert bei jeder eingehenden Nachricht ein `entities`-Array mit:

```json
[
  { "type": "custom_emoji", "offset": 6, "length": 2,
    "custom_emoji_id": "5375248220636463728" },
  { "type": "bold", "offset": 9, "length": 12 }
]
```

Der Trick: Wir speichern dieses Array **1:1 mit der Nachricht ab** und
geben es beim Wiedersenden als `entities` (bzw. `caption_entities` bei
Mediennachrichten) wieder mit. Telegram rendert dann genau das, was der
Admin ursprünglich sah — inklusive animierter Custom-Emojis.

Vorteil dieses Ansatzes:
- Keine HTML-Sanitization nötig
- Keine `getCustomEmojiStickers`-Lookups
- Funktioniert mit allen entity-Typen (bold, italic, links, spoilers, …)
- Robust gegen Edge Cases

Wichtige Bedingung: **Wenn `entities` mitgegeben werden, darf
`parse_mode` NICHT gleichzeitig gesetzt sein** — Telegram lehnt sonst
mit "Bad Request: can't parse entities" ab. Das ist transparent in den
`tgApi`-Helpern gelöst.

## Geänderte Dateien

| Datei | Änderung |
|---|---|
| `src/services/adminHelper/inputWizardHandler.js` | `sched_wizard_text` und `sched_wizard_file` extrahieren `msg.entities` bzw. `msg.caption_entities` und legen sie in `pending.msgEntities` ab. Wenn der Admin ein Foto/Video MIT Caption schickt, gewinnt die Caption über den Step-1-Text (weil die Caption-Offsets sonst nicht stimmen). |
| `src/services/adminHelper/callbackHandler.js` | `sched_save_final_*` speichert `msgEntities` als `entities` jsonb-Spalte mit. Bestätigungs-Anzeige zeigt jetzt "✨ N Premium-Emojis erkannt" wenn welche im Array sind. |
| `src/services/adminHelper/tgAdminHelper.js` | **Kernstück**: Die `tgApi`-Helper (`send`, `sendPhoto`, `sendVideo`, `sendAnimation`) entfernen `parse_mode` automatisch, sobald `entities`/`caption_entities` im Aufruf enthalten sind. `fireScheduled` rekonstruiert das Array aus der DB und gibt es passend (entities vs. caption_entities) mit. Robust gegen jsonb-als-string und Malformed JSON. |
| `src/services/adminHelper/settingsHandler.js` | Schritt-1-Header weist explizit auf Premium-Emoji-Unterstützung hin. |
| `supabase/schema_v1.5.10.sql` | Neue Spalte `entities jsonb` in `scheduled_messages`. |

## Voraussetzungen für die Premium-Darstellung

1. **Bot-Owner hat aktive Telegram-Premium-Subscription.**
   - Ohne Premium werden Custom-Emojis als statische Unicode-Fallbacks
     angezeigt (das normale Emoji statt des animierten). Andere
     Formatierungen (bold/italic/links) funktionieren immer.
2. **Custom-Emoji muss für den User sichtbar sein.**
   - Telegram-Standard-Sets sind allen zugänglich.
   - Eigene Sets erfordern, dass der lesende User Zugriff hat (Bei
     Premium-Sets brauchen auch Leser eigentlich keine Premium für die
     Anzeige, nur fürs Senden).
3. **Schema-Migration ausgeführt.**

## Was funktioniert ohne Premium

Auch ohne Premium-Sub werden weiterhin korrekt übernommen:
- **fett**, *kursiv*, ~~durchgestrichen~~, ||spoilers||
- `code` und Code-Blöcke
- Hyperlinks (`text_link`)
- Mentions (`@username`, `text_mention`)
- Blockquotes
- Hashtags, URLs, E-Mails

## Installation

1. **SQL ausführen:** `supabase/schema_v1.5.10.sql`
2. **Code-Dateien ersetzen** (4 Dateien)
3. **Server neu starten.**

Vorhandene Schedules bleiben funktionsfähig — bei ihnen ist
`entities = NULL`, der Sende-Pfad fällt automatisch auf den alten
HTML-Modus zurück.

## Tests, die ich gefahren habe

| Test | Status |
|---|---|
| Wizard erfasst `entities` aus eingehender Nachricht | ✓ |
| Wizard erfasst `caption_entities` bei Foto+Caption (überschreibt Step-1-Text) | ✓ |
| `tgApi.send` ohne entities → `parse_mode: HTML` gesetzt | ✓ |
| `tgApi.send` mit entities → `parse_mode` weggelassen | ✓ |
| `tgApi.sendPhoto` mit `caption_entities` → korrekt versendet | ✓ |
| `fireScheduled` Plain Text → `parse_mode: HTML`, kein entities | ✓ |
| `fireScheduled` Text mit Custom-Emoji → entities, kein parse_mode | ✓ |
| `fireScheduled` Foto mit Custom-Emoji → caption_entities, kein parse_mode | ✓ |
| `fireScheduled` Video mit Custom-Emoji → sendVideo + caption_entities | ✓ |
| `fireScheduled` jsonb-als-String wird auto-geparst | ✓ |
| `fireScheduled` Inline-Buttons + entities zusammen | ✓ |
| `fireScheduled` Malformed entities → Fallback auf Plain Text | ✓ |
| `fireScheduled` leeres `[]` → wie ohne entities | ✓ |
| Syntax-Check aller Dateien | ✓ |

## Manueller Test

1. Stelle sicher, dass dein Telegram-Account, dem `@AdminHelper_Bot`
   gehört, **Telegram Premium** hat.
2. SQL-Migration einspielen, Code deployen, Server starten.
3. Im Settings-Menü: Wiederholungen → ➕ Neue Nachricht.
4. Im Schritt 1/6: Tippe einen Text und füge ein paar **animierte
   Premium-Emojis** ein (z.B. aus dem Standard-Set "Animierte Smileys").
5. Wizard zu Ende klicken (Sofort senden, einmalig, keine Buttons).
6. Beim Speichern erscheint im Bestätigungs-Dialog:
   `✨ 3 Premium-Emojis erkannt`
7. Beim nächsten Senden im Channel sind die Emojis **animiert** zu
   sehen — exakt wie beim Tippen.

## Was NICHT geändert wurde (bewusst)

**Welcome- und Goodbye-Nachrichten** verwenden Premium-Emojis aktuell
nicht. Grund: Diese Texte werden mit Platzhaltern (`{name}`,
`{member_count}`) substituiert. Die Substitution würde die Offsets der
gespeicherten entities verschieben und alle custom-emojis falsch
positioniert. Eine korrekte Lösung müsste die Offsets bei jeder
Substitution neu berechnen — das ist möglich, aber außerhalb des
Scopes dieses Updates.

Workaround: Pure-Emoji-Welcome-Nachrichten ohne Platzhalter würden
funktionieren, aber das müsste man dann gezielt einbauen.


---


## Was ist neu

### 1) `/donate` öffnet jetzt das passende Menü

Wenn ein User `/donate` ausführt, prüft der Bot, ob der Channel bereits
ein laufendes Paket besitzt:

- **Channel hat laufendes Paket** → Refill-Liste. Eine Spende stockt die
  Credits auf, ohne die Laufzeit zurückzusetzen.
- **Channel hat kein laufendes Paket** → Paket-Liste wie bisher. Eine
  Spende aktiviert ein Paket für 30 Tage.

Die Entscheidung trifft `hasActivePackage(channel)`:
- `bot_channels.token_limit > 0` UND
- `bot_channels.credits_expire_at` in der Zukunft (oder NULL = endlos)
  UND `is_active !== false`

Wichtig: Wenn das Credit-Budget aufgebraucht ist, aber die Laufzeit noch
gilt, läuft trotzdem der Refill-Modus — der Owner soll Refills draufladen
können statt ein neues Paket aktivieren zu müssen.

Refill-Spenden werden in `channel_purchases.meta` als
`{type: "refill", source: "donation", donor_user_id}` markiert.

### 2) Slash-Command-Sichtbarkeit angepasst

`/unmute` und `/unban` sind aus den **Group-Slash-Commands** entfernt —
sie werden in der Auto-Vervollständigung nicht mehr angeboten, weil sie
ohnehin nur für Admins funktionieren. Die Befehle selbst arbeiten
weiterhin, wenn ein Admin sie tippt.

`/help` ist neu in der **Private-Chat-Slash-Commands** registriert.

### 3) `/help` mit unterschiedlichen Antworten

- **Im Privatchat** (Admin spricht mit dem Bot): vollständige
  Befehlsreferenz mit allen Admin-Tools (Verwaltung, Moderation,
  Recherche).
- **In der Gruppe**:
  - Admin → bestehender Pfad: Schnellverwaltungsmenü als DM.
  - Normaler User → Übersicht der für ihn verfügbaren Befehle.
    Frisch ergänzt: `/donate` als erster Eintrag.

### 4) `/ban` und `/mute` mit @user/ID/Reply und Begründung

Beide Befehle akzeptieren jetzt drei Aufruf-Varianten:

```
/ban  @username  [Grund]
/ban  USER_ID    [Grund]
/ban  (als Reply auf eine Nachricht)  [Grund]

/mute @username  [Dauer]  [Grund]
/mute USER_ID    [Dauer]  [Grund]
/mute (Reply)    [Dauer]  [Grund]
```

Dauer-Formate für `/mute`: `30s`, `5m`, `2h`, `1d`, `permanent`.

Die öffentliche Bestätigung in der Gruppe enthält jetzt den Grund und den
Namen des handelnden Admins, z.B.:

> 🚫 @max wurde gebannt.
> **Grund:** Mehrfaches Spammen
> *Aktion durch @adminuser*

Wenn kein Grund angegeben wird: "Kein Grund angegeben".

`/ban` legt zusätzlich einen Eintrag in `channel_banned_users` an, damit
spätere Beitritts-Anfragen blockiert werden.

### 5) Inline-Buttons unter wiederholenden Nachrichten

Der Schedule-Wizard ist von 5 auf 6 Schritte erweitert. **Schritt 6/6**
fragt nach optionalen Inline-Buttons im Format:

```
Button-Name, https://example.com
[Discord], [https://discord.gg/abc]
🌐 Webseite, https://example.com
```

Eine Zeile = ein Button = eine eigene Tastatur-Zeile. Eckige Klammern
werden toleriert (entsprechend der Vorlage). Maximal 8 Buttons. Erlaubt
sind `https://` und `tg://` URLs.

Beim Versenden der Nachricht (über `fireScheduled`) werden die Buttons
als `reply_markup.inline_keyboard` mitgesendet — funktioniert sowohl bei
reinen Textnachrichten als auch bei Foto/GIF/Video-Posts.

**Schema:**
```sql
ALTER TABLE scheduled_messages
ADD COLUMN IF NOT EXISTS inline_buttons jsonb DEFAULT NULL;
```

### 6) Welcome- und Goodbye-Nachrichten: erweiterte Platzhalter

Beim Bearbeiten der Welcome-/Goodbye-Nachricht zeigt der Bot jetzt im
Header alle verfügbaren Variablen an. Neu unterstützt:

| Platzhalter      | Beispiel                  |
|------------------|---------------------------|
| `{name}`         | Vorname **fett**          |
| `{first_name}`   | Vorname (ohne Markup)     |
| `{last_name}`    | Nachname                  |
| `{username}`     | `@max` (oder leer)        |
| `{user_id}`      | `123456789`               |
| `{chat_title}`   | "Mein Kanal"              |
| `{chat}`         | Chat-ID (wie bisher)      |
| `{member_count}` | aktuelle Mitgliederzahl   |
| `{time}`         | `14:32`                   |
| `{date}`         | `03.05.2026`              |

Beispiel-Template:
> `Willkommen {name}! Du bist Mitglied #{member_count} – schön dass du um {time} dabei bist. 🎉`

User-eingegebene Werte werden HTML-escaped, damit Namen mit
Sonderzeichen/Tags die Nachricht nicht zerschießen können.

## Geänderte Dateien

- `src/services/adminHelper/commandHandler.js`
  - `hasActivePackage()` und `sendDonationOptions()` als Helfer
  - `/donate` und `/start donate_*` benutzen die neue Logik
  - `/help` im Privatchat eigenständig (nicht mehr im "Sammel-Match")
  - `/help` in Gruppe für User mit `/donate` ergänzt
  - `/ban` und `/mute` komplett überarbeitet (Resolver + Grund)
- `src/services/adminHelper/callbackHandler.js`
  - neuer Handler `donate_refill_*`
  - `sched_save_final_*` speichert jetzt `inline_buttons`
- `src/services/adminHelper/inputWizardHandler.js`
  - neuer Schritt `sched_wizard_buttons` (Schritt 6/6)
  - Helper `_sendButtonsPrompt` und `_parseInlineButtonsSpec`
- `src/services/adminHelper/tgAdminHelper.js`
  - `fireScheduled` rekonstruiert und sendet `inline_buttons`
  - `_renderTemplate()` mit erweiterten Platzhaltern
  - `sendWelcome`/`sendGoodbye` nutzen den neuen Renderer
- `src/services/adminHelper/settingsHandler.js`
  - Welcome/Goodbye-Editor zeigt Variablen-Liste im Header
- `src/services/packageService.js`
  - `generateRefillUrl(refill, channelId, { donorUserId })`
- `src/server.js`
  - Slash-Command-Listen angepasst
- `supabase/schema_v1.5.9.sql` (NEU) — `inline_buttons` Spalte

## Installation

1. **SQL ausführen:** `supabase/schema_v1.5.9.sql` (eine ALTER TABLE)
2. **Code-Dateien ersetzen** (8 Dateien)
3. **Server neu starten.**

Die Slash-Command-Listen werden beim Start automatisch beim Telegram-API
neu registriert (siehe `setAutoCommands` in `server.js`).

## Tests

| Bereich | Tests | Status |
|---|---|---|
| `hasActivePackage` | 8 Szenarien | 8/8 ✓ |
| Donate-Modi | 4 Szenarien (Refill, Paket, leere Listen) | 4/4 ✓ |
| Inline-Button-Parser | 17 Eingaben (positiv, negativ, Edge-Cases) | 17/17 ✓ |
| Template-Renderer | 9 Szenarien (XSS, Fallbacks, mehrfache Platzhalter) | 9/9 ✓ |
| `/ban` und `/mute` Regex | 16 Eingabe-Varianten | alle korrekt |
| `inline_buttons` Roundtrip | jsonb als Object und String, null/undefined | alle korrekt |
| Syntax-Check aller Dateien | 10 Dateien | 10/10 OK |

## Manuelle Test-Szenarien

**Test 1 — Donate (Refill):**
1. Channel kaufen sodass `token_limit > 0`.
2. In Gruppe `/donate` als Nicht-Admin schreiben.
3. Erwartung: PN mit Überschrift "Refill für …", Buttons aus
   `channel_refills`.

**Test 2 — Donate (Paket):**
1. Frisch hinzugefügter Channel, kein Paket gekauft.
2. `/donate` in Gruppe.
3. Erwartung: PN mit Überschrift "Credit-Paket für …", Buttons aus
   `channel_packages`.

**Test 3 — `/ban` mit Username:**
1. Als Admin: `/ban @max Spam und Werbung`
2. Erwartung in Gruppe:
   > 🚫 @max wurde gebannt.
   > **Grund:** Spam und Werbung
   > *Aktion durch @adminuser*

**Test 4 — `/mute` mit Dauer:**
1. Als Admin: `/mute @max 2h Bitte erst lesen, dann posten`
2. Erwartung: User für 2h gemutet, Bestätigung mit Grund öffentlich.

**Test 5 — Inline-Buttons:**
1. Im Settings-Menü: Wiederholungen → Neue Nachricht.
2. Wizard durchklicken bis Schritt 6/6.
3. Eingabe:
   ```
   📢 Channel beitreten, https://t.me/example
   🌐 Webseite, https://example.com
   ```
4. Speichern. Beim nächsten Senden erscheinen die zwei Buttons unter
   der Nachricht.

**Test 6 — Welcome-Variable:**
1. Settings → Channel-Einstellungen → 👋 Willkommen.
2. Im Header sieht der Admin die komplette Variablenliste.
3. Eingabe: `Hi {name}! Du bist Mitglied #{member_count} um {time}.`
4. Neuer Beitritt → Test-Welcome wird mit eingesetzten Werten gepostet.


---

# Update 1.5.40

## Was ist neu

### 1) Befehle für Channel-Admins: `/unmute` und `/unban`

Beide Befehle akzeptieren drei Eingabeformen:
- **Username:** `/unmute @baddy` oder `/unmute baddy` (mit oder ohne `@`)
- **User-ID:** `/unmute 123456789`
- **Reply:** Auf eine beliebige Nachricht des Users mit `/unmute` antworten

`/unban` funktioniert genauso. Der bestehende `/unban`-Befehl ist
robuster geworden — bisher nahm er nur eine ID, jetzt versteht er
auch `@usernames` und löst sie über die `channel_members`-Tabelle auf.

Falls der User nicht gefunden wird, gibt der Bot eine klare Fehlermeldung
in der Channel-Sprache aus. Befehle dürfen nur Gruppen-Admins ausführen.
Beide Befehle sind in der Telegram-Slashcommand-Liste registriert.

### 2) Undo-Buttons im Admin-DM

Wenn die Blacklist eingreift, bekommt der Channel-Owner wie bisher eine
private Benachrichtigung. **Neu**: unter dem Bericht stehen jetzt
Schnell-Buttons, die die Konsequenzen rückgängig machen, ohne dass der
Admin Befehle tippen muss.

| Konfiguration | Buttons im Admin-DM |
|---|---|
| `delete` | _(keine — nichts rückgängig zu machen)_ |
| `delete + mute` | 🔊 Stummschalten aufheben |
| `delete + ban` | 🔓 Entbannen |
| `delete + mute + ban` | 🔓 Entbannen & Stumm aufheben |

Beim Klick:
- Die Aktion wird sofort durchgeführt.
- Die Original-DM-Nachricht wird mit einer Inline-Bestätigung markiert
  (`✅ Entbannt erledigt von @admin.`) und die Buttons verschwinden,
  damit nicht doppelt geklickt werden kann.
- In der Gruppe selbst erscheint eine 15-Sekunden-Bestätigung.

Die Berechtigung für die Undo-Buttons ist auf den Channel-Owner
(`bot_channels.added_by_user_id`) eingeschränkt — sie funktionieren also
auch dann sicher, wenn die DM-Nachricht weitergeleitet wird.

### 3) Button-Audit: Alle Click-Pfade verifiziert

Komplette Inventur aller im Code erzeugten `callback_data`-Werte gegen
ihre Handler im `callbackHandler`, `settingsHandler` und
`tgAdminHelper`. Ergebnis:

- 53 unterschiedliche callback_data-Präfixe inventarisiert
- Alle Präfixe haben einen passenden Handler
- Keine Toten Buttons gefunden
- Routing-Kette: `callbackHandler.handle()` → Spezial-Handler → bei
  `cfg_*` Fall-through an `settingsHandler.handleSettingsCallback()`,
  bei `admin_*` an `tgAdminHelper.handleCallback()`

Bug-Fix beim Anlass: Im bisherigen `cfg_unban_<userId>_<channelId>`
Pfad wurden Channel-IDs mit `-` korrekt erkannt, aber der Test war
fehleranfällig — funktioniert jetzt verifiziert für beliebige
negative Channel-IDs.

## Geänderte Dateien

- `src/services/i18n.js` — 11 neue T_DE-Keys für die neuen Texte
- `src/services/adminHelper/blacklistService.js` — neue Funktionen
  `resolveUserRef`, `unmuteUser`, `unbanUser`; Admin-DM erweitert um
  Undo-Buttons mit Tracking welche Aktionen tatsächlich durchgeführt
  wurden
- `src/services/adminHelper/commandHandler.js` — `/unmute` neu,
  `/unban` aufgewertet (Username-Resolver, mehrsprachig)
- `src/services/adminHelper/callbackHandler.js` — Handler für
  `bl_unmute_*` / `bl_unban_*` / `bl_unbanmute_*` direkt nach `cfg_noop`
- `src/server.js` — `/unmute` und `/unban` in der Slashcommand-Liste
  für Gruppen registriert

## Installation

1. **Kein neues SQL nötig.**
2. Code-Dateien ersetzen.
3. Server neu starten.
   - Beim ersten Start werden ~88 zusätzliche Übersetzungen erzeugt
     (11 neue Keys × 8 Sprachen, im Hintergrund).

## Wie testen

**Test 1 — `/unmute` per Username:**
1. User in der Gruppe stummschalten (z.B. via Blacklist-Wort).
2. Als Admin in die Gruppe schreiben: `/unmute @baddy`.
3. Erwartung: Bestätigung "🔊 @baddy kann wieder schreiben." erscheint
   für 15 Sekunden.

**Test 2 — `/unban` per Reply:**
1. User mit `/ban` (Reply) bannen oder über Blacklist banlassen.
2. Als Admin in die Gruppe `/unban USER_ID` senden.
3. Erwartung: Bestätigung erscheint, der User-Eintrag verschwindet aus
   `channel_banned_users`.

**Test 3 — Undo-Buttons im DM:**
1. Blacklist-Konsequenzen auf `delete + mute + ban` setzen.
2. Als Nicht-Admin ein Blacklist-Wort posten.
3. In der DM mit dem AdminHelper-Bot erscheint die Benachrichtigung
   _mit_ einem Button "🔓 Entbannen & Stumm aufheben".
4. Klick auf den Button: Aktion läuft, DM-Text bekommt
   "✅ … erledigt von @admin." angehängt, Buttons verschwinden, in der
   Gruppe erscheint kurz die Bestätigung.

**Test 4 — Berechtigung:**
1. Einen anderen User die DM-Nachricht weiterleiten lassen und auf den
   Undo-Button klicken.
2. Erwartung: Pop-up "❌ Keine Berechtigung." — der Klick wird ignoriert.


---

# Update 1.5.39

## Was ist neu

### Blacklist-Konsequenzen werden jetzt tatsächlich durchgesetzt
Die Konfiguration der Blacklist (Wörter, Konsequenzen `delete` / `mute` /
`ban`, Toleriert-Liste mit Auto-Delete) war schon vorhanden — der Aufruf-
Hook im AdminHelper-Bot hat aber gefehlt. Jetzt:

1. **`smalltalkBotRoutes.js`** ruft `blacklistService.checkBlacklist()`
   für jede Gruppen-/Supergruppen-Nachricht auf — vor dem regulären
   Command-Processing. Wenn `delete` als Konsequenz greift, wird die
   weitere Verarbeitung abgebrochen, damit das Wort nicht noch im
   Smalltalk-Kontext landet.

2. **`blacklistService.js`** hat einen kompletten Redesign bekommen:
   - **`parseDuration()`** ist jetzt verfügbar (war im `commandHandler`
     referenziert, aber nicht implementiert) — versteht `30s`, `5m`,
     `2h`, `1d`, `permanent`/`perm`/`forever`.
   - **Default-Konsequenz `delete`**, falls der Admin keine Konsequenzen
     ausgewählt hat. Vorher tat die Hard-Liste in dem Fall nichts.
   - **Mehrsprachige Texte**: Warnung im Channel und Admin-DM kommen aus
     dem zentralen i18n-Tool und sprechen die Channel-Sprache
     (`bot_language`).
   - **Voller Mute**: Schaltet jetzt alle Sende-Permissions stumm
     (Fotos, Videos, Voice, Sticker etc.), nicht nur Text.
   - **Robust**: Skip bei Bots, Skip bei Channel-Posts mit `sender_chat`,
     Skip bei Telegram-Service-User (777000), Admin-Skip ist effizient
     (nur bei Wort-Treffer wird `getChatMember` aufgerufen).
   - **Vollständiges Logging**: Jeder Hit landet in `blacklist_hits`
     (auch Admin-Skips als `skipped_admin`), bei Fehlern wird gewarnt
     statt stillzuschweigen.
   - **Detaillierter Admin-DM**: Der Channel-Owner bekommt eine private
     Nachricht mit Channel, User, Wort, durchgeführten Aktionen und
     dem Original-Text-Anfang.

3. **`i18n.js`** hat sechs neue T_DE-Schlüssel:
   `bl_warn_msg`, `bl_action_deleted`, `bl_action_muted`,
   `bl_action_banned`, `bl_action_none`, `bl_admin_alert`.
   Diese werden beim Server-Start via DeepSeek in alle anderen Sprachen
   übersetzt und in `translation_cache` gespeichert.

## Hinweise zur Mute-Dauer

Die Stummschaltung ist auf **12 Stunden** fixiert (Konstante
`MUTE_HOURS_DEFAULT` in `blacklistService.js`). Das passt zur bestehenden
Settings-Beschriftung „User stummschalten (12h)". Wer das später
konfigurierbar machen will: einfach ein Feld `bl_mute_hours` zur Tabelle
`bot_channels` ergänzen und die Konstante durch `ch?.bl_mute_hours ?? 12`
ersetzen.

## Installation

1. **Kein neues SQL nötig** — die bestehenden Felder
   `bl_hard_consequences` und `bl_soft_delete_hours` aus 1.5.7 reichen.
2. **Code-Dateien ersetzen:**
   - `src/services/i18n.js`
   - `src/services/adminHelper/blacklistService.js`
   - `src/routes/smalltalkBotRoutes.js`
3. **Server neu starten.** Beim ersten Start werden für die 6 neuen
   T_DE-Keys × 7 Sprachen = 42 zusätzliche Übersetzungen erzeugt
   (nimmt ca. 5-10 Sekunden, läuft im Hintergrund).

## Wie testen

1. Im Admin-Helper-Menü unter `🔒 Moderation → 🚫 Blacklist`:
   - Ein Wort zur **Harten Liste** hinzufügen (z.B. `testword`).
   - Unter `⚙️ Konsequenzen einstellen → 🔴 Harte Liste konfigurieren`
     mindestens `🗑 Nachricht löschen` aktivieren.
2. In der Gruppe als Nicht-Admin `testword` schreiben.
3. Erwartung:
   - Nachricht wird gelöscht
   - Im Channel erscheint kurz "⚠️ Blacklist Wort erkannt!" (5s)
   - Der Channel-Owner bekommt einen DM mit Details
   - Eintrag in `blacklist_hits` ist sichtbar in Supabase

Wenn `mute` zusätzlich aktiv ist, wird der User für 12h stummgeschaltet.
Wenn `ban` aktiv ist, wird er gebannt und in `channel_banned_users`
eingetragen.
