# Test server for same-origin "iframe shell" parity tests.
# Started in-process by wkharness.py (thread). Logs every request (path, Cookie, Sec-Fetch-*) into LOG.
import http.server, socketserver, threading, urllib.parse, json, time, base64

LOG = []
PNG = base64.b64decode(b'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

LONG = ''.join(f'<p>para {i} lorem ipsum dolor sit amet</p>' for i in range(200))

def shell_html(q):
    frame_attrs = q.get('attrs', ['allowfullscreen'])[0]
    head_extra = q.get('shellhead', [''])[0]
    copy = q.get('copy', ['0'])[0] == '1'
    page_q = urllib.parse.urlencode({k: v[0] for k, v in q.items() if k.startswith('p_')})
    return f'''<!doctype html><html><head><meta charset=utf-8><title>SHELL</title>{head_extra}
<style>html,body{{margin:0;height:100%;overflow:hidden;background:#123456}}
#side{{position:fixed;left:0;top:0;width:200px;height:100%;background:#222;color:#eee}}
#f{{position:fixed;left:200px;top:0;width:calc(100% - 200px);height:100%;border:0}}</style></head>
<body><div id=side>SIDEBAR <button id=sbtn style="margin-top:40px">sidebar button</button></div>
<iframe id=f {frame_attrs} src="/page?{page_q}"></iframe>
<script>
window.__log=[];
const f=document.getElementById('f');
window.__f=f;
f.addEventListener('load',()=>{{__log.push('iframe load '+f.contentWindow.location.pathname);
  if({'true' if copy else 'false'}) {{
    const d=f.contentDocument; document.title=d.title;
    for (const el of d.querySelectorAll('meta[name=theme-color],link[rel~=icon]')) document.head.appendChild(el.cloneNode(true));
  }}
}});
f.addEventListener('DOMContentLoaded',()=>{{}});
document.addEventListener('DOMContentLoaded',()=>__log.push('shell DCL'));
window.addEventListener('load',()=>__log.push('shell load'));
</script></body></html>'''

def page_html(q):
    head = q.get('p_head', ['<meta name=theme-color content="#ff0000"><link rel=icon href="/icon-page.png">'])[0]
    copyearly = q.get('p_copyearly', ['0'])[0] == '1'
    return f'''<!doctype html><html><head><meta charset=utf-8><title>PAGE TITLE</title>{head}
<style>body{{margin:0;font:16px sans-serif}} #b{{position:fixed;left:10px;top:10px;width:150px;height:40px;z-index:5}}
#vw{{width:100vw;height:10px;background:red}}</style>
<script>
window.__r={{}}; window.__ev=[];
if ({'true' if copyearly else 'false'} && parent!==window) {{
  // copy icon/theme-color into the shell as early as the <head> is parsed
  document.addEventListener('DOMContentLoaded',()=>{{for(const el of document.querySelectorAll('meta[name=theme-color],link[rel~=icon]')) parent.document.head.appendChild(el.cloneNode(true)); parent.document.title=document.title;}});
}}
addEventListener('beforeunload',e=>{{ if(window.__bu){{e.preventDefault(); e.returnValue='x'; __ev.push('beforeunload-prevent');}} else __ev.push('beforeunload'); }});
addEventListener('unload',()=>{{ try{{ parent.__log.push('iframe unload'); }}catch(e){{}} }});
addEventListener('keydown',e=>__ev.push('keydown '+e.key+' trusted='+e.isTrusted));
addEventListener('scroll',()=>{{window.__scrolled=scrollY}});
addEventListener('focus',()=>__ev.push('window focus'));
addEventListener('blur',()=>__ev.push('window blur'));
</script></head><body>
<button id=b onclick="window.__clicked=(window.__clicked||0)+1; window.__onclick && window.__onclick()">click me</button>
<div id=vw></div>
<h1 style="margin-top:80px">Inner page</h1>
<p><a id=dl href="/download">download link</a> <a id=dla download href="/dlattr.txt">download attr</a>
<a id=blank target=_blank href="/blank-target">blank</a> <a id=xs href="http://localhost:PORT/xs-landing">cross-site link</a></p>
<form id=pf method=post action="/post-result"><input name=a value=1><input id=pw type=password autocomplete=current-password></form>
{LONG}
<p id=tok>UNIQUEFINDTOKEN at bottom of inner page</p>
</body></html>'''

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _send(self, code, body, ctype='text/html; charset=utf-8', headers=()):
        if isinstance(body, str): body = body.replace('PORT', str(self.server.server_address[1])).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in headers: self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n)
        self.do_GET()
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        LOG.append({'t': time.time(), 'method': self.command, 'host': self.headers.get('Host'), 'path': self.path,
                    'cookie': self.headers.get('Cookie'), 'referer': self.headers.get('Referer'),
                    'sfs': self.headers.get('Sec-Fetch-Site'), 'sfd': self.headers.get('Sec-Fetch-Dest'),
                    'origin': self.headers.get('Origin')})
        p = u.path
        if p == '/shell': return self._send(200, shell_html(q))
        if p == '/page': return self._send(200, page_html(q))
        if p == '/set-cookies':
            return self._send(200, '<title>cookies set</title>ok', headers=[('Set-Cookie', 'cs=1; SameSite=Strict; Path=/'), ('Set-Cookie', 'cl=1; SameSite=Lax; Path=/'), ('Set-Cookie', 'cd=1; Path=/')])
        if p == '/xs-start':  # cross-site page that navigates the top to the shell
            return self._send(200, f'<title>xs</title><a id=go href="{q["to"][0]}">go</a><script>setTimeout(()=>document.getElementById("go").click(),100)</script>')
        if p in ('/icon-page.png', '/icon-shell.png', '/favicon.ico'): return self._send(200, PNG, 'image/png')
        if p == '/download': return self._send(200, 'hello download', 'application/octet-stream', [('Content-Disposition', 'attachment; filename="d.bin"')])
        if p == '/dlattr.txt': return self._send(200, 'attr download', 'text/plain')
        if p == '/post-result': return self._send(200, '<title>posted</title>posted')
        if p == '/sw.js': return self._send(200, "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(e.request.url.includes('/sw-probe'))e.respondWith(new Response('from-sw'))});self.addEventListener('message',e=>{e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>e.source.postMessage(cs.map(c=>({url:new URL(c.url).pathname,frameType:c.frameType,focused:c.focused,visibility:c.visibilityState,isSender:c.id===e.source.id})))))});", 'application/javascript')
        if p == '/slow':
            time.sleep(float(q.get('s', ['2'])[0]))
            return self._send(200, '<title>slow done</title>slow page')
        if p == '/raw': return self._send(200, q.get('html', [''])[0])
        return self._send(200, f'<title>{p}</title>{p}')

class TS(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True; allow_reuse_address = True

def start(port):
    s = TS(('0.0.0.0', port), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s
