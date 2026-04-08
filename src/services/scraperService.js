const axios = require('axios');
const cheerio = require('cheerio');
const textSplitter = require('../utils/textSplitter');

const scraperService = {
  async scrapeUrl(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (AI Business Bot)' }
      });

      const $ = cheerio.load(response.data);

      // Entferne störende Elemente, die kein Wissen enthalten
      $('script, style, nav, footer, header, noscript, iframe').remove();

      // Extrahiere Text aus dem Body oder spezifischen Content-Areas
      const title = $('title').text().trim();
      const content = $('body').text()
        .replace(/\s+/g, ' ')
        .trim();

      // Den Text in handliche Stücke (Chunks) unterteilen
      const chunks = textSplitter.split(content, 1000);

      return {
        url,
        title,
        chunks
      };
    } catch (error) {
      console.error(`Scraping failed for ${url}:`, error.message);
      throw new Error(`Konnte Inhalt von ${url} nicht lesen.`);
    }
  },

  async processMultipleUrls(urls) {
    const results = [];
    for (const url of urls) {
      try {
        const data = await this.scrapeUrl(url);
        results.push(data);
      } catch (e) {
        console.warn(`Skipping ${url} due to error.`);
      }
    }
    return results;
  }
};

module.exports = scraperService;
