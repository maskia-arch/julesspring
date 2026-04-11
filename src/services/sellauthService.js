/**
 * sellauthService.js v1.2.9
 *
 * Verbesserungen:
 * - Holt vollständige Produktdetails (GET /products/{id}) für instructions,
 *   meta_description, status_text, product_badges
 * - Keyword-reiche Wissenseinträge mit allen Synonymen
 * - Paralleles Laden der Produktdetails (Batches von 5)
 */

const axios    = require('axios');
const supabase  = require('../config/supabase');
const deepseekService = require('./deepseekService');
const syncJobManager  = require('./syncJobManager');
const logger   = require('../utils/logger');

const SELLAUTH_API = 'https://api.sellauth.com/v1';

const sellauthService = {

  _client(apiKey) {
    return axios.create({
      baseURL: SELLAUTH_API, timeout: 25000,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
  },

  // ── API-Abruf ────────────────────────────────────────────────────────────

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

  // Vollständige Produktdetails holen (hat instructions, meta_description, status_text, badges)
  async getProductDetail(apiKey, shopId, productId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/products/${productId}`);
      return data;
    } catch (e) {
      logger.warn(`[Sellauth] Produktdetail ${productId} fehlgeschlagen: ${e.message}`);
      return null;
    }
  },

  // Vollständige Details für alle Produkte laden (parallele Batches)
  async getAllProductDetails(apiKey, shopId, products) {
    const BATCH_SIZE = 5;
    const detailed = [];

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(p => this.getProductDetail(apiKey, shopId, p.id))
      );
      // Merge list-Daten mit Detail-Daten (Detail hat mehr Felder)
      results.forEach((detail, idx) => {
        detailed.push(detail || batch[idx]); // Fallback auf list-Daten
      });
      // Kurze Pause zwischen Batches
      if (i + BATCH_SIZE < products.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return detailed;
  },

  async getCategories(apiKey, shopId) {
    try {
      const client = this._client(apiKey);
      const all = [];
      let page = 1, lastPage = 1;
      do {
        const { data } = await client.get(`/shops/${shopId}/categories`, { params: { page, perPage: 100 } });
        all.push(...(data.data || []));
        lastPage = data.last_page || 1;
        page++;
      } while (page <= lastPage);
      return all;
    } catch { return []; }
  },

  async getBlogPosts(apiKey, shopId) {
    try {
      const client = this._client(apiKey);
      const all = [];
      let page = 1, lastPage = 1;
      do {
        const { data } = await client.get(`/shops/${shopId}/blog-posts`, {
          params: { page, perPage: 100, orderColumn: 'id', orderDirection: 'asc' }
        });
        all.push(...(data.data || []));
        lastPage = data.last_page || 1;
        page++;
      } while (page <= lastPage);
      return all;
    } catch (e) {
      logger.warn(`[Sellauth] Blog-Posts nicht verfügbar: ${e.message}`);
      return [];
    }
  },

  async getBlogPostDetail(apiKey, shopId, postId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/blog-posts/${postId}`);
      return data;
    } catch { return null; }
  },

  async getGroups(apiKey, shopId) {
    try {
      const { data } = await this._client(apiKey).get(`/shops/${shopId}/groups`);
      return data.data || [];
    } catch { return []; }
  },

  // ── URL & Stock ─────────────────────────────────────────────────────────

  buildProductUrl(shopUrl, productPath) {
    return `${shopUrl.replace(/\/$/, '')}/product/${productPath}`;
  },

  _stockInfo(stockValue) {
    if (stockValue === null || stockValue === -1 || stockValue === undefined) {
      return { inStock: true, display: 'Verfügbar' };
    }
    if (stockValue > 0) {
      return { inStock: true, display: 'Verfügbar' };
    }
    return { inStock: false, display: 'Ausverkauft' };
  },

  // ── Text-Helfer ─────────────────────────────────────────────────────────

  _cleanHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  },

  // Extrahiert Keywords aus Varianten-/Produktnamen für bessere Vektorsuche
  // z.B. "10GB - 30 Tage" → ["10GB", "10 GB", "30 Tage", "30 Tage Gültigkeit"]
  _buildKeywords(productName, variantName, categoryName, groupName) {
    const parts = [productName, variantName, categoryName, groupName].filter(Boolean);
    const keywords = new Set();

    parts.forEach(p => {
      // Original
      keywords.add(p);

      // Daten-Volumen Varianten
      const gbMatch = p.match(/(\d+(?:\.\d+)?)\s*GB/i);
      if (gbMatch) {
        keywords.add(`${gbMatch[1]}GB`);
        keywords.add(`${gbMatch[1]} GB`);
        keywords.add(`${gbMatch[1]} Gigabyte`);
        keywords.add(`${gbMatch[1]} Gigabyte Daten`);
        keywords.add(`${gbMatch[1]}GB Datenvolumen`);
      }

      // Zeitraum Varianten
      const dayMatch = p.match(/(\d+)\s*(?:Day|Tage?|Days?)/i);
      if (dayMatch) {
        keywords.add(`${dayMatch[1]} Tage`);
        keywords.add(`${dayMatch[1]} Tag Gültigkeit`);
        keywords.add(`${dayMatch[1]} Tage Laufzeit`);
      }

      // Land-Synonyme
      if (/germany|german|deutsch|de\b/i.test(p)) {
        keywords.add('Deutschland');
        keywords.add('Germany');
        keywords.add('Deutsch');
        keywords.add('DE eSIM');
      }
      if (/europe|europa/i.test(p)) {
        keywords.add('Europa');
        keywords.add('Europe');
        keywords.add('europäische Länder');
      }

      // Tarif-Typ Synonyme
      if (/unlimited/i.test(p)) {
        keywords.add('Unlimited');
        keywords.add('unbegrenzt');
        keywords.add('unbegrenztes Datenvolumen');
        keywords.add('Fair Use');
      }
      if (/travel/i.test(p)) {
        keywords.add('Travel');
        keywords.add('Reise eSIM');
        keywords.add('Reisen');
        keywords.add('festes Datenvolumen');
      }
      if (/eco|budget/i.test(p)) {
        keywords.add('günstig');
        keywords.add('Budget');
        keywords.add('preiswert');
      }
      if (/pro\b/i.test(p)) {
        keywords.add('Premium');
        keywords.add('schnell');
      }
    });

    return [...keywords].join(', ');
  },

  // ── Format: Variante (keyword-reich) ───────────────────────────────────

  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(variant.stock);
    const groupName  = product.group?.name || null;
    const statusText = product.status_text || null;
    const badges     = (product.product_badges || []).map(b => b.label).filter(Boolean).join(', ');

    // Beschreibung: HTML bereinigen, Priorität: Produktbeschreibung > meta_description
    const descRaw    = this._cleanHtml(product.description) ||
                       this._cleanHtml(product.meta_description) || '';
    const desc       = descRaw.substring(0, 600);

    // Anleitung (instructions) — oft enthält FUP-Details, Aktivierungsinfos
    const instrRaw   = this._cleanHtml(product.instructions) || '';
    const instr      = instrRaw.substring(0, 400);

    // Keywords für Vektorsuche
    const keywords   = this._buildKeywords(product.name, variant.name, categoryName, groupName);

    const lines = [
      `Produkt: ${product.name}`,
      `Option: ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stockDisplay}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      groupName    ? `Gruppe: ${groupName}` : '',
      statusText   ? `Status: ${statusText}` : '',
      badges       ? `Badges: ${badges}` : '',
      `Kauflink: ${productUrl}`,
      '',
      desc         ? `Beschreibung: ${desc}` : '',
      instr        ? `Nutzungshinweise: ${instr}` : '',
      '',
      `Suchbegriffe: ${keywords}`,
      '',
      `Empfehlung: "${variant.name}" von "${product.name}"${price ? ' für ' + price : ''}`,
      `Kauflink: ${productUrl}`,
    ].filter(l => l !== null && l !== undefined && l !== '');

    return lines.join('\n');
  },

  // ── Format: Einzelprodukt ────────────────────────────────────────────────

  formatSingleProductKnowledge(product, productUrl, categoryName) {
    const price      = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(product.stock_count);
    const groupName  = product.group?.name || null;
    const descRaw    = this._cleanHtml(product.description) || this._cleanHtml(product.meta_description) || '';
    const desc       = descRaw.substring(0, 600);
    const instrRaw   = this._cleanHtml(product.instructions) || '';
    const instr      = instrRaw.substring(0, 400);
    const keywords   = this._buildKeywords(product.name, null, categoryName, groupName);

    const lines = [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Verfügbarkeit: ${stockDisplay}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      groupName    ? `Gruppe: ${groupName}` : '',
      `Kauflink: ${productUrl}`,
      '',
      desc  ? `Beschreibung: ${desc}` : '',
      instr ? `Nutzungshinweise: ${instr}` : '',
      '',
      `Suchbegriffe: ${keywords}`,
      '',
      `Kauflink: ${productUrl}`,
    ].filter(Boolean).join('\n');
    return lines;
  },

  // ── Format: Übersicht ────────────────────────────────────────────────────

  formatOverviewKnowledge(product, productUrl, categoryName) {
    const variantLines = (product.variants || []).map(v => {
      const price = v.price ? `${v.price} ${product.currency || 'EUR'}` : '?';
      const { display: s } = this._stockInfo(v.stock);
      return `  - ${v.name}: ${price} (${s})`;
    }).join('\n');

    const keywords = this._buildKeywords(product.name, null, categoryName, product.group?.name);

    return [
      `Produkt-Übersicht: ${product.name}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      `Kaufseite: ${productUrl}`,
      '',
      'Alle verfügbaren Optionen:',
      variantLines,
      '',
      `Suchbegriffe: ${keywords}`,
      '',
      `Kauflink: ${productUrl}`
    ].filter(Boolean).join('\n');
  },

  // ── Blog-Post ────────────────────────────────────────────────────────────

  formatBlogPostKnowledge(post, shopUrl, fullContent) {
    const postUrl = `${shopUrl.replace(/\/$/, '')}/blog/${post.path}`;
    const clean   = (text) => this._cleanHtml(text).substring(0, 2000);
    return [
      `Artikel: ${post.title}`,
      post.summary ? `Zusammenfassung: ${clean(post.summary)}` : '',
      fullContent  ? `Inhalt: ${clean(fullContent)}` : '',
      `Link: ${postUrl}`,
    ].filter(Boolean).join('\n');
  },

  // ── Kategorie ────────────────────────────────────────────────────────────

  formatCategoryKnowledge(category, shopUrl) {
    const catUrl = `${shopUrl.replace(/\/$/, '')}/category/${category.path}`;
    return [
      `Kategorie: ${category.name}`,
      category.description ? `Beschreibung: ${this._cleanHtml(category.description)}` : '',
      `Link: ${catUrl}`,
    ].filter(Boolean).join('\n');
  },

  // ── Bereinigung ───────────────────────────────────────────────────────────

  async _cleanupOldEntries() {
    const sources = ['sellauth_sync', 'sellauth', 'sellauth_import', 'sellauth_blog', 'sellauth_category'];
    for (const src of sources) {
      await supabase.from('knowledge_base').delete().eq('source', src);
    }
    logger.info('[Sellauth] Alte Einträge bereinigt');
  },

  async _getKbCategoryId(name) {
    try {
      const { data } = await supabase.from('knowledge_categories').select('id').eq('name', name).single();
      return data?.id || null;
    } catch { return null; }
  },

  // ── HAUPT-SYNC ────────────────────────────────────────────────────────────

  async syncToKnowledgeBase(apiKey, shopId, shopUrl, jobId) {
    const results = { total: 0, saved: 0, blogPosts: 0, categories: 0, errors: [] };

    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Sellauth] ${pct}% – ${step}`);
    };

    try {
      // 1. Alle Daten laden
      progress(5, 'Lade Produktliste von Sellauth...');
      const [productList, saCategories, blogPosts] = await Promise.all([
        this.getAllProducts(apiKey, shopId),
        this.getCategories(apiKey, shopId),
        this.getBlogPosts(apiKey, shopId)
      ]);

      const visibleProducts = productList.filter(p => p.visibility !== 'hidden');
      results.total = visibleProducts.length;
      progress(10, `${visibleProducts.length} Produkte, ${blogPosts.length} Blog-Posts geladen. Lade Produktdetails...`);

      // 2. Vollständige Produktdetails laden (instructions, meta_description, status_text, badges)
      progress(12, `Lade Details für ${visibleProducts.length} Produkte (Batch-Modus)...`);
      const products = await this.getAllProductDetails(apiKey, shopId, visibleProducts);
      progress(30, `Produktdetails geladen. Bereinige alte Einträge...`);

      // 3. Alte Einträge bereinigen
      await this._cleanupOldEntries();

      // 4. KB-Kategorien
      const kbCatProduct = await this._getKbCategoryId('Sellauth Import');
      const kbCatBlog    = await this._getKbCategoryId('FAQ');
      const kbCatGeneral = await this._getKbCategoryId('Allgemein');

      // 5. PRODUKTE importieren
      progress(33, 'Importiere Produkte...');
      let processed = 0;

      for (const product of products) {
        const cat        = saCategories.find(c => c.id === product.category_id);
        const catName    = product.category?.name || cat?.name || null;
        const productUrl = this.buildProductUrl(shopUrl, product.path);

        try {
          if (product.type === 'variant' && product.variants?.length) {
            // Pro Variante ein Eintrag
            for (const variant of product.variants) {
              const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
              const embedding = await deepseekService.generateEmbedding(content);
              await supabase.from('knowledge_base').insert([{
                content, embedding,
                title:       `${product.name} – ${variant.name}`,
                source:      'sellauth_sync',
                category_id: kbCatProduct,
                metadata:    {
                  product_id:   product.id,
                  variant_id:   variant.id,
                  product_url:  productUrl,
                  price:        variant.price,
                  currency:     product.currency,
                  stock:        variant.stock,
                  type:         'variant',
                  status_text:  product.status_text || null,
                  group:        product.group?.name || null
                }
              }]);
              results.saved++;
              await new Promise(r => setTimeout(r, 150));
            }

            // Übersichts-Eintrag
            const ov  = this.formatOverviewKnowledge(product, productUrl, catName);
            const emb = await deepseekService.generateEmbedding(ov);
            await supabase.from('knowledge_base').insert([{
              content: ov, embedding: emb,
              title:       `${product.name} (alle Optionen)`,
              source:      'sellauth_sync',
              category_id: kbCatProduct,
              metadata:    { product_id: product.id, product_url: productUrl, type: 'overview' }
            }]);
            await new Promise(r => setTimeout(r, 150));

          } else {
            const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
            const embedding = await deepseekService.generateEmbedding(content);
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title:       product.name,
              source:      'sellauth_sync',
              category_id: kbCatProduct,
              metadata:    { product_id: product.id, product_url: productUrl, type: 'single' }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 150));
          }

          logger.info(`[Sellauth] ✓ ${product.name}`);
        } catch (err) {
          results.errors.push(`${product.name}: ${err.message}`);
          logger.warn(`[Sellauth] ✗ ${product.name}: ${err.message}`);
        }

        processed++;
        const pct = 33 + Math.floor((processed / products.length) * 42);
        progress(pct, `Produkt ${processed}/${products.length}: ${product.name}`);
      }

      // 6. Shop-Kategorien
      progress(77, `Importiere ${saCategories.length} Kategorien...`);
      for (const cat of saCategories) {
        if (!cat.name) continue;
        try {
          const content   = this.formatCategoryKnowledge(cat, shopUrl);
          const embedding = await deepseekService.generateEmbedding(content);
          await supabase.from('knowledge_base').insert([{
            content, embedding,
            title:       `Kategorie: ${cat.name}`,
            source:      'sellauth_category',
            category_id: kbCatGeneral,
            metadata:    { category_id: cat.id, path: cat.path }
          }]);
          results.categories++;
          await new Promise(r => setTimeout(r, 150));
        } catch (err) {
          logger.warn(`[Sellauth] Kategorie ${cat.name}: ${err.message}`);
        }
      }

      // 7. Blog-Posts
      if (blogPosts.length > 0) {
        progress(82, `Importiere ${blogPosts.length} Blog-Posts...`);
        let blogIdx = 0;
        for (const post of blogPosts) {
          try {
            const detail      = await this.getBlogPostDetail(apiKey, shopId, post.id);
            const fullContent = detail?.content || post.summary || '';
            const content     = this.formatBlogPostKnowledge(post, shopUrl, fullContent);
            const embedding   = await deepseekService.generateEmbedding(content);
            const title       = (post.title || '').toLowerCase();
            let catId = kbCatBlog;
            if (/refund|rückgabe|erstattung|support|anleitung|guide|setup/.test(title)) {
              catId = await this._getKbCategoryId('Support') || kbCatBlog;
            }
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title:       post.title,
              source:      'sellauth_blog',
              category_id: catId,
              metadata:    { post_id: post.id, path: post.path, type: 'blog_post' }
            }]);
            results.blogPosts++;
            blogIdx++;
            progress(82 + Math.floor((blogIdx / blogPosts.length) * 13), `Blog: ${post.title}`);
            await new Promise(r => setTimeout(r, 200));
          } catch (err) {
            logger.warn(`[Sellauth] Blog-Post ${post.title}: ${err.message}`);
          }
        }
      }

      progress(97, 'Abschluss...');
      logger.info(`[Sellauth] Sync: ${results.saved} Produkte, ${results.blogPosts} Blog-Posts, ${results.categories} Kategorien`);
      return results;

    } catch (err) {
      logger.error('[Sellauth] Sync-Fehler:', err.message);
      throw err;
    }
  },

  // ── Invoice Lookup ──────────────────────────────────────────────────────

  async getInvoice(apiKey, shopId, invoiceId) {
    try {
      const { data } = await this._client(apiKey).get(
        `/shops/${shopId}/invoices/${encodeURIComponent(invoiceId)}`
      );
      return data;
    } catch (err) {
      if (invoiceId.includes('-') && err.response?.status !== 404) {
        const numericId = invoiceId.split('-').pop().replace(/^0+/, '') || '0';
        const { data } = await this._client(apiKey).get(`/shops/${shopId}/invoices/${numericId}`);
        return data;
      }
      throw err;
    }
  },

  formatInvoiceForCustomer(invoice, shopUrl) {
    const checkoutUrl = invoice.unique_id
      ? `${(shopUrl || '').replace(/\/$/, '')}/checkout/${invoice.unique_id}`
      : null;

    const statusMap = {
      completed:  { text: 'Abgeschlossen', emoji: '✅' },
      pending:    { text: 'Offen / Ausstehend', emoji: '⏳' },
      refunded:   { text: 'Erstattet', emoji: '↩️' },
      cancelled:  { text: 'Storniert', emoji: '❌' },
      processing: { text: 'Wird verarbeitet', emoji: '🔄' }
    };
    const status = statusMap[invoice.status] || { text: invoice.status, emoji: '❓' };

    const products = (invoice.items || []).map(item => {
      const pName = item.product?.name || 'Produkt';
      const vName = item.variant?.name || null;
      return vName ? `${pName} - ${vName}` : pName;
    });

    const lines = [
      `Bestellnummer: ${invoice.id}`,
      `Status: ${status.emoji} ${status.text}`,
      '',
      products.length ? `Produkt: ${products.join(', ')}` : '',
      invoice.price   ? `Betrag: ${invoice.price} ${invoice.currency || 'EUR'}` : '',
      invoice.gateway ? `Zahlungsart: ${invoice.gateway}` : '',
      invoice.completed_at
        ? `Abgeschlossen: ${new Date(invoice.completed_at).toLocaleString('de-DE')}`
        : '',
    ].filter(Boolean);

    if (checkoutUrl) {
      lines.push('');
      if (invoice.status === 'completed') {
        lines.push('Deine eSIM und Bestelldetails:');
      } else if (invoice.status === 'pending') {
        lines.push('Zahlung noch offen - bezahle hier:');
      } else {
        lines.push('Bestellseite:');
      }
      lines.push(checkoutUrl);
    }

    return lines.join('\n');
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
