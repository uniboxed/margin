#!/usr/bin/python3.12
# WebKitGTK runner: wkrun.py '<json spec>'
# spec = {url, wait (ms), steps: [{js?, wait?, record?}], isolated?: js source injected at document-start
#         in an isolated world (all frames), id?: log id to fetch from the server}
import sys, json, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

spec = json.loads(sys.argv[1])
out = {'records': [], 'uriChanges': []}

ucm = WebKit2.UserContentManager()
if spec.get('isolated'):
    ucm.add_script(WebKit2.UserScript.new_for_world(spec['isolated'], WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                                                     WebKit2.UserScriptInjectionTime.START, 'margin-cs', None, None))
if spec.get('mainworld'):
    ucm.add_script(WebKit2.UserScript.new(spec['mainworld'], WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                                          WebKit2.UserScriptInjectionTime.START, None, None))

win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
view = WebKit2.WebView.new_with_user_content_manager(ucm)
view.set_size_request(1000, 600); win.add(view); win.show_all()
if spec.get('nopagecache'):
    view.get_settings().set_enable_page_cache(False)
view.connect('notify::uri', lambda v, p: out['uriChanges'].append(v.get_uri()))

def bflist():
    bf = view.get_back_forward_list()
    cur = bf.get_current_item()
    nb, nf = len(bf.get_back_list()), len(bf.get_forward_list())
    ordered = []
    for i in range(-nb, nf + 1):
        it = bf.get_nth_item(i)
        ordered.append(('*' if i == 0 else '') + (it.get_uri() if it else 'None') + ' "' + (it.get_title() or '' if it else '') + '"')
    return {'back': [i.get_uri() for i in bf.get_back_list()], 'current': cur.get_uri() if cur else None,
            'forward': [i.get_uri() for i in bf.get_forward_list()], 'ordered': ordered}

steps = list(spec.get('steps', []))

def record(label, then):
    expr = spec.get('recordExpr', 'JSON.stringify({top: location.href, title: document.title, len: history.length})')
    def cb(v, res):
        try:
            val = v.evaluate_javascript_finish(res)
            val = json.loads(val.to_string())
        except Exception as e:
            val = 'ERR ' + str(e)
        out['records'].append({'label': label, 'page': val, 'uri': view.get_uri(), 'title': view.get_title(), 'bf': bflist()})
        then()
    view.evaluate_javascript(expr, -1, None, None, None, cb)

def run_next():
    if not steps:
        finish(); return False
    st = steps.pop(0)
    def after_js():
        def after_wait():
            if st.get('record'):
                record(st.get('label', st.get('js', '')), run_next)
            else:
                run_next()
            return False
        GLib.timeout_add(st.get('wait', 0), after_wait)
    if st.get('loaduri'):
        view.load_uri(st['loaduri']); after_js(); return False
    if st.get('goback') or st.get('goforward') or st.get('reload'):
        (view.go_back() if st.get('goback') else view.go_forward() if st.get('goforward') else view.reload())
        after_js(); return False
    if st.get('js'):
        def cb(v, res):
            try:
                val = v.evaluate_javascript_finish(res); out.setdefault('jsResults', []).append(val.to_string())
            except Exception as e:
                out.setdefault('jsResults', []).append('ERR ' + str(e))
            after_js()
        view.evaluate_javascript(st['js'], -1, None, None, None, cb)
    else:
        after_js()
    return False

def finish():
    out['finalUri'] = view.get_uri(); out['finalTitle'] = view.get_title(); out['bf'] = bflist()
    if spec.get('id'):
        try:
            out['log'] = json.loads(urllib.request.urlopen('http://localhost:8701/results?id=' + spec['id'], timeout=5).read())
        except Exception as e:
            out['log'] = 'ERR ' + str(e)
    print(json.dumps(out))
    Gtk.main_quit()

started = [False]
def on_load(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not started[0]:
        started[0] = True
        GLib.timeout_add(spec.get('wait', 1500), run_next)
view.connect('load-changed', on_load)
view.load_uri(spec['url'])
GLib.timeout_add(spec.get('timeout', 30000), lambda: (out.setdefault('timedOut', True), finish()))
Gtk.main()
