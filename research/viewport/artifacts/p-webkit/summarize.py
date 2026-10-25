import sys, json
# compact view of RESULT lines: drops 'log' arrays unless -v
verbose = '-v' in sys.argv
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if verbose or k not in ('log', 'cfg', 'world', 'scenario')}
    if isinstance(o, list):
        return [strip(x) for x in o]
    return o
for l in sys.stdin:
    if l.startswith('RESULT '):
        print(json.dumps(strip(json.loads(l[7:]))))
    else:
        print(l, end='')
