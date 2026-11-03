// background/keep-ready.js: the tabs of the space in front kept ready to show
// (Safari), against a fake browser API.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// `contains`: how the permission check answers (default: yes, at once).
const fake = { local: {}, session: {}, scripts: [], alarms: [], noPage: new Set(), tabs: new Map(), ends: new Map(), contains: null };
globalThis.chrome = /** @type {any} */ ({
  runtime: { getURL: (path) => `safari-web-extension://test/${path}` },
  permissions: { contains: async (query) => (fake.contains ? fake.contains(query) : true) },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { ...tab };
    },
  },
  scripting: {
    executeScript: async ({ target, world, func, args }) => {
      fake.scripts.push({ tabId: target.tabId, world, func: func.name, ms: args?.[0], args });
      if (fake.noPage.has(target.tabId)) throw new Error('Could not execute script on this tab');
      if (func.name === 'releaseInPage') return [{ result: undefined }];
      // A hold runs until its time is up (or its page is shown): pending here,
      // until a test ends it (`fake.ends`, by its key).
      return new Promise((resolve) => { if (typeof args?.[1] === 'string') fake.ends.set(args[1], () => resolve([{ result: undefined }])); });
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
// The releases sent: [tabId, the keys named].
const released = () => fake.scripts.filter((x) => x.func === 'releaseInPage' && x.world === 'MAIN').map((x) => [x.tabId, x.args[0]]);
// The key of each hold placed in a tab, in order.
const keysOf = (tabId) => fake.scripts.filter((x) => x.func === 'keepAwake' && x.tabId === tabId).map((x) => x.args[1]);
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

test('keep ready: a hold that leaves the six ends at once (one script, naming that hold), not after 75 s; the tabs chosen again keep theirs', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 90_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  fake.scripts = [];
  await keepReady.tick(t0);
  await settleNow();
  const key5 = keysOf(5);
  assert.equal(key5.length, 1);
  assert.equal(typeof key5[0], 'string', 'each hold has a key');
  assert.equal(new Set([5, 6, 7, 8, 9, 10].map((id) => keysOf(id)[0])).size, 6, 'a key of its own');
  t.mock.timers.tick(10_000);
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 4: { ...s.tabs[4], lastActive: 100 } } }));
  await keepReady.tick();
  await settleNow();
  assert.deepEqual(released(), [[5, key5]], 'tab 5 let go, and only it');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [4, 6, 7, 8, 9, 10]);
  assert.equal(keepReady.keepReadyState().holds[5], undefined, 'forgotten');
  await keepReady.tick(t0 + 20_000);
  await settleNow();
  assert.deepEqual(released(), [[5, key5]], 'not again');
  keepReady.resetKeepReady();
});

test('keep ready: a run of switches never holds more than six: past them, the tab used longest ago lets go at once', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 91_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  fake.scripts = [];
  // Tabs 1, 4, 3, 2 left one after the other, each used just before.
  let at = t0;
  for (const id of [1, 4, 3, 2]) {
    at += 300;
    await mutate((s) => ({ ...s, tabs: { ...s.tabs, [id]: { ...s.tabs[id], lastActive: at } } }));
    keepReady.holdNow(id, at);
    await settleNow(); // the hold sent
    t.mock.timers.tick(250); // and not failed
    assert.ok(keepReady.keepReadyState().held.length <= 6, `${keepReady.keepReadyState().held.length} held after tab ${id} was left`);
  }
  assert.deepEqual(held(), [1, 4, 3, 2]);
  assert.deepEqual(released().map(([id]) => id), [5, 6, 7, 8], 'the ones used longest ago, in turn');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 2, 3, 4, 9, 10]);
  keepReady.resetKeepReady();
});

test('keep ready: turned off, every hold still running ends at once', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 92_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  const keys = Object.fromEntries([5, 6, 7, 8, 9, 10].map((id) => [id, keysOf(id)]));
  fake.scripts = [];
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepTabsReadyMinutes: 0 } }));
  await keepReady.tick(t0 + 5_000);
  await settleNow();
  assert.deepEqual(Object.fromEntries(released().map(([id, named]) => [id, named])), keys);
  assert.deepEqual(keepReady.keepReadyState().held, []);
  assert.deepEqual(keepReady.keepReadyState().holds, {});
  keepReady.resetKeepReady();
});

test('keep ready: a release names every hold of the tab still running (a renewal overlaps the hold before), never one already over; a late answer from an older hold doesn\'t forget the newer', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 93_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  // Tab 10 shown and left again: its first hold ended as it was shown (its
  // script answers late), and it's held afresh.
  keepReady.shown(10);
  keepReady.holdNow(10, t0 + 15_000);
  await settleNow();
  const [first, second] = keysOf(10);
  fake.ends.get(first)();
  await settleNow();
  assert.ok(keepReady.keepReadyState().held.includes(10), 'the newer hold is still known');
  assert.deepEqual(keepReady.keepReadyState().holds[10], [second]);
  // Tab 9 renewed: its first hold runs on 20 s more beside the new one.
  await keepReady.tick(t0 + 60_000);
  await settleNow();
  const nine = keysOf(9);
  assert.equal(nine.length, 2, 'renewed');
  assert.equal(keysOf(10).length, 2, 'not tab 10 (30 s left)');
  fake.scripts = [];
  // Tabs 2–7 now the most recent: 8, 9 and 10 leave the six.
  await mutate((s) => ({ ...s, tabs: Object.fromEntries(Object.entries(s.tabs).map(([id, tab]) => [id, Number(id) >= 2 && Number(id) <= 7 ? { ...tab, lastActive: 2000 + Number(id) } : tab])) }));
  await keepReady.tick(t0 + 61_000);
  await settleNow();
  const named = Object.fromEntries(released().map(([id, keys]) => [id, keys]));
  assert.deepEqual(Object.keys(named).map(Number), [8, 9, 10]);
  assert.deepEqual(named[9], nine, 'both holds of tab 9');
  assert.deepEqual(named[10], [second], 'tab 10\'s running hold only');
  keepReady.resetKeepReady();
});

test('keep ready: whether a tab is held, and how long since it was left, for the switch log', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 94_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  keepReady.noteLeft(2, t0);
  keepReady.holdNow(2, t0);
  await settleNow(); // the hold sent
  assert.deepEqual(keepReady.switchFacts(2, t0 + 4_000), { heldAtAsk: true, hiddenForMs: 4_000 });
  assert.deepEqual(keepReady.switchFacts(3, t0 + 4_000), { heldAtAsk: false, hiddenForMs: null });
  assert.equal(keepReady.switchFacts(2, t0 + 74_500).heldAtAsk, false, 'not a hold about to end');
  keepReady.resetKeepReady();
  assert.equal(keepReady.switchFacts(2, t0 + 5_000).heldAtAsk, false, 'released');
});

test('keep ready: a background started again releases the holds the one before it placed once they aren\'t chosen (they ran out by themselves before)', async () => {
  keepReady.resetKeepReady();
  await setUpMany();
  const t0 = Date.now();
  keepReady.noteUsed(t0);
  await keepReady.tick(t0);
  await settle();
  await settle();
  // The holds this background placed are in storage.session.
  assert.deepEqual(Object.keys(fake.session.keepReadyHolds ?? {}).map(Number).sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(fake.session.keepReadyHolds[7], { [keysOf(7)[0]]: [t0 + 75_000, 0, 0] }, 'its end, not sure to run (a first hold of a tab left a while ago), not a tab just left');
  // Another, earlier run's: tab 2 (not chosen now) and tab 7 (chosen, sure),
  // and one long over.
  fake.session.keepReadyHolds = { 2: { old2: [t0 + 60_000, 1] }, 7: { old7: [t0 + 60_000, 1] }, 3: { over: [t0 - 1, 1] } };
  fake.session.keepReadyUsedAt = t0;
  const again = await import('../extension/background/keep-ready.js?holds-again');
  fake.scripts = [];
  await again.tick(t0 + 5_000);
  await settle();
  assert.deepEqual(released(), [[2, ['old2']]]);
  assert.equal(again.switchFacts(7, t0 + 5_000).heldAtAsk, true, 'held, by the run before');
  again.resetKeepReady();
  await settle();
  assert.deepEqual(released().find(([id]) => id === 7)?.[1].sort(), ['old7', keysOf(7).at(-1)].sort(), 'stopped: the earlier run\'s holds end too');
});

// Window 1 shows space "a" (tabs 1 in front, 2–6); space "b" has 7–13 (13
// used last). Each tab's last use is its id (1: 1000).
async function setUpSpaces() {
  fake.scripts = []; fake.alarms = []; fake.noPage = new Set();
  const tabs = {};
  for (let id = 1; id <= 13; id++) tabs[id] = { id, windowId: 1, index: id, url: `https://t${id}.test/`, title: '', favIconUrl: '', active: id === 1, lastActive: id === 1 ? 1000 : id };
  fake.tabs = new Map(Object.values(tabs).map((t) => [t.id, t]));
  await mutate((s) => ({
    ...s,
    spaces: [{ id: 'a', name: 'A', emoji: '', color: '' }, { id: 'b', name: 'B', emoji: '', color: '' }],
    tabs,
    tabSpace: Object.fromEntries(Object.keys(tabs).map((id) => [id, Number(id) <= 6 ? 'a' : 'b'])),
    activeSpaceByWindow: { 1: 'a' },
    settings: { ...s.settings, keepTabsReadyMinutes: 30 },
  }));
  await markSynced();
}
// A switch in window 1 as background.js activated sees it: `to` shown, the
// tab in front left (held at once), then the state's activation.
async function switchTo(to, at, { space = null } = {}) {
  const left = Object.values((await load()).tabs).find((t) => t.active && t.id !== to);
  keepReady.shown(to, at);
  if (left) keepReady.holdNow(left.id, at);
  await mutate((s) => ({ ...M.activateTab(s, to, 1, at), ...(space ? { activeSpaceByWindow: { 1: space } } : {}) }));
}
const M = await import('../extension/state/model.js');

test('keep ready: the tab left for another space stays held among the six used last (a change of space and back returns to it); the other holds of the space left end, and it isn\'t renewed', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 95_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpSpaces();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [2, 3, 4, 5, 6]);
  fake.scripts = [];
  // To space b's tab 13.
  t.mock.timers.tick(1000);
  await switchTo(13, t0 + 1000, { space: 'b' });
  await settleNow();
  t.mock.timers.tick(1500);
  await keepReady.tick(t0 + 2500);
  await settleNow();
  assert.equal(held()[0], 1, 'tab 1 at once');
  assert.deepEqual(held().slice(1).sort((a, b) => a - b), [8, 9, 10, 11, 12], 'then space b\'s used last');
  assert.deepEqual(released().map(([id]) => id).sort((a, b) => a - b), [2, 3, 4, 5, 6], 'not tab 1');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 8, 9, 10, 11, 12], 'six in all: tab 7 waits');
  assert.deepEqual(keepReady.keepReadyState().lingering, [1]);
  // Tab 1's hold runs its 75 s and isn't renewed; just after it ends, tab 7
  // takes its place.
  fake.scripts = [];
  t.mock.timers.tick(60_000);
  await settleNow();
  assert.ok(!held().includes(1), 'tab 1 not renewed (space b\'s are)');
  const [key1] = keepReady.keepReadyState().holds[1];
  fake.ends.get(key1)();
  await settleNow();
  t.mock.timers.tick(15_000);
  for (let i = 0; i < 4; i++) await settleNow(); // the tick the timer started
  assert.ok(!held().includes(1), 'tab 1 not held again');
  assert.ok(held().includes(7), 'tab 7 held once tab 1\'s hold ended');
  assert.ok(keepReady.keepReadyState().held.length <= 6);
  keepReady.resetKeepReady();
});

test('keep ready: a held key run counts the tabs it passes by their use before: the tab it started from stays held, the tabs passed aren\'t held, and the ones held before keep their holds', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 96_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpSpaces();
  // All thirteen in space a.
  await mutate((s) => ({ ...s, tabSpace: Object.fromEntries(Object.keys(s.tabs).map((id) => [id, 'a'])) }));
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [8, 9, 10, 11, 12, 13]);
  fake.scripts = [];
  // From tab 1 through 2–6 (shown in passing: navigation.js), stopping on 7.
  let at = t0;
  for (const id of [2, 3, 4, 5, 6, 7]) {
    at += 100;
    t.mock.timers.tick(100);
    if (id !== 7) keepReady.passing(id, (await load()).tabs[id].lastActive, at);
    await switchTo(id, at);
  }
  await settleNow();
  t.mock.timers.tick(250);
  assert.deepEqual(held(), [1], 'only the tab the run started from, at once');
  t.mock.timers.tick(1500);
  await keepReady.tick(at + 1500);
  await settleNow();
  assert.deepEqual(held(), [1], 'none of the tabs passed');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 9, 10, 11, 12, 13]);
  assert.deepEqual(released().map(([id]) => id), [8], 'the one used longest ago, for tab 1');
  // Tab 4 shown again, not in passing, then left: held as any tab.
  fake.scripts = [];
  await switchTo(4, at + 5000);
  await switchTo(7, at + 6000);
  await settleNow();
  assert.deepEqual(held(), [7, 4]);
  keepReady.resetKeepReady();
});

test('keep ready: past six, a tab left that can\'t be held (Margin\'s start page, a tab being closed) costs no held tab its hold', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 97_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], url: 'safari-web-extension://test/newtab.html' } } }));
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  fake.scripts = [];
  // The start page left for tab 2.
  await switchTo(2, t0 + 100);
  await settleNow();
  t.mock.timers.tick(1000);
  await settleNow();
  assert.deepEqual(released(), [], 'the start page');
  // ⌘W on tab 2: Safari brings tab 1 to the front before the removal comes.
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], url: 'https://t1.test/' } } }));
  fake.tabs.delete(2); fake.noPage.add(2);
  await switchTo(1, t0 + 2000);
  await settleNow();
  t.mock.timers.tick(1000);
  await settleNow();
  assert.deepEqual(released(), [], 'a tab being closed');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
  keepReady.resetKeepReady();
  fake.noPage = new Set();
});

test('keep ready: a release that comes while a hold is still on its way (its permission check answering late) calls it off: no hold sent after it, left to run 75 s', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 98_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 7: { ...s.tabs[7], url: 'https://slow-permission.test/' } } }));
  /** @type {(yes: boolean) => void} */
  let answer = () => {};
  fake.contains = ({ origins }) => (origins?.some((o) => o.includes('slow-permission')) ? new Promise((resolve) => { answer = resolve; }) : true);
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  assert.ok(!held().includes(7), 'still on its way');
  // Turned off before the answer: everything released.
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepTabsReadyMinutes: 0 } }));
  await keepReady.tick(t0 + 1000);
  await settleNow();
  assert.ok(!released().some(([id]) => id === 7), 'nothing to release there yet');
  answer(true);
  await settleNow();
  assert.ok(!held().includes(7), 'not sent after');
  assert.deepEqual(keepReady.keepReadyState().holds, {});
  fake.contains = null;
  keepReady.resetKeepReady();
});

test('keep ready: held for the switch log only once the hold has gone out to a process known to be running: the tab just left, or held without a break since; not a first hold of a tab left a while ago (maybe behind its resume), nor one shown since', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 99_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  keepReady.noteUsed(t0);
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  assert.ok(held().includes(9));
  assert.equal(keepReady.switchFacts(9, t0 + 100).heldAtAsk, false, 'a first hold of a tab left a while ago');
  // Tab 1 left: sure once sent; a renewal keeps it sure.
  keepReady.shown(2, t0);
  keepReady.holdNow(1, t0);
  assert.equal(keepReady.switchFacts(1, t0).heldAtAsk, false, 'not sent yet');
  await mutate((s) => M.activateTab(s, 2, 1, t0));
  await settleNow();
  assert.equal(keepReady.switchFacts(1, t0 + 100).heldAtAsk, true);
  await keepReady.tick(t0 + 60_000);
  await settleNow();
  assert.equal(keysOf(1).length, 2, 'renewed');
  fake.ends.get(keysOf(1)[0])(); // the first ran out
  await settleNow();
  assert.equal(keepReady.switchFacts(1, t0 + 76_000).heldAtAsk, true, 'the renewal');
  keepReady.shown(1, t0 + 77_000);
  assert.equal(keepReady.switchFacts(1, t0 + 77_000).heldAtAsk, false, 'shown since');
  keepReady.resetKeepReady();
});

test('keep ready: a background started again keeps the hold of the tab left for another space (Safari stops an idle background)', async () => {
  keepReady.resetKeepReady();
  await setUpSpaces();
  await mutate((s) => ({ ...s, activeSpaceByWindow: { 1: 'b' }, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: false, lastActive: 5000 }, 13: { ...s.tabs[13], active: true, lastActive: 5000 } } }));
  const t0 = Date.now();
  // The run before held tab 1 as it was left, then stopped.
  fake.session.keepReadyHolds = { 1: { left1: [t0 + 60_000, 1, 1] }, 2: { old2: [t0 + 60_000, 0, 0] } };
  fake.session.keepReadyUsedAt = t0;
  const again = await import('../extension/background/keep-ready.js?left-again');
  fake.scripts = [];
  await again.tick(t0);
  await settle();
  assert.deepEqual(released(), [[2, ['old2']]], 'not tab 1');
  assert.deepEqual(again.keepReadyState().lingering, [1]);
  assert.ok(!held().includes(1), 'nor held again');
  assert.equal(again.switchFacts(1, t0).heldAtAsk, true);
  again.resetKeepReady();
});

test('keep ready: a hold that reached its page only once its tab was in front (sent behind a resume, the tab clicked meanwhile) isn\'t forgotten by a tick while the tab is in front: it\'s named once the tab is behind and not kept', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 60_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  keepReady.noteUsed(t0);
  keepReady.noteLeft(2, t0 - 40 * MIN); // left long ago: its first hold may wait behind a resume
  keepReady.resetKeepReady();
  await keepReady.tick(t0);
  await settleNow();
  const [first] = keysOf(2);
  assert.ok(first);
  assert.equal(keepReady.isHeld(2, t0 + 10), false, 'not sure to run (maybe behind its resume)');
  // The click on tab 2: shown before its hold has reached the page.
  t.mock.timers.tick(500);
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: false }, 2: { ...s.tabs[2], active: true, lastActive: t0 + 500 } } }));
  keepReady.shown(2, t0 + 500);
  t.mock.timers.tick(1500);
  await keepReady.tick(t0 + 2000); // tab 2 still in front
  await settleNow();
  assert.deepEqual(released().filter(([id]) => id === 2), [], 'nothing sent to the tab in front');
  assert.deepEqual(keepReady.keepReadyState().holds[2], [first], 'its key kept');
  // Left for tab 1 (held at once), then turned off: both holds named.
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: true, lastActive: t0 + 5000 }, 2: { ...s.tabs[2], active: false } } }));
  t.mock.timers.tick(3000);
  keepReady.holdNow(2, t0 + 5000);
  await settleNow();
  const second = keysOf(2).at(-1);
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepTabsReadyMinutes: 0 } }));
  await keepReady.tick(t0 + 6000);
  await settleNow();
  const named = released().filter(([id]) => id === 2).flatMap(([, keys]) => keys);
  assert.deepEqual(named.sort(), [first, second].sort());
  assert.equal(keepReady.keepReadyState().holds[2], undefined);
  keepReady.resetKeepReady();
});

test('keep ready: a key kept for the tab in front through a stop (turned off while it\'s in front) is named as the next tick stops again, once the tab is behind', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 61_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  keepReady.noteUsed(t0);
  keepReady.holdNow(2, t0);
  await settleNow();
  const [key] = keysOf(2);
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepTabsReadyMinutes: 0 }, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: false }, 2: { ...s.tabs[2], active: true, lastActive: t0 + 100 } } }));
  keepReady.shown(2, t0 + 100);
  await keepReady.tick(t0 + 200);
  await settleNow();
  assert.deepEqual(released().filter(([id]) => id === 2), [], 'in front: nothing sent');
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: true, lastActive: t0 + 1000 }, 2: { ...s.tabs[2], active: false } } }));
  await keepReady.tick(t0 + 1500);
  await settleNow();
  assert.deepEqual(released().filter(([id]) => id === 2), [[2, [key]]]);
  keepReady.resetKeepReady();
});

test('keep ready: when tabs were left is forgotten for closed tabs with keep-ready off too (it\'s noted either way, and written whole at each switch)', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 62_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp({ minutes: 0 });
  keepReady.noteLeft(2, t0);
  keepReady.noteLeft(99, t0); // closed since
  await keepReady.tick(t0 + 1000);
  assert.equal(keepReady.hiddenFor(99, t0 + 1000), null);
  assert.equal(keepReady.hiddenFor(2, t0 + 1000), 1000);
  keepReady.noteLeft(3, t0 + 1000);
  await settleNow();
  assert.deepEqual(Object.keys(fake.session.keepReadyLeftAt ?? {}).sort(), ['2', '3'], 'nor written again');
  keepReady.resetKeepReady();
});

test('keep ready: a tab shown since its last noted leave counts as hidden no longer than since that show (a leave missed: the tab left taken from a state still behind)', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 63_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  keepReady.noteLeft(2, t0 - 60 * MIN);
  keepReady.shown(2, t0 - 2000); // its leave after this never noted
  assert.equal(keepReady.hiddenFor(2, t0), 2000);
  keepReady.resetKeepReady();
});
