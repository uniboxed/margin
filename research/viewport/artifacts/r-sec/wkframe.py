"""WebKitGTK harness: load a URL, optionally with a compiled content rule list and/or a feature flag,
print document.title (JSON written by the page) after load.

usage: python3 wkframe.py URL [--rules rules.json] [--feature Identifier=1] [--list-features PATTERN]
"""
import sys, os, json, argparse, tempfile, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

ap = argparse.ArgumentParser()
ap.add_argument('url', nargs='?')
ap.add_argument('--rules')
ap.add_argument('--feature', action='append', default=[])
ap.add_argument('--list-features')
args = ap.parse_args()

settings = WebKit2.Settings()
if args.list_features is not None:
    feats = WebKit2.Settings.get_all_features()
    for i in range(feats.get_length()):
        f = feats.get(i)
        ident = f.get_identifier()
        if args.list_features.lower() in ident.lower():
            print(ident, f.get_status(), settings.get_feature_enabled(f), f.get_name())
    sys.exit(0)

for spec in args.feature:
    ident, val = spec.split('=')
    feats = WebKit2.Settings.get_all_features()
    found = False
    for i in range(feats.get_length()):
        f = feats.get(i)
        if f.get_identifier() == ident:
            settings.set_feature_enabled(f, val == '1'); found = True
    print('feature', ident, 'found' if found else 'NOT FOUND', file=sys.stderr)

ucm = WebKit2.UserContentManager()
view = None
result = {'title': None, 'filter': None}

def start():
    global view
    view = WebKit2.WebView(settings=settings, user_content_manager=ucm)
    view.set_size_request(1000, 600)
    win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600); win.add(view); win.show_all()
    def changed(v, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            def fin():
                result['title'] = v.get_title()
                Gtk.main_quit()
                return False
            GLib.timeout_add(int(os.environ.get('WAIT','4000')), fin)
    view.connect('load-changed', changed)
    view.load_uri(args.url)

if args.rules:
    src = open(args.rules).read()
    store_dir = tempfile.mkdtemp(prefix='cfstore', dir=os.path.dirname(os.path.abspath(__file__)))
    store = WebKit2.UserContentFilterStore.new(store_dir)
    def saved(st, res):
        try:
            flt = st.save_finish(res)
            ucm.add_filter(flt)
            result['filter'] = 'compiled'
        except Exception as e:
            result['filter'] = 'ERROR: ' + str(e)
            print(json.dumps(result)); Gtk.main_quit(); return
        start()
    store.save('margin-test', GLib.Bytes.new(src.encode()), None, saved)
else:
    start()

GLib.timeout_add(25000, Gtk.main_quit)
Gtk.main()
print(json.dumps(result))
