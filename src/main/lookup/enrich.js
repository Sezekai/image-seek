'use strict';
// Reads booru posts directly for clean series / character / artist tags and the full-size dimensions.
const cache = new Map();

function tagList(s) {
  return String(s || '').split(/\s+/).filter(Boolean).map(prettyTag);
}

function prettyTag(t) {
  return t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

async function danbooru(fetchImpl, id) {
  const key = 'd' + id;
  if (cache.has(key)) return cache.get(key);
  const res = await fetchImpl(`https://danbooru.donmai.us/posts/${id}.json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Danbooru ' + res.status);
  const p = await res.json();
  const out = {
    site: 'Danbooru',
    url: `https://danbooru.donmai.us/posts/${id}`,
    series: tagList(p.tag_string_copyright),
    characters: tagList(p.tag_string_character),
    artists: tagList(p.tag_string_artist),
    width: p.image_width || null,
    height: p.image_height || null,
    fileSize: p.file_size || null,
    fileUrl: p.file_url || p.large_file_url || null,
    ext: p.file_ext || null,
    rating: p.rating || null,
    source: p.source || null,
  };
  cache.set(key, out);
  return out;
}

async function moebooru(fetchImpl, host, id) {
  const key = host + id;
  if (cache.has(key)) return cache.get(key);
  const res = await fetchImpl(`https://${host}/post.json?tags=id:${id}`);
  if (!res.ok) throw new Error(host + ' ' + res.status);
  const arr = await res.json();
  const p = arr && arr[0];
  if (!p) return null;
  const out = {
    site: host === 'yande.re' ? 'Yande.re' : 'Konachan',
    url: `https://${host}/post/show/${id}`,
    width: p.width || null,
    height: p.height || null,
    fileSize: p.file_size || null,
    fileUrl: p.file_url || null,
    source: p.source || null,
  };
  cache.set(key, out);
  return out;
}

// Adds booru details to each result that carries a known post id. Failures are ignored.
async function enrichResults(fetchImpl, results) {
  const jobs = [];
  for (const r of results) {
    const ids = r.ids || {};
    let p = null;
    if (ids.danbooru) p = danbooru(fetchImpl, ids.danbooru);
    else if (ids.yandere) p = moebooru(fetchImpl, 'yande.re', ids.yandere);
    else if (ids.konachan) p = moebooru(fetchImpl, 'konachan.com', ids.konachan);
    if (!p) continue;
    jobs.push(p.then((info) => {
      if (!info) return;
      r.booru = info;
      if (info.width && !r.width) { r.width = info.width; r.height = info.height; }
      if (info.source && /^https?:/.test(info.source) && !(r.links || []).includes(info.source)) {
        r.links = [...(r.links || []), info.source];
      }
    }).catch(() => {}));
    if (jobs.length >= 6) break;
  }
  await Promise.all(jobs);
  return results;
}

module.exports = { enrichResults, prettyTag };
