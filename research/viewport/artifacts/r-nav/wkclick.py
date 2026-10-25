import sys, json, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, WebKit2, GLib, Gdk
url, sel, rid = sys.argv[1], sys.argv[2], sys.argv[3]
win = Gtk.Window(); win.set_default_size(1000, 600)
view = WebKit2.WebView(); win.add(view); win.show_all()
out = {}
def finish():
    if 'ua' not in out:
        def cb2(v, res):
            try: out['ua'] = v.evaluate_javascript_finish(res).to_string()
            except Exception as e: out['ua'] = 'ERR ' + str(e)[:80]
            finish()
        view.evaluate_javascript("JSON.stringify({frameHasBeenActive: (()=>{try{return document.querySelector('iframe').contentWindow.navigator.userActivation.hasBeenActive}catch(e){return 'n/a'}})(), topHasBeenActive: navigator.userActivation && navigator.userActivation.hasBeenActive})", -1, None, None, None, cb2)
        return
    out['final'] = view.get_uri()
    out['log'] = [e for e in json.loads(urllib.request.urlopen('http://localhost:8701/results?id=' + rid).read()) if e['ev'] in ('top-navigate', 'frame-navigate')]
    print(json.dumps(out)); Gtk.main_quit()
def click():
    js = f"(()=>{{const f=document.querySelector('iframe'); const r=f.getBoundingClientRect(); const a=f.contentDocument.querySelector('{sel}').getBoundingClientRect(); return JSON.stringify([r.left+a.left+a.width/2, r.top+a.top+a.height/2]);}})()"
    def cb(v, res):
        x, y = json.loads(v.evaluate_javascript_finish(res).to_string())
        out['xy'] = [x, y]
        import ctypes
        X = ctypes.cdll.LoadLibrary('libX11.so.6'); XT = ctypes.cdll.LoadLibrary('libXtst.so.6')
        X.XOpenDisplay.restype = ctypes.c_void_p
        dpy = ctypes.c_void_p(X.XOpenDisplay(None))
        _, ox, oy = view.get_window().get_origin()
        sx, sy = int(ox + x), int(oy + y)
        XT.XTestFakeMotionEvent(dpy, -1, sx, sy, 0); X.XFlush(dpy)
        XT.XTestFakeButtonEvent(dpy, 1, True, 0); XT.XTestFakeButtonEvent(dpy, 1, False, 30); X.XFlush(dpy)
        out['simulated'] = ['xtest', sx, sy]
        GLib.timeout_add(2000, lambda: (finish(), False)[1])
    view.evaluate_javascript(js, -1, None, None, None, cb)
    return False
started = [False]
def on_load(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not started[0]:
        started[0] = True; GLib.timeout_add(1500, click)
view.connect('load-changed', on_load); view.load_uri(url)
GLib.timeout_add(15000, lambda: (finish(), False)[1]); Gtk.main()
