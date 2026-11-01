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

export const SCENARIOS = {
  // Pages open at install get Margin (WebKit adds the core, the background
  // the theme); switching through Margin, including to a tab Safari unloaded.
  switching: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(1000), { op: 'install' },
    drawn('A'), themed('A'), drawn('B'),
    switchTo('A', 'B', { show: 'hover' }), shown('B'),
    checkPage('B', 'B: the carried sidebar is open on its first shown frame', `document.querySelector('margin-sidebar-host')?.dataset.open === 'true'`),
    check('B', 'B: hidden sidebar preparation acknowledged before activation', `(await Margin.content.send('switchLog')).some((entry) => entry.source === 'activateTab' && entry.preparation?.outcome === 'ready')`),
    switchTo('B', 'D'), shown('D'), drawn('D'), themed('D'),
    switchTo('D', 'C'), shown('C'), { op: 'state' },
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
    // What the stand-in can't see is still read from <body> itself.
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
    checkPage('S', 'S: shown once it had loaded', `const nav = performance.getEntriesByType('navigation')[0]; const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && nav.loadEventEnd > 0 && performance.timeOrigin + nav.loadEventEnd <= shownAt + 5`),
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
    checkPage('S', 'S: shown once it had loaded', `const nav = performance.getEntriesByType('navigation')[0]; const shownAt = window.__vis.find((e) => e[0] === 'shown')?.[1]; return !!shownAt && nav.loadEventEnd > 0 && performance.timeOrigin + nav.loadEventEnd <= shownAt + 5`),
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
    checkPage('A', 'A (in front, nothing typed), left with the old copy: loaded again', '!window.__before', 8000),
    checkPage('B', 'B (behind): loaded again', '!window.__before', 8000),
    boxed('A'), themed('A'), answers('A'),
    checkPage('C', 'C (a draft typed): not loaded again, the draft kept', `window.__before === true && document.getElementById('t').value === 'draft'`, 3000),
    checkPage('C', 'C: the old copy\'s dead sidebar out of sight', "[...document.querySelectorAll('margin-sidebar-host')].every((h) => getComputedStyle(h).display === 'none')", 3000),
    settled('A', 'A: covers lifted, its sidebar has every tab', 4),
    ...click('A', 'B'), shown('B'), settled('B', 'A to B from the sidebar: covers lifted, every tab there', 4),
    ...click('B', 'D'), shown('D'), settled('D', 'B to D (asleep) from the sidebar: loaded, covers lifted', 4),
    ...click('D', 'FC'), shown('C'),
    checkPage('C', 'C shown: still the draft, no dead cover over it', `document.getElementById('t').value === 'draft' && document.body.style.opacity !== '0' && [...document.querySelectorAll('margin-sidebar-host')].every((h) => getComputedStyle(h).display === 'none')`, 2000),
    switchTo('B', 'A'), shown('A'), settled('A', 'back on A: covers lifted', 4),
    ...newTabRound(1, 5),
  ],
  // The same reload with Margin's new-tab page open: that page is the old copy's, at its address,
  // and nothing in it answers. It's loaded again at this copy's address (marked as not a new tab:
  // ⌘T's hand-off would close it), then shown with every tab.
  'reloaded-newtab': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html' }, wait(1500),
    checkPage('N', "N: Margin's new-tab page drew the tabs", "document.querySelectorAll('[data-tab-id]').length >= 3", 4000),
    { op: 'page', in: 'N', js: 'window.__before = true; return location.href' },
    { op: 'page', in: 'A', js: 'window.__before = true; return "marked"' },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('A', 'A: loaded again', '!window.__before', 8000),
    checkPage('N', "N: loaded again at this copy's address, and it answers", "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return !window.__before && location.search === '?again' && document.readyState === 'complete' && await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])", 8000),
    wait(1500),
    { op: 'show', name: 'N' },
    checkPage('N', 'N shown: still open, its sidebar has every tab', "!document.hidden && document.querySelectorAll('[data-tab-id]').length >= 3", 4000),
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
