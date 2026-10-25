// Margin iframe-shell prototype: TOP-frame side (document_start, isolated world).
//
// Turns the top-level document of https://site/x into a shell (sidebar + card) and loads
// https://site/x again in a same-origin <iframe> sized to the card. Test-only switches are
// read from the URL query or hash: margin-noshell, -stop, -open, -nostop, -nofocus, -nofallback, -narrow, -nonav.
(() => {
  'use strict';
  if (window.top !== window) return;

  const flags = new Set((location.search + location.hash).match(/margin-[a-z]+/g) || []);
  const LOG = [];
  const log = (ev, data = {}) => {
    LOG.push({ t: +performance.now().toFixed(1), ev, ...data });
    try { document.documentElement?.setAttribute('data-margin-log', JSON.stringify(LOG)); } catch {}
  };

  // ---------------------------------------------------------------- opt-outs
  if (flags.has('margin-noshell')) return log('skip', { why: 'hash' });
  if (document.contentType !== 'text/html') return; // images, PDFs, text, XML: leave alone
  let skip = null;
  try {
    const flagged = sessionStorage.getItem('margin:noshell');
    if (flagged) {
      sessionStorage.removeItem('margin:noshell');
      if (flagged === location.href) skip = 'flagged';
    }
  } catch {}
  // CSP `sandbox` without allow-same-origin gives the top document an opaque origin: the shell
  // could not read its own card (and sessionStorage throws, so the fallback could not mark the
  // URL either: measured reload loop in T7 before this check).
  if (!skip && self.origin === 'null') skip = 'opaque-origin';
  if (!skip && window.opener) skip = 'popup'; // keep window.opener for OAuth-style popups
  if (!skip) {
    // A DNR rule appends `Server-Timing: margin-post` to top-level POST responses (rules-post.json).
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav?.serverTiming?.some((s) => s.name === 'margin-post')) skip = 'post';
  }
  if (skip) return log('skip', { why: skip });

  // ---------------------------------------------------------------- stop the page
  const target = location.href;
  // How the original page is kept from running (see T8):
  //  openstop (default): document.open()/write()/close(), THEN window.stop(): page scripts never
  //                  run, the top-level response download is aborted, and the top still renders.
  //  swap:           replace the parser's <html> with the shell's; the parser keeps filling the
  //                  detached tree, where scripts/styles/meta never run (download continues).
  //  stop:           window.stop() first (Chromium then never renders the top document!)
  //  open:           document.open()/write()/close() (aborts the parser and the response body)
  //  nostop:         naive: add the shell to the parser's own <html> (page scripts still run)
  //  swapstop:       swap, then window.stop() once the shell has rendered (aborts the
  //                  duplicate download), then insert the card
  const mode = ['stop', 'open', 'nostop', 'stopopen', 'swap', 'swapstopraf', 'swapstoptimeout'].find((m) => flags.has('margin-' + m)) || 'openstop';
  if (mode === 'stop' || mode === 'stopopen') window.stop();
  if (mode === 'open' || mode === 'stopopen' || mode === 'openstop') { document.open(); document.write('<!doctype html><html><head></head><body></body></html>'); document.close(); }
  if (mode === 'openstop') window.stop();

  // ---------------------------------------------------------------- shell DOM
  const shell = document.createElement('html');
  shell.setAttribute('data-margin-shell', mode);
  const head = shell.appendChild(document.createElement('head'));
  const body = shell.appendChild(document.createElement('body'));
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    html, body { margin: 0; height: 100%; overflow: hidden; background: #dcdde0; }
    #margin-sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 260px; box-sizing: border-box;
      padding: 12px; font: 13px system-ui, sans-serif; color: #222; }
    #margin-sidebar input { width: 100%; box-sizing: border-box; }
    #margin-frame { position: fixed; left: 260px; top: 8px; width: calc(100% - 268px); height: calc(100% - 16px);
      border: 0; border-radius: 6.25px; background: #fff; box-shadow: 0 0 0 .5px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.12); }
  `);
  document.adoptedStyleSheets = [sheet];

  const sidebar = body.appendChild(document.createElement('div'));
  sidebar.id = 'margin-sidebar';
  const label = sidebar.appendChild(document.createElement('div'));
  label.id = 'margin-title';
  label.textContent = 'Margin';
  const input = sidebar.appendChild(document.createElement('input'));
  input.id = 'margin-input';
  input.placeholder = 'Search';
  const button = sidebar.appendChild(document.createElement('button'));
  button.id = 'margin-button';
  button.textContent = 'A button';

  const frame = document.createElement('iframe');
  frame.id = 'margin-frame';
  frame.__marginFrame = true; // per-world expando: visible to frame.js (same isolated world), not to the page
  frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; autoplay; encrypted-media; picture-in-picture; web-share; payment');
  frame.allowFullscreen = true;

  const old = document.documentElement;
  if (mode === 'nostop' && old) { old.setAttribute('data-margin-shell', mode); old.append(head, body); }
  else if (old) document.replaceChild(shell, old);
  else document.appendChild(shell);
  log('shell', { mode, target });
  requestAnimationFrame(() => log('first-raf'));

  // ---------------------------------------------------------------- frame state
  let ownTopNav = false; // set right before Margin itself navigates the top document
  let pending = null; // last same-origin URL the frame started to navigate to
  let bustedDoc = null; // frame document that tried to bust out
  let handoff = null;

  const frameInfo = () => {
    try {
      const w = frame.contentWindow;
      return { ok: true, href: w.location.href, title: w.document.title, doc: w.document, win: w };
    } catch {
      return { ok: false };
    }
  };

  const sync = (why) => {
    const i = frameInfo();
    if (!i.ok || i.href === 'about:blank') return;
    const before = location.href;
    if (i.href !== before) history.replaceState(history.state, '', i.href);
    if (i.title && document.title !== i.title) document.title = i.title;
    else if (!i.title && why !== 'start' && document.title !== i.href) document.title = i.href;
    const icon = i.doc.querySelector('link[rel~="icon"]');
    const iconHref = icon ? icon.href : new URL('/favicon.ico', i.href).href;
    let link = head.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; head.appendChild(link); }
    if (link.href !== iconHref) link.href = iconHref;
    const theme = i.doc.querySelector('meta[name="theme-color"]')?.content;
    if (theme) {
      let meta = head.querySelector('meta[name="theme-color"]');
      if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; head.appendChild(meta); }
      if (meta.content !== theme) meta.content = theme;
    }
    if (i.href !== before || why === 'load') log('sync', { why, href: i.href, title: document.title, changed: i.href !== before });
  };

  // Anti-clickjacking pages hide themselves until they are top (OWASP pattern). Once Margin has
  // blocked such a page's bust, it is Margin's own same-origin card, so show it.
  const unhide = () => {
    const i = frameInfo();
    if (!i.ok || i.doc !== bustedDoc) return;
    for (const el of [i.doc.documentElement, i.doc.body]) {
      if (el && i.win.getComputedStyle(el).display === 'none') {
        el.style.setProperty('display', 'block', 'important');
        log('unhide', { tag: el.tagName });
      }
    }
  };

  const focusFrame = (why) => {
    if (flags.has('margin-nofocus')) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== frame && sidebar.contains(a) && a.matches('input, textarea, [contenteditable]')) return;
    try { frame.contentWindow.focus(); log('focus', { why }); } catch {}
  };

  const fallback = (reason, url) => {
    log('fallback', { reason, url });
    if (flags.has('margin-nofallback')) return;
    try { sessionStorage.setItem('margin:noshell', url); } catch { return log('fallback-impossible'); } // never loop
    ownTopNav = true;
    location.replace(url);
  };

  // frame.js (same isolated world, in the frame) pings us; we re-read the frame ourselves.
  window.addEventListener('margin:frame', (e) => {
    const why = String(e.detail || '');
    if (why.startsWith('navigate ')) { pending = why.slice(9); return; }
    sync(why);
    if (why === 'dcl') { unhide(); focusFrame('dcl'); }
  });

  frame.addEventListener('load', () => {
    const i = frameInfo();
    log('frame-load', { ok: i.ok, href: i.ok ? i.href : null });
    if (i.ok) { sync('load'); unhide(); return; }
    // Not readable: either a cross-origin document (frame.js hands it off via postMessage, which
    // arrives long before `load`) or an error page (X-Frame-Options / frame-ancestors / network).
    setTimeout(() => { if (!handoff && !frameInfo().ok) fallback('frame-unreadable', pending || location.href); }, 50);
  });

  // Cross-origin document committed in the frame (server redirect, meta refresh, ...).
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.__margin !== 'xo-frame') return;
    if (frameInfo().ok) return; // the frame is same-origin: a forged message
    let u;
    try { u = new URL(e.data.url); } catch { return; }
    if (u.origin !== e.origin) return;
    handoff = u.href;
    log('handoff', { url: u.href });
    try { e.source.postMessage({ __margin: 'xo-ack' }, e.origin); } catch {}
    ownTopNav = true;
    location.replace(u.href); // replace the joint-history entry that holds the cross-origin frame
  });

  // Top-level navigations of the shell. Same-origin ones (frame busting, target=_top links,
  // top.location = '/x' from the page) are kept inside the card.
  window.navigation?.addEventListener('navigate', (e) => {
    const d = e.destination;
    const info = { type: e.navigationType, url: d.url, sameDocument: d.sameDocument, cancelable: e.cancelable, userInitiated: e.userInitiated, form: !!e.formData };
    if (d.sameDocument) return; // our own replaceState
    if (ownTopNav) return log('top-nav-own', info);
    if (flags.has('margin-nonav')) return log('top-nav-unguarded', info);
    let du;
    try { du = new URL(d.url); } catch { return; }
    if (du.origin !== location.origin) return log('top-nav-leave', info);
    if (!e.cancelable || e.navigationType === 'traverse') return log('top-nav-uncancelable', info);
    if (e.formData) {
      try { sessionStorage.setItem('margin:noshell', d.url); } catch {}
      return log('top-nav-post', info);
    }
    e.preventDefault();
    const cur = frameInfo();
    if (e.navigationType === 'reload') {
      // Browser-UI reloads do not fire `navigate`; this one came from script. While the frame's
      // document is still loading it is a bust (reloading the frame would loop): drop it.
      if (cur.ok && cur.doc.readyState !== 'complete') {
        bustedDoc = cur.doc;
        log('bust-blocked', { ...info, how: 'reload-while-loading' });
        unhide();
        return;
      }
      log('top-reload->frame-reload', info);
      try { frame.contentWindow.location.reload(); } catch {}
      return;
    }
    if (cur.ok && d.url === cur.href) {
      bustedDoc = cur.doc;
      log('bust-blocked', info);
      unhide();
      return;
    }
    log('top-nav->frame', info);
    try {
      if (e.navigationType === 'replace') frame.contentWindow.location.replace(d.url);
      else frame.contentWindow.location.assign(d.url);
    } catch { frame.src = d.url; }
  });

  // Clicking the sidebar (but not its text fields) hands keyboard focus back to the page.
  sidebar.addEventListener('pointerup', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    setTimeout(() => focusFrame('sidebar-click'), 0);
  });

  // ---------------------------------------------------------------- go
  if (flags.has('margin-narrow')) {
    chrome.runtime.sendMessage({ type: 'arm' }).then((r) => {
      log('armed', r);
      frame.src = target;
      body.appendChild(frame);
    });
  } else if (mode === 'swapstopraf' || mode === 'swapstoptimeout') {
    const go = () => { window.stop(); log('late-stop'); frame.src = target; body.appendChild(frame); };
    if (mode === 'swapstopraf') requestAnimationFrame(() => setTimeout(go, 0)); else setTimeout(go, 0);
  } else {
    frame.src = target; // set before insertion: no extra about:blank history entry
    body.appendChild(frame);
  }
})();
