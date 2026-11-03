'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.jfif', '.tif', '.tiff']);

function isImage(file) {
  return IMAGE_EXTS.has(path.extname(file).toLowerCase());
}

function sanitizeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'file';
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Returns a path in dir for name that doesn't exist yet: "a.jpg", "a (2).jpg", ...
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

function uniquePathSync(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

// Move a file, creating the destination folder. Falls back to copy+delete across drives.
async function moveFile(src, destDir, keepName) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = await uniquePath(destDir, keepName || path.basename(src));
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
  return dest;
}

async function moveToExact(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (await exists(dest)) throw new Error('A file already exists at ' + dest);
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
  return dest;
}

async function listImages(folder, recursive) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < 12) await walk(full, depth + 1);
      } else if (e.isFile() && isImage(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(folder, 0);
  out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return out;
}

async function isDirEmpty(dir) {
  try { return (await fsp.readdir(dir)).length === 0; } catch { return false; }
}

module.exports = { isImage, sanitizeName, exists, uniquePath, uniquePathSync, moveFile, moveToExact, listImages, isDirEmpty, IMAGE_EXTS };
