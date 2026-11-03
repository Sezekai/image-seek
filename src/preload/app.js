'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Extension toolbar element (<browser-action-list>) for the in-app browser.
try {
  const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
  injectBrowserAction();
} catch (e) {
  console.error('browser action inject failed', e);
}

async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r) return undefined;
  if (!r.ok) throw new Error(r.error || 'Failed');
  return r.value;
}

const listeners = new Map();

contextBridge.exposeInMainWorld('api', {
  call,
  on(channel, cb) {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  send(channel, payload) { ipcRenderer.send(channel, payload); },
  startDrag(filePath) { ipcRenderer.send('drag:start', filePath); },
  pathForFile(file) { try { return webUtils.getPathForFile(file); } catch { return null; } },
});
void listeners;
