// Lookups: add folders, watch the queue, browse files and open their details.
import { api, state, h, icon, btn, seg, clear, thumbUrl, fmtDims, toast, on, emit, modal, safe, confirmBox, makeResizable } from '../core.js';
import { ItemDetail } from './itemdetail.js';

const TILE_W = 172, TILE_H = 228, GAP = 8;

export class LookupsView {
  constructor(root) {
    this.root = root;
    this.filter = 'active';
    this.mode = 'all';
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
    this.modeSeg = seg([
      { value: 'all', label: 'Both' }, { value: 'identify', label: 'Identify' }, { value: 'upgrade', label: 'Higher res' },
    ], this.mode, (v) => { this.mode = v; this.apply(); });
    this.batchSel = h('select', { class: 'input', style: { maxWidth: '220px' }, onchange: () => { this.batch = this.batchSel.value; this.apply(); } });
    this.search = h('input', { class: 'input search', placeholder: 'Search name, series, character, artist', style: { width: '260px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.apply(); } });
    this.queueBtn = btn('Pause', { icon: 'pause', onclick: () => this.toggleQueue() });
    this.toolbar = h('div', { class: 'toolbar' },
      btn('Add folder', { icon: 'plus', cls: 'primary', onclick: () => this.addFolder() }),
      this.batchSel,
      h('div', { class: 'vsep' }),
      this.statusSeg, this.modeSeg,
      this.search,
      h('div', { class: 'grow' }),
      this.queueBtn,
      btn('', { icon: 'reload', title: 'Retry failed lookups', onclick: () => safe(() => api.call('items:requeueErrors'), 'Retrying failed lookups') }),
      btn('', { icon: 'trash', title: 'Clear finished files from the list', onclick: () => this.clearDone() }));

    this.grid = h('div', { class: 'grid', tabindex: '0' });
    this.inner = h('div', { class: 'grid-inner' });
    this.grid.appendChild(this.inner);
    this.emptyEl = h('div', { class: 'empty hidden', style: { position: 'absolute', inset: '0' } });
    this.grid.appendChild(this.emptyEl);
    this.side = h('div', { class: 'side' });
    makeResizable(this.side, 'lookups', 380, 900);
    this.detailHost = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
    this.side.appendChild(this.detailHost);
    this.detail = new ItemDetail(this.detailHost);
    this.detail.render();
    this.root.append(this.toolbar, h('div', { class: 'split' }, h('div', { class: 'main' }, this.grid), this.side));

    this.grid.addEventListener('scroll', () => this.renderVisible());
    new ResizeObserver(() => this.layout()).observe(this.grid);
    this.grid.addEventListener('keydown', (e) => this.key(e));
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
      this.batchSel.appendChild(h('option', { value: b.id }, `${b.name} — ${b.mode === 'upgrade' ? 'higher res' : 'identify'} (${b.counts.total - b.counts.done}/${b.counts.total})`));
    }
    this.batchSel.value = state.batches.some((b) => b.id === cur) ? cur : 'all';
    this.batch = this.batchSel.value;
  }

  matches(s) {
    if (this.batch !== 'all' && s.batchId !== this.batch) return false;
    if (this.mode !== 'all' && s.mode !== this.mode) return false;
    if (this.q) {
      const g = s.guess || {};
      const hay = [s.name, ...(g.series || []).map((x) => x.name), ...(g.characters || []).map((x) => x.name), ...(g.artists || []).map((x) => x.name)].join(' ').toLowerCase();
      if (!hay.includes(this.q)) return false;
    }
    return true;
  }

  statusOk(s, f) {
    const done = s.status === 'done' || s.status === 'sorted';
    if (f === 'all') return true;
    if (f === 'active') return !done;
    if (f === 'queued') return s.status === 'queued' || s.status === 'looking' || (s.engines && s.engines.saucenao === 'waiting');
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
    const sub = s.status === 'queued' ? 'Queued' : s.status === 'looking' ? 'Looking up…' : s.status === 'error' ? (s.error || 'Error')
      : s.status === 'sorted' ? 'Sorted → ' + (s.sortedTo || '') : s.status === 'done' ? 'Done'
        : (g.series && g.series[0] ? g.series[0].name : (g.artists && g.artists[0] ? g.artists[0].name : 'No match'));
    const tags = h('div', { class: 'tags' },
      h('span', { class: 'chip ' + (s.mode === 'upgrade' ? 'blue' : '') }, s.mode === 'upgrade' ? 'Higher res' : 'Identify'),
      s.bigger ? h('span', { class: 'chip green' }, '↑ ' + fmtDims(s.bigger.width, s.bigger.height)) : null,
      s.downloads ? h('span', { class: 'chip warn' }, `${s.downloads} downloaded`) : null,
      s.engines && s.engines.saucenao === 'waiting' ? h('span', { class: 'chip' }, 'SauceNAO later') : null);
    const el = h('div', {
      class: 'tile' + (s.id === this.detail.id ? ' sel' : ''),
      style: { left: col * (this.tileW + GAP) + 'px', top: row * (TILE_H + GAP) + 'px', width: this.tileW + 'px', height: TILE_H + 'px' },
      onclick: () => { this.select(s.id); this.grid.focus(); },
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

  key(e) {
    if (e.target !== this.grid) return;
    if (e.key === 'ArrowRight') { this.move(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { this.move(-1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { this.move(this.cols); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.move(-this.cols); e.preventDefault(); }
    else if (e.key === 'Delete' && this.detail.item) { this.detail.recycle(); e.preventDefault(); }
    else if (e.key === 'Enter' && this.detail.item) { emit('view-image', this.detail.item.path); }
    else if (this.detail.keydown(e)) e.preventDefault();
  }

  // After sorting, jump to the next file in the list (sorted files drop out of "To do").
  afterSort(id) {
    const idx = this.list.findIndex((s) => s.id === id);
    const next = this.list[idx + 1] || this.list[idx - 1];
    setTimeout(() => {
      const it = state.items.get(id);
      const stillListed = it && this.statusOk(it, this.filter);
      if (!stillListed && next) this.select(next.id);
      this.grid.focus();
    }, 450);
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
    let mode = 'identify';
    let recursive = !!state.settings.includeSubfolders;
    const pathEl = h('div', { class: 'input ell', style: { display: 'flex', alignItems: 'center', flex: 1 } }, folder || 'No folder chosen');
    const choose = async () => {
      const f = await api.call('dialog:folder', 'Choose a folder of images');
      if (f) { folder = f; pathEl.textContent = f; }
    };
    const opt = (value, title, text, ic) => {
      const l = h('label', { class: value === mode ? 'on' : '' }, h('input', { type: 'radio', name: 'mode', value }), h('b', null, icon(ic), title), h('span', null, text));
      l.onclick = () => { mode = value; cards.querySelectorAll('label').forEach((x) => x.classList.toggle('on', x === l)); };
      return l;
    };
    const cards = h('div', { class: 'option-cards' },
      opt('identify', 'Identify', 'Find the series, character and artist, then sort the files into your folders.', 'search'),
      opt('upgrade', 'Higher resolution', 'Find better versions, download them in the app\'s browser, compare, keep the best.', 'sparkle'));
    const sub = h('input', { type: 'checkbox', checked: recursive, onchange: (e) => { recursive = e.target.checked; } });
    if (!folder) setTimeout(choose, 50);
    const r = await modal('Add a folder', [
      h('div', { class: 'row' }, pathEl, btn('Browse…', { icon: 'folder', onclick: choose })),
      cards,
      h('label', { class: 'check' }, sub, 'Include subfolders'),
      h('div', { class: 'xs dim' }, 'Files stay where they are until you sort or recycle them.'),
    ], [{ label: 'Cancel', value: () => null }, { label: 'Add and look up', primary: true, value: () => 'ok' }]);
    if (r !== 'ok' || !folder) return;
    if (recursive !== state.settings.includeSubfolders) state.settings = await api.call('settings:set', { includeSubfolders: recursive });
    const res = await safe(() => api.call('batch:add', folder, mode, recursive));
    if (res) {
      toast(res.added ? `Added ${res.added} image(s)${res.skipped ? `, ${res.skipped} already listed` : ''}` : 'No new images found in that folder', res.added ? 'info' : 'warn');
      this.filter = 'active';
      this.batch = res.batchId;
    }
  }

  onShow() { setTimeout(() => this.grid.focus(), 0); this.layout(); }
}
