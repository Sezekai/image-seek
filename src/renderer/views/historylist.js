// Compact browsing history: one line per page (time · title · address), grouped by day.
// Used in the browser's side panel and on the History screen.
import { api, h, icon, btn, clear, toast, confirmBox, hostOf } from '../core.js';

export class HistoryList {
  // onOpen(url, newTab) is called when an entry is clicked (Ctrl / middle click = new tab).
  constructor({ onOpen, onClose, compact }) {
    this.onOpen = onOpen;
    this.search = h('input', { class: 'input search', placeholder: 'Search history', style: { flex: '1', minWidth: '0' } });
    this.listEl = h('div', { class: 'scroll hist-list' });
    let t = null;
    this.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.render(), 120); });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (this.search.value) { this.search.value = ''; this.render(); } else if (onClose) onClose(); }
      if (e.key === 'Enter') { const first = this.listEl.querySelector('.hrow'); if (first) first.click(); }
    });
    this.el = h('div', { class: 'hist' + (compact ? ' compact' : '') },
      h('div', { class: 'hist-head' },
        compact ? h('span', { class: 'title' }, icon('history'), 'History') : null,
        this.search,
        btn('', { icon: 'trash', cls: 'sm icon ghost danger', title: 'Clear history', onclick: () => this.clearAll() }),
        onClose ? btn('', { icon: 'x', cls: 'sm icon ghost', title: 'Close history (Ctrl+H)', onclick: onClose }) : null),
      this.listEl);
  }

  async render() {
    const list = await api.call('browser:history', this.search.value.trim()).catch(() => []);
    clear(this.listEl);
    if (!list.length) { this.listEl.appendChild(h('div', { class: 'empty' }, icon('history'), h('div', null, this.search.value ? 'Nothing matches.' : 'No history yet.'))); return; }
    let lastDay = '';
    for (const e of list) {
      const d = new Date(e.time);
      const day = d.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        const today = new Date().toDateString() === day;
        this.listEl.appendChild(h('div', { class: 'hist-day' }, today ? 'Today' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })));
      }
      const row = h('div', {
        class: 'hrow', title: `${e.title || ''}\n${e.url}\nCtrl+click or middle-click: new tab`,
        onclick: (ev) => this.onOpen(e.url, ev.ctrlKey || ev.metaKey),
        onmousedown: (ev) => { if (ev.button === 1) ev.preventDefault(); },
        onauxclick: (ev) => { if (ev.button === 1) this.onOpen(e.url, true); },
      },
      h('span', { class: 'ht' }, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      h('img', { class: 'hf', src: `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(hostOf(e.url))}`, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (ev) => { ev.target.style.visibility = 'hidden'; } }),
      h('span', { class: 'hn' }, e.title || e.url),
      h('span', { class: 'hu' }, prettyUrl(e.url)));
      this.listEl.appendChild(row);
    }
  }

  focus() { setTimeout(() => this.search.focus(), 30); }

  async clearAll() {
    if (!(await confirmBox('Clear history?', 'All browsing history in Image Seek is deleted.', 'Clear'))) return;
    await api.call('browser:clearHistory');
    toast('History cleared');
    this.render();
  }
}

function prettyUrl(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname) + x.search; } catch { return u; }
}
