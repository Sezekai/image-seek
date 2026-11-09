// Settings: folders, lookups, browser, Firefox import, resets.
import { api, state, h, icon, btn, seg, clear, toast, on, emit, confirmBox, modal, fmtTime, fmtBytes, ENGINE_LABEL } from '../core.js';

export class SettingsView {
  constructor(root) {
    this.root = root;
    this.wrap = h('div', { class: 'settings' });
    root.appendChild(h('div', { class: 'scroll' }, this.wrap));
    on('settings', () => { if (state.view === 'settings' && !this.editing) this.render(); });
    api.on('browser:extensions', (list) => { state.extensions = list; if (state.view === 'settings') this.render(); });
  }

  async set(patch) {
    state.settings = await api.call('settings:set', patch);
    emit('settings', state.settings);
  }

  field(label, control, hint) {
    return h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'col', style: { gap: '4px' } }, control, hint ? h('div', { class: 'hint' }, hint) : null));
  }

  folderField(label, key, hint) {
    const v = state.settings[key];
    return this.field(label, h('div', { class: 'row' }, h('div', { class: 'input ell grow', style: { display: 'flex', alignItems: 'center' }, title: v }, v),
      btn('Change…', { icon: 'folder', onclick: async () => { const f = await api.call('dialog:folder', label, v); if (f) { await this.set({ [key]: f }); this.render(); } } }),
      btn('', { icon: 'external', title: 'Open', onclick: () => api.call('shell:open', v) })), hint);
  }

  async render() {
    const s = state.settings;
    clear(this.wrap);

    // ---------- folders
    this.wrap.appendChild(h('div', { class: 'card' }, h('h2', null, icon('folder'), 'Folders'),
      this.folderField('Downloads', 'downloadsDir', 'Each file you look up for a higher resolution gets its own subfolder here. Stray downloads go to "_Unlinked".'),
      this.folderField('Sort folder', 'sortRoot', 'Sorted files go into your folders inside this one (with NSFW / Very subfolders when switched on).'),
      this.field('New images', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.autoAdd !== false, onchange: (e) => this.set({ autoAdd: e.target.checked }) }), 'Pick up new images saved into added folders automatically'),
        'Renamed and moved files are followed either way (on the same drive).'),
      this.field('App data', h('div', { class: 'row' }, h('div', { class: 'input ell grow', style: { display: 'flex', alignItems: 'center' } }, state.paths.data),
        btn('', { icon: 'external', title: 'Open', onclick: () => api.call('shell:open', state.paths.data) })), 'Settings, the file list, browser profile, logins and caches. Kept outside the App folder so new versions pick it up.')));

    // ---------- lookups
    const keyInput = h('input', { class: 'input grow', type: 'password', value: s.saucenaoKey || '', placeholder: 'SauceNAO API key', spellcheck: 'false' });
    keyInput.addEventListener('change', () => this.set({ saucenaoKey: keyInput.value.trim(), saucenaoKeySource: 'manual' }));
    const q = (state.queue && state.queue.sauceQuota) || {};
    const quota = q.long != null ? `${q.long}${q.longLimit ? '/' + q.longLimit : ''} lookups left today · ${q.short ?? '?'} in the next 30 s` : 'Quota shows after the first lookup';
    const engineToggle = (k, label, hint) => h('label', { class: 'toggle', title: hint }, h('input', { type: 'checkbox', checked: s.engines[k], onchange: (e) => this.set({ engines: { ...state.settings.engines, [k]: e.target.checked } }) }), label);
    const simInput = (k) => h('input', { class: 'input', type: 'number', min: '0', max: '100', value: s.minSimilarity[k], style: { width: '70px' },
      onchange: (e) => this.set({ minSimilarity: { ...state.settings.minSimilarity, [k]: Math.max(0, Math.min(100, +e.target.value || 0)) } }) });
    this.wrap.appendChild(h('div', { class: 'card' }, h('h2', null, icon('search'), 'Lookups'),
      this.field('SauceNAO key', h('div', { class: 'row' }, keyInput,
        btn('', { icon: 'eye', title: 'Show / hide', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }),
        btn('Import from Collection Sorter', { icon: 'key', onclick: async () => {
          const r = await api.call('key:import').catch((e) => ({ found: false, reason: e.message }));
          if (r.found) { state.settings = r.settings; toast('SauceNAO key imported'); this.render(); } else toast(r.reason || 'Not found', 'warn', 6000);
        } })), `${quota}${s.saucenaoKeySource ? ' · key from ' + s.saucenaoKeySource : ''}`),
      this.field('Engines', h('div', { class: 'row wrap', style: { gap: '16px' } },
        engineToggle('iqdb', 'IQDB', 'Free, fast, covers the main boorus'),
        engineToggle('saucenao', 'SauceNAO', 'Uses your daily allowance'),
        engineToggle('ascii2d', 'ascii2d', 'Good for Pixiv and X/Twitter'),
        engineToggle('tracemoe', 'trace.moe', 'Anime screenshots — runs only when nothing else matched')),
      'Files are run through each one in this order. If SauceNAO runs out for the day, the rest wait and continue later automatically.'),
      this.field('Minimum similarity', h('div', { class: 'row wrap', style: { gap: '14px' } },
        h('span', { class: 'row small muted' }, 'SauceNAO', simInput('saucenao'), '%'),
        h('span', { class: 'row small muted' }, 'IQDB', simInput('iqdb'), '%'),
        h('span', { class: 'row small muted' }, 'trace.moe', simInput('tracemoe'), '%')),
      'Matches below this are hidden under "weaker matches" and not used for the best guess.'),
      this.field('Flag unrelated downloads', h('div', { class: 'row small muted' }, h('input', { class: 'input', type: 'number', min: '4', max: '40', value: s.unrelatedThreshold, style: { width: '70px' }, onchange: (e) => this.set({ unrelatedThreshold: +e.target.value || 20 }) }), 'difference (0 = identical, 64 = completely different)'),
      'A download linked to a file is flagged when it looks this different from it.'),
      this.field('Retry failed / blocked', h('div', { class: 'row wrap' },
        btn('All', { icon: 'reload', onclick: () => api.call('items:requeueErrors').then((n) => toast(n ? `Retrying ${n} file(s)` : 'Nothing to retry')) }),
        ...['iqdb', 'saucenao', 'ascii2d', 'tracemoe'].map((k) => btn(ENGINE_LABEL[k], { onclick: () => api.call('items:requeueErrors', k).then((n) => toast(n ? `Retrying ${n} file(s) on ${ENGINE_LABEL[k]}` : 'Nothing to retry')) })))),
    ));

    // ---------- browser
    const adSeg = seg([
      { value: 'builtin', label: 'Built-in' }, { value: 'ubol', label: 'uBlock Origin Lite' }, { value: 'off', label: 'Off' },
    ], s.adblock, async (v) => { await this.set({ adblock: v }); toast(v === 'ubol' ? 'Installing uBlock Origin Lite…' : v === 'builtin' ? 'Built-in blocker on' : 'Ad blocking off'); });
    const exts = state.extensions || [];
    const extList = h('div', { class: 'col', style: { gap: '4px' } }, exts.length ? exts.map((e) => h('div', { class: 'row small' }, icon('puzzle'), h('span', { class: 'grow ell' }, `${e.name}  `, h('span', { class: 'dim' }, e.version)),
      btn('Remove', { cls: 'sm danger', onclick: async () => { if (await confirmBox('Remove extension?', e.name, 'Remove')) api.call('browser:extRemove', e.id).catch((x) => toast(x.message, 'error')); } })))
      : h('div', { class: 'dim small' }, 'No extensions installed'));
    const extId = h('input', { class: 'input grow', placeholder: 'Chrome Web Store link or extension ID' });
    const themes = Object.entries(s.siteThemes || {}).sort((a, b) => a[0].localeCompare(b[0]));
    this.wrap.appendChild(h('div', { class: 'card' }, h('h2', null, icon('globe'), 'Browser'),
      this.field('Home page', h('input', { class: 'input', value: s.homepage, onchange: (e) => this.set({ homepage: e.target.value.trim() || 'https://www.google.com/' }) })),
      this.field('Ad blocking', adSeg, 'Built-in uses the uBlock Origin / EasyList filter lists (plus cookie-banner lists) without Chrome\'s extension limits.'),
      this.field('Dark mode', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.darkMode, onchange: (e) => this.set({ darkMode: e.target.checked }) }), 'Show websites dark by default (Dark Reader)'),
        themes.length ? h('div', { class: 'row wrap', style: { gap: '4px' } }, h('span', { class: 'hint' }, 'Per-site choices:'),
          themes.map(([host, t]) => h('button', { class: 'chip ' + (t === 'dark' ? '' : 'warn'), title: 'Remove — the site goes back to the default', onclick: () => api.call('browser:clearSiteTheme', host).then((st) => { state.settings = st; emit('settings', st); this.render(); }) }, `${host} · ${t}`, ' ×')))
          : 'Use the moon / sun button in the browser to switch one site; it\'s remembered for that site.'),
      this.field('Autofill logins', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: s.autofill, onchange: (e) => this.set({ autofill: e.target.checked }) }), 'Fill saved logins on sign-in pages')),
      this.field('Extensions', h('div', { class: 'col' }, extList, h('div', { class: 'row' }, extId,
        btn('Install', { icon: 'plus', onclick: () => {
          const m = extId.value.match(/[a-p]{32}/);
          if (!m) { toast('Paste a Chrome Web Store link or a 32-letter extension ID', 'warn'); return; }
          api.call('browser:extInstall', m[0]).then(() => { toast('Installed'); extId.value = ''; }).catch((e) => toast(e.message, 'error'));
        } }),
        btn('Chrome Web Store', { icon: 'store', onclick: () => { emit('open-url', { url: 'https://chromewebstore.google.com/', itemId: null }); } }))),
      'You can also click "Add to Chrome" on the Web Store inside the app. Not every extension works in an embedded browser.'),
      this.field('Browsing data', h('div', { class: 'row' },
        btn('Clear history', { icon: 'history', onclick: () => api.call('browser:clearHistory').then(() => toast('History cleared')) }),
        btn('Clear cookies & cache', { icon: 'trash', cls: 'danger', onclick: async () => { if (await confirmBox('Clear cookies and cache?', 'You\'ll be signed out of sites in the app\'s browser.', 'Clear')) api.call('browser:clearData').then(() => toast('Cleared')); } }))),
    ));

    // ---------- firefox
    const ffCard = h('div', { class: 'card' }, h('h2', null, icon('fox'), 'Import from Firefox'));
    this.wrap.appendChild(ffCard);
    this.renderFirefox(ffCard);

    // ---------- backups
    const bk = h('div', { class: 'card' }, h('h2', null, icon('save'), 'Library backups'));
    this.wrap.appendChild(bk);
    this.renderBackups(bk);

    // ---------- reset
    const reset = (what, label, text) => btn(label, { cls: 'danger', onclick: async () => {
      if (!(await confirmBox(label + '?', text, 'Reset'))) return;
      const st = await api.call('reset', what).catch((e) => toast(e.message, 'error'));
      if (st) { state.settings = st; emit('settings', st); toast('Done'); this.render(); }
    } });
    this.wrap.appendChild(h('div', { class: 'card' }, h('h2', null, icon('warn'), 'Reset'),
      h('div', { class: 'row wrap' },
        reset('settings', 'Reset settings', 'Folders, engines and browser options go back to defaults. Your SauceNAO key is kept.'),
        reset('library', 'Clear file list', 'Forget all looked-up files, results and download links. No files on disk are touched.'),
        reset('history', 'Clear history', 'Delete all browser history.'),
        reset('logins', 'Delete saved logins', 'Remove all logins saved in Image Seek.'),
        reset('browser', 'Clear cookies & cache', 'Sign out of every site in the app\'s browser.'),
        reset('thumbs', 'Clear thumbnail cache', 'Thumbnails are rebuilt as needed.')),
      h('div', { class: 'hint' }, `Image Seek ${state.version} · data folder: ${state.paths.data}`)));
  }

  // A copy of the file list is kept automatically before anything risky (and whenever files go
  // missing in bulk), so a bad rename or a disconnected drive can always be undone.
  async renderBackups(card) {
    const list = await api.call('lib:backups').catch(() => []);
    card.appendChild(h('div', { class: 'hint' }, 'Image Seek keeps a copy of your file list, lookup results and download links before anything risky — and whenever a lot of files suddenly go missing. The last 15 copies are kept. Your images are never touched.'));
    if (!list.length) card.appendChild(h('div', { class: 'xs dim' }, 'No backups yet.'));
    for (const b of list) {
      card.appendChild(h('div', { class: 'backup-row' },
        icon('save'),
        h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } },
          h('div', null, fmtTime(b.time), b.reason ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, REASON[b.reason] || b.reason) : null),
          h('div', { class: 'xs dim ell' }, `${b.items} file${b.items === 1 ? '' : 's'} · ${b.folders} folder${b.folders === 1 ? '' : 's'} · ${fmtBytes(b.size)}`)),
        btn('Restore', { icon: 'undo', cls: 'sm', onclick: async () => {
          if (!(await confirmBox('Restore this backup?', `Your file list goes back to how it was on ${fmtTime(b.time)} — ${b.items} files. A copy of the current list is saved first, so this can be undone. No images on disk are touched.`, 'Restore'))) return;
          try {
            const r = await api.call('lib:restoreBackup', b.file);
            toast(`Restored ${r.items} files in ${r.folders} folders`);
            this.render();
          } catch (e) { toast(e.message, 'error'); }
        } })));
    }
    card.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
      btn('Back up now', { icon: 'save', cls: 'sm primary', onclick: async () => {
        await api.call('lib:backupNow').catch((e) => toast(e.message, 'error'));
        toast('Backed up');
        this.render();
      } })));
  }

  async renderFirefox(card) {
    const profiles = await api.call('firefox:profiles').catch(() => []);
    const logins = await api.call('pw:list').catch(() => []);
    if (!profiles.length) {
      card.appendChild(h('div', { class: 'dim small' }, 'No Firefox profiles found on this PC. You can still import a logins CSV exported from Firefox.'));
    }
    const sel = h('select', { class: 'input grow' }, profiles.map((p) => h('option', { value: p.path }, `${p.name}${p.isDefault ? ' (default)' : ''}`)));
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'Firefox primary password (only if you set one)', style: { width: '300px' } });
    const status = h('div', { class: 'hint' });
    const importCookies = async () => {
      status.textContent = 'Importing cookies…';
      const off = api.on('import:progress', ({ done, total }) => { status.textContent = `Importing cookies… ${done}/${total}`; });
      try {
        const r = await api.call('firefox:cookies', sel.value);
        status.textContent = `Imported ${r.imported} cookies${r.failed ? ` (${r.failed} skipped)` : ''}. Reload open tabs to use them.`;
      } catch (e) { status.textContent = e.message; toast(e.message, 'error', 7000); }
      off();
    };
    const importLogins = async () => {
      status.textContent = 'Importing logins…';
      try {
        const r = await api.call('firefox:logins', sel.value, pw.value);
        status.textContent = `Logins: ${r.added} new, ${r.updated} updated${r.failed ? `, ${r.failed} unreadable` : ''}. ${r.total} saved in total.`;
        this.render();
      } catch (e) {
        status.textContent = e.message;
        if (/primary password/i.test(e.message)) pw.focus();
        toast(e.message, 'error', 7000);
      }
    };
    const importCsv = async () => {
      const f = await api.call('dialog:file', 'Choose the logins CSV exported from Firefox', [{ name: 'CSV', extensions: ['csv'] }]);
      if (!f) return;
      try {
        const r = await api.call('firefox:csv', f);
        status.textContent = `Logins from CSV: ${r.added} new, ${r.updated} updated. You can delete the CSV now — it holds your passwords in plain text.`;
        this.render();
      } catch (e) { toast(e.message, 'error', 7000); }
    };
    if (profiles.length) {
      card.append(
        this.field('Profile', sel),
        this.field('Cookies', h('div', { class: 'row' }, btn('Import cookies', { icon: 'download', cls: 'primary', onclick: importCookies })),
          'Keeps you signed in to the same sites as Firefox. Works while Firefox is open.'),
        this.field('Passwords', h('div', { class: 'row wrap' }, btn('Import passwords', { icon: 'key', cls: 'primary', onclick: importLogins }), pw),
          'Read directly from your Firefox profile and stored encrypted with your Windows account.'));
    }
    card.append(
      this.field('Or from a CSV', btn('Import logins CSV…', { icon: 'folder', onclick: importCsv }), 'In Firefox: about:logins → ⋯ → Export Logins.'),
      status,
      this.field('Saved logins', h('div', { class: 'row' }, h('span', { class: 'small' }, `${logins.length} saved`),
        logins.length ? btn('View…', { cls: 'sm', onclick: () => this.showLogins(logins) }) : null)));
  }

  async showLogins(list) {
    const body = h('div', { class: 'col', style: { gap: '2px', maxHeight: '55vh', overflow: 'auto' } }, list.map((l) => h('div', { class: 'row small', style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } },
      h('span', { class: 'grow ell' }, l.origin), h('span', { class: 'muted ell', style: { maxWidth: '180px' } }, l.username || '(no username)'),
      btn('', { icon: 'trash', cls: 'sm icon ghost danger', title: 'Delete', onclick: async (e) => { await api.call('pw:remove', l.origin, l.username); e.target.closest('.row').remove(); } }))));
    await modal(`Saved logins (${list.length})`, body, [{ label: 'Close', primary: true, value: () => null }]);
    this.render();
  }

  onShow() { this.render(); }
}

void fmtTime;

const REASON = {
  'files-missing': 'files went missing',
  'before-restore': 'before a restore',
  manual: 'manual',
  'folder-move': 'folder moved',
};
