import sys, json, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk','3.0')
from gi.repository import Gtk, WebKit2, GLib, Gdk
url = sys.argv[1]; click = len(sys.argv) > 2 and sys.argv[2] == 'click'; shot = sys.argv[3] if len(sys.argv) > 3 else None
win = Gtk.Window(); win.set_default_size(1000, 600); win.move(0,0)
view = WebKit2.WebView(); win.add(view); win.show_all(); win.connect("size-allocate", lambda w,a: print("alloc", a.width, a.height, file=sys.stderr))
state = {'done': False}
def finish(res):
    print(res); Gtk.main_quit()
def after_click():
    def got(v, r):
        try:
            jsres = v.evaluate_javascript_finish(r)
            finish(jsres.to_string())
        except Exception as e: finish('ERR '+str(e))
    view.evaluate_javascript('JSON.stringify(measure())', -1, None, None, None, got)
    return False
def snap():
    if shot:
        def got(v, r):
            surf = v.get_snapshot_finish(r); surf.write_to_png(shot)
        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, got)
    return False
def do_click():
    gw = view.get_window()
    seat = Gdk.Display.get_default().get_default_seat(); dev = seat.get_pointer()
    for (x, y) in [(650, 100), (850, 100), (850, 400), (850, 500)]:
        for t in (Gdk.EventType.MOTION_NOTIFY, Gdk.EventType.BUTTON_PRESS, Gdk.EventType.BUTTON_RELEASE):
            ev = Gdk.Event.new(t); ev.any.window = gw; ev.any.send_event = 1
            if t == Gdk.EventType.MOTION_NOTIFY:
                ev.motion.x = x; ev.motion.y = y; ev.motion.time = Gtk.get_current_event_time() or 1
            else:
                ev.button.x = x; ev.button.y = y; ev.button.button = 1; ev.button.time = 1
            ev.set_device(dev)
            view.event(ev)
    GLib.timeout_add(500, after_click); return False
def done(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not state['done']:
        state['done'] = True
        GLib.timeout_add(400, snap)
        GLib.timeout_add(1500, lambda: (__import__('subprocess').run(['import','-display',':99','-window','root','-crop','1000x600+0+0',shot.replace('.png','-x.png')]) if shot else None, False)[1])
        if click: GLib.timeout_add(1800, do_click)
        else: GLib.timeout_add(700, lambda: finish(v.get_title()))
view.connect('load-changed', done); view.load_uri(url); GLib.timeout_add(15000, lambda: finish('TIMEOUT')); Gtk.main()
