import sys, json
for l in sys.stdin:
    if not l.startswith('RESULT'):
        print(l, end=''); continue
    d = json.loads(l[7:])
    if 'step' not in d: print(d); continue
    print(d['step'], 'cfg=', d['cfg'], 'feature-args see cmd', '| topLoadsStarted(3s)=', d['topLoadsStarted'], '| pageRequests=', d['pageRequests'])
    print('   frame:', d['frame'])
    print('   shell cancels:', d['shell'].get('cancels') if isinstance(d['shell'], dict) else d['shell'], 'frameLoads:', d['shell'].get('frameLoads') if isinstance(d['shell'], dict) else None)
    print('   uri:', d['state']['uri'])
