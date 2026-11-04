'use strict';
const { multipart, decodeEntities, absUrl } = require('./multipart');

const SERVICES = ['1', '2', '3', '4', '5', '6', '11', '13']; // danbooru konachan yande.re gelbooru sankaku e-shuushuu zerochan anime-pictures

function parse(html) {
  const out = [];
  const pagesIdx = html.search(/id=['"]pages['"]/);
  const body = pagesIdx >= 0 ? html.slice(pagesIdx) : html;
  const tables = body.split(/<table[^>]*>/i).slice(1);
  for (const raw of tables) {
    const t = raw.split(/<\/table>/i)[0];
    if (/Your image/i.test(t) || /No relevant matches/i.test(t)) continue;
    const href = (t.match(/<a href=['"]([^'"]+)['"][^>]*>\s*<img/i) || [])[1];
    if (!href) continue;
    const imgTag = (t.match(/<a href=['"][^'"]+['"][^>]*>\s*(<img[^>]*>)/i) || [])[1] || '';
    const img = [null, (imgTag.match(/src=['"]([^'"]+)['"]/i) || [])[1], (imgTag.match(/alt=['"]([^'"]*)['"]/i) || [])[1]];
    const alt = decodeEntities(img[2] || '');
    const cells = [...t.matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/gi)].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
    const simCell = cells.find((c) => /% similarity/i.test(c)) || '';
    const dimCell = cells.find((c) => /^\d+\s*[×x]\s*\d+/.test(c)) || '';
    const siteCell = cells.find((c) => /^[A-Za-z][\w.\- ]+$/.test(c) && !/match/i.test(c)) || '';
    const dims = dimCell.match(/(\d+)\s*[×x]\s*(\d+)/);
    const rating = (dimCell.match(/\[(\w+)\]/) || [])[1] || null;
    const tags = (alt.match(/Tags:\s*(.*)$/i) || [])[1] || '';
    const url = absUrl(href, 'https://iqdb.org/');
    out.push({
      engine: 'iqdb',
      site: siteCell || hostLabel(url),
      similarity: parseFloat(simCell) || 0,
      thumbnail: img[1] ? absUrl(img[1], 'https://iqdb.org/') : null,
      url,
      links: [url],
      width: dims ? +dims[1] : null,
      height: dims ? +dims[2] : null,
      rating,
      tags: tags.split(/\s+/).filter(Boolean).slice(0, 60),
      best: /Best match/i.test(t),
      ids: idsFromUrl(url),
    });
  }
  return out;
}

function hostLabel(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'IQDB'; }
}

function idsFromUrl(u) {
  const ids = {};
  let m;
  if ((m = u.match(/danbooru\.donmai\.us\/posts\/(\d+)/))) ids.danbooru = +m[1];
  else if ((m = u.match(/yande\.re\/post\/show\/(\d+)/))) ids.yandere = +m[1];
  else if ((m = u.match(/konachan\.com\/post\/show\/(\d+)/))) ids.konachan = +m[1];
  else if ((m = u.match(/gelbooru\.com\/.*[?&]id=(\d+)/))) ids.gelbooru = +m[1];
  return ids;
}

class BusyError extends Error {}

function pageText(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function search(fetchImpl, image) {
  const fields = [{ name: 'MAX_FILE_SIZE', value: '8388608' }];
  for (const s of SERVICES) fields.push({ name: 'service[]', value: s });
  fields.push({ name: 'file', filename: image.filename, contentType: image.mime, data: image.buffer });
  const form = multipart(fields);
  const res = await fetchImpl('https://iqdb.org/', { method: 'POST', headers: { 'Content-Type': form.contentType }, body: form.body });
  const html = await res.text();
  const hasPages = /id=['"]pages['"]/.test(html);
  const text = pageText(html);
  // IQDB sometimes answers with a "heavy load, you are in the queue" page instead of results.
  if (res.status === 429 || res.status === 503 || res.status === 502 || (!hasPages && /heavy load|in (the )?queue|queue position|overload|too many|try again (later|in)|busy/i.test(text))) {
    throw new BusyError('IQDB is under heavy load — will try again later');
  }
  if (!res.ok) throw new Error(`IQDB error ${res.status}`);
  if (!hasPages) {
    if (/too large|not an image|can.?t read|invalid|unsupported|no file/i.test(text)) throw new Error('IQDB could not read the image (' + text.slice(0, 120) + ')');
    throw new BusyError('IQDB returned an unexpected page — will try again later');
  }
  return { results: parse(html) };
}

module.exports = { search, parse, idsFromUrl, BusyError };
