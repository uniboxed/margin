// Test server for adversarial engine checks of the transplant shell.
// localhost:PORT = first party, 127.0.0.1:PORT = third party (cross-site).
import http from 'node:http';
const PORT = +process.argv[2] || 8971;
const L = `http://localhost:${PORT}`, X = `http://127.0.0.1:${PORT}`;
let log = [];
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1 id="h">${title}</h1>${body}</body></html>`;
// Reports into the top document title-independent store: the page writes results to window.name-free global + beacon.
const beacon = (k, v) => `new Image().src='/b?k=${k}&v='+encodeURIComponent(${v});`;
http.createServer((req, res) => {
  const u = new URL(req.url, L);
  const p = u.pathname;
  if (p === '/log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (p === '/clear') { log = []; res.writeHead(200); return res.end('ok'); }
  log.push({ m: req.method, h: req.headers.host, p: req.url, dest: req.headers['sec-fetch-dest'] || null, site: req.headers['sec-fetch-site'] || null, ref: req.headers.referer || null });
  const html = (s, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(s); };
  if (p === '/b') { res.writeHead(204); return res.end(); }
  if (p === '/start') return html(page('start', `<a id="go" href="#">go</a>`));
  if (p === '/dest') return html(page('dest ' + (u.searchParams.get('from') || ''), `<p>dest</p>`, ''), { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
  // T1: Trusted Types enforcement on the top response.
  if (p === '/tt') {
    const csp = u.searchParams.get('csp') || "require-trusted-types-for 'script'";
    return html(page('TT', `<p id="p">tt</p><script>
      var r = { tt: typeof trustedTypes, framed: window !== top };
      try { document.getElementById('p').innerHTML = '<b>x</b>'; r.inner = 'allowed'; } catch (e) { r.inner = 'blocked:' + e.name; }
      document.documentElement.setAttribute('data-page-ran', JSON.stringify(r));
      ${beacon('ttpage', 'JSON.stringify(r)')}
    </script>`), { 'content-security-policy': csp });
  }
  // T2: legacy encoding (windows-1251) with a GET form.
  if (p === '/enc2') {
    const head = Buffer.from('<!doctype html><html><head><meta charset="windows-1251"><title>enc2</title></head><body><h1 id="h">enc2</h1><a id="a" href="/dest?from=link&q=', 'latin1');
    const tail = Buffer.from('">link</a><script>document.documentElement.setAttribute("data-page-ran", JSON.stringify({cs: document.characterSet}));</script></body></html>', 'latin1');
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(Buffer.concat([head, Buffer.from([0xEF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2]), tail]));
  }
  if (p === '/enc') {
    const body = Buffer.from(`<!doctype html><html><head><title>enc</title></head><body><h1 id="h">enc</h1>
      <form id="f" action="/dest" method="get"><input name="q" value="__CYR__"></form>
      <a id="a" href="/dest?from=link&q=__CYR__">link</a>
      <script>document.documentElement.setAttribute('data-page-ran', JSON.stringify({cs: document.characterSet, framed: window !== top, linkHref: document.getElementById('a').href}));</script></body></html>`, 'latin1');
    // Build windows-1251 bytes: replace __CYR__ with bytes for "привет" in cp1251.
    const cyr = Buffer.from([0xEF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2]);
    const s = body.toString('latin1').split('__CYR__');
    const out = Buffer.concat([Buffer.from(s[0], 'latin1'), cyr, Buffer.from(s[1], 'latin1'), cyr, Buffer.from(s[2], 'latin1')]);
    res.writeHead(200, { 'content-type': 'text/html; charset=windows-1251', 'cache-control': 'no-store' });
    return res.end(out);
  }
  // T3: a cross-origin child iframe in the card navigates its parent.
  if (p === '/xoparent') {
    const how = u.searchParams.get('how') || 'assign';
    return html(page('xoparent', `<iframe id="c" src="${X}/xochild?how=${how}" width="300" height="100" style="border:0;display:block"></iframe>`));
  }
  if (p === '/xochild') {
    const how = u.searchParams.get('how');
    const target = `${L}/dest?from=xochild-${how}`;
    if (how === 'manual') return html(`<!doctype html><html><head><title>xochild</title><style>body{margin:0}a{position:absolute;left:0;top:0;width:280px;height:80px;display:block;background:#fc0}</style></head><body><a id="a" target="_parent" href="${target}" onclick="navigator.sendBeacon('/b?k=child-clicked&ua='+navigator.userActivation.isActive)">parent link</a></body></html>`);
    const act = how === 'link' ? `document.getElementById('a').click();` : how === 'top' ? `top.location.href='${target}';` : `parent.location.href='${target}';`;
    return html(page('xochild', `<a id="a" target="_parent" href="${target}">parent link</a><script>setTimeout(function(){ try { ${act} } catch (e) { new Image().src='/b?k=xoerr&v='+encodeURIComponent(String(e)); } }, 300);</script>`));
  }
  // T4: card page with 3P script + 3P iframe, then script navigates top cross-site without interaction.
  if (p === '/topnav') {
    const dest = u.searchParams.get('same') ? `${L}/dest?from=topnav-same` : `${X}/dest?from=topnav-cross`;
    return html(page('topnav', `<script src="${X}/s.js"></script><iframe src="${X}/blank" width="50" height="50"></iframe>
      <script>addEventListener('load', function(){ setTimeout(function(){ try { window.top.location.href='${dest}'; } catch (e) { new Image().src='/b?k=topnaverr&v='+encodeURIComponent(String(e)); } }, 300); });</script>`));
  }
  if (p === '/s.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.__3p = 1;'); }
  if (p === '/blank') return html('<!doctype html><title>blank</title>');
  // T5: a Navigation-API SPA that intercepts its own link clicks.
  if (p === '/navspa') {
    return html(page('navspa', `<a id="l" href="/navspa?view=2">view 2</a><div id="v">view 1</div><script>
      window.__intercepts = [];
      navigation.addEventListener('navigate', function (e) {
        if (!e.canIntercept || e.hashChange || e.downloadRequest) return;
        try { e.intercept({ handler: async function () { document.getElementById('v').textContent = 'view 2 (spa)'; } }); window.__intercepts.push('ok'); }
        catch (err) { window.__intercepts.push('throw:' + err.name); }
        document.documentElement.setAttribute('data-intercepts', JSON.stringify(window.__intercepts));
      });
    </script>`));
  }
  if (p === '/ddomain') return html(page('ddomain', `<script>var r = {};
    try { document.domain = document.domain; r.dd = 'set'; } catch (e) { r.dd = 'err ' + e.name; }
    try { history.pushState({ a: 1 }, '', '/ddomain?pushed=1'); r.push = 'ok'; } catch (e) { r.push = 'err ' + e.name + ' ' + e.message; }
    try { r.parentDoc = typeof parent.document.title; } catch (e) { r.parentDoc = 'err ' + e.name; }
    document.documentElement.setAttribute('data-page-ran', JSON.stringify(r));</script>`));
  if (p === '/spalink') return html(page('spalink', `<a id="s" href="/dest?from=spalink" style="display:block;width:300px;height:60px;background:#cfc">spa link</a><div id="v">view 1</div><script>
    document.addEventListener('click', function (e) { var a = e.target.closest('a'); if (!a) return; e.preventDefault(); history.pushState({ v: 2 }, '', '/spalink?view=2'); document.getElementById('v').textContent = 'view 2 (spa)'; });
  </script>`));
  if (p === '/quirks' || p === '/limquirks') {
    const dt = p === '/quirks' ? '' : '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">';
    return html(dt + `<html><head><title>quirks</title></head><body style="margin:0"><table id="t"><tr><td><img id="i" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></td></tr></table><div id="d" style="height:50%;background:#ccc">half</div>
      <script>addEventListener('load', function(){ document.documentElement.setAttribute('data-page-ran', JSON.stringify({ mode: document.compatMode, cellH: document.getElementById('t').rows[0].cells[0].getBoundingClientRect().height, divH: document.getElementById('d').getBoundingClientRect().height })); });</script></body></html>`);
  }
  if (p === '/onload') {
    const img = u.searchParams.get('img') === '1' ? '<img src="/slow.gif">' : '';
    return html(page('onload', `${img}<script>var ev = [];
      document.addEventListener('DOMContentLoaded', function () { ev.push('dcl'); document.documentElement.setAttribute('data-page-ran', ev.join(',')); });
      window.onload = function () { ev.push('onload'); document.documentElement.setAttribute('data-page-ran', ev.join(',')); };
      window.addEventListener('load', function () { ev.push('load'); document.documentElement.setAttribute('data-page-ran', ev.join(',')); });
      window.addEventListener('pageshow', function () { ev.push('pageshow'); document.documentElement.setAttribute('data-page-ran', ev.join(',')); });</script>`));
  }
  if (p === '/slow.gif') { setTimeout(() => { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); }, 300); return; }
  if (p === '/bu') return html(page('bu', `<a id="l" href="/dest?from=bu" style="display:block;width:300px;height:60px;background:#cfc">go</a><input id="i" value="dirty"><script>
    addEventListener('beforeunload', function (e) { navigator.sendBeacon('/b?k=beforeunload'); e.preventDefault(); e.returnValue = ''; });</script>`));
  // T6: meta refresh in the card.
  if (p === '/meta') return html(page('meta', `<p>meta</p>`, `<meta http-equiv="refresh" content="0.3;url=/dest?from=meta">`));
  // T7: page CSP that restricts frames: does the srcdoc card still load?
  if (p === '/fsrc') return html(page('fsrc', `<p id="p">fsrc</p><script nonce="n1">document.documentElement.setAttribute('data-page-ran','1')</script>`), { 'content-security-policy': u.searchParams.get('csp') || "frame-src 'none'; script-src 'nonce-n1'" });
  res.writeHead(404); res.end('nf');
}).listen(PORT, () => console.log('listening', PORT));
