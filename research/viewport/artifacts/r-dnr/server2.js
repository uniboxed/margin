// Feasibility check: frame an X-Frame-Options: DENY / CSP frame-ancestors 'none' page without a network
// navigation (fetch + srcdoc, or fetch + document.write into about:blank). Usage: node server2.js PORT
const http = require('http');
const port = +process.argv[2];
const page = (name, hdrs) => ({ hdrs: Object.assign({ 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': 'sid=abc; Path=/; SameSite=Lax' }, hdrs),
  body: `<!doctype html><title>${name}</title><body><p id=p>${name}</p><script>
    let rs = null; try { history.replaceState(null, '', '/${name}?replaced'); rs = location.href; } catch (e) { rs = 'ERR ' + e.name; }
    top.postMessage({ name: ${JSON.stringify(name)}, href: rs, cookie: document.cookie, inline: 'ran', vw: innerWidth }, '*');
  </script>` });
const routes = {
  '/plain': () => page('plain', {}),
  '/xfo-deny': () => page('xfo-deny', { 'x-frame-options': 'DENY' }),
  '/csp-none': () => page('csp-none', { 'content-security-policy': "frame-ancestors 'none'" }),
  '/nonce': () => page('nonce', { 'x-frame-options': 'DENY', 'content-security-policy': "script-src 'nonce-SERVER2'; frame-ancestors 'none'" }),
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/shell') {
    const mode = u.searchParams.get('mode'); const targets = u.searchParams.get('f').split(',');
    const shellCsp = u.searchParams.get('csp');
    const h = { 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': 'sid=abc; Path=/; SameSite=Lax' };
    if (shellCsp) h['content-security-policy'] = shellCsp;
    res.writeHead(200, h);
    return res.end(`<!doctype html><title>pending</title><body><script nonce="SHELL1">
      const got = {};
      addEventListener('message', (e) => { got[e.data.name] = e.data; });
      (async () => {
        for (const f of ${JSON.stringify(targets)}) {
          const html = await (await fetch(f, { credentials: 'include' })).text();
          const fr = document.createElement('iframe'); fr.style.cssText = 'width:400px;height:150px';
          if ('${mode}' === 'srcdoc') { fr.srcdoc = html; document.body.append(fr); }
          else if ('${mode}' === 'write') { document.body.append(fr); const d = fr.contentDocument; d.open(); d.write(html); d.close(); }
          else if ('${mode}' === 'object') { const o = document.createElement('object'); o.type = 'text/html'; o.data = f; o.style.cssText = 'width:400px;height:150px'; document.body.append(o); }
          else if ('${mode}' === 'embed') { const o = document.createElement('embed'); o.type = 'text/html'; o.src = f; o.style.cssText = 'width:400px;height:150px'; document.body.append(o); }
          else { fr.src = f; document.body.append(fr); }
        }
        setTimeout(() => { const out = {}; ${JSON.stringify(targets)}.forEach((f) => { const n = f.slice(1); out[n] = got[n] || 'BLOCKED/NO-SCRIPT'; }); document.title = JSON.stringify(out); }, 1500);
      })();
    </script>`);
  }
  const r = routes[u.pathname]; if (!r) { res.writeHead(404); return res.end(); }
  const { hdrs, body } = r(); res.writeHead(200, hdrs); res.end(body);
}).listen(port, '127.0.0.1', () => console.log('listening ' + port));
