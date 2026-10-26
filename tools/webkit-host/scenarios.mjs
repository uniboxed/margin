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

// The id of the tab showing /p/<name>, from Margin's own tab snapshot.
const ID = 'const { tabs } = await browser.storage.local.get("tabs"); const id = (n) => Object.values(tabs).find((t) => t.url.endsWith("/p/" + n))?.id;';
const switchTo = (from, to) => ({ op: 'eval', in: from, js: `${ID} return JSON.stringify(await Margin.content.send("activateTab", { tabId: id("${to}") }) ?? null)` });
// `js`: an expression, or statements ending in `return …`.
const body = (js) => (/\breturn\b/.test(js) ? js : `return ${js}`);
const check = (tab, label, js, timeout) => ({ op: 'check', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const checkPage = (tab, label, js, timeout) => ({ op: 'checkPage', in: tab, label, js: body(js), ...(timeout ? { timeout } : {}) });
const wait = (ms) => ({ op: 'wait', ms });
// In a checkPage/page step: the card's window and document (fitted layout).
const CARD = "const f = document.querySelector('iframe[name^=margin-]'); const w = f.contentWindow; const d = f.contentDocument;";

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
    switchTo('A', 'B'), shown('B'),
    switchTo('B', 'D'), shown('D'), drawn('D'), themed('D'),
    switchTo('D', 'C'), shown('C'), { op: 'state' },
  ],
  // Margin updated while a page with a typed draft is open: the new copy
  // takes over, the draft stays, one sidebar.
  update: [
    { op: 'open', name: 'F1', url: '/p/F1', active: true }, { op: 'open', name: 'A', url: '/p/A' },
    wait(800), { op: 'install', sameId: true }, drawn('F1'),
    { op: 'page', in: 'F1', js: 'document.getElementById("t").value = "unsaved draft"; return "typed"' },
    { op: 'uninstall' }, wait(800), { op: 'install', sameId: true }, wait(3000),
    checkPage('F1', 'F1: the draft is still there', `document.getElementById('t').value === 'unsaved draft'`),
    // The old copy's scripts stay alive and may put its host back, hidden.
    checkPage('F1', 'F1: one sidebar shows (the old copy\'s is hidden)', `[...document.querySelectorAll('margin-sidebar-host')].filter((h) => getComputedStyle(h).display !== 'none').length === 1`),
    drawn('F1'),
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
  // A page Margin doesn't fit (turned off for the site): Keep open shows the
  // narrow rail and pushes the page by it only; resting on the rail opens
  // the full sidebar over the page, which doesn't move.
  rail: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, drawn('A'), keepOpen,
    { op: 'eval', in: 'A', js: 'return JSON.stringify(await Margin.content.send("setFitSite", { origin: location.origin, fit: false }))' },
    wait(800), reload('A'), drawn('A'),
    checkPage('A', 'A: not fitted, pushed by the rail only', `!document.documentElement.hasAttribute('data-margin-shell') && document.querySelector('margin-sidebar-host').dataset.rail === 'rail' && getComputedStyle(document.documentElement).marginLeft === '52px'`, 5000),
    { op: 'eval', in: 'A', js: 'Margin.content.sidebar.show("hover"); return "hovered"' },
    checkPage('A', 'A: the full sidebar over the page, which stays at the rail', `document.querySelector('margin-sidebar-host').dataset.rail === 'expanded' && getComputedStyle(document.documentElement).marginLeft === '52px'`),
    { op: 'eval', in: 'A', js: 'Margin.content.sidebar.hide(); return "left"' },
    checkPage('A', 'A: back to the rail', `document.querySelector('margin-sidebar-host').dataset.rail === 'rail'`),
  ],
  // The new-tab page loads the active theme's module.
  newtab: [
    { op: 'open', name: 'A', url: '/p/A', active: true }, wait(800), { op: 'install' }, wait(2000),
    { op: 'open', name: 'N', url: 'ext:newtab/newtab.html#launcher', active: true },
    checkPage('N', 'N: Arcadium\'s launcher is drawn', `!!document.querySelector('#launcher')`, 5000),
    checkPage('N', 'N: its sidebar lists the tabs', `document.querySelectorAll('#sidebar .tab').length >= 2`),
    checkPage('N', 'N: Settings shows the theme', `document.querySelector('#theme')?.value === 'arcadium'`),
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
