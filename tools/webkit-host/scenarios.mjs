// Scenarios for the WebKit host: steps it plays, and checks that must pass.
// `node scenarios.mjs <name>` prints one as JSON (run.sh does this).
//
// Steps (host.swift):
//   { op: 'open', name, url: '/p/A' | 'ext:<path>', active?, asleep? }  a tab
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
//   { op: 'deferLoads' }       from now on, a tab asleep loads only if it's still the one shown
//                              once the run loop turn is over (Safari putting its load off); its
//                              view is made as it's selected all the same (no page: a script there
//                              gets an error in place of a result, as in Safari)

// Margin's state from storage, by state key (shared/stored.js: the keys
// holding tab ids have names of their own there): an expression for steps.
const STATE = '(async (keys) => { const raw = await browser.storage.local.get(null); const open = raw.openTabs ?? {}; const of = (k) => (["tabs", "tabSpace", "activeSpaceByWindow"].includes(k) ? open[k] : k === "lostTabs" ? raw.lostTabs2 : k === "openTabsBy" ? (raw.openTabs ? { origin: open.origin, synced: open.synced } : null) : raw[k]); return Object.fromEntries([].concat(keys).map((k) => [k, of(k)])); })';
// The id of the tab showing /p/<name>, from Margin's own tab snapshot.
const ID = 'const { tabs } = await ' + STATE + '("tabs"); const id = (n) => Object.values(tabs).find((t) => t.url.endsWith("/p/" + n))?.id;';
const switchTo = (from, to, options = {}) => ({ op: 'eval', in: from, js: `${ID} return JSON.stringify(await Margin.content.send("activateTab", { tabId: id("${to}"), ...${JSON.stringify(options)} }) ?? null)` });
// `js`: an expression, or statements ending in `return …`.
const body = (js) => (/\breturn\b/.test(js) ? js : `return ${js}`);
const check = (tab, label, js, timeout) => ({ op: 'check', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const checkPage = (tab, label, js, timeout) => ({ op: 'checkPage', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const wait = (ms) => ({ op: 'wait', ms });
// In a page step: wheel events with these deltaX, 10ms apart, over the
// new-tab page's sidebar list (as a trackpad sends them); waits for the last.
const SWIPE = (deltas) => `await new Promise((resolve) => { const target = document.querySelector('#sidebar .tabs-section'); const d = ${JSON.stringify(deltas)}; let i = 0; const tick = () => { if (i >= d.length) return resolve(); target.dispatchEvent(new WheelEvent('wheel', { deltaX: d[i++], bubbles: true, cancelable: true, composed: true })); setTimeout(tick, 10); }; tick(); });`;
// Margin drew its sidebar here (the core sets data-open once the theme is mounted).
const drawn = (tab) => checkPage(tab, `${tab}: Margin's sidebar is there`, `document.querySelector('margin-sidebar-host')?.dataset.open !== undefined`, 5000);
const themed = (tab) => check(tab, `${tab}: the Arcadia theme is mounted`, `globalThis.Margin?.theme?.id === 'arcadia'`, 5000);
const shown = (tab) => checkPage(tab, `${tab} is the tab shown`, `!document.hidden`);
// The middle of a tab's row in the sidebar (over its title, clear of its close
// button), for a `mouse` step; through the test hook's __shadowOf (hook.js).
const rowAt = (name) => `${ID} const root = __shadowOf(document.querySelector('margin-sidebar-host')); const r = root.querySelector('.tab[data-tab-id="' + id('${name}') + '"]').getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]`;
// The switch requests a page's sidebar sends from here on (__sent).
const countSends = { op: 'eval', in: 'A', js: `const runtime = (globalThis.browser ?? chrome).runtime; const send = runtime.sendMessage.bind(runtime); globalThis.__sent = []; runtime.sendMessage = (m, ...rest) => { if (m?.type === 'activateTab') __sent.push(m.tabId); return send(m, ...rest); }; return 'counting'` };
const keepOpenIn = (tab) => ({ op: 'eval', in: tab, js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { sidebarPinnedOpen: true } }))' });
const keepOpen = keepOpenIn('A');
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

// Margin's frame fills the window at page zoom `z` (1200x800 at 100%), its
// sidebar at the corner: a check in Margin's world, whose measures are in the
// page's zoomed pixels.
const ZOOMED = (z) => `const r = __shadowOf(document.querySelector('margin-sidebar-host')); const f = r.querySelector('.frame').getBoundingClientRect(); const s = r.querySelector('.window-probe').getBoundingClientRect(); const near = (a, b) => Math.abs(a - b) < 1.5; return near(f.left, 0) && near(f.top, 0) && near(f.width, ${1200 / z}) && near(f.height, ${800 / z}) && near(s.left, 0) && near(s.width, ${1200 / z})`;
const rect = (id) => `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`;
const near = (a, b, by = 2) => `Math.abs((${a}) - (${b})) <= ${by}`;
const openBox = (name, url) => [{ op: 'open', name, url, active: true }, boxed(name)];
const startBoxed = (name, url) => [{ op: 'open', name, url, active: true }, wait(800), { op: 'install' }, drawn(name), themed(name), keepOpenIn(name), boxed(name)];
const tick = 'await new Promise((resolve) => setTimeout(resolve, 80));';
// A real key, no modifiers unless given (arrows: 125 down, 126 up, chars as AppKit's).
const key = (tab, keyCode, chars, mods = []) => ({ op: 'key', in: tab, keyCode, chars: String.fromCharCode(chars), mods });
const ARROW_DOWN = [125, 0xF701];
const ARROW_UP = [126, 0xF700];
const PAGE_DOWN = [121, 0xF72D];
const pressIn = (tab, at) => [{ op: 'mouse', in: tab, type: 'down', at: `return ${JSON.stringify(at)}` }, { op: 'mouse', in: tab, type: 'up' }];

// keep-ready-cap: ten tabs, and in each page's own world a count of the
// keepAwake holds waiting there (tabs.js keepAwake listens for pageswap; the
// test pages have no listener of their own): keep-ready's holds are messages
// to Margin's page now (content/hold.js, counted there: HELD), never a
// script left running in the page's own world (that kept the process at
// foreground priority).
const HOLD_TABS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const HELD = '(Margin.content.holding?.() ?? -1)';
const COUNT_HOLDS = `const live = new Set(); const add = addEventListener, remove = removeEventListener; window.addEventListener = function (type, fn, options) { if (type === 'pageswap') live.add(fn); return add.call(this ?? window, type, fn, options); }; window.removeEventListener = function (type, fn, options) { if (type === 'pageswap') live.delete(fn); return remove.call(this ?? window, type, fn, options); }; window.__holds = () => live.size; return 'counting holds'`;

// wake-wait, wake-cap: a switch to a tab whose wake answers late (as Safari's
// resume of a suspended process makes it wait) keeps the page before on
// screen until it does (tabs.js focusTabNow, mayWait). 60 ms in with no
// answer, the tab is kicked (to the front and the page in front straight
// back, in one turn), its hold sent again, then it's prepared and drawn
// before it's shown once its wake answers
// ('resumed'); one with no answer by 1.6 s is shown then, as it is
// ('capped'). The page before is hidden once (the switch), never by the
// kick; the tab's visibility changes twice for the kick, before its real
// show. The host never suspends a process, so here the page's main thread is
// busy for `ms` from the moment the wake's hold reaches it (keepAwake listens
// for pageswap): the kick can't speed it up, as a foreground resume does in
// Safari. B is shown once first, in the host's tab bar (so Margin knows it
// had a page). The paint barrier after a kick is 150 ms at most (here B's
// first rendering update after its busy spell can come later: ran out, not
// drawn). `ms` null: B isn't busy, and answers in time: not kicked before
// 60 ms (a host too loaded to answer by then may kick it).
const BUSY_AT_HOLD = (ms) => `let armed = true; const add = addEventListener; window.addEventListener = function (type, fn, options) { if (armed && type === 'pageswap') { armed = false; const until = performance.now() + ${ms}; while (performance.now() < until); } return add.call(this ?? window, type, fn, options); }; return 'busy at the next hold'`;
const waitedFor = (ms, outcome, label, entry, kicked = null) => [
  { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
  wait(800), { op: 'install' }, drawn('A'), themed('A'), drawn('B'),
  // (Keep-ready off: a tab it holds isn't waited for.)
  { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { keepLeftTabReadyMinutes: 0 } }))' },
  { op: 'show', name: 'B' }, wait(200), { op: 'show', name: 'A' }, wait(250),
  { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
  { op: 'page', in: 'B', js: ms == null ? `window.__from = __vis.length; return 'not busy'` : `window.__from = __vis.length; ${BUSY_AT_HOLD(ms)}` },
  switchTo('A', 'B'), shown('B'),
  // (The switch log first: the host's background stops about 5 s after it starts.)
  { op: 'eval', in: 'A', js: `${ID} return JSON.stringify((await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch' && e.tabId === id('B')).at(-1))` },
  check('A', `B: ${outcome}: ${label}`, `${ID} const e = (await Margin.content.send('switchLog'))?.filter((x) => x.kind === 'switch' && x.tabId === id('B')).at(-1); return !!e && !e.error && ${outcome ? `e.wakeOutcome === '${outcome}' && ` : ''}${kicked ? `e.kicked?.outcome === '${kicked}' && e.kicked.at < e.shownAfter` : `(!e.kicked || e.kicked.at >= 55)`} && (${entry})`),
  checkPage('A', 'A: hidden once (the switch), not by the kick', `JSON.stringify(__visibility) === '["hidden"]'`),
  ...(kicked
    // (The kick's two changes, then its real show: a page busy as they come
    // reads its state once it gets to them.)
    ? [checkPage('B', 'B: its visibility changed twice for the kick, before its real show', `const v = __vis.slice(__from).filter((e) => e[0] !== 'frame').map((e) => e[0]); return v.length === 3 && v[2] === 'shown'`)]
    : [checkPage('B', 'B: shown last', `const v = __vis.slice(__from).filter((e) => e[0] !== 'frame').map((e) => e[0]); return v.at(-1) === 'shown'`)]),
  noPageErrors('B'),
];
// wake-reveal, wake-space: the sidebar brought out (toggled) wakes the tab
// used before the one in front, and a pointer resting on a space's icon wakes
// that space's most recent tab (sidebar.js); a switch soon after takes the
// wake on, and the switch log says what started it. Keep-ready off (it would
// hold the tab just left, which isn't woken then). Within the host's ~5 s of
// background life.
const CHIP = (name) => `${ID} const { tabSpace } = await ${STATE}('tabSpace'); const root = __shadowOf(document.querySelector('margin-sidebar-host')); const chip = root.querySelector('.chip[data-space-id="' + tabSpace[id('${name}')] + '"]'); chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' })); return 'resting on ' + chip.title`;

// space-press: a press on a space's icon (sidebar.js switchSpace) shows the
// space in the sidebar at once and brings its tab to the front with the
// button still down; the release asks nothing more. Then back, by a click in
// the page that came: the page it left drew the other space as it was
// pressed, and its rows of its own space are there again, the same rows
// (sidebar.js SPACES_KEPT), not built anew; not the space it asked for
// before it went (sidebar.js shownSpace).
// Times (Date.now) are logged: the press, the sidebar showing the space,
// the tab shown. Five tabs in Personal, C in Work. `click`: the button comes
// up 100 ms after it went down (a click as a hand makes it), for timing a
// build that switches on click against this one. Within the host's ~5 s of
// background life (it stalls once in a while near the end, with or without
// this change: nothing after the last switch asks it anything).
const CHIP_AT = (name) => `${ID} const { tabSpace } = await ${STATE}('tabSpace'); const r = __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.chip[data-space-id="' + tabSpace[id('${name}')] + '"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]`;
const TIME_SPACE = (tab, title) => ({ op: 'eval', in: tab, js: `const root = __shadowOf(document.querySelector('margin-sidebar-host')); globalThis.__t = {}; let n = 0; root.addEventListener('pointerdown', () => { __t.press ??= Date.now(); }, true); const sent = (globalThis.browser ?? chrome).runtime; const send = sent.sendMessage.bind(sent); sent.sendMessage = (m, ...rest) => { if (m?.type === 'setSpace') __t.setSpace = ++n; return send(m, ...rest); }; new MutationObserver(() => { if (root.querySelector('.space-title .title')?.textContent === '${title}') __t.title ??= Date.now(); }).observe(root, { subtree: true, childList: true, characterData: true }); return 'timing'` });
const TIME_SHOWN = (tab) => ({ op: 'page', in: tab, js: `window.__shownAt = null; document.addEventListener('visibilitychange', () => { if (!document.hidden) window.__shownAt ??= Date.now(); }); return 'timing'` });
const spacePress = (click = false) => [
  ...['A', 'B', 'D', 'E', 'F', 'C'].map((name, i) => ({ op: 'open', name, url: `/p/${name}`, active: i === 0 })),
  wait(800), { op: 'install', sameId: true }, drawn('A'), themed('A'),
  { op: 'eval', in: 'A', js: `${ID} await Margin.content.send('updateSettings', { patch: { keepLeftTabReadyMinutes: 0 } }); const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('C'), spaceId: work }); Margin.content.sidebar.show('toggle'); return 'C moved to Work'` },
  check('A', 'A: the Work space\'s icon is drawn', `!!__shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.chip[title="Work"]')`, 2000),
  TIME_SPACE('A', 'Work'), TIME_SHOWN('C'), TIME_SPACE('C', 'Personal'), TIME_SHOWN('A'), wait(300), // (the sidebar slides out)
  { op: 'eval', in: 'A', js: `const root = __shadowOf(document.querySelector('margin-sidebar-host')); const rows = root.querySelectorAll('.tabs > .tab'); for (const row of rows) row.__drawnFirst = true; globalThis.__drewWork = false; new MutationObserver(() => { if (root.querySelectorAll('.tabs > .tab').length === 1) __drewWork = true; }).observe(root, { subtree: true, childList: true }); return rows.length + ' rows marked'` },
  { op: 'mouse', in: 'A', type: 'down', at: CHIP_AT('C') },
  ...(click ? [wait(100), { op: 'mouse', in: 'A', type: 'up' }] : []),
  check('A', 'A: Work shown in the sidebar at once', `!!__t.title && __t.title - __t.press < ${click ? 250 : 150}`, 1000),
  checkPage('C', click ? 'C: in front' : 'C: in front with the button still down', '!document.hidden', 2000),
  ...(click ? [] : [{ op: 'mouse', in: 'A', type: 'up' }]),
  wait(300),
  { op: 'eval', in: 'A', js: 'return "A: " + JSON.stringify(__t)' },
  { op: 'page', in: 'C', js: 'return "C shown at " + __shownAt' },
  check('A', 'A: one switch asked (the release asked nothing more)', `__t.setSpace === 1`),
  { op: 'eval', in: 'C', js: `${ID} const e = (await Margin.content.send('switchLog'))?.filter((x) => x.kind === 'switch' && x.tabId === id('C')).at(-1); return 'C switch ' + JSON.stringify(e)` },
  check('C', 'C: shown through Margin, prepared', `${ID} const e = (await Margin.content.send('switchLog'))?.filter((x) => x.kind === 'switch' && x.tabId === id('C')).at(-1); return !!e && !e.error`),
  { op: 'mouse', in: 'C', type: 'down', at: CHIP_AT('A') }, { op: 'mouse', in: 'C', type: 'up' },
  checkPage('A', 'A: back in front', '!document.hidden', 2000),
  wait(200),
  { op: 'eval', in: 'C', js: 'return "C: " + JSON.stringify(__t)' },
  { op: 'page', in: 'A', js: 'return "A shown at " + __shownAt' },
  check('A', 'A: Personal\'s five tabs listed, the rows it drew before (it drew Work\'s since)', `const rows = [...__shadowOf(document.querySelector('margin-sidebar-host')).querySelectorAll('.tabs > .tab')]; return rows.length === 5 && rows.filter((row) => row.__drawnFirst).length >= 4 && __drewWork`, 500),
];

// Sleeping tabs (background/sleep.js): a pass asked for now, for tabs unused
// for a millisecond (the setting is hours), and what it did.
const sleepNow = (tab, label = 'a pass of sleeping tabs') => ({ op: 'eval', in: tab, js: `return JSON.stringify(await Margin.content.send('sleepNow', { afterMs: 1 }))`, label });
// A tab's page is Margin's sleep page, hidden, its record still the page's own.
const asleepAt = (tab, name) => [
  checkPage(tab, `${tab}: on Margin's sleep page, hidden`, `location.pathname === '/sleep/sleep.html' && document.hidden && new URLSearchParams(location.search).get('u').endsWith('/p/${name}')`, 3000),
  check('A', `${tab}: Margin keeps it as its page (its address and title), asleep`, `const { tabs } = await ${STATE}('tabs'); const t = Object.values(tabs).find((x) => x.url.endsWith('/p/${name}')); return !!t && !!t.sleeping && t.title === '${name}'`, 3000),
];
// Back at its page, one history entry (no sleep page in its Back list), its content there.
const awakeAt = (tab, name, label) => checkPage(tab, `${tab}: ${label}`, `location.pathname === '/p/${name}' && history.length === 1 && document.title === '${name}' && !!document.body?.textContent.includes('${name}')`, 4000);

export const SCENARIOS = {
  // Pages open at install get Margin (WebKit adds the core, the background
  // the theme); switching through Margin, including to a tab Safari unloaded.
  switching: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(1000), { op: 'install' },
    drawn('A'), themed('A'), drawn('B'),
    switchTo('A', 'B', { show: 'hover' }), shown('B'),
    checkPage('B', 'B: the carried sidebar is open on its first shown frame', `document.querySelector('margin-sidebar-host')?.dataset.open === 'true'`),
    check('B', 'B: hidden sidebar preparation acknowledged before activation; the switch log has where its time went, and whether keep-ready held the tab', `(await Margin.content.send('switchLog')).some((entry) => entry.source === 'activateTab' && entry.preparation?.outcome === 'ready' && ['lagMs', 'readMs', 'renderMs', 'catchUpMs', 'layoutMs'].every((k) => Number.isFinite(entry.preparation.timings?.[k])) && typeof entry.heldAtAsk === 'boolean')`),
    switchTo('B', 'D'), shown('D'), drawn('D'), themed('D'),
    switchTo('D', 'C'), shown('C'), { op: 'state' },
  ],
  // Safari's update of the tab asked for answers only 4 s later (its process
  // hung, as in Tirth's Safari on 2026-11-03): the page that asked is
  // answered before it stops waiting (3 s here: the host's background lives
  // about 5 s), that the tab is shown (background/tabs.js focusTab), and the
  // tab comes up when Safari gets to it.
  stalled: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), drawn('B'),
    { op: 'stall', name: 'B', ms: 4000 },
    { op: 'eval', in: 'A', js: `${ID} const asked = Date.now(); globalThis.__answer = null; Margin.content.send('activateTab', { tabId: id('B'), deadline: asked + 3000 }).then((r) => { __answer = { r: r ?? null, ms: Date.now() - asked }; }); return 'asked'` },
    check('A', 'A: answered before its 3 s deadline, that B is shown', `${ID} return !!__answer && __answer.ms < 3000 && __answer.r?.shown === id('B')`, 3500),
    { op: 'eval', in: 'A', js: `${ID} return JSON.stringify({ ...__answer, log: (await Margin.content.send('switchLog'))?.filter((e) => e.kind === 'switch' && e.tabId === id('B')).at(-1) ?? null })` },
    checkPage('B', 'B: shown once Safari got to it', '!document.hidden', 3000),
  ],
  // Margin updated while a page with a typed draft is open: the new copy
  // takes over, the draft stays, one sidebar.
  update: [
    { op: 'open', name: 'F1', url: '/p/F1', active: true }, { op: 'open', name: 'A', url: '/p/A' },
    wait(800), { op: 'install', sameId: true }, drawn('F1'),
    { op: 'page', in: 'F1', js: 'document.getElementById("t").value = "unsaved draft"; return "typed"' },
    { op: 'uninstall' }, wait(800), { op: 'install', sameId: true }, themed('F1'),
    { op: 'page', in: 'A', js: 'window.__marginBeforeSwitchOrigin = performance.timeOrigin; return __marginBeforeSwitchOrigin' },
    switchTo('F1', 'A', { show: 'hover' }), shown('A'), wait(3200),
    checkPage('F1', 'F1: the draft is still there', `document.getElementById('t').value === 'unsaved draft'`),
    // The old copy's scripts stay alive and may put its host back, hidden.
    checkPage('F1', 'F1: one sidebar shows (the old copy\'s is hidden)', `[...document.querySelectorAll('margin-sidebar-host')].filter((h) => getComputedStyle(h).display !== 'none').length === 1`),
    drawn('F1'),
    shown('A'),
    checkPage('A', 'A: the selected tab stays selected beyond the stale copy timeout', `!document.hidden`),
    checkPage('A', 'A: selecting it cancels the hidden cleanup reload', `window.__marginBeforeSwitchOrigin === performance.timeOrigin`),
  ],
  // A page an old copy laid out stays out of the page's script's reach.
  'update-old-layout': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800),
    { op: 'page', in: 'A', js: `document.documentElement.setAttribute('data-margin-shell', ''); return 'fitted'` },
    { op: 'page', in: 'B', js: `document.documentElement.setAttribute('data-margin-frameless', ''); return 'test build'` },
    { op: 'install' }, drawn('A'), keepOpen, wait(500),
    checkPage('A', 'A: a fitted page is left alone', `getComputedStyle(document.documentElement).transform === 'none' && !window[Symbol.for('margin.page')]`, 2000),
    checkPage('B', 'B: a page of the frameless test build too', `getComputedStyle(document.documentElement).transform === 'none' && !window[Symbol.for('margin.page')]`, 2000),
  ],
  // The sidebar hidden, frame on (the default): a box at the frame's edge, from
  // the page's registered script after a reload, with no iframe anywhere.
  'hidden-box': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'), boxed('A', 8),
    checkPage('A', 'A: no iframe, no attribute on html for it', `!document.querySelector('iframe') && !document.documentElement.hasAttribute('data-margin-left')`),
    checkPage('A', 'A: fixed things stay in the box', `const f = document.createElement('div'); f.style.cssText = 'position: fixed; left: 0; top: 0; width: 10px; height: 10px'; document.body.append(f); const r = f.getBoundingClientRect(); f.remove(); return r.left === 0 && r.top === 0`),
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { frameWhenHidden: false } }))' },
    bare('A'),
    check('A', 'A: the setting off: no frame', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); return getComputedStyle(r.querySelector('.rims')).display === 'none'`, 2000),
    wait(300), reload('A'), drawn('A'), wait(300), bare('A'),
    checkPage('A', 'A: reloaded with no box: the page\'s world has none of Margin in it', `!window[Symbol.for('margin.page')]`),
  ],
  // Keep open: the box at the sidebar's edge, live, on open pages and new ones;
  // the scroll handed over; a page opened before Margin gets its script injected.
  box: [
    { op: 'open', name: 'A', url: '/p/T', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install' }, drawn('A'), themed('A'), boxed('A', 8),
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
    switchTo('A', 'D'), shown('D'), boxed('D'), themed('D'),
  ],
  // Toggling on an open page, both ways, in the page's own measures.
  toggle: [
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'), keepOpen, boxed('A'),
    { op: 'page', in: 'A', js: `window.scrollTo(0, 200); return 'scrolled'` },
    { op: 'eval', in: 'A', js: `return JSON.stringify(await Margin.content.send("updateSettings", { patch: { frameWhenHidden: false } }))` }, wait(100),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.toggle(); return 'off'` },
    bare('A'),
    checkPage('A', 'A: off: the place kept, on <html> again', `document.documentElement.scrollTop === 200 && scrollY === 200`, 1500),
    checkPage('A', 'A: off: a rule about the window asks about it again', `getComputedStyle(document.getElementById('wide')).color !== 'rgb(1, 2, 3)' && Math.round(document.getElementById('full').getBoundingClientRect().width) === 1200`, 1500),
    keepOpen, boxed('A'),
    checkPage('A', 'A: on again: the place kept, on body', `document.body.scrollTop === 200`, 1500),
  ],
  // A page under a strict CSP: the box, the shims and the sheets all work.
  csp: [
    { op: 'open', name: 'A', url: '/csp/A', active: true }, wait(800), { op: 'install' }, drawn('A'), boxed('A', 8), keepOpen, boxed('A'),
    wait(300), reload('A'), boxed('A'), themed('A'),
    checkPage('A', 'A: its sheet rewritten (CSSOM passes a strict CSP)', `getComputedStyle(document.getElementById('wide')).color === 'rgb(1, 2, 3)'`, 2000),
  ],
  // The page's own scroll locks, read from computed style, and a modal in the box.
  lock: [
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' }, drawn('A'), boxed('A', 8), keepOpen, boxed('A'),
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
    { op: 'eval', in: 'W', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { themes: { arcadia: { sidebarWidth: 360 } } } }))' },
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
    { op: 'eval', in: 'M', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { themes: { arcadia: { sidebarWidth: 360 } } } }))' },
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
  // The new-tab page loads the active theme's module.
  newtab: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, wait(2000),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: Arcadia\'s launcher is drawn', `!!document.querySelector('#launcher')`, 5000),
    checkPage('N', 'N: its sidebar lists the tabs', `document.querySelectorAll('#sidebar .tab').length >= 2`),
    checkPage('N', 'N: Settings shows the theme', `document.querySelector('#theme')?.value === 'arcadia'`),
  ],
  // Swiping between spaces in the sidebar (the new-tab page's: the same code
  // as on pages, whose sidebar is in a closed shadow root): a trackpad-like
  // run of wheel events with momentum (released on its decay, the rest landing
  // while it slides) switches to the next space and brings its tab to the
  // front; a short slow one doesn't.
  spaces: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install' }, wait(2000),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: its sidebar is drawn', `!!document.querySelector('#sidebar .space-pane')`, 5000),
    { op: 'page', in: 'N', js: `${ID} const work = (await browser.runtime.sendMessage({ type: 'createSpace', name: 'Work', emoji: '💼' })).result.spaceId; await browser.runtime.sendMessage({ type: 'moveTabToSpace', tabId: id('B'), spaceId: work }); return work` },
    wait(800),
    { op: 'page', in: 'N', js: `${SWIPE([3, 2, 3, 2])} return 'short'` }, wait(800),
    checkPage('N', 'a short slow swipe stays in the space', `document.querySelector('#sidebar .space-title .title')?.textContent === 'Personal' && !document.querySelector('.ghost')`),
    // The titles shown as it happens (the page is hidden a moment later, as B
    // comes to the front, and its timers slow down: read then, it says little).
    { op: 'page', in: 'N', js: `const title = () => document.querySelector('#sidebar .space-title .title')?.textContent; window.__titles = [{ t: performance.now(), title: title() }]; new MutationObserver(() => __titles.push({ t: performance.now(), title: title() })).observe(document.getElementById('sidebar'), { subtree: true, childList: true, characterData: true }); window.__flickAt = performance.now(); ${SWIPE([6, 14, 22, 19, 17, 15, 13, 11.5, 10, 9, 8, 7, 6, 5.2, 4.5, 3.9, 3.4])} return 'flick'` },
    checkPage('N', 'a flick shows the next space at once', `__titles.some((x) => x.title === 'Work' && x.t - __flickAt < 1000)`, 2000),
    shown('B'),
    check('B', 'B: the window is on Work', `const s = await ${STATE}(['spaces', 'activeSpaceByWindow']); return Object.values(s.activeSpaceByWindow ?? {}).some((id) => s.spaces.find((x) => x.id === id)?.name === 'Work')`),
  ],
  // Page zoom (⌘+): Margin's UI keeps its size (its host scaled back), and
  // the page's box follows the sidebar's width in the page's zoomed pixels;
  // the new-tab page's sidebar too.
  zoom: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(1000),
    { op: 'snapshot', file: new URL('build/zoom-100.png', import.meta.url).pathname },
    { op: 'zoom', factor: 1.5 },
    checkPage('A', 'Margin scaled back, the box at 260/1.5', `const h = document.querySelector('margin-sidebar-host'); ${AT} return Math.abs(parseFloat(getComputedStyle(h).zoom) - 1 / 1.5) < 0.001 && Math.abs(at.x - 260 / 1.5) < 0.5`, 3000),
    { op: 'snapshot', file: new URL('build/zoom-150.png', import.meta.url).pathname },
    check('A', 'the sidebar and frame at the window\'s corner, the frame its size, the hole on the page', ZOOMED(1.5), 3000),
    { op: 'zoom', factor: 0.75 },
    check('A', 'at 75% too', ZOOMED(0.75), 3000),
    { op: 'zoom', factor: 1 },
    checkPage('A', 'back to 100%: no scaling, the box at 260', `const h = document.querySelector('margin-sidebar-host'); ${AT} return !h.style.zoom && at.x === 260`, 3000),
    { op: 'zoom', factor: 1.5 }, wait(300),
    // Reloaded at 150%: the site's zoom is remembered, so Margin is drawn at
    // its size from its first render (before the browser has answered).
    reload('A'), drawn('A'),
    checkPage('A', 'reloaded at 150%: scaled back as soon as drawn', `Math.abs(parseFloat(getComputedStyle(document.querySelector('margin-sidebar-host')).zoom) - 1 / 1.5) < 0.001`, 100),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: drawn', `!!document.querySelector('#sidebar .space-pane')`, 5000),
    { op: 'zoom', factor: 1.5 },
    checkPage('N', 'N: its sidebar scaled back', `Math.abs(parseFloat(document.getElementById('sidebar').style.zoom) - 1 / 1.5) < 0.001`, 3000),
    { op: 'snapshot', file: new URL('build/zoom-150-newtab.png', import.meta.url).pathname },
  ],
  // Tab ids: the same while a tab sleeps and wakes or reloads; all new when
  // Margin is updated (a new copy). Tabs keep their spaces either way
  // (state/model.js syncTabs matches them by address).
  tabids: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(1500),
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
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(1500),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: false }, wait(1000),
    { op: 'page', in: 'N', js: 'await browser.storage.local.set({ tabs: { 999: { id: 999, windowId: 998, index: 0, url: "http://example.com/", title: "old copy", active: true } }, tabSpace: { 999: "personal" }, activeSpaceByWindow: { 998: "personal" } }); return "an old copy wrote its tabs"' }, wait(800),
    check('A', 'A: its sidebar still lists the tabs by ids its copy has', `const { state } = Margin.content.getState(); const urls = Object.values(state.tabs).map((t) => t.url); return !state.tabs[999] && urls.some((u) => u.endsWith('/p/A')) && urls.some((u) => u.endsWith('/p/B'))`),
    switchTo('A', 'B'), shown('B'),
    { op: 'page', in: 'N', js: 'const { openTabs } = await browser.storage.local.get("openTabs"); await browser.storage.local.set({ openTabs: { ...openTabs, synced: false } }); return "not matched yet"' },
    checkPage('B', 'B: Margin shows it is getting ready', `document.querySelector('margin-sidebar-host')?.dataset.startup === 'true'`, 2000),
    { op: 'page', in: 'N', js: 'const { openTabs } = await browser.storage.local.get("openTabs"); await browser.storage.local.set({ openTabs: { ...openTabs, synced: true } }); return "matched"' },
    checkPage('B', 'B: and stops once it is ready', `document.querySelector('margin-sidebar-host')?.dataset.startup === 'false'`, 2000),
    { op: 'page', in: 'N', js: 'const { owner } = await browser.storage.local.get("owner"); await browser.storage.local.set({ owner: { origin: "webkit-extension://a-newer-copy/", since: owner.since + 1000 } }); return "a newer copy took over"' },
    check('B', 'B: this copy stands back for the newer one, saying why', `(globalThis.__marginLog ?? []).some((l) => l.includes('stays out of the way')) && !Margin.content.active()`, 3000),
    checkPage('N', 'its background says so', `(await browser.runtime.sendMessage({ type: 'owner' }))?.stale === true`),
  ],
  // A Safari relaunch: every tab comes back asleep with new ids, the one in
  // front loads; tabs keep their spaces, the page in front shows Margin
  // getting ready until its copy has matched the tabs (Margin allowed late,
  // as an unsigned build is), and switching works after.
  relaunch: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(1500),
    { op: 'eval', in: 'A', js: `${ID} const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('B'), spaceId: work }); return 'B moved to Work'` }, wait(800),
    { op: 'restart', late: true, lateMs: 800 }, drawn('A'),
    check('A', 'A: Margin waited for its copy to match the tabs, then was ready', `const log = globalThis.__marginLog ?? []; return log.some((l) => l.includes('getting ready: waiting')) && log.some((l) => l.includes('getting ready: done')) && document.querySelector('margin-sidebar-host')?.dataset.startup !== 'true'`, 6000),
    check('A', 'A: B is still in Work, A in Personal, under their new ids', `const s = await ${STATE}(['tabs', 'tabSpace', 'spaces', 'openTabsBy']); const of = (n) => { const t = Object.values(s.tabs).find((x) => x.url.endsWith('/p/' + n)); return t && s.spaces.find((sp) => sp.id === s.tabSpace[t.id])?.name; }; return s.openTabsBy?.synced && of('B') === 'Work' && of('A') === 'Personal'`, 5000),
    switchTo('A', 'C'), shown('C'), drawn('C'),
    switchTo('C', 'B'), shown('B'), drawn('B'),
  ],
  // The tab in front at a Safari relaunch loads with its view in the window
  // before its process exists: WebKit never marks it as having been in a
  // window, and its first return showed Safari's empty view until it painted
  // (here 6–14 ms without the introduction, 3 runs; 40–87 ms in an earlier
  // host test; four shows of 49–155 ms in Tirth's Safari). Its page, made from
  // the tab's saved history as Safari makes it, says it started visible and
  // never came into view from hidden (content/core.js windowSeen), so Margin
  // introduces it before that return: its content there within a few ms
  // (1–2 ms with it). Within about 4 s of the restart (README.md).
  unseen: [
    { op: 'open', name: 'H', url: '/p/H2', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('H'), wait(1500),
    { op: 'restart' }, drawn('H'),
    checkPage('H', 'H: loaded in front at the relaunch, from its saved history (as Safari restores a tab)', `window.__vis[0][0] === 'shown' && performance.getEntriesByType('navigation')[0].type === 'back_forward'`),
    check('H', 'H: Margin ready, its copy matched to the tabs', `return document.querySelector('margin-sidebar-host')?.dataset.startup !== 'true' && (await ${STATE}('openTabsBy')).openTabsBy?.synced === true`, 3000),
    switchTo('H', 'B'), shown('B'),
    { op: 'probeShow', name: 'H', nth: 2 }, // the first is its introduction
    switchTo('B', 'H2'), shown('H'),
    { op: 'checkProbe', name: 'H', maxMs: 4, label: 'H: its content there on its first return (introduced first)' },
    check('H', 'H: the switch says its page was unseen and it introduced it', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.introduced === true && e.unseen === true && !e.error)`),
    noPageErrors('H'),
  ],
  // A Safari relaunch with tabs it unloaded (all but the one in front): the
  // repair of the open tabs asks each of them once, in its first pass, and
  // no pass after asks them again (background/tabs.js injectIntoOpenTabs:
  // after a relaunch on 2026-11-03, twice per pass over four passes); a
  // click as Margin starts isn't held up behind it, and the unloaded tab it
  // asks for is restored behind the page. The tab in front (no page yet at
  // the first pass) and the one switched to are asked again once loaded.
  // Within about 4 s of the restart (README.md): the last pass isn't seen.
  restartrepair: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, { op: 'open', name: 'D', url: '/p/D' }, { op: 'open', name: 'E', url: '/p/E' },
    wait(800), { op: 'install', sameId: true }, drawn('A'), wait(1500),
    { op: 'restart' }, drawn('A'),
    switchTo('A', 'C'), shown('C'), drawn('C'),
    check('C', 'C: the repair asked each tab Safari unloaded once (its first pass), none again after', `const log = await Margin.content.send('switchLog'); const at = log.findLastIndex((e) => e.kind === 'repair' && e.pass === 0); const passes = log.slice(at).filter((e) => e.kind === 'repair'); return at >= 0 && passes[0].noPage >= 3 && passes.length >= 2 && passes.slice(1).every((e) => e.noPage === 0) && passes.slice(1).reduce((n, e) => n + e.asked, 0) <= 2`, 2500),
    check('C', 'C: its switch started in time (not expired before it), restored behind the page', `const log = await Margin.content.send('switchLog'); const start = log.findLast((e) => e.kind === 'repair' && e.pass === 0)?.at ?? Infinity; const since = log.filter((e) => e.kind === 'switch' && e.at > start - 5000); const last = since.at(-1); return !since.some((e) => e.error === 'expired') && last?.restored != null && last?.before != null`),
    noPageErrors('C'),
  ],
  // A hidden tab prepared from the state it has: it heard every write since its
  // last read (the background's `rev` is the one it saw last), so it draws
  // without reading storage (content/core.js prepareForShow, timings.known),
  // and its first shown frame has its own row highlighted and a setting
  // changed in another tab while it was hidden. A preparation with a rev it
  // didn't see reads.
  prepared: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
    wait(800), { op: 'install', sameId: true }, drawn('A'), themed('A'), drawn('B'), drawn('C'),
    { op: 'eval', in: 'B', js: `${ID} const me = String(id('B')); const root = __shadowOf(document.querySelector('margin-sidebar-host')); globalThis.__atShow = null; document.addEventListener('visibilitychange', () => { if (!document.hidden && !__atShow) __atShow = { me, active: root.querySelector('.tab.active')?.dataset.tabId ?? null, open: document.querySelector('margin-sidebar-host')?.dataset.open }; }, true); return 'recording'` },
    // Each switch a moment after the one before, as a person makes them. One
    // asked while the last one's write is still under way (a loaded Mac) reads,
    // as before: no rev sent (store.js stateRev).
    keepOpen, wait(150),
    switchTo('A', 'B'), shown('B'),
    { op: 'eval', in: 'B', js: 'return JSON.stringify(__atShow)' },
    check('B', 'B: its first shown frame has its own row highlighted, and Keep open (changed while it was hidden)', `__atShow?.active === __atShow?.me && __atShow?.open === 'true'`),
    wait(150), switchTo('B', 'C'), shown('C'),
    wait(150), switchTo('C', 'A'), shown('A'),
    { op: 'eval', in: 'A', js: `return JSON.stringify((await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch').map((e) => ({ tabId: e.tabId, outcome: e.preparation?.outcome, ms: e.preparation?.ms, timings: e.preparation?.timings, shownAfter: e.shownAfter })))` },
    check('A', 'A: the three switches were prepared from the state each page had (no storage read), but where the last write was still under way', `const log = (await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch').slice(-3); return log.length === 3 && log.every((e) => !e.error && e.preparation?.outcome === 'ready' && (e.preparation.timings?.known === 1 ? e.preparation.timings.readMs === 0 : e.preparation.timings?.revSent === 0)) && log.some((e) => e.preparation.timings.known === 1)`),
    check('B', 'B: a preparation with a rev it didn\'t see reads storage', `const { tabId, windowId } = Margin.content.getState(); const answer = await Margin.content.prepareForShow({ token: 'other', tabId, windowId, rev: 'not-seen' }); Margin.content.cancelPreparedShow('other'); return answer.ready === true && answer.timings.known === 0`),
    // Called off before it took the page (the background's cancel for a switch
    // superseded, or past its budget, landing during the preparation's first
    // turn): it stops there, its carried sidebar never opened and no token
    // left for shown() to take (a second cancel finds none). Last, so it
    // doesn't shift the switches above in time.
    check('C', 'C: a preparation called off as soon as it was sent stops, and leaves nothing for a later show', `const { tabId, windowId } = Margin.content.getState(); const pending = Margin.content.prepareForShow({ token: 'off', tabId, windowId, carry: 'hover', rev: 'not-seen' }); Margin.content.cancelPreparedShow('off'); const answer = await pending; await new Promise((r) => setTimeout(r, 50)); return answer.ready === false && Margin.content.cancelPreparedShow('off') === false`),
  ],
  // A hidden tab whose page's world put work off until it's in sight: a sheet
  // added while hidden (its query not yet rewritten for the box, and a read of
  // <body> it asks for), and its box moved by the preparation itself (Keep open
  // turned on in another tab). Done in the preparation (content/page/box.js
  // catchUp), so all of it is there as the tab comes into view, before any of
  // Margin's own show handlers run, not a frame or more after.
  catchup: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), drawn('B'), keepOpen, boxed('A'),
    { op: 'page', in: 'B', js: `document.body.insertAdjacentHTML('beforeend', '<div id=x>x</div>'); window.__mq = matchMedia('(min-width: 1100px)'); window.__resized = 0; addEventListener('resize', () => __resized++); addEventListener('visibilitychange', () => { if (!document.hidden && !window.__atShow) window.__atShow = { at: performance.now(), resized: __resized, mq: __mq.matches, width: innerWidth, pad: getComputedStyle(document.body).paddingLeft, color: getComputedStyle(document.getElementById('x')).color }; }, true); document.head.append(Object.assign(document.createElement('style'), { textContent: 'body { margin: 0 0 0 40px } @media (max-width: 1000px) { #x { color: rgb(1, 2, 3) } }' })); return document.hidden ? 'hidden, styled' : 'shown?'` },
    wait(300),
    switchTo('A', 'B'), shown('B'),
    { op: 'page', in: 'B', js: 'return JSON.stringify(window.__atShow)' },
    checkPage('B', 'B: its box moved and rested before it came into view (the media list followed, one resize)', `__atShow.mq === false && __atShow.resized === 1 && __atShow.width === 1200 - 260 - 8`, 1000),
    checkPage('B', 'B: the sheet added while hidden was rewritten for the box before it came into view', `__atShow.color === 'rgb(1, 2, 3)'`, 1000),
    checkPage('B', 'B: the read it asked for was made before it came into view', `__atShow.pad === '40px'`, 1000),
    checkPage('B', 'B: and as it stays', `__resized === 1 && getComputedStyle(document.body).paddingLeft === '40px' && getComputedStyle(document.getElementById('x')).color === 'rgb(1, 2, 3)'`, 1000),
    { op: 'eval', in: 'B', js: `return JSON.stringify((await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch').map((e) => e.preparation))` },
  ],
  // The same move of a hidden tab's box, on a page whose own resize listener
  // takes 1.2 s (longer than any preparation may): the page's listeners run
  // in a task of their own, not in the preparation the background waits for,
  // so it answers in time and the sidebar carried is open as the tab comes
  // into view (a late one is cancelled, which closes it).
  'catchup-slow': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), drawn('B'),
    // B shown once by Margin (introduced: open at install, Margin has no proof
    // WebKit has seen it in a window), so the switch below goes to a tab it knows.
    switchTo('A', 'B'), shown('B'), switchTo('B', 'A'), shown('A'),
    keepOpen, boxed('A'),
    { op: 'page', in: 'B', js: `window.__resized = 0; addEventListener('resize', () => { if (__resized++) return; const until = performance.now() + 1200; while (performance.now() < until); }); const open = () => document.querySelector('margin-sidebar-host')?.dataset.open; addEventListener('visibilitychange', () => { if (document.hidden || window.__atShow) return; window.__atShow = { open: open() }; requestAnimationFrame(() => requestAnimationFrame(() => { __atShow.later = open(); })); }, true); return document.hidden ? 'hidden, slow' : 'shown?'` },
    { op: 'eval', in: 'B', js: `const cancel = Margin.content.cancelPreparedShow; globalThis.__cancelled = 0; Margin.content.cancelPreparedShow = (token) => { __cancelled++; return cancel(token); }; return 'counting'` },
    wait(300),
    switchTo('A', 'B', { show: 'hover' }), shown('B'),
    checkPage('B', 'B: the sidebar it carried is open as it comes into view, and a frame after', `__atShow.open === 'true' && __atShow.later === 'true'`, 3000),
    check('B', 'B: its preparation wasn\'t cancelled (late)', `__cancelled === 0`),
    checkPage('B', 'B: its own resize listener ran, once', `__resized === 1`, 3000),
    { op: 'page', in: 'B', js: 'return JSON.stringify(window.__atShow)' },
  ],
  // A preparation with little time left before the background stops waiting
  // leaves the catch-up to the show; one with time does it, the page's resize
  // event in a task right after the answer.
  'catchup-late': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), drawn('B'), keepOpen, boxed('A'), wait(300),
    { op: 'page', in: 'B', js: `window.__resized = 0; addEventListener('resize', () => __resized++); return document.hidden ? 'hidden' : 'shown?'` },
    { op: 'eval', in: 'B', js: `const { windowId, tabId } = Margin.content.getState(); const answer = await Margin.content.prepareForShow({ token: 'late', tabId, windowId, until: Date.now() + 100 }); Margin.content.cancelPreparedShow('late'); return JSON.stringify(answer)` },
    wait(200),
    checkPage('B', 'B: prepared with 100 ms left: no catch-up (the page not yet told of its box)', `document.hidden && __resized === 0`, 500),
    { op: 'eval', in: 'B', js: `const { windowId, tabId } = Margin.content.getState(); let during = 0; const count = () => during++; addEventListener('resize', count); const answer = await Margin.content.prepareForShow({ token: 'early', tabId, windowId, until: Date.now() + 900 }); removeEventListener('resize', count); globalThis.__resizedDuring = during; Margin.content.cancelPreparedShow('early'); return JSON.stringify({ answer, during })` },
    check('B', 'B: prepared with time: the page\'s resize event not inside the preparation', `__resizedDuring === 0`),
    checkPage('B', 'B: and right after it, still hidden, once', `document.hidden && __resized === 1`, 1000),
  ],
  // A tab loaded behind the page and shown for the first time (opened after
  // Margin started: introduced, arriving covered, as real tabs are): what
  // changed on its <html> or <body> while it was hidden (Margin's own mark,
  // the placeholder handed over: content/layout.js syncPlaceholder; a page's
  // class; the cover's style) asks for a read of <body>. Made in the
  // preparation, not as it comes into view (1 ms after the show, before its
  // first frame, in 3 runs before).
  'catchup-loaded': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'),
    { op: 'open', name: 'B', url: '/p/B' }, drawn('B'), wait(300),
    { op: 'page', in: 'B', js: `window.__ev = []; new MutationObserver((r) => { for (const x of r) for (const n of x.addedNodes) if (n.localName === 'margin-read') __ev.push(['read', performance.now(), document.hidden]); }).observe(document.documentElement, { childList: true }); addEventListener('visibilitychange', () => __ev.push([document.hidden ? 'hidden' : 'shown', performance.now()]), true); return 'watching'` },
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('B') }); Margin.content.startSwitching(id('B'), request); return JSON.stringify(await request)` },
    shown('B'),
    check('B', 'B: introduced first, then prepared covered', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.introduced === true && e.preparation?.outcome === 'ready' && !e.error)`, 2000),
    wait(300),
    { op: 'page', in: 'B', js: 'return JSON.stringify(__ev.map(([what, at, hidden]) => [what, Math.round(at), hidden]))' },
    checkPage('B', 'B: its <html> marked while hidden (the placeholder handed over)', `document.documentElement.dataset.marginDocked === 'off'`),
    checkPage('B', 'B: the read made while hidden, none as it came into view', `const shownAt = __ev.findLast((e) => e[0] === 'shown')?.[1]; return shownAt > 0 && __ev.some(([what, at, hidden]) => what === 'read' && hidden && at < shownAt) && !__ev.some(([what, at]) => what === 'read' && at >= shownAt && at < shownAt + 100)`, 300),
  ],
  // A page that navigated in front (a link, the address bar), in a tab WebKit
  // had already seen in the window: its first return isn't introduced, as
  // WebKit holds the page before for its paint (its mark is the tab's web
  // view's, kept through its navigations). Margin first proves the tab has it:
  // A, in front at install, is introduced on its first return (Margin has no
  // proof of it: background/tabs.js WebKit's mark), then navigates in front;
  // its return to the new page isn't.
  navigated: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('A'), drawn('B'), wait(300),
    switchTo('A', 'B'), shown('B'), switchTo('B', 'A'), shown('A'),
    check('A', 'A: its first return introduced (no proof of it yet)', `${ID} const log = (await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch' && e.tabId === id('A')); return log.at(-1)?.introduced === true && !log.at(-1)?.error`),
    { op: 'page', in: 'A', js: `location.href = '/p/A2'; return 'navigating'` }, checkPage('A', 'A: at its new address', `location.pathname === '/p/A2'`, 2000), drawn('A'),
    switchTo('A', 'B'), shown('B'),
    switchTo('B', 'A2'), shown('A'),
    { op: 'eval', in: 'A', js: `return JSON.stringify((await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch').slice(-2).map((e) => ({ introduced: e.introduced, markReason: e.markReason, layersBack: e.layersBack, shownAfter: e.shownAfter })))` },
    check('A', 'A: its return to the new page not introduced (proven, kept through the link), nor B\'s', `${ID} const log = (await Margin.content.send('switchLog')).filter((e) => e.kind === 'switch').slice(-2); return log.length === 2 && log.every((e) => e.introduced === false && String(e.markReason).startsWith('proven:') && !e.error)`),
  ],
  // The tab in front at a relaunch (unseen above) going to another page in
  // front before it's first left (a link, a reload, a script's redirect): the
  // new page doesn't know the tab started unseen (it navigated in front), but
  // WebKit's mark is the tab's and still unset. The background remembers it
  // from the first page's start (background/tabs.js pageStarted), so its first
  // return is introduced all the same. Within about 4 s of the restart.
  unseennav: [
    { op: 'open', name: 'H', url: '/p/H2', active: true }, { op: 'open', name: 'B', url: '/p/B' }, wait(800), { op: 'install', sameId: true }, drawn('H'), wait(1500),
    { op: 'restart' }, drawn('H'),
    checkPage('H', 'H: loaded in front at the relaunch, from its saved history', `window.__vis[0][0] === 'shown' && performance.getEntriesByType('navigation')[0].type === 'back_forward'`),
    { op: 'page', in: 'H', js: `location.href = '/p/H3'; return 'navigating'` }, checkPage('H', 'H: at its new address, loaded in front', `location.pathname === '/p/H3' && performance.getEntriesByType('navigation')[0].type === 'navigate'`, 2000), drawn('H'),
    check('H', 'H: its new page counts itself as seen (it navigated in front)', `globalThis.Margin.content.windowSeen() === true`),
    check('H', 'H: Margin ready, its copy matched to the tabs', `return document.querySelector('margin-sidebar-host')?.dataset.startup !== 'true' && (await ${STATE}('openTabsBy')).openTabsBy?.synced === true`, 3000),
    switchTo('H', 'B'), shown('B'),
    { op: 'probeShow', name: 'H', nth: 2 }, // the first is its introduction
    switchTo('B', 'H3'), shown('H'),
    { op: 'checkProbe', name: 'H', maxMs: 4, label: 'H: its content there on its first return (introduced first)' },
    check('H', 'H: the switch introduced it as unseen', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.introduced === true && e.unseen === true && !e.error)`),
  ],
  // A page left takes its listeners off browser.* events (WebKit kept them, and
  // the page, after it went through the back/forward cache); back from the
  // cache, it has them again: a change in storage reaches it.
  bfcache: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'),
    { op: 'page', in: 'A', js: `window.__before = 1; setTimeout(() => { location.href = '/p/A2'; }); return 'navigating'` },
    checkPage('A', 'A: at its next page', `location.pathname === '/p/A2'`, 2000), drawn('A'),
    { op: 'page', in: 'A', js: `setTimeout(() => history.back()); return 'back'` },
    checkPage('A', 'A: back to its first page, from the back/forward cache', `location.pathname === '/p/A' && window.__before === 1`, 2000),
    wait(600),
    { op: 'eval', in: 'A', js: `const { settings } = await browser.storage.local.get('settings'); await browser.storage.local.set({ settings: { ...settings, sidebarPinnedOpen: true } }); return 'kept open in storage'` },
    boxed('A'),
  ],
  // A switch to a tab Safari unloaded (background/tabs.js restoreTab): loaded
  // behind the page first (brought to the front and the page straight back, in
  // one run loop turn: Safari loads a tab as it's selected), the page staying
  // in front meanwhile; then introduced (its first instant in the window, with
  // no process yet, doesn't count for WebKit) and shown, its sidebar prepared
  // (its own tab and space, carried open): its content there as it comes up.
  // (Without the introduction, 13–24 ms of WebKit's empty view here.)
  // Soon after install: a second later the switch ran into the background's stop,
  // about 5 s after it starts (README.md), and failed at random.
  unloaded: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(250),
    { op: 'eval', in: 'A', js: `${ID} const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('D'), spaceId: work }); return 'D moved to Work'` }, wait(300),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    { op: 'probeShow', name: 'D', nth: 3 }, // the first is the restore, the second the introduction
    switchTo('A', 'D', { show: 'toggle' }), shown('D'), drawn('D'),
    { op: 'checkProbe', name: 'D', maxMs: 10, label: 'D: its content there as it\'s shown (no empty frame worth a screen refresh)' },
    checkPage('D', 'D: loaded behind before it was shown (hidden from its start)', `window.__vis[0][0] === 'hidden' && window.__vis.some((e) => e[0] === 'shown')`),
    checkPage('A', 'A: hidden once (the switch), not by the restore or the introduction', `JSON.stringify(__visibility) === '["hidden"]'`),
    checkPage('D', 'D: the sidebar was carried open', `document.querySelector('margin-sidebar-host')?.dataset.open === 'true'`, 3000),
    check('D', 'D: the window is on Work', `const s = await ${STATE}(['spaces', 'activeSpaceByWindow']); return Object.values(s.activeSpaceByWindow ?? {}).some((id) => s.spaces.find((x) => x.id === id)?.name === 'Work')`),
  ],
  // The same with a page heavy to paint: covered before its introduction
  // (background/tabs.js coverArrival), so that instant's paint, and the
  // show's, are the cover's, quick (a heavy page's own first paint took
  // 70–300 ms in Safari's log, longer than Margin waits after introducing).
  unloadedheavy: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'H', url: '/p/H1', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    { op: 'probeShow', name: 'H', nth: 3 }, // restored, introduced, shown
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('H1') }); Margin.content.startSwitching(id('H1'), request); return 'asked for H'` },
    checkPage('A', 'A: left', 'document.hidden', 4000), shown('H'),
    { op: 'checkProbe', name: 'H', maxMs: 10, label: 'H: its content there as it\'s shown' },
    checkPage('H', 'H: loaded behind before it was shown', `window.__vis[0][0] === 'hidden'`),
    checkPage('A', 'A: hidden once (the switch), not by the restore or the introduction', `JSON.stringify(__visibility) === '["hidden"]'`),
    check('H', 'H: its page back once shown (the arrival cover lifted)', `const h = document.querySelector('margin-sidebar-host'); return !document.hidden && h.dataset.arrivalCover === 'false' && getComputedStyle(document.body).opacity === '1'`, 3000),
  ],
  // The sidebar hidden: the frame around the page, in thin strips, the page
  // inside it and the pointer through it. Keep open turned off: the sidebar
  // slides away with the frame's edge, then the strips take over.
  'closed-frame': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'),
    check('A', 'A: the strips show at rest, the full frame doesn\'t', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); return getComputedStyle(r.querySelector('.rims')).display === 'block' && getComputedStyle(r.querySelector('.frame')).visibility === 'hidden'`, 3000),
    boxed('A', 8),
    keepOpen, wait(800),
    check('A', 'A: Keep open: the frame at the sidebar, no strips', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); return getComputedStyle(r.querySelector('.rims')).display === 'none' && r.querySelector('.frame .hole').getBoundingClientRect().left === 260`, 3000),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.toggle(); return 'off'` }, wait(90), // as the shortcut does: the setting's write comes back on the way
    check('A', 'A: on its way: the edge between the sidebar and the frame', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); const left = r.querySelector('.frame .hole').getBoundingClientRect().left; return left > 8 && left < 260 && r.querySelector('.margin-sidebar').getBoundingClientRect().right > 0`, 150),
    check('A', 'A: at rest again: the strips, the sidebar away, the frame at 8px', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); return getComputedStyle(r.querySelector('.rims')).display === 'block' && r.querySelector('.margin-sidebar').getBoundingClientRect().right <= 0 && !r.querySelector('.margin-sidebar').classList.contains('leaving')`, 1500),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.show('hover'); return 'hovered'` }, wait(300),
    boxed('A', 8),
    check('A', 'A: the floating sidebar has the card\'s corners', `getComputedStyle(__shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.margin-sidebar')).borderTopLeftRadius === '6.25px'`),
    // Keep open from the floating sidebar's button: off to the left, then in from the left with the edge.
    { op: 'eval', in: 'A', js: `__shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.keep-open').click(); return 'pressed'` },
    check('A', 'A: Keep open: the floating sidebar goes left first', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); const s = r.querySelector('.margin-sidebar'); return !s.classList.contains('open') && !s.classList.contains('docked') && s.getBoundingClientRect().left < 8`, 500),
    check('A', 'A: then the docked sidebar comes in with the edge, the page moved', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); const s = r.querySelector('.margin-sidebar'); const b = s.getBoundingClientRect(); const left = r.querySelector('.frame .hole').getBoundingClientRect().left; return s.classList.contains('arriving') && b.left < 0 && left > 8 && left < 260`, 600),
    check('A', 'A: docked: flush, the edge at the sidebar, no animation left', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); const s = r.querySelector('.margin-sidebar'); return s.getBoundingClientRect().left === 0 && r.querySelector('.frame .hole').getBoundingClientRect().left === 260 && !s.classList.contains('arriving') && document.querySelector('margin-sidebar-host').dataset.box === '260'`, 1500),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.toggle(); return 'off'` }, wait(500),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.hide(); return JSON.stringify(await Margin.content.send("updateSettings", { patch: { frameWhenHidden: false } }))` },
    bare('A'),
    check('A', 'A: the setting off: no frame', `const r = __shadowOf(document.querySelector('margin-sidebar-host')); return getComputedStyle(r.querySelector('.rims')).display === 'none' && getComputedStyle(r.querySelector('.frame')).visibility === 'hidden'`, 2000),
  ],
  // A pinch. On a page with no box: Safari's own, smooth, Margin out of it,
  // except what would open the overview. With one: Margin's (pinch-box).
  pinch: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'),
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
  // On a page with a box: the page scales at <html>, the sidebar and the frame
  // stay as they are, clicks land, two fingers move it, then scroll it.
  'pinch-box': [
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'), wait(300),
    keepOpen, boxed('A'), wait(500),
    { op: 'pinch', deltas: Array(14).fill(0.03), x: 700, y: 400 }, wait(100),
    checkPage('A', 'zoomed by Margin, not by Safari', `${AT} return at.scale > 1.2 && visualViewport.scale === 1`, 800),
    check('A', 'the sidebar stays where it is, at its size', `const b = __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.margin-sidebar').getBoundingClientRect(); return Math.abs(b.left) < 0.5 && Math.abs(b.width - 260) < 0.5 && Math.abs(b.top) < 0.5`),
    check('A', 'the frame too', `const r = __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.frame .hole').getBoundingClientRect(); return Math.abs(r.left - 260) < 0.5 && Math.abs(r.top - 8) < 0.5 && Math.abs(r.right - (1200 - 8)) < 0.5`),
    checkPage('A', 'the page\'s own measures stay at its size', `const r = document.getElementById('full').getBoundingClientRect(); return Math.abs(r.width - innerWidth) < 1`),
    checkPage('A', 'a point in the window finds what\'s drawn there', `const x = innerWidth / 2, y = innerHeight / 2; const r = document.elementFromPoint(x, y).getBoundingClientRect(); return r.left <= x && x <= r.right && r.top <= y && y <= r.bottom`),
    { op: 'pinch', deltas: Array(40).fill(-0.03), x: 700, y: 400 }, wait(350),
    checkPage('A', 'pinched back: the page as it was', `${AT} return at.scale === 1 && at.x === 260 && at.y === 8`, 800),
    check('A', 'the host too', `getComputedStyle(document.querySelector('margin-sidebar-host')).transform === 'none'`),
    { op: 'pinch', deltas: Array(10).fill(0.03), x: 100, y: 300 }, wait(100),
    checkPage('A', 'over the sidebar nothing zooms', `${AT} return at.scale === 1 && visualViewport.scale === 1`),
    { op: 'pinch', deltas: Array(40).fill(0.06), x: 700, y: 400 }, wait(350),
    checkPage('A', 'at most 3×', `${AT} return Math.abs(at.scale - 3) < 0.01`, 800),
    { op: 'pinch', deltas: Array(60).fill(-0.05), x: 700, y: 400 }, wait(300), { op: 'pinch', deltas: Array(8).fill(-0.03), x: 700, y: 400 }, wait(350),
    checkPage('A', 'pinched in past its size: it springs back', `${AT} return at.scale === 1`, 800),
    { op: 'pinch', deltas: Array(14).fill(0.04), x: 700, y: 400 }, wait(200),
    { op: 'eval', in: 'A', js: 'const { settings } = await browser.storage.local.get("settings"); await browser.storage.local.set({ settings: { ...settings, blockGestures: false } }); return "off"' },
    checkPage('A', 'gestures turned off: back to its size', `${AT} return at.scale === 1`, 1500),
  ],
  // What Margin adds to a page: <margin-app> and its hosts, bare; page zoom and
  // hiding work from the hosts' own styles, whatever the page's styles say.
  'clean-tags': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), themed('A'),
    { op: 'page', in: 'A', js: `const s = document.createElement('style'); s.textContent = ':root { --page-zoom: 2; } margin-app, margin-sidebar-host { --page-zoom: 2 !important; display: none !important; position: static !important; opacity: 0 !important; }'; document.head.append(s); return 'hostile styles'` },
    checkPage('A', 'A: one <margin-app> under <html>, the hosts in it', `const a = document.documentElement.querySelectorAll(':scope > margin-app'); return a.length === 1 && a[0].querySelector(':scope > margin-sidebar-host') && !document.documentElement.querySelector(':scope > margin-sidebar-host')`),
    checkPage('A', 'A: the host is the only style-free thing it needs to be', `!document.querySelector('margin-sidebar-host').hasAttribute('style')`),
    checkPage('A', 'A: the page\'s styles don\'t reach it', `const g = getComputedStyle(document.querySelector('margin-sidebar-host')); return g.position === 'fixed' && g.display !== 'none' && g.opacity === '1' && g.zoom === '1' && getComputedStyle(document.querySelector('margin-app')).display === 'contents'`),
    { op: 'zoom', factor: 1.5 }, wait(700),
    checkPage('A', 'A: page zoom: the host scaled back', `getComputedStyle(document.querySelector('margin-sidebar-host')).zoom !== '1'`, 2000),
    { op: 'zoom', factor: 1 }, wait(700),
    checkPage('A', 'A: back at 100%: bare again', `!document.querySelector('margin-sidebar-host').hasAttribute('style')`, 2000),
    { op: 'page', in: 'A', js: `document.querySelector('margin-app').remove(); return 'removed'` }, wait(300),
    checkPage('A', 'A: taken out by the page: put back', `!!document.querySelector('margin-app margin-sidebar-host')`, 2000),
    { op: 'page', in: 'A', js: `document.querySelector('margin-sidebar-host').remove(); return 'host removed'` }, wait(300),
    checkPage('A', 'A: the host taken out of it: put back', `!!document.querySelector('margin-app margin-sidebar-host')`, 2000),
  ],
  // A tab's row pressed with the mouse (Arc): the switch starts as the button
  // goes down and lands with it still down, and the click that follows the
  // release doesn't switch again. A press on the tab in front, or with ⌃
  // (the Mac's right-click), doesn't switch.
  press: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(500),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.show('toggle'); return 'open'` }, wait(300),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    countSends,
    { op: 'mouse', in: 'A', type: 'down', at: rowAt('A') }, wait(150), { op: 'mouse', in: 'A', type: 'up' }, wait(150),
    check('A', 'A: a press on the tab in front switches nowhere, and its click asks nothing more', `${ID} return (document.querySelector('margin-sidebar-host').dataset.switchingTo ?? '') === '' && !document.hidden && JSON.stringify(__sent) === JSON.stringify([id('A')])`),
    { op: 'mouse', in: 'A', type: 'down', at: rowAt('B') },
    check('A', 'A: B highlighted as it\'s pressed', `${ID} return document.querySelector('margin-sidebar-host').dataset.switchingTo === String(id('B'))`, 300),
    checkPage('B', 'B: in front with the button still down', '!document.hidden', 2000),
    { op: 'mouse', in: 'A', type: 'up' }, wait(400),
    check('A', 'A: the release asked for no second switch', `${ID} return JSON.stringify(__sent) === JSON.stringify([id('A'), id('B')])`),
    checkPage('B', 'B: still in front after the release', '!document.hidden'),
    checkPage('A', 'A: hidden once (the switch)', `JSON.stringify(__visibility) === '["hidden"]'`),
    check('B', 'B: the sidebar was carried open', `document.querySelector('margin-sidebar-host')?.dataset.open === 'true'`, 2000),
    { op: 'mouse', in: 'B', type: 'down', mods: ['control'], at: rowAt('C') }, wait(300),
    check('B', 'B: a ⌃-press switches nowhere (it\'s the menu)', `(document.querySelector('margin-sidebar-host').dataset.switchingTo ?? '') === '' && !document.hidden`),
    { op: 'mouse', in: 'B', type: 'up' },
  ],
  // A tab dragged in the sidebar (Arc): the row stays and a copy follows the
  // pointer, a line shows where it goes; let go, the copy glides into the
  // row's new place and Safari's tab order follows (tabs.move). The list
  // shows the newest tab at the top: A (in front, at the bottom) to above C.
  dragtab: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(500),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.show('toggle'); return 'open'` }, wait(300),
    check('A', 'A: the tabs listed C, B, A', `${ID} return JSON.stringify([...__shadowOf(document.querySelector('margin-sidebar-host')).querySelectorAll('.tabs > .tab')].map((r) => Number(r.dataset.tabId))) === JSON.stringify([id('C'), id('B'), id('A')])`),
    { op: 'mouse', in: 'A', type: 'down', at: rowAt('A') },
    check('A', 'A: its row shrinks as it\'s pressed', `${ID} return __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.tab[data-tab-id="' + id('A') + '"]').classList.contains('pressed')`, 500),
    { op: 'mouse', in: 'A', type: 'drag', at: `${ID} const r = __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.tab[data-tab-id="' + id('C') + '"]').getBoundingClientRect(); return [r.left + 40, r.top + r.height * 0.2]` },
    check('A', 'A: a copy follows the pointer, the row stays, a line above C', `${ID} const root = __shadowOf(document.querySelector('margin-sidebar-host')); return !!root.querySelector('.drag-ghost') && root.querySelectorAll('.tabs > .tab:not(.drag-ghost)').length === 3 && root.querySelector('.tab[data-tab-id="' + id('C') + '"]').classList.contains('drop-before')`, 1000),
    { op: 'mouse', in: 'A', type: 'up' },
    check('A', 'A: Safari\'s order follows (A last), the list shows A at the top', `${ID} const s = await ${STATE}(['tabs']); const root = __shadowOf(document.querySelector('margin-sidebar-host')); return s.tabs[id('A')].index > s.tabs[id('C')].index && Number(root.querySelector('.tabs > .tab').dataset.tabId) === id('A')`, 2000),
    check('A', 'A: the copy glided into place and is gone, the row shown', `${ID} const root = __shadowOf(document.querySelector('margin-sidebar-host')); return !root.querySelector('.drag-ghost') && !root.querySelector('.landing')`, 1500),
    check('A', 'A: still in front (a drag isn\'t a switch)', `!document.hidden`),
  ],
  // Another unloaded tab asked for while the first still loads behind: that
  // one is restored too (the first's turn in the window is over), then
  // introduced and shown with its content.
  unloadedtwo: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'S', url: '/p/S1', asleep: true }, { op: 'open', name: 'E', url: '/p/E', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('S1') }); Margin.content.startSwitching(id('S1'), request); return 'asked for S'` },
    checkPage('S', 'S: loading behind', `document.hidden && document.readyState !== 'complete'`, 1500),
    { op: 'probeShow', name: 'E', nth: 3 }, // restored, introduced, shown
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('E') }); Margin.content.startSwitching(id('E'), request); return 'asked for E'` },
    checkPage('A', 'A: left', 'document.hidden', 3000), shown('E'),
    { op: 'checkProbe', name: 'E', maxMs: 10, label: 'E: its content there as it\'s shown' },
    checkPage('E', 'E: loaded behind before it was shown', `window.__vis[0][0] === 'hidden'`),
  ],
  // A space whose last tab Safari unloaded, chosen in the sidebar (nothing
  // there covers the page itself): Margin covers the page in front while the
  // tab loads behind, then shows it.
  unloadedspace: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'S', url: '/p/S1', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'eval', in: 'A', js: `${ID} const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('S1'), spaceId: work }); globalThis.__work = work; return 'S moved to Work'` }, wait(300),
    { op: 'eval', in: 'A', js: `void Margin.content.send('setSpace', { spaceId: __work }); return 'asked for Work'` },
    check('A', 'A: covered while S loads behind', `const h = document.querySelector('margin-sidebar-host'); return !document.hidden && h.dataset.switchCover === 'true'`, 1500),
    checkPage('S', 'S: loading behind', `document.hidden && document.readyState !== 'complete'`, 1500),
    checkPage('A', 'A: left once S had loaded', 'document.hidden', 3000), shown('S'),
    checkPage('S', 'S: shown once it had painted (its document parsed: here, with its load)', `const nav = performance.getEntriesByType('navigation')[0]; const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && nav.loadEventEnd > 0 && performance.timeOrigin + nav.loadEventEnd <= shownAt + 5`),
  ],
  // Safari putting off the load of a tab it restores until its selection
  // update is over (it then loads the tab selected by then): nothing loads
  // behind, and the switch goes ahead as before a moment later, its page told
  // which tab it is before it draws (background/tabs.js noteShowing).
  deferred: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true }, { op: 'deferLoads' }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    switchTo('A', 'D'), shown('D'), drawn('D'),
    checkPage('D', 'D: loaded as it was shown (nothing loaded it behind)', `window.__vis[0][0] === 'shown'`),
    check('D', 'D: drawn as the tab shown from its first render', `(globalThis.__marginLog ?? []).some((l) => /drawn as tab \\d+, the one being shown/.test(l))`, 3000),
  ],
  // A tab Safari unloaded, shown without loading it behind first (here, too
  // little of the page's wait is left for it: a 1.9 s deadline), whose page is
  // all there at once but loads late (an image that takes 3 s): it loads in
  // front under the switch's cover (content/core.js coverWhileLoading), which
  // lifts once it has painted, not at its load.
  loadcover: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'Z', url: '/p/Z2', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'eval', in: 'A', js: `${ID} return JSON.stringify(await Margin.content.send('activateTab', { tabId: id('Z2'), deadline: Date.now() + 1900 }) ?? null)` }, shown('Z'),
    checkPage('Z', 'Z: loaded as it was shown (nothing loaded it behind)', `window.__vis[0][0] === 'shown'`),
    check('Z', 'Z: under the switch\'s cover as it loaded, lifted once it had painted, well before its load', `const h = document.querySelector('margin-sidebar-host'); return h.dataset.loadingCover === 'false' && performance.getEntriesByType('paint').some((e) => e.name === 'first-contentful-paint') && document.readyState !== 'complete'`, 1500),
  ],
  // Two copies of Margin loaded at once in one controller (as Safari would
  // load a new one while the old one still runs): they share one script world
  // in pages, so a page runs one copy, here the first's. Once the newer copy
  // owns the state, that page's copy stands back, saying to restart Safari,
  // rather than drawing tabs by ids its copy doesn't own.
  twins: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(1500),
    { op: 'page', in: 'A', js: 'window.__before = true; return "marked"' },
    { op: 'installTwin' }, wait(2500),
    { op: 'open', name: 'B', url: '/p/B', active: true },
    check('B', 'B: one copy runs in the shared world', `!!globalThis.Margin?.content && document.querySelectorAll('margin-sidebar-host').length === 1`, 4000),
    // Which copy the page runs is WebKit's pick: the newer one draws; the
    // older one stands back, saying why.
    check('B', 'B: either it runs the copy in charge, or it stands back and says why', `const log = globalThis.__marginLog ?? []; const s = await browser.storage.local.get('openTabs'); return (log.some((l) => l.includes('stays out of the way')) && !Margin.content.active()) || (s.openTabs?.origin === browser.runtime.getURL('') && s.openTabs.synced && Margin.content.active())`, 5000),
    // A page whose world is the other copy's, which still answers, isn't taken for one cut off
    // from a copy that's gone (background/cut-off.js): not loaded again, as it's shown or after.
    { op: 'show', name: 'A' }, wait(2000),
    checkPage('A', 'A (the other copy\'s world, still running): not loaded again', 'window.__before === true', 1000),
  ],
  // A tab Safari unloaded whose page is slow: it loads behind the page, which
  // stays in front, covered, its row highlighted; it's shown once loaded.
  slowunloaded: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'S', url: '/p/S1', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('S1') }); Margin.content.startSwitching(id('S1'), request); return 'asked'` },
    checkPage('S', 'S: loading behind', `document.hidden && document.readyState !== 'complete'`, 1500),
    check('A', 'A: still in front, covered, S highlighted', `${ID} const h = document.querySelector('margin-sidebar-host'); return !document.hidden && h.dataset.switchingTo === String(id('S1')) && h.dataset.switchCover === 'true'`),
    checkPage('S', 'S is the tab shown', '!document.hidden', 5000), checkPage('A', 'A: left (the switch landed)', 'document.hidden'),
    checkPage('S', 'S: shown once it had painted (its document parsed: here, with its load)', `const nav = performance.getEntriesByType('navigation')[0]; const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && nav.loadEventEnd > 0 && performance.timeOrigin + nav.loadEventEnd <= shownAt + 5`),
  ],
  // A tab Safari unloaded whose page is all there at once but loads late (an
  // image that takes 3 s): loaded behind the page, shown once it has painted
  // (shared/page-ready.js), well before its load, introduced first: its
  // content there as it's shown. (Waiting for its load event, it was shown at
  // the 2.5 s limit.)
  unloadedlate: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'Z', url: '/p/Z1', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(250),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    { op: 'probeShow', name: 'Z', nth: 3 }, // restored, introduced, shown
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('Z1') }); Margin.content.startSwitching(id('Z1'), request); return 'asked for Z'` },
    checkPage('A', 'A: left', 'document.hidden', 3000), shown('Z'),
    { op: 'checkProbe', name: 'Z', maxMs: 10, label: 'Z: its content there as it\'s shown' },
    checkPage('Z', 'Z: loaded behind, shown before its load (its image still on its way)', `const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; const nav = performance.getEntriesByType('navigation')[0]; return window.__vis[0][0] === 'hidden' && !!shownAt && (!nav.loadEventEnd || performance.timeOrigin + nav.loadEventEnd > shownAt)`),
    checkPage('Z', 'Z: shown well under 1.5 s from its load\'s start', `const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return shownAt - performance.timeOrigin < 1000`),
    check('Z', 'Z: well under 1.5 s from the click, waiting for its paint, introduced, its page drawn before the show (the log\'s barriers)', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.restored === 'painted' && e.introduced === true && !e.error && e.shownAfter < 1000 && e.barrier?.length > 0 && e.barrier.every((b) => b.how === 'drawn'))`),
    noPageErrors('Z'),
    checkPage('A', 'A: hidden once (the switch), not by the restore or the introduction', `JSON.stringify(__visibility) === '["hidden"]'`),
  ],
  // An address chosen in the palette (⌘T): the tab opens behind the page,
  // whose sidebar has its row highlighted and which stays covered while it
  // loads (a slow page: 1.5s), then comes to the front; or stays behind if the
  // user picks their own tab meanwhile, or presses Escape (keys typed
  // meanwhile don't reach the page). Three scenarios: in this host Margin's
  // background stops answering about 5 s after it starts (README.md).
  behind: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), wait(600),
    // As the palette asks (content/palette.js reportingSwitches): covered at once.
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/S2' }); Margin.content.startSwitching(-1, request); const h = document.querySelector('margin-sidebar-host'); return h.dataset.switchingTo + ' ' + h.dataset.switchCover` },
    check('A', 'A stays in front, covered, its sidebar on the new tab, while the page loads',
      `const s = await ${STATE}(['tabs']); const t = Object.values(s.tabs).find((x) => x.url.includes('/p/S2')); const host = document.querySelector('margin-sidebar-host'); return !document.hidden && !!t && !t.active && host.dataset.switchingTo === String(t.id) && host.dataset.switchCover === 'true'`, 1500),
    checkPage('new1', 'the new tab loads behind, hidden, Margin in it', `document.hidden && !!document.querySelector('margin-sidebar-host')`, 1500),
    // Shown for the first time, it arrives covered with the page hidden under
    // the cover (its first paint cheap: content/core.js arriveCovered), then
    // brings the page back and lifts the cover.
    { op: 'page', in: 'new1', js: `window.__arrival = []; const note = (why) => { const h = document.querySelector('margin-sidebar-host'); __arrival.push([why, document.hidden, h?.dataset.arrivalCover ?? '', document.body?.style.opacity ?? '']); }; document.addEventListener('visibilitychange', () => note('shown')); new MutationObserver(() => note('cover')).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-arrival-cover'] }); return 'recording'` },
    checkPage('new1', 'then comes to the front, loaded', `!document.hidden && document.readyState === 'complete'`, 4000),
    checkPage('new1', 'first shown covered, the page out of sight under the cover', `__arrival.some(([why, hidden, cover, vis]) => why === 'shown' && !hidden && cover === 'true' && vis === '0')`, 1000),
    checkPage('new1', 'then the page back and the cover lifted', `const h = document.querySelector('margin-sidebar-host'); return h.dataset.arrivalCover === 'false' && document.body.style.opacity === ''`, 1500),
    checkPage('A', 'A is behind', `document.hidden`),
  ],
  // ⌘T with a page all there at once that loads late (an image that takes
  // 3 s): it comes to the front once it has painted, still loading, not once
  // loaded; introduced first, its content there as it's shown.
  behindlate: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), wait(600),
    { op: 'probeShow', name: 'new1', nth: 2 }, // the first time is the introduction
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/Z3' }); Margin.content.startSwitching(-1, request); return 1` },
    checkPage('new1', 'the new tab comes to the front at its first paint, still loading (its image on its way)', `!document.hidden && document.readyState !== 'complete'`, 2500),
    { op: 'checkProbe', name: 'new1', maxMs: 10, label: 'its content there as it\'s shown' },
    checkPage('new1', 'shown well under 1.5 s from its start', `const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && shownAt - performance.timeOrigin < 1000`),
    checkPage('new1', 'then the page back and the cover lifted', `const h = document.querySelector('margin-sidebar-host'); return h.dataset.arrivalCover === 'false' && document.body.style.opacity === ''`, 1500),
  ],
  // An app's page (/p/Y…): parsed at once with an empty body, its own content
  // drawn by its script 0.25 s later, its load at 3 s. Margin's own UI in the
  // page (its sidebar, kept open; the switch cover's spinner) counts for the
  // browser's first contentful paint, so the show and the loading cover wait
  // for the page's own content (shared/page-ready.js): not before it, and not
  // until the time limit either. (Before, such a page was shown at Margin's
  // paint, 60 ms in, empty.) Each as soon after install as it can be: the
  // background here can stall from about 1 s after it starts (README.md). A
  // tab Safari unloaded, restored behind:
  shelllate: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'Y', url: '/p/Y1', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), keepOpen, wait(100),
    { op: 'eval', in: 'A', js: `${ID} const request = Margin.content.send('activateTab', { tabId: id('Y1') }); Margin.content.startSwitching(id('Y1'), request); return 'asked for Y'` },
    checkPage('A', 'A: left', 'document.hidden', 3000), shown('Y'),
    { op: 'page', in: 'Y', js: `return JSON.stringify({ paints: performance.getEntriesByType('paint').map((e) => e.name + '@' + Math.round(e.startTime)), textAt: Math.round(__textAt - performance.timeOrigin), shownAt: Math.round(window.__vis.find((e) => e[0] === 'shown')[1] - performance.timeOrigin) })` },
    checkPage('Y', 'Y: shown once its own content was there, soon after it, not at the limit', `const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return window.__vis[0][0] === 'hidden' && !!shownAt && __textAt > 0 && shownAt >= __textAt && shownAt - __textAt < 600`),
    check('Y', 'Y: the switch log says it waited for its paint', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.restored === 'painted' && !e.error)`),
  ],
  // One shown without loading it behind first (a 1.9 s deadline): the loading
  // cover lifts once the page's own content is there.
  shellcover: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'Y', url: '/p/Y2', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(200),
    { op: 'eval', in: 'A', js: `${ID} return JSON.stringify(await Margin.content.send('activateTab', { tabId: id('Y2'), deadline: Date.now() + 1900 }) ?? null)` }, shown('Y'),
    checkPage('Y', 'Y: loaded as it was shown (nothing loaded it behind)', `window.__vis[0][0] === 'shown'`),
    checkPage('Y', 'Y: its loading cover lifted once its own content was there, soon after it', `!!window.__liftAt && __textAt > 0 && __liftAt >= __textAt && __liftAt - __textAt < 400 && document.readyState !== 'complete'`, 2500),
  ],
  // A new tab from the palette, the sidebar kept open: to the front once the
  // page's own content is there.
  shellbehind: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(100),
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/Y3' }); Margin.content.startSwitching(-1, request); return 1` },
    check('A', 'the new tab opened (its row in the sidebar)', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs ?? {}).some((t) => t.url.endsWith('/p/Y3'))`, 3000),
    checkPage('new1', 'the new tab is the one shown', '!document.hidden', 3000),
    checkPage('new1', 'shown once its own content was there, soon after it, not at the limit', `const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && __textAt > 0 && shownAt >= __textAt && shownAt - __textAt < 600`),
  ],
  // The same with Keep open: the page under the cover has its box.
  behindbox: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, boxed('A'),
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/S5' }); Margin.content.startSwitching(-1, request); return 1` }, wait(300),
    checkPage('new1', 'the new tab loads behind, in its box', `document.hidden && location.pathname === '/p/S5' && document.scrollingElement === document.body`, 1500),
    { op: 'page', in: 'new1', js: `window.__arrival = []; const note = (why) => { const h = document.querySelector('margin-sidebar-host'); __arrival.push([why, document.hidden, h?.dataset.arrivalCover ?? '', document.body.style.opacity]); }; document.addEventListener('visibilitychange', () => note('shown')); return 'recording'` },
    checkPage('new1', 'then comes to the front', `!document.hidden`, 3000),
    checkPage('new1', 'first shown covered, the page hidden under the cover', `__arrival.some(([why, hidden, cover, vis]) => why === 'shown' && !hidden && cover === 'true' && vis === '0')`, 1000),
    checkPage('new1', 'then the page back and the cover lifted', `document.querySelector('margin-sidebar-host').dataset.arrivalCover === 'false' && document.body.style.opacity !== '0'`, 1500),
  ],
  // A page that focuses a field as it loads (autofocus) keeps its focus
  // through the covered arrival (typing goes there once it's shown).
  behindfocus: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), wait(600),
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/G1' }); Margin.content.startSwitching(-1, request); return 1` },
    checkPage('new1', 'the new tab comes to the front', `!document.hidden`, 3000),
    checkPage('new1', 'its field focused (autofocus), after the cover lifted', `document.querySelector('margin-sidebar-host')?.dataset.arrivalCover === 'false' && document.activeElement?.id === 't'`, 1500),
  ],
  // Shown for the first time, a tab is introduced first (background/tabs.js
  // introduceTab): brought to the front and the page in front straight back,
  // in one run loop turn, so WebKit then keeps the page before on screen until
  // it has painted. A heavy page, from the turn it's shown: none of WebKit's
  // empty view worth a screen refresh (without the introduction, 16–21 ms in
  // this host). The page in front sees nothing of it, and Margin's state only
  // the real switch.
  // S1 and S2 (2026-11-04): a tab Margin has no proof of (introduced first)
  // whose page stalls 2 s as it handles being hidden again (Instagram's
  // stalls in Safari: 1.35 s and 2.4 s): the show waits for its page to answer
  // one more look (after its flip's hide is over, by its own word or its
  // paint), and goes out once it's free, so WebKit holds it: its content there
  // as it's shown. At 9f1611f it was shown once its barriers ran out, about
  // 1 s after the flip, into the stall: WebKit's hold ran out, and Safari's
  // empty view stayed until the page drew.
  heavyflip: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'V', url: '/x/heavy-visible?stall=2000&after=0' }, wait(800), { op: 'install' }, drawn('A'), drawn('V'), wait(300),
    { op: 'probeShow', name: 'V', nth: 2 }, // the first is its introduction
    { op: 'eval', in: 'A', js: `const { tabs } = await ${STATE}("tabs"); const id = Object.values(tabs).find((t) => t.url.includes("/x/heavy-visible"))?.id; return JSON.stringify(await Margin.content.send("activateTab", { tabId: id }) ?? null)` },
    checkPage('V', 'V is the tab shown', `!document.hidden`, 5000),
    { op: 'checkProbe', name: 'V', maxMs: 10, label: 'V: its content there as it\'s shown, after its stall' },
    check('V', 'the switch introduced it, and its show waited for its page', `const e = (await Margin.content.send('switchLog')).filter((x) => x.kind === 'switch' && !x.error).at(-1); globalThis.__entry = JSON.stringify(e); return e?.introduced === true && e.gate?.pings?.length >= 2`),
    { op: 'eval', in: 'V', js: 'return globalThis.__entry' },
  ],
  // S4 (2026-11-04): ⌃⌘↓ on a page that takes ArrowDown at every level goes to
  // the next tab, through Margin's listener (the host has no Safari menu: no
  // command), and the page never sees it. In Safari the command came only
  // after the page had turned the key down, so such a page ate it.
  commandkeys: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(500), { op: 'install' }, drawn('A'), wait(300),
    { op: 'open', name: 'E', url: '/x/eats-arrows', active: true }, { op: 'open', name: 'B', url: '/p/B' }, drawn('E'), drawn('B'), wait(300),
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
  introduce: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), wait(600),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    // The tab in front in each state Margin writes (its isolated world).
    { op: 'eval', in: 'A', js: `globalThis.__fronts = []; browser.storage.onChanged.addListener((changes) => { const tabs = changes.openTabs?.newValue?.tabs; if (tabs) __fronts.push(Object.values(tabs).filter((t) => t.active).map((t) => t.url.split('/p/')[1]).join()); }); return 'recording'` },
    { op: 'probeShow', name: 'new1', nth: 2 }, // the first time is the introduction
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/H3' }); Margin.content.startSwitching(-1, request); return 1` },
    checkPage('new1', 'the new tab comes to the front', `!document.hidden`, 3000),
    { op: 'checkProbe', name: 'new1', maxMs: 10, label: 'its content there as it\'s shown (WebKit\'s empty view under a screen refresh at most)' },
    checkPage('A', 'the page before was hidden once (the switch), not by the introduction', `JSON.stringify(__visibility) === '["hidden"]'`),
    check('new1', 'the switch says it introduced the tab', `(await Margin.content.send('switchLog')).some((e) => e.kind === 'switch' && e.source === 'new tab' && e.introduced === true && !e.error)`),
    check('new1', 'in Margin\'s state, the new tab is the one in front', `const s = await ${STATE}(['tabs']); const active = Object.values(s.tabs).filter((t) => t.active); return active.length === 1 && active[0].url.includes('/p/H3')`),
    check('A', 'and it never had the new tab in front before that, then A again (the introduction left out)', `const i = __fronts.indexOf('H3'); return i >= 0 && !__fronts.slice(i).includes('A')`),
  ],
  // The covered arrival (content/core.js arriveCovered): not for a page on
  // screen already (Safari left it in front: no show would bring it back),
  // still for one visible only for an instant (an introduction).
  arrival: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, wait(800), { op: 'install' }, drawn('A'), drawn('B'), drawn('C'), wait(300),
    // C just brought to the front by Safari (within the 200 ms it takes to count as shown).
    { op: 'show', name: 'C' },
    { op: 'eval', in: 'C', js: `${ID} return JSON.stringify(await Margin.content.prepareForShow({ token: 'on-screen', tabId: id('C'), windowId: Object.values(tabs).find((t) => t.id === id('C')).windowId, covered: true }))` },
    checkPage('C', 'a page on screen asked to arrive covered isn\'t covered', `!document.hidden && document.querySelector('margin-sidebar-host').dataset.arrivalCover !== 'true' && document.body.style.opacity !== '0'`, 300), // (the cover would lift by itself after 3 s)
    { op: 'flip', to: 'B', back: 'C' }, wait(50),
    { op: 'eval', in: 'B', js: `${ID} return JSON.stringify(await Margin.content.prepareForShow({ token: 'instant', tabId: id('B'), windowId: Object.values(tabs).find((t) => t.id === id('B')).windowId, covered: true }))` },
    checkPage('B', 'one visible for an instant still arrives covered', `document.hidden && document.querySelector('margin-sidebar-host').dataset.arrivalCover === 'true' && document.body.style.opacity === '0'`),
    { op: 'eval', in: 'B', js: `return String(Margin.content.cancelPreparedShow('instant'))` },
    checkPage('B', 'and is uncovered when the switch is called off', `document.querySelector('margin-sidebar-host').dataset.arrivalCover === 'false' && document.body.style.opacity === ''`),
  ],
  behindleft: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), wait(600),
    { op: 'eval', in: 'A', js: `void Margin.content.send('newTab', { url: location.origin + '/p/S3' }); return 'asked'` },
    wait(400),
    { op: 'eval', in: 'A', js: `${ID} return JSON.stringify(await Margin.content.send('activateTab', { tabId: id('A') }))` },
    wait(1800),
    checkPage('A', 'picking its own tab meanwhile: A stays', `!document.hidden`),
    checkPage('new1', 'and the new tab stays behind, loaded', `document.hidden && document.readyState === 'complete'`),
    check('A', 'with its row in the sidebar, not highlighted, uncovered', `const s = await ${STATE}(['tabs']); const t = Object.values(s.tabs).find((x) => x.url.includes('/p/S3')); const h = document.querySelector('margin-sidebar-host'); return !!t && !t.active && h.dataset.switchingTo === '' && h.dataset.switchCover !== 'true'`),
  ],
  behindkeys: [
    { op: 'open', name: 'F', url: '/p/F1', active: true }, wait(800), { op: 'install' }, drawn('F'), wait(600),
    { op: 'page', in: 'F', js: `document.querySelector('textarea').focus(); return document.activeElement.localName` },
    { op: 'eval', in: 'F', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/S4' }); Margin.content.startSwitching(-1, request); return 'asked'` },
    wait(300),
    { op: 'key', in: 'F', chars: 'x', keyCode: 7 },
    checkPage('F', 'keys typed while covered don\'t reach the page', `document.querySelector('textarea').value === ''`),
    { op: 'key', in: 'F', chars: String.fromCharCode(27), keyCode: 53 },
    check('F', 'Escape calls it off: uncovered', `document.querySelector('margin-sidebar-host').dataset.switchCover === 'false'`, 1000),
    wait(1800),
    checkPage('F', 'and F stays', `!document.hidden`),
    checkPage('new1', 'the new tab stays behind', `document.hidden`),
  ],
  // Settings' shortcut recorder on the start page takes real key presses.
  recorder: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, wait(1500),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: drawn', `!!document.querySelector('[data-shortcut="nextTab"]')`, 5000),
    { op: 'page', in: 'N', js: `document.getElementById('settings').open = true; const i = document.querySelector('[data-shortcut="nextTab"]'); i.focus(); return 'focused ' + (document.activeElement === i) + ' ' + i.className` },
    { op: 'key', in: 'N', chars: 'p', keyCode: 35, mods: ['control', 'shift'] }, wait(500),
    checkPage('N', 'a combination is recorded (⌃⇧P)', `document.querySelector('[data-shortcut="nextTab"]').value === '⌃⇧P'`, 2000),
    { op: 'page', in: 'N', js: `const i = document.querySelector('[data-shortcut="nextSpace"]'); i.focus(); return 'focused ' + (document.activeElement === i)` },
    { op: 'key', in: 'N', chars: String.fromCharCode(0xF703), keyCode: 124, mods: ['command', 'option'] }, wait(500),
    { op: 'page', in: 'N', js: `return 'nextSpace field: ' + JSON.stringify(document.querySelector('[data-shortcut="nextSpace"]').value)` },
  ],
  // Keep-ready's holds (background/keep-ready.js) through a run of switches
  // in Safari's own tab bar: each tab left is held at once, but never more
  // than two (MAX_HELD): past them, the tab used longest ago lets go at once.
  // A hold is a message waiting for its answer in Margin's page (HELD), none
  // a keepAwake in the page's own world (its pageswap listener, counted there).
  'wake-wait': waitedFor(500, 'resumed', 'kicked, waited for with the page before on screen, then prepared and drawn before it was shown', `e.waitedOnOldPage >= 450 && e.wakeStartedBy === 'switch' && e.preparation?.outcome === 'ready' && e.barrier?.length === 1 && e.barrier[0].ms < 350`, 'resumed'),
  // (A click waits on past 1.6 s while its page's deadline leaves room: T2,
  // background/tabs.js focusTabNow. Shown as it was only near the deadline.)
  'wake-cap': waitedFor(2200, 'resumed', 'kicked, no answer by 1.6 s: waited on with the page before on screen (a click), answered at 2.2 s, drawn, then shown', `e.waitedOnOldPage >= 2150 && e.barrier?.at(-1)?.how === 'drawn' && e.layersBack === 'barrier'`, 'resumed'),
  'wake-awake': waitedFor(null, null, 'answered in time: shown, not kicked before 60 ms', 'true'),
  'wake-reveal': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), themed('A'), drawn('B'),
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { keepLeftTabReadyMinutes: 0 } }))' },
    { op: 'show', name: 'B' }, wait(200), { op: 'show', name: 'A' }, wait(300),
    { op: 'eval', in: 'A', js: `Margin.content.sidebar.toggle(); return 'sidebar out'` }, wait(250),
    switchTo('A', 'B'), shown('B'),
    check('B', 'B: woken as the sidebar came out on A (the tab used before it)', `${ID} const e = (await Margin.content.send('switchLog'))?.filter((x) => x.kind === 'switch' && x.tabId === id('B')).at(-1); return !!e && !e.error && e.wakeStartedBy === 'reveal'`),
  ],
  'wake-space': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'C', url: '/p/C' },
    wait(800), { op: 'install' }, drawn('A'), themed('A'),
    { op: 'eval', in: 'A', js: `${ID} await Margin.content.send('updateSettings', { patch: { keepLeftTabReadyMinutes: 0 } }); const work = (await Margin.content.send('createSpace', { name: 'Work' })).spaceId; await Margin.content.send('moveTabToSpace', { tabId: id('C'), spaceId: work }); return 'C moved to Work'` },
    check('A', 'A: the Work space\'s icon is drawn', `!!__shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.chip[title="Work"]')`, 2000),
    { op: 'eval', in: 'A', js: CHIP('C') }, wait(300),
    { op: 'eval', in: 'A', js: `${ID} const { tabSpace } = await ${STATE}('tabSpace'); return JSON.stringify(await Margin.content.send('setSpace', { spaceId: tabSpace[id('C')] }))` },
    shown('C'),
    check('C', 'C: woken as the pointer rested on its space\'s icon', `${ID} const e = (await Margin.content.send('switchLog'))?.filter((x) => x.kind === 'switch' && x.tabId === id('C')).at(-1); return !!e && !e.error && e.wakeStartedBy === 'space'`),
  ],
  'space-press': spacePress(),
  'space-click': spacePress(true),
  'keep-ready-cap': [
    ...HOLD_TABS.map((name, i) => ({ op: 'open', name, url: `/p/${name}`, active: i === 0 })), wait(800),
    ...HOLD_TABS.map((name) => ({ op: 'page', in: name, js: COUNT_HOLDS })),
    { op: 'install' }, drawn('A'),
    ...HOLD_TABS.slice(1).flatMap((name) => [{ op: 'show', name }, wait(120)]),
    wait(300),
    { op: 'page', in: 'J', js: 'return "holds counted in each tab next"' },
    ...HOLD_TABS.map((name) => ({ op: 'eval', in: name, js: `return '${name}: ' + (${HELD})` })),
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => check(name, `${name}: left earlier, let go once two later tabs were held`, `${HELD} === 0`, 3000)),
    ...['H', 'I'].map((name) => check(name, `${name}: among the two left last, held`, `${HELD} >= 1`, 1500)),
    check('J', 'J: the tab in front holds nothing', `${HELD} === 0`, 1500),
    ...HOLD_TABS.map((name) => checkPage(name, `${name}: no hold left running in the page's own world (foreground priority)`, '__holds() === 0', 200)),
  ],
  // Safari left for another app (the page in front lost focus while in sight:
  // shared/away.js sends 'away'; the host never has focus, so it's sent from
  // the page's Margin world here): the two tabs held are let go 15 s later
  // (keep-ready.js PAGE_AWAY_MS: Safari's own find bar brings the same word),
  // past the host's ~5 s of background life: here, that they're still held
  // 3.5 s after it (they were let go at 3 s until 2026-11-03), and that the
  // same word from a tab behind (B, a page that lost focus while still drawn,
  // its word late) doesn't count either. The let-go itself: unit tests.
  'keep-ready-away': [
    ...['A', 'B', 'C'].map((name, i) => ({ op: 'open', name, url: `/p/${name}`, active: i === 0 })), wait(800),
    ...['A', 'B', 'C'].map((name) => ({ op: 'page', in: name, js: COUNT_HOLDS })),
    { op: 'install' }, drawn('A'),
    { op: 'show', name: 'B' }, wait(120), { op: 'show', name: 'C' },
    ...['A', 'B'].map((name) => check(name, `${name}: left, held`, `${HELD} >= 1`, 1000)),
    { op: 'eval', in: 'B', js: 'return JSON.stringify(await Margin.content.send("away", { at: Date.now() }))' },
    wait(500),
    { op: 'eval', in: 'C', js: 'return JSON.stringify(await Margin.content.send("away", { at: Date.now() }))' },
    wait(3500),
    ...['A', 'B'].map((name) => check(name, `${name}: still held 3.5 s after Safari was left (or its find bar used)`, `${HELD} >= 1`, 200)),
    ...['A', 'B', 'C'].map((name) => checkPage(name, `${name}: no hold left running in the page's own world (foreground priority)`, '__holds() === 0', 200)),
  ],
  // A hidden tab's title ticking (a chat, a timer: background/tab-updates.js):
  // its changes are gathered into a write every 2 s at most, not one each,
  // and its row still shows the last; the tab in front's own title is written
  // at once. The writes of the open tabs counted in A's Margin world. All
  // within the host's ~5 s of background life.
  titles: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), themed('A'), drawn('B'),
    { op: 'eval', in: 'A', js: `globalThis.__writes = []; (globalThis.browser ?? chrome).storage.onChanged.addListener((changes) => { if (changes.openTabs) __writes.push(performance.now()); }); return 'counting writes'` },
    { op: 'page', in: 'A', js: `document.title = 'A now'; return 'titled'` },
    check('A', 'A: the tab in front\'s title is written at once (under 300 ms)', `${ID} return __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.tab[data-tab-id="' + id('A') + '"] .title')?.textContent === 'A now' && __writes.length > 0`, 300),
    { op: 'eval', in: 'A', js: `globalThis.__before = __writes.length; return 'next: B ticking'` },
    // (A hidden page's timers are slowed: each tick waits in a busy loop, then yields through a message.)
    { op: 'page', in: 'B', js: `const yieldNow = () => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = resolve; c.port2.postMessage(0); }); for (let n = 1; n <= 8; n++) { document.title = 'B tick ' + n; const until = performance.now() + 60; while (performance.now() < until); await yieldNow(); } return 'ticked'` },
    check('A', 'A: B\'s row shows its last title', `${ID} return __shadowOf(document.querySelector('margin-sidebar-host')).querySelector('.tab[data-tab-id="' + id('B') + '"] .title')?.textContent === 'B tick 8'`, 3600),
    { op: 'eval', in: 'A', js: `return 'writes while B ticked: ' + (__writes.length - __before)` },
    check('A', 'A: eight title changes of a hidden tab, at most two writes', `const n = __writes.length - __before; return n >= 1 && n <= 2`),
  ],
  // A hidden tab's new address is written at once, not gathered (background/
  // tab-updates.js: after a restart tabs are matched to their records by it);
  // a new fragment alone waits its 300 ms. Read from storage in A's Margin world.
  addresses: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), themed('A'), drawn('B'),
    { op: 'eval', in: 'A', js: `${ID} globalThis.__b = id('B'); return 'B is ' + __b` },
    { op: 'page', in: 'B', js: `history.pushState(null, '', '/p/B/next'); return 'moved'` },
    check('A', 'A: B\'s new address is stored at once (by about 200 ms: the host looks every 100 ms)', `const { tabs } = await ${STATE}('tabs'); return !!tabs[__b]?.url.endsWith('/p/B/next')`, 150),
    { op: 'page', in: 'B', js: `location.hash = 'inbox'; return 'fragment'` },
    wait(100),
    check('A', 'A: B\'s new fragment alone waits', `const { tabs } = await ${STATE}('tabs'); return !tabs[__b]?.url.endsWith('#inbox')`),
    check('A', 'A: then is stored', `const { tabs } = await ${STATE}('tabs'); return !!tabs[__b]?.url.endsWith('/p/B/next#inbox')`, 1500),
  ],
  // A picture of a page in its box, for a look (build/screenshot.png).
  screenshot: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'),
    keepOpen, wait(800), reload('A'), boxed('A'), wait(500),
    { op: 'snapshot', file: new URL('build/screenshot.png', import.meta.url).pathname },
  ],
};

// Safari reloading Margin while pages are open (an update, or Margin.app opened): it keeps
// Margin's content-script world in those pages, still bound to the copy that's gone, where
// nothing answers (background/cut-off.js). The page in front and the ones behind are loaded
// again; one with a draft typed keeps it, its dead sidebar put away; switching from the sidebar
// then lifts every cover, a new tab from the palette loads and comes to the front, and the
// sidebar keeps every tab.
const shownHost = "[...document.querySelectorAll('margin-sidebar-host')].find((h) => getComputedStyle(h).display !== 'none')";
const settled = (tab, label, rows) => check(tab, label, `const h = ${shownHost}; if (!h) return false; return h.dataset.switchCover !== 'true' && h.dataset.arrivalCover !== 'true' && h.dataset.loadingCover !== 'true' && h.dataset.startup !== 'true' && document.body.style.opacity !== '0' && __shadowOf(h).querySelectorAll('.tab[data-tab-id]').length >= ${rows}`, 5000);
const answers = (tab) => check(tab, `${tab}: its Margin answers (storage and the background)`, "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return (await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])) && (await Promise.race([Margin.content.send('sidebarScroll').then(() => true), later(1500)]))", 3000);
const click = (from, to) => [{ op: 'mouse', in: from, type: 'down', at: rowAt(to) }, { op: 'mouse', in: from, type: 'up' }];
const newTabRound = (n, rows) => [
  { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/S${n}' }); Margin.content.startSwitching(-1, request); return 'asked for S${n}'` },
  check('A', `round ${n}: the new tab is made`, `const s = await ${STATE}(['tabs']); return Object.values(s.tabs).some((t) => t.url.endsWith('/p/S${n}'))`, 4000), wait(300),
  checkPage(`new${n}`, `round ${n}: the new tab comes to the front, loaded`, `!document.hidden && document.readyState === 'complete'`, 8000),
  settled(`new${n}`, `round ${n}: its covers lifted, its sidebar has every tab`, rows),
  ...click(`new${n}`, 'A'), shown('A'),
  settled('A', `round ${n}: back on A from the sidebar: covers lifted, every tab there`, rows),
];
Object.assign(SCENARIOS, {
  reloaded: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/FC' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install', sameId: true }, drawn('A'), themed('A'), keepOpen, wait(800),
    reload('A'), reload('B'), reload('C'), wait(1500), boxed('A'), boxed('B'), boxed('C'),
    ...['A', 'B', 'C'].map((t) => ({ op: 'page', in: t, js: 'window.__before = true; return "marked"' })),
    { op: 'page', in: 'C', js: `document.getElementById('t').value = 'draft'; return 'typed'` },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('B', 'B (behind): loaded again', '!window.__before', 8000),
    // (2026-11-04: never loaded again in front. Its dead sidebar out of sight at
    // once, and loaded again once it's left.)
    checkPage('A', 'A (in front, nothing typed), left with the old copy: its dead sidebar out of sight, not loaded again in front', "window.__before === true && [...document.querySelectorAll('margin-sidebar-host')].every((h) => getComputedStyle(h).display === 'none')", 3000),
    checkPage('C', 'C (a draft typed): not loaded again, the draft kept', `window.__before === true && document.getElementById('t').value === 'draft'`, 3000),
    checkPage('C', 'C: the old copy\'s dead sidebar out of sight', "[...document.querySelectorAll('margin-sidebar-host')].every((h) => getComputedStyle(h).display === 'none')", 3000),
    { op: 'show', name: 'B' }, shown('B'),
    checkPage('A', 'A, left: loaded again, behind', '!window.__before && document.hidden', 4000),
    settled('B', 'A to B: covers lifted, every tab there', 4),
    ...click('B', 'D'), shown('D'), settled('D', 'B to D (asleep) from the sidebar: loaded, covers lifted', 4),
    ...click('D', 'FC'), shown('C'),
    checkPage('C', 'C shown: still the draft, no dead cover over it', `document.getElementById('t').value === 'draft' && document.body.style.opacity !== '0' && [...document.querySelectorAll('margin-sidebar-host')].every((h) => getComputedStyle(h).display === 'none')`, 2000),
    switchTo('B', 'A'), shown('A'), settled('A', 'back on A: covers lifted', 4),
    ...newTabRound(1, 5),
  ],
  // The same reload with Margin's new-tab page open: that page is the old copy's, at its address,
  // and nothing in it answers. It's loaded again at this copy's address (marked as not a new tab:
  // ⌘T's hand-off would close it), then shown with every tab.
  // A tab put to sleep (background/sleep.js): its page goes to Margin's sleep
  // page with location.replace from Margin's content script, and its page's
  // process exits; Safari's own show (its tab bar) wakes it: back at its page,
  // with no history entry for the sleep page, its content there. The tab in
  // front isn't put to sleep.
  'sleep-show': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), drawn('B'),
    checkPage('B', 'B: one history entry to begin with', 'history.length === 1'),
    { op: 'pid', name: 'B' }, { op: 'pid', name: 'A' },
    sleepNow('A'),
    ...asleepAt('B', 'B'),
    { op: 'pidGone', name: 'B', label: "B: its page's process has exited", timeout: 4000 },
    checkPage('A', 'A (in front): not put to sleep', "location.pathname === '/p/A' && !document.hidden"),
    { op: 'state' },
    { op: 'show', name: 'B' },
    awakeAt('B', 'B', "Safari's show woke it: back at its page, no history entry for the sleep page"),
    { op: 'state' },
  ],
  // The same put to sleep, woken by Margin's switch: loaded behind the page in
  // front (its sleep page told to go back, hidden), then shown, its content
  // there as it's shown, no history entry for the sleep page; the switch log
  // says so. (All within the host's ~5 s of background life.)
  'sleep-switch': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install' }, drawn('A'), drawn('B'),
    { op: 'pid', name: 'B' },
    sleepNow('A'),
    ...asleepAt('B', 'B'),
    { op: 'page', in: 'A', js: `window.__visibility = []; document.addEventListener('visibilitychange', () => __visibility.push(document.visibilityState)); return 'recording'` },
    switchTo('A', 'B'),
    shown('B'),
    awakeAt('B', 'B', "Margin's switch woke it: back at its page, no history entry for the sleep page"),
    checkPage('B', 'B: loaded behind before it was shown (hidden from its start)', `window.__vis[0][0] === 'hidden' && window.__vis.some((e) => e[0] === 'shown')`),
    checkPage('A', 'A: hidden once (the switch)', `JSON.stringify(__visibility) === '["hidden"]'`),
    check('B', "B: the switch log says it was woken (its page told) and loaded behind", `${ID} const log = await Margin.content.send('switchLog'); const sw = log.filter((e) => e.kind === 'switch' && e.tabId === id('B')).at(-1); const woke = log.some((e) => e.kind === 'sleep' && e.step === 'woke' && e.by === 'switch'); return !!sw && !sw.error && ['painted', 'loaded'].includes(sw.restored) && woke && log.some((e) => e.kind === 'sleep' && e.step === 'slept')`, 3000),
    noPageErrors('B'),
  ],
  // A tab with a draft typed into it (a real key press) isn't put to sleep;
  // one on a site that never sleeps isn't either.
  'sleep-kept': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'F', url: '/p/F1' }, { op: 'open', name: 'N', url: '/p/N' },
    wait(800), { op: 'install' }, drawn('A'), drawn('F'),
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
    checkPage('N', "N: on Margin's sleep page", `location.pathname === '/sleep/sleep.html'`, 3000),
  ],
  // Text in another site's frame (a comment box, a form) keeps its tab awake:
  // the page is asked in every frame (allFrames). One whose other site's frame
  // has nothing typed sleeps, its empty and srcdoc frames (WebKit runs nothing
  // there: the top frame looks into them) and a sandboxed one too. One with a
  // data: frame (no site: nothing may look into it) stays awake. (Margin
  // installed after the pages loaded: its watch there started late.)
  'sleep-frames': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'I', url: '/p/I1' }, { op: 'open', name: 'J', url: '/p/J1' }, { op: 'open', name: 'K', url: '/p/K1' },
    wait(800), { op: 'install' }, drawn('A'),
    checkPage('I', 'I: its frame loaded', `!!document.querySelector('iframe') && document.readyState === 'complete'`, 3000),
    check('A', 'a pass: the tab with text in its frame kept (edited), the one with a data: frame kept, the other put to sleep', `const r = await Margin.content.send('sleepNow', { afterMs: 1 }); console.log('[margin] sleep-frames pass ' + JSON.stringify(r)); return JSON.stringify(r) === JSON.stringify({ due: 3, slept: 1, skipped: { edited: 1, 'frame unknown': 1 }, stopped: null })`, 3000),
    checkPage('I', 'I: still its page', `location.pathname === '/p/I1'`),
    checkPage('K', 'K: still its page', `location.pathname === '/p/K1'`),
    checkPage('J', "J: on Margin's sleep page", `location.pathname === '/sleep/sleep.html'`, 3000),
  ],
  // Margin updated while a tab is asleep: its sleep page is the old copy's,
  // whose address no longer opens. It's moved to this copy's sleep page,
  // still asleep (hidden), and Safari's show wakes it there.
  'sleep-copy': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, drawn('A'), drawn('B'),
    sleepNow('A'),
    checkPage('B', "B: on Margin's sleep page", `location.pathname === '/sleep/sleep.html' && document.hidden`, 3000),
    { op: 'page', in: 'B', js: 'window.__old = location.origin; return location.origin' },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('B', "B: on this copy's sleep page now, still asleep", `!window.__old && location.pathname === '/sleep/sleep.html' && document.hidden && new URLSearchParams(location.search).get('u').endsWith('/p/B')`, 6000),
    { op: 'show', name: 'B' },
    checkPage('B', "B: Safari's show woke it, back at its page", `location.pathname === '/p/B' && document.title === 'B'`, 4000),
  ],
  'reloaded-newtab': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html' }, wait(1500),
    checkPage('N', "N: Margin's new-tab page drew the tabs", "document.querySelectorAll('[data-tab-id]').length >= 3", 4000),
    { op: 'page', in: 'N', js: 'window.__before = true; return location.href' },
    { op: 'page', in: 'A', js: 'window.__before = true; return "marked"' },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    // (In front: not loaded again there, 2026-11-04; once it's left, below.)
    checkPage('N', "N: loaded again at this copy's address, and it answers", "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return !window.__before && location.search === '?again' && document.readyState === 'complete' && await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])", 8000),
    wait(1500),
    checkPage('A', 'A (in front): not loaded again in front', 'window.__before === true'),
    { op: 'show', name: 'N' },
    checkPage('N', 'N shown: still open, its sidebar has every tab', "!document.hidden && document.querySelectorAll('[data-tab-id]').length >= 3", 4000),
    checkPage('A', 'A, left: loaded again, behind', '!window.__before && document.hidden', 4000),
    check('A', 'no hand-off closed N', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs).some((t) => /newtab\\.html\\?again/.test(t.url))`, 3000),
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
