// Detail panel for one looked-up file: preview, best guess, matches, manual search buttons,
// and either the sort panel (identify) or its linked downloads (higher resolution).
import {
  api, state, h, icon, btn, seg, clear, fmtBytes, fmtDims, fmtMp, thumbUrl, fileUrl, basename, dirname,
  simClass, ENGINE_LABEL, toast, emit, viewImage, confirmBox, hostOf,
} from '../core.js';
import { createSortPanel } from '../sortpanel.js';

const ENGINE_STATE = {
  done: ['green', 'done'], error: ['red', 'failed'], blocked: ['warn', 'blocked'], waiting: ['warn', 'waiting for quota'],
  skipped: ['', 'skipped'], undefined: ['', 'queued'],
};

export const SEARCH_SITES = [
  { engine: 'google', label: 'Google Lens', icon: 'search' },
  { engine: 'yandex', label: 'Yandex', icon: 'search' },
  { engine: 'ascii2d', label: 'ascii2d', icon: 'search' },
  { engine: 'saucenao', label: 'SauceNAO', icon: 'search' },
  { engine: 'iqdb', label: 'IQDB', icon: 'search' },
];

export function searchButtons(getPath, getItemId) {
  return h('div', { class: 'search-btns' }, SEARCH_SITES.map((s) => {
    const b = btn(s.label, { icon: s.icon, title: `Click to search in the app's browser, or drag this button onto a web page to drop the file there` });
    b.setAttribute('draggable', 'true');
    b.addEventListener('dragstart', (e) => { e.preventDefault(); const p = getPath(); if (p) api.startDrag(p); });
    b.addEventListener('click', () => { const p = getPath(); if (p) emit('search-in-tab', { engine: s.engine, path: p, itemId: getItemId() }); });
    return b;
  }));
}

export class ItemDetail {
  constructor(container) {
    this.el = container;
    this.item = null;
    this.sortPanel = null;
    this.keptSel = null;
    this.showWeak = new Set();
  }

  async show(id) {
    this.id = id;
    if (!id) { this.item = null; this.render(); return; }
    this.item = await api.call('item:get', id).catch(() => null);
    if (this.id !== id) return;
    this.render();
  }

  async refresh() { if (this.id) await this.show(this.id); }

  keydown(e) { return this.sortPanel ? this.sortPanel.api.key(e) : false; }

  render() {
    const prevScroll = this.el.querySelector('.scroll') ? this.el.querySelector('.scroll').scrollTop : 0;
    if (this.sortPanel) { this.sortPanel.api.destroy(); this.sortPanel = null; }
    clear(this.el);
    const it = this.item;
    if (!it) {
      this.el.appendChild(h('div', { class: 'empty', style: { flex: 1 } }, icon('image'), h('div', null, 'Select a file to see its matches')));
      return;
    }
    const summary = state.items.get(it.id) || it;
    const scroll = h('div', { class: 'scroll' });

    // ---- head
    const modeSeg = seg([
      { value: 'identify', label: 'Identify', title: 'Find out what it is, then sort it' },
      { value: 'upgrade', label: 'Higher res', title: 'Find and download better versions, then compare' },
    ], it.mode, (m) => api.call('item:mode', it.id, m));
    this.el.appendChild(h('div', { class: 'detail-head' },
      h('span', { class: 'dot ' + it.status }),
      h('div', { class: 'name ell grow', title: it.path }, it.name),
      modeSeg,
      btn('', { icon: 'folder', cls: 'sm icon ghost', title: 'Show in folder', onclick: () => api.call('shell:show', it.path) }),
      btn('', { icon: 'reload', cls: 'sm icon ghost', title: 'Look up again', onclick: () => api.call('item:requeue', it.id).then(() => toast('Queued again')) }),
      btn('', { icon: 'trash', cls: 'sm icon ghost danger', title: 'Send file to the Recycle Bin', onclick: () => this.recycle() })));

    // ---- preview
    const gone = it.originalRecycled;
    const pv = h('div', { class: 'preview', onclick: () => !gone && viewImage(fileUrl(it.path)) },
      gone ? h('div', { class: 'dim' }, 'Original sent to the Recycle Bin') : h('img', { src: thumbUrl(it.path, 900), draggable: 'false' }));
    if (!gone) {
      const dh = btn('Drag file', { icon: 'hand', cls: 'sm drag-handle', title: 'Drag onto a web page (e.g. Google Images) to search with it' });
      dh.setAttribute('draggable', 'true');
      dh.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); api.startDrag(it.path); });
      dh.addEventListener('click', (e) => e.stopPropagation());
      pv.appendChild(dh);
    }
    scroll.appendChild(pv);

    // ---- info
    scroll.appendChild(h('div', { class: 'section' },
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, 'Resolution'), h('span', null, `${fmtDims(it.width, it.height)}  ·  ${fmtMp(it.width, it.height)}`),
        h('span', { class: 'k' }, 'File'), h('span', null, `${fmtBytes(it.size)}  ·  ${it.format || '?'}${it.quality ? `  ·  JPEG q≈${it.quality}` : ''}`),
        h('span', { class: 'k' }, 'Folder'), h('span', { class: 'ell', title: dirname(it.path) }, dirname(it.path)),
        it.sortedTo ? h('span', { class: 'k' }, 'Sorted to') : null, it.sortedTo ? h('span', null, it.sortedTo) : null)));

    // ---- bigger version
    if (it.bigger) {
      scroll.appendChild(h('div', { class: 'section', style: { background: 'var(--accent-bg)' } },
        h('div', { class: 'row' }, icon('sparkle'),
          h('div', { class: 'grow small' }, h('b', null, 'Larger version exists: '), `${fmtDims(it.bigger.width, it.bigger.height)} on ${it.bigger.site}`),
          it.bigger.url ? btn('Open', { cls: 'sm primary', onclick: () => this.open(it.bigger.url) }) : null)));
    }

    // ---- guess
    const g = it.guess || { series: [], characters: [], artists: [] };
    const group = (label, list, kind) => h('div', { class: 'guess-group' }, h('div', { class: 'lbl' }, label),
      h('div', { class: 'vals' }, list.length ? list.map((v, i) => h('button', {
        class: 'chip' + (i === 0 ? ' green' : ''), title: `Score ${v.score} · ${v.sources.join(', ')}${kind === 'series' ? ' — click to filter sort folders' : ''}`,
        onclick: () => { if (this.sortPanel) this.sortPanel.api.setFilter(v.name); navigator.clipboard.writeText(v.name).catch(() => {}); },
      }, v.name)) : h('span', { class: 'dim xs' }, it.status === 'queued' || it.status === 'looking' ? '…' : 'unknown')));
    scroll.appendChild(h('div', { class: 'section' }, h('h3', null, 'Best guess'),
      group('Series', g.series, 'series'), group('Characters', g.characters, 'char'), group('Artist', g.artists, 'artist')));

    // ---- downloads (upgrade) or sort (identify)
    if (it.mode === 'upgrade') scroll.appendChild(this.renderUpgrade(it));
    else if (it.status !== 'sorted' && it.status !== 'done' && !gone) {
      this.sortPanel = createSortPanel({ target: () => ({ kind: 'item', id: it.id }), compact: true, onSorted: () => emit('item-sorted', it.id) });
      scroll.appendChild(h('div', { class: 'section' }, h('h3', null, 'Sort into', h('span', { class: 'grow' }), h('span', { class: 'dim', style: { textTransform: 'none', letterSpacing: 0 } }, '1–9 · N · V')), this.sortPanel));
    }

    // ---- manual search
    scroll.appendChild(h('div', { class: 'section' }, h('h3', null, 'Search manually'),
      gone ? h('div', { class: 'dim xs' }, 'The original is gone, so manual search is unavailable.') : searchButtons(() => it.path, () => it.id)));

    // ---- results
    scroll.appendChild(this.renderResults(it, summary));
    this.el.appendChild(scroll);
    scroll.scrollTop = prevScroll;
  }

  renderUpgrade(it) {
    const sec = h('div', { class: 'section' });
    const dls = (it.downloads || []).map((id) => state.downloads.get(id)).filter(Boolean);
    sec.appendChild(h('h3', null, `Downloaded versions (${dls.length})`, h('span', { class: 'grow' }),
      dls.length ? btn('Compare', { icon: 'compare', cls: 'sm primary', onclick: () => emit('open-compare', it.id) }) : null));
    if (!dls.length) {
      sec.appendChild(h('div', { class: 'dim xs' }, 'Open a match below (or search manually), then download or right-click → Save image. Downloads from tabs opened for this file are saved and linked here automatically.'));
    } else {
      for (const d of dls) {
        const flagged = d.dist != null && d.dist > (state.settings.unrelatedThreshold || 20);
        const bigger = d.width && it.width && d.width * d.height > it.width * it.height;
        sec.appendChild(h('div', { class: 'list-row', style: { padding: '5px 0', borderBottom: '0' } },
          h('img', { class: 'th', src: thumbUrl(d.path, 160), onclick: () => viewImage(fileUrl(d.path)) }),
          h('div', { class: 'grow col', style: { gap: '1px' } },
            h('div', { class: 'ell small' }, d.name || basename(d.path)),
            h('div', { class: 'xs dim' }, `${fmtDims(d.width, d.height)} · ${fmtBytes(d.size)} · ${hostOf(d.pageUrl || d.url)}`)),
          d.state === 'progress' ? h('span', { class: 'chip blue' }, 'downloading') : null,
          bigger ? h('span', { class: 'chip green' }, 'larger') : null,
          flagged ? h('span', { class: 'chip warn', title: 'Looks like a different picture' }, 'unrelated?') : null,
          d.sortedTo ? h('span', { class: 'chip' }, 'sorted') : null));
      }
    }
    // Kept files waiting to be sorted after Compare.
    if (it.phase === 'sort') {
      const pending = [];
      if ((it.keep || []).includes('original') && !it.originalSorted && !it.originalRecycled) pending.push({ kind: 'item', id: it.id, label: 'Original', path: it.path });
      for (const k of it.keep || []) {
        if (k === 'original') continue;
        const d = state.downloads.get(k);
        if (d && !d.sortedTo) pending.push({ kind: 'download', id: d.id, label: d.name || basename(d.path), path: d.path });
      }
      if (pending.length) {
        if (!this.keptSel || !pending.find((p) => p.id === this.keptSel.id && p.kind === this.keptSel.kind)) this.keptSel = pending[0];
        const list = h('div', { class: 'col', style: { gap: '4px', margin: '10px 0 8px' } }, h('div', { class: 'xs muted' }, 'Kept — choose one, then a folder:'),
          pending.map((p) => h('label', { class: 'check' }, h('input', {
            type: 'radio', name: 'keptsel', checked: this.keptSel.id === p.id && this.keptSel.kind === p.kind,
            onchange: () => { this.keptSel = p; },
          }), h('img', { src: thumbUrl(p.path, 120), style: { width: '30px', height: '30px', objectFit: 'cover', borderRadius: '5px' } }), h('span', { class: 'ell' }, p.label))));
        sec.appendChild(list);
        this.sortPanel = createSortPanel({ target: () => this.keptSel && { kind: this.keptSel.kind, id: this.keptSel.id }, compact: true, onSorted: () => emit('item-sorted', it.id) });
        sec.appendChild(this.sortPanel);
      }
    } else if (!it.originalRecycled && it.status !== 'done' && dls.length === 0) {
      sec.appendChild(h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'xs muted', style: { cursor: 'pointer' } }, 'Nothing better found? Sort the original'),
        h('div', { style: { marginTop: '8px' } }, (this.sortPanel = createSortPanel({ target: () => ({ kind: 'item', id: it.id }), compact: true, onSorted: () => emit('item-sorted', it.id) })))));
    }
    if (it.status === 'done') sec.appendChild(h('div', { class: 'chip green', style: { marginTop: '8px' } }, icon('check'), 'Done'));
    return sec;
  }

  renderResults(it, summary) {
    const sec = h('div', { class: 'section', style: { borderBottom: 0 } });
    const engines = ['iqdb', 'saucenao', 'ascii2d', 'tracemoe'].filter((e) => state.settings.engines[e] || (it.engines || {})[e]);
    sec.appendChild(h('h3', null, 'Matches', h('span', { class: 'grow' }),
      h('div', { class: 'engines' }, engines.map((e) => {
        const st = (it.engines || {})[e];
        const [cls, txt] = ENGINE_STATE[st] || ENGINE_STATE.undefined;
        const err = (it.engineErrors || {})[e];
        return h('span', { class: 'chip ' + cls, title: err || '' }, `${ENGINE_LABEL[e]} · ${txt}`);
      }))));
    const min = state.settings.minSimilarity;
    for (const e of engines) {
      const rs = (it.results || []).filter((r) => r.engine === e);
      const st = (it.engines || {})[e];
      const err = (it.engineErrors || {})[e];
      if (!rs.length && st !== 'error' && st !== 'blocked') continue;
      const head = h('div', { class: 'engine-head' }, ENGINE_LABEL[e], h('span', { class: 'grow' }));
      if (st === 'error' || st === 'blocked') {
        head.appendChild(btn('Retry', { cls: 'sm', onclick: () => api.call('item:requeue', it.id, [e]) }));
        if (e === 'ascii2d' && st === 'blocked') head.appendChild(btn('Open in browser', { cls: 'sm', onclick: () => emit('search-in-tab', { engine: 'ascii2d', path: it.path, itemId: it.id }) }));
      }
      sec.appendChild(head);
      if (err) sec.appendChild(h('div', { class: 'xs', style: { color: st === 'blocked' ? 'var(--warn)' : 'var(--danger)', margin: '0 0 4px 2px' } }, err));
      const strong = rs.filter((r) => e === 'ascii2d' ? r.rank <= 3 && r.mode === 'color' : (r.similarity || 0) >= (min[e] || 0));
      const weak = rs.filter((r) => !strong.includes(r));
      for (const r of strong) sec.appendChild(this.resultRow(r));
      if (weak.length) {
        if (this.showWeak.has(e)) for (const r of weak) sec.appendChild(this.resultRow(r));
        sec.appendChild(btn(this.showWeak.has(e) ? 'Hide weaker matches' : `Show ${weak.length} weaker match${weak.length > 1 ? 'es' : ''}`, {
          cls: 'sm ghost', onclick: () => { this.showWeak.has(e) ? this.showWeak.delete(e) : this.showWeak.add(e); this.render(); },
        }));
      }
    }
    if (!(it.results || []).length && (it.status === 'looked' || it.status === 'error')) {
      sec.appendChild(h('div', { class: 'dim xs' }, 'No matches found. Try Google Lens or Yandex above.'));
    }
    if (it.status === 'queued' || it.status === 'looking') sec.appendChild(h('div', { class: 'dim xs' }, it.status === 'looking' ? 'Looking up…' : 'Waiting in the queue…'));
    void summary;
    return sec;
  }

  resultRow(r) {
    const b = r.booru || {};
    const w = r.width || b.width, hh = r.height || b.height;
    const it = this.item;
    const bigger = w && it.width && w * hh > it.width * it.height * 1.15;
    const title = r.title || (b.series && b.series[0]) || r.site;
    const sub = [];
    if (w) sub.push(fmtDims(w, hh));
    if (b.fileSize) sub.push(fmtBytes(b.fileSize));
    const who = (b.artists && b.artists.length ? b.artists : r.artists || []).slice(0, 2).join(', ');
    if (who) sub.push(who);
    if (r.episode) sub.push('ep ' + r.episode);
    const links = [...new Set([...(r.links || []), b.url].filter(Boolean))];
    return h('div', { class: 'result' },
      r.thumbnail ? h('img', { class: 'rthumb', src: r.thumbnail, referrerpolicy: 'no-referrer', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }) : h('div', { class: 'rthumb' }),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'row' }, h('span', { class: 'chip' }, r.site), bigger ? h('span', { class: 'chip green' }, 'larger') : null),
        h('div', { class: 'rt ell', title }, title),
        sub.length ? h('div', { class: 'xs dim ell' }, sub.join(' · ')) : null,
        h('div', { class: 'links' }, links.slice(0, 5).map((u) => h('a', { title: u, onclick: () => this.open(u) }, shortUrl(u))))),
      h('div', { class: 'sim ' + simClass(r.similarity) }, r.similarity != null ? r.similarity.toFixed(r.similarity >= 99.95 ? 0 : 1) + '%' : '#' + (r.rank + 1)));
  }

  open(url) { emit('open-url', { url, itemId: this.item && this.item.id }); }

  async recycle() {
    const it = this.item;
    if (!(await confirmBox('Recycle this file?', `${it.name} will be sent to the Recycle Bin.`, 'Recycle'))) return;
    await api.call('item:recycle', it.id).then(() => toast('Sent to the Recycle Bin')).catch((e) => toast(e.message, 'error'));
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 22 ? x.pathname.slice(0, 20) + '…' : x.pathname;
    return x.hostname.replace(/^www\./, '') + (p === '/' ? '' : p);
  } catch { return u; }
}
