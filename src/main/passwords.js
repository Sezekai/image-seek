'use strict';
// Saved logins, encrypted with your Windows account (safeStorage / DPAPI) in Data\logins.dat.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

function originOf(u) {
  try {
    const url = new URL(u.includes('://') ? u : 'https://' + u);
    return url.origin;
  } catch { return null; }
}

function hostOf(u) {
  try { return new URL(u.includes('://') ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Registrable-ish domain: last two labels, or three for co.uk style suffixes.
function siteOf(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const two = parts.slice(-2).join('.');
  if (/^(co|com|net|org|ac|gov|ne|or)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
  return two;
}

class PasswordStore {
  constructor(paths) {
    this.file = path.join(paths.data, 'logins.dat');
    this.list = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file);
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      this.list = JSON.parse(text);
    } catch (e) {
      console.error('Could not read saved logins', e.message);
      this.list = [];
    }
  }

  save() {
    const text = JSON.stringify(this.list);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
    fs.writeFileSync(this.file + '.tmp', data);
    fs.renameSync(this.file + '.tmp', this.file);
  }

  // Adds or updates logins; returns counts.
  merge(logins, source) {
    let added = 0, updated = 0;
    for (const l of logins) {
      const origin = originOf(l.origin);
      if (!origin || !l.password) continue;
      const existing = this.list.find((x) => x.origin === origin && x.username === l.username);
      if (existing) {
        if (existing.password !== l.password) { existing.password = l.password; existing.updated = Date.now(); updated++; }
      } else {
        this.list.push({ origin, username: l.username || '', password: l.password, source, added: Date.now() });
        added++;
      }
    }
    this.save();
    return { added, updated, total: this.list.length };
  }

  forUrl(url) {
    const host = hostOf(url);
    if (!host) return [];
    const exact = this.list.filter((l) => hostOf(l.origin) === host);
    if (exact.length) return exact;
    const site = siteOf(host);
    return this.list.filter((l) => siteOf(hostOf(l.origin)) === site);
  }

  summary() {
    return this.list.map((l) => ({ origin: l.origin, username: l.username, source: l.source }));
  }

  remove(origin, username) {
    this.list = this.list.filter((l) => !(l.origin === origin && l.username === username));
    this.save();
  }

  clear() {
    this.list = [];
    this.save();
  }
}

module.exports = { PasswordStore, hostOf };
