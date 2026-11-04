'use strict';
// Background lookup queue. Runs one file at a time through IQDB → SauceNAO → ascii2d → trace.moe.
// Busy sites (IQDB's "heavy load" queue, SauceNAO's limits) are retried later on their own,
// while other files keep going.
const saucenao = require('./saucenao');
const iqdb = require('./iqdb');
const ascii2d = require('./ascii2d');
const tracemoe = require('./tracemoe');
const { enrichResults } = require('./enrich');
const { buildGuess } = require('./guess');

const ORDER = ['iqdb', 'saucenao', 'ascii2d', 'tracemoe'];
const FINAL = new Set(['done', 'error', 'blocked', 'skipped']);
const IQDB_BACKOFF = [2, 5, 10, 20, 30, 60].map((m) => m * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LookupQueue {
  constructor({ library, settings, fetch, render, prepImage, log, emit }) {
    this.lib = library;
    this.settings = settings;
    this.fetch = fetch;
    this.render = render;
    this.prepImage = prepImage;
    this.log = log;
    this.emit = emit;
    this.running = false;
    this.current = null;
    this.sauceQuota = { short: null, long: null, at: 0 };
    this.sauceWaitUntil = 0; // daily limit back-off
    this.traceWaitUntil = 0;
    this.iqdbBusyUntil = 0; // site-wide pause after a busy page
    this.wakeTimer = null;
  }

  status() {
    const items = Object.values(this.lib.d.items);
    const waiting = items.filter((i) => i.status !== 'done' && Object.values(i.engines || {}).includes('waiting'));
    return {
      paused: !!this.settings.get().queuePaused,
      running: this.running,
      current: this.current,
      queued: items.filter((i) => i.status === 'queued' || i.status === 'looking').length,
      waiting: waiting.length,
      waitingSauce: waiting.filter((i) => i.engines.saucenao === 'waiting').length,
      waitingIqdb: waiting.filter((i) => i.engines.iqdb === 'waiting').length,
      sauceQuota: this.sauceQuota,
      sauceWaitUntil: this.sauceWaitUntil,
      iqdbBusyUntil: this.iqdbBusyUntil,
      failed: this.lib.failedCounts(),
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

  // When an engine that's waiting on a file may be tried again.
  readyAt(it, engine) {
    const own = (it.retryAt && it.retryAt[engine]) || 0;
    if (engine === 'saucenao') return Math.max(own, this.sauceWaitUntil);
    if (engine === 'iqdb') return Math.max(own, this.iqdbBusyUntil);
    return own;
  }

  hasReadyWaiting(it, now) {
    if (it.status === 'done') return false;
    const s = this.settings.get();
    return Object.entries(it.engines || {}).some(([e, v]) => v === 'waiting' && s.engines[e] && this.readyAt(it, e) <= now);
  }

  nextItem() {
    const now = Date.now();
    const items = Object.values(this.lib.d.items).sort((a, b) => a.addedAt - b.addedAt);
    const q = items.find((i) => i.status === 'queued');
    if (q) return q;
    return items.find((i) => this.hasReadyWaiting(i, now)) || null;
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
    let next = Infinity;
    for (const it of Object.values(this.lib.d.items)) {
      if (it.status === 'done') continue;
      for (const [e, v] of Object.entries(it.engines || {})) if (v === 'waiting') next = Math.min(next, this.readyAt(it, e));
    }
    if (next < Infinity) {
      const ms = Math.max(5000, Math.min(next - Date.now() + 1000, 30 * 60 * 1000));
      this.wakeTimer = setTimeout(() => this.kick(), ms);
    }
  }

  async process(it) {
    this.current = { id: it.id, name: it.name, engine: null };
    const prevStatus = it.status;
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

    const now = Date.now();
    for (const engine of this.enabledEngines()) {
      if (this.settings.get().queuePaused) break;
      const st = it.engines[engine];
      if (FINAL.has(st)) continue;
      if (st === 'waiting' && this.readyAt(it, engine) > now) continue;
      if (engine === 'tracemoe' && !this.wantTrace(it)) { it.engines.tracemoe = 'skipped'; continue; }
      this.current.engine = engine;
      this.pushStatus();
      await this.runEngine(it, engine, image);
    }

    const pending = this.enabledEngines().some((e) => !FINAL.has(it.engines[e]) && it.engines[e] !== 'waiting');
    if (this.settings.get().queuePaused && pending) it.status = prevStatus === 'looked' ? 'looked' : 'queued';
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
    // Sorting / downloading may have finished the item while it was being looked up.
    await this.lib.checkItemDone(it);
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

  wait(it, engine, ms, message) {
    it.engines[engine] = 'waiting';
    it.retryAt = { ...(it.retryAt || {}), [engine]: Date.now() + ms };
    it.engineErrors = { ...(it.engineErrors || {}), [engine]: message };
    it.attempts = { ...(it.attempts || {}), [engine]: ((it.attempts || {})[engine] || 0) + 1 };
  }

  async runEngine(it, engine, image) {
    const s = this.settings.get();
    try {
      if (engine === 'iqdb') {
        let r;
        try {
          r = await iqdb.search(this.fetch, image);
        } catch (e) {
          if (e instanceof iqdb.BusyError) {
            const n = (it.attempts || {}).iqdb || 0;
            const ms = IQDB_BACKOFF[Math.min(n, IQDB_BACKOFF.length - 1)];
            this.iqdbBusyUntil = Date.now() + Math.min(ms, 2 * 60 * 1000);
            this.wait(it, 'iqdb', ms, `IQDB busy — retrying around ${new Date(Date.now() + ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
            this.log(`${it.name}: IQDB is busy — will try again later`, 'warn');
            this.lib.changed(it.id);
            return;
          }
          // Odd encodings (CMYK, wrong extension) — try once more with a clean JPEG copy.
          if (/could not read/i.test(e.message)) {
            const clean = await this.prepImage(it.path, s, { force: true });
            r = await iqdb.search(this.fetch, clean);
          } else throw e;
        }
        this.setResults(it, 'iqdb', r.results);
      } else if (engine === 'saucenao') {
        if (!s.saucenaoKey) { it.engines.saucenao = 'error'; it.engineErrors = { ...(it.engineErrors || {}), saucenao: 'No API key (Settings → Lookups)' }; return; }
        if (Date.now() < this.sauceWaitUntil) { this.wait(it, 'saucenao', this.sauceWaitUntil - Date.now(), 'Waiting for SauceNAO quota'); return; }
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
              this.wait(it, 'saucenao', 60 * 60 * 1000, 'Waiting for SauceNAO quota');
              this.log('SauceNAO daily limit reached — the rest will run when quota frees up (checked hourly).', 'warn');
              this.pushStatus();
              return;
            }
            throw e;
          }
        }
      } else if (engine === 'ascii2d') {
        try {
          const r = await ascii2d.search(this.render, image);
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
      if (it.retryAt) delete it.retryAt[engine];
      if (it.attempts) delete it.attempts[engine];
    } catch (e) {
      it.engines[engine] = 'error';
      it.engineErrors = { ...(it.engineErrors || {}), [engine]: e.message };
      this.log(`${it.name}: ${engine} failed — ${e.message}`, 'warn');
    }
    this.lib.changed(it.id);
  }
}

module.exports = { LookupQueue };
