'use strict';
// Batches, looked-up items, downloads and the sort log. Files are worked on where they are.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const { JsonStore } = require('./store');
const fo = require('./fileops');
const { getImageInfo } = require('./imageinfo');

const newId = () => crypto.randomBytes(5).toString('hex');

class Library {
  constructor(paths, settings, emit) {
    this.paths = paths;
    this.settings = settings;
    this.emit = emit; // (event, payload)
    this.store = new JsonStore(path.join(paths.data, 'library.json'), {
      version: 1, batches: [], items: {}, downloads: {}, sortLog: [],
    });
    // Anything left mid-lookup when the app closed goes back to the queue.
    for (const it of Object.values(this.d.items)) {
      if (it.status === 'looking') it.status = 'queued';
    }
  }

  get d() { return this.store.data; }
  save() { this.store.save(); }
  changed(ids) { this.save(); this.emit('lib:changed', { ids: [].concat(ids || []) }); }

  // ---------- summaries for the UI ----------
  summary(it) {
    return {
      id: it.id, batchId: it.batchId, path: it.path, name: it.name, mode: it.mode, status: it.status,
      phase: it.phase, width: it.width, height: it.height, size: it.size, format: it.format,
      guess: it.guess || null, bigger: it.bigger || null, error: it.error || null,
      engines: it.engines || {}, downloads: (it.downloads || []).length, keep: it.keep || null,
      resultCount: (it.results || []).length, addedAt: it.addedAt, doneAt: it.doneAt || null,
      sortedTo: it.sortedTo || null,
    };
  }

  snapshot() {
    return {
      batches: this.d.batches.map((b) => ({ ...b, counts: this.batchCounts(b.id) })),
      items: Object.values(this.d.items).map((it) => this.summary(it)),
      downloads: Object.values(this.d.downloads),
      sortLog: this.d.sortLog.slice(-500),
    };
  }

  batchCounts(batchId) {
    const c = { total: 0, queued: 0, looked: 0, done: 0, error: 0 };
    for (const it of Object.values(this.d.items)) {
      if (it.batchId !== batchId) continue;
      c.total++;
      if (it.status === 'queued' || it.status === 'looking') c.queued++;
      else if (it.status === 'looked') c.looked++;
      else if (it.status === 'done' || it.status === 'sorted') c.done++;
      else if (it.status === 'error') c.error++;
    }
    return c;
  }

  item(id) { return this.d.items[id] || null; }

  // ---------- batches ----------
  async addBatch(folder, mode, recursive) {
    const files = await fo.listImages(folder, recursive);
    const known = new Set(Object.values(this.d.items).filter((i) => i.status !== 'done' && i.status !== 'sorted').map((i) => i.path.toLowerCase()));
    const batch = { id: newId(), folder, mode, recursive: !!recursive, created: Date.now(), name: path.basename(folder) };
    let added = 0;
    for (const f of files) {
      if (known.has(f.toLowerCase())) continue;
      const it = {
        id: newId(), batchId: batch.id, path: f, name: path.basename(f), mode,
        status: 'queued', phase: 'lookup', engines: {}, results: [], downloads: [], addedAt: Date.now(),
      };
      try { Object.assign(it, pickInfo(await getImageInfo(f))); } catch (_) { /* unreadable header */ }
      this.d.items[it.id] = it;
      added++;
    }
    batch.added = added;
    this.d.batches.push(batch);
    this.changed([]);
    return { batch, added, skipped: files.length - added };
  }

  removeBatch(batchId) {
    for (const [id, it] of Object.entries(this.d.items)) {
      if (it.batchId === batchId && (it.downloads || []).length === 0) delete this.d.items[id];
      else if (it.batchId === batchId) it.batchId = null;
    }
    this.d.batches = this.d.batches.filter((b) => b.id !== batchId);
    this.changed([]);
  }

  setMode(id, mode) {
    const it = this.item(id);
    if (!it) return;
    it.mode = mode;
    this.changed(id);
  }

  requeue(id, engines) {
    const it = this.item(id);
    if (!it) return;
    if (engines && engines.length) for (const e of engines) delete it.engines[e];
    else { it.engines = {}; it.results = []; }
    it.status = 'queued';
    it.error = null;
    this.changed(id);
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
    if (dl.itemId && this.d.items[dl.itemId]) {
      const it = this.d.items[dl.itemId];
      it.downloads = it.downloads || [];
      it.downloads.push(id);
      if (it.mode === 'upgrade' && it.phase === 'lookup') it.phase = 'compare';
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
    } else {
      this.detachDownload(dl);
      delete this.d.downloads[id];
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
    }
  }

  async relinkDownload(id, itemId) {
    const dl = this.d.downloads[id];
    if (!dl) throw new Error('Download not found');
    const oldItem = dl.itemId;
    const target = itemId ? this.item(itemId) : null;
    const destDir = target ? this.itemFolder(target) : this.unlinkedFolder();
    if (await fo.exists(dl.path)) dl.path = await fo.moveFile(dl.path, destDir);
    this.detachDownload(dl);
    dl.itemId = target ? target.id : null;
    if (target) {
      target.downloads = target.downloads || [];
      target.downloads.push(dl.id);
      if (target.phase === 'lookup') target.phase = 'compare';
      if (target.status === 'done') target.status = 'looked';
    }
    await this.cleanupItemFolder(oldItem);
    this.changed([oldItem, itemId].filter(Boolean));
  }

  async recycleDownload(id) {
    const dl = this.d.downloads[id];
    if (!dl) return;
    if (await fo.exists(dl.path)) await shell.trashItem(dl.path);
    this.detachDownload(dl);
    delete this.d.downloads[id];
    await this.cleanupItemFolder(dl.itemId);
    this.changed(dl.itemId || []);
  }

  // ---------- compare: keep some, recycle the rest ----------
  async applyKeep(itemId, keepIds) {
    const it = this.item(itemId);
    if (!it) throw new Error('Item not found');
    const keep = new Set(keepIds);
    const recycled = [];
    if (!keep.has('original')) {
      if (await fo.exists(it.path)) { await shell.trashItem(it.path); recycled.push(it.path); }
      it.originalRecycled = true;
    }
    for (const dlId of [...(it.downloads || [])]) {
      if (keep.has(dlId)) continue;
      const dl = this.d.downloads[dlId];
      if (dl && await fo.exists(dl.path)) { await shell.trashItem(dl.path); recycled.push(dl.path); }
      if (dl) delete this.d.downloads[dlId];
      it.downloads = it.downloads.filter((x) => x !== dlId);
    }
    it.keep = [...keep];
    it.phase = 'sort';
    await this.checkItemDone(it);
    this.changed(itemId);
    return { recycled: recycled.length };
  }

  // Things still waiting to be sorted for an upgrade item after Compare.
  pendingKept(it) {
    const out = [];
    if ((it.keep || []).includes('original') && !it.originalSorted && !it.originalRecycled) out.push('original');
    for (const dlId of it.keep || []) {
      if (dlId === 'original') continue;
      const dl = this.d.downloads[dlId];
      if (dl && !dl.sortedTo) out.push(dlId);
    }
    return out;
  }

  async checkItemDone(it) {
    if (it.mode !== 'upgrade' || it.phase !== 'sort') return;
    if (this.pendingKept(it).length === 0) {
      await this.cleanupItemFolder(it.id, true);
      it.status = 'done';
      it.doneAt = Date.now();
    }
  }

  async cleanupItemFolder(itemId, force) {
    if (!itemId) return;
    const it = this.item(itemId);
    if (!it) return;
    const dir = this.itemFolder(it);
    if (await fo.isDirEmpty(dir)) {
      try { await fsp.rmdir(dir); } catch (_) { /* in use */ }
    } else if (force) {
      // Only remove if nothing in it belongs to a live download.
      const live = Object.values(this.d.downloads).some((d) => d.path && d.path.startsWith(dir + path.sep));
      if (!live && await fo.isDirEmpty(dir)) { try { await fsp.rmdir(dir); } catch (_) { /* ignore */ } }
    }
  }

  // ---------- sorting ----------
  // target: { kind: 'item' | 'download', id, sub } ; dest folder is relative to sort root
  async sortFile(target, destRel, flags) {
    const s = this.settings.get();
    const parts = [s.sortRoot, ...destRel.split(/[\\/]/).filter(Boolean)];
    if (flags && flags.nsfw) parts.push('NSFW');
    if (flags && flags.nsfw && flags.very) parts.push('Very');
    const destDir = path.join(...parts);
    let src, logEntry;
    if (target.kind === 'item') {
      const it = this.item(target.id);
      if (!it) throw new Error('Item not found');
      src = it.path;
      const dest = await fo.moveFile(src, destDir);
      logEntry = { id: newId(), time: Date.now(), kind: 'item', refId: it.id, from: src, to: dest, folder: destRel, flags, prev: { status: it.status, path: it.path } };
      it.path = dest;
      it.sortedTo = destRel;
      if (it.mode === 'identify') { it.status = 'sorted'; it.doneAt = Date.now(); }
      else { it.originalSorted = true; await this.checkItemDone(it); }
      this.changed(it.id);
    } else {
      const dl = this.d.downloads[target.id];
      if (!dl) throw new Error('Download not found');
      src = dl.path;
      const dest = await fo.moveFile(src, destDir);
      logEntry = { id: newId(), time: Date.now(), kind: 'download', refId: dl.id, from: src, to: dest, folder: destRel, flags, prev: { path: dl.path, itemId: dl.itemId } };
      dl.path = dest;
      dl.sortedTo = destRel;
      const it = dl.itemId && this.item(dl.itemId);
      if (it) {
        // A kept download is sorted: it stays recorded on the item until the item is done.
        if (!it.keep || it.phase !== 'sort') {
          // Sorted straight from the Downloads section: unlink it from the item.
          this.detachDownload(dl);
          dl.itemId = null;
          delete this.d.downloads[dl.id];
        }
        await this.cleanupItemFolder(it.id);
        await this.checkItemDone(it);
        this.changed(it.id);
      } else {
        delete this.d.downloads[dl.id];
        this.changed([]);
      }
      logEntry.download = { ...dl };
    }
    this.d.sortLog.push(logEntry);
    if (this.d.sortLog.length > 5000) this.d.sortLog.splice(0, this.d.sortLog.length - 5000);
    this.changed([]);
    return logEntry;
  }

  async undoSort(logId) {
    const idx = this.d.sortLog.findIndex((l) => l.id === logId);
    if (idx < 0) throw new Error('Log entry not found');
    const l = this.d.sortLog[idx];
    if (l.undone) throw new Error('Already undone');
    await fo.moveToExact(l.to, l.from);
    if (l.kind === 'item') {
      const it = this.item(l.refId);
      if (it) {
        it.path = l.from;
        it.sortedTo = null;
        if (it.mode === 'identify') { it.status = l.prev.status === 'sorted' ? 'looked' : l.prev.status; it.doneAt = null; }
        else { it.originalSorted = false; if (it.status === 'done') { it.status = 'looked'; it.doneAt = null; } }
        this.changed(it.id);
      }
    } else {
      const dl = { ...(l.download || {}), path: l.from, sortedTo: null, itemId: l.prev.itemId || null };
      dl.id = l.refId;
      this.d.downloads[dl.id] = dl;
      const it = dl.itemId && this.item(dl.itemId);
      if (it) {
        if (!(it.downloads || []).includes(dl.id)) it.downloads.push(dl.id);
        if (it.status === 'done') { it.status = 'looked'; it.doneAt = null; }
        this.changed(it.id);
      }
    }
    l.undone = true;
    this.changed([]);
  }

  async recycleItem(id) {
    const it = this.item(id);
    if (!it) return;
    if (await fo.exists(it.path)) await shell.trashItem(it.path);
    it.originalRecycled = true;
    if (it.mode === 'identify' || (it.downloads || []).length === 0) {
      it.status = 'done';
      it.doneAt = Date.now();
    } else {
      it.keep = (it.keep || []).filter((k) => k !== 'original');
    }
    this.changed(id);
  }

  forgetItem(id) {
    const it = this.item(id);
    if (!it) return;
    for (const dlId of it.downloads || []) {
      const dl = this.d.downloads[dlId];
      if (dl) dl.itemId = null;
    }
    delete this.d.items[id];
    this.changed([]);
  }

  clearDone() {
    for (const [id, it] of Object.entries(this.d.items)) {
      if (it.status === 'done' || it.status === 'sorted') delete this.d.items[id];
    }
    this.changed([]);
  }
}

function pickInfo(info) {
  return {
    width: info.width, height: info.height, size: info.size, format: info.format,
    quality: info.quality == null ? null : info.quality,
  };
}

module.exports = { Library, newId };
