'use strict';
// In-app browser: tabs (webviews) bound to looked-up files, downloads routing, history,
// ad blocking (built-in or uBO Lite), dark mode, autofill, extensions and the Chrome Web Store.
const { app, session, net, Menu, clipboard, ipcMain, BrowserWindow, webContents: WC } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { JsonStore } = require('./store');
const fo = require('./fileops');
const { multipart } = require('./lookup/multipart');

const PARTITION = 'persist:browse';
const EXT_ISDCAC = 'edibdbjcniadpccecjdfdjjppcpchdlm'; // I still don't care about cookies
const EXT_UBOL = 'ddkjiahejlhfcafbddmgiahcphecmpfh'; // uBlock Origin Lite

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/avif': '.avif', 'image/bmp': '.bmp', 'image/jxl': '.jxl',
};

class BrowserManager {
  constructor({ paths, settings, lib, passwords, emit, log, getWindow, prepImage }) {
    this.paths = paths;
    this.settings = settings;
    this.lib = lib;
    this.passwords = passwords;
    this.emit = emit;
    this.log = log;
    this.getWindow = getWindow;
    this.prepImage = prepImage;
    this.bindings = new Map(); // webContents id -> item id (or null)
    this.pendingTabs = new Map(); // request id -> resolve(webContents)
    this.forcedTargets = new Map(); // url -> { itemId }
    this.blocker = null;
    this.history = new JsonStore(path.join(paths.data, 'history.json'), { entries: [] });
    this.darkReaderCode = null;
  }

  get ses() { return session.fromPartition(PARTITION); }
  extApi() { const s = this.ses; return s.extensions || s; }

  async init() {
    const s = this.ses;
    // Present as plain Chrome so sites don't treat the app as an unknown browser.
    const ua = s.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\simage-seek\/\S+/i, '').replace(/\sImage Seek\/\S+/i, '');
    s.setUserAgent(ua);
    app.userAgentFallback = ua;

    // Page preload: dark mode + autofill (runs in every frame of the browse session).
    s.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '..', 'preload', 'page.js') });

    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    this.extensions = new ElectronChromeExtensions({
      session: s,
      createTab: async (details) => {
        const wc = await this.requestTab(details.url || 'about:blank', details.active !== false, null);
        return [wc, this.getWindow()];
      },
      selectTab: (wc) => this.emit('browser:select', { wcId: wc.id }),
      removeTab: (wc) => this.emit('browser:close', { wcId: wc.id }),
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        await this.requestTab(url || 'about:blank', true, null);
        return this.getWindow();
      },
    });
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);

    try {
      const { installChromeWebStore } = require('electron-chrome-web-store');
      await installChromeWebStore({ session: s, extensionsPath: this.paths.extensions, autoUpdate: true, loadExtensions: true });
    } catch (e) {
      this.log('Chrome Web Store support failed to start: ' + e.message, 'warn');
    }

    this.setupDownloads();
    this.setupIpc();
    this.firstRunExtensions().catch((e) => this.log('Extension install failed: ' + e.message, 'warn'));
    this.applyAdblock().catch((e) => this.log('Ad blocker failed to start: ' + e.message, 'warn'));
  }

  async firstRunExtensions() {
    const st = this.settings.get();
    if (st.extensionsSeeded) return;
    const have = this.extApi().getAllExtensions().map((e) => e.id);
    if (!have.includes(EXT_ISDCAC)) {
      const { installExtension } = require('electron-chrome-web-store');
      await installExtension(EXT_ISDCAC, { session: this.ses, extensionsPath: this.paths.extensions });
      this.log('Installed "I still don\'t care about cookies"', 'info');
    }
    this.settings.set({ extensionsSeeded: true });
    this.emit('browser:extensions', this.listExtensions());
  }

  // ---------- ad blocking ----------
  async applyAdblock() {
    const mode = this.settings.get().adblock;
    const s = this.ses;
    const api = this.extApi();
    if (mode === 'builtin') {
      if (!this.blocker) {
        const { ElectronBlocker } = require('@ghostery/adblocker-electron');
        const cacheFile = path.join(this.paths.cache, 'adblock-engine.bin');
        this.blocker = await ElectronBlocker.fromPrebuiltFull((url, opts) => net.fetch(url, opts), {
          path: cacheFile, read: fsp.readFile, write: fsp.writeFile,
        });
      }
      if (!this.blocker.isBlockingEnabled(s)) this.blocker.enableBlockingInSession(s);
      if (api.getExtension(EXT_UBOL)) api.removeExtension(EXT_UBOL);
    } else {
      if (this.blocker && this.blocker.isBlockingEnabled(s)) this.blocker.disableBlockingInSession(s);
      if (mode === 'ubol') {
        if (!api.getExtension(EXT_UBOL)) {
          const dir = path.join(this.paths.extensions, EXT_UBOL);
          if (fs.existsSync(dir)) {
            const { loadAllExtensions } = require('electron-chrome-web-store');
            await loadAllExtensions(s, this.paths.extensions);
          }
          if (!api.getExtension(EXT_UBOL)) {
            const { installExtension } = require('electron-chrome-web-store');
            await installExtension(EXT_UBOL, { session: s, extensionsPath: this.paths.extensions });
          }
        }
      } else if (api.getExtension(EXT_UBOL)) {
        api.removeExtension(EXT_UBOL);
      }
    }
    this.emit('browser:extensions', this.listExtensions());
  }

  listExtensions() {
    return this.extApi().getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version }));
  }

  async uninstallExtension(id) {
    const { uninstallExtension } = require('electron-chrome-web-store');
    await uninstallExtension(id, { session: this.ses, extensionsPath: this.paths.extensions });
    if (id === EXT_UBOL && this.settings.get().adblock === 'ubol') this.settings.set({ adblock: 'builtin' });
    this.emit('browser:extensions', this.listExtensions());
  }

  async installById(id) {
    const { installExtension } = require('electron-chrome-web-store');
    await installExtension(id, { session: this.ses, extensionsPath: this.paths.extensions });
    this.emit('browser:extensions', this.listExtensions());
  }

  // ---------- tabs ----------
  requestTab(url, active, itemId) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      this.pendingTabs.set(reqId, resolve);
      this.emit('browser:open', { reqId, url, active, itemId });
    });
  }

  attach(wc) {
    if (wc.session !== this.ses) return;
    const win = this.getWindow();
    try { this.extensions.addTab(wc, win); } catch (_) { /* already added */ }

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url && url !== 'about:blank') {
        this.emit('browser:open', { url, active: disposition !== 'background-tab', itemId: this.bindings.get(wc.id) ?? null, openerId: wc.id });
      }
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, params) => this.contextMenu(wc, params));

    // Forward app shortcuts pressed while the page has focus.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const key = (input.key || '').toLowerCase();
      let k = null;
      if (ctrl && input.shift && key === 'w') k = 'closeall';
      else if (ctrl && input.shift && key === 't') k = 'reopen';
      else if (ctrl && key === 't') k = 'newtab';
      else if (ctrl && key === 'w') k = 'close';
      else if (ctrl && key === 'l') k = 'address';
      else if (ctrl && key === 'h') k = 'history';
      else if (ctrl && key === 'r') k = 'reload';
      else if (ctrl && key === 'tab') k = input.shift ? 'prev' : 'next';
      else if (ctrl && key === 'pagedown') k = 'next';
      else if (ctrl && key === 'pageup') k = 'prev';
      else if (ctrl && !input.shift && /^[1-9]$/.test(key)) k = 'tab' + key;
      else if (key === 'f5') k = 'reload';
      else if (key === 'f11') k = 'fullscreen';
      else if (input.alt && key === 'arrowleft') k = 'back';
      else if (input.alt && key === 'arrowright') k = 'forward';
      if (k) { e.preventDefault(); this.emit('browser:shortcut', k); }
    });

    const record = (url) => {
      if (!/^https?:/.test(url)) return;
      const list = this.history.data.entries;
      const last = list[list.length - 1];
      if (last && last.url === url && Date.now() - last.time < 30000) return;
      list.push({ url, title: wc.getTitle() || url, time: Date.now() });
      if (list.length > 25000) list.splice(0, list.length - 25000);
      this.history.save();
    };
    wc.on('did-navigate', (_e, url) => record(url));
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) record(url); });
    wc.on('page-title-updated', (_e, title) => {
      const list = this.history.data.entries;
      const url = wc.getURL();
      for (let i = list.length - 1; i >= Math.max(0, list.length - 5); i--) {
        if (list[i].url === url) { list[i].title = title; this.history.save(); break; }
      }
    });
    // Per-site light / dark: Dark Reader runs from the page preload; this makes sites with
    // their own dark theme follow the same choice (they'd otherwise follow Windows' theme).
    this.attachScheme(wc);
    if (process.env.IMAGESEEK_DEBUG) wc.on('console-message', (e) => console.log('[page]', e.message));
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) this.applyScheme(wc, d.url); });
    wc.on('destroyed', () => this.bindings.delete(wc.id));
  }

  attachScheme(wc) {
    try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (_) { /* devtools open */ }
  }

  applyScheme(wc, url) {
    if (!/^https?:/.test(url || '')) return;
    const dark = this.themeFor(url) === 'dark';
    try {
      if (!wc.debugger.isAttached()) this.attachScheme(wc);
      wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  siteKey(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  // 'dark' or 'light' for a page: the site's own setting, else its parent domain's, else the default.
  themeFor(url) {
    const s = this.settings.get();
    const host = this.siteKey(url);
    const map = s.siteThemes || {};
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const h = parts.slice(i).join('.');
      if (map[h]) return map[h];
    }
    return s.darkMode ? 'dark' : 'light';
  }

  setSiteTheme(url, theme) {
    const host = this.siteKey(url);
    if (!host) return this.settings.get();
    const map = { ...(this.settings.get().siteThemes || {}) };
    // drop parent-domain entries that would override this choice
    map[host] = theme;
    return this.settings.set({ siteThemes: map });
  }

  // ---------- context menu ----------
  // Right-click menu. The underlined letter (& in a label) is the key that picks that item
  // while the menu is open, e.g. V = Save image as…
  contextMenu(wc, params) {
    const itemId = this.bindings.get(wc.id) || null;
    const it = itemId ? this.lib.item(itemId) : null;
    const esc = (t) => String(t).replace(/&/g, '&&');
    const tmpl = [];
    const src = params.mediaType === 'image' ? params.srcURL : null;
    if (src) {
      tmpl.push({ label: it ? `&Save image to "${esc(trim(it.name, 32))}"` : '&Save image (unlinked)', click: () => this.saveUrl(wc, src, itemId) });
      if (originalCandidates(src).length) tmpl.push({ label: it ? 'Save &original size to the linked file' : 'Save &original size (unlinked)', click: () => this.saveOriginal(wc, src, itemId) });
      if (it) tmpl.push({ label: 'Save image as &unlinked', click: () => this.saveUrl(wc, src, null) });
      tmpl.push({ label: 'Sa&ve image as… (choose a folder)', click: () => this.saveAs(wc, src) });
      tmpl.push({ type: 'separator' });
      tmpl.push({ label: 'Open image in new &tab', click: () => this.emit('browser:open', { url: src, active: true, itemId }) });
      tmpl.push({ label: 'Search this image with &Google Lens', click: () => this.emit('browser:open', { url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(src), active: true, itemId }) });
      tmpl.push({ label: '&Copy image', click: () => wc.copyImageAt(params.x, params.y) });
      tmpl.push({ label: 'Copy image &address', click: () => clipboard.writeText(src) });
      tmpl.push({ type: 'separator' });
    }
    if (params.linkURL) {
      tmpl.push({ label: 'Open &link in new tab', click: () => this.emit('browser:open', { url: params.linkURL, active: false, itemId }) });
      tmpl.push({ label: 'Copy link addr&ess', click: () => clipboard.writeText(params.linkURL) });
      if (/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i.test(params.linkURL)) {
        tmpl.push({ label: it ? '&Download linked image to the linked file' : '&Download linked image (unlinked)', click: () => this.saveUrl(wc, params.linkURL, itemId) });
      }
      tmpl.push({ label: 'Save lin&k as… (choose a folder)', click: () => this.saveAs(wc, params.linkURL) });
      tmpl.push({ type: 'separator' });
    }
    if (params.isEditable) {
      tmpl.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (params.selectionText) {
      tmpl.push({ role: 'copy' }, { type: 'separator' });
    }
    tmpl.push(
      { label: '&Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: '&Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: '&Reload', click: () => wc.reload() },
    );
    try {
      const extItems = this.extensions.getContextMenuItems(wc, params);
      if (extItems.length) tmpl.push({ type: 'separator' }, ...extItems);
    } catch (_) { /* ignore */ }
    tmpl.push({ type: 'separator' }, { label: '&Inspect element', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(cleanSeparators(tmpl)).popup({ window: this.getWindow() });
  }

  saveUrl(wc, url, itemId) {
    this.forcedTargets.set(url, { itemId });
    wc.downloadURL(url);
  }

  // Normal "Save as" dialog: saved wherever you choose and not tracked by the app.
  saveAs(wc, url) {
    this.forcedTargets.set(url, { saveAs: true });
    wc.downloadURL(url);
  }

  // Toolbar buttons on an image page: mode = 'linked' | 'unlinked' | 'saveas'
  saveCurrent(wcId, mode) {
    const wc = WC.fromId(wcId);
    if (!wc) throw new Error('Tab not found');
    const url = wc.getURL();
    if (mode === 'saveas') return this.saveAs(wc, url);
    const itemId = mode === 'linked' ? (this.bindings.get(wc.id) || null) : null;
    if (mode === 'linked' && !itemId) throw new Error('This tab isn\'t linked to a file');
    const orig = originalCandidates(url);
    if (orig.length) return this.saveOriginal(wc, url, itemId);
    return this.saveUrl(wc, url, itemId);
  }

  async saveOriginal(wc, src, itemId) {
    const cands = originalCandidates(src);
    const referer = wc.getURL();
    for (const c of cands) {
      try {
        const res = await this.ses.fetch(c, { method: 'HEAD', headers: { Referer: referer } });
        if (res.ok) { this.saveUrl(wc, c, itemId); return; }
      } catch (_) { /* try next */ }
    }
    this.log('Couldn\'t find an original-size version; saving the image as shown.', 'warn');
    this.saveUrl(wc, src, itemId);
  }

  // ---------- downloads ----------
  setupDownloads() {
    this.ses.on('will-download', (_e, item, wc) => {
      const url = item.getURL();
      let itemId = wc ? (this.bindings.get(wc.id) ?? null) : null;
      const forced = this.forcedTargets.get(url);
      if (forced) this.forcedTargets.delete(url);
      if (forced && forced.saveAs) {
        let name = fo.sanitizeName(decodeURIComponentSafe(item.getFilename() || 'image'));
        if (!path.extname(name) && MIME_EXT[item.getMimeType()]) name += MIME_EXT[item.getMimeType()];
        const dir = this.settings.get().lastSaveAsDir || app.getPath('pictures');
        item.setSaveDialogOptions({ title: 'Save image', defaultPath: path.join(dir, name) });
        item.once('done', (_ev, state) => {
          if (state === 'completed' && item.getSavePath()) {
            this.settings.set({ lastSaveAsDir: path.dirname(item.getSavePath()) });
            this.log(`Saved ${path.basename(item.getSavePath())} to ${path.dirname(item.getSavePath())}`);
          }
        });
        return; // Electron shows the Save dialog itself
      }
      if (forced) itemId = forced.itemId;
      const it = itemId ? this.lib.item(itemId) : null;
      if (!it) itemId = null;
      const dir = it ? this.lib.itemFolder(it) : this.lib.unlinkedFolder();
      fs.mkdirSync(dir, { recursive: true });
      let name = fo.sanitizeName(decodeURIComponentSafe(item.getFilename() || 'download'));
      if (!path.extname(name) && MIME_EXT[item.getMimeType()]) name += MIME_EXT[item.getMimeType()];
      const savePath = fo.uniquePathSync(dir, name);
      item.setSavePath(savePath);
      const dl = this.lib.addDownload({
        itemId, path: savePath, name: path.basename(savePath), url, pageUrl: wc ? wc.getURL() : null,
        total: item.getTotalBytes(), mime: item.getMimeType(),
      });
      this.log(`Downloading ${path.basename(savePath)}${it ? ' → linked to ' + it.name : ' → unlinked'}`, 'info');
      item.on('updated', () => {
        this.emit('dl:progress', { id: dl.id, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
      item.once('done', (_ev, state) => {
        this.lib.finishDownload(dl.id, state, item.getSavePath());
        if (state !== 'completed') this.log(`Download ${state}: ${path.basename(savePath)}`, 'warn');
      });
    });
  }

  // ---------- reverse image search in a tab ----------
  async uploadInTab(wcId, engine, filePath) {
    const wc = WC.fromId(wcId);
    if (!wc) throw new Error('Tab not found');
    const image = await this.prepImage(filePath, this.settings.get());
    let url, field;
    if (engine === 'google') {
      url = `https://lens.google.com/v3/upload?ep=cntpubb&hl=en&re=df&s=4&st=${Date.now()}&vpw=1600&vph=900`;
      field = 'encoded_image';
    } else if (engine === 'yandex') {
      url = 'https://yandex.com/images/search?rpt=imageview&cbir_page=sites';
      field = 'upfile';
    } else if (engine === 'ascii2d') {
      url = 'https://ascii2d.net/search/file';
      field = 'file';
    } else if (engine === 'saucenao') {
      url = 'https://saucenao.com/search.php';
      field = 'file';
    } else if (engine === 'iqdb') {
      url = 'https://iqdb.org/';
      field = 'file';
    } else throw new Error('Unknown engine');
    const fields = engine === 'ascii2d' ? [{ name: 'utf8', value: '✓' }] : [];
    fields.push({ name: field, filename: image.filename, contentType: image.mime, data: image.buffer });
    const form = multipart(fields);
    await wc.loadURL(url, {
      postData: [{ type: 'rawData', bytes: form.body }],
      extraHeaders: `Content-Type: ${form.contentType}`,
    }).catch(() => {}); // loadURL rejects on redirects that abort; the page still loads
  }

  // ---------- page preload support ----------
  pageConfig(url) {
    const s = this.settings.get();
    const dark = /^https?:/.test(url) && this.themeFor(url) === 'dark';
    return { dark, autofill: !!s.autofill && this.passwords.forUrl(url).length > 0 };
  }

  getDarkReader() {
    if (!this.darkReaderCode) this.darkReaderCode = fs.readFileSync(require.resolve('darkreader/darkreader.js'), 'utf8');
    return this.darkReaderCode;
  }

  setupIpc() {
    ipcMain.on('page:config', (e, url) => { e.returnValue = this.pageConfig(url); });
    ipcMain.on('page:darkreader', (e) => { e.returnValue = this.getDarkReader(); });
    ipcMain.handle('page:logins', (e, url) => {
      if (e.sender.session !== this.ses || !this.settings.get().autofill) return [];
      return this.passwords.forUrl(url).map((l) => ({ username: l.username, password: l.password }));
    });
  }

  // ---------- hidden page used by lookups that need a real browser (ascii2d) ----------
  hiddenWindow() {
    if (this.hidden && !this.hidden.isDestroyed()) return this.hidden;
    this.hidden = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: false },
    });
    this.hidden.webContents.setAudioMuted(true);
    this.hidden.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.hidden;
  }

  // Loads a page (optionally POSTing a form) and waits until done(url, html) is true.
  // Returns { url, html, blocked } — blocked when a Cloudflare check never cleared.
  async renderPage({ url, postData, contentType, referer, done, timeout = 40000 }) {
    const w = this.hiddenWindow();
    const wc = w.webContents;
    const opts = {};
    if (postData) {
      opts.postData = [{ type: 'rawData', bytes: postData }];
      opts.extraHeaders = `Content-Type: ${contentType}\n`;
    }
    if (referer) opts.httpReferrer = referer;
    wc.loadURL(url, opts).catch(() => {}); // rejects on redirects; we poll below
    const start = Date.now();
    let html = '', cur = '';
    let sawChallenge = false;
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 600));
      if (w.isDestroyed()) break;
      cur = wc.getURL();
      if (wc.isLoading()) continue;
      try { html = await wc.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""', true); } catch (_) { html = ''; }
      if (/cf-chl|challenge-platform|Just a moment|cf_chl_opt/i.test(html)) { sawChallenge = true; continue; }
      if (done(cur, html)) return { url: cur, html, blocked: false };
    }
    return { url: cur, html, blocked: sawChallenge };
  }

  // ---------- history ----------
  searchHistory(q, limit = 300) {
    const list = this.history.data.entries;
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      const h = list[i];
      if (!needle || h.url.toLowerCase().includes(needle) || (h.title || '').toLowerCase().includes(needle)) out.push(h);
    }
    return out;
  }

  suggestions(q) {
    const needle = String(q || '').toLowerCase();
    if (!needle) return [];
    const seen = new Set();
    const out = [];
    const list = this.history.data.entries;
    for (let i = list.length - 1; i >= 0 && out.length < 8; i--) {
      const h = list[i];
      if (seen.has(h.url)) continue;
      if (h.url.toLowerCase().includes(needle) || (h.title || '').toLowerCase().includes(needle)) { seen.add(h.url); out.push(h); }
    }
    return out;
  }

  clearHistory() { this.history.reset(); }

  async clearBrowsingData() {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
  }
}

// ---------- helpers ----------
function trim(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

function cleanSeparators(t) {
  const out = [];
  for (const i of t) {
    if (i.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(i);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

// Rewrites known "preview size" image URLs to their full-size originals.
function originalCandidates(src) {
  let u;
  try { u = new URL(src); } catch { return []; }
  const out = [];
  if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
    const m = u.pathname.match(/^\/media\/([^.:]+)(?:\.(\w+))?/);
    if (m) {
      const fmt = u.searchParams.get('format') || m[2] || 'jpg';
      if (u.searchParams.get('name') !== 'orig') out.push(`https://pbs.twimg.com/media/${m[1]}?format=${fmt}&name=orig`);
    }
  } else if (u.hostname === 'i.pximg.net' && /img-master|custom-thumb|\/c\//.test(u.pathname)) {
    const m = u.pathname.match(/\/img\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+_p\d+)/);
    if (m) for (const ext of ['png', 'jpg', 'gif']) out.push(`https://i.pximg.net/img-original/img/${m[1]}/${m[2]}.${ext}`);
  } else if (/(^|\.)donmai\.us$/.test(u.hostname) && !u.pathname.startsWith('/original/')) {
    const m = u.pathname.match(/\/([0-9a-f]{2})\/([0-9a-f]{2})\/(?:sample-)?([0-9a-f]{32})\./);
    if (m) for (const ext of ['png', 'jpg', 'webp', 'gif']) out.push(`https://${u.hostname}/original/${m[1]}/${m[2]}/${m[3]}.${ext}`);
  } else if (/(^|\.)yande\.re$/.test(u.hostname) && /\/(sample|jpeg)\//.test(u.pathname)) {
    const m = u.pathname.match(/\/(?:sample|jpeg)\/([0-9a-f]{32})\//);
    if (m) for (const ext of ['png', 'jpg']) out.push(`https://files.yande.re/image/${m[1]}/yande.re.${ext}`);
  }
  return out;
}

module.exports = { BrowserManager, PARTITION, originalCandidates, EXT_UBOL, EXT_ISDCAC };
