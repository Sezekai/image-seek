'use strict';
// Plain Node tests for the parts that don't need a window: run with `npm test`.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Module = require('module');

// Stub the electron module for code that only needs shell.trashItem / safeStorage.
const trashed = [];
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      shell: { trashItem: async (p) => { trashed.push(p); fs.unlinkSync(p); } },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.call(this, req, ...rest);
};

const FX = path.join(__dirname, 'fixtures');
let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------- image info ----------------
const { getImageInfo } = require('../src/main/imageinfo');
test('image headers: dimensions and formats', async () => {
  for (const [f, fmt] of [['q85.jpg', 'JPEG'], ['prog.jpg', 'JPEG'], ['a.png', 'PNG'], ['a.webp', 'WebP'], ['ll.webp', 'WebP'], ['a.gif', 'GIF'], ['a.bmp', 'BMP']]) {
    const i = await getImageInfo(path.join(FX, f));
    assert.strictEqual(i.format, fmt, f);
    assert.strictEqual(i.width, 640, f + ' width');
    assert.strictEqual(i.height, 480, f + ' height');
  }
});
test('JPEG quality estimate', async () => {
  const a = await getImageInfo(path.join(FX, 'q85.jpg'));
  const b = await getImageInfo(path.join(FX, 'q60.jpg'));
  assert.ok(Math.abs(a.quality - 85) <= 2, 'q85 -> ' + a.quality);
  assert.ok(Math.abs(b.quality - 60) <= 2, 'q60 -> ' + b.quality);
});

// ---------------- firefox cookies ----------------
const firefox = require('../src/main/firefox');
test('Firefox cookies (including rows only in the WAL file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  fs.copyFileSync(path.join(FX, 'cookies.sqlite'), path.join(dir, 'cookies.sqlite'));
  fs.copyFileSync(path.join(FX, 'cookies.sqlite-wal'), path.join(dir, 'cookies.sqlite-wal'));
  const list = await firefox.readCookies(dir);
  const names = list.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['PHPSESSID', 'auth_token'], 'expired + container cookies skipped, WAL row present');
  const x = list.find((c) => c.name === 'auth_token');
  assert.strictEqual(x.url, 'https://x.com/');
  assert.strictEqual(x.domain, '.x.com');
  assert.strictEqual(x.sameSite, 'strict');
  assert.ok(x.expirationDate < 1e11, 'millisecond expiry converted to seconds');
});

// ---------------- firefox logins (key4.db + logins.json) ----------------
function derLen(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n) { bytes.unshift(n & 255); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
const seq = (...c) => tlv(0x30, Buffer.concat(c));
const octet = (b) => tlv(0x04, b);
const int = (n) => { const b = []; do { b.unshift(n & 255); n = Math.floor(n / 256); } while (n); if (b[0] & 0x80) b.unshift(0); return tlv(0x02, Buffer.from(b)); };
function oid(str) {
  const p = str.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const stack = [v & 0x7f];
    let x = v >> 7;
    while (x) { stack.unshift((x & 0x7f) | 0x80); x >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
const O = firefox._internal.OID;
function pkcs7(buf, bs) { const n = bs - (buf.length % bs); return Buffer.concat([buf, Buffer.alloc(n, n)]); }
function nssPbes2(plain, globalSalt, pw) {
  const salt = crypto.randomBytes(32), iter = 1000, iv14 = crypto.randomBytes(14);
  const k = crypto.createHash('sha1').update(globalSalt).update(Buffer.from(pw, 'utf8')).digest();
  const key = crypto.pbkdf2Sync(k, salt, iter, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-cbc', key, Buffer.concat([Buffer.from([4, 14]), iv14]));
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7(plain, 16)), c.final()]);
  return seq(seq(oid(O.PBES2), seq(seq(oid(O.PBKDF2), seq(octet(salt), int(iter), int(32), seq(oid(O.HMAC_SHA256)))), seq(oid(O.AES256_CBC), octet(iv14)))), octet(ct));
}
function loginField(text, key) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7(Buffer.from(text, 'utf8'), 16)), c.final()]);
  return seq(octet(Buffer.alloc(16, 1)), seq(oid(O.AES256_CBC), octet(iv)), octet(ct)).toString('base64');
}
async function makeProfile(pw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffl-'));
  const init = require('sql.js');
  const SQL = await init({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  const globalSalt = crypto.randomBytes(20);
  const master = crypto.randomBytes(32);
  db.run('CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2)');
  db.run('CREATE TABLE nssPrivate (id INTEGER PRIMARY KEY, a11, a102)');
  db.run('INSERT INTO metaData VALUES (?,?,?)', ['password', globalSalt, nssPbes2(Buffer.from('password-check'), globalSalt, pw)]);
  db.run('INSERT INTO nssPrivate (a11, a102) VALUES (?,?)', [nssPbes2(master, globalSalt, pw), Buffer.alloc(16, 1)]);
  fs.writeFileSync(path.join(dir, 'key4.db'), Buffer.from(db.export()));
  fs.writeFileSync(path.join(dir, 'logins.json'), JSON.stringify({ logins: [
    { hostname: 'https://www.pixiv.net', formSubmitURL: 'https://accounts.pixiv.net', encryptedUsername: loginField('me@example.com', master), encryptedPassword: loginField('hunter2 ünï', master) },
    { hostname: 'https://danbooru.donmai.us', encryptedUsername: loginField('', master), encryptedPassword: loginField('pw2', master) },
  ] }));
  return dir;
}
test('Firefox logins decrypt (no primary password)', async () => {
  const dir = await makeProfile('');
  const r = await firefox.readLogins(dir, '');
  assert.strictEqual(r.failed, 0);
  assert.deepStrictEqual(r.logins.map((l) => [l.origin, l.username, l.password]), [
    ['https://www.pixiv.net', 'me@example.com', 'hunter2 ünï'], ['https://danbooru.donmai.us', '', 'pw2']]);
});
test('Firefox logins with a primary password', async () => {
  const dir = await makeProfile('s3cret');
  await assert.rejects(() => firefox.readLogins(dir, ''), /primary password/);
  await assert.rejects(() => firefox.readLogins(dir, 'wrong'), /Wrong Firefox primary password/);
  const r = await firefox.readLogins(dir, 's3cret');
  assert.strictEqual(r.logins[0].password, 'hunter2 ünï');
});
test('Firefox logins CSV export', () => {
  const csv = '﻿"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\r\n' +
    '"https://x.com","me","p,a""ss","","https://x.com","{1}","1","1","1"\r\n"https://y.com","","pw","","","{2}","1","1","1"\r\n';
  const l = firefox.loginsFromCsv(csv);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].password, 'p,a"ss');
});
test('profiles.ini parsing', () => {
  const s = firefox._internal.parseIni('[Install123]\nDefault=Profiles/abc.default-release\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n');
  assert.strictEqual(s[1].Path, 'Profiles/abc.default-release');
});

// ---------------- parsers ----------------
const iqdb = require('../src/main/lookup/iqdb');
test('IQDB result page parsing', () => {
  const html = `<div id='pages'>
  <div><table><tr><th>Your image</th></tr><tr><td class='image'><img src='/thu/thu_abc.jpg'></td></tr><tr><td>800×600</td></tr></table></div>
  <div><table><tr><th>Best match</th></tr><tr><td class='image'><a href="//danbooru.donmai.us/posts/12345"><img src='/danbooru/1/2/x.jpg' alt="Rating: s Score: 10 Tags: hatsune_miku vocaloid 1girl" title="t" width='150' height='113'></a></td></tr>
  <tr><td><img class="service-icon" src="/icon/danbooru.ico">Danbooru <img class="service-icon" src="/icon/gelbooru.ico"><a href="https://gelbooru.com/index.php?page=post&amp;s=view&amp;id=99">Gelbooru</a></td></tr><tr><td>2400×1800 [Safe]</td></tr><tr><td>96% similarity</td></tr></table></div>
  <div><table><tr><th>Additional match</th></tr><tr><td class='image'><a href="https://yande.re/post/show/777"><img src='/moe/a.jpg' alt="Rating: q Score: 1 Tags: x"></a></td></tr><tr><td>yande.re</td></tr><tr><td>1600×1200 [Ero]</td></tr><tr><td>71% similarity</td></tr></table></div>
  </div>`;
  const r = iqdb.parse(html);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].url, 'https://danbooru.donmai.us/posts/12345');
  assert.strictEqual(r[0].similarity, 96);
  assert.strictEqual(r[0].width, 2400);
  assert.strictEqual(r[0].ids.danbooru, 12345);
  assert.ok(r[0].tags.includes('hatsune_miku'));
  assert.strictEqual(r[1].ids.yandere, 777);
  assert.strictEqual(r[1].site, 'yande.re');
});
const ascii2d = require('../src/main/lookup/ascii2d');
test('ascii2d result page parsing', () => {
  const html = `<div class='row item-box'><div class='col-xs-12 col-sm-12 col-md-4 col-xl-4 text-xs-center image-box'><img src="/thumbnail/a/b/c/d/abc.jpg"></div>
  <div class='col-xs-12 col-sm-12 col-md-8 col-xl-8 info-box'><div class='hash'>abc</div><small class='text-muted'>800x600 JPEG 100.0KB</small></div></div>
  <div class='row item-box'><div class='image-box'><img src="/thumbnail/x.jpg"></div><div class='info-box'><div class='hash'>def</div><small class='text-muted'>2048x1536 PNG 3.1MB</small>
  <div class='detail-box gray-link'><h6><img src="/assets/pixiv.ico"><a target="_blank" rel="noopener" href="https://www.pixiv.net/artworks/1111">Work title</a><a target="_blank" rel="noopener" href="https://www.pixiv.net/users/22">Artist Name</a><small>pixiv</small></h6></div></div></div>`;
  const r = ascii2d.parse(html, 'color');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, 'https://www.pixiv.net/artworks/1111');
  assert.deepStrictEqual(r[0].artists, ['Artist Name']);
  assert.strictEqual(r[0].width, 2048);
  assert.strictEqual(r[0].site, 'pixiv');
});
const saucenao = require('../src/main/lookup/saucenao');
test('SauceNAO result normalising', () => {
  const r = saucenao.normalizeResult({
    header: { similarity: '93.5', thumbnail: 't', index_id: 9, index_name: 'Index #9: Danbooru - 123.jpg' },
    data: { ext_urls: ['https://danbooru.donmai.us/post/show/123'], danbooru_id: 123, creator: 'artist_a', material: 'genshin impact', characters: 'raiden shogun, yae miko', source: 'https://twitter.com/x/status/1' },
  });
  assert.strictEqual(r.site, 'Danbooru');
  assert.strictEqual(r.similarity, 93.5);
  assert.deepStrictEqual(r.characters, ['raiden shogun', 'yae miko']);
  assert.strictEqual(r.ids.danbooru, 123);
  assert.strictEqual(r.links.length, 2);
});
const { buildGuess } = require('../src/main/lookup/guess');
test('best guess and larger-version detection', () => {
  const res = [
    { engine: 'saucenao', site: 'Danbooru', similarity: 93, series: ['genshin impact'], characters: ['raiden shogun'], artists: ['artist_a'], booru: { series: ['Genshin Impact'], characters: ['Raiden Shogun'], artists: ['artist a'], width: 3000, height: 4000 } },
    { engine: 'iqdb', site: 'Gelbooru', similarity: 90, width: 1500, height: 2000 },
    { engine: 'saucenao', site: 'Pixiv', similarity: 40, series: ['wrong series'] },
  ];
  const g = buildGuess(res, { saucenao: 70, iqdb: 80 }, { width: 750, height: 1000 });
  assert.strictEqual(g.guess.series[0].name, 'Genshin Impact');
  assert.ok(!g.guess.series.find((s) => /wrong/i.test(s.name)), 'low similarity ignored');
  assert.strictEqual(g.guess.characters[0].name, 'Raiden Shogun');
  assert.strictEqual(g.bigger.width, 3000);
});
const { searchObject, searchText } = require('../src/main/keyimport');
test('Collection Sorter key detection', () => {
  const key = 'a'.repeat(20) + '0123456789abcdef0123';
  assert.strictEqual(searchObject({ lookups: { saucenao: { apiKey: key } } }), key);
  assert.strictEqual(searchObject({ saucenao_api_key: key }), key);
  assert.strictEqual(searchText(`SAUCENAO_KEY = "${key}"`), key);
  assert.strictEqual(searchObject({ other: key }), null);
});
const { originalCandidates } = (() => {
  // browser.js needs electron's main-process APIs; only load the pure helper.
  const src = fs.readFileSync(path.join(__dirname, '../src/main/browser.js'), 'utf8');
  const fn = src.slice(src.indexOf('function originalCandidates'), src.indexOf('module.exports'));
  return { originalCandidates: new Function(fn + '; return originalCandidates;')() };
})();
test('original-size URL rewriting', () => {
  assert.deepStrictEqual(originalCandidates('https://pbs.twimg.com/media/AbC123?format=jpg&name=small'), ['https://pbs.twimg.com/media/AbC123?format=jpg&name=orig']);
  assert.strictEqual(originalCandidates('https://i.pximg.net/img-master/img/2024/01/02/03/04/05/1234_p0_master1200.jpg')[0], 'https://i.pximg.net/img-original/img/2024/01/02/03/04/05/1234_p0.png');
  assert.strictEqual(originalCandidates('https://cdn.donmai.us/sample/ab/cd/sample-abcdefabcdefabcdefabcdefabcdefab.jpg')[0], 'https://cdn.donmai.us/original/ab/cd/abcdefabcdefabcdefabcdefabcdefab.png');
  assert.deepStrictEqual(originalCandidates('https://example.com/a.jpg'), []);
});
const { multipart } = require('../src/main/lookup/multipart');
test('multipart body', () => {
  const m = multipart([{ name: 'a', value: '1' }, { name: 'file', filename: 'x.jpg', contentType: 'image/jpeg', data: Buffer.from([1, 2, 3]) }]);
  const s = m.body.toString('latin1');
  assert.ok(s.includes('name="file"; filename="x.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\x01\x02\x03\r\n'));
  assert.ok(s.endsWith(`--${m.boundary}--\r\n`));
});

// ---------------- library: sort, undo, keep, relink ----------------
function makeLib() {
  const { Library } = require('../src/main/library');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  for (const n of ['one.jpg', 'two.png', 'three.jpg']) fs.copyFileSync(path.join(FX, n === 'two.png' ? 'a.png' : 'q85.jpg'), path.join(src, n));
  const paths = { data: path.join(root, 'Data') };
  fs.mkdirSync(paths.data);
  const st = { downloadsDir: path.join(root, 'Downloads'), sortRoot: path.join(root, 'Sorted') };
  const lib = new Library(paths, { get: () => st }, () => {});
  return { lib, root, src, st };
}

test('library flow: sort, undo, compare-keep, relink, done', async () => {
  const { lib, src, st } = makeLib();
  const r = await lib.addBatch(src, false);
  assert.strictEqual(r.added, 3);
  const again = await lib.addBatch(src, false);
  assert.strictEqual(again.added, 0, 'no duplicates');
  const items = Object.values(lib.d.items).sort((a, b) => a.name.localeCompare(b.name));
  const [one, three, two] = items;
  assert.strictEqual(one.width, 640);

  // sort the original straight away with NSFW/Very, then undo
  const e1 = await lib.sortFile({ kind: 'item', id: one.id }, 'Genshin Impact', { nsfw: true, very: true });
  assert.ok(fs.existsSync(path.join(st.sortRoot, 'Genshin Impact', 'NSFW', 'Very', 'one.jpg')));
  assert.strictEqual(lib.item(one.id).status, 'done');
  await lib.undoSort(e1.id);
  assert.ok(fs.existsSync(path.join(src, 'one.jpg')));
  assert.notStrictEqual(lib.item(one.id).status, 'done');

  // same file: download two versions, keep one, sort it -> done, folder removed
  const folder = lib.itemFolder(lib.item(two.id));
  fs.mkdirSync(folder, { recursive: true });
  const p1 = path.join(folder, 'big.png'), p2 = path.join(folder, 'other.jpg');
  fs.copyFileSync(path.join(FX, 'a.png'), p1);
  fs.copyFileSync(path.join(FX, 'q60.jpg'), p2);
  const d1 = lib.addDownload({ itemId: two.id, path: p1, name: 'big.png' });
  const d2 = lib.addDownload({ itemId: two.id, path: p2, name: 'other.jpg' });
  await lib.finishDownload(d1.id, 'completed');
  await lib.finishDownload(d2.id, 'completed');
  assert.strictEqual(lib.item(two.id).phase, 'compare');
  await lib.applyKeep(two.id, [d1.id]);
  assert.ok(!fs.existsSync(p2) && !fs.existsSync(path.join(src, 'two.png')), 'unkept + original recycled');
  assert.notStrictEqual(lib.item(two.id).status, 'done');
  await lib.sortFile({ kind: 'download', id: d1.id }, 'Art', { nsfw: false });
  assert.ok(fs.existsSync(path.join(st.sortRoot, 'Art', 'big.png')));
  assert.strictEqual(lib.item(two.id).status, 'done');
  assert.ok(!fs.existsSync(folder), 'item download folder removed');

  // sort the original AND keep a download: not done until both are sorted
  const f3 = lib.itemFolder(lib.item(three.id));
  fs.mkdirSync(f3, { recursive: true });
  const p3 = path.join(f3, 'v.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), p3);
  const d3 = lib.addDownload({ itemId: three.id, path: p3, name: 'v.jpg' });
  await lib.finishDownload(d3.id, 'completed');
  await lib.sortFile({ kind: 'item', id: three.id }, 'Art', {});
  assert.notStrictEqual(lib.item(three.id).status, 'done', 'download still pending');
  await lib.sortFile({ kind: 'download', id: d3.id }, 'Art', {});
  assert.strictEqual(lib.item(three.id).status, 'done');

  // stray download: unlinked, then linked to an item, then unlinked again
  const un = lib.unlinkedFolder();
  fs.mkdirSync(un, { recursive: true });
  const p4 = path.join(un, 'stray.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), p4);
  const d4 = lib.addDownload({ itemId: null, path: p4, name: 'stray.jpg' });
  await lib.finishDownload(d4.id, 'completed');
  await lib.relinkDownload(d4.id, one.id);
  assert.ok(lib.d.downloads[d4.id].path.startsWith(lib.itemFolder(lib.item(one.id))));
  assert.deepStrictEqual(lib.item(one.id).downloads, [d4.id]);
  await lib.relinkDownload(d4.id, null);
  assert.ok(lib.d.downloads[d4.id].path.startsWith(un));
  assert.deepStrictEqual(lib.item(one.id).downloads, []);
  assert.ok(!fs.existsSync(lib.itemFolder(lib.item(one.id))), 'emptied item folder removed');
  lib.store.flush();
});

test('files moved or deleted outside the app are removed and logged', async () => {
  const { lib, src, st } = makeLib();
  await lib.addBatch(src, false);
  const items = Object.values(lib.d.items).sort((a, b) => a.name.localeCompare(b.name));
  const [one, three, two] = items;
  // a sorted file, an unlinked download and an original all go missing
  const e = await lib.sortFile({ kind: 'item', id: one.id }, 'Art', {});
  const un = lib.unlinkedFolder();
  fs.mkdirSync(un, { recursive: true });
  const pu = path.join(un, 'u.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), pu);
  const du = lib.addDownload({ itemId: null, path: pu, name: 'u.jpg' });
  await lib.finishDownload(du.id, 'completed');
  // item with a download: original removed but the download keeps it in the app
  const f = lib.itemFolder(lib.item(two.id));
  fs.mkdirSync(f, { recursive: true });
  const pd = path.join(f, 'v.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), pd);
  const dd = lib.addDownload({ itemId: two.id, path: pd, name: 'v.jpg' });
  await lib.finishDownload(dd.id, 'completed');

  fs.unlinkSync(path.join(st.sortRoot, 'Art', 'one.jpg'));
  fs.unlinkSync(pu);
  fs.unlinkSync(path.join(src, 'three.jpg'));
  fs.unlinkSync(path.join(src, 'two.png'));
  const n = await lib.checkMissing();
  assert.ok(n >= 4);
  assert.ok(!lib.item(three.id), 'original-only item removed');
  assert.ok(!lib.item(one.id), 'done item whose sorted file vanished removed');
  assert.ok(lib.item(two.id) && lib.item(two.id).originalMissing, 'item with downloads kept');
  assert.ok(!lib.d.downloads[du.id], 'vanished download removed');
  const entry = lib.d.sortLog.find((l) => l.id === e.id);
  assert.ok(entry.missingAt, 'sort entry marked missing');
  await assert.rejects(() => lib.undoSort(e.id), /can't be undone/);
  assert.strictEqual(lib.d.sortLog.filter((l) => l.kind === 'gone').length, 3);
  // after 30 days the missing lines are purged
  for (const l of lib.d.sortLog) { if (l.kind === 'gone') l.time -= 31 * 864e5; if (l.missingAt) l.missingAt -= 31 * 864e5; }
  await lib.checkMissing();
  assert.strictEqual(lib.d.sortLog.length, 0);
  // remaining download sorted -> the item is done
  await lib.sortFile({ kind: 'download', id: dd.id }, 'Art', {});
  assert.strictEqual(lib.item(two.id).status, 'done');
  lib.clearLog();
  assert.strictEqual(lib.d.sortLog.length, 0);
});

test('retry failed lookups, per site', () => {
  const { lib } = makeLib();
  lib.d.items.a = { id: 'a', name: 'a', path: 'x', status: 'looked', engines: { iqdb: 'error', saucenao: 'done', ascii2d: 'blocked' }, results: [], downloads: [] };
  lib.d.items.b = { id: 'b', name: 'b', path: 'y', status: 'looked', engines: { iqdb: 'done', ascii2d: 'blocked' }, results: [], downloads: [] };
  assert.deepStrictEqual(lib.failedCounts(), { all: 2, iqdb: 1, saucenao: 0, ascii2d: 2, tracemoe: 0 });
  assert.strictEqual(lib.requeueFailed('iqdb'), 1);
  assert.strictEqual(lib.d.items.a.engines.iqdb, undefined);
  assert.strictEqual(lib.d.items.a.engines.ascii2d, 'blocked');
  assert.strictEqual(lib.requeueFailed(null), 2);
  assert.strictEqual(lib.d.items.b.engines.ascii2d, undefined);
});

const old = (p) => { const t = new Date(Date.now() - 60000); fs.utimesSync(p, t, t); };

test('renamed and moved files are followed (option 1)', async () => {
  const { lib, src, st } = makeLib();
  await lib.addBatch(src, false);
  const items = Object.values(lib.d.items).sort((a, b) => a.name.localeCompare(b.name));
  const [one, three, two] = items;

  // 1. original renamed in place -> followed, not re-added as a new file
  fs.renameSync(path.join(src, 'one.jpg'), path.join(src, 'one-renamed.jpg'));
  let r = await lib.reconcile(null);
  assert.strictEqual(lib.item(one.id).path, path.join(src, 'one-renamed.jpg'));
  assert.strictEqual(r.added.length, 0, 'not picked up as a new file');
  assert.ok(lib.d.sortLog.some((l) => l.kind === 'moved' && l.renamed));

  // 2. original moved into the sort folder by hand -> counts as sorted (NSFW flag read from the path)
  fs.mkdirSync(path.join(st.sortRoot, 'Hololive', 'NSFW'), { recursive: true });
  fs.renameSync(path.join(src, 'three.jpg'), path.join(st.sortRoot, 'Hololive', 'NSFW', 'three.jpg'));
  await lib.reconcile([]);
  const t = lib.item(three.id);
  assert.strictEqual(t.status, 'done');
  const manual = lib.d.sortLog.find((l) => l.refId === three.id && l.manual);
  assert.strictEqual(manual.folder, 'Hololive');
  assert.strictEqual(manual.flags.nsfw, true);

  // 3. sorted by the app, then moved to another sorted folder -> log updated, undo still works
  const e = await lib.sortFile({ kind: 'item', id: two.id }, 'Art', {});
  fs.mkdirSync(path.join(st.sortRoot, 'Better Folder'), { recursive: true });
  fs.renameSync(e.to, path.join(st.sortRoot, 'Better Folder', 'two-final.png'));
  await lib.reconcile([]);
  const entry = lib.d.sortLog.find((l) => l.id === e.id);
  assert.strictEqual(entry.folder, 'Better Folder');
  assert.ok(!entry.missingAt && entry.moves.length === 1);
  await lib.undoSort(e.id);
  assert.ok(fs.existsSync(path.join(src, 'two.png')), 'undo moved it back from the new place');

  // 4. sorted file moved back out of the sort folder -> un-sorted
  const e2 = await lib.sortFile({ kind: 'item', id: two.id }, 'Art', {});
  const outside = path.join(path.dirname(src), 'elsewhere');
  fs.mkdirSync(outside);
  fs.renameSync(e2.to, path.join(outside, 'two.png'));
  lib.index = null; // outside the watched folders: found via the folder watcher
  lib.appeared = new Map([[await require('../src/main/library').fidOf(path.join(outside, 'two.png')), path.join(outside, 'two.png')]]);
  await lib.reconcile([]);
  assert.strictEqual(lib.item(two.id).originalSorted, false);
  assert.notStrictEqual(lib.item(two.id).status, 'done');
  assert.ok(lib.d.sortLog.find((l) => l.id === e2.id).movedOut);

  // 5. a download renamed in its folder is followed
  const f = lib.itemFolder(lib.item(one.id));
  fs.mkdirSync(f, { recursive: true });
  const pd = path.join(f, 'v.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), pd);
  const d = lib.addDownload({ itemId: one.id, path: pd, name: 'v.jpg' });
  await lib.finishDownload(d.id, 'completed');
  fs.renameSync(pd, path.join(f, 'v-big.jpg'));
  await lib.reconcile([]);
  assert.strictEqual(lib.d.downloads[d.id].name, 'v-big.jpg');
});

test('new images in an added folder are picked up', async () => {
  const { lib, src } = makeLib();
  await lib.addBatch(src, false);
  assert.strictEqual(Object.keys(lib.d.items).length, 3);
  const n1 = path.join(src, 'new.png');
  fs.copyFileSync(path.join(FX, 'a.png'), n1);
  old(n1); // copies keep the old modified time (as on Windows)
  const busy = path.join(src, 'copying.jpg');
  fs.copyFileSync(path.join(FX, 'q85.jpg'), busy);
  old(busy);
  const sub = path.join(src, 'sub');
  fs.mkdirSync(sub);
  fs.copyFileSync(path.join(FX, 'q85.jpg'), path.join(sub, 'deep.jpg'));
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  let r = await lib.reconcile([n1, busy, path.join(sub, 'deep.jpg')]);
  assert.deepStrictEqual(r.added.map((i) => i.name), [], 'just-created files wait for a second look');
  fs.appendFileSync(busy, Buffer.alloc(100)); // still being written
  await wait(1600);
  r = await lib.reconcile([]);
  assert.deepStrictEqual(r.added.map((i) => i.name), ['new.png'], 'stable file taken; growing file and subfolder skipped');
  await wait(1600);
  r = await lib.reconcile([]);
  assert.deepStrictEqual(r.added.map((i) => i.name), ['copying.jpg'], 'settled file picked up');
  // full rescan finds nothing more; re-adding the folder with subfolders picks up the deep one
  r = await lib.reconcile(null);
  assert.strictEqual(r.added.length, 0);
  const again = await lib.addBatch(src, true);
  assert.strictEqual(again.added, 1);
  assert.strictEqual(lib.d.batches.length, 1, 'same folder reuses its entry');
  // turned off
  lib.settings.get().autoAdd = false;
  const n2 = path.join(src, 'n2.png');
  fs.copyFileSync(path.join(FX, 'a.png'), n2);
  r = await lib.reconcile(null);
  await wait(1600);
  r = await lib.reconcile(null);
  assert.strictEqual(r.added.length, 0);
});

// ---------------- library: the input folder is renamed or moved ----------------
// Each file keeps its lookup results: the folder is found again by its folder ID, or failing that
// by the names of the files inside it, and otherwise the person points the app at it by hand.
const tagResults = (lib) => {
  for (const it of Object.values(lib.d.items)) {
    it.results = [{ engine: 'iqdb', url: 'https://danbooru.donmai.us/posts/1', similarity: 93 }];
    it.guess = { series: 'Hololive', character: 'Pekora' };
    it.engines = { iqdb: 'done' };
    it.status = 'done';
  }
};

test('renamed input folder is found again by its folder ID, with results kept', async () => {
  const { lib, root, src } = makeLib();
  await lib.addBatch(src, false);
  tagResults(lib);
  const b = lib.d.batches[0];
  assert.ok(b.fid, 'the folder ID is recorded when the folder is added');
  const moved = path.join(root, 'renamed pics');
  fs.renameSync(src, moved);
  const r = await lib.checkMissing();
  void r;
  assert.strictEqual(lib.d.batches[0].folder, moved, 'the batch points at the new path');
  assert.strictEqual(lib.d.batches[0].name, 'renamed pics');
  assert.ok(!lib.d.batches[0].missing);
  const items = Object.values(lib.d.items);
  assert.strictEqual(items.length, 3, 'all three files are still there');
  for (const it of items) {
    assert.strictEqual(path.dirname(it.path), moved, it.name + ' has the new path');
    assert.ok(fs.existsSync(it.path));
    assert.strictEqual(it.status, 'done');
    assert.strictEqual(it.guess.character, 'Pekora', 'the lookup result is kept');
  }
  assert.ok(lib.d.sortLog.some((l) => l.kind === 'folder'), 'the move is noted in the log');
});

test('moved folder with no recorded ID is found by the names of its files', async () => {
  const { lib, root, src } = makeLib();
  await lib.addBatch(src, false);
  tagResults(lib);
  delete lib.d.batches[0].fid; // a folder added by an older version
  const deep = path.join(root, 'Pictures', 'art', 'to sort');
  fs.mkdirSync(path.dirname(deep), { recursive: true });
  fs.renameSync(src, deep);
  await lib.checkMissing();
  assert.strictEqual(lib.d.batches[0].folder, deep);
  assert.strictEqual(Object.keys(lib.d.items).length, 3);
  assert.strictEqual(Object.values(lib.d.items)[0].guess.character, 'Pekora');
});

test('a folder that can\'t be found is flagged, not emptied, and relinks by hand', async () => {
  const { lib, root, src } = makeLib();
  await lib.addBatch(src, false);
  tagResults(lib);
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'away-'));
  const moved = path.join(away, 'elsewhere');
  fs.renameSync(src, moved);
  lib.d.batches[0].fid = '0:0'; // pretend the ID no longer matches, so only a manual fix is left
  const before = JSON.stringify(lib.d.batches[0].folder);
  await lib.checkMissing();
  const b = lib.d.batches[0];
  assert.ok(b.missing, 'the folder is flagged as missing');
  assert.strictEqual(JSON.stringify(b.folder), before, 'the old path is kept so it can be shown');
  assert.strictEqual(Object.keys(lib.d.items).length, 3, 'no files are dropped while the folder is missing');
  assert.strictEqual((await lib.findMissingFolders()).found, null, 'and it genuinely cannot be found');

  assert.deepStrictEqual(await lib.folderLooksRight(b.id, moved), { known: 3, matched: 3 }, 'the right folder is recognised');
  assert.strictEqual((await lib.folderLooksRight(b.id, away)).matched, 0, 'a folder with none of the files is not');

  const r = await lib.relocateBatch(b.id, moved);
  assert.ok(r.ok !== false);
  const nb = lib.d.batches[0];
  assert.strictEqual(nb.folder, moved);
  assert.ok(!nb.missing, 'the flag is cleared');
  const items = Object.values(lib.d.items);
  assert.strictEqual(items.length, 3);
  for (const it of items) {
    assert.strictEqual(path.dirname(it.path), moved);
    assert.strictEqual(it.guess.character, 'Pekora', 'results survive a manual relink');
    assert.ok(!it.originalMissing);
  }
  void root;
});

test('a file deleted and put back keeps its results, and backups can be restored', async () => {
  const { lib, src } = makeLib();
  await lib.addBatch(src, false);
  tagResults(lib);
  const p = path.join(src, 'one.jpg');
  const keep = fs.readFileSync(p);
  fs.unlinkSync(p);
  await lib.checkMissing();
  assert.strictEqual(Object.keys(lib.d.items).length, 2, 'the missing file is removed');
  assert.ok((lib.d.removed || []).some((x) => x.item.name === 'one.jpg'), 'it is remembered in case it comes back');
  fs.writeFileSync(p, keep);
  const r = await lib.addFiles(lib.d.batches[0], [p]);
  assert.strictEqual(r.length, 1);
  const back = Object.values(lib.d.items).find((i) => i.name === 'one.jpg');
  assert.ok(back, 'the file is back');
  assert.strictEqual(back.guess.character, 'Pekora', 'its earlier lookup is reused instead of looking it up again');
  assert.strictEqual(back.status, 'looked', 'and it goes back to waiting to be sorted, not to be looked up');

  const file = await lib.backup('manual');
  assert.ok(file, 'a backup is written');
  const list = await lib.listBackups();
  assert.ok(list.length >= 1 && list[0].items === 3, 'the backup lists its contents');
  for (const it of Object.values(lib.d.items)) lib.forgetItem(it.id);
  assert.strictEqual(Object.keys(lib.d.items).length, 0);
  const res = await lib.restoreBackup(list[0].file);
  assert.strictEqual(res.items, 3, 'restoring brings the file list back');
});

test('an entry kept for its downloads is combined with the same file after a folder rename', async () => {
  const { lib, root, src } = makeLib();
  await lib.addBatch(src, false);
  tagResults(lib);
  const one = Object.values(lib.d.items).find((i) => i.name === 'one.jpg');
  // v1.3.0 state: the original is "missing" but kept because it has a download, at a stale path.
  const dl = lib.addDownload({ itemId: one.id, path: path.join(root, 'dl.jpg'), name: 'dl.jpg', url: 'https://x/y.jpg', total: 1 });
  fs.writeFileSync(dl.path, 'x');
  one.downloads = [dl.id];
  one.originalMissing = true;
  one.path = path.join(root, 'old name that is gone', 'one.jpg');
  const moved = path.join(root, 'renamed');
  fs.renameSync(src, moved);
  lib.d.batches[0].folder = moved; // as if the folder was already found
  // a fresh entry for the same file appears (what the re-scan used to do)
  const added = await lib.addFiles(lib.d.batches[0], fs.readdirSync(moved).map((n) => path.join(moved, n)));
  assert.ok(added.includes(one), 'the old entry is reused');
  const ones = Object.values(lib.d.items).filter((i) => i.name === 'one.jpg');
  assert.strictEqual(ones.length, 1, 'no duplicate');
  assert.strictEqual(ones[0].id, one.id);
  assert.strictEqual(ones[0].path, path.join(moved, 'one.jpg'));
  assert.ok(!ones[0].originalMissing);
  assert.deepStrictEqual(ones[0].downloads, [dl.id], 'its download is still linked');
  assert.strictEqual(ones[0].guess.character, 'Pekora', 'and its results');

  // already doubled: an old entry and a fresh one side by side get folded together
  const fresh = { ...JSON.parse(JSON.stringify(ones[0])), id: 'dup1', downloads: [], results: [], guess: undefined, status: 'queued', engines: {} };
  ones[0].originalMissing = true;
  ones[0].path = path.join(root, 'gone', 'one.jpg');
  lib.d.items.dup1 = fresh;
  const n = await lib.healStale();
  assert.strictEqual(n, 1);
  assert.strictEqual(Object.values(lib.d.items).filter((i) => i.name === 'one.jpg').length, 1);
  assert.ok(!lib.d.items.dup1, 'the fresh copy is gone');
  assert.strictEqual(lib.d.items[one.id].path, path.join(moved, 'one.jpg'));
  assert.deepStrictEqual(lib.d.items[one.id].downloads, [dl.id]);
});

const iqdbMod = require('../src/main/lookup/iqdb');
test('IQDB busy page is retried later, not failed', async () => {
  const fake = (html, status = 200) => async () => ({ status, ok: status < 400, text: async () => html });
  await assert.rejects(() => iqdbMod.search(fake('<html><body>IQDB is experiencing heavy load. You are in queue position 12.</body></html>'), { filename: 'a.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(3) }), iqdbMod.BusyError);
  await assert.rejects(() => iqdbMod.search(fake('', 503), { filename: 'a.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(3) }), iqdbMod.BusyError);
  await assert.rejects(() => iqdbMod.search(fake('<p>Not an image or image format not supported</p>'), { filename: 'a.jpg', mime: 'image/jpeg', buffer: Buffer.alloc(3) }), /could not read/);
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n    ')); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
