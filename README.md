# 🤖 DeepSeek Business Admin Bot

Ein leistungsstarker KI-Kundensupport-Bot auf Basis von **DeepSeek**, integriert mit **Telegram**, einem **Web-Widget** und einer automatisierten **Wissensdatenbank (RAG)**. Inklusive eines modernen Admin-Dashboards zur Live-Überwachung und Steuerung.

---

## 🚀 Features

* **KI-Chat**: Intelligente Antworten durch DeepSeek API (V3/R1).
* **RAG Wissensdatenbank**: Scrape deine Webseite oder synchronisiere **Sellauth-Produkte**, um der KI spezifisches Wissen zu geben.
* **Hybrid-Modus**: Schalte im Admin-Dashboard zwischen KI-Antworten und manueller Übernahme um.
* **Multi-Platform**: Unterstützung für Telegram und ein integrierbares Web-Widget.
* **Vektorsuche**: Nutzt Supabase `pgvector` für blitzschnelle Informationssuche.
* **Dashboard**: Echtzeit-Statistiken, Chat-Verläufe und Systemeinstellungen.

---

## 🛠 Tech Stack

* **Backend**: Node.js, Express
* **Datenbank**: Supabase (PostgreSQL + pgvector)
* **KI-Modell**: DeepSeek API
* **Embeddings**: OpenAI (text-embedding-3-small)
* **Scraping**: Cheerio, Axios
* **Logging**: Winston

---

## 📋 Voraussetzungen

1.  **Node.js** (v18 oder höher)
2.  **Supabase Account**: Erstelle ein Projekt und führe `supabase/schema.sql` im SQL-Editor aus.
3.  **API Keys**:
    * DeepSeek API Key
    * Telegram Bot Token (via @BotFather)
    * OpenAI API Key (für Embeddings)
    * Sellauth API Key (optional)

---

## ⚙️ Installation & Setup

1. **Repository klonen:**
   ```bash
   git clone <dein-repo-url>
   cd deepseek-admin-bot
