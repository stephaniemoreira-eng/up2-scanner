'use strict';

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SCANNER_TOKEN = process.env.SCANNER_TOKEN || '';

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu'
];

// ── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const token = req.headers['x-scanner-token'];
  if (!SCANNER_TOKEN || !token || token !== SCANNER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── scanSite ─────────────────────────────────────────────────────────────────
async function scanSite(browser, site) {
  if (!site) return { error: 'No site provided' };

  let url = site;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 375, height: 812, isMobile: true });
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );

    let http_status = 0;
    const response = await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => null);
    if (response) http_status = response.status();

    const data = await page.evaluate(() => {
      const title = document.title || '';

      const descEl =
        document.querySelector('meta[name="description"]') ||
        document.querySelector('meta[property="og:description"]');
      const description = descEl ? descEl.getAttribute('content') || '' : '';

      const allLinks = Array.from(document.querySelectorAll('a[href]')).map(
        (a) => (a.href || '').toLowerCase()
      );
      const allText = (document.body ? document.body.innerText : '').toLowerCase();

      // WhatsApp
      const has_whatsapp = allLinks.some(
        (h) => h.includes('wa.me') || h.includes('api.whatsapp.com')
      );

      // Instagram — ignora /p/ /reel/ /reels/ /stories/ /explore/ /accounts/ /tv/
      const IG_SKIP = ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv'];
      let instagram_url = '';
      for (const link of allLinks) {
        const m = link.match(/https?:\/\/(?:www\.)?instagram\.com\/([^/?#]+)/);
        if (m && !IG_SKIP.includes(m[1])) {
          instagram_url = 'https://www.instagram.com/' + m[1];
          break;
        }
      }

      // Facebook — ignora botões de compartilhar
      const FB_SKIP = ['sharer', 'share', 'dialog', 'plugins'];
      let facebook_url = '';
      for (const link of allLinks) {
        const m = link.match(/https?:\/\/(?:www\.)?facebook\.com\/([^/?#]+)/);
        if (m && !FB_SKIP.includes(m[1])) {
          facebook_url = 'https://www.facebook.com/' + m[1];
          break;
        }
      }

      // E-commerce
      const ecommerceKw = [
        'carrinho', 'checkout', 'comprar agora', 'loja virtual', 'adicionar ao carrinho'
      ];
      const has_ecommerce = ecommerceKw.some((k) => allText.includes(k));

      // CTA
      const ctaKw = ['agendar', 'contratar', 'começar', 'quero', 'reservar'];
      const has_cta = ctaKw.some((k) => allText.includes(k));

      return { title, description, has_whatsapp, instagram_url, facebook_url, has_ecommerce, has_cta };
    });

    return { ...data, http_status, url };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── scanInstagram ─────────────────────────────────────────────────────────────
async function scanInstagram(browser, igUrl) {
  if (!igUrl) return { error: 'No Instagram URL provided', selo: '🔴' };

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    );
    await page
      .goto(igUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => null);

    const { og_description } = await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:description"]');
      return { og_description: el ? el.getAttribute('content') || '' : '' };
    });

    let followers = 0;
    let posts = 0;

    const followerMatch = og_description.match(/(\d[\d,.]+)\s*[Ff]ollower/);
    if (followerMatch) followers = parseInt(followerMatch[1].replace(/[,.]/g, '')) || 0;

    const postsMatch = og_description.match(/(\d[\d,.]+)\s*[Pp]ost/);
    if (postsMatch) posts = parseInt(postsMatch[1].replace(/[,.]/g, '')) || 0;

    return { followers, posts, og_description, selo: followers > 0 ? '🟡' : '🔴' };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── scanFacebookAds ───────────────────────────────────────────────────────────
async function scanFacebookAds(browser, empresa) {
  if (!empresa) return { has_active_ads: false, ad_count: 0, selo: '🔴' };

  const page = await browser.newPage();
  try {
    const q = encodeURIComponent(empresa);
    const url =
      `https://www.facebook.com/ads/library/?active_status=active&ad_type=all` +
      `&country=BR&q=${q}&search_type=keyword_unordered&media_type=all`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    // Aguarda JS renderizar
    await new Promise((r) => setTimeout(r, 3000));

    const { has_active_ads, ad_count } = await page.evaluate(() => {
      const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
      const has_active_ads =
        !bodyText.includes('no results') &&
        !bodyText.includes('nenhum resultado') &&
        !bodyText.includes('no ads match');

      const cards1 = document.querySelectorAll('[data-testid="ad-archive-renderer"]');
      const cards2 = document.querySelectorAll('._8njr');
      const ad_count = Math.max(cards1.length, cards2.length);

      return { has_active_ads, ad_count };
    });

    return { has_active_ads, ad_count, selo: has_active_ads ? '🟢' : '🔴' };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── POST /scan ────────────────────────────────────────────────────────────────
app.post('/scan', async (req, res) => {
  const { site, empresa, cidade } = req.body || {};
  const errors = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      headless: true,
      args: PUPPETEER_ARGS
    });

    const result = { site: null, instagram: null, facebook_ads: null, errors };

    // 1. Scan site
    try {
      result.site = await scanSite(browser, site);
    } catch (e) {
      errors.push({ scan: 'site', message: e.message });
      result.site = { error: e.message };
    }

    // 2. Scan Instagram (URL detectada no site ou passada diretamente)
    const igUrl = (result.site && result.site.instagram_url) || '';
    try {
      if (igUrl) {
        result.instagram = await scanInstagram(browser, igUrl);
      } else {
        result.instagram = { error: 'No Instagram URL found', followers: 0, posts: 0, selo: '🔴' };
      }
    } catch (e) {
      errors.push({ scan: 'instagram', message: e.message });
      result.instagram = { error: e.message, followers: 0, posts: 0, selo: '🔴' };
    }

    // 3. Scan Facebook Ads
    try {
      result.facebook_ads = await scanFacebookAds(browser, empresa);
    } catch (e) {
      errors.push({ scan: 'facebook_ads', message: e.message });
      result.facebook_ads = { has_active_ads: false, ad_count: 0, error: e.message, selo: '🔴' };
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, errors });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`UP2 Scanner running on port ${PORT}`);
});
