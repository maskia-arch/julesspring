/**
 * sellauthService.js v1.1.2
 *
 * Verbesserungen:
 * - Pro Variante ein eigener Knowledge-Eintrag (bessere Vektorsuche)
 * - Semantisch reicheres Format mit Kundenfragen-Sprache
 * - Jede Variante hat ihren eigenen Direktlink
 */

const axios  = require('axios');
const supabase = require('../config/supabase');
const deepseekService = require('./deepseekService');
const logger = require('../utils/logger');

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

  buildProductUrl(shopUrl, path) {
    return `${shopUrl.replace(/\/$/, '')}/${path}`;
  },

  // ── VERBESSERT: Pro Variante ein eigener Eintrag ──────────────────────
  formatVariantKnowledge(product, variant, shopUrl, categoryName) {
    const productUrl = this.buildProductUrl(shopUrl, product.path);
    // Direktlink mit vorausgewählter Variante
    const variantUrl = `${productUrl}?variant=${variant.id}`;
    const price      = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const stock      = variant.stock !== null ? variant.stock : '∞';

    // Semantisch reiches Format: enthält Kundenfragen-Sprache und alle relevanten Begriffe
    return [
      `Produkt: ${product.name} – ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stock > 0 || stock === '∞' ? 'Verfügbar' : 'Ausverkauft'}`,
      `Direkter Kauflink: ${variantUrl}`,
      `Shop-Seite: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      product.description
        ? `Beschreibung: ${product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400)}`
        : '',
      '',
      // Suchbegriffe: hilft der Vektorsuche bei Kundenanfragen
      `Suchbegriffe: ${[product.name, variant.name, categoryName].filter(Boolean).join(', ')}`,
      `Wenn ein Kunde nach diesem Tarif oder Produkt fragt, empfiehl: ${variant.name} von ${product.name} für ${price || 'diesen Preis'}.`,
      `Kauflink für Kunden: ${variantUrl}`
    ].filter(Boolean).join('\n');
  },

  // Format für Produkte ohne Varianten (Typ: single)
  formatSingleProductKnowledge(product, shopUrl, categoryName) {
    const url   = this.buildProductUrl(shopUrl, product.path);
    const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;

    return [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Kauflink: ${url}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      product.description
        ? `Beschreibung: ${product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400)}`
        : '',
      '',
      `Suchbegriffe: ${[product.name, categoryName].filter(Boolean).join(', ')}`,
      `Wenn ein Kunde dieses Produkt sucht, gib ihm den Link: ${url}`
    ].filter(Boolean).join('\n');
  },

  async syncToKnowledgeBase(apiKey, shopId, shopUrl) {
    const results = { total: 0, saved: 0, skipped: 0, errors: [] };

    const [products, categories] = await Promise.all([
      this.getAllProducts(apiKey, shopId),
      this.getCategories(apiKey, shopId)
    ]);

    results.total = products.length;

    const { data: kbCat } = await supabase
      .from('knowledge_categories').select('id').eq('name', 'Sellauth Import').single();
    const categoryId = kbCat?.id || null;

    // Alle alten Sellauth-Einträge löschen → Fresh Sync
    await supabase.from('knowledge_base').delete().eq('source', 'sellauth_sync');

    for (const product of products) {
      if (product.visibility === 'hidden') { results.skipped++; continue; }

      const cat = categories.find(c => c.id === product.category_id);
      const catName = cat?.name || null;

      try {
        if (product.type === 'variant' && product.variants?.length) {
          // Eine Eintrag pro Variante – für präzise Vektorsuche
          for (const variant of product.variants) {
            const content   = this.formatVariantKnowledge(product, variant, shopUrl, catName);
            const embedding = await deepseekService.generateEmbedding(content);
            const title     = `${product.name} – ${variant.name}`;

            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title,
              source:      'sellauth_sync',
              category_id: categoryId,
              metadata: {
                product_id:   product.id,
                variant_id:   variant.id,
                product_path: product.path,
                product_url:  this.buildProductUrl(shopUrl, product.path),
                variant_url:  `${this.buildProductUrl(shopUrl, product.path)}?variant=${variant.id}`,
                price:        variant.price,
                currency:     product.currency,
                stock:        variant.stock,
                type:         'variant'
              }
            }]);

            results.saved++;
            await new Promise(r => setTimeout(r, 250)); // Rate-Limit
          }

          // Zusätzlich: ein Übersichts-Eintrag für das gesamte Produkt
          const overview = this._buildProductOverview(product, shopUrl, catName, categories);
          const emb      = await deepseekService.generateEmbedding(overview);
          await supabase.from('knowledge_base').insert([{
            content: overview, embedding: emb,
            title:   `${product.name} (Übersicht)`,
            source:  'sellauth_sync',
            category_id: categoryId,
            metadata: { product_id: product.id, type: 'overview' }
          }]);
          await new Promise(r => setTimeout(r, 250));

        } else {
          // Einzelprodukt
          const content   = this.formatSingleProductKnowledge(product, shopUrl, catName);
          const embedding = await deepseekService.generateEmbedding(content);
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title:       product.name,
            source:      'sellauth_sync',
            category_id: categoryId,
            metadata: {
              product_id:   product.id,
              product_path: product.path,
              product_url:  this.buildProductUrl(shopUrl, product.path),
              price:        product.price,
              currency:     product.currency,
              type:         'single'
            }
          }]);
          results.saved++;
          await new Promise(r => setTimeout(r, 250));
        }

        logger.info(`[Sellauth] ✓ ${product.name}`);
      } catch (err) {
        results.errors.push(`${product.name}: ${err.message}`);
        logger.warn(`[Sellauth] ✗ ${product.name}: ${err.message}`);
      }
    }

    logger.info(`[Sellauth] Sync fertig: ${results.saved} Einträge für ${results.total} Produkte`);
    return results;
  },

  _buildProductOverview(product, shopUrl, catName, categories) {
    const url = this.buildProductUrl(shopUrl, product.path);
    const variantList = (product.variants || []).map(v => {
      const price = v.price ? `${v.price} ${product.currency}` : '?';
      const link  = `${url}?variant=${v.id}`;
      return `- ${v.name}: ${price} → ${link}`;
    }).join('\n');

    return [
      `Produkt-Übersicht: ${product.name}`,
      catName ? `Kategorie: ${catName}` : '',
      `Shop-Link: ${url}`,
      '',
      'Alle verfügbaren Optionen:',
      variantList,
      '',
      `Wenn ein Kunde eine Option aus "${product.name}" kaufen möchte, gib ihm den passenden Direktlink.`
    ].filter(Boolean).join('\n');
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
