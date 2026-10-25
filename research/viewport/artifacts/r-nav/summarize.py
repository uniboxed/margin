import sys, json
# reads wkrun/chromium JSON on stdin; prints a compact summary
d = json.loads(sys.stdin.read())
log = d.get('log', [])
keep = ('top-navigate', 'frame-navigate', 'shell-iframe-load', 'page-load', 'frame-after', 'server-redirect', 'server-post', 'post-landed', 'top-popstate', 'top-beforeunload', 'shell-nav-request', 'frame-pagehide')
counts = {}
for e in log:
    counts[e.get('ev')] = counts.get(e.get('ev'), 0) + 1
print('final:', d.get('finalUri'), '| title:', d.get('finalTitle'), '| counts:', counts)
seen = set()
for e in log:
    ev = e.get('ev')
    if ev not in keep:
        if ev == 'server-hit':
            k = (e['path'], e['dest'], e['method'])
            if k in seen: continue
            seen.add(k)
            print('   server-hit', e['method'], e['dest'], e['host'], e['path'][:90])
        continue
    x = {k: v for k, v in e.items() if k not in ('t', 'port', 'ev', 'hashChange', 'info')}
    print('  ', ev, json.dumps(x)[:400])
