'use strict';
// ascii2d.net — good for Pixiv and X/Twitter originals.
const { multipart, decodeEntities, absUrl } = require('./multipart');

const BASE = 'https://ascii2d.net';

class BlockedError extends Error {}

function strip(s) { return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }

function parse(html, mode) {
  const out = [];
  const boxes = html.split(/<div class=['"]row item-box['"]>/i).slice(1);
  boxes.forEach((raw, idx) => {
    const box = raw.split(/<div class=['"]row item-box['"]>/i)[0];
    const img = (box.match(/<img[^>]+src=['"]([^'"]+)['"]/i) || [])[1];
    const detail = strip((box.match(/<small[^>]*>([\s\S]*?)<\/small>/i) || [])[1]);
    const infoIdx = box.search(/class=['"]detail-box gray-link['"]/i);
    const info = infoIdx >= 0 ? box.slice(infoIdx) : '';
    const links = [...info.matchAll(/<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: absUrl(m[1], BASE), text: strip(m[2]) }))
      .filter((l) => /^https?:/.test(l.href) && !/ascii2d\.net\/(search|details)/.test(l.href));
    if (!links.length) return; // the first box is your own image
    const srcLabel = [...info.matchAll(/<small[^>]*>([\s\S]*?)<\/small>/gi)].map((m) => strip(m[1])).find((t) => /^(pixiv|twitter|x|fanbox|fantia|niconico|ニコニコ静画|tinami|nijie|danbooru|gelbooru)$/i.test(t));
    const dims = detail.match(/(\d+)\s*x\s*(\d+)/i);
    const work = links[0];
    const author = links[1] && /users|member|twitter\.com\/[^/]+$|x\.com\/[^/]+$|fanbox/.test(links[1].href) ? links[1] : null;
    out.push({
      engine: 'ascii2d',
      mode,
      site: srcLabel || hostLabel(work.href),
      similarity: null, // ascii2d doesn't score matches; keep its order
      rank: idx,
      thumbnail: img ? absUrl(img, BASE) : null,
      title: work.text,
      url: work.href,
      links: links.map((l) => l.href),
      artists: author ? [author.text] : [],
      width: dims ? +dims[1] : null,
      height: dims ? +dims[2] : null,
      detail,
    });
  });
  return out;
}

function hostLabel(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'ascii2d'; }
}

// Runs the search in a hidden page of the app's browser session (the same way the manual
// button does), so Cloudflare's browser check passes and its clearance cookie is reused.
async function search(render, image) {
  const form = multipart([
    { name: 'utf8', value: '✓' },
    { name: 'file', filename: image.filename, contentType: image.mime, data: image.buffer },
  ]);
  const first = await render({
    url: BASE + '/search/file',
    postData: form.body,
    contentType: form.contentType,
    referer: BASE + '/',
    done: (u, html) => /\/search\/(color|bovw)\//.test(u) && /item-box|class=['"]row/i.test(html),
    timeout: 45000,
  });
  if (first.blocked || !/\/search\/color\//.test(first.url)) {
    if (first.blocked || /cf-chl|challenge-platform|Just a moment|turnstile/i.test(first.html)) {
      throw new BlockedError('ascii2d wants a Cloudflare check. Open ascii2d with the button below, pass the check once, then retry.');
    }
    throw new Error('ascii2d returned an unexpected page');
  }
  const results = parse(first.html, 'color').slice(0, 10);
  // Feature (bovw) search finds crops and edits that colour search misses.
  try {
    const second = await render({
      url: first.url.replace('/color/', '/bovw/'),
      referer: first.url,
      done: (u, html) => /\/search\/bovw\//.test(u) && /item-box/i.test(html),
      timeout: 25000,
    });
    if (!second.blocked) {
      const seen = new Set(results.map((r) => r.url));
      for (const b of parse(second.html, 'bovw').slice(0, 6)) if (!seen.has(b.url)) results.push(b);
    }
  } catch (_) { /* optional */ }
  return { results, pageUrl: first.url };
}

module.exports = { search, parse, BlockedError };
