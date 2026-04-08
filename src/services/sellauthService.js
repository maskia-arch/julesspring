const axios = require('axios');
const { sellauth } = require('../config/env');
const supabase = require('../config/supabase');
const embeddingService = require('./embeddingService');

const sellauthService = {
  async fetchProducts() {
    try {
      const response = await axios.get('https://api.sellauth.com/v1/products', {
        headers: {
          'Authorization': `Bearer ${sellauth.apiKey}`,
          'Accept': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Sellauth API Fetch Error:', error.response?.data || error.message);
      throw new Error('Produkte konnten nicht von Sellauth geladen werden.');
    }
  },

  async syncProductsToKnowledge() {
    try {
      const products = await this.fetchProducts();
      const syncResults = [];

      for (const product of products) {
        const content = `Produkt: ${product.name}\nBeschreibung: ${product.description}\nPreis: ${product.price} ${product.currency}\nLink: ${product.url}`;
        
        const embedding = await embeddingService.createEmbedding(content);

        const { data, error } = await supabase
          .from('knowledge_base')
          .upsert({
            source: 'sellauth',
            external_id: product.id.toString(),
            content: content,
            embedding: embedding,
            metadata: { 
              name: product.name, 
              price: product.price,
              stock: product.stock_status 
            },
            updated_at: new Date()
          }, { onConflict: 'external_id' });

        if (error) throw error;
        syncResults.push(product.name);
      }

      return syncResults;
    } catch (error) {
      console.error('Sellauth Sync Error:', error.message);
      throw error;
    }
  }
};

module.exports = sellauthService;
