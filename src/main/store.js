'use strict';
// Small JSON file store with debounced, atomic writes (write temp file, then rename).
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.timer = null;
    this.data = this._load();
  }

  _load() {
    const fresh = () => JSON.parse(JSON.stringify(this.defaults));
    for (const f of [this.file, this.file + '.bak']) {
      try {
        if (fs.existsSync(f)) {
          const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
          return Object.assign(fresh(), parsed);
        }
      } catch (e) {
        console.error('store load failed', f, e.message);
      }
    }
    return fresh();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch (_) { /* ignore */ }
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store save failed', this.file, e.message);
    }
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(this.defaults));
    this.flush();
  }
}

module.exports = { JsonStore };
