// Shared state, DOM helpers, icons and small UI pieces.
export const api = window.api;

// Let el.append(a, cond ? b : null) skip empty values instead of printing "null".
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...nodes) { return nativeAppend.apply(this, nodes.filter((n) => n != null && n !== false)); };

export const state = {
  settings: null,
  paths: null,
  batches: [],
  items: new Map(), // id -> summary
  downloads: new Map(), // id -> record
  sortLog: [],
  queue: null,
  extensions: [],
  selectedItem: null,
  view: 'lookups',
};

// ---------- events ----------
const bus = new Map();
export function on(ev, fn) { if (!bus.has(ev)) bus.set(ev, new Set()); bus.get(ev).add(fn); return () => bus.get(ev).delete(fn); }
export function emit(ev, payload) { for (const fn of bus.get(ev) || []) { try { fn(payload); } catch (e) { console.error(e); } } }

// ---------- DOM ----------
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- icons (24x24 line icons) ----------
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  compare: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  fwd: '<path d="m9 18 6-6-6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  unlink: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  cols: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
  rows: '<rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  sort: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m10 13 2 2 3-4"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  fox: '<path d="M4 4l4 5h8l4-5v9a8 8 0 0 1-16 0z"/><path d="M9 14h.01M15 14h.01"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  hand: '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 14a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
  logo: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/><rect x="7.5" y="8" width="6" height="5" rx="1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  store: '<path d="M4 9h16l-1 11H5z"/><path d="M8 9V7a4 4 0 0 1 8 0v2"/>',
};
export function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = P[name] || P.info;
  return s;
}

export function btn(label, opts = {}) {
  const b = h('button', { class: 'btn ' + (opts.cls || ''), title: opts.title, onclick: opts.onclick, disabled: opts.disabled });
  if (opts.icon) b.appendChild(icon(opts.icon));
  if (label) b.appendChild(document.createTextNode(label));
  if (!label && opts.icon) b.classList.add('icon');
  return b;
}

export function seg(options, value, onchange) {
  const el = h('div', { class: 'seg' });
  const render = (v) => {
    clear(el);
    for (const o of options) {
      const b = h('button', { class: o.value === v ? 'on' : '', title: o.title, onclick: () => { render(o.value); onchange(o.value); } });
      if (o.icon) b.appendChild(icon(o.icon));
      if (o.label) b.appendChild(document.createTextNode(o.label));
      if (o.count != null) b.appendChild(h('span', { class: 'n' }, o.count));
      el.appendChild(b);
    }
  };
  render(value);
  el.set = render;
  return el;
}

// ---------- formatting ----------
export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10485760 ? 2 : 1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
export function fmtDims(w, h) { return w && h ? `${w}×${h}` : '—'; }
export function fmtMp(w, h) { return w && h ? (w * h / 1e6).toFixed(w * h < 1e7 ? 2 : 1) + ' MP' : '—'; }
export function fmtTime(t) {
  const d = new Date(t);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function basename(p) { return String(p || '').split(/[\\/]/).pop(); }
export function dirname(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i > 0 ? s.slice(0, i) : s; }
export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
export function fileUrl(p, bust) { return 'isf://f/' + encodeURIComponent(p) + (bust ? '?v=' + bust : ''); }
export function thumbUrl(p, size = 320, bust) { return 'isf://thumb/' + encodeURIComponent(p) + '?s=' + size + (bust ? '&v=' + bust : ''); }
export function simClass(s) { return s == null ? 'lo' : s >= 85 ? 'hi' : s >= 65 ? 'mid' : 'lo'; }
export const ENGINE_LABEL = { iqdb: 'IQDB', saucenao: 'SauceNAO', ascii2d: 'ascii2d', tracemoe: 'trace.moe' };

// ---------- toasts ----------
export function toast(msg, kind = 'info', ms = 3500, action) {
  const el = h('div', { class: 'toast ' + kind }, h('div', { class: 'grow' }, msg));
  if (action) el.appendChild(btn(action.label, { cls: 'sm', onclick: () => { action.run(); el.remove(); } }));
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'error', 6000); return undefined; }
}

// ---------- modal ----------
export function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const close = (v) => { ov.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); close(p.value()); }
      }
    };
    const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(null); } },
      h('div', { class: 'modal' },
        h('div', { class: 'mh' }, title),
        h('div', { class: 'mb' }, body),
        h('div', { class: 'mf' }, buttons.map((b) => btn(b.label, { cls: b.primary ? 'primary' : '', onclick: () => close(b.value ? b.value() : b.label) })))));
    document.body.appendChild(ov);
    document.addEventListener('keydown', key, true);
    const first = ov.querySelector('input, select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export async function prompt(title, label, value = '', placeholder = '') {
  const input = h('input', { class: 'input', value, placeholder, style: { width: '100%' } });
  return modal(title, [label ? h('div', { class: 'muted small' }, label) : null, input], [
    { label: 'Cancel', value: () => null },
    { label: 'OK', primary: true, value: () => input.value.trim() || null },
  ]);
}

export async function confirmBox(title, text, okLabel = 'OK') {
  const r = await modal(title, h('div', { class: 'muted' }, text), [
    { label: 'Cancel', value: () => false },
    { label: okLabel, primary: true, value: () => true },
  ]);
  return !!r;
}

// ---------- popup menu ----------
export function popupMenu(x, y, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu' }, items.map((it) => it === '-' ? h('div', { style: { height: '1px', background: 'var(--line)', margin: '4px 0' } })
    : h('div', { class: 'mi', onclick: () => { m.remove(); it.run(); } }, it.img ? h('img', { src: it.img }) : null, h('span', { class: 'ell' }, it.label))));
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
  return m;
}

// ---------- tooltips for icon buttons ----------
let tipEl = null;
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { if (tipEl) { tipEl.remove(); tipEl = null; } return; }
  if (tipEl && tipEl._for === t) return;
  if (tipEl) tipEl.remove();
  tipEl = h('div', { class: 'tip' }, t.dataset.tip);
  tipEl._for = t;
  document.body.appendChild(tipEl);
  const r = t.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  const left = t.closest('#rail') ? r.right + 8 : Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 6));
  const top = t.closest('#rail') ? r.top + r.height / 2 - tr.height / 2 : r.bottom + 6;
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
});

// ---------- image viewer ----------
export function viewImage(src) {
  const v = h('div', { class: 'viewer', onclick: () => v.remove() }, h('img', { src }));
  document.body.appendChild(v);
  const k = (e) => { if (e.key === 'Escape') { v.remove(); document.removeEventListener('keydown', k); } };
  document.addEventListener('keydown', k);
}

// ---------- resizable side panels ----------
export function makeResizable(side, key, min = 320, max = 900) {
  const handle = h('div', { class: 'resizer' });
  side.appendChild(handle);
  const saved = +localStorageGet('w:' + key) || 0;
  if (saved) side.style.setProperty('--side-w', saved + 'px');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('drag');
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;
    const left = side.classList.contains('left');
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(min, Math.min(max, startW + (left ? dx : -dx)));
      side.style.setProperty('--side-w', w + 'px');
    };
    const up = () => {
      handle.classList.remove('drag');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorageSet('w:' + key, Math.round(side.getBoundingClientRect().width));
      window.dispatchEvent(new Event('resize'));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- image helpers (decode / resize / perceptual hash) ----------
async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not open image');
  const blob = await res.blob();
  return createImageBitmap(blob);
}

export async function prepForUpload(url, maxSide, quality) {
  const bmp = await loadBitmap(url);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), hh = Math.max(1, Math.round(bmp.height * scale));
  const c = new OffscreenCanvas(w, hh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, hh);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, hh);
  bmp.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

const hashCache = new Map();
// 64-bit difference hash; compare with hamming distance (0 = same picture, >20 = probably different).
export async function dHash(url) {
  if (hashCache.has(url)) return hashCache.get(url);
  const p = (async () => {
    const bmp = await loadBitmap(url);
    const c = new OffscreenCanvas(9, 8);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, 9, 8);
    bmp.close();
    const d = ctx.getImageData(0, 0, 9, 8).data;
    let bits = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 9 + x) * 4, j = i + 4;
        const a = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const b = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
        bits += a > b ? '1' : '0';
      }
    }
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  })();
  hashCache.set(url, p);
  p.catch(() => hashCache.delete(url));
  return p;
}
export function hamming(a, b) {
  if (!a || !b) return null;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
