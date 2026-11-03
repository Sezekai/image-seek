'use strict';
const { multipart } = require('./multipart');

class LimitError extends Error {
  constructor(kind, message) { super(message); this.limit = kind; }
}

// Map SauceNAO index ids to friendly site names when index_name is noisy.
function siteName(header) {
  const n = String(header.index_name || '');
  const m = n.match(/^Index #\d+:\s*(.+?)(?:\s*-\s*[\w.\-]+\.\w+)?$/);
  return (m ? m[1] : n).replace(/\s*\(.*?\)\s*$/, '').trim() || 'SauceNAO';
}

function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(splitList);
  return String(v).split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
}

function normalizeResult(r) {
  const h = r.header || {};
  const d = r.data || {};
  const links = [...(d.ext_urls || [])];
  if (d.source && /^https?:\/\//.test(d.source) && !links.includes(d.source)) links.push(d.source);
  const artists = [
    ...splitList(d.creator), ...splitList(d.member_name), ...splitList(d.author_name),
    ...splitList(d.twitter_user_handle ? '@' + d.twitter_user_handle : null), ...splitList(d.artist),
  ];
  const out = {
    engine: 'saucenao',
    site: siteName(h),
    similarity: parseFloat(h.similarity) || 0,
    thumbnail: h.thumbnail || null,
    title: d.title || d.eng_name || d.jp_name || d.source && !/^https?:/.test(d.source) && d.source || '',
    links,
    url: links[0] || null,
    artists: [...new Set(artists)],
    series: splitList(d.material),
    characters: splitList(d.characters),
    ids: {},
  };
  for (const k of ['danbooru_id', 'gelbooru_id', 'yandere_id', 'konachan_id', 'sankaku_id', 'pixiv_id', 'tweet_id', 'anidb_aid', 'mal_id']) {
    if (d[k]) out.ids[k.replace(/_id$/, '')] = d[k];
  }
  if (d.part) out.episode = d.part;
  if (d.est_time) out.timestamp = d.est_time;
  if (d.year) out.year = d.year;
  if (h.hidden) out.hidden = true;
  return out;
}

async function search(fetchImpl, key, image, opts = {}) {
  if (!key) throw new Error('No SauceNAO API key set (Settings → Lookups).');
  const params = new URLSearchParams({ output_type: '2', numres: '16', db: '999', api_key: key, hide: '0' });
  const form = multipart([{ name: 'file', filename: image.filename, contentType: image.mime, data: image.buffer }]);
  const res = await fetchImpl('https://saucenao.com/search.php?' + params, {
    method: 'POST', headers: { 'Content-Type': form.contentType }, body: form.body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html error page */ }
  const header = (json && json.header) || {};
  const quota = {
    short: header.short_remaining != null ? +header.short_remaining : null,
    long: header.long_remaining != null ? +header.long_remaining : null,
    shortLimit: header.short_limit != null ? +header.short_limit : null,
    longLimit: header.long_limit != null ? +header.long_limit : null,
    at: Date.now(),
  };
  if (res.status === 429 || (header.status != null && header.status < 0 && /limit/i.test(header.message || text))) {
    const daily = /daily|24 ?h/i.test(header.message || text) || quota.long === 0;
    throw Object.assign(new LimitError(daily ? 'long' : 'short', daily ? 'SauceNAO daily limit reached' : 'SauceNAO 30-second limit reached'), { quota });
  }
  if (res.status === 403) throw new Error('SauceNAO rejected the API key (check it in Settings).');
  if (!json) throw new Error(`SauceNAO error ${res.status}`);
  // status > 0 means some of SauceNAO's indexes failed; the rest of the results are still usable.
  if (header.status > 0 && !(json.results || []).length) throw new Error('SauceNAO: ' + (header.message || 'server error').replace(/<[^>]+>/g, ''));
  if (header.status < 0) throw new Error('SauceNAO: ' + (header.message || 'bad request').replace(/<[^>]+>/g, ''));
  const results = (json.results || []).map(normalizeResult);
  return { results, quota };
}

module.exports = { search, LimitError, normalizeResult };
