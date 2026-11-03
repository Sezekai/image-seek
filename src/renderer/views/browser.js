// In-app browser with tabs. Each tab can be linked to a looked-up file; downloads from a linked
// tab are saved into that file's folder.
import { api, state, h, icon, btn, clear, thumbUrl, toast, on, emit, popupMenu, basename, hostOf } from '../core.js';

const DISCARD_AFTER = 15 * 60 * 1000;
let nextId = 1;

export class BrowserView {
  constructor(root) {
    this.root = root;
    this.tabs = [];
    this.active = null;
    this.build();
    on('open-url', ({ url, itemId }) => { this.open(url, { itemId, active: true }); emit('show-view', 'browser'); });
    on('search-in-tab', (o) => { this.searchIn(o); emit('show-view', 'browser'); });
    api.on('browser:open', (o) => this.open(o.url, { itemId: o.itemId, active: o.active !== false, reqId: o.reqId, openerId: o.openerId }));
    api.on('browser:select', ({ wcId }) => { const t = this.tabs.find((x) => x.wcId === wcId); if (t) this.activate(t); });
    api.on('browser:close', ({ wcId }) => { const t = this.tabs.find((x) => x.wcId === wcId); if (t) this.close(t); });
    api.on('dl:progress', () => this.renderDownloads());
    api.on('dl:finished', () => this.renderDownloads());
    on('lib', () => { this.renderBind(); this.renderTabs(); });
    setInterval(() => this.discardIdle(), 60 * 1000);
    document.addEventListener('keydown', (e) => this.key(e), true);
  }

  build() {
    this.tabsEl = h('div', { class: 'tabs' });
    this.addrInput = h('input', { class: 'input', placeholder: 'Search Google or type a URL', spellcheck: 'false' });
    this.suggestEl = h('div', { class: 'suggest hidden' });
    this.backBtn = btn('', { icon: 'back', cls: 'ghost', title: 'Back (Alt+←)', onclick: () => this.wv() && this.wv().goBack() });
    this.fwdBtn = btn('', { icon: 'fwd', cls: 'ghost', title: 'Forward (Alt+→)', onclick: () => this.wv() && this.wv().goForward() });
    this.reloadBtn = btn('', { icon: 'reload', cls: 'ghost', title: 'Reload (F5)', onclick: () => this.wv() && this.wv().reload() });
    this.darkBtn = btn('', { icon: 'moon', cls: 'ghost', title: 'Dark mode for this site', onclick: () => this.toggleDarkSite() });
    this.actions = document.createElement('browser-action-list');
    this.actions.setAttribute('partition', 'persist:browse');
    this.actions.setAttribute('alignment', 'bottom right');
    this.dlEl = h('div', { class: 'row xs muted hidden' });

    const siteBtn = (label, url, tip) => {
      const b = btn(label, { icon: 'search', title: tip, onclick: () => this.open(url, { itemId: this.boundItemForNew(), active: true }) });
      b.setAttribute('draggable', 'true');
      b.addEventListener('dragstart', (e) => {
        e.preventDefault();
        const p = this.dragPath();
        if (p) api.startDrag(p); else toast('Link this tab to a file (or select one in Lookups) to drag it', 'warn');
      });
      return b;
    };
    this.googleBtn = siteBtn('Google Images', 'https://images.google.com/', 'Open Google Images — drag this button onto the page to drop the linked file');
    this.yandexBtn = siteBtn('Yandex', 'https://yandex.com/images/', 'Open Yandex Images — drag this button onto the page to drop the linked file');

    const addr = h('div', { class: 'addr' }, this.addrInput, this.suggestEl);
    this.toolbar = h('div', { class: 'toolbar', style: { flexWrap: 'nowrap' } },
      this.backBtn, this.fwdBtn, this.reloadBtn, addr,
      this.googleBtn, this.yandexBtn,
      h('div', { class: 'vsep' }),
      this.darkBtn, this.actions,
      btn('', { icon: 'store', cls: 'ghost', title: 'Chrome Web Store (install extensions)', onclick: () => this.open('https://chromewebstore.google.com/', { active: true }) }),
      btn('', { icon: 'history', cls: 'ghost', title: 'History', onclick: () => emit('show-view', 'history') }),
      this.dlEl);
    this.bindEl = h('div', { class: 'bindbar' });
    this.views = h('div', { class: 'webviews' });
    this.blank = h('div', { class: 'blank' }, h('div', { class: 'empty' }, icon('globe'), h('div', null, 'No tabs open'),
      btn('New tab', { icon: 'plus', cls: 'primary', onclick: () => this.open(state.settings.homepage, { active: true }) })));
    this.views.appendChild(this.blank);
    this.root.append(this.tabsEl, this.toolbar, this.bindEl, this.views);

    this.addrInput.addEventListener('keydown', (e) => this.addrKey(e));
    this.addrInput.addEventListener('input', () => this.suggest());
    this.addrInput.addEventListener('focus', () => this.addrInput.select());
    this.addrInput.addEventListener('blur', () => setTimeout(() => this.suggestEl.classList.add('hidden'), 150));
    this.renderTabs();
    this.renderBind();
  }

  wv() { return this.active && this.active.wv; }

  // ---------- tabs ----------
  open(url, { itemId = null, active = true, reqId = null, openerId = null, upload = null } = {}) {
    if (openerId && itemId == null) {
      const opener = this.tabs.find((t) => t.wcId === openerId);
      if (opener) itemId = opener.itemId;
    }
    const tab = { id: nextId++, url: url || state.settings.homepage, title: 'New tab', favicon: null, loading: true, itemId: itemId || null, wcId: null, lastActive: Date.now(), reqId, upload };
    this.tabs.push(tab);
    this.mount(tab);
    if (active || !this.active) this.activate(tab);
    this.renderTabs();
    return tab;
  }

  mount(tab) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:browse');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes');
    wv.src = 'about:blank';
    tab.wv = wv;
    tab.discarded = false;
    let first = true;
    wv.addEventListener('dom-ready', async () => {
      if (!first) return;
      first = false;
      tab.wcId = wv.getWebContentsId();
      await api.call('browser:bind', tab.wcId, tab.itemId);
      if (tab.reqId) { api.call('browser:tabReady', tab.reqId, tab.wcId); tab.reqId = null; }
      if (tab === this.active) { api.call('browser:select', tab.wcId); this.actions.setAttribute('tab', String(tab.wcId)); }
      if (tab.upload) {
        const u = tab.upload;
        tab.upload = null;
        api.call('browser:upload', tab.wcId, u.engine, u.path).catch((e) => toast('Upload failed: ' + e.message, 'error'));
      } else if (tab.url && tab.url !== 'about:blank') {
        wv.loadURL(tab.url).catch(() => {});
      }
    });
    wv.addEventListener('did-start-loading', () => { tab.loading = true; this.renderTab(tab); });
    wv.addEventListener('did-stop-loading', () => { tab.loading = false; this.renderTab(tab); this.renderNav(); });
    wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; this.renderTab(tab); });
    wv.addEventListener('page-favicon-updated', (e) => { tab.favicon = e.favicons && e.favicons[0]; this.renderTab(tab); });
    const nav = (e) => {
      if (e.isMainFrame === false) return;
      if (e.url && e.url !== 'about:blank') tab.url = e.url;
      if (tab === this.active && document.activeElement !== this.addrInput) this.addrInput.value = tab.url === 'about:blank' ? '' : tab.url;
      this.renderNav();
    };
    wv.addEventListener('did-navigate', nav);
    wv.addEventListener('did-navigate-in-page', nav);
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || !e.isMainFrame) return; // aborted (e.g. a download)
      tab.loading = false; this.renderTab(tab);
    });
    this.views.appendChild(wv);
  }

  activate(tab) {
    if (tab.discarded) this.restore(tab);
    this.active = tab;
    tab.lastActive = Date.now();
    for (const t of this.tabs) if (t.wv) t.wv.classList.toggle('on', t === tab);
    this.blank.classList.toggle('hidden', true);
    if (tab.wcId) { api.call('browser:select', tab.wcId); this.actions.setAttribute('tab', String(tab.wcId)); }
    if (document.activeElement !== this.addrInput) this.addrInput.value = tab.url === 'about:blank' ? '' : (tab.url || '');
    this.renderTabs();
    this.renderBind();
    this.renderNav();
  }

  close(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (tab.wv) tab.wv.remove();
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
      else { this.blank.classList.remove('hidden'); this.addrInput.value = ''; this.renderBind(); }
    }
    this.renderTabs();
  }

  // Free memory from tabs you haven't looked at in a while; they reload when selected.
  discardIdle() {
    const now = Date.now();
    for (const t of this.tabs) {
      if (t === this.active || t.discarded || t.loading || !t.wv) continue;
      if (now - t.lastActive > DISCARD_AFTER) {
        t.wv.remove();
        t.wv = null;
        t.wcId = null;
        t.discarded = true;
      }
    }
  }

  restore(tab) {
    tab.discarded = false;
    this.mount(tab);
  }

  renderTabs() {
    clear(this.tabsEl);
    for (const t of this.tabs) this.tabsEl.appendChild(this.tabEl(t));
    this.tabsEl.appendChild(h('button', { class: 'newtab', title: 'New tab (Ctrl+T)', onclick: () => this.open(state.settings.homepage, { active: true }) }, icon('plus')));
  }

  tabEl(t) {
    const it = t.itemId ? state.items.get(t.itemId) : null;
    const el = h('div', {
      class: 'tab' + (t === this.active ? ' on' : ''), title: (it ? `Linked to ${it.name}\n` : '') + (t.title || t.url),
      onclick: () => this.activate(t),
      onauxclick: (e) => { if (e.button === 1) this.close(t); },
    },
    t.loading ? h('span', { class: 'spin' }) : it ? h('img', { class: 'bound', src: thumbUrl(it.path, 64) }) : t.favicon ? h('img', { class: 'fav', src: t.favicon, onerror: (e) => e.target.remove() }) : icon('globe'),
    h('span', { class: 't' }, t.title || hostOf(t.url) || 'New tab'),
    h('button', { class: 'x', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); this.close(t); } }, icon('x')));
    el.dataset.tab = t.id;
    return el;
  }

  renderTab(t) {
    const old = this.tabsEl.querySelector(`[data-tab="${t.id}"]`);
    if (old) old.replaceWith(this.tabEl(t));
  }

  renderNav() {
    const wv = this.wv();
    let can = { b: false, f: false };
    try { if (wv && this.active.wcId) can = { b: wv.canGoBack(), f: wv.canGoForward() }; } catch (_) { /* not ready */ }
    this.backBtn.disabled = !can.b;
    this.fwdBtn.disabled = !can.f;
    const host = this.active ? hostOf(this.active.url) : '';
    const excluded = host && (state.settings.darkModeExclude || []).some((x) => host === x || host.endsWith('.' + x));
    clear(this.darkBtn).appendChild(icon(state.settings.darkMode && !excluded ? 'moon' : 'sun'));
    this.darkBtn.title = !state.settings.darkMode ? 'Dark mode is off (turn it on in Settings)' : excluded ? `Dark mode off for ${host} — click to turn on` : `Dark mode on for ${host} — click to turn off for this site`;
  }

  // ---------- linking ----------
  boundItemForNew() {
    if (this.active && this.active.itemId) return this.active.itemId;
    return null;
  }

  dragPath() {
    const id = (this.active && this.active.itemId) || state.selectedItem;
    const it = id && state.items.get(id);
    return it && !it.originalRecycled ? it.path : null;
  }

  renderBind() {
    clear(this.bindEl);
    const t = this.active;
    if (!t) { this.bindEl.classList.add('hidden'); return; }
    this.bindEl.classList.remove('hidden');
    const it = t.itemId ? state.items.get(t.itemId) : null;
    if (it) {
      const dl = it.downloads || 0;
      const img = h('img', { src: thumbUrl(it.path, 64), draggable: 'true', title: 'Drag onto the page to search with it' });
      img.addEventListener('dragstart', (e) => { e.preventDefault(); api.startDrag(it.path); });
      this.bindEl.append(icon('link'), h('span', { class: 'muted' }, 'Linked to'), img, h('b', { class: 'ell', style: { maxWidth: '320px' } }, it.name),
        h('span', { class: 'chip ' + (dl ? 'green' : '') }, `${dl} downloaded`),
        h('span', { class: 'dim xs' }, 'Downloads and right-click → Save image go to this file\'s folder'),
        h('div', { class: 'grow' }),
        btn('Change', { cls: 'sm', onclick: (e) => this.chooseBind(e) }),
        btn('Unlink tab', { icon: 'unlink', cls: 'sm', onclick: () => this.setBind(null) }),
        btn('Open file', { icon: 'eye', cls: 'sm', onclick: () => { emit('select-item', it.id); emit('show-view', 'lookups'); } }));
    } else {
      const sel = state.selectedItem && state.items.get(state.selectedItem);
      this.bindEl.append(icon('unlink'), h('span', { class: 'muted' }, 'Not linked — downloads go to the Unlinked folder'), h('div', { class: 'grow' }),
        sel ? btn(`Link to "${sel.name.length > 30 ? sel.name.slice(0, 29) + '…' : sel.name}"`, { icon: 'link', cls: 'sm', onclick: () => this.setBind(sel.id) }) : null,
        btn('Link to…', { cls: 'sm', onclick: (e) => this.chooseBind(e) }));
    }
  }

  chooseBind(e) {
    const r = e.target.getBoundingClientRect();
    const list = [...state.items.values()].filter((s) => s.status !== 'done' && s.status !== 'sorted')
      .sort((a, b) => (b.mode === 'upgrade') - (a.mode === 'upgrade') || (b.downloads || 0) - (a.downloads || 0)).slice(0, 40);
    if (!list.length) { toast('No files to link to yet', 'warn'); return; }
    popupMenu(r.left, r.bottom + 4, list.map((s) => ({ label: s.name, img: thumbUrl(s.path, 64), run: () => this.setBind(s.id) })));
  }

  async setBind(itemId) {
    const t = this.active;
    if (!t) return;
    t.itemId = itemId;
    if (t.wcId) await api.call('browser:bind', t.wcId, itemId);
    this.renderBind();
    this.renderTab(t);
  }

  // ---------- reverse search in a new linked tab ----------
  searchIn({ engine, path, itemId }) {
    this.open('about:blank', { itemId, active: true, upload: { engine, path } });
  }

  // ---------- address bar ----------
  navigate(text) {
    let url = text.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url) || /^localhost(:\d+)?/.test(url)) url = 'https://' + url;
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
    if (!this.active) this.open(url, { active: true });
    else { this.active.url = url; if (this.wv() && this.active.wcId) this.wv().loadURL(url).catch(() => {}); }
    this.wv() && this.wv().focus();
  }

  addrKey(e) {
    const items = [...this.suggestEl.querySelectorAll('div')];
    const cur = items.findIndex((x) => x.classList.contains('on'));
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items.forEach((x) => x.classList.remove('on')); items[(cur + 1) % items.length].classList.add('on'); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items.forEach((x) => x.classList.remove('on')); items[(cur - 1 + items.length) % items.length].classList.add('on'); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = items[cur];
      this.suggestEl.classList.add('hidden');
      this.navigate(pick ? pick.dataset.url : this.addrInput.value);
    } else if (e.key === 'Escape') { this.suggestEl.classList.add('hidden'); this.addrInput.value = this.active ? this.active.url : ''; this.addrInput.blur(); }
  }

  async suggest() {
    const q = this.addrInput.value.trim();
    const list = q ? await api.call('browser:suggest', q).catch(() => []) : [];
    clear(this.suggestEl);
    this.suggestEl.classList.toggle('hidden', !list.length);
    for (const s of list) {
      const d = h('div', { onmousedown: (e) => { e.preventDefault(); this.suggestEl.classList.add('hidden'); this.navigate(s.url); } },
        h('span', { class: 'ell' }, s.title || s.url), h('span', { class: 'u ell grow' }, s.url));
      d.dataset.url = s.url;
      this.suggestEl.appendChild(d);
    }
  }

  async toggleDarkSite() {
    if (!this.active) return;
    if (!state.settings.darkMode) {
      state.settings = await api.call('settings:set', { darkMode: true });
      emit('settings', state.settings);
    } else {
      const host = hostOf(this.active.url);
      if (!host) return;
      const excluded = (state.settings.darkModeExclude || []).some((x) => host === x || host.endsWith('.' + x));
      state.settings = await api.call('browser:darkSite', host, excluded);
      emit('settings', state.settings);
    }
    this.renderNav();
    this.wv() && this.wv().reload();
  }

  async renderDownloads() {
    const active = [...state.downloads.values()].filter((d) => d.state === 'progress');
    this.dlEl.classList.toggle('hidden', !active.length);
    clear(this.dlEl);
    if (active.length) this.dlEl.append(icon('download'), `${active.length} downloading`);
  }

  key(e) {
    if (state.view !== 'browser') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }); setTimeout(() => this.addrInput.focus(), 50); }
    else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); if (this.active) this.close(this.active); }
    else if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); this.addrInput.focus(); }
    else if (ctrl && e.key === 'Tab') {
      e.preventDefault();
      if (this.tabs.length > 1) { const i = this.tabs.indexOf(this.active); this.activate(this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length]); }
    } else if (e.key === 'F5') { e.preventDefault(); this.wv() && this.wv().reload(); }
    else if (e.altKey && e.key === 'ArrowLeft') { this.wv() && this.wv().goBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { this.wv() && this.wv().goForward(); }
  }

  shortcut(k) {
    if (k === 'newtab') { this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }); setTimeout(() => this.addrInput.focus(), 50); }
    else if (k === 'close') { if (this.active) this.close(this.active); }
    else if (k === 'address') this.addrInput.focus();
    else if (k === 'next' || k === 'prev') {
      if (this.tabs.length > 1) { const i = this.tabs.indexOf(this.active); this.activate(this.tabs[(i + (k === 'prev' ? -1 : 1) + this.tabs.length) % this.tabs.length]); }
    } else if (k === 'reload') this.wv() && this.wv().reload();
    else if (k === 'back') this.wv() && this.wv().goBack();
    else if (k === 'forward') this.wv() && this.wv().goForward();
  }

  onShow() {
    if (!this.tabs.length) this.open(state.settings.homepage, { active: true });
    this.renderBind();
  }
}

void basename;
