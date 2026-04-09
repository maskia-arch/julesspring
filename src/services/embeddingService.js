const axios = require('axios');

const embeddingService = {
  async createEmbedding(text) {
    try {
      const cleanText = text.replace(/\n/g, ' ').substring(0, 8000);

      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          input: cleanText,
          model: 'text-embedding-3-small'
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      return response.data.data[0].embedding;
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      console.error('Embedding Error:', msg);
      throw new Error(`Embedding-Generierung fehlgeschlagen: ${msg}`);
    }
  },

  async createEmbeddingsForChunks(chunks) {
    const results = [];
    for (const chunk of chunks) {
      const embedding = await this.createEmbedding(chunk);
      results.push({ content: chunk, embedding });
    }
    return results;
  }
};

module.exports = embeddingService;
