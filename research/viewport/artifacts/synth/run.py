#!/usr/bin/python3.12
# usage: run.py PORT PAGECACHE(0/1)
import sys, os, json, time, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
PORT = int(sys.argv[1]); PC = sys.argv[2] == '1'
L = f'http://localhost:{PORT}'; X = f'http://127.0.0.1:{PORT}'
def get(u): return urllib.request.urlopen(u, timeout=5).read().decode()

win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
ucm = WebKit2.UserContentManager()
ucm.add_script(WebKit2.UserScript.new_for_world(open(HERE + 'shell.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
ucm.add_script(WebKit2.UserScript.new(open(HERE + 'main.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.register_script_message_handler_in_world('r', 'margin')
ucm.register_script_message_handler('m')
msgs = []
def onmsg(u, res):
    try: msgs.append(json.loads(res.get_js_value().to_string()))
    except Exception as e: msgs.append({'err': str(e)})
ucm.connect('script-message-received::r', onmsg); ucm.connect('script-message-received::m', onmsg)
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
s = view.get_settings(); s.set_enable_page_cache(PC); s.set_enable_write_console_messages_to_stdout(True)
view.set_size_request(1000, 600); win.add(view); win.show_all()
out = []
def emit(o): out.append(o); print(json.dumps(o), flush=True)

def bf():
    l = view.get_back_forward_list()
    f = lambda it: (it.get_uri().replace(L, ''), it.get_title()) if it else None
    return {'back': [f(i) for i in l.get_back_list()], 'cur': f(l.get_current_item()), 'fwd': [f(i) for i in l.get_forward_list()]}

STATE_JS = """(() => { const f = document.querySelector('iframe'); let fr = null;
 try { fr = f ? { href: f.contentWindow.location.href, h1: f.contentDocument.getElementById('h')?.textContent, ref: f.contentDocument.referrer } : null; } catch (e) { fr = 'ERR ' + e; }
 return JSON.stringify({ top: location.href, title: document.title, topRef: document.referrer, icons: [...document.querySelectorAll('link[rel~=icon]')].map(l => l.getAttribute('href')), frame: fr }); })()"""

def steps():
    global msgs
    get(L + '/clear'); msgs = []
    # 1. cross-site arrival via link click (with a slow image in the page)
    yield ('load', X + '/start')
    yield ('js', "document.getElementById('go').href = 'http://localhost:%d/page?n=A&slow=1500'; document.getElementById('go').click(); 1" % PORT)
    yield ('sample', 2600)
    st = yield ('js', STATE_JS)
    emit({'step': 'arrive-A', 'state': json.loads(st), 'msgs': msgs, 'progress': prog_summary(), 'srv': json.loads(get(L + '/log'))})
    # 2. in-frame link clicks A -> B -> C (each becomes a top-level navigation)
    for lid in ('lB', 'lC'):
        msgs = []; get(L + '/clear')
        yield ('js', "document.querySelector('iframe').contentDocument.getElementById('%s').click(); 1" % lid)
        yield ('sample', 1500)
        st = yield ('js', STATE_JS)
        emit({'step': 'click-' + lid, 'state': json.loads(st), 'bf': bf(), 'msgs': [m for m in msgs if m.get('ev') in ('to-top', 'takeover', 'transplanted', 'main-world')], 'srv': [(e['m'], e['p'], e['dest']) for e in json.loads(get(L + '/log')) if not e['p'].startswith('/b')]})
    # 3. UI back x2, forward x2
    for d in ('back', 'back', 'forward', 'forward'):
        get(L + '/clear')
        yield (d,)
        yield ('sample', 1500)
        st = yield ('js', STATE_JS)
        emit({'step': d, 'state': json.loads(st), 'bf': bf(), 'srv': [(e['m'], e['p'], e['dest']) for e in json.loads(get(L + '/log')) if not e['p'].startswith('/b')]})
    # 4. leave to another site and come back
    get(L + '/clear')
    yield ('load', X + '/start')
    yield (('back',))
    yield ('sample', 1500)
    st = yield ('js', STATE_JS)
    emit({'step': 'leave-and-back', 'state': json.loads(st), 'bf': bf(), 'srv': [(e['m'], e['p'], e['dest']) for e in json.loads(get(L + '/log')) if not e['p'].startswith('/b')]})

prog = []
def prog_summary():
    if not prog: return None
    t0 = prog[0][0]
    busy = [p for p in prog if p[1]]
    return {'samples': len(prog), 'loadingUntilMs': round((busy[-1][0] - t0) * 1000) if busy else 0, 'firstFullMs': next((round((p[0]-t0)*1000) for p in prog if p[2] >= 1.0 and not p[1]), None), 'trace': [(round((p[0]-t0)*1000), int(p[1]), round(p[2], 2)) for p in prog[::4]]}

gen = steps(); pending = {'v': None}
def advance(val=None):
    try: act = gen.send(val)
    except StopIteration: Gtk.main_quit(); return False
    kind = act[0]
    if kind == 'load':
        done = {'f': False}
        def onload(v, ev):
            if ev == WebKit2.LoadEvent.FINISHED and not done['f']:
                done['f'] = True; view.disconnect(hid); GLib.timeout_add(600, lambda: advance() and False)
        hid = view.connect('load-changed', onload); view.load_uri(act[1])
    elif kind == 'js':
        def cb(v, res):
            try: r = v.evaluate_javascript_finish(res).to_string()
            except Exception as e: r = json.dumps({'jserr': str(e)})
            GLib.idle_add(lambda: advance(r) and False)
        view.evaluate_javascript(act[1], -1, None, None, None, cb)
    elif kind == 'sample':
        prog.clear(); end = time.time() + act[1] / 1000
        def tick():
            prog.append((time.time(), view.is_loading(), view.get_estimated_load_progress()))
            if time.time() >= end: GLib.idle_add(lambda: advance() and False); return False
            return True
        GLib.timeout_add(25, tick)
    elif kind in ('back', 'forward'):
        (view.go_back if kind == 'back' else view.go_forward)(); GLib.idle_add(lambda: advance() and False)
    return False
GLib.timeout_add(20000 * 3, Gtk.main_quit)
GLib.idle_add(lambda: advance() and False)
Gtk.main()
