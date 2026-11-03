// Folder picker for sorting: your own folder list, NSFW / Very toggles, filter + Enter, number keys.
import { api, state, h, icon, btn, clear, prompt, toast, emit, on } from './core.js';

export function createSortPanel({ target, onSorted, compact }) {
  let filter = '';
  const flags = { ...(state.settings.lastSortFlags || { nsfw: false, very: false }) };
  const filterInput = h('input', { class: 'input search grow', placeholder: 'Filter folders — Enter sorts to the highlighted one' });
  const nsfwBtn = h('button', { class: 'btn sm flag-btn nsfw', 'data-tip': 'NSFW subfolder (N)' }, 'NSFW');
  const veryBtn = h('button', { class: 'btn sm flag-btn very', 'data-tip': 'Very subfolder inside NSFW (V)' }, 'Very');
  const foldersEl = h('div', { class: 'folders' });
  const destEl = h('div', { class: 'xs dim ell' });
  const el = h('div', { class: 'sortpanel' },
    h('div', { class: 'row' }, filterInput,
      btn('', { icon: 'folderPlus', cls: 'sm icon', title: 'New folder', onclick: () => addFolder() }),
      btn('', { icon: 'menu', cls: 'sm icon', title: 'Add existing folders from the sort folder', onclick: () => importExisting() })),
    h('div', { class: 'flags' }, nsfwBtn, veryBtn, h('div', { class: 'grow' }), destEl),
    foldersEl);
  if (compact) el.style.setProperty('--folders-max', '200px');

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
    nsfwBtn.classList.toggle('on', flags.nsfw);
    veryBtn.classList.toggle('on', flags.very);
    destEl.textContent = flags.nsfw ? (flags.very ? '→ Folder\\NSFW\\Very' : '→ Folder\\NSFW') : '';
  }

  function render() {
    renderFlags();
    clear(foldersEl);
    const list = filtered();
    if (!folders().length) {
      foldersEl.appendChild(h('div', { class: 'dim xs', style: { gridColumn: '1/-1', padding: '6px 2px' } },
        'No sort folders yet. Use the folder + button to add one (e.g. "Genshin Impact" or "Games/Elden Ring"), or the ☰ button to add folders that already exist in your sort folder.'));
      return;
    }
    list.forEach((f, i) => {
      foldersEl.appendChild(h('div', {
        class: 'f' + (filter && i === 0 ? ' top' : ''), title: f, role: 'button',
        onclick: () => sortTo(f),
      },
      h('span', { class: 'k' }, i < 9 ? String(i + 1) : ''),
      h('span', { class: 'ell' }, f),
      h('button', { class: 'x', title: 'Remove from list (the folder on disk stays)', onclick: (e) => { e.stopPropagation(); removeFolder(f); } }, '×')));
    });
    if (!list.length) {
      foldersEl.appendChild(h('div', { class: 'f', onclick: () => addFolder(filter) }, icon('plus'), h('span', { class: 'ell' }, `Create "${filter}"`)));
    }
  }

  async function saveFolders(list) {
    state.settings = await api.call('settings:set', { sortFolders: list });
    emit('settings', state.settings);
  }

  async function addFolder(name) {
    const v = name || await prompt('New sort folder', 'Folder name inside your sort folder. Use / for subfolders.', '', 'e.g. Genshin Impact');
    if (!v) return;
    const clean = v.replace(/[<>:"|?*]/g, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    await api.call('sort:createFolder', clean).catch((e) => toast(e.message, 'error'));
    const list = [...new Set([...folders(), clean])].sort((a, b) => a.localeCompare(b));
    await saveFolders(list);
    filter = ''; filterInput.value = '';
    render();
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
    try {
      const entry = await api.call('sort:file', t, folder, { ...flags });
      toast(`Sorted to ${folder}${flags.nsfw ? (flags.very ? ' › NSFW › Very' : ' › NSFW') : ''}`, 'info', 4000, {
        label: 'Undo', run: () => api.call('sort:undo', entry.id).then(() => toast('Undone')).catch((e) => toast(e.message, 'error')),
      });
      state.lastSortEntry = entry.id;
      filter = ''; filterInput.value = '';
      render();
      if (onSorted) onSorted(entry);
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  }

  async function setFlags(nsfw, very) {
    flags.nsfw = nsfw;
    flags.very = nsfw && very;
    renderFlags();
    state.settings = await api.call('settings:set', { lastSortFlags: { ...flags } });
  }

  nsfwBtn.onclick = () => setFlags(!flags.nsfw, flags.very);
  veryBtn.onclick = () => setFlags(!flags.very ? true : flags.nsfw, !flags.very);
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim(); render(); });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const list = filtered();
      if (list.length) sortTo(list[0]);
      else if (filter) addFolder(filter);
    }
    if (e.key === 'Escape') { filter = ''; filterInput.value = ''; render(); filterInput.blur(); }
  });

  const off = on('settings', () => render());
  render();

  el.api = {
    focus: () => filterInput.focus(),
    setFilter: (v) => { filter = v; filterInput.value = v; render(); },
    // Keyboard shortcuts when no input is focused: 1–9 sort, N / V toggle flags.
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (/^[1-9]$/.test(e.key)) {
        const list = filtered();
        const f = list[+e.key - 1];
        if (f) { sortTo(f); return true; }
      }
      if (e.key === 'n' || e.key === 'N') { setFlags(!flags.nsfw, flags.very); return true; }
      if (e.key === 'v' || e.key === 'V') { setFlags(!flags.very ? true : flags.nsfw, !flags.very); return true; }
      return false;
    },
    destroy: off,
  };
  return el;
}
