const axios = require('axios');
const cheerio = require('cheerio');
const textSplitter = require('../utils/textSplitter');

const scraperService = {
  async discoverLinks(baseUrl) {
    try {
      const response = await axios.get(baseUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (AI Business Bot)' }
      });
      const $ = cheerio.load(response.data);
      const links = new Set();
      const baseHostname = new URL(baseUrl).hostname;

      $('a').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;

        try {
          const resolvedUrl = new URL(href, baseUrl);
          // Nur Links von der gleichen Domain aufnehmen
          if (resolvedUrl.hostname === baseHostname) {
            // Clean URL (Anker entfernen)
            resolvedUrl.hash = '';
            links.add(resolvedUrl.href);
          }
        } catch (e) {
          // Ungültige URL ignorieren
        }
      });

      return Array.from(links).slice(0, 25);
    } catch (error) {
      console.error(`Link discovery failed for ${baseUrl}:`, error.message);
      throw new Error(`Konnte keine Links auf ${baseUrl} finden.`);
    }
  },

  async scrapeUrl(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (AI Business Bot)' }
      });

      const $ = cheerio.load(response.data);
      $('script, style, nav, footer, header, noscript, iframe').remove();

      const title = $('title').text().trim();
      const content = $('main, article, .content, body').text()
        .replace(/\s+/g, ' ')
        .trim();

      const chunks = textSplitter.split(content, 1000);

      return { url, title, chunks };
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
