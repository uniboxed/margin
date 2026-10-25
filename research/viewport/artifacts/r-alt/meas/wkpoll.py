import sys, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
view = WebKit2.WebView(); view.set_size_request(1000, 600); win.add(view); win.show_all()
def poll():
    t = view.get_title() or ''
    if t.startswith('{'): print(t); Gtk.main_quit(); return False
    return True
GLib.timeout_add(200, poll)
view.load_uri(sys.argv[1]); GLib.timeout_add(int(sys.argv[2]) if len(sys.argv) > 2 else 12000, lambda: (print('TIMEOUT', view.get_title(), view.get_uri()), Gtk.main_quit()))
Gtk.main()
