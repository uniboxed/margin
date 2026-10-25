// Test server for the same-origin iframe-shell navigation experiments.
// Ports 8701 and 8702 (same-site, cross-origin on "localhost"); use 127.0.0.1 for cross-site.
import http from 'node:http';
import { URL } from 'node:url';

const logs = new Map();
const PORTS = [8701, 8702];

function addLog(id, entry) {
  if (!logs.has(id)) logs.set(id, []);
  logs.get(id).push({ t: Date.now(), ...entry });
}

// Shared client-side logger, works from any origin (absolute URL to 8701).
const LOGGER = `
<script>
window.__ID = new URLSearchParams(location.search).get('id') || 'none';
window.log = function (o) {
  try {
    o.at = location.href; o.isTop = (window.top === window);
    fetch('http://localhost:8701/log?id=' + encodeURIComponent(__ID), {method:'POST', body: JSON.stringify(o), keepalive:true, mode:'no-cors'});
  } catch (e) {}
};
</script>`;

function navInfo() {
  // Serialises a NavigateEvent.
  return `
function navInfo(e) {
  let src = null;
  try { src = e.sourceElement ? (e.sourceElement.tagName + (e.sourceElement.id ? '#' + e.sourceElement.id : '')) : null; } catch (x) { src = 'ERR'; }
  return { type: e.navigationType, cancelable: e.cancelable, canIntercept: e.canIntercept, userInitiated: e.userInitiated,
           dest: e.destination.url, sameDoc: e.destination.sameDocument, hashChange: e.hashChange,
           formData: e.formData ? [...e.formData.entries()].map(x => x.join('=')).join('&') : null,
           sourceElement: src, info: e.info === undefined ? undefined : String(e.info) };
}`;
}

// The "site page": when top-level it turns itself into a shell that frames location.href;
// when framed it renders the page and (optionally) runs a frame-busting / navigation mode.
function sitePage(q, port) {
  const id = q.get('id') || 'none';
  const mode = q.get('mode') || '';
  const prevent = q.get('prevent') || '0';          // top: 1 = preventDefault cross-doc navigates
  const childGuard = q.get('guard') || '0';         // frame: 1 = cancel cross-origin navs and push them to top
  const shellSrc = q.get('shellsrc') || '';          // top: frame a different URL instead of location.href
  const crossTarget = q.get('cross') || 'http://localhost:8702/site?id=' + id + '&role=xo';
  return `<!doctype html><html><head><meta charset=utf-8><title>site ${mode} ${port}</title>${LOGGER}
<style>html,body{margin:0;height:100%} iframe{border:0;position:fixed;left:200px;top:0;width:calc(100vw - 200px);height:100vh}</style>
</head><body>
<script>
${navInfo()}
const MODE = ${JSON.stringify(mode)}, PREVENT = ${JSON.stringify(prevent)}, GUARD = ${JSON.stringify(childGuard)};
const CROSS = ${JSON.stringify(crossTarget)};
const hasNav = typeof navigation !== 'undefined';
if (window.top === window && !${JSON.stringify(q.get('role') || '')}) {
  // ---------- SHELL ----------
  document.title = 'shell';
  log({ ev: 'shell-start', hasNav, ua: navigator.userAgent.slice(0, 60) });
  window.__shellNavigating = false;
  if (hasNav) navigation.addEventListener('navigate', (e) => {
    const i = navInfo(e);
    let action = 'allow';
    if (PREVENT === '1' && !e.destination.sameDocument && !window.__shellNavigating) { e.preventDefault(); action = 'prevented'; }
    i.defaultPrevented = e.defaultPrevented;
    log({ ev: 'top-navigate', action, ...i });
  });
  addEventListener('popstate', (e) => log({ ev: 'top-popstate', url: location.href, state: e.state }));
  addEventListener('beforeunload', () => log({ ev: 'top-beforeunload' }));
  addEventListener('pagehide', () => log({ ev: 'top-pagehide', url: location.href }));
  document.addEventListener('margin-nav', (e) => { log({ ev: 'shell-nav-request', via: 'event', dest: e.detail }); window.__shellNavigating = true; location.href = e.detail; });
  addEventListener('message', (e) => { if (e.data && e.data.marginNav && e.origin === location.origin) { log({ ev: 'shell-nav-request', via: 'postMessage', dest: e.data.marginNav }); window.__shellNavigating = true; location.href = e.data.marginNav; } });
  const f = document.createElement('iframe');
  f.name = 'margin-frame';
  if (${JSON.stringify(q.get('sandbox') || '')}) f.setAttribute('sandbox', ${JSON.stringify(q.get('sandbox') || '')});
  f.src = ${JSON.stringify(shellSrc)} || location.href;
  f.addEventListener('load', () => {
    let url, doc;
    try { url = f.contentWindow.location.href; } catch (e) { url = 'THROWS:' + e.name; }
    try { doc = f.contentDocument ? 'doc' : 'null'; } catch (e) { doc = 'THROWS'; }
    log({ ev: 'shell-iframe-load', url, doc });
  });
  document.body.appendChild(f);
  window.__f = f;
} else {
  // ---------- FRAMED PAGE ----------
  log({ ev: 'page-load', mode: MODE, name: window.name, ancestorOrigins: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null,
        topIsSelf: window.top === window.self, referrer: document.referrer });
  if (hasNav) navigation.addEventListener('navigate', (e) => {
    const i = navInfo(e);
    let action = 'allow';
    if (GUARD !== '0' && !e.destination.sameDocument) {
      const d = new URL(e.destination.url);
      if (d.origin !== location.origin && e.cancelable) {
        e.preventDefault(); action = 'prevented->top(guard' + GUARD + ')';
        const dest = e.destination.url;
        try {
          if (GUARD === '1') window.top.location.href = dest;
          else if (GUARD === '2') window.top.document.dispatchEvent(new CustomEvent('margin-nav', { detail: dest }));
          else if (GUARD === '3') window.top.postMessage({ marginNav: dest }, location.origin);
          else if (GUARD === '4') {
            // rebuild the submission in the top document so POST bodies survive
            const td = window.top.document, fm = td.createElement('form');
            fm.method = e.formData ? 'post' : 'get'; fm.action = dest; fm.target = '_self'; fm.style.display = 'none';
            if (e.formData) for (const [k, v] of e.formData) { const i = td.createElement('input'); i.type = 'hidden'; i.name = k; i.value = typeof v === 'string' ? v : ''; fm.appendChild(i); }
            td.body.appendChild(fm); window.top.__shellNavigating = true; fm.submit();
          }
        } catch (x) { action += ' ERR:' + x.name + ' ' + x.message; }
      }
    }
    log({ ev: 'frame-navigate', action, ...i });
  });
  addEventListener('pagehide', () => log({ ev: 'frame-pagehide', url: location.href }));
}
</script>
<h1 id=h>Page ${mode} on ${port}</h1>
${q.get('untrusted') === '1' ? '<script src="http://127.0.0.1:8702/3p.js"></script><iframe src="http://127.0.0.1:8702/blank" style="width:10px;height:10px"></iframe>' : ''}
<a id=lnkSelf href="/site?id=${id}&mode=landed">same-origin link</a>
<a id=lnkCross href="${crossTarget}">cross link</a>
<a id=lnkTop target=_top href="/site?id=${id}&mode=landed-top">top-target link</a>
<form id=fg action="${crossTarget}" method=get><input name=q value=1></form>
<form id=fp action="http://localhost:8702/post?id=${id}" method=post><input name=q value=2></form>
<script>
function bust() {
  const me = location.href;
  switch (MODE) {
    case 'assign': top.location = self.location; break;
    case 'href': top.location.href = me; break;
    case 'replace': top.location.replace(me); break;
    case 'open': window.open(me, '_top'); break;
    case 'a': { const a = document.createElement('a'); a.id = 'bustA'; a.target = '_top'; a.href = me; document.body.appendChild(a); a.click(); break; }
    case 'formget': { const fm = document.createElement('form'); fm.id = 'bustF'; fm.target = '_top'; fm.method = 'get'; fm.action = location.pathname;
      for (const [k, v] of new URLSearchParams(location.search)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; fm.appendChild(i); }
      document.body.appendChild(fm); fm.submit(); break; }
    case 'formpost': { const fm = document.createElement('form'); fm.id = 'bustP'; fm.target = '_top'; fm.method = 'post'; fm.action = location.href;
      const i = document.createElement('input'); i.name = 'x'; i.value = 'y'; fm.appendChild(i); document.body.appendChild(fm); fm.submit(); break; }
    case 'other': top.location = '/site?id=' + __ID + '&mode=other-dest'; break;
    case 'topcross': top.location = CROSS; break;
    // frame-internal navigations (Q3)
    case 'f-lnkcross': document.getElementById('lnkCross').click(); break;
    case 'f-hrefcross': location.href = CROSS; break;
    case 'f-assigncross': location.assign(CROSS); break;
    case 'f-formget': document.getElementById('fg').submit(); break;
    case 'f-formpost': document.getElementById('fp').submit(); break;
    case 'f-open-self': window.open(CROSS, '_self'); break;
    case 'f-meta': { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + CROSS; document.head.appendChild(m); break; }
    case 'f-redirect': location.href = '/redir?id=' + __ID + '&to=' + encodeURIComponent(CROSS); break;
    case 'f-redirect-xfo': location.href = '/redir?id=' + __ID + '&to=' + encodeURIComponent('http://localhost:8702/site?id=' + __ID + '&role=xo&xfo=DENY'); break;
    case 'f-redirect-xs': location.href = '/redir?id=' + __ID + '&to=' + encodeURIComponent('http://127.0.0.1:8702/site?id=' + __ID + '&role=xs'); break;
    case 'f-lnkself': document.getElementById('lnkSelf').click(); break;
  }
}
if (window.top !== window && MODE && MODE !== 'landed' && MODE !== 'other-dest') {
  setTimeout(() => { log({ ev: 'frame-bust-attempt', mode: MODE }); let err = null; try { bust(); } catch (x) { err = x.name + ': ' + x.message; }
    setTimeout(() => log({ ev: 'frame-after', mode: MODE, url: location.href, err }), 1200); }, Number(${JSON.stringify(q.get('delay') || '150')}));
}
</script>
</body></html>`;
}

function handler(port) {
  return (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const q = u.searchParams;
    const id = q.get('id') || 'none';
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (u.pathname === '/log') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { addLog(id, { port, ...JSON.parse(body || '{}') }); } catch (e) { addLog(id, { port, raw: body }); }
        res.writeHead(204, cors); res.end();
      });
      return;
    }
    if (u.pathname === '/3p.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.__3p = 1;'); return; }
    if (u.pathname === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>3p</title>3p'); return; }
    if (u.pathname === '/results') { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(logs.get(id) || [])); return; }
    if (u.pathname === '/reset') { logs.clear(); res.writeHead(204); res.end(); return; }
    if (u.pathname === '/redir') { addLog(id, { port, ev: 'server-redirect', to: q.get('to') }); res.writeHead(302, { Location: q.get('to') }); res.end(); return; }
    if (u.pathname === '/post') {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => { addLog(id, { port, ev: 'server-post', body, method: req.method, dest: req.headers['sec-fetch-dest'] }); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>posted</title>${LOGGER}<script>log({ev:'post-landed', topIsSelf: top===self})</script>posted`); });
      return;
    }
    if (u.pathname === '/site') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        addLog(id, { port, ev: 'server-hit', method: req.method, path: u.pathname + u.search, dest: req.headers['sec-fetch-dest'] || null, host: req.headers.host, body: body || undefined });
        const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
        if (q.get('xfo')) headers['X-Frame-Options'] = q.get('xfo');
        if (q.get('fa')) headers['Content-Security-Policy'] = 'frame-ancestors ' + q.get('fa');
        res.writeHead(200, headers);
        res.end(sitePage(q, port));
      });
      return;
    }
    if (u.pathname === '/hist2') {
      // "top-owned history" shell: the top creates every history entry with pushState and
      // the iframe only ever navigates with location.replace().
      const n = q.get('n') || '?';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': q.get('cc') === '0' ? 'max-age=0' : 'no-store' });
      res.end(`<!doctype html><title>Page ${n}</title><body><h1>${n}</h1>
<script>
if (top === self) {
  document.title = 'shell';
  window.__events = [];
  const f = document.createElement('iframe'); f.name = 'margin-frame'; f.style.cssText = 'width:600px;height:300px';
  addEventListener('pageshow', (e) => __events.push('pageshow:persisted=' + e.persisted));
  addEventListener('popstate', (e) => { __events.push('top-popstate:' + location.href); f.contentWindow.location.replace(location.href); });
  window.navFrame = (url) => { history.pushState({ margin: 1 }, '', url); f.contentWindow.location.replace(url); };
  f.addEventListener('load', () => {
    let fu; try { fu = f.contentWindow.location.href; } catch (e) { fu = null; }
    __events.push('iframe-load:' + fu);
    if (fu && fu !== location.href) { __events.push('fallback-replaceState'); history.replaceState(history.state, '', fu); }
    if (fu) document.title = f.contentDocument.title;
  });
  f.src = location.href;
  document.body.appendChild(f); window.__f = f;
}
</script></body>`);
      return;
    }
    if (u.pathname === '/hist3') {
      // top-owned history for cross-document frame navigations + SPA pushState inside the frame,
      // mirrored to the top with replaceState (strategy) or with a top pushState (strategy=push)
      const n = q.get('n') || '?';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Page ${n}</title><body><h1>${n}</h1>
<script>
if (top === self) {
  document.title = 'shell';
  window.__events = [];
  const f = document.createElement('iframe'); f.name = 'margin-frame'; f.style.cssText = 'width:600px;height:300px';
  addEventListener('pageshow', (e) => __events.push('pageshow:persisted=' + e.persisted));
  addEventListener('popstate', (e) => {
    __events.push('top-popstate:' + location.href + ' state=' + JSON.stringify(e.state));
    let fu; try { fu = f.contentWindow.location.href; } catch (x) {}
    if (fu !== location.href) f.contentWindow.location.replace(location.href);
  });
  window.navFrame = (url) => { history.pushState({ margin: 1 }, '', url); f.contentWindow.location.replace(url); };
  const sync = () => {
    let fu; try { fu = f.contentWindow.location.href; } catch (e) { fu = null; }
    if (fu && fu !== location.href) { __events.push('sync-replaceState:' + fu); history.replaceState(history.state, '', fu); }
    if (fu) document.title = f.contentDocument.title;
  };
  window.__sync = sync;
  f.addEventListener('load', () => {
    __events.push('iframe-load:' + (()=>{try{return f.contentWindow.location.href}catch(e){return 'XO'}})());
    sync();
    try { f.contentWindow.navigation.addEventListener('currententrychange', () => { __events.push('frame-cec:' + f.contentWindow.location.href); sync(); }); } catch (e) {}
  });
  f.src = location.href;
  document.body.appendChild(f); window.__f = f;
} else {
  addEventListener('popstate', (e) => { document.querySelector('h1').textContent = location.search; try { top.__events.push('frame-popstate:' + location.href); } catch (x) {} });
}
</script></body>`);
      return;
    }
    if (u.pathname === '/owasp') {
      // classic OWASP anti-clickjacking snippet; top-level -> shell, framed -> snippet runs
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html><head><title>owasp</title>${LOGGER}<style id="antiClickjack">body{display:none !important;}</style></head><body>content
<script>
if (window.top === window && !window.__marginFrame) {
  const f = document.createElement('iframe'); f.name = 'margin-frame'; f.src = location.href; document.body.appendChild(f);
  document.getElementById('antiClickjack').remove();
  if (typeof navigation !== 'undefined') navigation.addEventListener('navigate', (e) => { if (!e.destination.sameDocument) { e.preventDefault(); log({ ev: 'top-navigate', action: 'prevented', dest: e.destination.url }); } });
} else {
  if (self === top) { var a = document.getElementById('antiClickjack'); a.parentNode.removeChild(a); }
  else { top.location = self.location; }
  setTimeout(() => log({ ev: 'owasp-frame', visible: getComputedStyle(document.body).display !== 'none', selfIsTop: self === top, windowIsTop: window === top }), 300);
}
</script></body></html>`);
      return;
    }
    if (u.pathname === '/hist4') {
      // fully top-owned history: cross-doc frame navs via navFrame(), SPA pushState in the frame
      // rewritten by a (would-be MAIN-world content script) wrapper into frame replaceState + top pushState.
      const n = q.get('n') || '?';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Page ${n}</title><script>
// ---- would be a MAIN-world document_start content script in the frame ----
(function () {
  if (window.top === window) return;
  let T; try { T = window.top; void T.location.href; if (!T.__marginShell) return; } catch (e) { return; }
  window.__marginDocId = Math.random().toString(36).slice(2);
  const H = History.prototype, push = H.pushState, replace = H.replaceState;
  H.pushState = function (state, title, url) {
    replace.call(this, state, title, url);
    T.__marginPush(location.href, state, window.__marginDocId);
  };
  window.__marginApplyPop = (url, state) => { replace.call(history, state, '', url); dispatchEvent(new PopStateEvent('popstate', { state })); };
})();
</script><body><h1>${n}</h1>
<script>
if (top === self) {
  window.__marginShell = true;
  document.title = 'shell';
  window.__events = [];
  const f = document.createElement('iframe'); f.name = 'margin-frame'; f.style.cssText = 'width:600px;height:300px';
  addEventListener('pageshow', (e) => __events.push('pageshow:persisted=' + e.persisted));
  window.__marginPush = (url, appState, docId) => { history.pushState({ margin: 'spa', docId, appState }, '', url); __events.push('top-push(spa):' + url); setTimeout(sync, 0); };
  window.navFrame = (url) => { history.pushState({ margin: 'doc' }, '', url); f.contentWindow.location.replace(url); };
  addEventListener('popstate', (e) => {
    const st = e.state || {};
    let fw = f.contentWindow, fu; try { fu = fw.location.href; } catch (x) {}
    if (st.docId && fw.__marginDocId === st.docId) { fw.__marginApplyPop(location.href, st.appState); __events.push('top-popstate->frame same-doc pop:' + location.href); sync(); }
    else if (fu !== location.href) { __events.push('top-popstate->frame replace:' + location.href); fw.location.replace(location.href); }
    else __events.push('top-popstate (no-op):' + location.href);
  });
  const sync = () => {
    let fu; try { fu = f.contentWindow.location.href; } catch (e) { fu = null; }
    if (fu && fu !== location.href) { __events.push('fallback-replaceState:' + fu); history.replaceState(history.state, '', fu); }
    if (fu) document.title = f.contentDocument.title;
  };
  f.addEventListener('load', () => {
    __events.push('iframe-load:' + (()=>{try{return f.contentWindow.location.href}catch(e){return 'XO'}})()); sync();
    try { history.replaceState(Object.assign({}, history.state, { docId: f.contentWindow.__marginDocId }), '', location.href); } catch (e) {}
  });
  f.src = location.href;
  document.body.appendChild(f); window.__f = f;
} else {
  addEventListener('popstate', (e) => { document.title = 'Page ' + new URLSearchParams(location.search).get('n'); top.__events.push('frame-popstate:' + location.href + ' state=' + JSON.stringify(e.state)); });
}
</script></body>`);
      return;
    }
    if (u.pathname === '/hist') {
      // simple page for session-history test
      const n = q.get('n') || '?';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><title>Page ${n}</title>${LOGGER}<body><h1>${n}</h1>
<script>
if (top === self) {
  document.title = 'shell';
  const f = document.createElement('iframe'); f.name = 'margin-frame'; f.src = location.href; f.style.cssText = 'width:600px;height:300px';
  document.body.appendChild(f); window.__f = f; window.__events = [];
  addEventListener('popstate', (e) => __events.push('top-popstate:' + location.href));
  if (typeof navigation !== 'undefined') navigation.addEventListener('navigate', (e) => __events.push('top-navigate:' + e.navigationType + ':' + e.destination.url + ':c=' + e.cancelable));
  const SYNC = new URLSearchParams(location.search).get('sync') !== '0';
  f.addEventListener('load', () => {
    let fu; try { fu = f.contentWindow.location.href; } catch (e) { fu = null; }
    __events.push('iframe-load:' + fu);
    if (SYNC && fu && fu !== location.href) { history.replaceState(history.state, '', fu); }
    if (SYNC && fu) { document.title = f.contentDocument.title; }
  });
} else {
  if (typeof navigation !== 'undefined') navigation.addEventListener('navigate', (e) => { try { top.__events.push('frame-navigate:' + e.navigationType + ':' + e.destination.url + ':c=' + e.cancelable); } catch (x) {} });
}
</script></body>`);
      return;
    }
    res.writeHead(404); res.end('nf');
  };
}

for (const p of PORTS) http.createServer(handler(p)).listen(p, '0.0.0.0', () => console.log('listening', p));
