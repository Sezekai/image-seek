'use strict';
// Batches, looked-up items, downloads and the log. Files are worked on where they are.
//
// One flow per file: you can sort the original straight away, or download better versions,
// compare them, keep some and sort those. A file is done once its original and every
// download linked to it have been sorted, recycled, unlinked or gone missing.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const { JsonStore } = require('./store');
const fo = require('./fileops');
const { getImageInfo } = require('./imageinfo');

const newId = () => crypto.randomBytes(5).toString('hex');

// A file's identity on Windows (volume serial + NTFS file index). It survives renames and moves
// on the same drive, which lets the app follow files you rename or move in Explorer.
async function fidOf(p) {
  try {
    const st = await fsp.stat(p, { bigint: true });
    if (!st.isFile() || !st.ino) return null; // FAT/exFAT drives have no stable index
    return `${st.dev}:${st.ino}`;
  } catch { return null; }
}
const DAY = 24 * 60 * 60 * 1000;
const LOG_KEEP_MISSING = 30 * DAY;

class Library {
  constructor(paths, settings, emit) {
    this.paths = paths;
    this.settings = settings;
    this.emit = emit; // (event, payload)
    this.store = new JsonStore(path.join(paths.data, 'library.json'), {
      version: 2, batches: [], items: {}, downloads: {}, sortLog: [],
    });
    this.migrate();
    this.checking = false;
  }

  get d() { return this.store.data; }
  save() { this.store.save(); }
  changed(ids) { this.save(); this.emit('lib:changed', { ids: [].concat(ids || []).filter(Boolean) }); }

  migrate() {
    for (const it of Object.values(this.d.items)) {
      if (it.status === 'looking') it.status = 'queued';
      if (it.status === 'sorted') { it.status = 'done'; it.originalSorted = true; }
      if (it.engines) for (const [k, v] of Object.entries(it.engines)) if (v === 'waiting' && k !== 'saucenao' && !(it.retryAt && it.retryAt[k])) it.engines[k] = undefined;
    }
    this.d.version = 2;
  }

  // ---------- summaries for the UI ----------
  summary(it) {
    return {
      id: it.id, batchId: it.batchId, path: it.path, name: it.name, status: it.status, phase: it.phase,
      width: it.width, height: it.height, size: it.size, format: it.format,
      guess: it.guess || null, bigger: it.bigger || null, error: it.error || null,
      engines: it.engines || {}, downloads: (it.downloads || []).length,
      pendingDownloads: this.pendingDownloads(it).length, keep: it.keep || null,
      resultCount: (it.results || []).length, addedAt: it.addedAt, doneAt: it.doneAt || null,
      sortedTo: it.sortedTo || null, originalGone: this.originalGone(it), originalSorted: !!it.originalSorted,
    };
  }

  snapshot() {
    return {
      batches: this.d.batches.map((b) => ({ ...b, counts: this.batchCounts(b.id) })),
      items: Object.values(this.d.items).map((it) => this.summary(it)),
      downloads: Object.values(this.d.downloads),
      sortLog: this.d.sortLog.slice(-1500),
    };
  }

  light() {
    return {
      batches: this.d.batches.map((b) => ({ ...b, counts: this.batchCounts(b.id) })),
      downloads: Object.values(this.d.downloads),
      sortLog: this.d.sortLog.slice(-1500),
    };
  }

  batchCounts(batchId) {
    const c = { total: 0, queued: 0, looked: 0, done: 0, error: 0 };
    for (const it of Object.values(this.d.items)) {
      if (it.batchId !== batchId) continue;
      c.total++;
      if (it.status === 'queued' || it.status === 'looking') c.queued++;
      else if (it.status === 'looked') c.looked++;
      else if (it.status === 'done') c.done++;
      else if (it.status === 'error') c.error++;
    }
    return c;
  }

  item(id) { return this.d.items[id] || null; }

  originalGone(it) { return !!(it.originalRecycled || it.originalMissing); }

  // ---------- batches ----------
  async addBatch(folder, recursive) {
    const existing = this.d.batches.find((b) => samePath(b.folder, folder));
    const batch = existing || { id: newId(), folder, recursive: !!recursive, created: Date.now(), name: path.basename(folder) || folder };
    if (existing) existing.recursive = existing.recursive || !!recursive;
    else this.d.batches.push(batch);
    const files = await fo.listImages(folder, batch.recursive);
    const added = await this.addFiles(batch, files);
    this.changed([]);
    return { batch, added: added.length, skipped: files.length - added.length };
  }

  knownPaths() {
    const known = new Set();
    for (const i of Object.values(this.d.items)) known.add(i.path.toLowerCase());
    for (const d of Object.values(this.d.downloads)) if (d.path) known.add(d.path.toLowerCase());
    return known;
  }

  async addFiles(batch, files) {
    const known = this.knownPaths();
    const added = [];
    for (const f of files) {
      if (known.has(f.toLowerCase())) continue;
      const it = {
        id: newId(), batchId: batch.id, path: f, name: path.basename(f),
        status: 'queued', phase: 'lookup', engines: {}, results: [], downloads: [], addedAt: Date.now(),
      };
      try { Object.assign(it, pickInfo(await getImageInfo(f))); } catch (_) { /* unreadable header */ }
      it.fid = await fidOf(f);
      this.d.items[it.id] = it;
      known.add(f.toLowerCase());
      added.push(it);
    }
    return added;
  }

  removeBatch(batchId) {
    for (const [id, it] of Object.entries(this.d.items)) {
      if (it.batchId !== batchId) continue;
      if ((it.downloads || []).length === 0) delete this.d.items[id];
      else it.batchId = null;
    }
    this.d.batches = this.d.batches.filter((b) => b.id !== batchId);
    this.changed([]);
  }

  requeue(id, engines) {
    const it = this.item(id);
    if (!it) return;
    if (engines && engines.length) {
      for (const e of engines) {
        delete it.engines[e];
        if (it.retryAt) delete it.retryAt[e];
        if (it.engineErrors) delete it.engineErrors[e];
      }
    } else { it.engines = {}; it.results = []; it.retryAt = {}; it.engineErrors = {}; }
    if (it.status !== 'done') it.status = 'queued';
    it.error = null;
    this.changed(id);
  }

  // Requeue every failed / blocked lookup, optionally for one engine only. Returns how many files.
  requeueFailed(engine) {
    let n = 0;
    for (const it of Object.values(this.d.items)) {
      if (it.status === 'done') continue;
      const bad = Object.entries(it.engines || {}).filter(([k, v]) => (v === 'error' || v === 'blocked') && (!engine || k === engine)).map(([k]) => k);
      if (it.status === 'error' && !engine && !bad.length) { this.requeue(it.id); n++; continue; }
      if (bad.length) { this.requeue(it.id, bad); n++; }
    }
    this.changed([]);
    return n;
  }

  failedCounts() {
    const c = { all: 0, iqdb: 0, saucenao: 0, ascii2d: 0, tracemoe: 0 };
    for (const it of Object.values(this.d.items)) {
      if (it.status === 'done') continue;
      let any = it.status === 'error';
      for (const [k, v] of Object.entries(it.engines || {})) {
        if (v === 'error' || v === 'blocked') { c[k] = (c[k] || 0) + 1; any = true; }
      }
      if (any) c.all++;
    }
    return c;
  }

  // ---------- item folder for linked downloads ----------
  itemFolder(it) {
    const stem = fo.sanitizeName(path.parse(it.name).name).slice(0, 60);
    return path.join(this.settings.get().downloadsDir, `${stem}__${it.id}`);
  }
  unlinkedFolder() {
    return path.join(this.settings.get().downloadsDir, '_Unlinked');
  }

  // ---------- downloads ----------
  addDownload(rec) {
    const id = newId();
    const dl = { id, time: Date.now(), state: 'progress', ...rec };
    this.d.downloads[id] = dl;
    const it = dl.itemId && this.d.items[dl.itemId];
    if (it) {
      it.downloads = it.downloads || [];
      it.downloads.push(id);
      if (it.phase !== 'sort') it.phase = 'compare';
      if (it.status === 'done') { it.status = 'looked'; it.doneAt = null; }
    }
    this.changed(dl.itemId || []);
    return dl;
  }

  async finishDownload(id, state, savePath) {
    const dl = this.d.downloads[id];
    if (!dl) return;
    dl.state = state;
    if (savePath) dl.path = savePath;
    if (state === 'completed') {
      try { Object.assign(dl, pickInfo(await getImageInfo(dl.path))); } catch (_) { /* not an image */ }
      dl.fid = await fidOf(dl.path);
    } else {
      this.detachDownload(dl);
      delete this.d.downloads[id];
      const it = dl.itemId && this.item(dl.itemId);
      if (it) await this.checkItemDone(it);
    }
    this.changed(dl.itemId || []);
    this.emit('dl:finished', { id, state });
  }

  updateDownload(id, patch) {
    const dl = this.d.downloads[id];
    if (!dl) return;
    Object.assign(dl, patch);
    this.changed(dl.itemId || []);
  }

  detachDownload(dl) {
    if (dl.itemId && this.d.items[dl.itemId]) {
      const it = this.d.items[dl.itemId];
      it.downloads = (it.downloads || []).filter((x) => x !== dl.id);
      if (it.keep) it.keep = it.keep.filter((x) => x !== dl.id);
      if (!it.downloads.length && it.phase === 'compare') it.phase = 'lookup';
    }
  }

  async relinkDownload(id, itemId) {
    const dl = this.d.downloads[id];
    if (!dl) throw new Error('Download not found');
    const oldItem = dl.itemId;
    const target = itemId ? this.item(itemId) : null;
    const destDir = target ? this.itemFolder(target) : this.unlinkedFolder();
    if (await fo.exists(dl.path)) { dl.path = await fo.moveFile(dl.path, destDir); dl.name = path.basename(dl.path); dl.fid = await fidOf(dl.path); }
    this.detachDownload(dl);
    dl.itemId = target ? target.id : null;
    dl.dist = undefined;
    if (target) {
      target.downloads = target.downloads || [];
      target.downloads.push(dl.id);
      if (target.phase !== 'sort') target.phase = 'compare';
      if (target.status === 'done') { target.status = 'looked'; target.doneAt = null; }
    }
    await this.cleanupItemFolder(oldItem);
    const old = oldItem && this.item(oldItem);
    if (old) await this.checkItemDone(old);
    this.changed([oldItem, itemId]);
  }

  async recycleDownload(id) {
    const dl = this.d.downloads[id];
    if (!dl) return;
    if (await fo.exists(dl.path)) await shell.trashItem(dl.path);
    this.detachDownload(dl);
    delete this.d.downloads[id];
    await this.cleanupItemFolder(dl.itemId);
    const it = dl.itemId && this.item(dl.itemId);
    if (it) await this.checkItemDone(it);
    this.changed(dl.itemId || []);
  }

  // ---------- compare: keep some, recycle the rest ----------
  async applyKeep(itemId, keepIds) {
    const it = this.item(itemId);
    if (!it) throw new Error('Item not found');
    const keep = new Set(keepIds);
    let recycled = 0;
    if (!keep.has('original') && !this.originalGone(it) && !it.originalSorted) {
      if (await fo.exists(it.path)) { await shell.trashItem(it.path); recycled++; }
      it.originalRecycled = true;
    }
    for (const dlId of [...(it.downloads || [])]) {
      if (keep.has(dlId)) continue;
      const dl = this.d.downloads[dlId];
      if (!dl || dl.sortedTo || dl.state !== 'completed') continue;
      if (await fo.exists(dl.path)) { await shell.trashItem(dl.path); recycled++; }
      delete this.d.downloads[dlId];
      it.downloads = it.downloads.filter((x) => x !== dlId);
    }
    it.keep = [...keep];
    it.phase = 'sort';
    await this.checkItemDone(it);
    this.changed(itemId);
    return { recycled };
  }

  // Downloads linked to an item that still need sorting (or comparing).
  pendingDownloads(it) {
    return (it.downloads || []).map((id) => this.d.downloads[id]).filter((d) => d && !d.sortedTo);
  }

  // Everything still waiting to be dealt with for this item.
  pending(it) {
    const out = [];
    if (!it.originalSorted && !this.originalGone(it)) out.push('original');
    for (const d of this.pendingDownloads(it)) out.push(d.id);
    return out;
  }

  async checkItemDone(it) {
    if (!it) return;
    if (this.pending(it).length === 0) {
      if (it.status !== 'done') { it.status = 'done'; it.doneAt = Date.now(); }
      await this.cleanupItemFolder(it.id);
    } else if (it.status === 'done') {
      it.status = (it.results || []).length || Object.keys(it.engines || {}).length ? 'looked' : 'queued';
      it.doneAt = null;
    }
  }

  async cleanupItemFolder(itemId) {
    if (!itemId) return;
    const it = this.item(itemId);
    if (!it) return;
    const dir = this.itemFolder(it);
    if (await fo.isDirEmpty(dir)) {
      try { await fsp.rmdir(dir); } catch (_) { /* in use */ }
    }
  }

  // ---------- sorting ----------
  // target: { kind: 'item' | 'download', id } ; destRel is relative to the sort folder
  async sortFile(target, destRel, flags) {
    const s = this.settings.get();
    const parts = [s.sortRoot, ...destRel.split(/[\\/]/).filter(Boolean)];
    if (flags && flags.nsfw) parts.push('NSFW');
    if (flags && flags.nsfw && flags.very) parts.push('Very');
    const destDir = path.join(...parts);
    let logEntry;
    if (target.kind === 'item') {
      const it = this.item(target.id);
      if (!it) throw new Error('Item not found');
      if (it.originalSorted || this.originalGone(it)) throw new Error('The original has already been dealt with');
      const src = it.path;
      const dest = await fo.moveFile(src, destDir);
      const fid = await fidOf(dest);
      logEntry = { id: newId(), time: Date.now(), kind: 'item', refId: it.id, name: it.name, from: src, to: dest, folder: destRel, flags, fid };
      it.fid = fid;
      it.path = dest;
      it.sortedTo = destRel;
      it.originalSorted = true;
      await this.checkItemDone(it);
      this.changed(it.id);
    } else {
      const dl = this.d.downloads[target.id];
      if (!dl) throw new Error('Download not found');
      const src = dl.path;
      const dest = await fo.moveFile(src, destDir);
      dl.path = dest;
      dl.sortedTo = destRel;
      dl.fid = await fidOf(dest);
      logEntry = { id: newId(), time: Date.now(), kind: 'download', refId: dl.id, name: dl.name, from: src, to: dest, folder: destRel, flags, fid: dl.fid, download: { ...dl } };
      const it = dl.itemId && this.item(dl.itemId);
      if (it) {
        await this.cleanupItemFolder(it.id);
        await this.checkItemDone(it);
        // Keep the record while the item is still open (Compare shows it); drop it once done.
        if (it.status === 'done') this.dropSortedDownloads(it);
        this.changed(it.id);
      } else {
        delete this.d.downloads[dl.id];
      }
    }
    this.pushLog(logEntry);
    this.changed([]);
    return logEntry;
  }

  dropSortedDownloads(it) {
    for (const id of [...(it.downloads || [])]) {
      const d = this.d.downloads[id];
      if (d && d.sortedTo) delete this.d.downloads[id];
    }
    it.downloads = (it.downloads || []).filter((id) => this.d.downloads[id]);
  }

  pushLog(entry) {
    this.d.sortLog.push(entry);
    if (this.d.sortLog.length > 5000) this.d.sortLog.splice(0, this.d.sortLog.length - 5000);
  }

  async undoSort(logId) {
    const l = this.d.sortLog.find((x) => x.id === logId);
    if (!l) throw new Error('Log entry not found');
    if (l.undone) throw new Error('Already undone');
    if (l.missingAt || l.kind === 'gone' || l.kind === 'moved') throw new Error('That file was moved or deleted outside Image Seek, so it can\'t be undone');
    if (!(await fo.exists(l.to))) {
      l.missingAt = Date.now();
      this.changed([]);
      throw new Error('The sorted file is no longer there, so it can\'t be moved back');
    }
    await fo.moveToExact(l.to, l.from);
    const fid = await fidOf(l.from);
    if (l.kind === 'item') {
      const it = this.item(l.refId);
      if (it) {
        it.path = l.from;
        it.name = path.basename(l.from);
        it.fid = fid;
        it.sortedTo = null;
        it.originalSorted = false;
        await this.checkItemDone(it);
        this.changed(it.id);
      }
    } else {
      const dl = { ...(l.download || {}), id: l.refId, path: l.from, name: path.basename(l.from), sortedTo: null, fid };
      const it = dl.itemId && this.item(dl.itemId);
      if (!it) dl.itemId = null;
      this.d.downloads[dl.id] = dl;
      if (it) {
        if (!(it.downloads || []).includes(dl.id)) it.downloads.push(dl.id);
        await this.checkItemDone(it);
        this.changed(it.id);
      }
    }
    l.undone = true;
    this.changed([]);
  }

  clearLog() {
    this.d.sortLog = [];
    this.changed([]);
  }

  async recycleItem(id) {
    const it = this.item(id);
    if (!it) return;
    if (await fo.exists(it.path)) await shell.trashItem(it.path);
    it.originalRecycled = true;
    if (it.keep) it.keep = it.keep.filter((k) => k !== 'original');
    await this.checkItemDone(it);
    this.changed(id);
  }

  forgetItem(id) {
    const it = this.item(id);
    if (!it) return;
    for (const dlId of it.downloads || []) {
      const dl = this.d.downloads[dlId];
      if (dl) { if (dl.sortedTo) delete this.d.downloads[dlId]; else dl.itemId = null; }
    }
    delete this.d.items[id];
    this.changed([]);
  }

  clearDone() {
    for (const [id, it] of Object.entries(this.d.items)) {
      if (it.status !== 'done') continue;
      this.dropSortedDownloads(it);
      delete this.d.items[id];
    }
    this.changed([]);
  }

  // ---------- files renamed, moved or deleted outside the app ----------
  // Every tracked file is checked. One that's gone from its path is looked for by its file ID
  // (recent folder-watch events, its old folder, then the watched folders). If found, the app
  // follows it: moving it into the sort folder counts as sorting it, moving a sorted file to
  // another sorted folder updates the log (undo still works), moving it out of the sort folder
  // un-sorts it. If it can't be found it's removed from the app and noted in the log.
  // "gone" / "moved" lines and missing sort entries drop off the log after 30 days.
  async checkMissing() {
    if (this.checking) return 0;
    this.checking = true;
    let changes = 0;
    try {
      const missing = [];
      const jobs = [];
      const watch = (kind, ref, p) => jobs.push(async () => {
        const fid = await fidOf(p);
        if (fid) { if (ref.fid !== fid) { ref.fid = fid; } return; }
        if (await fo.exists(p)) return; // exists but has no stable ID (e.g. FAT drive)
        missing.push({ kind, ref, path: p, fid: ref.fid || null });
      });
      for (const it of Object.values(this.d.items)) {
        if (this.originalGone(it)) continue;
        if (it.originalSorted) continue; // followed through its log entry
        watch('item', it, it.path);
      }
      for (const dl of Object.values(this.d.downloads)) {
        if (dl.state !== 'completed' || dl.sortedTo) continue;
        watch('download', dl, dl.path);
      }
      for (const l of this.d.sortLog) {
        if (l.kind === 'gone' || l.kind === 'moved' || l.undone || l.missingAt) continue;
        watch('log', l, l.to);
      }
      await runLimited(jobs, 24);

      if (missing.length) {
        const found = await this.locate(missing.filter((m) => m.fid));
        for (const m of missing) {
          const np = m.fid && found.get(m.fid);
          // still really gone? (it may have come back while we looked)
          if (!np && await fo.exists(m.path)) continue;
          if (np) await this.follow(m, np); else await this.lose(m);
          changes++;
        }
      }

      // purge old lines
      const now = Date.now();
      const before = this.d.sortLog.length;
      this.d.sortLog = this.d.sortLog.filter((l) => {
        const t = l.kind === 'gone' || l.kind === 'moved' ? l.time : l.missingAt;
        return !t || now - t < LOG_KEEP_MISSING;
      });
      if (this.d.sortLog.length !== before) changes++;
    } finally {
      this.checking = false;
    }
    if (changes) this.changed([]);
    return changes;
  }

  // Finds current paths for file IDs. Returns Map fid -> path.
  async locate(wanted) {
    const out = new Map();
    if (!wanted.length) return out;
    const need = new Set(wanted.map((m) => m.fid));
    // 1. files the folder watcher saw appear recently
    for (const [fid, p] of this.appeared || []) {
      if (need.has(fid) && (await fidOf(p)) === fid) { out.set(fid, p); need.delete(fid); }
    }
    if (!need.size) return out;
    // 2. the file's old folder (renamed in place)
    const dirs = [...new Set(wanted.filter((m) => need.has(m.fid)).map((m) => path.dirname(m.path)))];
    for (const d of dirs) {
      let names;
      try { names = await fsp.readdir(d); } catch { continue; }
      if (names.length > 20000) continue;
      for (const n of names) {
        if (!fo.isImage(n)) continue;
        const p = path.join(d, n);
        const fid = await fidOf(p);
        if (fid && need.has(fid)) { out.set(fid, p); need.delete(fid); }
      }
      if (!need.size) return out;
    }
    // 3. every watched folder. A cached index is tried first, then a fresh scan (only happens
    //    when something newly went missing, since afterwards it's followed or marked gone).
    const before = this.indexAt;
    let index = await this.folderIndex();
    let fresh = this.indexAt !== before; // built just now
    for (;;) {
      for (const fid of [...need]) {
        const p = index.get(fid);
        if (p && (await fidOf(p)) === fid) { out.set(fid, p); need.delete(fid); }
      }
      if (!need.size || fresh) break;
      index = await this.folderIndex(true);
      fresh = true;
    }
    return out;
  }

  watchedRoots() {
    const s = this.settings.get();
    const roots = this.d.batches.map((b) => ({ path: b.folder, recursive: !!b.recursive }));
    if (s.downloadsDir) roots.push({ path: s.downloadsDir, recursive: true });
    if (s.sortRoot) roots.push({ path: s.sortRoot, recursive: true });
    return roots;
  }

  async folderIndex(force) {
    if (!force && this.index && Date.now() - this.indexAt < 5 * 60 * 1000) return this.index;
    const map = new Map();
    for (const r of this.watchedRoots()) {
      const files = await fo.listImages(r.path, r.recursive);
      await runLimited(files.map((f) => async () => { const fid = await fidOf(f); if (fid) map.set(fid, f); }), 32);
    }
    this.index = map;
    this.indexAt = Date.now();
    return map;
  }

  inSortRoot(p) {
    const root = this.settings.get().sortRoot;
    if (!root) return false;
    const rel = path.relative(root, p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // Folder (relative to the sort folder) and NSFW / Very flags for a file in the sort folder.
  sortPlace(p) {
    const rel = path.relative(this.settings.get().sortRoot, path.dirname(p));
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const flags = { nsfw: false, very: false };
    const last = (i) => (parts[parts.length - i] || '').toLowerCase();
    if (last(1) === 'very' && last(2) === 'nsfw') { flags.nsfw = true; flags.very = true; parts.splice(-2); }
    else if (last(1) === 'nsfw') { flags.nsfw = true; parts.pop(); }
    return { folder: parts.join('/') || '(sort folder)', flags };
  }

  noteMoved(what, name, from, to) {
    const renamed = path.dirname(from).toLowerCase() === path.dirname(to).toLowerCase();
    this.pushLog({ id: newId(), time: Date.now(), kind: 'moved', what, renamed, name, from, to });
  }

  async follow(m, np) {
    const fid = m.fid;
    if (m.kind === 'item') {
      const it = m.ref;
      if (!this.d.items[it.id]) return;
      const from = it.path;
      it.path = np; it.name = path.basename(np); it.fid = fid;
      if (this.inSortRoot(np)) {
        // Moved into the sort folder by hand: counts as sorting it.
        const pl = this.sortPlace(np);
        it.originalSorted = true; it.sortedTo = pl.folder;
        this.pushLog({ id: newId(), time: Date.now(), kind: 'item', manual: true, refId: it.id, name: it.name, from, to: np, folder: pl.folder, flags: pl.flags, fid });
        await this.checkItemDone(it);
      } else this.noteMoved('original', it.name, from, np);
    } else if (m.kind === 'download') {
      const dl = m.ref;
      if (!this.d.downloads[dl.id]) return;
      const from = dl.path;
      dl.path = np; dl.name = path.basename(np); dl.fid = fid;
      const it = dl.itemId && this.item(dl.itemId);
      if (this.inSortRoot(np)) {
        const pl = this.sortPlace(np);
        dl.sortedTo = pl.folder;
        this.pushLog({ id: newId(), time: Date.now(), kind: 'download', manual: true, refId: dl.id, name: dl.name, from, to: np, folder: pl.folder, flags: pl.flags, fid, download: { ...dl } });
        if (it) {
          await this.cleanupItemFolder(it.id);
          await this.checkItemDone(it);
          if (it.status === 'done') this.dropSortedDownloads(it);
        } else delete this.d.downloads[dl.id];
      } else {
        this.noteMoved(dl.itemId ? 'download' : 'unlinked', dl.name, from, np);
        if (it) await this.cleanupItemFolder(it.id);
      }
    } else if (m.kind === 'log') {
      const l = m.ref;
      const from = l.to;
      const it = l.kind === 'item' ? this.item(l.refId) : null;
      const dl = l.kind === 'download' ? this.d.downloads[l.refId] : null;
      if (this.inSortRoot(np)) {
        // Renamed, or moved to another sorted folder: keep the entry (undo moves it back from here).
        const pl = this.sortPlace(np);
        l.moves = (l.moves || []).concat({ time: Date.now(), from, to: np, folder: pl.folder });
        l.to = np; l.folder = pl.folder; l.flags = pl.flags; l.fid = fid;
        if (it && it.path === from) { it.path = np; it.name = path.basename(np); it.sortedTo = pl.folder; it.fid = fid; }
        if (dl) { dl.path = np; dl.name = path.basename(np); dl.sortedTo = pl.folder; dl.fid = fid; }
      } else {
        // Moved back out of the sort folder: it's no longer sorted.
        l.undone = true;
        l.movedOut = { time: Date.now(), to: np };
        if (it && it.path === from) {
          it.path = np; it.name = path.basename(np); it.fid = fid;
          it.originalSorted = false; it.sortedTo = null;
          await this.checkItemDone(it);
        }
        if (dl) {
          dl.path = np; dl.name = path.basename(np); dl.sortedTo = null; dl.fid = fid;
          const owner = dl.itemId && this.item(dl.itemId);
          if (owner) await this.checkItemDone(owner);
        }
      }
    }
  }

  async lose(m) {
    const gone = (what, name, p) => this.pushLog({ id: newId(), time: Date.now(), kind: 'gone', what, name, from: p, to: null });
    if (m.kind === 'item') {
      const it = m.ref;
      if (!this.d.items[it.id]) return;
      gone('original', it.name, it.path);
      it.originalMissing = true;
      const anyDownloads = (it.downloads || []).some((id) => this.d.downloads[id] && !this.d.downloads[id].sortedTo);
      if (!anyDownloads) this.forgetItemQuiet(it);
      else await this.checkItemDone(it);
    } else if (m.kind === 'download') {
      const dl = m.ref;
      if (!this.d.downloads[dl.id]) return;
      gone(dl.itemId ? 'download' : 'unlinked', dl.name || path.basename(dl.path), dl.path);
      this.detachDownload(dl);
      delete this.d.downloads[dl.id];
      const it = dl.itemId && this.item(dl.itemId);
      if (it) {
        await this.cleanupItemFolder(it.id);
        if (this.originalGone(it) && !it.originalSorted && !(it.downloads || []).length) this.forgetItemQuiet(it);
        else await this.checkItemDone(it);
      }
    } else if (m.kind === 'log') {
      const l = m.ref;
      l.missingAt = Date.now();
      if (l.kind === 'download' && this.d.downloads[l.refId] && this.d.downloads[l.refId].sortedTo) {
        const dl = this.d.downloads[l.refId];
        this.detachDownload(dl);
        delete this.d.downloads[l.refId];
      }
      if (l.kind === 'item') {
        const it = this.item(l.refId);
        if (it && it.path === l.to) {
          if (it.status === 'done') delete this.d.items[it.id];
          else { it.originalMissing = true; await this.checkItemDone(it); }
        }
      }
    }
  }

  // ---------- new images in added folders ----------
  // paths: specific files the watcher reported, or null to rescan every added folder.
  async pickUpNew(paths) {
    if (this.settings.get().autoAdd === false) return [];
    const s = this.settings.get();
    const skip = (p) => [s.downloadsDir, s.sortRoot, this.paths.data].some((r) => r && isInside(r, p));
    const added = [];
    for (const b of this.d.batches) {
      let files;
      if (paths) {
        files = paths.filter((p) => fo.isImage(p) && isInside(b.folder, p) && (b.recursive || samePath(path.dirname(p), b.folder)));
      } else {
        if (!(await fo.exists(b.folder))) continue;
        files = await fo.listImages(b.folder, b.recursive);
      }
      files = files.filter((p) => !skip(p));
      if (!files.length) continue;
      // Skip files that may still be copying in: a file is taken once it was created a while ago,
      // or its size and modified time stayed the same across two checks (copies on Windows keep
      // the original modified time, so that alone can't be trusted).
      const ready = [];
      const now = Date.now();
      this.sightings = this.sightings || new Map();
      for (const f of files) {
        let st;
        try { st = await fsp.stat(f); } catch { continue; }
        if (!st.isFile() || st.size === 0) { this.later = (this.later || new Set()).add(f); continue; }
        const born = Math.max(st.birthtimeMs || 0, st.ctimeMs || 0, st.mtimeMs || 0);
        const prev = this.sightings.get(f);
        const stable = prev && prev.size === st.size && prev.mtime === st.mtimeMs && now - prev.at >= 1500;
        if (now - born > 10000 || stable) { ready.push(f); this.sightings.delete(f); continue; }
        if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) this.sightings.set(f, { size: st.size, mtime: st.mtimeMs, at: now });
        this.later = (this.later || new Set()).add(f);
      }
      if (this.sightings.size > 2000) this.sightings.clear();
      const got = await this.addFiles(b, ready);
      if (got.length) { b.picked = (b.picked || 0) + got.length; added.push(...got); }
    }
    if (added.length) this.changed([]);
    return added;
  }

  // Watcher / timer entry point: follow renamed or moved files first, then add new ones.
  async reconcile(paths) {
    if (this.reconciling) {
      this.again = this.again === undefined ? (paths ? [...paths] : null) : (this.again === null || !paths ? null : this.again.concat(paths));
      return { changes: 0, added: [] };
    }
    this.reconciling = true;
    try {
      const changes = await this.checkMissing();
      let todo = paths;
      if (this.later && this.later.size) { todo = todo ? todo.concat([...this.later]) : todo; this.later.clear(); }
      const added = await this.pickUpNew(todo);
      return { changes, added };
    } finally {
      this.reconciling = false;
      if (this.again !== undefined) {
        const again = this.again;
        this.again = undefined;
        setTimeout(() => this.reconcile(again).then((r) => this.onReconciled && this.onReconciled(r)), 50);
      }
    }
  }

  forgetItemQuiet(it) {
    for (const dlId of it.downloads || []) {
      const dl = this.d.downloads[dlId];
      if (dl) { if (dl.sortedTo) delete this.d.downloads[dlId]; else dl.itemId = null; }
    }
    delete this.d.items[it.id];
  }
}

function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function isInside(root, p) {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function runLimited(jobs, n) {
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const j = jobs[i++]; try { await j(); } catch (_) { /* ignore */ } } };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

function pickInfo(info) {
  return {
    width: info.width, height: info.height, size: info.size, format: info.format,
    quality: info.quality == null ? null : info.quality,
  };
}

module.exports = { Library, newId, LOG_KEEP_MISSING, fidOf };
