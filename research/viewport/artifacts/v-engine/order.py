#!/usr/bin/python3.12
# Does another extension's document_start script (its own world) that inserts a <style> into <html> run before Margin's shell?
import sys, os, json, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
URL = sys.argv[1]; OTHER = sys.argv[2:]
results = []
def run_once(other_world, first):
    win = Gtk.OffscreenWindow(); win.set_size_request(800, 500)
    ucm = WebKit2.UserContentManager()
    other = WebKit2.UserScript.new_for_world("(() => { const s = document.createElement('style'); s.textContent = 'html{filter:none}'; (document.head || document.documentElement).appendChild(s); })();", WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, other_world, None, None)
    margin = WebKit2.UserScript.new_for_world('window.__NAME=true;window.__HASH=true;' + open(HERE + 'shell5v.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None)
    for sc in ([other, margin] if first == 'other' else [margin, other]): ucm.add_script(sc)
    msgs = []
    ucm.register_script_message_handler_in_world('r', 'margin')
    ucm.connect('script-message-received::r', lambda u, r: msgs.append(json.loads(r.get_js_value().to_string())))
    view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(), user_content_manager=ucm); win.add(view); win.show_all()
    def done(v, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(300, lambda: (results.append({'other_world': other_world, 'added_first': first, 'margin': [(m.get('ev'), m.get('kids')) for m in msgs if m.get('ev') in ('takeover', 'skip')]}), Gtk.main_quit(), False)[2])
    view.connect('load-changed', done); view.load_uri(URL)
    GLib.timeout_add(8000, Gtk.main_quit); Gtk.main()
    win.destroy()
for w in OTHER:
    for first in ('other', 'margin'):
        run_once(w, first)
for r in results: print(json.dumps(r))
