# One case per process (fresh data dir): title / theme-color / favicon seen by the browser chrome.
import sys, tempfile
from wkharness import Runner, WebKit2, server_log
OUT = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/out'
url = sys.argv[1]
def conf(R):
    d = tempfile.mkdtemp(prefix='wkdata', dir=OUT)
    R.dm = WebKit2.WebsiteDataManager(base_data_directory=d + '/data', base_cache_directory=d + '/cache')
    R.ctx = WebKit2.WebContext(website_data_manager=R.dm)
    R.ctx.set_favicon_database_directory(d + '/fav')
R = Runner(port=8814, configure=conf)
def t():
    yield ('load', 'http://127.0.0.1:8814' + url, 2000)
    ok, c = R.view.get_theme_color()
    print(f'{url:28} title={R.view.get_title()!r:13} theme={c.to_string() if ok else None!s:16} favicon={"set" if R.view.get_favicon() else None} iconRequests={[e["path"] for e in server_log() if "icon" in e["path"]]}')
R.run(t(), timeout=30)
