const axios = require('axios');
const cheerio = require('cheerio');
const textSplitter = require('../utils/textSplitter');

const scraperService = {
  async discoverLinks(baseUrl) {
    try {
      const targetUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
      const response = await axios.get(targetUrl, {
        timeout: 10000,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        }
      });
      
      const $ = cheerio.load(response.data);
      const links = new Set();
      const urlObj = new URL(targetUrl);

      $('a').each((_, el) => {
        let href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        try {
          const resolvedUrl = new URL(href, targetUrl);
          if (resolvedUrl.hostname === urlObj.hostname) {
            resolvedUrl.hash = '';
            links.add(resolvedUrl.href);
          }
        } catch (e) {}
      });

      return Array.from(links).slice(0, 30);
    } catch (error) {
      console.error(`Link Discovery Error für ${baseUrl}:`, error.message);
      throw new Error(`Seite nicht erreichbar: ${error.message}`);
    }
  },

  async scrapeUrl(url) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
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
