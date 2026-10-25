# What a service worker sees (clients.matchAll) when the page runs inside the shell.
import json, tempfile
from wkharness import Runner, WebKit2
OUT = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out'
def conf(R):
    d = tempfile.mkdtemp(prefix='wkdata', dir=OUT)
    R.dm = WebKit2.WebsiteDataManager(base_data_directory=d + '/data', base_cache_directory=d + '/cache')
    R.ctx = WebKit2.WebContext(website_data_manager=R.dm)
R = Runner(port=8818, configure=conf)
ASK = "const reg = await navigator.serviceWorker.ready; return await new Promise(r=>{navigator.serviceWorker.onmessage=e=>r(JSON.stringify(e.data)); reg.active.postMessage('list');});"
def t():
    yield ('load', 'http://127.0.0.1:8818/page', 300)
    yield ('ajs', "await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return 1")
    yield ('load', 'http://127.0.0.1:8818/page', 600)
    print('top-level page  :', (yield ('ajs', ASK)))
    yield ('load', 'http://127.0.0.1:8818/shell', 800)
    yield ('js', '__f.contentWindow.focus();1')
    print('shell (asked from iframe):', (yield ('ajs', "return await __f.contentWindow.eval(" + json.dumps('(async()=>{' + ASK + '})()') + ")")))
    print('shell top controlled by SW:', (yield ('js', '!!navigator.serviceWorker.controller')))
R.run(t(), timeout=30)
