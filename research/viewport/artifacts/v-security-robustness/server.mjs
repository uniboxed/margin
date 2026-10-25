// Security/robustness probes for the transplant shell: is the page's own CSP (script-src, Trusted Types,
// img-src) still enforced inside the card? Is a legacy charset preserved? What does meta refresh do?
// node server.mjs PORT
import http from 'node:http';
const PORT = +process.argv[2];
let log = [];
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const B = (ev) => `new Image().src='/b?ev='+encodeURIComponent(${ev})+'&f='+(window===top?'top':'sub');`;
const POLICY = "script-src 'nonce-abc'; require-trusted-types-for 'script'; img-src 'self'";
const cspPage = (meta) => `<!doctype html><html><head><meta charset="utf-8">${meta ? `<meta http-equiv="Content-Security-Policy" content="${POLICY}">` : ''}<title>CSP ${meta ? 'meta' : 'header'}</title>
<script nonce="abc">${B("'nonce-ran'")}</script>
<script>${B("'NO-NONCE-RAN'")}</script>
</head><body><div id=d></div>
<script nonce="abc">
try { document.getElementById('d').innerHTML = '<b>x</b>'; ${B("'TT-NOT-ENFORCED'")} } catch (e) { ${B("'tt-enforced:'+e.name")} }
try { eval('1'); ${B("'EVAL-ALLOWED'")} } catch (e) { ${B("'eval-blocked:'+e.name")} }
</script>
<img src="http://127.0.0.1:${PORT}/b?ev=XORIGIN-IMG-LOADED">
</body></html>`;
// Shift_JIS bytes for 日本 = 93 FA 96 7B
const sjisBody = Buffer.concat([
  Buffer.from('<!doctype html><html><head><meta charset="Shift_JIS"><title>sjis</title></head><body><p id=p>'),
  Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
  Buffer.from(`</p><a id=a href="/q?q=`), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from(`">q</a>
<script>${B("'cs='+document.characterSet+'|text='+encodeURIComponent(document.getElementById('p').textContent)+'|href='+document.getElementById('a').href.split('?')[1]")}</script>
</body></html>`)]);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/clear') { log = []; res.writeHead(200); return res.end('ok'); }
  log.push({ m: req.method, host: req.headers.host, p: u.pathname + u.search, dest: req.headers['sec-fetch-dest'] || null });
  if (u.pathname === '/csp-header') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY }); return res.end(cspPage(false)); }
  if (u.pathname === '/csp-meta') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(cspPage(true)); }
  if (u.pathname === '/sjis') { res.writeHead(200, { 'content-type': 'text/html; charset=Shift_JIS' }); return res.end(sjisBody); }
  if (u.pathname === '/refresh') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/landed"><title>refresh</title></head><body>r</body></html>`); }
  if (u.pathname === '/landed') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>landed</title><p>landed</p><script>${B("'landed'")}</script>`); }
  if (u.pathname === '/start') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>start</title><p>start</p>'); }
  if (u.pathname === '/lreplace') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>lreplace</title><script>location.replace('/landed')</script>`); }
  if (u.pathname === '/lhref') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>lhref</title><script>location.href='/landed'</script>`); }
  if (u.pathname === '/autopost') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>autopost</title><form method=post action=/landed2><input name=SAMLResponse value=abc123></form><script>document.forms[0].submit()</script>`); }
  if (u.pathname === '/landed2') { let body=''; req.on('data', c => body += c); return req.on('end', () => { log.push({ m: 'BODY', host: '', p: body, dest: null }); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>landed2</title><p>${req.method} ${body}</p>`); }); }
  if (u.pathname === '/reloader') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>reloader</title><p>r</p><script>${B("'reloader-ran'")} setTimeout(() => { if (!sessionStorage.r) { sessionStorage.r = 1; location.reload(); } }, 300);</script>`); }
  if (u.pathname === '/xparent') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>xparent</title><p>x</p><iframe src="http://127.0.0.1:${PORT}/xchild"></iframe>`); }
  if (u.pathname === '/xchild') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>xchild</title><script>new Image().src='/b?ev=xchild-ran'; setTimeout(() => { try { parent.location.href = 'http://localhost:${PORT}/landed'; new Image().src='/b?ev=xchild-assigned'; } catch (e) { new Image().src='/b?ev=xchild-threw-'+e.name; } }, 300);</script>`); }
  if (u.pathname === '/upload') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>upload</title><form method=post enctype="multipart/form-data" action="/landed3"><input type=file name=f><input name=t value=hello><button id=go type=submit name=go value=1>go</button></form><script>new Image().src='/b?ev=up-script'; addEventListener('load', () => setTimeout(() => { new Image().src='/b?ev=up-load-'+sessionStorage.u; const dt = new DataTransfer(); dt.items.add(new File(['FILECONTENT-XYZ'], 'a.txt', { type: 'text/plain' })); document.querySelector('input[type=file]').files = dt.files; if (!sessionStorage.u) { sessionStorage.u = 1; try { document.getElementById('go').click(); new Image().src='/b?ev=up-clicked'; } catch (e) { new Image().src='/b?ev=up-err-'+e.name; } } }, 300));</script>`); }
  if (u.pathname === '/landed3') { let body=''; req.on('data', c => body += c); return req.on('end', () => { log.push({ m: 'BODY', host: '', p: (req.headers['content-type']||'').split(';')[0] + ' || ' + body.replace(/\r?\n/g, ' ').slice(0, 300), dest: null }); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>landed3</title>ok'); }); }
  if (u.pathname === '/ld') { const css = u.searchParams.get('css'), img = u.searchParams.get('img'); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>ld</title>${css ? '<link rel=stylesheet href="/s.css?' + css + '">' : ''}<p>x</p>${img ? '<img src="/b?ev=img-' + img + '">' : ''}<script>document.addEventListener('DOMContentLoaded', () => { new Image().src='/b?ev=ld-dcl'; }); addEventListener('load', () => { new Image().src='/b?ev=ld-load'; }); setTimeout(() => { new Image().src='/b?ev=ld-rs-'+document.readyState; }, 1500);</script>`); }
  if (u.pathname === '/s.css') { return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); res.end('p{color:red}'); }, +(u.searchParams.get('ms') || 0)); }
  if (u.pathname === '/slow.js') { return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end("new Image().src='/b?ev=slowjs-ran'"); }, +(u.searchParams.get('ms') || 0)); }
  if (u.pathname === '/ldjs') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>ldjs</title><p>x</p><script>addEventListener('load', () => { new Image().src='/b?ev=ldjs-load'; });</script><script async src="/slow.js?ms=1500"></script>`); }
  if (u.pathname === '/b') { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); return res.end(GIF); }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log('listening', PORT));
