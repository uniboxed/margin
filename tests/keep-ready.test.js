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
      get: async (key) => (key in fake.session ? { [key]: fake.session[key] } : {}),
      set: async (items) => { Object.assign(fake.session, items); },
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

test('keep ready: a tab with no page (Safari unloaded it) isn\'t loaded by a hold, and is tried again later', async () => {
  await setUp();
  const t0 = 30_000_000;
  fake.noPage.add(2);
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  fake.scripts = [];
  fake.noPage.clear();
  await keepReady.tick(t0 + 5_000);
  await settle();
  assert.deepEqual(held(), [], 'not tried at every tick');
  await keepReady.tick(t0 + 61_000);
  await settle();
  assert.ok(held().includes(2), 'tried again after a minute');
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
