'use strict';
const crypto = require('crypto');

// Builds a multipart/form-data body as a Buffer.
// fields: [{ name, value }] or [{ name, filename, contentType, data: Buffer }]
function multipart(fields) {
  const boundary = '----ImageSeek' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename !== undefined) {
      head += `; filename="${String(f.filename).replace(/"/g, '_')}"\r\nContent-Type: ${f.contentType || 'application/octet-stream'}`;
    }
    head += '\r\n\r\n';
    parts.push(Buffer.from(head, 'utf8'));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.value == null ? '' : f.value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function absUrl(u, base) {
  if (!u) return u;
  u = decodeEntities(u);
  if (u.startsWith('//')) return 'https:' + u;
  try { return new URL(u, base).toString(); } catch { return u; }
}

module.exports = { multipart, decodeEntities, absUrl };
