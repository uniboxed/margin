// Test server for the same-origin iframe-shell experiments (WebKitGTK harness).
// Listens on two ports (default 8931, 8932) on all interfaces:
//   http://localhost:8931   = origin A (the "site")
//   http://localhost:8932   = same-site, cross-ORIGIN (port differs)
//   http://127.0.0.1:8931   = cross-SITE
// Every request is logged in memory; GET /__log?since=N returns entries, /__clear resets.
//
// Page:   /p/<name>?xfo=DENY|SAMEORIGIN&fa=none|self&tcsp=<top CSP>&bust=1&delay=ms&cookie=1&pushy=1
// 302:    /r?to=<absolute url>
// beacon: /b?...   (204)
import { createServer } from 'node:http';

const PORTS = (process.env.PORTS || '8931,8932').split(',').map(Number);
const T0 = performance.now();
let seq = 0;
const log = [];

function page(name, q, port) {
  const A = `http://localhost:${PORTS[0]}`;
  const B = `http://localhost:${PORTS[1]}`;
  const X = `http://127.0.0.1:${PORTS[0]}`;
  const bust = q.get('bust') === '1';
  const keep = new URLSearchParams(q); keep.delete('cookie'); keep.delete('delay');
  const ks = keep.toString() ? '?' + keep.toString() : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Page ${name}</title>
<meta name="theme-color" content="#${name === 'B' ? '00aa00' : 'aa0000'}">
<link rel="icon" href="/favicon-${name}.png">
${q.get('owasp') ? '<style id="antiClickjack">body{display:none !important;}</style><script>if (self === top) { var a = document.getElementById("antiClickjack"); a.parentNode.removeChild(a); } else { top.location = self.location; }</script>' : ''}
<script>
  // inline head script: counts executions per document and beacons the context
  window.__inlineHead = (window.__inlineHead || 0) + 1;
  window.__ctx = (window.top === window) ? 'top' : 'frame';
  try { (new Image()).src = '/b?ev=inline-head&page=${name}&ctx=' + window.__ctx + '&t=' + Date.now(); } catch (e) {}
  ${bust ? "if (top !== self) { window.__bustTried = 1; try { top.location = self.location; } catch (e) { window.__bustErr = String(e); } }" : ''}
</script>
<script src="/s.js?page=${name}"></script>
${q.get('big') ? Array.from({length: 20}, (_, i) => `<link rel="stylesheet" href="/style.css?big=${i}"><script src="/s.js?big=${i}"></script>`).join('') + '<!--' + 'x'.repeat(Number(q.get('big')) * 1024) + '-->' : ''}
<link rel="stylesheet" href="/style.css?page=${name}">
<style>
  html, body { margin: 0; font: 14px sans-serif; }
  #hdr { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #36c; color: #fff; z-index: 5; }
  #vw { width: 100vw; height: 20px; background: #c63; }
  #content { height: 3000px; padding-top: 50px; background: linear-gradient(#fff, #ddd); }
  #mq::after { content: 'wide'; }
  @media (max-width: 800px) { #mq::after { content: 'narrow'; } }
</style>
</head><body>
<div id="hdr">fixed header ${name}</div>
<div id="content">
  <div id="vw"></div>
  <div id="mq"></div>
  <p>needle-${name} unique text for find-in-page</p>
  <p><a id="lB" href="/p/B${ks}">same-origin B</a> |
     <a id="lC" href="/p/C${ks}">same-origin C</a> |
     <a id="lX" href="${X}/p/X">cross-site X</a> |
     <a id="lO" href="${B}/p/O">cross-origin same-site O</a> |
     <a id="lR" href="/r?to=${encodeURIComponent(X + '/p/RX')}">same-origin 302 -> cross-site</a> |
     <a id="lRD" href="/r?to=${encodeURIComponent(X + '/p/RXD?xfo=DENY')}">302 -> cross-site with XFO DENY</a> |
     <a id="lTop" href="/p/T${ks}" target="_top">target=_top T</a> |
     <a id="lBlank" href="/p/N" target="_blank">target=_blank N</a> |
     <a id="lHash" href="#sec2">hash</a>
  </p>
  <form id="fPost" method="post" action="/p/POSTED"><input name="q" value="1"><button>post</button></form>
  <div id="sec2" style="margin-top:1200px">section 2</div>
  <input id="inp" placeholder="input"${q.get('af') ? ' autofocus' : ''}>
</div>
<script>
  window.__inlineBody = (window.__inlineBody || 0) + 1;
  try { (new Image()).src = '/b?ev=inline-body&page=${name}&ctx=' + window.__ctx + '&t=' + Date.now(); } catch (e) {}
  window.__scrollEvents = 0;
  addEventListener('scroll', () => { window.__scrollEvents++; });
  window.__keydowns = [];
  addEventListener('keydown', (e) => { window.__keydowns.push(e.key); });
</script>
<img src="/img.png?page=${name}" width="1" height="1">
</body></html>`;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function handler(port) {
  return async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const entry = {
      i: ++seq, t: +(performance.now() - T0).toFixed(1), port, host: req.headers.host, method: req.method,
      path: u.pathname + u.search, dest: req.headers['sec-fetch-dest'] || null, site: req.headers['sec-fetch-site'] || null,
      cookie: req.headers.cookie || null, xmt: req.headers['x-margin-test'] || null, referer: req.headers.referer || null,
    };
    if (!u.pathname.startsWith('/__')) log.push(entry);
    res.setHeader('Cache-Control', u.searchParams.get('cache') ? 'max-age=' + u.searchParams.get('cache') : 'no-store');
    if (u.pathname === '/__log') {
      const since = Number(u.searchParams.get('since') || 0);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(JSON.stringify(log.filter((e) => e.i > since)));
    }
    if (u.pathname === '/__clear') { log.length = 0; res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('ok'); }
    if (u.pathname === '/r') { res.statusCode = 302; res.setHeader('Location', u.searchParams.get('to')); return res.end(); }
    if (u.pathname === '/b') { res.statusCode = 204; return res.end(); }
    if (u.pathname === '/s.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.__ext = (window.__ext||0)+1;'); }
    if (u.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); return res.end('/* css */'); }
    if (u.pathname.endsWith('.png')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
    if (u.pathname === '/json') { res.setHeader('Content-Type', 'application/json'); return res.end('{"a":1}'); }
    if (u.pathname.startsWith('/p/')) {
      const q = u.searchParams;
      const delay = Number(q.get('delay') || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const name = u.pathname.slice(3) || 'A';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (q.get('linkpreload')) res.setHeader('Link', '</img.png?via=link-header>; rel=preload; as=image');
      if (q.get('xfo')) res.setHeader('X-Frame-Options', q.get('xfo'));
      const csp = [];
      if (q.get('fa')) csp.push(`frame-ancestors ${q.get('fa') === 'none' ? "'none'" : q.get('fa') === 'self' ? "'self'" : q.get('fa')}`);
      if (q.get('tcsp')) csp.push(q.get('tcsp'));
      if (csp.length) res.setHeader('Content-Security-Policy', csp.join('; '));
      if (q.get('cookie') === '1') {
        const v = Date.now().toString(36);
        res.setHeader('Set-Cookie', [
          `lax=L${v}; SameSite=Lax; Path=/`,
          `strict=S${v}; SameSite=Strict; Path=/`,
          `honly=H${v}; HttpOnly; SameSite=Lax; Path=/`,
        ]);
      }
      return res.end(page(name, q, port));
    }
    res.statusCode = 404; res.end('nf');
  };
}

for (const port of PORTS) createServer(handler(port)).listen(port, () => console.log(`listening ${port}`));
