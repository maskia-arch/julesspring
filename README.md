# AI AdminHelper (Standalone)

Telegram-Bot fuer Gruppenadministration mit eigenem Admin-Dashboard.

## Was kann das?

- **Channel-Verwaltung**: Bot in Telegram-Gruppen einsetzen, AI fuer Smalltalk
- **Diss Battle**: Mini-Game in Gruppen (Bot moderiert)
- **Safelist / Scamliste**: Gruppen-uebergreifende Vertrauenslisten
- **@admin-Meldungen**: AI-klassifizierte Eskalation an Admins
- **Channel-Pakete**: Sellauth-Integration fuer Credit-Verkauf an Channel-Admins
- **Activity-Tracker**: Wochenrangliste der aktivsten User
- **Quiet Hours**: Automatische Nachtruhe in Gruppen
- **Scheduled Messages**: Wiederkehrende Nachrichten

## Architektur

```
AdminHelper-Render-Service ──── Supabase-DB (bestehend)
       │
       └── Telegram-Bot (smalltalk_bot_token)
```

## Erstmal-Setup

### 1. Datenbank aufraeumen
Du hast bereits eine Supabase-Datenbank mit gemischten AdminHelper- und
Berater-Tabellen. Fuehre dieses Script im Supabase-SQL-Editor aus:

```
supabase/SPLIT_cleanup_adminhelper.sql
```

Das entfernt alle Berater-Tabellen (chats, messages, knowledge_*, visitors,
coupons etc.) und Berater-Spalten aus der settings-Tabelle.

### 2. Render-Deploy

ENV-Variablen in Render setzen:

```
SUPABASE_URL=<deine bestehende Supabase-URL>
SUPABASE_SERVICE_ROLE_KEY=<bestehender Service-Role-Key>
DEEPSEEK_API_KEY=<DeepSeek-API-Key>
XAI_API_KEY=<xAI/Grok-API-Key>
OPENAI_API_KEY=<OpenAI-Key fuer Embeddings>
ADMIN_USERNAME=<Dashboard-Login>
ADMIN_PASSWORD=<Dashboard-Passwort>
JWT_SECRET=<32-Zeichen-Zufallswert>
VAPID_PUBLIC_KEY=<Web-Push Public-Key>
VAPID_PRIVATE_KEY=<Web-Push Private-Key>
APP_URL=https://dein-adminhelper.onrender.com
PORT=3000
```

Build-Command:
```
npm install
```

Start-Command:
```
node src/server.js
```

### 3. Bot konfigurieren

1. Render-Deploy startet, Dashboard ist unter `https://dein-adminhelper.onrender.com/admin` erreichbar
2. Einloggen mit ADMIN_USERNAME / ADMIN_PASSWORD
3. Settings → AdminHelper-Folder → Smalltalk → Token eintragen
4. Webhook wird automatisch beim naechsten Server-Start registriert

## Endpunkte

```
POST /api/webhooks/smalltalk      Bot-Webhook (Telegram)
POST /api/admin/login             Dashboard-Login
GET  /api/admin/channels          Liste der verwalteten Channels
GET  /api/admin/settings          Settings
POST /api/admin/settings          Settings updaten
GET  /admin                       Dashboard-UI
GET  /health                      Liveness-Check
```
