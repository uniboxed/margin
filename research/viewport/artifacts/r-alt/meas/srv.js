const http = require('http');
const port = +process.argv[2] || 8765;
const APP = `<!doctype html><html><head><meta charset=utf-8><title>app</title><link rel=stylesheet href="app.css"></head><body>
<p id=p>app body</p><img id=im src="pix.png">
<script>
(function(){
  const inFrame = window !== window.top;
  const r = {where: inFrame ? 'frame' : 'top', href: location.href, path: location.pathname, iw: innerWidth,
    cookie: document.cookie, readyState: document.readyState, baseURI: document.baseURI,
    cssLoaded: null, imgSrc: document.getElementById('im').src};
  try { history.pushState({}, '', '/app/pushed?x=1'); r.pushed = location.href; } catch (e) { r.pushed = 'ERR ' + e.name; }
  addEventListener('load', () => { r.cssLoaded = getComputedStyle(document.getElementById('p')).color; r.loadFired = true;
    try { (window.top.__res = window.top.__res || []).push(r); } catch (e) {} });
  r.scriptRan = true;
})();
</script></body></html>`;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/app.css') { res.writeHead(200, {'content-type': 'text/css'}); return res.end('#p{color:rgb(1, 2, 3)}'); }
  if (u.pathname === '/pix.png') { res.writeHead(404); return res.end(); }
  if (u.pathname.startsWith('/app')) {
    res.writeHead(200, {'content-type': 'text/html', 'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'", 'set-cookie': 'sid=abc; Path=/; SameSite=Lax'});
    return res.end(APP);
  }
  if (u.pathname === '/shell') {
    const mode = u.searchParams.get('m');
    res.writeHead(200, {'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'"});
    return res.end(`<!doctype html><html><head><meta charset=utf-8></head><body style="margin:0">
<div id=host style="position:fixed;left:300px;top:0;width:700px;height:600px"></div>
<script>
window.__res = []; const mode = ${JSON.stringify(mode)}; const host = document.getElementById('host');
const style = 'width:700px;height:600px;border:0;display:block';
function report(extra){ setTimeout(()=>{ document.title = JSON.stringify({mode, res: window.__res, extra: extra||null}); }, 1500); }
if (mode === 'iframe') { const f = document.createElement('iframe'); f.style.cssText = style; f.src = '/app/page?q=1';
  f.onload = () => { let acc; try { acc = f.contentDocument && f.contentDocument.URL; } catch (e) { acc = 'ERR ' + e.name; } report({frameURL: acc}); }; host.appendChild(f); }
if (mode === 'object') { const o = document.createElement('object'); o.style.cssText = style; o.data = '/app/page?q=1'; o.type = 'text/html';
  o.onload = () => { let acc; try { acc = o.contentDocument && o.contentDocument.URL; } catch (e) { acc = 'ERR ' + e.name; } report({objURL: acc}); };
  o.onerror = () => report({objError: true}); host.appendChild(o); setTimeout(() => report({timeout: true, objDoc: (()=>{try{return o.contentDocument && o.contentDocument.URL}catch(e){return 'ERR'}})()}), 2500); }
if (mode === 'embed') { const o = document.createElement('embed'); o.style.cssText = style; o.src = '/app/page?q=1'; o.type = 'text/html';
  host.appendChild(o); setTimeout(() => report({embed: true}), 2500); }
if (mode === 'docopen') {
  const f = document.createElement('iframe'); f.style.cssText = style; host.appendChild(f);
  history.replaceState(null, '', '/app/page?q=1');  // shell top URL = the page URL (as content-script shell would be)
  fetch('/app/page?q=1', {credentials: 'include'}).then(r => r.text()).then(html => {
    const d = f.contentDocument; d.open(); d.write(html); d.close();
    report({afterOpenURL: d.URL, frameLocation: f.contentWindow.location.href});
  }).catch(e => report({err: String(e)}));
}
</script></body></html>`);
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('listening ' + port));
