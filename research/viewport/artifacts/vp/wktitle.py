import sys, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
view = WebKit2.WebView(); view.set_size_request(1000, 600); win.add(view); win.show_all()
def done(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(500, lambda: (print(v.get_title()), Gtk.main_quit()))
view.connect('load-changed', done); view.load_uri(sys.argv[1]); GLib.timeout_add(10000, Gtk.main_quit); Gtk.main()
