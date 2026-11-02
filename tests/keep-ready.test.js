// background/keep-ready.js: the tabs of the space in front kept ready to show
// (Safari), against a fake browser API.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fake = { local: {}, session: {}, scripts: [], alarms: [], noPage: new Set(), tabs: new Map() };
globalThis.chrome = /** @type {any} */ ({
  runtime: { getURL: (path) => `safari-web-extension://test/${path}` },
  permissions: { contains: async () => true },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { ...tab };
    },
  },
  scripting: {
    executeScript: async ({ target, world, func, args }) => {
      fake.scripts.push({ tabId: target.tabId, world, func: func.name, ms: args?.[0] });
      if (fake.noPage.has(target.tabId)) throw new Error('Could not execute script on this tab');
      // A hold runs until its time is up (or its page is shown): pending here.
      return new Promise(() => {});
    },
  },
  alarms: {
    create: (name, info) => fake.alarms.push(['create', name, info.periodInMinutes]),
    clear: async (name) => { fake.alarms.push(['clear', name]); return true; },
  },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...fake.local } : Object.fromEntries([].concat(keys).filter((k) => k in fake.local).map((k) => [k, structuredClone(fake.local[k])]))),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
      remove: async () => {},
    },
    session: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in fake.session).map((k) => [k, structuredClone(fake.session[k])])),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
    },
  },
});

const keepReady = await import('../extension/background/keep-ready.js');
const { mutate, load, decided, markSynced } = await import('../extension/background/store.js');
await decided(); // this copy owns the state

const MIN = 60_000;
// Window 1 shows space "a" (tabs 1 active, 2, 3; tab 4 is in space "b");
// window 2 shows space "b" (tab 5 active, 6).
async function setUp({ minutes = 30 } = {}) {
  fake.scripts = []; fake.alarms = []; fake.noPage = new Set();
  const tab = (id, windowId, lastActive, active = false) => ({ id, windowId, index: id, url: `https://t${id}.test/`, title: '', favIconUrl: '', active, lastActive });
  const tabs = { 1: tab(1, 1, 100, true), 2: tab(2, 1, 50), 3: tab(3, 1, 90), 4: tab(4, 1, 99), 5: tab(5, 2, 100, true), 6: tab(6, 2, 10) };
  fake.tabs = new Map(Object.values(tabs).map((t) => [t.id, t]));
  await mutate((s) => ({
    ...s,
    spaces: [{ id: 'a', name: 'A', emoji: '', color: '' }, { id: 'b', name: 'B', emoji: '', color: '' }],
    tabs,
    tabSpace: { 1: 'a', 2: 'a', 3: 'a', 4: 'b', 5: 'b', 6: 'b' },
    activeSpaceByWindow: { 1: 'a', 2: 'b' },
    settings: { ...s.settings, keepTabsReadyMinutes: minutes },
  }));
  await markSynced(); // its ids matched to the open tabs
}
const held = () => fake.scripts.filter((x) => x.func === 'keepAwake' && x.world === 'MAIN').map((x) => x.tabId);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// The same where setTimeout is mocked.
const settleNow = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('keep ready: the tabs of the space each window shows, not the one in front, most recently used first', async () => {
  await setUp();
  assert.deepEqual(keepReady.chooseTabs(await load()), [3, 2, 6]);
});

test('keep ready: while Safari was used recently they are held (75 s holds), renewed only when nearly over', async () => {
  await setUp();
  const t0 = 1_000_000;
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  assert.deepEqual(held().sort(), [2, 3, 6]);
  assert.ok(fake.scripts.every((x) => x.ms === 75_000));
  assert.deepEqual(fake.alarms[0], ['create', keepReady.KEEP_READY_ALARM, 1], 'an alarm in case the background is stopped');
  fake.scripts = [];
  await keepReady.tick(t0 + 10_000);
  assert.deepEqual(held(), [], 'still held: not renewed');
  await keepReady.tick(t0 + 60_000);
  await settle();
  assert.deepEqual(held().sort(), [2, 3, 6], 'renewed before the hold ends');
});

test('keep ready: 30 minutes after Safari was last used, no more holds (the last ones end by themselves)', async () => {
  await setUp();
  const t0 = 5_000_000;
  keepReady.noteUsed(t0);
  await keepReady.tick(t0 + 30 * MIN + 1);
  assert.deepEqual(held(), []);
  assert.deepEqual(fake.alarms.at(-1), ['clear', keepReady.KEEP_READY_ALARM]);
});

test('keep ready: off (0 minutes): nothing held', async () => {
  await setUp({ minutes: 0 });
  const t0 = 9_000_000;
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  assert.deepEqual(held(), []);
});

test('keep ready: the tab just left is held at once', async () => {
  await setUp();
  const t0 = 20_000_000;
  keepReady.noteUsed(t0);
  keepReady.holdNow(4, t0); // left for another space's tab, say
  await settle();
  assert.deepEqual(held(), [4]);
});

test('keep ready: a tab with no page (Safari unloaded it) isn\'t loaded by a hold, and isn\'t tried again for ten minutes', async () => {
  await setUp();
  const t0 = 30_000_000;
  fake.noPage.add(2);
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  assert.deepEqual(keepReady.keepReadyState().noPage, [2]);
  fake.scripts = [];
  for (const at of [5_000, 61_000, 5 * MIN, 9 * MIN]) {
    keepReady.noteUsed(t0 + at);
    await keepReady.tick(t0 + at);
    await settle();
    assert.ok(!held().includes(2), `not tried again ${at / 1000} s later (every 40 s before)`);
  }
  fake.noPage.clear();
  await keepReady.tick(t0 + 10 * MIN + 1);
  await settle();
  assert.ok(held().includes(2), 'tried again after ten minutes, if no event came');
});

test('keep ready: a tab with no page is tried again as soon as a tab event says its page changed', async () => {
  await setUp();
  const t0 = 31_000_000;
  fake.noPage.add(2);
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  fake.noPage.clear(); // Margin restored it behind, say
  fake.scripts = [];
  keepReady.pageChanged(2); // tabs.onUpdated: status or address (background.js)
  assert.deepEqual(keepReady.keepReadyState().noPage, []);
  await keepReady.tick(t0 + 5_000);
  await settle();
  assert.deepEqual(held(), [2]);
});

test('keep ready: a tab with no page is forgotten once shown (Safari loads it then)', async () => {
  await setUp();
  const t0 = 32_000_000;
  fake.noPage.add(3);
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  assert.deepEqual(keepReady.keepReadyState().noPage, [3]);
  keepReady.shown(3);
  assert.deepEqual(keepReady.keepReadyState().noPage, []);
});

test('keep ready: a page event while a hold was on its way: the tab isn\'t set aside (its page may have come just after)', async () => {
  await setUp();
  const t0 = 33_000_000;
  let reject;
  const executeScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (call) => {
    if (call.target.tabId !== 2) return executeScript(call);
    fake.scripts.push({ tabId: 2, world: call.world, func: call.func.name, ms: call.args?.[0] });
    return new Promise((_, no) => { reject = no; });
  };
  try {
    keepReady.noteUsed(t0);
    await keepReady.tick(t0);
    await settle();
    keepReady.pageChanged(2); // its load started meanwhile
    reject(new Error('Could not execute script on this tab'));
    await settle();
    assert.deepEqual(keepReady.keepReadyState().noPage, []);
    fake.scripts = [];
    await keepReady.tick(t0 + 5_000);
    await settle();
    assert.deepEqual(held(), [2], 'held at the next tick');
  } finally {
    chrome.scripting.executeScript = executeScript;
  }
});

test('keep ready: a tab shown and left again is held afresh at once (its hold ended as it was shown)', async () => {
  await setUp();
  const t0 = 40_000_000;
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  keepReady.shown(3); // shown at t0 + 10 s: its hold ends (keepAwake)
  fake.scripts = [];
  keepReady.holdNow(3, t0 + 30_000); // left again
  await settle();
  assert.deepEqual(held(), [3]);
});

test('keep ready: a hold placed between ticks is renewed before it ends', async () => {
  await setUp();
  const t0 = 50_000_000;
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  keepReady.holdNow(3, t0 + 10_000); // left again at +10 s: held afresh, ends at +85 s
  await settle();
  fake.scripts = [];
  await keepReady.tick(t0 + 60_000); // 25 s left: not yet (the others are)
  assert.ok(!held().includes(3));
  await keepReady.tick(t0 + 66_000); // what the schedule sets: end − 20 s + 0.5 s
  await settle();
  assert.ok(held().includes(3), 'renewed in time');
});

// Window 1 shows space "a": tab 1 in front, tabs 2–10 behind, used in that
// order (10 last).
async function setUpMany() {
  fake.scripts = []; fake.alarms = []; fake.noPage = new Set();
  const tabs = {};
  for (let id = 1; id <= 10; id++) tabs[id] = { id, windowId: 1, index: id, url: `https://t${id}.test/`, title: '', favIconUrl: '', active: id === 1, lastActive: id === 1 ? 1000 : id };
  fake.tabs = new Map(Object.values(tabs).map((t) => [t.id, t]));
  await mutate((s) => ({
    ...s,
    spaces: [{ id: 'a', name: 'A', emoji: '', color: '' }],
    tabs,
    tabSpace: Object.fromEntries(Object.keys(tabs).map((id) => [id, 'a'])),
    activeSpaceByWindow: { 1: 'a' },
    settings: { ...s.settings, keepTabsReadyMinutes: 30 },
  }));
  await markSynced();
}

test('keep ready: at most six, the ones used last (beyond them, Safari suspends as it would)', async () => {
  await setUpMany();
  assert.deepEqual(keepReady.chooseTabs(await load()), [10, 9, 8, 7, 6, 5]);
  assert.deepEqual(keepReady.chooseTabs(await load(), new Set([9, 7])), [10, 8, 6, 5, 4, 3], 'tabs with no page don\'t count');
});

test('keep ready: tabs with no page don\'t count toward the six: the next with a page takes their place at once', async (t) => {
  keepReady.resetKeepReady(); // no tick soon left over from the tests before
  const t0 = 60_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  fake.noPage = new Set([10, 8]);
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady(); // not noteUsed's tick soon: the one the failures ask for
  await keepReady.tick(t0);
  await settleNow();
  assert.deepEqual(held().sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(keepReady.keepReadyState().noPage.sort((a, b) => a - b), [8, 10]);
  fake.scripts = [];
  t.mock.timers.tick(1500); // the tick soon the two failures asked for
  await settleNow();
  assert.deepEqual(held().sort((a, b) => a - b), [3, 4], 'two more in their place');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [3, 4, 5, 6, 7, 9]);
});

test('keep ready: a background start holds nothing at once (a first switch may be on its way), the set a moment later', async (t) => {
  keepReady.resetKeepReady();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 70_000_000 });
  await setUpMany();
  keepReady.noteUsed(Date.now() - 60_000); // used a minute ago (as storage.session tells a new background)
  keepReady.resetKeepReady(); // only the time it was used is known
  fake.scripts = [];
  keepReady.tickSoon(); // background.js, after the first sync
  await settleNow();
  assert.deepEqual(held(), []);
  t.mock.timers.tick(1500);
  await settleNow();
  assert.deepEqual(held().sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
});

test('keep ready: a hold that leaves the six is forgotten (it ends by itself), and doesn\'t set ticks a second apart until it ends', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 80_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady(); // not noteUsed's tick soon
  await keepReady.tick(t0);
  await settleNow();
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
  // Ten seconds later tab 4 is used: tab 5 leaves the six.
  t.mock.timers.tick(10_000);
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 4: { ...s.tabs[4], lastActive: 100 } } }));
  await keepReady.tick();
  await settleNow();
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [4, 6, 7, 8, 9, 10], 'tab 5 forgotten');
  const before = keepReady.keepReadyState().ticks;
  for (let s = 0; s < 70; s++) {
    t.mock.timers.tick(1000);
    await settleNow();
  }
  // Up to +80 s: the renewals of the five (+55.5 s) and of tab 4 (+65.5 s),
  // not a tick a second from +55.5 s on for tab 5's hold (about 25).
  assert.ok(keepReady.keepReadyState().ticks - before <= 3, `${keepReady.keepReadyState().ticks - before} ticks`);
  keepReady.resetKeepReady();
});

test('keep ready: the tabs set aside outlast the background (Safari stops it when idle and the alarm starts it again)', async () => {
  keepReady.resetKeepReady();
  await setUpMany();
  const t0 = Date.now();
  fake.noPage = new Set([10]);
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  await settle();
  assert.deepEqual(fake.session.keepReadyNoPage, { 10: t0 + 10 * MIN });
  keepReady.resetKeepReady(); // stop(): nothing set aside any more
  await settle();
  assert.deepEqual(fake.session.keepReadyNoPage, {});
  // A background that started again: its memory is empty, storage.session isn't.
  fake.session.keepReadyNoPage = { 10: t0 + 10 * MIN, 9: t0 + 10 * MIN };
  fake.session.keepReadyUsedAt = t0;
  const again = await import('../extension/background/keep-ready.js?started-again');
  again.shown(9); // shown before the read: Safari loaded it
  fake.scripts = [];
  await again.tick(t0 + 5_000);
  await settle();
  assert.deepEqual(held().sort((a, b) => a - b), [4, 5, 6, 7, 8, 9], 'tab 10 not tried again; tab 9, shown since, is');
  assert.deepEqual(again.keepReadyState().noPage, [10]);
  again.resetKeepReady();
});

test('keep ready: a tab taken back before the read of the tabs set aside is dropped from storage.session too, so the next background start doesn\'t set it aside again', async () => {
  keepReady.resetKeepReady();
  await setUpMany();
  const t0 = Date.now();
  fake.noPage = new Set();
  fake.session.keepReadyNoPage = { 10: t0 + 10 * MIN };
  fake.session.keepReadyUsedAt = t0;
  // Started by the switch to tab 10 (Safari loads it as it's shown), before the read.
  const second = await import('../extension/background/keep-ready.js?taken-back');
  second.shown(10);
  await second.tick(t0 + 5_000);
  await settle();
  await settle();
  assert.deepEqual(second.keepReadyState().noPage, []);
  assert.deepEqual(fake.session.keepReadyNoPage, {}, 'storage.session forgets it too');
  // Safari stops that background; the alarm starts another.
  const third = await import('../extension/background/keep-ready.js?taken-back-again');
  fake.scripts = [];
  await third.tick(t0 + 70_000);
  await settle();
  assert.ok(held().includes(10), `tab 10 held (held ${JSON.stringify(held())})`);
  second.resetKeepReady();
  third.resetKeepReady();
});
