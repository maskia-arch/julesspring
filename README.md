# 🤖 AI Assistant Platform — v1.4.1

Eine vollständige KI-Kundensupport-Plattform auf Basis von **DeepSeek**, integriert mit **Telegram**, einem **Web-Widget** und einer automatisierten **Wissensdatenbank (RAG)**. Inklusive eines separaten **TG Admin-Helper-Bots** für Gruppen-/Channel-Verwaltung.

---

## 🚀 Features

### 🤖 Berater-Bot (Telegram + Widget)
- **KI-Chat**: Intelligente Antworten durch DeepSeek API (V3/R1)
- **RAG Wissensdatenbank**: Webseiten-Scraping + Sellauth-Produktsync
- **Halluzinations-Schutz**: Erfindet keine Produkte oder Links
- **Hybrid-Modus**: Wechsel zwischen KI- und manuellem Betrieb
- **Clarity-Erkennung**: Unklare KI-Antworten werden automatisch als Wissenslücke eingetragen

### 💬 TG Admin-Helper-Bot (v1.4 — neu)
- **Separater Bot-Token**: Eigene Persönlichkeit, vollständig unabhängig vom Berater
- **Kostenlose Admin-Tools** (ohne AI-Aktivierung):
  - 🧹 Gelöschte Accounts aus Gruppen entfernen
  - 👋 Willkommens- und Abschiedsnachrichten
  - ⏰ Geplante Nachrichten mit optionalem Foto (Cron-Unterstützung)
  - 📌 Nachrichten pinnen / löschen
  - 🛡 Safelist / Scamliste (Community-Sicherheit mit KI-Zusammenfassung)
- **KI-Features** (nach Freischaltung durch Admin):
  - Eigener System-Prompt pro Channel
  - Per-Channel isolierte Wissensdatenbank (OpenAI-orchestriert)
  - `/ai [Frage]`-Befehl für Channel-Mitglieder
  - Token/USD-Limits pro Channel

### 📊 Admin-Dashboard
- Echtzeit-Statistiken, Chat-Verläufe, Kostenübersicht
- Wissensdatenbank-Verwaltung (manuell + KI-aufbereitet)
- Coupon-System mit Wochenplan
- Channel-Verwaltung: Freischaltung, Token-Limits, KB, Safelist
- Smalltalk-Bot-Konfiguration (Token, System-Prompt, Verbindungstest)

---

## 🛠 Tech Stack

| Bereich | Technologie |
|---|---|
| Backend | Node.js, Express |
| Datenbank | Supabase (PostgreSQL + pgvector) |
| Haupt-KI | DeepSeek API (deepseek-chat / deepseek-reasoner) |
| Embeddings | OpenAI (text-embedding-3-small) |
| Logging | Winston |
| Deployment | Render.com (Free Tier) |

---

## 📋 Voraussetzungen

1. **Node.js** v18 oder höher
2. **Supabase-Projekt** (kostenloser Plan ausreichend)
3. **Render.com-Account** für das Deployment
4. **API Keys** (siehe unten)

---

## ⚙️ Installation (Neuinstallation)

### 1. Repository klonen

```bash
git clone <dein-repo-url>
cd ai-assistant-platform
npm install
```

### 2. Supabase einrichten

Öffne den **SQL Editor** in deinem Supabase-Projekt und führe aus:

```
supabase/schema_v1.4.sql
```

Das ist die einzige Datei für eine Neuinstallation. Sie erstellt alle Tabellen, Indizes, Funktionen und Standard-Daten in einem Schritt.

### 3. Environment Variables (Render.com)

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `SUPABASE_URL` | URL deines Supabase-Projekts | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key (nicht Anon Key!) | ✅ |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | ✅ |
| `OPENAI_API_KEY` | OpenAI Key (für Embeddings + KB-Aufbereitung) | ✅ |
| `TELEGRAM_BOT_TOKEN` | Berater-Bot Token von @BotFather | ✅ |
| `ADMIN_USERNAME` | Login für das Admin-Dashboard | ✅ |
| `ADMIN_PASSWORD` | Passwort für das Admin-Dashboard | ✅ |
| `JWT_SECRET` | Geheimschlüssel für JWT-Tokens | ✅ |
| `APP_URL` | Deine Render-URL (z.B. `https://app.onrender.com`) | ✅ |
| `VAPID_PUBLIC_KEY` | Web Push — öffentlicher Key | optional |
| `VAPID_PRIVATE_KEY` | Web Push — privater Key | optional |
| `SELLAUTH_API_KEY` | Sellauth API Key | optional |
| `SELLAUTH_SHOP_ID` | Sellauth Shop-ID | optional |
| `SELLAUTH_SHOP_URL` | URL deines Sellauth-Shops | optional |

### 4. Berater-Bot-Webhook setzen

Wird automatisch beim Server-Start registriert wenn `APP_URL` gesetzt ist.

### 5. Smalltalk-Bot einrichten (optional)

1. Neuen Bot via `@BotFather` erstellen → Token kopieren
2. Dashboard → Einstellungen → **💬 Smalltalk** → Token eintragen → Speichern
3. Webhook wird automatisch registriert, Status erscheint sofort
4. Bot in Gruppe/Channel als Admin hinzufügen

---

## 🔄 Update von einer älteren Version

Wenn du von einer Version **vor 1.4** aktualisierst, führe in Supabase aus:

```
supabase/schema_v1.4.sql   ← idempotent, kann sicher mehrfach ausgeführt werden
```

Falls Fehler über fehlende Spalten in `bot_channels` auftreten (z.B. `bot_type not found`), hat ein ALTER TABLE nicht gegriffen. Führe dann zusätzlich aus:
```sql
NOTIFY pgrst, 'reload schema';
```

---

## 📂 Projektstruktur

```
src/
  server.js                     – Express + KeepAlive + Scheduler
  config/
    env.js                      – Environment-Konfiguration
    supabase.js                 – Supabase-Client (Service Role Key)
  controllers/
    adminController.js          – Einstellungen, Stats, Chats, KB, Coupons
    channelController.js        – Channel-Verwaltung, Scan, KB, Safelist, Schedule
  routes/
    adminRoutes.js              – Admin-API Endpunkte
    webhookRoutes.js            – Berater-Bot Telegram Webhook
    widgetRoutes.js             – Website-Widget API
    smalltalkBotRoutes.js       – TG Admin-Helper-Bot Webhook
  services/
    messageProcessor.js         – KI-Verarbeitung, Retry-Zustellung
    deepseekService.js          – DeepSeek API (Halluzinations-Schutz)
    couponService.js            – Tages-Coupon-Rotation, Wochenplan
    sellauthService.js          – Produkt-API, Invoice, Bestseller
    knowledgeEnricher.js        – OpenAI KB-Aufbereitung (Berater)
    telegramService.js          – Telegram Bot API
    embeddingService.js         – OpenAI Embedding-Generierung
    ai/
      clarityDetector.js        – Klarheitserkennung (0 Token-Kosten)
      smalltalkAgent.js         – Smalltalk-KI mit Channel-KB
      channelKnowledgeEnricher.js – OpenAI KB-Orchestrierung pro Channel
    adminHelper/
      tgAdminHelper.js          – Telegram-Verwaltungstools
      safelistService.js        – Community-Safelist mit KI-Zusammenfassung
  public/
    index.html                  – Admin-Dashboard (PWA)
    js/
      dashboard.js              – Dashboard-Logik
      api.js                    – API-Client mit Cache
    sw.js                       – Service Worker (Web Push)
    manifest.json               – PWA-Manifest
supabase/
  schema_v1.4.sql               – Vollständiges Installations-Schema
```

---

## 🤖 Telegram-Befehle

### Berater-Bot (Privat-Chat)
| Befehl | Beschreibung |
|---|---|
| Normale Nachricht | KI-Beratung starten |
| `/start` | Willkommensnachricht |

### TG Admin-Helper-Bot (in Gruppen/Channels)
| Befehl | Wer | Beschreibung |
|---|---|---|
| `/admin` oder `/menu` | Admins | Verwaltungsmenü öffnen |
| `/settings` | Admins | Einstellungen (Hier oder Privat) |
| `/clean` | Admins | Gelöschte Accounts entfernen |
| `/pin` (Reply) | Admins | Nachricht pinnen |
| `/del` (Reply) | Admins | Nachricht löschen |
| `/safelist @user` | Alle | User als sicher melden |
| `/scamlist @user` | Alle | User als Scammer melden |
| `/check @user` | Alle | Safelist-Status prüfen |
| `/ai [Frage]` | Alle | KI-Antwort (nur wenn aktiviert) |

---

## 📈 Kostenoptimierung

Die Plattform ist auf minimale API-Kosten ausgelegt:

- **DeepSeek Prefix-Cache**: System-Prompt wird gecacht → bis zu 90% weniger Input-Token-Kosten
- **Chat-Zusammenfassung**: Alle 5 Nachrichten async zusammengefasst, max. 180 Token
- **Adaptiver RAG**: Score ≥ 0.82 → 2 Docs, ≥ 0.65 → 3 Docs, sonst max. 8
- **Smalltalk-Modus**: `deepseek-chat` (günstigstes Modell), max. 200 Token
- **Clarity-Detector**: Erkennt unklare Antworten ohne KI-Aufruf (0 Tokenkosten)

---

## 🛡 Halluzinations-Schutz

Der Berater-Bot enthält einen mehrstufigen Schutz gegen erfundene Produkte:

1. **System-Prompt-Regeln**: Explizite Verbote für das Erfinden von Produkten/Links
2. **RAG-Konfidenz-Check**: Bei niedrigem Score → Safety-Kontext wird injiziert
3. **`@autoacts`-Fallback**: Bei fehlendem Produkt → automatisch an Support verwiesen
4. **Clarity-Detector**: Erkennt thematische Fehlleitungen und erstellt Lernqueue-Einträge

---

## 📞 Support

Bei Fragen zur Einrichtung: **@autoacts** auf Telegram
