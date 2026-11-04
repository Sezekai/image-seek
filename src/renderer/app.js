import { api, state, h, icon, clear, on, emit, toast, viewImage, fileUrl, fmtTime, prepForUpload, dHash } from './core.js';
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
  else if (state.view === 'lookups' && lk.dock !== 'closed') browser.show(lk.slot, lk.dock);
  else browser.hide();
}

function setDock(d) {
  const lk = views.lookups.inst;
  if (d !== 'closed') state.lastDock = d;
  lk.setDock(d);
  api.call('settings:set', { dock: d });
  requestAnimationFrame(placeBrowser);
}

// Links opened from Lookups open in a new tab in the docked browser; from anywhere else, in the Browser tab.
function openUrl({ url, itemId }) {
  if (state.view === 'lookups') { if (views.lookups.inst.dock === 'closed') setDock(state.lastDock || 'small'); }
  else if (state.view !== 'browser') showView('browser');
  browser.open(url, { itemId, active: true });
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
  const head = h('div', { class: 'bar', onclick: () => {
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
  browser = new Browser();
  for (const v of VIEWS) views[v.id].inst = new v.cls(views[v.id].el);
  state.lastDock = data.settings.dock && data.settings.dock !== 'closed' ? data.settings.dock : 'small';
  on('dock', setDock);
  on('open-url', openUrl);
  on('search-in-tab', searchInTab);
  document.addEventListener('keydown', (e) => browser.key(e), true);
  buildLog(data.log);

  on('show-view', showView);
  on('view-image', (p) => viewImage(fileUrl(p)));
  on('select-item', (id) => views.lookups.inst.select(id));
  // Browser shortcuts pressed while a web page has focus are forwarded from the main process.
  api.on('browser:shortcut', (k) => browser.shortcut(k));
  api.on('queue:status', (q) => { state.queue = q; renderStatus(); emit('queue'); });
  api.on('settings:changed', (s) => { state.settings = s; emit('settings', s); });

  // Ctrl+Z: undo the last sort from anywhere.
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      const last = state.sortLog.slice().reverse().find((l) => !l.undone && l.kind !== 'gone' && !l.missingAt);
      if (!last) return;
      e.preventDefault();
      api.call('sort:undo', last.id).then(() => toast('Undid: ' + last.to.split(/[\\/]/).pop())).catch((x) => toast(x.message, 'error'));
    }
  });

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
