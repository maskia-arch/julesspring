/**
 * sellauthService.js
 *
 * Vollständige Sellauth API-Integration.
 * API-Basis: https://api.sellauth.com/v1/shops/{shopId}/...
 * Auth: Bearer Token
 *
 * Produkt-URL Aufbau: {shopUrl}/{product.path}
 * z.B. https://meinshop.sellauth.com/esim-europa
 */

const axios = require('axios');
const supabase = require('../config/supabase');
const deepseekService = require('./deepseekService');
const logger = require('../utils/logger');

const SELLAUTH_API = 'https://api.sellauth.com/v1';

const sellauthService = {

  // ── HTTP-Client mit Auth-Header ─────────────────────────────────────────
  _client(apiKey) {
    return axios.create({
      baseURL: SELLAUTH_API,
      timeout: 20000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  },

  // ── Shop-Infos laden (Domain, Name) ────────────────────────────────────
  async getShopInfo(apiKey, shopId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}`);
      return data;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      throw new Error(`Shop-Info Fehler: ${msg}`);
    }
  },

  // ── Alle Produkte mit Varianten laden (alle Seiten) ────────────────────
  async getAllProducts(apiKey, shopId) {
    const client = this._client(apiKey);
    const allProducts = [];
    let page = 1;
    let totalPages = 1;

    do {
      const { data } = await client.get(`/shops/${shopId}/products`, {
        params: { page, perPage: 100, orderColumn: 'name', orderDirection: 'asc' }
      });

      const products = data.data || [];
      allProducts.push(...products);
      totalPages = data.last_page || 1;
      page++;
    } while (page <= totalPages);

    logger.info(`[Sellauth] ${allProducts.length} Produkte geladen (${totalPages} Seite(n))`);
    return allProducts;
  },

  // ── Einzelnes Produkt mit vollständigen Daten laden ────────────────────
  async getProduct(apiKey, shopId, productId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/products/${productId}`);
      return data;
    } catch (err) {
      return null;
    }
  },

  // ── Kategorien laden ────────────────────────────────────────────────────
  async getCategories(apiKey, shopId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/categories`, {
        params: { perPage: 100 }
      });
      return data.data || [];
    } catch (err) {
      return [];
    }
  },

  // ── Produkt-URL konstruieren ────────────────────────────────────────────
  buildProductUrl(shopUrl, productPath) {
    const base = shopUrl.replace(/\/$/, '');
    // Sellauth URL-Format: {shopUrl}/{product.path}
    return `${base}/${productPath}`;
  },

  // ── Produkt als Wissens-Text formatieren ───────────────────────────────
  formatProductKnowledge(product, shopUrl, categories = []) {
    const url = this.buildProductUrl(shopUrl, product.path);
    const category = categories.find(c => c.id === product.category_id);

    let text = `=== PRODUKT: ${product.name} ===\n`;
    text += `🔗 Link: ${url}\n`;

    if (product.type === 'single') {
      const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : 'Preis auf Anfrage';
      text += `💰 Preis: ${price}\n`;
    }

    if (product.type === 'variant' && product.variants?.length) {
      text += `\n📦 Verfügbare Varianten:\n`;
      product.variants.forEach(v => {
        const price = v.price ? `${v.price} ${product.currency || 'EUR'}` : '–';
        const stock = v.stock !== null ? `(${v.stock} verfügbar)` : '(auf Lager)';
        text += `  • ${v.name}: ${price} ${stock}\n`;
        // Direkt-Link zur Variante: Shoplink mit vorausgewählter Variante
        text += `    → Direkt bestellen: ${url}?variant=${v.id}\n`;
      });
    }

    if (product.description) {
      // HTML-Tags entfernen
      const cleanDesc = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (cleanDesc.length > 0) text += `\n📄 Beschreibung: ${cleanDesc.substring(0, 500)}\n`;
    }

    if (category) text += `\n🏷 Kategorie: ${category.name}\n`;
    if (product.stock_count !== null) text += `📊 Gesamtbestand: ${product.stock_count}\n`;

    text += `\nWenn Kunden nach diesem Produkt fragen, gib ihnen direkt den Kauflink: ${url}`;

    return text;
  },

  // ── Hauptfunktion: Sync → Wissensdatenbank ─────────────────────────────
  async syncToKnowledgeBase(apiKey, shopId, shopUrl) {
    const results = {
      total: 0,
      saved: 0,
      skipped: 0,
      errors: []
    };

    try {
      // Produkte und Kategorien parallel laden
      const [products, categories] = await Promise.all([
        this.getAllProducts(apiKey, shopId),
        this.getCategories(apiKey, shopId)
      ]);

      results.total = products.length;

      // "Sellauth Import" Kategorie-ID in knowledge_categories holen
      const { data: kbCat } = await supabase
        .from('knowledge_categories')
        .select('id')
        .eq('name', 'Sellauth Import')
        .single();

      const categoryId = kbCat?.id || null;

      // Bestehende Sellauth-Einträge löschen (Fresh Sync)
      await supabase.from('knowledge_base').delete().eq('source', 'sellauth_sync');

      // Jedes Produkt in die Wissensdatenbank schreiben
      for (const product of products) {
        // Unsichtbare Produkte überspringen
        if (product.visibility === 'hidden') {
          results.skipped++;
          continue;
        }

        try {
          const content = this.formatProductKnowledge(product, shopUrl, categories);
          const embedding = await deepseekService.generateEmbedding(content);

          await supabase.from('knowledge_base').insert([{
            content,
            embedding,
            source:      'sellauth_sync',
            title:       product.name,
            category_id: categoryId,
            metadata: {
              product_id:   product.id,
              product_path: product.path,
              product_url:  this.buildProductUrl(shopUrl, product.path),
              type:         product.type,
              currency:     product.currency,
              variants:     (product.variants || []).map(v => ({
                id:    v.id,
                name:  v.name,
                price: v.price,
                stock: v.stock
              }))
            }
          }]);

          results.saved++;
          logger.info(`[Sellauth] Produkt gespeichert: ${product.name}`);

          // Rate-Limit: kurze Pause zwischen Embedding-Aufrufen
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          results.errors.push(`${product.name}: ${err.message}`);
          logger.warn(`[Sellauth] Produkt übersprungen ${product.name}: ${err.message}`);
        }
      }

      logger.info(`[Sellauth] Sync abgeschlossen: ${results.saved}/${results.total} gespeichert`);
      return results;

    } catch (err) {
      logger.error('[Sellauth] Sync-Fehler:', err.message);
      throw err;
    }
  },

  // ── API-Verbindung testen ───────────────────────────────────────────────
  async testConnection(apiKey, shopId) {
    try {
      const shop = await this.getShopInfo(apiKey, shopId);
      return { ok: true, shopName: shop.name || shop.slug || shopId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
};

module.exports = sellauthService;
