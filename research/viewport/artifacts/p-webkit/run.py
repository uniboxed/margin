#!/usr/bin/python3.12
"""WebKitGTK 2.52 harness for the Margin same-origin iframe shell.

usage: DISPLAY=:99 GDK_CORE_DEVICE_EVENTS=1 /usr/bin/python3.12 run.py SCENARIO [--world margin|main] [--cfg JSON]
                 [--no-shell] [--no-frame-side] [--rules FILE] [--feature Ident=0|1] [--size WxH] [--out FILE]
Scenarios are generator functions in scenarios.py; each yields commands executed here.
Results are JSON lines (stdout + --out).
"""
import sys, os, json, time, argparse, tempfile, urllib.request, gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1'); gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, WebKit2, GLib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scenarios

ap = argparse.ArgumentParser()
ap.add_argument('scenario')
ap.add_argument('--world', default='margin')
ap.add_argument('--cfg', default='{}')
ap.add_argument('--no-shell', action='store_true')
ap.add_argument('--no-frame-side', action='store_true')
ap.add_argument('--rules')
ap.add_argument('--feature', action='append', default=[])
ap.add_argument('--size', default='1000x600')
ap.add_argument('--out')
ap.add_argument('--param', action='append', default=[])
ap.add_argument('--timeout', type=int, default=60000)
ap.add_argument('--no-page-cache', action='store_true')
args = ap.parse_args()
W, Hh = map(int, args.size.split('x'))
PARAMS = dict(p.split('=', 1) for p in args.param)
WORLD = None if args.world == 'main' else args.world

outf = open(args.out, 'a') if args.out else None
T0 = time.perf_counter()
def ms():
    return round((time.perf_counter() - T0) * 1000, 1)

def emit(obj):
    obj = dict(obj)
    obj.setdefault('scenario', args.scenario)
    obj['world'] = args.world
    obj['cfg'] = json.loads(args.cfg)
    s = json.dumps(obj)
    print('RESULT ' + s, flush=True)
    if outf:
        outf.write(s + '\n'); outf.flush()

# ---------- WebKit setup ----------
settings = WebKit2.Settings()
settings.set_enable_write_console_messages_to_stdout(True)
settings.set_enable_developer_extras(True)
if args.no_page_cache:
    settings.set_enable_page_cache(False)
feats = WebKit2.Settings.get_all_features()
for spec in args.feature:
    ident, val = spec.split('=')
    for i in range(feats.get_length()):
        f = feats.get(i)
        if f.get_identifier() == ident:
            settings.set_feature_enabled(f, val == '1')
            print('feature', ident, '->', val, file=sys.stderr)

dm = WebKit2.WebsiteDataManager.new_ephemeral()
dm.set_itp_enabled(True)  # Safari-like tracking prevention
ctx = WebKit2.WebContext.new_with_website_data_manager(dm)
ctx.get_cookie_manager().set_accept_policy(WebKit2.CookieAcceptPolicy.NO_THIRD_PARTY)

ucm = WebKit2.UserContentManager()
cfg_src = 'var __MCFG = ' + args.cfg + ';\n'
def add_script(path, frames):
    src = cfg_src + open(os.path.join(HERE, path)).read()
    if WORLD:
        us = WebKit2.UserScript.new_for_world(src, frames, WebKit2.UserScriptInjectionTime.START, WORLD, None, None)
    else:
        us = WebKit2.UserScript.new(src, frames, WebKit2.UserScriptInjectionTime.START, None, None)
    ucm.add_script(us)
if not args.no_shell:
    add_script('shell.js', WebKit2.UserContentInjectedFrames.TOP_FRAME)
    if not args.no_frame_side:
        add_script('frame.js', WebKit2.UserContentInjectedFrames.ALL_FRAMES)

view = None
win = None
events = {'load': [], 'create': [], 'policy': [], 'failed': [], 'find': [], 'fullscreen': []}

def on_load(v, ev):
    events['load'].append({'t': ms(), 'ev': ev.value_nick, 'uri': v.get_uri()})
def on_failed(v, ev, uri, err):
    events['failed'].append({'t': ms(), 'ev': ev.value_nick, 'uri': uri, 'err': err.message})
    return False
def on_create(v, action):
    req = action.get_request()
    events['create'].append({'t': ms(), 'uri': req.get_uri(), 'frame_name': action.get_frame_name(), 'user_gesture': action.is_user_gesture()})
    return None
def on_policy(v, decision, dtype):
    try:
        if dtype in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            a = decision.get_navigation_action()
            events['policy'].append({'t': ms(), 'type': dtype.value_nick, 'uri': a.get_request().get_uri(), 'frame_name': decision.get_frame_name() if hasattr(decision, 'get_frame_name') else None, 'redirect': a.is_redirect(), 'gesture': a.is_user_gesture(), 'navtype': a.get_navigation_type().value_nick})
    except Exception as e:
        events['policy'].append({'err': str(e)})
    return False

def make_view():
    global view, win
    view = WebKit2.WebView(web_context=ctx, settings=settings, user_content_manager=ucm)
    win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    win.set_decorated(False)
    win.set_default_size(W, Hh)
    win.set_size_request(W, Hh)
    win.set_resizable(False)
    win.move(0, 0)
    win.add(view)
    win.show_all()
    win.present()
    view.grab_focus()
    view.connect('load-changed', on_load)
    view.connect('load-failed', on_failed)
    view.connect('create', on_create)
    view.connect('decide-policy', on_policy)
    view.connect('enter-fullscreen', lambda v: (events['fullscreen'].append({'t': ms(), 'ev': 'enter'}), False)[1])
    view.connect('leave-fullscreen', lambda v: (events['fullscreen'].append({'t': ms(), 'ev': 'leave'}), False)[1])
    fc = view.get_find_controller()
    fc.connect('counted-matches', lambda c, n: events['find'].append({'t': ms(), 'counted': n}))
    fc.connect('found-text', lambda c, n: events['find'].append({'t': ms(), 'found': n}))
    fc.connect('failed-to-find-text', lambda c: events['find'].append({'t': ms(), 'failed': True}))

# ---------- command execution ----------
def wrap(body):
    return '(() => { try { ' + body + ' } catch (e) { return {__jserr: String(e && e.stack || e)}; } })()'

def js(body, world, cb):
    w = WORLD if world == 'shell' else (None if world in (None, 'main') else world)
    def done(v, res):
        try:
            val = v.evaluate_javascript_finish(res)
            j = val.to_json(0)
            cb(json.loads(j) if j not in (None, 'undefined') else None)
        except Exception as e:
            cb({'__error': str(e)})
    view.evaluate_javascript(wrap(body), -1, w, None, None, done)

def http(path):
    with urllib.request.urlopen(scenarios.A + path, timeout=5) as r:
        b = r.read().decode()
    try:
        return json.loads(b)
    except Exception:
        return b

KEYS = {'space': Gdk.KEY_space, 'down': Gdk.KEY_Down, 'up': Gdk.KEY_Up, 'pagedown': Gdk.KEY_Page_Down, 'tab': Gdk.KEY_Tab, 'a': Gdk.KEY_a, 'end': Gdk.KEY_End}

def gdkwin():
    return view.get_window()

def execute(cmd, cb):
    kind = cmd[0]
    if kind == 'load':
        view.load_uri(cmd[1]); GLib.idle_add(lambda: (cb({'t': ms()}), False)[1])
    elif kind == 'js':
        js(cmd[1], cmd[2] if len(cmd) > 2 else None, cb)
    elif kind == 'waitfor':
        body, world, timeout = cmd[1], (cmd[2] if len(cmd) > 2 else None), (cmd[3] if len(cmd) > 3 else 8000)
        start = ms()
        def poll():
            def got(v):
                if v and not (isinstance(v, dict) and ('__jserr' in v or '__error' in v)):
                    cb({'ok': True, 'ms': round(ms() - start, 1), 'v': v})
                elif ms() - start > timeout:
                    cb({'ok': False, 'ms': round(ms() - start, 1), 'v': v})
                else:
                    GLib.timeout_add(25, poll)
            js(body, world, got)
            return False
        poll()
    elif kind == 'sleep':
        GLib.timeout_add(cmd[1], lambda: (cb(None), False)[1])
    elif kind == 'key':
        view.grab_focus()
        kv = KEYS[cmd[1]]
        Gdk.test_simulate_key(gdkwin(), -1, -1, kv, 0, Gdk.EventType.KEY_PRESS)
        Gdk.test_simulate_key(gdkwin(), -1, -1, kv, 0, Gdk.EventType.KEY_RELEASE)
        GLib.timeout_add(cmd[2] if len(cmd) > 2 else 300, lambda: (cb(None), False)[1])
    elif kind == 'click':
        x, y = cmd[1], cmd[2]
        Gdk.test_simulate_button(gdkwin(), x, y, 1, 0, Gdk.EventType.BUTTON_PRESS)
        Gdk.test_simulate_button(gdkwin(), x, y, 1, 0, Gdk.EventType.BUTTON_RELEASE)
        GLib.timeout_add(cmd[3] if len(cmd) > 3 else 300, lambda: (cb(None), False)[1])
    elif kind == 'wheel':
        x, y, n = cmd[1], cmd[2], cmd[3]
        gw = gdkwin()
        disp = Gdk.Display.get_default()
        seat = disp.get_default_seat(); ptr = seat.get_pointer()
        for _ in range(n):
            ev = Gdk.Event.new(Gdk.EventType.SCROLL)
            ev.scroll.window = gw; ev.scroll.send_event = 1; ev.scroll.time = Gdk.CURRENT_TIME
            ev.scroll.x = float(x); ev.scroll.y = float(y); ev.scroll.direction = Gdk.ScrollDirection.DOWN
            ev.set_device(ptr)
            Gtk.main_do_event(ev)
        GLib.timeout_add(cmd[4] if len(cmd) > 4 else 500, lambda: (cb(None), False)[1])
    elif kind == 'state':
        bfl = view.get_back_forward_list()
        cur = bfl.get_current_item()
        cb({'uri': view.get_uri(), 'title': view.get_title(),
            'back': [i.get_uri() for i in bfl.get_back_list()],
            'back_titles': [i.get_title() for i in bfl.get_back_list()],
            'cur': cur.get_uri() if cur else None, 'cur_title': cur.get_title() if cur else None,
            'fwd': [i.get_uri() for i in bfl.get_forward_list()],
            'can_back': view.can_go_back(), 'has_toplevel_focus': win.has_toplevel_focus(), 'view_has_focus': view.has_focus()})
    elif kind == 'events':
        cb(json.loads(json.dumps(events)))
    elif kind == 'clear_events':
        for k in events: events[k].clear()
        cb(None)
    elif kind == 'srv':
        cb(http(cmd[1]))
    elif kind == 'back':
        view.go_back(); GLib.timeout_add(cmd[1] if len(cmd) > 1 else 50, lambda: (cb(None), False)[1])
    elif kind == 'forward':
        view.go_forward(); GLib.timeout_add(cmd[1] if len(cmd) > 1 else 50, lambda: (cb(None), False)[1])
    elif kind == 'reload':
        view.reload(); GLib.timeout_add(50, lambda: (cb(None), False)[1])
    elif kind == 'find':
        fc = view.get_find_controller()
        fc.count_matches(cmd[1], WebKit2.FindOptions.CASE_INSENSITIVE, 100)
        GLib.timeout_add(500, lambda: (fc.search(cmd[1], WebKit2.FindOptions.CASE_INSENSITIVE, 100), GLib.timeout_add(700, lambda: (cb(None), False)[1]), False)[2])
    elif kind == 'print':
        out = cmd[1]
        po = WebKit2.PrintOperation.new(view)
        ps = Gtk.PrintSettings()
        ps.set_printer('Print to File')
        ps.set(Gtk.PRINT_SETTINGS_OUTPUT_FILE_FORMAT, 'pdf')
        ps.set(Gtk.PRINT_SETTINGS_OUTPUT_URI, 'file://' + out)
        po.set_print_settings(ps)
        def fin(*a):
            GLib.timeout_add(300, lambda: (cb({'pdf': out}), False)[1])
        po.connect('finished', fin)
        po.connect('failed', lambda o, e: cb({'print_failed': e.message}))
        po.print_()
    elif kind == 'emit':
        emit(cmd[1]); GLib.idle_add(lambda: (cb(None), False)[1])
    elif kind == 'now':
        cb(ms())
    else:
        raise Exception('unknown cmd ' + kind)

def drive(gen):
    def step(val):
        try:
            cmd = gen.send(val)
        except StopIteration:
            GLib.timeout_add(100, lambda: (Gtk.main_quit(), False)[1]); return
        except Exception as e:
            import traceback; traceback.print_exc()
            emit({'fatal': str(e)}); Gtk.main_quit(); return
        execute(cmd, step)
    step(None)

def start():
    make_view()
    gen = getattr(scenarios, args.scenario)(PARAMS)
    GLib.idle_add(lambda: (drive(gen), False)[1])

if args.rules:
    src = open(args.rules).read()
    store = WebKit2.UserContentFilterStore.new(tempfile.mkdtemp(prefix='cfstore', dir='/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/p-webkit/tmp'))
    def saved(st, res):
        try:
            flt = st.save_finish(res)
            ucm.add_filter(flt)
            emit({'filter': 'compiled', 'rules': os.path.basename(args.rules)})
        except Exception as e:
            emit({'filter': 'ERROR', 'rules': os.path.basename(args.rules), 'error': str(e)})
            Gtk.main_quit(); return
        start()
    store.save('margin-test', GLib.Bytes.new(src.encode()), None, saved)
else:
    start()

GLib.timeout_add(args.timeout, lambda: (emit({'fatal': 'timeout'}), Gtk.main_quit(), False)[2])
Gtk.main()
