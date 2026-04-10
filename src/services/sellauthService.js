/**
 * sellauthService.js v1.1.12
 *
 * Neu: Importiert zusätzlich zu Produkten auch:
 * - Blog-Posts (FAQ, Refund Policy, Anleitungen, etc.)
 * - Shop-Kategorien (mit Beschreibungen)
 * - Produktgruppen
 * 
 * Sync läuft mit Job-Fortschritt (syncJobManager)
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

  // ─── API-Abruf-Hilfsfunktionen ────────────────────────────────────────────

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
      const client = this._client(apiKey);
      const all = [];
      let page = 1, lastPage = 1;
      do {
        const { data } = await client.get(`/shops/${shopId}/categories`, {
          params: { page, perPage: 100 }
        });
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

  // ─── URL & Stock ──────────────────────────────────────────────────────────

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

  // ─── Format-Funktionen ────────────────────────────────────────────────────

  formatVariantKnowledge(product, variant, productUrl, categoryName) {
    const price = variant.price ? `${variant.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(variant.stock);
    return [
      `Produkt: ${product.name}`,
      `Option: ${variant.name}`,
      price ? `Preis: ${price}` : '',
      `Status: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      product.description ? `Info: ${product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400)}` : '',
      '',
      `Empfehlung: ${variant.name}${price ? ' für ' + price : ''} - Kauflink: ${productUrl}`
    ].filter(l => l !== null && l !== undefined && l !== '').join('\n');
  },

  formatSingleProductKnowledge(product, productUrl, categoryName) {
    const price = product.price ? `${product.price} ${product.currency || 'EUR'}` : null;
    const { display: stockDisplay } = this._stockInfo(product.stock_count);
    return [
      `Produkt: ${product.name}`,
      price ? `Preis: ${price}` : '',
      `Status: ${stockDisplay}`,
      `Kauflink: ${productUrl}`,
      categoryName ? `Kategorie: ${categoryName}` : '',
      product.description ? `Info: ${product.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 400)}` : '',
      '',
      `Kauflink: ${productUrl}`
    ].filter(Boolean).join('\n');
  },

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
      '', 'Verfügbare Optionen:', variantLines,
      '', `Kauflink: ${productUrl}`
    ].filter(Boolean).join('\n');
  },

  formatBlogPostKnowledge(post, shopUrl, fullContent) {
    const postUrl = `${shopUrl.replace(/\/$/, '')}/blog/${post.path}`;
    const clean = (text) => (text || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return [
      `Artikel: ${post.title}`,
      post.summary ? `Zusammenfassung: ${clean(post.summary)}` : '',
      fullContent ? `Inhalt: ${clean(fullContent).substring(0, 2000)}` : '',
      `Link: ${postUrl}`,
    ].filter(Boolean).join('\n');
  },

  formatCategoryKnowledge(category, shopUrl) {
    const catUrl = `${shopUrl.replace(/\/$/, '')}/category/${category.path}`;
    return [
      `Kategorie: ${category.name}`,
      category.description ? `Beschreibung: ${category.description.replace(/<[^>]*>/g, '').trim()}` : '',
      `Link: ${catUrl}`,
    ].filter(Boolean).join('\n');
  },

  // ─── Bereinigung ──────────────────────────────────────────────────────────

  async _cleanupOldEntries() {
    const sources = ['sellauth_sync', 'sellauth', 'sellauth_import', 'sellauth_blog', 'sellauth_category'];
    for (const src of sources) {
      await supabase.from('knowledge_base').delete().eq('source', src);
    }
    logger.info('[Sellauth] Alle alten Einträge bereinigt');
  },

  // ─── Kategorie-ID für Wissens-DB ─────────────────────────────────────────

  async _getKbCategoryId(name) {
    try {
      const { data } = await supabase.from('knowledge_categories').select('id').eq('name', name).single();
      return data?.id || null;
    } catch { return null; }
  },

  // ─── HAUPT-SYNC (mit Job-Fortschritt) ────────────────────────────────────

  async syncToKnowledgeBase(apiKey, shopId, shopUrl, jobId) {
    const results = { total: 0, saved: 0, blogPosts: 0, categories: 0, errors: [] };

    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Sellauth] ${pct}% – ${step}`);
    };

    try {
      // ── 1. Alle Daten parallel laden ───────────────────────────────────
      progress(5, 'Lade Produktdaten von Sellauth...');

      const [products, saCategories, blogPosts, groups] = await Promise.all([
        this.getAllProducts(apiKey, shopId),
        this.getCategories(apiKey, shopId),
        this.getBlogPosts(apiKey, shopId),
        this.getGroups(apiKey, shopId)
      ]);

      results.total = products.length;
      progress(12, `${products.length} Produkte, ${blogPosts.length} Blog-Posts, ${saCategories.length} Kategorien geladen`);

      // ── 2. Alte Einträge bereinigen ────────────────────────────────────
      progress(15, 'Bereinige alte Einträge...');
      await this._cleanupOldEntries();

      // ── 3. Kategorie-IDs für Wissens-DB ───────────────────────────────
      const kbCatProduct  = await this._getKbCategoryId('Sellauth Import');
      const kbCatBlog     = await this._getKbCategoryId('FAQ');
      const kbCatGeneral  = await this._getKbCategoryId('Allgemein');

      // ── 4. PRODUKTE ────────────────────────────────────────────────────
      progress(18, 'Importiere Produkte...');
      let processed = 0;

      for (const product of products) {
        if (product.visibility === 'hidden') continue;

        const cat        = saCategories.find(c => c.id === product.category_id);
        const catName    = cat?.name || null;
        const productUrl = this.buildProductUrl(shopUrl, product.path);

        try {
          if (product.type === 'variant' && product.variants?.length) {
            for (const variant of product.variants) {
              const content   = this.formatVariantKnowledge(product, variant, productUrl, catName);
              const embedding = await deepseekService.generateEmbedding(content);
              await supabase.from('knowledge_base').insert([{
                content, embedding,
                title:       `${product.name} – ${variant.name}`,
                source:      'sellauth_sync',
                category_id: kbCatProduct,
                metadata:    { product_id: product.id, variant_id: variant.id, product_url: productUrl, price: variant.price, currency: product.currency, stock: variant.stock, type: 'variant' }
              }]);
              results.saved++;
              await new Promise(r => setTimeout(r, 150));
            }
            // Übersichts-Eintrag
            const ov  = this.formatOverviewKnowledge(product, productUrl, catName);
            const emb = await deepseekService.generateEmbedding(ov);
            await supabase.from('knowledge_base').insert([{
              content: ov, embedding: emb,
              title: `${product.name} (Übersicht)`,
              source: 'sellauth_sync', category_id: kbCatProduct,
              metadata: { product_id: product.id, product_url: productUrl, type: 'overview' }
            }]);
            await new Promise(r => setTimeout(r, 150));
          } else {
            const content   = this.formatSingleProductKnowledge(product, productUrl, catName);
            const embedding = await deepseekService.generateEmbedding(content);
            await supabase.from('knowledge_base').insert([{
              content, embedding,
              title: product.name, source: 'sellauth_sync', category_id: kbCatProduct,
              metadata: { product_id: product.id, product_url: productUrl, price: product.price, currency: product.currency, type: 'single' }
            }]);
            results.saved++;
            await new Promise(r => setTimeout(r, 150));
          }
        } catch (err) {
          results.errors.push(`Produkt ${product.name}: ${err.message}`);
          logger.warn(`[Sellauth] ✗ ${product.name}: ${err.message}`);
        }

        processed++;
        // Fortschritt: 18% bis 65% für Produkte
        const pct = 18 + Math.floor((processed / products.length) * 47);
        progress(pct, `Produkt ${processed}/${products.length}: ${product.name}`);
      }

      // ── 5. SHOP-KATEGORIEN ─────────────────────────────────────────────
      progress(68, `Importiere ${saCategories.length} Shop-Kategorien...`);
      for (const cat of saCategories) {
        if (!cat.description && !cat.name) continue;
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

      // ── 6. BLOG-POSTS (FAQ, Refund Policy, etc.) ──────────────────────
      if (blogPosts.length > 0) {
        progress(75, `Importiere ${blogPosts.length} Blog-Posts/Artikel...`);
        let blogIdx = 0;

        for (const post of blogPosts) {
          try {
            // Vollständigen Blog-Post-Inhalt laden
            const detail      = await this.getBlogPostDetail(apiKey, shopId, post.id);
            const fullContent = detail?.content || post.summary || '';
            const content     = this.formatBlogPostKnowledge(post, shopUrl, fullContent);
            const embedding   = await deepseekService.generateEmbedding(content);

            // Bestmögliche KB-Kategorie wählen
            const title = (post.title || '').toLowerCase();
            let catId = kbCatBlog; // FAQ als Standard
            if (title.includes('refund') || title.includes('rückgabe') || title.includes('erstattung')) {
              catId = await this._getKbCategoryId('Support') || kbCatBlog;
            } else if (title.includes('anleitung') || title.includes('guide') || title.includes('how to') || title.includes('setup')) {
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
            progress(75 + Math.floor((blogIdx / blogPosts.length) * 20), `Blog-Post: ${post.title}`);
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
