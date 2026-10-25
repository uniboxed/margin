# Popups: if a script-opened popup is shelled, what do window.opener / window.close() do inside the iframe?
from wkharness import Runner, WebKit2, Gtk, GLib
import json
R = Runner(port=8817)
st = {}
def create(v, nav):
    nv = WebKit2.WebView(related_view=v)
    w = Gtk.Window(); w.set_default_size(600, 400); w.add(nv)
    nv.connect('ready-to-show', lambda x: w.show_all())
    nv.connect('close', lambda x: st.__setitem__('popupClosed', True))
    st['popup'] = nv
    return nv
R.view.disconnect_by_func(R._create); R.view.connect('create', create)
def evalp(js):
    out = {}
    def cb(v, task):
        r = v.evaluate_javascript_finish(task); out['v'] = r.to_string()
    st['popup'].evaluate_javascript(js, -1, None, None, None, cb)
    return out
def t():
    yield ('load', 'http://127.0.0.1:8817/page', 500)
    for target in ('/page', '/shell'):
        st.clear()
        yield ('js', "window.__onclick = () => { window.__pw = window.open(%s, 'pw', 'width=500,height=400'); }; 1" % json.dumps(target))
        R.click(60, 30); yield ('wait', 1500)
        W = '__f.contentWindow' if target == '/shell' else 'window'
        o = evalp(f"JSON.stringify({{pageSeesOpener: {W}.opener !== null, topOpener: top.opener !== null, pageIsTop: {W} === top}})"); yield ('wait', 500)
        print(target, 'in popup:', o.get('v'))
        evalp(f"{W}.close(); 1"); yield ('wait', 800)
        print(target, '  page called window.close() -> popup closed:', st.get('popupClosed', False))
R.run(t(), timeout=30)
