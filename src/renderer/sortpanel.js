// Folder picker for sorting: your folder list, NSFW / Very toggles (shared by every screen),
// a filter box with keyboard control, and 1–9 to sort to the first nine folders shown.
//
// In the box: type to filter · ↑ ↓ move the highlight · Enter sorts into the highlighted folder
// (a name that doesn't exist yet is created first) · Tab fills in the highlighted name (add /Sub
// for a subfolder) · Alt+N / Alt+V toggle NSFW / Very · Esc leaves the box.
import { api, state, h, icon, btn, clear, prompt, toast, emit, on } from './core.js';

const panels = new Set();

// The sort panel on the screen you're looking at (for /, N, V and 1–9).
export function activeSortPanel() {
  const view = document.querySelector('.view.on');
  for (const p of panels) {
    if (!p.isConnected || !p.offsetParent) continue;
    if (view && !view.contains(p)) continue;
    return p;
  }
  return null;
}

export function sortFlags() { return state.settings.lastSortFlags || { nsfw: false, very: false }; }

export async function setSortFlags(nsfw, very) {
  const flags = { nsfw: !!nsfw, very: !!nsfw && !!very };
  state.settings.lastSortFlags = flags;
  emit('sort-flags', flags);
  state.settings = await api.call('settings:set', { lastSortFlags: flags });
}

export function toggleNsfw() { const f = sortFlags(); setSortFlags(!f.nsfw, f.very); }
// Very turns NSFW on with it; turning Very off leaves NSFW on.
export function toggleVery() { const f = sortFlags(); setSortFlags(f.very ? f.nsfw : true, !f.very); }

export function createSortPanel({ target, onSorted, compact }) {
  let filter = '';
  let hi = 0; // highlighted index in the filtered list
  const filterInput = h('input', { class: 'input search grow', placeholder: 'Sort into…  ( / )  type, ↑↓, Enter — a new name creates the folder' });
  const nsfwBtn = h('button', { class: 'btn sm flag-btn nsfw', 'data-tip': 'NSFW subfolder (N, or Alt+N while typing)' }, 'NSFW');
  const veryBtn = h('button', { class: 'btn sm flag-btn very', 'data-tip': 'Very subfolder inside NSFW (V, or Alt+V while typing)' }, 'Very');
  const foldersEl = h('div', { class: 'folders' });
  const destEl = h('div', { class: 'xs dim ell' });
  const el = h('div', { class: 'sortpanel' },
    h('div', { class: 'row' }, filterInput,
      btn('', { icon: 'folderPlus', cls: 'sm icon', title: 'New folder', onclick: () => addFolder() }),
      btn('', { icon: 'menu', cls: 'sm icon', title: 'Add existing folders from the sort folder', onclick: () => importExisting() })),
    h('div', { class: 'flags' }, nsfwBtn, veryBtn, h('div', { class: 'grow' }), destEl),
    foldersEl);
  if (compact) el.style.setProperty('--folders-max', '200px');
  panels.add(el);

  const folders = () => (state.settings.sortFolders || []);
  const filtered = () => {
    const q = filter.toLowerCase();
    return folders().filter((f) => !q || f.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!q) return 0;
        const as = a.toLowerCase().startsWith(q) ? 0 : 1, bs = b.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs;
      });
  };

  function renderFlags() {
    const f = sortFlags();
    nsfwBtn.classList.toggle('on', f.nsfw);
    veryBtn.classList.toggle('on', f.very);
    destEl.textContent = f.nsfw ? (f.very ? '→ Folder\\NSFW\\Very' : '→ Folder\\NSFW') : '';
  }

  function render() {
    renderFlags();
    clear(foldersEl);
    const list = filtered();
    if (hi >= list.length) hi = Math.max(0, list.length - 1);
    if (!folders().length && !filter) {
      foldersEl.appendChild(h('div', { class: 'dim xs', style: { gridColumn: '1/-1', padding: '6px 2px' } },
        'No sort folders yet. Type a name and press Enter to create one (use / for subfolders, e.g. "Games/Elden Ring"), or use ☰ to add folders that already exist in your sort folder.'));
      return;
    }
    list.forEach((f, i) => {
      foldersEl.appendChild(h('div', {
        class: 'f' + (filter && i === hi ? ' hi' : ''), title: f, role: 'button',
        onclick: () => sortTo(f),
      },
      h('span', { class: 'k' }, i < 9 ? String(i + 1) : ''),
      h('span', { class: 'ell' }, f),
      h('button', { class: 'x', title: 'Remove from list (the folder on disk stays)', onclick: (e) => { e.stopPropagation(); removeFolder(f); } }, '×')));
    });
    if (filter && !list.some((f) => f.toLowerCase() === filter.toLowerCase())) {
      foldersEl.appendChild(h('div', { class: 'f' + (!list.length ? ' hi' : ''), style: { gridColumn: '1 / -1' }, onclick: () => createAndSort(filter) }, icon('plus'), h('span', { class: 'ell' }, `Create "${filter}" and sort${list.length ? '' : ' (Enter)'}`)));
    }
    const cur = foldersEl.querySelector('.f.hi');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  async function saveFolders(list) {
    state.settings = await api.call('settings:set', { sortFolders: list });
    emit('settings', state.settings);
  }

  const clean = (v) => v.replace(/[<>:"|?*]/g, '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').trim();

  async function ensureFolder(name) {
    const c = clean(name);
    if (!c) return null;
    const existing = folders().find((f) => f.toLowerCase() === c.toLowerCase());
    if (existing) return existing;
    await api.call('sort:createFolder', c).catch((e) => toast(e.message, 'error'));
    await saveFolders([...new Set([...folders(), c])].sort((a, b) => a.localeCompare(b)));
    return c;
  }

  async function addFolder(name) {
    const v = name || await prompt('New sort folder', 'Folder name inside your sort folder. Use / for subfolders.', '', 'e.g. Genshin Impact');
    if (!v) return;
    await ensureFolder(v);
    filter = ''; filterInput.value = '';
    render();
  }

  async function createAndSort(name) {
    const f = await ensureFolder(name);
    if (f) await sortTo(f);
  }

  async function importExisting() {
    const existing = await api.call('sort:scanRoot');
    if (!existing.length) { toast('No folders found in ' + state.settings.sortRoot, 'warn'); return; }
    const before = folders().length;
    const list = [...new Set([...folders(), ...existing])].sort((a, b) => a.localeCompare(b));
    await saveFolders(list);
    toast(`Added ${list.length - before} folder(s) from the sort folder`);
    render();
  }

  async function removeFolder(f) {
    await saveFolders(folders().filter((x) => x !== f));
    render();
  }

  async function sortTo(folder) {
    const t = typeof target === 'function' ? target() : target;
    if (!t) { toast('Nothing selected to sort', 'warn'); return; }
    const flags = { ...sortFlags() };
    try {
      const entry = await api.call('sort:file', t, folder, flags);
      toast(`Sorted to ${folder}${flags.nsfw ? (flags.very ? ' › NSFW › Very' : ' › NSFW') : ''}`, 'info', 4000, {
        label: 'Undo', run: () => api.call('sort:undo', entry.id).then(() => toast('Undone')).catch((e) => toast(e.message, 'error')),
      });
      filter = ''; filterInput.value = ''; hi = 0;
      filterInput.blur();
      render();
      if (onSorted) onSorted(entry);
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  }

  nsfwBtn.onclick = () => toggleNsfw();
  veryBtn.onclick = () => toggleVery();
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim(); hi = 0; render(); });
  filterInput.addEventListener('keydown', (e) => {
    const list = filtered();
    const extra = filter && !list.some((f) => f.toLowerCase() === filter.toLowerCase()) ? 1 : 0; // "Create …" row
    if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); toggleNsfw(); return; }
    if (e.altKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); toggleVery(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(list.length + extra - 1, hi + 1); render(); highlightCreate(list); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); render(); highlightCreate(list); }
    else if (e.key === 'Tab' && filter) {
      e.preventDefault();
      if (list[hi]) { filterInput.value = list[hi]; filter = list[hi]; hi = 0; render(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi < list.length && list.length) sortTo(list[hi]);
      else if (filter) createAndSort(filter);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      filter = ''; filterInput.value = ''; hi = 0; render(); filterInput.blur();
    } else if (e.key === '/' && !filterInput.value) { e.preventDefault(); filterInput.blur(); }
    e.stopPropagation(); // keys typed here never trigger app shortcuts
  });
  function highlightCreate(list) {
    if (hi >= list.length) { const c = foldersEl.querySelector('.f:last-child'); if (c) c.classList.add('hi'); }
  }

  const offs = [on('settings', () => render()), on('sort-flags', () => renderFlags())];
  render();

  el.api = {
    focus: () => { filterInput.focus(); filterInput.select(); },
    setFilter: (v) => { filter = v; filterInput.value = v; hi = 0; render(); },
    sortNth: (n) => { const f = filtered()[n]; if (f) { sortTo(f); return true; } return false; },
    destroy: () => { offs.forEach((o) => o()); panels.delete(el); },
  };
  return el;
}
