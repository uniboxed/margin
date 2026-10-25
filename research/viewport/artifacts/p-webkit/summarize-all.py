#!/usr/bin/python3.12
"""Compact digest of out/*.jsonl produced by run-all.sh.  usage: /usr/bin/python3.12 summarize-all.py [outdir]"""
import json, os, sys, glob

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')

def rows(name):
    p = os.path.join(OUT, name + '.jsonl')
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p) if l.strip()]

def fr(g):
    return g.get('frame', g) if isinstance(g, dict) else g

print('## T1 viewport')
for d in rows('T1'):
    if d.get('step') == 'T1.geom':
        f = d['geom']['frame']; i = d['geom']['iframe']
        print(f"  shell[{d['world']}]: iframe {i['w']}x{i['h']} at ({i['x']},{i['y']}); frame innerWidth={f['innerWidth']} clientWidth={f['clientWidth']} 100vw={f['vw100']} "
              f"fixed hdr {f['hdr']['left']}..{f['hdr']['right']} mq800={f['mq800']} css={f['mqCSS']} outerWidth={f['outerWidth']} top.innerWidth={d['geom']['top']['innerWidth']}")
    elif d.get('step') in ('T1.scrollTo500', 'T1.wheel5'):
        g = d['geom']; print(f"  {d['step']}[{d['world']}]: scrollY={g['scrollY']} scrollEvents={g['scrollEvents']} hdr.top={g['hdr']['top']} elementAt5x5={g['elementAt5x5']}")
    elif d.get('step') == 'T1base':
        g = d['geom']; print(f"  no-shell window: innerWidth={g['innerWidth']} 100vw={g['vw100']} hdr={g['hdr']['left']}..{g['hdr']['right']} mq800={g['mq800']}; after wheel scrollY={d['after_wheel5']['scrollY']}")

print('## T2 cookies')
for d in rows('T2'):
    if d['step'] == 'T2':
        print('  values:', d['values'], 'hasStorageAccess:', d['hasStorageAccess'])
    print('  ', d['step'], [(e['path'], e['dest'], e['site'], e['cookie']) for e in d['srv']])

print('## T3 same-origin navigation')
for d in rows('T3'):
    if d['step'] == 'T3':
        print(f"  [{d['world']}] ready={d['ready']['ok']} markerSurvived={d['markerSurvived']} topLoadsStarted={d['topLoadsStartedDuringClick']} uri={d['after']['state']['uri']} title={d['after']['state']['title']} srv={[(e['path'], e['dest']) for e in d['srv']]} copiedHead={d['copiedHead']}")
    else:
        print(f"  [{d['world']}] SPA pushState -> uri={d['after_pushState']['state']['uri']} title={d['after_pushState']['state']['title']}; hash -> {d['after_hash']['uri']}")
for d in rows('NAV'):
    if d['step'] == 'NAVSPA.toplevel':
        print('  Navigation API events (top-level, no shell):', d['events'])
    else:
        print(f"  NAV frame sets top.location to other same-origin URL: ready={d['ready']['ok']} topLoads={d['topLoadsStarted']} uri={d['state']['uri']} cancels={d['shell']['cancels']}")

print('## T4 back/forward')
for name in ('T4', 'BF-topmode'):
    for d in rows(name):
        if d['step'].startswith('T4'):
            st = d['state']
            print(f"  [{name} cfg={d['cfg']}] {d['step']} {d.get('how','')} ok={d.get('ready',{}).get('ok')} uri={st['uri']} title={st['title']} backLabels={st['back']} cur={st['cur']} fwd={st['fwd']}")
for name in ('BF', 'BF-topmode'):
    for d in rows(name):
        if d['step'].startswith('BF.'):
            print(f"  [{name}] {d['step']} shell={d['shell']} uri={d['state']['uri']} backLabels={d['state']['back']} cur={d['state']['cur']}")
        elif d['step'].startswith('BF2'):
            print(f"  [{name} cfg={d['cfg']} pc={d['pageCache']}] Back from other site -> uri={d['state']['uri']} frame={d['frame']} refetched={[e['path'] + ' ' + str(e['dest']) for e in d['srv'] if e['host'].startswith('localhost')]}")
        elif d['step'] == 'BFC':
            print(f"  [{name}] BFC q={d['q']!r} restoredFromBFCache={d['restoredFromBFCache']}")
        elif d['step'] == 'BFSKIP.backx3_fwdx3':
            print(f"  [{name} cfg={d['cfg']}] back x3 / fwd x3 landed={d['landed']} expected={d['expected']}")

print('## T5 cross-origin escapes')
for name in ('T5', 'T5-nonavapi'):
    for d in rows(name):
        if d['step'].startswith('T5dbg'):
            print(f"  [{name}] {d['step']} frame={d['frame']}"); continue
        print(f"  [{name}] {d['step']} -> uri={d['state']['uri']} ms={d['ms']} requests={[(e['host'].split(':')[0][:3] + ':' + e['host'].split(':')[1], e['path'][:38], e['dest']) for e in d['srv']]}")

print('## T6 frame busting')
for d in rows('T6'):
    if d['step'] == 'T6':
        print(f"  cfg={d['cfg']} topLoadsStarted(3s)={d['topLoadsStarted']} pageRequests={d['pageRequests']} frame={d['frame']}")
    else:
        print(f"  OWASP anti-clickjack cfg={d['cfg']}: topLoads={d['topLoadsStarted']} frame={d['frame']} srv={d['srv'][:4]}")

print('## T7 framing headers')
for name in ('T7', 'T7-rules'):
    for d in rows(name):
        if 'filter' in d:
            continue
        if d['step'] == 'T7':
            frm = d['frame']; framed = bool(frm.get('contentDocument') and frm['contentDocument'].get('hdr'))
            print(f"  [{name}][{d['world']}] q={d['q']}: framedInShell={framed} topLoads={d['topLoadsStarted']} requests={[(e['path'][:30], e['dest'], e['xmt']) for e in d['srv']]}")
        elif d['step'] == 'DUMP':
            print(f"  [{name}] DUMP {d['url']}: log={[e['ev'] for e in d['shellLog']] if isinstance(d['shellLog'], list) else d['shellLog']}")
        elif d['step'] == 'T8.scripts':
            print(f"  [{name}] control rule list on q={d['q']}: requests={[(e['path'][:25], e['xmt']) for e in d['srv']]}")

print('## T8 top-level scripts / cost')
for d in rows('T8'):
    if d['step'] == 'T8.scripts':
        print(f"  [{d['world']} cfg={d['cfg']}] q={d['q']!r}: top={d['topMainWorld']} frame={d['frameMainWorld']} counts={d['requestCounts']}")
    else:
        print(f"  timing base={d['base']} delay={d['delay']}ms: median={[v for k, v in d.items() if k.startswith('median')][0]} vals={d['vals']}")

print('## T9 keyboard / focus')
for d in rows('T9'):
    s = d['step']
    def fs(g):
        g = fr(g); return f"scrollY={g.get('scrollY')} keys={g.get('keydowns')}"
    if s == 'T9base':
        print(f"  no-shell: before {fs(d['before'])} | Space {fs(d['afterSpace'])} | Down {fs(d['afterDown'])}")
    elif s == 'T9.afterLoad':
        print(f"  cfg={d['cfg']} after load: before {fs(d['before'])} | Space {fs(d['afterSpace'])} | Down {fs(d['afterDown'])}")
    elif s == 'T9.afterSidebarClick':
        print(f"  cfg={d['cfg']} after sidebar click: Space {fs(d['afterSpace'])} topActive={d['afterClick'].get('topActive')}")
    elif s == 'T9.sidebarInput':
        print(f"  cfg={d['cfg']} sidebar input typing: {d['input']}")
    elif s == 'T9.afterFrameClick':
        print(f"  cfg={d['cfg']} after clicking in frame: Space {fs(d['afterSpace'])}")
    elif s == 'T9af':
        print(f"  autofocus base={d['base']}: afterLoad={d['afterLoad']} afterTyping={d['afterTypingA']}")

print('## T10 target=_top / _blank')
for d in rows('T10'):
    if d['step'] == 'T10.top':
        print(f"  cfg={d['cfg']} _top: ready={d['ready']['ok']} markerSurvived={d['markerSurvived']} topLoads={d['topLoadsStarted']} uri={d['state']['uri']} requests={[(e['path'], e['dest']) for e in d['srv']]}")
    else:
        print(f"  cfg={d['cfg']} _blank: create={d['create']} policy={[(p['type'], p['uri'], p.get('frame_name')) for p in d['policy']]}")

print('## extras')
for d in rows('T11'):
    print(f"  find-in-page base={d['base']}: {d['find']} selection={d['selectionInFrame']!r}")
for d in rows('PRINT'):
    print(f"  print base={d['base']} cfg={d['cfg']}: {d['pages']} hasSection2={d['hasSection2']} startsWith={d['text'][:40]!r}")
for d in rows('FS'):
    print(f"  fullscreen from frame: {d['enabled']} {d['after']} gtk={d['gtkFullscreen']}")
for d in rows('ISO'):
    print(f"  isolated world: {d['mainWorld']} {d['shellWorld']}")
for d in rows('POST'):
    print(f"  {d['step']}: {d.get('srv')} uri={d.get('uri') or d.get('state')}")
for d in rows('REF'):
    print(f"  referrer on cross-site arrival: {d['js']} requests={d['srv']}")
for name in ('BF-topmode', 'BF'):
    for d in rows(name):
        if d['step'] == 'BFSKIP2':
            print(f"  [{name} cfg={d['cfg']}] BFSKIP2 pre-click={d['pre']} landed={d['landed']} expected={d['expected']}")
for d in rows('T8-cache'):
    print(f"  cacheable top response q={d['q']}: requestCounts={d['requestCounts']}")
for d in rows('T7-dump-deny'):
    print(f"  XFO DENY trace: frame={d['frame']} topLoads={d['topLoadsStarted']} requests={d['srv'][:4]}")
for d in rows('CSPPROBE'):
    print(f"  CSP probe (content-script world, no shell) {d['q']}: {d['res']}")
for d in rows('CSPSTYLE'):
    print(f"  shell under top CSP {d['q']} cfg={d['cfg']}: {d['geom']} requests={d['srv']}")
