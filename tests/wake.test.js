// The wake before a switch (background/tabs.js wakeTab, focusTab) and the
// ⌘T-opens-the-homepage note (background/newtab-hint.js), against a fake
// browser API (Safari's: the note is Safari-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// tabs: id → { id, url, active, windowId, status }. `scriptDelay(tabId)`:
// how long the page takes to run a script (null: no page, it fails at once).
const fake = {
  tabs: new Map(),
  scriptDelay: () => 0,
  scripts: [],
  updates: [],
  messages: [],
  created: [],
  session: {},
  local: {},
  reply: true, // what a page answers: true once it showed the note
  // What a page's sidebar answers when asked to prepare (default: ready).
  prepare: (args) => ({ ready: true, token: args?.[0]?.token }),
  contentScripts: undefined, // the manifest's
};
globalThis.chrome = {
  runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ version: '0', content_scripts: fake.contentScripts }) },
  permissions: { contains: async () => true },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { ...tab };
    },
    // `fake.activated`: told as Safari tells onActivated, as it brings the tab
    // to the front (before it answers).
    update: async (id, change) => {
      fake.updates.push({ id, change, at: Date.now() });
      const tab = fake.tabs.get(id);
      const was = tab.active;
      for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      if (change.active && !was) fake.activated?.({ tabId: id, windowId: tab.windowId });
      return { ...tab };
    },
    query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)),
    // A new tab, still loading (a test says when it's loaded).
    create: async ({ windowId = 1, url, active = true }) => {
      const id = Math.max(0, ...fake.tabs.keys()) + 1;
      fake.created.push({ id, url, active });
      fake.tabs.set(id, { id, windowId, url, status: 'loading', active: false });
      if (active) for (const t of fake.tabs.values()) if (t.windowId === windowId) t.active = t.id === id;
      return { ...fake.tabs.get(id) };
    },
    sendMessage: async (tabId, message) => { fake.messages.push({ tabId, message }); return fake.reply; },
  },
  scripting: {
    executeScript: ({ target, world, func, args, files }) => {
      fake.scripts.push({ tabId: target.tabId, at: Date.now(), world, func: func ?? { name: 'files' }, args, files });
      const delay = fake.scriptDelay(target.tabId, func);
      if (delay == null) return Promise.reject(new Error('Could not execute script on this tab'));
      const result = func?.name === 'prepareSidebarInPage' ? fake.prepare(args) : true;
      return sleep(delay).then(() => [{ result }]);
    },
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in fake.local).map((k) => [k, fake.local[k]])),
      set: async (items) => { Object.assign(fake.local, items); },
    },
    session: {
      get: async (key) => (key in fake.session ? { [key]: structuredClone(fake.session[key]) } : {}),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
    },
  },
};

const { wakeTab, focusTab, isFocusing, isIntroduction, markMarginOpening, keepAwake, openBehind, pageBlinked, resetIntroductions, resolveTab, setIntroductionHooks, tabOpened, tabShown, userSwitched } = await import('../extension/background/tabs.js');
const M = await import('../extension/state/model.js');
const hint = await import('../extension/background/newtab-hint.js');
const { mutate, decided } = await import('../extension/background/store.js');

function reset(tabs) {
  fake.prepare = (args) => ({ ready: true, token: args?.[0]?.token });
  fake.contentScripts = undefined;
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, ...t }]));
  fake.scripts = [];
  fake.updates = [];
  fake.messages = [];
  fake.created = [];
  fake.activated = null;
}

test('wake: a running page answers at once and the switch goes ahead then', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 2, url: 'https://b.test/' }]);
  fake.scriptDelay = () => 5;
  const started = Date.now();
  const focused = await focusTab(2, { carry: 'hover', scroll: 42 });
  const waited = fake.updates[0].at - started;
  assert.ok(waited < 60, `switched after ${waited}ms`);
  assert.equal(fake.scripts.filter((s) => s.tabId === 2).length, 3, 'the keep-awake, wake answer and sidebar preparation');
  assert.equal(focused.preparation.outcome, 'ready');
  const prepared = fake.scripts.find((s) => s.func.name === 'prepareSidebarInPage');
  assert.equal(prepared.args[0].scroll, 42);
  assert.equal(prepared.args[0].carry, 'hover');
  assert.ok(prepared.at <= fake.updates[0].at, 'the hidden page prepares before activation');
});

test('focus intent: a destination is protected from cleanup until activation finishes', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 12, url: 'https://protected.test/' }]);
  fake.scriptDelay = () => 40;
  const focusing = focusTab(12);
  assert.equal(isFocusing(12), true);
  await focusing;
  assert.equal(isFocusing(12), false);
});

test('wake: the keep-awake runs in the page\'s own world (Margin\'s is cleared when it reloads)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 9, url: 'https://i.test/' }]);
  fake.scriptDelay = () => 5;
  await wakeTab(9);
  const held = fake.scripts.find((s) => s.func === keepAwake);
  assert.equal(held?.world, 'MAIN');
});

// keepAwake in a fake page: it must always finish (WebKit keeps the tab
// awake until it does).
function fakePage() {
  const listeners = { window: {}, document: {} };
  const on = (where) => (type, fn) => { (listeners[where][type] ??= new Set()).add(fn); };
  const off = (where) => (type, fn) => listeners[where][type]?.delete(fn);
  globalThis.addEventListener = on('window');
  globalThis.removeEventListener = off('window');
  globalThis.document = { visibilityState: 'hidden', addEventListener: on('document'), removeEventListener: off('document') };
  const fire = (where, type) => [...(listeners[where][type] ?? [])].forEach((fn) => fn());
  const count = () => Object.values(listeners).flatMap((l) => Object.values(l)).reduce((n, set) => n + set.size, 0);
  return { fire, count, show() { globalThis.document.visibilityState = 'visible'; fire('document', 'visibilitychange'); } };
}

test('keepAwake: finishes after its time, when the page goes away, or once it\'s shown, and cleans up', async (t) => {
  t.after(() => {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.document;
  });
  let page = fakePage();
  let started = Date.now();
  await keepAwake(60);
  assert.ok(Date.now() - started >= 55);
  assert.equal(page.count(), 0, 'no listeners left in the page');
  for (const type of ['pagehide', 'pageswap']) {
    page = fakePage();
    started = Date.now();
    const held = keepAwake(5000);
    await sleep(0); // its listeners go on a moment later (awaiting the thenable)
    page.fire('window', type);
    await held;
    assert.ok(Date.now() - started < 100, `${type} ends it`);
    assert.equal(page.count(), 0);
  }
  page = fakePage();
  const held = keepAwake(5000);
  await sleep(0);
  page.fire('document', 'visibilitychange'); // still hidden: keeps holding
  let settled = false;
  held.then(() => { settled = true; });
  await sleep(10);
  assert.equal(settled, false);
  page.show();
  await held;
  assert.equal(page.count(), 0);
});

test('keepAwake: still finishes when the page broke setTimeout, Promise or addEventListener', async (t) => {
  const real = { setTimeout: globalThis.setTimeout, Promise: globalThis.Promise };
  t.after(() => {
    Object.assign(globalThis, real);
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.document;
  });
  fakePage();
  globalThis.setTimeout = () => 0; // a page's no-op
  const started = Date.now();
  await keepAwake(100);
  const took = Date.now() - started;
  globalThis.setTimeout = real.setTimeout;
  assert.ok(took >= 550 && took < 1500, `the engine's own clock ended it after ${took}ms`);
  fakePage();
  globalThis.Promise = function NotAPromise() {};
  globalThis.addEventListener = () => { throw new Error('page wrapper'); };
  await keepAwake(30);
  globalThis.Promise = real.Promise;
});

test('keepAwake: self-contained (executeScript sends only its source)', async () => {
  const vm = await import('node:vm');
  const noop = () => {};
  const context = vm.createContext({ setTimeout, clearTimeout, AbortSignal, addEventListener: noop, removeEventListener: noop, document: { visibilityState: 'hidden', addEventListener: noop, removeEventListener: noop } });
  await vm.runInContext(`(${keepAwake})(30)`, context);
});

test('wake: a page slow to come back is waited for, up to the cap', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }, { id: 4, url: 'https://d.test/' }]);
  fake.scriptDelay = (id) => (id === 3 ? 250 : 5000);
  let started = Date.now();
  const slow = await wakeTab(3);
  assert.equal(slow.outcome, 'awake');
  assert.ok(Date.now() - started >= 240, 'waited until it ran');
  started = Date.now();
  const stuck = await wakeTab(4);
  assert.equal(stuck.outcome, 'timeout');
  const waited = Date.now() - started;
  assert.ok(waited >= 390 && waited < 600, `gave up after ${waited}ms`);
});

test('sidebar preparation: a timeout is cancelled before the tab is activated', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 13, url: 'https://slow-sidebar.test/' }]);
  fake.scriptDelay = (_id, func) => func.name === 'prepareSidebarInPage' ? 950 : 5; // past its 900ms cap
  const focused = await focusTab(13);
  assert.equal(focused.preparation.outcome, 'timeout');
  const cancel = fake.scripts.find((s) => s.func.name === 'cancelSidebarInPage');
  assert.ok(cancel, 'the late preparation is invalidated');
  assert.ok(cancel.at <= fake.updates[0].at, 'invalidated before activation');
});

test('sidebar preparation: a page still running an earlier copy gets the current one (and its theme) first, then is prepared', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 14, url: 'https://old-copy.test/' }]);
  fake.contentScripts = [{ js: ['content/shell-main.bundle.js'], world: 'MAIN' }, { js: ['content/content.bundle.js'] }];
  let added = false;
  fake.prepare = (args) => (added ? { ready: true, token: args?.[0]?.token } : { ready: false, reason: 'no current sidebar' });
  fake.scriptDelay = (_id, func) => {
    if (!func) added = true;
    return 5;
  };
  const focused = await focusTab(14);
  const files = fake.scripts.find((s) => s.files);
  assert.deepEqual(files?.files, ['content/content.bundle.js', 'themes/arcadium/content.bundle.js']);
  assert.equal(focused.preparation.outcome, 'ready');
  assert.ok(files.at <= fake.updates[0].at, 'before the switch');
});

test('switch: a tab that isn\'t open any more fails (no switch, and the page says so)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  await assert.rejects(focusTab(99), /No tab with id 99/);
  assert.equal(fake.updates.length, 0);
});

test('switch: the tab in front already: nothing to wake, prepare or switch', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const focused = await focusTab(1);
  assert.equal(focused.tab.id, 1);
  assert.equal(fake.scripts.length, 0);
  assert.equal(fake.updates.length, 0);
});

test('switch: one Safari didn\'t bring to the front is asked once more, then fails', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 15, url: 'https://stuck.test/' }]);
  fake.scriptDelay = () => 5;
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, change) => { fake.updates.push({ id, change, at: Date.now() }); return { ...fake.tabs.get(id) }; }; // says it did, didn't
  try {
    await assert.rejects(focusTab(15), /didn't bring tab 15 to the front/);
    assert.equal(fake.updates.length, 2);
  } finally {
    chrome.tabs.update = update;
  }
});

test('switch: a tab Safari unloaded is noted before it\'s shown, so its page draws the right sidebar from its first frame', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 16, url: 'https://unloaded.test/' }]);
  await decided(); // the copy that owns the state notes it
  fake.scriptDelay = () => null; // no page
  const set = chrome.storage.local.set;
  let notedAt = 0;
  chrome.storage.local.set = async (items) => { if (items.showing) notedAt = Date.now(); return set(items); };
  try {
    await focusTab(16, { carry: 'toggle', scroll: 120 });
  } finally {
    chrome.storage.local.set = set;
  }
  const { showing } = fake.local;
  assert.equal(showing?.tabId, 16);
  assert.equal(showing.url, 'https://unloaded.test/');
  assert.equal(showing.carry, 'toggle');
  assert.equal(showing.scroll, 120);
  assert.ok(notedAt && notedAt <= fake.updates[0].at, 'noted before the switch');
});

test('switch: a row\'s tab id from before (another copy\'s, the last session\'s) is found by its address and place', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true, index: 0 }, { id: 20, url: 'https://dup.test/x', index: 1 }, { id: 21, url: 'https://dup.test/x', index: 5 }, { id: 30, url: 'https://dup.test/x', index: 1, windowId: 2 }]);
  assert.equal((await resolveTab(20, { url: 'https://other.test/' }, 1))?.id, 20, 'an id this copy has stands');
  assert.equal((await resolveTab(999, { url: 'https://dup.test/x', index: 4 }, 1))?.id, 21, 'the nearest place, in the asking window');
  assert.equal((await resolveTab(999, { url: 'https://dup.test/x#top', index: 1 }, 2))?.id, 30, 'its own window first');
  assert.equal(await resolveTab(999, { url: 'https://gone.test/' }, 1), null);
  assert.equal(await resolveTab(999, null, 1), null);
});

test('switch: no switch after the page stopped waiting (its deadline)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 17, url: 'https://slow.test/' }]);
  fake.scriptDelay = () => 300; // the wake takes longer than the page waits
  await assert.rejects(focusTab(17, { deadline: Date.now() + 200 }), /Too late/);
  assert.equal(fake.updates.length, 0);
});

test('switch: a switch waiting for its wake gives way to a tab the user chose themselves', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 18, url: 'https://b.test/' }]);
  fake.scriptDelay = () => 150;
  const pending = focusTab(18);
  await sleep(20);
  userSwitched(19); // Safari's tab bar, another tab
  const focused = await pending;
  assert.equal(focused.superseded, true);
  assert.equal(fake.updates.length, 0);
});

test('wake: a tab with no page (Safari unloaded it) doesn\'t wait', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 5, url: 'https://e.test/' }]);
  fake.scriptDelay = () => null;
  const started = Date.now();
  const wake = await wakeTab(5);
  assert.equal(wake.outcome, 'no page');
  assert.ok(Date.now() - started < 50);
});

test('wake: nothing to wake for the tab in front, a page Margin can\'t reach, or a closed tab', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 6, url: 'safari-web-extension://test/newtab/newtab.html' }]);
  fake.scriptDelay = () => 5;
  assert.equal((await wakeTab(1)).outcome, 'shown');
  assert.equal((await wakeTab(6)).outcome, 'no access');
  assert.equal((await wakeTab(99)).outcome, 'gone');
  assert.equal(fake.scripts.length, 0);
});

test('wake: a switch right after an early wake (a press, the palette) reuses it', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 7, url: 'https://g.test/' }]);
  fake.scriptDelay = (_id, func) => func.name === 'prepareSidebarInPage' ? 5 : 200;
  const early = wakeTab(7);
  await sleep(150);
  const started = Date.now();
  const focused = await focusTab(7);
  assert.equal(fake.scripts.length, 3, 'no second wake; only the sidebar preparation is added');
  assert.equal(focused.preparation.outcome, 'ready');
  const waited = fake.updates[0].at - started;
  assert.ok(waited < 120, `only the rest of the early wake: ${waited}ms`);
  assert.equal((await early).outcome, 'awake');
});

test('wake: an early wake long past doesn\'t count; a fresh one starts', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 8, url: 'https://h.test/' }]);
  fake.scriptDelay = () => 5;
  await wakeTab(8);
  await sleep(650); // past the 600ms a wake counts for
  await wakeTab(8);
  assert.equal(fake.scripts.length, 4);
});

// ---- ⌘T opening Safari's homepage --------------------------------------------

async function homepageTab(id, url, extra = {}) {
  fake.tabs.set(id, { id, url, active: true, windowId: 1, status: 'loading' });
  hint.tabCreated({ id, url: '', active: true, windowId: 1, ...extra });
  await hint.tabAddress(id, url);
  fake.tabs.get(id).status = 'complete';
  hint.tabLoaded(id);
  await sleep(5);
}

test('homepage note: the same page opening in a new tab from nothing, twice', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  fake.local = {};
  await homepageTab(10, 'https://home.test/');
  assert.equal(fake.messages.length, 0, 'not after the first');
  await homepageTab(11, 'https://home.test/');
  assert.deepEqual(fake.messages, [{ tabId: 11, message: { type: 'newtab-hint' } }]);
  await homepageTab(12, 'https://home.test/');
  assert.equal(fake.messages.length, 1, 'once a run');
});

test('homepage note: not for links (an opener), different pages, or with the setting off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  await homepageTab(20, 'https://x.test/', { openerTabId: 1 });
  await homepageTab(21, 'https://x.test/', { openerTabId: 1 });
  await homepageTab(22, 'https://one.test/');
  await homepageTab(23, 'https://two.test/');
  assert.equal(fake.messages.length, 0);
  fake.session = {};
  await mutate((st) => ({ ...st, settings: { ...st.settings, newTabHint: false } }));
  await homepageTab(25, 'https://home.test/');
  await homepageTab(26, 'https://home.test/');
  assert.equal(fake.messages.length, 0, 'turned off');
  await mutate((st) => ({ ...st, settings: { ...st.settings, newTabHint: true } }));
});

test('homepage note: a page that couldn\'t show it (no Margin there, opened from a link) leaves it for the next', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  fake.reply = false;
  await homepageTab(40, 'https://home.test/');
  await homepageTab(41, 'https://home.test/');
  assert.equal(fake.messages.length, 1);
  fake.reply = true;
  await homepageTab(42, 'https://home.test/');
  assert.deepEqual(fake.messages.map((m) => m.tabId), [41, 42]);
  await homepageTab(43, 'https://home.test/');
  assert.equal(fake.messages.length, 2, 'shown now: once a run');
});

test('homepage note: a new window\'s first tab doesn\'t count; about:blank first doesn\'t lose the tab', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  await homepageTab(50, 'https://home.test/', { index: 0 });
  await homepageTab(51, 'https://home.test/', { index: 0 });
  assert.equal(fake.messages.length, 0, 'new windows');
  fake.tabs.set(52, { id: 52, url: 'https://home.test/', active: true, windowId: 1, status: 'loading' });
  hint.tabCreated({ id: 52, url: '', active: true, windowId: 1, index: 3 });
  await hint.tabAddress(52, 'about:blank');
  await hint.tabAddress(52, 'https://home.test/');
  await homepageTab(53, 'https://home.test/', { index: 4 });
  assert.deepEqual(fake.messages.map((m) => m.tabId), [53]);
});

test('homepage note: Margin\'s new-tab page showing up resets it (the setting is Margin again)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  await homepageTab(30, 'https://home.test/');
  await hint.newTabPageSeen();
  await homepageTab(31, 'https://home.test/');
  assert.equal(fake.messages.length, 0, 'counting starts over');
});

// Last: Margin opening a tab leaves the next couple of seconds out.
test('homepage note: not for tabs Margin opened itself', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  markMarginOpening();
  await homepageTab(60, 'https://own.test/');
  await homepageTab(61, 'https://own.test/');
  assert.equal(fake.messages.length, 0);
});

// ---- a new tab from the palette, shown once loaded (tabs.js openBehind) ----------

const told = (type) => fake.messages.filter((m) => m.message?.type === type);
const front = () => [...fake.tabs.values()].find((t) => t.active)?.id;

test('openBehind: the tab opens behind the page, which is told at once (covered); it comes to the front once loaded', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const from = { id: 1, windowId: 1 };
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  assert.deepEqual(fake.created, [{ id: 2, url: 'https://slow.test/', active: false }], 'opened behind');
  assert.equal(front(), 1, 'the page stays in front while it loads');
  assert.deepEqual(told('switching').map((m) => [m.tabId, m.message.tabId, m.message.cover, m.message.windowId]), [[1, 2, 'now', 1]]);
  fake.tabs.get(2).status = 'complete';
  assert.deepEqual(await shown, { tabId: 2, shown: 2 });
  assert.equal(front(), 2);
  assert.equal(told('switch-done').length, 1);
  assert.equal(told('switch-failed').length, 0);
});

test('openBehind: the user going elsewhere meanwhile leaves it behind, loaded', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  userSwitched(3, 1); // Safari's tab bar, say (background.js onActivated)
  fake.tabs.get(4).status = 'complete';
  assert.deepEqual(await shown, { tabId: 4, shown: null });
  assert.equal(front(), 1, 'not brought to the front');
  assert.equal(told('switch-failed').length, 1, 'the page stops waiting');
  assert.equal(told('switch-failed')[0].message.reason, undefined, 'no notice: nothing went wrong');
});

test('openBehind: closed while it loads: nothing comes to the front', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  fake.tabs.delete(2);
  assert.deepEqual(await shown, { tabId: 2, shown: null });
  assert.equal(front(), 1);
  assert.equal(told('switch-failed').length, 1);
});

test('openBehind: a page that never finishes loading still comes up after the limit, as far as it got', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const started = Date.now();
  assert.deepEqual(await openBehind({ url: 'https://endless.test/', from: { id: 1, windowId: 1 }, maxMs: 400 }), { tabId: 2, shown: 2 });
  assert.ok(Date.now() - started >= 400, 'it waited for the limit');
  assert.equal(front(), 2);
});

test('openBehind: a search starting from a blank page waits for the search, not the blank page', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const shown = openBehind({ from: { id: 1, windowId: 1 }, then: async (tab) => {
    fake.tabs.get(tab.id).status = 'complete'; // about:blank, loaded
    await sleep(250);
    Object.assign(fake.tabs.get(tab.id), { url: 'https://search.test/?q=x', status: 'loading' });
  } });
  const started = Date.now();
  await sleep(350); // the search under way
  assert.equal(front(), 1, 'not for the blank page');
  fake.tabs.get(2).status = 'complete';
  assert.deepEqual(await shown, { tabId: 2, shown: 2 });
  assert.ok(Date.now() - started < 1000, 'once the search loaded, not at the limit');
});

test('openBehind: a switch in another window doesn\'t call it off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 5, url: 'https://e.test/', windowId: 9, active: true }, { id: 6, url: 'https://f.test/', windowId: 9 }]);
  fake.scriptDelay = () => 1;
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  userSwitched(6, 9);
  fake.tabs.get(7).status = 'complete';
  assert.deepEqual(await shown, { tabId: 7, shown: 7 });
});

test('openBehind: the page the user is on going somewhere else meanwhile calls it off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  fake.tabs.get(1).status = 'loading'; // a link, the address bar, ⌘R
  assert.deepEqual(await shown, { tabId: 2, shown: null });
  assert.equal(front(), 1);
  assert.equal(told('switch-failed').length, 1);
});

test('openBehind: its own row clicked meanwhile: that switch brings it, the page isn\'t told it failed', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  const clicked = focusTab(2, { source: 'activateTab' });
  assert.deepEqual(await shown, { tabId: 2, shown: null });
  await clicked;
  assert.equal(front(), 2);
  assert.equal(told('switch-failed').length, 0, 'the cover stays until the page is hidden');
});

test('openBehind: within the page\'s deadline (the wait shortened to leave time to bring it forward)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const started = Date.now();
  assert.deepEqual(await openBehind({ url: 'https://endless.test/', from: { id: 1, windowId: 1 }, deadline: Date.now() + 2900 }), { tabId: 2, shown: 2 });
  assert.ok(Date.now() - started < 1000, 'waited only until deadline − the time to bring it forward');
});

test('openBehind: without site access (no address from Safari) it counts as loaded once seen loading, then complete', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const shown = openBehind({ url: 'https://private.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  Object.assign(fake.tabs.get(2), { url: undefined, status: 'complete' });
  const started = Date.now();
  assert.deepEqual(await shown, { tabId: 2, shown: 2 });
  assert.ok(Date.now() - started < 1000, 'not the full limit');
});

test('openBehind: told the tab at once (created), its row titled meanwhile (label)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  let createdId = null;
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 }, created: (tab) => { createdId = tab.id; }, label: 'two words' });
  await sleep(150);
  assert.equal(createdId, 2);
  const { load } = await import('../extension/background/store.js');
  assert.equal((await load()).tabs[2]?.title, 'two words');
  fake.tabs.get(2).status = 'complete';
  await shown;
});

test('arriving covered: a tab opened behind is prepared to arrive covered; an ordinary switch isn\'t', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  fake.scriptDelay = () => 1;
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(150);
  fake.tabs.get(4).status = 'complete';
  await shown;
  const prepared = (id) => fake.scripts.filter((s) => s.tabId === id && s.func.name === 'prepareSidebarInPage').map((s) => s.args[0].covered);
  assert.deepEqual(prepared(4), [true]);
  await focusTab(3);
  assert.deepEqual(prepared(3), [false]);
});

// ---- a tab shown for the first time (tabs.js introduceTab) ----------------------

const keepAwakes = (id) => fake.scripts.filter((x) => x.tabId === id && x.func === keepAwake);
const prepares = (id) => fake.scripts.filter((x) => x.tabId === id && x.func.name === 'prepareSidebarInPage');
// Margin's state has `id` in front of window 1 (as onActivated left it).
const knownInFront = (id) => mutate((s) => M.activateTab(M.upsertTab(s, fake.tabs.get(id), Date.now()), id, 1, Date.now()));
// Safari has `id` in front of its window again.
const putInFront = (id) => { for (const t of fake.tabs.values()) if (t.windowId === fake.tabs.get(id).windowId) t.active = t.id === id; };
/** @param {any[]} tabs @param {number[]} opened never in front since they opened */
async function introducing(tabs, opened) {
  reset(tabs);
  fake.scriptDelay = () => 1;
  for (const id of opened) tabOpened({ id, active: false }); // opened behind (background.js onCreated)
  delete fake.session.introductionsOff;
  resetIntroductions();
  await knownInFront(1);
  return () => { // after the test
    for (const id of opened) tabShown(id);
    fake.activated = null;
    setIntroductionHooks({ activated: null, introduced: null });
    delete fake.session.introductionsOff;
    resetIntroductions();
  };
}
// chrome.tabs.update replaced for one test.
async function withUpdate(replacement, run) {
  const update = chrome.tabs.update;
  chrome.tabs.update = (id, change) => replacement(update, id, change);
  try {
    return await run();
  } finally {
    chrome.tabs.update = update;
  }
}

test('introducing: a tab never in front, loaded, is brought to the front and the page in front straight back (sent together), then shown', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 30, url: 'https://new.test/' }], [30]);
  try {
    const events = [];
    fake.activated = (info) => events.push([info.tabId, isIntroduction(info)]);
    const introduced = [];
    setIntroductionHooks({ introduced: (id) => introduced.push(id) });
    // Answers that take a moment, as Safari's do: the second is sent before the first has answered.
    let inFlight = 0;
    const startedWhile = [];
    await withUpdate(async (update, id, change) => {
      startedWhile.push(inFlight++);
      try {
        const answer = await update(id, change);
        await sleep(10);
        return answer;
      } finally {
        inFlight--;
      }
    }, () => focusTab(30));
    assert.deepEqual(fake.updates.map((u) => u.id), [30, 1, 30]);
    assert.deepEqual(startedWhile.slice(0, 2), [0, 1], 'the two sent together, not one after the other\'s answer');
    assert.ok(fake.updates[2].at - fake.updates[1].at >= 55, 'shown once its process has drawn');
    assert.deepEqual(events, [[30, true], [1, true], [30, false]], 'only the real switch is told as one');
    assert.deepEqual(introduced, [30], 'keep-ready hears of it (its hold ended)');
    const holds = keepAwakes(30);
    assert.equal(holds.length, 2, 'woken first, and held afresh after (the instant in front ended the first hold)');
    assert.ok(holds[0].at <= fake.updates[0].at && holds[1].at >= fake.updates[1].at);
    // Not introduced twice (say the switch didn't land and it's asked again).
    putInFront(1);
    fake.updates = [];
    await focusTab(30);
    assert.deepEqual(fake.updates.map((u) => u.id), [30]);
  } finally {
    done();
  }
});

test('introducing: not a tab still loading, one shown before, or one Safari unloaded (and one that is: introduced)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 31, url: 'https://loading.test/', status: 'loading' }, { id: 32, url: 'https://seen.test/' }, { id: 33, url: 'https://unloaded.test/' }, { id: 34, url: 'https://new.test/' }], [31, 33, 34]);
  try {
    fake.scriptDelay = (id) => (id === 33 ? null : 1);
    for (const id of [31, 32, 33]) {
      putInFront(1); // as Margin has it
      fake.updates = [];
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id], `tab ${id}: just shown`);
    }
    assert.equal(isIntroduction({ tabId: 33, windowId: 1 }), false, 'no activations left out');
    putInFront(1);
    fake.updates = [];
    await focusTab(34);
    assert.deepEqual(fake.updates.map((u) => u.id), [34, 1, 34], 'the same set-up does introduce a tab that can be');
  } finally {
    done();
  }
});

test('introducing: not while Safari has another tab in front than Margin knows of (a switch on its way): it isn\'t undone', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/' }, { id: 35, url: 'https://new.test/' }, { id: 36, url: 'https://picked.test/', active: true }], [35]);
  try {
    await focusTab(35);
    assert.deepEqual(fake.updates.map((u) => u.id), [35], 'no update for tab 36 (it would undo the user\'s switch)');
  } finally {
    done();
  }
});

test('introducing: not once another switch was asked for while Safari was asked which tab is in front', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 37, url: 'https://new.test/' }, { id: 38, url: 'https://picked.test/' }], [37]);
  const query = chrome.tabs.query;
  try {
    let asked = 0;
    chrome.tabs.query = async (q) => {
      const answer = await query(q);
      // The user picks tab 38 just as Safari answers (its event reaches Margin first).
      if (q?.active && asked++ === 0) {
        putInFront(38);
        userSwitched(38, 1);
      }
      return answer;
    };
    const result = await focusTab(37);
    assert.equal(result.superseded, true);
    assert.equal(fake.updates.some((u) => u.id === 1), false, 'the page in front isn\'t brought back over the user\'s pick');
    assert.equal(front(), 38);
  } finally {
    chrome.tabs.query = query;
    done();
  }
});

test('introducing: something else coming first ends the activations left out (told as they come)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 39, url: 'https://new.test/' }, { id: 40, url: 'https://other.test/' }], [39]);
  try {
    const events = [];
    // The user's own switch lands in between (Safari's tab bar).
    fake.activated = (info) => {
      if (info.tabId === 39 && events.length === 0) events.push([40, isIntroduction({ tabId: 40, windowId: 1 })]);
      events.push([info.tabId, isIntroduction(info)]);
    };
    await focusTab(39);
    assert.deepEqual(events.slice(0, 3), [[40, false], [39, false], [1, false]]);
  } finally {
    done();
  }
});

test('introducing: activations told after Safari has answered are still left out, until the tab is really shown', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 41, url: 'https://new.test/' }], [41]);
  try {
    const events = [];
    fake.activated = (info) => setTimeout(() => events.push([info.tabId, isIntroduction(info)]), 5);
    await focusTab(41);
    await sleep(20);
    assert.deepEqual(events, [[41, true], [1, true], [41, false]]);
  } finally {
    done();
  }
});

test('introducing: a switch called off or out of time after its introduction leaves the window free for the next', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 42, url: 'https://new.test/' }, { id: 43, url: 'https://next.test/' }, { id: 44, url: 'https://third.test/' }], [42, 43, 44]);
  try {
    fake.activated = (info) => isIntroduction(info);
    setTimeout(() => userSwitched(null, 1), 25); // during the wait after the introduction
    assert.equal((await focusTab(42)).superseded, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [42, 1]);
    fake.updates = [];
    await assert.rejects(focusTab(43, { deadline: Date.now() + 300 }), /Too late/);
    assert.deepEqual(fake.updates.map((u) => u.id), [43, 1], 'introduced, then out of time');
    fake.updates = [];
    await focusTab(44);
    assert.deepEqual(fake.updates.map((u) => u.id), [44, 1, 44]);
    assert.equal(isIntroduction({ tabId: 44, windowId: 1 }), false, 'nothing left expected');
  } finally {
    done();
  }
});

test('introducing: a new tab whose switch is called off from another window: the page that asked is told (not left covered)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 5, url: 'https://e.test/', windowId: 9, active: true }, { id: 6, url: 'https://f.test/', windowId: 9 }], []);
  try {
    fake.activated = (info) => isIntroduction(info);
    const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
    await sleep(150);
    const id = fake.created[0].id;
    tabOpened({ id, active: false });
    const update = chrome.tabs.update;
    // Once it's introduced, a switch in the other window.
    chrome.tabs.update = async (tabId, change) => {
      const answer = await update(tabId, change);
      if (tabId === 1) setTimeout(() => userSwitched(6, 9), 10);
      return answer;
    };
    try {
      fake.tabs.get(id).status = 'complete';
      assert.deepEqual(await shown, { tabId: id, shown: null });
    } finally {
      chrome.tabs.update = update;
    }
    assert.equal(told('switch-failed').length, 1, 'the page stops waiting');
    tabShown(id);
  } finally {
    done();
  }
});

test('introducing: Safari not bringing the page back: the tab is shown as it is (not prepared covered), its activation told after all, and no more introductions this session', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 45, url: 'https://new.test/' }, { id: 46, url: 'https://next.test/' }], [45, 46]);
  try {
    const toldAfter = [];
    // As background.js's handler: it can get to userSwitched only after the switch is over.
    setIntroductionHooks({ activated: (info) => { toldAfter.push(info.tabId); setTimeout(() => userSwitched(info.tabId, info.windowId), 0); } });
    fake.activated = (info) => isIntroduction(info);
    // The page in front isn't brought back (Safari says it was).
    const result = await withUpdate(async (update, id, change) => (id === 1 ? (fake.updates.push({ id, change, at: Date.now() }), { ...fake.tabs.get(1), active: true }) : update(id, change)),
      () => focusTab(45, { covered: true }));
    assert.equal(front(), 45, 'the tab is in front: it was about to be anyway');
    assert.equal(result.tab?.id, 45);
    assert.deepEqual(prepares(45), [], 'not prepared to arrive covered: it\'s on screen already');
    assert.deepEqual(toldAfter, [45], 'its activation, left out, told after all');
    assert.equal(fake.session.introductionsOff, true, 'for the rest of the Safari session');
    await knownInFront(45);
    fake.updates = [];
    const next = await focusTab(46);
    assert.ok(!next.superseded, 'the activation told after all is Margin\'s: it doesn\'t call off the next switch');
    assert.deepEqual(fake.updates.map((u) => u.id), [46], 'not introduced');
  } finally {
    done();
  }
});

test('introducing: not Safari\'s doing, introductions stay on: the user\'s pick of a third tab, the page in front closed, a second switch to the same tab', async () => {
  // The user picks tab 49 between the updates and Safari's answer (its event on its way).
  let done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 47, url: 'https://new.test/' }, { id: 49, url: 'https://picked.test/' }], [47]);
  try {
    const toldAfter = [];
    setIntroductionHooks({ activated: (info) => toldAfter.push(info.tabId) });
    fake.activated = (info) => (info.tabId === 47 ? isIntroduction(info) : setTimeout(() => isIntroduction(info), 30));
    await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (id === 1) putInFront(49);
      return answer;
    }, () => focusTab(47).catch(() => {}));
    assert.deepEqual(toldAfter, [], 'nothing told after all: the user\'s switch tells itself');
    assert.equal(fake.session.introductionsOff, undefined);
  } finally {
    done();
  }
  // The page in front closed meanwhile.
  done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 50, url: 'https://new.test/' }], [50]);
  try {
    fake.activated = (info) => isIntroduction(info);
    await withUpdate(async (update, id, change) => {
      if (id !== 1) return update(id, change);
      fake.tabs.delete(1);
      throw new Error('No tab with id 1');
    }, () => focusTab(50).catch(() => {}));
    assert.equal(fake.session.introductionsOff, undefined);
  } finally {
    done();
  }
  // A second switch to the same tab while the first one introduces it.
  done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 51, url: 'https://new.test/' }], [51]);
  try {
    fake.activated = (info) => setTimeout(() => isIntroduction(info), 20);
    let second = null;
    await withUpdate(async (update, id, change) => {
      if (id === 51 && !second) second = focusTab(51, { wake: false });
      return update(id, change);
    }, () => focusTab(51).catch(() => {}));
    await second;
    await sleep(30);
    assert.equal(front(), 51);
    assert.equal(fake.session.introductionsOff, undefined);
  } finally {
    done();
  }
});

test('introducing: the page in front hidden for an instant after the two updates went out, before the real switch, turns them off for the session; a real switch away and back doesn\'t', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 52, url: 'https://new.test/' }, { id: 53, url: 'https://next.test/' }], [52, 53]);
  try {
    let sentAt = 0;
    let answeredAt = 0;
    await withUpdate(async (update, id, change) => {
      if (id === 52 && !sentAt) sentAt = Date.now();
      const answer = await update(id, change);
      await sleep(5);
      if (id === 1) answeredAt = Date.now();
      return answer;
    }, () => focusTab(52));
    const realAt = fake.updates[2].at;
    assert.ok(realAt - answeredAt >= 50);
    // The real switch to 52 and straight back: hidden once the real switch went out.
    pageBlinked(1, { hiddenAt: realAt + 2, shownAt: realAt + 40 });
    pageBlinked(2, { hiddenAt: sentAt + 1, shownAt: sentAt + 10 }); // another window
    pageBlinked(1, { hiddenAt: sentAt - 100, shownAt: sentAt - 90 }); // before it
    await sleep(0);
    assert.equal(fake.session.introductionsOff, undefined);
    // A busy page in front, dating it when it got to it (after the answers).
    pageBlinked(1, { hiddenAt: answeredAt + 30, shownAt: answeredAt + 30 });
    await sleep(0);
    assert.equal(fake.session.introductionsOff, true);
    // As after a background restart: the session's word is kept.
    resetIntroductions();
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(53);
    assert.deepEqual(fake.updates.map((u) => u.id), [53], 'not introduced');
  } finally {
    done();
  }
});

test('introducing: Safari leaving the tab in front while another switch starts: its activation is still told (Margin\'s state follows)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 54, url: 'https://new.test/' }, { id: 5, url: 'https://e.test/', windowId: 9, active: true }], [54]);
  try {
    const toldAfter = [];
    setIntroductionHooks({ activated: (info) => toldAfter.push(info.tabId) });
    fake.activated = (info) => isIntroduction(info);
    const result = await withUpdate(async (update, id, change) => {
      if (id !== 1) return update(id, change);
      userSwitched(null, 9); // a switch in another window, just then
      fake.updates.push({ id, change, at: Date.now() });
      return { ...fake.tabs.get(1), active: true }; // says it did, didn't
    }, () => focusTab(54));
    assert.equal(result.superseded, true);
    assert.equal(front(), 54);
    assert.deepEqual(toldAfter, [54]);
    assert.equal(fake.session.introductionsOff, undefined, 'not taken for Safari\'s doing: another switch was asked for');
  } finally {
    done();
  }
});

test('introducing: a user\'s activation of the tab left out after the updates were answered is told once the switch has shown it', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 55, url: 'https://new.test/' }], [55]);
  try {
    const toldAfter = [];
    setIntroductionHooks({ activated: (info) => toldAfter.push(info.tabId) });
    fake.activated = null; // Safari tells nothing of the two updates
    let userAt = null;
    const shown = withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (id === 1 && !userAt) userAt = setTimeout(() => { putInFront(55); isIntroduction({ tabId: 55, windowId: 1 }); }, 20); // the user's click on it, left out
      return answer;
    }, () => focusTab(55));
    await shown;
    assert.deepEqual(toldAfter, [55], 'Margin\'s own update of it made no event: told');
  } finally {
    done();
  }
});

