// The app's browser. There is one browser, shown in one of three places:
//   'small'    — in Lookups, between the file grid and the info panel
//   'expanded' — in Lookups, covering the file grid
//   'full'     — the Browser tab
// It sits in its own layer that is positioned over a placeholder, so moving between those
// places never reloads the pages. Each tab can be linked to a looked-up file; downloads from
// a linked tab are saved into that file's folder.
import { api, state, h, icon, btn, clear, thumbUrl, toast, on, emit, popupMenu, hostOf } from '../core.js';
import { HistoryList } from './historylist.js';

const DISCARD_AFTER = 15 * 60 * 1000;
let nextId = 1;

export class Browser {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.closed = []; // recently closed tabs, for Ctrl+Shift+T
    this.linkTabs = new Map(); // item id -> tab opened from that file's match links (reused)
    this.histOpen = false;
    this.slot = null;
    this.place = null; // 'small' | 'expanded' | 'full' | null (hidden)
    this.build();
    on('lib', () => { this.renderBind(); this.renderTabs(); this.renderSave(); });
    on('settings', () => this.renderNav());
    on('selected-item', () => { if (this.active && !this.active.itemId) this.renderBind(); });
    api.on('browser:open', (o) => this.open(o.url, { itemId: o.itemId, active: o.active !== false, reqId: o.reqId, openerId: o.openerId }));
    api.on('browser:select', ({ wcId }) => { const t = this.tabs.find((x) => x.wcId === wcId); if (t) this.activate(t); });
    api.on('browser:close', ({ wcId }) => { const t = this.tabs.find((x) => x.wcId === wcId); if (t) this.close(t); });
    api.on('dl:progress', () => this.renderDownloads());
    api.on('dl:finished', () => this.renderDownloads());
    setInterval(() => this.discardIdle(), 60 * 1000);
    setInterval(() => this.position(), 150);
    window.addEventListener('resize', () => this.position());
  }

  build() {
    // Tab bar: tabs shrink to a minimum width, then scroll with the arrow buttons (or the
    // mouse wheel); the ▾ button lists every tab.
    this.tabsEl = h('div', { class: 'tabstrip' });
    this.scrollL = h('button', { class: 'tabarrow hidden', title: 'Scroll tabs left', onclick: () => this.scrollTabs(-1) }, icon('back'));
    this.scrollR = h('button', { class: 'tabarrow hidden', title: 'Scroll tabs right', onclick: () => this.scrollTabs(1) }, icon('fwd'));
    this.newTabBtn = h('button', { class: 'newtab', title: 'New tab (Ctrl+T)', onclick: () => this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }) }, icon('plus'));
    this.listBtn = h('button', { class: 'newtab', title: 'List all tabs', onclick: (e) => this.listTabs(e) }, icon('chevD'));
    this.tabBar = h('div', { class: 'tabs' }, this.scrollL, this.tabsEl, this.scrollR, this.newTabBtn, h('div', { class: 'grow' }), this.listBtn);
    this.tabsEl.addEventListener('wheel', (e) => { e.preventDefault(); this.tabsEl.scrollLeft += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX); this.updateArrows(); }, { passive: false });
    this.tabsEl.addEventListener('scroll', () => this.updateArrows());
    new ResizeObserver(() => requestAnimationFrame(() => this.updateArrows())).observe(this.tabsEl);
    this.addrInput = h('input', { class: 'input', placeholder: 'Search Google or type a URL', spellcheck: 'false' });
    this.suggestEl = h('div', { class: 'suggest hidden' });
    this.backBtn = btn('', { icon: 'back', cls: 'ghost', title: 'Back (Alt+← or mouse back button)', onclick: () => this.go('back') });
    this.fwdBtn = btn('', { icon: 'fwd', cls: 'ghost', title: 'Forward (Alt+→ or mouse forward button)', onclick: () => this.go('forward') });
    this.reloadBtn = btn('', { icon: 'reload', cls: 'ghost', title: 'Reload (F5)', onclick: () => this.go('reload') });
    this.darkBtn = btn('', { icon: 'moon', cls: 'ghost', onclick: () => this.toggleTheme() });
    this.actions = document.createElement('browser-action-list');
    this.actions.setAttribute('partition', 'persist:browse');
    this.actions.setAttribute('alignment', 'bottom right');
    this.dlEl = h('div', { class: 'row xs muted hidden' });

    // Save buttons, shown while the tab is showing an image file.
    this.saveLinked = btn('', { icon: 'link', cls: 'ghost', onclick: () => this.saveCurrent('linked') });
    this.saveUnlinked = btn('', { icon: 'download', cls: 'ghost', title: 'Save this image as an unlinked download', onclick: () => this.saveCurrent('unlinked') });
    this.saveAsBtn = btn('', { icon: 'saveas', cls: 'ghost', title: 'Save as… — choose any folder on your PC (not tracked by Image Seek)', onclick: () => this.saveCurrent('saveas') });
    this.saveGroup = h('div', { class: 'group savegroup hidden' }, h('span', { class: 'xs muted' }, 'Save'), this.saveLinked, this.saveUnlinked, this.saveAsBtn, h('div', { class: 'vsep' }));

    const siteBtn = (label, url, tip) => {
      const b = btn(label, { icon: 'search', cls: 'sitebtn', title: tip, onclick: () => this.open(url, { itemId: this.boundItemForNew(), active: true }) });
      b.setAttribute('draggable', 'true');
      b.addEventListener('dragstart', (e) => {
        e.preventDefault();
        const p = this.dragPath();
        if (p) api.startDrag(p); else toast('Link this tab to a file (or select one in Lookups) to drag it', 'warn');
      });
      return b;
    };
    this.googleBtn = siteBtn('Google', 'https://images.google.com/', 'Open Google Images — drag this button onto the page to drop the linked file');
    this.yandexBtn = siteBtn('Yandex', 'https://yandex.com/images/', 'Open Yandex Images — drag this button onto the page to drop the linked file');

    // Where the browser is shown.
    this.placeBtns = h('div', { class: 'group' });

    const addr = h('div', { class: 'addr' }, this.addrInput, this.suggestEl);
    this.toolbar = h('div', { class: 'toolbar', style: { flexWrap: 'nowrap' } },
      this.backBtn, this.fwdBtn, this.reloadBtn, addr,
      this.saveGroup,
      this.googleBtn, this.yandexBtn,
      h('div', { class: 'vsep' }),
      this.darkBtn, this.actions,
      btn('', { icon: 'store', cls: 'ghost', title: 'Chrome Web Store (install extensions)', onclick: () => this.open('https://chromewebstore.google.com/', { active: true }) }),
      (this.histBtn = btn('', { icon: 'history', cls: 'ghost', title: 'History (Ctrl+H)', onclick: () => this.toggleHistory() })),
      this.dlEl,
      h('div', { class: 'vsep' }),
      this.placeBtns);
    this.bindEl = h('div', { class: 'bindbar' });
    this.views = h('div', { class: 'webviews' });
    this.blank = h('div', { class: 'blank' }, h('div', { class: 'empty' }, icon('globe'), h('div', null, 'No tabs open'),
      btn('New tab', { icon: 'plus', cls: 'primary', onclick: () => this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }) })));
    this.views.appendChild(this.blank);
    // History side panel (in the small view it covers the file grid instead).
    this.history = new HistoryList({ compact: true, onOpen: (url, newTab) => this.openFromHistory(url, newTab), onClose: () => this.toggleHistory(false) });
    this.histSide = h('div', { class: 'histside hidden' });
    this.body = h('div', { class: 'bbody' }, this.histSide, this.views);
    this.el = h('div', { class: 'browser-layer off' }, this.tabBar, this.toolbar, this.bindEl, this.body);
    document.body.appendChild(this.el);
    new ResizeObserver(() => requestAnimationFrame(() => this.el.classList.toggle('narrow', this.el.clientWidth < 1000))).observe(this.el);

    this.addrInput.addEventListener('keydown', (e) => this.addrKey(e));
    this.addrInput.addEventListener('input', () => this.suggest());
    this.addrInput.addEventListener('focus', () => this.addrInput.select());
    this.addrInput.addEventListener('blur', () => setTimeout(() => this.suggestEl.classList.add('hidden'), 150));
    this.renderTabs();
    this.renderBind();
    this.renderPlace();
  }

  // ---------- placement ----------
  show(slot, place, opts = {}) {
    this.slot = slot;
    this.histSmallHost = opts.histHost || null;
    const changed = this.place !== place;
    this.place = place;
    this.el.classList.remove('off');
    this.el.classList.toggle('docked', place !== 'full');
    this.position(true);
    if (changed) this.renderPlace();
    if (!this.tabs.length) this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() });
    this.renderBind();
    this.placeHistory();
    requestAnimationFrame(() => this.revealActive());
  }

  hide() {
    this.place = null;
    this.slot = null;
    this.el.classList.add('off');
    this.suggestEl.classList.add('hidden');
    this.placeHistory();
  }

  // ---------- history panel ----------
  toggleHistory(open) {
    this.histOpen = open === undefined ? !this.histOpen : open;
    this.histBtn.classList.toggle('on', this.histOpen);
    this.placeHistory();
    if (this.histOpen) { this.history.render(); this.history.focus(); }
  }

  placeHistory() {
    const small = this.place === 'small' && this.histSmallHost;
    const show = this.histOpen && !!this.place;
    if (this.histSmallHost) this.histSmallHost.classList.toggle('hidden', !(show && small));
    this.histSide.classList.toggle('hidden', !(show && !small));
    const host = small ? this.histSmallHost : this.histSide;
    if (show && this.history.el.parentNode !== host) host.appendChild(this.history.el);
  }

  openFromHistory(url, newTab) {
    if (newTab || !this.active) this.open(url, { active: !newTab || !this.active, itemId: this.boundItemForNew() });
    else this.navigateTab(this.active, url);
  }

  get visible() { return !!this.place; }

  position(force) {
    if (!this.slot || !this.place) return;
    const r = this.slot.getBoundingClientRect();
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (!force && key === this.lastRect) return;
    this.lastRect = key;
    Object.assign(this.el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  renderPlace() {
    clear(this.placeBtns);
    const b = (ic, tip, fn) => btn('', { icon: ic, cls: 'ghost', title: tip, onclick: fn });
    const closeAll = b('closeall', 'Close all tabs and the browser (Ctrl+Shift+W)', () => this.closeAll());
    if (this.place === 'small') {
      this.placeBtns.append(
        b('expand', 'Expand over the file grid (E)', () => emit('dock', 'expanded')),
        b('maximize', 'Open in the Browser tab', () => emit('show-view', 'browser')),
        b('x', 'Close the browser panel — tabs stay open (B)', () => emit('dock', 'closed')),
        closeAll);
    } else if (this.place === 'expanded') {
      this.placeBtns.append(
        b('shrink', 'Show the file grid again (E)', () => emit('dock', 'small')),
        b('maximize', 'Open in the Browser tab', () => emit('show-view', 'browser')),
        b('x', 'Close the browser panel — tabs stay open (B)', () => emit('dock', 'closed')),
        closeAll);
    } else if (this.place === 'full') {
      this.placeBtns.append(b('dock', 'Show in Lookups next to the files', () => { emit('dock', state.lastDock || 'small'); emit('show-view', 'lookups'); }), closeAll);
    }
  }

  // ---------- tabs ----------
  open(url, { itemId = null, active = true, reqId = null, openerId = null, upload = null } = {}) {
    if (openerId && itemId == null) {
      const opener = this.tabs.find((t) => t.wcId === openerId);
      if (opener) itemId = opener.itemId;
    }
    const tab = { id: nextId++, url: url || state.settings.homepage, title: 'New tab', favicon: null, loading: true, itemId: itemId || null, wcId: null, lastActive: Date.now(), reqId, upload, isImage: false };
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
    wv.addEventListener('did-stop-loading', async () => {
      tab.loading = false;
      this.renderTab(tab);
      this.renderNav();
      try { tab.isImage = /^image\//.test(await wv.executeJavaScript('document.contentType')); } catch (_) { tab.isImage = false; }
      if (tab === this.active) this.renderSave();
    });
    wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; this.renderTab(tab); });
    wv.addEventListener('page-favicon-updated', (e) => { tab.favicon = e.favicons && e.favicons[0]; this.renderTab(tab); });
    const nav = (e) => {
      if (e.isMainFrame === false) return;
      if (e.url && e.url !== 'about:blank') tab.url = e.url;
      if (tab === this.active && document.activeElement !== this.addrInput) this.addrInput.value = tab.url === 'about:blank' ? '' : tab.url;
      this.renderNav();
    };
    wv.addEventListener('did-navigate', (e) => { tab.isImage = false; nav(e); if (tab === this.active) this.renderSave(); });
    wv.addEventListener('did-navigate-in-page', nav);
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || !e.isMainFrame) return; // aborted (e.g. a download)
      tab.loading = false; this.renderTab(tab);
    });
    this.views.appendChild(wv);
  }

  navigateTab(tab, url) {
    tab.url = url;
    if (tab.discarded) { this.activate(tab); return; }
    if (tab.wv && tab.wcId) tab.wv.loadURL(url).catch(() => {});
    this.activate(tab);
  }

  // A match link from the info panel: re-uses the tab opened from that file's links,
  // or opens a new one (always new with Ctrl+click / middle-click — in the background).
  openLink(url, itemId, newTab) {
    const prev = itemId && this.linkTabs.get(itemId);
    if (!newTab && prev && this.tabs.includes(prev)) { this.navigateTab(prev, url); return prev; }
    const t = this.open(url, { itemId, active: !newTab || !this.active });
    if (itemId && (!prev || !this.tabs.includes(prev))) this.linkTabs.set(itemId, t);
    return t;
  }

  activate(tab) {
    if (tab.discarded) this.restore(tab);
    this.active = tab;
    tab.lastActive = Date.now();
    for (const t of this.tabs) if (t.wv) t.wv.classList.toggle('on', t === tab);
    this.blank.classList.add('hidden');
    if (tab.wcId) { api.call('browser:select', tab.wcId); this.actions.setAttribute('tab', String(tab.wcId)); }
    if (document.activeElement !== this.addrInput) this.addrInput.value = tab.url === 'about:blank' ? '' : (tab.url || '');
    this.renderTabs();
    this.renderBind();
    this.renderNav();
    this.renderSave();
    emit('browser-tab');
  }

  // Closing the last tab closes the browser too.
  close(tab, { keepBrowser } = {}) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (tab.url && tab.url !== 'about:blank') { this.closed.push({ url: tab.url, itemId: tab.itemId }); if (this.closed.length > 25) this.closed.shift(); }
    if (tab.wv) tab.wv.remove();
    this.tabs.splice(i, 1);
    for (const [k, t] of this.linkTabs) if (t === tab) this.linkTabs.delete(k);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
      else { this.blank.classList.remove('hidden'); this.addrInput.value = ''; this.renderBind(); this.renderSave(); }
    }
    this.renderTabs();
    if (!this.tabs.length && !keepBrowser) emit('browser-closed');
  }

  closeMany(list) {
    for (const t of [...list]) this.close(t, { keepBrowser: true });
    if (!this.tabs.length) emit('browser-closed');
  }

  closeAll() { this.closeMany(this.tabs); this.toggleHistory(false); }

  reopen() {
    const c = this.closed.pop();
    if (c) this.open(c.url, { itemId: c.itemId, active: true });
  }

  tabMenu(e, t) {
    e.preventDefault();
    const i = this.tabs.indexOf(t);
    const sel = state.selectedItem && state.items.get(state.selectedItem);
    const items = [
      { label: 'New tab', run: () => this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }) },
      { label: 'Reload', run: () => { if (t.wv && t.wcId) t.wv.reload(); else this.activate(t); } },
      { label: 'Duplicate tab', run: () => this.open(t.url, { itemId: t.itemId, active: true }) },
      { label: 'Copy address', run: () => navigator.clipboard.writeText(t.url || '') },
      '-',
      sel && sel.id !== t.itemId ? { label: `Link to "${sel.name.length > 28 ? sel.name.slice(0, 27) + '…' : sel.name}"`, run: () => { this.activate(t); this.setBind(sel.id); } } : null,
      t.itemId ? { label: 'Unlink tab', run: () => { this.activate(t); this.setBind(null); } } : null,
      '-',
      { label: 'Close tab', run: () => this.close(t) },
      i > 0 ? { label: `Close tabs to the left (${i})`, run: () => this.closeMany(this.tabs.slice(0, i)) } : null,
      i < this.tabs.length - 1 ? { label: `Close tabs to the right (${this.tabs.length - 1 - i})`, run: () => this.closeMany(this.tabs.slice(i + 1)) } : null,
      this.tabs.length > 1 ? { label: `Close other tabs (${this.tabs.length - 1})`, run: () => this.closeMany(this.tabs.filter((x) => x !== t)) } : null,
      t.itemId && this.tabs.filter((x) => x.itemId === t.itemId).length > 1 ? { label: 'Close all tabs linked to this file', run: () => this.closeMany(this.tabs.filter((x) => x.itemId === t.itemId)) } : null,
      { label: 'Close all tabs and the browser', run: () => this.closeAll() },
      this.closed.length ? '-' : null,
      this.closed.length ? { label: 'Reopen closed tab (Ctrl+Shift+T)', run: () => this.reopen() } : null,
    ].filter(Boolean);
    while (items[0] === '-') items.shift();
    popupMenu(e.clientX, e.clientY, items.filter((x, k) => !(x === '-' && (items[k + 1] === '-' || k === items.length - 1))));
  }

  listTabs(e) {
    const r = e.currentTarget.getBoundingClientRect();
    popupMenu(r.right - 300, r.bottom + 4, this.tabs.map((t) => {
      const it = t.itemId ? state.items.get(t.itemId) : null;
      return { label: (t === this.active ? '● ' : '') + (t.title || hostOf(t.url) || 'New tab'), img: it ? thumbUrl(it.path, 64) : t.favicon || null, run: () => this.activate(t) };
    }));
  }

  scrollTabs(dir) {
    this.tabsEl.scrollBy({ left: dir * Math.max(120, this.tabsEl.clientWidth * 0.6), behavior: 'smooth' });
    setTimeout(() => this.updateArrows(), 350);
  }

  updateArrows() {
    const el = this.tabsEl;
    const over = el.scrollWidth > el.clientWidth + 1;
    this.scrollL.classList.toggle('hidden', !over);
    this.scrollR.classList.toggle('hidden', !over);
    this.scrollL.disabled = el.scrollLeft <= 0;
    this.scrollR.disabled = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  }

  revealActive() {
    const el = this.active && this.tabsEl.querySelector(`[data-tab="${this.active.id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.updateArrows();
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
    const keep = this.tabsEl.scrollLeft;
    clear(this.tabsEl);
    for (const t of this.tabs) this.tabsEl.appendChild(this.tabEl(t));
    this.tabsEl.scrollLeft = keep;
    requestAnimationFrame(() => this.revealActive());
  }

  tabEl(t) {
    const it = t.itemId ? state.items.get(t.itemId) : null;
    const el = h('div', {
      class: 'tab' + (t === this.active ? ' on' : ''), title: (it ? `Linked to ${it.name}\n` : '') + (t.title || t.url) + '\nMiddle-click to close · right-click for more',
      onclick: () => this.activate(t),
      // Middle-click closes (mousedown is cancelled so it doesn't start auto-scroll).
      onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
      onmouseup: (e) => { if (e.button === 1) { e.preventDefault(); this.close(t); } },
      oncontextmenu: (e) => this.tabMenu(e, t),
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
    const url = this.active ? this.active.url : '';
    const host = hostOf(url);
    const dark = this.themeFor(url) === 'dark';
    clear(this.darkBtn).appendChild(icon(dark ? 'moon' : 'sun'));
    this.darkBtn.title = host ? `${host} is shown ${dark ? 'dark' : 'light'} — click to switch (remembered for this site)` : 'Dark / light for this site';
    this.darkBtn.disabled = !/^https?:/.test(url || '');
  }

  // Same rule as the main process: the site's own choice, then its parent domain, else the default.
  themeFor(url) {
    const host = hostOf(url);
    const map = state.settings.siteThemes || {};
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) { const k = parts.slice(i).join('.'); if (map[k]) return map[k]; }
    return state.settings.darkMode ? 'dark' : 'light';
  }

  async toggleTheme() {
    if (!this.active) return;
    const url = this.active.url;
    const next = this.themeFor(url) === 'dark' ? 'light' : 'dark';
    state.settings = await api.call('browser:siteTheme', url, next);
    emit('settings', state.settings);
    this.renderNav();
    if (this.wv()) this.wv().reload();
  }

  // ---------- saving ----------
  renderSave() {
    const t = this.active;
    const show = !!(t && t.isImage);
    this.saveGroup.classList.toggle('hidden', !show);
    if (!show) return;
    const it = t.itemId ? state.items.get(t.itemId) : null;
    this.saveLinked.disabled = !it;
    this.saveLinked.title = it ? `Save this image to "${it.name}" (linked)` : 'Link this tab to a file to save linked';
  }

  async saveCurrent(mode) {
    if (!this.active || !this.active.wcId) return;
    try {
      await api.call('browser:saveCurrent', this.active.wcId, mode);
      if (mode !== 'saveas') toast(mode === 'linked' ? 'Saving to the linked file' : 'Saving as unlinked');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- linking ----------
  boundItemForNew() {
    if (this.active && this.active.itemId) return this.active.itemId;
    return null;
  }

  dragPath() {
    const id = (this.active && this.active.itemId) || state.selectedItem;
    const it = id && state.items.get(id);
    return it && !it.originalGone ? it.path : null;
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
      const drag = btn('Drag to search', { icon: 'hand', cls: 'sm', title: 'Drag this onto Google Images, Yandex or any upload box to search with the file' });
      drag.setAttribute('draggable', 'true');
      drag.addEventListener('dragstart', (e) => { e.preventDefault(); api.startDrag(it.path); });
      this.bindEl.append(icon('link'), h('span', { class: 'muted' }, 'Linked to'), img, h('b', { class: 'ell', style: { maxWidth: '260px' } }, it.name),
        h('span', { class: 'chip ' + (dl ? 'green' : '') }, `${dl} downloaded`),
        it.originalGone ? null : drag,
        h('span', { class: 'dim xs ell hint' }, 'Downloads and right-click → Save image go to this file\'s folder'),
        h('div', { class: 'grow' }),
        btn('Change', { cls: 'sm', onclick: (e) => this.chooseBind(e) }),
        btn('Unlink tab', { icon: 'unlink', cls: 'sm', onclick: () => this.setBind(null) }),
        this.place === 'full' ? btn('Open file', { icon: 'eye', cls: 'sm', onclick: () => { emit('select-item', it.id); emit('show-view', 'lookups'); } }) : null);
    } else {
      const sel = state.selectedItem && state.items.get(state.selectedItem);
      this.bindEl.append(icon('unlink'), h('span', { class: 'muted ell' }, 'Not linked — downloads go to the Unlinked folder'), h('div', { class: 'grow' }),
        sel ? btn(`Link to "${sel.name.length > 30 ? sel.name.slice(0, 29) + '…' : sel.name}"`, { icon: 'link', cls: 'sm', onclick: () => this.setBind(sel.id) }) : null,
        btn('Link to…', { cls: 'sm', onclick: (e) => this.chooseBind(e) }));
    }
  }

  chooseBind(e) {
    const r = e.target.getBoundingClientRect();
    const list = [...state.items.values()].filter((s) => s.status !== 'done')
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || b.addedAt - a.addedAt).slice(0, 40);
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
    this.renderSave();
  }

  // ---------- reverse search in a new linked tab ----------
  searchIn({ engine, path, itemId }) {
    this.open('about:blank', { itemId, active: true, upload: { engine, path } });
  }

  // ---------- address bar ----------
  wv() { return this.active && this.active.wv; }

  go(dir) {
    const wv = this.wv();
    if (!wv || !this.active.wcId) return;
    try {
      if (dir === 'back' && wv.canGoBack()) wv.goBack();
      else if (dir === 'forward' && wv.canGoForward()) wv.goForward();
      else if (dir === 'reload') wv.reload();
    } catch (_) { /* not ready */ }
  }

  navigate(text) {
    let url = text.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url) || /^localhost(:\d+)?/.test(url)) url = 'https://' + url;
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
    if (!this.active) this.open(url, { active: true });
    else { this.active.url = url; if (this.wv() && this.active.wcId) this.wv().loadURL(url).catch(() => {}); }
    if (this.wv()) this.wv().focus();
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

  renderDownloads() {
    const active = [...state.downloads.values()].filter((d) => d.state === 'progress');
    this.dlEl.classList.toggle('hidden', !active.length);
    clear(this.dlEl);
    if (active.length) this.dlEl.append(icon('download'), `${active.length} downloading`);
  }

  // Keyboard / mouse shortcuts (from the app window or forwarded from web pages).
  shortcut(k) {
    if (k === 'fullscreen') { emit('fullscreen'); return; }
    if (!this.visible) return;
    if (k === 'newtab') { this.open(state.settings.homepage, { active: true, itemId: this.boundItemForNew() }); setTimeout(() => this.addrInput.focus(), 50); }
    else if (k === 'close') { if (this.active) this.close(this.active); else emit('browser-closed'); }
    else if (k === 'closeall') this.closeAll();
    else if (k === 'reopen') this.reopen();
    else if (k === 'address') { this.addrInput.focus(); this.addrInput.select(); }
    else if (k === 'history') this.toggleHistory();
    else if (k === 'next' || k === 'prev') {
      if (this.tabs.length > 1) { const i = this.tabs.indexOf(this.active); this.activate(this.tabs[(i + (k === 'prev' ? -1 : 1) + this.tabs.length) % this.tabs.length]); }
    } else if (/^tab[1-9]$/.test(k)) {
      const n = +k.slice(3);
      const t = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (t) this.activate(t);
    } else if (k === 'reload') this.go('reload');
    else if (k === 'back') this.go('back');
    else if (k === 'forward') this.go('forward');
  }

  // Shortcuts pressed while the app itself (not a web page) has focus. They work whenever the
  // browser is showing — small, expanded or in the Browser tab.
  key(e) {
    if (!this.visible) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let cmd = null;
    if (ctrl && e.shiftKey && k === 'w') cmd = 'closeall';
    else if (ctrl && e.shiftKey && k === 't') cmd = 'reopen';
    else if (ctrl && k === 't') cmd = 'newtab';
    else if (ctrl && k === 'w') cmd = 'close';
    else if (ctrl && k === 'l') cmd = 'address';
    else if (ctrl && k === 'h') cmd = 'history';
    else if (ctrl && k === 'r') cmd = 'reload';
    else if (ctrl && e.key === 'Tab') cmd = e.shiftKey ? 'prev' : 'next';
    else if (ctrl && e.key === 'PageDown') cmd = 'next';
    else if (ctrl && e.key === 'PageUp') cmd = 'prev';
    else if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) cmd = 'tab' + e.key;
    else if (e.key === 'F5') cmd = 'reload';
    else if (e.altKey && e.key === 'ArrowLeft') cmd = 'back';
    else if (e.altKey && e.key === 'ArrowRight') cmd = 'forward';
    if (cmd) { e.preventDefault(); e.stopPropagation(); this.shortcut(cmd); }
  }
}

// The Browser tab is just a placeholder the shared browser is shown over.
export class BrowserView {
  constructor(root) {
    this.slot = h('div', { style: { flex: '1', minHeight: '0' } });
    root.appendChild(this.slot);
  }
}
