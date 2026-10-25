#!/usr/bin/python3.12
# WebKitGTK harness: inject cs.js as a document-start user script in an
# isolated world ("margin", all frames), load each URL, collect the content
# script's reports and the server's request log.
# usage: wkrun.py SERVER URL [URL...]   (each URL is a path on SERVER)
import sys, os, json, time, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

HERE = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-shell/'
SRC = open(os.environ.get('SCRIPT', HERE + 'cs.js')).read()
server = sys.argv[1]
paths = sys.argv[2:]
WAIT = 2500

def get(path):
    return urllib.request.urlopen(urllib.request.Request(server + path), timeout=5).read().decode()

class Run:
    def __init__(self):
        self.win = Gtk.OffscreenWindow(); self.win.set_size_request(1000, 600)
        ucm = WebKit2.UserContentManager()
        script = WebKit2.UserScript.new_for_world(SRC, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
                                                  WebKit2.UserScriptInjectionTime.START, 'margin', None, None)
        ucm.add_script(script)
        ucm.register_script_message_handler_in_world('r', 'margin')
        ucm.connect('script-message-received::r', self.on_msg)
        self.ctx = WebKit2.WebContext.new_ephemeral()
        self.view = WebKit2.WebView.new_with_user_content_manager(ucm) if False else WebKit2.WebView(web_context=self.ctx, user_content_manager=ucm)
        s = self.view.get_settings(); s.set_enable_write_console_messages_to_stdout(False)
        self.view.set_size_request(1000, 600); self.win.add(self.view); self.win.show_all()
        self.msgs = []
        self.view.connect('load-changed', self.on_load)

    def on_msg(self, ucm, res):
        try:
            v = res.get_js_value().to_string()
        except Exception:
            v = res.to_string() if hasattr(res, 'to_string') else str(res)
        self.msgs.append(json.loads(v))

    def quit(self):
        for t in self.timers:
            try: GLib.source_remove(t)
            except Exception: pass
        self.timers = []
        Gtk.main_quit()
        return False

    def on_load(self, v, ev):
        if ev == WebKit2.LoadEvent.FINISHED and not self.finished:
            self.finished = True
            self.timers.append(GLib.timeout_add(WAIT, self.quit))

    def go(self, url):
        self.msgs = []; self.finished = False; self.timers = []
        self.view.load_uri(url)
        self.timers.append(GLib.timeout_add(15000, self.quit))
        Gtk.main()
        return self.msgs

r = Run()
for p in paths:
    get('/clear')
    t0 = time.time() * 1000
    msgs = r.go(server + p)
    log = json.loads(get('/log'))
    print(json.dumps({'url': p, 't0': t0, 'cs': msgs, 'server': log}))
