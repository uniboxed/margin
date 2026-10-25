#!/usr/bin/python3.12
# usage: run.py PORT PATH MODE(shell|none)
# Loads http://localhost:PORT/PATH in WebKitGTK, with the recommendation's prototype (synth/shell5.js)
# as an isolated-world document_start user script (MODE=shell) or with no script (MODE=none).
# Prints the server log of page beacons and the shell's own messages.
import sys, os, json, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
SHELL = os.environ.get('SHELLJS', '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/synth/shell5.js')
PORT, PATH, MODE = int(sys.argv[1]), sys.argv[2], sys.argv[3]
L = f'http://localhost:{PORT}'
get = lambda u: urllib.request.urlopen(u, timeout=5).read().decode()
win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
ucm = WebKit2.UserContentManager()
if MODE == 'shell':
    ucm.add_script(WebKit2.UserScript.new_for_world('window.__NAME=true;window.__HASH=true;' + open(SHELL).read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
    ucm.register_script_message_handler_in_world('r', 'margin')
msgs = []
ucm.connect('script-message-received::r', lambda u, r: msgs.append(json.loads(r.get_js_value().to_string())))
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
view.set_size_request(1000, 600); win.add(view); win.show_all()
console = []
view.get_settings().set_enable_write_console_messages_to_stdout(True)
get(L + '/clear')
DONE=[False]
def finish():
    if DONE[0]: return False
    DONE[0]=True
    lg = json.loads(get(L + '/log'))
    l = view.get_back_forward_list(); f = lambda it: (it.get_uri().replace(L, ''), it.get_title()) if it else None
    bfl = {'back': [f(i) for i in l.get_back_list()], 'cur': f(l.get_current_item()), 'fwd': [f(i) for i in l.get_forward_list()]}
    print(json.dumps({'path': PATH, 'mode': MODE, 'uri': view.get_uri(), 'title': view.get_title(), 'bf': bfl,
                      'server': [(e['m'], e['p'][:90], e['dest']) for e in lg],
                      'shell': [{k: v for k, v in m.items() if k not in ('t',)} for m in msgs]}))
    Gtk.main_quit(); return False
def onload(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not DONE[0]: GLib.timeout_add(2500, finish)
if os.environ.get('START') == '1':
    def onstart(v, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            view.disconnect(hs[0]); GLib.timeout_add(300, lambda: (get(L + '/clear'), view.connect('load-changed', onload), view.load_uri(L + PATH)) and False)
    hs = [view.connect('load-changed', onstart)]
    view.load_uri(L + '/start')
else:
    view.connect('load-changed', onload)
    view.load_uri(L + PATH)
GLib.timeout_add(15000, finish)
Gtk.main()
