import sys, json, re, statistics, urllib.parse
rows = {}
for fn in sys.argv[1:]:
    for line in open(fn):
        if not line.startswith('{'): continue
        d = json.loads(line)
        m = re.search(r'tag=T-(\w+)-d(\d+)-g(\d+)-r(\d)', d['url'])
        if not m: continue
        mode, dl, gp = m.group(1), int(m.group(2)), int(m.group(3))
        srv = d['server']; base = min(e['t'] for e in srv)
        got = {}
        for e in srv:
            if e['p'].startswith('/b?'):
                q = urllib.parse.parse_qs(e['p'][3:]); tag = q['tag'][0]
                u = q.get('u', [''])[0]
                if 'T-' in u and tag not in got: got[tag] = e['t'] - base
        nreq = sum(1 for e in srv if e['p'].startswith('/p?'))
        k = (fn.split('-')[0], dl, gp, mode)
        rows.setdefault(k, []).append((got.get('inline1'), got.get('dcl'), got.get('load'), nreq))
print('%-4s %5s %4s %-7s %8s %8s %8s %5s' % ('eng', 'ttfb', 'gap', 'mode', 'inline1', 'dcl', 'load', 'reqs'))
for k in sorted(rows):
    v = rows[k]
    med = lambda i: statistics.median([x[i] for x in v if x[i] is not None]) if any(x[i] is not None for x in v) else float('nan')
    print('%-4s %5d %4d %-7s %8.1f %8.1f %8.1f %5d' % (k[0], k[1], k[2], k[3], med(0), med(1), med(2), v[0][3]))
