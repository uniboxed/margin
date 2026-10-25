#!/usr/bin/python3.12
# Probe: after transplant on a TT-enforcing page, which TT sinks are blocked from the isolated world vs main world?
import sys, os, json, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
PORT = int(sys.argv[1]); URL = sys.argv[2]
win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
ucm = WebKit2.UserContentManager()
ucm.add_script(WebKit2.UserScript.new_for_world('window.__NAME=true;window.__HASH=true;window.__FRAMEJS=false;' + open(HERE + 'shell5v.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
ucm.register_script_message_handler_in_world('r', 'margin')
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
view.set_size_request(1000, 600); win.add(view); win.show_all()
PROBE = r"""(async () => { const out = {};
 const f = document.querySelector('iframe'); const d = f.contentDocument;
 try { d.getElementById('p').innerHTML = '<i>y</i>'; out.cardInnerHTML = 'ok'; } catch (e) { out.cardInnerHTML = 'blocked ' + e.name; }
 try { const f2 = document.createElement('iframe'); f2.srcdoc = '<!doctype html><title></title>'; document.body.append(f2);
   await new Promise(r => f2.onload = r); const d2 = f2.contentDocument; d2.open(); d2.write('<p id=z>z</p>'); d2.close(); out.newSrcdocWrite = d2.getElementById('z') ? 'ok' : 'nothing'; } catch (e) { out.newSrcdocWrite = 'blocked ' + e.name + ' ' + e.message; }
 try { const f3 = document.createElement('iframe'); document.body.append(f3); const d3 = f3.contentDocument; d3.open(); d3.write('<p id=z>z</p>'); d3.close(); out.blankWrite = d3.getElementById('z') ? 'ok' : 'nothing'; } catch (e) { out.blankWrite = 'blocked ' + e.name; }
 try { const dv = document.createElement('div'); dv.innerHTML = '<b>q</b>'; out.topInnerHTML = 'ok'; } catch (e) { out.topInnerHTML = 'blocked ' + e.name; }
 return JSON.stringify(out); })()"""
res = {}
def run_world(world, cb):
    view.evaluate_javascript(PROBE, -1, world, None, None, lambda v, r: cb(v.evaluate_javascript_finish(r).to_string()))
def after_load(v, ev):
    if ev != WebKit2.LoadEvent.FINISHED: return
    def go():
        def got_iso(s):
            res['isolated'] = json.loads(s)
            def got_main(s2):
                res['main'] = json.loads(s2); print(json.dumps(res)); Gtk.main_quit()
            view.call_async_javascript_function(PROBE.replace('(async () =>', 'return (async () =>'), -1, None, None, None, None, lambda v, r: got_main(v.call_async_javascript_function_finish(r).to_string()))
        view.call_async_javascript_function(PROBE.replace('(async () =>', 'return (async () =>'), -1, None, 'margin', None, None, lambda v, r: got_iso(v.call_async_javascript_function_finish(r).to_string()))
        return False
    GLib.timeout_add(800, go)
view.connect('load-changed', after_load)
view.load_uri(URL)
GLib.timeout_add(15000, Gtk.main_quit)
Gtk.main()
