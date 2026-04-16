/**
 * channelKnowledgeEnricher.js  v1.4.3
 *
 * AI-gestützter Wissensverwalter für Channel-spezifische Smalltalk-KBs.
 * OpenAI orchestriert vollständig: kategorisiert, strukturiert, erstellt
 * neue Kategorien wenn nötig, bereinigt Duplikate.
 *
 * Isoliert vom Berater – keinerlei Auswirkung auf knowledge_base Tabelle.
 */

const axios    = require("axios");
const supabase = require("../../config/supabase");
const logger   = require("../../utils/logger");

const channelKnowledgeEnricher = {

  // ── Eintrag zur Channel-KB hinzufügen (OpenAI orchestriert) ─────────────
  async addEntry(channelId, rawContent, source = "manual") {
    const entries = await this._orchestrate(channelId, rawContent, source);
    const saved   = [];

    for (const e of entries) {
      try {
        const embedding = await this._embed(e.content);

        const { data } = await supabase.from("channel_knowledge").insert([{
          channel_id: channelId,
          category:   e.category  || "allgemein",
          title:      e.title     || null,
          content:    e.content,
          embedding,
          source,
          metadata:   { enriched: true, originalLength: rawContent.length }
        }]).select("id, category, title").single();

        if (data) saved.push(data);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        logger.warn(`[ChannelKB] Insert fehlgeschlagen: ${e.message}`);
      }
    }

    // Zähler aktualisieren
    const { count } = await supabase.from("channel_knowledge")
      .select("id", { count: "exact", head: true }).eq("channel_id", channelId);
    await supabase.from("bot_channels")
      .update({ kb_entry_count: count || 0, updated_at: new Date() }).eq("id", channelId);

    logger.info(`[ChannelKB] Channel ${channelId}: ${saved.length} Einträge hinzugefügt`);
    return saved;
  },

  // ── Alle Einträge eines Channels laden ───────────────────────────────────
  async getEntries(channelId) {
    const { data } = await supabase.from("channel_knowledge")
      .select("id, category, title, content, source, created_at")
      .eq("channel_id", channelId)
      .order("category").order("created_at", { ascending: false });
    return data || [];
  },

  // ── Eintrag löschen ───────────────────────────────────────────────────────
  async deleteEntry(channelId, entryId) {
    await supabase.from("channel_knowledge")
      .delete().eq("id", entryId).eq("channel_id", channelId);
    const { count } = await supabase.from("channel_knowledge")
      .select("id", { count: "exact", head: true }).eq("channel_id", channelId);
    await supabase.from("bot_channels")
      .update({ kb_entry_count: count || 0 }).eq("id", channelId);
  },

  // ── Semantic Search für Smalltalk-Agent ──────────────────────────────────
  async search(channelId, text, threshold = 0.50, limit = 4) {
    try {
      const embedding = await this._embed(text);
      const { data } = await supabase.rpc("match_channel_knowledge", {
        p_channel_id: channelId,
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit
      });
      return (data || []).map(d => d.content);
    } catch { return []; }
  },

  // ── OpenAI Orchestrierung ─────────────────────────────────────────────────
  async _orchestrate(channelId, rawContent, source) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // Fallback ohne OpenAI: direkt speichern
      return [{ content: rawContent, category: "allgemein", title: null }];
    }

    // Bestehende Kategorien laden
    const { data: existing } = await supabase.from("channel_knowledge")
      .select("category").eq("channel_id", channelId);
    const existingCats = [...new Set((existing || []).map(e => e.category))];
    const catList = existingCats.length ? existingCats.join(", ") : "keine (erste Einträge)";

    const prompt = `Du bist ein Wissensmanager für einen Telegram-Bot-Channel.
Analysiere den folgenden Inhalt und erstelle strukturierte Wissenseinträge.

Bestehende Kategorien in dieser Channel-KB: ${catList}

INHALT (Quelle: ${source}):
${rawContent.substring(0, 2000)}

AUFGABE:
- Erstelle 1-3 prägnante Wissenseinträge als JSON-Array
- Nutze bestehende Kategorien WENN passend, erstelle neue wenn nötig
- Titel: max 60 Zeichen, aussagekräftig
- Content: faktentreu, vollständig, suchoptimiert
- Kategorie: kurz, lowercase (z.B. "begrüßung", "produkte", "faq", "persönlichkeit")
- NIEMALS Fakten verändern oder erfinden

Format (nur JSON, kein Markdown):
[{"category":"...","title":"...","content":"..."}]`;

    try {
      const resp = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          max_tokens: 800,
          temperature: 0.1,
          messages: [
            { role: "system", content: "Erstelle präzise, faktentreue Wissensbank-Einträge für einen AI-Assistenten. Erfinde NIEMALS Fakten." },
            { role: "user",   content: prompt }
          ]
        },
        { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 25000 }
      );

      const raw   = resp.data.choices[0].message.content.trim();
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      logger.warn(`[ChannelKB] OpenAI fehlgeschlagen: ${e.message} – Fallback`);
    }

    return [{ content: rawContent, category: "allgemein", title: null }];
  },

  // ── Embedding ──────────────────────────────────────────────────────────────
  async _embed(text) {
    try {
      const embService = require("../embeddingService");
      const result = await embService.generateEmbedding(text);
      return result.embedding || result;
    } catch { return null; }
  }
};

module.exports = channelKnowledgeEnricher;
