#!/usr/bin/python3.12
# Real (XTest) click on the cross-origin child's target=_parent link, with or without the shell.
import sys, os, json, urllib.request, ctypes, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, WebKit2, GLib, Gdk
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
PORT = int(sys.argv[1]); SHELL = sys.argv[2] == '1'; URL = sys.argv[3]; EID = sys.argv[4] if len(sys.argv) > 4 else 'c'
win = Gtk.Window(); win.set_default_size(1000, 600); win.move(0, 0)
ucm = WebKit2.UserContentManager()
if SHELL:
    ucm.add_script(WebKit2.UserScript.new(open(HERE + '../synth/main-wrap5.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None)); ucm.add_script(WebKit2.UserScript.new_for_world('window.__NAME=true;window.__HASH=true;window.__FRAMEJS=true;window.__CLICK=' + ('true' if os.environ.get('CLICK') == '1' else 'false') + ';' + open(HERE + 'shell5v.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
msgs = []
ucm.register_script_message_handler_in_world('r', 'margin')
ucm.connect('script-message-received::r', lambda u, r: msgs.append(json.loads(r.get_js_value().to_string())))
view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(), user_content_manager=ucm); win.add(view); win.show_all()
out = {'shell': SHELL, 'dialogs': []}
def on_dialog(v, d):
    out['dialogs'].append(str(d.get_dialog_type()))
    try: d.confirm_set_confirmed(True)
    except Exception as e: out['dialogs'].append('err ' + str(e))
    return True
view.connect('script-dialog', on_dialog)
def finish():
    out['final'] = view.get_uri(); out['msgs'] = [(m.get('ev'), m.get('url', ''), m.get('user'), m.get('t')) for m in msgs]
    out['srv'] = [(e['m'], e['h'].split(':')[0], e['p'][:60], e['dest']) for e in json.loads(urllib.request.urlopen(f'http://localhost:{PORT}/log').read())]
    print(json.dumps(out)); Gtk.main_quit()
def click():
    js = """(()=>{ const card = document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe') : null;
      const doc = card ? card.contentDocument : document; const c = doc.getElementById('""" + EID + """').getBoundingClientRect();
      const r = card ? card.getBoundingClientRect() : {left:0, top:0}; return JSON.stringify([r.left + c.left + Math.min(40, c.width/2), r.top + c.top + c.height/2]); })()"""
    def cb(v, res):
        x, y = json.loads(v.evaluate_javascript_finish(res).to_string()); out['xy'] = [x, y]
        X = ctypes.cdll.LoadLibrary('libX11.so.6'); XT = ctypes.cdll.LoadLibrary('libXtst.so.6')
        X.XOpenDisplay.restype = ctypes.c_void_p; dpy = ctypes.c_void_p(X.XOpenDisplay(None))
        _, ox, oy = view.get_window().get_origin(); sx, sy = int(ox + x), int(oy + y)
        XT.XTestFakeMotionEvent(dpy, -1, int(ox + 900), int(oy + 550), 0); X.XFlush(dpy)
        XT.XTestFakeButtonEvent(dpy, 1, True, 0); XT.XTestFakeButtonEvent(dpy, 1, False, 30); X.XFlush(dpy)
        def real():
            XT.XTestFakeMotionEvent(dpy, -1, sx, sy, 0); X.XFlush(dpy)
            XT.XTestFakeButtonEvent(dpy, 1, True, 0); XT.XTestFakeButtonEvent(dpy, 1, False, 30); X.XFlush(dpy)
            GLib.timeout_add(2000, lambda: (finish(), False)[1])
            return False
        GLib.timeout_add(400, real)
    view.evaluate_javascript(js, -1, None, None, None, cb)
    return False
started = [False]
def on_load(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not started[0]:
        started[0] = True; GLib.timeout_add(1200, click)
urllib.request.urlopen(f'http://localhost:{PORT}/clear').read()
view.connect('load-changed', on_load); view.load_uri(URL)
GLib.timeout_add(15000, lambda: (finish(), False)[1]); Gtk.main()
