"""Scenarios for run.py. Each is a generator taking a params dict and yielding commands."""
A = 'http://localhost:8931'
B = 'http://localhost:8932'
X = 'http://127.0.0.1:8931'

# ---- JS snippets (function bodies) ----
FRAME_READY = """const f = document.getElementById('margin-frame'); if (!f) return false;
try { const d = f.contentDocument; return d && d.readyState === 'complete' && d.getElementById('hdr') ? f.contentWindow.location.href : false; } catch (e) { return false; }"""

def frame_at(path):
    return ("const f = document.getElementById('margin-frame'); if (!f) return false; try { const d = f.contentDocument;"
            " return d && d.readyState === 'complete' && d.getElementById('hdr') && f.contentWindow.location.pathname + f.contentWindow.location.search === %r ? f.contentWindow.location.href : false; } catch (e) { return false; }" % path)

SHELL = """const M = window.__margin; if (!M) return {noShell: true, href: location.href};
return {marker: M.marker, syncs: M.syncs, frameLoads: M.frameLoads, cancels: M.cancels, escapes: M.escapes,
        pending: M.pending, frameSide: M.frameSide, href: location.href, title: document.title, log: M.log};"""

SHELL_BRIEF = """const M = window.__margin; if (!M) return {noShell: true, href: location.href};
return {marker: M.marker, syncs: M.syncs, frameLoads: M.frameLoads, cancels: M.cancels, escapes: M.escapes, pending: M.pending, href: location.href, title: document.title};"""

GEOM = """const f = document.getElementById('margin-frame'); const w = f.contentWindow; const d = w.document;
const fr = f.getBoundingClientRect(); const h = d.getElementById('hdr').getBoundingClientRect(); const vw = d.getElementById('vw').getBoundingClientRect();
const top_at = d.elementFromPoint(5, 5);
return { top: {innerWidth: innerWidth, innerHeight: innerHeight, mq800: matchMedia('(max-width: 800px)').matches},
  iframe: {x: fr.x, y: fr.y, w: fr.width, h: fr.height},
  frame: { innerWidth: w.innerWidth, innerHeight: w.innerHeight, clientWidth: d.documentElement.clientWidth, clientHeight: d.documentElement.clientHeight,
    vvWidth: w.visualViewport ? w.visualViewport.width : null, outerWidth: w.outerWidth, screenWidth: w.screen.width, dpr: w.devicePixelRatio,
    mq800: w.matchMedia('(max-width: 800px)').matches, mqCSS: w.getComputedStyle(d.getElementById('mq'), '::after').content,
    hdr: {left: h.left, right: h.right, width: h.width, top: h.top}, vw100: vw.width,
    scrollY: w.scrollY, scrollEvents: w.__scrollEvents, elementAt5x5: top_at && top_at.id,
    docScrollWidth: d.documentElement.scrollWidth, keydowns: w.__keydowns,
    hasFocus: d.hasFocus(), active: d.activeElement && (d.activeElement.id || d.activeElement.tagName) },
  topHasFocus: document.hasFocus(), topActive: document.activeElement && (document.activeElement.id || document.activeElement.tagName) };"""

NOSHELL_GEOM = """const h = document.getElementById('hdr').getBoundingClientRect(); const vw = document.getElementById('vw').getBoundingClientRect();
return {innerWidth: innerWidth, innerHeight: innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
  mq800: matchMedia('(max-width: 800px)').matches, mqCSS: getComputedStyle(document.getElementById('mq'), '::after').content,
  hdr: {left: h.left, right: h.right, width: h.width, top: h.top}, vw100: vw.width, scrollY: scrollY, scrollEvents: window.__scrollEvents,
  docScrollWidth: document.documentElement.scrollWidth, keydowns: window.__keydowns, hasFocus: document.hasFocus()};"""

def page_ready_noshell():
    return "return document.readyState === 'complete' && !!document.getElementById('hdr');"

def srvlog_brief(log, paths=None):
    out = []
    for e in log:
        if paths and not any(e['path'].startswith(p) for p in paths):
            continue
        out.append({k: e[k] for k in ('i', 't', 'port', 'host', 'method', 'path', 'dest', 'site', 'cookie', 'xmt') if k in e})
    return out

def frame_link_center(link_id):
    return ("const f = document.getElementById('margin-frame'); const r = f.getBoundingClientRect(); const a = f.contentDocument.getElementById(%r);"
            " a.scrollIntoView({block: 'center'}); const b = a.getBoundingClientRect(); return {x: Math.round(r.x + b.x + Math.min(b.width/2, 20)), y: Math.round(r.y + b.y + b.height/2)};" % link_id)

def load_count(events):
    return len([e for e in events['load'] if e['ev'] == 'started'])

# ---------------- scenarios ----------------
def smoke(p):
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    r = yield ('waitfor', FRAME_READY, 'main', 8000)
    st = yield ('js', SHELL, 'shell')
    s = yield ('state',)
    log = yield ('srv', '/__log')
    ev = yield ('events',)
    yield ('emit', {'step': 'smoke', 'ready': r, 'shell': st, 'state': s, 'srv': srvlog_brief(log), 'events': ev})

def T1(p):
    """viewport inside the shell frame + scrolling."""
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    r = yield ('waitfor', FRAME_READY, 'main', 8000)
    g0 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T1.geom', 'ready': r, 'geom': g0})
    # programmatic scroll
    yield ('js', "document.getElementById('margin-frame').contentWindow.scrollTo(0, 500); return 1;", 'main')
    yield ('sleep', 300)
    g1 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T1.scrollTo500', 'geom': g1['frame'] if isinstance(g1, dict) and 'frame' in g1 else g1})
    # real wheel events over the card (x=600,y=300 is inside the iframe)
    yield ('wheel', 600, 300, 5, 800)
    g2 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T1.wheel5', 'geom': g2['frame'] if isinstance(g2, dict) and 'frame' in g2 else g2})
    s = yield ('state',)
    yield ('emit', {'step': 'T1.state', 'state': s})

def T1base(p):
    """same page without shell (use --no-shell --size 732x584 for the 'narrower window' reference, or 1000x600)."""
    yield ('load', A + '/p/A?__noshell=1')
    r = yield ('waitfor', page_ready_noshell(), 'main', 8000)
    g = yield ('js', NOSHELL_GEOM, 'main')
    yield ('js', "scrollTo(0, 500); return 1;", 'main')
    yield ('sleep', 300)
    g1 = yield ('js', NOSHELL_GEOM, 'main')
    yield ('wheel', 300, 300, 5, 800)
    g2 = yield ('js', NOSHELL_GEOM, 'main')
    yield ('emit', {'step': 'T1base', 'ready': r, 'geom': g, 'after_scrollTo500': g1, 'after_wheel5': g2})

def T2(p):
    """cookies set by the top-level response are sent with the frame request and readable in it; localStorage shared."""
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A?cookie=1')
    r = yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('js', "localStorage.setItem('fromTop', 'yes-' + Date.now()); return 1;", 'main')
    v = yield ('js', """const f = document.getElementById('margin-frame'); const w = f.contentWindow;
      return {frameCookie: w.document.cookie, topCookie: document.cookie, frameLS: w.localStorage.getItem('fromTop'), topLS: localStorage.getItem('fromTop'),
              sameOrigin: w.origin === origin, frameOrigin: w.origin};""", 'main')
    sa = yield ('js', """const w = document.getElementById('margin-frame').contentWindow; window.__sa = 'pending';
      if (!w.document.hasStorageAccess) return 'no-api'; w.document.hasStorageAccess().then(x => window.__sa = x, e => window.__sa = 'err ' + e); return 'called';""", 'main')
    yield ('sleep', 300)
    sa2 = yield ('js', "return window.__sa;", 'main')
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T2', 'ready': r, 'values': v, 'hasStorageAccess': [sa, sa2], 'srv': srvlog_brief(log, ['/p/'])})
    # second navigation: a cookie-less top request? no -- now navigate the frame to B: cookies must flow
    c = yield ('js', frame_link_center('lB'), 'main')
    yield ('click', c['x'], c['y'], 100)
    r2 = yield ('waitfor', frame_at('/p/B'), 'main', 8000)
    log2 = yield ('srv', '/__log')
    yield ('emit', {'step': 'T2.frameNavB', 'ready': r2, 'srv': srvlog_brief(log2, ['/p/B'])})

def T3(p):
    """same-origin link click inside the frame; top URL/title sync; top not reloaded."""
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    s0 = yield ('js', SHELL_BRIEF, 'shell')
    st0 = yield ('state',)
    yield ('clear_events',)
    c = yield ('js', frame_link_center('lB'), 'main')
    yield ('click', c['x'], c['y'], 100)
    r = yield ('waitfor', frame_at('/p/B'), 'main', 8000)
    yield ('sleep', 200)
    s1 = yield ('js', SHELL, 'shell')
    st1 = yield ('state',)
    ev = yield ('events',)
    log = yield ('srv', '/__log')
    meta = yield ('js', "return [...document.head.querySelectorAll('[data-margin-copy]')].map(e => e.outerHTML);", 'main')
    yield ('emit', {'step': 'T3', 'click': c, 'ready': r, 'before': {'shell': s0, 'state': st0}, 'after': {'shell': s1, 'state': st1},
                    'markerSurvived': s0.get('marker') == s1.get('marker'), 'topLoadsStartedDuringClick': load_count(ev), 'events': ev,
                    'copiedHead': meta, 'srv': srvlog_brief(log, ['/p/'])})
    # pushState inside the frame (SPA navigation) -> sync via currententrychange/popstate
    yield ('js', "const w = document.getElementById('margin-frame').contentWindow; w.history.pushState({}, '', '/p/B/spa?x=1'); w.document.title = 'SPA title'; return 1;", 'main')
    yield ('sleep', 300)
    st2 = yield ('state',)
    s2 = yield ('js', SHELL_BRIEF, 'shell')
    yield ('js', "document.getElementById('margin-frame').contentWindow.location.hash = 'h1'; return 1;", 'main')
    yield ('sleep', 300)
    st3 = yield ('state',)
    s3 = yield ('js', "const M = window.__margin; return M.log.slice(-8);", 'shell')
    yield ('emit', {'step': 'T3.spa', 'after_pushState': {'state': st2, 'shell': s2}, 'after_hash': st3, 'shellLogTail': s3})

def T4(p):
    """A->B->C in the frame, then back twice / forward; how=ui (view.go_back) or how=js (frame history.back())."""
    how = p.get('how', 'ui')
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    for nxt, lid in (('/p/B', 'lB'), ('/p/C', 'lC')):
        c = yield ('js', frame_link_center(lid), 'main')
        yield ('click', c['x'], c['y'], 100)
        r = yield ('waitfor', frame_at(nxt), 'main', 8000)
        yield ('sleep', 150)
    st = yield ('state',)
    sh = yield ('js', SHELL_BRIEF, 'shell')
    yield ('emit', {'step': 'T4.atC', 'state': st, 'shell': sh, 'historyLength': (yield ('js', 'return history.length;', 'main'))})
    yield ('clear_events',)
    for expect in ('/p/B', '/p/A'):
        if how == 'ui':
            yield ('back',)
        else:
            yield ('js', "document.getElementById('margin-frame').contentWindow.history.back(); return 1;", 'main')
        r = yield ('waitfor', frame_at(expect), 'main', 8000)
        yield ('sleep', 200)
        st = yield ('state',)
        sh = yield ('js', SHELL_BRIEF, 'shell')
        yield ('emit', {'step': 'T4.back->' + expect, 'how': how, 'ready': r, 'state': st, 'shell': sh})
    if how == 'ui':
        yield ('forward',)
    else:
        yield ('js', "document.getElementById('margin-frame').contentWindow.history.forward(); return 1;", 'main')
    r = yield ('waitfor', frame_at('/p/B'), 'main', 8000)
    yield ('sleep', 200)
    st = yield ('state',)
    sh = yield ('js', SHELL, 'shell')
    ev = yield ('events',)
    yield ('emit', {'step': 'T4.forward->/p/B', 'how': how, 'ready': r, 'state': st, 'shell': sh, 'topLoadsStarted': load_count(ev), 'events': ev['load']})
    # one more back past the start: should leave the site? (only 1 top-level entry) -> stays
    # reload the top (Cmd-R): shell must come back on the synced URL
    yield ('clear_events',)
    yield ('srv', '/__clear')
    yield ('reload',)
    r0 = yield ('waitfor', "return window.__margin && window.__margin.marker !== %r && window.__margin.frameLoads >= 1;" % sh['marker'], 'shell', 8000)
    r = yield ('waitfor', frame_at('/p/B'), 'main', 8000)
    st = yield ('state',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T4.reload', 'newShell': r0, 'ready': r, 'state': st, 'srv': srvlog_brief(log, ['/p/'])})

def T5(p):
    """cross-origin navigations from inside the frame become top-level navigations."""
    which = p.get('which', 'lX')
    expect = {'lX': X + '/p/X', 'lO': B + '/p/O', 'lR': X + '/p/RX', 'lRD': X + '/p/RXD?xfo=DENY', 'assign': X + '/p/X2', 'form': X + '/p/XF?'}[which]
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('clear_events',)
    t0 = yield ('now',)
    if which == 'assign':
        # page script (main world of the frame) changes location -> must still be intercepted
        yield ('js', "document.getElementById('margin-frame').contentWindow.eval(\"setTimeout(() => location.href = '%s', 0)\"); return 1;" % (X + '/p/X2'), 'main')
    elif which == 'form':
        yield ('js', "const d = document.getElementById('margin-frame').contentDocument; const f = d.createElement('form'); f.action = '%s'; f.method = 'get'; d.body.append(f); f.submit(); return 1;" % (X + '/p/XF'), 'main')
    else:
        c = yield ('js', frame_link_center(which), 'main')
        yield ('click', c['x'], c['y'], 100)
    # ready = top URL is the expected one AND the page shows, either inside a new shell frame or (if unframeable) unshelled
    r = yield ('waitfor', "return location.href === %r && (() => { const f = document.getElementById('margin-frame'); if (!f) return document.readyState === 'complete' && !!document.getElementById('hdr') && 'unshelled'; try { return f.contentDocument && f.contentDocument.readyState === 'complete' && !!f.contentDocument.getElementById('hdr') && 'in-shell'; } catch (e) { return false; } })();" % expect, 'main', 10000)
    t1 = yield ('now',)
    st = yield ('state',)
    ev = yield ('events',)
    log = yield ('srv', '/__log')
    sh = yield ('js', SHELL_BRIEF, 'shell')
    yield ('emit', {'step': 'T5.' + which, 'expect': expect, 'ready': r, 'ms': round(t1 - t0, 1), 'state': st, 'shellOnNewPage': sh,
                    'loads': ev['load'], 'failed': ev['failed'], 'policy': ev['policy'], 'srv': srvlog_brief(log, ['/p/', '/r', '/b?ev=escape'])})

def T5shell(p):
    """Like T5 but dumps the OLD shell's log just before it is replaced (to see which path handled it)."""
    which = p.get('which', 'lR')
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('js', "window.__dump = []; const M = window.__margin; const orig = M.escapes.push.bind(M.escapes); M.escapes.push = (x) => { window.__dump.push(JSON.stringify({x, log: M.log.slice(-12)})); try { sessionStorage.setItem('dump', JSON.stringify({x, log: M.log.slice(-15)})); } catch (e) {} return orig(x); }; return 1;", 'shell')
    c = yield ('js', frame_link_center(which), 'main')
    yield ('click', c['x'], c['y'], 100)
    yield ('sleep', 2500)
    st = yield ('state',)
    yield ('emit', {'step': 'T5shell.' + which, 'state': st})

def T6(p):
    """frame-busting page inside the shell."""
    yield ('srv', '/__clear')
    yield ('clear_events',)
    yield ('load', A + '/p/A?bust=1')
    yield ('sleep', int(p.get('wait', 3000)))
    ev = yield ('events',)
    st = yield ('state',)
    sh = yield ('js', SHELL, 'shell')
    fr = yield ('js', """const f = document.getElementById('margin-frame'); if (!f) return {noFrame: true, title: document.title, href: location.href};
      try { const w = f.contentWindow; return {href: w.location.href, title: w.document.title, bustTried: w.__bustTried || 0, bustErr: w.__bustErr || null, hdr: !!w.document.getElementById('hdr')}; } catch (e) { return {err: String(e)}; }""", 'main')
    log = yield ('srv', '/__log')
    docreqs = [e for e in log if e['path'].startswith('/p/A')]
    yield ('emit', {'step': 'T6', 'topLoadsStarted': load_count(ev), 'loads': ev['load'][:12], 'state': st, 'frame': fr, 'shell': sh,
                    'pageRequests': len(docreqs), 'srv': srvlog_brief(docreqs[:12])})

def T7(p):
    """framing headers: q = query string for /p/A (xfo=..., fa=..., tcsp=...)."""
    q = p.get('q', '')
    yield ('srv', '/__clear')
    yield ('clear_events',)
    yield ('load', A + '/p/A?' + q)
    yield ('sleep', int(p.get('wait', 2500)))
    fr = yield ('js', """const f = document.getElementById('margin-frame'); if (!f) return {noFrame: true, title: document.title, href: location.href};
      let r = {}; try { r.href = f.contentWindow.location.href; } catch (e) { r.hrefErr = String(e).slice(0, 80); }
      try { const d = f.contentDocument; r.contentDocument = d ? {url: d.URL, title: d.title, hdr: !!d.getElementById('hdr'), bodyLen: d.body ? d.body.innerHTML.length : null} : null; } catch (e) { r.cdErr = String(e).slice(0, 80); }
      return r;""", 'main')
    sh = yield ('js', SHELL_BRIEF, 'shell')
    st = yield ('state',)
    ev = yield ('events',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T7', 'q': q, 'frame': fr, 'shell': sh, 'state': st, 'topLoadsStarted': load_count(ev), 'failed': ev['failed'],
                    'srv': srvlog_brief(log, ['/p/'])})

def T8(p):
    """top-level page's own scripts and subresources: with shell (default) or --no-shell baseline."""
    q = p.get('q', '')
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A' + (('?' + q) if q else ''))
    yield ('sleep', int(p.get('wait', 2000)))
    top = yield ('js', "return {inlineHead: window.__inlineHead || 0, inlineBody: window.__inlineBody || 0, ext: window.__ext || 0, ctx: window.__ctx || null, rs: document.readyState, title: document.title, nodes: document.getElementsByTagName('*').length};", 'main')
    fr = yield ('js', "const f = document.getElementById('margin-frame'); if (!f) return null; const w = f.contentWindow; return {inlineHead: w.__inlineHead || 0, inlineBody: w.__inlineBody || 0, ext: w.__ext || 0, ctx: w.__ctx};", 'main')
    sh = yield ('js', "const M = window.__margin; return M ? M.log.slice(0, 4) : null;", 'shell')
    log = yield ('srv', '/__log')
    counts = {}
    for e in log:
        k = e['path'].split('?')[0] + (' ' + e['path'].split('ctx=')[1].split('&')[0] if 'ctx=' in e['path'] else '')
        counts[k] = counts.get(k, 0) + 1
    yield ('emit', {'step': 'T8.scripts', 'q': q, 'topMainWorld': top, 'frameMainWorld': fr, 'shellFirstLog': sh, 'requestCounts': counts, 'srv': srvlog_brief(log)})

TIMING_SHELL = """const f = document.getElementById('margin-frame'); if (!f) return false; let w, d; try { w = f.contentWindow; d = w.document; } catch (e) { return false; }
if (!d || d.readyState !== 'complete' || !d.getElementById('hdr')) return false;
const nav = w.performance.getEntriesByType('navigation')[0]; if (!nav || !nav.loadEventEnd) return false;
const tnav = performance.getEntriesByType('navigation')[0];
return {topTimeOrigin: performance.timeOrigin, frameTimeOrigin: w.performance.timeOrigin,
  frameLoadEndFromTopStart: +(w.performance.timeOrigin + nav.loadEventEnd - performance.timeOrigin).toFixed(1),
  frameResponseStartFromTopStart: +(w.performance.timeOrigin + nav.responseStart - performance.timeOrigin).toFixed(1),
  frameStartFromTopStart: +(w.performance.timeOrigin - performance.timeOrigin).toFixed(1),
  topResponseStart: tnav ? +tnav.responseStart.toFixed(1) : null};"""
TIMING_BASE = """if (document.readyState !== 'complete') return false; const nav = performance.getEntriesByType('navigation')[0]; if (!nav || !nav.loadEventEnd) return false;
return {loadEnd: +nav.loadEventEnd.toFixed(1), responseStart: +nav.responseStart.toFixed(1), dcl: +nav.domContentLoadedEventEnd.toFixed(1)};"""

def T8timing(p):
    n = int(p.get('n', 5)); delay = p.get('delay', '0'); base = p.get('base', '0') == '1'
    res = []
    for i in range(n):
        url = A + '/p/A?delay=' + delay + ('&__noshell=1' if base else '') + '&i=' + str(i)
        yield ('load', 'about:blank')
        yield ('sleep', 300)
        t0 = yield ('now',)
        yield ('load', url)
        guard = "if (!location.href.endsWith('&i=%d')) return false; " % i
        r = yield ('waitfor', guard + (TIMING_BASE if base else TIMING_SHELL), 'main', 10000)
        t1 = yield ('now',)
        res.append({'wall_ms': round(t1 - t0, 1), 'page': r.get('v')})
    key = 'loadEnd' if base else 'frameLoadEndFromTopStart'
    vals = sorted(x['page'][key] for x in res if x['page'])
    yield ('emit', {'step': 'T8.timing', 'base': base, 'delay': delay, 'n': n, 'median_' + key: vals[len(vals) // 2] if vals else None, 'vals': vals, 'runs': res})

def T9(p):
    """keyboard focus: Space/ArrowDown after load; after a sidebar click; typing in the sidebar input."""
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('sleep', 300)
    st = yield ('state',)
    g0 = yield ('js', GEOM, 'main')
    yield ('key', 'space', 600)
    g1 = yield ('js', GEOM, 'main')
    yield ('key', 'down', 600)
    g2 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T9.afterLoad', 'gtk': st, 'before': g0, 'afterSpace': g1, 'afterDown': g2})
    # click on the sidebar's blank area (x=100,y=150) then Space
    yield ('click', 100, 150, 300)
    g3 = yield ('js', GEOM, 'main')
    yield ('key', 'space', 600)
    g4 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T9.afterSidebarClick', 'afterClick': g3, 'afterSpace': g4})
    # click sidebar input then type 'a': must go to the input, not the frame
    pos = yield ('js', "const r = document.getElementById('sb-input').getBoundingClientRect(); return {x: Math.round(r.x + 10), y: Math.round(r.y + r.height / 2)};", 'main')
    yield ('click', pos['x'], pos['y'], 300)
    yield ('key', 'a', 300)
    v = yield ('js', "return {value: document.getElementById('sb-input').value, active: document.activeElement && document.activeElement.id};", 'main')
    g5 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T9.sidebarInput', 'input': v, 'frame': g5})
    # click inside the frame content then Space
    yield ('click', 600, 300, 300)
    g6 = yield ('js', GEOM, 'main')
    yield ('key', 'space', 600)
    g7 = yield ('js', GEOM, 'main')
    yield ('emit', {'step': 'T9.afterFrameClick', 'afterClick': g6, 'afterSpace': g7})

def T9base(p):
    yield ('load', A + '/p/A?__noshell=1')
    yield ('waitfor', page_ready_noshell(), 'main', 8000)
    yield ('sleep', 300)
    g0 = yield ('js', NOSHELL_GEOM, 'main')
    yield ('key', 'space', 600)
    g1 = yield ('js', NOSHELL_GEOM, 'main')
    yield ('key', 'down', 600)
    g2 = yield ('js', NOSHELL_GEOM, 'main')
    st = yield ('state',)
    yield ('emit', {'step': 'T9base', 'before': g0, 'afterSpace': g1, 'afterDown': g2, 'gtk': st})

def T10(p):
    """target=_top and target=_blank links inside the frame."""
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    s0 = yield ('js', SHELL_BRIEF, 'shell')
    yield ('clear_events',)
    c = yield ('js', frame_link_center('lTop'), 'main')
    yield ('click', c['x'], c['y'], 100)
    r = yield ('waitfor', frame_at('/p/T'), 'main', 8000)
    yield ('sleep', 300)
    s1 = yield ('js', SHELL, 'shell')
    st = yield ('state',)
    ev = yield ('events',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T10.top', 'ready': r, 'markerSurvived': s0.get('marker') == s1.get('marker'), 'shell': s1, 'state': st,
                    'topLoadsStarted': load_count(ev), 'srv': srvlog_brief(log, ['/p/T'])})
    yield ('clear_events',)
    c = yield ('js', frame_link_center('lBlank'), 'main')
    yield ('click', c['x'], c['y'], 500)
    ev = yield ('events',)
    st = yield ('state',)
    yield ('emit', {'step': 'T10.blank', 'create': ev['create'], 'policy': ev['policy'], 'state': st})

def T11(p):
    """find-in-page across the shell frame (WebKit FindController ~ Safari Cmd-F)."""
    yield ('load', A + ('/p/A' if p.get('base') != '1' else '/p/A?__noshell=1'))
    yield ('sleep', 1500)
    yield ('clear_events',)
    yield ('find', 'needle-A')
    ev = yield ('events',)
    sel = yield ('js', "const f = document.getElementById('margin-frame'); const w = f ? f.contentWindow : window; return String(w.getSelection());", 'main')
    yield ('emit', {'step': 'T11.find', 'base': p.get('base') == '1', 'find': ev['find'], 'selectionInFrame': sel})

def NAV(p):
    """Navigation API event semantics in WebKitGTK for the shell: what the top sees when the frame navigates top."""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('clear_events',)
    # frame script sets top.location to a *different* same-origin URL
    yield ('js', "document.getElementById('margin-frame').contentWindow.eval(\"top.location.href = '/p/C?fromframe=1'\"); return 1;", 'main')
    r = yield ('waitfor', frame_at('/p/C?fromframe=1'), 'main', 5000)
    yield ('sleep', 300)
    sh = yield ('js', SHELL, 'shell')
    ev = yield ('events',)
    st = yield ('state',)
    yield ('emit', {'step': 'NAV.frameSetsTop', 'ready': r, 'shell': sh, 'topLoadsStarted': load_count(ev), 'state': st})

def T2x(p):
    """cross-site arrival: cookies exist; user comes from another site (X) to A. Strict cookie on top request vs frame request."""
    yield ('load', A + '/p/A?cookie=1&__noshell=1')
    yield ('sleep', 800)
    yield ('load', X + '/p/X?__noshell=1')
    yield ('sleep', 800)
    yield ('srv', '/__clear')
    yield ('js', "location.href = %r; return 1;" % (A + '/p/A'), 'main')
    r = yield ('waitfor', FRAME_READY, 'main', 8000)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T2x.crossSiteArrival', 'ready': r, 'srv': srvlog_brief(log, ['/p/'])})

def NAVSPA(p):
    """Which Navigation API events fire for history.pushState / replaceState / hash in WebKitGTK (frame and top-level, no shell)."""
    yield ('load', A + '/p/A?__noshell=1')
    yield ('waitfor', page_ready_noshell(), 'main', 8000)
    r = yield ('js', """window.__ev = []; const n = window.navigation; if (!n) return 'no navigation api';
      for (const t of ['navigate', 'currententrychange', 'navigatesuccess', 'navigateerror']) n.addEventListener(t, (e) => window.__ev.push(t + (e.navigationType ? ':' + e.navigationType : '') + (e.destination ? ' ' + e.destination.url.replace(location.origin, '') : '')));
      addEventListener('popstate', () => window.__ev.push('popstate')); addEventListener('hashchange', () => window.__ev.push('hashchange'));
      history.pushState({}, '', '/p/A/push1'); window.__ev.push('--after push sync, currentEntry=' + n.currentEntry.url.replace(location.origin, ''));
      return 'ok';""", 'main')
    yield ('sleep', 200)
    yield ('js', "history.replaceState({}, '', '/p/A/replace1'); window.__ev.push('--after replace sync'); return 1;", 'main')
    yield ('sleep', 200)
    yield ('js', "location.hash = 'x'; window.__ev.push('--after hash sync'); return 1;", 'main')
    yield ('sleep', 200)
    yield ('js', "navigation.addEventListener('navigate', (e) => { if (e.canIntercept && e.destination.url.endsWith('/nav1')) e.intercept({handler: async () => {}}); }); navigation.navigate('/p/A/nav1', {history: 'push'}).finished.catch(()=>{}); window.__ev.push('--after navigation.navigate (intercepted)'); return 1;", 'main')
    yield ('sleep', 600)
    ev = yield ('js', "return window.__ev || ('reloaded: ' + location.href);", 'main')
    yield ('emit', {'step': 'NAVSPA.toplevel', 'setup': r, 'events': ev})

def BF(p):
    """back/forward list labels. shell mode: frame navigations A->B->C; noshell mode (--no-shell): top-level A->B->C."""
    shell = p.get('shell', '1') == '1'
    q = '' if shell else '?__noshell=1'
    yield ('load', A + '/p/A' + q)
    yield ('sleep', 700)
    for nxt in ('B', 'C'):
        if shell:
            yield ('js', "document.getElementById('margin-frame').contentDocument.getElementById('l%s').click(); return 1;" % nxt, 'main')
        else:
            yield ('js', "document.getElementById('l%s').click(); return 1;" % nxt, 'main')
        yield ('sleep', 700)
        st = yield ('state',)
        yield ('emit', {'step': 'BF.at' + nxt, 'shell': shell, 'state': st})
    yield ('back', 700)
    st = yield ('state',)
    yield ('emit', {'step': 'BF.afterBack', 'shell': shell, 'state': st})


def BF2(p):
    """A->B->C in the frame, leave to another site at top level, then Back: does the shell come back at C?"""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    for nxt in ('B', 'C'):
        yield ('js', "document.getElementById('margin-frame').contentDocument.getElementById('l%s').click(); return 1;" % nxt, 'main')
        yield ('waitfor', frame_at('/p/' + nxt), 'main', 8000)
        yield ('sleep', 200)
    yield ('srv', '/__clear')
    yield ('load', X + '/p/X?__noshell=1')
    yield ('sleep', 800)
    st0 = yield ('state',)
    yield ('back', 1500)
    st = yield ('state',)
    fr = yield ('js', "const f = document.getElementById('margin-frame'); if (!f) return {noFrame: true, href: location.href}; return {top: location.href, frame: f.contentWindow.location.href, marker: window.__margin && window.__margin.marker};", 'main')
    sh = yield ('js', SHELL_BRIEF, 'shell')
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'BF2.backFromOtherSite', 'pageCache': p.get('pc', '1'), 'atX': st0, 'state': st, 'frame': fr, 'shell': sh, 'srv': srvlog_brief(log, ['/p/'])})

def BFC(p):
    """bfcache check: load A (shell or not), go to X, Back. Did the top document get re-fetched?"""
    q = p.get('q', '')
    yield ('load', A + '/p/A' + q)
    yield ('sleep', 1000)
    yield ('js', "window.__bfmark = 'alive'; return 1;", 'main')
    yield ('srv', '/__clear')
    yield ('load', X + '/p/X?__noshell=1')
    yield ('sleep', 1000)
    yield ('back', 1500)
    m = yield ('js', "return {mark: window.__bfmark || null, href: location.href};", 'main')
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'BFC', 'q': q, 'restoredFromBFCache': (m or {}).get('mark') == 'alive', 'page': m, 'srv': [e['path'] + ' ' + str(e['dest']) for e in log]})

UA = """const f = document.getElementById('margin-frame'); const ua = (w) => w.navigator.userActivation ? {hasBeenActive: w.navigator.userActivation.hasBeenActive, isActive: w.navigator.userActivation.isActive} : 'n/a';
return {top: ua(window), frame: f ? ua(f.contentWindow) : null};"""

def BFSKIP(p):
    """real clicks A->B->C->T inside the frame; check user activation on top; then UI back x3 and forward x3, record where we land."""
    how = p.get('click', 'real')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    ua0 = yield ('js', UA, 'main')
    seq = []
    for nxt, lid in (('/p/B', 'lB'), ('/p/C', 'lC'), ('/p/B', 'lB')):
        if how == 'real':
            c = yield ('js', frame_link_center(lid), 'main')
            yield ('click', c['x'], c['y'], 50)
        else:
            yield ('js', "document.getElementById('margin-frame').contentDocument.getElementById(%r).click(); return 1;" % lid, 'main')
        ua = yield ('js', UA, 'main')
        r = yield ('waitfor', frame_at(nxt), 'main', 8000)
        yield ('sleep', 300)
        seq.append({'to': nxt, 'uaAfterClick': ua, 'ok': r['ok']})
    st = yield ('state',)
    yield ('emit', {'step': 'BFSKIP.forwardNavs', 'click': how, 'ua0': ua0, 'seq': seq, 'state': st})
    lands = []
    for i in range(3):
        yield ('back', 900)
        lands.append((yield ('js', "return location.pathname;", 'main')))
    for i in range(3):
        yield ('forward', 900)
        lands.append((yield ('js', "return location.pathname;", 'main')))
    yield ('emit', {'step': 'BFSKIP.backx3_fwdx3', 'expected': ['/p/C', '/p/B', '/p/A', '/p/B', '/p/C', '/p/B'], 'landed': lands})

def T5dbg(p):
    which = p.get('which', 'lRD')
    yield ('srv', '/__clear')
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    c = yield ('js', frame_link_center(which), 'main')
    yield ('click', c['x'], c['y'], 100)
    yield ('sleep', int(p.get('wait', 2000)))
    fr = yield ('js', """const f = document.getElementById('margin-frame'); let r = {};
      try { r.href = f.contentWindow.location.href; } catch (e) { r.hrefErr = String(e).slice(0, 120); }
      try { const d = f.contentDocument; r.cd = d ? {url: d.URL, title: d.title, body: d.body ? d.body.innerHTML.slice(0, 80) : null, origin: f.contentWindow.origin} : null; } catch (e) { r.cdErr = String(e).slice(0, 80); }
      return r;""", 'main')
    sh = yield ('js', "const M = window.__margin; return M ? M.log.slice(-10) : null;", 'shell')
    st = yield ('state',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'T5dbg.' + which, 'frame': fr, 'shellLogTail': sh, 'state': st, 'srv': srvlog_brief(log, ['/p/', '/r'])})

def DUMP(p):
    """load a URL with the shell, wait, dump shell log + frame state + server log."""
    url = p.get('url', A + '/p/A')
    yield ('srv', '/__clear')
    yield ('clear_events',)
    yield ('load', url)
    yield ('sleep', int(p.get('wait', 1500)))
    fr = yield ('js', """const f = document.getElementById('margin-frame'); if (!f) return {noFrame: true, href: location.href, title: document.title}; let r = {};
      try { r.href = f.contentWindow.location.href; } catch (e) { r.hrefErr = String(e).slice(0, 120); }
      try { const d = f.contentDocument; r.cd = d ? {url: d.URL, title: d.title, origin: f.contentWindow.origin, bodyDisplay: d.body ? f.contentWindow.getComputedStyle(d.body).display : null} : null; } catch (e) { r.cdErr = String(e).slice(0, 80); }
      return r;""", 'main')
    sh = yield ('js', "const M = window.__margin; return M ? M.log.slice(0, 30) : 'no shell';", 'shell')
    ev = yield ('events',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'DUMP', 'url': url, 'frame': fr, 'shellLog': sh, 'topLoadsStarted': load_count(ev), 'failed': ev['failed'][:5], 'srv': [e['path'][:60] + ' ' + str(e['dest']) for e in log][:30]})


def T9af(p):
    """autofocus input inside the framed page: does the shell's focus handoff keep it, and does typing reach it?"""
    url = A + '/p/A?af=1' + ('&__noshell=1' if p.get('base') == '1' else '')
    yield ('load', url)
    yield ('sleep', 1200)
    q = "const f = document.getElementById('margin-frame'); const d = f ? f.contentDocument : document; return {active: d.activeElement && (d.activeElement.id || d.activeElement.tagName), value: d.getElementById('inp').value, scrollY: (f ? f.contentWindow : window).scrollY};"
    a = yield ('js', q, 'main')
    yield ('key', 'a', 400)
    b = yield ('js', q, 'main')
    yield ('emit', {'step': 'T9af', 'base': p.get('base') == '1', 'afterLoad': a, 'afterTypingA': b})

def POSTIN(p):
    """a cross-site page POSTs a form to the site at top level (OAuth form_post / 3-D Secure return style)."""
    yield ('load', X + '/p/X?__noshell=1')
    yield ('sleep', 800)
    yield ('srv', '/__clear')
    yield ('js', "const f = document.createElement('form'); f.method = 'post'; f.action = %r; const i = document.createElement('input'); i.name = 'code'; i.value = 'secret-auth-code'; f.append(i); document.body.append(f); f.submit(); return 1;" % (A + '/p/POSTED'), 'main')
    yield ('sleep', 1500)
    st = yield ('state',)
    log = yield ('srv', '/__log')
    perf = yield ('js', "const n = performance.getEntriesByType('navigation')[0]; return {type: n && n.type, hasShell: !!document.getElementById('margin-frame')};", 'main')
    yield ('emit', {'step': 'POSTIN', 'state': {'uri': st['uri']}, 'top': perf, 'srv': [e['method'] + ' ' + e['path'][:40] + ' ' + str(e['dest']) for e in log if e['path'].startswith('/p/')]})

def POSTFRAME(p):
    """a same-origin POST form inside the frame: frame navigates (POST), shell syncs URL; then the user reloads the top."""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('srv', '/__clear')
    yield ('js', "document.getElementById('margin-frame').contentDocument.getElementById('fPost').submit(); return 1;", 'main')
    r = yield ('waitfor', frame_at('/p/POSTED'), 'main', 8000)
    st = yield ('state',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'POSTFRAME', 'ready': r['ok'], 'uri': st['uri'], 'srv': [e['method'] + ' ' + e['path'][:40] + ' ' + str(e['dest']) for e in log if e['path'].startswith('/p/')]})
    yield ('srv', '/__clear')
    yield ('reload',)
    yield ('sleep', 1500)
    st = yield ('state',)
    log = yield ('srv', '/__log')
    yield ('emit', {'step': 'POSTFRAME.reloadTop', 'uri': st['uri'], 'srv': [e['method'] + ' ' + e['path'][:40] + ' ' + str(e['dest']) for e in log if e['path'].startswith('/p/')]})


def PRINT(p):
    """Safari File > Print prints the TOP document. With the shell, what ends up in the PDF?"""
    import os, subprocess
    base = p.get('base') == '1'
    yield ('load', A + '/p/A' + ('?__noshell=1' if base else ''))
    yield ('sleep', 1500)
    out = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/p-webkit/out/print-%s%s.pdf' % ('noshell' if base else 'shell', ('-' + p['tag']) if p.get('tag') else '')
    if os.path.exists(out): os.remove(out)
    r = yield ('print', out)
    yield ('sleep', 500)
    info = subprocess.run(['pdfinfo', out], capture_output=True, text=True).stdout if os.path.exists(out) else 'missing'
    pages = [l for l in info.splitlines() if l.startswith('Pages')]
    txt = subprocess.run(['pdftotext', out, '-'], capture_output=True, text=True).stdout if os.path.exists(out) else ''
    yield ('emit', {'step': 'PRINT', 'base': base, 'result': r, 'pages': pages, 'hasNeedle': 'needle-A' in txt, 'hasSection2': 'section 2' in txt, 'text': txt[:300]})


def FS(p):
    """element fullscreen requested from inside the shell frame (video-player style)."""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    yield ('clear_events',)
    r = yield ('js', """const w = document.getElementById('margin-frame').contentWindow; const d = w.document; window.__fs = 'pending';
      const el = d.getElementById('content');
      try { el.requestFullscreen().then(() => window.__fs = {ok: true, fsEl: d.fullscreenElement && d.fullscreenElement.id, topFsEl: document.fullscreenElement && document.fullscreenElement.id}, (e) => window.__fs = 'rejected ' + e); } catch (e) { window.__fs = 'threw ' + e; }
      return {fullscreenEnabled: d.fullscreenEnabled, topFullscreenEnabled: document.fullscreenEnabled};""", 'main')
    yield ('sleep', 1500)
    r2 = yield ('js', "const w = document.getElementById('margin-frame').contentWindow; return {fs: window.__fs, frameInner: [w.innerWidth, w.innerHeight], topInner: [innerWidth, innerHeight]};", 'main')
    ev = yield ('events',)
    yield ('emit', {'step': 'FS', 'enabled': r, 'after': r2, 'gtkFullscreen': ev['fullscreen']})

def ISO(p):
    """isolated-world checks: page (main world) cannot see the shell's state; frame-side script (same isolated world, other frame) can."""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    m = yield ('js', "const f = document.getElementById('margin-frame'); return {topMainSeesShell: typeof window.__margin, frameMainSeesShell: typeof f.contentWindow.top.__margin, frameMainInlineRan: f.contentWindow.__inlineHead};", 'main')
    s = yield ('js', "return {shellWorldSeesShell: typeof window.__margin, frameSideRuns: window.__margin.frameSide, shellWorldSeesPageGlobals: typeof document.getElementById('margin-frame').contentWindow.__inlineHead};", 'shell')
    yield ('emit', {'step': 'ISO', 'mainWorld': m, 'shellWorld': s})

def BFSKIP2(p):
    """histMode top: which shell pushState entries does WebKit flag 'created by JS without user interaction'?
    pre=1 clicks a blank area of the frame first (activation before the first link click)."""
    yield ('load', A + '/p/A')
    yield ('waitfor', FRAME_READY, 'main', 8000)
    if p.get('pre') == '1':
        yield ('click', 600, 400, 300)
    for nxt, lid in (('/p/B', 'lB'), ('/p/C', 'lC'), ('/p/B', 'lB')):
        c = yield ('js', frame_link_center(lid), 'main')
        yield ('click', c['x'], c['y'], 50)
        yield ('waitfor', frame_at(nxt), 'main', 8000)
        yield ('sleep', 300)
    lands = []
    for i in range(3):
        yield ('back', 900)
        lands.append((yield ('js', "return location.pathname;", 'main')))
    for i in range(3):
        yield ('forward', 900)
        lands.append((yield ('js', "return location.pathname;", 'main')))
    yield ('emit', {'step': 'BFSKIP2', 'pre': p.get('pre'), 'expected': ['/p/C', '/p/B', '/p/A', '/p/B', '/p/C', '/p/B'], 'landed': lands})
