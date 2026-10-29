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
    update: async (id, change) => {
      fake.updates.push({ id, change, at: Date.now() });
      const tab = fake.tabs.get(id);
      for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return { ...tab };
    },
    query: async () => [...fake.tabs.values()],
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

const { wakeTab, focusTab, isFocusing, markMarginOpening, keepAwake, openBehind, resolveTab, userSwitched } = await import('../extension/background/tabs.js');
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
