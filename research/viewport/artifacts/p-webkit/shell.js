// Margin "same-origin iframe shell" prototype -- TOP-FRAME part.
// Injected at document_start into the top frame only (like a content script with all_frames:false),
// optionally in an isolated world. Config comes from a global __MCFG prepended by the harness:
//   stop:     true  -> window.stop() before building the shell (default true)
//   focus:    'window' | 'element' | 'none'  (how the frame gets focus after each load; default 'window')
//   navapi:   true  -> use the Navigation API on top to cancel frame-busting / retarget same-origin _top navs
//   sandbox:  string -> sandbox attribute for the iframe (fallback for frame-busting without Navigation API)
//   refocus:  true  -> after a click in the sidebar (not on an input), give focus back to the frame
//   styleMode: 'element' (default, <style> in head) | 'adopted' (document.adoptedStyleSheets; survives page CSP style-src)
(() => {
  const CFG = (typeof __MCFG !== 'undefined') ? __MCFG : {};
  if (window !== window.top) return;
  if (/[?&]__noshell\b/.test(location.search)) return;
  if (document.contentType && !/html/i.test(document.contentType)) return;
  try { if (sessionStorage.getItem('margin-skip') === location.href) { sessionStorage.removeItem('margin-skip'); return; } } catch (e) {}

  const SB = 260, G = 8;
  const now = () => +performance.now().toFixed(1);
  const M = (window.__margin = {
    t0: now(), log: [], marker: Math.random().toString(36).slice(2), cfg: CFG,
    syncs: 0, frameLoads: 0, cancels: [], escapes: [], pending: null, frameSide: 0,
  });
  const L = (ev, d = {}) => { M.log.push(Object.assign({ t: now(), ev }, d)); };
  const startURL = location.href;
  const stripHash = (u) => u.split('#')[0];
  // test instrumentation only: record shell decisions in the server log
  const beacon = (ev, url) => { try { (new Image()).src = '/b?ev=' + ev + '&url=' + encodeURIComponent(url || ''); } catch (e) {} };
  M.beacon = beacon;

  if (CFG.stop !== false) {
    try { window.stop(); } catch (e) { L('stop-err', { e: String(e) }); }
  }
  L('stopped', { hasDE: !!document.documentElement, rs: document.readyState, world: typeof webkit === 'undefined' ? 'no-webkit' : 'webkit' });

  let frame;
  let selfReplace = false;
  let selfNav = false;   // set while the shell itself navigates/reloads the top
  function build() {
    let de = document.documentElement;
    if (!de) { de = document.createElement('html'); document.appendChild(de); }
    L('build', { hadChildren: de.childNodes.length, rs: document.readyState });
    de.replaceChildren();
    for (const a of [...de.attributes]) de.removeAttribute(a.name);
    const head = document.createElement('head');
    const body = document.createElement('body');
    de.append(head, body);
    const st = document.createElement('style');
    st.textContent = `html,body{margin:0;height:100%;overflow:hidden;background:#2b2b33}
#margin-sidebar{position:fixed;left:0;top:0;bottom:0;width:${SB}px;color:#eee;font:13px system-ui;box-sizing:border-box;padding:12px}
#margin-sidebar input{width:200px}
#margin-card{position:fixed;left:${SB}px;top:${G}px;right:${G}px;bottom:${G}px;border-radius:10px;overflow:hidden;background:#fff}
#margin-frame{border:0;display:block;width:100%;height:100%}`;
    if (CFG.styleMode === 'adopted') {
      // A <style> element inserted by a content script is still subject to the PAGE's CSP (style-src / default-src):
      // WebKit blocks it even from an isolated world. Constructable stylesheets are not blocked (see CSPPROBE).
      const sheet = new CSSStyleSheet(); sheet.replaceSync(st.textContent);
      document.adoptedStyleSheets = [sheet];
      head.append(document.createElement('title'));
    } else {
      head.append(st, document.createElement('title'));
    }
    const sb = document.createElement('div'); sb.id = 'margin-sidebar';
    sb.innerHTML = '<div id="sb-tabs">tabs</div><input id="sb-input" placeholder="sidebar input"><div id="sb-pad" style="height:200px">sidebar blank area</div>';
    const card = document.createElement('div'); card.id = 'margin-card';
    frame = document.createElement('iframe');
    frame.id = 'margin-frame';
    frame.name = 'margin-shell-frame';
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; geolocation; camera; microphone; display-capture; payment; publickey-credentials-get; publickey-credentials-create; web-share; autoplay; encrypted-media; picture-in-picture; screen-wake-lock');
    frame.setAttribute('allowfullscreen', '');
    if (CFG.sandbox) frame.setAttribute('sandbox', CFG.sandbox);
    frame.addEventListener('load', onFrameLoad);
    frame.src = startURL;
    card.append(frame);
    body.append(sb, card);
    M.frame = frame;
    sb.addEventListener('pointerup', (e) => {
      if (CFG.refocus && !e.target.closest('input,textarea,select,[contenteditable]')) {
        setTimeout(() => { giveFocus('sidebar-click'); }, 0);
      }
    });
  }

  function giveFocus(why) {
    const mode = CFG.focus || 'window';
    try {
      if (mode === 'window') frame.contentWindow.focus();
      else if (mode === 'element') frame.focus();
      L('focus', { why, mode, active: document.activeElement && document.activeElement.id });
    } catch (e) { L('focus-err', { e: String(e) }); }
  }

  function copyHead(d) {
    try {
      const head = document.head;
      for (const old of head.querySelectorAll('[data-margin-copy]')) old.remove();
      for (const el of d.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], meta[name="theme-color"], meta[name="color-scheme"]')) {
        const c = el.cloneNode(false);
        if (c.href) c.href = el.href;  // absolutize
        c.setAttribute('data-margin-copy', '');
        head.append(c);
      }
    } catch (e) { L('copy-err', { e: String(e) }); }
  }

  function sync(why) {
    let w, href;
    try { w = frame.contentWindow; href = w.location.href; } catch (e) { L('xo', { why }); onCrossOrigin(why); return; }
    if (!href || href === 'about:blank') {
      L('blank', { why });
      // The top document's own CSP (frame-src / child-src / default-src without 'self') blocks our same-origin iframe:
      // WebKit leaves it at about:blank and still fires 'load'. Fall back to showing this URL unshelled.
      if (why === 'load' && M.frameLoads === 1) escapeTo(startURL, 'blank-first-load');
      return;
    }
    const before = location.href;
    if (href !== location.href) {
      selfReplace = true;
      try { history.replaceState(history.state, '', href); } finally { selfReplace = false; }
      if (location.href !== href) L('replace-failed', { href, now: location.href });
    }
    const d = w.document;
    if (d && d.title !== document.title) document.title = d.title;
    if (why === 'load') copyHead(d);
    M.syncs++;
    L('sync', { why, href, before });
    attach(w);
  }

  function attach(w) {
    if (w.__marginAttached) return;
    w.__marginAttached = true;
    w.addEventListener('popstate', () => sync('popstate'));
    w.addEventListener('hashchange', () => sync('hashchange'));
    // WebKitGTK 2.52: pushState/replaceState fire navigate + navigatesuccess but NOT currententrychange -> use navigatesuccess.
    if (w.navigation) {
      w.navigation.addEventListener('currententrychange', () => sync('currententrychange'));
      w.navigation.addEventListener('navigatesuccess', () => sync('navigatesuccess'));
    }
    try {
      const mo = new MutationObserver(() => { if (w.document.title !== document.title) { document.title = w.document.title; L('title', { t: document.title }); } });
      mo.observe(w.document.head || w.document.documentElement, { subtree: true, childList: true, characterData: true });
    } catch (e) {}
  }

  let xoTimer = null;
  function onCrossOrigin(why) {
    // The frame is no longer same-origin (redirect or blocked load). Wait briefly for the frame-side
    // "escape" message (carries the final URL); otherwise fall back to the last pending same-origin URL.
    clearTimeout(xoTimer);
    xoTimer = setTimeout(() => {
      const url = M.pending;
      L('xo-fallback', { url });
      if (url) escapeTo(url, 'fallback-pending');
    }, CFG.xoWait || 400);
  }

  // Leave the shell: either navigate the top to where the frame went (another origin), or -- if the frame was
  // blocked at the very URL the top is showing (X-Frame-Options / frame-ancestors) -- reload this URL unshelled once.
  function escapeTo(url, how, origin) {
    clearTimeout(xoTimer);
    if (stripHash(url) === stripHash(location.href)) {
      M.escapes.push({ how: how + ':unframeable-reload', url, origin });
      beacon('unframeable-reload-' + how, url);
      try { sessionStorage.setItem('margin-skip', location.href); } catch (err) {}
      selfNav = true;
      location.reload();
      return;
    }
    M.escapes.push({ how, url, origin });
    beacon('escape-' + how, url);
    selfNav = true;
    location.href = url;
  }

  function onFrameLoad() {
    M.frameLoads++;
    L('frame-load', { n: M.frameLoads });
    sync('load');
    if ((CFG.focus || 'window') !== 'none') giveFocus('load');
  }

  document.addEventListener('securitypolicyviolation', (e) => {
    L('csp-violation', { directive: e.violatedDirective || e.effectiveDirective, blocked: e.blockedURI });
  });

  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.margin !== 'escape') return;
    // WebKit: an X-Frame-Options/CSP-blocked frame becomes an opaque-origin ("null") document at the blocked URL, and the
    // all_frames content script still runs in it. A real extension should use runtime.sendMessage -> tabs.update instead
    // of postMessage so pages cannot forge this.
    let ok = false; try { ok = new URL(e.data.url).origin === e.origin || (e.origin === 'null' && CFG.acceptOpaqueEscape !== false); } catch (err) {}
    L('escape-msg', { url: e.data.url, origin: e.origin, ok });
    if (!ok) return;
    clearTimeout(xoTimer);
    escapeTo(e.data.url, 'frame-side-message', e.origin);
  });

  if (CFG.navapi !== false && window.navigation) {
    navigation.addEventListener('navigate', (e) => {
      const dest = new URL(e.destination.url);
      const rec = { type: e.navigationType, dest: dest.href, cancelable: e.cancelable, canIntercept: e.canIntercept, userInitiated: e.userInitiated, hashChange: e.hashChange, formData: !!e.formData, src: e.sourceElement ? e.sourceElement.id || e.sourceElement.tagName : null };
      rec.sameDocument = e.destination.sameDocument;
      L('top-navigate', rec);
      // history.replaceState() on the top (our own URL sync) fires a cancelable 'navigate' (type replace, sameDocument)
      // in WebKit: never cancel same-document navigations.
      if (e.destination.sameDocument || selfReplace || selfNav) return;
      if (e.navigationType === 'traverse' || e.navigationType === 'reload' || e.hashChange || e.downloadRequest) return;
      if (dest.origin !== location.origin) return;           // cross-origin top-level navigation: let it happen
      if (e.formData) { try { sessionStorage.setItem('margin-skip', dest.href); } catch (err) {} return; }
      if (!e.cancelable) return;
      let cur = null; try { cur = frame.contentWindow.location.href; } catch (err) {}
      e.preventDefault();
      if (cur && stripHash(cur) === stripHash(dest.href)) {
        M.cancels.push({ kind: 'bust', dest: dest.href }); L('cancel-bust', rec);
        // OWASP-style anti-clickjacking keeps <body> hidden unless self === top. If the page stays hidden after we
        // cancelled its frame-bust, show this URL unshelled instead of a blank card.
        if (CFG.hiddenCheck !== false) setTimeout(() => {
          try {
            const d = frame.contentDocument; const w = frame.contentWindow;
            const hidden = (el) => el && w.getComputedStyle(el).display === 'none';
            if (d && (hidden(d.documentElement) || hidden(d.body))) { L('busted-page-hidden'); escapeTo(location.href, 'hidden-after-bust'); }
          } catch (err) {}
        }, CFG.hiddenCheckMs || 300);
        return;
      }
      M.cancels.push({ kind: 'retarget', dest: dest.href });
      L('retarget', rec);
      frame.contentWindow.location.href = dest.href;
    });
  } else if (CFG.navapi !== false) {
    L('no-navigation-api');
  }

  // histMode 'top': same-origin cross-document frame navigations become top-level pushState entries + frame location.replace(),
  // so the browser's back/forward list holds correct top-level URLs (see BF2 results for why).
  M.topPush = (dest) => {
    selfReplace = true;
    try { history.pushState({ margin: 1 }, '', dest); } finally { selfReplace = false; }
    L('top-push', { dest });
    frame.contentWindow.location.replace(dest);
  };
  if (CFG.histMode === 'top') {
    addEventListener('popstate', () => {
      let cur = null; try { cur = frame.contentWindow.location.href; } catch (e) {}
      L('top-popstate', { href: location.href, frame: cur });
      if (cur !== location.href) frame.contentWindow.location.replace(location.href);
    });
  }

  // Printing: Safari prints the top document. Expand the frame to its content height and hide the chrome while printing.
  if (CFG.printFix !== false) {
    let printStyle = null;
    addEventListener('beforeprint', () => {
      try {
        const h = frame.contentDocument.documentElement.scrollHeight;
        printStyle = document.createElement('style');
        printStyle.textContent = `html,body{height:auto!important;overflow:visible!important;background:#fff!important}
#margin-sidebar{display:none!important}#margin-card{position:static!important;border-radius:0!important}
#margin-frame{height:${h}px!important}`;
        document.head.append(printStyle);
        L('beforeprint', { h });
      } catch (e) { L('beforeprint-err', { e: String(e) }); }
    });
    addEventListener('afterprint', () => { if (printStyle) printStyle.remove(); printStyle = null; L('afterprint'); });
  }

  build();
  L('built');
})();
