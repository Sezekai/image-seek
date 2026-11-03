'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage, session, webContents: WC } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { resolvePaths } = require('./paths');
const { Settings } = require('./settings');
const { Library } = require('./library');
const { LookupQueue } = require('./lookup/queue');
const { BrowserManager, PARTITION } = require('./browser');
const { PasswordStore } = require('./passwords');
const firefox = require('./firefox');
const { findCollectionSorterKey } = require('./keyimport');
const { getImageInfo } = require('./imageinfo');
const fo = require('./fileops');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const paths = resolvePaths(app);
// Keep Chromium's profile (cookies, cache, extensions state) in the Data folder, not AppData.
app.setPath('userData', paths.browser);
app.setPath('sessionData', paths.browser);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'isf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

let win = null;
let settings, lib, queue, browser, passwords;
const logLines = [];
const logFile = path.join(paths.data, 'image-seek.log');

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(msg, level = 'info') {
  const line = { time: Date.now(), level, msg: String(msg) };
  logLines.push(line);
  if (logLines.length > 800) logLines.shift();
  emit('log', line);
  try {
    const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (st && st.size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, `${new Date(line.time).toISOString()} [${level}] ${line.msg}\n`);
  } catch (_) { /* ignore */ }
}

// ---------- renderer helper (image decoding / resizing / hashing) ----------
const helperWaits = new Map();
function askRenderer(kind, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Window closed'));
    const id = crypto.randomBytes(6).toString('hex');
    const t = setTimeout(() => { helperWaits.delete(id); reject(new Error('Timed out')); }, timeout);
    helperWaits.set(id, { resolve, reject, t });
    win.webContents.send('helper:request', { id, kind, args });
  });
}
ipcMain.on('helper:result', (_e, { id, ok, result, error }) => {
  const w = helperWaits.get(id);
  if (!w) return;
  clearTimeout(w.t);
  helperWaits.delete(id);
  ok ? w.resolve(result) : w.reject(new Error(error || 'failed'));
});

// Returns an upload-sized version of the image: original bytes when already small, else a resized JPEG.
async function prepImage(filePath, s) {
  const info = await getImageInfo(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const simple = ['.jpg', '.jpeg', '.jfif', '.png'].includes(ext);
  const maxSide = s.uploadMaxSide || 3000;
  const maxBytes = s.uploadMaxBytes || 4 * 1024 * 1024;
  if (simple && info.size <= maxBytes && Math.max(info.width, info.height) <= maxSide && info.width > 0) {
    return { buffer: await fsp.readFile(filePath), mime: ext === '.png' ? 'image/png' : 'image/jpeg', filename: path.basename(filePath) };
  }
  try {
    const r = await askRenderer('prep', { url: fileUrl(filePath), maxSide, quality: 0.92 });
    return { buffer: Buffer.from(r.data), mime: 'image/jpeg', filename: path.parse(filePath).name + '.jpg' };
  } catch (e) {
    if (info.size > 20 * 1024 * 1024) throw new Error('Image too large to upload and could not be resized');
    const mime = { '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' }[ext] || 'application/octet-stream';
    return { buffer: await fsp.readFile(filePath), mime, filename: path.basename(filePath) };
  }
}

function fileUrl(p) { return 'isf://f/' + encodeURIComponent(p); }

// ---------- protocols ----------
function registerProtocols() {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const fontDir = path.dirname(require.resolve('@fontsource/inter/package.json'));
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let base = rendererDir;
    if (u.host === 'fonts') base = path.join(fontDir, 'files');
    if (!rel) rel = 'index.html';
    const full = path.normalize(path.join(base, rel));
    if (!full.startsWith(base)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(full).toString());
  });
  protocol.handle('isf', async (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    if (u.host === 'thumb') return thumbResponse(p, +(u.searchParams.get('s') || 320));
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
  });
}

const thumbInflight = new Map();
async function thumbResponse(p, size) {
  try {
    const st = await fsp.stat(p);
    const key = crypto.createHash('sha1').update(p + '|' + st.mtimeMs + '|' + st.size + '|' + size).digest('hex');
    const file = path.join(paths.thumbs, key.slice(0, 2), key + '.jpg');
    if (!fs.existsSync(file)) {
      if (!thumbInflight.has(file)) {
        thumbInflight.set(file, (async () => {
          const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
          if (img.isEmpty()) throw new Error('empty');
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(file, img.toJPEG(86));
        })().finally(() => thumbInflight.delete(file)));
      }
      await thumbInflight.get(file);
    }
    return net.fetch(pathToFileURL(file).toString());
  } catch (_) {
    // Windows couldn't make a thumbnail (e.g. no codec) — serve the image itself.
    try { return await net.fetch(pathToFileURL(p).toString()); } catch { return new Response('', { status: 404 }); }
  }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 960, minWidth: 980, minHeight: 620,
    backgroundColor: '#0e0f11',
    title: 'Image Seek',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f11', symbolColor: '#c9ccd1', height: 34 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'app.js'),
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => { win.show(); win.maximize(); });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) emit('browser:open', { url, active: true, itemId: null });
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (_e, wp, params) => {
    delete wp.preload;
    wp.nodeIntegration = false;
    wp.contextIsolation = true;
    wp.sandbox = true;
    params.partition = PARTITION;
  });
  win.webContents.on('did-attach-webview', (_e, wc) => { if (browser) browser.attach(wc); });
  win.loadURL('app://ui/index.html');
  win.on('closed', () => { win = null; });
  // Development hooks (used for automated checks): print renderer console, take screenshots.
  if (process.env.IMAGESEEK_DEBUG) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason));
  }
  if (process.env.IMAGESEEK_SHOTS) {
    win.webContents.once('did-finish-load', async () => {
      const steps = JSON.parse(process.env.IMAGESEEK_SHOTS);
      for (const st of steps) {
        await new Promise((r) => setTimeout(r, st.wait || 2500));
        if (st.js) { try { await win.webContents.executeJavaScript(st.js); } catch (e) { console.log('[shot js error]', e.message); } }
        await new Promise((r) => setTimeout(r, 900));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(st.out, img.toPNG());
        console.log('[shot]', st.out);
      }
      app.quit();
    });
  }
}


app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  try { lib.store.flush(); settings.store.flush(); browser.history.flush(); } catch (_) { /* ignore */ }
});

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) {
      log(`${name}: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  });
}

function setupIpc() {
  handle('app:init', async () => ({
    paths: { root: paths.root, data: paths.data },
    version: app.getVersion(),
    settings: settings.get(),
    snapshot: lib.snapshot(),
    queue: queue.status(),
    extensions: browser.listExtensions(),
    log: logLines.slice(-300),
    platform: process.platform,
  }));

  handle('settings:set', async (patch) => {
    const before = { ...settings.get() };
    const s = settings.set(patch);
    if ('adblock' in patch && patch.adblock !== before.adblock) await browser.applyAdblock();
    if ('queuePaused' in patch && !patch.queuePaused) queue.kick();
    if ('engines' in patch || 'saucenaoKey' in patch) queue.kick();
    if ('minSimilarity' in patch) {
      const { buildGuess } = require('./lookup/guess');
      for (const it of Object.values(lib.d.items)) {
        if (!it.results || !it.results.length) continue;
        const g = buildGuess(it.results, s.minSimilarity, it);
        it.guess = g.guess; it.bigger = g.bigger;
      }
      lib.changed([]);
    }
    queue.pushStatus();
    return s;
  });

  handle('dialog:folder', async (title, defaultPath) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose folder', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title, filters) => {
    const r = await dialog.showOpenDialog(win, { title, filters, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:confirm', async (message, detail, buttons) => {
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || []).length ? buttons.length - 1 : 1, noLink: true });
    return r.response;
  });

  handle('batch:add', async (folder, mode, recursive) => {
    const r = await lib.addBatch(folder, mode, recursive);
    log(`Added ${r.added} file(s) from ${folder} for ${mode === 'upgrade' ? 'higher resolution' : 'identifying'}${r.skipped ? ` (${r.skipped} already in the list)` : ''}`);
    queue.kick();
    return { added: r.added, skipped: r.skipped, batchId: r.batch.id };
  });
  handle('batch:remove', async (id) => lib.removeBatch(id));

  handle('lib:snapshot', async () => lib.snapshot());
  handle('lib:light', async () => {
    const snap = { batches: lib.d.batches.map((b) => ({ ...b, counts: lib.batchCounts(b.id) })), downloads: Object.values(lib.d.downloads), sortLog: lib.d.sortLog.slice(-500) };
    return snap;
  });
  handle('item:get', async (id) => lib.item(id));
  handle('item:summaries', async (ids) => ids.map((id) => lib.item(id)).filter(Boolean).map((it) => lib.summary(it)));
  handle('item:mode', async (id, mode) => lib.setMode(id, mode));
  handle('item:requeue', async (id, engines) => { lib.requeue(id, engines); queue.kick(); });
  handle('item:recycle', async (id) => lib.recycleItem(id));
  handle('item:forget', async (id) => lib.forgetItem(id));
  handle('item:folder', async (id) => { const it = lib.item(id); return it ? lib.itemFolder(it) : null; });
  handle('item:pending', async (id) => { const it = lib.item(id); return it ? lib.pendingKept(it) : []; });
  handle('items:clearDone', async () => lib.clearDone());
  handle('items:requeueErrors', async () => {
    for (const it of Object.values(lib.d.items)) {
      if (it.status === 'error') lib.requeue(it.id, Object.entries(it.engines || {}).filter(([, v]) => v === 'error' || v === 'blocked').map(([k]) => k));
    }
    queue.kick();
  });

  handle('queue:status', async () => queue.status());

  handle('sort:file', async (target, folder, flags) => {
    const entry = await lib.sortFile(target, folder, flags);
    log(`Sorted ${path.basename(entry.from)} → ${folder}${flags && flags.nsfw ? (flags.very ? '\\NSFW\\Very' : '\\NSFW') : ''}`);
    return entry;
  });
  handle('sort:undo', async (logId) => { await lib.undoSort(logId); log('Undid a sort'); });
  handle('sort:scanRoot', async () => {
    const root = settings.get().sortRoot;
    const out = [];
    try {
      for (const e of await fsp.readdir(root, { withFileTypes: true })) {
        if (e.isDirectory() && !/^(NSFW|Very)$/i.test(e.name)) out.push(e.name);
      }
    } catch (_) { /* missing */ }
    return out.sort((a, b) => a.localeCompare(b));
  });
  handle('sort:createFolder', async (rel) => {
    await fsp.mkdir(path.join(settings.get().sortRoot, ...rel.split(/[\\/]/).filter(Boolean)), { recursive: true });
  });

  handle('keep:apply', async (itemId, keepIds) => {
    const r = await lib.applyKeep(itemId, keepIds);
    log(`Kept ${keepIds.length}, sent ${r.recycled} to the Recycle Bin`);
    return r;
  });

  handle('dl:relink', async (id, itemId) => lib.relinkDownload(id, itemId));
  handle('dl:recycle', async (id) => lib.recycleDownload(id));
  handle('dl:update', async (id, patch) => lib.updateDownload(id, patch));

  // browser
  handle('browser:bind', async (wcId, itemId) => { browser.bindings.set(wcId, itemId || null); });
  handle('browser:tabReady', async (reqId, wcId) => {
    const resolve = browser.pendingTabs.get(reqId);
    if (resolve) { browser.pendingTabs.delete(reqId); resolve(WC.fromId(wcId)); }
  });
  handle('browser:select', async (wcId) => { const wc = WC.fromId(wcId); if (wc) browser.extensions.selectTab(wc); });
  handle('browser:upload', async (wcId, engine, filePath) => browser.uploadInTab(wcId, engine, filePath));
  handle('browser:history', async (q) => browser.searchHistory(q));
  handle('browser:suggest', async (q) => browser.suggestions(q));
  handle('browser:clearHistory', async () => browser.clearHistory());
  handle('browser:clearData', async () => browser.clearBrowsingData());
  handle('browser:extensions', async () => browser.listExtensions());
  handle('browser:extRemove', async (id) => browser.uninstallExtension(id));
  handle('browser:extInstall', async (id) => browser.installById(id));
  handle('browser:darkSite', async (host, enabled) => {
    const list = new Set(settings.get().darkModeExclude);
    enabled ? list.delete(host) : list.add(host);
    return settings.set({ darkModeExclude: [...list] });
  });

  ipcMain.on('drag:start', (e, filePath) => {
    let icon = null;
    try { icon = nativeImage.createFromPath(filePath); if (!icon.isEmpty()) icon = icon.resize({ width: 96 }); } catch (_) { icon = null; }
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'drag.png'));
    e.sender.startDrag({ file: filePath, icon });
  });

  // firefox + logins
  handle('firefox:profiles', async () => firefox.listProfiles());
  handle('firefox:cookies', async (profilePath) => {
    const r = await firefox.importCookies(profilePath, session.fromPartition(PARTITION), (done, total) => emit('import:progress', { done, total }));
    log(`Imported ${r.imported} Firefox cookie(s)${r.failed ? `, ${r.failed} skipped` : ''}`);
    return r;
  });
  handle('firefox:logins', async (profilePath, primaryPassword) => {
    const r = await firefox.readLogins(profilePath, primaryPassword);
    const m = passwords.merge(r.logins, 'firefox');
    log(`Imported Firefox logins: ${m.added} new, ${m.updated} updated${r.failed ? `, ${r.failed} unreadable` : ''}`);
    return { ...m, failed: r.failed };
  });
  handle('firefox:csv', async (file) => {
    const list = firefox.loginsFromCsv(await fsp.readFile(file, 'utf8'));
    const m = passwords.merge(list, 'firefox-csv');
    log(`Imported logins from CSV: ${m.added} new, ${m.updated} updated`);
    return m;
  });
  handle('pw:list', async () => passwords.summary());
  handle('pw:remove', async (origin, username) => passwords.remove(origin, username));
  handle('pw:clear', async () => passwords.clear());

  handle('key:import', async () => {
    const r = await findCollectionSorterKey();
    if (r.key) {
      settings.set({ saucenaoKey: r.key, saucenaoKeySource: 'Collection Sorter' });
      log('Imported SauceNAO key from Collection Sorter');
      queue.kick();
    }
    return { found: !!r.key, reason: r.reason || null, settings: settings.get() };
  });

  handle('fs:info', async (p) => getImageInfo(p));
  handle('fs:exists', async (p) => fo.exists(p));
  handle('shell:open', async (p) => shell.openPath(p));
  handle('shell:show', async (p) => shell.showItemInFolder(p));
  handle('shell:external', async (u) => { if (/^https?:/.test(u)) await shell.openExternal(u); });

  handle('reset', async (what) => {
    if (what === 'settings') settings.reset();
    if (what === 'library') lib.store.reset();
    if (what === 'history') browser.clearHistory();
    if (what === 'browser') await browser.clearBrowsingData();
    if (what === 'logins') passwords.clear();
    if (what === 'thumbs') await fsp.rm(paths.thumbs, { recursive: true, force: true }).then(() => fsp.mkdir(paths.thumbs, { recursive: true }));
    log(`Reset: ${what}`);
    emit('lib:changed', { ids: [] });
    return settings.get();
  });
}

// ---------- startup ----------
app.whenReady().then(async () => {
  registerProtocols();
  settings = new Settings(paths);
  lib = new Library(paths, settings, emit);
  passwords = new PasswordStore(paths);
  const fetchFn = (url, opts) => net.fetch(url, opts);
  browser = new BrowserManager({ paths, settings, lib, passwords, emit, log, getWindow: () => win, prepImage });
  queue = new LookupQueue({
    library: lib, settings, fetch: fetchFn,
    browserFetch: (url, opts) => session.fromPartition(PARTITION).fetch(url, opts),
    prepImage, log, emit,
  });
  setupIpc();
  createWindow();
  try { await browser.init(); } catch (e) { log('Browser setup problem: ' + e.message, 'error'); }

  // First run: pick up Collection Sorter's SauceNAO key automatically.
  if (!settings.get().saucenaoKey) {
    findCollectionSorterKey().then((r) => {
      if (r.key) {
        settings.set({ saucenaoKey: r.key, saucenaoKeySource: 'Collection Sorter' });
        log('Found your SauceNAO key in Collection Sorter\'s settings');
        emit('settings:changed', settings.get());
        queue.kick();
      } else if (!settings.get().firstRunDone) {
        log('SauceNAO key not found in Collection Sorter — add it in Settings → Lookups', 'warn');
      }
      settings.set({ firstRunDone: true });
    }).catch(() => {});
  }
  win.webContents.once('did-finish-load', () => setTimeout(() => queue.kick(), 1500));
  log(`Image Seek ${app.getVersion()} started — data in ${paths.data}`);
});
