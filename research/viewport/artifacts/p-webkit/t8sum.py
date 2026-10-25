import sys, json
for l in sys.stdin:
    if not l.startswith('RESULT'):
        print(l, end=''); continue
    d = json.loads(l[7:])
    if d.get('step') == 'T8.scripts':
        print('T8.scripts q=%r world=%s cfg=%s' % (d['q'], d['world'], d['cfg']))
        print('   top main world :', d['topMainWorld'])
        print('   frame main world:', d['frameMainWorld'])
        print('   request counts :', d['requestCounts'])
    elif d.get('step') == 'T8.timing':
        print('T8.timing base=%s delay=%s median=%s vals=%s' % (d['base'], d['delay'], [v for k, v in d.items() if k.startswith('median')], d['vals']))
    else:
        print(d)
