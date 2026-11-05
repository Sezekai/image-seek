// Lookups: add folders, watch the queue, browse files and open their details.
import { api, state, h, icon, btn, seg, clear, thumbUrl, fmtDims, toast, on, emit, modal, safe, confirmBox, makeResizable, popupMenu, ENGINE_LABEL } from '../core.js';
import { ItemDetail } from './itemdetail.js';

const TILE_W = 172, TILE_H = 228, GAP = 8;

export class LookupsView {
  constructor(root) {
    this.root = root;
    this.filter = 'active';
    this.extra = 'all'; // all | bigger | downloads
    this.dock = 'closed';
    this.batch = 'all';
    this.q = '';
    this.list = [];
    this.build();
    on('lib', (ids) => this.onLib(ids));
    on('queue', () => this.renderQueueBtn());
    on('item-sorted', (id) => this.afterSort(id));
  }

  build() {
    this.imgCache = new Map();
    this.statusSeg = seg(this.statusOptions(), this.filter, (v) => { this.filter = v; this.apply(); });
    this.extraSeg = seg([
      { value: 'all', label: 'Any' },
      { value: 'bigger', label: 'Larger found', title: 'Files where a lookup found a bigger version' },
      { value: 'downloads', label: 'Has downloads', title: 'Files with downloaded versions waiting' },
    ], this.extra, (v) => { this.extra = v; this.apply(); });
    this.batchSel = h('select', { class: 'input', style: { maxWidth: '220px' }, onchange: () => { this.batch = this.batchSel.value; this.renderBatchBtn(); this.apply(); } });
    this.batchRemove = btn('', { icon: 'x', cls: 'hidden', title: 'Remove this folder from Image Seek (stops picking up new images; files with downloads stay)', onclick: () => this.removeBatch() });
    this.search = h('input', { class: 'input search', placeholder: 'Search name, series, character, artist', style: { flex: '1 1 140px', minWidth: '120px', maxWidth: '300px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.apply(); } });
    this.queueBtn = btn('Pause', { icon: 'pause', onclick: () => this.toggleQueue() });
    this.retryBtn = btn('Retry', { icon: 'reload', title: 'Retry failed or blocked lookups', onclick: (e) => this.retryMenu(e) });
    this.browserBtn = btn('Browser', { icon: 'globe', title: 'Show or hide the browser next to the files', onclick: () => emit('dock', this.dock === 'closed' ? (state.lastDock || 'small') : 'closed') });
    this.toolbar = h('div', { class: 'toolbar' },
      btn('Add folder', { icon: 'plus', cls: 'primary', onclick: () => this.addFolder() }),
      this.batchSel, this.batchRemove,
      h('div', { class: 'vsep' }),
      this.statusSeg, this.extraSeg,
      this.search,
      this.browserBtn,
      this.queueBtn,
      this.retryBtn,
      btn('', { icon: 'trash', title: 'Clear finished files from the list', onclick: () => this.clearDone() }));

    this.grid = h('div', { class: 'grid', tabindex: '0' });
    this.inner = h('div', { class: 'grid-inner' });
    this.grid.appendChild(this.inner);
    this.emptyEl = h('div', { class: 'empty hidden', style: { position: 'absolute', inset: '0' } });
    this.grid.appendChild(this.emptyEl);
    this.histHost = h('div', { class: 'hist-host hidden' }); // browser history covers the grid in the small view
    this.gridPane = h('div', { class: 'gridpane' }, this.grid, this.histHost);
    makeResizable(this.gridPane, 'lookups-grid', 200, 1400, { left: true });
    this.slot = h('div', { class: 'bslot' });
    this.mainEl = h('div', { class: 'main lk-main dock-closed' }, this.gridPane, this.slot);
    this.side = h('div', { class: 'side' });
    makeResizable(this.side, 'lookups', 380, 900);
    this.detailHost = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
    this.side.appendChild(this.detailHost);
    this.detail = new ItemDetail(this.detailHost);
    this.detail.render();
    this.root.append(this.toolbar, h('div', { class: 'split' }, this.mainEl, this.side));

    this.grid.addEventListener('scroll', () => this.renderVisible());
    new ResizeObserver(() => this.layout()).observe(this.grid);
  }

  statusOptions(counts = {}) {
    return [
      { value: 'active', label: 'To do', count: counts.active },
      { value: 'queued', label: 'Queued', count: counts.queued },
      { value: 'looked', label: 'Looked up', count: counts.looked },
      { value: 'error', label: 'Errors', count: counts.error },
      { value: 'done', label: 'Done', count: counts.done },
      { value: 'all', label: 'All', count: counts.all },
    ];
  }

  onLib(ids) {
    this.renderBatches();
    this.apply(true);
    if (this.detail.id && (!ids.length || ids.includes(this.detail.id))) this.detail.refresh();
  }

  renderBatches() {
    const cur = this.batch;
    clear(this.batchSel);
    this.batchSel.appendChild(h('option', { value: 'all' }, `All folders (${state.batches.length})`));
    for (const b of state.batches) {
      this.batchSel.appendChild(h('option', { value: b.id }, `${b.name} (${b.counts.total - b.counts.done}/${b.counts.total})`));
    }
    this.batchSel.value = state.batches.some((b) => b.id === cur) ? cur : 'all';
    this.batch = this.batchSel.value;
    this.renderBatchBtn();
  }

  renderBatchBtn() {
    this.batchRemove.classList.toggle('hidden', this.batch === 'all');
    const b = state.batches.find((x) => x.id === this.batch);
    this.batchSel.title = b ? b.folder + (state.settings.autoAdd !== false ? '\nNew images saved here are picked up automatically' : '') : '';
  }

  async removeBatch() {
    const b = state.batches.find((x) => x.id === this.batch);
    if (!b) return;
    if (!(await confirmBox('Remove this folder?', `${b.folder}\n\nIts files leave the list (ones with downloads stay) and new images saved there won't be picked up any more. Nothing on disk changes.`, 'Remove'))) return;
    await safe(() => api.call('batch:remove', b.id), 'Folder removed');
    this.batch = 'all';
  }

  matches(s) {
    if (this.batch !== 'all' && s.batchId !== this.batch) return false;
    if (this.extra === 'bigger' && !s.bigger) return false;
    if (this.extra === 'downloads' && !s.pendingDownloads) return false;
    if (this.q) {
      const g = s.guess || {};
      const hay = [s.name, ...(g.series || []).map((x) => x.name), ...(g.characters || []).map((x) => x.name), ...(g.artists || []).map((x) => x.name)].join(' ').toLowerCase();
      if (!hay.includes(this.q)) return false;
    }
    return true;
  }

  statusOk(s, f) {
    const done = s.status === 'done';
    if (f === 'all') return true;
    if (f === 'active') return !done;
    if (f === 'queued') return !done && (s.status === 'queued' || s.status === 'looking' || Object.values(s.engines || {}).includes('waiting'));
    if (f === 'looked') return s.status === 'looked';
    if (f === 'error') return s.status === 'error';
    if (f === 'done') return done;
    return true;
  }

  apply(keepScroll) {
    const base = [...state.items.values()].filter((s) => this.matches(s));
    const counts = {};
    for (const f of ['active', 'queued', 'looked', 'error', 'done', 'all']) counts[f] = base.filter((s) => this.statusOk(s, f)).length;
    // update counts on segment buttons
    const opts = this.statusOptions(counts);
    clear(this.statusSeg);
    for (const o of opts) {
      const b = h('button', { class: o.value === this.filter ? 'on' : '', onclick: () => { this.filter = o.value; this.apply(); } }, o.label, h('span', { class: 'n' }, o.count));
      this.statusSeg.appendChild(b);
    }
    this.list = base.filter((s) => this.statusOk(s, this.filter)).sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!keepScroll) this.grid.scrollTop = 0;
    this.layout();
    if (this.detail.id && !state.items.has(this.detail.id)) this.select(null);
    else if (!this.detail.id && this.list.length) this.select(this.list[0].id);
  }

  layout() {
    const w = this.grid.clientWidth - 20;
    this.cols = Math.max(1, Math.floor((w + GAP) / (TILE_W + GAP)));
    this.tileW = Math.floor((w - (this.cols - 1) * GAP) / this.cols);
    const rows = Math.ceil(this.list.length / this.cols);
    this.inner.style.height = Math.max(0, rows * (TILE_H + GAP) - GAP) + 'px';
    this.emptyEl.classList.toggle('hidden', this.list.length > 0);
    if (!this.list.length) {
      clear(this.emptyEl).append(icon('folderPlus'), h('div', null, state.items.size ? 'Nothing matches these filters.' : 'Add a folder of images to identify or to find higher-resolution versions of.'),
        state.items.size ? null : btn('Add folder', { icon: 'plus', cls: 'primary', onclick: () => this.addFolder() }));
    }
    this.rendered = new Map();
    clear(this.inner);
    this.renderVisible();
  }

  renderVisible() {
    if (!this.list.length) return;
    const top = this.grid.scrollTop;
    const hgt = this.grid.clientHeight;
    const r0 = Math.max(0, Math.floor(top / (TILE_H + GAP)) - 2);
    const r1 = Math.ceil((top + hgt) / (TILE_H + GAP)) + 2;
    const want = new Set();
    for (let i = r0 * this.cols; i < Math.min(this.list.length, r1 * this.cols); i++) want.add(i);
    for (const [i, el] of this.rendered) if (!want.has(i)) { el.remove(); this.rendered.delete(i); }
    for (const i of want) {
      if (this.rendered.has(i)) continue;
      const el = this.tile(this.list[i], i);
      this.rendered.set(i, el);
      this.inner.appendChild(el);
    }
  }

  tile(s, i) {
    const row = Math.floor(i / this.cols), col = i % this.cols;
    const g = s.guess || {};
    const waiting = Object.entries(s.engines || {}).filter(([, v]) => v === 'waiting').map(([k]) => ENGINE_LABEL[k]);
    const sub = s.status === 'queued' ? 'Queued' : s.status === 'looking' ? 'Looking up…' : s.status === 'error' ? (s.error || 'Error')
      : s.status === 'done' ? 'Done' + (s.sortedTo ? ' → ' + s.sortedTo : '')
        : (g.series && g.series[0] ? g.series[0].name : (g.artists && g.artists[0] ? g.artists[0].name : 'No match'));
    const tags = h('div', { class: 'tags' },
      s.bigger ? h('span', { class: 'chip green', title: 'A larger version was found on ' + s.bigger.site }, '↑ ' + fmtDims(s.bigger.width, s.bigger.height)) : null,
      s.pendingDownloads ? h('span', { class: 'chip warn' }, `${s.pendingDownloads} downloaded`) : null,
      s.originalSorted && s.status !== 'done' ? h('span', { class: 'chip blue' }, 'original sorted') : null,
      waiting.length ? h('span', { class: 'chip', title: 'Will be retried automatically' }, waiting.join(', ') + ' later') : null);
    const el = h('div', {
      class: 'tile' + (s.id === this.detail.id ? ' sel' : ''),
      style: { left: col * (this.tileW + GAP) + 'px', top: row * (TILE_H + GAP) + 'px', width: this.tileW + 'px', height: TILE_H + 'px' },
      onclick: () => { this.select(s.id); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); },
      ondblclick: () => emit('view-image', s.path),
    },
    h('div', { class: 'thumb' }, this.thumbImg(s), tags),
    h('div', { class: 'meta' },
      h('div', { class: 'row' }, h('span', { class: 'dot ' + s.status }), h('span', { class: 'name ell grow', title: s.name }, s.name)),
      h('div', { class: 'sub ell', title: sub }, sub)));
    el.dataset.id = s.id;
    return el;
  }

  // Re-use loaded <img> elements so tiles don't flicker when the list updates.
  thumbImg(s) {
    const key = s.id + '|' + s.path;
    let img = this.imgCache.get(key);
    if (!img) {
      img = h('img', { src: thumbUrl(s.path, 320), loading: 'lazy', draggable: 'false', onerror: (e) => { e.target.style.display = 'none'; } });
      this.imgCache.set(key, img);
      if (this.imgCache.size > 3000) this.imgCache.delete(this.imgCache.keys().next().value);
    }
    return img;
  }

  select(id) {
    this.detail.show(id);
    state.selectedItem = id;
    for (const el of this.inner.children) el.classList.toggle('sel', el.dataset.id === id);
    emit('selected-item', id);
  }

  ensureVisible(idx) {
    const row = Math.floor(idx / this.cols);
    const y = row * (TILE_H + GAP);
    if (y < this.grid.scrollTop) this.grid.scrollTop = y;
    else if (y + TILE_H > this.grid.scrollTop + this.grid.clientHeight) this.grid.scrollTop = y + TILE_H - this.grid.clientHeight + 10;
  }

  move(delta) {
    if (!this.list.length) return;
    let idx = this.list.findIndex((s) => s.id === this.detail.id);
    idx = Math.max(0, Math.min(this.list.length - 1, (idx < 0 ? 0 : idx) + delta));
    this.select(this.list[idx].id);
    this.ensureVisible(idx);
  }

  // Called by the app's keyboard handler when this screen is showing and you're not typing.
  handleKey(e) {
    const k = e.key;
    if (k === 'ArrowRight') { this.move(1); return true; }
    if (k === 'ArrowLeft') { this.move(-1); return true; }
    if (k === 'ArrowDown') { this.move(this.cols); return true; }
    if (k === 'ArrowUp') { this.move(-this.cols); return true; }
    if (k === 'Home') { this.move(-1e9); return true; }
    if (k === 'End') { this.move(1e9); return true; }
    const it = this.detail.item;
    if (!it) return false;
    if (k === 'Delete') { this.detail.recycle(); return true; }
    if (k === 'Enter' || k === 't' || k === 'T') { emit('view-image', it.path); return true; }
    if (k === 'c' || k === 'C') { emit('open-compare', it.id); return true; }
    if (k === 'r' || k === 'R') { api.call('item:requeue', it.id).then(() => toast('Looking up again')); return true; }
    if (k === 'g' || k === 'G') { emit('search-in-tab', { engine: 'google', path: it.path, itemId: it.id }); return true; }
    if (k === 'y' || k === 'Y') { emit('search-in-tab', { engine: 'yandex', path: it.path, itemId: it.id }); return true; }
    if (k === 'e' || k === 'E') { if (this.dock !== 'closed') { emit('dock', this.dock === 'small' ? 'expanded' : 'small'); return true; } }
    return false;
  }

  // After sorting, jump to the next file in the list (sorted files drop out of "To do").
  afterSort(id) {
    const idx = this.list.findIndex((s) => s.id === id);
    const next = this.list[idx + 1] || this.list[idx - 1];
    setTimeout(() => {
      const it = state.items.get(id);
      const stillListed = it && this.statusOk(it, this.filter);
      if (!stillListed && next) this.select(next.id);
    }, 450);
  }

  retryMenu(e) {
    const f = (state.queue && state.queue.failed) || {};
    const r = e.currentTarget.getBoundingClientRect();
    const items = [{ label: `All failed and blocked (${f.all || 0})`, run: () => this.retry(null) }, '-'];
    for (const k of ['iqdb', 'saucenao', 'ascii2d', 'tracemoe']) items.push({ label: `${ENGINE_LABEL[k]} only (${f[k] || 0})`, run: () => this.retry(k) });
    popupMenu(r.left, r.bottom + 4, items);
  }

  async retry(engine) {
    const n = await safe(() => api.call('items:requeueErrors', engine));
    if (n != null) toast(n ? `Retrying ${n} file${n === 1 ? '' : 's'}${engine ? ' on ' + ENGINE_LABEL[engine] : ''}` : 'Nothing to retry', n ? 'info' : 'warn');
  }

  setDock(d) {
    this.dock = d;
    this.mainEl.classList.remove('dock-closed', 'dock-small', 'dock-expanded');
    this.mainEl.classList.add('dock-' + d);
    this.browserBtn.classList.toggle('on', d !== 'closed');
    requestAnimationFrame(() => this.layout());
  }

  renderQueueBtn() {
    const q = state.queue || {};
    clear(this.queueBtn);
    this.queueBtn.append(icon(q.paused ? 'play' : 'pause'), document.createTextNode(q.paused ? 'Resume' : 'Pause'));
    this.queueBtn.title = q.paused ? 'Resume lookups' : 'Pause lookups';
  }

  async toggleQueue() {
    const paused = !(state.queue && state.queue.paused);
    state.settings = await api.call('settings:set', { queuePaused: paused });
    state.queue = await api.call('queue:status');
    emit('queue');
  }

  async clearDone() {
    if (!(await confirmBox('Clear finished files?', 'Done and sorted files are removed from this list. Nothing on disk changes.', 'Clear'))) return;
    await safe(() => api.call('items:clearDone'));
  }

  async addFolder(prefill) {
    let folder = prefill || null;
    let recursive = !!state.settings.includeSubfolders;
    const pathEl = h('div', { class: 'input ell', style: { display: 'flex', alignItems: 'center', flex: 1 } }, folder || 'No folder chosen');
    const choose = async () => {
      const f = await api.call('dialog:folder', 'Choose a folder of images');
      if (f) { folder = f; pathEl.textContent = f; }
    };
    const sub = h('input', { type: 'checkbox', checked: recursive, onchange: (e) => { recursive = e.target.checked; } });
    if (!folder) setTimeout(choose, 50);
    const r = await modal('Add a folder', [
      h('div', { class: 'row' }, pathEl, btn('Browse…', { icon: 'folder', onclick: choose })),
      h('label', { class: 'check' }, sub, 'Include subfolders'),
      h('div', { class: 'xs dim' }, 'Each file is looked up for its series, characters, artist and any larger versions. Sort it straight away, or download better versions and compare. Files stay where they are until you sort or recycle them.'),
      state.settings.autoAdd !== false ? h('div', { class: 'xs dim' }, 'New images saved into this folder later are added and looked up automatically. Adding a folder that\'s already listed just picks up anything new.') : null,
    ], [{ label: 'Cancel', value: () => null }, { label: 'Add and look up', primary: true, value: () => 'ok' }]);
    if (r !== 'ok' || !folder) return;
    if (recursive !== state.settings.includeSubfolders) state.settings = await api.call('settings:set', { includeSubfolders: recursive });
    const res = await safe(() => api.call('batch:add', folder, recursive));
    if (res) {
      toast(res.added ? `Added ${res.added} image(s)${res.skipped ? `, ${res.skipped} already listed` : ''}` : 'No new images found in that folder', res.added ? 'info' : 'warn');
      this.filter = 'active';
      this.batch = res.batchId;
    }
  }

  onShow() { this.layout(); }
}
