import sys, json
def f(g):
    if not isinstance(g, dict): return g
    fr = g.get('frame', g)
    return {'frameScrollY': fr.get('scrollY'), 'frameKeys': fr.get('keydowns'), 'frameHasFocus': fr.get('hasFocus'), 'frameActive': fr.get('active'), 'topActive': g.get('topActive'), 'topHasFocus': g.get('topHasFocus')}
for l in sys.stdin:
    if not l.startswith('RESULT'):
        print(l, end=''); continue
    d = json.loads(l[7:])
    st = d.get('step')
    print(st, 'cfg=', d.get('cfg'))
    for k, v in d.items():
        if k in ('step', 'cfg', 'world', 'scenario'): continue
        if k == 'gtk': print('   gtk:', {x: v[x] for x in ('has_toplevel_focus', 'view_has_focus')}); continue
        if k == 'input': print('   input:', v); continue
        print('   %s: %s' % (k, f(v)))
