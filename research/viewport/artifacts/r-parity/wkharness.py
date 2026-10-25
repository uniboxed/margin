# Minimal coroutine harness around a WebKitGTK WebView (WebKit2 4.1 / WebKitGTK 2.52).
# A test is a generator yielding commands; the runner resumes it with the command's result.
import sys, json, os, time
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, WebKit2, GLib
import server

class Runner:
    def __init__(self, port=8811, width=1000, height=600, offscreen=False, configure=None):
        self.srv = server.start(port)
        self.port = port
        self.events = []
        self.ctx = WebKit2.WebContext.get_default()
        self.dm = self.ctx.get_website_data_manager()
        if configure: configure(self)
        self.view = WebKit2.WebView.new_with_context(self.ctx) if not hasattr(self, 'view') else self.view
        s = self.view.get_settings()
        s.set_enable_developer_extras(True)
        s.set_javascript_can_open_windows_automatically(False)
        s.set_enable_fullscreen(True)
        self.win = Gtk.OffscreenWindow() if offscreen else Gtk.Window()
        self.win.set_default_size(width, height)
        self.view.set_size_request(width, height)
        self.win.add(self.view); self.win.show_all()
        if not offscreen: self.win.present()
        self.load_done = False
        self.view.connect('load-changed', self._lc)
        self.view.connect('permission-request', self._perm)
        self.view.connect('script-dialog', self._dialog)
        self.view.connect('create', self._create)
        self.view.connect('enter-fullscreen', lambda v: (self.events.append('enter-fullscreen'), False)[1])
        self.view.connect('leave-fullscreen', lambda v: (self.events.append('leave-fullscreen'), False)[1])
        self.view.connect('print', self._print)
        self.ctx.connect('download-started', self._dl)
        self.view.connect('notify::title', lambda v, p: self.events.append('title=' + str(v.get_title())))
        self.view.connect('notify::uri', lambda v, p: self.events.append('uri=' + str(v.get_uri())))
        self.print_hook = None
        self.allow_perms = True

    # ---- signal handlers
    def _lc(self, v, ev):
        if ev == WebKit2.LoadEvent.FINISHED: self.load_done = True
    def _perm(self, v, req):
        self.events.append('permission-request:' + type(req).__name__)
        if self.allow_perms: req.allow()
        else: req.deny()
        return True
    def _dialog(self, v, d):
        t = d.get_dialog_type()
        self.events.append(f'script-dialog:{t.value_nick}:{d.get_message()!r}')
        if t == WebKit2.ScriptDialogType.BEFORE_UNLOAD_CONFIRM: d.confirm_set_confirmed(True)
        return True
    def _create(self, v, nav):
        r = nav.get_request()
        self.events.append('create-window:' + (r.get_uri() if r else '?'))
        return None
    def _dl(self, ctx, dl):
        self.events.append('download-started:' + dl.get_request().get_uri())
        dl.connect('decide-destination', lambda d, name: (self.events.append('download-name:' + name), d.set_destination('file:///tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out/' + name), True)[2])
    def _print(self, v, op):
        self.events.append('print-signal')
        if self.print_hook: self.print_hook(op)
        return True

    # ---- input synthesis
    def click(self, x, y):
        w = self.view.get_window()
        seat = Gdk.Display.get_default().get_default_seat()
        for typ in (Gdk.EventType.BUTTON_PRESS, Gdk.EventType.BUTTON_RELEASE):
            ev = Gdk.Event.new(typ)
            ev.button.window = w; ev.button.x = x; ev.button.y = y; ev.button.button = 1
            ev.button.time = Gtk.get_current_event_time(); ev.button.send_event = 1
            ev.set_device(seat.get_pointer())
            self.view.event(ev)
    def key(self, keyval, state=0):
        w = self.view.get_window()
        seat = Gdk.Display.get_default().get_default_seat()
        km = Gdk.Keymap.get_for_display(Gdk.Display.get_default())
        ok, keys = km.get_entries_for_keyval(keyval)
        for typ in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
            ev = Gdk.Event.new(typ)
            ev.key.window = w; ev.key.keyval = keyval; ev.key.state = state
            ev.key.hardware_keycode = keys[0].keycode if ok else 0
            ev.key.time = Gtk.get_current_event_time(); ev.key.send_event = 1
            ev.set_device(seat.get_keyboard())
            self.view.event(ev)

    # ---- coroutine driver
    def run(self, gen, timeout=60):
        self.gen = gen
        self._step(None)
        GLib.timeout_add(timeout * 1000, self._timeout)
        Gtk.main()
    def _timeout(self):
        print('TIMEOUT', file=sys.stderr); Gtk.main_quit(); return False
    def _step(self, value):
        try:
            cmd = self.gen.send(value)
        except StopIteration:
            Gtk.main_quit(); return False
        except Exception:
            import traceback; traceback.print_exc(); Gtk.main_quit(); return False
        kind = cmd[0]
        if kind == 'wait':
            GLib.timeout_add(cmd[1], lambda: self._step(None) and False)
        elif kind == 'load':
            self.load_done = False
            self.view.load_uri(cmd[1])
            def poll():
                if self.load_done: GLib.timeout_add(cmd[2] if len(cmd) > 2 else 300, lambda: self._step(None) and False); return False
                return True
            GLib.timeout_add(50, poll)
        elif kind == 'js':
            def cb(v, task):
                try:
                    res = v.evaluate_javascript_finish(task)
                    out = json.loads(res.to_json(0)) if not res.is_undefined() else None
                except Exception as e:
                    out = {'__error': str(e)}
                GLib.idle_add(lambda: self._step(out) and False)
            self.view.evaluate_javascript(cmd[1], -1, None, None, None, cb)
        elif kind == 'ajs':  # async function body; `return await ...`
            def cb2(v, task):
                try:
                    res = v.call_async_javascript_function_finish(task)
                    out = json.loads(res.to_json(0)) if not res.is_undefined() else None
                except Exception as e:
                    out = {'__error': str(e)}
                GLib.idle_add(lambda: self._step(out) and False)
            self.view.call_async_javascript_function(cmd[1], -1, None, None, None, None, cb2)
        elif kind == 'call':  # run python callable, resume with result
            r = cmd[1]()
            GLib.idle_add(lambda: self._step(r) and False)
        return False

def server_log():
    return server.LOG
