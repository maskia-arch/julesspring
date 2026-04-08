const axios = require('axios');
const { deepseek } = require('../config/env');

const embeddingService = {
  async createEmbedding(text) {
    try {
      const cleanText = text.replace(/\n/g, ' ');
      
      // Hinweis: Falls du OpenAI nutzt, hier 'https://api.openai.com/v1/embeddings'
      // Wenn du DeepSeek-kompatible Proxies nutzt, entsprechend anpassen.
      const response = await axios.post('https://api.openai.com/v1/embeddings', {
        input: cleanText,
        model: 'text-embedding-3-small'
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      return response.data.data[0].embedding;
    } catch (error) {
      console.error('Embedding Error:', error.response?.data || error.message);
      // Fallback: Ein leerer Vektor oder Fehler werfen
      throw new Error('Fehler bei der Vektor-Generierung');
    }
  },

  async createEmbeddingsForChunks(chunks) {
    const embeddings = [];
    for (const chunk of chunks) {
      const vector = await this.createEmbedding(chunk);
      embeddings.push({
        content: chunk,
        embedding: vector
      });
    }
    return embeddings;
  }
};

module.exports = embeddingService;
