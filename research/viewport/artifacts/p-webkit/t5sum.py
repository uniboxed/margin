import sys, json
for l in sys.stdin:
    if not l.startswith('RESULT'):
        print(l, end=''); continue
    d = json.loads(l[7:])
    if 'step' not in d:
        print(d); continue
    print(d['step'], 'ok=', d['ready']['ok'], 'ms=', d['ms'], 'uri=', d['state']['uri'], 'href=', d['shellOnNewPage'].get('href'))
    print('   loads:', [(e['ev'], e['uri']) for e in d['loads']][:8])
    print('   failed:', d['failed'][:3])
    print('   srv:', [(e['host'], e['path'][:45], e['dest']) for e in d['srv']])
