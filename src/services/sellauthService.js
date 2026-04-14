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
    // 1. Alle Produkte listen
    do {
      const { data } = await client.get(`/shops/${shopId}/products`, {
        params: { page, perPage: 100, orderColumn: 'name', orderDirection: 'asc' }
      });
      all.push(...(data.data || []));
      lastPage = data.last_page || 1;
      page++;
    } while (page <= lastPage);

    // 2. Für Variant-Produkte: Einzel-Abruf für vollständige Varianten-Preise
    // Die List-API gibt manchmal unvollständige Varianten zurück
    const enriched = [];
    for (const product of all) {
      if (product.type === 'variant' && product.id) {
        try {
          const { data: full } = await client.get(`/shops/${shopId}/products/${product.id}`);
          // Varianten aus Einzel-Abruf sind vollständiger (inkl. Preise, Stock)
          if (full && full.variants && full.variants.length >= (product.variants || []).length) {
            enriched.push({ ...product, variants: full.variants });
          } else {
            enriched.push(product);
          }
          await new Promise(r => setTimeout(r, 100)); // Rate-Limit-Schutz
        } catch {
          enriched.push(product); // Fallback auf List-Daten
        }
      } else {
        enriched.push(product);
      }
    }
    return enriched;
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
    // Preis korrekt formatieren (Sellauth gibt String wie "8.29" zurück)
    const rawPrice = variant.price ? parseFloat(variant.price) : null;
    const price = rawPrice ? `${rawPrice.toFixed(2)} ${product.currency || 'EUR'}` : null;
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

  async syncToKnowledgeBase(apiKey, shopId, shopUrl, jobId) {
    const syncJobManager = require('./syncJobManager');
    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Sellauth] ${pct}% – ${step}`);
    };

    const results = { saved: 0, skipped: 0, errors: 0 };

    progress(2, 'Lade Produkte und Kategorien...');

    const [products, categories] = await Promise.all([
      this.getAllProducts(apiKey, shopId),
      this.getCategories(apiKey, shopId)
    ]);

    progress(8, `${products.length} Produkte geladen, ${categories.length} Kategorien`);

    // ── Deduplizierung ────────────────────────────────────────────────────────
    // Bestseller, Bundles etc. sind Duplikate mit evtl. falschen Preisen → weglassen
    const SKIP_NAME_PATTERNS = /bestseller|bundle|combo/i;
    const seenPaths = new Set();
    const seenNormNames = new Set();
    const filtered = products.filter(p => {
      if (p.visibility === 'hidden') return false;
      if (SKIP_NAME_PATTERNS.test(p.name)) return false;
      // Exakter Pfad-Check
      if (p.path && seenPaths.has(p.path)) return false;
      if (p.path) seenPaths.add(p.path);
      // Normalisierter Name-Check (entfernt Leerzeichen, Sonderzeichen)
      const normName = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seenNormNames.has(normName)) return false;
      seenNormNames.add(normName);
      return true;
    });
    const skipped = products.length - filtered.length;
    progress(12, `${filtered.length} einzigartige Produkte (${skipped} Duplikate übersprungen)`);

    // ── Kategorien in Wissensdatenbank anlegen / sicherstellen ──────────────
    progress(14, 'Kategorien vorbereiten...');
    const catMap = await this._ensureKbCategories(categories);

    // ── Alte Sellauth-Einträge löschen ────────────────────────────────────
    progress(16, 'Alte Einträge löschen...');
    try {
      await supabase.from('knowledge_base').delete().eq('source', 'sellauth_sync');
    } catch (e) { logger.warn('[Sellauth] Delete:', e.message); }

    // ── Produkte verarbeiten ───────────────────────────────────────────────
    const total = filtered.length;
    for (let i = 0; i < total; i++) {
      const product = filtered[i];
      const pct     = 18 + Math.round((i / total) * 75);
      progress(pct, `Produkt ${i+1}/${total}: ${product.name}`);

      const cat       = categories.find(c => c.id === product.category_id);
      const catName   = cat?.name || null;
      const kbCatId   = catMap[product.category_id] || catMap['_products'] || null;
      const productUrl = this.buildProductUrl(shopUrl, product.path);

      try {
        if (product.type === 'variant' && product.variants?.length) {
          // Übersichts-Eintrag (einmal pro Produkt)
          const overview  = this.formatOverviewKnowledge(product, productUrl, catName);
          const _eo       = await deepseekService.generateEmbedding(overview);
          const embOver   = _eo.embedding || _eo;
          await supabase.from('knowledge_base').insert([{
            content: overview, embedding: embOver,
            title:   `${product.name} (Übersicht)`,
            source:  'sellauth_sync',
            category_id: kbCatId,
            metadata: { product_id: product.id, product_url: productUrl, type: 'overview' }
          }]);
          results.saved++;
          await new Promise(r => setTimeout(r, 150));

          // Pro Variante einzelner Eintrag
          for (const variant of product.variants) {
            const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
            const _ev       = await deepseekService.generateEmbedding(content);
            const embedding = _ev.embedding || _ev;
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title:  `${product.name} – ${variant.name}`,
              source: 'sellauth_sync',
              category_id: kbCatId,
              metadata: {
                product_id: product.id, variant_id: variant.id,
                product_url: productUrl, price: variant.price,
                currency: product.currency, stock: variant.stock, type: 'variant'
              }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 150));
          }
        } else {
          const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
          const _es       = await deepseekService.generateEmbedding(content);
          const embedding = _es.embedding || _es;
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title:  product.name, source: 'sellauth_sync',
            category_id: kbCatId,
            metadata: { product_id: product.id, product_url: productUrl, price: product.price, currency: product.currency, type: 'single' }
          }]);
          results.saved++;
          await new Promise(r => setTimeout(r, 150));
        }
      } catch (e) {
        logger.warn(`[Sellauth] Produkt-Fehler (${product.name}): ${e.message}`);
        results.errors++;
      }
    }

    progress(95, 'Abschluss...');
    logger.info(`[Sellauth] Sync: ${results.saved} Einträge, ${results.skipped} übersprungen, ${results.errors} Fehler`);
    return results;
  },

  // Wissensdatenbank-Kategorien aus Sellauth-Kategorien ableiten
  async _ensureKbCategories(sellauthCategories) {
    const map = {};

    // Alle existierenden KB-Kategorien laden (User-Kategorien bewahren!)
    try {
      const { data: allCats } = await supabase.from('knowledge_categories').select('id, name');
      for (const cat of (allCats || [])) {
        map['_' + cat.name.toLowerCase()] = cat.id;
      }
    } catch (_) {}

    // Standard-Kategorien anlegen falls noch nicht vorhanden
    const needed = [
      { name: 'Produkte', icon: '🛒' },
      { name: 'Tarife',   icon: '📶' },
      { name: 'Preise',   icon: '💰' },
      { name: 'FAQ',      icon: '❓' },
      { name: 'Support',  icon: '🛠️' },
    ];
    for (const def of needed) {
      const key = '_' + def.name.toLowerCase();
      if (map[key]) continue; // Bereits vorhanden → nicht überschreiben
      try {
        const { data: created } = await supabase.from('knowledge_categories')
          .insert([{ name: def.name, icon: def.icon, color: '#3b82f6' }])
          .select('id').single();
        if (created) map[key] = created.id;
      } catch (_) {}
    }

    // Fallback-Alias
    map['_products'] = map['_tarife'] || map['_produkte'] || null;

    // Sellauth-Kategorien → KB-Kategorien mappen
    for (const cat of (sellauthCategories || [])) {
      const lname = (cat.name || '').toLowerCase();
      if (/tarif|esim|data|sim|travel|unlimited/.test(lname)) {
        map[cat.id] = map['_tarife'] || map['_products'];
      } else if (/preis|price|kosten|cost/.test(lname)) {
        map[cat.id] = map['_preise'] || map['_tarife'];
      } else if (/faq|info|hilfe|help|anleitung/.test(lname)) {
        map[cat.id] = map['_faq'];
      } else if (/support|kontakt|service/.test(lname)) {
        map[cat.id] = map['_support'];
      } else {
        map[cat.id] = map['_produkte'] || map['_products'];
      }
    }
    return map;
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
