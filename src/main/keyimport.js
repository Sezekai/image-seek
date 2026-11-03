'use strict';
// Finds the SauceNAO API key saved by Collection Sorter in %LOCALAPPDATA%\Collection Sorter.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const KEY_RE = /^[0-9a-f]{40}$/i;

function searchObject(obj, depth = 0) {
  if (!obj || depth > 6) return null;
  if (typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /sauce|snao/i.test(k) && KEY_RE.test(v.trim())) return v.trim();
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && /sauce|snao/i.test(k)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 === 'string' && /key|api/i.test(k2) && KEY_RE.test(v2.trim())) return v2.trim();
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = searchObject(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function searchText(text) {
  const m = text.match(/sauce\w*[^\n]{0,40}?["'=:\s]([0-9a-f]{40})\b/i);
  return m ? m[1] : null;
}

async function findCollectionSorterKey() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Collection Sorter') : null;
  if (!base || !fs.existsSync(base)) return { key: null, reason: 'Collection Sorter data folder not found' };
  const files = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !/models?|cache|logs?|thumb/i.test(e.name)) await walk(full, depth + 1); }
      else if (/\.(json|ini|cfg|conf|txt|toml|ya?ml)$/i.test(e.name)) files.push(full);
    }
  }
  await walk(base, 0);
  // settings-like files first
  files.sort((a, b) => (/setting|config/i.test(b) ? 1 : 0) - (/setting|config/i.test(a) ? 1 : 0));
  for (const f of files) {
    let stat;
    try { stat = await fsp.stat(f); } catch { continue; }
    if (stat.size > 5 * 1024 * 1024) continue;
    let text;
    try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
    let key = null;
    if (/\.json$/i.test(f)) {
      try { key = searchObject(JSON.parse(text)); } catch { /* not json */ }
    }
    if (!key) key = searchText(text);
    if (key) return { key, file: f };
  }
  return { key: null, reason: 'No SauceNAO key found in Collection Sorter settings' };
}

module.exports = { findCollectionSorterKey, searchObject, searchText };
