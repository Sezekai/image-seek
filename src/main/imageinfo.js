'use strict';
// Reads image dimensions and format from file headers (no decoding), and
// estimates JPEG quality from the quantisation tables.
const fs = require('fs');
const fsp = fs.promises;

// Standard JPEG luminance quantisation table (natural order, quality 50).
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
// Zigzag index -> natural index
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

function estimateJpegQuality(lumaZigzag) {
  const natural = new Array(64);
  for (let i = 0; i < 64; i++) natural[ZIGZAG[i]] = lumaZigzag[i];
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += (natural[i] * 100) / STD_LUMA[i];
  const s = sum / 64;
  let q = s <= 100 ? (200 - s) / 2 : 5000 / s;
  q = Math.max(1, Math.min(100, Math.round(q)));
  return q;
}

function parseJpeg(buf) {
  let off = 2;
  let w = 0, h = 0, quality = null, progressive = false;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(off + 2);
    const seg = off + 4;
    if (marker === 0xdb && quality === null) {
      // DQT: may hold several tables; take table id 0 (luminance)
      let p = seg;
      const end = off + 2 + len;
      while (p < end) {
        const pq = buf[p] >> 4, tq = buf[p] & 15;
        p++;
        const vals = [];
        for (let i = 0; i < 64; i++) {
          vals.push(pq ? buf.readUInt16BE(p + i * 2) : buf[p + i]);
        }
        p += pq ? 128 : 64;
        if (tq === 0) { quality = estimateJpegQuality(vals); break; }
      }
    }
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      h = buf.readUInt16BE(seg + 1);
      w = buf.readUInt16BE(seg + 3);
      progressive = marker === 0xc2;
    }
    off += 2 + len;
  }
  return { format: 'JPEG', width: w, height: h, quality, progressive };
}

function parseWebp(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { format: 'WebP', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, lossless: false };
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { format: 'WebP', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, lossless: true };
  }
  if (chunk === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    const animated = !!(buf[20] & 0x02);
    return { format: 'WebP', width: w, height: h, animated };
  }
  return { format: 'WebP', width: 0, height: 0 };
}

function parseAvif(buf) {
  // Find 'ispe' box: 4 bytes version/flags then width, height (uint32 BE)
  const idx = buf.indexOf('ispe');
  if (idx > 0 && idx + 16 <= buf.length) {
    return { format: 'AVIF', width: buf.readUInt32BE(idx + 8), height: buf.readUInt32BE(idx + 12) };
  }
  return { format: 'AVIF', width: 0, height: 0 };
}

function parseBuffer(buf) {
  if (buf.length < 12) return { format: 'Unknown', width: 0, height: 0 };
  if (buf[0] === 0xff && buf[1] === 0xd8) return parseJpeg(buf);
  if (buf.toString('ascii', 1, 4) === 'PNG') {
    return { format: 'PNG', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24] };
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'GIF', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return parseWebp(buf);
  if (buf.toString('ascii', 0, 2) === 'BM') {
    return { format: 'BMP', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(buf.toString('ascii', 8, 12))) return parseAvif(buf);
  return { format: 'Unknown', width: 0, height: 0 };
}

// Reads enough of the file to find dimensions. JPEG markers can be deep, so read up to 1 MB.
async function getImageInfo(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(stat.size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const info = parseBuffer(buf);
    info.size = stat.size;
    info.mtime = stat.mtimeMs;
    return info;
  } finally {
    await fh.close();
  }
}

module.exports = { getImageInfo, parseBuffer, estimateJpegQuality };
