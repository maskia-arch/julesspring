/**
 * sellauthService.js v1.1.9
 *
 * Fixes:
 * - Breite Bereinigung: löscht ALLE alten Sellauth-Einträge unabhängig vom source-Namen
 * - URL: {shopUrl}/product/{path} ✅
 * - Stock: -1 und null = unbegrenzt vorrätig ✅
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const deepseekService = require('./deepseekService');
const logger  = require('../utils/logger');

const SELLAUTH_API = 'https://api.sellauth.com/v1';

const sellauthService = {

  _client(apiKey) {
    return axios.create({
      baseURL: SELLAUTH_API, timeout: 20000,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
  },

  async getShopInfo(apiKey, shopId) {
    const { data } = await this._client(apiKey).get(`/shops/${shopId}`);
    return data;
  },

  async getAllProducts(apiKey, shopId) {
    const client = this._client(apiKey);
    const all = [];
    let page = 1, lastPage = 1;
    do {
      const { data } = await client.get(`/shops/${shopId}/products`, {
        params: { page, perPage: 100, orderColumn: 'name', orderDirection: 'asc' }
      });
      all.push(...(data.data || []));
      lastPage = data.last_page || 1;
      page++;
    } while (page <= lastPage);
    return all;
  },

  async getCategories(apiKey, shopId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/categories`, { params: { perPage: 100 } });
      return data.data || [];
    } catch { return []; }
  },

  // ── URL: {shopUrl}/product/{path} ─────────────────────────────────────────
  buildProductUrl(shopUrl, productPath) {
    return `${shopUrl.replace(/\/$/, '')}/product/${productPath}`;
  },

  // ── Stock Logik: -1 und null = unbegrenzt ─────────────────────────────────
  _stockInfo(stockValue) {
    if (stockValue === null || stockValue === -1) {
      return { inStock: true, display: 'Unbegrenzt vorrätig' };
    }
    if (stockValue > 0) {
      return { inStock: true, display: `${stockValue} auf Lager` };
    }
    return { inStock: false, display: 'Ausverkauft' };
  },

  // ── Format: eine Variante ─────────────────────────────────────────────────
  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const { inStock, display: stockDisplay } = this._stockInfo(variant.stock);

    const lines = [
      `Produkt: ${product.name}`,
      `Option/Variante: ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];

    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 500)}`);
    }

    lines.push('');
    lines.push(`Empfehlung für Kunden: "${variant.name}" von "${product.name}"`);
    if (price) lines.push(`Preis: ${price}`);
    lines.push(`→ Kauflink: ${productUrl}`);

    return lines.filter(l => l !== undefined && l !== null && l !== '').join('\n');
  },

  // ── Format: Einzelprodukt ─────────────────────────────────────────────────
  formatSingleProductKnowledge(product, productUrl, categoryName) {
    const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(product.stock_count);

    const lines = [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];
    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 500)}`);
    }
    lines.push('');
    lines.push(`→ Kauflink: ${productUrl}`);
    return lines.filter(Boolean).join('\n');
  },

  // ── Format: Übersicht aller Varianten ────────────────────────────────────
  formatOverviewKnowledge(product, productUrl, categoryName) {
    const variantLines = (product.variants || []).map(v => {
      const price = v.price ? `${v.price} ${product.currency || 'EUR'}` : '?';
      const { display: stockNote } = this._stockInfo(v.stock);
      return `  • ${v.name}: ${price} (${stockNote})`;
    }).join('\n');

    return [
      `Produkt-Übersicht: ${product.name}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      `Kauflink (Variante auf der Seite wählen): ${productUrl}`,
      '',
      'Verfügbare Optionen:',
      variantLines,
      '',
      `Kunden können auf ${productUrl} die gewünschte Option auswählen und kaufen.`
    ].filter(Boolean).join('\n');
  },

  // ── Hauptfunktion: Sync ──────────────────────────────────────────────────
  async syncToKnowledgeBase(apiKey, shopId, shopUrl) {
    const results = { total: 0, saved: 0, skipped: 0, errors: [], deleted: 0 };

    const [products, categories] = await Promise.all([
      this.getAllProducts(apiKey, shopId),
      this.getCategories(apiKey, shopId)
    ]);

    results.total = products.length;
    logger.info(`[Sellauth] ${products.length} Produkte von API geladen`);

    // ── BEREINIGUNG: ALLE alten Sellauth-Einträge löschen ───────────────────
    // Löscht alle Einträge die jemals von Sellauth importiert wurden,
    // unabhängig vom exakten source-Namen (alte Versionen nutzten verschiedene Namen)
    const cleanupSources = ['sellauth_sync', 'sellauth', 'sellauth_import'];
    for (const src of cleanupSources) {
      const { count, error } = await supabase.from('knowledge_base')
        .delete()
        .eq('source', src)
        .select('*', { count: 'exact', head: true });
      if (!error && count) {
        results.deleted += count;
        logger.info(`[Sellauth] Bereinigt: ${count} alte Einträge (source="${src}")`);
      }
    }

    // Kategorie-ID für Sellauth-Import
    let categoryId = null;
    try {
      const { data: kbCat } = await supabase.from('knowledge_categories').select('id').eq('name', 'Sellauth Import').single();
      categoryId = kbCat?.id || null;
    } catch {}

    // ── Produkte verarbeiten ───────────────────────────────────────────────
    for (const product of products) {
      if (product.visibility === 'hidden') { results.skipped++; continue; }

      const cat        = categories.find(c => c.id === product.category_id);
      const catName    = cat?.name || null;
      const productUrl = this.buildProductUrl(shopUrl, product.path);

      logger.info(`[Sellauth] Verarbeite: ${product.name} → ${productUrl}`);

      try {
        if (product.type === 'variant' && product.variants?.length) {
          // Je Variante ein eigener Eintrag
          for (const variant of product.variants) {
            const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
            const embedding = await deepseekService.generateEmbedding(content);
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title:       `${product.name} – ${variant.name}`,
              source:      'sellauth_sync',
              category_id: categoryId,
              metadata: {
                product_id:  product.id,
                variant_id:  variant.id,
                product_url: productUrl,
                price:       variant.price,
                currency:    product.currency,
                stock:       variant.stock,
                type:        'variant'
              }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 200));
          }

          // Übersichts-Eintrag
          const overview  = this.formatOverviewKnowledge(product, productUrl, catName);
          const embOver   = await deepseekService.generateEmbedding(overview);
          await supabase.from('knowledge_base').insert([{
            content: overview, embedding: embOver,
            title:       `${product.name} (alle Optionen)`,
            source:      'sellauth_sync',
            category_id: categoryId,
            metadata:    { product_id: product.id, product_url: productUrl, type: 'overview' }
          }]);
          await new Promise(r => setTimeout(r, 200));

        } else {
          const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
          const embedding = await deepseekService.generateEmbedding(content);
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title:       product.name,
            source:      'sellauth_sync',
            category_id: categoryId,
            metadata:    { product_id: product.id, product_url: productUrl, price: product.price, currency: product.currency, type: 'single' }
          }]);
          results.saved++;
          await new Promise(r => setTimeout(r, 200));
        }

        logger.info(`[Sellauth] ✓ ${product.name}`);
      } catch (err) {
        results.errors.push(`${product.name}: ${err.message}`);
        logger.warn(`[Sellauth] ✗ ${product.name}: ${err.message}`);
      }
    }

    logger.info(`[Sellauth] Sync abgeschlossen: ${results.saved} Einträge, ${results.deleted} alte gelöscht`);
    return results;
  },

  async testConnection(apiKey, shopId) {
    try {
      const shop = await this.getShopInfo(apiKey, shopId);
      return { ok: true, shopName: shop.name || shop.slug || shopId };
    } catch (err) {
      return { ok: false, error: err.response?.data?.message || err.message };
    }
  }
};

module.exports = sellauthService;
