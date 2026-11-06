# The handoff lab's local server (tools/handoff-lab): the lab's pages (www/), a queue of commands
# for the lab's extension (ext/bg.js, `for=ext`) and for each page (`for=<id>`, `for=probe-<id>`),
# the answers to them, and the pages' own reports (numbers only). Only on 127.0.0.1.
#   python3 -I server.py <www> <state file> [port]
# The state file holds the latest report per id, for the lab to read.
import http.server, json, os, sys, threading, time, urllib.parse
ROOT = sys.argv[1]; STATE = sys.argv[2]; PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 47944
state = {}; queue = []; results = {}; lock = threading.Lock()

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def send_json(self, code, obj):
        b = json.dumps(obj).encode() if obj is not None else b''
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == '/cmd':
            who = q.get('for', ['ext'])[0]
            with lock:
                i = next((k for k, x in enumerate(queue) if x.get('for', 'ext') == who), None)
                c = queue.pop(i) if i is not None else None
            return self.send_json(200 if c else 204, c)
        if u.path == '/result':
            with lock: r = results.pop(q['id'][0], None)
            return self.send_json(200 if r else 204, r)
        if u.path == '/state':
            with lock: return self.send_json(200, state)
        return super().do_GET()
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        try: d = json.loads(body or b'null')
        except Exception: d = None
        with lock:
            if u.path == '/enqueue' and d: queue.append(d)
            elif u.path == '/res': results[q['id'][0]] = d
            elif u.path == '/r' and isinstance(d, dict):
                d['recv'] = time.time(); state[q.get('id', ['p'])[0]] = d
                tmp = STATE + '.tmp'; open(tmp, 'w').write(json.dumps(state)); os.replace(tmp, STATE)
        self.send_json(204, None)
    def do_OPTIONS(self): self.send_json(204, None)

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
