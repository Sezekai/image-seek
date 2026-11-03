'use strict';
// Folder layout:
//   <root>\App\ImageSeek.exe   (replaceable with each version)
//   <root>\Data\               (settings, library, browser profile, logins, caches)
//   <root>\Downloads\          (default, changeable in Settings)
//   <root>\Sorted\             (default, changeable in Settings)
// If the exe isn't inside a folder called "App", <root> is the exe's own folder.
const path = require('path');
const fs = require('fs');

function exeDir(app) {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(process.execPath);
  return path.join(app.getAppPath(), 'dev-root', 'App');
}

function resolvePaths(app) {
  const dir = exeDir(app);
  const root = path.basename(dir).toLowerCase() === 'app' ? path.dirname(dir) : dir;
  const data = path.join(root, 'Data');
  const p = {
    root,
    data,
    browser: path.join(data, 'Browser'),
    extensions: path.join(data, 'Extensions'),
    cache: path.join(data, 'Cache'),
    thumbs: path.join(data, 'Cache', 'Thumbs'),
    defaultDownloads: path.join(root, 'Downloads'),
    defaultSorted: path.join(root, 'Sorted'),
  };
  for (const k of ['data', 'browser', 'extensions', 'cache', 'thumbs']) {
    fs.mkdirSync(p[k], { recursive: true });
  }
  return p;
}

module.exports = { resolvePaths };
