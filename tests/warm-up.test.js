// The quiet warm-up after a Safari relaunch (background/warm-up.js): the
// tabs likely clicked next, loaded behind the page one at a time while the
// user is idle, as a switch's restore loads them, giving way at once to a
// switch or input. Through background.js's own listeners, against a fake
// Safari whose extension calls run one after another on its main thread
// (startup.test.js), whose unloaded tabs load once selected
// (slow-safari.test.js), and whose page in front answers whether the user
// is idle (content/idle.js; tests/idle.test.js tests that side).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => (listeners[name] ?? []).map((fn) => fn(...args));

const fake = {
  tabs: new Map(),
  noPage: new Set(), // tabs Safari unloaded: a script there fails
  loads: new Map(), // tabs Safari loads once selected: { startMs, commitMs, paintMs, loadMs }
  painted: new Set(),
  callMs: 2, // each extension call takes this long of Safari's main thread, one after another
  calls: [], // { what, tabId, name, at }
  updates: [], // { id, at }
  local: {},
  session: {},
  // The page in front's answer to whether the user is idle (content/idle.js).
  idle: () => ({ idle: true }),
  idleAsks: [], // { tabId, at }
  notes: [], // { tabId, progress, at }: the warm-up's note
  covers: [], // { tabId, at }: 'switching' messages (a page covered)
  winState: 'normal',
  focused: true,
  winDelay: 0, // windows.get takes this long (Safari slow to answer it)
  sessionGate: null, // storage.session's answer about the warm-up held until the test is ready
  onWindowQuery: null, // told as Safari answers a tabs.query for one window's tabs
};
let turn = Promise.resolve();
// (Its turn on the main thread, then its answer: a script's own wait in its
// page doesn't hold the next call up.)
const safari = (what, tabId, name, fn) => {
  const slot = turn.then(() => (fake.callMs ? sleep(fake.callMs) : null)).then(() => { fake.calls.push({ what, tabId, name, at: Date.now() }); });
  turn = slot;
  return slot.then(() => fn());
};
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const bringToFront = (id) => {
  const tab = fake.tabs.get(id);
  if (!tab || tab.active) return;
  for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
  fire('onActivated', { tabId: id, windowId: tab.windowId });
};
const setStatus = (id, status) => {
  const tab = fake.tabs.get(id);
  if (!tab || tab.status === status) return;
  tab.status = status;
  fire('onUpdated', id, { status }, { ...tab });
};
function startLoad(id) {
  const how = fake.loads.get(id);
  if (!how) return;
  fake.loads.delete(id);
  sleep(how.startMs ?? 0).then(() => setStatus(id, 'loading'));
  sleep(how.commitMs ?? 0).then(() => fake.noPage.delete(id));
  if (how.paintMs != null) sleep(how.paintMs).then(() => fake.painted.add(id));
  if (how.loadMs != null) sleep(how.loadMs).then(() => setStatus(id, 'complete'));
}
const readiness = async (id, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const tab = fake.tabs.get(id);
    if (tab?.status === 'complete' && !fake.loads.has(id) && !fake.noPage.has(id)) return 'loaded';
    if (fake.painted.has(id)) return 'painted';
    if (Date.now() >= until) return 'timeout';
    await sleep(5);
  }
};
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => `safari-web-extension://test/${p}`,
    getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'),
    sendMessage: async () => undefined,
    sendNativeMessage: async () => undefined,
  },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => null, create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    get: (id) => sleep(fake.winDelay).then(() => safari('windows.get', null, null, () => ({ id, focused: fake.focused, state: fake.winState }))),
    getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1, focused: fake.focused, state: fake.winState }),
    update: async () => {}, onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: (id) => safari('get', id, null, () => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; }),
    query: (filter = {}) => safari(Object.keys(filter).length ? 'query' : 'query all', null, null, () => (filter.windowId != null ? fake.onWindowQuery?.() : null, [...fake.tabs.values()])
      .filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId) && (!filter.lastFocusedWindow || t.windowId === 1))
      .map((t) => ({ ...t }))),
    update: (id, change) => safari('update', id, null, () => {
      if (!fake.tabs.has(id)) throw new Error(`No tab with id ${id}`);
      fake.updates.push({ id, at: Date.now() });
      if (change.active) {
        startLoad(id);
        bringToFront(id);
      }
      return { ...fake.tabs.get(id) };
    }),
    sendMessage: (tabId, message) => {
      if (fake.noPage.has(tabId)) return sleep(2).then(() => { throw new Error('no page'); });
      if (message?.type === 'margin-hold') return never();
      if (message?.type === 'warm-up-idle') {
        fake.idleAsks.push({ tabId, at: Date.now() });
        return sleep(2).then(() => fake.idle(tabId));
      }
      if (message?.type === 'warm-up') fake.notes.push({ tabId, progress: message.progress, at: Date.now() });
      if (message?.type === 'switching') fake.covers.push({ tabId, at: Date.now() });
      return sleep(2).then(() => (message?.type === 'switching' || message?.type === 'margin-release' ? true : undefined));
    },
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }),
    create: async () => { throw new Error('not here'); }, remove: async () => {}, reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: ({ target, func, files, args }) => safari('script', target.tabId, files ? 'files' : func?.name ?? 'anonymous', async () => {
      if (fake.noPage.has(target.tabId)) throw new Error('Could not execute script on this tab');
      let result = true;
      if (func?.name === 'prepareSidebarInPage') result = { ready: true, token: args?.[0]?.token };
      else if (func?.name === 'paintBarrierInPage') result = 'drawn';
      else if (func?.name === 'cutOffInPage') result = { cutOff: false };
      else if (func?.name === 'readyInPage') result = await readiness(target.tabId, args?.[0] ?? 0);
      return [{ result }];
    }),
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete fake.local[k]; },
    },
    session: {
      get: async (keys) => {
        if (keys === 'warmUp' && fake.sessionGate) await fake.sessionGate;
        return pick(fake.session, keys);
      },
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
};

// Tabs 1–9 loaded (1 in front); 20–59 unloaded, as after a relaunch, used
// longest ago first.
const base = Date.now() - 3_600_000;
for (let id = 1; id <= 9; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, status: 'complete', active: id === 1, lastAccessed: base + id });
for (let id = 20; id <= 59; id++) {
  fake.tabs.set(id, { id, windowId: 1, url: `https://u${id}.test/`, title: `U${id}`, index: id - 11, status: 'complete', active: false, lastAccessed: base + id });
  fake.noPage.add(id);
}
let openGate = () => {};
fake.sessionGate = new Promise((resolve) => { openGate = resolve; });

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
const M = await import('../extension/state/model.js');
const { forgetNeverShown, pageChanged } = await import('../extension/background/tabs.js');
const { tapLog } = await import('../extension/background/diagnostics.js');
const slow = await import('../extension/background/slow.js');
const warmUp = await import('../extension/background/warm-up.js');

const TIMING = { startAfterMs: 300, repairWaitMs: 5000, resumeAfterMs: 50, runMaxMs: 60_000, quietMs: 700, lagMaxMs: 250, idleMs: 200, keysMs: 500, gapMs: 120, retryMs: 100, loadingMaxMs: 3000, backoffMaxMs: 2000, noteMs: 15_000, calmMs: 50, idleAnswerMs: 300 };
warmUp.setWarmUpTiming(TIMING);

const front = () => [...fake.tabs.values()].find((t) => t.active && t.windowId === 1).id;
const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id).url });
const WAIT_MS = 7000;
function ask(type, payload = {}) {
  const asked = Date.now();
  const deadline = asked + WAIT_MS;
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload, deadline, waitsUntil: deadline + 3000 }, sender(front()), (reply) => resolve({ reply, ms: Date.now() - asked, asked }));
  });
}
async function settledOn(id) {
  for (let i = 0; i < 300; i++) {
    if ((await store.load()).tabs[id]?.active) return;
    await sleep(10);
  }
  assert.fail(`tab ${id} never known in front`);
}
// These tabs used last (most recent first), the setting at `count`.
async function prefer(ids, count = ids.length) {
  const now = Date.now();
  await store.mutate((s) => {
    const tabs = { ...s.tabs };
    ids.forEach((id, i) => { tabs[id] = { ...tabs[id], lastActive: now - 1000 - i }; });
    return { ...s, tabs, settings: { ...s.settings, warmUpTabs: count } };
  });
}
const loadsFor = (ids, how = { startMs: 20, commitMs: 80, paintMs: 200, loadMs: 300 }) => { for (const id of ids) fake.loads.set(id, { ...how }); };
// The warm-up's log entries while `fn` runs.
async function logged(fn) {
  const entries = [];
  tapLog((e) => entries.push(e));
  try {
    const out = await fn();
    return { out, entries: entries.filter((e) => e.kind === 'warmUp'), all: entries };
  } finally {
    tapLog(null);
  }
}
// A new run, as after a relaunch (the background before it gone).
async function relaunched() {
  warmUp.resetWarmUp();
  delete fake.session.warmUp;
  warmUp.freshSession();
  return over(warmUp.start());
}
// Its last write and its last note have landed too.
const over = (run) => Promise.resolve(run).then(() => sleep(40));
async function until(fn, ms = 5000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${typeof label === 'function' ? label() : label}`);
}
// The flips of tab `id` (its updates).
const flipsOf = (id, since = 0) => fake.updates.filter((u) => u.id === id && u.at >= since);
async function calm() {
  fake.idle = () => ({ idle: true });
  fake.winState = 'normal';
  fake.focused = true;
  fake.winDelay = 0;
  fake.tabs.get(1).audible = false;
  if (front() !== 1) {
    bringToFront(1);
    await settledOn(1);
  }
  await sleep(30);
  slow.resetSlow();
}

// ---- which tabs ----------------------------------------------------------------------

test('pickTabs: the tab used last first, then the tab each other space shows, then tabs open on a pin, then the rest used last; only eligible tabs, the setting\'s count at most', () => {
  const t = (id, windowId, lastActive, extra = {}) => ({ id, windowId, index: id, title: '', url: `https://p${id}.test/`, lastActive, active: false, ...extra });
  const s = {
    spaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    tabs: {
      1: t(1, 1, 100, { active: true }), 2: t(2, 1, 90), 3: t(3, 1, 80), 4: t(4, 1, 70), 5: t(5, 1, 60), 6: t(6, 1, 50), 7: t(7, 1, 40), 8: t(8, 1, 30),
      9: t(9, 1, 95), // in space c, but not eligible
    },
    tabSpace: { 1: 'a', 2: 'a', 3: 'a', 4: 'b', 5: 'b', 6: 'c', 7: 'a', 8: 'a', 9: 'c' },
    pins: [{ id: 'p', spaceId: 'a', url: 'https://p8.test', title: '' }, { id: 'q', spaceId: 'b', url: 'https://p8.test/', title: '' }],
  };
  const eligible = (r) => r.id !== 9;
  const picked = warmUp.pickTabs(/** @type {any} */ (s), { max: 6, eligible });
  // 2: used last; 4: what space b shows (space c shows 9, not eligible: none
  // for c); 8: open on a pin of its space; then the rest used last.
  assert.deepEqual(picked, [{ id: 2, why: 'recent' }, { id: 4, why: 'space' }, { id: 8, why: 'pinned' }, { id: 3, why: 'recent' }, { id: 5, why: 'recent' }, { id: 6, why: 'recent' }]);
  assert.equal(picked.length, 6);
  assert.deepEqual(warmUp.pickTabs(/** @type {any} */ (s), { max: 2, eligible }).map((p) => p.id), [2, 4]);
  assert.deepEqual(warmUp.pickTabs(/** @type {any} */ (s), { max: 0, eligible }), []);
  // A pin in another space doesn't make a tab pinned: 8's pin in b doesn't count for a tab of a.
  assert.deepEqual(warmUp.pickTabs(/** @type {any} */ ({ ...s, pins: [s.pins[1]] }), { max: 4, eligible }).map((p) => p.why), ['recent', 'space', 'recent', 'recent']);
});

// ---- the run after a relaunch ----------------------------------------------------------

test('after a relaunch, once settled: the tabs picked are loaded behind the page one at a time, nothing covered, the note says how far it got, and it\'s kept as done', async () => {
  for (let i = 0; i < 300 && !store.isSynced(); i++) await sleep(20);
  assert.ok(store.isSynced());
  await settledOn(1);
  await prefer([20, 21, 22]);
  loadsFor([20, 21, 22]);
  fake.covers = [];
  const startedAt = Date.now();
  const { entries } = await logged(async () => {
    openGate(); // the background's warm-up reads its record now
    await until(() => fake.session.warmUp?.state === 'done' && fake.notes.at(-1)?.progress.state === 'done', 15000, 'the run done');
  });
  const flips = fake.updates.filter((u) => [20, 21, 22].includes(u.id));
  assert.deepEqual(flips.map((u) => u.id), [20, 21, 22], 'each flipped once, in order');
  // Not before Safari settled.
  const tabs = entries.filter((e) => e.step === 'tab');
  assert.deepEqual(tabs.map((e) => [e.tabId, e.outcome]), [[20, 'painted'], [21, 'painted'], [22, 'painted']], JSON.stringify(entries));
  // One at a time: each flip after the one before had painted.
  for (let i = 1; i < flips.length; i++) assert.ok(flips[i].at - flips[i - 1].at >= 200, `flip ${i} ${flips[i].at - flips[i - 1].at} ms after the one before`);
  // The page in front was never covered, and every flip brought it straight back.
  assert.deepEqual(fake.covers, []);
  assert.equal(front(), 1);
  for (const f of flips) assert.ok(fake.updates.some((u) => u.id === 1 && u.at >= f.at && u.at - f.at < 50), 'the page in front straight back');
  // Its note: 0 of 3 as it starts, then each, then done, to the page in front.
  const notes = fake.notes.map((n) => [n.tabId, n.progress.state, n.progress.done, n.progress.total]);
  assert.deepEqual(notes.at(-1), [1, 'done', 3, 3], JSON.stringify(notes));
  assert.ok(notes.some((n) => n[1] === 'running' && n[2] === 1), JSON.stringify(notes));
  const plan = entries.find((e) => e.step === 'plan');
  assert.deepEqual(plan.candidates.map((c) => c.tabId), [20, 21, 22]);
  assert.ok(plan.evidence.noPage >= 30 && plan.evidence.withPage <= 9, JSON.stringify(plan.evidence));
  assert.equal(entries.find((e) => e.step === 'end')?.why, 'done');
  assert.ok(flips[0].at - startedAt >= 0);
  // Nothing drawn or held in them for it: no arrival cover, no wake.
  const quiet = fake.calls.filter((c) => [20, 21, 22].includes(c.tabId) && (c.name === 'coverArrivalInPage' || c.name === 'keepAwake'));
  assert.deepEqual(quiet, [], JSON.stringify(quiet));
  // Warmed tabs are left never shown: the first click introduces them, then shows them (no restore).
  const { reply } = await ask('activateTab', { tabId: 21 });
  assert.deepEqual(reply, { ok: true, result: { shown: 21 } });
});

test('a background started again in the same Safari session does nothing once the run is over, nor without one; one under way goes on with what\'s left', async () => {
  await calm();
  // Over: nothing.
  warmUp.resetWarmUp();
  const before = fake.updates.length;
  await warmUp.start();
  assert.equal(fake.updates.length, before);
  // No record, not a fresh session (the plan wasn't kept before it stopped): nothing.
  warmUp.resetWarmUp();
  delete fake.session.warmUp;
  await warmUp.start();
  assert.equal(fake.updates.length, before);
  assert.equal(fake.session.warmUp, undefined);
  // Under way: 23 done by the background before, 24 and 25 left. 25 has a
  // page by now (Safari loaded it meanwhile): this background asks it first,
  // and leaves it alone.
  loadsFor([24]);
  fake.noPage.delete(25);
  // (This background's own knowledge gone, as a new one has none.)
  pageChanged(24);
  pageChanged(25);
  fake.session.warmUp = { v: 1, state: 'running', at: Date.now(), until: Date.now() + 60_000, picked: [{ id: 23, why: 'recent' }, { id: 24, why: 'recent' }, { id: 25, why: 'space' }], done: { 23: 'painted' } };
  warmUp.resetWarmUp();
  const { entries } = await logged(() => over(warmUp.start()));
  assert.deepEqual(entries.filter((e) => e.step === 'tab').map((e) => [e.tabId, e.outcome]), [[24, 'painted'], [25, 'skipped: has a page']]);
  assert.equal(fake.session.warmUp.state, 'done');
  assert.equal(flipsOf(23, 0).length, 0);
  assert.equal(flipsOf(25, 0).length, 0, 'a tab with a page is never flipped (a suspended one isn\'t kicked)');
  fake.noPage.add(25);
});

test('a Margin update (or a new copy finding its tabs loaded) isn\'t a relaunch: nothing is warmed', async () => {
  await calm();
  // The update's own word.
  warmUp.resetWarmUp();
  delete fake.session.warmUp;
  warmUp.freshSession();
  warmUp.noteInstalled('update');
  const before = fake.updates.length;
  const { entries } = await logged(() => over(warmUp.start()));
  assert.equal(fake.updates.length, before);
  assert.equal(fake.session.warmUp?.state, 'not relaunch');
  assert.equal(entries[0]?.step, 'not relaunch');
  assert.equal(entries[0]?.evidence?.update, true);
});

test('the setting at 0: nothing is warmed', async () => {
  await calm();
  await prefer([26, 27], 0);
  const t0 = Date.now();
  const before = fake.updates.length;
  await relaunched();
  assert.equal(fake.updates.length, before);
  assert.equal(fake.session.warmUp?.state, 'off');
  assert.deepEqual(fake.idleAsks.filter((a) => a.at >= t0), [], 'not even the page asked');
});

test('it waits while Safari is slow, and until the user is idle on the page in front, focused, the window on screen, nothing playing', async () => {
  await calm();
  await prefer([26, 27]);
  loadsFor([26, 27]);
  // Slow at first, then not idle, then the window minimized, then playing.
  slow.noteCall('tabs.get', 700, 3);
  let phase = 'slow';
  fake.idle = () => (phase === 'typing' ? { idle: false, why: 'typing', retryMs: 100 } : phase === 'unfocused' ? { idle: false, why: 'not focused', retryMs: 100 } : { idle: true });
  const run = relaunched();
  const t0 = Date.now();
  await sleep(TIMING.startAfterMs + 300);
  assert.equal(flipsOf(26, t0).length, 0, 'nothing while a slow sign is recent');
  assert.equal(fake.idleAsks.filter((a) => a.at > t0).length, 0, 'not even the page asked while Safari is slow');
  phase = 'typing';
  await sleep(TIMING.quietMs + 200);
  assert.ok(fake.idleAsks.filter((a) => a.at > t0).length >= 1, 'the page asked once Safari was quiet');
  assert.equal(flipsOf(26, t0).length, 0, 'nothing while the user types');
  phase = 'unfocused';
  await sleep(300);
  assert.equal(flipsOf(26, t0).length, 0, 'nothing while Safari isn\'t in use (the page not focused)');
  phase = 'idle';
  fake.winState = 'minimized';
  await sleep(300);
  assert.equal(flipsOf(26, t0).length, 0, 'nothing while the window is minimized');
  fake.winState = 'fullscreen';
  await sleep(300);
  assert.equal(flipsOf(26, t0).length, 0, 'nothing in full screen');
  // (Sound first, then on screen: a look under way as both changed at once
  // could see neither.)
  fake.tabs.get(1).audible = true;
  await sleep(100);
  fake.winState = 'normal';
  await sleep(300);
  assert.equal(flipsOf(26, t0).length, 0, 'nothing while the tab in front plays sound');
  fake.tabs.get(1).audible = false;
  await run;
  assert.equal(fake.session.warmUp.state, 'done');
  assert.equal(flipsOf(26, t0).length, 1);
  assert.equal(flipsOf(27, t0).length, 1);
  const waits = warmUp.warmUpState().waits;
  for (const why of ['slow', 'typing', 'not focused', 'minimized', 'fullscreen', 'playing']) assert.ok(waits[why] >= 1, `${why}: ${JSON.stringify(waits)}`);
});

test('a switch the user asks for while a tab loads behind: shown as fast as without the warm-up, the warm-up\'s wait gives way at once, and nothing more is flipped until it\'s over', async () => {
  await calm();
  // Baseline: a switch to a loaded tab, nothing else going on.
  const base1 = await ask('activateTab', { tabId: 3 });
  assert.deepEqual(base1.reply, { ok: true, result: { shown: 3 } });
  await calm();
  const base2 = await ask('activateTab', { tabId: 4 });
  await calm();
  const baseline = Math.max(base1.ms, base2.ms);
  // A slow page loading behind (its paint at 2 s).
  await prefer([28, 29]);
  loadsFor([28, 29], { startMs: 20, commitMs: 100, paintMs: 2000, loadMs: 2500 });
  const { out, entries } = await logged(async () => {
    const run = relaunched();
    await until(() => flipsOf(28).length >= 1, 5000, () => `tab 28 flipped (${JSON.stringify(warmUp.warmUpState())}, slow ${JSON.stringify(slow.slowFacts())})`);
    await sleep(150); // its load under way, the warm-up polling it
    const during = await ask('activateTab', { tabId: 5 });
    const shownAt = Date.now();
    await run;
    return { during, shownAt };
  });
  assert.deepEqual(out.during.reply, { ok: true, result: { shown: 5 } });
  // Nothing of the warm-up's sent to a page while the switch was under way (its calls go first).
  const sentDuring = fake.notes.filter((n) => n.at >= out.during.asked && n.at < out.shownAt);
  assert.deepEqual(sentDuring, [], JSON.stringify(sentDuring));
  assert.ok(out.during.ms <= baseline + 60, `shown ${out.during.ms} ms after the click during a warm-up (${baseline} without)`);
  const t28 = entries.find((e) => e.step === 'tab' && e.tabId === 28);
  assert.ok(t28?.outcome === 'left' || t28?.outcome === 'hurried', JSON.stringify(t28));
  assert.ok(t28.ms < 1000, `its wait ended ${t28.ms} ms after its flip`);
  // The next went only after the switch was over.
  const next = flipsOf(29)[0];
  assert.ok(next && next.at >= out.shownAt, 'not flipped during the switch');
});

test('a click on the very tab loading behind: it\'s taken on as it loads (no second flip of it), then shown', async () => {
  await calm();
  await prefer([30]);
  loadsFor([30], { startMs: 20, commitMs: 100, paintMs: 900, loadMs: 1200 });
  const t0 = Date.now();
  const run = relaunched();
  await until(() => flipsOf(30, t0).length >= 1, 5000, 'tab 30 flipped');
  await sleep(100);
  const { reply } = await ask('activateTab', { tabId: 30 });
  assert.deepEqual(reply, { ok: true, result: { shown: 30 } });
  await run;
  // The warm-up's flip, the introduction once it had painted, the show: no second restore flip before its paint.
  const flips = flipsOf(30, t0);
  assert.ok(flips.length <= 3, JSON.stringify(flips.map((f) => f.at - t0)));
  assert.ok(flips.slice(1).every((f) => f.at - t0 >= 850), `nothing flipped it again before its paint: ${JSON.stringify(flips.map((f) => f.at - t0))}`);
  assert.equal(front(), 30);
});

test('input on the page in front ends the wait at once; input before the flip goes out, and it doesn\'t go out', async () => {
  await calm();
  await prefer([31, 32]);
  loadsFor([31, 32], { startMs: 20, commitMs: 100, paintMs: 1500, loadMs: 2000 });
  const t0 = Date.now();
  // The page says the user did something just after it said idle, before the flip.
  let first = true;
  fake.idle = (tabId) => {
    if (first) {
      first = false;
      setTimeout(() => listeners.onMessage[0]({ type: 'warmUpInput', at: Date.now() }, sender(tabId), () => {}), 0);
    }
    return { idle: true };
  };
  const { entries } = await logged(async () => {
    const run = relaunched();
    await until(() => flipsOf(31, t0).length >= 1, 6000, 'tab 31 flipped');
    await sleep(120);
    // Input during its load wait.
    listeners.onMessage[0]({ type: 'warmUpInput', at: Date.now() }, sender(1), () => {});
    await run;
  });
  const t31 = entries.find((e) => e.step === 'tab' && e.tabId === 31);
  assert.equal(t31?.outcome, 'hurried', JSON.stringify(entries));
  assert.ok(t31.ms < 600, `its wait ended ${t31.ms} ms after its flip`);
  // The first idle answer was followed by input: no flip for it, only after the next.
  const asks = fake.idleAsks.filter((a) => a.at >= t0);
  assert.ok(asks.length >= 2 && flipsOf(31, t0)[0].at > asks[1].at, `flipped after the second idle answer: asks ${JSON.stringify(asks.map((a) => a.at - t0))}, flip ${flipsOf(31, t0)[0].at - t0}`);
  const waits = warmUp.warmUpState().waits;
  assert.ok((waits['gave way'] ?? 0) + (waits.switch ?? 0) >= 1, JSON.stringify(waits));
});

test('input that comes just as a flip is about to go out (after the window\'s tab in front was asked for): the flip doesn\'t go out', async () => {
  await calm();
  await prefer([41]);
  loadsFor([41]);
  const t0 = Date.now();
  let hooked = 0;
  fake.onWindowQuery = () => {
    if (hooked++ === 0) warmUp.userActed(Date.now());
  };
  try {
    const { entries } = await logged(() => relaunched());
    assert.equal(hooked >= 1, true);
    assert.equal(flipsOf(41, t0).length, 1, 'flipped once, the next time');
    assert.deepEqual(entries.filter((e) => e.step === 'tab').map((e) => [e.tabId, e.outcome]), [[41, 'painted']]);
    assert.ok(warmUp.warmUpState().waits['gave way'] >= 1, JSON.stringify(warmUp.warmUpState().waits));
  } finally {
    fake.onWindowQuery = null;
  }
});

test('the note\'s × stops it: nothing more is flipped, and it\'s kept as stopped', async () => {
  await calm();
  await prefer([33, 34, 35]);
  loadsFor([33, 34, 35], { startMs: 20, commitMs: 100, paintMs: 400, loadMs: 600 });
  const t0 = Date.now();
  const run = relaunched();
  await until(() => flipsOf(33, t0).length >= 1, 5000, 'tab 33 flipped');
  listeners.onMessage[0]({ type: 'warmUpStop' }, sender(1), () => {});
  await run;
  assert.equal(fake.session.warmUp.state, 'stopped');
  assert.equal(fake.session.warmUp.why, 'stopped by you');
  assert.equal(flipsOf(34, t0).length + flipsOf(35, t0).length, 0);
  assert.equal(fake.notes.at(-1).progress.state, 'stopped');
});

test('a tab shown since it was picked is skipped, and so is one gone', async () => {
  await calm();
  await prefer([36, 37, 38]);
  loadsFor([36, 37, 38]);
  const t0 = Date.now();
  fake.idle = () => ({ idle: false, why: 'input', retryMs: 100 });
  const { entries } = await logged(async () => {
    const run = relaunched();
    await until(() => fake.session.warmUp?.state === 'running', 5000, 'planned');
    // The user shows 37 themselves (Safari's tab bar), then goes back; 38 closes.
    bringToFront(37);
    await settledOn(37);
    bringToFront(1);
    await settledOn(1);
    const gone = fake.tabs.get(38);
    fake.tabs.delete(38);
    fake.idle = () => ({ idle: true });
    await run;
    fake.tabs.set(38, gone);
  });
  assert.deepEqual(entries.filter((e) => e.step === 'tab').map((e) => [e.tabId, e.outcome]).sort(), [[36, 'painted'], [37, 'skipped: shown'], [38, 'skipped: gone']]);
  assert.equal(flipsOf(37, t0).length, 0, 'never flipped');
});

test('a tab warmed, then clicked from a background Safari started again since (its own knowledge gone): still introduced first, its mark kept in storage.session', async () => {
  await calm();
  await prefer([42]);
  loadsFor([42]);
  await relaunched();
  assert.deepEqual(Object.values(fake.session.warmUp.done), ['painted']);
  assert.ok(fake.session.unseenTabs?.includes(42), JSON.stringify(fake.session.unseenTabs));
  forgetNeverShown(); // a new background: neverShown is in memory only
  const t0 = Date.now();
  const { all, out } = await logged(() => ask('activateTab', { tabId: 42 }));
  assert.deepEqual(out.reply, { ok: true, result: { shown: 42 } });
  const entry = all.find((e) => e.kind === 'switch' && e.tabId === 42);
  assert.equal(entry?.introduced, true, JSON.stringify(entry));
  assert.equal(flipsOf(42, t0).length, 2, 'its introduction, then its show');
  assert.ok(!fake.session.unseenTabs.includes(42), 'its mark gone once shown');
});

test('the warm-up\'s own timers firing late (Safari in the background, the user away) aren\'t taken as Safari slow by switches', async () => {
  await calm();
  await prefer([43]);
  fake.idle = () => ({ idle: false, why: 'not focused', retryMs: 300 });
  const run = relaunched();
  await until(() => fake.session.warmUp?.state === 'running', 5000, 'planned');
  await sleep(100);
  slow.resetSlow();
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => real(fn, ms >= 250 ? ms + 700 : ms, ...rest);
  try {
    await sleep(3500);
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(slow.lastSignAt(), null, JSON.stringify(slow.slowFacts()));
  assert.equal(slow.isSlow(), false);
  warmUp.stopByUser();
  await run;
});

test('a pick closed before its turn is skipped as gone, the run ends and its note says so', async () => {
  await calm();
  await prefer([44, 45]);
  loadsFor([44, 45]);
  fake.idle = () => ({ idle: false, why: 'input', retryMs: 100 });
  const run = relaunched();
  await until(() => fake.session.warmUp?.state === 'running', 5000, 'planned');
  const gone = fake.tabs.get(45);
  fake.tabs.delete(45);
  fire('onRemoved', 45, { windowId: 1, isWindowClosing: false });
  await until(async () => !(await store.load()).tabs[45], 3000, 'its record gone');
  fake.idle = () => ({ idle: true });
  await Promise.race([run, sleep(4000)]);
  fake.tabs.set(45, gone);
  fire('onCreated', { ...gone });
  assert.equal(fake.session.warmUp.state, 'done', JSON.stringify(fake.session.warmUp));
  assert.deepEqual(fake.session.warmUp.done, { 44: 'painted', 45: 'skipped: gone' });
  assert.equal(fake.notes.at(-1)?.progress.state, 'done');
});

test('only the window in front as it\'s planned: picks come from its tabs (pickTabs `windowId`)', () => {
  const t = (id, windowId, lastActive, extra = {}) => ({ id, windowId, index: id, title: '', url: `https://w${id}.test/`, lastActive, active: false, ...extra });
  const s = {
    spaces: [{ id: 'a' }, { id: 'b' }],
    tabs: { 1: t(1, 1, 10, { active: true }), 2: t(2, 1, 20), 3: t(3, 2, 100, { active: true }), 4: t(4, 2, 90), 5: t(5, 2, 80), 6: t(6, 1, 5) },
    tabSpace: { 1: 'a', 2: 'a', 3: 'a', 4: 'b', 5: 'a', 6: 'b' },
    pins: [],
  };
  assert.deepEqual(warmUp.pickTabs(/** @type {any} */ (s), { max: 6, eligible: () => true, windowId: 1 }).map((p) => p.id), [2, 6]);
  assert.deepEqual(warmUp.pickTabs(/** @type {any} */ (s), { max: 6, eligible: () => true, windowId: 2 }).map((p) => p.id), [4, 5]);
});

test('the note\'s × sent to a background Safari just started (the run kept by the one before, not read yet): kept stopped, nothing more warmed', async () => {
  await calm();
  loadsFor([46, 47]);
  fake.session.warmUp = { v: 1, state: 'running', at: Date.now(), until: Date.now() + 60_000, picked: [{ id: 46, why: 'recent' }, { id: 47, why: 'space' }], done: {}, windowId: 1, shown: true, told: [1] };
  warmUp.resetWarmUp();
  const t0 = Date.now();
  await new Promise((resolve) => listeners.onMessage[0]({ type: 'warmUpStop' }, sender(1), resolve));
  assert.equal(fake.session.warmUp.state, 'stopped');
  assert.equal(fake.session.warmUp.why, 'stopped by you');
  await over(warmUp.start());
  await sleep(300);
  assert.equal(flipsOf(46, t0).length + flipsOf(47, t0).length, 0);
  assert.equal(fake.notes.filter((n) => n.at >= t0 && n.progress.state === 'running').length, 0, 'the note not shown again');
  fake.loads.clear();
});

test('a run taken over by a background started again ends with a last word to the pages given the note, also when it warms nothing more or its time is up', async () => {
  await calm();
  // Its last pick has a page by now: skipped, and the run is over.
  fake.noPage.delete(48);
  pageChanged(48);
  fake.session.warmUp = { v: 1, state: 'running', at: Date.now(), until: Date.now() + 60_000, picked: [{ id: 47, why: 'recent' }, { id: 48, why: 'space' }], done: { 47: 'painted' }, windowId: 1, shown: true, told: [1, 3] };
  warmUp.resetWarmUp();
  let t0 = Date.now();
  await over(warmUp.start());
  assert.equal(fake.session.warmUp.state, 'done');
  // (Its skip is news too: "2 of 2" to the page in front, then the last word to each.)
  const lastWord = (since) => Object.fromEntries(fake.notes.filter((n) => n.at >= since).map((n) => [n.tabId, n.progress.state]));
  assert.deepEqual(lastWord(t0), { 1: 'done', 3: 'done' });
  fake.noPage.add(48);
  // Its time up as the background starts: stopped, and they're told.
  fake.session.warmUp = { v: 1, state: 'running', at: Date.now() - 70_000, until: Date.now() - 10_000, picked: [{ id: 47, why: 'recent' }, { id: 49, why: 'space' }], done: { 47: 'painted' }, windowId: 1, shown: true, told: [1] };
  warmUp.resetWarmUp();
  t0 = Date.now();
  await over(warmUp.start());
  assert.equal(fake.session.warmUp.state, 'stopped');
  assert.equal(fake.session.warmUp.why, 'out of time');
  assert.deepEqual(fake.notes.filter((n) => n.at >= t0).map((n) => [n.tabId, n.progress.state]), [[1, 'stopped']]);
  assert.equal(flipsOf(49, t0).length, 0);
});

test('Safari slow answering the warm-up\'s own look at it (before the flip): nothing flipped until it\'s quick again', async () => {
  await calm();
  await prefer([50]);
  loadsFor([50]);
  fake.winDelay = 600; // windows.get, the gate's own call, slow: a sign
  const t0 = Date.now();
  const run = relaunched();
  await sleep(TIMING.startAfterMs + 2500);
  assert.equal(flipsOf(50, t0).length, 0, 'not flipped with Safari slow during its own calls');
  assert.ok(warmUp.warmUpState().waits.slow >= 1, JSON.stringify(warmUp.warmUpState().waits));
  fake.winDelay = 0;
  await run;
  assert.equal(flipsOf(50, t0).length, 1);
  assert.equal(fake.session.warmUp.state, 'done');
});

test('tabs Safari doesn\'t load behind end the warm-up, but don\'t turn restores off for the user\'s own clicks', async () => {
  await calm();
  await prefer([51, 52, 53]);
  // (No load for them: Safari leaves them unloaded.)
  const { entries } = await logged(() => relaunched());
  assert.deepEqual(entries.filter((e) => e.step === 'tab').map((e) => [e.tabId, e.outcome]), [[51, 'not loaded'], [52, 'not loaded']]);
  assert.equal(fake.session.warmUp.why, 'Safari not loading tabs behind');
  assert.notEqual(fake.session.restoresOff, true);
  assert.ok(!fake.session.restoreMisses, JSON.stringify(fake.session.restoreMisses));
  await calm();
  loadsFor([54], { startMs: 20, commitMs: 150, paintMs: 300, loadMs: 600 });
  const { all } = await logged(() => ask('activateTab', { tabId: 54 }));
  assert.equal(all.find((e) => e.kind === 'switch' && e.tabId === 54)?.restored, 'painted');
});

test('a tab warmed that starts playing sound by itself ends the run', async () => {
  await calm();
  await prefer([55, 56]);
  loadsFor([55, 56], { startMs: 20, commitMs: 80, paintMs: 150, loadMs: 1500 });
  const t0 = Date.now();
  const run = relaunched();
  await until(() => flipsOf(55, t0).length >= 1, 5000, 'tab 55 flipped');
  fake.tabs.get(55).audible = true;
  await run;
  fake.tabs.get(55).audible = false;
  assert.equal(fake.session.warmUp.why, 'a tab warmed played sound');
  assert.equal(flipsOf(56, t0).length, 0);
});

// ---- nothing changes for a switch ------------------------------------------------------------

test('guard: a click on an unloaded tab with no warm-up under way is restored behind the covered page and introduced, as before', async () => {
  await calm();
  loadsFor([40], { startMs: 20, commitMs: 150, paintMs: 300, loadMs: 600 });
  fake.covers = [];
  const { all, out } = await logged(() => ask('activateTab', { tabId: 40 }));
  assert.deepEqual(out.reply, { ok: true, result: { shown: 40 } });
  const entry = all.find((e) => e.kind === 'switch' && e.tabId === 40);
  assert.equal(entry?.restored, 'painted', JSON.stringify(entry));
  assert.equal(entry?.introduced, true);
  assert.ok(fake.covers.some((c) => c.tabId === 1), 'the page in front covered while it loaded');
});

test.after(() => setTimeout(() => process.exit(0), 50));
