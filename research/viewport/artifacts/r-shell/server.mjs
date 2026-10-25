// Test server for the "iframe shell" experiments.
// Logs every request (time, path, sec-fetch-dest, method) so we can see what
// the top document and the shell iframe fetched, and serves a test page whose
// own scripts report (beacon) when they execute.
import http from 'node:http';
import { URL } from 'node:url';

const PORT = +process.argv[2] || 8790;
let log = [];
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Main-world reporter used by the page's own scripts.
const PAGE_REP = `function __rep(tag){var f=(window.top===window)?'top':'sub';var q='/b?k=page&tag='+tag+'&f='+f+'&t='+Date.now()+'&u='+encodeURIComponent(location.pathname+location.search);try{var i=new Image();i.src=q;(window.__imgs=window.__imgs||[]).push(i);}catch(e){}try{console.log('P '+JSON.stringify({tag:tag,f:f,t:Date.now(),href:location.href}));}catch(e){}}`;

function pageHtml(q) {
  const tag = q.get('tag') || 'x';
  const nonce = q.get('nonce');
  const n = nonce ? ` nonce="${nonce}"` : '';
  const pad = 'x'.repeat((+q.get('pad') || 0) * 1024);
  const child = q.get('child') ? `<iframe id="sitechild" src="/child?tag=${tag}" style="width:200px;height:50px"></iframe><script${n}>var sc=document.getElementById('sitechild'); sc.__marginShell='expando-token'; sc.setAttribute('data-margin-frame','attr-token');</script>` : '';
  const head = `<!doctype html>
<html lang="en" data-site="1">
<head>
<meta charset="utf-8">
<title>Test page ${tag}</title>
<link rel="stylesheet" href="/s.css?tag=${tag}">
<script${n}>${PAGE_REP}
__rep('inline1');
${q.get('bust') ? "if (top !== self) { __rep('bust'); top.location = self.location.href; }" : ''}
localStorage.setItem('runs', String((+localStorage.getItem('runs')||0)+1));
document.documentElement.setAttribute('data-page-ran','1');
try{ if (window.frameElement) __rep('frameElementExpandoVisibleToPage_' + String(window.frameElement.__marginShell)); }catch(e){ __rep('frameElementErr'); }
</script>
<script src="/ext.js?tag=${tag}"${n}></script>
</head>
`;
  const body = `<body>
<h1>Hello ${tag}</h1>
<img src="/img.gif?tag=${tag}">
${child}
<div style="display:none">${pad}</div>
${Array.from({ length: +q.get('els') || 0 }, (_, i) => `<div class="row r${i}"><a href="/item/${i}">Item ${i}</a> <span title="t${i}">some text for row ${i} with <b>bold</b> and <i>italic</i></span></div>`).join('\n')}
${q.get('pagenav') ? `<script${n}>if (window.top !== window && !/tag=nav3/.test(location.search)) setTimeout(function(){ __rep('pagenav-go'); location.href = '/p?mode=none&tag=nav3'; }, 300);</script>` : ''}
<script${n}>__rep('inline2'); document.addEventListener('DOMContentLoaded',function(){__rep('dcl')}); window.addEventListener('load',function(){__rep('load')});</script>
</body>
</html>`;
  return { head, body };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  const entry = { t: now(), m: req.method, p: u.pathname + u.search, dest: req.headers['sec-fetch-dest'] || '', site: req.headers['sec-fetch-site'] || '', mode: req.headers['sec-fetch-mode'] || '' };
  if (u.pathname !== '/log') log.push(entry);
  if (u.pathname === '/log') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(log));
    if (q.get('clear')) log = [];
    return;
  }
  if (u.pathname === '/clear') { log = []; res.end('ok'); return; }
  if (u.pathname === '/p' || u.pathname === '/post') {
    let bodyIn = '';
    for await (const c of req) bodyIn += c;
    if (bodyIn) entry.body = bodyIn;
    await sleep(+q.get('delay') || 0); // server think time (TTFB)
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': q.get('cache') || 'no-store' };
    if (q.get('csp')) headers['content-security-policy'] = q.get('csp');
    if (q.get('xfo')) headers['x-frame-options'] = q.get('xfo');
    res.writeHead(200, headers);
    const { head, body } = pageHtml(q);
    res.write(head);
    const gap = +q.get('gap') || 0; // delay between <head> chunk and <body> chunk
    if (gap) await sleep(gap);
    res.end(body);
    entry.done = now();
    return;
  }
  if (u.pathname === '/fid') {
    // Fidelity page: execution order of classic/defer/async/module scripts, nested document.write,
    // declarative shadow DOM, <template>, <noscript>, currentScript, readyState.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>fid</title>
<script>${PAGE_REP} window.__order=[]; function o(x){__order.push(x); document.documentElement.setAttribute('data-order', __order.join('|'))}; o('inline-head:'+document.readyState+':'+(document.currentScript&&document.currentScript.id||'cs'));</script>
<script src="/fs.js?n=defer" defer></script>
<script src="/fs.js?n=async" async></script>
<script type="module">o('module:'+document.readyState)</script>
<script src="/fs.js?n=classic"></script>
</head><body>
<div id="host"><template shadowrootmode="open"><span id="in-shadow">x</span></template></div>
<template id="tpl"><b>t</b></template>
<noscript><p id="ns">noscript</p></noscript>
<script>document.write('<p id="dw">written</p><scr'+'ipt>o("dw-script")</scr'+'ipt>'); o('after-dw:'+!!document.getElementById('dw'));</script>
<script>document.addEventListener('DOMContentLoaded',function(){o('dcl');
  o('shadow:'+!!(document.getElementById('host').shadowRoot));
  o('tpl:'+document.getElementById('tpl').content.childNodes.length);
  o('ns-el:'+!!document.getElementById('ns'));
});
window.addEventListener('load',function(){o('load'); __rep('ORDER|'+__order.join('|'));});</script>
</body></html>`);
    return;
  }
  if (u.pathname === '/fs.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end(`o('${q.get('n')}:'+document.readyState);`);
    return;
  }
  if (u.pathname === '/ttcheck') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "require-trusted-types-for 'script'" });
    res.end(`<!doctype html><html><body><script>var r=[typeof trustedTypes];try{document.body.innerHTML='<b>x</b>';r.push('innerHTML-allowed')}catch(e){r.push('innerHTML-blocked:'+e.name)}document.title=r.join(',');console.log('P '+JSON.stringify({tag:document.title}));</script></body></html>`);
    return;
  }
  if (u.pathname === '/child') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>child<script>${PAGE_REP}__rep('child');</script></body></html>`);
    return;
  }
  if (u.pathname === '/form') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body><form id=f method=post action="${q.get('action') || '/post?mode=stop&tag=post'}"><input name=a value=1></form><script>setTimeout(function(){document.getElementById('f').submit()},50)</script></body></html>`);
    return;
  }
  if (u.pathname === '/ext.js') {
    await sleep(+q.get('d') || 0);
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end(`__rep('ext');`);
    return;
  }
  if (u.pathname === '/s.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('h1{color:green}'); return; }
  if (u.pathname === '/img.gif' || u.pathname === '/b') { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); res.end(GIF); return; }
  res.writeHead(404); res.end('nf');
});
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED', e));
server.listen(PORT, '127.0.0.1', () => console.log('listening ' + PORT));
