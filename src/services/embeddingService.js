const axios = require('axios');

const embeddingService = {
  async createEmbedding(text) {
    if (!text || typeof text !== 'string') return null;
    
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
          timeout: 20000
        }
      );

      if (!response.data?.data?.[0]?.embedding) return null;

      return {
        embedding: response.data.data[0].embedding,
        tokens:    response.data.usage?.total_tokens || 0
      };
    } catch (error) {
      const msg = error.response?.data?.error?.message || error.message;
      console.error('Embedding Error:', msg);
      return null;
    }
  },

  async createEmbeddingsForChunks(chunks) {
    const results = [];
    for (const chunk of chunks) {
      const res = await this.createEmbedding(chunk);
      if (res) results.push({ content: chunk, embedding: res.embedding });
    }
    return results;
  }
};

module.exports = embeddingService;
