// Which tabs WebKit has seen come into a window with their page running, and
// so keeps the page before on screen for as they're shown (background/tabs.js:
// WebKit's mark), against a fake Safari (as in tests/wake.test.js): a tab not
// proven to have it is introduced before Margin first shows it; and a show
// waits for the tab's layers to be back (a paint since its wake, flip or kick).
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
  // Pages whose main thread is busy until then (fake.busy): every plain
  // script there starts only after it (a hold, keepAwake in the page's own
  // world, isn't one: it doesn't wait in the page's queue once it runs).
  busyUntil: new Map(),
  busy(tabId, until) { this.busyUntil.set(tabId, until); },
  // What a page says as it's asked just before its show (pingInPage): ms
  // since it handled a change of its visibility (null: nothing to say).
  since: () => null,
  // When a page drew after it last became visible (drewInPage; null: it
  // doesn't say, as an earlier copy of Margin's).
  drewAt: () => null,
  // Pages whose world holds a copy's word that their tab is proven
  // (content/core.js inWindowAt: pageThere answers 'proven').
  proven: new Set(),
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
  windows: { get: async (id) => ({ id, state: 'normal', focused: true }), update: async () => {} },
  runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ version: '0', content_scripts: fake.contentScripts }) },
  permissions: { contains: async () => true },
  tabs: {
    // `fake.getMs`: how long Safari takes to answer (a slow Safari).
    get: async (id) => {
      if (fake.getMs) await sleep(fake.getMs);
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
      const busyFor = (fake.busyUntil.get(target.tabId) ?? 0) - Date.now();
      if (busyFor > 0 && !(world === 'MAIN' && func === keepAwake)) return sleep(busyFor).then(() => chrome.scripting.executeScript({ target, world, func, args, files, again: true }));
      const suspended = fake.suspended.get(target.tabId);
      if (suspended) return suspended.wait().then(() => chrome.scripting.executeScript({ target, world, func, args, files, again: true }));
      if (fake.scriptError?.(target.tabId)) return sleep(1).then(() => [{ result: null, error: 'Failed to execute script.' }]);
      const delay = fake.scriptDelay(target.tabId, func);
      if (delay == null) return Promise.reject(new Error('Could not execute script on this tab'));
      if (func?.name === 'readyInPage') return sleep(delay).then(() => readiness(target.tabId, args)).then((result) => [{ result }]);
      if (func?.name === 'paintBarrierInPage') return sleep(delay + fake.barrierMs(target.tabId)).then(() => [{ result: 'drawn' }]);
      const result = func?.name === 'pageThere' && fake.other?.has(target.tabId) ? { there: true, other: true } : func?.name === 'prepareSidebarInPage' ? fake.prepare(args) : func?.name === 'cutOffInPage' ? (fake.cutOff?.(target.tabId, args) ?? { cutOff: false }) : func?.name === 'pageThere' && fake.proven.has(target.tabId) ? 'proven' : func?.name === 'pageThere' && fake.unseen.has(target.tabId) ? 'unseen' : func?.name === 'pageThere' && fake.seen.has(target.tabId) ? 'seen' : func?.name === 'pingInPage' ? { since: fake.since(target.tabId) } : func?.name === 'drewInPage' ? fake.drewAt(target.tabId) : true;
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

const tabsModule = await import('../extension/background/tabs.js');
const { activationsHeard, heardActivation, focusTab, isIntroduction, sawActivation, setIntroductionHooks, tabOpened, tabShown, resetIntroductions, resetRestores, forgetNeverShown, keepAwake } = tabsModule;
const { tapLog } = await import('../extension/background/diagnostics.js');
const { noteLeft, resetKeepReady } = await import('../extension/background/keep-ready.js');
const M = await import('../extension/state/model.js');
const V = await import('../extension/shared/view.js');
const { mutate, load } = await import('../extension/background/store.js');
const { navigate } = await import('../extension/background/navigation.js');
const { handlers } = await import('../extension/background/handlers.js');
const slow = await import('../extension/background/slow.js');
const { madeAfresh: madeAfreshNavigation } = await import('../extension/shared/platform.js');

const front = () => [...fake.tabs.values()].find((t) => t.active && t.windowId === 1)?.id;
const ids = () => fake.updates.map((u) => u.id);
// Margin's state has `id` in front of window 1 (as onActivated left it).
const knownInFront = (id) => mutate((s) => M.activateTab(M.upsertTab(s, fake.tabs.get(id), Date.now()), id, 1, Date.now()));
// Safari has `id` in front of its window.
const putInFront = (id) => { for (const t of fake.tabs.values()) if (t.windowId === fake.tabs.get(id).windowId) t.active = t.id === id; };
// An activation as background.js handles it: introductions' left out, the
// rest heard in order as they come, the tab taken as shown once the state is
// read (`late`: that comes after something else, a page's hello).
function activation(tabId, { late = null } = {}) {
  const info = { tabId, windowId: fake.tabs.get(tabId).windowId };
  if (isIntroduction(info)) return Promise.resolve();
  sawActivation(info);
  heardActivation(info);
  const shown = () => tabShown(tabId);
  return late ? late.then(shown) : Promise.resolve().then(shown);
}
// The user (or Safari) brings `tabId` to the front of its window.
async function select(tabId) {
  putInFront(tabId);
  await activation(tabId);
  await knownInFront(tabId);
}
// A page's hello as background.js passes it on (its place among the
// activations as it came). `doc`: the document's own id; `fresh`: its copy
// started with it; `made`: made from the tab's saved history, or a tab's first
// document; `unseen`: it started visible that way.
const hello = (tabId, { doc = `doc-${tabId}`, fresh = true, made = false, unseen = false, active = fake.tabs.get(tabId).active, heard = activationsHeard() } = {}) =>
  handlers.hello({ ...(unseen ? { unseen: true } : {}), doc, fresh, made, heard }, { tab: { id: tabId, windowId: fake.tabs.get(tabId).windowId, active } });
const inView = (tabId, { doc = `doc-${tabId}`, heard = activationsHeard() } = {}) => handlers.inView?.({ doc, heard }, { tab: { id: tabId, windowId: fake.tabs.get(tabId).windowId } });

function reset(tabs) {
  fake.prepare = (args) => ({ ready: true, token: args?.[0]?.token });
  fake.painted = new Set();
  fake.unseen = new Set();
  fake.seen = new Set();
  fake.oldDocument = new Set();
  fake.barrierMs = () => 20;
  fake.scriptError = null;
  fake.cutOff = null;
  fake.other = null;
  fake.getMs = 0;
  fake.suspended = new Map();
  fake.holdsRun = false;
  fake.busyUntil = new Map();
  fake.since = () => null;
  fake.drewAt = () => null;
  fake.proven = new Set();
  fake.reply = true;
  fake.contentScripts = undefined;
  fake.scriptDelay = () => 1;
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, ...t }]));
  fake.scripts = [];
  fake.updates = [];
  fake.messages = [];
  fake.created = [];
  // Safari's activations for Margin's own updates, as background.js hears them.
  fake.activated = (info) => void activation(info.tabId);
  fake.session = {};
  forgetNeverShown();
  resetIntroductions();
  resetRestores();
  resetKeepReady();
  slow.resetSlow();
  setIntroductionHooks({ activated: null, introduced: null });
}
// Each entry of the switch log while `fn` runs.
async function logged(fn) {
  const entries = [];
  tapLog((e) => entries.push(e));
  try {
    const out = await fn();
    return { out, entries: entries.filter((e) => e.kind === 'switch') };
  } finally {
    tapLog(null);
  }
}
const flipped = (id) => { const u = ids(); return u.length === 3 && u[0] === id && u[2] === id; };

// ---- why five of Tirth's switches on 2026-11-03 weren't introduced ----------

test('a tab Safari restored as it was selected, left before its page started (so the page started hidden), is introduced on Margin\'s next switch to it', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 2, url: 'https://restored.test/' }]);
  await knownInFront(1);
  // Safari selects tab 2 (its tab bar, after a relaunch: no process yet, its
  // view in the window as the process starts), and tab 1 again 0.6 s later.
  await select(2);
  await select(1);
  // Its page's copy starts only now, hidden: made from the tab's saved history.
  await hello(2, { made: true, active: false });
  fake.updates = [];
  const { entries } = await logged(() => focusTab(2));
  assert.ok(flipped(2), `introduced, then shown: ${JSON.stringify(ids())}`);
  assert.equal(entries.at(-1)?.introduced, true);
});

test('a tab Safari restored as it was selected, whose page said hello before the activation that restored it was handled, then came into view from hidden in front (its window covered and uncovered) or went to another page: still introduced', async () => {
  for (const after of ['uncovered', 'redirect']) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://race.test/' }]);
    await knownInFront(1);
    putInFront(3);
    // Its activation heard, its handling (once the state is read) still to come.
    let stateRead = () => {};
    const shownLate = activation(3, { late: new Promise((resolve) => { stateRead = resolve; }) });
    await hello(3, { made: true, unseen: true, active: true });
    await sleep(5);
    stateRead();
    await shownLate;
    await knownInFront(3);
    if (after === 'uncovered') {
      fake.seen.add(3); // its page has come into view from hidden
      await inView(3);
    } else {
      await hello(3, { doc: 'doc-3b', made: false, active: true }); // a script's redirect
    }
    await select(1);
    fake.updates = [];
    const { entries } = await logged(() => focusTab(3));
    assert.ok(flipped(3), `${after}: introduced, then shown: ${JSON.stringify(ids())}`);
    assert.equal(entries.at(-1)?.introduced, true, after);
  }
});

test('a held key passing through a tab not proven to have been in a window doesn\'t show it (passed over: shown as it is, it would be Safari\'s empty view); the tab it stops on is introduced, then shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 20, url: 'https://k1.test/' }, { id: 21, url: 'https://k2.test/' }]);
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 20, 21]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  const s = await load();
  const first = V.cycleTab(s, 1, 1, 1);
  const last = V.cycleTab(s, 1, first, 1);
  // Both warmed behind the page after a relaunch: running, never in front.
  for (const id of [first, last]) await hello(id, { made: true, active: false });
  fake.session.unseenTabs = [first, last]; // the warm-up's own mark until 2026-11-03
  const { entries } = await logged(async () => {
    navigate('next-tab', 'key', 1); // a held key: the presses queue
    await navigate('next-tab', 'key', 1);
  });
  assert.equal(front(), last);
  assert.ok(!ids().includes(first), `the tab passed through not shown: ${JSON.stringify(ids())}`);
  assert.equal(entries.find((e) => e.tabId === first)?.error, 'passed over');
  assert.ok(flipped(last), `the tab it stops on introduced, then shown: ${JSON.stringify(ids())}`);
});

test('with Safari slow, a tab not proven to have been in a window is still introduced before it\'s shown when its page\'s deadline leaves room (its wake answering late, at 1.2 s)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 30, url: 'https://slowwarm.test/' }]);
  await knownInFront(1);
  await hello(30, { made: true, active: false }); // warmed behind
  fake.session.unseenTabs = [30]; // the warm-up's own mark until 2026-11-03
  fake.scriptDelay = (id, func) => (id === 30 && func?.name === 'pageThere' ? 1200 : 1);
  slow.noteCall('tabs.get', 900, 'safari');
  slow.noteCall('tabs.get', 900, 77);
  const asked = Date.now();
  const { entries } = await logged(() => focusTab(30, { deadline: asked + 7000, waitsUntil: asked + 10_000, source: 'activateTab' }));
  assert.ok(flipped(30), `introduced, then shown: ${JSON.stringify(ids())}`);
  assert.equal(entries.at(-1)?.introduced, true, JSON.stringify(entries.at(-1)));
  assert.ok(fake.updates[2].at < asked + 7000 - 1000, 'shown well before its page\'s deadline');
});

// ---- the proof (T1) ------------------------------------------------------------

// Tab `id`, its page running behind (never in front: warmed, opened behind),
// shown by Margin once (introduced, then shown), then left for tab 1 through
// Safari's own tab bar: from here it's proven.
async function proven(id) {
  await hello(id, { made: true, active: false });
  fake.updates = [];
  await focusTab(id);
  assert.ok(flipped(id), `tab ${id}: introduced, then shown: ${JSON.stringify(ids())}`);
  await select(1);
  fake.updates = [];
  fake.scripts = [];
}

test('guard: a tab shown by Margin with its page running is proven: not flipped again on its next return, shown at once with no paint barrier (its page awake)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 40, url: 'https://proven.test/' }]);
  await knownInFront(1);
  await proven(40);
  const started = Date.now();
  const { entries } = await logged(() => focusTab(40));
  assert.deepEqual(ids(), [40], 'shown, not introduced');
  assert.ok(fake.updates[0].at - started < 60, `shown after ${fake.updates[0].at - started} ms`);
  assert.equal(fake.scripts.filter((x) => x.func.name === 'paintBarrierInPage').length, 0, 'nothing drawn first');
  const entry = entries.at(-1);
  assert.equal(entry.introduced, false);
  assert.equal(entry.markReason, 'proven:shown');
  assert.equal(entry.layersBack, 'skipped:running');
});

test('a tab Safari showed itself after its page started (its tab bar), whose page then said it came into view, is proven; one whose page never said so isn\'t', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 41, url: 'https://tabbar.test/' }, { id: 42, url: 'https://nosay.test/' }]);
  await knownInFront(1);
  // 41: behind, then Safari's tab bar: its page comes into view.
  await hello(41, { made: true, active: false });
  await select(41);
  await inView(41);
  await select(1);
  // 42: the same, its page's word lost.
  await hello(42, { made: true, active: false });
  await select(42);
  await select(1);
  for (const [id, introduced] of [[41, false], [42, true]]) {
    fake.updates = [];
    const { entries } = await logged(() => focusTab(id));
    assert.equal(flipped(id), introduced, `tab ${id}: ${JSON.stringify(ids())}`);
    assert.equal(entries.at(-1)?.introduced, introduced, `tab ${id}`);
    if (!introduced) assert.equal(entries.at(-1)?.markReason, 'proven:inView', `tab ${id}`);
    await select(1);
  }
});

test('the tab in front at a launch whose page said it came into view while it stayed in front (its window covered and uncovered) isn\'t proven; once left, back (Safari\'s tab bar) and in view again, it is', async () => {
  for (const back of [false, true]) {
    // A background just started: no activation heard in the window yet.
    reset([{ id: 1, url: 'https://a.test/' }, { id: 43, url: 'https://launchfront.test/', active: true }]);
    await knownInFront(43);
    await hello(43, { made: true, unseen: true, active: true });
    await inView(43); // its window uncovered
    await select(1);
    if (back) {
      await select(43);
      await inView(43);
      await select(1);
    }
    fake.updates = [];
    const { entries } = await logged(() => focusTab(43));
    assert.equal(flipped(43), !back, `${back ? 'back' : 'never left and back'}: ${JSON.stringify(ids())}`);
    assert.equal(entries.at(-1)?.markReason, back ? 'proven:inView' : 'unproven');
  }
});

test('the tab in front at a launch, left, is introduced on Margin\'s first switch back to it; not on the next', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 50, url: 'https://other.test/' }]);
  await knownInFront(1);
  await hello(1, { made: true, unseen: true, active: true });
  await hello(50, { made: true, active: false });
  fake.updates = [];
  await focusTab(50);
  assert.ok(flipped(50), JSON.stringify(ids()));
  fake.updates = [];
  await knownInFront(50);
  const { entries } = await logged(() => focusTab(1));
  assert.deepEqual(ids(), [1, 50, 1], 'tab 1 introduced, then shown');
  assert.equal(entries.at(-1)?.markReason, 'unproven');
  await knownInFront(1);
  for (const id of [50, 1]) {
    fake.updates = [];
    await focusTab(id);
    assert.deepEqual(ids(), [id], `tab ${id}: shown, not introduced`);
    await knownInFront(id);
  }
});

test('the mark is lost when Safari may have made the tab a new web view (a page made from its saved history, a wake finding no page, a page saying it started visible and unseen), and kept through a link in the tab', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 60, url: 'https://keep.test/' }, { id: 61, url: 'https://history.test/' }, { id: 62, url: 'https://nopage.test/' }, { id: 63, url: 'https://unseen.test/' }]);
  await knownInFront(1);
  for (const id of [60, 61, 62, 63]) await proven(id);
  // 60: a link in it (a new document, not made from its history).
  await hello(60, { doc: 'doc-60b', made: false, active: false });
  // 61: Safari unloaded it and made it again from its saved history.
  await hello(61, { doc: 'doc-61b', made: true, active: false });
  // 62: a script finds no page there (Safari unloaded it), then its page is back.
  fake.scriptDelay = (id) => (id === 62 ? null : 1);
  await tabsModule.wakeTab(62, { renew: true });
  fake.scriptDelay = () => 1;
  await hello(62, { doc: 'doc-62b', made: false, active: false });
  // 63: its page says it started visible and hasn't come into view since.
  fake.unseen.add(63);
  for (const [id, introduced] of [[60, false], [61, true], [62, true], [63, true]]) {
    fake.updates = [];
    const { entries } = await logged(() => focusTab(id));
    // (62: restored behind the page first, its wake having found no page.)
    assert.equal(introduced ? JSON.stringify(ids().slice(-3)) === JSON.stringify([id, 1, id]) : JSON.stringify(ids()) === JSON.stringify([id]), true, `tab ${id}: ${JSON.stringify(ids())}`);
    assert.equal(entries.at(-1)?.introduced, introduced, `tab ${id}`);
    fake.unseen.delete(id);
    await select(1);
  }
});

test('a page\'s hello handled only after Margin proved its tab (its handling late) doesn\'t undo the proof; one that came after the proof does', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 64, url: 'https://latehello.test/' }, { id: 65, url: 'https://newpage.test/' }]);
  await knownInFront(1);
  for (const id of [64, 65]) {
    const early = activationsHeard(); // 64's hello as it came, before the switch
    await hello(id, { made: true, active: false, heard: early }); // (a warmed page's own start)
    fake.updates = [];
    await focusTab(id);
    assert.ok(flipped(id), `tab ${id}: ${JSON.stringify(ids())}`);
    await select(1);
    // 64: the same page's hello, handled late (as it came: before the proof).
    // 65: a new page made from its saved history, after the proof.
    await hello(id, id === 64 ? { made: true, active: false, heard: early } : { doc: 'doc-65b', made: true, active: false });
  }
  for (const [id, introduced] of [[64, false], [65, true]]) {
    fake.updates = [];
    await focusTab(id);
    assert.equal(flipped(id), introduced, `tab ${id}: ${JSON.stringify(ids())}`);
    await select(1);
  }
});

test('the marks are kept in storage.session: a background Safari started again knows which tabs are proven, and which aren\'t', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 70, url: 'https://kept.test/' }, { id: 71, url: 'https://notyet.test/' }]);
  await knownInFront(1);
  await proven(70);
  await hello(71, { made: true, active: false });
  await sleep(10);
  forgetNeverShown(); // a new background: what it knew in memory is gone
  for (const [id, introduced] of [[70, false], [71, true]]) {
    fake.updates = [];
    await focusTab(id);
    assert.equal(flipped(id), introduced, `tab ${id}: ${JSON.stringify(ids())}`);
    await select(1);
  }
});

// ---- the layers back before the show (T2) -------------------------------------

const barriersOf = (id) => fake.scripts.filter((x) => x.tabId === id && x.func.name === 'paintBarrierInPage');

test('a tab kicked awake whose page draws slowly after the kick (300 ms) isn\'t shown before its page has drawn since the kick, whether its wake answered at once (running all along) or only once resumed', async () => {
  for (const shownMs of [5, 80]) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 80, url: 'https://kicked.test/' }]);
    await knownInFront(1);
    await proven(80);
    noteLeft(80, Date.now() - 10_000);
    suspend(80, { shownMs });
    // Its page draws 300 ms after the kick (busy with its resume).
    const kickAt = () => fake.updates.find((u) => u.id === 80)?.at ?? Date.now();
    fake.barrierMs = (id) => (id === 80 ? Math.max(20, kickAt() + 300 - Date.now()) : 20);
    const { entries } = await logged(() => focusTab(80, { source: 'activateTab' }));
    const entry = entries.at(-1);
    assert.equal(entry.kicked?.outcome, shownMs > 60 ? 'resumed' : 'awake', JSON.stringify(entry));
    const kickBack = fake.updates[1].at;
    const show = fake.updates.at(-1);
    assert.equal(show.id, 80);
    assert.ok(show.at - kickBack >= 290, `shown ${show.at - kickBack} ms after the kick: its page drew first`);
    assert.equal(entry.barrier.at(-1).how, 'drawn', JSON.stringify(entry.barrier));
    assert.equal(entry.layersBack, 'barrier');
  }
});

test('a tab introduced whose page draws slowly (500 ms an update) isn\'t shown when its barrier runs out (400 ms): drawn under the cover, then shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 81, url: 'https://slowdraw.test/' }]);
  await knownInFront(1);
  await hello(81, { made: true, active: false });
  // Its page draws 500 ms after its introduction (busy).
  const flipAt = () => fake.updates.find((u) => u.id === 81)?.at ?? Date.now();
  fake.barrierMs = (id) => (id === 81 ? Math.max(20, flipAt() + 500 - Date.now()) : 20);
  const { entries } = await logged(() => focusTab(81));
  assert.ok(flipped(81), JSON.stringify(ids()));
  const entry = entries.at(-1);
  assert.ok(fake.updates[2].at - fake.updates[1].at >= 490, `shown ${fake.updates[2].at - fake.updates[1].at} ms after its introduction`);
  assert.deepEqual(entry.barrier.map((b) => b.how), ['timeout', 'drawn']);
  assert.equal(entry.layersBack, 'barrier');
});

test('a click whose tab\'s wake hasn\'t answered by 1.6 s (no kick: not known left this session) waits on under the cover while its page\'s deadline leaves room, then is drawn and shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 82, url: 'https://capped.test/' }]);
  await knownInFront(1);
  await proven(82);
  resetKeepReady(); // not known left in this session: no kick
  suspend(82, { backgroundMs: 2500 });
  const asked = Date.now();
  const { entries } = await logged(() => focusTab(82, { source: 'activateTab', deadline: asked + 7000, waitsUntil: asked + 10_000 }));
  const entry = entries.at(-1);
  assert.deepEqual(ids(), [82], 'shown once (no kick, no introduction)');
  assert.ok(fake.updates[0].at - asked >= 2500, `shown ${fake.updates[0].at - asked} ms after the ask, after its wake answered`);
  assert.equal(entry.wakeOutcome, 'resumed', JSON.stringify(entry));
  assert.equal(entry.layersBack, 'barrier');
});

test('a click with Safari slow, its tab\'s page never drawing in time: still shown and answered before its page\'s deadline', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 83, url: 'https://never.test/' }]);
  await knownInFront(1);
  await proven(83);
  resetKeepReady();
  fake.scriptDelay = (id, func) => (id === 83 && func?.name === 'pageThere' ? 300 : 1); // resumed behind as it's asked
  fake.barrierMs = (id) => (id === 83 ? 60_000 : 20);
  slow.noteCall('tabs.get', 900, 'safari');
  slow.noteCall('tabs.get', 900, 77);
  const asked = Date.now();
  const deadline = asked + 7000;
  const { out, entries } = await logged(() => focusTab(83, { source: 'activateTab', deadline, waitsUntil: deadline + 3000 }));
  const answered = Date.now();
  assert.equal(out.tab?.id, 83);
  assert.equal(front(), 83);
  assert.ok(answered < deadline - 700, `answered ${deadline - answered} ms before the deadline`);
  const entry = entries.at(-1);
  assert.match(String(entry.layersBack ?? entry.stuckAt), /timeout|barrier|skipped/);
});

test('guard: a held key passing through a proven tab whose page answers at once still shows it in passing', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 90, url: 'https://p1.test/' }, { id: 91, url: 'https://p2.test/' }]);
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 90, 91]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  const s = await load();
  const first = V.cycleTab(s, 1, 1, 1);
  const last = V.cycleTab(s, 1, first, 1);
  await proven(first);
  await proven(last);
  await knownInFront(1);
  navigate('next-tab', 'key', 1);
  await navigate('next-tab', 'key', 1);
  assert.equal(front(), last);
  assert.deepEqual(ids(), [first, last], 'both shown, neither introduced');
});

// ---- review of 2026-11-04 ----------------------------------------------------

test('with Safari slow, a switch held up by Margin\'s own steps (a storage read slow as a background starts), not by its tab\'s page, is still shown by the slow plan, about 2 s after the ask: only the time spent waiting for the page is left out of that plan', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 2, url: 'https://b.test/' }]);
  await knownInFront(1);
  await proven(2);
  resetIntroductions(); // (a background just started: what it keeps in storage.session read again)
  slow.noteCall('tabs.get', 900, 'safari');
  slow.noteCall('tabs.get', 900, 77);
  fake.sessionMs = 4000;
  try {
    const asked = Date.now();
    const { entries } = await logged(() => focusTab(2, { source: 'activateTab', deadline: asked + 7000, waitsUntil: asked + 10_000 }));
    const show = fake.updates.filter((u) => u.id === 2).at(-1);
    const entry = entries.at(-1);
    assert.ok(show && show.at - asked < 2600, `shown ${show ? show.at - asked : null} ms after the ask: ${JSON.stringify(entry)}`);
    assert.equal(entry.forced, true);
    assert.ok(entry.pageWaitedMs < 300, `${entry.pageWaitedMs} ms of it spent waiting for the page`);
  } finally {
    fake.sessionMs = 0;
    await sleep(4100); // (the slow reads out)
  }
});

test('guard: with Safari slow, a switch waiting for its tab\'s own page (a process resumed at background priority, 2.6 s) waits past the slow plan, and the tab is drawn, then shown, before the page\'s deadline', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  await knownInFront(1);
  await proven(3);
  resetKeepReady(); // not known left in this session: no kick
  suspend(3, { backgroundMs: 2600 });
  slow.noteCall('tabs.get', 900, 'safari');
  slow.noteCall('tabs.get', 900, 77);
  const asked = Date.now();
  const { entries } = await logged(() => focusTab(3, { source: 'activateTab', deadline: asked + 7000, waitsUntil: asked + 10_000 }));
  const entry = entries.at(-1);
  assert.deepEqual(ids(), [3]);
  assert.ok(fake.updates[0].at - asked >= 2600, `shown ${fake.updates[0].at - asked} ms after the ask`);
  assert.equal(entry.forced, undefined, JSON.stringify(entry));
  assert.equal(entry.layersBack, 'barrier');
});

test('an introduction whose switch was given up (another row clicked), then Safari unloading the tab: once it\'s restored behind the page, it\'s introduced before it\'s shown (the earlier introduction was for the web view before)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 5, url: 'https://e.test/' }]);
  await knownInFront(1);
  tabOpened({ id: 5, active: false });
  await hello(5, { made: true, active: false });
  let once = true;
  setIntroductionHooks({ activated: null, introduced: (id) => { if (id === 5 && once) { once = false; void focusTab(1).catch(() => {}); } } });
  const first = await focusTab(5);
  setIntroductionHooks({ activated: null, introduced: null });
  assert.equal(first.superseded, true);
  assert.deepEqual(ids(), [5, 1], 'introduced, then given up');
  tabsModule.forgetWake(5);
  // Safari unloads it: no page; selected, it loads (its new page says hello).
  let noPage = true;
  fake.scriptDelay = (id) => (id === 5 && noPage ? null : 1);
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, change) => {
    const answer = await update(id, change);
    if (id === 5 && change.active && noPage) {
      noPage = false;
      fake.tabs.get(5).status = 'loading';
      setTimeout(() => {
        fake.tabs.get(5).status = 'complete';
        void hello(5, { doc: 'doc-5b', made: true, active: fake.tabs.get(5).active });
      }, 100);
    }
    return answer;
  };
  try {
    fake.updates = [];
    const { entries } = await logged(() => focusTab(5));
    const entry = entries.at(-1);
    assert.equal(entry.restored, 'loaded', JSON.stringify(entry));
    assert.deepEqual(ids(), [5, 1, 5, 1, 5], 'restored behind, introduced, then shown');
    assert.equal(entry.introduced, true, JSON.stringify(entry));
  } finally {
    chrome.tabs.update = update;
  }
});

test('a click to a tab not proven to have been in a window, suspended, whose page said hello this session but that Margin never saw left (a tab Safari restored as it was selected, one the warm-up loaded): kicked at once, the kick its introduction, drawn, then shown, not after its background resume', async () => {
  for (const kind of ['restored as selected', 'warmed']) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 8, url: 'https://h.test/' }]);
    await knownInFront(1);
    if (kind === 'warmed') await hello(8, { made: true, active: false });
    else {
      await hello(8, { made: true, unseen: true, active: true });
      putInFront(8); await activation(8); await knownInFront(8);
      await select(1);
    }
    resetKeepReady(); // (a background started since: not known left)
    suspend(8, { backgroundMs: 3000, shownMs: 5 });
    const asked = Date.now();
    const { entries } = await logged(() => focusTab(8, { source: 'activateTab', deadline: asked + 7000, waitsUntil: asked + 10_000 }));
    const entry = entries.at(-1);
    assert.deepEqual(ids(), [8, 1, 8], `${kind}: one flip (the kick), then the show`);
    assert.ok(fake.updates[2].at - asked < 1000, `${kind}: shown ${fake.updates[2].at - asked} ms after the ask`);
    assert.equal(entry.introduced, true, JSON.stringify(entry));
    assert.equal(entry.markReason, 'unproven:kicked');
    assert.equal(entry.layersBack, 'barrier');
  }
});

test('a key (no page waiting for it) to a warmed tab, suspended, whose background resume takes 2.5 s: kicked, drawn, then shown, not shown as it is at 1.6 s', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 20, url: 'https://k1.test/' }]);
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, 20]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  await hello(20, { made: true, active: false });
  suspend(20, { backgroundMs: 2500 });
  const asked = Date.now();
  const { entries } = await logged(() => navigate('next-tab', 'key', 1));
  const entry = entries.at(-1);
  assert.deepEqual(ids(), [20, 1, 20], JSON.stringify(entry));
  assert.ok(fake.updates[2].at - asked < 1000, `shown ${fake.updates[2].at - asked} ms after the key`);
  assert.equal(entry.layersBack, 'barrier');
  assert.equal(entry.introduced, true);
});

test('a tab never shown, suspended: kicked as its introduction (once: not flipped again after it), drawn, then shown, not after its background resume', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 12, url: 'https://l.test/' }]);
  await knownInFront(1);
  tabOpened({ id: 12, active: false });
  await hello(12, { made: true, active: false });
  suspend(12, { backgroundMs: 3000, shownMs: 5 });
  const asked = Date.now();
  const { entries } = await logged(() => focusTab(12, { source: 'activateTab', deadline: asked + 7000, waitsUntil: asked + 10_000 }));
  const entry = entries.at(-1);
  assert.deepEqual(ids(), [12, 1, 12], JSON.stringify(entry));
  assert.ok(fake.updates[2].at - asked < 1000, `shown ${fake.updates[2].at - asked} ms after the ask`);
  assert.equal(entry.markReason, 'never shown:kicked');
  assert.equal(entry.introduced, true);
});

test('a tab not proven, suspended, that can\'t be kicked (no page of it known to Margin: none said hello this session), whose wake doesn\'t answer: its wait ends with room left for its introduction, which resumes it; drawn, then shown, never shown as it is (a click, and a key)', async () => {
  for (const kind of ['click', 'key']) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 21, url: 'https://w.test/' }]);
    await mutate(() => {
      let st = M.defaultState();
      for (const id of [1, 21]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
      return M.activateTab(st, 1, 1, Date.now());
    });
    suspend(21, { backgroundMs: 6000, shownMs: 5 });
    const asked = Date.now();
    const deadline = asked + 7000;
    const { entries } = await logged(() => (kind === 'click' ? focusTab(21, { source: 'activateTab', deadline, waitsUntil: deadline + 3000 }) : navigate('next-tab', 'key', 1)));
    const entry = entries.at(-1);
    assert.deepEqual(ids(), [21, 1, 21], `${kind}: ${JSON.stringify(entry)}`);
    assert.equal(entry.kicked, undefined, kind);
    assert.equal(entry.introduced, true, kind);
    assert.equal(entry.layersBack, 'barrier', kind);
    const flipAt = fake.updates[0].at - asked;
    if (kind === 'click') assert.ok(flipAt <= 7000 - 1800 - 500, `introduced ${flipAt} ms after the ask: room left for it`);
    else assert.ok(flipAt >= 1550 && flipAt < 1800, `introduced ${flipAt} ms after the key`);
  }
});

test('a proof from before the Mac\'s clock was set back doesn\'t outlast a new web view: a background started again after that takes a new page made afresh as unmarked', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 9, url: 'https://i.test/' }]);
  await knownInFront(1);
  await proven(9);
  await sleep(20);
  assert.equal(fake.session.inWindowTabs?.tabs?.find(([id]) => id === 9)?.[1]?.marked, true);
  const realNow = Date.now;
  Date.now = () => realNow() - 60_000;
  try {
    const restarted = await import(`../extension/background/tabs.js?restart=${realNow()}`);
    restarted.pageStarted(9, { made: true, fresh: true, doc: 'doc-9-new', heard: restarted.activationsHeard(), active: false });
    await sleep(20);
    const rec = fake.session.inWindowTabs?.tabs?.find(([id]) => id === 9)?.[1];
    assert.equal(rec?.doc, 'doc-9-new');
    assert.equal(rec?.marked, false, JSON.stringify(rec));
  } finally {
    Date.now = realNow;
  }
});

test('a page that came into view is told once its tab is proven with it in it (it stops saying so); not before, nor for another page of the tab', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 14, url: 'https://n.test/' }]);
  await knownInFront(1);
  await hello(14, { made: true, active: false });
  assert.equal(await inView(14, { doc: 'doc-other' }), false, 'another page of the tab');
  assert.equal(await inView(14), true, 'out of the window from its start, then in view: proven');
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 15, url: 'https://o.test/' }]);
  await knownInFront(1);
  await hello(15, { made: true, unseen: true, active: true });
  assert.equal(await inView(15), false, 'in front from its start, never left: not proven');
});

test('a reload doesn\'t make a page count as a new web view, whatever the tab\'s history; a page from the tab\'s saved history, or a tab\'s first, does', () => {
  assert.equal(madeAfreshNavigation('reload', 1), false);
  assert.equal(madeAfreshNavigation('reload', 4), false);
  assert.equal(madeAfreshNavigation('back_forward', 3), true);
  assert.equal(madeAfreshNavigation('navigate', 1), true);
  assert.equal(madeAfreshNavigation(undefined, 1), true);
  assert.equal(madeAfreshNavigation('navigate', 2), false);
});

test('the new-tab hand-off (no wake: its page answered a moment ago) to a tab not proven says so in the switch log; it isn\'t introduced (its palette is open on it)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 2, url: 'https://new.test/' }]);
  await knownInFront(1);
  await hello(1, { made: true, unseen: true, active: true }); // in front at a launch: not proven
  await select(2); // ⌘T: the new tab in front
  const { entries } = await logged(() => focusTab(1, { wake: false, source: 'new tab hand-off' }));
  const entry = entries.at(-1);
  assert.deepEqual(ids(), [1]);
  assert.equal(entry.introduced, false);
  assert.equal(entry.markReason, 'unproven:skipped:no wake');
});

// ---- the proof run of 2026-11-04: the show once its page is free (S1), a
// flip's own word that it drew (S2), the proof in the page's world (S3) ------

const named = (id, name) => fake.scripts.filter((x) => x.tabId === id && x.func.name === name);
// Three tabs in the sidebar's order, 1 in front: [first, last] after it.
async function threeTabs(ids) {
  await mutate(() => {
    let st = M.defaultState();
    for (const id of [1, ...ids]) st = M.upsertTab(st, { ...fake.tabs.get(id), index: id }, Date.now());
    return M.activateTab(st, 1, 1, Date.now());
  });
  const s = await load();
  const first = V.cycleTab(s, 1, 1, 1);
  return [first, V.cycleTab(s, 1, first, 1)];
}

test('S1: a page whose main thread stalls after its preparation answered isn\'t shown until it answers one more look, sent after every other script of the switch (Instagram, 2026-11-04: 2.05 s of Safari\'s empty view)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 100, url: 'https://stall.test/' }]);
  await knownInFront(1);
  await proven(100);
  let stalledAt = null;
  fake.prepare = (args) => {
    stalledAt = Date.now();
    fake.busy(100, stalledAt + 600);
    return { ready: true, token: args?.[0]?.token };
  };
  const { entries } = await logged(() => focusTab(100));
  const show = fake.updates.find((u) => u.id === 100);
  assert.ok(show && show.at - stalledAt >= 590, `shown ${show ? show.at - stalledAt : null} ms into the stall`);
  const before = fake.scripts.filter((x) => x.tabId === 100 && x.world !== 'MAIN' && x.at <= show.at);
  assert.equal(before.at(-1).func.name, 'pingInPage', `the last script before the show: ${before.map((x) => x.func.name)}`);
  const entry = entries.at(-1);
  assert.equal(entry.gate?.outcome, 'free', JSON.stringify(entry.gate));
  assert.ok(entry.gate.pings[0].ms >= 590, 'the first look waited out the stall');
  assert.ok(entry.gate.safari?.ms != null && entry.gate.safari.ms < 100, 'Safari answered a call about no page at once: this page, not Safari');
});

test('S1: a page free as it\'s shown pays one look, and nothing else waits', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 101, url: 'https://free.test/' }]);
  await knownInFront(1);
  await proven(101);
  const started = Date.now();
  const { entries } = await logged(() => focusTab(101));
  assert.deepEqual(ids(), [101]);
  assert.equal(named(101, 'pingInPage').length, 1);
  assert.equal(named(1, 'pingInPage').length, 0, 'the page in front not asked');
  assert.ok(fake.updates[0].at - started < 60, `shown after ${fake.updates[0].at - started} ms`);
  assert.equal(entries.at(-1).gate?.pings.length, 1);
});

test('S1: a page that handled a change of its visibility just before (under 150 ms) is asked once more after that, then shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 102, url: 'https://settling.test/' }]);
  await knownInFront(1);
  await proven(102);
  let first = null;
  fake.since = (id) => {
    if (id !== 102) return null;
    first ??= Date.now();
    return Date.now() - first + 30; // it handled being hidden 30 ms before the first look
  };
  const { entries } = await logged(() => focusTab(102));
  const gate = entries.at(-1).gate;
  assert.equal(gate.outcome, 'free');
  assert.equal(gate.pings.length, 2, JSON.stringify(gate));
  assert.ok(gate.pings[1].since >= 150, JSON.stringify(gate));
  assert.ok(fake.updates[0].at - first >= 115, 'shown once that change was 150 ms behind');
});

test('S1: Margin\'s holds still running in the page (keep-ready\'s, a wake\'s) don\'t hold up the look before the show', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 103, url: 'https://held.test/' }]);
  await knownInFront(1);
  await proven(103);
  fake.holdsRun = true;
  void tabsModule.holdTab(103, 60_000, 'kept');
  await sleep(10);
  const started = Date.now();
  const { entries } = await logged(() => focusTab(103));
  assert.deepEqual(ids(), [103]);
  assert.ok(fake.updates[0].at - started < 60, `shown after ${fake.updates[0].at - started} ms`);
  assert.equal(entries.at(-1).gate?.outcome, 'free');
});

test('S1: a slow page with Safari as slow (a call about no page unanswered 250 ms) is Safari slow: shown then, without waiting for the page (the plan for a slow Safari); a page in front as slow doesn\'t count (review, 2026-11-04)', async () => {
  for (const how of ['page', 'safari', 'front']) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 104, url: 'https://slowlook.test/' }]);
    await knownInFront(1);
    await proven(104);
    let stalledAt = null;
    fake.prepare = (args) => {
      stalledAt = Date.now();
      fake.busy(104, stalledAt + 1500);
      if (how === 'safari') fake.getMs = 2000;
      if (how === 'front') fake.busy(1, stalledAt + 3000);
      return { ready: true, token: args?.[0]?.token };
    };
    const { entries } = await logged(() => focusTab(104));
    const gate = entries.at(-1).gate;
    const show = fake.updates.find((u) => u.id === 104);
    assert.equal(gate.outcome, how === 'safari' ? 'slow safari' : 'free', `${how}: ${JSON.stringify(gate)}`);
    if (how === 'safari') {
      assert.ok(show.at - stalledAt < 600, `${how}: shown ${show.at - stalledAt} ms into the stall, not waited for`);
      assert.equal(gate.pings[0].ms, null, 'the page\'s look still out');
    } else assert.ok(show.at - stalledAt >= 1490, `${how}: shown ${show.at - stalledAt} ms into the stall`);
    assert.deepEqual(ids().filter((id) => id === 104), [104]);
  }
});

test('S1: a page that answers every look slowly (busy but running) is asked 3 times at most, then shown', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 109, url: 'https://slowly.test/' }]);
  await knownInFront(1);
  await proven(109);
  let gating = false;
  fake.prepare = (args) => { gating = true; return { ready: true, token: args?.[0]?.token }; };
  fake.scriptDelay = (id, func) => (id === 109 && gating && func?.name === 'pingInPage' ? 150 : 1);
  const { entries } = await logged(() => focusTab(109));
  const gate = entries.at(-1).gate;
  assert.equal(gate.outcome, 'answered', JSON.stringify(gate));
  assert.equal(gate.pings.length, 3);
  assert.equal(named(109, 'pingInPage').length, 3);
  assert.deepEqual(ids(), [109]);
});

test('S1: a later key press gives the show of a busy page up: the tab stays behind, the page before stays in front meanwhile, and the next press goes on from that tab', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 105, url: 'https://k1.test/' }, { id: 106, url: 'https://k2.test/' }]);
  const [first, last] = await threeTabs([105, 106]);
  await proven(first);
  await proven(last);
  await knownInFront(1);
  fake.prepare = (args) => {
    if (args?.[0]?.tabId === first) fake.busy(first, Date.now() + 2000);
    return { ready: true, token: args?.[0]?.token };
  };
  const { entries } = await logged(async () => {
    const one = navigate('next-tab', 'key', 1);
    await sleep(300); // the first press's show waiting for its page
    assert.equal(front(), 1, 'the page before still in front');
    await navigate('next-tab', 'key', 1);
    await one;
  });
  assert.equal(front(), last);
  assert.ok(!fake.updates.some((u) => u.id === first && u.change.active), `${first} never shown: ${JSON.stringify(ids())}`);
  const given = entries.find((e) => e.tabId === first);
  assert.equal(given?.hurried, true, JSON.stringify(given));
  assert.equal(given?.gate?.outcome, 'hurried');
  assert.equal(fake.tabs.get(first).active, false, 'left behind');
});

test('S1: a click to a page that never answers its last look is shown as it is at its page\'s deadline (FORCE_SHOW_MS before it), not before', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 107, url: 'https://hung.test/' }]);
  await knownInFront(1);
  await proven(107);
  fake.prepare = (args) => { fake.busy(107, Date.now() + 20_000); return { ready: true, token: args?.[0]?.token }; };
  const asked = Date.now();
  const deadline = asked + 7000;
  const { out, entries } = await logged(() => focusTab(107, { source: 'activateTab', deadline, waitsUntil: deadline + 3000 }));
  assert.equal(out.tab?.id, 107);
  const shownAt = fake.updates.find((u) => u.id === 107).at - asked;
  assert.ok(shownAt >= 5400 && shownAt < 5800, `shown ${shownAt} ms after the click`);
  const entry = entries.at(-1);
  assert.equal(entry.forced, true, JSON.stringify(entry));
  assert.equal(entry.stuckAt, 'ping');
});

test('S1: a key\'s switch to a page that never answers is shown at its limit (3 s from the press, then 1 s for the look already out), as it is', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 108, url: 'https://hungkey.test/' }]);
  await knownInFront(1);
  await proven(108);
  fake.prepare = (args) => { fake.busy(108, Date.now() + 20_000); return { ready: true, token: args?.[0]?.token }; };
  const asked = Date.now();
  const { entries } = await logged(() => focusTab(108, { source: 'next-tab' }));
  const shownAt = fake.updates.find((u) => u.id === 108).at - asked;
  assert.ok(shownAt >= 3900 && shownAt < 4300, `shown ${shownAt} ms after the press`);
  assert.equal(entries.at(-1).gate?.outcome, 'limit');
});

test('S2: a tab introduced whose page says it drew after the flip (its first rendering update once visible) isn\'t held for two more rendering updates: shown a moment after that word, with one look', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 110, url: 'https://drew.test/' }]);
  await knownInFront(1);
  await hello(110, { made: true, active: false }); // not proven: introduced
  fake.barrierMs = (id) => (id === 110 ? 800 : 20); // two updates of a page hidden again: slow
  fake.drewAt = (id) => {
    const flip = fake.updates.find((u) => u.id === 110)?.at;
    return id === 110 && flip != null ? flip + 5 : null;
  };
  const { entries } = await logged(() => focusTab(110));
  assert.ok(flipped(110), JSON.stringify(ids()));
  const gap = fake.updates[2].at - fake.updates[1].at;
  assert.ok(gap >= 50 && gap < 300, `shown ${gap} ms after its introduction`);
  const entry = entries.at(-1);
  assert.equal(entry.layersBack, 'drew', JSON.stringify(entry));
  assert.equal(entry.barrier[0].how, 'drew');
  assert.ok(entry.drewVisible >= 0 && entry.drewVisible < 50, JSON.stringify(entry));
  assert.ok(entry.flip && entry.flip.forwardMs != null && entry.flip.backMs != null, JSON.stringify(entry.flip));
});

test('S2: a page that says nothing of its drawing (an earlier copy), or a drawing from before the flip, gets the barrier as before', async () => {
  for (const kind of ['silent', 'before the flip']) {
    reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 111, url: 'https://old.test/' }]);
    await knownInFront(1);
    await hello(111, { made: true, active: false });
    const asked = Date.now();
    fake.drewAt = (id) => (kind === 'silent' || id !== 111 ? null : asked - 100);
    fake.barrierMs = (id) => (id === 111 ? 60 : 20);
    const { entries } = await logged(() => focusTab(111));
    assert.ok(flipped(111), `${kind}: ${JSON.stringify(ids())}`);
    const entry = entries.at(-1);
    assert.equal(entry.layersBack, 'barrier', `${kind}: ${JSON.stringify(entry)}`);
    assert.equal(entry.barrier.at(-1).how, 'drawn', kind);
    assert.ok(fake.updates[2].at - fake.updates[1].at >= 60, `${kind}: drawn first`);
  }
});

test('S3: a tab Margin has no record of whose page\'s world says it was proven (a copy before this one told it so) is shown at once, not introduced', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 120, url: 'https://kept.test/' }, { id: 121, url: 'https://silent.test/' }]);
  await knownInFront(1);
  fake.proven.add(120);
  for (const [id, introduced] of [[120, false], [121, true]]) {
    fake.updates = [];
    const { entries } = await logged(() => focusTab(id));
    assert.equal(flipped(id), introduced, `tab ${id}: ${JSON.stringify(ids())}`);
    if (!introduced) assert.deepEqual(ids(), [id]);
    const entry = entries.at(-1);
    assert.equal(entry.introduced, introduced, `tab ${id}`);
    assert.equal(entry.markReason, introduced ? 'unproven' : 'proven:page', `tab ${id}`);
    await select(1);
  }
});

test('S3: a page is told as it says hello whether its tab is proven with it in it (it keeps that in its world): a link in a proven tab is, a page made from the tab\'s saved history isn\'t', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 122, url: 'https://link.test/' }]);
  await knownInFront(1);
  await proven(122);
  assert.equal((await hello(122, { doc: 'doc-122b', made: false, active: false }))?.proven, true, 'a link');
  assert.equal((await hello(122, { doc: 'doc-122c', made: true, active: false }))?.proven, false, 'made afresh');
});

// Review of 2026-11-04 (S3): the hello isn't held for that word on a
// background just started (its storage slow): answered at once, and the word
// written into the page's world once its tab's record is read.
test('S3: a hello whose tab\'s record isn\'t read yet is answered at once, and the page is told it\'s proven once it is', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 123, url: 'https://cold.test/' }]);
  await knownInFront(1);
  await proven(123);
  await sleep(50); // its record written
  forgetNeverShown(); // a background started again: the records read again
  fake.sessionMs = 300;
  try {
    const at = Date.now();
    const answer = await hello(123, { doc: 'doc-123b', made: false, active: false });
    assert.ok(Date.now() - at < 100, `answered after ${Date.now() - at} ms`);
    assert.equal(answer?.proven, false, 'not known yet');
    await sleep(400);
    const told = fake.scripts.filter((x) => x.tabId === 123 && x.func.name === 'provenInPage');
    assert.deepEqual(told.map((x) => x.args), [['doc-123b']], 'told once known, that document only');
  } finally {
    fake.sessionMs = 0;
  }
});

// Review of 2026-11-04 (S5): a cut-off tab woken before the switch to it (a
// pointer resting on its row, the key run's wake ahead: its world another
// copy's) is a suspect, and the switch to it used to load it again 150 ms
// before its show, the load committing in front. Now its dead Margin is put
// out of sight in the switch's one probe, before the show, and it's loaded
// again once it's left, behind.
test('S5: a cut-off tab a switch goes to is never loaded again as it\'s shown: put out of sight before its show, loaded again once it\'s left', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 300, url: 'https://cut.test/' }]);
  await knownInFront(1);
  await proven(300);
  fake.other = new Set([300]);
  fake.cutOff = (tabId) => (tabId === 300 ? { cutOff: true, busy: false, hidden: true, proven: false } : { cutOff: false });
  await tabsModule.wakeTab(300, { by: 'hover' });
  await sleep(100); // the probe the wake set off answers: a suspect
  const probes = () => fake.scripts.filter((x) => x.tabId === 300 && x.func.name === 'cutOffInPage').length;
  await tabsModule.wakeTab(300, { by: 'hover' });
  await sleep(50);
  assert.equal(probes(), 1, 'a suspect isn\'t asked again by each wake');
  fake.updates = [];
  fake.scripts = [];
  await focusTab(300);
  await sleep(300);
  const loads = () => fake.updates.filter((u) => u.id === 300 && (u.change.url || u.change.reload));
  const show = fake.updates.find((u) => u.id === 300 && u.change.active);
  assert.ok(show, 'shown');
  assert.deepEqual(loads(), [], 'not loaded again as it\'s shown');
  const quiet = fake.scripts.find((x) => x.tabId === 300 && x.func.name === 'cutOffInPage' && x.args[1] === true);
  assert.ok(quiet && quiet.at <= show.at, 'its dead sidebar put out of sight before its show');
  // Left: loaded again, behind.
  await select(1);
  await sleep(700);
  assert.equal(loads().length, 1, JSON.stringify(fake.updates));
  assert.equal(loads()[0].change.active, undefined, 'a load, not a show');
});

// Review of 2026-11-04 (S1): a press that gives a busy tab's show up goes on
// from that tab however long its gate held the switch (NAV_CHAIN_MS is 1.5 s
// from the press; a key's gate holds up to 4 s), not from the tab in front,
// which came back to the same busy tab.
test('S1: a press 1.8 s into a busy tab\'s gate gives its show up and goes on from it', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 140, url: 'https://busy.test/' }, { id: 141, url: 'https://next.test/' }]);
  const [first, last] = await threeTabs([140, 141]);
  await proven(first);
  await proven(last);
  await knownInFront(1);
  fake.prepare = (args) => {
    if (args?.[0]?.tabId === first) fake.busy(first, Date.now() + 10_000);
    return { ready: true, token: args?.[0]?.token };
  };
  const { entries } = await logged(async () => {
    const one = navigate('next-tab', 'key', 1);
    await sleep(1800);
    assert.equal(front(), 1, 'still waiting on the busy tab');
    const two = navigate('next-tab', 'key', 1);
    await one;
    await two;
  });
  assert.equal(front(), last, JSON.stringify(entries.map((e) => [e.tabId, e.gate?.outcome, e.hurried])));
  assert.ok(!fake.updates.some((u) => u.id === first && u.change.active), 'the busy tab never shown');
});

// Review of 2026-11-04 (S1): a tab whose wake isn't answered by the cap is
// shown as it is (its show resumes a suspended process), but one whose page
// answered a wake moments before is running and stalled: shown, it would be
// the empty view. Its show waits for its page as any.
test('S1: a tab capped at its wake that answered one moments before (stalled, not suspended) waits for its page before its show', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 107, url: 'https://stalled.test/' }]);
  await knownInFront(1);
  await proven(107);
  await tabsModule.wakeTab(107, { by: 'hover' });
  tabsModule.forgetWake(107); // (its answer gone by the switch: it wakes it again)
  fake.busy(107, Date.now() + 2600);
  const started = Date.now();
  const { entries } = await logged(() => focusTab(107));
  const show = fake.updates.find((u) => u.id === 107 && u.change.active);
  assert.ok(show.at - started >= 2550, `shown ${show.at - started} ms after the ask, its page still stalled`);
  const entry = entries.at(-1);
  assert.equal(entry.wakeOutcome, 'capped');
  assert.equal(entry.gate?.stalled, true, JSON.stringify(entry.gate));
  assert.equal(entry.gate?.outcome, 'free');
  // (One that answered nothing lately, a process Safari suspended, is shown at
  // the cap as before: tests/wake.test.js.)
});

// Review of 2026-11-04 (S2): the page's word that it drew since its flip
// counts from Safari's answer to the flip, as the flip's hide does
// (hidePending), not from when it went out: with Safari answering the flip's
// updates late (about 110 ms for the two in Safari's log), the hide was still
// taken as pending after the word, and a held key refused the tab
// (passable), where a paint barrier that drew cleared it.
test('S2: after the page\'s word that it drew since its flip, its hide is over, with Safari slow to answer the flip as with a barrier that drew', async () => {
  const results = {};
  const update = chrome.tabs.update;
  chrome.tabs.update = (id, change) => sleep(50).then(() => update(id, change));
  try {
    for (const kind of ['barrier drew', 'page said it drew']) {
      const id = kind === 'barrier drew' ? 120 : 121;
      reset([{ id: 1, url: 'https://a.test/', active: true }, { id, url: `https://t${id}.test/` }]);
      await knownInFront(1);
      await hello(id, { made: true, active: false }); // not proven: introduced
      fake.barrierMs = (t) => (t === id && kind === 'page said it drew' ? 800 : 20);
      fake.drewAt = (t) => {
        const flip = fake.updates.find((u) => u.id === id)?.at;
        return kind === 'page said it drew' && t === id && flip != null ? flip + 5 : null;
      };
      const { entries } = await logged(() => focusTab(id));
      assert.ok(flipped(id), JSON.stringify(ids()));
      results[kind] = { layersBack: entries.at(-1).layersBack, passable: await tabsModule.passable(id, { outcome: 'awake', ms: 1, startedAt: Date.now() }) };
    }
  } finally {
    chrome.tabs.update = update;
  }
  assert.deepEqual(results, { 'barrier drew': { layersBack: 'barrier', passable: true }, 'page said it drew': { layersBack: 'drew', passable: true } });
});
