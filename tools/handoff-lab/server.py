# The handoff lab's local server (tools/handoff-lab): the lab's pages (www/), a queue of commands
# for the lab's extension (ext/bg.js, `for=ext`) and for each page (`for=<id>`, `for=probe-<id>`),
# the answers to them, and the pages' own reports (numbers only). Only on 127.0.0.1.
#   LAB_TOKEN=<random> python3 -I server.py <www> <state file> [port]
# The state file holds the latest report per id, for the lab to read.
#
# Other web pages in any browser on the Mac can reach 127.0.0.1 too, so:
# - the lab's own calls (/enqueue, /result, /state) need its per-run token (X-Lab-Token). A page
#   can't send that header without a preflight, which is never allowed, and doesn't know it;
# - a request from any origin but the lab's pages and an extension's is refused, and so is one
#   addressed to another host name (DNS rebinding);
# - no response says Access-Control-Allow-Origin: *. Only an allowed origin is echoed.
import hmac, http.server, json, os, sys, threading, time, urllib.parse
ROOT = sys.argv[1]; STATE = sys.argv[2]; PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 47944
TOKEN = os.environ.get('LAB_TOKEN', '')
if len(TOKEN) < 16: sys.exit('server.py: LAB_TOKEN (16 characters or more) must be set')
HOSTS = {'127.0.0.1:%d' % PORT, 'localhost:%d' % PORT}
PAGES = {'http://127.0.0.1:%d' % PORT, 'http://localhost:%d' % PORT}
LAB_ONLY = {'/enqueue', '/result', '/state'}
state = {}; queue = []; results = {}; lock = threading.Lock()

def allowed_origin(origin):
    return origin in PAGES or origin.startswith('safari-web-extension://')

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def end_headers(self):
        o = self.headers.get('Origin')
        if o and allowed_origin(o): self.send_header('Access-Control-Allow-Origin', o); self.send_header('Vary', 'Origin')
        super().end_headers()
    def send_json(self, code, obj):
        b = json.dumps(obj).encode() if obj is not None else b''
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(b)
    # Refused (403, nothing done): another host name, a foreign origin, or a lab call without the token.
    def refused(self, path):
        if self.headers.get('Host', '') not in HOSTS: return True
        o = self.headers.get('Origin')
        if o is not None and not allowed_origin(o): return True
        if path in LAB_ONLY and not hmac.compare_digest(self.headers.get('X-Lab-Token', ''), TOKEN): return True
        return False
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if self.refused(u.path): return self.send_json(403, None)
        if u.path == '/cmd':
            who = q.get('for', ['ext'])[0]
            with lock:
                i = next((k for k, x in enumerate(queue) if x.get('for', 'ext') == who), None)
                c = queue.pop(i) if i is not None else None
            return self.send_json(200 if c else 204, c)
        if u.path == '/result':
            with lock: r = results.pop(q.get('id', [''])[0], None)
            return self.send_json(200 if r else 204, r)
        if u.path == '/state':
            with lock: return self.send_json(200, state)
        return super().do_GET()
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.refused(u.path): return self.send_json(403, None)
        try: d = json.loads(body or b'null')
        except Exception: d = None
        with lock:
            if u.path == '/enqueue' and d: queue.append(d)
            elif u.path == '/res' and 'id' in q: results[q['id'][0]] = d
            elif u.path == '/r' and isinstance(d, dict):
                d['recv'] = time.time(); state[q.get('id', ['p'])[0]] = d
                tmp = STATE + '.tmp'; open(tmp, 'w').write(json.dumps(state)); os.replace(tmp, STATE)
        self.send_json(204, None)
    # No preflight is ever allowed: nothing here needs one, and a page sending the token would.
    def do_OPTIONS(self): self.send_json(403, None)

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
