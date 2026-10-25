import sys, json, urllib.parse
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('{'): continue
    d=json.loads(line)
    srv=d['server']; 
    base = min([e['t'] for e in srv] or [d.get('t0',0)])
    print('=== ', d['url'])
    for e in srv:
        p=e['p']
        if p.startswith('/b?'):
            q=urllib.parse.parse_qs(p[3:]); print('  %7.1f PAGE-SCRIPT %-8s in %-3s (%s)' % (e['t']-base, q.get('tag',[''])[0], q.get('f',[''])[0], q.get('u',[''])[0][:40]))
        else:
            print('  %7.1f REQ %-4s %-60s dest=%s site=%s%s' % (e['t']-base, e['m'], p[:60], e['dest'], e['site'], (' done=%.1f'%(e['done']-base)) if 'done' in e else ''))
    for m in d['cs']:
        m=dict(m); t=m.pop('t'); ev=m.pop('ev'); f=m.pop('f'); m.pop('href',None)
        print('  %7.1f CS %-18s %-3s %s' % (t-base, ev, f, json.dumps(m)[:260]))
