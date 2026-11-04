// Compare the original with its downloaded versions: side by side, stacked or grid,
// zoom and pan in sync, stats with the best values highlighted, keep the ones you want.
import {
  api, state, h, icon, btn, seg, clear, thumbUrl, fileUrl, fmtBytes, fmtDims, fmtMp, toast, on, emit,
  basename, modal, makeResizable, dHash, hamming,
} from '../core.js';
import { createSortPanel } from '../sortpanel.js';

export class CompareView {
  constructor(root) {
    this.root = root;
    this.itemId = null;
    this.item = null;
    this.keep = new Set();
    this.zoom = { mode: 'fit', m: 1, cx: 0.5, cy: 0.5 };
    this.paneZoom = new Map();
    this.sync = true;
    this.holding = false;
    this.layoutMode = state.settings.compareLayout || 'horizontal';
    this.build();
    on('lib', (ids) => { this.renderList(); if (this.itemId && (!ids.length || ids.includes(this.itemId))) this.load(this.itemId, true); });
    on('open-compare', (id) => { emit('show-view', 'compare'); this.load(id); });
    document.addEventListener('keydown', (e) => { if (state.view === 'compare' && e.code === 'Space' && !isTyping()) { e.preventDefault(); if (!this.holding) { this.holding = true; this.applyZoom(); } } });
    document.addEventListener('keyup', (e) => { if (e.code === 'Space' && this.holding) { this.holding = false; this.applyZoom(); } });
    window.addEventListener('resize', () => this.applyZoom());
  }

  build() {
    this.listEl = h('div', { class: 'scroll cmp-list' });
    const side = h('div', { class: 'side left', style: { '--side-w': '280px' } },
      h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'Files with downloads')), this.listEl);
    makeResizable(side, 'compare-list', 220, 480);
    this.layoutSeg = seg([
      { value: 'horizontal', icon: 'cols', title: 'Side by side' },
      { value: 'vertical', icon: 'rows', title: 'Stacked' },
      { value: 'grid', icon: 'grid', title: 'Grid' },
    ], this.layoutMode, (v) => { this.layoutMode = v; api.call('settings:set', { compareLayout: v }); this.renderPanes(); });
    this.syncBtn = btn('Synced zoom', { icon: 'link', cls: 'on', title: 'Zoom and pan all images together', onclick: () => { this.sync = !this.sync; this.syncBtn.classList.toggle('on', this.sync); } });
    this.keepBtn = btn('Keep selected', { icon: 'check', cls: 'primary', onclick: () => this.apply() });
    this.titleEl = h('div', { class: 'ell title', style: { maxWidth: '380px' } });
    this.toolbar = h('div', { class: 'toolbar' }, this.titleEl, this.layoutSeg,
      btn('Fit', { icon: 'fit', onclick: () => this.setZoom({ mode: 'fit', m: 1, cx: 0.5, cy: 0.5 }) }),
      btn('100%', { icon: 'zoom', title: 'Show the highest-resolution image at 100%', onclick: () => this.oneToOne() }),
      this.syncBtn,
      h('span', { class: 'xs dim' }, h('kbd', null, 'Space'), ' hold to show the original everywhere · scroll to zoom · drag to pan'),
      h('div', { class: 'grow' }),
      this.keepBtn);
    this.area = h('div', { class: 'cmp-area horizontal' });
    this.sortHost = h('div', { class: 'hidden', style: { borderTop: '1px solid var(--line)', background: 'var(--panel)', padding: '10px 12px', maxHeight: '45%', overflow: 'auto' } });
    this.main = h('div', { class: 'main' }, this.toolbar, this.area, this.sortHost);
    this.root.appendChild(h('div', { class: 'split' }, side, this.main));
  }

  candidates() {
    return [...state.items.values()].filter((s) => s.status !== 'done' && (s.pendingDownloads > 0 || s.phase === 'sort'));
  }

  renderList() {
    clear(this.listEl);
    const all = this.candidates();
    const groups = [
      ['To compare', all.filter((s) => s.phase !== 'sort')],
      ['To sort', all.filter((s) => s.phase === 'sort')],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      this.listEl.appendChild(h('div', { class: 'xs muted', style: { padding: '10px 10px 4px', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 } }, `${label} (${list.length})`));
      for (const s of list) {
        this.listEl.appendChild(h('div', { class: 'ci' + (s.id === this.itemId ? ' on' : ''), onclick: () => this.load(s.id) },
          h('img', { src: thumbUrl(s.path, 120) }),
          h('div', { class: 'grow col', style: { gap: '1px' } }, h('div', { class: 'ell small' }, s.name),
            h('div', { class: 'xs dim' }, `${s.pendingDownloads} download${s.pendingDownloads === 1 ? '' : 's'} · ${fmtDims(s.width, s.height)}`))));
      }
    }
    if (!all.length) this.listEl.appendChild(h('div', { class: 'empty' }, icon('compare'), h('div', { class: 'small' }, 'Files you download higher-resolution versions for appear here.')));
  }

  async load(id, keepZoom) {
    this.itemId = id;
    this.item = await api.call('item:get', id).catch(() => null);
    if (!this.item) return;
    const cands = this.panesData();
    if (!keepZoom) {
      this.zoom = { mode: 'fit', m: 1, cx: 0.5, cy: 0.5 };
      this.paneZoom.clear();
      // Default: keep the highest-resolution version.
      this.keep = new Set();
      const best = cands.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h) || (b.size - a.size))[0];
      if (best) this.keep.add(best.key);
    } else {
      const keys = new Set(cands.map((c) => c.key));
      this.keep = new Set([...this.keep].filter((k) => keys.has(k)));
    }
    this.renderList();
    this.renderPanes();
    this.hashCheck(cands);
  }

  panesData() {
    const it = this.item;
    const out = [];
    if (!it) return out;
    if (!it.originalRecycled && !it.originalMissing) {
      // A sorted original is still shown for comparison, but it's already kept.
      out.push({ key: 'original', label: it.originalSorted ? 'Original (sorted)' : 'Original', locked: !!it.originalSorted, path: it.path, w: it.width, h: it.height, size: it.size, format: it.format, quality: it.quality });
    }
    let n = 1;
    for (const id of it.downloads || []) {
      const d = state.downloads.get(id);
      if (!d || d.state !== 'completed' || d.sortedTo) continue;
      out.push({ key: d.id, label: `Download ${n++}`, path: d.path, w: d.width, h: d.height, size: d.size, format: d.format, quality: d.quality, dist: d.dist, url: d.pageUrl || d.url });
    }
    return out;
  }

  async hashCheck(cands) {
    const orig = cands.find((c) => c.key === 'original');
    if (!orig) return;
    try {
      const ho = await dHash(fileUrl(orig.path));
      for (const c of cands) {
        if (c.key === 'original' || c.dist != null) continue;
        const hc = await dHash(fileUrl(c.path)).catch(() => null);
        const dist = hamming(ho, hc);
        if (dist != null) { c.dist = dist; api.call('dl:update', c.key, { dist }); }
      }
    } catch (_) { /* ignore */ }
  }

  renderPanes() {
    clear(this.area);
    this.panes = [];
    const it = this.item;
    this.titleEl.textContent = it ? it.name : 'Compare';
    this.sortHost.classList.add('hidden');
    if (!it) {
      this.area.className = 'cmp-area';
      this.area.appendChild(h('div', { class: 'empty' }, icon('compare'), h('div', null, 'Choose a file on the left to compare its versions.')));
      this.keepBtn.disabled = true;
      return;
    }
    const data = this.panesData();
    this.keepBtn.classList.toggle('hidden', it.phase === 'sort' || it.status === 'done');
    this.keepBtn.disabled = !data.length;
    if (it.phase === 'sort' || it.status === 'done') this.renderSort();
    if (!data.length) {
      this.area.className = 'cmp-area';
      this.area.appendChild(h('div', { class: 'empty' }, icon(it.status === 'done' ? 'check' : 'download'), h('div', null, it.status === 'done' ? 'All kept files are sorted — this one is done.' : 'Nothing to compare yet.')));
      return;
    }
    const cls = this.layoutMode === 'grid' ? '' : this.layoutMode;
    this.area.className = 'cmp-area ' + cls;
    if (this.layoutMode === 'grid') {
      const cols = Math.ceil(Math.sqrt(data.length));
      this.area.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      this.area.style.gridAutoRows = '1fr';
    } else {
      this.area.style.gridTemplateColumns = '';
      this.area.style.gridAutoRows = '';
    }
    // best values for highlighting
    const maxPx = Math.max(...data.map((d) => (d.w || 0) * (d.h || 0)));
    const maxSize = Math.max(...data.map((d) => d.size || 0));
    const qualities = data.map((d) => d.format === 'PNG' || d.format === 'WebP' && !d.quality ? 101 : (d.quality || 0));
    const maxQ = Math.max(...qualities);
    data.forEach((d, i) => {
      const px = (d.w || 0) * (d.h || 0);
      const isBestRes = px && px === maxPx;
      const isBestSize = d.size && d.size === maxSize;
      const isBestQ = maxQ > 0 && qualities[i] === maxQ && data.length > 1;
      if (d.locked) this.keep.add(d.key);
      const keepCb = h('input', { type: 'checkbox', disabled: !!d.locked, title: d.locked ? 'Already sorted' : '', checked: this.keep.has(d.key), onchange: (e) => { e.target.checked ? this.keep.add(d.key) : this.keep.delete(d.key); pane.classList.toggle('keep', e.target.checked); this.updateKeepBtn(); } });
      const stats = h('div', { class: 'stats' },
        h('span', { class: 'chip' + (isBestRes ? ' green' : ''), title: isBestRes ? 'Highest resolution' : '' }, `${fmtDims(d.w, d.h)} · ${fmtMp(d.w, d.h)}`),
        h('span', { class: 'chip' + (isBestSize ? ' green' : ''), title: isBestSize ? 'Biggest file' : '' }, fmtBytes(d.size)),
        h('span', { class: 'chip' + (isBestQ ? ' green' : '') }, (d.format || '?') + (d.quality ? ` q${d.quality}` : d.format === 'PNG' ? ' lossless' : '')),
        d.key !== 'original' && d.dist != null ? h('span', { class: 'chip ' + (d.dist > (state.settings.unrelatedThreshold || 20) ? 'warn' : ''), title: 'Visual difference from the original (0 = identical)' },
          d.dist > (state.settings.unrelatedThreshold || 20) ? 'different picture?' : d.dist <= 4 ? 'same picture' : `similar (${d.dist})`) : null,
        d.key !== 'original' && px && it.width ? h('span', { class: 'chip dim' }, `${(px / (it.width * it.height)).toFixed(px / (it.width * it.height) >= 10 ? 0 : 1)}× pixels`) : null);
      const img = h('img', { src: fileUrl(d.path), draggable: 'false' });
      const stage = h('div', { class: 'stage' }, img);
      const holdTag = h('span', { class: 'chip warn holding hidden' }, 'Showing original');
      const pane = h('div', { class: 'pane' + (this.keep.has(d.key) ? ' keep' : '') },
        h('div', { class: 'phead' },
          h('label', { class: 'check' }, keepCb, h('span', { class: 'lbl' }, d.label)),
          stats,
          h('div', { class: 'grow' }),
          d.url ? btn('', { icon: 'external', cls: 'sm icon ghost', title: 'Open the page it came from', onclick: () => emit('open-url', { url: d.url, itemId: it.id }) }) : null,
          btn('', { icon: 'folder', cls: 'sm icon ghost', title: 'Show in folder', onclick: () => api.call('shell:show', d.path) })),
        h('div', { class: 'pbody' }, stage, holdTag));
      const p = { d, img, stage, pane, holdTag, nw: d.w || 0, nh: d.h || 0 };
      img.onload = () => {
        // Only record this pane's own size (not the original shown while Space is held).
        if (!img.dataset.src || img.dataset.src === fileUrl(d.path)) { p.nw = img.naturalWidth; p.nh = img.naturalHeight; }
        this.applyZoom();
      };
      this.bindPane(p);
      this.panes.push(p);
      this.area.appendChild(pane);
    });
    this.updateKeepBtn();
    requestAnimationFrame(() => this.applyZoom());
  }

  updateKeepBtn() {
    const n = this.keep.size;
    const total = this.panesData().length;
    clear(this.keepBtn).append(icon('check'), document.createTextNode(n ? `Keep ${n}, recycle ${total - n}` : 'Select at least one to keep'));
    if (!(this.item && (this.item.phase === 'sort' || this.item.status === 'done'))) this.keepBtn.disabled = n === 0;
  }

  zoomFor(p) {
    if (this.sync) return this.zoom;
    if (!this.paneZoom.has(p.d.key)) this.paneZoom.set(p.d.key, { ...this.zoom });
    return this.paneZoom.get(p.d.key);
  }

  setZoom(z, p) {
    if (this.sync || !p) { this.zoom = { ...z }; if (!this.sync) for (const k of this.paneZoom.keys()) this.paneZoom.set(k, { ...z }); }
    else this.paneZoom.set(p.d.key, { ...z });
    this.applyZoom();
  }

  oneToOne() {
    if (!this.panes || !this.panes.length) return;
    const big = this.panes.slice().sort((a, b) => b.nw * b.nh - a.nw * a.nh)[0];
    const fit = this.fitScale(big);
    this.setZoom({ mode: 'rel', m: 1 / fit, cx: this.zoom.cx, cy: this.zoom.cy });
  }

  fitScale(p) {
    const r = p.stage.getBoundingClientRect();
    if (!p.nw || !p.nh || !r.width) return 1;
    return Math.min(r.width / p.nw, r.height / p.nh);
  }

  applyZoom() {
    if (!this.panes) return;
    const orig = this.panes.find((p) => p.d.key === 'original');
    for (const p of this.panes) {
      const showOrig = this.holding && orig && p !== orig;
      const src = showOrig ? orig : p;
      const wantSrc = fileUrl(src.d.path);
      if (p.img.dataset.src !== wantSrc) { p.img.dataset.src = wantSrc; if (p.img.src !== wantSrc) p.img.src = wantSrc; }
      p.holdTag.classList.toggle('hidden', !showOrig);
      const nw = src.nw, nh = src.nh;
      if (!nw || !nh) continue;
      const z = this.zoomFor(p);
      const r = p.stage.getBoundingClientRect();
      const fit = Math.min(r.width / nw, r.height / nh);
      // Keep the same on-screen size when showing the original in place of a bigger download.
      const ref = showOrig ? (Math.min(r.width / p.nw, r.height / p.nh) * p.nw) / nw : fit;
      const scale = ref * (z.mode === 'fit' ? 1 : z.m);
      const x = r.width / 2 - z.cx * nw * scale;
      const y = r.height / 2 - z.cy * nh * scale;
      p.img.style.width = nw + 'px';
      p.img.style.height = nh + 'px';
      p.img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      p.stage.classList.toggle('pixel', scale >= 3);
    }
  }

  bindPane(p) {
    p.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const z = { ...this.zoomFor(p) };
      if (z.mode === 'fit') { z.mode = 'rel'; z.m = 1; }
      const r = p.stage.getBoundingClientRect();
      const fit = Math.min(r.width / p.nw, r.height / p.nh);
      const scale = fit * z.m;
      // image-normalised point under the cursor
      const px = z.cx + (e.clientX - r.left - r.width / 2) / (p.nw * scale);
      const py = z.cy + (e.clientY - r.top - r.height / 2) / (p.nh * scale);
      const factor = Math.exp(-e.deltaY * 0.0015);
      z.m = Math.max(0.2, Math.min(64, z.m * factor));
      const ns = fit * z.m;
      z.cx = px - (e.clientX - r.left - r.width / 2) / (p.nw * ns);
      z.cy = py - (e.clientY - r.top - r.height / 2) / (p.nh * ns);
      this.setZoom(z, p);
    }, { passive: false });
    p.stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      p.stage.classList.add('dragging');
      let lx = e.clientX, ly = e.clientY;
      const move = (ev) => {
        const z = { ...this.zoomFor(p) };
        if (z.mode === 'fit') { z.mode = 'rel'; z.m = 1; }
        const scale = this.fitScale(p) * z.m;
        z.cx -= (ev.clientX - lx) / (p.nw * scale);
        z.cy -= (ev.clientY - ly) / (p.nh * scale);
        lx = ev.clientX; ly = ev.clientY;
        this.setZoom(z, p);
      };
      const up = () => { p.stage.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    p.stage.addEventListener('dblclick', () => this.setZoom({ mode: 'fit', m: 1, cx: 0.5, cy: 0.5 }, p));
  }

  async apply() {
    const data = this.panesData();
    const keep = data.filter((d) => this.keep.has(d.key) && !d.locked);
    const drop = data.filter((d) => !this.keep.has(d.key) && !d.locked);
    if (!keep.length && data.some((d) => d.locked)) {
      // Original already sorted: keeping none of the downloads is fine.
      if (!drop.length) { toast('Nothing to change', 'warn'); return; }
    }
    if (!keep.length && !data.some((d) => d.locked)) { toast('Select at least one version to keep', 'warn'); return; }
    const r = await modal('Keep selected versions?', [
      h('div', null, h('b', null, 'Keep: '), keep.length ? keep.map((d) => d.label).join(', ') : 'none (the original is already sorted)'),
      drop.length ? h('div', null, h('b', null, 'Recycle Bin: '), drop.map((d) => d.label).join(', ')) : h('div', { class: 'muted' }, 'Nothing will be recycled.'),
      h('div', { class: 'xs dim' }, 'Next you\'ll choose folders for the kept files. Once they\'re all sorted, the file\'s download folder is removed and it\'s marked done.'),
    ], [{ label: 'Cancel', value: () => null }, { label: 'Keep and continue', primary: true, value: () => 'ok' }]);
    if (r !== 'ok') return;
    try {
      const res = await api.call('keep:apply', this.item.id, [...keep.map((d) => d.key), ...data.filter((d) => d.locked).map((d) => d.key)]);
      toast(`Kept ${keep.length}${res.recycled ? `, ${res.recycled} sent to the Recycle Bin` : ''}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  renderSort() {
    const it = this.item;
    clear(this.sortHost);
    this.sortHost.classList.remove('hidden');
    if (it.status === 'done') {
      this.sortHost.appendChild(h('div', { class: 'row' }, h('span', { class: 'chip green' }, icon('check'), 'Done'), h('span', { class: 'muted small' }, 'All kept versions are sorted.')));
      return;
    }
    const pending = [];
    if (!it.originalSorted && !it.originalRecycled && !it.originalMissing) pending.push({ kind: 'item', id: it.id, label: 'Original', path: it.path });
    for (const id of it.downloads || []) {
      const d = state.downloads.get(id);
      if (d && !d.sortedTo && d.state === 'completed') pending.push({ kind: 'download', id: d.id, label: d.name || basename(d.path), path: d.path });
    }
    if (!pending.length) { this.sortHost.appendChild(h('div', { class: 'muted small' }, 'Nothing left to sort.')); return; }
    if (!this.sel || !pending.find((p) => p.id === this.sel.id && p.kind === this.sel.kind)) this.sel = pending[0];
    const pick = h('div', { class: 'row wrap' }, h('span', { class: 'muted small' }, 'Sort kept files:'), pending.map((p) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'cmpsort', checked: this.sel && this.sel.id === p.id && this.sel.kind === p.kind, onchange: () => { this.sel = p; } }),
      h('img', { src: thumbUrl(p.path, 100), style: { width: '28px', height: '28px', objectFit: 'cover', borderRadius: '5px' } }), p.label)));
    if (this.sortPanel) this.sortPanel.api.destroy();
    this.sortPanel = createSortPanel({ target: () => this.sel && { kind: this.sel.kind, id: this.sel.id }, compact: true });
    this.sortHost.append(pick, h('div', { style: { height: '8px' } }), this.sortPanel);
  }

  onShow() {
    this.renderList();
    if (!this.itemId) { const first = this.candidates().find((s) => s.status !== 'done'); if (first) this.load(first.id); }
    else this.applyZoom();
  }
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}
