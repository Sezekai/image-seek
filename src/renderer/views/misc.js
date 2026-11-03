// Sort log (with undo) and browser history.
import { api, state, h, icon, btn, clear, fmtTime, basename, dirname, toast, on, emit, thumbUrl } from '../core.js';

export class SortLogView {
  constructor(root) {
    this.root = root;
    this.q = '';
    this.search = h('input', { class: 'input search', placeholder: 'Search the log', style: { width: '260px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.render(); } });
    this.listEl = h('div', { class: 'scroll' });
    root.append(h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'Sort log'), this.search, h('div', { class: 'grow' }),
      h('span', { class: 'xs dim' }, 'Ctrl+Z undoes the last sort anywhere in the app')), this.listEl);
    on('lib', () => { if (state.view === 'sortlog') this.render(); });
  }

  render() {
    clear(this.listEl);
    const list = state.sortLog.slice().reverse().filter((l) => !this.q || `${l.from} ${l.to} ${l.folder}`.toLowerCase().includes(this.q));
    if (!list.length) this.listEl.appendChild(h('div', { class: 'empty' }, icon('log'), h('div', null, 'Nothing sorted yet.')));
    for (const l of list.slice(0, 1000)) {
      const flags = l.flags && l.flags.nsfw ? (l.flags.very ? ' › NSFW › Very' : ' › NSFW') : '';
      this.listEl.appendChild(h('div', { class: 'list-row', style: { opacity: l.undone ? 0.5 : 1 } },
        l.undone ? h('div', { class: 'th', style: { width: '38px', height: '38px' } }) : h('img', { class: 'th', src: thumbUrl(l.to, 100), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
        h('div', { class: 'grow col', style: { gap: '1px' } },
          h('div', { class: 'ell' }, basename(l.to)),
          h('div', { class: 'xs dim ell', title: `${l.from}\n→ ${l.to}` }, `${dirname(l.from)}  →  ${l.folder}${flags}`)),
        h('span', { class: 'chip' }, l.kind === 'item' ? 'looked-up file' : 'download'),
        h('span', { class: 'xs dim', style: { width: '110px', textAlign: 'right' } }, fmtTime(l.time)),
        l.undone ? h('span', { class: 'xs dim', style: { width: '70px' } }, 'undone')
          : btn('Undo', { icon: 'undo', cls: 'sm', onclick: () => api.call('sort:undo', l.id).then(() => toast('Moved back')).catch((e) => toast(e.message, 'error')) })));
    }
  }

  onShow() { this.render(); }
}

export class HistoryView {
  constructor(root) {
    this.root = root;
    this.search = h('input', { class: 'input search', placeholder: 'Search history', style: { width: '320px' }, oninput: () => this.render() });
    this.listEl = h('div', { class: 'scroll' });
    root.append(h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'History'), this.search, h('div', { class: 'grow' }),
      btn('Clear history', { icon: 'trash', cls: 'danger', onclick: () => this.clearAll() })), this.listEl);
  }

  async render() {
    const list = await api.call('browser:history', this.search.value.trim()).catch(() => []);
    clear(this.listEl);
    if (!list.length) { this.listEl.appendChild(h('div', { class: 'empty' }, icon('history'), h('div', null, 'No history yet.'))); return; }
    let lastDay = '';
    for (const e of list) {
      const day = new Date(e.time).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        this.listEl.appendChild(h('div', { class: 'xs muted', style: { padding: '12px 12px 4px', fontWeight: 600 } }, new Date(e.time).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })));
      }
      this.listEl.appendChild(h('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: () => { emit('open-url', { url: e.url, itemId: null }); } },
        h('span', { class: 'xs dim', style: { width: '48px' } }, new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        h('div', { class: 'grow col', style: { gap: '1px' } }, h('div', { class: 'ell' }, e.title || e.url), h('div', { class: 'xs dim ell' }, e.url))));
    }
  }

  async clearAll() {
    await api.call('browser:clearHistory');
    toast('History cleared');
    this.render();
  }

  onShow() { this.render(); this.search.focus(); }
}
