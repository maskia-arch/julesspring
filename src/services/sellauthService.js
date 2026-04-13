/**
 * sellauthService.js v1.1.4
 *
 * Fix: Produktlinks verwenden nur {shopUrl}/{product.path}
 * Sellauth hat KEIN ?variant=ID URL-Parameter.
 * Varianten werden auf der Produktseite ausgewählt.
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const deepseekService = require('./deepseekService');
const logger  = require('../utils/logger');

const SELLAUTH_API = 'https://api.sellauth.com/v1';

const sellauthService = {

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

  // FIX: /product/ Prefix — Sellauth URL-Format: {shopUrl}/product/{path}
  buildProductUrl(shopUrl, productPath) {
    return `${shopUrl.replace(/\/$/, '')}/product/${productPath}`;
  },

  // Format für Variante: Link führt immer zur Produktseite
  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    // Sellauth: stock = null oder -1 → unbegrenzt vorrätig, 0 → ausverkauft
    const stock = variant.stock;
    const isUnlimited = stock === null || stock === -1;
    const inStock = isUnlimited || stock > 0;
    const stockDisplay = isUnlimited ? 'Unbegrenzt vorrätig' : stock > 0 ? `${stock} auf Lager` : 'Ausverkauft';

    const lines = [
      `Produkt: ${product.name}`,
      `Option/Variante: ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Status: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];

    // Produktbeschreibung (einmal, nicht pro Variante redundant)
    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 500)}`);
    }

    lines.push('');
    lines.push(`Wenn ein Kunde "${variant.name}" oder "${product.name}" sucht: Link → ${productUrl}`);
    if (price) lines.push(`Empfehlung: "${variant.name}" für ${price} – Kauflink: ${productUrl}`);

    return lines.filter(l => l !== undefined && l !== null && l !== '').join('\n');
  },

  // Format für Produkte ohne Varianten
  formatSingleProductKnowledge(product, productUrl, categoryName) {
    const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;
    const lines = [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
    ];
    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 500)}`);
    }
    lines.push('');
    lines.push(`Wenn ein Kunde dieses Produkt sucht: Link → ${productUrl}`);
    return lines.filter(Boolean).join('\n');
  },

  // Übersichts-Eintrag für Variant-Produkt (alle Optionen auf einen Blick)
  formatOverviewKnowledge(product, productUrl, categoryName) {
    const variantLines = (product.variants || []).map(v => {
      const price = v.price ? `${v.price} ${product.currency || 'EUR'}` : '?';
      const stockNote = (v.stock === 0) ? ' (ausverkauft)' : (v.stock === null || v.stock === -1) ? ' (unbegrenzt)' : '';
      return `  • ${v.name}: ${price}${stockNote}`;
    }).join('\n');

    return [
      `Produkt-Übersicht: ${product.name}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      `Kauflink (alle Optionen auf dieser Seite): ${productUrl}`,
      '',
      `Verfügbare Optionen:`,
      variantLines,
      '',
      `Kunden können auf der Seite ${productUrl} die gewünschte Option auswählen und direkt kaufen.`
    ].filter(Boolean).join('\n');
  },

  async syncToKnowledgeBase(apiKey, shopId, shopUrl) {
    const results = { total: 0, saved: 0, skipped: 0, errors: [] };

    const [products, categories] = await Promise.all([
      this.getAllProducts(apiKey, shopId),
      this.getCategories(apiKey, shopId)
    ]);

    results.total = products.length;
    logger.info(`[Sellauth] ${products.length} Produkte geladen`);

    // Sellauth-Import Kategorie-ID holen
    let categoryId = null;
    try {
      const { data: kbCat } = await supabase.from('knowledge_categories').select('id').eq('name', 'Sellauth Import').single();
      categoryId = kbCat?.id || null;
    } catch {}

    // Alte Einträge löschen
    await supabase.from('knowledge_base').delete().eq('source', 'sellauth_sync');

    for (const product of products) {
      if (product.visibility === 'hidden') { results.skipped++; continue; }

      const cat        = categories.find(c => c.id === product.category_id);
      const catName    = cat?.name || null;
      const productUrl = this.buildProductUrl(shopUrl, product.path);

      try {
        if (product.type === 'variant' && product.variants?.length) {

          // 1. Pro Variante ein Eintrag
          for (const variant of product.variants) {
            const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
            const _emb1    = await deepseekService.generateEmbedding(content);
            const embedding = _emb1.embedding || _emb1;  // unwrap {embedding,tokens}
            const title     = `${product.name} – ${variant.name}`;

            await supabase.from('knowledge_base').insert([{
              content, embedding, title,
              source:      'sellauth_sync',
              category_id: categoryId,
              metadata: {
                product_id:   product.id,
                variant_id:   variant.id,
                product_url:  productUrl,
                price:        variant.price,
                currency:     product.currency,
                stock:        variant.stock,
                type:         'variant'
              }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 200));
          }

          // 2. Übersichts-Eintrag mit allen Varianten
          const overview  = this.formatOverviewKnowledge(product, productUrl, catName);
          const _embOver  = await deepseekService.generateEmbedding(overview);
          const embOver   = _embOver.embedding || _embOver;  // unwrap
          await supabase.from('knowledge_base').insert([{
            content: overview, embedding: embOver,
            title:   `${product.name} (alle Optionen)`,
            source:  'sellauth_sync',
            category_id: categoryId,
            metadata: { product_id: product.id, product_url: productUrl, type: 'overview' }
          }]);
          await new Promise(r => setTimeout(r, 200));

        } else {
          const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
          const _emb3    = await deepseekService.generateEmbedding(content);
          const embedding = _emb3.embedding || _emb3;  // unwrap
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title:       product.name,
            source:      'sellauth_sync',
            category_id: categoryId,
            metadata: {
              product_id:  product.id,
              product_url: productUrl,
              price:       product.price,
              currency:    product.currency,
              type:        'single'
            }
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

    logger.info(`[Sellauth] Sync: ${results.saved} Einträge für ${results.total} Produkte`);
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
