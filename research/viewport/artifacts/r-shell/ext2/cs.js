// Experimental "shell" content script. Runs at document_start in an isolated
// world (WebKitGTK: UserScript in world "margin"; Chromium: MV3 content script).
// Behaviour is selected by ?mode= in the page URL so one script covers all tests.
(() => {
  const isTop = window.top === window;
  const R = (o) => {
    o.f = isTop ? 'top' : 'sub';
    o.t = Date.now();
    o.href = location.href;
    const s = JSON.stringify(o);
    try { window.webkit.messageHandlers.r.postMessage(s); } catch (e) {}
    try { console.log('R ' + s); } catch (e) {}
  };
  // Re-entrancy: a parser-created <html> (document.write) re-runs document-start scripts.
  if (window.__marginOpening) { R({ ev: 'reinjected-during-open', url: document.URL }); return; }
  window.__marginRuns = (window.__marginRuns || 0) + 1;
  if (window.__marginRuns > 1) R({ ev: 'reinjected', n: window.__marginRuns, url: document.URL });
  const qs = new URLSearchParams(location.search);
  const mode = qs.get('mode') || 'none';
  const de = document.documentElement;
  const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
  R({
    ev: 'injected', mode, perfNow: Math.round(performance.now()), readyState: document.readyState,
    hasDE: !!de, deChildren: de ? de.childNodes.length : -1, deAttrs: de ? [...de.attributes].map((a) => a.name).join(',') : '',
    pageRanAttr: de ? de.getAttribute('data-page-ran') : null,
    responseStart: nav ? Math.round(nav.responseStart) : null, requestStart: nav ? Math.round(nav.requestStart) : null,
    navType: nav ? nav.type : null,
  });

  if (!isTop) {
    // Frame side: is this the shell's own frame, or a site's iframe?
    let fe = null, err = null;
    try { fe = window.frameElement; } catch (e) { err = String(e); }
    let topIsShell = null;
    try { topIsShell = window.top.document.documentElement.hasAttribute('data-margin-shell'); } catch (e) { topIsShell = 'err:' + e.name; }
    R({ ev: 'frame-detect', hasFrameElement: !!fe, expando: fe ? String(fe.__marginShell) : null, attr: fe ? fe.getAttribute('data-margin-frame') : null,
      parentIsTop: window.parent === window.top, topIsShell, err, innerWidth: window.innerWidth });
    document.addEventListener('DOMContentLoaded', () => R({ ev: 'frame-dcl', perfNow: Math.round(performance.now()) }));
    if (qs.get('interceptnav')) {
      const nav = window.navigation;
      R({ ev: 'frame-navapi', has: !!nav, entries: nav ? nav.entries().length : null, cur: nav && nav.currentEntry ? nav.currentEntry.url : null });
      nav && nav.addEventListener('navigate', (e) => {
        R({ ev: 'frame-nav-intercepted', to: e.destination.url, type: e.navigationType, cancelable: e.cancelable, canIntercept: e.canIntercept, formData: !!e.formData });
        if (e.hashChange || e.downloadRequest || e.destination.sameDocument) return;
        if (e.cancelable && !e.formData) { e.preventDefault(); window.top.location.href = e.destination.url; }
      });
    }
    return;
  }

  const SHELL_W = 200;
  const buildShell = (useSrc, srcdocEarly) => {
    const html = document.createElement('html');
    html.setAttribute('data-margin-shell', '');
    html.innerHTML = `<head><meta charset="utf-8"><title>shell</title></head><body style="margin:0"></body>`;
    const f = document.createElement('iframe');
    f.setAttribute('data-margin-frame', 'attr-token');
    f.__marginShell = 'expando-token';
    f.style.cssText = `position:fixed;left:${SHELL_W}px;top:0;width:calc(100% - ${SHELL_W}px);height:100%;border:0`;
    if (useSrc) f.src = location.href;
    if (srcdocEarly) f.srcdoc = '<!doctype html><title></title>';
    html.lastChild.appendChild(f);
    return { html, f };
  };

  const navAfter = (f) => {
    if (!qs.get('navafter')) return;
    setTimeout(() => {
      try {
        const d = f.contentDocument;
        const a = d.createElement('a');
        a.href = '/p?mode=none&tag=nav2&from=' + mode;
        d.body.appendChild(a);
        R({ ev: 'frame-nav-click', to: a.href });
        a.click();
        setTimeout(() => { let h = null; try { h = f.contentWindow.location.href; } catch (e) { h = 'err:' + e.name; } R({ ev: 'frame-after-nav', frameHref: h }); }, 800);
      } catch (e) { R({ ev: 'frame-nav-err', e: String(e) }); }
    }, 300);
  };

  const watchTop = (old) => {
    document.addEventListener('readystatechange', () => R({ ev: 'top-readystate', rs: document.readyState, oldChildren: old ? old.childElementCount : null, oldBodyKids: old && old.querySelector('body') ? old.querySelector('body').childElementCount : null, oldHasScriptText: old ? old.querySelectorAll('script').length : null }));
    window.addEventListener('load', () => R({ ev: 'top-load', perfNow: Math.round(performance.now()), histLen: history.length }));
  };

  if (mode === 'none') { watchTop(null); return; }

  if (mode === 'stop' || mode === 'stopcsp') {
    window.stop();
    const afterStop = { ev: 'after-stop', readyState: document.readyState, deChildren: document.documentElement ? document.documentElement.childNodes.length : -1 };
    R(afterStop);
    const { html, f } = buildShell(true);
    document.replaceChild(html, document.documentElement);
    f.addEventListener('load', () => {
      let info = {};
      try { info = { frameHref: f.contentWindow.location.href, frameTitle: f.contentDocument.title, frameInnerWidth: f.contentWindow.innerWidth }; } catch (e) { info = { err: String(e) }; }
      R({ ev: 'shell-frame-load', ...info });
      if (!window.__navDone) { window.__navDone = 1; navAfter(f); }
    });
    f.addEventListener('error', () => R({ ev: 'shell-frame-error' }));
    watchTop(null);
    return;
  }

  if (mode === 'detach' || mode === 'transplant' || mode === 'tsrcdoc' || mode === 'tblank' || mode === 'tsrcdoc2') {
    // Take the parser's <html> out of the document: the parser keeps building
    // into the detached tree, where scripts are not "connected" and never run.
    const old = document.documentElement;
    const { html, f } = buildShell(false, mode === 'tsrcdoc2');
    document.replaceChild(html, old);
    watchTop(old);
    let frameReady = Promise.resolve();
    if (mode === 'tsrcdoc2') frameReady = new Promise((r) => f.addEventListener('load', r, { once: true }));
    if (mode === 'tsrcdoc' || mode === 'tblank') {
      frameReady = new Promise((r) => f.addEventListener('load', r, { once: true }));
      if (mode === 'tsrcdoc') f.srcdoc = '<!doctype html><title></title>'; else f.src = 'about:blank';
    }
    if (mode !== 'detach') {
      const go = async () => {
        await frameReady;
        let markup;
        if (qs.get('ser') === 'gethtml' && old.getHTML) {
          // Keep declarative shadow roots: pass every (open) shadow root explicitly.
          const roots = [];
          const walk = (n) => { for (const el of n.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
          walk(old);
          const wrap = document.createElement('div'); // getHTML serializes children, so serialize via a temporary parent
          markup = '<!doctype html>' + '<html' + [...old.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('') + '>' + old.getHTML({ shadowRoots: roots }) + '</html>';
          R({ ev: 'gethtml', roots: roots.length });
        } else markup = '<!doctype html>' + old.outerHTML;
        const d = f.contentDocument;
        if (qs.get('mainwrite')) {
          f.setAttribute('data-margin-markup', markup);
          f.dispatchEvent(new CustomEvent('margin-transplant', { bubbles: true }));
        } else {
          d.open();
          d.write(markup);
          d.close();
        }
        let info = {};
        try { const n = f.contentWindow.navigation; info = { histLen: history.length, navEntries: n ? n.entries().length : null, navCur: n && n.currentEntry ? n.currentEntry.url : null, frameHref: f.contentWindow.location.href, frameURL: d.URL, frameCookieOk: typeof d.cookie, frameInnerWidth: f.contentWindow.innerWidth, markupLen: markup.length }; } catch (e) { info = { err: String(e) }; }
        if (mode === 'tsrcdoc2') { try { const w = f.contentWindow; w.history.replaceState(w.history.state, '', w.location.href); info.navCurAfterReplaceState = w.navigation && w.navigation.currentEntry ? w.navigation.currentEntry.url : null; info.histLenAfter = history.length; } catch (e) { info.rsErr = String(e); } }
        setTimeout(() => { try { R({ ev: 'frame-order', order: f.contentDocument.documentElement.getAttribute('data-order') }); } catch (e) { R({ ev: 'frame-order-err', e: String(e) }); } }, 1500);
        R({ ev: 'transplanted', perfNow: Math.round(performance.now()), ...info });
        navAfter(f);
        if (qs.get('interceptnav')) {
          // Turn every cross-document navigation of the frame into a top-level one.
          try {
            const nav = f.contentWindow.navigation;
            R({ ev: 'navapi', has: !!nav });
            nav && nav.addEventListener('navigate', (e) => {
              R({ ev: 'nav-intercepted', sameDocument: e.destination.sameDocument, to: e.destination.url, type: e.navigationType, cancelable: e.cancelable, canIntercept: e.canIntercept, hashChange: e.hashChange, formData: !!e.formData, userInitiated: e.userInitiated });
              if (e.hashChange || e.downloadRequest || e.destination.sameDocument) return;
              if (e.cancelable && !e.formData) { e.preventDefault(); window.location.href = e.destination.url; }
            });
          } catch (err) { R({ ev: 'navapi-err', e: String(err) }); }
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
      else go();
    }
    return;
  }

  if (mode === 'open') {
    // document.open() from the isolated world while the parser is active.
    let r = 'ok';
    try {
      window.__marginOpening = true;
      document.open();
      document.write('<!doctype html><html data-margin-shell><body>opened</body></html>');
      document.close();
    } catch (e) { r = 'err:' + e.name + ':' + e.message; }
    R({ ev: 'after-open', r, readyState: document.readyState, de: document.documentElement ? document.documentElement.outerHTML.slice(0, 120) : null, url: document.URL });
    watchTop(null);
    return;
  }

  if (mode === 'rc') { document.documentElement.replaceChildren(); R({ ev: 'after-rc', deChildren: document.documentElement.childNodes.length }); watchTop(null); return; }
  if (mode === 'stoponly') { window.stop(); R({ ev: 'after-stop', readyState: document.readyState }); watchTop(document.documentElement); setTimeout(() => R({ ev: 'stoponly-later', rs: document.readyState, html: document.documentElement.outerHTML.length, scripts: document.scripts.length }), 1000); return; }
  if (mode === 'remove') {
    // Remove the parser's <html> and leave nothing: what does the parser do next?
    const old = document.documentElement;
    old.remove();
    watchTop(old);
    return;
  }
})();
