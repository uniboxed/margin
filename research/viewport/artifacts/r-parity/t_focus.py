# Keyboard focus / scrolling after load, with and without the shell focusing the iframe.
import sys, json
from wkharness import Runner, Gdk
mode = sys.argv[1] if len(sys.argv) > 1 else 'nofocus'
offscreen = len(sys.argv) > 2 and sys.argv[2] == 'off'
R = Runner(port=8811, offscreen=offscreen)
ST = "JSON.stringify({shellHasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.tagName, frameHasFocus: __f.contentDocument.hasFocus(), frameScrollY: __f.contentWindow.scrollY, shellScrollY: scrollY, clicked: __f.contentWindow.__clicked||0, ev: __f.contentWindow.__ev.slice(), log: __log.slice()})"
def t():
    yield ('load', 'http://127.0.0.1:8811/shell', 600)
    if mode == 'focus':
        yield ('js', "__f.contentWindow.focus(); 1")
        yield ('wait', 200)
    elif mode == 'top':
        # baseline: the page loaded top-level
        yield ('load', 'http://127.0.0.1:8811/page', 600)
    R.view.grab_focus()
    yield ('wait', 200)
    get = "JSON.stringify({hasFocus: document.hasFocus(), scrollY, ev: __ev.slice()})" if mode == 'top' else ST
    print('after load    ', (yield ('js', get)))
    R.key(Gdk.KEY_space); yield ('wait', 500)
    print('after Space   ', (yield ('js', get)))
    R.key(Gdk.KEY_Down); yield ('wait', 500)
    print('after Down    ', (yield ('js', get)))
    if mode != 'top':
        R.click(260, 30); yield ('wait', 400)
        print('after click in iframe', (yield ('js', ST)))
        R.key(Gdk.KEY_space); yield ('wait', 500)
        print('after Space   ', (yield ('js', ST)))
        R.click(50, 60); yield ('wait', 400)   # click on sidebar button (shell)
        print('after click in sidebar', (yield ('js', ST)))
        R.key(Gdk.KEY_space); yield ('wait', 500)
        print('after Space   ', (yield ('js', ST)))
    print('events', R.events)
R.run(t())
