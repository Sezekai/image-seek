'use strict';
// ascii2d.net — good for Pixiv and X/Twitter originals. Runs in the browser session so any
// Cloudflare clearance you got while browsing ascii2d is reused.
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

async function search(fetchImpl, image) {
  const form = multipart([
    { name: 'utf8', value: '✓' },
    { name: 'file', filename: image.filename, contentType: image.mime, data: image.buffer },
  ]);
  const res = await fetchImpl(BASE + '/search/file', {
    method: 'POST',
    headers: { 'Content-Type': form.contentType, Referer: BASE + '/' },
    body: form.body,
  });
  const html = await res.text();
  if (res.status === 403 || res.status === 503 || /cf-chl|challenge-platform|Just a moment/i.test(html)) {
    throw new BlockedError('ascii2d showed a Cloudflare check. Open ascii2d in the browser once, then retry.');
  }
  if (!res.ok) throw new Error('ascii2d error ' + res.status);
  const colorUrl = res.url;
  const results = parse(html, 'color').slice(0, 10);
  // Feature (bovw) search finds crops and edits that colour search misses.
  let bovw = [];
  if (/\/search\/color\//.test(colorUrl)) {
    try {
      const r2 = await fetchImpl(colorUrl.replace('/color/', '/bovw/'), { headers: { Referer: colorUrl } });
      if (r2.ok) bovw = parse(await r2.text(), 'bovw').slice(0, 6);
    } catch (_) { /* optional */ }
  }
  const seen = new Set(results.map((r) => r.url));
  for (const b of bovw) if (!seen.has(b.url)) results.push(b);
  return { results, pageUrl: colorUrl };
}

module.exports = { search, parse, BlockedError };
