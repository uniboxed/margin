# Storage, cookies, SameSite, ITP/3p-cookie blocking, service workers: top-level vs same-origin shell iframe.
import sys, json, tempfile, os
from wkharness import Runner, WebKit2, server_log
itp = 'itp' in sys.argv
def conf(R):
    d = tempfile.mkdtemp(prefix='wkdata', dir='/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out')
    R.dm = WebKit2.WebsiteDataManager(base_data_directory=d + '/data', base_cache_directory=d + '/cache')
    R.ctx = WebKit2.WebContext(website_data_manager=R.dm)
    if itp:
        R.dm.set_itp_enabled(True)
        R.dm.get_cookie_manager().set_accept_policy(WebKit2.CookieAcceptPolicy.NO_THIRD_PARTY)
R = Runner(port=8812, configure=conf)
A = 'http://127.0.0.1:8812'
SETUP = """localStorage.setItem('k','from-top'); sessionStorage.setItem('s','from-top-session');
 await new Promise(r=>{const o=indexedDB.open('db',1);o.onupgradeneeded=()=>o.result.createObjectStore('st');o.onsuccess=()=>{const tx=o.result.transaction('st','readwrite');tx.objectStore('st').put('idb-from-top','key');tx.oncomplete=r;}});
 const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return 'ok'"""
READ = """const o={cookie: document.cookie, ls: localStorage.getItem('k'), ss: sessionStorage.getItem('s'), hasSA: await document.hasStorageAccess(),
 swController: !!navigator.serviceWorker.controller, swProbe: await fetch('/sw-probe').then(r=>r.text()).catch(e=>'err '+e)};
 o.idb = await new Promise(r=>{const q=indexedDB.open('db',1);q.onupgradeneeded=()=>q.result.createObjectStore('st');q.onsuccess=()=>{try{const g=q.result.transaction('st').objectStore('st').get('key');g.onsuccess=()=>r(g.result||null);}catch(e){r('err '+e)}}});
 o.caches = await caches.keys().then(k=>k.length).catch(e=>'err');
 return JSON.stringify(o)"""
def t():
    yield ('load', A + '/set-cookies', 300)
    yield ('load', A + '/page', 300)
    r = yield ('ajs', SETUP); print('setup (top-level)', r)
    yield ('load', A + '/page', 800)
    print('top-level reload      ', (yield ('ajs', READ)))
    n = len(server_log())
    # arrive cross-site (top-level nav initiated by another site), shell + iframe
    yield ('load', 'http://localhost:8812/xs-start?to=' + A + '/shell', 1500)
    for e in server_log()[n:]:
        if e['path'].startswith(('/shell', '/page', '/xs-start')): print('  req', e['host'], e['path'][:30], 'cookie=', e['cookie'], 'referer=', e['referer'], 'sec-fetch-site=', e['sfs'])
    print('iframe after xs arrive', (yield ('ajs', "return await __f.contentWindow.eval(" + json.dumps('(async()=>{' + READ + '})()') + ")")))
    n = len(server_log())
    # baseline: same cross-site arrival but top-level page (no shell)
    yield ('load', 'http://localhost:8812/xs-start?to=' + A + '/page', 1500)
    for e in server_log()[n:]:
        if e['path'].startswith(('/shell', '/page', '/xs-start')): print('  req', e['host'], e['path'][:30], 'cookie=', e['cookie'], 'sec-fetch-site=', e['sfs'])
    # a page on another site that embeds our page (true third-party iframe) for contrast
    n = len(server_log())
    yield ('load', 'http://localhost:8812/raw?html=' + __import__('urllib.parse').parse.quote('<iframe id=x src="' + A + '/page"></iframe><script>window.__f=document.getElementById("x")</script>'), 1500)
    for e in server_log()[n:]:
        if e['path'].startswith(('/page',)): print('  3p req', e['host'], e['path'][:30], 'cookie=', e['cookie'])
R.run(t(), timeout=60)
