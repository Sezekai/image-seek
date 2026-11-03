'use strict';
// trace.moe — identifies anime screenshots (series, episode, timestamp).
const { multipart } = require('./multipart');

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function search(fetchImpl, image) {
  const form = multipart([{ name: 'image', filename: image.filename, contentType: image.mime, data: image.buffer }]);
  const res = await fetchImpl('https://api.trace.moe/search?cutBorders&anilistInfo', {
    method: 'POST', headers: { 'Content-Type': form.contentType }, body: form.body,
  });
  if (res.status === 402 || res.status === 429) {
    const e = new Error('trace.moe quota reached for now');
    e.limit = 'long';
    throw e;
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('trace.moe error ' + res.status);
  if (json.error) throw new Error('trace.moe: ' + json.error);
  const seen = new Set();
  const results = [];
  for (const r of json.result || []) {
    const a = r.anilist || {};
    const t = (a.title && (a.title.english || a.title.romaji || a.title.native)) || r.filename || 'Unknown';
    const key = (a.id || t) + '|' + (r.episode || '');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      engine: 'tracemoe',
      site: 'AniList',
      similarity: Math.round((r.similarity || 0) * 1000) / 10,
      thumbnail: r.image || null,
      title: t + (r.episode ? ` — ep ${r.episode}` : '') + ` @ ${fmtTime(r.from)}`,
      url: a.id ? `https://anilist.co/anime/${a.id}` : null,
      links: a.id ? [`https://anilist.co/anime/${a.id}`] : [],
      series: [t],
      characters: [],
      artists: [],
      episode: r.episode || null,
      timestamp: fmtTime(r.from),
      isAdult: !!a.isAdult,
      video: r.video || null,
    });
    if (results.length >= 5) break;
  }
  return { results };
}

module.exports = { search };
