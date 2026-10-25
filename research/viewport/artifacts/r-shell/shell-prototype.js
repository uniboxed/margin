// Prototype of the "transplant shell" (document_start content script, isolated world).
// Safari/WebKit path. Measured in WebKitGTK 2.52; NOT yet run in real Safari.
//
// Top-level page https://site/x arrives once (as a normal top-level navigation).
//  1. At <html> creation (document_start) swap the parser's <html> for Margin's shell.
//     The parser keeps filling the detached tree; nothing in it runs or loads
//     (scripts, stylesheets, iframes, meta refresh/CSP), except <img>.
//  2. When parsing ends, serialize the detached tree (with shadow roots) and
//     document.write it into a same-origin srcdoc iframe. The frame's URL becomes
//     https://site/x, it inherits the page's CSP, its viewport is the card's size.
//  3. Every cross-document navigation of the frame becomes a top-level navigation,
//     so no URL is ever fetched *as a frame* (no X-Frame-Options / frame-ancestors /
//     frame-src / Sec-Fetch-Dest:iframe problems, no double fetch, POST keeps working).
(() => {
  const REPORT = (o) => { try { console.log('R ' + JSON.stringify(o)); window.webkit?.messageHandlers?.r?.postMessage(JSON.stringify(o)); } catch (e) {} };

  if (window.top !== window) {
    // Frame side. In WebKit this script is injected again when document.write
    // creates the transplanted <html>; recognise Margin's own frame by an expando
    // that only Margin's isolated world can see (the site can copy attributes, not this).
    let mine = false;
    try { mine = window.parent === window.top && window.frameElement?.__marginShellFrame === true; } catch (e) {}
    REPORT({ ev: 'frame-side', mine, url: location.href });
    return;
  }

  const old = document.documentElement;
  if (!old || old.childNodes.length || document.contentType !== 'text/html') return; // too late or not HTML
  if (window.__marginShell) return; // re-entrancy (a parser-created <html> re-runs document_start scripts)
  window.__marginShell = true;

  // 1. Shell document.
  const shell = document.createElement('html');
  shell.setAttribute('data-margin-shell', '');
  const head = shell.appendChild(document.createElement('head'));
  const body = shell.appendChild(document.createElement('body'));
  body.style.margin = '0';                         // CSSOM, not style="" (page style-src may forbid that)
  const frame = document.createElement('iframe');
  frame.__marginShellFrame = true;                 // per-world expando, invisible to the page
  frame.srcdoc = '<!doctype html><title></title>'; // set BEFORE insertion: no extra history entry, Navigation API enabled
  Object.assign(frame.style, { position: 'fixed', top: '8px', left: '268px', width: 'calc(100% - 276px)', height: 'calc(100% - 16px)', border: '0', borderRadius: '12px' });
  body.appendChild(frame);
  document.replaceChild(shell, old);
  const frameReady = new Promise((r) => frame.addEventListener('load', r, { once: true }));

  // Title/icon/theme-color can be mirrored early from the detached <head> as it streams in.
  const mirrorHead = () => { const t = old.querySelector('title'); if (t && document.title !== t.textContent) document.title = t.textContent; };
  new MutationObserver(mirrorHead).observe(old, { childList: true, subtree: true, characterData: true });

  const serialize = () => {
    const attrs = [...old.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    if (!old.getHTML) return '<!doctype html>' + old.outerHTML;
    const roots = [];
    const walk = (n) => { for (const el of n.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
    walk(old);
    return `<!doctype html><html${attrs}>${old.getHTML({ shadowRoots: roots })}</html>`;
  };

  const transplant = async () => {
    await frameReady;
    const w = frame.contentWindow, d = frame.contentDocument;
    d.open(); d.write(serialize()); d.close();
    try { w.history.replaceState(w.history.state, '', w.location.href); } catch (e) {}
    REPORT({ ev: 'transplanted', frameURL: d.URL, innerWidth: w.innerWidth });

    // 3. Cross-document navigations of the frame -> top-level navigations.
    w.navigation?.addEventListener('navigate', (e) => {
      if (e.destination.sameDocument || e.hashChange || e.downloadRequest || !e.cancelable) return;
      e.preventDefault();
      REPORT({ ev: 'to-top', url: e.destination.url, type: e.navigationType, post: !!e.formData });
      if (e.navigationType === 'reload') return location.reload();
      if (!e.formData) return assignTop(e.destination.url);
      // POST: re-submit the same entries from the top document (files via DataTransfer).
      const form = document.createElement('form');
      form.method = 'post'; form.action = e.destination.url; form.enctype = e.sourceElement?.enctype || 'application/x-www-form-urlencoded';
      for (const [k, v] of e.formData) {
        const input = document.createElement('input');
        input.name = k;
        if (typeof v === 'string') { input.type = 'hidden'; input.value = v; } else { input.type = 'file'; const dt = new DataTransfer(); dt.items.add(v); input.files = dt.files; }
        form.appendChild(input);
      }
      form.hidden = true; body.appendChild(form); form.submit();
    });
  };
  // Frame-busting (`top.location = self.location`) from the page would reload the top
  // document and re-create the shell forever. Navigations of the top document that a
  // same-origin document starts fire the top window's navigate event: cancel the ones
  // Margin did not start itself and that only reload the current URL.
  let ownTopNav = false;
  const assignTop = (url) => { ownTopNav = true; location.assign(url); };
  window.navigation?.addEventListener('navigate', (e) => {
    if (ownTopNav || e.destination.sameDocument) return;
    if (e.cancelable && e.destination.url === location.href && e.navigationType !== 'reload') { e.preventDefault(); REPORT({ ev: 'frame-bust-blocked', url: e.destination.url }); }
  });
  // DOMContentLoaded of the shell document = the parser has finished the detached tree.
  document.addEventListener('DOMContentLoaded', transplant, { once: true });
})();
