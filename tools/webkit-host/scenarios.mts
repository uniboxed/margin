// Scenarios for the WebKit host: steps it plays, and checks that must pass.
// `node scenarios.mts <name>` prints one as JSON (run.sh does this).
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

// A step (the list above); scenarios are lists of them, printed as JSON.
type Step = { op: string, [field: string]: unknown };

// Margin's state from storage, by state key (shared/stored.ts: the keys
// holding tab ids have names of their own there): an expression for steps.
const STATE = '(async (keys) => { const raw = await browser.storage.local.get(null); const open = raw.openTabs ?? {}; const of = (k) => (["tabs", "tabSpace", "activeSpaceByWindow", "keptTabs"].includes(k) ? open[k] ?? (k === "keptTabs" ? {} : undefined) : k === "lostTabs" ? raw.lostTabs2 : k === "openTabsBy" ? (raw.openTabs ? { origin: open.origin, synced: open.synced } : null) : raw[k]); return Object.fromEntries([].concat(keys).map((k) => [k, of(k)])); })';
// The id of the tab showing /p/<name>, from Margin's own tab snapshot.
const ID = 'const { tabs } = await ' + STATE + '("tabs"); const id = (n) => Object.values(tabs).find((t) => t.url.endsWith("/p/" + n))?.id;';
const switchTo = (from: string, to: string, options: Record<string, unknown> = {}) => ({ op: 'eval', in: from, js: `${ID} return JSON.stringify(await Margin.content.send("activateTab", { tabId: id("${to}"), ...${JSON.stringify(options)} }) ?? null)` });
// `js`: an expression, or statements ending in `return …`.
const body = (js: string) => (/\breturn\b/.test(js) ? js : `return ${js}`);
const check = (tab: string, label: string, js: string, timeout?: number) => ({ op: 'check', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const checkPage = (tab: string, label: string, js: string, timeout?: number) => ({ op: 'checkPage', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const wait = (ms: number) => ({ op: 'wait', ms });
// Margin's core runs in this page and has the state. It draws nothing there,
// linked to Margin.app or not (Margin 2 Phase 2 step 5: the app draws Margin's UI).
const ready = (tab: string) => check(tab, `${tab}: Margin runs here, with the state`, `!!Margin.content?.getState?.().state?.spaces?.length`, 5000);
// No element of Margin's in the page, and no frame painted on it (the first paint handed over, or never there).
const NOTHING_DRAWN = `[...document.querySelectorAll('*')].every((el) => !el.localName.startsWith('margin-')) && getComputedStyle(document.documentElement, '::after').content === 'none'`;
const nothingDrawn = (tab: string, label = `${tab}: no element of Margin's in the page, no frame`) => checkPage(tab, label, NOTHING_DRAWN, 3000);
// Linked to Margin.app's real end of the link (the link server, started by appStart).
const linked = (tab: string) => check(tab, `${tab}: linked to Margin.app`, `Margin.content?.appDraws?.() === true`, 9000);
// Margin.app running (its real end of the link: the link server).
const appWith = () => ({ op: 'appStart' });
const shown = (tab: string) => checkPage(tab, `${tab} is the tab shown`, `!document.hidden`);
// Nothing Margin did reached the page's own error listeners (a ResizeObserver
// loop error from a paint barrier, say: host.swift's page log).
const noPageErrors = (tab: string) => checkPage(tab, `${tab}: no error reached the page`, `!(window.__pageLog ?? []).some((l) => l.startsWith('uncaught'))`);
const reload = (tab: string) => ({ op: 'page', in: tab, js: 'location.reload(); return "reloading"' });
// The page as it is (Margin puts no box around it: the page box was removed 2026-11-16, DECISIONS.md "Hosted only").
const bare = (tab: string) => checkPage(tab, `${tab}: the page as it is`, `getComputedStyle(document.documentElement).transform === 'none' && document.scrollingElement === document.documentElement && innerWidth === 1200`, 3000);

const rect = (id: string) => `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`;
const near = (a: string | number, b: string | number, by = 2) => `Math.abs((${a}) - (${b})) <= ${by}`;
// Margin.app linked, and a page.
const startLinked = (name: string, url: string): Step[] => [appWith(), { op: 'open', name, url, active: true }, wait(800), { op: 'install' }, linked(name), bare(name)];
const tick = 'await new Promise((resolve) => setTimeout(resolve, 80));';
// A real key, no modifiers unless given (arrows: 125 down, 126 up, chars as AppKit's).
const key = (tab: string, keyCode: number, chars: number, mods: string[] = []) => ({ op: 'key', in: tab, keyCode, chars: String.fromCharCode(chars), mods });
const ARROW_DOWN: [number, number] = [125, 0xF701];
const PAGE_DOWN: [number, number] = [121, 0xF72D];
const pressIn = (tab: string, at: [number, number]) => [{ op: 'mouse', in: tab, type: 'down', at: `return ${JSON.stringify(at)}` }, { op: 'mouse', in: tab, type: 'up' }];

// Sleeping tabs (background/sleep.ts): a pass asked for now, for tabs unused
// for a millisecond (the setting is hours), and what it did.
const sleepNow = (tab: string, label = 'a pass of sleeping tabs') => ({ op: 'eval', in: tab, js: `return JSON.stringify(await Margin.content.send('sleepNow', { afterMs: 1 }))`, label });
// A Margin tab opened again: its page, one history entry, its content there.
const awakeAt = (tab: string, name: string, label: string) => checkPage(tab, `${tab}: ${label}`, `location.pathname === '/p/${name}' && history.length === 1 && document.title === '${name}' && !!document.body?.textContent.includes('${name}')`, 4000);

// Margin's tabs (Margin 2: state/model.ts keptTabs). The kept (not open)
// Margin tab at /p/<name>, as statements in a check (`k` then).
const KEPT = (name: string) => `const k = Object.values((await ${STATE}('keptTabs')).keptTabs ?? {}).find((x) => x.url.endsWith('/p/${name}'));`;
// It clicked in the app's sidebar: the request its row sends (activateTab with its id: ui/actions.ts).
const openKept = (tab: string, name: string) => ({ op: 'eval', in: tab, js: `${KEPT(name)} return JSON.stringify(await Margin.content.send('activateTab', { tabId: k.id }) ?? null)` });
// The open tab's Margin id at /p/<name>, kept in `tab`'s content world as __mid<name>.
const keepMid = (tab: string, name: string) => ({ op: 'eval', in: tab, js: `const { tabs } = await ${STATE}('tabs'); globalThis.__mid${name} = Object.values(tabs).find((t) => t.url.endsWith('/p/${name}'))?.mid; return globalThis.__mid${name} ?? 'none'` });
// The page server's address (run.sh's MARGIN_HOST_PORT), for addresses Margin's own pages carry.
import { firstReadKeys } from '../../extension/shared/stored.ts';
const SERVER = `http://127.0.0.1:${process.env.MARGIN_HOST_PORT ?? 47811}`;
// Margin's sleep page as an earlier build left a tab on it (Safari closes sleeping tabs now, and
// the page is gone since Phase 3: its address opens nothing).
const OLD_SLEEP = (name: string) => `ext:sleep/sleep.html?${new URLSearchParams({ u: `${SERVER}/p/${name}`, t: name, k: `old-${name}` })}`;


export const SCENARIOS: Record<string, Step[]> = {
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
  // hung, as in real Safari on 2026-11-03): the page that asked is
  // answered before it stops waiting (3 s here: the host's background lives
  // about 5 s), that the tab is shown (background/tabs.ts focusTab), and the
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
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
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
  // Fast presses of the app's next-tab key (Margin 2: Safari reliability).
  // The sidebar lists the newest tab first, so from A the key goes to E, D,
  // C, B. The first press goes to Safari at once (E, whose update Safari is
  // slow to carry out); the next three come while it's with Safari, and only
  // the newest of them (B) is sent after it: D and C never come into view.
  // The overlay hears each press's 'switching' at once and a word for each.
  'fast-keys': [
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/C' },
    { op: 'open', name: 'D', url: '/p/D' }, { op: 'open', name: 'E', url: '/p/E' },
    wait(800), { op: 'install' }, linked('A'), ready('B'), ready('C'), ready('D'), ready('E'),
    ...['B', 'C', 'D', 'E'].map((tab) => ({ op: 'page', in: tab, js: "window.__seen = []; document.addEventListener('visibilitychange', () => __seen.push(document.visibilityState)); return 'counting'" })),
    { op: 'stall', name: 'E', ms: 600 },
    { op: 'appMark' },
    { op: 'appReq', type: 'navigate', payload: { action: 'next-tab' } },
    { op: 'appReq', type: 'navigate', payload: { action: 'next-tab' } },
    { op: 'appReq', type: 'navigate', payload: { action: 'next-tab' } },
    { op: 'appReq', type: 'navigate', payload: { action: 'next-tab' } },
    { op: 'appHeard', label: 'the overlay told at the press, with the press\'s switch', has: ['"ev":"push"', '"type":"switching"', '"switchId":"nav-'], timeout: 400 },
    checkPage('B', 'B, the last press\'s tab, is shown', '!document.hidden', 5000),
    { op: 'appHeard', label: 'its word: done', has: ['"ev":"push"', '"type":"switch-done"', '"switchId":"nav-'], timeout: 4000 },
    wait(500),
    checkPage('E', 'E, the first press\'s, came into view once and went', `JSON.stringify(__seen) === '["visible","hidden"]'`),
    checkPage('D', 'D, passed, never came into view', '__seen.length === 0 && document.hidden'),
    checkPage('C', 'C, passed, never came into view', '__seen.length === 0 && document.hidden'),
    checkPage('B', 'B came into view once', `JSON.stringify(__seen) === '["visible"]'`),
    { op: 'appHeard', label: 'the run is one line in Margin.app\'s log: 4 presses, Safari asked twice, 2 taken over, landed, never told backwards', has: ['"ev":"extension log"', 'key run in window', ': 4 tab presses, Safari asked 2 times, 2 skipped (a newer press took their place), landed ', 'highlight told backwards 0 times'], timeout: 2000 },
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
  // Tab ids: the same while a tab sleeps and wakes or reloads; all new when
  // Margin is updated (a new copy). Tabs keep their spaces either way
  // (state/model.ts syncTabs matches them by address).
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
  // Which copy of Margin is in charge (shared/owner.ts). An older copy
  // still running after an update writes its own tab ids under the old
  // storage names: pages don't read those (shared/stored.ts). While this
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
    { op: 'eval', in: 'A', js: `const w = Margin.content.getState().windowId; await browser.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', at: Date.now(), drawn: { [w]: true } } }); return 'linked in storage'` },
    check('A', 'A: the change reached it (linked)', `Margin.content.appDraws() === true`, 3000),
  ],
  // A pinch: Safari's own, smooth, Margin out of it, except what would open the overview.
  pinch: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'), 
    bare('A'), wait(300),
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
    // from a copy that's gone (background/cut-off.ts): not loaded again, as it's shown or after.
    { op: 'show', name: 'A' }, wait(2000),
    checkPage('A', 'A (the other copy\'s world, still running): not loaded again', 'window.__before === true', 1000),
  ],
  // S4 (2026-11-04): the next-tab key (⌥⌘↓ since 2026-11-08, ⌃⌘↓ before) on a
  // page that takes ArrowDown at every level goes to the next tab, through
  // Margin's listener (the host has no Safari menu: no command), and the page
  // never sees it. In Safari the command came only after the page had turned
  // the key down, so such a page ate it.
  commandkeys: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(500), { op: 'install' }, ready('A'), wait(300),
    { op: 'open', name: 'E', url: '/x/eats-arrows', active: true }, { op: 'open', name: 'B', url: '/p/B' }, ready('E'), ready('B'), wait(300),
    key('E', ...ARROW_DOWN, ['option', 'command']),
    checkPage('E', 'the next tab is shown (E left)', `document.hidden`, 2500),
    checkPage('E', 'E never saw the key', `__eaten.window === 0 && __eaten.document === 0 && __eaten.body === 0`),
    { op: 'show', name: 'E' }, wait(200),
    { op: 'page', in: 'E', js: `document.getElementById('t').focus(); return document.activeElement.id` },
    key('E', ...ARROW_DOWN, ['option', 'command']),
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
  // A hidden tab's title ticking (a chat, a timer: background/tab-updates.ts):
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
  // tab-updates.ts: after a restart tabs are matched to their records by it);
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
    check('A', 'A: the background still answers 12 s after install (20 requests)', `const said = await Promise.all(Array.from({ length: 20 }, () => Margin.content.send('windowState', {}, false))); return said.every((a) => a && typeof a.fullscreen === 'boolean')`, 4000),
    wait(10000),
    check('A', 'A: and 22 s after', `const said = await Promise.all(Array.from({ length: 20 }, () => Margin.content.send('windowState', {}, false))); return said.every((a) => a && typeof a.fullscreen === 'boolean')`, 4000),
  ],
  // The real extension linked to Margin.app's real end of the link (link-server: app/platforms/macos/shell's
  // ExtensionLink, LinkSocket, LinkMessage, Chunks), through the host's native messaging:
  // wantLink, the link dispatched into the copy's port, the WebSocket with its token and the
  // app's key, hello, the snapshot, the theme in pieces, a request from the app run by the
  // background. Then the app quitting (off at once), coming back (linked again), and crashing
  // (reconnecting, then off).
  'app-link': [
    { op: 'appStart' },
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' },
    check('A', 'A: linked to the app: the page draws no Margin UI', `Margin.content?.appDraws?.() === true`, 8000),
    nothingDrawn('A', 'A: linked: nothing of Margin\'s in the page'),
    bare('A'),
    check('A', 'A: the app\'s request (updateSettings) ran in the background', `const { settings } = await browser.storage.local.get('settings'); return settings?.sidebarShortcut === 'Alt+KeyJ'`, 5000),
    check('A', 'A: pages are told it\'s linked', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'linked'`, 3000),
    // ⌘T reaching the page while the app draws (its hot key would have taken it in Safari):
    // nothing visible, no tab made.
    { op: 'key', in: 'A', keyCode: 17, chars: 't', mods: ['command'] },
    wait(400),
    check('A', 'A: ⌘T in the page while linked: no new tab', `const { openTabs } = await browser.storage.local.get('openTabs'); return Object.keys(openTabs?.tabs ?? {}).length === 1`, 2000),
    { op: 'appQuit' },
    check('A', 'A: the app quit (bye): off at once', `Margin.content.appDraws() === false`, 3000),
    bare('A'),
    { op: 'appStart' }, reload('A'),
    check('A', 'A: the app back, a page starting: linked again', `Margin.content?.appDraws?.() === true`, 9000),
    { op: 'appKill' },
    wait(800),
    check('A', 'A: the app gone without a word: reconnecting, still nothing drawn', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'reconnecting' && Margin.content.appDraws() === true`, 3000),
    check('A', 'A: and once it\'s clear it\'s gone, off', `Margin.content.appDraws() === false`, 9000),
    bare('A'), nothingDrawn('A'),
  ],
  // The app back after quitting while Safari loses the handler's answers (as 27.2 does when several
  // profiles' copies ask at once): the copy takes the link dispatched into its port without the
  // answer, as a page starts (before the fix it waited for the answer forever).
  'app-link-lost': [
    { op: 'appStart' },
    { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' },
    check('A', 'A: linked to the app', `Margin.content?.appDraws?.() === true`, 8000),
    { op: 'appQuit' },
    check('A', 'A: the app quit (bye): off', `Margin.content.appDraws() === false`, 3000),
    { op: 'appLoseAnswers', count: 3 }, { op: 'appStart' }, reload('A'),
    check('A', 'A: the app back, its answers lost: linked again from the link alone', `Margin.content?.appDraws?.() === true`, 9000),
    check('A', 'A: and the app said hello to it', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'linked'`, 3000),
  ],
};

// Safari reloading Margin while pages are open (an update, or Margin.app opened): it keeps
// Margin's content-script world in those pages, still bound to the copy that's gone, where
// nothing answers (background/cut-off.ts). The page in front and the ones behind are loaded
// again; one with a draft typed keeps it; switches then work and every page answers, a new tab
// loads and comes to the front.
const answers = (tab: string) => check(tab, `${tab}: its Margin answers (storage and the background)`, "const later = (ms) => new Promise((r) => setTimeout(() => r(false), ms)); return (await Promise.race([browser.storage.local.get('owner').then(() => true), later(1000)])) && (await Promise.race([Margin.content.send('sidebarScroll').then(() => true), later(1500)]))", 3000);
Object.assign(SCENARIOS, {
  reloaded: [
    appWith(),
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'B', url: '/p/B' }, { op: 'open', name: 'C', url: '/p/FC' }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install', sameId: true }, linked('A'), wait(800),
    reload('A'), reload('B'), reload('C'), wait(1500), bare('A'), bare('B'), bare('C'),
    ...['A', 'B', 'C'].map((t) => ({ op: 'page', in: t, js: 'window.__before = true; return "marked"' })),
    { op: 'page', in: 'C', js: `document.getElementById('t').value = 'draft'; return 'typed'` },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    checkPage('B', 'B (behind): loaded again', '!window.__before', 8000),
    // (2026-11-04: never loaded again in front; once it's left, below.)
    checkPage('A', 'A (in front, nothing typed), left with the old copy: not loaded again in front, nothing of Margin\'s in it', `window.__before === true && ${NOTHING_DRAWN}`, 3000),
    checkPage('C', 'C (a draft typed): not loaded again, the draft kept', `window.__before === true && document.getElementById('t').value === 'draft'`, 3000),
    { op: 'show', name: 'B' }, shown('B'), answers('B'), linked('B'), bare('B'),
    checkPage('A', 'A, left: loaded again, behind', '!window.__before && document.hidden', 4000),
    switchTo('B', 'D'), shown('D'), answers('D'), bare('D'),
    switchTo('D', 'FC'), shown('C'),
    checkPage('C', 'C shown: still the draft, nothing of Margin\'s over it', `document.getElementById('t').value === 'draft' && document.body.style.opacity !== '0' && ${NOTHING_DRAWN}`, 2000),
    switchTo('B', 'A'), shown('A'), answers('A'),
    { op: 'eval', in: 'A', js: `return JSON.stringify(await Margin.content.send('newTab', { url: location.origin + '/p/S1' }) ?? null)` },
    checkPage('new1', 'a new tab: made, loaded and in front', `!document.hidden && document.readyState === 'complete' && location.pathname === '/p/S1'`, 8000),
    answers('new1'), bare('new1'),
  ],
  // A tab put to sleep (background/sleep.ts; Margin 2): Margin closes its
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
  // linked to Margin.app: no element of Margin's, no frame, none of
  // Margin's page scripts, on a page open at install and on one loaded
  // since; ⌘T in a page opens
  // Margin's new-tab page, which says the app isn't running.
  'no-ui': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    nothingDrawn('A'), bare('A'),
    checkPage('A', 'A: none of Margin\'s page scripts', `!window[Symbol.for('margin.page')]`),
    check('A', 'A: not linked, nothing drawn here', `Margin.content.appDraws() === false && Margin.content.runtime === undefined`),
    { op: 'open', name: 'B', url: '/p/B', active: true }, ready('B'), nothingDrawn('B'), bare('B'),
    checkPage('B', 'B (loaded since): none of Margin\'s page scripts either', `!window[Symbol.for('margin.page')]`),
    { op: 'key', in: 'B', keyCode: 17, chars: 't', mods: ['command'] },
    checkPage('new1', 'new1: ⌘T in the page: Margin\'s new-tab page, saying Margin.app isn\'t running, with an address field', `location.pathname === '/newtab/newtab.html' && !document.getElementById('notice').hidden && !!document.getElementById('address')`, 4000),
    check('B', 'B: one new tab for the press', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs).filter((t) => t.url.includes('/newtab/newtab.html')).length === 1`, 2000),
  ],
  // Linked: still nothing of Margin's in a page, on one open and one loaded
  // since. The link dropping (the app killed): reconnecting; once the grace
  // is over (GONE_MS), off, on the page in front and the one behind, and a
  // page loaded then has nothing of Margin's either. The app back: linked
  // again as a page starts.
  'link-drop': [
    appWith(), { op: 'open', name: 'A', url: '/p/T', active: true }, wait(800), { op: 'install' },
    linked('A'), bare('A'), nothingDrawn('A', 'A: linked: still nothing of Margin\'s in the page'),
    { op: 'open', name: 'B', url: '/p/B', active: true }, bare('B'), nothingDrawn('B'),
    checkPage('B', 'B (loaded while linked): none of Margin\'s page scripts (nothing registered)', `!window[Symbol.for('margin.page')]`),
    { op: 'appKill' }, wait(800),
    check('B', 'B: the link dropped: reconnecting', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'reconnecting'`, 3000),
    check('B', 'B: the grace over: off', `Margin.content.appDraws() === false`, 10000), bare('B'),
    nothingDrawn('B', 'B: off: nothing of Margin\'s, no frame'),
    check('A', 'A (behind): off too', `Margin.content.appDraws() === false`, 2000),
    wait(1000), { op: 'open', name: 'C', url: '/p/C', active: true }, ready('C'), bare('C'), nothingDrawn('C', 'C (loaded once off): nothing of Margin\'s, no frame'),
    checkPage('C', 'C: none of Margin\'s page scripts', `!window[Symbol.for('margin.page')] && !document.documentElement.hasAttribute('data-margin-at')`),
    appWith(), reload('C'),
    linked('C'), bare('C'),
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
  // behind is linked too.
  'newtab-start': [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: true },
    checkPage('N', 'N: the start button', `!document.getElementById('start').hidden`, 5000),
    { op: 'appOnDemand' },
    { op: 'page', in: 'N', js: `document.getElementById('start').click(); return document.getElementById('status').textContent` },
    checkPage('N', 'N: linked: loaded again, the app draws it (the page shows nothing of its own)', `document.getElementById('notice')?.hidden === true && (await browser.storage.local.get('appLink')).appLink?.state === 'linked'`, 12000),
    check('A', 'A (behind): linked', `Margin.content.appDraws() === true`, 3000),
    bare('A'),
  ],

  // The socket guard (Margin 2: Safari reliability): a background that finds the note of a socket
  // being opened left behind (one before it never got past `new WebSocket`, or Safari quit just then)
  // makes no socket for the rest of the Safari session. The new-tab page says Margin turned its link
  // off and when, with Try again and no Start; Try again links at once, and the page is the app's.
  'link-guard': [
    appWith(),
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install', sameId: true }, linked('A'),
    { op: 'eval', in: 'A', js: `await browser.storage.local.set({ appLinkOpening: { at: Date.now() } }); return 'left'` },
    { op: 'uninstall', keepWorld: true }, wait(100), { op: 'install', sameId: true },
    // (A's content world is the old copy's now: read in Margin's own page.)
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: true },
    checkPage('N', 'pages: off, why sockets-off, since when', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'off' && appLink?.why === 'sockets-off' && appLink.offAt > 0 && appLink.offUntil === undefined`, 9000),
    checkPage('N', 'N: Margin turned its link off, when, Try again, no Start', `!document.getElementById('notice').hidden && document.getElementById('title').textContent === 'Margin turned its link off' && /^Margin turned its link off at .+ after a socket never opened\. It tries again when Safari next starts\.$/.test(document.getElementById('why').textContent) && !document.getElementById('retry').hidden && document.getElementById('start').hidden`, 5000),
    { op: 'page', in: 'N', js: `document.getElementById('retry').click(); return 'clicked'` },
    checkPage('N', 'N: Try again links: loaded again, drawn by the app', `document.getElementById('notice')?.hidden === true && (await browser.storage.local.get('appLink')).appLink?.state === 'linked'`, 9000),
    checkPage('N', 'the guard\'s notes gone', `const got = await browser.storage.local.get(['appLinkOff', 'appLinkHung', 'appLinkOpening']); return Object.keys(got).length === 0`, 3000),
  ],

  // Margin.app running but every link it dispatches refused (one an update
  // left running, before scripts/safari.sh quit it: SFErrorDomain 1): the
  // new-tab page says it isn't answering, with no start button (it's
  // running); asked again 5 s later, and linked once the app's dispatches go
  // through: the page is the app's from then on.
  'newtab-no-link': [
    appWith(), { op: 'appRefuse' },
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, ready('A'),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html', active: true },
    checkPage('N', 'N: Margin.app isn\'t answering, no start button, the address field', `!document.getElementById('notice').hidden && document.getElementById('title').textContent === 'Margin.app isn’t answering' && document.getElementById('start').hidden && !!document.getElementById('address')`, 8000),
    check('A', 'pages: off, why no-link', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'off' && appLink?.why === 'no-link'`, 2000),
    { op: 'appHeard', label: 'the app\'s link refused, never delivered', has: ['"ev":"dispatch refused"', '"name":"link"'] },
    { op: 'appRefuse', refuse: false },
    checkPage('N', 'N: asked again 5 s later and linked: loaded again, drawn by the app', `document.getElementById('notice')?.hidden === true && (await browser.storage.local.get('appLink')).appLink?.state === 'linked'`, 9000),
    check('A', 'pages: linked, no why left', `const { appLink } = await browser.storage.local.get('appLink'); return appLink?.state === 'linked' && appLink.why === undefined`, 2000),
    linked('A'), bare('A'),
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
    appWith(),
    { op: 'open', name: 'A', url: '/p/FA', active: true }, { op: 'open', name: 'B', url: '/p/B' },
    wait(800), { op: 'install', sameId: true }, linked('A'), wait(800),
    reload('A'), reload('B'), wait(1500), bare('A'),
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
    linked('A'), bare('A'),
  ],
  // A new tab from nothing opening the same web page twice (Safari's "New
  // tabs open with" isn't Margin): the window told "new-tab-setting" once its
  // page says it was opened from nothing; "Don't show again" from the app
  // turns the note off.
  'notice-newtab': [
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'),
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
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(600),
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
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(300),
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
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), wait(500),
    { op: 'eval', in: 'A', js: `const keys = ${JSON.stringify(firstReadKeys())}; const time = async (k) => { const t = performance.now(); const r = await browser.storage.local.get(k); return [performance.now() - t, JSON.stringify(r).length]; }; const measure = async () => { const runs = { all: [], first: [] }; for (let i = 0; i < 7; i++) { runs.all.push(await time(null)); runs.first.push(await time(keys)); } const med = (l) => l.map((x) => x[0]).sort((a, b) => a - b)[3].toFixed(1); return 'get(null) ' + med(runs.all) + ' ms, ' + runs.all[0][1] + ' bytes; the first read now ' + med(runs.first) + ' ms, ' + runs.first[0][1] + ' bytes'; }; const stored = JSON.stringify((await browser.storage.local.get('uiTheme')).uiTheme ?? null).length; const builtIn = await measure(); await browser.storage.local.set({ uiTheme: { id: 'big', version: '1', pkg: { id: 'big', manifest: '{}', html: '', css: '', files: { 'fonts/a.woff2': 'A'.repeat(3000000) } } } }); const big = await measure(); return 'the built-in theme stored (' + stored + ' bytes): ' + builtIn + ' | a 3 MB theme stored: ' + big` },
    reload('A'), ready('A'),
    check('A', 'A: its first read took no theme package (a 3 MB one stored)', `!('uiTheme' in Margin.content.getState().state)`),
    bare('A'),
  ],
  // A window Margin.app draws nothing over (Margin 2: Safari reliability): the shell tells the copy
  // `drawn` false for a window it hasn't bound, or one not in full screen (here `appDrawn`). ⌘T in
  // that window opens Margin's new-tab page, which stays, and says Margin.app hasn't placed the window
  // (its address field, no Start).
  'undrawn': [
    appWith(), { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, linked('A'), bare('A'),
    { op: 'appDrawn', on: false },
    check('A', 'A: the copy keeps the app\'s word that it draws nothing over the window', `const { appLink } = await browser.storage.local.get('appLink'); return !!appLink?.drawn && Object.values(appLink.drawn).includes(false)`, 2000),
    bare('A'),
    // ⌘T there (the app's hot key isn't on over a window it doesn't draw): the unlinked way, Margin's
    // new-tab page, and it stays (no palette to hand it to).
    { op: 'show', name: 'A' }, shown('A'),
    { op: 'key', in: 'A', keyCode: 17, chars: 't', mods: ['command'] },
    checkPage('new1', 'new1: ⌘T in the page of the undrawn window: Margin\'s new-tab page', `location.pathname === '/newtab/newtab.html'`, 4000),
    checkPage('new1', 'new1: it says Margin.app hasn\'t placed this window, with the address field, no Start, nothing about the app not running', `!document.getElementById('notice').hidden && document.getElementById('title').textContent === 'Margin.app hasn’t placed this window yet' && document.getElementById('start').hidden && !!document.getElementById('address') && !document.body.textContent.includes('isn’t running')`, 4000),
    wait(1000),
    check('A', 'A: one new tab for the press, kept (not closed for a palette that isn\'t drawn)', `const { tabs } = await ${STATE}('tabs'); return Object.values(tabs).filter((t) => t.url.includes('/newtab/newtab.html')).length === 1`, 2000),
  ],
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  const steps = SCENARIOS[name];
  if (!steps) {
    console.error(`unknown scenario "${name}"; one of: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(steps));
}
