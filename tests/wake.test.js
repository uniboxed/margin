// The wake before a switch (background/tabs.js wakeTab, focusTab) and the
// ⌘T-opens-the-homepage note (background/newtab-hint.js), against a fake
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
  reply: true, // what a page answers: true once it showed the note
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
    sendMessage: async (tabId, message) => { fake.messages.push({ tabId, message }); return fake.reply; },
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

const { activationsHeard, heardActivation, repairCutOff, wakeTab, forgetWake, focusTab, handingOff, holdTab, isFocusing, isIntroduction, isNeverShown, keepHandedOff, markMarginOpening, keepAwake, openBehind, pageBlinked, pageStarted, pageThere, releaseInPage, releaseTab, resetIntroductions, resetMarksForTests, resetRestores, resolveTab, setIntroductionHooks, tabOpened, tabShown, userSwitched } = await import('../extension/background/tabs.js');
// Tabs these tests didn't prove to have WebKit's mark count as having it, as
// every tab did before it was tracked (background/tabs.js; its own tests:
// tests/in-window.test.js).
(await import('../extension/background/tabs.js')).assumeMarkedForTests(true);
const { tapLog } = await import('../extension/background/diagnostics.js');
const { holdNow, keepReadyState, noteLeft, resetKeepReady, startedAgain, switchFacts } = await import('../extension/background/keep-ready.js');
const M = await import('../extension/state/model.js');
const hint = await import('../extension/background/newtab-hint.js');
const { mutate, decided, load, markSynced } = await import('../extension/background/store.js');
const V = await import('../extension/shared/view.js');
const { navigate, showSpace } = await import('../extension/background/navigation.js');
const { handlers } = await import('../extension/background/handlers.js');
const { asksBackground } = await import('../extension/shared/platform.js');
// What content/hold.js listens for.
const HOLD = 'margin-hold';
const RELEASE = 'margin-release';

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
  fake.contentScripts = undefined;
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, ...t }]));
  fake.scripts = [];
  fake.updates = [];
  fake.messages = [];
  fake.created = [];
  fake.activated = null;
  resetMarksForTests(); // (WebKit's mark: what one test proved or lost isn't the next one's)
}

test('wake: a running page answers at once and the switch goes ahead then', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 2, url: 'https://b.test/' }]);
  fake.scriptDelay = () => 5;
  const started = Date.now();
  const focused = await focusTab(2, { carry: 'hover', scroll: 42 });
  const waited = fake.updates[0].at - started;
  assert.ok(waited < 60, `switched after ${waited}ms`);
  assert.equal(fake.scripts.filter((s) => s.tabId === 2).length, 4, 'the keep-awake, wake answer, sidebar preparation, and one look just before the show (its page free: tabs.js pingInPage)');
  assert.equal(fake.scripts.filter((s) => s.tabId === 2).at(-1).func.name, 'pingInPage');
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
  globalThis.dispatchEvent = (event) => fire('window', event.type);
  const count = () => Object.values(listeners).flatMap((l) => Object.values(l)).reduce((n, set) => n + set.size, 0);
  return { fire, count, show() { globalThis.document.visibilityState = 'visible'; fire('document', 'visibilitychange'); } };
}

test('keepAwake: finishes after its time, when the page goes away, or once it\'s shown, and cleans up', async (t) => {
  t.after(() => {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.dispatchEvent;
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

test('keepAwake: a hold with a key also ends when a release names it, and cleans up; a release naming another hold, or one with no key (a wake\'s), leaves it running', async (t) => {
  t.after(() => {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.dispatchEvent;
    delete globalThis.document;
  });
  const page = fakePage();
  const ended = new Set();
  const older = keepAwake(5000, 'older').then(() => ended.add('older'));
  const newer = keepAwake(5000, 'newer').then(() => ended.add('newer'));
  const wake = keepAwake(5000).then(() => ended.add('wake'));
  await sleep(0);
  releaseInPage(['older']); // a late release: the hold placed after it runs on
  await sleep(10);
  assert.deepEqual([...ended], ['older']);
  page.fire('window', 'margin-release:newer'); // the page itself: only that hold ends early
  await sleep(10);
  assert.deepEqual([...ended].sort(), ['newer', 'older']);
  page.show();
  await Promise.all([older, newer, wake]);
  assert.equal(page.count(), 0, 'no listeners left in the page');
});

test('releaseInPage: self-contained (executeScript sends only its source), and safe in a page that broke dispatchEvent', async () => {
  const vm = await import('node:vm');
  const seen = [];
  vm.runInContext(`(${releaseInPage})(['a', 'b'])`, vm.createContext({ Event, dispatchEvent: (e) => seen.push(e.type) }));
  assert.deepEqual(seen, ['margin-release:a', 'margin-release:b']);
  vm.runInContext(`(${releaseInPage})(['a'])`, vm.createContext({ Event, dispatchEvent: () => { throw new Error('page wrapper'); } }));
});

test('release: a message to Margin\'s page naming the holds, a script in the page\'s own world only if nothing there answers it; nothing while a switch to the tab is under way (it ends them as it shows it)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 13, url: 'https://release.test/' }]);
  fake.scriptDelay = () => 40;
  const focusing = focusTab(13);
  fake.messages = [];
  assert.equal(releaseTab(13, ['k1']), false);
  assert.equal(fake.scripts.filter((x) => x.func === releaseInPage).length, 0);
  await focusing;
  const releases = () => fake.messages.filter((m) => m.message.type === RELEASE).map((m) => [m.tabId, m.message.keys]);
  assert.deepEqual(releases(), []);
  fake.scripts = [];
  assert.equal(releaseTab(13, ['k1', 'k2']), true);
  await sleep(5);
  assert.deepEqual(releases(), [[13, ['k1', 'k2']]]);
  assert.equal(fake.scripts.filter((x) => x.func === releaseInPage).length, 0, 'answered: nothing more');
  // A page with Margin's script from before (no listener of this copy's: no answer).
  fake.reply = undefined;
  fake.messages = [];
  assert.equal(releaseTab(13, ['k3']), true);
  await sleep(5);
  assert.deepEqual(releases(), [[13, ['k3']]]);
  const sent = fake.scripts.filter((x) => x.func === releaseInPage);
  assert.deepEqual(sent.map((x) => [x.tabId, x.world, x.args[0]]), [[13, 'MAIN', ['k3']]]);
});

test('hold: keep-ready\'s hold is a message to Margin\'s page, answered once it\'s over (background priority: no script left running); a page with no listener of this copy\'s is held by the page-world script for what\'s left; a message that failed late isn\'t followed by one', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 16, url: 'https://hold16.test/' }]);
  fake.scriptDelay = () => 1;
  const send = chrome.tabs.sendMessage;
  try {
    /** @type {(answer: unknown) => void} */
    let answer = () => {};
    chrome.tabs.sendMessage = async (tabId, message) => {
      fake.messages.push({ tabId, message });
      return message.type === HOLD ? new Promise((resolve) => { answer = resolve; }) : true;
    };
    let over = false;
    const held = holdTab(16, 60_000, 'key16').then((ran) => { over = true; return ran; });
    await sleep(10);
    assert.deepEqual(fake.messages.map((m) => [m.tabId, m.message]), [[16, { type: HOLD, key: 'key16', ms: 60_000 }]]);
    assert.equal(keepAwakes(16).length, 0, 'no script');
    assert.equal(over, false, 'running');
    answer({ held: true });
    assert.equal(await held, true);
    // No listener there: an answer of nothing, at once.
    chrome.tabs.sendMessage = async (tabId, message) => { fake.messages.push({ tabId, message }); return undefined; };
    fake.holdsRun = true;
    void holdTab(16, 60_000, 'key16b');
    await sleep(10);
    assert.deepEqual(keepAwakes(16).map((x) => [x.world, x.args[1]]), [['MAIN', 'key16b']]);
    assert.ok(keepAwakes(16)[0].args[0] <= 60_000 && keepAwakes(16)[0].args[0] > 59_000, 'for what\'s left of its time');
    // Failed after a while (its page gone with its process): nothing more.
    fake.scripts = [];
    chrome.tabs.sendMessage = async () => sleep(2100).then(() => { throw new Error('page gone'); });
    assert.equal(await holdTab(16, 60_000, 'key16c'), false);
    assert.equal(keepAwakes(16).length, 0);
  } finally {
    chrome.tabs.sendMessage = send;
    fake.holdsRun = false;
  }
});

test('hold: the messages are the ones Margin\'s page listens for', async () => {
  const page = await import('../extension/content/hold.js');
  assert.equal(HOLD, page.HOLD);
  assert.equal(RELEASE, page.RELEASE);
});

test('switch log: whether keep-ready held the tab and how long it had been hidden as the switch was asked for, and where the preparation\'s time went in the page', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 14, url: 'https://log.test/' }]);
  fake.scriptDelay = () => 5;
  const timings = { lagMs: 3, readMs: 4.5, renderMs: 2, catchUpMs: 1, layoutMs: 0.5 };
  let sentAt = null;
  fake.prepare = (args) => {
    sentAt = args?.[0]?.sentAt;
    return { ready: true, token: args?.[0]?.token, timings };
  };
  noteLeft(14, Date.now() - 5000);
  const entries = [];
  tapLog((entry) => entries.push(entry));
  const before = Date.now();
  try {
    await focusTab(14, { source: 'test' });
  } finally {
    tapLog(null);
  }
  const entry = entries.find((e) => e.kind === 'switch' && e.tabId === 14);
  assert.equal(entry.heldAtAsk, false);
  assert.ok(entry.hiddenForMs >= 5000 && entry.hiddenForMs < 5500, `hidden for ${entry.hiddenForMs} ms`);
  assert.deepEqual(entry.preparation.timings, timings);
  assert.ok(sentAt >= before && sentAt <= Date.now(), 'the call says when it was sent');
});

test('keepAwake: still finishes when the page broke setTimeout, Promise or addEventListener', async (t) => {
  const real = { setTimeout: globalThis.setTimeout, Promise: globalThis.Promise };
  t.after(() => {
    Object.assign(globalThis, real);
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.dispatchEvent;
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
  fake.scriptDelay = (_id, func) => func.name === 'prepareSidebarInPage' ? 950 : 5; // past its cap (900 ms; 250 for a tab awake: below)
  const focused = await focusTab(13);
  assert.equal(focused.preparation.outcome, 'timeout');
  const cancel = fake.scripts.find((s) => s.func.name === 'cancelSidebarInPage');
  assert.ok(cancel, 'the late preparation is invalidated');
  assert.ok(cancel.at <= fake.updates[0].at, 'invalidated before activation');
});

test('sidebar preparation: a tab whose wake answered awake gets 250 ms from that answer; one later is called off before the show; a tab whose wake didn\'t answer keeps 900 ms', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 230, url: 'https://awake-busy.test/' }]);
  fake.scriptDelay = (_id, func) => (func.name === 'prepareSidebarInPage' ? 400 : 5);
  const { result, entry } = await logged(230, () => focusTab(230));
  const [prepared] = prepares(230);
  assert.equal(result.preparation.outcome, 'timeout');
  assert.equal(entry.preparation.reason, 'awake budget');
  const shown = fake.updates[0].at - prepared.at;
  assert.ok(shown >= 240 && shown < 330, `shown ${shown} ms after its preparation went out`);
  const cancels = cancelsOf(230, prepared.args[0].token);
  assert.ok(cancels.some((x) => x.at <= fake.updates[0].at), 'called off before the show');

  // Its wake slower than WAKE_MAX_MS (not known to be awake): its own 900 ms.
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 231, url: 'https://not-answering.test/' }]);
  fake.scriptDelay = (_id, func) => (func.name === 'prepareSidebarInPage' ? 600 : func.name === 'pageThere' ? 450 : 5);
  const slow = await focusTab(231);
  assert.equal(slow.preparation.outcome, 'ready', 'waited for');
  const [late] = prepares(231);
  assert.ok(fake.updates[0].at - late.at >= 590, 'shown once it was prepared');

  // Its wake answering late (a process Safari resumed slowly answers both
  // scripts together, the preparation just behind): 250 ms from that answer.
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 233, url: 'https://resumed.test/' }]);
  fake.scriptDelay = (_id, func) => (func.name === 'prepareSidebarInPage' ? 330 : func.name === 'pageThere' ? 300 : 5);
  const resumed = await focusTab(233);
  assert.equal(resumed.preparation.outcome, 'ready', 'not cut off just behind its wake');
});

test('sidebar preparation: the page is told the state\'s last write (store.js stateRev), so one that saw it draws without reading storage', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 232, url: 'https://knows.test/' }]);
  fake.scriptDelay = () => 5;
  await mutate((st) => ({ ...st, settings: { ...st.settings, sidebarWidth: 271 } }));
  const written = fake.local.stateRev;
  assert.equal(typeof written?.id, 'string', 'stamped with the write');
  await focusTab(232);
  const [prepared] = prepares(232);
  assert.equal(prepared.args[0].rev, written.id);
});

test('sidebar preparation: a page still running an earlier copy gets the current one (and its theme) first, then is prepared', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 14, url: 'https://old-copy.test/' }]);
  fake.contentScripts = [{ js: ['content/other.bundle.js'], world: 'MAIN' }, { js: ['content/content.bundle.js'] }];
  let added = false;
  fake.prepare = (args) => (added ? { ready: true, token: args?.[0]?.token } : { ready: false, reason: 'no current sidebar' });
  fake.scriptDelay = (_id, func) => {
    if (!func) added = true;
    return 5;
  };
  const focused = await focusTab(14);
  const files = fake.scripts.find((s) => s.files);
  assert.deepEqual(files?.files, ['content/content.bundle.js', 'themes/arcadia/content.bundle.js']);
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

test('switch: a tab Safari unloaded, shown without loading it behind first (restores off), is noted before it\'s shown, so its page draws the right sidebar from its first frame', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 16, url: 'https://unloaded.test/' }]);
  await decided(); // the copy that owns the state notes it
  fake.scriptDelay = () => null; // no page
  fake.session.restoresOff = true; // as a background started again finds it
  delete fake.session.introductionsOff;
  resetRestores();
  resetIntroductions();
  await mutate((st) => M.activateTab(M.upsertTab(st, fake.tabs.get(1), Date.now()), 1, 1, Date.now())); // a restore would be tried without the flag
  const set = chrome.storage.local.set;
  let notedAt = 0;
  chrome.storage.local.set = async (items) => { if (items.showing) notedAt = Date.now(); return set(items); };
  try {
    await focusTab(16, { carry: 'toggle', scroll: 120 });
  } finally {
    chrome.storage.local.set = set;
    delete fake.session.restoresOff;
    resetRestores();
  }
  assert.deepEqual(fake.updates.map((u) => u.id), [16]);
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
  await sleep(150); // (its preparation answers, and is called off again)
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
  // (Answering within 60 ms of going out: one slower is drawn before it's shown, below.
  // Its last look before the show, its page free by then, quick.)
  fake.scriptDelay = (_id, func) => func.name === 'prepareSidebarInPage' || func.name === 'pingInPage' ? 5 : 50;
  const early = wakeTab(7);
  await sleep(30);
  const started = Date.now();
  const focused = await focusTab(7);
  assert.equal(fake.scripts.length, 4, 'no second wake; only the sidebar preparation and the look before the show are added');
  assert.equal(focused.preparation.outcome, 'ready');
  const waited = fake.updates[0].at - started;
  assert.ok(waited < 45, `only the rest of the early wake: ${waited}ms`);
  assert.equal((await early).outcome, 'awake');
});

test('wake: one whose page answered counts while its hold runs (1.8 s, less 400 ms), past the 600 ms of one that didn\'t; past that a fresh one starts', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 8, url: 'https://h.test/' }]);
  fake.scriptDelay = () => 5;
  await wakeTab(8);
  await sleep(650); // past the 600 ms any wake counts for
  assert.equal((await wakeTab(8)).outcome, 'awake');
  assert.equal(fake.scripts.length, 2, 'its hold runs: taken on');
  await sleep(800); // 1.45 s: its hold ends within 400 ms
  await wakeTab(8);
  assert.equal(fake.scripts.length, 4, 'a fresh one');
});

test('wake: one whose page hasn\'t answered yet is taken on past its 600 ms (a second would only queue behind it); answered late (its process resumed), it says so, and counts while its hold runs; one that found no page counts 600 ms only', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 240, url: 'https://slow240.test/' }, { id: 247, url: 'https://none247.test/' }]);
  fake.scriptDelay = () => 900; // a process Safari resumes at background priority
  assert.equal((await wakeTab(240)).outcome, 'timeout');
  await sleep(250); // 650 ms: no answer yet
  assert.equal((await wakeTab(240)).outcome, 'timeout');
  assert.equal(fake.scripts.length, 2, 'taken on, nothing sent');
  await sleep(300); // answered at 900 ms
  fake.scriptDelay = () => 5;
  const late = await wakeTab(240);
  assert.equal(late.outcome, 'awake', 'its late answer, not the timeout');
  assert.ok(late.ms >= 890, `answered ${late.ms} ms after it started`);
  assert.equal(fake.scripts.length, 2, 'its hold runs: taken on');
  await sleep(500); // 1.45 s
  await wakeTab(240);
  assert.equal(fake.scripts.length, 2, 'its hold counted from its answer (it started at the resume): 1.8 s from about 0.84 s, less 400 ms, still runs: taken on');
  await sleep(900); // 2.35 s
  await wakeTab(240);
  assert.equal(fake.scripts.length, 4, 'a fresh one');
  fake.scriptDelay = (id) => (id === 247 ? null : 5);
  assert.equal((await wakeTab(247)).outcome, 'no page');
  await sleep(650);
  fake.scriptDelay = () => 5;
  assert.equal((await wakeTab(247)).outcome, 'awake', 'woken afresh (it may have a page now)');
});

test('wake: an answer that lands just as an unanswered wake would stop counting (1 s) still leaves it counting for its hold', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 239, url: 'https://edge239.test/' }]);
  fake.scriptDelay = () => 1010;
  const started = Date.now();
  await wakeTab(239);
  while (Date.now() - started < 1030) await sleep(5);
  fake.scriptDelay = () => 5;
  assert.equal((await wakeTab(239)).outcome, 'awake');
  assert.equal(fake.scripts.length, 2, 'taken on: its hold runs to 1.8 s');
});

test('wake: a tab shown since (its hold ended then) or whose page went away: its wake doesn\'t count', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 241, url: 'https://shown241.test/' }]);
  fake.scriptDelay = () => 5;
  await wakeTab(241);
  tabShown(241); // its activation (background.js)
  await wakeTab(241);
  assert.equal(fake.scripts.length, 4, 'shown: a fresh one');
  forgetWake(241); // a load starting there (background.js)
  await wakeTab(241);
  assert.equal(fake.scripts.length, 6, 'its page gone: a fresh one');
});

test('hover: a wake started by a pointer resting on a row holds its tab 2 s, once (nothing renews it); a switch takes it on while that hold runs, and the switch log says what started it', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 242, url: 'https://hover242.test/' }]);
  fake.scriptDelay = () => 5;
  assert.equal((await wakeTab(242, { hover: true, by: 'hover' })).outcome, 'awake');
  assert.deepEqual(keepAwakes(242).map((x) => x.args[0]), [2000], 'held 2 s');
  await sleep(1400);
  const started = Date.now();
  const { entry } = await logged(242, () => focusTab(242));
  assert.ok(fake.updates[0].at - started < 40);
  assert.equal(keepAwakes(242).length, 1, 'nothing more sent to hold it');
  assert.equal(entry.wakeStartedBy, 'hover');
  assert.equal(entry.wake.by, 'hover');
  assert.equal(entry.wakeOutcome, 'awake');
  tabShown(242);
});

test('prewake: what the page asks for says what started it (a press by default); the sidebar\'s longer hold for a pointer resting, the sidebar coming out or a space; nothing for a tab keep-ready holds, nor for an earlier copy\'s renewal of a row\'s hold', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 248, url: 'https://reveal248.test/' }, { id: 249, url: 'https://press249.test/' }, { id: 250, url: 'https://held250.test/' }]);
  fake.scriptDelay = () => 5;
  try {
    await handlers.prewake({ tabId: 248, hover: true, why: 'reveal' });
    await handlers.prewake({ tabId: 249 });
    await handlers.prewake({ tabId: 249, hover: true, holdOnly: true, renew: true }); // (an earlier copy's renewal)
    await decided();
    await markSynced();
    await mutate((st) => M.upsertTab(st, fake.tabs.get(250), Date.now() - 60_000));
    fake.holdsRun = true;
    noteLeft(250, Date.now() - 1_000);
    holdNow(250);
    await sleep(10);
    assert.equal(switchFacts(250).heldAtAsk, true, 'held');
    const held = keepAwakes(250).length;
    await handlers.prewake({ tabId: 250, why: 'hover', hover: true });
    await sleep(20);
    assert.deepEqual(keepAwakes(248).map((x) => x.args[0]), [2000], 'the sidebar\'s hold');
    assert.deepEqual(keepAwakes(249).map((x) => x.args[0]), [1800], 'a press\'s, once');
    assert.equal(scriptsNamed(250, 'pageThere').length, 0, 'held: no wake');
    assert.equal(keepAwakes(250).length, held);
    const { entry } = await logged(248, () => focusTab(248));
    assert.equal(entry.wakeStartedBy, 'reveal');
    const pressed = await logged(249, () => focusTab(249));
    assert.equal(pressed.entry.wakeStartedBy, 'press');
  } finally {
    resetKeepReady();
    for (const id of [248, 249, 250]) tabShown(id);
  }
});

test('wake: a switch whose preparation isn\'t bounded by the awake budget (a tab never shown, introductions off) doesn\'t take on a wake whose hold ends before its show; it holds the tab afresh', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 245, url: 'https://never245.test/' }]);
  fake.session.introductionsOff = true;
  resetIntroductions();
  try {
    tabOpened({ id: 245, active: false }); // opened behind (a ⌘-click)
    fake.scriptDelay = (id, func) => (func?.name === 'prepareSidebarInPage' ? 700 : 5);
    await wakeTab(245); // woken ahead: a press, the palette, a key run
    await sleep(1350);
    await focusTab(245);
    const update = fake.updates.find((u) => u.id === 245);
    assert.ok(update, 'shown');
    const holdEnd = Math.max(...keepAwakes(245).map((k) => k.at + k.args[0]));
    assert.ok(holdEnd - update.at >= 100, `a hold runs past its show (${holdEnd - update.at} ms left)`);
  } finally {
    delete fake.session.introductionsOff;
    resetIntroductions();
    tabShown(245);
  }
});

test('wake: a page with an earlier copy of Margin, given the current one: its process is held through that, past a short preparation\'s hold', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 246, url: 'https://old246.test/' }]);
  fake.scriptDelay = () => 5;
  await wakeTab(246);
  await sleep(1200); // its hold has 600 ms left: enough for an awake preparation
  fake.contentScripts = [{ js: ['content/content.bundle.js'] }];
  let added = false;
  fake.prepare = (args) => (added ? { ready: true, token: args?.[0]?.token } : { ready: false, reason: 'no current sidebar' });
  fake.scriptDelay = (_id, func) => {
    if (!func) added = true;
    return !func ? 300 : func.name === 'prepareSidebarInPage' && added ? 300 : 5; // the copy, and the page busy with it
  };
  const focused = await focusTab(246);
  assert.equal(focused.preparation.outcome, 'ready');
  const update = fake.updates.find((u) => u.id === 246);
  assert.ok(update, 'shown');
  const holdEnd = Math.max(...keepAwakes(246).map((k) => k.at + k.args[0]));
  assert.ok(holdEnd - update.at >= 100, `a hold runs past its show (${holdEnd - update.at} ms left)`);
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

test('openBehind: the new tab comes to the front once its page has painted, before it has loaded (a page that paints nothing still waits for the limit: above)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const started = Date.now();
  const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  setTimeout(() => fake.painted.add(2), 200);
  assert.deepEqual(await shown, { tabId: 2, shown: 2 });
  const took = Date.now() - started;
  assert.ok(took >= 195 && took < 700, `shown at its first paint (${took}ms), not at its load or the limit`);
  assert.equal(fake.tabs.get(2).status, 'loading', 'still loading as it was shown');
});

test('arriving covered: a tab opened behind is prepared to arrive covered; an ordinary switch isn\'t', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  fake.scriptDelay = () => 1;
  tabShown(4); // (the new tab's id: an earlier test's tab 4 answered its wake late, resumed behind)
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
const barriers = (id) => fake.scripts.filter((x) => x.tabId === id && x.func.name === 'paintBarrierInPage');
const scriptsNamed = (id, name) => fake.scripts.filter((x) => x.tabId === id && x.func.name === name);
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
  delete fake.session.restoresOff;
  resetIntroductions();
  resetRestores();
  await knownInFront(1);
  return () => { // after the test
    for (const id of opened) tabShown(id);
    fake.activated = null;
    setIntroductionHooks({ activated: null, introduced: null });
    delete fake.session.introductionsOff;
    delete fake.session.restoresOff;
    resetIntroductions();
    resetRestores();
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
    const drawn = barriers(30).filter((x) => x.at >= fake.updates[1].at);
    assert.ok(drawn.length >= 1 && fake.updates[2].at - drawn[0].at >= 55, 'shown once its page has drawn after the introduction (paintBarrierInPage)');
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

test('introducing: not a tab shown before (and one never shown: introduced; one still loading, or one Safari unloaded: below)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 32, url: 'https://seen.test/' }, { id: 34, url: 'https://new.test/' }], [34]);
  try {
    for (const id of [32]) {
      putInFront(1); // as Margin has it
      fake.updates = [];
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id], `tab ${id}: just shown`);
    }
    assert.equal(isIntroduction({ tabId: 32, windowId: 1 }), false, 'no activations left out');
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
    // Not taken for introduced: shown again later, from a page Margin knows, it is.
    putInFront(36);
    await knownInFront(36);
    fake.updates = [];
    tabOpened({ id: 35, active: false }); // never shown, as far as this test goes
    await focusTab(35);
    assert.deepEqual(fake.updates.map((u) => u.id), [35, 36, 35]);
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
    // Safari slow to answer the introduction's updates (a hung process): the
    // page's deadline comes first, and the tab is shown as it is
    // (background/tabs.js focusTab), its introduction over.
    const late = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (id === 1) await sleep(1500);
      return answer;
    }, () => focusTab(43, { deadline: Date.now() + 2700 }));
    assert.equal(late.forced, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [43, 1, 43], 'introduced, then out of time: shown as it is');
    await sleep(1600); // (the introduction's answers come)
    putInFront(1);
    await knownInFront(1);
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

test('introducing: the page in front hidden for an instant after the two updates went out, before the real switch, turns them off for the session; a real switch away and back doesn\'t, nor the tab introduced saying it blinked', async () => {
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
    // The tab introduced itself, hidden just before (shared/switching.js says
    // a blink with no switch under way too), and shown for that instant.
    pageBlinked(1, { hiddenAt: sentAt - 5, shownAt: sentAt + 2 }, 52);
    await sleep(0);
    assert.equal(fake.session.introductionsOff, undefined);
    // A busy page in front, dating it when it got to it (after the answers).
    pageBlinked(1, { hiddenAt: answeredAt + 30, shownAt: answeredAt + 30 }, 1);
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


test('introducing: shown once its page has drawn after the introduction (a rendering update there), not after a fixed wait: at once for a quick page, later for a busy one', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 160, url: 'https://quick.test/' }, { id: 161, url: 'https://busy.test/' }], [160, 161]);
  try {
    fake.barrierMs = (id) => (id === 160 ? 5 : 150);
    await focusTab(160);
    assert.deepEqual(fake.updates.map((u) => u.id), [160, 1, 160]);
    const quick = fake.updates[2].at - fake.updates[1].at;
    assert.ok(quick < 45, `a quick page shown ${quick}ms after its introduction`);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(161);
    assert.deepEqual(fake.updates.map((u) => u.id), [161, 1, 161]);
    const busy = fake.updates[2].at - fake.updates[1].at;
    assert.ok(busy >= 145, `a busy page shown once it drew (${busy}ms)`);
  } finally {
    done();
  }
});

test('introducing: a tab never shown whose page is too busy to answer its wake in time is introduced all the same (only no page means no page)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 162, url: 'https://busy.test/' }], [162]);
  try {
    fake.scriptDelay = (id, func) => (id === 162 && (func === keepAwake || func?.name === 'pageThere') ? 600 : 1);
    const result = await focusTab(162);
    assert.equal(result.tab?.id, 162);
    assert.deepEqual(fake.updates.map((u) => u.id), [162, 1, 162], 'introduced, then shown');
  } finally {
    done();
  }
});

test('introducing: a tab shown before whose page started visible and never came into view from hidden (in front at a launch, loaded as it was shown) is introduced once, prepared after its introduction, with no arrival cover', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 163, url: 'https://launch.test/' }, { id: 164, url: 'https://seen.test/' }], []);
  try {
    fake.unseen.add(163);
    const result = await focusTab(163, { covered: true });
    assert.equal(result.tab?.id, 163);
    assert.deepEqual(fake.updates.map((u) => u.id), [163, 1, 163], 'introduced, then shown');
    const [early, after, ...more] = prepares(163);
    assert.ok(early && after && !more.length, 'prepared beside its wake, then again after its introduction');
    assert.ok(after.at >= fake.updates[1].at && after.at < fake.updates[2].at, 'the second between its introduction and its show');
    assert.notEqual(after.args[0].token, early.args[0].token, 'under a token of its own (a late answer to the first isn\'t taken for it)');
    const cancels = scriptsNamed(163, 'cancelSidebarInPage').filter((x) => x.args[0] === early.args[0].token);
    assert.ok(cancels.some((x) => x.at <= fake.updates[0].at), 'the early preparation called off before the introduction');
    assert.ok(cancels.some((x) => x.at >= early.at), 'and after it went out');
    assert.equal(result.preparation.token, after.args[0].token, 'the one after it goes with the show');
    assert.equal(scriptsNamed(163, 'coverArrivalInPage').length, 0, 'no arrival cover: it has painted on screen before');
    // Once until it's shown: asked again (say the switch didn't land), not introduced again.
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(163);
    assert.deepEqual(fake.updates.map((u) => u.id), [163]);
    // A page that has come into view from hidden: not introduced.
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(164);
    assert.deepEqual(fake.updates.map((u) => u.id), [164]);
  } finally {
    tabShown(163);
    done();
  }
});

test('introducing: an unseen tab whose early preparation is slow: waited for 150 ms at most before its introduction, called off then, and again once it answers; the show goes with the preparation made after the introduction', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 170, url: 'https://slowearly.test/' }], []);
  try {
    fake.unseen.add(170);
    let calls = 0;
    fake.scriptDelay = (id, func) => (id === 170 && func?.name === 'prepareSidebarInPage' && calls++ === 0 ? 300 : 1);
    const result = await focusTab(170);
    assert.equal(result.tab?.id, 170);
    assert.deepEqual(fake.updates.map((u) => u.id), [170, 1, 170], 'introduced, then shown');
    const [early] = prepares(170);
    const waited = fake.updates[0].at - early.at;
    assert.ok(waited >= 140 && waited < 280, `introduced ${waited}ms after the early preparation went out (waited for it, 150 ms at most)`);
    assert.ok(result.preparation.token.endsWith(':introduced'), 'the show goes with the preparation after the introduction');
    await sleep(Math.max(0, early.at + 330 - Date.now()));
    const cancels = scriptsNamed(170, 'cancelSidebarInPage').filter((x) => x.args[0] === early.args[0].token);
    assert.ok(cancels.some((x) => x.at <= fake.updates[0].at), 'called off before the introduction');
    assert.ok(cancels.some((x) => x.at >= early.at + 295), 'and again once it answered (a late answer could otherwise land after the first call-off)');
  } finally {
    tabShown(170);
    done();
  }
});

test('wake: a page says whether it ever came into view from hidden (unseen); one with an earlier copy, or none, counts as seen; the empty page a tab starts with is no page', async () => {
  const vm = await import('node:vm');
  const ask = (href, Margin) => vm.runInContext(`(${pageThere})()`, vm.createContext({ location: { href }, ...(Margin ? { Margin } : {}) }));
  assert.equal(ask('https://a.test/', { content: { windowSeen: () => false } }), 'unseen');
  assert.equal(ask('https://a.test/', { content: { windowSeen: () => true } }), true);
  assert.equal(ask('https://a.test/', { content: {} }), true, 'an earlier copy (no windowSeen)');
  assert.equal(ask('https://a.test/', null), true, 'no copy in this world');
  assert.equal(ask('about:blank', { content: { windowSeen: () => false } }), false);
  assert.equal(ask('https://a.test/', { content: { windowSeen: () => true, cameIntoView: () => true } }), 'seen', 'one that came into view from hidden itself');
  assert.equal(ask('https://a.test/', { content: { windowSeen: () => true, cameIntoView: () => false } }), true);
});

test('introducing: a tab Margin never saw shown (opened behind) whose page says it has come into view from hidden (Safari showed it, or a switch went out with no introduction) isn\'t introduced', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 304, url: 'https://shownbysafari.test/' }], [304]);
  try {
    assert.ok(isNeverShown(304));
    fake.seen.add(304);
    await focusTab(304, { covered: true });
    assert.deepEqual(fake.updates.map((u) => u.id), [304], 'shown, not introduced first');
    assert.equal(isNeverShown(304), false, 'its mark gone');
  } finally {
    done();
  }
});

test('introducing: a tab whose page started unseen (hello) and has since come into view from hidden is still introduced when nothing says its tab left the window (its window uncovered, a minimize: WebKit marks a tab only as it enters a window)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 305, url: 'https://uncovered.test/' }], []);
  try {
    // As Tirth's Safari had it on 2026-11-03: a tab restored in front at the
    // relaunch, its window covered (state 30 to 58) and uncovered (58 to 30)
    // while it stayed in front, then left: its first return showed 420 ms of
    // Safari's empty view.
    heardActivation({ tabId: 305, windowId: 1 });
    pageStarted(305, { unseen: true, heard: activationsHeard() });
    heardActivation({ tabId: 1, windowId: 1 }); // left (after its hello was handled)
    await sleep(5);
    fake.seen.add(305);
    await focusTab(305);
    assert.deepEqual(fake.updates.map((u) => u.id), [305, 1, 305], 'introduced, then shown');
  } finally {
    tabShown(305);
    done();
  }
});

test('introducing: a page\'s word that it started unseen, handled only once its tab had been left and come back (both activations came after its hello), doesn\'t stand once the page says it came into view; one whose bringing up came after it does', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 306, url: 'https://backbeforehello.test/' }, { id: 307, url: 'https://latepick.test/' }, { id: 308, url: 'https://notseen.test/' }], []);
  try {
    // 306: selected (loaded in front), its hello came, then tab 1 and 306
    // again, all before the hello was handled (it waits for the ownership
    // check, an activation for the state).
    heardActivation({ tabId: 306, windowId: 1 });
    const hello306 = activationsHeard();
    heardActivation({ tabId: 1, windowId: 1 });
    heardActivation({ tabId: 306, windowId: 1 });
    pageStarted(306, { unseen: true, heard: hello306 });
    // 307: the activation that brought it up came after its hello (a
    // background starting, given both at once): not a return.
    const hello307 = activationsHeard();
    heardActivation({ tabId: 307, windowId: 1 });
    pageStarted(307, { unseen: true, heard: hello307 });
    // 308: left and back after its hello, but its page hasn't come into
    // view (Safari loaded it afresh as it came back, say): introduced.
    heardActivation({ tabId: 308, windowId: 1 });
    const hello308 = activationsHeard();
    heardActivation({ tabId: 1, windowId: 1 });
    heardActivation({ tabId: 308, windowId: 1 });
    pageStarted(308, { unseen: true, heard: hello308 });
    await sleep(5);
    fake.seen.add(306);
    fake.seen.add(307);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(306);
    assert.deepEqual(fake.updates.map((u) => u.id), [306], 'left and back since: shown, not introduced');
    await sleep(5);
    assert.equal((fake.session.inWindowTabs?.tabs ?? []).find(([id]) => id === 306)?.[1]?.marked, true, 'proven in the session too');
    for (const id of [307, 308]) {
      putInFront(1);
      await knownInFront(1);
      fake.updates = [];
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id], `tab ${id}: introduced, then shown`);
    }
  } finally {
    for (const id of [306, 307, 308]) tabShown(id);
    done();
  }
});

test('openBehind: a new tab shown at its first paint, still loading, is introduced all the same (it was never in a window)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }], []);
  try {
    const shown = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 }, created: (tab) => tabOpened({ id: tab.id, active: false }) });
    setTimeout(() => fake.painted.add(fake.created[0].id), 150);
    const { tabId, shown: id } = await shown;
    assert.equal(id, tabId);
    assert.deepEqual(fake.updates.map((u) => u.id), [tabId, 1, tabId], 'introduced, then shown');
    assert.equal(fake.tabs.get(tabId).status, 'loading');
    tabShown(tabId);
  } finally {
    done();
  }
});

test('openBehind: a new tab that hasn\'t painted by its limit, on a busy page (its scripts take 260 ms), is still introduced before it\'s shown', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }], []);
  try {
    fake.scriptDelay = (id) => (id === 1 ? 1 : 260);
    const entries = [];
    tapLog((e) => entries.push(e));
    const result = await openBehind({ url: 'https://endless.test/', from: { id: 1, windowId: 1 }, maxMs: 400, created: (tab) => tabOpened(tab) });
    tapLog(null);
    assert.deepEqual(result, { tabId: 2, shown: 2 });
    assert.deepEqual(fake.updates.map((u) => u.id), [2, 1, 2], 'introduced, then shown');
    assert.equal(entries.filter((e) => e.kind === 'switch' && e.source === 'new tab').at(-1)?.introduced, true);
  } finally {
    tabShown(2);
    done();
  }
});

// ---- a tab not ready to show (tabs.js restoreTab, waitLoaded) --------------------

// Tabs Safari unloaded: no page (scripts fail at once), and their status says
// complete. Selected, one has a view (scripts answer with an error), and
// starts loading (Safari's lazy restore) `startMs` later (at once by default),
// done after `loadMs`; with `behind: false`, only if it's still the tab
// selected a turn later (Safari putting its load off: it then loads the tab
// selected by then). `cached`: back from its cache at once (never seen
// loading); `busyMs`: its scripts answer that late once it has a page.
// `answerMs`: Safari answers tabs.update that late (~110 ms in Safari).
const unloaded = new Map(); // id → how
const noPage = new Set();
const viewed = new Set();
const busy = new Map(); // id → ms
// `launchMs`: its process starts that long after the selection (a Mac
// busy after a relaunch): its scripts wait until then, Safari still says
// 'complete' (as for any tab it unloaded), and its load starts then.
/** @param {any[]} tabs @param {Record<number, { loadMs?: number, startMs?: number, behind?: boolean, cached?: boolean, busyMs?: number, launchMs?: number }>} asleep @param {{ answerMs?: number }} [options] */
async function restoring(tabs, asleep, { answerMs = 0 } = {}) {
  const done = await introducing(tabs, []);
  unloaded.clear();
  noPage.clear();
  viewed.clear();
  busy.clear();
  delete fake.session.restoreMisses;
  resetRestores();
  for (const [id, how] of Object.entries(asleep)) {
    unloaded.set(Number(id), { loadMs: 100, startMs: 0, behind: true, ...how });
    noPage.add(Number(id));
  }
  fake.scriptDelay = (id) => (noPage.has(id) ? null : busy.get(id) ?? 1);
  fake.scriptError = (id) => noPage.has(id) && viewed.has(id);
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, change) => {
    const answer = await update(id, change);
    const how = unloaded.get(id);
    const load = () => {
      unloaded.delete(id);
      noPage.delete(id);
      if (how.busyMs) busy.set(id, how.busyMs);
      if (how.cached) return;
      fake.tabs.get(id).status = 'loading';
      setTimeout(() => { if (fake.tabs.has(id)) fake.tabs.get(id).status = 'complete'; }, how.loadMs);
    };
    if (how && change.active) {
      viewed.add(id);
      if (how.launchMs) {
        let launched = () => {};
        const running = new Promise((resolve) => { launched = resolve; });
        fake.suspended.set(id, { wait: () => running, shown() {} });
        setTimeout(() => {
          fake.suspended.delete(id);
          if (unloaded.has(id) && fake.tabs.has(id)) load();
          launched();
        }, how.launchMs);
      } else if (how.behind) {
        if (how.startMs) setTimeout(() => unloaded.has(id) && fake.tabs.has(id) && load(), how.startMs);
        else load();
      } else setTimeout(() => fake.tabs.get(id)?.active && unloaded.has(id) && load(), 0);
    }
    if (answerMs) await sleep(answerMs);
    return answer;
  };
  return () => {
    chrome.tabs.update = update;
    for (const id of Object.keys(asleep)) tabShown(Number(id));
    delete fake.session.restoreMisses;
    done();
  };
}
// What the page in front (tab 1) was told.
const toldFront = () => fake.messages.filter((m) => m.tabId === 1).map((m) => [m.message.type, m.message.tabId, m.message.cover ?? null]);

test('restoring: a tab Safari unloaded is loaded behind the page (to the front and straight back, sent together), the page in front covered meanwhile; once loaded it\'s introduced (its first instant in the window doesn\'t count: it had no process yet), then shown, its page prepared to arrive covered', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 60, url: 'https://unloaded.test/' }], { 60: { loadMs: 200 } });
  try {
    const events = [];
    fake.activated = (info) => events.push([info.tabId, isIntroduction(info)]);
    const heard = [];
    setIntroductionHooks({ introduced: (id) => heard.push(id) });
    const asked = Date.now();
    const result = await focusTab(60, { carry: 'hover' });
    assert.equal(result.tab?.id, 60);
    assert.deepEqual(fake.updates.map((u) => u.id), [60, 1, 60, 1, 60], 'restored, introduced, shown');
    assert.ok(fake.updates[1].at - fake.updates[0].at < 5, 'the two sent together');
    assert.ok(fake.updates[2].at - asked >= 190, `introduced once it had loaded (${fake.updates[2].at - asked}ms)`);
    const drawn = barriers(60).filter((x) => x.at >= fake.updates[3].at);
    assert.ok(drawn.length >= 1 && fake.updates[4].at - drawn[0].at >= 55, 'shown once its page has drawn after the introduction (paintBarrierInPage)');
    assert.deepEqual(events.map(([, left]) => left), [true, true, true, true, false], 'only the real switch is told as one');
    assert.equal(front(), 60);
    // (A first try, beside the wake, found no page.)
    const loadedPrepares = prepares(60).filter((x) => x.at > fake.updates[0].at);
    assert.deepEqual(loadedPrepares.map((x) => [x.args[0].covered, x.args[0].carry]), [[true, 'hover']], 'prepared hidden once loaded, to arrive covered, as a sidebar switch is');
    assert.ok(loadedPrepares[0].at >= fake.updates[3].at && loadedPrepares[0].at < fake.updates[4].at, 'after its introduction (its instant on screen would take the preparation)');
    const arrivals = fake.scripts.filter((x) => x.tabId === 60 && x.func.name === 'coverArrivalInPage');
    assert.equal(arrivals.length, 1);
    assert.ok(arrivals[0].at > fake.updates[1].at && arrivals[0].at <= fake.updates[2].at, 'out of sight under its cover once loaded, before its introduction (that instant paints only the cover)');
    assert.deepEqual(heard, [60, 60], 'keep-ready hears of it (it can hold it now)');
    assert.deepEqual(toldFront(), [['switching', 60, 'now'], ['switch-done', 60, null]], 'the page in front covered at once, then told');
    assert.equal(fake.local.showing?.tabId === 60, false, 'no note needed: its page knows its tab');
  } finally {
    done();
  }
});

test('restoring: a switch with no cover of its own (a space, a closed tab) covers the page in front while the tab loads; the page is told if it fails', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 61, url: 'https://space.test/' }], { 61: {} });
  try {
    await focusTab(61, { source: 'space' });
    assert.deepEqual(toldFront(), [['switching', 61, 'now'], ['switch-done', 61, null]]);
    assert.deepEqual(prepares(61).filter((x) => x.at > fake.updates[0].at).map((x) => x.args[0].covered), [true], 'arriving covered, as the page before was');
    putInFront(1);
    await knownInFront(1);
    fake.tabs.set(62, { id: 62, windowId: 1, url: 'https://gone.test/', status: 'complete', active: false });
    unloaded.set(62, { loadMs: 100, behind: true });
    noPage.add(62);
    fake.messages = [];
    const shown = focusTab(62, { source: 'space' });
    await sleep(60);
    fake.tabs.delete(62); // closed while it loads
    await assert.rejects(shown, /No tab with id 62/);
    assert.deepEqual(toldFront().map(([type]) => type), ['switching', 'switch-failed']);
  } finally {
    done();
  }
});

test('restoring: Safari putting the load off (it loads the tab selected by then): the switch goes ahead as before; after two such tabs in a row, even with the background started again between them, no more tries this Safari session', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 63, url: 'https://b.test/' }, { id: 64, url: 'https://c.test/' }, { id: 65, url: 'https://d.test/' }], { 63: { behind: false }, 64: { behind: false }, 65: { behind: false } });
  try {
    await decided();
    for (const id of [63, 64]) {
      putInFront(1);
      await knownInFront(1);
      fake.updates = [];
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id], `tab ${id}: tried, then shown as before`);
      assert.ok(fake.updates[2].at - fake.updates[1].at >= 550, 'once its load didn\'t start in time');
      assert.equal(front(), id);
      assert.equal(fake.local.showing?.tabId, id, 'noted, as a tab shown unloaded is');
      resetRestores(); // the background stopped and started again
    }
    assert.equal(fake.session.restoresOff, true);
    assert.equal(fake.session.introductionsOff, undefined, 'introductions stay on: Safari did bring the page back');
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(65);
    assert.deepEqual(fake.updates.map((u) => u.id), [65], 'not tried again');
  } finally {
    done();
  }
});

test('restoring: Safari slow to answer (tabs.get 350 ms, as after a relaunch) and putting the load off: its script\'s failure, 20 ms on, is still heard (not taken as a page too busy to answer), so each counts as a miss, and restores go off after two', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 77, url: 'https://slowb.test/' }, { id: 78, url: 'https://slowc.test/' }], { 77: { behind: false }, 78: { behind: false } });
  const get = chrome.tabs.get;
  const run = chrome.scripting.executeScript;
  const slow = (id) => id === 77 || id === 78;
  chrome.tabs.get = async (id) => {
    if (slow(id)) await sleep(350);
    return get(id);
  };
  chrome.scripting.executeScript = async (options) => {
    if (slow(options.target.tabId)) await sleep(20);
    return run(options);
  };
  try {
    await decided();
    for (const id of [77, 78]) {
      putInFront(1);
      await knownInFront(1);
      fake.updates = [];
      const entries = [];
      tapLog((e) => entries.push(e));
      await focusTab(id, { deadline: Date.now() + 7000 });
      tapLog(null);
      const entry = entries.find((e) => e.kind === 'switch' && e.tabId === id);
      assert.equal(entry?.restored, 'not loaded', `tab ${id}: ${entry?.restored} (${entry?.restoreStart})`);
      assert.equal(entry?.restoreStart, undefined);
      resetRestores();
    }
    assert.equal(fake.session.restoresOff, true);
  } finally {
    chrome.tabs.get = get;
    chrome.scripting.executeScript = run;
    delete fake.session.restoresOff;
    resetRestores();
    done();
  }
});

test('restoring: misses count only in a row: a tab loaded behind between two keeps restores on', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 66, url: 'https://b.test/' }, { id: 67, url: 'https://c.test/' }, { id: 68, url: 'https://d.test/' }], { 66: { behind: false }, 67: {}, 68: { behind: false } });
  try {
    for (const id of [66, 67, 68]) {
      putInFront(1);
      await knownInFront(1);
      await focusTab(id);
      resetRestores(); // the background stopped and started again: the count is Safari's session's
    }
    assert.equal(fake.session.restoresOff, undefined);
    assert.equal(fake.session.restoreMisses, 1);
  } finally {
    done();
  }
});

test('restoring: a page back from its cache at once (never seen loading) is found by a script running there', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 69, url: 'https://cached.test/' }, { id: 70, url: 'https://cached2.test/' }], { 69: { cached: true }, 70: { cached: true } });
  try {
    for (const id of [69, 70]) {
      putInFront(1);
      await knownInFront(1);
      fake.updates = [];
      const asked = Date.now();
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id, 1, id]);
      assert.ok(fake.updates[2].at - asked < 300, `introduced soon (${fake.updates[2].at - asked}ms)`);
    }
    assert.equal(fake.session.restoresOff, undefined);
  } finally {
    done();
  }
});

test('restoring: a page too busy to answer a script once back is taken as loading (not a miss), and its restore held up only to the usual limit (its load not seen, its document silent: Safari\'s \'complete\' says nothing); its show then waits for its page to answer, until its page\'s deadline is near (2026-11-04)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 71, url: 'https://busy.test/' }], { 71: { cached: true, busyMs: 8000 } });
  try {
    const asked = Date.now();
    const result = await focusTab(71, { deadline: asked + 7000 });
    assert.equal(result.tab?.id, 71);
    const shown = fake.updates.at(-1).at - asked;
    // (Its restore over at 2.5 s, then the introduction's questions to the
    // busy page; its last look before the show, unanswered: shown as it is
    // FORCE_SHOW_MS before the deadline, until 2026-11-04 at about 2.5 s,
    // into a page that couldn't draw.)
    assert.ok(fake.updates.filter((u) => u.id === 71).length >= 2, 'restored behind first');
    assert.ok(fake.updates.find((u) => u.id === 71).at - asked < 2700, 'its restore ended at the usual limit');
    assert.ok(shown >= 5400 && shown < 6000, `shown at its page's deadline, its page never answering (${shown}ms)`);
    assert.equal(fake.session.restoreMisses, undefined, 'not counted as Safari putting it off');
  } finally {
    done();
  }
});

test('restoring: a tab whose process is slow to start once selected (its scripts wait, Safari still says \'complete\') isn\'t taken as loaded: it stays behind until its load is seen and it has loaded, then is introduced and shown', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 76, url: 'https://launching.test/' }], { 76: { launchMs: 1100, loadMs: 300 } });
  try {
    const entries = [];
    tapLog((e) => entries.push(e));
    const asked = Date.now();
    const result = await focusTab(76, { deadline: asked + 7000 });
    tapLog(null);
    assert.equal(result.tab?.id, 76);
    assert.deepEqual(fake.updates.map((u) => u.id), [76, 1, 76, 1, 76], 'restored, introduced, shown');
    const introducedAt = fake.updates[2].at - asked;
    assert.ok(introducedAt >= 1380, `introduced once it had loaded (${introducedAt}ms; its load started at 1100, done at 1400)`);
    const entry = entries.find((e) => e.kind === 'switch' && e.tabId === 76);
    assert.equal(entry?.restored, 'loaded');
    assert.equal(entry?.restoreStart, 'waiting', 'the switch log says its start wasn\'t seen at first');
    assert.equal(fake.session.restoreMisses, undefined);
  } finally {
    done();
  }
});

test('restoring: another unloaded tab asked for while the first loads is restored too (the first\'s turn in the window is over)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 72, url: 'https://first.test/' }, { id: 73, url: 'https://second.test/' }], { 72: { loadMs: 400 }, 73: {} });
  try {
    const first = focusTab(72);
    await sleep(150);
    const second = await focusTab(73);
    assert.equal(second.tab?.id, 73);
    assert.equal((await first).superseded, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [72, 1, 73, 1, 73, 1, 73], 'restored, then the second restored, introduced, shown');
    assert.equal(front(), 73);
  } finally {
    done();
  }
});

test('restoring: the same tab asked for again while it loads behind: its load is waited for, then it\'s introduced and shown', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 74, url: 'https://again.test/' }], { 74: { loadMs: 300 } });
  try {
    const first = focusTab(74);
    await sleep(120);
    const asked = Date.now();
    const second = await focusTab(74);
    assert.equal(second.tab?.id, 74);
    assert.equal((await first).superseded, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [74, 1, 74, 1, 74]);
    assert.ok(fake.updates[2].at - asked >= 150, 'introduced once loaded, not shown while loading');
    // Each switch's word says which it is: the first's 'switch-done' (called
    // off) doesn't end the second's cover (shared/switching.js).
    const told = fake.messages.filter((m) => m.tabId === 1).map((m) => m.message);
    const [one, two] = told.filter((m) => m.type === 'switching');
    assert.notEqual(one.switchId, two.switchId);
    assert.deepEqual(told.filter((m) => m.type !== 'switching').map((m) => [m.type, m.switchId]), [['switch-done', one.switchId], ['switch-done', two.switchId]]);
  } finally {
    done();
  }
});

test('restoring: a tab never shown that\'s still loading (a ⌘-clicked link) is waited for, the page in front covered, then introduced and shown', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 75, url: 'https://clicked.test/', status: 'loading' }], {});
  try {
    tabOpened({ id: 75, active: false });
    setTimeout(() => { fake.tabs.get(75).status = 'complete'; }, 200);
    const asked = Date.now();
    await focusTab(75);
    assert.deepEqual(fake.updates.map((u) => u.id), [75, 1, 75]);
    assert.ok(fake.updates[0].at - asked >= 190, 'introduced once loaded');
    assert.deepEqual(toldFront(), [['switching', 75, 'now'], ['switch-done', 75, null]]);
  } finally {
    done();
  }
});

test('restoring: a tab never shown going from a loaded page to another: the old page, loaded, isn\'t taken for the new one (its load waited for)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 171, url: 'https://redirect.test/', status: 'loading' }], {});
  try {
    tabOpened({ id: 171, active: false });
    fake.oldDocument.add(171);
    setTimeout(() => { fake.oldDocument.delete(171); fake.tabs.get(171).status = 'complete'; }, 250);
    const asked = Date.now();
    await focusTab(171);
    assert.deepEqual(fake.updates.map((u) => u.id), [171, 1, 171]);
    assert.ok(fake.updates[0].at - asked >= 240, `introduced once the tab said it had loaded (${fake.updates[0].at - asked}ms), not at the old page's answer`);
  } finally {
    done();
  }
});

test('restoring: another switch while it loads stands; the tab stays behind, loaded, and is introduced when it\'s shown later', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 76, url: 'https://unloaded.test/' }, { id: 77, url: 'https://e.test/' }], { 76: { loadMs: 300 } });
  try {
    const first = focusTab(76);
    const firstEnded = first.then(() => Date.now());
    await sleep(120);
    assert.equal(fake.tabs.get(76).status, 'loading');
    const switched = Date.now();
    await focusTab(77);
    const result = await first;
    assert.ok(await firstEnded - switched < 150, `given up at its next look (${await firstEnded - switched}ms)`);
    assert.deepEqual(toldFront().filter(([, id]) => id === 76).map(([type]) => type), ['switching', 'switch-done'], 'the page told it\'s over, not that it failed');
    assert.equal(result.tab, null);
    assert.equal(result.superseded, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [76, 1, 77]);
    assert.equal(front(), 77);
    await sleep(250);
    await knownInFront(77);
    fake.updates = [];
    assert.equal(isNeverShown(76), true, 'its page arrives covered (handlers.js focusWithSidebar)');
    await focusTab(76);
    assert.deepEqual(fake.updates.map((u) => u.id), [76, 77, 76], 'introduced, then shown');
  } finally {
    done();
  }
});

test('restoring: a key press after it (hurry) stops the wait at once, the tab left behind loading; one already pressed skips it', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 78, url: 'https://unloaded.test/' }, { id: 79, url: 'https://unloaded2.test/' }], { 78: { loadMs: 2000 }, 79: {} });
  try {
    let pressed = false;
    setTimeout(() => { pressed = true; }, 150);
    const asked = Date.now();
    const result = await focusTab(78, { hurry: () => pressed });
    assert.deepEqual([result.tab, result.hurried], [null, true]);
    assert.ok(Date.now() - asked < 300, `given up at once (${Date.now() - asked}ms)`);
    assert.equal(fake.tabs.get(78).status, 'loading', 'left behind, loading');
    assert.deepEqual(fake.updates.map((u) => u.id), [78, 1]);
    putInFront(1);
    fake.updates = [];
    const skipped = await focusTab(79, { hurry: () => true });
    assert.equal(skipped.hurried, true);
    assert.deepEqual(fake.updates, [], 'not even restored');
  } finally {
    done();
  }
});

test('restoring: next/previous presses don\'t queue behind a restore: the next press goes on from it at once', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 80, url: 'https://n1.test/' }, { id: 81, url: 'https://n2.test/' }, { id: 82, url: 'https://n3.test/' }], { 80: { loadMs: 1500 }, 81: { loadMs: 1500 }, 82: { loadMs: 1500 } });
  try {
    await mutate(() => {
      let st = M.defaultState();
      for (const id of [1, 80, 81, 82]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
      return M.activateTab(st, 1, 1, Date.now());
    });
    const s = await load();
    const second = V.cycleTab(s, 1, V.cycleTab(s, 1, 1, 1), 1);
    const asked = Date.now();
    navigate('next-tab', 'key', 1);
    await sleep(100);
    await navigate('next-tab', 'key', 1);
    assert.equal(front(), second);
    const shownAt = fake.updates.findLast((u) => u.id === second).at - asked;
    assert.ok(shownAt < 2200, `the second press's tab restored and shown without waiting for the first's load (${shownAt}ms)`);
    assert.ok(fake.updates.findIndex((u) => u.id === second) < 4, 'its restore started at once');
  } finally {
    done();
  }
});

test('restoring: Safari leaving the tab in front: the switch is done (it loads there, noted, as before), and no more introductions or restores this session', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 83, url: 'https://unloaded.test/' }, { id: 84, url: 'https://unloaded2.test/' }], { 83: {}, 84: {} });
  try {
    await decided();
    const result = await withUpdate(async (update, id, change) => {
      if (id !== 1) return update(id, change);
      fake.updates.push({ id, change, at: Date.now() });
      return { ...fake.tabs.get(1), active: true }; // says it did, didn't
    }, () => focusTab(83));
    assert.equal(result.tab?.id, 83);
    assert.equal(front(), 83);
    assert.deepEqual(fake.updates.map((u) => u.id), [83, 1]);
    assert.equal(fake.local.showing?.tabId, 83, 'its page told which tab it is');
    assert.equal(fake.session.introductionsOff, true);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(84);
    assert.deepEqual(fake.updates.map((u) => u.id), [84], 'no restore once introductions are off');
  } finally {
    done();
  }
});

test('restoring: the page in front hidden for an instant just after the two updates (dated late, as a busy page does) turns them off, and the switch goes ahead at once; a blink later in the load isn\'t the restore\'s', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 85, url: 'https://late.test/' }, { id: 86, url: 'https://blink.test/' }], { 85: { loadMs: 400 }, 86: { loadMs: 2000 } });
  try {
    const first = focusTab(85);
    await sleep(250); // loading behind
    pageBlinked(1, { hiddenAt: Date.now(), shownAt: Date.now() + 20 });
    await first;
    assert.equal(fake.session.introductionsOff, undefined, 'a blink well into the load isn\'t the restore\'s');
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    let answered = 0;
    const second = withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      answered = Date.now();
      return answer;
    }, () => focusTab(86));
    await sleep(80);
    pageBlinked(1, { hiddenAt: answered + 30, shownAt: answered + 45 });
    const blinkedAt = Date.now();
    await second;
    assert.equal(fake.session.introductionsOff, true, 'dated 30 ms after the answers: the restore\'s');
    assert.ok(fake.updates.at(-1).at - blinkedAt < 300, 'shown at once, not after its load');
    assert.deepEqual(fake.updates.map((u) => u.id), [86, 1, 86]);
  } finally {
    done();
  }
});

test('restoring: a page that keeps loading and paints nothing is shown at the limit (1.5 s from its load\'s start), introduced as far as it got, covered', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 87, url: 'https://slow.test/' }], { 87: { loadMs: 8000 } });
  try {
    const asked = Date.now();
    const result = await focusTab(87, { deadline: asked + 7000 });
    assert.equal(result.tab?.id, 87);
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt >= 1450 && shownAt < 1900, `shown at the limit (${shownAt}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [87, 1, 87, 1, 87], 'introduced still loading (rather than shown empty)');
    assert.deepEqual(prepares(87).filter((x) => x.at > fake.updates[0].at).map((x) => x.args[0].covered), [true]);
  } finally {
    done();
  }
});

test('restoring: a shorter wait left by the page that asked bounds it; with too little left for it, the tab is shown as before', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 88, url: 'https://slow.test/' }, { id: 89, url: 'https://late.test/' }], { 88: { loadMs: 8000 }, 89: {} });
  try {
    let asked = Date.now();
    await focusTab(88, { deadline: asked + 4100 });
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt >= 1250 && shownAt < 1900, `shown at the page's deadline less the switch's own time (2.8 s: ${shownAt}ms)`);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    asked = Date.now();
    const result = await focusTab(89, { deadline: asked + 1800 });
    assert.equal(result.tab?.id, 89);
    assert.deepEqual(fake.updates.map((u) => u.id), [89], 'no time to restore it: shown as it is');
  } finally {
    done();
  }
});

test('restoring: not a page Margin can\'t run in; nor, with restores off, is an unloaded tab never shown introduced (it has no page)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 90, url: 'file:///Users/x/a.pdf' }, { id: 91, url: 'https://unloaded.test/' }], {});
  try {
    fake.scriptDelay = () => null;
    tabOpened({ id: 91, active: false });
    fake.session.restoresOff = true;
    resetRestores();
    for (const id of [90, 91]) {
      putInFront(1);
      fake.updates = [];
      await focusTab(id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id], `tab ${id}: just shown`);
    }
  } finally {
    delete fake.session.restoresOff;
    done();
  }
});

test('restoring: the check for a tab with no page doesn\'t hold up a switch to one whose process is slow to wake (its preparation starts meanwhile)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 92, url: 'https://asleep.test/' }], {});
  try {
    fake.scriptDelay = () => 50; // a slow process (one slower than 60 ms is drawn first: below)
    const asked = Date.now();
    await focusTab(92);
    assert.ok(prepares(92)[0].at - asked < 20, 'preparation started with the wake');
    // (Then one look more, its page free: 50 ms here.)
    assert.ok(fake.updates[0].at - asked < 150, `switched once both were done (${fake.updates[0].at - asked}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [92]);
  } finally {
    done();
  }
});

test('introducing: a tab arriving covered is out of sight under its cover before its introduction; one that doesn\'t arrive covered isn\'t', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 37, url: 'https://new.test/' }, { id: 38, url: 'https://new2.test/' }], [37, 38]);
  const arrivals = (id) => fake.scripts.filter((x) => x.tabId === id && x.func.name === 'coverArrivalInPage');
  try {
    await focusTab(37, { covered: true });
    assert.deepEqual(fake.updates.map((u) => u.id), [37, 1, 37]);
    assert.equal(arrivals(37).length, 1);
    assert.ok(arrivals(37)[0].at <= fake.updates[0].at, 'before its introduction');
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(38);
    assert.deepEqual(fake.updates.map((u) => u.id), [38, 1, 38]);
    assert.equal(arrivals(38).length, 0);
  } finally {
    done();
  }
});

test('restoring: a switch called off while asking whether its tab has a page (slow just after Safari starts) doesn\'t cover the page in front; a double-click restores it once', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 93, url: 'https://slowcheck.test/' }, { id: 94, url: 'https://slowcheck2.test/' }], { 93: { loadMs: 200 }, 94: { loadMs: 200 } });
  const contains = chrome.permissions.contains;
  chrome.permissions.contains = async () => { await sleep(250); return true; };
  try {
    const first = focusTab(93);
    await sleep(100);
    await focusTab(1); // Escape on the page (cancelSwitch: its own tab)
    assert.equal((await first).superseded, true);
    assert.deepEqual(toldFront(), [], 'not covered after it was called off');
    assert.deepEqual(fake.updates, [], 'nor restored');
    const one = focusTab(94);
    await sleep(100);
    const two = await focusTab(94);
    assert.equal((await one).superseded, true);
    assert.equal(two.tab?.id, 94);
    assert.deepEqual(fake.updates.map((u) => u.id), [94, 1, 94, 1, 94], 'restored, introduced, shown');
    assert.deepEqual(toldFront().map(([type]) => type), ['switching', 'switch-done'], 'covered once, by the switch that went ahead');
  } finally {
    chrome.permissions.contains = contains;
    done();
  }
});

test('restoring: a second click before Safari has answered the first\'s two updates waits for that answer, then for the load: not shown while it loads', async () => {
  for (const [id, gap] of [[140, 40], [141, 100]]) {
    const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://dbl${id}.test/` }], { [id]: { loadMs: 400, startMs: 70 } }, { answerMs: 110 });
    try {
      const asked = Date.now();
      const first = focusTab(id);
      await sleep(gap);
      const second = await focusTab(id);
      assert.equal(second.tab?.id, id);
      assert.equal((await first).superseded, true);
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id, 1, id], `${gap} ms apart: restored, introduced, shown`);
      assert.ok(fake.updates[2].at - asked >= 450, `introduced once loaded (${fake.updates[2].at - asked}ms)`);
      assert.notEqual(fake.local.showing?.tabId, id, 'not shown unloaded');
    } finally {
      done();
    }
  }
});

test('restoring: called off before its load is seen (Safari starts it a moment after the selection), the tab is still one never shown: introduced when shown later', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 96, url: 'https://late-start.test/' }, { id: 97, url: 'https://other.test/' }], { 96: { loadMs: 150, startMs: 70 } });
  try {
    const first = focusTab(96);
    await sleep(30);
    await focusTab(97);
    assert.equal((await first).superseded, true);
    await sleep(300); // loaded behind
    assert.equal(isNeverShown(96), true);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(96, { covered: isNeverShown(96) });
    assert.deepEqual(fake.updates.map((u) => u.id), [96, 1, 96], 'introduced, then shown');
  } finally {
    done();
  }
});

test('restoring: a page in front that can\'t be covered (a PDF, Safari\'s own pages, an earlier copy): the tab isn\'t loaded behind it (nothing would show meanwhile), it\'s shown as before', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 98, url: 'https://uncovered.test/' }], { 98: {} });
  try {
    fake.reply = undefined;
    await focusTab(98);
    assert.deepEqual(fake.updates.map((u) => u.id), [98]);
    assert.equal(fake.local.showing?.tabId, 98, 'noted, as a tab shown unloaded is');
  } finally {
    done();
  }
});

test('restoring: a key press, or the tab closed, while Safari puts its load off: given up at once, not counted as Safari\'s miss', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 99, url: 'https://off.test/' }, { id: 100, url: 'https://off2.test/' }], { 99: { behind: false }, 100: { behind: false } });
  try {
    let pressed = false;
    setTimeout(() => { pressed = true; }, 150);
    const asked = Date.now();
    const result = await focusTab(99, { hurry: () => pressed });
    assert.deepEqual([result.tab, result.hurried], [null, true]);
    assert.ok(Date.now() - asked < 350, `given up at once (${Date.now() - asked}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [99, 1]);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    const closed = focusTab(100);
    await sleep(100);
    fake.tabs.delete(100);
    await assert.rejects(closed, /No tab with id 100/);
    assert.equal(fake.session.restoreMisses, undefined);
  } finally {
    done();
  }
});

test('restoring: an unloaded tab in another window: that window comes forward at once, its page covered while the tab loads', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 200, url: 'https://w2.test/', windowId: 2, active: true }, { id: 201, url: 'https://w2b.test/', windowId: 2 }], { 201: { loadMs: 300 } });
  let focused = 1;
  const raised = [];
  chrome.windows = { get: async (id) => ({ id, focused: id === focused }), update: async (id) => { raised.push({ id, at: Date.now() }); focused = id; return { id }; } };
  try {
    await mutate((s) => M.activateTab(M.upsertTab(s, fake.tabs.get(200), Date.now()), 200, 2, Date.now()));
    const result = await focusTab(201);
    assert.equal(result.tab?.id, 201);
    assert.deepEqual(fake.updates.map((u) => u.id), [201, 200, 201, 200, 201]);
    assert.equal(raised[0]?.id, 2);
    assert.ok(raised[0].at <= fake.updates[0].at, 'raised before its load');
    assert.deepEqual(fake.messages.filter((m) => m.tabId === 200).map((m) => [m.message.type, m.message.tabId]), [['switching', 201], ['switch-done', 201]], 'the page the user now sees covered');
  } finally {
    delete chrome.windows;
    done();
  }
});

// Spaces of their own (tab ids per space, most recent first) for tests below.
const spaced = (spaces) => mutate((s0) => {
  let s = s0;
  for (const [spaceId, ids] of Object.entries(spaces)) {
    s = M.createSpace(s, { id: spaceId, name: spaceId, emoji: '•', color: '#000000' });
    ids.forEach((id, i) => {
      s = M.moveTab(M.upsertTab(s, fake.tabs.get(id), Date.now()), id, spaceId);
      s = { ...s, tabs: { ...s.tabs, [id]: { ...s.tabs[id], lastActive: 100 - i } } };
    });
  }
  return s;
});

test('restoring: a space\'s tab loading behind, the switch called off from the page (Escape on its cover): the window goes back to the space of the tab still in front', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 120, url: 'https://work.test/' }], { 120: { loadMs: 1500 } });
  try {
    await spaced({ esc: [120] });
    const before = V.activeSpaceId(await load(), 1);
    const shown = showSpace(1, 'esc');
    await sleep(200);
    assert.equal(V.activeSpaceId(await load(), 1), 'esc');
    await focusTab(1); // the page's Escape (cancelSwitch: its own tab)
    assert.equal((await shown)?.superseded, true);
    assert.equal(V.activeSpaceId(await load(), 1), before);
    assert.equal(front(), 1);
  } finally {
    done();
  }
});

test('restoring: a space\'s most recent tab closed while it loads behind: the next one comes up, and the page isn\'t told the switch failed', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 121, url: 'https://s1.test/' }, { id: 122, url: 'https://s2.test/' }], { 121: { loadMs: 1500 } });
  try {
    await spaced({ closing: [121, 122] });
    const shown = showSpace(1, 'closing');
    await sleep(100);
    fake.tabs.delete(121);
    const result = await shown;
    assert.equal(result?.tab?.id, 122);
    assert.equal(front(), 122);
    assert.deepEqual(toldFront().filter(([type]) => type === 'switch-failed'), []);
  } finally {
    done();
  }
});

test('restoring: next/previous space presses don\'t queue behind a restore: the next press goes on from that space at once', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 130, url: 'https://sp1.test/' }, { id: 131, url: 'https://sp2.test/' }], { 130: { loadMs: 1500 }, 131: { loadMs: 300 } });
  try {
    await spaced({ sp1: [130], sp2: [131] });
    const asked = Date.now();
    navigate('next-space', 'key', 1);
    await sleep(100);
    await navigate('next-space', 'key', 1);
    assert.equal(V.activeSpaceId(await load(), 1), 'sp2');
    assert.equal(front(), 131);
    assert.deepEqual(fake.updates.slice(0, 3).map((u) => u.id), [130, 1, 131], 'the first given up, the second restored at once');
    assert.ok(fake.updates[2].at - asked < 300, `(${fake.updates[2].at - asked}ms)`);
  } finally {
    done();
  }
});

test('openBehind: a page still loading at the limit is shown then, not waited for again', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const create = chrome.tabs.create;
  chrome.tabs.create = async (options) => {
    const tab = await create(options);
    tabOpened(tab); // background.js onCreated
    return tab;
  };
  try {
    const started = Date.now();
    assert.deepEqual(await openBehind({ url: 'https://heavy.test/', from: { id: 1, windowId: 1 }, maxMs: 400, deadline: started + 12000 }), { tabId: 2, shown: 2 });
    const shownAt = fake.updates.at(-1).at - started;
    assert.ok(shownAt < 700, `shown at the limit (${shownAt}ms)`);
    assert.equal(told('switching').length, 1, 'covered once');
  } finally {
    chrome.tabs.create = create;
    tabShown(2);
  }
});

test('restoring: a held key passes over tabs Safari unloaded (nothing shown for them); the tab it stops on is loaded behind the page, then shown', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 150, url: 'https://h1.test/' }, { id: 151, url: 'https://h2.test/' }, { id: 152, url: 'https://h3.test/' }], { 150: {}, 151: {}, 152: {} });
  try {
    await mutate(() => {
      let st = M.defaultState();
      for (const id of [1, 150, 151, 152]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
      return M.activateTab(st, 1, 1, Date.now());
    });
    const s = await load();
    const step = (from) => V.cycleTab(s, 1, from, 1);
    const last = step(step(step(1)));
    navigate('next-tab', 'key', 1); // a held key: the presses queue
    navigate('next-tab', 'key', 1);
    await navigate('next-tab', 'key', 1);
    assert.equal(front(), last);
    assert.deepEqual(fake.updates.map((u) => u.id), [last, 1, last, 1, last], 'only the last one restored, introduced, shown');
    assert.deepEqual(toldFront().map(([type, id]) => [type, id]).filter(([type]) => type === 'switch-failed'), [], 'none told as failed');
  } finally {
    done();
  }
});

// Pages cut off from Margin (background/cut-off.js): Safari reloaded Margin
// and kept its world in them, bound to the copy that's gone.
test('restoring: a page that paints at once but loads late (a slow image) is introduced and shown once it has painted, not once loaded', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 165, url: 'https://late.test/' }], { 165: { loadMs: 3000 } });
  try {
    const asked = Date.now();
    setTimeout(() => fake.painted.add(165), 200);
    const result = await focusTab(165, { carry: 'hover' });
    assert.equal(result.tab?.id, 165);
    assert.deepEqual(fake.updates.map((u) => u.id), [165, 1, 165, 1, 165], 'restored, introduced, shown');
    assert.ok(fake.updates[2].at - asked >= 195, 'introduced once painted');
    const shownAt = fake.updates[4].at - asked;
    assert.ok(shownAt < 500, `shown ${shownAt}ms after the click, at its first paint (it loads at 3 s)`);
    assert.equal(fake.tabs.get(165).status, 'loading', 'still loading as it was shown');
    assert.deepEqual(prepares(165).filter((x) => x.at > fake.updates[0].at).map((x) => x.args[0].covered), [true], 'prepared to arrive covered');
  } finally {
    done();
  }
});

test('restoring: whether it has painted is asked again until the question reaches the page\'s own document (before its load commits: an error in place of a result)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 166, url: 'https://commit.test/' }], { 166: { loadMs: 3000 } });
  try {
    const asked = Date.now();
    const scriptError = fake.scriptError;
    fake.scriptError = (id) => (id === 166 && Date.now() - asked < 250) || scriptError(id);
    fake.painted.add(166);
    await focusTab(166);
    assert.deepEqual(fake.updates.map((u) => u.id), [166, 1, 166, 1, 166]);
    assert.ok(scriptsNamed(166, 'readyInPage').length >= 3, 'asked again until it ran there');
    assert.ok(fake.updates[2].at - asked >= 245 && fake.updates[4].at - asked < 700, `introduced once it answered (${fake.updates[2].at - asked}ms), shown soon after`);
  } finally {
    done();
  }
});

test('restoring: once painted, its wake is renewed and its arrival cover asked for together (not one after the other on a busy page), both before its introduction', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 167, url: 'https://busy.test/' }], { 167: { loadMs: 3000 } });
  try {
    fake.painted.add(167);
    // Busy once its load has started: a wake takes 200 ms to answer.
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 167 && func?.name === 'pageThere' ? 200 : 1);
    await focusTab(167);
    assert.deepEqual(fake.updates.map((u) => u.id), [167, 1, 167, 1, 167]);
    // (After its first wake's, which found no page; in the same millisecond as Safari's answer, it can be.)
    const renew = scriptsNamed(167, 'pageThere').slice(1).find((x) => x.at >= fake.updates[1].at);
    const [arrival] = scriptsNamed(167, 'coverArrivalInPage');
    assert.ok(renew && arrival, 'a fresh wake and the arrival cover');
    assert.ok(Math.abs(arrival.at - renew.at) < 100, `sent together (${arrival.at - renew.at}ms apart; one after the other: 200)`);
    assert.ok(arrival.at < fake.updates[2].at, 'the cover asked for before the introduction');
  } finally {
    done();
  }
});

test('restoring: a page just loaded behind gets 300 ms for its preparation; one slower is shown unprepared, its preparation called off', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 168, url: 'https://slowprep.test/' }], { 168: { loadMs: 3000 } });
  try {
    fake.painted.add(168);
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 168 && func?.name === 'prepareSidebarInPage' ? 800 : 1);
    const result = await focusTab(168);
    assert.equal(result.tab?.id, 168);
    assert.equal(result.preparation.outcome, 'timeout');
    const waited = fake.updates[4].at - fake.updates[3].at;
    assert.ok(waited >= 280 && waited < 500, `shown ${waited}ms after its introduction`);
    assert.ok(scriptsNamed(168, 'cancelSidebarInPage').some((x) => x.at <= fake.updates[4].at), 'its preparation called off before the show');
  } finally {
    done();
  }
});

// Its document not there yet (a server slow to answer): every script there
// fails until `commitMs` after `asked` (it has a view, no page of its own).
const commitsAt = (id, asked, commitMs) => {
  const scriptError = fake.scriptError;
  fake.scriptError = (tabId) => (tabId === id && Date.now() - asked < commitMs) || scriptError(tabId);
};

test('restoring: a tab whose own document hasn\'t answered by the 2.5 s limit (a server slow to answer) stays behind the covered page until it does, then is introduced and shown; the switch log says when it committed', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 180, url: 'https://slowserver.test/' }], { 180: { loadMs: 8000 } });
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    const asked = Date.now();
    commitsAt(180, asked, 3000);
    fake.painted.add(180); // painted as soon as it's there
    const result = await focusTab(180);
    assert.equal(result.tab?.id, 180);
    assert.deepEqual(fake.updates.map((u) => u.id), [180, 1, 180, 1, 180], 'restored, introduced once there, shown');
    assert.ok(fake.updates[2].at - asked >= 2950, `not shown with no document at 2.5 s (introduced at ${fake.updates[2].at - asked}ms)`);
    assert.ok(fake.updates[4].at - asked < 3500, `shown soon after it answered (${fake.updates[4].at - asked}ms)`);
    assert.deepEqual(toldFront(), [['switching', 180, 'now'], ['switch-done', 180, null]], 'the page in front covered all along');
    const logged = entries.find((e) => e.kind === 'switch' && e.tabId === 180);
    assert.equal(logged?.restored, 'painted');
    assert.ok(logged.committed >= 2950 && logged.committed < 3400, `committed at ${logged.committed}ms`);
  } finally {
    tapLog(null);
    done();
  }
});

test('restoring: a tab whose document never answers is shown at the hard limit (4 s, or what the page that asked waits less the switch\'s own time), not before', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 182, url: 'https://deadserver.test/' }], { 182: { loadMs: 20000 } });
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    const asked = Date.now();
    commitsAt(182, asked, 60000);
    const result = await focusTab(182, { deadline: asked + 5200 });
    assert.equal(result.tab?.id, 182);
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt >= 2350 && shownAt < 3000, `shown at the page's deadline less the switch's own time (2.8 s: ${shownAt}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [182, 1, 182], 'nothing to introduce: shown as it is');
    const logged = entries.find((e) => e.kind === 'switch' && e.tabId === 182);
    assert.deepEqual([logged?.restored, logged?.committed], ['loading', null]);
  } finally {
    tapLog(null);
    done();
  }
});

test('restoring: past the 2.5 s limit with no document yet, Escape or another click (a newer switch) and a key press still end the wait at once', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 183, url: 'https://slow1.test/' }, { id: 184, url: 'https://slow2.test/' }], { 183: { loadMs: 20000 }, 184: { loadMs: 20000 } });
  try {
    let asked = Date.now();
    commitsAt(183, asked, 60000);
    const first = focusTab(183);
    const firstEnded = first.then(() => Date.now());
    await sleep(3000);
    const escaped = Date.now();
    await focusTab(1); // Escape on the page (cancelSwitch: its own tab)
    assert.equal((await first).superseded, true, 'not shown at 2.5 s');
    assert.ok(await firstEnded - escaped < 150, `ended at once (${await firstEnded - escaped}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [183, 1]);
    assert.equal(front(), 1);
    fake.updates = [];
    asked = Date.now();
    commitsAt(184, asked, 60000);
    let pressed = false;
    setTimeout(() => { pressed = true; }, 2800);
    const hurried = await focusTab(184, { hurry: () => pressed });
    assert.deepEqual([hurried.tab, hurried.hurried], [null, true]);
    assert.ok(Date.now() - asked < 3000, `given up at the press (${Date.now() - asked}ms)`);
  } finally {
    done();
  }
});

test('restoring: its wake renewed and its arrival cover asked for as soon as its own document answers, while its paint is still waited for: on its paint it\'s introduced at once', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 181, url: 'https://overlap.test/' }], { 181: { loadMs: 3000 } });
  try {
    const asked = Date.now();
    let paintedAt = 0;
    setTimeout(() => { fake.painted.add(181); paintedAt = Date.now(); }, 700);
    await focusTab(181);
    assert.deepEqual(fake.updates.map((u) => u.id), [181, 1, 181, 1, 181]);
    const arrivals = scriptsNamed(181, 'coverArrivalInPage');
    assert.equal(arrivals.length, 1, 'asked for once');
    assert.ok(arrivals[0].at - asked < 400, `asked for as its document answered (${arrivals[0].at - asked}ms), not after its paint`);
    const renew = scriptsNamed(181, 'pageThere').filter((x) => x.at > fake.updates[1].at).at(0);
    assert.ok(renew && Math.abs(renew.at - arrivals[0].at) < 50, 'its wake renewed with it');
    assert.ok(fake.updates[2].at - paintedAt < 80, `introduced once painted (${fake.updates[2].at - paintedAt}ms after)`);
  } finally {
    done();
  }
});

test('restoring: its wake answering after its page has drawn doesn\'t call for a second paint barrier (the wake changes nothing in the page)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 185, url: 'https://slowwake.test/' }], { 185: { loadMs: 3000 } });
  try {
    fake.painted.add(185);
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 185 && func?.name === 'pageThere' ? 150 : 1);
    await focusTab(185);
    assert.deepEqual(fake.updates.map((u) => u.id), [185, 1, 185, 1, 185]);
    const after = barriers(185).filter((x) => x.at >= fake.updates[3].at);
    assert.equal(after.length, 1, 'one barrier, beside the preparation and the wake');
    assert.ok(fake.updates[4].at - fake.updates[3].at < 220, `shown once the wake answered (${fake.updates[4].at - fake.updates[3].at}ms after the introduction)`);
  } finally {
    done();
  }
});

test('restoring: a tab that didn\'t answer when the open tabs were checked (not loaded yet after a relaunch), restored behind: its page is this copy\'s, and isn\'t given a second paint barrier for the cut-off check', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 186, url: 'https://suspect.test/' }], { 186: { loadMs: 3000 } });
  try {
    assert.equal(await repairCutOff(fake.tabs.get(186)), false); // no page to ask: a suspect
    fake.painted.add(186);
    await focusTab(186);
    assert.deepEqual(fake.updates.map((u) => u.id), [186, 1, 186, 1, 186]);
    assert.equal(barriers(186).filter((x) => x.at >= fake.updates[3].at).length, 1);
  } finally {
    done();
  }
});

test('restoring: its renewed wake running out of time after its page drew (the page busy with a task of its own) calls for a fresh paint barrier just before the show', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 191, url: 'https://wakelate.test/' }], { 191: { loadMs: 3000 } });
  try {
    fake.painted.add(191);
    // Its page busy from its introduction on: its wake's script gets there only after WAKE_MAX_MS.
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 191 && func?.name === 'pageThere' && fake.updates.length >= 4 ? 700 : 1);
    await focusTab(191);
    assert.deepEqual(fake.updates.map((u) => u.id), [191, 1, 191, 1, 191]);
    const after = barriers(191).filter((x) => x.at >= fake.updates[3].at);
    assert.equal(after.length, 2, 'one beside the preparation and the wake, one after the wake ran out of time');
    assert.ok(fake.updates[4].at - after[1].at < 150, `shown once its page drew again (${fake.updates[4].at - after[1].at}ms after the second barrier was asked)`);
  } finally {
    done();
  }
});

test('restoring: a document that arrives past the 2.5 s limit is given time to paint (1 s from its arrival, within the hard limit), not shown at once with nothing drawn', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 190, url: 'https://latecommit.test/' }], { 190: { loadMs: 8000 } });
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    const asked = Date.now();
    commitsAt(190, asked, 3000);
    let paintedAt = Infinity;
    setTimeout(() => { fake.painted.add(190); paintedAt = Date.now() - asked; }, 3500);
    const result = await focusTab(190);
    assert.equal(result.tab?.id, 190);
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt > paintedAt, `shown once painted (${shownAt}ms, painted at ${paintedAt}ms)`);
    assert.ok(shownAt < 3900, `soon after (${shownAt}ms)`);
    const logged = entries.find((e) => e.kind === 'switch' && e.tabId === 190);
    assert.equal(logged?.restored, 'painted');
    assert.ok(logged.committed >= 2950 && logged.committed < 3400, `committed at ${logged.committed}ms`);
  } finally {
    tapLog(null);
    done();
  }
});

test('restoring: a page with its document, too busy to answer a question in time, isn\'t taken for one with no document: its late answer that it has painted ends the wait; one that paints nothing is shown at the usual limit, not the hard one', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 193, url: 'https://busy.test/' }, { id: 194, url: 'https://busyblank.test/' }], { 193: { loadMs: 8000, busyMs: 700 }, 194: { loadMs: 8000, busyMs: 600 } });
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    let asked = Date.now();
    fake.painted.add(193);
    assert.equal((await focusTab(193)).tab?.id, 193);
    assert.deepEqual(fake.updates.map((u) => u.id), [193, 1, 193, 1, 193]);
    assert.ok(fake.updates[2].at - asked < 1800, `introduced once its late answer said it had painted (${fake.updates[2].at - asked}ms)`);
    let logged = entries.find((e) => e.kind === 'switch' && e.tabId === 193);
    assert.equal(logged?.restored, 'painted');
    assert.ok(logged.committed != null && logged.committed < 1300, `its document there (${logged.committed}ms)`);
    fake.updates = [];
    putInFront(1);
    asked = Date.now();
    assert.equal((await focusTab(194)).tab?.id, 194);
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt < 3500, `shown at the usual limit, not 5 s (${shownAt}ms)`);
    logged = entries.find((e) => e.kind === 'switch' && e.tabId === 194);
    assert.equal(logged?.restored, 'loading');
    assert.ok(logged.committed != null, 'its document there');
  } finally {
    tapLog(null);
    done();
  }
});

test('restoring: a preparation past its time is called off before the show with its page\'s arrival cover kept (the show lifts it)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 195, url: 'https://slowprep2.test/' }], { 195: { loadMs: 3000 } });
  try {
    fake.painted.add(195);
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 195 && func?.name === 'prepareSidebarInPage' ? 450 : 1);
    const result = await focusTab(195);
    assert.equal(result.preparation.outcome, 'timeout');
    const cancels = scriptsNamed(195, 'cancelSidebarInPage').filter((x) => x.at <= fake.updates.at(-1).at);
    assert.equal(cancels.length, 1);
    assert.deepEqual(cancels[0].args, [result.preparation.token, true], 'its arrival cover kept');
  } finally {
    done();
  }
});

test('restoring: the last thing before the show is the page drawing (a barrier after a preparation slower than the first)', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 169, url: 'https://draw.test/' }], { 169: { loadMs: 3000 } });
  try {
    fake.painted.add(169);
    fake.barrierMs = () => 20;
    fake.scriptDelay = (id, func) => (noPage.has(id) ? null : id === 169 && func?.name === 'prepareSidebarInPage' ? 150 : 1);
    await focusTab(169);
    const [prepared] = prepares(169).filter((x) => x.at > fake.updates[1].at);
    const last = barriers(169).at(-1);
    // A few ms of slack: timers can fire a millisecond early by Date.now().
    assert.ok(last.at >= prepared.at + 145, 'a barrier once the preparation answered');
    assert.ok(fake.updates.at(-1).at >= last.at + 18, 'the show once it answered');
  } finally {
    done();
  }
});

test('cut off: a page not in use is loaded again (a GET of its address; with a #fragment, the browser\'s reload)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 40, url: 'https://cut.test/x' }, { id: 41, url: 'https://cut.test/y#part' }]);
  fake.scriptDelay = () => 1;
  fake.cutOff = () => ({ cutOff: true, busy: false, hidden: true });
  assert.equal(await repairCutOff(fake.tabs.get(40)), 'reloaded');
  assert.equal(await repairCutOff(fake.tabs.get(41)), 'reloaded');
  assert.deepEqual(fake.updates.map((u) => [u.id, u.change]), [[40, { url: 'https://cut.test/x' }], [41, { reload: true }]]);
  assert.ok(fake.scripts.every((x) => x.func.name !== 'cutOffInPage' || x.args[1] === false), 'only asked, nothing hidden');
  // Still cut off at once after (a load that didn't happen): not loaded again within the cooldown.
  assert.equal(await repairCutOff(fake.tabs.get(40)), 'quiet');
  assert.equal(fake.updates.length, 2);
});

// (Changed 2026-11-04: a switch to it no longer loads it again first, the load
// committing in front: it's shown as it is, its dead Margin out of sight, and
// loaded again once it's left.)
test('cut off: a page in use keeps its page, its dead Margin out of sight; a switch to it later shows it so, not loaded again as it\'s shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 42, url: 'https://draft.test/' }]);
  fake.scriptDelay = () => 1;
  let busy = true;
  fake.cutOff = () => ({ cutOff: true, busy, hidden: true });
  assert.equal(await repairCutOff(fake.tabs.get(42)), 'quiet');
  assert.deepEqual(fake.scripts.filter((x) => x.func.name === 'cutOffInPage').map((x) => x.args[1]), [false, true], 'asked, then put out of sight');
  assert.equal(fake.updates.length, 0, 'not loaded again');
  busy = false; // the draft sent meanwhile
  await focusTab(42);
  assert.deepEqual(fake.updates.map((u) => u.change), [{ active: true }], 'shown, not loaded again as it is');
  const quiet = fake.scripts.filter((x) => x.func.name === 'cutOffInPage' && x.tabId === 42).at(-1);
  assert.ok(quiet.args[1] === true && quiet.at <= fake.updates[0].at, 'put out of sight before its show');
  // (Loaded again once it's left: tests/in-window.test.js, tests/cut-off.test.js.)
});

test('cut off: a page bound to this copy isn\'t, and isn\'t asked again; a switch to a tab not suspected doesn\'t ask', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 43, url: 'https://fine.test/' }, { id: 44, url: 'https://other.test/' }]);
  fake.scriptDelay = () => 1;
  assert.equal(await repairCutOff(fake.tabs.get(43)), false);
  assert.equal(await repairCutOff(fake.tabs.get(43)), false);
  assert.equal(fake.scripts.filter((x) => x.func.name === 'cutOffInPage').length, 1);
  await focusTab(44);
  assert.equal(fake.scripts.filter((x) => x.func.name === 'cutOffInPage').length, 1);
  assert.equal(await repairCutOff({ id: 45, url: 'safari-web-extension://test/newtab/newtab.html' }), false, 'not a web page: not asked');
});

// ---- after the branch's review --------------------------------------------------

test('restoring: a question about its paint that its document never answers (the document went away: a script redirect still loading) doesn\'t take the whole wait; the next document is asked', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 300, url: 'https://redirect.test/', status: 'loading' }], {});
  const exec = chrome.scripting.executeScript;
  let loads;
  try {
    tabOpened({ id: 300, active: false });
    let first = true;
    chrome.scripting.executeScript = (opts) => {
      if (opts.target.tabId === 300 && opts.func?.name === 'readyInPage' && first) {
        first = false;
        fake.scripts.push({ tabId: 300, at: Date.now(), func: opts.func, args: opts.args });
        return new Promise(() => {}); // its world went with the page
      }
      return exec(opts);
    };
    setTimeout(() => fake.painted.add(300), 150);
    loads = setTimeout(() => { fake.tabs.get(300).status = 'complete'; }, 1400);
    const asked = Date.now();
    await focusTab(300);
    const introducedAt = fake.updates[0].at - asked;
    assert.ok(scriptsNamed(300, 'readyInPage').length >= 2, 'asked again');
    assert.ok(introducedAt < 700, `introduced at ${introducedAt}ms: painted at 150 ms, loaded at 1.4 s`);
    assert.equal(fake.tabs.get(300).status, 'loading', 'shown before its load');
  } finally {
    clearTimeout(loads);
    chrome.scripting.executeScript = exec;
    tabShown(300);
    done();
  }
});

test('restoring: a page whose document hasn\'t committed by 1.5 s from its load\'s start (a slow server) is waited for, then given 1 s from its commit to paint (past the 2.5 s from the click), then introduced and shown, not shown with no page', async () => {
  const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id: 301, url: 'https://slowserver.test/' }], { 301: { loadMs: 6000 } });
  try {
    delete fake.local.showing;
    const asked = Date.now();
    const scriptError = fake.scriptError;
    let committedAt = Infinity;
    fake.scriptError = (id) => (id === 301 && Date.now() - asked < 1900) || scriptError(id);
    setTimeout(() => { committedAt = Date.now() - asked; }, 1900);
    const result = await focusTab(301, { deadline: asked + 7000 });
    assert.equal(result.tab?.id, 301);
    const shownAt = fake.updates.at(-1).at - asked;
    assert.ok(shownAt > committedAt + 950, `shown at ${shownAt}ms, its page committed at ${committedAt}ms`);
    assert.ok(shownAt < committedAt + 1500, `nothing painted 1 s after its commit: shown as far as it got (${shownAt}ms)`);
    assert.deepEqual(fake.updates.map((u) => u.id), [301, 1, 301, 1, 301], 'restored, introduced, shown');
    assert.equal(fake.local.showing?.tabId ?? null, null, 'not shown as a tab with no page');
  } finally {
    done();
  }
});

test('openBehind: a new tab whose server is slow to answer (no document for 3 s) is asked whether it has painted less and less often meanwhile', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  fake.scriptDelay = () => 1;
  const started = Date.now();
  fake.scriptError = () => Date.now() - started < 3000;
  setTimeout(() => fake.painted.add(2), 3000);
  assert.deepEqual(await openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } }), { tabId: 2, shown: 2 });
  const took = Date.now() - started;
  const asked = scriptsNamed(2, 'readyInPage').filter((x) => x.at - started < 3000).length;
  assert.ok(asked <= 30, `${asked} questions before its document came (58 at one every 50 ms)`);
  assert.ok(took >= 3000 && took < 3400, `shown soon after it painted (${took}ms)`);
});

test('introducing: a tab whose page started in front with no process (a launch) that then went to another page in front is still introduced on its first return (WebKit\'s mark is the tab\'s, not the page\'s)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 302, url: 'https://launch.test/next' }, { id: 303, url: 'https://seen.test/next' }], []);
  try {
    // Its first page said so as it started (hello); the page there now (a link
    // followed in front) doesn't know.
    pageStarted(302, { unseen: true });
    pageStarted(303, { unseen: false });
    await focusTab(302, { covered: true });
    assert.deepEqual(fake.updates.map((u) => u.id), [302, 1, 302], 'introduced, then shown');
    // Shown (its activation): not again.
    tabShown(302);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(302);
    assert.deepEqual(fake.updates.map((u) => u.id), [302]);
    putInFront(1);
    await knownInFront(1);
    fake.updates = [];
    await focusTab(303);
    assert.deepEqual(fake.updates.map((u) => u.id), [303], 'a tab whose pages never said so: not introduced');
  } finally {
    tabShown(302);
    done();
  }
});

test('keys: the tabs a held key only passes through are marked for keep-ready (not held for them once left, counted by their use before); not the tab the key stops on or started from', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 190, url: 'https://k1.test/' }, { id: 191, url: 'https://k2.test/' }, { id: 192, url: 'https://k3.test/' }]);
  fake.scriptDelay = () => 1;
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 190, 191, 192]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  const s = await load();
  const step = (from) => V.cycleTab(s, 1, from, 1);
  const first = step(1), second = step(first), last = step(second);
  navigate('next-tab', 'key', 1); // a held key: the presses queue
  navigate('next-tab', 'key', 1);
  await navigate('next-tab', 'key', 1);
  assert.equal(front(), last);
  assert.deepEqual(keepReadyState().passed, [first, second]);
});

test('keys: the tab after the one a press lands on is woken ahead only once the one woken ahead before answered in time; a run of presses 1.5 s on wakes ahead again', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 250, url: 'https://w1.test/' }, { id: 251, url: 'https://w2.test/' }, { id: 252, url: 'https://w3.test/' }, { id: 253, url: 'https://w4.test/' }]);
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 250, 251, 252, 253]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  const s = await load();
  const step = (from) => V.cycleTab(s, 1, from, 1);
  const a = step(1), b = step(a), c = step(b), d = step(c);
  // b's page answers late (a process Safari resumes at background priority;
  // the press that lands on it waits for that answer).
  fake.scriptDelay = (id, func) => (id === b && func.name === 'pageThere' ? 600 : 1);
  await navigate('next-tab', 'key', 1);
  await sleep(10); // (the wake ahead isn't waited for)
  assert.equal(front(), a);
  assert.equal(scriptsNamed(b, 'pageThere').length, 1, 'b woken ahead');
  await navigate('next-tab', 'key', 1);
  await sleep(10);
  assert.equal(front(), b);
  assert.equal(fake.scripts.filter((x) => x.tabId === c).length, 0, 'b didn\'t answer in time: c not woken ahead');
  await sleep(1500);
  await navigate('next-tab', 'key', 1);
  await sleep(10);
  assert.equal(front(), c);
  assert.equal(scriptsNamed(d, 'pageThere').length, 1, 'another run: d woken ahead');
  for (const id of [250, 251, 252, 253]) tabShown(id);
});

test('keys: a wake ahead that answers in time but after the next press has landed still lets the tab after be woken ahead, as it answers', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 260, url: 'https://x1.test/' }, { id: 261, url: 'https://x2.test/' }, { id: 262, url: 'https://x3.test/' }]);
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 260, 261, 262]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  await sleep(1600); // (a run of presses before, in another test: past it)
  const s = await load();
  const step = (from) => V.cycleTab(s, 1, from, 1);
  const a = step(1), b = step(a), c = step(b);
  // b's page answered a wake before (so the press that lands on it doesn't
  // wait for its next one), and answers the one ahead in 250 ms (a busy page,
  // in time), after that press is done.
  fake.scriptDelay = () => 1;
  await wakeTab(b);
  forgetWake(b);
  let first = true;
  fake.scriptDelay = (id, func) => {
    if (id !== b || func.name !== 'pageThere') return 1;
    if (!first) return 1;
    first = false;
    return 250;
  };
  await navigate('next-tab', 'key', 1);
  await sleep(10);
  assert.equal(front(), a);
  await navigate('next-tab', 'key', 1);
  assert.equal(front(), b);
  assert.equal(fake.scripts.filter((x) => x.tabId === c).length, 0, 'b\'s wake ahead not answered yet: c not yet');
  await sleep(300);
  assert.equal(scriptsNamed(c, 'pageThere').length, 1, 'b answered in time: c woken ahead then');
  for (const id of [260, 261, 262]) tabShown(id);
});

// ---- a tab whose process Safari suspended (tabs.js focusTabNow, mayWait) ---------

// The switch log's entry for the last switch to `tabId`, from a run of `run`.
async function logged(tabId, run) {
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    const result = await run();
    return { result, entry: entries.filter((e) => e.kind === 'switch' && e.tabId === tabId).at(-1) };
  } finally {
    tapLog(null);
  }
}
const cancelsOf = (id, token) => scriptsNamed(id, 'cancelSidebarInPage').filter((x) => x.args[0] === token);

// The early preparation's token (the switch's own, sent beside its wake).
const earlyToken = (id) => prepares(id)[0]?.args[0].token;
// Introductions off for the Safari session, and with them the kick: a switch
// waits for its tab's wake alone (introducing's `done` turns them on again).
function noKicks() {
  fake.session.introductionsOff = true;
  resetIntroductions();
}

test('wait: a tab Safari suspended (its wake answered only once its process is resumed, at background priority), with introductions off (no kick), stays behind the page in front until then, then is prepared and drawn before it\'s shown; nothing else comes to the front', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 200, url: 'https://slept.test/' }], []);
  try {
    noKicks();
    const events = [];
    fake.activated = (info) => events.push(info.tabId);
    noteLeft(200, Date.now() - 10_000);
    suspend(200, { backgroundMs: 600 });
    const asked = Date.now();
    const { result, entry } = await logged(200, () => focusTab(200));
    assert.equal(result.tab?.id, 200);
    assert.deepEqual(fake.updates.map((u) => u.id), [200], 'shown once, nothing brought to the front before');
    assert.deepEqual(events, [200]);
    const shownAfter = fake.updates[0].at - asked;
    assert.ok(shownAfter >= 590 && shownAfter < 900, `shown ${shownAfter} ms after the ask (its resume: 600 ms)`);
    assert.equal(keepAwakes(200).length, 1, 'one wake');
    assert.equal(prepares(200).length, 1, 'one preparation, beside the wake');
    assert.equal(result.preparation.outcome, 'ready');
    const [drawn, ...more] = barriers(200);
    assert.ok(drawn && !more.length && drawn.at - asked >= 590, 'drawn once, after its resume');
    assert.ok(fake.updates[0].at - drawn.at >= 55, 'shown once it has drawn');
    assert.equal(entry.wakeOutcome, 'resumed');
    assert.equal(entry.wakeStartedBy, 'switch');
    assert.ok(entry.wakeMs >= 590, `its wake's answer: ${entry.wakeMs} ms`);
    assert.ok(entry.waitedOnOldPage >= 590 && entry.waitedOnOldPage < 700, `waited ${entry.waitedOnOldPage} ms on the page before`);
    assert.equal(entry.kicked, undefined);
  } finally {
    tabShown(200);
    done();
  }
});

test('wait: no answer by 1.6 s (introductions off: no kick): shown then as it is (its show resumes it), its preparation called off, no paint barrier (it would wait behind the resume)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 201, url: 'https://deep.test/' }], []);
  try {
    noKicks();
    noteLeft(201, Date.now() - 60_000);
    suspend(201, { backgroundMs: 4000 });
    const asked = Date.now();
    const { result, entry } = await logged(201, () => focusTab(201));
    assert.equal(result.tab?.id, 201);
    assert.deepEqual(fake.updates.map((u) => u.id), [201]);
    const shownAfter = fake.updates[0].at - asked;
    assert.ok(shownAfter >= 1590 && shownAfter < 1750, `shown ${shownAfter} ms after the ask`);
    assert.ok(cancelsOf(201, earlyToken(201)).some((x) => x.at <= fake.updates[0].at), 'its preparation called off before the show');
    assert.equal(barriers(201).length, 0);
    assert.equal(result.preparation.outcome, 'timeout');
    assert.equal(entry.wakeOutcome, 'capped');
    assert.equal(entry.wakeMs, null);
  } finally {
    tabShown(201);
    done();
  }
});

test('wait: with too little time left before the page stops waiting, the tab is shown at once', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 208, url: 'https://late.test/' }], []);
  try {
    noteLeft(208, Date.now() - 10_000);
    suspend(208);
    const asked = Date.now();
    const { result, entry } = await logged(208, () => focusTab(208, { deadline: Date.now() + 1700 }));
    assert.equal(result.tab?.id, 208);
    assert.deepEqual(fake.updates.map((u) => u.id), [208]);
    assert.ok(fake.updates[0].at - asked < 60, `shown ${fake.updates[0].at - asked} ms after the ask`);
    assert.equal(entry.wakeOutcome, 'capped');
  } finally {
    tabShown(208);
    done();
  }
});

test('wait: a switch whose page doesn\'t cover itself (a space\'s icon, a key to a space, a tab closed) covers the page in front once it has waited 150 ms (introductions off: no kick), and tells it how it went; not one answered sooner, nor a row clicked in the page (it covers itself)', async () => {
  // [source, backgroundMs (null: running), told the page in front]
  for (const [source, backgroundMs, told, id] of [['space', 600, true, 202], ['space', null, false, 203], ['activateTab', 600, false, 204]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://cover${id}.test/` }], []);
    try {
      noKicks(); // (its foreground resume would answer sooner)
      noteLeft(id, Date.now() - 10_000);
      if (backgroundMs) suspend(id, { backgroundMs });
      let coveredAt = null;
      const send = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = (tabId, message) => { if (message.type === 'switching') coveredAt ??= Date.now(); return send(tabId, message); };
      const asked = Date.now();
      try {
        await focusTab(id, { source });
      } finally {
        chrome.tabs.sendMessage = send;
      }
      assert.deepEqual(toldFront(), told ? [['switching', id, 'now'], ['switch-done', id, null]] : [], `${source}, ${backgroundMs}`);
      if (told) assert.ok(coveredAt - asked >= 145 && coveredAt - asked < 250, `covered ${coveredAt - asked} ms after the ask`);
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('wait: another switch, or a key press after it, ends the wait at once (introductions off: no kick; after a kick: below); the tab stays behind, its preparation called off', async () => {
  for (const [how, id] of [['another switch', 205], ['a key press', 206]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://left${id}.test/` }], []);
    try {
      noKicks();
      noteLeft(id, Date.now() - 10_000);
      suspend(id, { backgroundMs: 1200 });
      let pressed = false;
      const asked = Date.now();
      const pending = logged(id, () => focusTab(id, { source: 'next-tab', hurry: () => pressed }));
      await sleep(100);
      if (how === 'a key press') pressed = true;
      else userSwitched(999);
      const { result, entry } = await pending;
      const ended = Date.now() - asked;
      assert.equal(result.superseded, true, how);
      assert.equal(!!result.hurried, how === 'a key press');
      assert.ok(ended < 220, `${how}: ended ${ended} ms after the ask`);
      assert.deepEqual(fake.updates, []);
      assert.ok(cancelsOf(id, earlyToken(id)).length >= 1, 'its preparation called off');
      assert.equal(entry.wakeOutcome, how === 'a key press' ? 'hurried' : 'left');
      await sleep(1200); // (its resume, and the late answers)
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('wait: a tab whose earlier wake (a pointer resting on its row) was answered only after a background resume is drawn before it\'s shown, not brought to the front first; one whose wake answered in time isn\'t drawn first', async () => {
  // [backgroundMs (null: running), click after the hover wake, tab]
  for (const [backgroundMs, clickAfter, id] of [[300, 450, 272], [600, 700, 273], [null, 150, 274]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://hovered${id}.test/` }], []);
    try {
      noteLeft(id, Date.now() - 20_000);
      if (backgroundMs) suspend(id, { backgroundMs });
      const hovered = Date.now();
      const hover = wakeTab(id, { hover: true, by: 'hover' });
      await sleep(clickAfter - (Date.now() - hovered));
      const asked = Date.now();
      const { result, entry } = await logged(id, () => focusTab(id));
      assert.equal(result.tab?.id, id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id], 'shown once');
      assert.equal(entry.wakeStartedBy, 'hover');
      if (!backgroundMs) {
        // (A machine too loaded to answer in time here says nothing.)
        if ((await hover).ms < 50) {
          assert.equal(barriers(id).length, 0, 'answered in time: nothing drawn first');
          assert.equal(entry.wakeOutcome, 'awake');
        }
        continue;
      }
      assert.equal(entry.wakeOutcome, 'resumed', `resumed at ${backgroundMs} ms`);
      const [drawn] = barriers(id);
      assert.ok(drawn && drawn.at >= asked && drawn.at < fake.updates[0].at, 'drawn before the show');
      assert.ok(entry.waitedOnOldPage < 40, `nothing more waited for its wake (${entry.waitedOnOldPage} ms)`);
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('wait: not a tab keep-ready holds (its process runs: a slow wake there is a busy page), nor a page loading; their wakes are waited for as before', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 214, url: 'https://held.test/' }, { id: 215, url: 'https://loading.test/', status: 'loading' }], []);
  try {
    await decided();
    await markSynced();
    await mutate((st) => M.upsertTab(st, fake.tabs.get(214), Date.now() - 60_000));
    fake.holdsRun = true;
    for (const id of [214, 215]) noteLeft(id, Date.now() - 10_000);
    holdNow(214);
    await sleep(10);
    assert.equal(switchFacts(214).heldAtAsk, true, 'held');
    fake.scriptDelay = (id, func) => ([214, 215].includes(id) && func?.name === 'pageThere' ? 250 : 1);
    for (const id of [214, 215]) {
      putInFront(1);
      await knownInFront(1);
      fake.updates = [];
      const asked = Date.now();
      const { entry } = await logged(id, () => focusTab(id));
      assert.deepEqual(fake.updates.map((u) => u.id), [id]);
      assert.ok(fake.updates[0].at - asked >= 240, `tab ${id}: its wake waited for`);
      assert.equal(entry.wakeOutcome, null, `tab ${id}: not a wait`);
      assert.equal(barriers(id).length, 0);
    }
  } finally {
    resetKeepReady();
    tabShown(214);
    tabShown(215);
    done();
  }
});

test('wait: a held key passing through tabs Safari suspended doesn\'t wait for them, nor shows them (their wakes not answered in time: the highlight moves on); only the tab it stops on goes through focusTab', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 210, url: 'https://p1.test/' }, { id: 211, url: 'https://p2.test/' }, { id: 212, url: 'https://p3.test/' }], []);
  try {
    await mutate(() => {
      let st = M.defaultState();
      for (const id of [1, 210, 211, 212]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
      return M.activateTab(st, 1, 1, Date.now());
    });
    const s = await load();
    const step = (from) => V.cycleTab(s, 1, from, 1);
    const first = step(1), second = step(first), last = step(second);
    for (const id of [first, second]) {
      noteLeft(id, Date.now() - 10_000);
      suspend(id);
    }
    const entries = [];
    tapLog((entry) => entries.push(entry));
    const started = Date.now();
    try {
      navigate('next-tab', 'key', 1);
      navigate('next-tab', 'key', 1);
      await navigate('next-tab', 'key', 1);
    } finally {
      tapLog(null);
    }
    assert.equal(front(), last);
    assert.deepEqual(fake.updates.map((u) => u.id), [last], 'only the tab it stops on shown');
    assert.ok(Date.now() - started < 600, 'the tabs passed through not waited for');
    for (const id of [first, second]) assert.equal(entries.find((e) => e.kind === 'switch' && e.tabId === id)?.error, 'passed over', `tab ${id}`);
  } finally {
    for (const id of [210, 211, 212]) tabShown(id);
    done();
  }
});

test('wait: a running tab (hidden 10 s, its wake answering in 30 ms) is shown at once, prepared beside its wake, nothing drawn first', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 216, url: 'https://running.test/' }], []);
  try {
    noteLeft(216, Date.now() - 10_000);
    fake.scriptDelay = (_id, func) => (func?.name === 'pageThere' || func?.name === 'prepareSidebarInPage' ? 30 : 5);
    const asked = Date.now();
    const { result, entry } = await logged(216, () => focusTab(216));
    assert.deepEqual(fake.updates.map((u) => u.id), [216]);
    const [prepared, ...more] = prepares(216);
    assert.ok(prepared && !more.length && prepared.at - asked < 10, 'prepared beside its wake, once');
    assert.equal(result.preparation.outcome, 'ready');
    assert.equal(barriers(216).length, 0);
    assert.ok(fake.updates[0].at - asked < 60, `shown ${fake.updates[0].at - asked} ms after the ask`);
    assert.equal(entry.wakeOutcome, 'awake');
    assert.ok(entry.waitedOnOldPage >= 25 && entry.waitedOnOldPage < 60, `waited ${entry.waitedOnOldPage} ms`);
  } finally {
    tabShown(216);
    done();
  }
});

test('wait: a wake that fails before its scripts go out (its permission check throws) fails the switch, as before, rather than leaving it waiting', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 217, url: 'https://throws.test/' }], []);
  const contains = chrome.permissions.contains;
  chrome.permissions.contains = () => { throw new Error('boom'); };
  // (The same rejection reaches promises that aren't this test's: the
  // preparation beside the wake, the permission cache. Kept out of the runner.)
  const listeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', () => {});
  try {
    noteLeft(217, Date.now() - 1_000);
    const outcome = await Promise.race([focusTab(217).then(() => 'shown', (err) => `failed: ${err.message}`), sleep(1500).then(() => 'still waiting')]);
    assert.equal(outcome, 'failed: boom');
    assert.equal(isFocusing(217), false);
    await sleep(20);
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of listeners) process.on('unhandledRejection', listener);
    chrome.permissions.contains = contains;
    tabShown(217);
    done();
  }
});

test('wait: a wake that fails once the page in front is covered for it (past 150 ms: its permission check slow, then throwing) uncovers that page at once, told the switch failed, not left covered until its own limit', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 263, url: 'https://throws263.test/' }], []);
  const contains = chrome.permissions.contains;
  chrome.permissions.contains = () => { throw new Error('boom'); };
  // The wake's own look at the tab (the switch's first is quick) slow: its
  // permission check comes 300 ms in.
  const get = chrome.tabs.get;
  let gets = 0;
  chrome.tabs.get = async (id) => (id === 263 && ++gets === 2 ? sleep(300).then(() => get(id)) : get(id));
  const listeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', () => {});
  try {
    noteLeft(263, Date.now() - 1_000);
    const outcome = await Promise.race([focusTab(263, { source: 'space' }).then(() => 'shown', (err) => `failed: ${err.message}`), sleep(1500).then(() => 'still waiting')]);
    assert.equal(outcome, 'failed: boom');
    await sleep(20);
    assert.deepEqual(toldFront().map(([type, tabId]) => [type, tabId]), [['switching', 263], ['switch-failed', 263]], 'covered while it waited, then told');
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of listeners) process.on('unhandledRejection', listener);
    chrome.permissions.contains = contains;
    chrome.tabs.get = get;
    tabShown(263);
    done();
  }
});

test('wait: a tab keep-ready holds isn\'t waited for, but one whose wake doesn\'t answer in time all the same (suspended after all: a hold that ended unseen) is drawn before it\'s shown', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 264, url: 'https://held264.test/' }], []);
  try {
    await decided();
    await markSynced();
    await mutate((st) => M.upsertTab(st, fake.tabs.get(264), Date.now() - 60_000));
    fake.holdsRun = true;
    noteLeft(264, Date.now() - 10_000);
    holdNow(264);
    await sleep(10);
    assert.equal(switchFacts(264).heldAtAsk, true, 'held');
    fake.holdsRun = false;
    suspend(264, { backgroundMs: 600 });
    const asked = Date.now();
    const { entry } = await logged(264, () => focusTab(264));
    assert.equal(entry.wakeOutcome, null, 'not a wait');
    const [drawn] = barriers(264);
    assert.ok(drawn, 'drawn first');
    assert.ok(fake.updates.at(-1).at - asked >= 590, `shown once its process had resumed (${fake.updates.at(-1).at - asked} ms)`);
  } finally {
    resetKeepReady();
    tabShown(264);
    done();
  }
});

test('hand-off: a ⌘T tab that stays after all has its activation, left out while it was handed back, told if it\'s still in front; nothing for one not handed off, or no longer in front', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/' }, { id: 265, url: 'safari-web-extension://test/newtab/newtab.html', active: true }, { id: 266, url: 'https://b.test/' }], []);
  try {
    const told = [];
    setIntroductionHooks({ activated: (info) => told.push([info.tabId, info.windowId]) });
    handingOff.add(265);
    keepHandedOff(265);
    await sleep(5);
    assert.deepEqual(told, [[265, 1]]);
    assert.equal(handingOff.has(265), false);
    keepHandedOff(265); // (again: no longer handed off)
    handingOff.add(266); // left meanwhile
    keepHandedOff(266);
    await sleep(5);
    assert.deepEqual(told, [[265, 1]]);
  } finally {
    handingOff.clear();
    done();
  }
});

test('prewake: pages ask for wakes in Safari (Chrome: tests/open-behind-chrome.test.js)', () => {
  assert.equal(asksBackground('prewake'), true);
  assert.equal(asksBackground('activateTab'), true);
});

// A tab Safari unloaded whose scripts fail only after 200 ms (its UI process
// busy, as just after a relaunch), from restoring() (below).
function slowNoPage(id) {
  const run = chrome.scripting.executeScript;
  chrome.scripting.executeScript = (options) => {
    const slow = options.target.tabId === id && noPage.has(id);
    const ran = run(options);
    return slow ? ran.then((rows) => sleep(200).then(() => rows), (err) => sleep(200).then(() => { throw err; })) : ran;
  };
  return () => { chrome.scripting.executeScript = run; };
}

test('wait: a tab whose wake says late that it has no page (Safari unloaded it, or its process went away while suspended) is restored behind the page in front, covered once (from 150 ms into the wait); one left in this session (known to have had a page) is kicked first, which starts its load: it\'s waited for behind the page the same way', async () => {
  for (const [left, id] of [[false, 218], [true, 219]]) {
    const done = await restoring([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://unloaded${id}.test/` }], { [id]: { loadMs: 300, startMs: 80 } });
    const undo = slowNoPage(id);
    try {
      if (left) noteLeft(id, Date.now() - 1_000);
      const { result, entry } = await logged(id, () => focusTab(id));
      assert.equal(result.tab?.id, id);
      assert.equal(entry.wakeOutcome, 'no page');
      if (left) {
        assert.equal(entry.kicked?.outcome, 'loading');
        assert.ok(['painted', 'loaded'].includes(entry.loadWait), `waited for: ${entry.loadWait}`);
      } else {
        assert.equal(entry.kicked, undefined, 'not known to have a page: not kicked');
        assert.ok(['painted', 'loaded'].includes(entry.restored), `restored: ${entry.restored}`);
      }
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id, 1, id], 'restored (or kicked), introduced, shown');
      assert.deepEqual(toldFront(), [['switching', id, 'now'], ['switch-done', id, null]]);
    } finally {
      undo();
      done();
    }
  }
});

test('wait: the first switch after a background start (Safari stopped the idle one) knows from storage.session when its tab was left (the switch log): hidden a minute, likely suspended, it\'s kicked 40 ms after its wake went out, then drawn and shown', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 270, url: 'https://restarted.test/' }], []);
  try {
    fake.session.keepReadyLeftAt = { 270: Date.now() - 60_000 };
    fake.sessionMs = 30; // a background just started: storage slow to answer
    startedAgain();
    suspend(270, { backgroundMs: 300 });
    const asked = Date.now();
    const { result, entry } = await logged(270, () => focusTab(270));
    assert.equal(result.tab?.id, 270);
    assert.deepEqual(fake.updates.map((u) => u.id), [270, 1, 270], 'kicked, then shown');
    assert.equal(entry.wakeOutcome, 'resumed');
    assert.equal(entry.kicked?.outcome, 'resumed');
    assert.ok(entry.hiddenForMs >= 60_000, `hidden for ${entry.hiddenForMs} ms (the background before's note)`);
    const kickedAt = fake.updates[0].at - asked;
    assert.ok(kickedAt >= 65 && kickedAt < 120, `kicked ${kickedAt} ms after the ask (the session read: 30 ms, then 40 ms after the wake went out)`);
    assert.ok(fake.updates[2].at - asked < 300, `shown ${fake.updates[2].at - asked} ms after the ask (its background resume: 300 ms)`);
  } finally {
    fake.sessionMs = 0;
    resetKeepReady();
    tabShown(270);
    done();
  }
});

test('wait: a wake whose permission check outlasts its 400 ms (Safari starting) is still waited for: its scripts not out by then, the tab is kicked, then drawn and shown once it answers', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 275, url: 'https://slow-check.test/' }], []);
  const contains = chrome.permissions.contains;
  chrome.permissions.contains = async () => { await sleep(450); return true; };
  try {
    noteLeft(275, Date.now() - 10_000);
    suspend(275, { backgroundMs: 300 });
    const asked = Date.now();
    const { result, entry } = await logged(275, () => focusTab(275));
    assert.equal(result.tab?.id, 275);
    assert.deepEqual(fake.updates.map((u) => u.id), [275, 1, 275], 'kicked, then shown');
    assert.equal(entry.wakeOutcome, 'resumed');
    assert.equal(entry.kicked?.outcome, 'resumed');
    const kickedAt = fake.updates[0].at - asked;
    assert.ok(kickedAt >= 395 && kickedAt < 440, `kicked ${kickedAt} ms after the ask (its scripts not out by 400 ms)`);
    assert.equal(result.preparation.outcome, 'ready');
    assert.ok(barriers(275).length === 1);
    const shownAfter = fake.updates[2].at - asked;
    assert.ok(shownAfter >= 450 && shownAfter < 700, `shown ${shownAfter} ms after the ask (its check: 450 ms; its background resume would have been 750)`);
  } finally {
    chrome.permissions.contains = contains;
    tabShown(275);
    done();
  }
});

test('wait: a wake answered late holds the tab from its answer (its hold started at the resume): the switch that waited for it sends no second wake and doesn\'t wait for one; nor after a pointer resting on the row 1 s before the click', async () => {
  // [resume (ms from the wake's start), click after the hover wake (null: the switch's own wake), tab]
  for (const [backgroundMs, clickAfter, id] of [[1500, null, 331], [1700, 1000, 332]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://late${id}.test/` }], []);
    try {
      noKicks(); // (a kick would resume it in the foreground: no late answer)
      noteLeft(id, Date.now() - 20_000);
      suspend(id, { backgroundMs });
      const started = Date.now();
      if (clickAfter != null) {
        void wakeTab(id, { hover: true, by: 'hover' });
        await sleep(clickAfter);
      }
      // A page just resumed is busy: a second wake there would take 450 ms to answer.
      const exec = chrome.scripting.executeScript;
      chrome.scripting.executeScript = (opts) => (!opts.again && opts.target.tabId === id && Date.now() - started > backgroundMs - 100 && opts.func?.name === 'pageThere' ? sleep(450).then(() => exec(opts)) : exec(opts));
      let got;
      try {
        got = await logged(id, () => focusTab(id));
      } finally {
        chrome.scripting.executeScript = exec;
      }
      const { result, entry } = got;
      assert.equal(result.tab?.id, id);
      assert.equal(entry.wakeOutcome, 'resumed');
      assert.equal(keepAwakes(id).length, 1, `tab ${id}: one hold`);
      assert.equal(scriptsNamed(id, 'pageThere').length, 1, `tab ${id}: one wake`);
      const shownAfter = fake.updates[0].at - started;
      assert.ok(shownAfter < backgroundMs + 250, `tab ${id}: shown ${shownAfter} ms after the wake (its resume: ${backgroundMs} ms)`);
      assert.ok(barriers(id).length === 1 && barriers(id)[0].at < fake.updates[0].at, 'drawn before the show');
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('wait: a wake answering only after its tab was shown (a switch that stopped waiting for it) doesn\'t mark it resumed: the next switch to it, running, isn\'t drawn first', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 333, url: 'https://capped333.test/' }], []);
  try {
    noKicks(); // (capped: a kick would resume it)
    fake.activated = (info) => tabShown(info.tabId); // as background.js onActivated
    noteLeft(333, Date.now() - 60_000);
    suspend(333, { backgroundMs: 4000, shownMs: 30 });
    const first = await logged(333, () => focusTab(333));
    assert.equal(first.entry.wakeOutcome, 'capped');
    await sleep(200); // its scripts' late answers
    await chrome.tabs.update(1, { active: true });
    await knownInFront(1);
    fake.updates = [];
    fake.scripts = [];
    noteLeft(333, Date.now() - 3000);
    const asked = Date.now();
    const { entry } = await logged(333, () => focusTab(333));
    assert.equal(entry.wakeOutcome, 'awake');
    assert.equal(barriers(333).length, 0, 'nothing drawn first');
    assert.ok(fake.updates[0].at - asked < 40, `shown ${fake.updates[0].at - asked} ms after the ask`);
  } finally {
    tabShown(333);
    done();
  }
});

test('wait: a wake already answered counts with no time left to wait (a switch close to its deadline): the tab is prepared and shown, not taken as capped', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 334, url: 'https://run334.test/' }], []);
  try {
    noteLeft(334, Date.now() - 10_000);
    await wakeTab(334, { hover: true, by: 'hover' });
    await sleep(300);
    const { result, entry } = await logged(334, () => focusTab(334, { deadline: Date.now() + 2000 }));
    assert.equal(result.tab?.id, 334);
    assert.equal(entry.wakeOutcome, 'awake');
    assert.equal(entry.wakeStartedBy, 'hover');
    assert.equal(result.preparation.outcome, 'ready');
  } finally {
    tabShown(334);
    done();
  }
});

test('wait: the page in front, covered from 150 ms into the wait, slow to answer that: a tab whose wake has answered is shown without waiting for it, and the page is told how it went once it has answered', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 335, url: 'https://space335.test/' }], []);
  const send = chrome.tabs.sendMessage;
  try {
    noKicks(); // (its foreground resume would answer before the cover)
    noteLeft(335, Date.now() - 10_000);
    suspend(335, { backgroundMs: 170 });
    chrome.tabs.sendMessage = (tabId, message) => (message.type === 'switching' ? send(tabId, message).then((answer) => sleep(400).then(() => answer)) : send(tabId, message));
    const asked = Date.now();
    const { result, entry } = await logged(335, () => focusTab(335, { source: 'space' }));
    assert.equal(result.tab?.id, 335);
    assert.equal(entry.wakeOutcome, 'resumed');
    const shownAfter = fake.updates[0].at - asked;
    assert.ok(shownAfter < 340, `shown ${shownAfter} ms after the ask (its resume: 170 ms)`);
    await sleep(450);
    assert.deepEqual(toldFront(), [['switching', 335, 'now'], ['switch-done', 335, null]]);
  } finally {
    chrome.tabs.sendMessage = send;
    tabShown(335);
    done();
  }
});

test('wait: a tab never shown that Safari suspended (a ⌘-clicked link read later) is introduced only once its wake has answered, then drawn and shown; one that answers at once is introduced at once', async () => {
  for (const [backgroundMs, id] of [[900, 336], [null, 337]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://opened${id}.test/` }], [id]);
    try {
      if (backgroundMs) suspend(id, { backgroundMs });
      const asked = Date.now();
      const { result, entry } = await logged(id, () => focusTab(id));
      assert.equal(result.tab?.id, id);
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id], 'introduced, then shown');
      const introducedAfter = fake.updates[0].at - asked;
      if (backgroundMs) {
        assert.ok(introducedAfter >= backgroundMs - 10, `introduced ${introducedAfter} ms after the ask (its resume: ${backgroundMs} ms)`);
        assert.equal(entry.wakeOutcome, 'resumed');
      } else {
        assert.ok(introducedAfter < 60, `introduced ${introducedAfter} ms after the ask`);
        assert.equal(entry.wakeOutcome, 'awake');
      }
      const drawn = barriers(id).filter((x) => x.at >= fake.updates[1].at);
      assert.ok(drawn.length >= 1 && drawn[0].at < fake.updates[2].at, 'drawn after its introduction, before the show');
    } finally {
      done();
    }
  }
});

// ---- the kick (tabs.js focusTabNow: a foreground resume inside the wait) --------

test('kick: a tab Safari suspended, hidden 8 s or more, whose wake hasn\'t answered 40 ms after it went out, is brought to the front and the page in front straight back (sent together); then woken again, prepared afresh and drawn before it\'s shown, long before its background resume; the kick\'s activations aren\'t switches', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 280, url: 'https://kicked.test/' }], []);
  try {
    const events = [];
    fake.activated = (info) => events.push([info.tabId, isIntroduction(info)]);
    noteLeft(280, Date.now() - 10_000);
    suspend(280, { backgroundMs: 2000, shownMs: 30 }); // (its answer then comes more than 60 ms after its wake went out: resumed, not running)
    let inFlight = 0;
    const startedWhile = [];
    const asked = Date.now();
    const { result, entry } = await withUpdate(async (update, id, change) => {
      startedWhile.push(inFlight++);
      try {
        const answer = await update(id, change);
        await sleep(10);
        return answer;
      } finally {
        inFlight--;
      }
    }, () => logged(280, () => focusTab(280, { source: 'activateTab' })));
    assert.equal(result.tab?.id, 280);
    assert.deepEqual(fake.updates.map((u) => u.id), [280, 1, 280], 'kicked, then shown');
    assert.deepEqual(startedWhile.slice(0, 2), [0, 1], 'the two sent together');
    const kickedAt = fake.updates[0].at - asked;
    assert.ok(kickedAt >= 38 && kickedAt < 56, `kicked ${kickedAt} ms after the ask (40 ms after its wake went out)`);
    assert.deepEqual(events, [[280, true], [1, true], [280, false]], 'only the real switch is told as one');
    const holds = keepAwakes(280);
    assert.equal(holds.length, 2, 'woken, then held afresh after the kick (its instant in front ended the first hold)');
    assert.ok(holds[1].at >= fake.updates[1].at);
    const [first, again, ...more] = prepares(280);
    assert.ok(first && again && !more.length, 'prepared beside the wake, then again after the kick');
    assert.ok(again.at >= fake.updates[1].at && again.args[0].token.endsWith(':kicked'));
    assert.ok(holds[1].at <= again.at, 'woken again as Safari answered the kick, with the new preparation (not once the wait is over)');
    assert.ok(cancelsOf(280, first.args[0].token).some((x) => x.at <= fake.updates[2].at), 'the first preparation called off');
    assert.equal(result.preparation.outcome, 'ready');
    const drawn = barriers(280);
    assert.ok(drawn.length === 1 && drawn[0].at >= fake.updates[1].at && fake.updates[2].at - drawn[0].at >= 55, 'drawn after the kick, then shown');
    assert.ok(fake.updates[2].at - asked < 400, `shown ${fake.updates[2].at - asked} ms after the ask (its background resume: 2 s)`);
    assert.equal(entry.wakeOutcome, 'resumed');
    assert.equal(entry.kicked?.outcome, 'resumed');
    assert.ok(entry.kicked.at >= 38 && entry.kicked.kickMs >= 8 && entry.kicked.wakeMs != null, JSON.stringify(entry.kicked));
    assert.deepEqual(toldFront(), [], 'the page in front was told nothing (it covers itself for a row)');
  } finally {
    tabShown(280);
    done();
  }
});

test('kick: a tab hidden only 2 s is kicked once its wake hasn\'t answered 60 ms after it went out; one answering in 30 ms isn\'t kicked', async () => {
  for (const [suspended, id] of [[true, 281], [false, 282]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://soon${id}.test/` }], []);
    try {
      noteLeft(id, Date.now() - 2000);
      if (suspended) suspend(id, { backgroundMs: 2000, shownMs: 5 });
      else fake.scriptDelay = (_id, func) => (func?.name === 'pageThere' ? 30 : 1);
      const asked = Date.now();
      const { entry } = await logged(id, () => focusTab(id, { source: 'activateTab' }));
      if (!suspended) {
        assert.deepEqual(fake.updates.map((u) => u.id), [id]);
        assert.equal(entry.kicked, undefined);
        assert.equal(entry.wakeOutcome, 'awake');
        continue;
      }
      assert.deepEqual(fake.updates.map((u) => u.id), [id, 1, id]);
      const kickedAt = fake.updates[0].at - asked;
      assert.ok(kickedAt >= 58 && kickedAt < 90, `kicked ${kickedAt} ms after the ask`);
      assert.equal(entry.kicked?.outcome, 'resumed');
      const drawn = barriers(id);
      assert.ok(drawn.length === 1 && drawn[0].at >= fake.updates[1].at && drawn[0].at < fake.updates[2].at, 'drawn after the kick, before the show (its new wake answered at once)');
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('kick: none with introductions off, for a tab not known to have had a page (not left in this Safari session), nor with too little of the wait left; those wait for the wake alone', async () => {
  for (const [how, id] of [['off', 283], ['unknown', 284], ['little time', 285]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://nokick${id}.test/` }], []);
    try {
      if (how === 'off') noKicks();
      if (how !== 'unknown') noteLeft(id, Date.now() - 10_000);
      suspend(id, { backgroundMs: 200, shownMs: 5 });
      // (The wait leaves 250 ms: 1.5 s, then 250 ms for the preparation, before its deadline.)
      const deadline = how === 'little time' ? Date.now() + 2000 : undefined;
      const { result, entry } = await logged(id, () => focusTab(id, { source: 'activateTab', deadline }));
      assert.equal(result.tab?.id, id, how);
      assert.deepEqual(fake.updates.map((u) => u.id), [id], `${how}: not kicked`);
      assert.equal(entry.kicked, undefined, how);
      assert.equal(entry.wakeOutcome, 'resumed', how);
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('kick: one that doesn\'t get the tab resumed (a heavy tab under swap) still has it shown only at the cap (1.6 s), not before; both its preparations called off, no paint barrier', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 286, url: 'https://heavy.test/' }], []);
  try {
    noteLeft(286, Date.now() - 60_000);
    suspend(286, { backgroundMs: 4000, shownMs: 4000 });
    const asked = Date.now();
    const { result, entry } = await logged(286, () => focusTab(286, { source: 'activateTab' }));
    assert.equal(result.tab?.id, 286);
    assert.deepEqual(fake.updates.map((u) => u.id), [286, 1, 286]);
    const shownAfter = fake.updates[2].at - asked;
    assert.ok(shownAfter >= 1590 && shownAfter < 1750, `shown ${shownAfter} ms after the ask`);
    for (const prep of prepares(286)) assert.ok(cancelsOf(286, prep.args[0].token).some((x) => x.at <= fake.updates[2].at), `${prep.args[0].token} called off`);
    assert.equal(barriers(286).length, 0);
    assert.equal(entry.wakeOutcome, 'capped');
    assert.equal(entry.kicked?.outcome, 'capped');
    assert.equal(entry.kicked.wakeMs, null);
  } finally {
    tabShown(286);
    done();
  }
});

test('kick: another switch after the kick ends the wait at once; the tab stays behind, its preparation after the kick called off', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 287, url: 'https://kickleft.test/' }], []);
  try {
    noteLeft(287, Date.now() - 10_000);
    suspend(287, { backgroundMs: 1500, shownMs: 1500 });
    const asked = Date.now();
    const pending = logged(287, () => focusTab(287, { source: 'activateTab' }));
    await sleep(150);
    userSwitched(999);
    const { result, entry } = await pending;
    assert.equal(result.superseded, true);
    assert.ok(Date.now() - asked < 260, `ended ${Date.now() - asked} ms after the ask`);
    assert.deepEqual(fake.updates.map((u) => u.id), [287, 1], 'the kick, nothing after');
    assert.equal(front(), 1);
    const kicked = prepares(287).find((x) => x.args[0].token.endsWith(':kicked'));
    assert.ok(kicked && cancelsOf(287, kicked.args[0].token).length >= 1, 'its preparation after the kick called off');
    assert.equal(entry.kicked?.outcome, 'left');
    await sleep(1500); // (its resume, and the late answers)
  } finally {
    tabShown(287);
    done();
  }
});

test('kick: Safari leaving the tab in front: it\'s shown as it is (its preparation called off, not left to land on the page on screen), and no more kicks or introductions this session', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 288, url: 'https://stays.test/' }], []);
  try {
    noteLeft(288, Date.now() - 10_000);
    suspend(288, { backgroundMs: 2000, shownMs: 5 });
    const { result, entry } = await withUpdate(async (update, id, change) => (id === 1 ? (fake.updates.push({ id, change, at: Date.now() }), { ...fake.tabs.get(1), active: true }) : update(id, change)),
      () => logged(288, () => focusTab(288, { source: 'activateTab' })));
    assert.equal(front(), 288);
    assert.equal(result.tab?.id, 288);
    assert.equal(entry.kicked?.outcome, 'in front');
    assert.ok(cancelsOf(288, earlyToken(288)).length >= 1, 'its preparation called off');
    assert.equal(fake.session.introductionsOff, true);
  } finally {
    tabShown(288);
    done();
  }
});

test('kick: the page in front hidden for an instant during a kick turns kicks off for the session: the next switch to a tab Safari suspended waits for its wake alone', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 289, url: 'https://blink1.test/' }, { id: 290, url: 'https://blink2.test/' }], []);
  try {
    // The page in front, as it comes back from the kick, says it was hidden for an instant.
    fake.activated = (info) => { if (isIntroduction(info) && info.tabId === 1) pageBlinked(1, { hiddenAt: Date.now(), shownAt: Date.now() }); };
    for (const id of [289, 290]) {
      noteLeft(id, Date.now() - 10_000);
      suspend(id, { backgroundMs: 300, shownMs: 5 });
    }
    await focusTab(289, { source: 'activateTab' });
    assert.deepEqual(fake.updates.map((u) => u.id), [289, 1, 289]);
    assert.equal(fake.session.introductionsOff, true);
    await chrome.tabs.update(1, { active: true });
    await knownInFront(1);
    fake.updates = [];
    const { entry } = await logged(290, () => focusTab(290, { source: 'activateTab' }));
    assert.deepEqual(fake.updates.map((u) => u.id), [290], 'not kicked');
    assert.equal(entry.wakeOutcome, 'resumed');
  } finally {
    for (const id of [289, 290]) tabShown(id);
    done();
  }
});

test('barrier: a tab kicked awake gets a first barrier of 150 ms (it drew in the window for the kick); a tab resumed behind (its wake answered late before the switch, never in the window since) and a tab introduced (never shown) 400 ms; one run out after a flip of the tab\'s own (a kick, an introduction: its hide still pending) is followed by one more under the cover, for the rest of 600 ms, then the tab is shown as it is; one only resumed behind is shown when its barrier runs out, as before', async () => {
  for (const [kind, id] of [['kicked', 290], ['resumed', 291], ['introduced', 292]]) {
    const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://barrier${id}.test/` }], kind === 'introduced' ? [id] : []);
    try {
      noteLeft(id, Date.now() - 20_000);
      if (kind === 'resumed') {
        suspend(id, { backgroundMs: 200 });
        await wakeTab(id, { hover: true, by: 'hover' }).then(() => sleep(300));
      }
      if (kind === 'kicked') suspend(id, { backgroundMs: 2000, shownMs: 30 });
      fake.barrierMs = () => 2000; // a page that doesn't draw in time
      const asked = Date.now();
      const { result, entry } = await logged(id, () => focusTab(id, { source: 'activateTab' }));
      assert.equal(result.tab?.id, id);
      const [timedOut, ...more] = entry.barrier ?? [];
      assert.equal(timedOut?.how, 'timeout', `${kind}: ${JSON.stringify(entry.barrier)}`);
      assert.equal(entry.layersBack, 'timeout');
      const shownAfter = fake.updates.at(-1).at - asked;
      if (kind === 'resumed') {
        // (No flip of its own: 23 of 68 such switches ran to the limit on
        // 2026-11-03, none dark.)
        assert.equal(more.length, 0, `${kind}: one barrier only: ${JSON.stringify(entry.barrier)}`);
        assert.equal(entry.wakeOutcome, 'resumed');
        assert.equal(entry.kicked, undefined, 'answered before the switch: not kicked');
        assert.ok(timedOut.ms >= 410, `${kind}: the barrier ran ${timedOut.ms} ms`);
        assert.ok(shownAfter >= 410 && shownAfter < 410 + 300, `${kind}: shown ${shownAfter} ms after the ask`);
        continue;
      }
      // One more, for the rest of LAYERS_EXTRA_MS (not one new barrier each 400 ms).
      assert.equal(more.length, 1, `${kind}: ${JSON.stringify(entry.barrier)}`);
      assert.equal(more[0].how, 'timeout');
      assert.ok(more[0].ms >= 550 && more[0].ms < 750, `${kind}: ${more[0].ms} ms more under the cover (${JSON.stringify(entry.barrier)})`);
      if (kind === 'kicked') {
        assert.equal(entry.kicked?.outcome, 'resumed');
        assert.ok(timedOut.ms >= 140 && timedOut.ms < 200, `the barrier ran ${timedOut.ms} ms`);
        assert.ok(shownAfter < 330 + 750, `shown ${shownAfter} ms after the ask`);
      } else {
        assert.ok(timedOut.ms >= 410, `${kind}: the barrier ran ${timedOut.ms} ms`);
        assert.ok(shownAfter >= 410 + 550, `${kind}: shown ${shownAfter} ms after the ask`);
      }
    } finally {
      tabShown(id);
      done();
    }
  }
});

test('kick: a second click on the same row during the wait after a kick doesn\'t kick the tab again (its process resumed and held by then): it takes on the tab\'s wake, and the tab is shown once that answers', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 460, url: 'https://reclick460.test/' }], []);
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    noteLeft(460, Date.now() - 20_000);
    suspend(460, { backgroundMs: 3000, shownMs: 400 }); // a heavy tab: its foreground resume takes 400 ms
    const asked = Date.now();
    const first = focusTab(460, { source: 'activateTab' });
    await sleep(250); // kicked at about 40 ms, its wake not answered
    const second = focusTab(460, { source: 'activateTab' });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.superseded, true);
    assert.equal(b.tab?.id, 460);
    assert.deepEqual(fake.updates.map((u) => u.id), [460, 1, 460], 'one kick, then the show');
    const shown = entries.filter((e) => e.kind === 'switch' && e.tabId === 460 && e.shownAfter != null);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kicked, undefined, 'the second switch: not kicked');
    assert.equal(scriptsNamed(460, 'pageThere').length, 1, 'its wake taken on');
    const shownAfter = fake.updates[2].at - asked;
    assert.ok(shownAfter >= 430 && shownAfter < 700, `shown ${shownAfter} ms after the first ask (its resume: about 440 ms)`);
  } finally {
    tapLog(null);
    tabShown(460);
    done();
  }
});

test('kick: the page in front of a switch that doesn\'t cover itself (a key to a space) is covered 150 ms into the wait even while a kick is under way (WebKit holding its first update 250 ms for the tab\'s paint)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 461, url: 'https://held461.test/' }], []);
  const send = chrome.tabs.sendMessage;
  try {
    noteLeft(461, Date.now() - 20_000);
    suspend(461, { backgroundMs: 3000, shownMs: 300 });
    let coveredAt = null;
    const asked = Date.now();
    chrome.tabs.sendMessage = (tabId, message) => {
      if (message.type === 'switching' && coveredAt == null) coveredAt = Date.now() - asked;
      return send(tabId, message);
    };
    const { result, entry } = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (fake.updates.length <= 2) await sleep(250); // the kick, held
      return answer;
    }, () => logged(461, () => focusTab(461, { source: 'space' })));
    assert.equal(result.tab?.id, 461);
    assert.deepEqual(fake.updates.map((u) => u.id), [461, 1, 461]);
    assert.ok(entry.kicked?.kickMs >= 245, JSON.stringify(entry.kicked));
    assert.ok(coveredAt != null && coveredAt >= 145 && coveredAt < 200, `covered ${coveredAt} ms after the ask`);
    assert.deepEqual(toldFront(), [['switching', 461, 'now'], ['switch-done', 461, null]]);
  } finally {
    chrome.tabs.sendMessage = send;
    tabShown(461);
    done();
  }
});

test('kick: a switch given up while Safari answers its kick (another switch) sends the tab nothing more: no hold, wake or preparation for a tab the user has left', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 462, url: 'https://given462.test/' }, { id: 463, url: 'https://other463.test/' }], []);
  try {
    noteLeft(462, Date.now() - 10_000);
    suspend(462, { backgroundMs: 1500, shownMs: 5 });
    let otherAt = null;
    const { result, entry } = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (otherAt == null && id === 462) {
        otherAt = Date.now();
        userSwitched(463);
      }
      await sleep(120);
      return answer;
    }, () => logged(462, () => focusTab(462, { source: 'activateTab' })));
    assert.equal(result.superseded, true);
    assert.equal(entry.kicked?.outcome, 'left');
    await sleep(50);
    const after = fake.scripts.filter((x) => x.tabId === 462 && x.at >= otherAt && x.func.name !== 'cancelSidebarInPage').map((x) => x.func.name || 'keepAwake');
    assert.deepEqual(after, [], 'nothing but its preparation called off');
    assert.ok(cancelsOf(462, earlyToken(462)).length >= 1, 'its preparation called off');
    await sleep(1500); // (its late answers)
  } finally {
    tabShown(462);
    done();
  }
});

test('kick: after the kick the tab\'s wake stands (its scripts reach the page behind the resume the kick started, so its answer comes first): only its hold is sent again, and its preparation made again; the wait ends on that first answer', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 464, url: 'https://stands464.test/' }], []);
  try {
    noteLeft(464, Date.now() - 10_000);
    suspend(464, { backgroundMs: 1500, shownMs: 30 });
    const asked = Date.now();
    const { result, entry } = await logged(464, () => focusTab(464, { source: 'activateTab' }));
    assert.equal(result.tab?.id, 464);
    assert.deepEqual(fake.updates.map((u) => u.id), [464, 1, 464]);
    assert.equal(scriptsNamed(464, 'pageThere').length, 1, 'one wake');
    assert.equal(keepAwakes(464).length, 2, 'its hold, then again after the kick');
    assert.equal(prepares(464).length, 2, 'prepared beside the wake, then again after the kick');
    assert.equal(entry.kicked?.outcome, 'resumed');
    assert.ok(entry.kicked.wakeMs != null && entry.kicked.wakeMs < 60, `answered ${entry.kicked.wakeMs} ms after the kick`);
    assert.equal(entry.wakeOutcome, 'resumed');
    assert.ok(fake.updates[2].at - asked < 330, `shown ${fake.updates[2].at - asked} ms after the ask`);
  } finally {
    tabShown(464);
    done();
  }
});

test('kick: another switch, to another tab, asked while Safari answers a kick, sends its wake at once (not once the kick is answered); a tab running is shown then', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 465, url: 'https://first465.test/' }, { id: 466, url: 'https://second466.test/' }], []);
  try {
    noteLeft(465, Date.now() - 10_000);
    noteLeft(466, Date.now() - 1000);
    suspend(465, { backgroundMs: 1500, shownMs: 5 });
    let secondAsked = 0;
    const second = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      await sleep(150);
      return answer;
    }, async () => {
      const first = focusTab(465, { source: 'activateTab' });
      await sleep(70); // the kick went out at about 40 ms
      secondAsked = Date.now();
      const shown = await logged(466, () => focusTab(466, { source: 'activateTab' }));
      await first;
      return shown;
    });
    assert.equal(second.result.tab?.id, 466);
    const woken = scriptsNamed(466, 'pageThere')[0];
    assert.ok(woken && woken.at - secondAsked < 20, `its wake went out ${woken && woken.at - secondAsked} ms after its ask`);
    const shown = fake.updates.find((u) => u.id === 466);
    assert.ok(shown.at - secondAsked < 60, `shown ${shown.at - secondAsked} ms after its ask`);
    assert.deepEqual(fake.updates.map((u) => u.id), [465, 1, 466]);
    assert.equal(front(), 466);
    await sleep(1500); // (the first's late answers)
  } finally {
    for (const id of [465, 466]) tabShown(id);
    done();
  }
});

test('kick: another switch, to a tab never shown, asked while Safari answers a kick, still has its tab introduced: once the kick is answered (one flip at a time in a window)', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 471, url: 'https://first471.test/' }, { id: 472, url: 'https://new472.test/' }], [472]);
  try {
    noteLeft(471, Date.now() - 10_000);
    suspend(471, { backgroundMs: 1500, shownMs: 5 });
    const second = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (fake.updates.length <= 2) await sleep(150); // the kick
      return answer;
    }, async () => {
      const first = focusTab(471, { source: 'activateTab' });
      await sleep(70);
      const shown = await logged(472, () => focusTab(472, { source: 'activateTab' }));
      await first;
      return shown;
    });
    assert.equal(second.result.tab?.id, 472);
    assert.equal(second.entry.introduced, true);
    assert.deepEqual(fake.updates.map((u) => u.id), [471, 1, 472, 1, 472], 'the kick, the introduction, the show');
    await sleep(1500);
  } finally {
    tabShown(471);
    done();
  }
});

test('kick: a second switch\'s kick waits for a kick of another switch\'s still under way in the window (one at a time), then goes out', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 467, url: 'https://first467.test/' }, { id: 468, url: 'https://second468.test/' }], []);
  try {
    for (const id of [467, 468]) {
      noteLeft(id, Date.now() - 10_000);
      suspend(id, { backgroundMs: 1500, shownMs: 30 });
    }
    let secondAsked = 0;
    const second = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (id === 467 || (id === 1 && fake.updates.length <= 2)) await sleep(150);
      return answer;
    }, async () => {
      const first = focusTab(467, { source: 'activateTab' });
      await sleep(50);
      secondAsked = Date.now();
      const shown = await logged(468, () => focusTab(468, { source: 'activateTab' }));
      await first;
      return shown;
    });
    assert.equal(second.result.tab?.id, 468);
    assert.deepEqual(fake.updates.map((u) => u.id), [467, 1, 468, 1, 468], 'the first kick, the second, the show');
    assert.equal(second.entry.kicked?.outcome, 'resumed');
    assert.ok(fake.updates[2].at - secondAsked >= 130, `kicked ${fake.updates[2].at - secondAsked} ms after its ask (once the first kick was answered)`);
    await sleep(1500);
  } finally {
    for (const id of [467, 468]) tabShown(id);
    done();
  }
});

test('kick: a tab kicked that answers within 60 ms of its wake going out was running after all (`kicked.outcome` awake), and is shown once its page has drawn since the kick (the kick hid its content as it came into the window), not at once', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 469, url: 'https://busy469.test/' }], []);
  try {
    noteLeft(469, Date.now() - 10_000);
    fake.scriptDelay = (_id, func) => (func?.name === 'pageThere' ? 50 : 1); // busy: answers in 50 ms
    const { result, entry } = await logged(469, () => focusTab(469, { source: 'activateTab' }));
    assert.equal(result.tab?.id, 469);
    assert.deepEqual(fake.updates.map((u) => u.id), [469, 1, 469], 'kicked at 40 ms, not knowing');
    assert.equal(entry.kicked?.outcome, 'awake');
    assert.equal(entry.wakeOutcome, 'awake');
    assert.equal(barriers(469).length, 1, 'drawn first, once');
    assert.ok(barriers(469)[0].at >= fake.updates[1].at, 'after the kick');
    assert.equal(entry.layersBack, 'barrier');
  } finally {
    tabShown(469);
    done();
  }
});

test('kick: a switch shown at its page\'s deadline during a kick (Safari slow to answer it) says so in the switch log', async () => {
  const done = await introducing([{ id: 1, url: 'https://a.test/', active: true }, { id: 470, url: 'https://hung470.test/' }], []);
  const entries = [];
  tapLog((entry) => entries.push(entry));
  try {
    noteLeft(470, Date.now() - 10_000);
    suspend(470, { backgroundMs: 4000, shownMs: 4000 });
    const result = await withUpdate(async (update, id, change) => {
      const answer = await update(id, change);
      if (fake.updates.length <= 2) await sleep(1500); // the kick, answered late
      return answer;
    }, () => focusTab(470, { source: 'activateTab', deadline: Date.now() + 2500 }));
    assert.equal(result.forced, true);
    const entry = entries.find((e) => e.kind === 'switch' && e.tabId === 470 && e.forced);
    assert.equal(entry?.stuckAt, 'kick');
    assert.equal(entry.kicked?.outcome, 'under way');
    assert.equal(entry.kicked.kickMs, null);
    await sleep(1600);
  } finally {
    tapLog(null);
    tabShown(470);
    done();
  }
});

test('prewake: the sidebar coming out wakes the same tab at most once in 10 s; a press on its row, or another tab, still wakes', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 338, url: 'https://reveal338.test/' }, { id: 339, url: 'https://reveal339.test/' }]);
  fake.scriptDelay = () => 5;
  try {
    await handlers.prewake({ tabId: 338, hover: true, why: 'reveal' });
    await sleep(1700); // past what its first wake still covers
    await handlers.prewake({ tabId: 338, hover: true, why: 'reveal' });
    await handlers.prewake({ tabId: 339, hover: true, why: 'reveal' });
    await sleep(20);
    assert.equal(scriptsNamed(338, 'pageThere').length, 1, 'brought out again 1.7 s later: not woken again');
    assert.equal(scriptsNamed(339, 'pageThere').length, 1, 'another tab: woken');
    await handlers.prewake({ tabId: 338 });
    await sleep(20);
    assert.equal(scriptsNamed(338, 'pageThere').length, 2, 'a press: woken');
  } finally {
    for (const id of [338, 339]) tabShown(id);
  }
});
