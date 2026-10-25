#!/usr/bin/python3.12
# usage: run.py MODE(top|shell) TEST [PC 0/1] [extra]
import sys, os, json, time, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk', '3.0'); gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gtk, Gdk, WebKit2, GLib, GdkPixbuf
HERE = os.path.dirname(os.path.abspath(__file__)) + '/'
MODE, TEST = sys.argv[1], sys.argv[2]
PC = len(sys.argv) > 3 and sys.argv[3] == '1'
EXTRA = sys.argv[4] if len(sys.argv) > 4 else ''
PORT = int(os.environ.get('PORT', '8961'))
L = f'http://localhost:{PORT}'
def get(u): return urllib.request.urlopen(u, timeout=5).read().decode()
def srvlog(): return [(e['m'], e['p'][:70], e.get('dest'), e.get('body')) for e in json.loads(get(L + '/log')) if not e['p'].startswith('/b')]

win = Gtk.Window(); win.set_default_size(1000, 600); win.move(0, 0)
ucm = WebKit2.UserContentManager()
if MODE == 'shell':
    pre = f"window.__REBUILD={json.dumps(EXTRA or 'hidden')};window.__SIDEBAR={'true' if os.environ.get('SIDEBAR')=='1' else 'false'};window.__HOLD={'true' if os.environ.get('HOLD')=='1' else 'false'};"
    ucm.add_script(WebKit2.UserScript.new_for_world(pre + open(HERE + 'vshell.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, 'margin', None, None))
    ucm.add_script(WebKit2.UserScript.new(open(HERE + 'main-wrap5.js').read(), WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.register_script_message_handler_in_world('r', 'margin')
msgs = []
def onmsg(u, res):
    try: msgs.append(json.loads(res.get_js_value().to_string()))
    except Exception as e: msgs.append({'err': str(e)})
ucm.connect('script-message-received::r', onmsg)
# "Another extension": document_end scripts in its own world, all_frames and top-frame-only
if TEST == 'otherext':
    allow = [f'http://localhost:{PORT}/*']
    for name, frames in (('allframes', WebKit2.UserContentInjectedFrames.ALL_FRAMES), ('topframe', WebKit2.UserContentInjectedFrames.TOP_FRAME)):
        for when, wname in ((WebKit2.UserScriptInjectionTime.START, 'start'), (WebKit2.UserScriptInjectionTime.END, 'end')):
            js = f"try{{window.webkit.messageHandlers.o.postMessage(JSON.stringify({{s:'{name}-{wname}',href:location.href,top:window===top,shell:document.documentElement.hasAttribute('data-margin-shell'),h1:!!document.querySelector('h1'),rs:document.readyState}}))}}catch(e){{}}"
            ucm.add_script(WebKit2.UserScript.new_for_world(js, frames, when, 'otherext', None, None))
    ucm.register_script_message_handler_in_world('o', 'otherext')
    ucm.connect('script-message-received::o', onmsg)
ctx = WebKit2.WebContext.new_ephemeral()
view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
s = view.get_settings(); s.set_enable_page_cache(PC); s.set_enable_write_console_messages_to_stdout(True)
view.set_size_request(1000, 600); win.add(view); win.show_all(); win.present()
events = []
view.connect('notify::uri', lambda v, p: events.append(('uri', str(v.get_uri()).replace(L, ''))))
def on_submit(v, req):
    print(json.dumps({'submit-form-signal': True, 'uri': view.get_uri()}), flush=True)
    ok, names, values = req.list_text_fields()
    print(json.dumps({'submit-form-fields': list(zip(names or [], values or []))}), flush=True)
    events.append(('submit-form', list(zip(names or [], values or []))))
    req.submit()
view.connect('submit-form', on_submit)
def on_policy(v, dec, typ):
    if typ in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
        a = dec.get_navigation_action(); mods = a.get_modifiers(); fn = dec.get_frame_name() if typ == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION else None
        u = a.get_request().get_uri().replace(L, '')
        events.append(('policy', typ.value_nick, u, int(mods), a.get_navigation_type().value_nick, a.is_user_gesture()))
        if mods & Gdk.ModifierType.CONTROL_MASK:   # emulate Safari's cmd-click => open in new tab
            events.append(('would-open-new-tab', u)); dec.ignore(); return True
    return False
view.connect('decide-policy', on_policy)
def emit(o): print(json.dumps(o), flush=True)

# ---- helpers
def click(x, y, state=0):
    w = view.get_window(); seat = Gdk.Display.get_default().get_default_seat()
    for typ in (Gdk.EventType.BUTTON_PRESS, Gdk.EventType.BUTTON_RELEASE):
        ev = Gdk.Event.new(typ); ev.button.window = w; ev.button.x = x; ev.button.y = y; ev.button.button = 1; ev.button.state = state
        ev.button.time = Gtk.get_current_event_time(); ev.button.send_event = 1; ev.set_device(seat.get_pointer()); view.event(ev)
def key(keyval, state=0):
    w = view.get_window(); seat = Gdk.Display.get_default().get_default_seat(); km = Gdk.Keymap.get_for_display(Gdk.Display.get_default())
    ok, keys = km.get_entries_for_keyval(keyval)
    for typ in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
        ev = Gdk.Event.new(typ); ev.key.window = w; ev.key.keyval = keyval; ev.key.state = state; ev.key.hardware_keycode = keys[0].keycode if ok else 0
        ev.key.time = Gtk.get_current_event_time(); ev.key.send_event = 1; ev.set_device(seat.get_keyboard()); view.event(ev)
def pixel(x, y):
    pb = Gdk.pixbuf_get_from_window(view.get_window(), x, y, 1, 1)
    if not pb: return None
    b = pb.get_pixels(); return '#%02x%02x%02x' % (b[0], b[1], b[2])
# D(): JS expression giving the page's document (top doc unshelled; card doc shelled)
D = "(document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe').contentDocument : document)"
W = "(document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe').contentWindow : window)"

# ---- tests
def t_autofocus():
    yield ('load', L + '/autofocus')
    view.grab_focus(); yield ('wait', 300)
    r1 = yield ('js', f"JSON.stringify({{active: {D}.activeElement && ({D}.activeElement.id || {D}.activeElement.tagName), atLoad: {W}.__af, docHasFocus: {D}.hasFocus()}})")
    key(Gdk.KEY_a); key(Gdk.KEY_b); yield ('wait', 300)
    r2 = yield ('js', f"JSON.stringify({{value: {D}.getElementById('q').value}})")
    emit({'test': 'autofocus', 'mode': MODE, 'afterLoad': json.loads(r1), 'afterTypingAB': json.loads(r2)})
def t_textfrag():
    yield ('load', L + '/tf#:~:text=ZQXJV'); yield ('wait', 800)
    r = yield ('js', f"JSON.stringify({{scrollY: {W}.scrollY, targetTop: Math.round({D}.getElementById('target').getBoundingClientRect().top), topHref: location.href, frameHref: {W}.location.href}})")
    emit({'test': 'textfrag', 'mode': MODE, 'r': json.loads(r)})
    yield ('load', L + '/page?n=X'); yield ('load', L + '/tf#target'); yield ('wait', 800)
    r = yield ('js', f"JSON.stringify({{scrollY: {W}.scrollY, targetTop: Math.round({D}.getElementById('target').getBoundingClientRect().top)}})")
    emit({'test': 'plainfrag', 'mode': MODE, 'r': json.loads(r)})
def t_restore():
    setv = f"{W}.scrollTo(0, 3000); {D}.getElementById('t').value='typed-input'; {D}.getElementById('ta').value='typed-area'; 1"
    rd = f"JSON.stringify({{href: {W}.location.href.replace('{L}',''), scrollY: {W}.scrollY, t: {D}.getElementById('t') && {D}.getElementById('t').value, ta: {D}.getElementById('ta') && {D}.getElementById('ta').value}})"
    yield ('load', L + '/long?n=A')
    yield ('js', setv); yield ('wait', 300)
    before = yield ('js', rd)
    yield ('reload',); yield ('wait', 800)
    after_reload = yield ('js', rd)
    yield ('js', setv); yield ('wait', 300)
    yield ('js', f"{D}.getElementById('next').click(); 1"); yield ('wait', 1200)
    on_next = yield ('js', rd)
    yield ('back',); yield ('wait', 1200)
    after_back = yield ('js', rd)
    emit({'test': 'restore', 'mode': MODE, 'pagecache': PC, 'before': json.loads(before), 'afterReload': json.loads(after_reload), 'onNext': json.loads(on_next), 'afterBack': json.loads(after_back)})
def t_ads():
    rules = [
        {"trigger": {"url-filter": ".*"}, "action": {"type": "css-display-none", "selector": ".adA"}},
        {"trigger": {"url-filter": "^https?://"}, "action": {"type": "css-display-none", "selector": ".adB"}},
        {"trigger": {"url-filter": ".*", "if-domain": ["*localhost"]}, "action": {"type": "css-display-none", "selector": ".adC"}},
        {"trigger": {"url-filter": "^https?://[^/]*/ads"}, "action": {"type": "css-display-none", "selector": ".adD"}},
    ]
    store = WebKit2.UserContentFilterStore.new(HERE + 'cfstore')
    box = {}
    def saved(st, res):
        try: box['f'] = st.save_finish(res)
        except Exception as e: box['e'] = str(e)
    store.save('ads', GLib.Bytes.new(json.dumps(rules).encode()), None, saved)
    while 'f' not in box and 'e' not in box: yield ('wait', 50)
    if 'e' in box: emit({'err': box['e']}); return
    ucm.add_filter(box['f'])
    yield ('load', L + '/ads'); yield ('wait', 300)
    r = yield ('js', f"JSON.stringify(Object.fromEntries(['adA','adB','adC','adD','ctl'].map(c => [c, getComputedStyle({D}.querySelector('.'+c)).display])))")
    emit({'test': 'contentblocker-css', 'mode': MODE, 'display': json.loads(r)})
def t_login():
    global msgs
    yield ('load', L + '/login'); get(L + '/clear'); events.clear()
    yield ('js', f"{D}.getElementById('u').value='alice'; {D}.getElementById('pw').value='s3cret'; {D}.getElementById('go').click(); 1")
    yield ('wait', 1500)
    r = yield ('js', f"JSON.stringify({{top: location.href.replace('{L}',''), title: document.title, body: {D}.getElementById('b') && {D}.getElementById('b').textContent}})")
    emit({'test': 'login-post', 'mode': MODE, 'rebuild': EXTRA or None, 'final': json.loads(r), 'hooks': [e for e in events if e[0] in ('submit-form', 'policy')], 'srv': srvlog(), 'msgs': [m for m in msgs if m.get('ev') in ('frame-navigate', 'to-top')]})
def t_navapi():
    yield ('load', L + '/navapi'); get(L + '/clear')
    yield ('js', f"{W}.__mark = 'kept'; {D}.getElementById('l2').click(); 1"); yield ('wait', 1200)
    r = yield ('js', f"JSON.stringify({{h: {D}.getElementById('h').textContent, mark: {W}.__mark || null, log: {W}.__log, top: location.href.replace('{L}','')}})")
    emit({'test': 'navapi-intercept-spa', 'mode': MODE, 'r': json.loads(r), 'docFetches': [x for x in srvlog() if x[1].startswith('/navapi')], 'msgs': [m for m in msgs if m.get('ev') in ('frame-navigate', 'to-top')]})
def t_otherext():
    yield ('load', L + '/page?n=A'); yield ('wait', 500)
    emit({'test': 'other-extension-scripts', 'mode': MODE, 'injections': [m for m in msgs if 's' in m]})
def t_ctrlclick():
    yield ('load', L + '/page?n=A'); yield ('wait', 300); events.clear(); get(L + '/clear')
    rect = yield ('js', f"JSON.stringify((() => {{ const r = {D}.getElementById('lB').getBoundingClientRect(); const off = document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe').getBoundingClientRect() : {{left:0,top:0}}; return {{x: r.left + off.left + 3, y: r.top + off.top + 3}}; }})())")
    rc = json.loads(rect)
    click(rc['x'], rc['y'], Gdk.ModifierType.CONTROL_MASK); yield ('wait', 1200)
    r = yield ('js', "location.href")
    emit({'test': 'ctrl-click-link', 'mode': MODE, 'topAfter': r.replace(L, ''), 'events': events[:], 'msgs': [m for m in msgs if m.get('ev') in ('frame-navigate', 'to-top')]})
    events.clear(); click(rc['x'], rc['y'], 0); yield ('wait', 1200)
    r = yield ('js', "location.href")
    emit({'test': 'plain-click-link', 'mode': MODE, 'topAfter': r.replace(L, ''), 'events': events[:]})
def t_flash():
    # A (green) -> click -> B streams: red header immediately, rest after GAP ms; optionally slow CSS
    gap = int(os.environ.get('GAP', '1500')); css = os.environ.get('CSS', '')
    yield ('load', L + f'/stream?n=A&gap=0&bg=%230a0'); yield ('wait', 500)
    href = f"/stream?n=B&gap={gap}" + (f"&css={css}" if css else '') + "&bg=%2300a"
    yield ('js', f"(() => {{ const a = {D}.getElementById('lB'); a.href = '{href}'; a.click(); return 1; }})()")
    t0 = time.time(); samples = []
    while time.time() - t0 < (gap + int(css or 0)) / 1000 + 1.2:
        samples.append((round((time.time() - t0) * 1000), pixel(600, 300), pixel(600, 500), pixel(40, 30)))
        yield ('wait', 40)
    # collapse runs
    runs = []
    for t, a, b, c in samples:
        if not runs or runs[-1][1] != (a, b, c): runs.append([t, (a, b, c)])
    emit({'test': 'flash', 'mode': MODE, 'sidebar': os.environ.get('SIDEBAR'), 'gap': gap, 'css': css, 'runs(ms,(px600x300,px600x500,px40x30))': runs})

def t_activation():
    yield ('load', L + '/page?n=A'); yield ('wait', 300)
    q = "JSON.stringify({top: [navigator.userActivation.isActive, navigator.userActivation.hasBeenActive], card: (()=>{const f=document.querySelector('iframe'); return f ? [f.contentWindow.navigator.userActivation.isActive, f.contentWindow.navigator.userActivation.hasBeenActive] : null})()})"
    before = yield ('js', q)
    click(600, 300); yield ('wait', 200)
    after = yield ('js', q)
    emit({'test': 'activation-propagation', 'mode': MODE, 'before': json.loads(before), 'afterRealClickInCard': json.loads(after)})
def t_close():
    view.connect('close', lambda v: events.append(('close-signal',)))
    yield ('load', L + '/page?n=A'); yield ('wait', 300)
    yield ('js', f"{W}.close(); 1"); yield ('wait', 500)
    emit({'test': 'window.close-from-page', 'mode': MODE, 'events': [e for e in events if e[0] == 'close-signal']})
def t_sjis():
    yield ('load', L + '/sjis'); yield ('wait', 300)
    cs = yield ('js', f"JSON.stringify({{charset: {D}.characterSet, linkHref: {D}.getElementById('l').href}})")
    get(L + '/clear')
    yield ('js', f"{D}.getElementById('q').value='\u65e5\u672c'; {D}.getElementById('go').click(); 1"); yield ('wait', 1200)
    emit({'test': 'legacy-encoding', 'mode': MODE, 'page': json.loads(cs), 'submitted': [x[1] for x in srvlog() if x[1].startswith('/sjis-result')]})
def t_bu():
    def dlg(v, d):
        events.append(('dialog', d.get_dialog_type().value_nick, view.get_uri().replace(L, '')))
        if d.get_dialog_type() == WebKit2.ScriptDialogType.BEFORE_UNLOAD_CONFIRM: d.confirm_set_confirmed(os.environ.get('STAY') != '1')
        return True
    view.connect('script-dialog', dlg)
    yield ('load', L + '/bu'); yield ('wait', 300)
    rect = yield ('js', f"JSON.stringify((() => {{ const r = {D}.getElementById('lB').getBoundingClientRect(); const off = document.documentElement.hasAttribute('data-margin-shell') ? document.querySelector('iframe').getBoundingClientRect() : {{left:0,top:0}}; return {{x: r.left + off.left + 3, y: r.top + off.top + 3}}; }})())")
    rc = json.loads(rect)
    click(rc['x'] - 200, rc['y']); yield ('wait', 200)  # click textarea area => sticky activation (beforeunload requires it)
    key(Gdk.KEY_a); yield ('wait', 200)
    events.clear(); click(rc['x'], rc['y']); yield ('wait', 1500)
    r = yield ('js', "location.href")
    emit({'test': 'beforeunload-on-link-click', 'mode': MODE, 'stay': os.environ.get('STAY') == '1', 'dialogs': [e for e in events if e[0] == 'dialog'], 'topAfter': r.replace(L, ''), 'msgs': [m for m in msgs if m.get('ev') in ('frame-navigate', 'to-top')]})
TESTS = {'bu': t_bu, 'sjis': t_sjis, 'close': t_close, 'activation': t_activation, 'autofocus': t_autofocus, 'textfrag': t_textfrag, 'restore': t_restore, 'ads': t_ads, 'login': t_login, 'navapi': t_navapi, 'otherext': t_otherext, 'ctrlclick': t_ctrlclick, 'flash': t_flash}
gen = TESTS[TEST]()
def advance(val=None):
    try: act = gen.send(val)
    except StopIteration: Gtk.main_quit(); return False
    except Exception:
        import traceback; traceback.print_exc(); Gtk.main_quit(); return False
    kind = act[0]
    if kind == 'load':
        done = {'f': False}
        def onload(v, ev):
            if ev == WebKit2.LoadEvent.FINISHED and not done['f']:
                done['f'] = True; view.disconnect(hid); GLib.timeout_add(500, lambda: advance() and False)
        hid = view.connect('load-changed', onload); view.load_uri(act[1])
    elif kind == 'js':
        def cb(v, res):
            try: r = v.evaluate_javascript_finish(res).to_string()
            except Exception as e: r = json.dumps({'jserr': str(e)})
            GLib.idle_add(lambda: advance(r) and False)
        view.evaluate_javascript(act[1], -1, None, None, None, cb)
    elif kind == 'wait': GLib.timeout_add(act[1], lambda: advance() and False)
    elif kind == 'reload': view.reload(); GLib.idle_add(lambda: advance() and False)
    elif kind in ('back', 'forward'): (view.go_back if kind == 'back' else view.go_forward)(); GLib.idle_add(lambda: advance() and False)
    return False
GLib.timeout_add(60000, Gtk.main_quit)
GLib.idle_add(lambda: advance() and False)
Gtk.main()
