// Test server for framing experiments.
// Usage: node server.js PORT
// Pages:
//   /shell?f=<path>[,<path>...]  top page that frames each path same-origin, reports JSON in document.title
//   /plain        frameable page (control)
//   /xfo-deny     X-Frame-Options: DENY
//   /xfo-same     X-Frame-Options: SAMEORIGIN
//   /csp-none     Content-Security-Policy: frame-ancestors 'none'
//   /csp-self     Content-Security-Policy: frame-ancestors 'self'
//   /echo         frameable page that reports the request headers it received
const http = require('http');
const port = +process.argv[2] || 8701;
const log = [];

function framed(name, extraHeaders, req) {
  return {
    headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, extraHeaders),
    body: `<!doctype html><title>${name}</title><body>${name}<script>
      for (const w of new Set([parent, top])) w.postMessage({ name: ${JSON.stringify(name)}, loaded: true,
        hdr: ${JSON.stringify({ xm: req.headers['x-margin-test'] || null, al: req.headers['accept-language'] || null, sfd: req.headers['sec-fetch-dest'] || null })} }, '*');
    </script>`,
  };
}

const routes = {
  '/plain': (req) => framed('plain', {}, req),
  '/xfo-deny': (req) => framed('xfo-deny', { 'x-frame-options': 'DENY' }, req),
  '/xfo-same': (req) => framed('xfo-same', { 'x-frame-options': 'SAMEORIGIN' }, req),
  '/csp-none': (req) => framed('csp-none', { 'content-security-policy': "frame-ancestors 'none'" }, req),
  '/csp-self': (req) => framed('csp-self', { 'content-security-policy': "frame-ancestors 'self'" }, req),
  '/echo': (req) => framed('echo', {}, req),
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  log.push({ path: u.pathname, xm: req.headers['x-margin-test'] || null, sfd: req.headers['sec-fetch-dest'] || null });
  if (u.pathname === '/log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(log));
  }
  if (u.pathname === '/shell') {
    const frames = (u.searchParams.get('f') || '/plain').split(',');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(`<!doctype html><title>pending</title><body>
      ${frames.map((f) => `<iframe src="${f}" style="width:300px;height:100px"></iframe>`).join('')}
      <script>
        const got = {};
        addEventListener('message', (e) => { got[e.data.name] = e.data; });
        setTimeout(() => {
          const out = {};
          const want = (new URLSearchParams(location.search).get('expect') || ${JSON.stringify(frames.join(','))}).split(',');
          want.forEach((f) => { const n = new URL(f, location.href).pathname.slice(1); out[n] = got[n] ? (got[n].hdr && (got[n].hdr.xm || got[n].hdr.al) ? got[n].hdr : 'LOADED') : 'BLOCKED'; });
          document.title = JSON.stringify(out);
        }, 1500);
      </script>`);
  }
  const r = routes[u.pathname];
  if (!r) { res.writeHead(404); return res.end('nf'); }
  const { headers, body } = r(req);
  res.writeHead(200, headers);
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log('listening ' + port));
