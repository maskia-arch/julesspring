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
