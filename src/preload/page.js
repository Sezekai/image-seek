'use strict';
// Runs in web pages inside the in-app browser: dark mode (Dark Reader) and login autofill.
const { ipcRenderer, webFrame } = require('electron');

let config = { dark: false, autofill: false };
try { config = ipcRenderer.sendSync('page:config', location.href) || config; } catch (_) { /* ignore */ }

// ---------- mouse back / forward buttons ----------
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); ipcRenderer.send('page:mousenav', 'back'); }
  else if (e.button === 4) { e.preventDefault(); ipcRenderer.send('page:mousenav', 'forward'); }
}, true);

// ---------- '/' jumps to Image Seek's sort box (when you're not typing on the page) ----------
window.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (typing) return;
  e.preventDefault();
  e.stopPropagation();
  ipcRenderer.send('page:hotkey', '/');
}, true);

// ---------- scrollbars: thin, no track background (matches the app) ----------
try {
  webFrame.insertCSS('::-webkit-scrollbar{width:10px;height:10px;background:transparent}' +
    '::-webkit-scrollbar-track,::-webkit-scrollbar-corner,::-webkit-scrollbar-track-piece{background:transparent}' +
    '::-webkit-scrollbar-button{display:none;width:0;height:0}' +
    '::-webkit-scrollbar-thumb{background-color:rgba(128,128,128,.45);border-radius:10px;border:2px solid transparent;background-clip:padding-box}' +
    '::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.7)}');
} catch (_) { /* ignore */ }

// ---------- dark mode ----------
// Dark Reader is started as soon as the page's document exists (the preload runs before that,
// which is why it used to fail silently). An early dark background avoids a white flash.
if (config.dark && window.top === window) {
  try {
    webFrame.insertCSS('html, body { background-color: #181a1b !important; } html { color-scheme: dark; }');
    const code = ipcRenderer.sendSync('page:darkreader');
    webFrame.executeJavaScript(
      '(function(){var exports, module, define;' + code +
      '\n;try{DarkReader.setFetchMethod(window.fetch.bind(window));}catch(e){}' +
      'var go=function(){ if(!document.documentElement) return false; try{ DarkReader.enable({brightness:100,contrast:95,sepia:0}); }catch(e){ console.warn("Dark Reader:", e && e.message); } return true; };' +
      'if(!go()){ var mo=new MutationObserver(function(){ if(go()) mo.disconnect(); }); mo.observe(document,{childList:true,subtree:true}); }' +
      '})();'
    ).catch(() => {});
  } catch (_) { /* ignore */ }
}

// ---------- autofill ----------
if (config.autofill) {
  let logins = null;
  let done = false;

  const fillScript = (u, p) => `(function(u,p){
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    function set(el,v){ if(!el) return; el.focus(); setter.call(el,v);
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    var pw = Array.prototype.slice.call(document.querySelectorAll('input[type=password]')).filter(function(e){return e.offsetParent!==null;})[0];
    var scope = (pw && pw.form) || document;
    var users = Array.prototype.slice.call(scope.querySelectorAll('input[type=email],input[type=text],input[autocomplete=username],input:not([type])'))
      .filter(function(e){return e.offsetParent!==null && !e.readOnly;});
    var user = null;
    if (pw) { for (var i=0;i<users.length;i++){ if (users[i].compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) user = users[i]; } }
    else user = users.filter(function(e){return /user|mail|login|name|id/i.test((e.name||'')+(e.id||'')+(e.autocomplete||''));})[0] || null;
    if (u && user && !user.value) set(user,u);
    if (p && pw && !pw.value) set(pw,p);
  })(${JSON.stringify(u)},${JSON.stringify(p)});`;

  function visibleLoginFields() {
    const pw = [...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null);
    const user = [...document.querySelectorAll('input[autocomplete=username],input[type=email]')].some((e) => e.offsetParent !== null);
    return pw || user;
  }

  function showPicker(list) {
    if (document.getElementById('__imageseek_picker')) return;
    const host = document.createElement('div');
    host.id = '__imageseek_picker';
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b{font:13px/1.3 system-ui,Segoe UI,sans-serif;background:#16181c;color:#e8e8ea;border:1px solid #2c2f36;border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:220px}
      .t{color:#9aa0aa;font-size:11px;margin:0 4px 6px}
      button{display:block;width:100%;text-align:left;background:#22252b;color:#e8e8ea;border:0;border-radius:7px;padding:7px 9px;margin-top:4px;cursor:pointer;font:inherit}
      button:hover{background:#2f6f3e}.x{background:none;color:#9aa0aa;text-align:right;padding:2px 4px}</style>
      <div class="b"><div class="t">Image Seek — fill saved login</div></div>`;
    const box = root.querySelector('.b');
    for (const l of list) {
      const btn = document.createElement('button');
      btn.textContent = l.username || '(no username)';
      btn.onclick = () => { webFrame.executeJavaScript(fillScript(l.username, l.password)); host.remove(); };
      box.appendChild(btn);
    }
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = 'Close';
    x.onclick = () => host.remove();
    box.appendChild(x);
    (document.body || document.documentElement).appendChild(host);
  }

  async function tryFill() {
    if (done || !visibleLoginFields()) return;
    if (!logins) logins = await ipcRenderer.invoke('page:logins', location.href).catch(() => []);
    if (!logins || !logins.length) { done = true; return; }
    done = true;
    if (logins.length === 1) webFrame.executeJavaScript(fillScript(logins[0].username, logins[0].password)).catch(() => {});
    else showPicker(logins);
  }

  window.addEventListener('DOMContentLoaded', () => {
    tryFill();
    // Single-page apps often render the login form later.
    const mo = new MutationObserver(() => { if (!done) tryFill(); else mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  });
}
