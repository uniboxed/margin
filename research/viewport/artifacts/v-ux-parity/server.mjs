// UX-parity test site. node server.mjs PORT
import http from 'node:http';
const PORT = +process.argv[2];
let log = [];
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const HDR = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const q = u.searchParams;
  let body = '';
  if (req.method === 'POST') { for await (const c of req) body += c; }
  const e = { t: Date.now(), m: req.method, host: req.headers.host, p: u.pathname + u.search, dest: req.headers['sec-fetch-dest'], body: body || undefined };
  if (u.pathname === '/log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/clear') { log = []; res.writeHead(200); return res.end('ok'); }
  log.push(e);
  const n = q.get('n') || 'A';
  if (u.pathname === '/css') { await sleep(+q.get('ms') || 0); res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); return res.end(`html,body{background:${q.get('bg') || '#0a0'} !important}`); }
  if (u.pathname === '/b' || u.pathname.startsWith('/icon')) { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); return res.end(GIF); }
  if (u.pathname === '/stream') {
    // head + visible header immediately, rest after `gap` ms
    const gap = +q.get('gap') || 0, css = q.get('css');
    res.writeHead(200, HDR);
    res.write(`<!doctype html><html><head><title>Stream ${n}</title>${css ? `<link rel=stylesheet href="/css?ms=${css}&bg=${encodeURIComponent(q.get('bg') || '#0a0')}">` : `<style>body{background:${q.get('bg') || '#0a0'}}</style>`}</head><body style="margin:0"><div id=hdr style="height:200px;background:#c00;color:#fff;font:40px sans-serif">HEADER ${n} ${'x'.repeat(2000)}</div>\n`);
    res.write(' '.repeat(4096));
    await sleep(gap);
    res.end(`<div id=rest style="height:200px;background:#00c;color:#fff">REST ${n}</div><a id=lB href="/stream?n=B&gap=${gap}${css ? '&css=' + css : ''}">B</a>${filler(30)}</body></html>`);
    return;
  }
  if (u.pathname === '/sjis') { res.writeHead(200, { 'content-type': 'text/html; charset=shift_jis', 'cache-control': 'no-store' }); return res.end(`<!doctype html><title>SJIS</title><form id=f action="/sjis-result"><input name=q id=q><button id=go>go</button></form><a id=l href="/sjis-result?x=\x93\xfa">link</a>`, 'latin1'); }
  if (u.pathname === '/sjis-result') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><title>R</title><pre id=b>${req.url}</pre>`); }
  res.writeHead(200, HDR);
  if (u.pathname === '/bu') return res.end(`<!doctype html><title>BU</title><textarea id=ta></textarea><a id=lB href="/page?n=B">B</a><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x'; return 'x'; });</script>`);
  if (u.pathname === '/autofocus') return res.end(`<!doctype html><title>AF</title><p>before</p><input id=q autofocus><script>addEventListener('load',()=>{window.__af=document.activeElement&&document.activeElement.id})</script>`);
  if (u.pathname === '/long') return res.end(`<!doctype html><title>Long ${n}</title><h1>Long ${n}</h1><input id=t><textarea id=ta></textarea><a id=next href="/long?n=${n}2">next</a>${filler(300)}`);
  if (u.pathname === '/tf') return res.end(`<!doctype html><title>TF</title><h1>TF</h1>${filler(200)}<p id=target>ZQXJV unique phrase here</p>${filler(50)}`);
  if (u.pathname === '/ads') return res.end(`<!doctype html><title>Ads</title><div class=adA>adA</div><div class=adB>adB</div><div class=adC>adC</div><div class=adD>adD</div><div class=ctl>ctl</div>`);
  if (u.pathname === '/login') return res.end(`<!doctype html><title>Login</title><form id=f method=post action="/dologin"><input name=username id=u autocomplete=username><input type=password name=password id=pw autocomplete=current-password><button id=go>Sign in</button></form>`);
  if (u.pathname === '/dologin') return res.end(`<!doctype html><title>Welcome</title><h1 id=h>Welcome</h1><pre id=b>${body.replace(/</g, '&lt;')}</pre>`);
  if (u.pathname === '/navapi') return res.end(`<!doctype html><title>NavAPI ${q.get('p') || '1'}</title><h1 id=h>NavAPI page ${q.get('p') || '1'}</h1><a id=l2 href="/navapi?p=2">p2</a>
<script>window.__docId = Math.random(); window.__log = [];
navigation.addEventListener('navigate', (e) => {
  const url = new URL(e.destination.url);
  if (!e.canIntercept || url.pathname !== '/navapi' || e.hashChange || e.downloadRequest) return;
  try { e.intercept({ handler: async () => { document.getElementById('h').textContent = 'NavAPI page ' + url.searchParams.get('p') + ' (SPA)'; document.title = 'NavAPI ' + url.searchParams.get('p'); } }); __log.push('intercepted'); }
  catch (err) { __log.push('intercept threw: ' + err.name + ': ' + err.message); }
});</script>`);
  if (u.pathname === '/page') return res.end(`<!doctype html><title>Page ${n}</title><h1 id=h>Page ${n}</h1><a id=lB href="/page?n=B">B</a>${filler(40)}`);
  res.end('404');
}).listen(PORT, '0.0.0.0');
