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
