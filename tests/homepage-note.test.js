// The ⌘T-opens-the-homepage note (background/newtab-hint.js) and finding a
// sleeping tab by its address (the rest of the old wake tests went with the wakes, Phase 2 step 8), against a fake
// browser API (Safari's: the note is Safari-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// tabs: id → { id, url, active, windowId, status }. `scriptDelay(tabId)`:
// how long the page takes to run a script (null: no page, it fails at once).
// `scriptError(tabId)`: a view but no page (WebKit answers with an error in
// place of a result).
const fake = {
  tabs: new Map(),
  scriptDelay: () => 0,
  scripts: [],
  updates: [],
  messages: [],
  created: [],
  session: {},
  local: {},
  reply: true, // what a page answers (a switch: true, it's covered)
  hintReply: { fromNothing: true }, // what a page answers the New Tab note's question: opened from nothing
  // What a page's sidebar answers when asked to prepare (default: ready).
  prepare: (args) => ({ ready: true, token: args?.[0]?.token }),
  contentScripts: undefined, // the manifest's
  // Pages that have painted (readyInPage answers 'painted'; 'loaded' once
  // their status says complete), and pages whose document has never come into
  // view from hidden (pageThere answers 'unseen').
  painted: new Set(),
  unseen: new Set(),
  seen: new Set(), // pages that have come into view from hidden (pageThere answers 'seen')
  // Tabs going from a loaded page to another: the old page's document, loaded,
  // answers until the new one commits (readyInPage: 'loaded' at once).
  oldDocument: new Set(),
  // How long a page takes to go through a rendering update (paintBarrierInPage).
  barrierMs: () => 60,
  // Tabs whose process Safari suspended (suspend()): their scripts wait for
  // its resume.
  suspended: new Map(),
  // Keep-ready's holds (a keepAwake with a key) run on until the test ends.
  holdsRun: false,
};
// A tab's process suspended: a script there waits until WebKit resumes it, at
// background priority `backgroundMs` after the first script reached it, or
// once the tab is brought to the front (its view in the window: a foreground
// resume, `shownMs` later).
function suspend(tabId, { backgroundMs = 2000, shownMs = 5 } = {}) {
  let resume = () => {};
  const resumed = new Promise((resolve) => { resume = resolve; });
  let timer = null;
  const done = () => { clearTimeout(timer); fake.suspended.delete(tabId); resume(); };
  fake.suspended.set(tabId, {
    wait() {
      timer ??= setTimeout(done, backgroundMs);
      return resumed;
    },
    shown() {
      setTimeout(done, shownMs);
    },
  });
}
// readyInPage, as a page answers it: 'loaded' once its status says complete,
// 'painted' once it has painted, 'timeout' at its limit.
const readiness = async (tabId, [ms]) => {
  if (fake.oldDocument.has(tabId)) return 'loaded';
  const until = Date.now() + ms;
  for (;;) {
    const tab = fake.tabs.get(tabId);
    if (!tab) return new Promise(() => {}); // gone with its page
    if (tab.status === 'complete') return 'loaded';
    if (fake.painted.has(tabId)) return 'painted';
    if (Date.now() >= until) return 'timeout';
    await sleep(5);
  }
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
      if (change.active) fake.suspended.get(id)?.shown();
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
    sendMessage: async (tabId, message) => { fake.messages.push({ tabId, message }); return message?.type === 'newtab-hint' ? fake.hintReply : fake.reply; },
    reload: async (id) => { fake.updates.push({ id, change: { reload: true }, at: Date.now() }); },
  },
  scripting: {
    executeScript: ({ target, world, func, args, files, again = false }) => {
      if (!again) fake.scripts.push({ tabId: target.tabId, at: Date.now(), world, func: func ?? { name: 'files' }, args, files });
      if (fake.holdsRun && func === keepAwake && typeof args?.[1] === 'string') return new Promise(() => {});
      const suspended = fake.suspended.get(target.tabId);
      if (suspended) return suspended.wait().then(() => chrome.scripting.executeScript({ target, world, func, args, files, again: true }));
      if (fake.scriptError?.(target.tabId)) return sleep(1).then(() => [{ result: null, error: 'Failed to execute script.' }]);
      const delay = fake.scriptDelay(target.tabId, func);
      if (delay == null) return Promise.reject(new Error('Could not execute script on this tab'));
      if (func?.name === 'readyInPage') return sleep(delay).then(() => readiness(target.tabId, args)).then((result) => [{ result }]);
      if (func?.name === 'paintBarrierInPage') return sleep(delay + fake.barrierMs(target.tabId)).then(() => [{ result: 'drawn' }]);
      const result = func?.name === 'prepareSidebarInPage' ? fake.prepare(args) : func?.name === 'cutOffInPage' ? (fake.cutOff?.(target.tabId, args) ?? { cutOff: false }) : func?.name === 'pageThere' && fake.unseen.has(target.tabId) ? 'unseen' : func?.name === 'pageThere' && fake.seen.has(target.tabId) ? 'seen' : true;
      return sleep(delay).then(() => [{ result }]);
    },
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in fake.local).map((k) => [k, fake.local[k]])),
      set: async (items) => { Object.assign(fake.local, items); },
    },
    // `fake.sessionMs`: how long a read takes (a background Safari just started).
    session: {
      get: async (keys) => {
        if (fake.sessionMs) await sleep(fake.sessionMs);
        return Object.fromEntries([].concat(keys).filter((k) => k in fake.session).map((k) => [k, structuredClone(fake.session[k])]));
      },
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
    },
  },
};

const { markMarginOpening, resolveTab, tabShown } = await import('../extension/background/tabs.js');
const M = await import('../extension/state/model.js');
const hint = await import('../extension/background/newtab-hint.js');
// Margin.app's overlay, linked: the notices pushed to it (background/notices.js).
const notices = await import('../extension/background/notices.js');
const pushed = [];
let appLinked = true;
notices.useLinkForTests({ linked: () => appLinked, push: (windowId, msg) => { if (!appLinked) return false; pushed.push({ windowId, msg }); return true; } });
const noted = () => pushed.filter((p) => p.msg.kind === 'new-tab-setting').map((p) => p.msg.tabId);
const { mutate, decided, load, markSynced } = await import('../extension/background/store.js');
const V = await import('../extension/shared/view.js');
const { navigate, showSpace } = await import('../extension/background/navigation.js');
const { handlers } = await import('../extension/background/handlers.js');

function reset(tabs) {
  fake.prepare = (args) => ({ ready: true, token: args?.[0]?.token });
  fake.painted = new Set();
  fake.unseen = new Set();
  fake.seen = new Set();
  fake.oldDocument = new Set();
  fake.barrierMs = () => 60;
  fake.scriptError = null;
  fake.cutOff = null;
  fake.suspended = new Map();
  fake.holdsRun = false;
  fake.reply = true;
  fake.hintReply = { fromNothing: true };
  fake.contentScripts = undefined;
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, ...t }]));
  fake.scripts = [];
  fake.updates = [];
  fake.messages = [];
  fake.created = [];
  fake.activated = null;
}




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
  globalThis.dispatchEvent = (event) => fire('window', event.type);
  const count = () => Object.values(listeners).flatMap((l) => Object.values(l)).reduce((n, set) => n + set.size, 0);
  return { fire, count, show() { globalThis.document.visibilityState = 'visible'; fire('document', 'visibilitychange'); } };
}

































// ---- ⌘T opening Safari's homepage --------------------------------------------

async function homepageTab(id, url, extra = {}) {
  fake.tabs.set(id, { id, url, active: true, windowId: 1, status: 'loading' });
  hint.tabCreated({ id, url: '', active: true, windowId: 1, ...extra });
  await hint.tabAddress(id, url);
  fake.tabs.get(id).status = 'complete';
  hint.tabLoaded(id);
  await sleep(5);
}

test('homepage note: the same page opening in a new tab from nothing, twice: said in the window\'s overlay', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  fake.local = {};
  pushed.length = 0;
  notices.resetNotices();
  await homepageTab(10, 'https://home.test/');
  assert.equal(fake.messages.length, 0, 'not after the first');
  await homepageTab(11, 'https://home.test/');
  assert.deepEqual(fake.messages, [{ tabId: 11, message: { type: 'newtab-hint' } }], 'the page asked whether it was opened from nothing');
  assert.deepEqual(pushed, [{ windowId: 1, msg: { type: 'notice', kind: 'new-tab-setting', tabId: 11 } }], 'the overlay of its window told, the kind only');
  await homepageTab(12, 'https://home.test/');
  assert.equal(fake.messages.length, 1, 'once a run');
  assert.equal(noted().length, 1);
});

test('homepage note: not linked to Margin.app, nothing said, and the next one may', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.session = {};
  pushed.length = 0;
  notices.resetNotices();
  appLinked = false;
  await homepageTab(15, 'https://home.test/');
  await homepageTab(16, 'https://home.test/');
  assert.deepEqual(noted(), []);
  appLinked = true;
  await homepageTab(17, 'https://home.test/');
  assert.deepEqual(noted(), [17], 'linked again: said');
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
  pushed.length = 0;
  notices.resetNotices();
  fake.hintReply = { fromNothing: false };
  await homepageTab(40, 'https://home.test/');
  await homepageTab(41, 'https://home.test/');
  assert.equal(fake.messages.length, 1);
  assert.deepEqual(noted(), [], 'opened from a link: not said');
  fake.hintReply = undefined; // no Margin in the page
  await homepageTab(42, 'https://home.test/');
  assert.deepEqual(noted(), []);
  fake.hintReply = { fromNothing: true };
  await homepageTab(43, 'https://home.test/');
  assert.deepEqual(fake.messages.map((m) => m.tabId), [41, 42, 43]);
  assert.deepEqual(noted(), [43]);
  await homepageTab(44, 'https://home.test/');
  assert.equal(fake.messages.length, 3, 'shown now: once a run');
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














const { sleepAddress, isSleepPage } = await import('../extension/shared/sleep.js');
const { ensureCurrent, forgetCurrent } = await import('../extension/background/tabs.js');




test('asleep: a page that names a sleeping tab by its address (before this copy\'s ids are its own) finds it at its sleep page', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 64, url: sleepAddress('safari-web-extension://test/', { url: 'https://named.test/a', key: 'k' }) }]);
  const found = await resolveTab(999, { url: 'https://named.test/a', index: 1, from: { origin: 'safari-web-extension://elsewhere/' } }, 1);
  assert.equal(found?.id, 64);
});

test('asleep: a tab asleep on an earlier copy\'s sleep page (an update, a relaunch) is moved to this copy\'s, its page\'s address kept, still asleep', async () => {
  const old = sleepAddress('safari-web-extension://old-copy/', { url: 'https://moved.test/?q=1', title: 'Moved', key: 'k' });
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 65, url: old }]);
  forgetCurrent(65);
  await ensureCurrent(65);
  assert.deepEqual(fake.updates.map((u) => [u.id, u.change.url]), [[65, old.replace('safari-web-extension://old-copy/', 'safari-web-extension://test/')]]);
  assert.ok(!fake.updates.some((u) => u.change.active), 'not brought to the front');
});
