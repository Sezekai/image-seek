'use strict';
// Import cookies and saved logins from Firefox.
//  - Cookies: cookies.sqlite (+ its -wal file, so recent cookies are included even while Firefox is open).
//  - Logins: logins.json decrypted with key4.db (works without a primary password, or with one you enter),
//            or Firefox's own CSV export (about:logins → ⋯ → Export Logins).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---------------- profiles ----------------
function parseIni(text) {
  const sections = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(';') || t.startsWith('#')) continue;
    const m = t.match(/^\[(.+)\]$/);
    if (m) { cur = { _name: m[1] }; sections.push(cur); continue; }
    const kv = t.match(/^([^=]+)=(.*)$/);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

function firefoxRoot() {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'Mozilla', 'Firefox') : null;
}

function listProfiles() {
  const root = firefoxRoot();
  if (!root) return [];
  const ini = path.join(root, 'profiles.ini');
  if (!fs.existsSync(ini)) return [];
  const sections = parseIni(fs.readFileSync(ini, 'utf8'));
  const installDefaults = new Set(sections.filter((s) => s._name.startsWith('Install') && s.Default).map((s) => s.Default.replace(/\\/g, '/')));
  const out = [];
  for (const s of sections) {
    if (!s._name.startsWith('Profile') || !s.Path) continue;
    const p = s.IsRelative === '1' ? path.join(root, ...s.Path.split(/[\\/]/)) : s.Path;
    if (!fs.existsSync(p)) continue;
    out.push({
      name: s.Name || path.basename(p),
      path: p,
      isDefault: installDefaults.has(s.Path.replace(/\\/g, '/')) || s.Default === '1',
      hasCookies: fs.existsSync(path.join(p, 'cookies.sqlite')),
      hasLogins: fs.existsSync(path.join(p, 'logins.json')),
    });
  }
  out.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (b.hasLogins ? 1 : 0) - (a.hasLogins ? 1 : 0));
  return out;
}

// ---------------- SQLite with WAL ----------------
// sql.js reads only the main database file, so apply committed WAL frames ourselves.
function applyWal(db, wal) {
  if (!wal || wal.length < 32) return db;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return db;
  const bigEndianChecksum = magic === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
  const frameSize = 24 + pageSize;
  const pages = new Map();
  let pending = new Map();
  let dbSizePages = 0;
  let s0 = wal.readUInt32BE(24), s1 = wal.readUInt32BE(28);
  const checksum = (buf, start, len, a, b) => {
    for (let i = start; i < start + len; i += 8) {
      const x0 = bigEndianChecksum ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
      const x1 = bigEndianChecksum ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
      a = (a + x0 + b) >>> 0;
      b = (b + x1 + a) >>> 0;
    }
    return [a, b];
  };
  for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
    const pgno = wal.readUInt32BE(off);
    const commit = wal.readUInt32BE(off + 4);
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
    [s0, s1] = checksum(wal, off, 8, s0, s1);
    [s0, s1] = checksum(wal, off + 24, pageSize, s0, s1);
    if (s0 !== wal.readUInt32BE(off + 16) || s1 !== wal.readUInt32BE(off + 20)) break;
    pending.set(pgno, wal.subarray(off + 24, off + 24 + pageSize));
    if (commit > 0) {
      for (const [k, v] of pending) pages.set(k, v);
      pending = new Map();
      dbSizePages = commit;
    }
  }
  if (!pages.size) return db;
  const dbPageSize = db.length >= 18 ? (db.readUInt16BE(16) === 1 ? 65536 : db.readUInt16BE(16)) : pageSize;
  if (dbPageSize && dbPageSize !== pageSize && db.length) return db;
  const out = Buffer.alloc(Math.max(dbSizePages * pageSize, db.length));
  db.copy(out, 0);
  for (const [pgno, page] of pages) page.copy(out, (pgno - 1) * pageSize);
  const trimmed = dbSizePages ? out.subarray(0, dbSizePages * pageSize) : out;
  // Mark the copy as rollback-journal mode so sql.js doesn't look for a WAL.
  if (trimmed.length > 19) { trimmed[18] = 1; trimmed[19] = 1; }
  return trimmed;
}

let SQL = null;
async function sqljs() {
  if (!SQL) {
    const init = require('sql.js');
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await init({ wasmBinary: fs.readFileSync(wasmPath) });
  }
  return SQL;
}

async function openDb(file) {
  const SQLmod = await sqljs();
  // Read the files directly (Firefox shares them for reading), then apply the WAL in memory.
  const main = await fsp.readFile(file);
  let wal = null;
  try { wal = await fsp.readFile(file + '-wal'); } catch (_) { /* no wal */ }
  const merged = applyWal(main, wal);
  if (merged.length > 19) { merged[18] = 1; merged[19] = 1; }
  return new SQLmod.Database(merged);
}

function rows(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// ---------------- cookies ----------------
async function readCookies(profilePath) {
  const db = await openDb(path.join(profilePath, 'cookies.sqlite'));
  try {
    const cols = rows(db, 'PRAGMA table_info(moz_cookies)').map((r) => r.name);
    const hasSameSite = cols.includes('sameSite');
    const list = rows(db, `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, originAttributes${hasSameSite ? ', sameSite' : ''} FROM moz_cookies`);
    const now = Date.now() / 1000;
    const out = [];
    for (const c of list) {
      if (c.originAttributes) continue; // containers / partitioned cookies stay in Firefox
      let exp = Number(c.expiry) || 0;
      if (exp > 1e11) exp = exp / 1000; // newer Firefox stores milliseconds
      if (exp && exp < now) continue;
      const host = String(c.host || '');
      const bare = host.replace(/^\./, '');
      if (!bare) continue;
      const secure = !!c.isSecure;
      let sameSite = 'unspecified';
      if (hasSameSite) sameSite = c.sameSite === 2 ? 'strict' : c.sameSite === 1 ? 'lax' : (secure ? 'no_restriction' : 'unspecified');
      const cookie = {
        url: `${secure ? 'https' : 'http'}://${bare}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure,
        httpOnly: !!c.isHttpOnly,
        sameSite,
      };
      if (host.startsWith('.')) cookie.domain = host;
      if (exp) cookie.expirationDate = exp;
      if (cookie.name.startsWith('__Host-')) delete cookie.domain;
      out.push(cookie);
    }
    return out;
  } finally {
    db.close();
  }
}

async function importCookies(profilePath, electronSession, onProgress) {
  const list = await readCookies(profilePath);
  let ok = 0, failed = 0;
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const res = await Promise.allSettled(chunk.map((c) => electronSession.cookies.set(c)));
    for (const r of res) r.status === 'fulfilled' ? ok++ : failed++;
    if (onProgress) onProgress(Math.min(i + 50, list.length), list.length);
  }
  await electronSession.cookies.flushStore();
  return { imported: ok, failed, total: list.length };
}

// ---------------- minimal DER reader ----------------
function der(buf, off = 0) {
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  const start = off + hdr;
  const node = { tag, start, end: start + len, len, value: buf.subarray(start, start + len) };
  if (tag === 0x30 || tag === 0x31 || tag === 0xa0) {
    node.children = [];
    let p = start;
    while (p < start + len) {
      const child = der(buf, p);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

function oid(node) {
  const b = node.value;
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

function intVal(node) {
  let v = 0;
  for (const x of node.value) v = v * 256 + x;
  return v;
}

const OID = {
  PBES2: '1.2.840.113549.1.5.13',
  PBKDF2: '1.2.840.113549.1.5.12',
  HMAC_SHA256: '1.2.840.113549.2.9',
  AES256_CBC: '2.16.840.1.101.3.4.1.42',
  PBE_SHA1_3DES: '1.2.840.113549.1.12.5.1.3',
  DES_EDE3_CBC: '1.2.840.113549.3.7',
};

function unpad(buf) {
  const n = buf[buf.length - 1];
  if (n > 0 && n <= 16 && n <= buf.length) return buf.subarray(0, buf.length - n);
  return buf;
}

// Decrypts an NSS "encrypted private key info" style blob from key4.db.
function decryptPbe(blob, globalSalt, primaryPassword) {
  const root = der(blob);
  const algSeq = root.children[0];
  const algOid = oid(algSeq.children[0]);
  const ciphertext = root.children[1].value;
  const pw = Buffer.from(primaryPassword || '', 'utf8');
  if (algOid === OID.PBES2) {
    const params = algSeq.children[1];
    const kdf = params.children[0];
    const kdfParams = kdf.children[1];
    const salt = kdfParams.children[0].value;
    const iterations = intVal(kdfParams.children[1]);
    const keyLen = kdfParams.children[2] && kdfParams.children[2].tag === 0x02 ? intVal(kdfParams.children[2]) : 32;
    const enc = params.children[1];
    const ivRaw = enc.children[1].value;
    // NSS stores a 14-byte IV; the real IV is the DER header (04 0e) plus those 14 bytes.
    const iv = ivRaw.length === 14 ? Buffer.concat([Buffer.from([0x04, 0x0e]), ivRaw]) : ivRaw;
    const k = crypto.createHash('sha1').update(globalSalt).update(pw).digest();
    const key = crypto.pbkdf2Sync(k, salt, iterations, keyLen, 'sha256');
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(false);
    return unpad(Buffer.concat([d.update(ciphertext), d.final()]));
  }
  if (algOid === OID.PBE_SHA1_3DES) {
    const params = algSeq.children[1];
    const entrySalt = params.children[0].value;
    const hp = crypto.createHash('sha1').update(globalSalt).update(pw).digest();
    const pes = Buffer.concat([entrySalt, Buffer.alloc(Math.max(0, 20 - entrySalt.length))]);
    const chp = crypto.createHash('sha1').update(hp).update(entrySalt).digest();
    const k1 = crypto.createHmac('sha1', chp).update(Buffer.concat([pes, entrySalt])).digest();
    const tk = crypto.createHmac('sha1', chp).update(pes).digest();
    const k2 = crypto.createHmac('sha1', chp).update(Buffer.concat([tk, entrySalt])).digest();
    const k = Buffer.concat([k1, k2]);
    const d = crypto.createDecipheriv('des-ede3-cbc', k.subarray(0, 24), k.subarray(k.length - 8));
    d.setAutoPadding(false);
    return unpad(Buffer.concat([d.update(ciphertext), d.final()]));
  }
  throw new Error('Unsupported Firefox key encryption (' + algOid + ')');
}

async function getMasterKey(profilePath, primaryPassword) {
  const db = await openDb(path.join(profilePath, 'key4.db'));
  try {
    const meta = rows(db, "SELECT item1, item2 FROM metaData WHERE id = 'password'")[0];
    if (!meta) throw new Error('key4.db has no password entry');
    const globalSalt = Buffer.from(meta.item1);
    const check = decryptPbe(Buffer.from(meta.item2), globalSalt, primaryPassword);
    if (!check.toString('latin1').startsWith('password-check')) {
      const e = new Error(primaryPassword ? 'Wrong Firefox primary password' : 'This Firefox profile has a primary password — enter it to import logins');
      e.needsPassword = true;
      throw e;
    }
    const keys = rows(db, 'SELECT a11, a102 FROM nssPrivate');
    for (const k of keys) {
      if (!k.a11) continue;
      try {
        const key = decryptPbe(Buffer.from(k.a11), globalSalt, primaryPassword);
        if (key.length >= 24) return key;
      } catch (_) { /* try next */ }
    }
    throw new Error('Could not read the Firefox encryption key');
  } finally {
    db.close();
  }
}

function decryptLoginField(b64, key) {
  const node = der(Buffer.from(b64, 'base64'));
  const alg = node.children[1];
  const algOid = oid(alg.children[0]);
  const iv = alg.children[1].value;
  const ct = node.children[2].value;
  let d;
  if (algOid === OID.DES_EDE3_CBC) d = crypto.createDecipheriv('des-ede3-cbc', key.subarray(0, 24), iv);
  else if (algOid === OID.AES256_CBC) d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  else throw new Error('Unsupported login encryption ' + algOid);
  d.setAutoPadding(false);
  return unpad(Buffer.concat([d.update(ct), d.final()])).toString('utf8');
}

async function readLogins(profilePath, primaryPassword) {
  const json = JSON.parse(await fsp.readFile(path.join(profilePath, 'logins.json'), 'utf8'));
  const key = await getMasterKey(profilePath, primaryPassword);
  const out = [];
  let failed = 0;
  for (const l of json.logins || []) {
    try {
      out.push({
        origin: l.hostname,
        formOrigin: l.formSubmitURL || l.formActionOrigin || '',
        username: decryptLoginField(l.encryptedUsername, key),
        password: decryptLoginField(l.encryptedPassword, key),
      });
    } catch (_) { failed++; }
  }
  return { logins: out, failed };
}

// ---------------- CSV export ----------------
function parseCsv(text) {
  const out = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0]) out.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

function loginsFromCsv(text) {
  const table = parseCsv(text.replace(/^﻿/, ''));
  if (!table.length) return [];
  const head = table[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => head.indexOf(n);
  const iu = idx('url'), iname = idx('username'), ipw = idx('password'), iform = idx('formactionorigin');
  if (iu < 0 || ipw < 0) throw new Error('This doesn\'t look like a Firefox logins export (no url/password columns)');
  return table.slice(1).filter((r) => r[iu]).map((r) => ({
    origin: r[iu], username: r[iname] || '', password: r[ipw] || '', formOrigin: iform >= 0 ? r[iform] : '',
  }));
}

module.exports = {
  listProfiles, readCookies, importCookies, readLogins, loginsFromCsv, parseCsv,
  // exported for tests
  _internal: { der, oid, decryptPbe, decryptLoginField, applyWal, parseIni, OID },
};
