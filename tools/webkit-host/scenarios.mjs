// Scenarios for the WebKit host: steps it plays, and checks that must pass.
// `node scenarios.mjs <name>` prints one as JSON (run.sh does this).
//
// Steps (host.swift):
//   { op: 'open', name, url: '/p/A' | 'ext:<path>', active?, asleep?, selectedFirst? }  a tab (selectedFirst:
//                              in front before the extension hears it was made, as Safari's New Tab)
//   { op: 'install', sameId? } / { op: 'uninstall', keepWorld? }  Margin (sameId: as an update would;
//                              keepWorld: open pages keep Margin's content-script world, and the old
//                              copy's globals and `browser` in it, as Safari keeps them when it reloads Margin)
//   { op: 'sleep', name }      the tab's web view goes away (Safari unloading it)
//   { op: 'wait', ms }
//   { op: 'eval', in, js }     run JS in Margin's content-script world of a tab, log the result
//   { op: 'page', in, js }     the same in the page's own world
//   { op: 'check' | 'checkPage', in, js, label, timeout? }  wait until js returns true
//   { op: 'state' }            log which tab is shown, hidden or asleep
//   { op: 'snapshot', file }   PNG of the shown tab
//   { op: 'deny', pattern }    take a site permission away (as in Safari's settings)
//   { op: 'zoom', factor }     the shown tab's page zoom (as ⌘+ / ⌘−)
//   { op: 'pinch', deltas, x?, y? }  real magnify events for the shown tab's web view (x, y: in the
//                              window); the first delta is the Began's; logs its native magnification
//   { op: 'show', name }       Safari itself bringing a tab to the front (its tab bar)
//   { op: 'close', name, windowClosing? }  Safari closing a tab itself (its tab bar, ⌘W), or with
//                              its window (tabs.onRemoved's isWindowClosing; the window stays here)
//   { op: 'restart', late?, lateMs?, drop? }  a Safari relaunch (host.swift); `drop`: names of tabs
//                              Safari doesn't bring back
//   { op: 'flip', to, back }   one tab to the front and another back, in the same run loop turn
//   { op: 'probeShow', name, nth? }  count the web view's layers in each turn committed after
//                              the nth show of the tab from now on (empty: WebKit's empty view)
//   { op: 'checkProbe', name, maxMs, label }  that show had its content within maxMs
//   { op: 'showProbe', name }  show a tab and log the same, with how long the show took
//   { op: 'mouse', in, type: 'down' | 'drag' | 'up', at?, mods?, steps? }  a real press, drag or
//                              release of the mouse's main button; `at`: JavaScript (Margin's content
//                              world) returning [x, y] (the last point if left out); a drag moves there
//                              from the last point in `steps` moves (12) a frame apart; a drag and a
//                              release go where the press did
//   { op: 'stall', name, ms }  the tab's next activation by Margin (tabs.update) is carried out and
//                              answered only ms later (Safari's update of a tab whose process hangs)
//   { op: 'pid', name }        keep the tab's web content process id now (logged)
//   { op: 'pidGone', name, label, timeout? }  that process has exited (its memory given back)
//   { op: 'appStart' } / { op: 'appQuit' } / { op: 'appKill' } / { op: 'appPings' }  Margin.app's
//                              real end of the link (link-server/), started (native messaging
//                              goes to it), saying goodbye, killed; the copy's pings logged
//   { op: 'appMark' }          what the app's end says from now on is what appHeard looks at
//   { op: 'appHeard', label, has: [text], timeout?, none? }  a line the app's end said (link-server/:
//                              its `ev` lines, a push with its msg) has every text; none: no such line
//   { op: 'appReq', type, payload? | in, js }  a request from the app's UI for the copy's first window;
//                              `js` (Margin's world of tab `in`) returns its payload as JSON text
//   { op: 'deferLoads' }       from now on, a tab asleep loads only if it's still the one shown
//                              once the run loop turn is over (Safari putting its load off); its
//                              view is made as it's selected all the same (no page: a script there
//                              gets an error in place of a result, as in Safari)

// Margin's state from storage, by state key (shared/stored.js: the keys
// holding tab ids have names of their own there): an expression for steps.
const STATE = '(async (keys) => { const raw = await browser.storage.local.get(null); const open = raw.openTabs ?? {}; const of = (k) => (["tabs", "tabSpace", "activeSpaceByWindow", "keptTabs"].includes(k) ? open[k] ?? (k === "keptTabs" ? {} : undefined) : k === "lostTabs" ? raw.lostTabs2 : k === "openTabsBy" ? (raw.openTabs ? { origin: open.origin, synced: open.synced } : null) : raw[k]); return Object.fromEntries([].concat(keys).map((k) => [k, of(k)])); })';
// The id of the tab showing /p/<name>, from Margin's own tab snapshot.
const ID = 'const { tabs } = await ' + STATE + '("tabs"); const id = (n) => Object.values(tabs).find((t) => t.url.endsWith("/p/" + n))?.id;';
const switchTo = (from, to, options = {}) => ({ op: 'eval', in: from, js: `${ID} return JSON.stringify(await Margin.content.send("activateTab", { tabId: id("${to}"), ...${JSON.stringify(options)} }) ?? null)` });
// `js`: an expression, or statements ending in `return …`.
const body = (js) => (/\breturn\b/.test(js) ? js : `return ${js}`);
const check = (tab, label, js, timeout) => ({ op: 'check', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const checkPage = (tab, label, js, timeout) => ({ op: 'checkPage', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const wait = (ms) => ({ op: 'wait', ms });
// Margin's core runs in this page and has the state. It draws nothing there,
// linked to Margin.app or not (Margin 2 Phase 2 step 5: the app draws Margin's UI).
const ready = (tab) => check(tab, `${tab}: Margin runs here, with the state`, `!!Margin.content?.getState?.().state?.spaces?.length`, 5000);
// No element of Margin's in the page, and no frame painted on it (the first-paint placeholder off, or never there).
const NOTHING_DRAWN = `[...document.querySelectorAll('*')].every((el) => !el.localName.startsWith('margin-')) && getComputedStyle(document.documentElement, '::after').content === 'none'`;
const nothingDrawn = (tab, label = `${tab}: no element of Margin's in the page, no frame`) => checkPage(tab, label, NOTHING_DRAWN, 3000);
// Linked to Margin.app's real end of the link (the link server, started by appStart).
const linked = (tab) => check(tab, `${tab}: linked to Margin.app`, `Margin.content?.appDraws?.() === true`, 9000);
// The app's overlay measured the page slot again: its insets from the window's edges.
const layoutAt = (left, top = 8, right = 8, bottom = 8) => ({ op: 'appLayout', layout: [left, top, right, bottom] });
// Margin.app running, its page slot `left`/8/8/8 (Keep open: 260; the frame alone: 8).
const appWith = (left = 260) => ({ op: 'appStart', layout: [left, 8, 8, 8] });
const shown = (tab) => checkPage(tab, `${tab} is the tab shown`, `!document.hidden`);
// Keep open, as the app's layout says it (pages have no sidebar of their own to keep open).
const keepOpen = layoutAt(260);
// Nothing Margin did reached the page's own error listeners (a ResizeObserver
// loop error from a paint barrier, say: host.swift's page log).
const noPageErrors = (tab) => checkPage(tab, `${tab}: no error reached the page`, `!(window.__pageLog ?? []).some((l) => l.startsWith('uncaught'))`);
const reload = (tab) => ({ op: 'page', in: tab, js: 'location.reload(); return "reloading"' });
// In a page step: where <html> sits in the window, from the transform itself
// (the page's own getBoundingClientRect answers for the box).
const AT = "const m = new DOMMatrix(getComputedStyle(document.documentElement).transform); const at = { x: m.e, y: m.f, scale: m.a };";
// The page has its box at `left`, inside the frame.
const boxed = (tab, left = 260) => checkPage(tab, `${tab}: the page is in its box at ${left}`, `${AT} return at.x === ${left} && at.y === 8 && innerWidth === 1200 - ${left} - 8 && document.scrollingElement === document.body`, 5000);
// No box: the page as it is.
const bare = (tab) => checkPage(tab, `${tab}: no box, the page as it is`, `getComputedStyle(document.documentElement).transform === 'none' && document.scrollingElement === document.documentElement && innerWidth === 1200`, 3000);

const rect = (id) => `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`;
const near = (a, b, by = 2) => `Math.abs((${a}) - (${b})) <= ${by}`;
const openBox = (name, url) => [{ op: 'open', name, url, active: true }, boxed(name)];
// Margin.app linked with Keep open's layout (260/8/8/8), and a page in its box.
const startBoxed = (name, url, left = 260) => [appWith(left), { op: 'open', name, url, active: true }, wait(800), { op: 'install' }, linked(name), boxed(name, left)];
const tick = 'await new Promise((resolve) => setTimeout(resolve, 80));';
// A real key, no modifiers unless given (arrows: 125 down, 126 up, chars as AppKit's).
const key = (tab, keyCode, chars, mods = []) => ({ op: 'key', in: tab, keyCode, chars: String.fromCharCode(chars), mods });
const ARROW_DOWN = [125, 0xF701];
const ARROW_UP = [126, 0xF700];
const PAGE_DOWN = [121, 0xF72D];
const pressIn = (tab, at) => [{ op: 'mouse', in: tab, type: 'down', at: `return ${JSON.stringify(at)}` }, { op: 'mouse', in: tab, type: 'up' }];

// Sleeping tabs (background/sleep.js): a pass asked for now, for tabs unused
// for a millisecond (the setting is hours), and what it did.
const sleepNow = (tab, label = 'a pass of sleeping tabs') => ({ op: 'eval', in: tab, js: `return JSON.stringify(await Margin.content.send('sleepNow', { afterMs: 1 }))`, label });
// Back at its page, one history entry (no sleep page in its Back list), its content there.
const awakeAt = (tab, name, label) => checkPage(tab, `${tab}: ${label}`, `location.pathname === '/p/${name}' && history.length === 1 && document.title === '${name}' && !!document.body?.textContent.includes('${name}')`, 4000);

// Margin's tabs (Margin 2: state/model.js keptTabs). The kept (not open)
// Margin tab at /p/<name>, as statements in a check (`k` then).
const KEPT = (name) => `const k = Object.values((await ${STATE}('keptTabs')).keptTabs ?? {}).find((x) => x.url.endsWith('/p/${name}'));`;
// It clicked in the app's sidebar: the request its row sends (activateTab with its id: ui/actions.js).
const openKept = (tab, name) => ({ op: 'eval', in: tab, js: `${KEPT(name)} return JSON.stringify(await Margin.content.send('activateTab', { tabId: k.id }) ?? null)` });
// The open tab's Margin id at /p/<name>, kept in `tab`'s content world as __mid<name>.
const keepMid = (tab, name) => ({ op: 'eval', in: tab, js: `const { tabs } = await ${STATE}('tabs'); globalThis.__mid${name} = Object.values(tabs).find((t) => t.url.endsWith('/p/${name}'))?.mid; return globalThis.__mid${name} ?? 'none'` });
// The page server's address (run.sh's MARGIN_HOST_PORT), for addresses Margin's own pages carry.
import { firstReadKeys } from '../../extension/shared/stored.js';
const SERVER = `http://127.0.0.1:${process.env.MARGIN_HOST_PORT ?? 47811}`;
// Margin's sleep page as an earlier build left a tab on it (Safari closes sleeping tabs now, and
// the page is gone since Phase 3: its address opens nothing).
const OLD_SLEEP = (name) => `ext:sleep/sleep.html?${new URLSearchParams({ u: `${SERVER}/p/${name}`, t: name, k: `old-${name}` })}`;

export const SCENARIOS = {
  // Pages open at install get Margin (WebKit adds the core); switching
  // through Margin, including to a tab Safari unloaded. Nothing is drawn in
  // a page.
  switching: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(1000), { op: 'install' },
    ready('A'), ready('B'),
    switchTo('A', 'B'), shown('B'),
    switchTo('B', 'D'), shown('D'), ready('D'),
    switchTo('D', 'C'), shown('C'), nothingDrawn('C'), { op: 'state' },
  ],
  // Safari's update of the tab asked for answers only 4 s later (its process
  // hung, as in Tirth's Safari on 2026-11-03): the page that asked is
  // answered before it stops waiting (3 s here: the host's background lives
  // about 5 s), that the tab is shown (background/tabs.js focusTab), and the
  // tab comes up when Safari gets to it.
  stalled: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), ready('B'),
    { op: 'stall', name: 'B', ms: 4000 },
    { op: 'eval', in: 'A', js: `${ID} const asked = Date.now(); globalThis.__answer = null; Margin.content.send('activateTab', { tabId: id('B'), deadline: asked + 3000 }).then((r) => { __answer = { r: r ?? null, ms: Date.now() - asked }; }); return 'asked'` },
    check('A', 'A: answered before its 3 s deadline, that B is shown', `${ID} return !!__answer && __answer.ms < 3000 && __answer.r?.shown === id('B')`, 3500),
    { op: 'eval', in: 'A', js: 'return JSON.stringify(__answer)' },
    checkPage('B', 'B: shown once Safari got to it', '!document.hidden', 3000),
  ],
  // The plain switch (Margin 2 Phase 2 step 8), through Margin.app's real end
  // of the link: a click in the app's sidebar (activateTab) and the app's key
  // (navigate next-tab). The tab switched to comes into view once (no flip of
  // it forward and back first), the page left goes hidden once; each switch
  // is one line in Margin.app's log, its steps in order up to the delta out;
  // a key's switch tells the overlay it's switching, then that it's done.
  'plain-switch': [
    appWith(260), { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
    wait(800), { op: 'install' }, linked('A'), ready('B'), ready('C'),
    { op: 'page', in: 'B', js: "window.__seen = []; document.addEventListener('visibilitychange', () => __seen.push(document.visibilityState)); return 'counting'" },
    { op: 'page', in: 'A', js: "window.__seen = []; document.addEventListener('visibilitychange', () => __seen.push(document.visibilityState)); return 'counting'" },
    { op: 'appMark' },
    { op: 'appReq', type: 'activateTab', in: 'A', js: `${ID} return JSON.stringify({ tabId: id('B') })` },
    shown('B'),
    { op: 'appHeard', label: 'its answer: shown', has: ['"type":"activateTab"', '"ok":true'], timeout: 4000 },
    { op: 'appHeard', label: 'one line in the log: asked, the update and its answer, Safari\'s onActivated, the state stored, the delta out', has: ['extension log', '(activateTab', 'asked +0', 'tabs.update +', 'onActivated +', 'stored +', 'delta out +'], timeout: 5000 },
    { op: 'appHeard', label: 'one activation heard (no other tab brought forward and back)', has: ['activations heard'], none: true, timeout: 500 },
    checkPage('B', 'B came into view once, nothing before (no flip of it forward and back)', `JSON.stringify(__seen) === '["visible"]'`),
    checkPage('A', 'A went hidden once', `JSON.stringify(__seen) === '["hidden"]'`),
    { op: 'appMark' },
    { op: 'appReq', type: 'navigate', payload: { action: 'next-tab' } },
    { op: 'appHeard', label: 'a key\'s switch: the overlay told it\'s switching', has: ['"ev":"push"', '"type":"switching"'], timeout: 4000 },
    { op: 'appHeard', label: 'then that it\'s done', has: ['"ev":"push"', '"type":"switch-done"'], timeout: 4000 },
    { op: 'appHeard', label: 'and its line in the log', has: ['extension log', '(next-tab', 'delta out +'], timeout: 5000 },
    noPageErrors('B'),
  ],
  // Margin updated while a page with a typed draft is open: the new copy
  // takes over, the draft stays, nothing of either copy's in the page.
  update: [
    { op: 'open', name: 'F1', url: '/p/F1', active: true }, { op: 'open', name: 'A', url: '/p/A' },
    wait(800), { op: 'install', sameId: true }, ready('F1'),
    { op: 'page', in: 'F1', js: 'document.getElementById("t").value = "unsaved draft"; return "typed"' },
    { op: 'uninstall' }, wait(800), { op: 'install', sameId: true }, ready('F1'),
    { op: 'page', in: 'A', js: 'window.__marginBeforeSwitchOrigin = performance.timeOrigin; return __marginBeforeSwitchOrigin' },
    switchTo('F1', 'A'), shown('A'), wait(3200),
    checkPage('F1', 'F1: the draft is still there', `document.getElementById('t').value === 'unsaved draft'`),
    nothingDrawn('F1', 'F1: nothing of either copy\'s in the page'),
    shown('A'),
    checkPage('A', 'A: the selected tab stays selected beyond the stale copy timeout', `!document.hidden`),
    checkPage('A', 'A: selecting it cancels the hidden cleanup reload', `window.__marginBeforeSwitchOrigin === performance.timeOrigin`),
  ],
  // The app's layout with the frame alone (8 px all round): a box at the
  // frame's edge, with no iframe anywhere. Nothing at any edge (the frame
  // off): no box, and with nothing registered for that (no frame, no Keep
  // open), a page reloaded loads none of Margin's page scripts.
  'hidden-box': [
    appWith(8), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), boxed('A', 8),
    checkPage('A', 'A: no iframe, no attribute on html for it', `!document.querySelector('iframe') && !document.documentElement.hasAttribute('data-margin-left')`),
    checkPage('A', 'A: fixed things stay in the box', `const f = document.createElement('div'); f.style.cssText = 'position: fixed; left: 0; top: 0; width: 10px; height: 10px'; document.body.append(f); const r = f.getBoundingClientRect(); f.remove(); return r.left === 0 && r.top === 0`),
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { frameWhenHidden: false } }))' },
    layoutAt(0, 0, 0, 0),
    bare('A'),
    wait(300), reload('A'), ready('A'), wait(300), bare('A'),
    checkPage('A', 'A: reloaded with no box: the page\'s world has none of Margin in it', `!window[Symbol.for('margin.page')]`),
  ],
  // Margin.app's layout from the frame alone to Keep open: the box at the
  // sidebar's edge, live, on open pages and new ones; the scroll handed over;
  // a page opened before Margin gets its script injected.
  box: [
    appWith(8), { op: 'open', name: 'A', url: '/p/T', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install' }, linked('A'), boxed('A', 8),
    { op: 'page', in: 'A', js: `window.scrollTo(0, 300); window.__mq = matchMedia('(min-width: 1100px)'); window.__mqChanges = []; __mq.addEventListener('change', (e) => __mqChanges.push(e.matches)); window.__resized = 0; addEventListener('resize', () => __resized++); return String(scrollY)` },
    keepOpen, boxed('A'),
    checkPage('A', 'A: Keep open is live: the place kept', `scrollY === 300`),
    checkPage('A', 'A: a media list follows the box, and says so', `__mq.matches === false && JSON.stringify(__mqChanges) === '[false]' && __mq instanceof MediaQueryList`, 1000),
    checkPage('A', 'A: the page got one resize', `__resized === 1`, 1000),
    checkPage('A', 'A: a rule asks about the box', `getComputedStyle(document.getElementById('wide')).color === 'rgb(1, 2, 3)'`),
    checkPage('A', 'A: viewport units are the box\'s', `Math.round(document.getElementById('full').getBoundingClientRect().width) === innerWidth`),
    checkPage('A', 'A: two in one rule, both right (not twice one and never the other)', `const c = getComputedStyle(document.getElementById('bleed')); return c.marginLeft === c.marginRight`),
    checkPage('A', 'A: an inline height in vh too', `Math.round(document.getElementById('inline').getBoundingClientRect().height) === innerHeight`),
    checkPage('A', 'A: scroll APIs speak for body', `document.documentElement.scrollTop === 300 && document.documentElement.clientWidth === innerWidth`),
    { op: 'page', in: 'A', js: `window.__scrolls = 0; addEventListener('scroll', () => __scrolls++); document.body.scrollTop = 500; return 'scrolled'` },
    checkPage('A', 'A: a scroll of body reaches the window', `__scrolls > 0 && scrollY === 500`, 1000),
    switchTo('A', 'D'), shown('D'), boxed('D'), 
  ],
  // The app's layout changing on an open page, both ways (Keep open off with
  // no frame: nothing at any edge; on again), in the page's own measures.
  toggle: [
    ...startBoxed('A', '/p/T'),
    { op: 'page', in: 'A', js: `window.scrollTo(0, 200); return 'scrolled'` },
    layoutAt(0, 0, 0, 0),
    bare('A'),
    checkPage('A', 'A: off: the place kept, on <html> again', `document.documentElement.scrollTop === 200 && scrollY === 200`, 1500),
    checkPage('A', 'A: off: a rule about the window asks about it again', `getComputedStyle(document.getElementById('wide')).color !== 'rgb(1, 2, 3)' && Math.round(document.getElementById('full').getBoundingClientRect().width) === 1200`, 1500),
    keepOpen, boxed('A'),
    checkPage('A', 'A: on again: the place kept, on body', `document.body.scrollTop === 200`, 1500),
  ],
  // A page under a strict CSP: the box, the shims and the sheets all work.
  csp: [
    appWith(8), { op: 'open', name: 'A', url: '/csp/A', active: true }, wait(800), { op: 'install' }, linked('A'), boxed('A', 8), keepOpen, boxed('A'),
    wait(300), reload('A'), boxed('A'), 
    checkPage('A', 'A: its sheet rewritten (CSSOM passes a strict CSP)', `getComputedStyle(document.getElementById('wide')).color === 'rgb(1, 2, 3)'`, 2000),
  ],
  // The page's own scroll locks, read from computed style, and a modal in the box.
  lock: [
    appWith(8), { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' }, linked('A'), boxed('A', 8), keepOpen, boxed('A'),
    { op: 'page', in: 'A', js: `document.documentElement.classList.add('locked'); return 'locked on html'` },
    checkPage('A', 'A: html locked: body stops scrolling', `getComputedStyle(document.body).overflowY === 'hidden'`, 1000),
    { op: 'page', in: 'A', js: `document.documentElement.classList.remove('locked'); return 'unlocked'` },
    checkPage('A', 'A: unlocked: body scrolls', `getComputedStyle(document.body).overflowY === 'auto'`, 1000),
    { op: 'page', in: 'A', js: `document.body.classList.add('locked'); return 'locked on body'` },
    checkPage('A', 'A: body locked: its own rule wins', `getComputedStyle(document.body).overflowY === 'hidden'`, 1000),
    { op: 'page', in: 'A', js: `document.body.classList.remove('locked'); const d = document.createElement('dialog'); d.textContent = 'hello'; document.body.append(d); d.showModal(); window.__d = d; return 'modal'` },
    checkPage('A', 'A: a modal is centred on the box', `const r = window.__d.getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2`, 1000),
    { op: 'page', in: 'A', js: `const v = new CSSStyleSheet(); v.replaceSync('body { overflow: visible }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, v]; document.body.classList.add('open'); return 'visible'` },
    checkPage('A', 'A: a page\'s own overflow: visible on body: body still scrolls', `getComputedStyle(document.body).overflowY === 'auto'`, 1000),
    { op: 'page', in: 'A', js: `__d.close(); const a = document.createElement('div'); a.id = 'stray'; a.style.cssText = 'position: absolute; top: 2000px'; document.documentElement.append(a); return 'stray'` },
    checkPage('A', 'A: absolute under html moves to body, to scroll with the page', `document.getElementById('stray').parentNode === document.body`, 1000),
    ...openBox('R', '/x/rows'),
    { op: 'page', in: 'R', js: `scrollTo(0, 1000); window.__row = document.getElementById('row').getBoundingClientRect().top; document.body.style.position = 'fixed'; document.body.style.top = '-1000px'; document.body.style.width = '100%'; return String(__row)` },
    checkPage('R', 'R: body pinned at -1000: the row stays put, the page behind can\'t scroll', `const row = document.getElementById('row'); const r = row.getBoundingClientRect(); return ${near('r.top', '__row', 1)} && getComputedStyle(document.body).overflowY === 'hidden' && document.elementFromPoint(100, r.top + 5) === row`, 1000),
    { op: 'page', in: 'R', js: `document.body.removeAttribute('style'); scrollTo(0, 1000); return 'unlocked'` },
    checkPage('R', 'R: unpinned: where it was, and scrolling again', `scrollY === 1000 && getComputedStyle(document.body).overflowY === 'auto'`, 1000),
  ],
  // <body>'s own size in the box: a centred column, and a body that grows.
  'body-size': [
    ...startBoxed('C', '/x/center-max'),
    checkPage('C', 'C: max-width and auto margins kept', `const r = ${rect('h')}; return ${near('r[0]', '(innerWidth - 600) / 2')} && r[2] === 600 && document.scrollingElement === document.body`, 2000),
    ...openBox('W', '/x/center-width'),
    checkPage('W', 'W: width and auto margins kept, the top margin too', `const r = ${rect('h')}; return ${near('r[0]', '(innerWidth - 600) / 2')} && r[2] === 600 && ${near('r[1]', 40)}`, 2000),
    layoutAt(360),
    boxed('W', 360),
    checkPage('W', 'W: still centred after the sidebar\'s width changed', `const r = ${rect('h')}; return ${near('r[0]', '(innerWidth - 600) / 2')} && r[2] === 600`, 2000),
    { op: 'open', name: 'F', url: '/x/flex-column', active: true }, boxed('F', 360),
    checkPage('F', 'F: a flex column keeps its children\'s heights, and all of it scrolls', `const a = ${rect('a')}, f = ${rect('f')}; return a[3] === 800 && f[3] === 80 && document.documentElement.scrollHeight === 1680`, 2000),
    { op: 'open', name: 'O', url: '/x/flex-one', active: true }, boxed('O', 360),
    checkPage('O', 'O: flex: 1 on a clipped child too', `return ${rect('a')}[3] === 2000 && document.documentElement.scrollHeight === 2080`, 2000),
    { op: 'open', name: 'P', url: '/x/percent', active: true }, boxed('P', 360),
    checkPage('P', 'P: a percent height in a body that grows is auto: the footer comes after', `return ${rect('w')}[3] === 2500 && ${rect('f')}[1] === 2500`, 2000),
    { op: 'open', name: 'Q', url: '/x/app', active: true }, boxed('Q', 360),
    checkPage('Q', 'Q: an app that fills the window still does', `return ${rect('app')}[3] === innerHeight`, 2000),
  ],
  // An app whose reset comes after `load`: <body>'s default margin and auto
  // height mustn't stay what Margin read first.
  'late-body': [
    ...startBoxed('A', '/p/A'),
    { op: 'open', name: 'S', url: '/x/late-style', active: true }, boxed('S'),
    checkPage('S', 'S: a <style> after load: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[2] === innerWidth && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'L', url: '/x/late-link', active: true }, boxed('L'),
    checkPage('L', 'L: a <link> after load: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[2] === innerWidth && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'R', url: '/x/late-rule', active: true }, boxed('R'),
    checkPage('R', 'R: a rule a script inserts: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[2] === innerWidth && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'C', url: '/x/late-class', active: true }, boxed('C'),
    checkPage('C', 'C: a class on <body>: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[2] === innerWidth && r[3] === innerHeight`, 2000),
    // What only <body> itself shows, and edits that bring no new sheet.
    { op: 'open', name: 'H', url: '/x/body-has', active: true }, boxed('H'),
    checkPage('H', 'H: body:has(): the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'F', url: '/x/body-fit', active: true }, boxed('F'),
    checkPage('F', 'F: a width from its content stays that width, centred', `const r = ${rect('p')}; return r[2] === 600 && ${near('r[0]', '(innerWidth - 600) / 2')}`, 2000),
    { op: 'page', in: 'F', js: `document.head.append(Object.assign(document.createElement('style'), { textContent: '.nothing { color: red }' })); return 'styled'` },
    wait(400),
    checkPage('F', 'F: and after a late sheet', `const r = ${rect('p')}; return r[2] === 600 && ${near('r[0]', '(innerWidth - 600) / 2')}`, 500),
    { op: 'open', name: 'X', url: '/x/html-flex', active: true }, boxed('X'),
    checkPage('X', 'X: <html> a flex box: <body> still centred', `return ${near(`${rect('p')}[0]`, '(innerWidth - 500) / 2')}`, 2000),
    { op: 'open', name: 'M', url: '/x/body-has-moving', active: true }, boxed('M'),
    wait(300),
    { op: 'page', in: 'M', js: `document.head.append(Object.assign(document.createElement('style'), { textContent: 'body { padding-bottom: 3px }' })); return 'styled'` },
    wait(500),
    checkPage('M', 'M: read from <body> with a transition: still centred', `const r = ${rect('h')}; return r[2] === 600 && ${near('r[0]', '(innerWidth - 600) / 2')}`, 500),
    layoutAt(360),
    boxed('M', 360),
    checkPage('M', 'M: and in a new width', `const r = ${rect('h')}; return r[2] === 600 && ${near('r[0]', '(innerWidth - 600) / 2')}`, 2000),
    // A page that reacts to what it sees added doesn't set off reading for ever.
    { op: 'open', name: 'O', url: '/x/observer', active: true }, boxed('O', 360),
    wait(600),
    { op: 'page', in: 'O', js: `window.__bodies = 0; new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.localName === 'body') __bodies++; }).observe(document.documentElement, { childList: true }); return 'watching'` },
    wait(800),
    checkPage('O', 'O: nothing changed, nothing read', `__bodies === 0`, 200),
    // Reading again moves nothing on a page in use.
    { op: 'open', name: 'T', url: '/x/late-scrolled', active: true }, boxed('T', 360),
    { op: 'page', in: 'T', js: `document.getElementById('pane').scrollTop = 900; document.scrollingElement.scrollTo({ top: 3000, behavior: 'instant' }); ${tick} window.__scrolls = 0; addEventListener('scroll', () => __scrolls++, true); window.__moved = 0; addEventListener('transitionrun', () => __moved++); document.head.append(Object.assign(document.createElement('style'), { textContent: '.nothing { color: red }' })); return 'styled'` },
    wait(600),
    checkPage('T', 'T: a late sheet: both scrollers where they were, no scroll, no transition, one <body>', `document.scrollingElement.scrollTop === 3000 && document.getElementById('pane').scrollTop === 900 && __scrolls === 0 && __moved === 0 && document.querySelectorAll('body').length === 1 && getComputedStyle(document.body).paddingLeft === '40px'`, 500),
  ],
  // What only a read of <body> itself sees, what a read costs a page in use, and
  // how reads back off. Its own scenario: the background is gone 5 s in (README).
  'late-reads': [
    ...startBoxed('A', '/p/A'),
    { op: 'open', name: 'G', url: '/x/late-has', active: true }, boxed('G'),
    checkPage('G', 'G: body:has() in a late sheet: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'N', url: '/x/late-text', active: true }, boxed('N'),
    checkPage('N', 'N: a <style>\'s text node edited: the app fills the box', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'D', url: '/x/late-disabled', active: true }, boxed('D'),
    checkPage('D', 'D: sheet.disabled: the margin it held goes', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'Y', url: '/x/late-rule-style', active: true }, boxed('Y'),
    checkPage('Y', 'Y: rule.style edited: the margin it held goes', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    { op: 'open', name: 'E', url: '/x/late-selector', active: true }, boxed('E'),
    checkPage('E', 'E: rule.selectorText edited: it reaches <body>', `const r = ${rect('app')}; return r[0] === 0 && r[1] === 0 && r[3] === innerHeight`, 2000),
    // Lengths worked out with no layout.
    { op: 'open', name: 'U', url: '/x/calc-width', active: true }, boxed('U'),
    checkPage('U', 'U: calc() width centred, by arithmetic', `const r = ${rect('h')}; return ${near('r[0]', 50)} && ${near('r[2]', 'innerWidth - 100')}`, 2000),
    { op: 'open', name: 'I', url: '/x/percent-pad', active: true }, boxed('I'),
    checkPage('I', 'I: percent padding, of the box', `return ${near(`${rect('h')}[0]`, 'innerWidth * 0.05')}`, 2000),
    { op: 'open', name: 'J', url: '/x/rtl-width', active: true }, boxed('J'),
    checkPage('J', 'J: rtl: the width kept, at the right', `const r = ${rect('h')}; return r[2] === 600 && ${near('r[0]', 'innerWidth - 600')}`, 2000),
    { op: 'open', name: 'K', url: '/x/first-margin', active: true }, boxed('K'),
    checkPage('K', 'K: a first child\'s percent margin collapses with <body>\'s', `const top = ${rect('h')}[1]; const size = (innerWidth - 60) * 0.01; return ${near('top', 'Math.max(30, size)')}`, 2000),
    { op: 'open', name: 'Q', url: '/x/first-dialog', active: true }, boxed('Q'),
    { op: 'page', in: 'Q', js: `document.getElementById('d').showModal(); document.head.append(Object.assign(document.createElement('style'), { textContent: 'body { padding-bottom: 3px }' })); return 'open'` },
    wait(500),
    checkPage('Q', 'Q: a modal first child: its real backdrop left alone, what\'s read stays right', `const b = getComputedStyle(document.getElementById('d'), '::backdrop'); return b.marginTop === '0px' && getComputedStyle(document.body).paddingBottom === '33px' && ${near(`${rect('p')}[0]`, 30)}`, 500),
    // A transition already running goes on; a flex column's children don't start one.
    { op: 'open', name: 'V', url: '/x/moving', active: true }, boxed('V'),
    { op: 'page', in: 'V', js: `window.__cancelled = 0; addEventListener('transitioncancel', () => __cancelled++); document.body.classList.add('dark'); getComputedStyle(document.body).backgroundColor; document.head.append(Object.assign(document.createElement('style'), { textContent: 'html { outline: 0 }' })); return 'fading'` },
    wait(1300),
    checkPage('V', 'V: a read during <body>\'s transition doesn\'t cancel it', `__cancelled === 0 && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'`, 500),
    { op: 'open', name: 'W', url: '/x/column-moving', active: true }, boxed('W'),
    wait(700),
    { op: 'page', in: 'W', js: `window.__moved = 0; addEventListener('transitionrun', () => __moved++); document.head.append(Object.assign(document.createElement('style'), { textContent: 'html { outline: 0 }' })); return 'styled'` },
    wait(500),
    checkPage('W', 'W: children of a flex column stay still through a read', `__moved === 0`, 200),
    // Nothing is put in the page to read it, and a page that keeps poking gets fewer reads.
    { op: 'open', name: 'O', url: '/x/observer', active: true }, boxed('O'),
    wait(600),
    { op: 'page', in: 'O', js: `window.__bodies = 0; window.__records = 0; window.__flips = 0; window.__stayed = 0; new MutationObserver((records) => { if (document.querySelector('margin-read, margin-hold')) __stayed++; for (const r of records) { if (r.type === 'attributes' && r.attributeName !== 'data-seen') __records++; for (const n of r.addedNodes) { if (n.localName === 'body') __bodies++; if (n.localName === 'margin-read') __flips++; } } }).observe(document, { childList: true, subtree: true, attributes: true }); document.head.append(Object.assign(document.createElement('style'), { textContent: '.nothing { color: red }' })); return 'watching'` },
    wait(500),
    checkPage('O', 'O: a read: gone before any observer runs, and not one attribute written', `__flips >= 1 && __flips <= 2 && __stayed === 0 && !document.querySelector('margin-read, margin-hold') && __bodies === 0 && __records === 0`, 200),
    { op: 'page', in: 'O', js: `window.__late = document.head.appendChild(document.createElement('style')).sheet; return 'sheet'` },
    wait(1300),
    { op: 'page', in: 'O', js: `window.__flips = 0; for (let i = 0; i < 50; i++) __late.insertRule('.none' + i + ' { margin: 3px }'); return 'inserted'` },
    wait(500),
    checkPage('O', 'O: rules that reach neither <html>, <body> nor its first child: no read', `__flips === 0`, 200),
    { op: 'page', in: 'O', js: `window.__flips = 0; for (let i = 0; i < 5000; i++) __late.insertRule('.many' + i + ' { margin: 3px }'); return 'inserted'` },
    wait(400),
    checkPage('O', 'O: 5,000 rules at once are judged together: no read', `__flips === 0`, 200),
    { op: 'page', in: 'O', js: `window.__flips = 0; window.__poke = setInterval(() => document.body.classList.toggle('poked'), 50); return 'poking'` },
    wait(4000),
    checkPage('O', 'O: a class that comes and goes costs a read for each value, then none', `__flips <= 2`, 200),
    { op: 'page', in: 'O', js: `window.__poked = performance.now(); __late.insertRule('body.poked, body { margin: 21px }'); return 'changed'` },
    checkPage('O', 'O: a real change among them is read within the cap', `getComputedStyle(document.body).paddingLeft === '21px' && (window.__took ??= performance.now() - __poked) < 400`, 1500),
    { op: 'page', in: 'O', js: `clearInterval(__poke); return String(Math.round(__took)) + ' ms'` },
  ],
  // What a read has to get right and what it mustn't disturb, each thing a review
  // found. Its own scenario for the same reason as 'late-reads'.
  'read-limits': [
    ...startBoxed('A', '/p/A'),
    // A length on its way somewhere isn't what the page says.
    { op: 'open', name: 'D', url: '/x/read-drawer', active: true }, boxed('D'),
    { op: 'page', in: 'D', js: `window.__scrolled = 0; document.body.classList.add('open'); return 'opened'` },
    wait(1500),
    checkPage('D', 'D: a read during a transition of <body>\'s margin: all the way there', `const r = ${rect('h')}; return r[0] === 300 && ${near('r[2]', 'innerWidth - 300')}`, 2000),
    { op: 'page', in: 'D', js: `document.body.classList.remove('open'); return 'closed'` },
    wait(1500),
    checkPage('D', 'D: and all the way back', `return ${rect('h')}[0] === 0`, 2000),
    { op: 'page', in: 'D', js: `document.body.style.transition = 'margin .3s ease'; document.body.style.marginTop = '120px'; return 'inline'` },
    wait(1200),
    checkPage('D', 'D: an inline transition of the top margin too', `return ${rect('h')}[1] === 120`, 2000),
    // The first child's margin, and what can change it.
    { op: 'open', name: 'K', url: '/x/read-key', active: true }, boxed('K'),
    { op: 'page', in: 'K', js: `const s = document.head.appendChild(document.createElement('style')).sheet; s.insertRule('.e1 { margin-top: 40px }'); document.getElementById('a').className = 'e1'; return 'class'` },
    checkPage('K', 'K: a rule, then the first child takes its class in the same turn', `return ${rect('a')}[1] === 40`, 1500),
    { op: 'page', in: 'K', js: `const s = document.head.appendChild(document.createElement('style')).sheet; s.insertRule('.e2 { margin-top: 60px }'); document.body.prepend(Object.assign(document.createElement('div'), { className: 'e2', id: 'b', textContent: 'New' })); return 'prepended'` },
    checkPage('K', 'K: a rule, then a new first child', `return ${rect('b')}[1] === 60`, 1500),
    { op: 'page', in: 'K', js: `document.getElementById('b').className = ''; return 'gone'` },
    checkPage('K', 'K: a class off the first child, much later', `return ${rect('b')}[1] === 8`, 1500),
    { op: 'open', name: 'W', url: '/x/read-wrapper', active: true }, boxed('W'),
    checkPage('W', 'W: a margin collapses through a wrapper', `return ${rect('h')}[1] === 40`, 1500),
    { op: 'page', in: 'W', js: `document.getElementById('h').style.marginTop = '70px'; return 'down'` },
    checkPage('W', 'W: and is followed down there', `return ${rect('h')}[1] === 70`, 1500),
    { op: 'open', name: 'N', url: '/x/read-neg-child', active: true }, boxed('N'),
    checkPage('N', 'N: a negative child margin', `return ${rect('h')}[1] === 3`, 1500),
    { op: 'open', name: 'B', url: '/x/read-border-top', active: true }, boxed('B'),
    checkPage('B', 'B: a border stops the collapse', `return ${rect('h')}[1] === 30`, 1500),
    { op: 'open', name: 'F', url: '/x/read-flex', active: true }, boxed('F'),
    checkPage('F', 'F: so does a flex <body>', `return ${rect('h')}[1] === 28`, 1500),
    { op: 'open', name: 'S', url: '/x/read-abs-first', active: true }, boxed('S'),
    checkPage('S', 'S: an absolute first child takes no part', `return ${rect('h')}[1] === 8`, 1500),
    { op: 'open', name: 'G', url: '/x/read-neg-body', active: true }, boxed('G'),
    checkPage('G', 'G: a negative margin on <body> stays a margin', `return ${rect('h')}[0] === -20 && getComputedStyle(document.body).marginLeft === '-20px'`, 1500),
    // <body>'s own pixels.
    { op: 'open', name: 'Z', url: '/x/read-zoom-body', active: true }, boxed('Z'),
    checkPage('Z', 'Z: zoom on <body>: centred, inside the box', `const r = ${rect('h')}; return r[2] === 600 && ${near('r[0]', '(innerWidth - 600) / 2')}`, 1500),
    { op: 'open', name: 'H', url: '/x/read-zoom-html', active: true },
    checkPage('H', 'H: zoom on <html>: the box stays the box\'s size, centred in it', `const r = ${rect('h')}; return r[2] === 500 && ${near('r[0]', '(innerWidth - 500) / 2')}`, 1500),
    { op: 'open', name: 'X', url: '/x/read-border-box', active: true }, boxed('X'),
    checkPage('X', 'X: border-box with side borders: as wide as said, centred', `const r = ${rect('h')}; return r[2] === 450 && ${near('r[0] - 25', '(innerWidth - 500) / 2')}`, 1500),
    // The box moving, and what the page says about that.
    { op: 'open', name: 'Q', url: '/x/read-query', active: true }, boxed('Q'),
    checkPage('Q', 'Q: margins of a wide box', `return ${rect('h')}[0] === 40`, 1500),
    { op: 'page', in: 'Q', js: `document.dispatchEvent(new CustomEvent('margin:box', { detail: JSON.stringify({ left: 500, top: 8, right: 8, bottom: 8 }), cancelable: true })); return 'narrow'` },
    checkPage('Q', 'Q: a box move across a media query is read', `return innerWidth === 692 && ${rect('h')}[0] === 0`, 1500),
    { op: 'page', in: 'Q', js: `document.dispatchEvent(new CustomEvent('margin:box', { detail: 'off', cancelable: true })); document.dispatchEvent(new CustomEvent('margin:box', { detail: JSON.stringify({ left: 500, top: 8, right: 8, bottom: 8 }), cancelable: true })); return 'off and on'` },
    checkPage('Q', 'Q: and so is the box off and on', `return innerWidth === 692 && ${rect('h')}[0] === 0`, 1500),
    { op: 'open', name: 'V', url: '/x/read-vw', active: true }, boxed('V'),
    { op: 'page', in: 'V', js: `document.dispatchEvent(new CustomEvent('margin:box', { detail: JSON.stringify({ left: 500, top: 8, right: 8, bottom: 8 }), cancelable: true })); return 'narrow'` },
    checkPage('V', 'V: a margin in vw follows a box move', `return innerWidth === 692 && ${near(`${rect('h')}[0]`, 'innerWidth * 0.05')}`, 1500),
    // Ways of changing styles with no new sheet and no attribute.
    { op: 'open', name: 'E', url: '/x/read-sheets', active: true }, boxed('E'),
    ...[
      ['a <style>\'s disabled', `document.getElementById('m').disabled = true`, 8, `document.getElementById('m').disabled = false`],
      ['sheet.media.mediaText', `document.getElementById('m').sheet.media.mediaText = 'print'`, 8, `document.getElementById('m').sheet.media.mediaText = 'all'`],
      ['appendMedium and deleteMedium', `const l = document.getElementById('m').sheet.media; l.appendMedium('print'); l.deleteMedium('all')`, 8, `const l = document.getElementById('m').sheet.media; l.appendMedium('all'); l.deleteMedium('print')`],
      // Twice: WebKit drops the first set on a rule's map, with or without Margin.
      ['rule.styleMap', `const m = document.getElementById('l').sheet.cssRules[0].styleMap; m.set('margin-top', CSS.px(11)); m.set('margin-top', CSS.px(11))`, 18, `const m = document.getElementById('l').sheet.cssRules[0].styleMap; m.set('margin-top', CSS.px(40)); m.set('margin-top', CSS.px(40))`, 1, 47],
    ].flatMap(([what, change, gap, back, side = 0, before = 40]) => [
      { op: 'page', in: 'E', js: `${change}; return 'changed'` },
      checkPage('E', `E: ${what}`, `return ${rect('h')}[${side}] === ${gap}`, 1500),
      { op: 'page', in: 'E', js: `${back}; return 'back'` },
      checkPage('E', `E: ${what}, undone`, `return ${rect('h')}[${side}] === ${before}`, 1500),
    ]),
    { op: 'page', in: 'E', js: `document.getElementById('q').sheet.cssRules[0].media.mediaText = 'print'; return 'rule'` },
    checkPage('E', 'E: a @media rule\'s mediaText', `return getComputedStyle(document.body).paddingTop === '40px'`, 1500),
    { op: 'page', in: 'E', js: `window.__built = new CSSStyleSheet(); __built.replaceSync('body { margin: 0 }'); document.adoptedStyleSheets.push(__built); return 'pushed'` },
    checkPage('E', 'E: a sheet built earlier, pushed on adoptedStyleSheets', `return ${rect('h')}[0] === 0`, 1500),
    { op: 'page', in: 'E', js: `document.adoptedStyleSheets.splice(document.adoptedStyleSheets.indexOf(__built), 1); return document.adoptedStyleSheets.length` },
    checkPage('E', 'E: and taken off with splice', `return ${rect('h')}[0] === 40`, 1500),
    checkPage('E', 'E: Margin\'s own sheets are still last', `const list = document.adoptedStyleSheets; return list.length >= 6 && !list.includes(__built) && Array.isArray(list)`, 500),
    { op: 'page', in: 'E', js: `document.head.append(Object.assign(document.createElement('style'), { textContent: '@import url("data:text/css,body%20%7B%20margin-left%3A%2023px%20!important%20%7D");' })); return 'import'` },
    checkPage('E', 'E: a late <style> whose @import arrives after it', `return ${rect('h')}[0] === 23`, 2000),
    // :has() turning true with no change to any sheet or to <html> and <body>.
    { op: 'open', name: 'R', url: '/x/read-has', active: true }, boxed('R'),
    wait(500),
    { op: 'page', in: 'R', js: `window.__before = __reads; document.getElementById('x').className = 'on'; return 'class'` },
    checkPage('R', 'R: body:has() turns true by a class on a descendant', `return ${rect('h')}[0] === 33`, 1500),
    { op: 'page', in: 'R', js: `document.getElementById('x').remove(); return 'removed'` },
    checkPage('R', 'R: and false by a node going', `return ${rect('h')}[0] === 8`, 1500),
    { op: 'page', in: 'R', js: `window.__before = __reads; for (let i = 0; i < 20; i++) document.body.append(document.createElement('p')); document.body.style.setProperty('--n', '1'); return 'nodes'` },
    wait(500),
    checkPage('R', 'R: nodes that change no answer are no reason to read', `__reads - __before <= 1`, 200),
    { op: 'page', in: 'R', js: `const s = document.head.appendChild(document.createElement('style')).sheet; s.insertRule('body:has(.late-on) { margin: 19px }'); document.body.append(Object.assign(document.createElement('i'), { className: 'late-on' })); return 'both'` },
    checkPage('R', 'R: a late :has() rule and its match in one turn', `return ${rect('h')}[0] === 19`, 1500),
    // Nothing a read does shows on a page in use.
    { op: 'open', name: 'C', url: '/x/read-container', active: true }, boxed('C'),
    { op: 'page', in: 'C', js: `document.body.scrollTop = 3000; return 'scrolled'` },
    wait(200),
    { op: 'page', in: 'C', js: `window.__scrolls = 0; document.body.addEventListener('scroll', () => __scrolls++); document.head.append(Object.assign(document.createElement('style'), { textContent: '.late { color: red }' })); return 'watching'` },
    wait(600),
    { op: 'page', in: 'C', js: `document.body.classList.add('x'); document.head.append(Object.assign(document.createElement('style'), { textContent: '.later { color: red }' })); return 'again'` },
    wait(600),
    checkPage('C', 'C: a size container under <body>: its scroll stays through reads', `return document.body.scrollTop === 3000 && __scrolls === 0`, 500),
    { op: 'open', name: 'T', url: '/x/read-strong', active: true },
    wait(800),
    { op: 'page', in: 'T', js: `window.__moved = 0; for (const name of ['transitionrun', 'transitioncancel']) addEventListener(name, () => __moved++, true); document.documentElement.dataset.x = '1'; return 'poked'` },
    wait(700),
    checkPage('T', 'T: <body> stays still against a stronger rule, its pseudo-elements with it', `__moved === 0`, 200),
    { op: 'open', name: 'L', url: '/x/read-dialog', active: true }, boxed('L'),
    { op: 'page', in: 'L', js: `const d = document.getElementById('d'); d.showModal(); return 'open'` },
    wait(200),
    { op: 'page', in: 'L', js: `const d = document.getElementById('d'); d.close(); window.__closing = getComputedStyle(d, '::backdrop').marginTop; return __closing` },
    checkPage('L', 'L: the backdrop of a first child closing stays out of a read', `__closing === '0px'`, 200),
    { op: 'open', name: 'M', url: '/x/read-fit-smooth', active: true }, boxed('M'),
    { op: 'page', in: 'M', js: `document.body.scrollTo({ top: 1500, behavior: 'smooth' }); setTimeout(() => dispatchEvent(new Event('load')), 120); return 'smooth'` },
    checkPage('M', 'M: a page that needs a layout: a smooth scroll isn\'t cut short', `document.body.scrollTop === 1500`, 3000),
    { op: 'open', name: 'P', url: '/x/read-echo', active: true }, boxed('P'),
    wait(500),
    { op: 'page', in: 'P', js: `document.documentElement.classList.add('poke'); return 'poked'` },
    wait(400),
    { op: 'page', in: 'P', js: `window.__before = __reads; window.__sync = document.documentElement.dataset.sync; return 'watching'` },
    wait(3000),
    checkPage('P', 'P: an observer that writes back doesn\'t keep reads running', `__reads === __before && document.documentElement.dataset.sync === __sync`, 200),
    // And a page that does nothing pays for one look at it.
    { op: 'open', name: 'I', url: '/x/read-idle', active: true }, boxed('I'),
    wait(800),
    { op: 'page', in: 'I', js: `return String(__reads) + ' reads, top ' + ${rect('h')}[1]` },
    checkPage('I', 'I: a page that says nothing new at load: a read at most for each thing that came', `return ${rect("h")}[1] === 12 && __reads <= 4`, 200),
  ],
  // What a page finds in its own document, and what it can do to it: Margin has
  // no element there outside a read, and follows a new <html>.
  'read-shape': [
    ...startBoxed('A', '/p/A'),
    { op: 'open', name: 'N', url: '/x/shape-nth', active: true }, boxed('N'),
    { op: 'page', in: 'N', js: `const at = [...document.documentElement.children].indexOf(document.body) + 1; document.head.append(Object.assign(document.createElement('style'), { textContent: 'html > body:nth-child(' + at + ') { margin-left: 70px } html > :nth-child(' + (at - 1) + ') + body { margin-right: 30px }' })); return 'said, by where <body> is'` },
    checkPage('N', 'N: `:nth-child` on <html>\'s children holds, through every read', `const r = ${rect('h')}; return r[0] === 70 && ${near('r[2]', 'innerWidth - 100')}`, 2000),
    { op: 'open', name: 'H', url: '/x/shape-html', active: true }, boxed('H'),
    checkPage('H', 'H: nothing of Margin\'s in <html> as a script in <body> runs, or after', `!__parsed.includes('margin-read') && !__parsed.includes('margin-hold') && !document.querySelector('margin-read, margin-hold')`, 200),
    checkPage('H', 'H: the document serializes as the page wrote it', `!document.documentElement.outerHTML.includes('margin-read') `, 200),
    { op: 'page', in: 'H', js: `window.__second = document.documentElement.appendChild(document.createElement('body')); return 'second'` },
    wait(100),
    checkPage('H', 'H: a stray second <body> takes nothing from the first', `document.body.getBoundingClientRect().width === innerWidth && getComputedStyle(document.body).boxSizing === 'border-box'`, 500),
    { op: 'page', in: 'H', js: `__second.remove(); const n = document.createElement('html'); n.innerHTML = document.documentElement.innerHTML; document.replaceChild(n, document.documentElement); return 'replaced'` },
    checkPage('H', 'H: a new <html>: <body> still fills the box, its column kept', `const r = ${rect('h')}; return document.body.getBoundingClientRect().width === innerWidth && getComputedStyle(document.body).boxSizing === 'border-box' && r[2] === 700 && ${near('r[0]', '(innerWidth - 700) / 2')}`, 2000),
    { op: 'page', in: 'H', js: `document.head.append(Object.assign(document.createElement('style'), { textContent: 'html body { max-width: 500px }' })); return 'late'` },
    checkPage('H', 'H: and what comes after it is read', `return ${rect('h')}[2] === 500`, 3000),
    { op: 'page', in: 'H', js: `document.documentElement.append(Object.assign(document.createElement('style'), { textContent: 'html.w body { max-width: 300px }' })); document.documentElement.className = 'w'; return 'class'` },
    checkPage('H', 'H: a class on the new <html> is read', `return ${rect('h')}[2] === 300`, 3000),
    { op: 'open', name: 'W', url: '/x/shape-html', active: true }, boxed('W'),
    { op: 'page', in: 'W', js: `const page = document.documentElement.outerHTML; document.open(); document.write(page); document.close(); return 'written'` },
    checkPage('W', 'W: `document.write` of a whole page: the same', `const r = ${rect('h')}; return document.body.getBoundingClientRect().width === innerWidth && r[2] === 700 && ${near('r[0]', '(innerWidth - 700) / 2')}`, 2000),
    // `zoom` on <html> from a class, read once and then known.
    { op: 'open', name: 'Z', url: '/x/shape-zoom', active: true }, boxed('Z'),
    ...[1, 2, 3, 4].flatMap((n) => [
      { op: 'page', in: 'Z', js: `document.documentElement.classList.toggle('z'); return 'toggled'` },
      wait(1300),
      checkPage('Z', `Z: toggle ${n}: the box's own width, the page's zoom in it`, `const r = ${rect('h')}; return ${n % 2 ? 'r[0] === 30 && r[2] === innerWidth - 60' : 'r[0] === 20 && r[2] === innerWidth - 40'}`, 1000),
    ]),
    // First children: what stands in the way, and what's stepped over.
    { op: 'open', name: 'T', url: '/x/shape-text', active: true }, boxed('T'),
    checkPage('T', 'T: text before a nested child: its margin doesn\'t reach <body>\'s', `return ${rect('h')}[1] === 66`, 2000),
    { op: 'open', name: 'C', url: '/x/shape-contain', active: true }, boxed('C'),
    checkPage('C', 'C: a first child with layout containment keeps its margin', `return ${rect('h')}[1] === 48`, 2000),
    { op: 'open', name: 'U', url: '/x/shape-unhide', active: true }, boxed('U'),
    checkPage('U', 'U: a hidden first child is stepped over', `return ${rect('h')}[1] === 8`, 2000),
    { op: 'page', in: 'U', js: `document.getElementById('b').hidden = false; return 'shown'` },
    checkPage('U', 'U: shown, its margin is what collapses with <body>\'s', `return ${rect('b')}[1] === 40`, 2000),
    { op: 'open', name: 'S', url: '/x/shape-script', active: true }, boxed('S'),
    wait(800),
    { op: 'page', in: 'S', js: `window.__before = __frames; for (let i = 0; i < 60; i++) { await new Promise((go) => setTimeout(go, 10)); const li = document.createElement('li'); document.getElementById('l').append(li); li.remove(); } return 'churned'` },
    wait(100),
    checkPage('S', 'S: nodes far from a <script> first in <body>: no look at the first children', `__frames - __before <= 2`, 200),
    // Lengths that move by a route of their own.
    { op: 'open', name: 'M', url: '/x/shape-moving', active: true }, boxed('M'),
    { op: 'page', in: 'M', js: `document.getElementById('h').classList.add('o'); return 'moving'` },
    wait(1500),
    checkPage('M', 'M: a first child\'s margin in transition: read as it ends', `return ${rect('h')}[1] === 60`, 2000),
    { op: 'open', name: 'E', url: '/x/shape-em', active: true }, boxed('E'),
    { op: 'page', in: 'E', js: `document.body.classList.add('o'); return 'moving'` },
    wait(1500),
    checkPage('E', 'E: <body>\'s margin in em, its font size in transition', `const r = ${rect('h')}; return r[0] === 40 && r[1] === 40`, 2000),
    { op: 'open', name: 'G', url: '/x/shape-var', active: true }, boxed('G'),
    { op: 'page', in: 'G', js: `document.body.classList.add('o'); return 'moving'` },
    wait(1500),
    checkPage('G', 'G: a margin through a registered variable in transition', `return ${rect('h')}[0] === 90`, 2000),
    // Edits by the older routes.
    { op: 'open', name: 'R', url: '/x/shape-rules', active: true }, boxed('R'),
    { op: 'page', in: 'R', js: `document.getElementById('s').sheet.addRule('body:has(.one)', 'margin-left: 33px'); return 'added'` },
    wait(500),
    { op: 'page', in: 'R', js: `document.getElementById('h').className = 'one'; return 'class'` },
    checkPage('R', 'R: `:has()` through addRule turns true', `return ${rect('h')}[0] === 33`, 3000),
    { op: 'page', in: 'R', js: `document.getElementById('h').className = ''; document.getElementById('s').sheet.cssRules[0].selectorText = 'body:has(.two)'; return 'selector'` },
    wait(1200),
    { op: 'page', in: 'R', js: `document.getElementById('h').className = 'two'; return 'class'` },
    checkPage('R', 'R: and through selectorText', `return ${rect('h')}[0] === 44`, 3000),
    checkPage('R', 'R: appendMedium and deleteMedium with no argument throw, as a browser\'s do', `const { media } = document.getElementById('s').sheet; const threw = (name) => { try { media[name](); return false; } catch (e) { return e instanceof TypeError; } }; return threw('appendMedium') && threw('deleteMedium') && MediaList.prototype.appendMedium.length === 1 && MediaList.prototype.appendMedium.name === 'appendMedium'`, 200),
  ],
  // What a page asks about what's in view, with no root of its own.
  'in-view': [
    ...startBoxed('V', '/x/views'),
    { op: 'page', in: 'V', js: `window.__seen = {}; window.__calls = {}; window.__io = new IntersectionObserver((entries) => { for (const e of entries) { const id = e.target.id || e.target.localName; __calls[id] = (__calls[id] ?? 0) + 1; __seen[id] = { in: e.isIntersecting, left: e.boundingClientRect.left, root: e.rootBounds?.width }; } }, { rootMargin: '200px' }); for (const t of [inside, near, far, document.body]) __io.observe(t); return 'observing'` },
    checkPage('V', 'V: what\'s fixed, the page and <body> are in view; near comes in through the margin; far doesn\'t', `__seen.inside?.in && __seen.body?.in && __seen.near?.in && __seen.far && !__seen.far.in`, 2000),
    checkPage('V', 'V: entries in the page\'s coordinates, the root the box, one answer each', `__seen.inside.left === document.getElementById('inside').getBoundingClientRect().left && __seen.near.root === innerWidth + 400 && __calls.near === 1 && __calls.inside === 1`, 1000),
    checkPage('V', 'V: still an IntersectionObserver, as the page made it', `__io instanceof IntersectionObserver && __io.root === null && __io.rootMargin.startsWith('200px') && new IntersectionObserver(() => {}, { root: document.body }).root === document.body`, 1000),
    { op: 'page', in: 'V', js: `document.getElementById('far').scrollIntoView(); return 'to the end'` },
    checkPage('V', 'V: far comes in by scrolling', `__seen.far.in`, 2000),
    { op: 'page', in: 'V', js: `scrollTo(0, 0); return 'back'` },
    checkPage('V', 'V: and goes again', `!__seen.far.in`, 2000),
    { op: 'page', in: 'V', js: `document.dispatchEvent(new CustomEvent('margin:box', { detail: 'off', cancelable: true })); return 'off'` },
    wait(300),
    checkPage('V', 'V: the box off, what\'s below the fold stays out of view: no runaway infinite scroll', `!__seen.far.in`, 500),
    { op: 'page', in: 'V', js: `document.dispatchEvent(new CustomEvent('margin:box', { detail: JSON.stringify({ left: 260, top: 8, right: 8, bottom: 8 }), cancelable: true })); const fresh = document.createElement('body'); fresh.className = 'swapped'; fresh.innerHTML = '<div style="height: 3000px"></div><div id=late>late</div>'; window.__late = fresh.querySelector('#late'); __io.observe(__late); document.documentElement.replaceChild(fresh, document.body); return 'swapped'` },
    checkPage('V', 'V: a body swapped in is tracked: it scrolls, and observers follow it', `getComputedStyle(document.body).overflowY === 'auto' && (__late.scrollIntoView(), __seen.late?.in === true)`, 2000),
  ],
  // What a window's root reports and does, by the box's body.
  answers: [
    ...startBoxed('T', '/p/T'),
    checkPage('T', 'T: <body> and <html> report the page\'s height; <html>\'s client height the viewport\'s', `const h = document.body.scrollHeight; return h > 3000 && document.body.offsetHeight === h && document.documentElement.offsetHeight === h && document.body.clientHeight === h && document.documentElement.clientHeight === innerHeight`, 1000),
    checkPage('T', 'T: caret points in the page\'s coordinates, both APIs', `const r = document.getElementById('wide').getBoundingClientRect(); const x = r.left + 10, y = r.top + 10; const text = document.getElementById('wide').firstChild; const p = document.caretPositionFromPoint(x, y); return document.caretRangeFromPoint(x, y).startContainer === text && p.offsetNode === text && Math.abs(p.getClientRect().top - r.top) < r.height`, 1000),
    { op: 'page', in: 'T', js: `const e = document.createElement('div'); e.id = 'late'; document.body.append(e); ${tick} e.style.height = '100vh'; e.style.setProperty('width', '50vw'); return 'set'` },
    checkPage('T', 'T: vw and vh a script sets on an element are the box\'s', `const r = document.getElementById('late').getBoundingClientRect(); return ${near('r.width', 'innerWidth / 2', 1)} && ${near('r.height', 'innerHeight', 1)}`, 500),
    { op: 'page', in: 'T', js: `document.getElementById('late').setAttribute('style', 'height: 100vh; width: 100vw'); return 'set'` },
    checkPage('T', 'T: by setAttribute too', `return ${near(`${rect('late')}[2]`, 'innerWidth', 1)}`, 500),
  ],
  // Paging keys and an inner pane; the pressed pane keeps them.
  keys: [
    ...startBoxed('T', '/p/T'),
    key('T', 125, 0xF701, ['command']),
    checkPage('T', 'T: ⌘↓ with nothing pressed goes to the end', `scrollY > 2000`, 2000),
    key('T', 126, 0xF700, ['command']),
    checkPage('T', 'T: ⌘↑ goes back', `scrollY === 0`, 2000),
    key('T', 125, 0xF701, ['option']),
    checkPage('T', 'T: ⌥↓ pages', `scrollY > 500`, 2000),
    { op: 'page', in: 'T', js: `scrollTo(0, 0); return 'top'` },
    { op: 'open', name: 'P', url: '/x/pane', active: true }, boxed('P'),
    ...pressIn('P', [500, 300]),
    key('P', ...PAGE_DOWN),
    checkPage('P', 'P: Page Down moves the pane that was pressed', `document.getElementById('app').scrollTop > 300`, 2000),
    { op: 'page', in: 'P', js: `const s = getSelection(); s.selectAllChildren(document.getElementById('line')); s.collapseToStart(); s.extend(document.getElementById('line').firstChild, 3); return s.toString()` },
    { op: 'page', in: 'P', js: `window.__prevented = 0; addEventListener('keydown', (e) => { if (e.defaultPrevented) __prevented++; }); return 'watching'` },
    key('P', 125, 0xF701, ['shift']),
    checkPage('P', 'P: Shift and an arrow is the selection\'s', `__prevented === 0`, 500),
  ],
  // The place across same-document Back and Forward.
  history: [
    ...startBoxed('T', '/p/T'),
    { op: 'page', in: 'T', js: `scrollTo(0, 1500); ${tick} history.pushState({}, '', '/p/T2'); scrollTo(0, 0); ${tick} history.back(); return 'back'` },
    checkPage('T', 'T: Back returns to the place', `location.pathname === '/p/T' && scrollY === 1500`, 2000),
    { op: 'page', in: 'T', js: `${tick} scrollTo(0, 200); ${tick} history.forward(); return 'forward'` },
    checkPage('T', 'T: Forward to its own', `location.pathname === '/p/T2' && scrollY === 0`, 2000),
    { op: 'page', in: 'T', js: `${tick} history.back(); ${tick} ${tick} scrollTo(0, 800); location.hash = '#wide'; return 'hash'` },
    wait(200),
    { op: 'page', in: 'T', js: `history.back(); return 'back'` },
    checkPage('T', 'T: Back from a fragment too', `!location.hash && scrollY === 800`, 2000),
    { op: 'page', in: 'T', js: `history.scrollRestoration = 'manual'; history.pushState({}, '', '/p/T3'); scrollTo(0, 0); ${tick} history.back(); return 'manual'` },
    wait(300),
    checkPage('T', 'T: a page that keeps its own place keeps it', `scrollY === 0`, 500),
  ],
  // Dialogs and popovers, placed against the box.
  'top-layer': [
    ...startBoxed('L', '/x/top'),
    { op: 'page', in: 'L', js: `plain.showModal(); return 'plain'` },
    checkPage('L', 'L: a plain dialog is centred on the box', `const r = plain.getBoundingClientRect(); return ${near('r.left + r.width / 2', 'innerWidth / 2')} && ${near('r.top + r.height / 2', 'innerHeight / 2')}`, 1000),
    { op: 'page', in: 'L', js: `plain.close(); corner.showModal(); return 'corner'` },
    checkPage('L', 'L: a corner dialog keeps its corner of the box', `const r = corner.getBoundingClientRect(); return ${near('innerWidth - r.right', 20)} && ${near('r.top', 100)}`, 1000),
    { op: 'page', in: 'L', js: `corner.close(); drawer.showModal(); return 'drawer'` },
    checkPage('L', 'L: a left drawer starts at the box\'s edge, not under the sidebar', `${near('drawer.getBoundingClientRect().left', 0)}`, 1000),
    { op: 'page', in: 'L', js: `drawer.close(); centred.showPopover(); return 'centred'` },
    checkPage('L', 'L: a popover centred with its own translate stays centred', `const r = centred.getBoundingClientRect(); return ${near('r.left + r.width / 2', 'innerWidth / 2')} && ${near('r.top + r.height / 2', 'innerHeight / 2')}`, 1000),
    { op: 'page', in: 'L', js: `centred.hidePopover(); placed.showPopover(); placed.style.left = '100px'; placed.style.top = '50px'; return 'placed'` },
    checkPage('L', 'L: a popover a script places lands where it says', `const r = placed.getBoundingClientRect(); return ${near('r.left', 100)} && ${near('r.top', 50)}`, 1000),
    { op: 'page', in: 'L', js: `placed.hidePopover(); return 'closed'` },
    checkPage('L', 'L: closed: its style as it was', `!placed.style.translate`, 1000),
  ],
  // A sheet of another origin with no CORS: fetched, tied to its link.
  'linked-sheet': [
    ...startBoxed('X', '/x/linked'),
    checkPage('X', 'X: the fetched copy applies, for the box', `getComputedStyle(document.getElementById('w')).color === 'rgb(1, 2, 3)' && document.querySelectorAll('style').length === 1`, 3000),
    { op: 'page', in: 'X', js: `l.disabled = true; return 'disabled'` },
    checkPage('X', 'X: the page turning the link off turns the copy off', `getComputedStyle(document.getElementById('w')).color !== 'rgb(1, 2, 3)'`, 1000),
    { op: 'page', in: 'X', js: `l.disabled = false; return 'enabled'` },
    checkPage('X', 'X: and on', `getComputedStyle(document.getElementById('w')).color === 'rgb(1, 2, 3)'`, 1000),
    { op: 'page', in: 'X', js: `l.remove(); return 'removed'` },
    checkPage('X', 'X: the link gone, its copy goes', `document.querySelectorAll('style').length === 0 && getComputedStyle(document.getElementById('w')).color !== 'rgb(1, 2, 3)'`, 1000),
  ],
  // Page zoom (⌘+): the page's box follows the app's layout in the page's
  // zoomed pixels; a page reloaded zoomed has it at its size from the site's
  // zoom Margin remembers.
  zoom: [
    ...startBoxed('A', '/p/A'),
    { op: 'zoom', factor: 1.5 },
    checkPage('A', 'at 150%: the box at 260/1.5, 8/1.5', `${AT} return Math.abs(at.x - 260 / 1.5) < 0.5 && Math.abs(at.y - 8 / 1.5) < 0.5`, 3000),
    { op: 'zoom', factor: 0.75 },
    checkPage('A', 'at 75%: at 260/0.75', `${AT} return Math.abs(at.x - 260 / 0.75) < 0.5`, 3000),
    { op: 'zoom', factor: 1 },
    checkPage('A', 'back to 100%: at 260', `${AT} return at.x === 260 && at.y === 8`, 3000),
    { op: 'zoom', factor: 1.5 }, wait(300),
    reload('A'), ready('A'),
    checkPage('A', 'reloaded at 150%: at 260/1.5', `${AT} return Math.abs(at.x - 260 / 1.5) < 0.5`, 3000),
  ],
  // Tab ids: the same while a tab sleeps and wakes or reloads; all new when
  // Margin is updated (a new copy). Tabs keep their spaces either way
  // (state/model.js syncTabs matches them by address).
  tabids: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, ready('A'), wait(1500),
    { op: 'eval', in: 'A', js: `${ID} const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('B'), spaceId: work }); return 'B moved to Work'` }, wait(500),
    { op: 'eval', in: 'A', js: `${ID} globalThis.__ids = [id('A'), id('B')]; return 'ids ' + __ids` },
    { op: 'sleep', name: 'B' }, wait(500), switchTo('A', 'B'), wait(1500), reload('B'), wait(1500),
    check('A', 'B: the same id after sleeping, waking and a reload (A too)', `${ID} return id('A') === __ids[0] && id('B') === __ids[1]`, 3000),
    check('B', 'B: still in Work', `const s = await ${STATE}(['tabs', 'tabSpace', 'spaces']); const of = (n) => { const t = Object.values(s.tabs).find((x) => x.url.endsWith('/p/' + n)); return t && s.spaces.find((sp) => sp.id === s.tabSpace[t.id])?.name; }; return of('B') === 'Work' && of('A') === 'Personal'`),
    { op: 'uninstall' }, wait(800), { op: 'install', sameId: true }, wait(3000),
    // Read from Margin's own page (the pages' old content-script world belongs to the copy before).
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: false }, wait(1500),
    checkPage('N', 'after the update: B still in Work, A in Personal', `const s = await ${STATE}(['tabs', 'tabSpace', 'spaces']); const of = (n) => { const t = Object.values(s.tabs).find((x) => x.url.endsWith('/p/' + n)); return t && s.spaces.find((sp) => sp.id === s.tabSpace[t.id])?.name; }; return of('B') === 'Work' && of('A') === 'Personal'`, 5000),
    checkPage('N', 'and their ids are new', `const s = await ${STATE}('tabs'); return Object.values(s.tabs).filter((t) => /\\/p\\/[AB]$/.test(t.url)).every((t) => t.id > 50)`),
  ],
  // Which copy of Margin is in charge (shared/owner.js). An older copy
  // still running after an update writes its own tab ids under the old
  // storage names: pages don't read those (shared/stored.js). While this
  // copy hasn't matched the tabs, a page shows it's getting ready; once a
  // newer copy owns the state, this one stands back. (Two copies can't run
  // side by side in this host: the installOld step's copy breaks the
  // installed one's messaging here, so their writes are made by hand.)
  owner: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, ready('A'), wait(1500),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: false }, wait(1000),
    { op: 'page', in: 'N', js: 'await browser.storage.local.set({ tabs: { 999: { id: 999, windowId: 998, index: 0, url: "http://example.com/", title: "old copy", active: true } }, tabSpace: { 999: "personal" }, activeSpaceByWindow: { 998: "personal" } }); return "an old copy wrote its tabs"' }, wait(800),
    check('A', 'A: its sidebar still lists the tabs by ids its copy has', `const { state } = Margin.content.getState(); const urls = Object.values(state.tabs).map((t) => t.url); return !state.tabs[999] && urls.some((u) => u.endsWith('/p/A')) && urls.some((u) => u.endsWith('/p/B'))`),
    switchTo('A', 'B'), shown('B'),
    { op: 'eval', in: 'B', js: `const log = globalThis.__marginLog ?? []; globalThis.__waits = log.filter((l) => l.includes('getting ready: waiting')).length; globalThis.__dones = log.filter((l) => l.includes('getting ready: done')).length; return 'counted'` },
    { op: 'page', in: 'N', js: 'const { openTabs } = await browser.storage.local.get("openTabs"); await browser.storage.local.set({ openTabs: { ...openTabs, synced: false } }); return "not matched yet"' },
    check('B', 'B: its copy waits to match the tabs', `(globalThis.__marginLog ?? []).filter((l) => l.includes('getting ready: waiting')).length > (globalThis.__waits ?? 0)`, 2000),
    { op: 'page', in: 'N', js: 'const { openTabs } = await browser.storage.local.get("openTabs"); await browser.storage.local.set({ openTabs: { ...openTabs, synced: true } }); return "matched"' },
    check('B', 'B: and is done once they are', `(globalThis.__marginLog ?? []).filter((l) => l.includes('getting ready: done')).length > (globalThis.__dones ?? 0)`, 2000),
    { op: 'page', in: 'N', js: 'const { owner } = await browser.storage.local.get("owner"); await browser.storage.local.set({ owner: { origin: "webkit-extension://a-newer-copy/", since: owner.since + 1000 } }); return "a newer copy took over"' },
    check('B', 'B: this copy stands back for the newer one, saying why', `(globalThis.__marginLog ?? []).some((l) => l.includes('stays out of the way'))`, 3000),
    checkPage('N', 'its background says so', `(await browser.runtime.sendMessage({ type: 'owner' }))?.stale === true`),
  ],
  // A Safari relaunch: every tab comes back asleep with new ids, the one in
  // front loads; tabs keep their spaces, the page in front shows Margin
  // getting ready until its copy has matched the tabs (Margin allowed late,
  // as an unsigned build is), and switching works after.
  relaunch: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, wait(800), { op: 'install', sameId: true }, ready('A'), wait(1500),
    { op: 'eval', in: 'A', js: `${ID} const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('B'), spaceId: work }); return 'B moved to Work'` }, wait(800),
    { op: 'restart', late: true, lateMs: 800 }, ready('A'),
    check('A', 'A: Margin waited for its copy to match the tabs, then was ready', `const log = globalThis.__marginLog ?? []; return log.some((l) => l.includes('getting ready: waiting')) && log.some((l) => l.includes('getting ready: done'))`, 6000),
    check('A', 'A: B is still in Work, A in Personal, under their new ids', `const s = await ${STATE}(['tabs', 'tabSpace', 'spaces', 'openTabsBy']); const of = (n) => { const t = Object.values(s.tabs).find((x) => x.url.endsWith('/p/' + n)); return t && s.spaces.find((sp) => sp.id === s.tabSpace[t.id])?.name; }; return s.openTabsBy?.synced && of('B') === 'Work' && of('A') === 'Personal'`, 5000),
    switchTo('A', 'C'), shown('C'), ready('C'),
    switchTo('C', 'B'), shown('B'), ready('B'),
  ],
  // A page back from the back/forward cache has its listeners on browser.*
  // events again (they come off as a page is left): a change in storage (the
  // app's layout, as the link client writes it) reaches it.
  bfcache: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    { op: 'page', in: 'A', js: `window.__before = 1; setTimeout(() => { location.href = '/p/A2'; }); return 'navigating'` },
    checkPage('A', 'A: at its next page', `location.pathname === '/p/A2'`, 2000), ready('A'),
    { op: 'page', in: 'A', js: `setTimeout(() => history.back()); return 'back'` },
    checkPage('A', 'A: back to its first page, from the back/forward cache', `location.pathname === '/p/A' && window.__before === 1`, 2000),
    wait(600),
    { op: 'eval', in: 'A', js: `const w = Margin.content.getState().windowId; await browser.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', at: Date.now(), layouts: { [w]: { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 10, container: { width: 1200, height: 800 }, mode: 'fullscreen', seq: 1, epoch: 'e1' } } } }); return 'linked in storage'` },
    boxed('A'),
  ],
  // A pinch. On a page with no box: Safari's own, smooth, Margin out of it,
  // except what would open the overview. With one: Margin's (pinch-box).
  pinch: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'), 
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { frameWhenHidden: false } }))' }, bare('A'), wait(300),
    { op: 'page', in: 'A', js: `window.__pinch = []; for (const t of ['gesturestart', 'gesturechange']) addEventListener(t, (e) => __pinch.push(t + ':' + e.defaultPrevented), false); return 'listening'` },
    { op: 'pinch', deltas: Array(14).fill(0.03) }, wait(300),
    checkPage('A', 'A: outward: Safari\'s own magnification', `visualViewport.scale > 1.2`, 1500),
    { op: 'pinch', deltas: Array(40).fill(-0.03) }, wait(400),
    checkPage('A', 'A: inward, while magnified: Safari\'s, back to normal', `visualViewport.scale === 1`, 2000),
    { op: 'page', in: 'A', js: `__pinch.length = 0; return 'reset'` },
    { op: 'pinch', deltas: Array(10).fill(-0.03) }, wait(200),
    checkPage('A', 'A: inward at normal scale: cancelled, nothing moves', `visualViewport.scale === 1 && __pinch[0] === 'gesturestart:true'`),
    { op: 'pinch', deltas: Array(10).fill(0.03) }, wait(300),
    checkPage('A', 'A: and the next one works', `visualViewport.scale > 1.1`, 1500),
    { op: 'pinch', deltas: Array(30).fill(-0.03) }, wait(400),
  ],
  // On a page with a box (the app's layout): Margin's pinch, the page scaled
  // at <html>, clicks land, two fingers move it, then scroll it.
  'pinch-box': [
    ...startBoxed('A', '/p/T'), wait(500),
    { op: 'pinch', deltas: Array(14).fill(0.03), x: 700, y: 400 }, wait(100),
    checkPage('A', 'zoomed by Margin, not by Safari', `${AT} return at.scale > 1.2 && visualViewport.scale === 1`, 800),
    checkPage('A', 'the page\'s own measures stay at its size', `const r = document.getElementById('full').getBoundingClientRect(); return Math.abs(r.width - innerWidth) < 1`),
    checkPage('A', 'a point in the window finds what\'s drawn there', `const x = innerWidth / 2, y = innerHeight / 2; const r = document.elementFromPoint(x, y).getBoundingClientRect(); return r.left <= x && x <= r.right && r.top <= y && y <= r.bottom`),
    { op: 'pinch', deltas: Array(40).fill(-0.03), x: 700, y: 400 }, wait(350),
    checkPage('A', 'pinched back: the page as it was', `${AT} return at.scale === 1 && at.x === 260 && at.y === 8`, 800),
    { op: 'pinch', deltas: Array(40).fill(0.06), x: 700, y: 400 }, wait(350),
    checkPage('A', 'at most 3×', `${AT} return Math.abs(at.scale - 3) < 0.01`, 800),
    { op: 'pinch', deltas: Array(60).fill(-0.05), x: 700, y: 400 }, wait(300), { op: 'pinch', deltas: Array(8).fill(-0.03), x: 700, y: 400 }, wait(350),
    checkPage('A', 'pinched in past its size: it springs back', `${AT} return at.scale === 1`, 800),
    { op: 'pinch', deltas: Array(14).fill(0.04), x: 700, y: 400 }, wait(200),
    { op: 'eval', in: 'A', js: 'const { settings } = await browser.storage.local.get("settings"); await browser.storage.local.set({ settings: { ...settings, blockGestures: false } }); return "off"' },
    checkPage('A', 'gestures turned off: back to its size', `${AT} return at.scale === 1`, 1500),
  ],
  // Two copies of Margin loaded at once in one controller (as Safari would
  // load a new one while the old one still runs): they share one script world
  // in pages, so a page runs one copy, here the first's. Once the newer copy
  // owns the state, that page's copy stands back, saying to restart Safari,
  // rather than drawing tabs by ids its copy doesn't own.
  twins: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install', sameId: true }, ready('A'), wait(1500),
    { op: 'page', in: 'A', js: 'window.__before = true; return "marked"' },
    { op: 'installTwin' }, wait(2500),
    { op: 'open', name: 'B', url: '/p/B', active: true },
    check('B', 'B: one copy runs in the shared world', `!!globalThis.Margin?.content && ${NOTHING_DRAWN}`, 4000),
    // Which copy the page runs is WebKit's pick: the newer one acts there;
    // the older one stands back, saying why.
    check('B', 'B: either it runs the copy in charge, or it stands back and says why', `const log = globalThis.__marginLog ?? []; const s = await browser.storage.local.get('openTabs'); return (log.some((l) => l.includes('stays out of the way')) && !Margin.content.active()) || (s.openTabs?.origin === browser.runtime.getURL('') && s.openTabs.synced && Margin.content.active())`, 5000),
    // A page whose world is the other copy's, which still answers, isn't taken for one cut off
    // from a copy that's gone (background/cut-off.js): not loaded again, as it's shown or after.
    { op: 'show', name: 'A' }, wait(2000),
    checkPage('A', 'A (the other copy\'s world, still running): not loaded again', 'window.__before === true', 1000),
  ],
  // S4 (2026-11-04): ⌃⌘↓ on a page that takes ArrowDown at every level goes to
  // the next tab, through Margin's listener (the host has no Safari menu: no
  // command), and the page never sees it. In Safari the command came only
  // after the page had turned the key down, so such a page ate it.
  commandkeys: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(500), { op: 'install' }, ready('A'), wait(300),
    { op: 'open', name: 'E', url: '/x/eats-arrows', active: true }, { op: 'open', name: 'B', url: '/p/B' }, ready('E'), ready('B'), wait(300),
    key('E', ...ARROW_DOWN, ['control', 'command']),
    checkPage('E', 'the next tab is shown (E left)', `document.hidden`, 2500),
    checkPage('E', 'E never saw the key', `__eaten.window === 0 && __eaten.document === 0 && __eaten.body === 0`),
    { op: 'show', name: 'E' }, wait(200),
    { op: 'page', in: 'E', js: `document.getElementById('t').focus(); return document.activeElement.id` },
    key('E', ...ARROW_DOWN, ['control', 'command']),
    checkPage('E', 'from a text field too', `document.hidden && __eaten.window === 0`, 2500),
    { op: 'show', name: 'E' }, wait(200),
    key('E', ...ARROW_DOWN, []),
    checkPage('E', 'a bare arrow is still the page\'s (E stays, and took it)', `!document.hidden && __eaten.window === 1`, 300),
  ],
  behindleft: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'), wait(600),
    { op: 'eval', in: 'A', js: `void Margin.content.send('newTab', { url: location.origin + '/p/S3' }); return 'asked'` },
    wait(400),
    { op: 'eval', in: 'A', js: `${ID} return JSON.stringify(await Margin.content.send('activateTab', { tabId: id('A') }))` },
    wait(1800),
    checkPage('A', 'picking its own tab meanwhile: A stays', `!document.hidden`),
    checkPage('new1', 'and the new tab stays behind, loaded', `document.hidden && document.readyState === 'complete'`),
    check('A', 'in the state, not the tab in front', `const s = await ${STATE}(['tabs']); const t = Object.values(s.tabs).find((x) => x.url.includes('/p/S3')); return !!t && !t.active`),
  ],
  // A hidden tab's title ticking (a chat, a timer: background/tab-updates.js):
  // its changes are gathered into a write every 2 s at most, not one each,
  // and the state ends on the last; the tab in front's own title is written
  // at once. The writes of the open tabs counted in A's Margin world.
  titles: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), ready('B'),
    { op: 'eval', in: 'A', js: `globalThis.__writes = []; (globalThis.browser ?? chrome).storage.onChanged.addListener((changes) => { if (changes.openTabs) __writes.push(performance.now()); }); return 'counting writes'` },
    { op: 'page', in: 'A', js: `document.title = 'A now'; return 'titled'` },
    check('A', 'A: the tab in front\'s title is written at once (under 300 ms)', `${ID} const { tabs: now } = await ${STATE}('tabs'); return now[id('A')]?.title === 'A now' && __writes.length > 0`, 300),
    { op: 'eval', in: 'A', js: `globalThis.__before = __writes.length; return 'next: B ticking'` },
    // (A hidden page's timers are slowed: each tick waits in a busy loop, then yields through a message.)
    { op: 'page', in: 'B', js: `const yieldNow = () => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = resolve; c.port2.postMessage(0); }); for (let n = 1; n <= 8; n++) { document.title = 'B tick ' + n; const until = performance.now() + 60; while (performance.now() < until); await yieldNow(); } return 'ticked'` },
    check('A', 'A: B\'s stored title is its last', `${ID} const { tabs: now } = await ${STATE}('tabs'); return now[id('B')]?.title === 'B tick 8'`, 3600),
    { op: 'eval', in: 'A', js: `return 'writes while B ticked: ' + (__writes.length - __before)` },
    check('A', 'A: eight title changes of a hidden tab, at most two writes', `const n = __writes.length - __before; return n >= 1 && n <= 2`),
  ],
  // A hidden tab's new address is written at once, not gathered (background/
  // tab-updates.js: after a restart tabs are matched to their records by it);
  // a new fragment alone waits its 300 ms. Read from storage in A's Margin world.
  addresses: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), ready('B'),
    { op: 'eval', in: 'A', js: `${ID} globalThis.__b = id('B'); return 'B is ' + __b` },
    { op: 'page', in: 'B', js: `history.pushState(null, '', '/p/B/next'); return 'moved'` },
    check('A', 'A: B\'s new address is stored at once (by about 200 ms: the host looks every 100 ms)', `const { tabs } = await ${STATE}('tabs'); return !!tabs[__b]?.url.endsWith('/p/B/next')`, 150),
    { op: 'page', in: 'B', js: `location.hash = 'inbox'; return 'fragment'` },
    wait(100),
    check('A', 'A: B\'s new fragment alone waits', `const { tabs } = await ${STATE}('tabs'); return !tabs[__b]?.url.endsWith('#inbox')`),
    check('A', 'A: then is stored', `const { tabs } = await ${STATE}('tabs'); return !!tabs[__b]?.url.endsWith('/p/B/next#inbox')`, 1500),
  ],
  // Safari's background is a page now (Margin 2: the link to Margin.app
  // needs one). As a service worker it stopped about 5 s after install here
  // (README): a page should still answer well after.
  'bg-page': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    wait(12000),
    check('A', 'A: the background still answers 12 s after install (20 requests)', `const zooms = await Promise.all(Array.from({ length: 20 }, () => Margin.content.send('getZoom', {}, false))); return zooms.every((z) => Number(z) > 0)`, 4000),
    wait(10000),
    check('A', 'A: and 22 s after', `const zooms = await Promise.all(Array.from({ length: 20 }, () => Margin.content.send('getZoom', {}, false))); return zooms.every((z) => Number(z) > 0)`, 4000),
  ],
  // Margin.app linked (the copy's appLink, shared/app-link.js, written here as
  // the link client would): the page has its box from the window's layout less
  // where the viewport sits (none here: the host's outer size is 0), and still
  // nothing of Margin's in it; reconnecting, the box stays; off, the page as it
  // is.
  'app-linked': [
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' }, ready('A'), bare('A'), nothingDrawn('A', 'A: not linked: nothing of Margin\'s, no box'),
    { op: 'eval', in: 'A', js: `const w = Margin.content.getState().windowId; await browser.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', at: Date.now(), layouts: { [w]: { insets: { left: 300, top: 60, right: 20, bottom: 24 }, radius: 10, container: { width: outerWidth, height: outerHeight }, mode: 'fullscreen', seq: 1, epoch: 'e1' } } } }); return 'linked ' + w + ' ' + (outerHeight - innerHeight)` },
    check('A', 'A: linked', `Margin.content.appDraws() && Margin.content.runtime === undefined`, 3000),
    check('A', 'A: linked: the box is the layout from the app, less the title bar above the viewport', `${AT} const top = 60 - Math.max(0, outerHeight - innerHeight); return at.x === 300 && at.y === top`, 3000),
    checkPage('A', 'A: linked: the page is as big as the box', `innerWidth === 1200 - 300 - 20 && document.scrollingElement === document.body`, 3000),
    nothingDrawn('A', 'A: linked: still nothing of Margin\'s in the page'),
    { op: 'eval', in: 'A', js: `const w = Margin.content.getState().windowId; const { appLink } = await browser.storage.local.get('appLink'); await browser.storage.local.set({ appLink: { ...appLink, layouts: { [w]: { ...appLink.layouts[w], insets: { left: 256, top: 60, right: 16, bottom: 16 }, seq: 2 } } } }); return 'moved'` },
    check('A', 'A: a new layout: the box follows', `${AT} return at.x === 256`, 3000),
    { op: 'eval', in: 'A', js: `const { appLink } = await browser.storage.local.get('appLink'); await browser.storage.local.set({ appLink: { ...appLink, state: 'reconnecting' } }); return 'reconnecting'` },
    wait(400),
    check('A', 'A: reconnecting: the box stays', `${AT} return at.x === 256 && Margin.content.appDraws()`),
    { op: 'eval', in: 'A', js: `const { appLink } = await browser.storage.local.get('appLink'); await browser.storage.local.set({ appLink: { ...appLink, state: 'off' } }); return 'off'` },
    bare('A'), nothingDrawn('A', 'A: off: the page as it is, nothing of Margin\'s'),
    check('A', 'A: off', `!Margin.content.appDraws() && !Margin.content.boxed()`),
  ],
  // The real extension linked to Margin.app's real end of the link (link-server: app/shell's
  // ExtensionLink, LinkSocket, LinkMessage, Chunks), through the host's native messaging:
  // wantLink, the link dispatched into the copy's port, the WebSocket with its token and the
  // app's key, hello, the snapshot, the theme in pieces, a setLayout the page's box follows,
  // a request from the app run by the background. Then the app quitting (pages lose their box at
  // once), coming back (linked again), and crashing (reconnecting, then off: the box goes).
  'app-link': [
    { op: 'appStart' },
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' },
    check('A', 'A: linked to the app: the page draws no Margin UI', `Margin.content?.appDraws?.() === true`, 8000),
    nothingDrawn('A', 'A: linked: nothing of Margin\'s in the page'),
    check('A', 'A: the box is where the app\'s setLayout put the page (300, 40)', `${AT} return at.x === 300 && at.y === 40 - Math.max(0, outerHeight - innerHeight)`, 5000),
    check('A', 'A: the app\'s request (updateSettings) ran in the background', `const { settings } = await browser.storage.local.get('settings'); return settings?.sidebarShortcut === 'Alt+KeyJ'`, 5000),
    check('A', 'A: pages are told it\'s linked', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'linked' && Object.keys(appLink.layouts ?? {}).length === 1`, 3000),
    // ⌘T reaching the page while the app draws (its hot key would have taken it in Safari):
    // nothing visible, no tab made, the app told (the link server logs the push `keyHeard`).
    { op: 'key', in: 'A', keyCode: 17, chars: 't', mods: ['command'] },
    wait(400),
    check('A', 'A: ⌘T in the page while linked: no new tab', `const { openTabs } = await browser.storage.local.get('openTabs'); return Object.keys(openTabs?.tabs ?? {}).length === 1`, 2000),
    { op: 'appQuit' },
    check('A', 'A: the app quit (bye): off at once, the box gone', `Margin.content.appDraws() === false && !Margin.content.boxed()`, 3000),
    bare('A'),
    { op: 'appStart' }, reload('A'),
    check('A', 'A: the app back, a page starting: linked again', `Margin.content?.appDraws?.() === true`, 9000),
    { op: 'appKill' },
    wait(800),
    check('A', 'A: the app gone without a word: reconnecting, still nothing drawn', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'reconnecting' && Margin.content.appDraws() === true`, 3000),
    check('A', 'A: and once it\'s clear it\'s gone, off: the box goes', `Margin.content.appDraws() === false && !Margin.content.boxed()`, 9000),
    bare('A'), nothingDrawn('A'),
  ],
  // A picture of a page in its box, for a look (build/screenshot.png).
  screenshot: [
    ...startBoxed('A', '/p/A'),
    wait(800), reload('A'), boxed('A'), wait(500),
    { op: 'snapshot', file: new URL('build/screenshot.png', import.meta.url).pathname },
  ],
};

// Safari reloading Margin while pages are open (an update, or Margin.app opened): it keeps
// Margin's content-script world in those pages, still bound to the copy that's gone, where
// nothing answers (background/cut-off.js). The page in front and the ones behind are loaded
// again; one with a draft typed keeps it; switches then work and every page answers, a new tab
// loads and comes to the front, and every page has its box from Margin.app's layout.
const answers = (tab) => check(tab, `${tab}: its Margin answers (storage and the background)`, "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return (await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])) && (await Promise.race([Margin.content.send('sidebarScroll').then(() => true), later(1500)]))", 3000);
Object.assign(SCENARIOS, {
  reloaded: [
    appWith(260),
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/FC' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install', sameId: true }, linked('A'), wait(800),
    reload('A'), reload('B'), reload('C'), wait(1500), boxed('A'), boxed('B'), boxed('C'),
    ...['A', 'B', 'C'].map((t) => ({ op: 'page', in: t, js: 'window.__before = true; return "marked"' })),
    { op: 'page', in: 'C', js: `document.getElementById('t').value = 'draft'; return 'typed'` },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('B', 'B (behind): loaded again', '!window.__before', 8000),
    // (2026-11-04: never loaded again in front; once it's left, below.)
    checkPage('A', 'A (in front, nothing typed), left with the old copy: not loaded again in front, nothing of Margin\'s in it', `window.__before === true && ${NOTHING_DRAWN}`, 3000),
    checkPage('C', 'C (a draft typed): not loaded again, the draft kept', `window.__before === true && document.getElementById('t').value === 'draft'`, 3000),
    { op: 'show', name: 'B' }, shown('B'), answers('B'), linked('B'), boxed('B'),
    checkPage('A', 'A, left: loaded again, behind', '!window.__before && document.hidden', 4000),
    switchTo('B', 'D'), shown('D'), answers('D'), boxed('D'),
    switchTo('D', 'FC'), shown('C'),
    checkPage('C', 'C shown: still the draft, nothing of Margin\'s over it', `document.getElementById('t').value === 'draft' && document.body.style.opacity !== '0' && ${NOTHING_DRAWN}`, 2000),
    switchTo('B', 'A'), shown('A'), answers('A'),
    { op: 'eval', in: 'A', js: `return JSON.stringify(await Margin.content.send('newTab', { url: location.origin + '/p/S1' }) ?? null)` },
    checkPage('new1', 'a new tab: made, loaded and in front', `!document.hidden && document.readyState === 'complete' && location.pathname === '/p/S1'`, 8000),
    answers('new1'), boxed('new1'),
  ],
  // A tab put to sleep (background/sleep.js; Margin 2): Margin closes its
  // browser tab and keeps the Margin tab, not open, in its space; clicked
  // (the request its row in the app's sidebar sends), it opens again, in
  // front, as the same Margin tab, its content there and one history entry.
  // The tab in front isn't put to sleep.
  'sleep-show': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), ready('B'), wait(300),
    keepMid('A', 'B'),
    sleepNow('A'),
    check('A', 'B: closed and kept, not open (put to sleep)', `${KEPT('B')} return k?.why === 'sleep' && k.id === __midB`, 3000),
    checkPage('A', 'A (in front): not put to sleep', "location.pathname === '/p/A' && !document.hidden"),
    openKept('A', 'B'),
    awakeAt('new1', 'B', 'its row opened it again: its page, one history entry'),
    checkPage('new1', 'new1: in front', '!document.hidden', 3000),
    check('A', 'B open again as the same Margin tab, nothing kept', `const s = await ${STATE}(['tabs', 'keptTabs']); return Object.values(s.tabs).some((t) => t.url.endsWith('/p/B') && t.mid === __midB) && !Object.values(s.keptTabs).some((x) => x.url.endsWith('/p/B'))`, 3000),
    { op: 'state' },
  ],
  // A tab with a draft typed into it (a real key press) isn't put to sleep;
  // one on a site that never sleeps isn't either.
  'sleep-kept': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'F', url: '/p/F1' }, { op: 'open', name: 'N', url: '/p/N' },
    wait(800), { op: 'install' }, ready('A'), ready('F'),
    // (Keep-ready off: the tab just left is held, and a tab held isn't put to sleep.)
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { keepLeftTabReadyMinutes: 0 } }))' },
    { op: 'show', name: 'F' }, wait(150),
    { op: 'page', in: 'F', js: `document.querySelector('textarea').focus(); return 'focused'` },
    key('F', 0, 0x61), key('F', 11, 0x62),
    checkPage('F', 'F: the draft is typed', `document.querySelector('textarea').value === 'ab'`),
    { op: 'show', name: 'A' }, wait(150),
    { op: 'eval', in: 'A', js: `return JSON.stringify(await Margin.content.send('updateSettings', { patch: { neverSleepSites: ['127.0.0.1'] } }))` }, wait(100),
    check('A', 'a pass: no tab due (the test pages\' site never sleeps)', `const r = await Margin.content.send('sleepNow', { afterMs: 1 }); return r?.due === 0 && r.slept === 0`, 3000),
    checkPage('F', 'F: still its page, the draft there', `location.pathname === '/p/F1' && document.querySelector('textarea').value === 'ab'`),
    checkPage('N', 'N: still its page', `location.pathname === '/p/N'`),
    { op: 'eval', in: 'A', js: `return JSON.stringify(await Margin.content.send('updateSettings', { patch: { neverSleepSites: [] } }))` }, wait(100),
    check('A', 'without the list: the tab with the draft kept (edited), the other put to sleep', `const r = await Margin.content.send('sleepNow', { afterMs: 1 }); return JSON.stringify(r) === JSON.stringify({ due: 2, slept: 1, skipped: { edited: 1 }, stopped: null })`, 3000),
    checkPage('F', 'F: still its page, the draft there', `location.pathname === '/p/F1' && document.querySelector('textarea').value === 'ab'`),
    check('A', 'N: closed and kept, not open (put to sleep)', `${KEPT('N')} return k?.why === 'sleep'`, 3000),
  ],
  // Text in another site's frame (a comment box, a form) keeps its tab awake:
  // the page is asked in every frame (allFrames). One whose other site's frame
  // has nothing typed sleeps, its empty and srcdoc frames (WebKit runs nothing
  // there: the top frame looks into them) and a sandboxed one too. One with a
  // data: frame (no site: nothing may look into it) stays awake. (Margin
  // installed after the pages loaded: its watch there started late.)
  'sleep-frames': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'I', url: '/p/I1' }, { op: 'open', name: 'J', url: '/p/J1' }, { op: 'open', name: 'K', url: '/p/K1' },
    wait(800), { op: 'install' }, ready('A'),
    checkPage('I', 'I: its frame loaded', `!!document.querySelector('iframe') && document.readyState === 'complete'`, 3000),
    check('A', 'a pass: the tab with text in its frame kept (edited), the one with a data: frame kept, the other put to sleep', `const r = await Margin.content.send('sleepNow', { afterMs: 1 }); console.log('[margin] sleep-frames pass ' + JSON.stringify(r)); return JSON.stringify(r) === JSON.stringify({ due: 3, slept: 1, skipped: { edited: 1, 'frame unknown': 1 }, stopped: null })`, 3000),
    checkPage('I', 'I: still its page', `location.pathname === '/p/I1'`),
    checkPage('K', 'K: still its page', `location.pathname === '/p/K1'`),
    check('A', 'J: closed and kept, not open (put to sleep)', `${KEPT('J1')} return k?.why === 'sleep'`, 3000),
  ],
  // Margin updated while tabs are on Margin's sleep page, where an earlier
  // build put sleeping tabs (gone since Phase 3: its address opens nothing).
  // Until then Margin knows them by their pages. Found as the new copy
  // starts, hidden: closed, kept as their Margin tabs (the same ones),
  // asleep, not archived. One on it in front: loaded at its page's address.
  'sleep-leftover': [
    { op: 'open', name: 'A', url: '/p/A', active: true },
    wait(800), { op: 'install', sameId: true }, ready('A'),
    { op: 'open', name: 'B', url: OLD_SLEEP('B'), asleep: true }, { op: 'open', name: 'C', url: OLD_SLEEP('C'), asleep: true },
    check('A', 'B and C: known by their pages, asleep', `const { tabs } = await ${STATE}('tabs'); return ['B', 'C'].every((n) => Object.values(tabs).some((t) => t.url.endsWith('/p/' + n) && t.title === n && t.sleeping?.how === 'page'))`, 3000),
    { op: 'eval', in: 'A', js: `const { tabs } = await ${STATE}('tabs'); const m = Object.values(tabs).find((t) => t.url.endsWith('/p/B'))?.mid; sessionStorage.setItem('__midB', m); return m ?? 'none'` },
    { op: 'uninstall' }, wait(800), { op: 'install', sameId: true }, ready('A'),
    check('A', 'B and C (hidden): closed, kept as their Margin tabs (B the same one), asleep, not archived', `const s = await ${STATE}(['tabs', 'keptTabs', 'archive']); const k = (n) => Object.values(s.keptTabs).find((x) => x.url.endsWith('/p/' + n)); return k('B')?.why === 'sleep' && k('B').id === sessionStorage.getItem('__midB') && k('C')?.why === 'sleep' && !Object.values(s.tabs).some((t) => /[/]p[/][BC]$/.test(t.url) || t.url.includes('sleep.html')) && !s.archive.some((a) => /[/]p[/][BC]$/.test(a.url))`, 8000),
    { op: 'open', name: 'D', url: OLD_SLEEP('D'), active: true },
    checkPage('D', "D (in front): loaded at its page's address", `location.pathname === '/p/D' && document.title === 'D'`, 6000),
  ],
  // Margin's tabs (Margin 2, PLAN.md §6). A tab lost with its window
  // (tabs.onRemoved's isWindowClosing) stays in its space, not open, the same
  // Margin tab; nothing is archived. (How the app's sidebar draws it: the
  // view model's unit tests.)
  'keep-window': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
    wait(800), { op: 'install' }, ready('A'), wait(300),
    keepMid('A', 'C'),
    { op: 'close', name: 'C', windowClosing: true },
    check('A', 'C: kept, not open, in its space, the same Margin tab', `${KEPT('C')} const { tabs } = await ${STATE}('tabs'); return k?.why === 'window' && k.id === __midC && !Object.values(tabs).some((t) => t.url.endsWith('/p/C'))`, 3000),
    check('A', 'nothing archived', `return (await ${STATE}('archive')).archive.length === 0`),
  ],
  // A tab closed on its own (Safari's tab bar, ⌘W: not with its window, not
  // Margin's doing) goes to the archive, and isn't kept.
  'archive-own': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), wait(300),
    { op: 'close', name: 'B' },
    check('A', 'B: archived, not kept', `${KEPT('B')} const { archive, tabs } = await ${STATE}(['archive', 'tabs']); return !k && archive.some((a) => a.url.endsWith('/p/B')) && !Object.values(tabs).some((t) => t.url.endsWith('/p/B'))`, 3000),
  ],
  // A tab that isn't open, clicked (the request its row in the app's sidebar
  // sends): it opens in this window, in front, at its address, and that
  // browser tab is the same Margin tab.
  'reopen-kept': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), wait(300),
    keepMid('A', 'B'),
    { op: 'close', name: 'B', windowClosing: true },
    check('A', 'B: kept, not open', `${KEPT('B')} return k?.id === __midB`, 3000),
    openKept('A', 'B'),
    checkPage('new1', 'new1: B open again, in front, its content', `location.pathname === '/p/B' && !document.hidden && document.title === 'B'`, 4000),
    check('A', 'the new tab is the same Margin tab, in its space; nothing kept', `const s = await ${STATE}(['tabs', 'keptTabs', 'tabSpace']); const t = Object.values(s.tabs).find((x) => x.url.endsWith('/p/B')); const a = Object.values(s.tabs).find((x) => x.url.endsWith('/p/A')); return !!t && t.mid === __midB && s.tabSpace[t.id] === s.tabSpace[a.id] && !Object.values(s.keptTabs).length`, 3000),
  ],
  // A Safari relaunch: the tabs it restores are matched to their Margin tabs
  // by address and order (new ids, the same Margin tabs); one it didn't
  // restore stays in its space, not open.
  'relaunch-match': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
    wait(800), { op: 'install', sameId: true }, ready('A'), wait(1200),
    { op: 'eval', in: 'A', js: `const { tabs } = await ${STATE}('tabs'); const m = Object.fromEntries(Object.values(tabs).map((t) => [t.url.split('/p/')[1], { mid: t.mid, id: t.id }])); sessionStorage.setItem('__mids', JSON.stringify(m)); return JSON.stringify(m)` },
    { op: 'restart', drop: ['C'] }, ready('A'),
    check('A', 'A and B: the same Margin tabs, matched by address under new ids', `const m = JSON.parse(sessionStorage.getItem('__mids')); const s = await ${STATE}(['tabs', 'openTabsBy']); const of = (n) => Object.values(s.tabs).find((t) => t.url.endsWith('/p/' + n)); return s.openTabsBy?.synced === true && of('A')?.mid === m.A.mid && of('B')?.mid === m.B.mid`, 5000),
    check('A', "C (Safari didn't restore it): kept, not open, in its space, the same Margin tab", `const m = JSON.parse(sessionStorage.getItem('__mids')); ${KEPT('C')} return k?.id === m.C.mid && k.why === 'not restored'`, 3000),
  ],
  // Put to sleep: closed by Margin, its page's process gone (all its memory
  // given back), its Margin tab kept, not open.
  'sleep-close': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, ready('A'), ready('B'), wait(300),
    keepMid('A', 'B'),
    { op: 'pid', name: 'B' },
    sleepNow('A'),
    check('A', 'B: closed by Margin, kept as its Margin tab (put to sleep), not archived', `${KEPT('B')} const { tabs, archive } = await ${STATE}(['tabs', 'archive']); return k?.why === 'sleep' && k.id === __midB && !Object.values(tabs).some((t) => t.url.endsWith('/p/B')) && !archive.some((a) => a.url.endsWith('/p/B'))`, 3000),
    { op: 'pidGone', name: 'B', label: "B: its page's process has exited", timeout: 4000 },
  ],
  // The same reload with Margin's new-tab page open: that page is the old copy's, at its address,
  // and nothing in it answers. It's loaded again at this copy's address (marked as not a new tab:
  // ⌘T's hand-off would close it), then shown with its notice (not linked).
  'reloaded-newtab': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, ready('A'), wait(800),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html' }, wait(1500),
    checkPage('N', "N: Margin's new-tab page says Margin.app isn't running (not linked)", "!document.getElementById('notice').hidden", 4000),
    { op: 'page', in: 'N', js: 'window.__before = true; return location.href' },
    { op: 'page', in: 'A', js: 'window.__before = true; return "marked"' },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    // (In front: not loaded again there, 2026-11-04; once it's left, below.)
    checkPage('N', "N: loaded again at this copy's address, and it answers", "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return !window.__before && location.search === '?again' && document.readyState === 'complete' && await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])", 8000),
    wait(1500),
    checkPage('A', 'A (in front): not loaded again in front', 'window.__before === true'),
    { op: 'show', name: 'N' },
    checkPage('N', 'N shown: still open, with its notice', "!document.hidden && !document.getElementById('notice').hidden", 4000),
    checkPage('A', 'A, left: loaded again, behind', '!window.__before && document.hidden', 4000),
    check('A', 'no hand-off closed N', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs).some((t) => /newtab\\.html\\?again/.test(t.url))`, 3000),
  ],
  // What Margin adds to a page: nothing (Margin 2 Phase 2 step 5). Not
  // linked to Margin.app: no element of Margin's, no frame, no box, none of
  // Margin's page scripts, on a page open at install and on one loaded
  // since (nothing registered for its first paint); ⌘T in a page opens
  // Margin's new-tab page, which says the app isn't running.
  'no-ui': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    nothingDrawn('A'), bare('A'),
    checkPage('A', 'A: none of Margin\'s page scripts', `!window[Symbol.for('margin.page')]`),
    check('A', 'A: not linked, nothing drawn here', `Margin.content.appDraws() === false && Margin.content.runtime === undefined && !Margin.content.boxed()`),
    { op: 'open', name: 'B', url: '/p/B', active: true }, ready('B'), nothingDrawn('B'), bare('B'),
    checkPage('B', 'B (loaded since): nothing registered for its first paint either', `!window[Symbol.for('margin.page')]`),
    { op: 'key', in: 'B', keyCode: 17, chars: 't', mods: ['command'] },
    checkPage('new1', 'new1: ⌘T in the page: Margin\'s new-tab page, saying Margin.app isn\'t running, with an address field', `location.pathname === '/newtab/newtab.html' && !document.getElementById('notice').hidden && !!document.getElementById('address')`, 4000),
    check('B', 'B: one new tab for the press', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs).filter((t) => t.url.includes('/newtab/newtab.html')).length === 1`, 2000),
  ],
  // Linked: still nothing of Margin's in a page; its box is the app's layout,
  // from its first paint on a page loaded since (registered while linked).
  // The link dropping (the app killed): reconnecting, the box stays; once the
  // grace is over (GONE_MS), off: the box goes, on the page in front and the
  // one behind, and a page loaded then has none of Margin's page scripts.
  // The app back: linked again as a page starts, the box back.
  'link-drop': [
    appWith(260), { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' },
    linked('A'), boxed('A'), nothingDrawn('A', 'A: linked: still nothing of Margin\'s in the page'),
    { op: 'open', name: 'B', url: '/p/B', active: true }, boxed('B'), nothingDrawn('B'),
    checkPage('B', 'B (loaded while linked): its box from its first paint (the page\'s script registered)', `!!window[Symbol.for('margin.page')]`),
    { op: 'appKill' }, wait(800),
    check('B', 'B: the link dropped: reconnecting, the box kept', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'reconnecting' && Margin.content.boxed()`, 3000),
    checkPage('B', 'B: the grace over: off, no box, the page as it is', `getComputedStyle(document.documentElement).transform === 'none' && document.scrollingElement === document.documentElement && innerWidth === 1200`, 10000),
    nothingDrawn('B', 'B: off: nothing of Margin\'s, no frame'),
    check('A', 'A (behind): no box either', `!Margin.content.boxed() && Margin.content.appDraws() === false`, 2000),
    wait(1000), { op: 'open', name: 'C', url: '/p/C', active: true }, ready('C'), bare('C'), nothingDrawn('C', 'C (loaded once off): no box, nothing of Margin\'s, no frame'),
    // (Its registrations are dropped (background/registered.js), but WebKit here still puts them
    // in a web view made after they were registered, until it restarts: the page's script and the
    // placeholder ran in C, and Margin's core took both off. DECISIONS.md, Phase 2 step 5.)
    { op: 'page', in: 'C', js: `return 'C: the page\'s script ' + (window[Symbol.for('margin.page')] ? 'ran (WebKit kept the registration)' : 'not loaded')` },
    appWith(260), reload('C'),
    linked('C'), boxed('C'),
  ],
  // Margin's new-tab page, not linked: a short notice that Margin.app isn't
  // running, its button to start it, and an address field, which opens an
  // address in that tab; nothing else of Margin's.
  'newtab-off': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: true },
    checkPage('N', 'N: the notice, its start button, the address field (focused)', `!document.getElementById('notice').hidden && !document.getElementById('start').hidden && document.activeElement === document.getElementById('address')`, 5000),
    checkPage('N', 'N: nothing else of Margin\'s (no sidebar, no launcher)', `document.body.children.length === 1 && !document.querySelector('.margin-sidebar, .launcher, .arcadia')`),
    { op: 'page', in: 'N', js: `document.getElementById('address').value = '${SERVER}/p/G'; document.getElementById('go').requestSubmit(); return 'submitted'` },
    checkPage('N', 'N: the address opened in this tab', `location.pathname === '/p/G' && document.title === 'G'`, 4000),
  ],
  // Not linked, the new-tab page's button starts Margin.app (the extension
  // handler starts it on demand: the host's appOnDemand), and from then on
  // the page is drawn by the app: it shows nothing of its own; the page
  // behind gets its box from the app's layout.
  'newtab-start': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: true },
    checkPage('N', 'N: the start button', `!document.getElementById('start').hidden`, 5000),
    { op: 'appOnDemand', layout: [260, 8, 8, 8] },
    { op: 'page', in: 'N', js: `document.getElementById('start').click(); return document.getElementById('status').textContent` },
    checkPage('N', 'N: linked: loaded again, the app draws it (the page shows nothing of its own)', `document.getElementById('notice')?.hidden === true && (await browser.storage.local.get('appLink')).appLink?.state === 'linked'`, 12000),
    check('A', 'A (behind): linked, its box from the app\'s layout', `Margin.content.appDraws() === true`, 3000),
    boxed('A'),
  ],

  // ---- Margin 2 Phase 2 step 7: what pages said in their own UI, said by Margin.app's overlay ----
  // Through the app's real end of the link (link-server/): what it heard
  // (appHeard), and a request from its UI (appReq). The overlay drawing it is
  // tools/app-tests' (no overlays here).
  //
  // A page in front cut off from Margin by a reload of Margin (a draft typed
  // in it, so Margin leaves its reload to the person): the copy tells the
  // window's overlay "not-responding" (the kind only, once it has linked
  // again); the overlay's Reload, as noticeAction, loads the page again.
  'notice-cutoff': [
    appWith(260),
    { op: 'open', name: 'A', url: '/p/FA', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, linked('A'), wait(800),
    reload('A'), reload('B'), wait(1500), boxed('A'),
    { op: 'page', in: 'A', js: `window.__before = true; document.getElementById('t').value = 'draft'; return 'typed'` },
    { op: 'page', in: 'B', js: 'window.__before = true; return "marked"' },
    { op: 'appMark' },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('B', 'B (behind): loaded again by Margin', '!window.__before', 8000),
    linked('B'),
    { op: 'appHeard', label: 'A (in front, cut off, a draft typed): its window told "not-responding", the kind and the tab only', has: ['"ev":"push"', '"type":"notice"', '"kind":"not-responding"', '"tabId":'], timeout: 8000 },
    { op: 'appHeard', label: 'and no words on the link', has: ['"type":"notice"', 'isn’t responding'], none: true, timeout: 300 },
    checkPage('A', 'A: not loaded again by Margin (its draft)', `window.__before === true && document.getElementById('t').value === 'draft'`),
    { op: 'appMark' },
    { op: 'appReq', type: 'noticeAction', in: 'B', js: `const { tabs } = await ${STATE}('tabs'); const a = Object.values(tabs).find((t) => t.url.endsWith('/p/FA')); return JSON.stringify({ notice: 'not-responding', action: 'reload', tabId: a?.id ?? null })` },
    { op: 'appHeard', label: 'its Reload, from the app\'s UI: answered', has: ['"ev":"reply"', '"type":"noticeAction"', '"ok":true', '"result":true'] },
    checkPage('A', 'A: loaded again, as the person chose', '!window.__before', 6000),
    linked('A'), boxed('A'),
  ],
  // A new tab from nothing opening the same web page twice (Safari's "New
  // tabs open with" isn't Margin): the window told "new-tab-setting" once its
  // page says it was opened from nothing; "Don't show again" from the app
  // turns the note off.
  'notice-newtab': [
    appWith(260), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'),
    { op: 'appMark' },
    { op: 'open', name: 'H1', url: '/p/home', active: true, selectedFirst: true }, ready('H1'), wait(500),
    { op: 'open', name: 'H2', url: '/p/home', active: true, selectedFirst: true }, ready('H2'),
    { op: 'appHeard', label: 'the same page twice in a new tab from nothing: its window told "new-tab-setting"', has: ['"type":"notice"', '"kind":"new-tab-setting"'], timeout: 6000 },
    { op: 'appMark' },
    { op: 'appReq', type: 'noticeAction', in: 'H2', js: `return JSON.stringify({ notice: 'new-tab-setting', action: 'never', tabId: Margin.content.getState().tabId })` },
    { op: 'appHeard', label: 'its "Don\'t show again", from the app\'s UI: answered', has: ['"ev":"reply"', '"type":"noticeAction"', '"result":true'] },
    check('H2', 'the note turned off in the settings', `(await browser.storage.local.get('settings')).settings?.newTabHint === false`, 3000),
  ],
  // Loading, for the app's sidebar: the page in front about to be left (told
  // at once, from its beforeunload; taken back when it stays), left by a link
  // to a page that takes a while to load (an image 3 s late), then done once
  // it has loaded; a site's own same-page navigation (the Navigation API)
  // that takes a while.
  'loading': [
    appWith(260), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(600),
    { op: 'appMark' },
    { op: 'page', in: 'A', js: `dispatchEvent(new Event('beforeunload')); return 'about to leave'` },
    { op: 'appHeard', label: 'A about to be left (its beforeunload): loading, told by the page itself', has: ['"type":"loading"'], re: '"tabIds":.[0-9]', timeout: 2000 },
    { op: 'page', in: 'A', js: `document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return 'stayed'` },
    { op: 'appHeard', label: 'it stayed (the person did something there): not loading', has: ['"type":"loading"', '"tabIds":[]'], timeout: 2000 },
    wait(200), { op: 'appMark' },
    { op: 'page', in: 'A', js: `location.href = '/p/Z2'; return 'leaving'` },
    { op: 'appHeard', label: 'A left by a link: its window told a tab is loading', has: ['"type":"loading"'], re: '"tabIds":.[0-9]', timeout: 3000 },
    ready('A'),
    { op: 'appHeard', label: 'and done once the next page loaded', has: ['"type":"loading"', '"tabIds":[]'], timeout: 8000 },
    wait(300), { op: 'appMark' },
    { op: 'page', in: 'A', js: `if (!window.navigation) return 'no Navigation API'; navigation.addEventListener('navigate', (e) => { if (e.canIntercept && e.destination.url.endsWith('#later')) e.intercept({ handler: () => new Promise((r) => setTimeout(r, 700)) }); }); navigation.navigate(location.pathname + '#later'); return 'navigating'` },
    { op: 'appHeard', label: 'a same-page navigation taking a while: loading', has: ['"type":"loading"'], re: '"tabIds":.[0-9]', timeout: 2000 },
    { op: 'appHeard', label: 'and done when it finished', has: ['"type":"loading"', '"tabIds":[]'], timeout: 3000 },
  ],
  // Margin's pull to refresh in a page (synthetic wheel events at the top):
  // its feedback told to the window's overlay as it goes, then the reload.
  'gesture-pull': [
    appWith(260), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(300),
    { op: 'appMark' },
    { op: 'page', in: 'A', js: `window.__before = true; for (let i = 0; i < 24; i++) { document.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, deltaMode: 0, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 16)); } return 'pulled'` },
    { op: 'appHeard', label: 'a pull at the top of A: its window told how far it went', has: ['"type":"gesture"', '"kind":"pull"', '"state":"pulling"'] },
    { op: 'appHeard', label: 'armed', has: ['"type":"gesture"', '"kind":"pull"', '"state":"armed"'] },
    { op: 'appHeard', label: 'let go: done', has: ['"type":"gesture"', '"kind":"pull"', '"state":"trigger"'] },
    checkPage('A', 'A: reloaded by the pull', '!window.__before', 4000),
  ],
  // A page's first read of storage with a big theme package stored (a user
  // theme can be 3 MB): pages no longer read it (Margin.app's link does).
  // Logs the read's time and size as a page did it before (all of storage)
  // and now (its keys), the median of 7 each.
  'first-read': [
    appWith(260), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(500),
    { op: 'eval', in: 'A', js: `const keys = ${JSON.stringify(firstReadKeys())}; const time = async (k) => { const t = performance.now(); const r = await browser.storage.local.get(k); return [performance.now() - t, JSON.stringify(r).length]; }; const measure = async () => { const runs = { all: [], first: [] }; for (let i = 0; i < 7; i++) { runs.all.push(await time(null)); runs.first.push(await time(keys)); } const med = (l) => l.map((x) => x[0]).sort((a, b) => a - b)[3].toFixed(1); return 'get(null) ' + med(runs.all) + ' ms, ' + runs.all[0][1] + ' bytes; the first read now ' + med(runs.first) + ' ms, ' + runs.first[0][1] + ' bytes'; }; const stored = JSON.stringify((await browser.storage.local.get('uiTheme')).uiTheme ?? null).length; const builtIn = await measure(); await browser.storage.local.set({ uiTheme: { id: 'big', version: '1', pkg: { id: 'big', manifest: '{}', html: '', css: '', files: { 'fonts/a.woff2': 'A'.repeat(3000000) } } } }); const big = await measure(); return 'the built-in theme stored (' + stored + ' bytes): ' + builtIn + ' | a 3 MB theme stored: ' + big` },
    reload('A'), ready('A'),
    check('A', 'A: its first read took no theme package (a 3 MB one stored)', `!('uiTheme' in Margin.content.getState().state)`),
    boxed('A'),
  ],
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario "${name}"; one of: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(SCENARIOS[name]));
}
