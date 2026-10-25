// Transplant shell per the recommendation (isolated world, all frames, document_start).
// Derived from synth/shell5.js + the recommended frame.js navigate routing (document_start in the card).
(() => {
  const R = (o) => { try { window.webkit.messageHandlers.r.postMessage(JSON.stringify(Object.assign({ t: Math.round(performance.now()), top: window.top === window, href: location.href }, o))); } catch (e) {} };
  const REBUILD = window.__REBUILD || 'hidden';
  if (window.top !== window) {
    let mine = false; try { mine = window.parent === window.top && window.frameElement?.__marginShellFrame === true; } catch (e) {}
    if (!mine || location.href === 'about:srcdoc') return;
    R({ ev: 'frame-cs' });
    // frame.js (a): route every cross-document, cancelable navigation to the top.
    window.navigation?.addEventListener('navigate', (e) => {
      R({ ev: 'frame-navigate', url: e.destination.url, type: e.navigationType, same: e.destination.sameDocument, hash: e.hashChange, cancelable: e.cancelable, user: e.userInitiated, form: !!e.formData });
      if (e.destination.sameDocument || e.hashChange || e.downloadRequest || !e.cancelable) return;
      e.preventDefault();
      const form = e.sourceElement && (e.sourceElement.form || (e.sourceElement.tagName === 'FORM' ? e.sourceElement : null));
      const types = {}; if (form) for (const el of form.elements) if (el.name) types[el.name] = el.type;
      window.top.__marginNav({ url: e.destination.url, type: e.navigationType, entries: e.formData ? [...e.formData.entries()].filter(([, v]) => typeof v === 'string') : null, enctype: form ? form.enctype : null, types });
    });
    addEventListener('load', () => R({ ev: 'frame-load' }));
    return;
  }
  const old = document.documentElement;
  if (!old || old.childNodes.length || document.contentType !== 'text/html' || window.__marginShell) { R({ ev: 'skip', kids: old && old.childNodes.length }); return; }
  window.__marginShell = true;
  R({ ev: 'takeover' });
  const shell = document.createElement('html');
  const head = shell.appendChild(document.createElement('head'));
  const body = shell.appendChild(document.createElement('body'));
  shell.setAttribute('data-margin-shell', '');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('html,body{margin:0;height:100%;background:#334} iframe{position:fixed;top:8px;left:268px;width:calc(100% - 276px);height:calc(100% - 16px);border:0;border-radius:8px}');
  const hold = new CSSStyleSheet(); hold.replaceSync('html{visibility:hidden}');
  document.adoptedStyleSheets = window.__HOLD ? [sheet, hold] : [sheet];
  const frame = document.createElement('iframe');
  frame.__marginShellFrame = true; frame.name = 'm' + Math.random().toString(36).slice(2);
  frame.srcdoc = '<!doctype html><title></title>';
  frame.allowFullscreen = true;
  body.appendChild(frame);
  if (window.__SIDEBAR) { const host = body.appendChild(document.createElement('div')); host.className = 'sb'; const sr = host.attachShadow({ mode: 'closed' }); const sbs = new CSSStyleSheet(); sbs.replaceSync(':host{position:fixed;left:0;top:0;width:260px;height:100%;overflow:hidden;color:#eee;font:13px sans-serif}div{padding:4px 10px}'); sr.adoptedStyleSheets = [sbs]; for (let i = 0; i < 30; i++) { const d = document.createElement('div'); d.textContent = 'Tab ' + i + ' - Some open page title'; sr.appendChild(d); } }
  document.replaceChild(shell, old);
  const frameReady = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  const mirror = () => {
    const t = old.querySelector('title'); if (t && document.title !== t.textContent) document.title = t.textContent;
    for (const l of old.querySelectorAll('link[rel~=icon]')) if (!l.__copied) { l.__copied = true; head.appendChild(l.cloneNode()); }
  };
  new MutationObserver(mirror).observe(old, { childList: true, subtree: true, characterData: true });
  let ownTopNav = false;
  window.__marginNav = (n) => {
    R({ ev: 'to-top', url: n.url, type: n.type, post: !!n.entries });
    ownTopNav = true;
    if (n.type === 'reload') return location.reload();
    if (n.entries) {
      const f = document.createElement('form'); f.method = 'post'; f.action = n.url; if (n.enctype) f.enctype = n.enctype;
      for (const [k, v] of n.entries) { const i = document.createElement('input'); i.type = REBUILD === 'typed' ? (n.types[k] || 'hidden') : 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
      f.hidden = true; body.appendChild(f); f.submit(); return;
    }
    location.assign(n.url);
  };
  window.navigation?.addEventListener('navigate', (e) => {
    if (ownTopNav || e.destination.sameDocument) return;
    if (e.cancelable && e.destination.url === location.href && e.navigationType !== 'reload') { e.preventDefault(); R({ ev: 'bust-blocked' }); }
  });
  document.addEventListener('DOMContentLoaded', async () => {
    mirror();
    await frameReady;
    const w = frame.contentWindow, d = frame.contentDocument;
    const attrs = [...old.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    d.open(); d.write(`<!doctype html><html${attrs}>${old.getHTML ? old.getHTML() : old.innerHTML}</html>`); d.close();
    if (location.hash) w.location.replace(location.href);
    R({ ev: 'transplanted', frameURL: d.URL, iw: w.innerWidth });
    w.focus();
    if (window.__HOLD) {
      const links = [...d.querySelectorAll('link[rel~=stylesheet]')];
      await Promise.all(links.map((l) => l.sheet ? 0 : new Promise((r) => { l.addEventListener('load', r, { once: true }); l.addEventListener('error', r, { once: true }); })));
      await new Promise((r) => w.requestAnimationFrame(() => r()));
      document.adoptedStyleSheets = [sheet]; R({ ev: 'unhold' });
    }
  }, { once: true });
})();
