# Browser-UI-facing parity: title, theme-color, favicon, find, zoom, select-all, beforeunload, downloads, POST reload.
import sys, json, tempfile, subprocess, os
from wkharness import Runner, Gdk, GLib, WebKit2, server_log
case = sys.argv[1]
OUT = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out'
def conf(R):
    d = tempfile.mkdtemp(prefix='wkdata', dir=OUT)
    R.dm = WebKit2.WebsiteDataManager(base_data_directory=d + '/data', base_cache_directory=d + '/cache')
    R.ctx = WebKit2.WebContext(website_data_manager=R.dm)
    R.ctx.set_favicon_database_directory(d + "/fav")
R = Runner(port=8813, configure=conf)
A = 'http://127.0.0.1:8813'
def color(R):
    ok, c = R.view.get_theme_color()
    return c.to_string() if ok else None
def icons(n): return [e['path'] for e in server_log()[n:] if 'icon' in e['path']]
def t():
    if case == 'chrome':
        for label, url in [('top-level page', A + '/page'), ('shell, no copy', A + '/shell'), ('shell copies on iframe load', A + '/shell?copy=1'),
                           ('iframe copies at its DCL', A + '/shell?p_copyearly=1')]:
            n = len(server_log()); R.events.clear()
            yield ('load', url, 1500)
            print(f'{label:30} title={R.view.get_title()!r:14} theme={color(R)!s:20} favicon={"set" if R.view.get_favicon() else None} iconRequests={icons(n)}')
        # dynamic theme-color change after load in the shell
        yield ('js', "document.querySelector('meta[name=theme-color]').content='#00ff00';1"); yield ('wait', 300)
        print('after shell meta change -> theme', color(R))
    elif case == 'find':
        for label, url in [('top-level', A + '/page'), ('shell', A + '/shell')]:
            yield ('load', url, 600)
            fc = R.view.get_find_controller(); got = {}
            fc.connect('counted-matches', lambda f, n: got.__setitem__('count', n))
            fc.connect('found-text', lambda f, n: got.__setitem__('found', n))
            fc.connect('failed-to-find-text', lambda f: got.__setitem__('failed', True))
            fc.count_matches('UNIQUEFINDTOKEN', WebKit2.FindOptions.CASE_INSENSITIVE, 100); yield ('wait', 500)
            fc.search('UNIQUEFINDTOKEN', WebKit2.FindOptions.CASE_INSENSITIVE | WebKit2.FindOptions.WRAP_AROUND, 100); yield ('wait', 800)
            sc = yield ('js', "JSON.stringify({top: scrollY, frame: window.__f ? __f.contentWindow.scrollY : null, frameSel: window.__f ? String(__f.contentWindow.getSelection()) : null, sel: String(getSelection())})")
            print(f'{label:10} find:', got, 'scroll after find:', sc)
            fc.search_finish()
    elif case == 'zoom':
        for label, url in [('top-level', A + '/page'), ('shell', A + '/shell')]:
            yield ('load', url, 600)
            for z in (1.0, 1.5):
                R.view.set_zoom_level(z); yield ('wait', 400)
                W = '__f.contentWindow' if 'shell' in label else 'window'
                print(f'{label:10} zoom={z}', (yield ('js', f"JSON.stringify({{shellInnerW: innerWidth, pageInnerW: {W}.innerWidth, pageDPR: {W}.devicePixelRatio, h1px: {W}.document.querySelector('h1').getBoundingClientRect().height}})")))
            R.view.set_zoom_level(1.0)
    elif case == 'selectall':
        for label, pre in [('shell, nothing focused', ''), ('shell, iframe focused', '__f.contentWindow.focus();')]:
            yield ('load', A + '/shell', 600)
            yield ('js', pre + '1'); R.view.grab_focus(); yield ('wait', 200)
            R.view.execute_editing_command('SelectAll'); yield ('wait', 300)
            print(f'{label:24}', (yield ('js', "JSON.stringify({shellSelLen: String(getSelection()).length, frameSelLen: String(__f.contentWindow.getSelection()).length})")))
            R.view.execute_editing_command('Copy'); yield ('wait', 300)
            # read clipboard via GTK
            from gi.repository import Gtk
            cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD); txt = cb.wait_for_text() or ''
            print('   copied text starts:', repr(txt[:40]), 'len', len(txt))
    elif case == 'beforeunload':
        for label, url, x in [('top-level', A + '/page', 60), ('shell', A + '/shell', 260)]:
            yield ('load', url, 600)
            W = '__f.contentWindow' if label == 'shell' else 'window'
            yield ('js', f"{W}.__bu = true; 1")
            R.click(x, 30); yield ('wait', 300)   # user interaction inside the page
            R.events.clear()
            yield ('js', "setTimeout(()=>location.href='/elsewhere',0);1"); yield ('wait', 1000)
            print(f'{label:10} top-level navigation ->', [e for e in R.events if 'script-dialog' in e or 'uri=' in e])
    elif case == 'download':
        for label, url, W in [('top-level', A + '/page', 'window'), ('shell', A + '/shell', '__f.contentWindow')]:
            for link in ('dl', 'dla'):
                yield ('load', url, 600); R.events.clear()
                yield ('js', f"{W}.document.getElementById('{link}').click();1"); yield ('wait', 1200)
                print(f'{label:10} {link:4}', [e for e in R.events if 'download' in e or 'uri=' in e])
    elif case == 'post':
        for label, url, W in [('top-level', A + '/page', 'window'), ('shell', A + '/shell', '__f.contentWindow')]:
            yield ('load', url, 600)
            yield ('js', f"{W}.document.getElementById('pf').submit();1"); yield ('wait', 800)
            n = len(server_log()); R.events.clear()
            R.view.reload(); yield ('wait', 1200)
            print(f'{label:10} after reload: requests', [(e['method'], e['path'][:20]) for e in server_log()[n:]], 'dialogs', [e for e in R.events if 'dialog' in e], 'uri', R.view.get_uri())
            n = len(server_log())
    elif case == 'fetchmeta':
        n = len(server_log())
        yield ('load', A + '/shell', 600)
        for e in server_log()[n:]:
            if e['path'].startswith(('/shell', '/page')): print(e['path'][:12], 'sec-fetch-site', e['sfs'], 'sec-fetch-dest', e['sfd'], 'referer', e['referer'])
        print((yield ('js', "JSON.stringify({ref: __f.contentDocument.referrer, histLen: history.length, frameHistLen: __f.contentWindow.history.length, navType: __f.contentWindow.performance.getEntriesByType('navigation')[0].type})")))
R.run(t(), timeout=90)
