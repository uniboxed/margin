// Transplant shell (isolated world, all frames, document_start). Based on r-shell/shell-prototype.js.
(() => {
  const R = (o) => { try { window.webkit.messageHandlers.r.postMessage(JSON.stringify(Object.assign({ t: Math.round(performance.now()), top: window.top === window }, o))); } catch (e) {} };
  if (window.top !== window) {
    let mine = false; try { mine = window.parent === window.top && window.frameElement?.__marginShellFrame === true; } catch (e) {}
    if (mine && location.href !== 'about:srcdoc') {
      R({ ev: 'frame-cs', href: location.href, ref: document.referrer, cs: document.characterSet });
      if (window.__CLICK) addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]'); if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const u = new URL(a.href, location.href); if (u.href.split('#')[0] === location.href.split('#')[0]) return;
        R({ ev: 'capture-click-to-top', url: u.href, active: navigator.userActivation && navigator.userActivation.isActive });
        e.preventDefault(); window.top.__marginGo(u.href, 'push');
      }, true);
      if (window.__FRAMEJS) window.navigation?.addEventListener('navigate', (e) => {
        R({ ev: 'frame-navigate', url: e.destination.url, type: e.navigationType, same: e.destination.sameDocument, cancelable: e.cancelable, canIntercept: e.canIntercept, user: e.userInitiated });
        if (e.destination.sameDocument || e.hashChange || e.downloadRequest || !e.cancelable) return;
        e.preventDefault(); R({ ev: 'to-top(framejs)', url: e.destination.url });
        try { window.top.__marginGo(e.destination.url, e.navigationType); } catch (err) { R({ ev: 'go-err', e: String(err) }); }
      });
      addEventListener('load', () => R({ ev: 'frame-load', href: location.href }));
    }
    return;
  }
  if (location.pathname === '/start') return;
  const old = document.documentElement;
  if (!old || old.childNodes.length || document.contentType !== 'text/html' || window.__marginShell) { R({ ev: 'skip', kids: old && old.childNodes.length }); return; }
  window.__marginShell = true;
  R({ ev: 'takeover', href: location.href, ref: document.referrer, cs: document.characterSet });
  const shell = document.createElement('html');
  const head = shell.appendChild(document.createElement('head'));
  const body = shell.appendChild(document.createElement('body'));
  body.style.margin = '0'; shell.setAttribute('data-margin-shell', '');
  const frame = document.createElement('iframe');
  frame.__marginShellFrame = true; if (window.__NAME) frame.name = 'm' + Math.random().toString(36).slice(2);
  frame.srcdoc = '<!doctype html><title></title>';
  Object.assign(frame.style, { position: 'fixed', top: '8px', left: '268px', width: 'calc(100% - 276px)', height: 'calc(100% - 16px)', border: '0' });
  body.appendChild(frame);
  document.replaceChild(shell, old);
  const frameReady = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  const mirror = () => {
    const t = old.querySelector('title'); if (t && document.title !== t.textContent) document.title = t.textContent;
    for (const l of old.querySelectorAll('link[rel~=icon]')) if (!l.__copied) { l.__copied = true; head.appendChild(l.cloneNode()); }
  };
  new MutationObserver(mirror).observe(old, { childList: true, subtree: true, characterData: true });
  addEventListener('load', () => R({ ev: 'top-load' }));
  let ownTopNav = false;
  const assignTop = (url) => { ownTopNav = true; location.assign(url); };
  window.__marginGo = (url, type) => { if (type === 'reload') return location.reload(); assignTop(url); };
  window.navigation?.addEventListener('navigate', (e) => {
    R({ ev: 'top-navigate', url: e.destination.url, type: e.navigationType, same: e.destination.sameDocument, cancelable: e.cancelable });
    if (ownTopNav || e.destination.sameDocument) return;
    if (e.cancelable && e.destination.url === location.href && e.navigationType !== 'reload') { e.preventDefault(); R({ ev: 'bust-blocked' }); }
  });
  document.addEventListener('DOMContentLoaded', async () => {
    mirror();
    await frameReady;
    if (window.__DEFER) await new Promise((r) => setTimeout(r, 0));
    const w = frame.contentWindow, d = frame.contentDocument;
    const attrs = [...old.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    try { d.open(); d.write(`<!doctype html><html${attrs}>${old.getHTML ? old.getHTML() : old.innerHTML}</html>`); d.close(); }
    catch (err) { R({ ev: 'write-error', e: String(err), name: err.name }); return; }
    R({ ev: 'transplanted', frameURL: d.URL, iw: w.innerWidth, frameRef: d.referrer, cs: d.characterSet, topcs: document.characterSet });
    w.focus();
    if (!window.__FRAMEJS) w.navigation?.addEventListener('navigate', (e) => {
      if (e.hashChange && e.navigationType === 'push' && window.__HASH) { e.preventDefault(); history.replaceState(Object.assign({}, history.state, { __scroll: w.scrollY }), ''); history.pushState(null, '', e.destination.url); w.location.replace(e.destination.url); R({ ev: 'hash-to-top', url: e.destination.url }); return; }
      if (e.destination.sameDocument || e.hashChange || e.downloadRequest || !e.cancelable) return;
      e.preventDefault(); R({ ev: 'to-top', url: e.destination.url, type: e.navigationType });
      if (e.navigationType === 'reload') return location.reload();
      assignTop(e.destination.url);
    });
  }, { once: true });
})();
