'use strict';
const path = require('path');
const { JsonStore } = require('./store');

function defaults(paths) {
  return {
    downloadsDir: paths.defaultDownloads,
    sortRoot: paths.defaultSorted,
    sortFolders: [],
    saucenaoKey: '',
    saucenaoKeySource: '',
    engines: { iqdb: true, saucenao: true, ascii2d: true, tracemoe: true },
    minSimilarity: { saucenao: 70, iqdb: 80, ascii2d: 0, tracemoe: 90 },
    includeSubfolders: false,
    adblock: 'builtin', // builtin | ubol | off
    darkMode: true,
    darkModeExclude: [],
    siteThemes: {},
    lastSaveAsDir: '',
    dock: 'closed',
    autoAdd: true,
    homepage: 'https://www.google.com/',
    uploadMaxSide: 3000,
    uploadMaxBytes: 4 * 1024 * 1024,
    unrelatedThreshold: 20, // dHash distance (0-64) above which a download is flagged as unrelated
    autofill: true,
    queuePaused: false,
    sidebarHidden: false,
    logOpen: false,
    lastSortFlags: { nsfw: false, very: false },
    compareLayout: 'horizontal',
    firstRunDone: false,
  };
}

class Settings {
  constructor(paths) {
    this.paths = paths;
    this.store = new JsonStore(path.join(paths.data, 'settings.json'), defaults(paths));
    // merge nested defaults for older settings files
    const d = defaults(paths);
    const s = this.store.data;
    s.engines = Object.assign({}, d.engines, s.engines);
    s.minSimilarity = Object.assign({}, d.minSimilarity, s.minSimilarity);
    // Older versions kept a list of sites with dark mode turned off.
    if (!s.siteThemes) s.siteThemes = {};
    for (const h of s.darkModeExclude || []) if (!s.siteThemes[h]) s.siteThemes[h] = 'light';
    s.darkModeExclude = [];
  }
  get() { return this.store.data; }
  set(patch) {
    Object.assign(this.store.data, patch);
    this.store.save();
    return this.store.data;
  }
  reset() {
    const keepKey = this.store.data.saucenaoKey;
    this.store.data = defaults(this.paths);
    this.store.data.saucenaoKey = keepKey;
    this.store.flush();
  }
}

module.exports = { Settings };
