
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
