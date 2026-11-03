'use strict';
// Background lookup queue. Runs one file at a time through IQDB → SauceNAO → ascii2d → trace.moe,
// respects SauceNAO's 30-second and daily limits, and resumes after a restart.
const saucenao = require('./saucenao');
const iqdb = require('./iqdb');
const ascii2d = require('./ascii2d');
const tracemoe = require('./tracemoe');
const { enrichResults } = require('./enrich');
const { buildGuess } = require('./guess');

const ORDER = ['iqdb', 'saucenao', 'ascii2d', 'tracemoe'];
const FINAL = new Set(['done', 'error', 'blocked', 'skipped']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LookupQueue {
  constructor({ library, settings, fetch, browserFetch, prepImage, log, emit }) {
    this.lib = library;
    this.settings = settings;
    this.fetch = fetch;
    this.browserFetch = browserFetch;
    this.prepImage = prepImage;
    this.log = log;
    this.emit = emit;
    this.running = false;
    this.current = null;
    this.sauceQuota = { short: null, long: null, at: 0 };
    this.sauceWaitUntil = 0; // daily limit back-off
    this.traceWaitUntil = 0;
    this.wakeTimer = null;
  }

  status() {
    const items = Object.values(this.lib.d.items);
    return {
      paused: !!this.settings.get().queuePaused,
      running: this.running,
      current: this.current,
      queued: items.filter((i) => i.status === 'queued' || i.status === 'looking').length,
      waitingSauce: items.filter((i) => i.engines && i.engines.saucenao === 'waiting').length,
      sauceQuota: this.sauceQuota,
      sauceWaitUntil: this.sauceWaitUntil,
    };
  }

  pushStatus() { this.emit('queue:status', this.status()); }

  kick() {
    if (this.running) return;
    this.run().catch((e) => this.log('Queue stopped: ' + e.message, 'error'));
  }

  enabledEngines() {
    const s = this.settings.get();
    return ORDER.filter((e) => s.engines[e]);
  }

  nextItem() {
    const now = Date.now();
    const items = Object.values(this.lib.d.items).sort((a, b) => a.addedAt - b.addedAt);
    const q = items.find((i) => i.status === 'queued');
    if (q) return q;
    if (now >= this.sauceWaitUntil && this.settings.get().engines.saucenao) {
      return items.find((i) => i.engines && i.engines.saucenao === 'waiting') || null;
    }
    return null;
  }

  async run() {
    this.running = true;
    this.pushStatus();
    try {
      while (!this.settings.get().queuePaused) {
        const it = this.nextItem();
        if (!it) break;
        await this.process(it);
      }
    } finally {
      this.running = false;
      this.current = null;
      this.pushStatus();
      this.scheduleWake();
    }
  }

  scheduleWake() {
    clearTimeout(this.wakeTimer);
    const waiting = Object.values(this.lib.d.items).some((i) => i.engines && i.engines.saucenao === 'waiting');
    if (waiting && this.sauceWaitUntil > Date.now()) {
      this.wakeTimer = setTimeout(() => this.kick(), Math.min(this.sauceWaitUntil - Date.now() + 1000, 30 * 60 * 1000));
    }
  }

  async process(it) {
    this.current = { id: it.id, name: it.name, engine: null };
    const wasLooked = it.status === 'looked';
    it.status = 'looking';
    it.engines = it.engines || {};
    this.lib.changed(it.id);
    this.pushStatus();

    let image;
    try {
      image = await this.prepImage(it.path, this.settings.get());
    } catch (e) {
      it.status = 'error';
      it.error = 'Could not read the image: ' + e.message;
      this.lib.changed(it.id);
      this.log(`${it.name}: ${it.error}`, 'error');
      return;
    }

    for (const engine of this.enabledEngines()) {
      if (this.settings.get().queuePaused) break;
      if (FINAL.has(it.engines[engine])) continue;
      if (engine === 'tracemoe' && !this.wantTrace(it)) { it.engines.tracemoe = 'skipped'; continue; }
      this.current.engine = engine;
      this.pushStatus();
      await this.runEngine(it, engine, image);
    }

    const pending = this.enabledEngines().some((e) => !FINAL.has(it.engines[e]) && it.engines[e] !== 'waiting');
    if (this.settings.get().queuePaused && pending) it.status = wasLooked ? 'looked' : 'queued';
    else it.status = 'looked';
    it.error = null;
    const errs = Object.entries(it.engines).filter(([, v]) => v === 'error').map(([k]) => k);
    if (errs.length && errs.length === this.enabledEngines().length) {
      it.status = 'error';
      it.error = 'All lookups failed';
    }
    it.lookedAt = Date.now();
    try { await enrichResults(this.fetch, it.results); } catch (_) { /* optional */ }
    const g = buildGuess(it.results, this.settings.get().minSimilarity, it);
    it.guess = g.guess;
    it.bigger = g.bigger;
    this.lib.changed(it.id);
  }

  // trace.moe only helps with anime screenshots, so by default it runs when nothing else matched.
  wantTrace(it) {
    if (Date.now() < this.traceWaitUntil) return false;
    const min = this.settings.get().minSimilarity;
    const strong = (it.results || []).some((r) => r.engine !== 'tracemoe' && r.similarity != null && r.similarity >= (min[r.engine] || 0) + 5);
    return !strong;
  }

  setResults(it, engine, results) {
    it.results = (it.results || []).filter((r) => r.engine !== engine).concat(results);
  }

  async runEngine(it, engine, image) {
    const s = this.settings.get();
    try {
      if (engine === 'iqdb') {
        const r = await iqdb.search(this.fetch, image);
        this.setResults(it, 'iqdb', r.results);
      } else if (engine === 'saucenao') {
        if (!s.saucenaoKey) { it.engines.saucenao = 'error'; it.engineErrors = { ...(it.engineErrors || {}), saucenao: 'No API key' }; return; }
        if (Date.now() < this.sauceWaitUntil) { it.engines.saucenao = 'waiting'; return; }
        let attempt = 0;
        for (;;) {
          try {
            const r = await saucenao.search(this.fetch, s.saucenaoKey, image);
            this.sauceQuota = r.quota;
            this.setResults(it, 'saucenao', r.results);
            if (r.quota.short === 0) await sleep(31000);
            break;
          } catch (e) {
            if (e.quota) this.sauceQuota = e.quota;
            if (e.limit === 'short' && attempt < 3) {
              attempt++;
              this.log('SauceNAO 30-second limit — waiting', 'info');
              await sleep(31000);
              continue;
            }
            if (e.limit === 'long' || e.limit === 'short') {
              this.sauceWaitUntil = Date.now() + 60 * 60 * 1000;
              it.engines.saucenao = 'waiting';
              this.log('SauceNAO daily limit reached — the rest will run when quota frees up (checked hourly).', 'warn');
              this.pushStatus();
              return;
            }
            throw e;
          }
        }
      } else if (engine === 'ascii2d') {
        try {
          const r = await ascii2d.search(this.browserFetch, image);
          this.setResults(it, 'ascii2d', r.results);
          it.ascii2dUrl = r.pageUrl;
        } catch (e) {
          if (e instanceof ascii2d.BlockedError) {
            it.engines.ascii2d = 'blocked';
            it.engineErrors = { ...(it.engineErrors || {}), ascii2d: e.message };
            return;
          }
          throw e;
        }
      } else if (engine === 'tracemoe') {
        try {
          const r = await tracemoe.search(this.fetch, image);
          this.setResults(it, 'tracemoe', r.results);
        } catch (e) {
          if (e.limit) { this.traceWaitUntil = Date.now() + 60 * 60 * 1000; it.engines.tracemoe = 'skipped'; return; }
          throw e;
        }
      }
      it.engines[engine] = 'done';
      if (it.engineErrors) delete it.engineErrors[engine];
    } catch (e) {
      it.engines[engine] = 'error';
      it.engineErrors = { ...(it.engineErrors || {}), [engine]: e.message };
      this.log(`${it.name}: ${engine} failed — ${e.message}`, 'warn');
    }
    this.lib.changed(it.id);
  }
}

module.exports = { LookupQueue };
