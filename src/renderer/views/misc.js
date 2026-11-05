// Sort log (with undo) and browser history.
import { api, state, h, icon, btn, seg, clear, fmtTime, basename, dirname, toast, on, emit, thumbUrl, confirmBox, lsGet, lsSet } from '../core.js';
import { HistoryList } from './historylist.js';

const DAY = 24 * 60 * 60 * 1000;

function movesLabel(moves) {
  const last = moves[moves.length - 1];
  const renamed = dirname(last.from).toLowerCase() === dirname(last.to).toLowerCase();
  return renamed ? 'renamed' : `moved to ${last.folder}`;
}

export class SortLogView {
  constructor(root) {
    this.root = root;
    this.q = '';
    this.search = h('input', { class: 'input search', placeholder: 'Search the log', style: { width: '260px' }, oninput: () => { this.q = this.search.value.trim().toLowerCase(); this.render(); } });
    this.listEl = h('div', { class: 'scroll' });
    this.mode = lsGet('log-view', 'cards');
    this.modeSeg = seg([{ value: 'cards', icon: 'cards', label: 'Cards' }, { value: 'list', icon: 'list', label: 'List' }], this.mode, (v) => { this.mode = v; lsSet('log-view', v); this.render(); });
    root.append(h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'Log'), this.modeSeg, this.search, h('div', { class: 'grow' }),
      h('span', { class: 'xs dim' }, 'Ctrl+Z undoes the last sort · files moved or deleted outside Image Seek drop off after 30 days'),
      btn('Clear log', { icon: 'trash', cls: 'danger', onclick: () => this.clearAll() })), this.listEl);
    on('lib', () => { if (state.view === 'sortlog') this.render(); });
  }

  render() {
    clear(this.listEl);
    const list = state.sortLog.slice().reverse().filter((l) => !this.q || `${l.from} ${l.to} ${l.folder} ${l.name}`.toLowerCase().includes(this.q));
    if (!list.length) { this.listEl.appendChild(h('div', { class: 'empty' }, icon('log'), h('div', null, 'Nothing in the log.'))); return; }
    if (this.mode === 'cards') {
      const grid = h('div', { class: 'cards' });
      for (const l of list.slice(0, 600)) grid.appendChild(this.card(l));
      this.listEl.appendChild(grid);
      return;
    }
    for (const l of list.slice(0, 1500)) this.listEl.appendChild(l.kind === 'gone' ? this.goneRow(l) : l.kind === 'moved' ? this.movedRow(l) : this.sortRow(l));
  }

  // Card view: the same information as the list, with a bigger picture.
  card(l) {
    const flags = l.flags && l.flags.nsfw ? (l.flags.very ? ' › NSFW › Very' : ' › NSFW') : '';
    const chips = [];
    let thumb = null, name, sub, right = null, path = null;
    if (l.kind === 'gone') {
      const what = { original: 'file', download: 'linked download', unlinked: 'unlinked download' }[l.what] || 'file';
      name = l.name || basename(l.from);
      sub = dirname(l.from);
      chips.push(h('span', { class: 'chip warn' }, `${what} gone`));
      right = h('span', { title: 'Removed from the log after 30 days' }, `${this.daysLeft(l.time)}d left`);
    } else if (l.kind === 'moved') {
      const what = { original: 'File', download: 'Linked download', unlinked: 'Unlinked download' }[l.what] || 'File';
      name = basename(l.to); path = l.to;
      sub = l.renamed ? `was ${basename(l.from)}` : `${dirname(l.from)} → ${dirname(l.to)}`;
      chips.push(h('span', { class: 'chip blue' }, `${what} ${l.renamed ? 'renamed' : 'moved'}`));
      right = h('span', null, `${this.daysLeft(l.time)}d left`);
    } else {
      const missing = !!l.missingAt;
      name = basename(l.to); path = missing || l.undone ? null : l.to;
      sub = `→ ${l.folder}${flags}   ·   from ${dirname(l.from)}`;
      chips.push(h('span', { class: 'chip' }, l.kind === 'item' ? 'original' : 'download'));
      if (missing) chips.push(h('span', { class: 'chip warn' }, 'no longer there'));
      if (l.manual) chips.push(h('span', { class: 'chip blue' }, 'sorted in Explorer'));
      if (l.moves && l.moves.length) chips.push(h('span', { class: 'chip blue', title: l.moves.map((m) => `${fmtTime(m.time)}: ${m.from} → ${m.to}`).join('\n') }, movesLabel(l.moves)));
      if (l.movedOut) chips.push(h('span', { class: 'chip' }, 'moved out of the sort folder'));
      right = l.undone ? h('span', null, l.movedOut ? '' : 'undone')
        : missing ? h('span', null, `${this.daysLeft(l.missingAt)}d left`)
          : btn('Undo', { icon: 'undo', cls: 'sm', onclick: () => api.call('sort:undo', l.id).then(() => toast('Moved back')).catch((e) => toast(e.message, 'error')) });
    }
    thumb = path ? h('img', { src: thumbUrl(path, 400), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }) : icon(l.undone ? 'undo' : 'warn');
    return h('div', { class: 'lcard', style: { opacity: l.undone ? 0.6 : 1 } },
      h('div', { class: 'lthumb' }, thumb),
      h('div', { class: 'lbody' },
        h('div', { class: 'lname ell', title: name }, name),
        h('div', { class: 'lsub ell', title: `${l.from || ''}${l.to ? '\n→ ' + l.to : ''}` }, sub),
        h('div', { class: 'lchips' }, chips),
        h('div', { class: 'lfoot' }, h('span', null, fmtTime(l.time)), h('span', { class: 'grow' }), right)));
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

  movedRow(l) {
    const what = { original: 'File', download: 'Linked download', unlinked: 'Unlinked download' }[l.what] || 'File';
    return h('div', { class: 'list-row' },
      h('img', { class: 'th', src: thumbUrl(l.to, 100), loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } }),
      h('div', { class: 'grow col', style: { gap: '1px' } },
        h('div', { class: 'ell' }, basename(l.to)),
        h('div', { class: 'xs dim ell', title: `${l.from}\n→ ${l.to}` }, l.renamed ? `was ${basename(l.from)}` : `${dirname(l.from)}  →  ${dirname(l.to)}`)),
      h('span', { class: 'chip blue', title: 'Changed outside Image Seek — the app followed it' }, `${what} ${l.renamed ? 'renamed' : 'moved'}`),
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
      missing ? h('span', { class: 'chip warn', title: 'The sorted file was deleted (or moved to another drive) outside Image Seek' }, 'no longer there') : null,
      l.manual ? h('span', { class: 'chip blue', title: 'You moved it into the sort folder outside Image Seek' }, 'sorted in Explorer') : null,
      l.moves && l.moves.length ? h('span', { class: 'chip blue', title: l.moves.map((m) => `${fmtTime(m.time)}: ${m.from} → ${m.to}`).join('\n') }, movesLabel(l.moves)) : null,
      l.movedOut ? h('span', { class: 'chip', title: l.movedOut.to }, 'moved out of the sort folder') : null,
      h('span', { class: 'chip' }, l.kind === 'item' ? 'original' : 'download'),
      h('span', { class: 'xs dim', style: { width: '110px', textAlign: 'right' } }, fmtTime(l.time)),
      l.undone ? h('span', { class: 'xs dim', style: { width: '70px' } }, l.movedOut ? '' : 'undone')
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
    this.list = new HistoryList({ onOpen: (url, newTab) => emit('open-url', { url, itemId: null, newTab }) });
    root.append(h('div', { class: 'toolbar' }, h('span', { class: 'title' }, 'History'), h('span', { class: 'xs dim' }, 'Also in the browser: the clock button or Ctrl+H')), this.list.el);
  }

  onShow() { this.list.render(); this.list.focus(); }
}
