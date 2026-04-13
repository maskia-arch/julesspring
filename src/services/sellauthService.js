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
  // Parst "50.00GB / 180 Days" → { gb: "50", days: "180" }
  _parseVariantName(name) {
    const m = name.match(/([\d.]+)\s*GB.*?(\d+)\s*(?:Day|Tag)/i);
    return m ? { gb: parseFloat(m[1]).toString(), days: m[2] } : null;
  },

  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const stock = variant.stock;
    const isUnlimited = stock === null || stock === -1;
    const inStock = isUnlimited || stock > 0;
    const stockDisplay = isUnlimited ? 'Unbegrenzt vorrätig' : stock > 0 ? `${stock} auf Lager` : 'Ausverkauft';

    // Deutsche Synonyme aus englischen Varianten-Namen ableiten
    const parsed = this._parseVariantName(variant.name);
    const gbPart   = parsed ? `${parsed.gb} GB` : '';
    const daysPart = parsed ? `${parsed.days} Tage` : '';
    const germanName = parsed ? `${parsed.gb}GB ${parsed.days} Tage` : '';
    const shortName  = parsed ? `${parsed.gb}GB / ${parsed.days} Tage` : '';

    const lines = [
      `Produkt: ${product.name}`,
      `Variante: ${variant.name}`,
      germanName    ? `Auch bekannt als: ${germanName}` : '',
      shortName     ? `Kurzbezeichnung: ${shortName}` : '',
      gbPart        ? `Datenvolumen: ${gbPart}` : '',
      daysPart      ? `Laufzeit: ${daysPart}` : '',
      price         ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName  ? `Kategorie: ${categoryName}` : '',
    ];

    if (product.description) {
      const clean = product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length > 10) lines.push(`Info: ${clean.substring(0, 300)}`);
    }

    lines.push('');
    // Suchformulierungen die Kunden benutzen
    if (parsed) {
      lines.push(`Suchanfrage: "${product.name} ${parsed.gb}GB" oder "${product.name} ${parsed.days} Tage" → Kauflink: ${productUrl}`);
      lines.push(`Kunden fragen oft nach "${parsed.gb} gb ${parsed.days} tage" oder "${parsed.gb}GB ${parsed.days} Tage ${product.name}"`);
    } else {
      lines.push(`Suchanfrage: "${variant.name}" oder "${product.name}" → Kauflink: ${productUrl}`);
    }
    if (price) lines.push(`Empfehlung: "${variant.name}" für ${price} – Kauflink: ${productUrl}`);

    return lines.filter(Boolean).join('\n');
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
      const price     = v.price ? `${v.price} ${product.currency || 'EUR'}` : '?';
      const stockNote = (v.stock === 0) ? ' (ausverkauft)' : (v.stock === null || v.stock === -1) ? ' (unbegrenzt)' : '';
      const parsed    = this._parseVariantName(v.name);
      const german    = parsed ? ` / ${parsed.gb}GB ${parsed.days} Tage` : '';
      return `  • ${v.name}${german}: ${price}${stockNote}`;
    }).join('\n');

    // Alle Varianten-GB-Werte als Suchterme
    const gbValues = [...new Set((product.variants||[]).map(v => {
      const p = this._parseVariantName(v.name); return p ? p.gb + 'GB' : null;
    }).filter(Boolean))].join(', ');

    return [
      `Produkt-Übersicht: ${product.name}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      gbValues ? `Verfügbare Datenvolumen: ${gbValues}` : '',
      `Kauflink: ${productUrl}`,
      '',
      `Alle Optionen für ${product.name}:`,
      variantLines,
      '',
      `Auf der Seite ${productUrl} kannst du die passende Option (Datenmenge und Laufzeit) wählen und kaufen.`
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

    // ── Deduplizierung: Produkte mit identischem Path oder Namen filtern ────
    // "Bestseller"-Gruppen sind Duplikate von regulären Produkten
    const SKIP_NAME_PATTERNS = /bestseller/i;
    const seenPaths = new Set();
    const filtered = products.filter(p => {
      if (p.visibility === 'hidden') return false;
      if (SKIP_NAME_PATTERNS.test(p.name)) return false; // Bestseller-Duplikat
      const key = p.path || p.name;
      if (seenPaths.has(key)) return false;
      seenPaths.add(key);
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
    // Standard-Kategorien die wir immer wollen
    const needed = ['Produkte', 'Tarife', 'FAQ', 'Support'];
    for (const name of needed) {
      try {
        const { data: existing } = await supabase.from('knowledge_categories')
          .select('id').eq('name', name).maybeSingle();
        if (existing) { map['_' + name.toLowerCase()] = existing.id; continue; }
        const { data: created } = await supabase.from('knowledge_categories')
          .insert([{ name, icon: name === 'Produkte' ? '🛒' : name === 'Tarife' ? '📶' : name === 'FAQ' ? '❓' : '🛠️', color: '#3b82f6' }])
          .select('id').single();
        if (created) map['_' + name.toLowerCase()] = created.id;
      } catch (_) {}
    }
    map['_products'] = map['_produkte'] || map['_tarife'] || null;

    // Sellauth-Kategorien → KB-Kategorien mappen
    for (const cat of (sellauthCategories || [])) {
      const lname = (cat.name || '').toLowerCase();
      if (/tarif|esim|data|sim/.test(lname)) map[cat.id] = map['_tarife'] || map['_products'];
      else if (/faq|info|hilfe|help/.test(lname)) map[cat.id] = map['_faq'];
      else if (/support|kontakt/.test(lname)) map[cat.id] = map['_support'];
      else map[cat.id] = map['_produkte'] || map['_products'];
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
