'use strict';
// Combines every engine's matches into a best guess for series, characters and artist,
// and works out whether a larger version of the image exists.

const ENGINE_WEIGHT = { saucenao: 1, iqdb: 0.9, ascii2d: 0.6, tracemoe: 1 };

function norm(s) {
  return String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').replace(/\s*\((?:artist|cosplay)\)\s*$/, '').trim();
}

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function passes(r, minSim) {
  const min = minSim[r.engine] == null ? 0 : minSim[r.engine];
  if (r.engine === 'ascii2d') return r.rank != null && r.rank <= 3 && r.mode === 'color';
  return (r.similarity || 0) >= min;
}

function weightOf(r) {
  const w = ENGINE_WEIGHT[r.engine] || 0.5;
  if (r.engine === 'ascii2d') return w * (1 - r.rank * 0.15);
  return w * ((r.similarity || 0) / 100);
}

function vote(map, value, w, src) {
  const k = norm(value);
  if (!k || k === 'original' || k.length < 2) return;
  const cur = map.get(k) || { name: value, score: 0, sources: new Set() };
  cur.score += w;
  cur.sources.add(src);
  // Prefer the nicest-looking display form (one with capitals).
  if (/[A-Z]/.test(value) && !/[A-Z]/.test(cur.name)) cur.name = value;
  map.set(k, cur);
}

function finish(map, limit) {
  return [...map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((v) => ({ name: /[A-Z]/.test(v.name) ? v.name : titleCase(v.name.replace(/_/g, ' ')), score: Math.round(v.score * 100) / 100, sources: [...v.sources] }));
}

function buildGuess(results, minSim, original) {
  const series = new Map(), characters = new Map(), artists = new Map();
  let bigger = null;
  const origPx = (original.width || 0) * (original.height || 0);
  for (const r of results) {
    const ok = passes(r, minSim);
    if (!ok) continue;
    const w = weightOf(r);
    const b = r.booru || {};
    const src = r.site || r.engine;
    for (const s of b.series || r.series || []) vote(series, s, w * (b.series ? 1.2 : 1), src);
    for (const c of b.characters || r.characters || []) vote(characters, c, w * (b.characters ? 1.2 : 1), src);
    for (const a of b.artists || r.artists || []) vote(artists, a, w * (b.artists ? 1.2 : 1), src);
    const rw = r.width || b.width, rh = r.height || b.height;
    if (rw && rh && origPx && rw * rh > origPx * 1.15) {
      if (!bigger || rw * rh > bigger.width * bigger.height) {
        bigger = { width: rw, height: rh, site: src, url: r.url, engine: r.engine };
      }
    }
  }
  return {
    guess: { series: finish(series, 4), characters: finish(characters, 6), artists: finish(artists, 3) },
    bigger,
  };
}

module.exports = { buildGuess };
