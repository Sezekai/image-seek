// Every downloaded file and the file it's linked to. Unlink, relink, recycle or sort them.
import {
  api, state, h, icon, btn, seg, clear, thumbUrl, fileUrl, fmtBytes, fmtDims, fmtTime, toast, on, emit,
  popupMenu, viewImage, hostOf, basename, makeResizable, confirmBox, dHash, hamming, lsGet, lsSet,
} from '../core.js';
import { createSortPanel } from '../sortpanel.js';

export class DownloadsView {
  constructor(root) {
    this.root = root;
    this.filter = 'all';
    this.q = '';
    this.sel = null;
    this.build();
    on('lib', () => this.render());
    api.on('dl:progress', (p) => this.progress(p));
    api.on('dl:finished', ({ id, state: st }) => { if (st === 'completed') this.checkSimilarity(id); });
  }

  build() {
    this.seg = seg(this.opts(), this.filter, (v) => { this.filter = v; this.render(); });
    this.search = h('input', { class: 'input search', placeholder: 'Search downloads', style: { width: '240px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.render(); } });
    this.listEl = h('div', { class: 'scroll' });
    this.mode = lsGet('downloads-view', 'cards');
    this.modeSeg = seg([{ value: 'cards', icon: 'cards', label: 'Cards' }, { value: 'list', icon: 'list', label: 'List' }], this.mode, (v) => { this.mode = v; lsSet('downloads-view', v); this.render(); });
    this.side = h('div', { class: 'side', style: { '--side-w': '440px' } });
    makeResizable(this.side, 'downloads', 340, 800);
    this.sideBody = h('div', { class: 'scroll' });
    this.side.appendChild(this.sideBody);
    this.root.append(
      h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'Downloads'), this.modeSeg, this.seg, this.search, h('div', { class: 'grow' }),
        btn('Open downloads folder', { icon: 'folder', onclick: () => api.call('shell:open', state.settings.downloadsDir) })),
      h('div', { class: 'split' }, h('div', { class: 'main' }, this.listEl), this.side));
  }

  opts(c = {}) {
    return [
      { value: 'all', label: 'All', count: c.all },
      { value: 'linked', label: 'Linked', count: c.linked },
      { value: 'unlinked', label: 'Unlinked', count: c.unlinked },
      { value: 'flagged', label: 'Looks unrelated', count: c.flagged },
    ];
  }

  isFlagged(d) { return d.itemId && d.dist != null && d.dist > (state.settings.unrelatedThreshold || 20); }

  render() {
    const all = [...state.downloads.values()].filter((d) => !d.sortedTo).sort((a, b) => b.time - a.time);
    const c = { all: all.length, linked: all.filter((d) => d.itemId).length, unlinked: all.filter((d) => !d.itemId).length, flagged: all.filter((d) => this.isFlagged(d)).length };
    clear(this.seg);
    for (const o of this.opts(c)) this.seg.appendChild(h('button', { class: o.value === this.filter ? 'on' : '', onclick: () => { this.filter = o.value; this.render(); } }, o.label, h('span', { class: 'n' }, o.count)));
    const list = all.filter((d) => {
      if (this.filter === 'linked' && !d.itemId) return false;
      if (this.filter === 'unlinked' && d.itemId) return false;
      if (this.filter === 'flagged' && !this.isFlagged(d)) return false;
      if (this.q) {
        const it = d.itemId && state.items.get(d.itemId);
        if (!`${d.name} ${d.url} ${d.pageUrl} ${it ? it.name : ''}`.toLowerCase().includes(this.q)) return false;
      }
      return true;
    });
    clear(this.listEl);
    if (!list.length) {
      this.listEl.appendChild(h('div', { class: 'empty' }, icon('download'), h('div', null, all.length ? 'Nothing matches.' : 'Files you download in the app\'s browser appear here.')));
    }
    if (this.mode === 'cards' && list.length) {
      const grid = h('div', { class: 'cards' });
      for (const d of list) grid.appendChild(this.card(d));
      this.listEl.appendChild(grid);
      this.renderSide();
      return;
    }
    for (const d of list) {
      const it = d.itemId && state.items.get(d.itemId);
      const row = h('div', { class: 'list-row', style: { cursor: 'pointer', background: this.sel === d.id ? 'var(--accent-bg)' : '' }, onclick: () => { this.sel = d.id; this.render(); } },
        d.state === 'completed' ? h('img', { class: 'th', src: thumbUrl(d.path, 120), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }) : h('div', { class: 'th', style: { width: '38px', height: '38px', display: 'grid', placeItems: 'center' } }, h('span', { class: 'spin' })),
        h('div', { class: 'grow col', style: { gap: '1px' } },
          h('div', { class: 'ell' }, d.name || basename(d.path)),
          h('div', { class: 'xs dim ell' }, `${fmtDims(d.width, d.height)} · ${fmtBytes(d.size || d.total)} · ${hostOf(d.pageUrl || d.url)} · ${fmtTime(d.time)}`)),
        this.isFlagged(d) ? h('span', { class: 'chip warn' }, 'unrelated?') : null,
        d.state === 'progress' ? h('div', { class: 'progress', dataset: { dl: d.id } }, h('div')) : null,
        it ? h('div', { class: 'row', style: { width: '230px', flex: 'none' } }, icon('link'), h('img', { class: 'th', src: thumbUrl(it.path, 80), style: { width: '28px', height: '28px' } }), h('span', { class: 'ell xs' }, it.name))
          : h('div', { class: 'row xs dim', style: { width: '230px', flex: 'none' } }, icon('unlink'), 'Unlinked'));
      this.listEl.appendChild(row);
    }
    this.renderSide();
  }

  card(d) {
    const it = d.itemId && state.items.get(d.itemId);
    const bigger = it && d.width && it.width && d.width * d.height > it.width * it.height;
    return h('div', { class: 'lcard click' + (this.sel === d.id ? ' sel' : ''), onclick: () => { this.sel = d.id; this.render(); }, ondblclick: () => d.state === 'completed' && viewImage(fileUrl(d.path)) },
      h('div', { class: 'lthumb' }, d.state === 'completed' ? h('img', { src: thumbUrl(d.path, 400), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }) : h('span', { class: 'spin' })),
      h('div', { class: 'lbody' },
        h('div', { class: 'lname ell', title: d.name || basename(d.path) }, d.name || basename(d.path)),
        h('div', { class: 'lsub ell' }, `${fmtDims(d.width, d.height)} · ${fmtBytes(d.size || d.total)} · ${hostOf(d.pageUrl || d.url)}`),
        h('div', { class: 'lchips' },
          bigger ? h('span', { class: 'chip green' }, 'larger') : null,
          this.isFlagged(d) ? h('span', { class: 'chip warn' }, 'unrelated?') : null,
          d.state === 'progress' ? h('div', { class: 'progress', dataset: { dl: d.id } }, h('div')) : null),
        it ? h('div', { class: 'llink', title: 'Linked to ' + it.name }, icon('link'), h('img', { src: thumbUrl(it.path, 80) }), h('span', { class: 'ell' }, it.name))
          : h('div', { class: 'llink dim' }, icon('unlink'), 'Unlinked'),
        h('div', { class: 'lfoot' }, h('span', null, fmtTime(d.time)))));
  }

  progress({ id, received, total }) {
    const el = this.listEl.querySelector(`[data-dl="${id}"] > div`);
    if (el && total) el.style.width = Math.round((received / total) * 100) + '%';
  }

  renderSide() {
    if (this.sortPanel) { this.sortPanel.api.destroy(); this.sortPanel = null; }
    clear(this.sideBody);
    const d = this.sel && state.downloads.get(this.sel);
    if (!d || d.sortedTo) {
      this.sideBody.appendChild(h('div', { class: 'empty' }, icon('download'), h('div', null, 'Select a download')));
      return;
    }
    const it = d.itemId && state.items.get(d.itemId);
    this.sideBody.append(
      h('div', { class: 'preview', onclick: () => viewImage(fileUrl(d.path)) }, d.state === 'completed' ? h('img', { src: thumbUrl(d.path, 800) }) : h('div', { class: 'dim' }, 'Downloading…')),
      h('div', { class: 'section' },
        h('div', { class: 'ell', style: { fontWeight: 600, marginBottom: '6px' }, title: d.path }, d.name || basename(d.path)),
        h('div', { class: 'kv' },
          h('span', { class: 'k' }, 'Resolution'), h('span', null, fmtDims(d.width, d.height)),
          h('span', { class: 'k' }, 'File'), h('span', null, `${fmtBytes(d.size)} · ${d.format || d.mime || '?'}${d.quality ? ' · q' + d.quality : ''}`),
          h('span', { class: 'k' }, 'From'), h('span', { class: 'ell', title: d.pageUrl || d.url }, d.pageUrl || d.url || '—'),
          h('span', { class: 'k' }, 'Saved'), h('span', null, fmtTime(d.time))),
        h('div', { class: 'row wrap', style: { marginTop: '10px' } },
          btn('Show in folder', { icon: 'folder', cls: 'sm', onclick: () => api.call('shell:show', d.path) }),
          d.pageUrl ? btn('Open page', { icon: 'external', cls: 'sm', onclick: () => emit('open-url', { url: d.pageUrl, itemId: d.itemId }) }) : null,
          btn('Recycle', { icon: 'trash', cls: 'sm danger', onclick: () => this.recycle(d) }))),
      h('div', { class: 'section' }, h('h3', null, 'Linked to'),
        it ? h('div', { class: 'row' }, h('img', { class: 'th', src: thumbUrl(it.path, 100), style: { width: '44px', height: '44px', borderRadius: '6px', objectFit: 'cover' } }),
          h('div', { class: 'grow col', style: { gap: '1px' } }, h('div', { class: 'ell' }, it.name), h('div', { class: 'xs dim' }, `${fmtDims(it.width, it.height)} · ${it.downloads} download(s)`)),
          btn('Open', { cls: 'sm', onclick: () => { emit('select-item', it.id); emit('show-view', 'lookups'); } }))
          : h('div', { class: 'dim small' }, 'Not linked to any file.'),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          btn(it ? 'Link to another file…' : 'Link to a file…', { icon: 'link', cls: 'sm', onclick: (e) => this.chooseLink(e, d) }),
          it ? btn('Unlink', { icon: 'unlink', cls: 'sm', onclick: () => this.relink(d, null) }) : null)),
      h('div', { class: 'section', style: { borderBottom: 0 } }, h('h3', null, 'Sort this file'),
        d.state === 'completed' ? (this.sortPanel = createSortPanel({ target: () => ({ kind: 'download', id: d.id }), onSorted: () => { this.sel = null; } })) : h('div', { class: 'dim xs' }, 'Wait for the download to finish.')));
  }

  chooseLink(e, d) {
    const r = e.target.getBoundingClientRect();
    const list = [...state.items.values()].filter((s) => s.status !== 'done' && s.id !== d.itemId)
      .sort((a, b) => (b.pendingDownloads || 0) - (a.pendingDownloads || 0) || b.addedAt - a.addedAt).slice(0, 60);
    if (!list.length) { toast('No files to link to', 'warn'); return; }
    popupMenu(r.left, r.bottom + 4, list.map((s) => ({ label: s.name, img: thumbUrl(s.path, 64), run: () => this.relink(d, s.id) })));
  }

  async relink(d, itemId) {
    try {
      await api.call('dl:relink', d.id, itemId);
      toast(itemId ? 'Linked' : 'Unlinked — moved to the Unlinked folder');
    } catch (e) { toast(e.message, 'error'); }
  }

  async recycle(d) {
    if (!(await confirmBox('Recycle this download?', `${d.name} will be sent to the Recycle Bin.`, 'Recycle'))) return;
    await api.call('dl:recycle', d.id).catch((e) => toast(e.message, 'error'));
    this.sel = null;
  }

  // Flag downloads that don't look like the file they're linked to.
  async checkSimilarity(id) {
    const d = state.downloads.get(id);
    if (!d || !d.itemId) return;
    const it = state.items.get(d.itemId);
    if (!it || it.originalRecycled) return;
    try {
      const [a, b] = await Promise.all([dHash(fileUrl(it.path)), dHash(fileUrl(d.path))]);
      const dist = hamming(a, b);
      if (dist != null) {
        await api.call('dl:update', id, { dist });
        if (dist > (state.settings.unrelatedThreshold || 20)) {
          toast(`"${d.name}" doesn't look like ${it.name}`, 'warn', 7000, { label: 'Unlink', run: () => this.relink({ id }, null) });
        }
      }
    } catch (_) { /* not an image */ }
  }

  onShow() { this.render(); }
}
