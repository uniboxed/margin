// Test site for the transplant-shell checks. node server.mjs PORT
import http from 'node:http';
const PORT = +process.argv[2];
let log = [];
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const page = (q) => {
  const n = q.get('n') || 'A';
  const slow = q.get('slow') || '0';
  return `<!doctype html><html><head><title>Page ${n}</title><link rel="icon" href="/icon-${n}.png">
<script>new Image().src='/b?ev=inline-head&n=${n}&ref='+encodeURIComponent(document.referrer)+'&framed='+(window!==top)+'&href='+encodeURIComponent(location.href);</script>
</head><body><h1 id=h>Page ${n}</h1>
<p><a id=lA href="/page?n=A">A</a> <a id=lB href="/page?n=B">B</a> <a id=lC href="/page?n=C">C</a>
<a id=lX href="http://127.0.0.1:${PORT}/start">cross-site</a>
<a id=lH href="#sec">hash</a> <button id=push onclick="history.pushState({s:1},'', '/page?n=${n}&spa=1'); document.getElementById('h').textContent='SPA ${n}'">push</button></p>
<div style="height:3000px"></div><h2 id=sec>sec</h2>
${slow !== '0' ? `<img src="/slow.gif?ms=${slow}">` : ''}
<script>addEventListener('load',()=>{new Image().src='/b?ev=page-load&n=${n}&t='+Math.round(performance.now())});
addEventListener('hashchange',()=>{new Image().src='/b?ev=hashchange&href='+encodeURIComponent(location.href)});addEventListener('popstate',e=>{new Image().src='/b?ev=popstate&n=${n}&href='+encodeURIComponent(location.href)});</script>
</body></html>`;
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const e = { t: Date.now(), m: req.method, host: req.headers.host, p: u.pathname + u.search, dest: req.headers['sec-fetch-dest'], site: req.headers['sec-fetch-site'], ref: req.headers['referer'] || null };
  if (u.pathname === '/log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/clear') { log = []; res.writeHead(200); return res.end('ok'); }
  log.push(e);
  if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }); return res.end(page(u.searchParams)); }
  if (u.pathname === '/start') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>start</title><a id=go href="http://localhost:${PORT}/page?n=A">go</a>`); }
  if (u.pathname === '/slow.gif') { return setTimeout(() => { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); res.end(GIF); }, +u.searchParams.get('ms')); }
  if (u.pathname === '/b' || u.pathname.startsWith('/icon')) { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); return res.end(GIF); }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0');
