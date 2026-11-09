'use strict';
// Watches the added folders, the downloads folder and the sort folder. Changes are batched and
// passed to the library, which follows renamed / moved files and picks up new images.
const fs = require('fs');
const path = require('path');
const fo = require('./fileops');
const { fidOf } = require('./library');

class FolderWatcher {
  constructor(lib, onResult, log) {
    this.lib = lib;
    this.onResult = onResult;
    this.log = log;
    this.watchers = new Map(); // root path (lower) -> fs.FSWatcher
    this.pending = new Set();
    this.timer = null;
    lib.appeared = new Map(); // fid -> path, for files seen arriving recently
  }

  // (Re)create watchers to match the current folders.
  refresh() {
    const roots = [];
    for (const r of [...this.lib.watchedRoots(), ...this.lib.probeRoots()]) {
      if (!r.path || !fs.existsSync(r.path)) continue;
      // Skip a folder already covered by a recursive watch on a parent folder.
      if (roots.some((o) => o.recursive && inside(o.path, r.path))) continue;
      for (let i = roots.length - 1; i >= 0; i--) if (r.recursive && inside(r.path, roots[i].path)) roots.splice(i, 1);
      const same = roots.find((o) => o.path.toLowerCase() === r.path.toLowerCase());
      if (same) { same.recursive = same.recursive || r.recursive; continue; }
      roots.push({ ...r });
    }
    const want = new Map(roots.map((r) => [r.path.toLowerCase() + (r.recursive ? '|r' : ''), r]));
    for (const [k, w] of this.watchers) if (!want.has(k)) { try { w.close(); } catch (_) { /* ignore */ } this.watchers.delete(k); }
    for (const [k, r] of want) {
      if (this.watchers.has(k)) continue;
      try {
        const w = fs.watch(r.path, { recursive: r.recursive, persistent: false }, (_ev, name) => {
          if (!name) { this.full = true; this.schedule(); return; }
          this.pending.add(path.join(r.path, name.toString()));
          this.schedule();
        });
        w.on('error', () => { try { w.close(); } catch (_) { /* ignore */ } this.watchers.delete(k); this.full = true; this.schedule(); });
        this.watchers.set(k, w);
      } catch (e) {
        this.log(`Can't watch ${r.path}: ${e.message}`, 'warn');
      }
    }
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
  }

  async flush() {
    const paths = [...this.pending].filter((p) => fo.isImage(p));
    this.pending.clear();
    const full = this.full;
    this.full = false;
    const now = Date.now();
    for (const p of paths) {
      const fid = await fidOf(p);
      if (fid) this.lib.appeared.set(fid, p);
    }
    // forget old sightings
    if (this.lib.appeared.size > 5000) this.lib.appeared = new Map([...this.lib.appeared].slice(-2000));
    if (!paths.length && !full) return;
    const r = await this.lib.reconcile(full ? null : paths);
    this.onResult(r);
    void now;
  }

  close() {
    for (const w of this.watchers.values()) { try { w.close(); } catch (_) { /* ignore */ } }
    this.watchers.clear();
  }
}

function inside(root, p) {
  const rel = path.relative(root.toLowerCase(), p.toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { FolderWatcher };
