// Sort log (with undo) and browser history.
import { api, state, h, icon, btn, clear, fmtTime, basename, dirname, toast, on, emit, thumbUrl, confirmBox } from '../core.js';

const DAY = 24 * 60 * 60 * 1000;

export class SortLogView {
  constructor(root) {
    this.root = root;
    this.q = '';
    this.search = h('input', { class: 'input search', placeholder: 'Search the log', style: { width: '260px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.render(); } });
    this.listEl = h('div', { class: 'scroll' });
    root.append(h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'Log'), this.search, h('div', { class: 'grow' }),
      h('span', { class: 'xs dim' }, 'Ctrl+Z undoes the last sort · files moved or deleted outside Image Seek drop off after 30 days'),
      btn('Clear log', { icon: 'trash', cls: 'danger', onclick: () => this.clearAll() })), this.listEl);
    on('lib', () => { if (state.view === 'sortlog') this.render(); });
  }

  render() {
    clear(this.listEl);
    const list = state.sortLog.slice().reverse().filter((l) => !this.q || `${l.from} ${l.to} ${l.folder} ${l.name}`.toLowerCase().includes(this.q));
    if (!list.length) this.listEl.appendChild(h('div', { class: 'empty' }, icon('log'), h('div', null, 'Nothing in the log.')));
    for (const l of list.slice(0, 1500)) this.listEl.appendChild(l.kind === 'gone' ? this.goneRow(l) : this.sortRow(l));
  }

  daysLeft(t) { return Math.max(0, Math.ceil((t + 30 * DAY - Date.now()) / DAY)); }

  goneRow(l) {
    const what = { original: 'file', download: 'linked download', unlinked: 'unlinked download' }[l.what] || 'file';
    return h('div', { class: 'list-row' },
      h('div', { class: 'th', style: { width: '38px', height: '38px', display: 'grid', placeItems: 'center' } }, icon('warn')),
      h('div', { class: 'grow col', style: { gap: '1px' } },
        h('div', { class: 'ell' }, l.name || basename(l.from)),
        h('div', { class: 'xs dim ell', title: l.from }, `${dirname(l.from)}`)),
      h('span', { class: 'chip warn', title: 'Moved, renamed or deleted outside Image Seek, so it was removed from the app' }, `${what} gone`),
      h('span', { class: 'xs dim', style: { width: '110px', textAlign: 'right' } }, fmtTime(l.time)),
      h('span', { class: 'xs dim', style: { width: '70px' }, title: 'Removed from the log after 30 days' }, `${this.daysLeft(l.time)}d left`));
  }

  sortRow(l) {
    const flags = l.flags && l.flags.nsfw ? (l.flags.very ? ' › NSFW › Very' : ' › NSFW') : '';
    const missing = !!l.missingAt;
    return h('div', { class: 'list-row', style: { opacity: l.undone ? 0.5 : 1 } },
      l.undone || missing ? h('div', { class: 'th', style: { width: '38px', height: '38px', display: 'grid', placeItems: 'center' } }, missing ? icon('warn') : null)
        : h('img', { class: 'th', src: thumbUrl(l.to, 100), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
      h('div', { class: 'grow col', style: { gap: '1px' } },
        h('div', { class: 'ell' }, basename(l.to)),
        h('div', { class: 'xs dim ell', title: `${l.from}\n→ ${l.to}` }, `${dirname(l.from)}  →  ${l.folder}${flags}`)),
      missing ? h('span', { class: 'chip warn', title: 'The sorted file was moved, renamed or deleted outside Image Seek' }, 'no longer there') : null,
      h('span', { class: 'chip' }, l.kind === 'item' ? 'original' : 'download'),
      h('span', { class: 'xs dim', style: { width: '110px', textAlign: 'right' } }, fmtTime(l.time)),
      l.undone ? h('span', { class: 'xs dim', style: { width: '70px' } }, 'undone')
        : missing ? h('span', { class: 'xs dim', style: { width: '70px' }, title: 'Removed from the log after 30 days' }, `${this.daysLeft(l.missingAt)}d left`)
          : btn('Undo', { icon: 'undo', cls: 'sm', onclick: () => api.call('sort:undo', l.id).then(() => toast('Moved back')).catch((e) => toast(e.message, 'error')) }));
  }

  async clearAll() {
    if (!(await confirmBox('Clear the log?', 'Every entry is removed, including the ones you could still undo. Nothing on disk changes.', 'Clear'))) return;
    await api.call('sort:clearLog').catch((e) => toast(e.message, 'error'));
    toast('Log cleared');
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
