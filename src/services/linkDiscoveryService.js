const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const linkDiscoveryService = {
  async findInternalLinks(baseUrl) {
    try {
      const response = await axios.get(baseUrl, { 
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (AI Business Bot)' }
      });
      
      const $ = cheerio.load(response.data);
      const mainDomain = new URL(baseUrl).hostname;
      const links = new Set();

      $('a').each((_, element) => {
        const href = $(element).attr('href');
        if (!href) return;

        try {
          const absoluteUrl = new URL(href, baseUrl);
          
          // Nur interne Links der gleichen Domain zulassen
          // Keine Anker (#) oder Mailtos/Tel-Links
          if (
            absoluteUrl.hostname === mainDomain && 
            !absoluteUrl.pathname.match(/\.(jpg|jpeg|png|gif|pdf|zip)$/i) &&
            absoluteUrl.protocol.startsWith('http')
          ) {
            links.add(absoluteUrl.origin + absoluteUrl.pathname);
          }
        } catch (e) {
          // Ungültige URL ignorieren
        }
      });

      return Array.from(links).sort();
    } catch (error) {
      console.error(`Link Discovery Error for ${baseUrl}:`, error.message);
      throw new Error('Die Webseite konnte nicht erreicht werden.');
    }
  },

  async getMetadata(url) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      const $ = cheerio.load(response.data);
      return {
        url,
        title: $('title').text() || url,
        description: $('meta[name="description"]').attr('content') || ''
      };
    } catch (e) {
      return { url, title: url, description: '' };
    }
  }
};

module.exports = linkDiscoveryService;
