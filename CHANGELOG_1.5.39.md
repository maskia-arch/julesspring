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
