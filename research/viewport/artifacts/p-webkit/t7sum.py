import sys, json
for l in sys.stdin:
    if not l.startswith('RESULT'):
        print(l, end=''); continue
    d = json.loads(l[7:])
    if 'step' not in d: print(d); continue
    fr = d['frame']
    framed = bool(fr.get('contentDocument') and fr['contentDocument'].get('hdr'))
    print('T7 q=%-45s world=%s framedInShell=%s topLoads=%s uri=%s' % (d['q'], d['world'], framed, d['topLoadsStarted'], d['state']['uri']))
    print('    frame=', json.dumps(fr)[:300])
    print('    shell=', json.dumps({k: d['shell'].get(k) for k in ('frameLoads', 'escapes', 'noShell')})[:300])
    print('    srv=', [(e['path'][:40], e['dest'], e['xmt']) for e in d['srv']])
