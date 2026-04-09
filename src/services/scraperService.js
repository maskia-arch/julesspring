const axios = require('axios');
const cheerio = require('cheerio');
const textSplitter = require('../utils/textSplitter');

// Realistische Browser-Header für maximale Kompatibilität
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Connection': 'keep-alive'
};

// HTTP-GET mit Retry-Logik (3 Versuche, exponentielles Backoff)
async function fetchWithRetry(url, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          ...BROWSER_HEADERS,
          'Referer': new URL(url).origin + '/'
        },
        maxRedirects: 5,
        // validateStatus akzeptiert alles außer 4xx/5xx für bessere Fehlermeldungen
        validateStatus: (status) => status < 400
      });

      return response;
    } catch (error) {
      lastError = error;

      // Bei 503 (Cloudflare/Überlastung): warten und wiederholen
      const status = error.response?.status;
      if (status === 503 || status === 429) {
        const waitMs = (attempt + 1) * 2000; // 2s, 4s, 6s
        console.warn(`[Scraper] ${url} → ${status}, Versuch ${attempt + 1}/${maxRetries}. Warte ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Andere Fehler sofort weitergeben
      break;
    }
  }

  // Fehler-Kategorisierung für bessere Fehlermeldungen
  const status = lastError?.response?.status;
  if (status === 503) {
    throw new Error(`Die Seite ist durch Cloudflare oder einen anderen Schutz gesichert (503). Versuche es später erneut oder gib den Inhalt manuell ein.`);
  }
  if (status === 403) {
    throw new Error(`Zugriff verweigert (403). Die Seite blockiert automatische Anfragen.`);
  }
  if (status === 404) {
    throw new Error(`Seite nicht gefunden (404): ${url}`);
  }
  if (lastError?.code === 'ECONNABORTED' || lastError?.code === 'ETIMEDOUT') {
    throw new Error(`Zeitüberschreitung beim Laden von ${url}. Die Seite antwortet zu langsam.`);
  }

  throw new Error(`Seite nicht erreichbar: ${lastError?.message || 'Unbekannter Fehler'}`);
}

const scraperService = {

  // Links auf einer Seite finden
  async discoverLinks(baseUrl) {
    const targetUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;

    const response = await fetchWithRetry(targetUrl);
    const $ = cheerio.load(response.data);
    const links = new Set();
    const urlObj = new URL(targetUrl);

    // Basis-URL selbst immer einschließen
    links.add(targetUrl);

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      try {
        const resolved = new URL(href, targetUrl);
        // Nur interne Links, keine Binärdateien
        if (
          resolved.hostname === urlObj.hostname &&
          !resolved.pathname.match(/\.(jpg|jpeg|png|gif|pdf|zip|mp4|svg|ico|webp)$/i)
        ) {
          resolved.hash = '';
          links.add(resolved.href);
        }
      } catch (_) {}
    });

    return Array.from(links).slice(0, 40);
  },

  // Einzelne URL scrapen
  async scrapeUrl(url) {
    const response = await fetchWithRetry(url);
    const $ = cheerio.load(response.data);

    // Störende Elemente entfernen
    $('script, style, nav, footer, header, noscript, iframe, aside, .cookie-banner, .popup, .modal, [role="banner"], [role="navigation"]').remove();

    const title = $('title').text().trim() || url;

    // Wichtigsten Inhalt extrahieren (Priorität: main > article > spezifische Klassen > body)
    let content = '';
    const selectors = ['main', 'article', '[role="main"]', '.content', '.post-content', '.entry-content', '#content', 'body'];
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        content = el.text().replace(/\s+/g, ' ').trim();
        if (content.length > 200) break;
      }
    }

    if (!content || content.length < 100) {
      throw new Error(`Kein verwertbarer Inhalt auf ${url} gefunden.`);
    }

    const chunks = textSplitter.split(content, 1000);
    return { url, title, chunks };
  },

  // Mehrere URLs scrapen (Fehler werden einzeln abgefangen)
  async processMultipleUrls(urls) {
    const results = [];
    for (const url of urls) {
      try {
        console.log(`[Scraper] Verarbeite: ${url}`);
        const data = await this.scrapeUrl(url);
        results.push(data);
        // Kurze Pause zwischen Anfragen um nicht als Bot erkannt zu werden
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.warn(`[Scraper] Überspringe ${url}: ${e.message}`);
        // Fehler für einzelne URL nicht fatal – weiter mit nächster
      }
    }
    return results;
  }
};

module.exports = scraperService;
