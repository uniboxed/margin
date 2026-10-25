const http = require('http'); const crypto = require('crypto');
const port = +process.argv[2] || 8766;
function app(nonce){ return `<!doctype html><html><head><meta charset=utf-8></head><body><a id=lnk href="/app/next">next</a>
<script nonce="${nonce}">
(function(){ const r={where: window!==window.top?'frame':'top', href: location.href, iw: innerWidth, nav: typeof navigation};
  try { (window.top.__res = window.top.__res || []).push(r); } catch(e) {} })();
</script></body></html>`; }
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const nonce = crypto.randomBytes(6).toString('hex');
  if (u.pathname.startsWith('/app')) {
    res.writeHead(200, {'content-type':'text/html','x-frame-options':'DENY',
      'content-security-policy': `script-src 'nonce-${nonce}'; frame-ancestors 'none'`});
    return res.end(app(nonce));
  }
  if (u.pathname === '/shell') {
    const rewrite = u.searchParams.get('rewrite') === '1'; const follow = u.searchParams.get('follow') === '1';
    res.writeHead(200, {'content-type':'text/html','x-frame-options':'DENY',
      'content-security-policy': `script-src 'nonce-${nonce}'; frame-ancestors 'none'`});
    return res.end(`<!doctype html><html><body style="margin:0"><script nonce="${nonce}">
window.__res=[]; const myNonce = document.currentScript.nonce;
const f=document.createElement('iframe'); f.style.cssText='width:700px;height:600px;border:0;position:fixed;left:300px;top:0'; document.body.appendChild(f);
history.replaceState(null,'','/app/page');
fetch('/app/page').then(r=>r.text()).then(html=>{
  if (${rewrite}) html = html.replace(/nonce="[0-9a-f]+"/g, 'nonce="'+myNonce+'"');
  const d=f.contentDocument; d.open(); d.write(html); d.close();
  setTimeout(()=>{
    let afterNav = null;
    if (${follow}) { f.onload = () => { let u; try { u = f.contentDocument && f.contentDocument.URL } catch(e) { u = 'ERR '+e.name } afterNav = u;
        setTimeout(()=>{document.title=JSON.stringify({rewrite:${rewrite}, follow:true, res:window.__res, afterNavURL: afterNav})}, 500); };
      f.contentDocument.getElementById('lnk').click(); return; }
    document.title=JSON.stringify({rewrite:${rewrite}, res:window.__res, myNonceLen: myNonce.length});
  }, 800);
});
</script></body></html>`);
  }
  res.writeHead(404); res.end();
}).listen(port,'127.0.0.1',()=>console.log('listening '+port));
