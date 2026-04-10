/**
 * sellauthService.js v1.1.10
 *
 * Fixes:
 * - Supabase delete: .select() nach .delete() ist ungültig → entfernt
 * - Nukleäre Bereinigung: löscht ALLE Sellauth-Einträge inkl. Content-Suche
 * - URL: {shopUrl}/product/{path} ✅
 * - Stock: -1 und null = Unbegrenzt vorrätig ✅
 */

const axios    = require('axios');
const supabase = require('../config/supabase');
const deepseekService = require('./deepseekService');
const logger   = require('../utils/logger');

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

  // ── URL: /product/ Prefix ───────────────────────────────────────────────
  buildProductUrl(shopUrl, productPath) {
    return `${shopUrl.replace(/\/$/, '')}/product/${productPath}`;
  },

  // ── Stock: -1 / null = unbegrenzt ─────────────────────────────────────
  _stockInfo(stockValue) {
    if (stockValue === null || stockValue === -1 || stockValue === undefined) {
      return { inStock: true, display: 'Verfügbar' };
    }
    if (stockValue > 0) {
      return { inStock: true, display: 'Verfügbar' };
    }
    return { inStock: false, display: 'Ausverkauft' };
  },

  // ── Format: Variante ───────────────────────────────────────────────────
  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(variant.stock);

    const lines = [
      `Produkt: ${product.name}`,
      `Option: ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Status: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];

    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 400)}`);
    }

    lines.push('');
    lines.push(`Wenn ein Kunde "${variant.name}" oder "${product.name}" sucht:`);
    if (price) lines.push(`Empfehlung: ${variant.name} für ${price}`);
    lines.push(`Link: ${productUrl}`);

    return lines.filter(l => l !== null && l !== undefined && l !== '').join('\n');
  },

  // ── Format: Einzelprodukt ─────────────────────────────────────────────
  formatSingleProductKnowledge(product, productUrl, categoryName) {
    const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(product.stock_count);

    const lines = [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Status: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];
    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 400)}`);
    }
    lines.push('');
    lines.push(`Link: ${productUrl}`);
    return lines.filter(Boolean).join('\n');
  },

  // ── Format: Übersicht ──────────────────────────────────────────────────
  formatOverviewKnowledge(product, productUrl, categoryName) {
    const variantLines = (product.variants || []).map(v => {
      const price = v.price ? `${v.price} ${product.currency || 'EUR'}` : '?';
      const { display: s } = this._stockInfo(v.stock);
      return `  - ${v.name}: ${price} (${s})`;
    }).join('\n');

    return [
      `Produkt-Übersicht: ${product.name}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      `Kaufseite: ${productUrl}`,
      '',
      'Verfügbare Optionen:',
      variantLines,
      '',
      `Kauflink für alle Optionen: ${productUrl}`
    ].filter(Boolean).join('\n');
  },

  // ── Nukleäre Bereinigung aller alten Sellauth-Einträge ────────────────
  async _cleanupOldEntries(shopUrl) {
    let totalDeleted = 0;

    // 1. Löschen nach bekannten source-Namen (Supabase v2 korrekte Syntax)
    const knownSources = ['sellauth_sync', 'sellauth', 'sellauth_import'];
    for (const src of knownSources) {
      const { error } = await supabase.from('knowledge_base').delete().eq('source', src);
      if (!error) {
        logger.info(`[Sellauth] Bereinigt: source="${src}"`);
      }
    }

    // 2. Löschen nach Shop-URL im Content (erwischt alle alten Einträge)
    if (shopUrl) {
      const shopDomain = shopUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
      // Einträge die die Shop-Domain im Content haben aber NICHT source=sellauth_sync
      // (damit wir nicht die frisch importierten löschen)
      const { data: oldEntries } = await supabase
        .from('knowledge_base')
        .select('id, source, content')
        .ilike('content', `%${shopDomain}%`);

      if (oldEntries?.length) {
        const toDelete = oldEntries
          .filter(e => !knownSources.includes(e.source) && e.source !== 'manual_entry')
          .map(e => e.id);

        if (toDelete.length > 0) {
          const { error } = await supabase.from('knowledge_base').delete().in('id', toDelete);
          if (!error) {
            totalDeleted += toDelete.length;
            logger.info(`[Sellauth] ${toDelete.length} weitere veraltete Einträge entfernt`);
          }
        }
      }
    }

    return totalDeleted;
  },

  // ── Haupt-Sync ─────────────────────────────────────────────────────────
  async syncToKnowledgeBase(apiKey, shopId, shopUrl) {
    const results = { total: 0, saved: 0, skipped: 0, errors: [], deletedOld: 0 };

    // Produkte + Kategorien laden
    const [products, categories] = await Promise.all([
      this.getAllProducts(apiKey, shopId),
      this.getCategories(apiKey, shopId)
    ]);

    results.total = products.length;
    logger.info(`[Sellauth] ${products.length} Produkte von API geladen`);

    // Alle alten Einträge bereinigen
    results.deletedOld = await this._cleanupOldEntries(shopUrl);
    logger.info(`[Sellauth] Bereinigung abgeschlossen`);

    // Kategorie-ID
    let categoryId = null;
    try {
      const { data: kbCat } = await supabase.from('knowledge_categories').select('id').eq('name', 'Sellauth Import').single();
      categoryId = kbCat?.id || null;
    } catch {}

    // Produkte verarbeiten
    for (const product of products) {
      if (product.visibility === 'hidden') { results.skipped++; continue; }

      const cat        = categories.find(c => c.id === product.category_id);
      const catName    = cat?.name || null;
      const productUrl = this.buildProductUrl(shopUrl, product.path);

      logger.info(`[Sellauth] ${product.name} → ${productUrl}`);

      try {
        if (product.type === 'variant' && product.variants?.length) {
          for (const variant of product.variants) {
            const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
            const embedding = await deepseekService.generateEmbedding(content);
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title:       `${product.name} – ${variant.name}`,
              source:      'sellauth_sync',
              category_id: categoryId,
              metadata: {
                product_id: product.id, variant_id: variant.id,
                product_url: productUrl, price: variant.price,
                currency: product.currency, stock: variant.stock, type: 'variant'
              }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 200));
          }

          // Übersichts-Eintrag
          const overview = this.formatOverviewKnowledge(product, productUrl, catName);
          const embOv    = await deepseekService.generateEmbedding(overview);
          await supabase.from('knowledge_base').insert([{
            content: overview, embedding: embOv,
            title: `${product.name} (Übersicht)`,
            source: 'sellauth_sync',
            category_id: categoryId,
            metadata: { product_id: product.id, product_url: productUrl, type: 'overview' }
          }]);
          await new Promise(r => setTimeout(r, 200));

        } else {
          const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
          const embedding = await deepseekService.generateEmbedding(content);
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title: product.name,
            source: 'sellauth_sync',
            category_id: categoryId,
            metadata: { product_id: product.id, product_url: productUrl, price: product.price, currency: product.currency, type: 'single' }
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

    logger.info(`[Sellauth] Fertig: ${results.saved} Einträge für ${results.total} Produkte`);
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
