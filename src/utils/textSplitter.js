const textSplitter = {
  split(text, chunkSize = 1000, chunkOverlap = 200) {
    if (!text || typeof text !== 'string') return [];

    const cleanText = text.replace(/\s+/g, ' ').trim();
    const chunks = [];
    let currentIndex = 0;

    while (currentIndex < cleanText.length) {
      let endIndex = currentIndex + chunkSize;

      if (endIndex < cleanText.length) {
        const lastSpace = cleanText.lastIndexOf(' ', endIndex);
        if (lastSpace > currentIndex) {
          endIndex = lastSpace;
        }
      }

      const chunk = cleanText.substring(currentIndex, endIndex).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      currentIndex = endIndex - chunkOverlap;
      
      if (currentIndex >= cleanText.length || chunk.length < 50) {
        if (currentIndex < cleanText.length && chunk.length < 50) {
           currentIndex = cleanText.length;
        } else {
           break;
        }
      }
    }

    return chunks;
  }
};

module.exports = textSplitter;
