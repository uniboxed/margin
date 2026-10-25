#!/usr/bin/python3.12
# usage: run.py PORT SHELL(0/1) FRAMEJS(0/1) test1 test2 ...
# Loads each test URL in WebKitGTK with (or without) the transplant shell and prints JSON per test.
import sys, os, json, time, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
PORT = int(sys.argv[1]); SHELL = sys.argv[2] == '1'; FRAMEJS = sys.argv[3] == '1'; TESTS = sys.argv[4:]
L = f'http://localhost:{PORT}'; X = f'http://127.0.0.1:{PORT}'
def get(u): return urllib.request.urlopen(u, timeout=5).read().decode()

win = Gtk.OffscreenWindow(); win.set_size_request(1000, 600)
ucm = WebKit2.UserContentManager()
if SHELL:
    pre = 'window.__DEFER=' + ('true' if os.environ.get('DEFER') == '1' else 'false') + ';window.__NAME=true;window.__HASH=true;window.__FRAMEJS=' + ('true' if FRAMEJS else 'false') + ';'
    ucm.add_script(WebKit2.UserScript.new_for_world(pre + open(HERE + 'shell5v.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
    ucm.add_script(WebKit2.UserScript.new(open(HERE + '../synth/main-wrap5.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.register_script_message_handler_in_world('r', 'margin')
msgs = []
def onmsg(u, res):
    try: msgs.append(json.loads(res.get_js_value().to_string()))
    except Exception as e: msgs.append({'err': str(e)})
ucm.connect('script-message-received::r', onmsg)
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
s = view.get_settings(); s.set_enable_page_cache(True); s.set_enable_write_console_messages_to_stdout(True)
view.set_size_request(1000, 600); win.add(view); win.show_all()

STATE_JS = """(() => { const f = document.querySelector('iframe[name^=m]') || (document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe') : null);
 const doc = f ? f.contentDocument : document; const w = f ? f.contentWindow : window; let st = {};
 try { st = { rs: doc.readyState, href: w.location.href, title: doc.title, cs: doc.characterSet, mode: doc.compatMode, doctype: doc.doctype && doc.doctype.publicId, divH: doc.getElementById('d') && doc.getElementById('d').getBoundingClientRect().height, cellH: doc.getElementById('t') && doc.getElementById('t').rows[0].cells[0].getBoundingClientRect().height, pageRan: doc.documentElement && doc.documentElement.getAttribute('data-page-ran'), intercepts: doc.documentElement && doc.documentElement.getAttribute('data-intercepts'), v: doc.getElementById('v') && doc.getElementById('v').textContent, h1: doc.getElementById('h') && doc.getElementById('h').textContent }; } catch (e) { st = { err: String(e) }; }
 return JSON.stringify({ top: location.href, topTitle: document.title, shelled: document.documentElement.hasAttribute('data-margin-shell'), card: st }); })()"""

# Per-test actions run inside the card (or the page when unshelled) after load.
ACTIONS = {
  'enc_form': "(document.querySelector('iframe[name^=m]')?.contentDocument || document).getElementById('f').submit(); 1",
  'enc_link': "(document.querySelector('iframe[name^=m]')?.contentDocument || document).getElementById('a').click(); 1",
  'enc2_link': "(document.querySelector('iframe[name^=m]')?.contentDocument || document).getElementById('a').click(); 1",
  'navspa': "(document.querySelector('iframe[name^=m]')?.contentDocument || document).getElementById('l').click(); 1",
}
URLS = {
  'tt': L + "/tt",
  'tt_none': L + "/tt?csp=" + urllib.parse.quote("require-trusted-types-for 'script'; trusted-types 'none'") if False else None,
  'enc_form': L + '/enc', 'enc2': L + '/enc2', 'enc2_link': L + '/enc2', 'enc_link': L + '/enc', 'enc': L + '/enc',
  'xo_assign': L + '/xoparent?how=assign', 'xo_link': L + '/xoparent?how=link', 'xo_top': L + '/xoparent?how=top',
  'topnav_cross': L + '/topnav', 'topnav_same': L + '/topnav?same=1',
  'navspa': L + '/navspa', 'onload0': L + '/onload?img=0', 'onload1': L + '/onload?img=1', 'quirks': L + '/quirks', 'limquirks': L + '/limquirks', 'ddomain': L + '/ddomain', 'meta': L + '/meta',
  'fsrc_none': L + '/fsrc', 'fsrc_default': L + '/fsrc?csp=' + urllib.parse.quote("default-src 'self'; script-src 'nonce-n1'"),
  'fsrc_child': L + '/fsrc?csp=' + urllib.parse.quote("child-src 'none'; script-src 'nonce-n1'"),
}
import urllib.parse
URLS['tt_none'] = L + "/tt?csp=" + urllib.parse.quote("require-trusted-types-for 'script'; trusted-types 'none'")

def steps():
    global msgs
    for t in TESTS:
        msgs = []; get(L + '/clear')
        yield ('load', URLS[t])
        yield ('wait', 700)
        before = yield ('js', STATE_JS)
        if t in ACTIONS:
            yield ('js', ACTIONS[t])
            yield ('wait', 900)
        else:
            yield ('wait', 900)
        after = yield ('js', STATE_JS)
        lg = json.loads(get(L + '/log'))
        print(json.dumps({'test': t, 'shell': SHELL, 'framejs': FRAMEJS, 'before': json.loads(before), 'after': json.loads(after), 'msgs': msgs,
                          'srv': [(e['m'], e['h'].split(':')[0], e['p'][:90], e['dest'], e['site']) for e in lg]}), flush=True)
        yield ('load', 'about:blank')

gen = steps()
def advance(val=None):
    try: act = gen.send(val)
    except StopIteration: Gtk.main_quit(); return False
    kind = act[0]
    if kind == 'load':
        done = {'f': False}
        def onload(v, ev):
            if ev == WebKit2.LoadEvent.FINISHED and not done['f']:
                done['f'] = True; view.disconnect(hid); GLib.timeout_add(50, lambda: advance() and False)
        hid = view.connect('load-changed', onload); view.load_uri(act[1])
        # safety: proceed even if FINISHED never arrives
        def safety():
            if not done['f']:
                done['f'] = True
                try: view.disconnect(hid)
                except Exception: pass
                advance()
            return False
        GLib.timeout_add(4000, safety)
    elif kind == 'js':
        def cb(v, res):
            try: r = v.evaluate_javascript_finish(res).to_string()
            except Exception as e: r = json.dumps({'jserr': str(e)})
            GLib.idle_add(lambda: advance(r) and False)
        view.evaluate_javascript(act[1], -1, None, None, None, cb)
    elif kind == 'wait':
        GLib.timeout_add(act[1], lambda: advance() and False)
    return False
GLib.timeout_add(120000, Gtk.main_quit)
GLib.idle_add(lambda: advance() and False)
Gtk.main()
