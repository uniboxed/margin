"""WebKitGTK: inject an isolated-world user script (like an extension content script) that builds a shell iframe.
usage: wkuser.py URL IFRAME_URL [world-name|main]"""
import sys, json, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
url, src = sys.argv[1], sys.argv[2]
world = sys.argv[3] if len(sys.argv) > 3 else 'margin'
js = """(() => { const go = () => {
  let ok = false; addEventListener('message', (e) => { if (e.data && e.data.name) ok = e.data.name; });
  const f = document.createElement('iframe'); f.src = %s; document.body.append(f);
  setTimeout(() => { document.title = (ok ? 'LOADED:' + ok : 'BLOCKED') + ' siteInlineRanInTop=' + (document.documentElement.dataset.siteRan === '1'); }, 2000); };
  if (document.body) go(); else addEventListener('DOMContentLoaded', go); })();""" % json.dumps(src)
ucm = WebKit2.UserContentManager()
if world == 'main':
    us = WebKit2.UserScript.new(js, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.END, None, None)
else:
    us = WebKit2.UserScript.new_for_world(js, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.END, world, None, None)
ucm.add_script(us)
view = WebKit2.WebView(user_content_manager=ucm)
win = Gtk.OffscreenWindow(); win.set_size_request(800, 500); win.add(view); win.show_all()
res = {}
def changed(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(3000, lambda: (res.__setitem__('title', v.get_title()), Gtk.main_quit(), False)[-1])
view.connect('load-changed', changed)
view.load_uri(url)
GLib.timeout_add(20000, Gtk.main_quit)
Gtk.main()
print(json.dumps({'url': url, 'world': world, 'title': res.get('title')}))
