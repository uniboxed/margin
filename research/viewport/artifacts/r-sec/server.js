// Security test server. usage: node server.js PORT
// Targets /t/<name> send framing headers; each reports to top via external /report.js.
const http = require('http');
const port = +process.argv[2];
const TARGETS = {
  plain: {},
  deny: { 'x-frame-options': 'DENY' },
  same: { 'x-frame-options': 'SAMEORIGIN' },
  fanone: { 'content-security-policy': "frame-ancestors 'none'; script-src 'self'" },
  faself: { 'content-security-policy': "frame-ancestors 'self'; script-src 'self'" },
  both: { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; script-src 'self'" },
};
const target = (name) => `<!doctype html><title>${name}</title><body>${name}
<script>window.__inline = 1;</script>
<script src="/report.js?name=${name}"></script>`;
const report = `(() => { const n = new URL(document.currentScript.src).searchParams.get('name');
  let topSame = false; try { topSame = !!top.document; } catch (e) {}
  top.postMessage({ name: n, origin: location.origin, inlineRan: !!window.__inline, topSameOrigin: topSame }, '*'); })();`;
const collector = (frames, extraHead = '') => `<!doctype html><head>${extraHead}<title>pending</title></head><body><script>
  const got = {}; const viol = [];
  addEventListener('message', (e) => { if (e.data && e.data.name) got[e.data.name] = e.data; });
  document.addEventListener('securitypolicyviolation', (e) => viol.push({ dir: e.effectiveDirective, blockedURI: e.blockedURI }));
  for (const f of ${JSON.stringify(frames)}) { const fr = document.createElement('iframe'); fr.src = f; fr.style.cssText = 'width:300px;height:100px'; document.body.append(fr); }
  setTimeout(() => { const out = {}; for (const f of ${JSON.stringify(frames)}) { const n = decodeURIComponent(f).split('/t/').pop(); out[n] = got[n] ? (got[n].inlineRan ? 'LOADED(inline-script-ran)' : 'LOADED(inline-script-blocked)') + '@' + got[n].origin : 'BLOCKED'; }
    if (viol.length) out._violations = viol; document.title = JSON.stringify(out); }, 2500);
</script>`;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const h = { 'content-type': 'text/html', 'cache-control': 'no-store' };
  if (u.pathname === '/hdr') { res.writeHead(200, Object.assign({}, h, { 'x-frame-options': 'DENY' })); return res.end('<!doctype html><title>' + JSON.stringify({ xm: req.headers['x-margin-test'] || null, dest: req.headers['sec-fetch-dest'] || null }).replace(/</g, '') + '</title>'); }
  if (u.pathname === '/page') { const c = u.searchParams.get('csp'); res.writeHead(200, Object.assign({}, h, c ? { 'content-security-policy': c } : {})); return res.end('<!doctype html><head><title>page</title><script>document.documentElement.dataset.siteRan = "1";</script></head><body>page</body>'); }
  if (u.pathname === '/report.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(report); }
  if (u.pathname === '/shell') { res.writeHead(200, h); return res.end(collector(u.searchParams.get('f').split(','))); }
  if (u.pathname === '/ad') { // third-party intermediate frame that nests the victim
    res.writeHead(200, h); const f = u.searchParams.get('f');
    return res.end(`<!doctype html><body>ad<iframe src="${f}" style="width:280px;height:80px"></iframe>`);
  }
  if (u.pathname === '/navshell') { // emulates the Margin shell with a meta CSP frame-src 'self' injected by a content script
    res.writeHead(200, h);
    const f = u.searchParams.get('f').split(',');
    return res.end(`<!doctype html><head><title>pending</title><script>
      const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = "frame-src 'self'"; document.head.append(m);
    </script></head><body><script>
      const got = {}; const viol = []; const loads = [];
      addEventListener('message', (e) => { if (e.data && e.data.name) got[e.data.name] = e.data; });
      document.addEventListener('securitypolicyviolation', (e) => viol.push({ dir: e.effectiveDirective, blockedURI: e.blockedURI, src: e.sourceFile }));
      for (const s of ${JSON.stringify(f)}) { const fr = document.createElement('iframe'); fr.src = s; fr.onload = () => { let where; try { where = fr.contentWindow.location.href; } catch (e) { where = 'CROSS-ORIGIN(' + e.name + ')'; } loads.push(s + ' -> ' + where); }; document.body.append(fr); }
      setTimeout(() => { document.title = JSON.stringify({ got, viol, loads }); }, 3000);
    </script>`);
  }
  if (u.pathname === '/t/hop') { // same-origin page that navigates its own frame cross-origin
    res.writeHead(200, h); const to = u.searchParams.get('to');
    return res.end(`<!doctype html><body>hop<script>setTimeout(() => { location.href = ${JSON.stringify(to)}; }, 200);</script>`);
  }
  if (u.pathname === '/t/redir') { res.writeHead(302, { location: u.searchParams.get('to') }); return res.end(); }
  if (u.pathname === '/t/embeds3p') { // same-origin page that itself embeds a third-party frame (grandchild of the shell)
    res.writeHead(200, h); const g = u.searchParams.get('g');
    return res.end(`<!doctype html><body>embeds3p<iframe src="${g}"></iframe>`);
  }
  const m = u.pathname.match(/^\/t\/(\w+)$/);
  if (m && TARGETS[m[1]]) { res.writeHead(200, Object.assign({}, h, TARGETS[m[1]])); return res.end(target(m[1])); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('listening ' + port));
