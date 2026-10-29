// Scenarios for the WebKit host: steps it plays, and checks that must pass.
// `node scenarios.mjs <name>` prints one as JSON (run.sh does this).
//
// Steps (host.swift):
//   { op: 'open', name, url: '/p/A' | 'ext:<path>', active?, asleep? }  a tab
//   { op: 'install', sameId? } / { op: 'uninstall' }  Margin (sameId: as an update would)
//   { op: 'sleep', name }      the tab's web view goes away (Safari unloading it)
//   { op: 'wait', ms }
//   { op: 'eval', in, js }     run JS in Margin's content-script world of a tab, log the result
//   { op: 'page', in, js }     the same in the page's own world
//   { op: 'check' | 'checkPage', in, js, label, timeout? }  wait until js returns true
//   { op: 'state' }            log which tab is shown, hidden or asleep
//   { op: 'snapshot', file }   PNG of the shown tab
//   { op: 'deny', pattern }    take a site permission away (as in Safari's settings)
//   { op: 'zoom', factor }     the shown tab's page zoom (as ⌘+ / ⌘−)
//   { op: 'show', name }       Safari itself bringing a tab to the front (its tab bar)
//   { op: 'flip', to, back }   one tab to the front and another back, in the same run loop turn
//   { op: 'probeShow', name, nth? }  count the web view's layers in each turn committed after
//                              the nth show of the tab from now on (empty: WebKit's empty view)
//   { op: 'checkProbe', name, maxMs, label }  that show had its content within maxMs
//   { op: 'showProbe', name }  show a tab and log the same, with how long the show took
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
// In a checkPage/page step: the card's window and document (fitted layout).
const CARD = "const f = document.querySelector('iframe[name^=margin-]'); const w = f.contentWindow; const d = f.contentDocument;";

// In a page step: wheel events with these deltaX, 10ms apart, over the
// new-tab page's sidebar list (as a trackpad sends them); waits for the last.
const SWIPE = (deltas) => `await new Promise((resolve) => { const target = document.querySelector('#sidebar .tabs-section'); const d = ${JSON.stringify(deltas)}; let i = 0; const tick = () => { if (i >= d.length) return resolve(); target.dispatchEvent(new WheelEvent('wheel', { deltaX: d[i++], bubbles: true, cancelable: true, composed: true })); setTimeout(tick, 10); }; tick(); });`;
// Margin drew its sidebar here (the core sets data-open once the theme is mounted).
const drawn = (tab) => checkPage(tab, `${tab}: Margin's sidebar is there`, `document.querySelector('margin-sidebar-host')?.dataset.open !== undefined`, 5000);
const themed = (tab) => check(tab, `${tab}: the Arcadium theme is mounted`, `globalThis.Margin?.theme?.id === 'arcadium'`, 5000);
const shown = (tab) => checkPage(tab, `${tab} is the tab shown`, `!document.hidden`);
const keepOpen = { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("updateSettings", { patch: { sidebarPinnedOpen: true } }))' };
const reload = (tab) => ({ op: 'page', in: tab, js: 'location.reload(); return "reloading"' });
const fitted = (tab) => checkPage(tab, `${tab}: the page is fitted beside the sidebar`, `document.documentElement.hasAttribute('data-margin-shell') && !!document.querySelector('iframe[name^=margin-]')`, 5000);

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
  // "Keep open" with the fitted layout, then a tab Safari unloaded shown.
  fitted: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true },
    wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(800), reload('A'),
    fitted('A'), drawn('A'),
    switchTo('A', 'D'), shown('D'), fitted('D'), themed('D'),
  ],
  // A fitted page's own history: pushState entries, Back through them, and a
  // pushState that bypasses Margin (YouTube calls one from another frame).
  history: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(800), reload('A'), fitted('A'),
    { op: 'page', in: 'A', js: `${CARD} w.history.pushState({ n: 1 }, '', '/p/A/one'); w.history.pushState({ n: 2 }, '', '/p/A/two'); return 'pushed'` },
    checkPage('A', 'after two pushes, the top and the card are on /p/A/two', `${CARD} return location.pathname === '/p/A/two' && w.location.pathname === '/p/A/two'`),
    { op: 'page', in: 'A', js: 'history.back(); return "back"' },
    checkPage('A', 'Back: both on /p/A/one with its state', `${CARD} return location.pathname === '/p/A/one' && w.location.pathname === '/p/A/one' && w.history.state?.n === 1`),
    { op: 'page', in: 'A', js: 'history.back(); return "back"' },
    checkPage('A', 'Back again: both on /p/A', `${CARD} return location.pathname === '/p/A' && w.location.pathname === '/p/A'`),
    { op: 'page', in: 'A', js: `${CARD} const i = d.createElement('iframe'); d.body.append(i); i.contentWindow.History.prototype.pushState.call(w.history, {}, '', '/p/A/yt'); return 'bypassed'` },
    checkPage('A', 'a pushState past Margin still updates the address bar', `${CARD} return w.location.pathname === '/p/A/yt' && location.pathname === '/p/A/yt'`),
  ],
  // A page Margin doesn't fit (turned off for the site): Keep open pushes it
  // by the full sidebar. The narrow rail is off for now (platform.compactRail),
  // whatever the setting says.
  rail: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen,
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("setFitSite", { origin: location.origin, fit: false }))' },
    wait(800), reload('A'), drawn('A'),
    checkPage('A', 'A: not fitted, pushed by the full sidebar (no rail)', `!document.documentElement.hasAttribute('data-margin-shell') && document.querySelector('margin-sidebar-host').dataset.rail === 'off' && parseFloat(getComputedStyle(document.documentElement).marginLeft) >= 160`, 5000),
  ],
  // The new-tab page loads the active theme's module.
  newtab: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, wait(2000),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: Arcadium\'s launcher is drawn', `!!document.querySelector('#launcher')`, 5000),
    checkPage('N', 'N: its sidebar lists the tabs', `document.querySelectorAll('#sidebar .tab').length >= 2`),
    checkPage('N', 'N: Settings shows the theme', `document.querySelector('#theme')?.value === 'arcadium'`),
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
  // the page is pushed, or its card placed, by the sidebar's width in the
  // page's zoomed pixels; the new-tab page's sidebar too.
  zoom: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(1000),
    { op: 'snapshot', file: new URL('build/zoom-100.png', import.meta.url).pathname },
    { op: 'zoom', factor: 1.5 },
    checkPage('A', 'pushed: Margin scaled back, the page pushed by 260/1.5', `const h = document.querySelector('margin-sidebar-host'); return Math.abs(parseFloat(h.style.zoom) - 1 / 1.5) < 0.001 && Math.abs(parseFloat(getComputedStyle(document.documentElement).marginLeft) - 260 / 1.5) < 0.5`, 3000),
    { op: 'snapshot', file: new URL('build/zoom-150.png', import.meta.url).pathname },
    { op: 'zoom', factor: 1 },
    checkPage('A', 'back to 100%: no scaling, pushed by 260', `const h = document.querySelector('margin-sidebar-host'); return !h.style.zoom && parseFloat(getComputedStyle(document.documentElement).marginLeft) === 260`, 3000),
    reload('A'), fitted('A'), { op: 'zoom', factor: 1.5 },
    checkPage('A', 'fitted: the card placed by 260/1.5', `const f = document.querySelector('iframe[name^=margin-]'); return Math.abs(parseFloat(f.style.left) - 260 / 1.5) < 0.5`, 3000),
    { op: 'snapshot', file: new URL('build/zoom-150-fitted.png', import.meta.url).pathname },
    // Reloaded at 150%: the site's zoom is remembered, so Margin is drawn at
    // its size from its first render (before the browser has answered).
    reload('A'), drawn('A'),
    checkPage('A', 'reloaded at 150%: scaled back as soon as drawn', `Math.abs(parseFloat(document.querySelector('margin-sidebar-host').style.zoom) - 1 / 1.5) < 0.001`, 100),
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
  unloaded: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, { op: 'open', name: 'D', url: '/p/D', asleep: true }, wait(800), { op: 'install', sameId: true }, drawn('A'), wait(800),
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
    { op: 'installTwin' }, wait(2500),
    { op: 'open', name: 'B', url: '/p/B', active: true },
    check('B', 'B: one copy runs in the shared world', `!!globalThis.Margin?.content && document.querySelectorAll('margin-sidebar-host').length === 1`, 4000),
    // Which copy the page runs is WebKit's pick: the newer one draws; the
    // older one stands back, saying why.
    check('B', 'B: either it runs the copy in charge, or it stands back and says why', `const log = globalThis.__marginLog ?? []; const s = await browser.storage.local.get('openTabs'); return (log.some((l) => l.includes('stays out of the way')) && !Margin.content.active()) || (s.openTabs?.origin === browser.runtime.getURL('') && s.openTabs.synced && Margin.content.active())`, 5000),
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
  // The same in the fitted layout: the card is what's hidden under the cover.
  behindfitted: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen, wait(500), reload('A'), fitted('A'),
    { op: 'eval', in: 'A', js: `const request = Margin.content.send('newTab', { url: location.origin + '/p/S5' }); Margin.content.startSwitching(-1, request); return 1` },
    checkPage('new1', 'the new tab loads behind, fitted', `document.hidden && !!document.querySelector('iframe[name^=margin-]')`, 1500),
    { op: 'page', in: 'new1', js: `window.__arrival = []; const note = (why) => { const h = document.querySelector('margin-sidebar-host'); __arrival.push([why, document.hidden, h?.dataset.arrivalCover ?? '', document.querySelector('iframe[name^=margin-]')?.style.opacity ?? '']); }; document.addEventListener('visibilitychange', () => note('shown')); return 'recording'` },
    checkPage('new1', 'then comes to the front', `!document.hidden`, 3000),
    checkPage('new1', 'first shown covered, the card hidden under the cover', `__arrival.some(([why, hidden, cover, vis]) => why === 'shown' && !hidden && cover === 'true' && vis === '0')`, 1000),
    checkPage('new1', 'then the card back and the cover lifted', `document.querySelector('margin-sidebar-host').dataset.arrivalCover === 'false' && document.querySelector('iframe[name^=margin-]').style.opacity !== '0'`, 1500),
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
  // A picture of a fitted page, for a look (build/screenshot.png).
  screenshot: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'),
    keepOpen, wait(800), reload('A'), fitted('A'), wait(500),
    { op: 'snapshot', file: new URL('build/screenshot.png', import.meta.url).pathname },
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  if (!SCENARIOS[name]) {
    console.error(`unknown scenario "${name}"; one of: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(SCENARIOS[name]));
}
