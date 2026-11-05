import { api, state, h, icon, clear, on, emit, toast, viewImage, fileUrl, fmtTime, prepForUpload, dHash, modal } from './core.js';
import { activeSortPanel, toggleNsfw, toggleVery } from './sortpanel.js';
import { LookupsView } from './views/lookups.js';
import { Browser, BrowserView } from './views/browser.js';
import { DownloadsView } from './views/downloads.js';
import { CompareView } from './views/compare.js';
import { SortLogView, HistoryView } from './views/misc.js';
import { SettingsView } from './views/settings.js';

const VIEWS = [
  { id: 'lookups', label: 'Lookups', icon: 'search', cls: LookupsView },
  { id: 'browser', label: 'Browser', icon: 'globe', cls: BrowserView },
  { id: 'downloads', label: 'Downloads', icon: 'download', cls: DownloadsView },
  { id: 'compare', label: 'Compare', icon: 'compare', cls: CompareView },
  { id: 'sortlog', label: 'Log', icon: 'log', cls: SortLogView },
  { id: 'history', label: 'History', icon: 'history', cls: HistoryView },
  { id: 'settings', label: 'Settings', icon: 'settings', cls: SettingsView, bottom: true },
];

const views = {};
let browser = null;
const railBtns = {};

// ---------- renderer helper for the main process ----------
api.on('helper:request', async ({ id, kind, args }) => {
  try {
    let result;
    if (kind === 'prep') result = { data: await prepForUpload(args.url, args.maxSide, args.quality) };
    else if (kind === 'hash') result = await dHash(args.url);
    else throw new Error('unknown helper ' + kind);
    api.send('helper:result', { id, ok: true, result });
  } catch (e) {
    api.send('helper:result', { id, ok: false, error: e.message });
  }
});

// ---------- library sync ----------
function applySnapshot(snap) {
  state.batches = snap.batches;
  if (snap.items) state.items = new Map(snap.items.map((s) => [s.id, s]));
  state.downloads = new Map(snap.downloads.map((d) => [d.id, d]));
  state.sortLog = snap.sortLog;
}

let pendingIds = new Set();
let pendingFull = false;
let syncTimer = null;
api.on('lib:changed', ({ ids }) => {
  if (!ids || !ids.length) pendingFull = true;
  else ids.forEach((i) => pendingIds.add(i));
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 180);
});

async function sync() {
  const full = pendingFull;
  const ids = [...pendingIds];
  pendingFull = false;
  pendingIds = new Set();
  try {
    if (full) {
      applySnapshot(await api.call('lib:snapshot'));
    } else {
      applySnapshot(await api.call('lib:light'));
      const sums = await api.call('item:summaries', ids);
      for (const s of sums) state.items.set(s.id, s);
      for (const id of ids) if (!sums.find((s) => s.id === id)) state.items.delete(id);
    }
  } catch (e) { console.error(e); }
  emit('lib', full ? [] : ids);
  updateBadges();
}

function updateBadges() {
  const dl = [...state.downloads.values()].filter((d) => d.state === 'progress').length;
  setBadge('downloads', dl);
  const cmp = [...state.items.values()].filter((s) => s.pendingDownloads > 0 && s.phase !== 'sort' && s.status !== 'done').length;
  setBadge('compare', cmp);
}
function setBadge(view, n) {
  const b = railBtns[view] && railBtns[view].querySelector('.badge');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n);
  b.classList.toggle('show', n > 0);
}

// ---------- shell ----------
function showView(id) {
  state.view = id;
  for (const v of VIEWS) {
    views[v.id].el.classList.toggle('on', v.id === id);
    railBtns[v.id].classList.toggle('on', v.id === id);
  }
  const inst = views[id].inst;
  if (inst && inst.onShow) inst.onShow();
  placeBrowser();
}

// Show the shared browser in the Browser tab, docked in Lookups, or not at all.
function placeBrowser() {
  if (!browser) return;
  const lk = views.lookups.inst;
  if (state.view === 'browser') browser.show(views.browser.inst.slot, 'full');
  else if (state.view === 'lookups' && lk.dock !== 'closed') browser.show(lk.slot, lk.dock, { histHost: lk.histHost });
  else browser.hide();
}

function setDock(d) {
  const lk = views.lookups.inst;
  if (d !== 'closed') state.lastDock = d;
  lk.setDock(d);
  api.call('settings:set', { dock: d });
  requestAnimationFrame(placeBrowser);
}

// Links opened from Lookups go to the docked browser; from anywhere else, to the Browser tab.
// Match links re-use that file's tab (Ctrl+click / middle-click = new tab).
function openUrl({ url, itemId, newTab, fromLinks }) {
  if (state.view === 'lookups') { if (views.lookups.inst.dock === 'closed') setDock(state.lastDock || 'small'); }
  else if (state.view !== 'browser') showView('browser');
  if (fromLinks) browser.openLink(url, itemId, newTab);
  else browser.open(url, { itemId, active: true });
}

// Closing the last tab (or "close all") closes the browser.
function browserClosed() {
  if (state.view === 'browser') showView('lookups');
  if (views.lookups.inst.dock !== 'closed') setDock('closed');
}

function searchInTab(o) {
  if (state.view === 'lookups') { if (views.lookups.inst.dock === 'closed') setDock(state.lastDock || 'small'); }
  else if (state.view !== 'browser') showView('browser');
  browser.searchIn(o);
}

function renderStatus() {
  const el = document.getElementById('status');
  clear(el);
  const q = state.queue || {};
  const parts = [];
  if (q.paused) parts.push(h('span', { class: 'chip warn' }, 'Lookups paused'));
  else if (q.current) parts.push(h('span', { class: 'pill' }, h('span', { class: 'dot looking' }), ` ${q.current.engine ? q.current.engine + ': ' : ''}${q.current.name}`));
  if (q.queued) parts.push(h('span', { class: 'chip' }, `${q.queued} queued`));
  if (q.waitingSauce) parts.push(h('span', { class: 'chip warn', title: 'Waiting for SauceNAO quota — they\'ll continue automatically' }, `${q.waitingSauce} waiting for SauceNAO`));
  if (q.waitingIqdb) parts.push(h('span', { class: 'chip warn', title: 'IQDB was busy — these are retried automatically' }, `${q.waitingIqdb} waiting for IQDB`));
  if (q.failed && q.failed.all) parts.push(h('span', { class: 'chip red', title: 'Failed or blocked lookups — use Retry in Lookups' }, `${q.failed.all} failed`));
  const sq = q.sauceQuota || {};
  if (sq.long != null) parts.push(h('span', { class: 'chip ' + (sq.long < 20 ? 'warn' : ''), title: 'SauceNAO lookups left today' }, `SauceNAO ${sq.long} left`));
  el.append(...parts);
}

function buildLog(initial) {
  const bar = document.getElementById('logbar');
  const last = h('span', { class: 'last' });
  const lines = h('div', { class: 'lines' });
  const caretHost = h('span', null, icon(state.settings.logOpen ? 'down' : 'up'));
  const head = h('div', { class: 'bar', title: 'Activity log (L)', onclick: () => {
    bar.classList.toggle('open');
    const open = bar.classList.contains('open');
    clear(caretHost).appendChild(icon(open ? 'down' : 'up'));
    api.call('settings:set', { logOpen: open });
    lines.scrollTop = lines.scrollHeight;
  } });
  const clearBtn = h('button', { class: 'btn sm ghost', title: 'Clear the activity log', onclick: (e) => { e.stopPropagation(); clear(lines); last.textContent = ''; api.call('log:clear'); } }, 'Clear');
  head.append(icon('log'), h('span', null, 'Activity'), last, clearBtn, caretHost);
  bar.append(head, lines);
  if (state.settings.logOpen) bar.classList.add('open');
  const add = (l) => {
    lines.appendChild(h('div', { class: 'ln ' + l.level }, h('span', { class: 't' }, fmtTime(l.time)), l.msg));
    while (lines.childNodes.length > 600) lines.firstChild.remove();
    last.textContent = l.msg;
    last.style.color = l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warn)' : '';
    if (bar.classList.contains('open')) lines.scrollTop = lines.scrollHeight;
  };
  initial.forEach(add);
  api.on('log', add);
}

// ---------- keyboard ----------
function typing() {
  const t = document.activeElement;
  return t && ((t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function focusSort() {
  const p = activeSortPanel();
  if (p) p.api.focus();
  else toast('Nothing to sort on this screen', 'warn', 2000);
}

async function toggleFullscreen() { await api.call('win:fullscreen'); }

function toggleLog() { document.querySelector('#logbar .bar').click(); }

// Keys that work everywhere in the app (the browser's own keys are handled by the browser).
function appKey(e) {
  if (e.defaultPrevented) return;
  if (keysOpen && (e.key === 'k' || e.key === 'K' || e.key === '?')) { e.preventDefault(); document.querySelector('.overlay')?.remove(); keysOpen = false; return; }
  if (document.querySelector('.overlay')) return; // a dialog is open
  if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
  if (e.ctrlKey || e.metaKey) {
    if (typing()) return;
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undoLast(); }
    return;
  }
  if (e.altKey) return;
  if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (document.querySelector('.viewer')) return; // the image viewer has its own keys
  const k = e.key;
  const lower = k.toLowerCase();
  const done = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === '/') { done(); focusSort(); return; }
  if (lower === 'k' || k === '?') { done(); showShortcuts(); return; }
  if (lower === 'f') { done(); toggleFullscreen(); return; }
  if (lower === 'n') { done(); toggleNsfw(); return; }
  if (lower === 'v') { done(); toggleVery(); return; }
  if (lower === 'l') { done(); toggleLog(); return; }
  if (lower === 'h') { done(); document.body.classList.toggle('bars-hidden'); setTimeout(() => window.dispatchEvent(new Event('resize')), 30); return; }
  if (lower === 'm') { done(); document.body.classList.toggle('no-rail'); setTimeout(() => window.dispatchEvent(new Event('resize')), 30); return; }
  if (lower === 'b') {
    done();
    if (state.view === 'lookups') setDock(views.lookups.inst.dock === 'closed' ? (state.lastDock || 'small') : 'closed');
    else showView(state.view === 'browser' ? 'lookups' : 'browser');
    return;
  }
  if (/^[1-9]$/.test(k)) { const p = activeSortPanel(); if (p && p.api.sortNth(+k - 1)) done(); return; }
  // screen numbers with Shift+1…7 would clash with sorting, so switching screens uses the rail / these:
  if (k === 'Escape' && document.body.classList.contains('bars-hidden')) { done(); document.body.classList.remove('bars-hidden'); return; }
  const inst = views[state.view] && views[state.view].inst;
  if (inst && inst.handleKey && inst.handleKey(e)) done();
}

function undoLast() {
  const last = state.sortLog.slice().reverse().find((l) => !l.undone && l.kind !== 'gone' && l.kind !== 'moved' && !l.missingAt);
  if (!last) { toast('Nothing to undo', 'warn', 2000); return; }
  api.call('sort:undo', last.id).then(() => toast('Undid: ' + last.to.split(/[\\/]/).pop())).catch((x) => toast(x.message, 'error'));
}

let keysOpen = false;
async function showShortcuts() {
  if (keysOpen) { document.querySelector('.overlay')?.remove(); keysOpen = false; return; }
  const sec = (title, rows) => [h('tr', null, h('th', { colspan: '2' }, title)), ...rows.map(([k, d]) => h('tr', null, h('td', null, ...String(k).split(/(\s+|\+|\/)/).filter((x) => x.trim()).map((x) => (x === '+' || x === '/' || x === 'or' ? h('span', { class: 'dim' }, ` ${x} `) : h('kbd', null, x)))), h('td', { class: 'muted' }, d)))];
  const col1 = h('table', { class: 'keys-table' },
    ...sec('Anywhere', [['/', 'Jump to the sort box'], ['N', 'Toggle the NSFW subfolder'], ['V', 'Toggle the Very subfolder (inside NSFW)'], ['1 … 9', 'Sort into the 1st … 9th folder shown'], ['Ctrl + Z', 'Undo the last sort'], ['K or ?', 'This list'], ['F or F11', 'Full screen'], ['H', 'Hide / show the menus and bars'], ['M', 'Hide / show the side menu'], ['L', 'Open / close the activity log'], ['B', 'Show / hide the browser'], ['Esc', 'Leave a text box / close the viewer']]),
    ...sec('In the sort box', [['Type', 'Filter your folders'], ['↑ ↓', 'Move the highlight'], ['Enter', 'Sort into the highlighted folder — a new name creates the folder first'], ['Tab', 'Fill in the highlighted name (then add /Sub for a subfolder)'], ['Alt + N  /  Alt + V', 'Toggle NSFW / Very while typing'], ['Esc', 'Leave the box']]),
    ...sec('Lookups', [['← → ↑ ↓', 'Move between files'], ['Home / End', 'First / last file'], ['Enter or T', 'Open the viewer'], ['C', 'Compare the downloaded versions'], ['G  /  Y', 'Search with Google Lens / Yandex in a new tab'], ['R', 'Look the file up again'], ['E', 'Expand / shrink the browser'], ['Delete', 'Send the original to the Recycle Bin'], ['Click a match link', 'Open it in that file\'s tab'], ['Ctrl + click or middle-click', 'Open it in a new tab']]));
  const col2 = h('table', { class: 'keys-table' },
    ...sec('Browser (small, expanded or full)', [['Ctrl + T', 'New tab'], ['Ctrl + W', 'Close the tab (the last one closes the browser)'], ['Ctrl + Shift + W', 'Close all tabs and the browser'], ['Ctrl + Shift + T', 'Reopen the last closed tab'], ['Ctrl + Tab', 'Next tab'], ['Ctrl + Shift + Tab', 'Previous tab'], ['Ctrl + 1 … 8  /  Ctrl + 9', 'Go to that tab / the last tab'], ['Alt + ←  /  Alt + →', 'Back / forward (mouse buttons too)'], ['Ctrl + L', 'Address bar'], ['Ctrl + H', 'History'], ['F5 or Ctrl + R', 'Reload'], ['Middle-click a tab', 'Close it'], ['Right-click a tab', 'Close others / left / right, duplicate, link…']]),
    ...sec('Right-click an image in the browser (then press)', [['S', 'Save to the linked file (or unlinked)'], ['O', 'Save the original size'], ['U', 'Save as unlinked'], ['V', 'Save as… — choose any folder'], ['T', 'Open the image in a new tab'], ['G', 'Search it with Google Lens'], ['C  /  A', 'Copy the image / its address'], ['D  /  K', 'Download a linked image / save the link as…']]),
    ...sec('Compare', [['Hold Space', 'Show the original in every pane'], ['Mouse wheel', 'Zoom (all panes together)'], ['Drag', 'Move around'], ['Double-click', 'Fit']]),
    ...sec('Viewer', [['← →', 'Previous / next file'], ['Esc, T or Enter', 'Close']]));
  keysOpen = true;
  await modal('Keyboard shortcuts', h('div', { class: 'keys-cols' }, col1, col2), [{ label: 'Close', primary: true, value: () => null }]);
  keysOpen = false;
}

async function init() {
  const data = await api.call('app:init');
  state.settings = data.settings;
  state.paths = data.paths;
  state.version = data.version;
  state.queue = data.queue;
  state.extensions = data.extensions;
  applySnapshot(data.snapshot);

  const app = document.getElementById('app');
  app.append(
    h('div', { id: 'titlebar' }, h('div', { class: 'logo' }, icon('logo'), 'Image Seek'), h('div', { class: 'spacer' }), h('div', { class: 'status', id: 'status' })),
    h('div', { id: 'body' }, h('div', { id: 'rail' }), h('div', { id: 'views' })),
    h('div', { id: 'logbar' }));
  const rail = document.getElementById('rail');
  const viewsEl = document.getElementById('views');
  for (const v of VIEWS) {
    if (v.bottom) rail.appendChild(h('div', { class: 'sep' }));
    const b = h('button', { class: 'rb', 'data-tip': v.label, onclick: () => showView(v.id) }, icon(v.icon), h('span', { class: 'badge' }));
    railBtns[v.id] = b;
    rail.appendChild(b);
    const el = h('div', { class: 'view', id: 'view-' + v.id });
    viewsEl.appendChild(el);
    views[v.id] = { el };
  }
  rail.insertBefore(h('button', { class: 'rb', 'data-tip': 'Keyboard shortcuts (K)', onclick: () => showShortcuts() }, icon('keyboard')), railBtns.settings);
  browser = new Browser();
  for (const v of VIEWS) views[v.id].inst = new v.cls(views[v.id].el);
  state.lastDock = data.settings.dock && data.settings.dock !== 'closed' ? data.settings.dock : 'small';
  on('dock', setDock);
  on('open-url', openUrl);
  on('search-in-tab', searchInTab);
  document.addEventListener('keydown', (e) => browser.key(e), true);
  document.addEventListener('keydown', appKey);
  on('browser-closed', browserClosed);
  on('fullscreen', toggleFullscreen);
  api.on('app:hotkey', (k) => { if (k === '/') focusSort(); });
  buildLog(data.log);

  on('show-view', showView);
  on('view-image', (p) => {
    // In Lookups, ← → step through the files in the grid (and select them).
    const lk = views.lookups.inst;
    const nav = state.view === 'lookups' ? (dir) => {
      lk.move(dir);
      const it = lk.detail.id && state.items.get(lk.detail.id);
      return it ? { src: fileUrl(it.path), caption: it.name } : null;
    } : null;
    const cur = [...state.items.values()].find((x) => x.path === p);
    viewImage(fileUrl(p), { nav, caption: cur ? cur.name : '' });
  });
  on('select-item', (id) => views.lookups.inst.select(id));
  // Browser shortcuts pressed while a web page has focus are forwarded from the main process.
  api.on('browser:shortcut', (k) => browser.shortcut(k));
  api.on('queue:status', (q) => { state.queue = q; renderStatus(); emit('queue'); });
  api.on('settings:changed', (s) => { state.settings = s; emit('settings', s); });

  // Drop files/folders from Explorer onto the window to add them.
  document.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const p = api.pathForFile(e.dataTransfer.files[0]);
    if (p) { showView('lookups'); views.lookups.inst.addFolder(p); }
  });

  renderStatus();
  emit('lib', []);
  updateBadges();
  emit('queue');
  showView('lookups');
}

init().catch((e) => {
  document.body.appendChild(h('pre', { style: { color: '#e05a5e', padding: '20px' } }, 'Image Seek failed to start:\n' + (e.stack || e.message)));
});
