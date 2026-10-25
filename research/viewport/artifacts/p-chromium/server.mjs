// Test site for the same-origin iframe shell prototype.
// Listens on two ports (default 8921, 8922) on all interfaces, so:
//   http://localhost:8921  = site A (the "main" site)
//   http://localhost:8922  = same-site, cross-ORIGIN (cookies are shared: they ignore ports)
//   http://127.0.0.1:8921  = cross-SITE
// Every request is logged (Sec-Fetch-Dest/Site, Cookie, ...). GET /__log returns the log,
// GET /__log?clear=1 clears it.
//
// Pages: /p/<name>?xfo=DENY|SAMEORIGIN&csp=<policy>&cookie=1&delay=<ms>&bust=<mode>&owasp=1
// Redirect: /r?to=<url>&code=302   POST sink: /post (echoes the form)   Beacons: /__beacon
import { createServer } from 'node:http';

const PORTS = (process.env.PORTS || '8921,8922').split(',').map(Number);
const T0 = performance.now();
let log = [];
let seq = 0;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(name, q, port, dest = '') {
  const title = q.get('title') || `page ${name}`;
  const bust = q.get('bust'); // assign | replace | href | reload | other
  const owasp = q.get('owasp') === '1';
  const bustJs = {
    assign: 'if (top !== self) top.location = self.location;',
    replace: 'if (top !== self) top.location.replace(self.location.href);',
    href: 'if (window.top != window.self) window.top.location.href = window.self.location.href;',
    reload: 'if (top !== self) top.location.reload();',
    other: "if (top !== self) top.location.href = '/p/framed-warning';",
  }[bust] || '';
  const A = `http://localhost:${PORTS[0]}`;
  const B = `http://localhost:${PORTS[1]}`;
  const X = `http://127.0.0.1:${PORTS[0]}`;
  return `<!doctype html><html${owasp ? ' id="antiClickjack"' : ''}><head><meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="icon" href="/icon.png?n=${esc(name)}">
<meta name="theme-color" content="#3366ff">
${owasp ? '<style id="antiClickjackStyle">html{display:none !important}</style>' : ''}
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; }
  #hdr { position: fixed; left: 0; right: 0; top: 0; height: 40px; background: #36f; color: #fff; z-index: 5; }
  #vw { width: 100vw; height: 20px; background: orange; }
  #content { padding-top: 48px; }
  #tall { height: 3000px; background: linear-gradient(#fff, #bbb); }
  #mq::after { content: 'wide'; }
  @media (max-width: 800px) { #mq::after { content: 'narrow'; } }
  a { display: inline-block; margin: 4px 8px; }
</style>
<script>
  (function () {
    var where = (top === self) ? 'top' : 'frame';
    window.__inlineRuns = (window.__inlineRuns || 0) + 1;
    try { navigator.sendBeacon('/__beacon?ev=inline&name=${esc(name)}&where=' + where); } catch (e) {}
  })();
</script>
<script src="/ext.js?name=${esc(name)}&for=${esc(dest)}"></script>
${bustJs ? `<script>${bustJs}</script>` : ''}
${owasp ? `<script>if (self === top) { var s = document.getElementById('antiClickjackStyle'); s.parentNode.removeChild(s); } else { top.location = self.location; }</script>` : ''}
</head><body>
<div id="hdr">header ${esc(name)}</div>
<div id="content">
  <div id="vw"></div>
  <div id="mq"></div>
  <p id="links">
    <a id="a" href="/p/A">A</a>
    <a id="b" href="/p/B">B</a>
    <a id="c" href="/p/C">C</a>
    <a id="hash" href="#section2">hash</a>
    <a id="xo" href="${B}/p/xo">cross-origin (same-site)</a>
    <a id="xs" href="${X}/p/xs">cross-site</a>
    <a id="redir" href="/r?to=${encodeURIComponent(B + '/p/xo-redir')}">same-origin 302 to cross-origin</a>
    <a id="top-same" href="/p/topsame" target="_top">_top same-origin</a>
    <a id="top-xo" href="${B}/p/topxo" target="_top">_top cross-origin</a>
    <a id="blank-same" href="/p/blanksame" target="_blank">_blank same-origin (noopener implied)</a>
    <a id="blank-opener" href="/p/blankopener" target="_blank" rel="opener">_blank rel=opener</a>
    <a id="blank-xo" href="${B}/p/blankxo" target="_blank">_blank cross-origin</a>
    <a id="mailto" href="mailto:someone@example.com">mailto</a>
  </p>
  <form id="f-xo" method="post" action="${B}/post"><input name="who" value="tirth"><input name="n" value="42"><button id="f-xo-btn">POST cross-origin</button></form>
  <form id="f-same-top" method="post" action="/post" target="_top"><input name="who" value="same"><button id="f-same-top-btn">POST same-origin _top</button></form>
  <img src="/img.png?name=${esc(name)}&for=${esc(dest)}" width="1" height="1" alt="">
  <button id="fs-btn" onclick="document.getElementById('vw').requestFullscreen().then(function(){window.__fs='ok'},function(e){window.__fs=String(e)})">fullscreen</button>
  <div id="tall"></div>
  <div id="section2">section 2</div>
</div>
<script>
  window.__scrolls = 0;
  addEventListener('scroll', function () { window.__scrolls++; });
  window.__port = ${port};
  window.__msgs = [];
  addEventListener('message', function (e) { window.__msgs.push({ data: e.data, origin: e.origin }); });
</script>
</body></html>`;
}

function handler(port) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const entry = {
      i: ++seq, t: +(performance.now() - T0).toFixed(1), port, host: req.headers.host, method: req.method,
      path: url.pathname + url.search, dest: req.headers['sec-fetch-dest'], site: req.headers['sec-fetch-site'],
      mode: req.headers['sec-fetch-mode'], user: req.headers['sec-fetch-user'], cookie: req.headers.cookie || '',
      referer: req.headers.referer || '', xMarginTest: req.headers['x-margin-test'],
    };
    if (url.pathname === '/__log') {
      if (url.searchParams.get('clear')) log = [];
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(JSON.stringify(log));
    }
    log.push(entry);
    const q = url.searchParams;
    const delay = Number(q.get('delay') || 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));

    if (url.pathname === '/__beacon') {
      entry.beacon = Object.fromEntries(q);
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname === '/ext.js') {
      res.setHeader('content-type', 'text/javascript');
      res.setHeader('cache-control', 'no-store');
      return res.end(`try{navigator.sendBeacon('/__beacon?ev=ext&name=${encodeURIComponent(q.get('name') || '')}&where='+(top===self?'top':'frame'))}catch(e){}`);
    }
    if (url.pathname === '/img.png' || url.pathname === '/icon.png' || url.pathname === '/favicon.ico') {
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'no-store');
      return res.end(PNG);
    }
    if (url.pathname === '/attack') {
      // A page that frames q.src (used to probe how broad the header-removal rules are).
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><title>attacker</title><body><iframe id="victim" src="${esc(q.get('src'))}" width="600" height="300"></iframe></body>`);
    }
    if (url.pathname === '/r') {
      res.statusCode = Number(q.get('code') || 302);
      res.setHeader('location', q.get('to'));
      return res.end();
    }
    if (url.pathname === '/post') {
      let body = '';
      for await (const c of req) body += c;
      entry.body = body;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><title>posted ${esc(req.method)}</title><body><pre id="body">${esc(req.method)} ${esc(body)}</pre></body>`);
    }
    if (url.pathname.startsWith('/p/')) {
      const name = decodeURIComponent(url.pathname.slice(3)) || 'home';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (q.get('xfo')) res.setHeader('x-frame-options', q.get('xfo'));
      if (q.get('csp')) res.setHeader('content-security-policy', q.get('csp'));
      if (q.get('cookie') === '1') {
        res.setHeader('set-cookie', [
          `lax=L${port}; SameSite=Lax; Path=/`,
          `strict=S${port}; SameSite=Strict; Path=/`,
          `honly=H${port}; HttpOnly; SameSite=Lax; Path=/`,
        ]);
      }
      const html = page(name, q, port, req.headers['sec-fetch-dest'] || '');
      const stream = Number(q.get('stream') || 0);
      if (!stream) return res.end(html);
      // Send the <head> part, pause, then a large filler body: shows whether the browser keeps
      // downloading (and parsing) the top-level response after the shell took over.
      const cut = html.indexOf('<body>');
      res.write(html.slice(0, cut));
      entry.finished = false;
      res.on('close', () => { entry.closedAt = +(performance.now() - T0).toFixed(1); entry.aborted = !res.writableFinished; });
      await new Promise((r) => setTimeout(r, stream));
      if (res.destroyed) return;
      res.write('<div style="display:none">' + 'x'.repeat(Number(q.get('filler') || 200000)) + '</div>');
      await new Promise((r) => setTimeout(r, stream));
      if (res.destroyed) return;
      entry.finished = true;
      return res.end(html.slice(cut));
    }
    res.statusCode = 404;
    res.end('not found');
  };
}

for (const port of PORTS) {
  createServer(handler(port)).listen(port, () => console.log(`listening ${port}`));
}
