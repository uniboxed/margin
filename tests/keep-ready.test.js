// background/keep-ready.js: the tab just left kept ready to show (Safari),
// against a fake browser API.
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
async function setUp({ minutes = 1 } = {}) {
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
    settings: { ...s.settings, keepLeftTabReadyMinutes: minutes },
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

const M = await import('../extension/state/model.js');
// A switch in window 1 as background.js activated sees it: Safari in use,
// `to` shown, the tab in front left (held at once), then the state's
// activation.
async function switchTo(to, at, { space = null } = {}) {
  const left = Object.values((await load()).tabs).find((t) => t.windowId === 1 && t.active && t.id !== to);
  keepReady.noteFocused();
  keepReady.shown(to, at);
  if (left) keepReady.noteLeft(left.id, at);
  if (left) keepReady.holdNow(left.id, at);
  await mutate((s) => ({ ...M.activateTab(s, to, 1, at), ...(space ? { activeSpaceByWindow: { 1: space } } : {}) }));
}
// Window 1 shows space "a": tab 1 in front, tabs 2–10 behind, used in that
// order (10 last).
async function setUpMany({ minutes = 1 } = {}) {
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
    settings: { ...s.settings, keepLeftTabReadyMinutes: minutes },
  }));
  await markSynced();
}

test('keep ready: only the tab just left is held, once, for the setting\'s minutes; nothing else of the space, and no alarm', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 1_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await keepReady.tick(t0); // a background start, a change of the setting
  await settleNow();
  assert.deepEqual(held(), [], 'the space\'s other tabs aren\'t held (six of them before)');
  await switchTo(2, t0);
  await settleNow();
  assert.deepEqual(held(), [1]);
  assert.deepEqual(fake.scripts.filter((x) => x.func === 'keepAwake').map((x) => x.ms), [60_000], 'one minute');
  assert.ok(!fake.alarms.some(([what]) => what === 'create'), 'no alarm: nothing is renewed');
  keepReady.resetKeepReady();
});

test('keep ready: the hold isn\'t renewed: once its minute is over, nothing holds the tab, whatever Safari does meanwhile', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 2_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await switchTo(2, t0);
  await settleNow();
  const [key] = keysOf(1);
  fake.scripts = [];
  for (let s = 0; s < 300; s++) {
    t.mock.timers.tick(1000);
    if (s % 20 === 0) keepReady.noteFocused(); // a window focused, say
    if (s === 59) fake.ends.get(key)(); // its own timer in the page
    await settleNow();
  }
  await keepReady.tick();
  await settleNow();
  assert.deepEqual(held(), [], 'never renewed (every minute for 30 minutes before)');
  assert.deepEqual(keepReady.keepReadyState().held, []);
  assert.equal(keepReady.switchFacts(1).heldAtAsk, false);
  keepReady.resetKeepReady();
});

test('keep ready: the setting\'s minutes are the hold\'s length, at most ten; 0: off, nothing held', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 3_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  for (const [minutes, ms] of [[3, 180_000], [30, 600_000], [0, null]]) {
    await setUp({ minutes });
    await switchTo(2, t0);
    await settleNow();
    assert.deepEqual(fake.scripts.filter((x) => x.func === 'keepAwake').map((x) => x.ms), ms == null ? [] : [ms], `${minutes} minutes`);
    keepReady.resetKeepReady();
  }
});

test('keep ready: at most two: the tab left before the last one stays held, the one before that lets go at once', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 4_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  let at = t0;
  for (const id of [2, 3, 4, 5]) {
    at += 1000;
    t.mock.timers.tick(1000);
    await switchTo(id, at);
    await settleNow(); // the hold sent
    t.mock.timers.tick(250); // and not failed
    assert.ok(keepReady.keepReadyState().held.length <= 2, `${keepReady.keepReadyState().held.length} held after tab ${id} was shown`);
  }
  assert.deepEqual(held(), [1, 2, 3, 4]);
  assert.deepEqual(released(), [[1, keysOf(1)], [2, keysOf(2)]], 'the ones left longest ago, in turn');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [3, 4]);
  keepReady.resetKeepReady();
});

test('keep ready: past two, a tab let go is let go though the state still has it in front (its activations queued behind writes, through quick switches)', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 4_500_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], lastActive: 1 } } })); // in front since long ago, by the state
  // Tabs 2, 3, 4 shown in turn; the state hasn't caught up with any of it.
  let at = t0;
  for (const [to, left] of [[2, 1], [3, 2], [4, 3]]) {
    at += 120;
    t.mock.timers.tick(120);
    keepReady.shown(to, at);
    keepReady.noteLeft(left, at);
    keepReady.holdNow(left, at);
    await settleNow();
  }
  t.mock.timers.tick(250);
  assert.deepEqual(released(), [[1, keysOf(1)]], 'named: tab 1 was left (kept running as a front tab\'s before)');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [2, 3]);
  assert.equal(keepReady.keepReadyState().holds[1], undefined);
  keepReady.resetKeepReady();
});

test('keep ready: past two, the tab left longest ago lets go, by the tab events, though the state\'s last uses say otherwise (behind a run of quick switches)', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 4_600_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], lastActive: 1 } } })); // the state's, stale
  // Tabs 2 and 3 left, then tab 1 (for tab 4).
  let at = t0;
  for (const left of [2, 3, 1]) {
    at += 120;
    t.mock.timers.tick(120);
    keepReady.noteLeft(left, at);
    keepReady.holdNow(left, at);
    await settleNow();
  }
  t.mock.timers.tick(250);
  assert.deepEqual(released().map(([id]) => id), [2], 'not tab 1, left last');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 3]);
  keepReady.resetKeepReady();
});

test('keep ready: the tab left is the one the activations put in front, though the state is behind them: through two quick switches the tab just left is held, not the one two back again', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 4_700_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  const s = await load(); // tab 1 in front, and so it stays in the state: its activations' writes queued
  let at = t0;
  const lefts = [];
  for (const to of [2, 3]) {
    at += 120;
    t.mock.timers.tick(120);
    // As background.js: the activation as it comes, then activated.
    const left = keepReady.frontChanged(1, to, s);
    lefts.push(left);
    keepReady.noteFocused(null, at);
    keepReady.shown(to, at);
    if (left != null) keepReady.noteLeft(left, at);
    if (left != null) keepReady.holdNow(left, at);
    await settleNow();
  }
  t.mock.timers.tick(250);
  assert.deepEqual(lefts, [1, 2]);
  assert.deepEqual(held(), [1, 2], 'tab 2 held, tab 1 once (from the state: tab 1 twice, tab 2 never)');
  assert.equal(keepReady.hiddenFor(2, at + 1000), 1000, 'tab 2 hidden since it was left');
  // A window this background hasn't seen a switch in: from the state.
  const other = { tabs: { 5: { id: 5, windowId: 2, active: true }, 6: { id: 6, windowId: 2, active: false } } };
  assert.equal(keepReady.frontChanged(2, 6, /** @type {any} */ (other)), 5);
  // The same tab told again: none left. The tab in front closed (or moved to
  // another window): none, whatever the state still says.
  assert.equal(keepReady.frontChanged(2, 6, /** @type {any} */ (other)), null);
  keepReady.frontGone(6);
  assert.equal(keepReady.frontChanged(2, 5, /** @type {any} */ (other)), null);
  keepReady.resetKeepReady();
});

test('keep ready: a page\'s word that Safari was left doesn\'t count when Safari was seen in use after it lost focus, when it comes from another window than the one focused last, or from a tab no longer in front', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 4_800_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  const s = await load();
  keepReady.noteFocused(1, t0); // window 1 focused
  t.mock.timers.tick(100);
  const left = keepReady.frontChanged(1, 2, s); // a switch to tab 2
  keepReady.noteFocused(null, t0 + 100);
  keepReady.shown(2, t0 + 100);
  keepReady.noteLeft(/** @type {number} */ (left), t0 + 100);
  keepReady.holdNow(/** @type {number} */ (left), t0 + 100);
  await settleNow();
  t.mock.timers.tick(250);
  assert.deepEqual(held(), [1]);
  const nothingLetGo = async (why) => {
    t.mock.timers.tick(5000);
    await settleNow();
    assert.deepEqual(released(), [], why);
    assert.equal(keepReady.keepReadyState().away, false, why);
  };
  // Tab 2's page lost focus before the switch's activation came (Safari
  // took focus before hiding it, say), its word after.
  keepReady.noteAway({ at: t0 + 90, tabId: 2, windowId: 1 });
  await nothingLetGo('lost focus before Safari was seen in use');
  // Tab 1's page, left, lost focus while still drawn.
  keepReady.noteAway({ at: Date.now(), tabId: 1, windowId: 1 });
  await nothingLetGo('a tab no longer in front');
  // A click into window 2: its focus came first, window 1's page's word after.
  keepReady.noteFocused(2);
  keepReady.noteAway({ at: Date.now(), tabId: 2, windowId: 1 });
  await nothingLetGo('another window focused last');
  // Window 1 focused again, then Safari left from its page: that counts.
  keepReady.noteFocused(1);
  t.mock.timers.tick(10);
  keepReady.noteAway({ at: Date.now(), tabId: 2, windowId: 1 });
  t.mock.timers.tick(3000);
  await settleNow();
  assert.deepEqual(released(), [[1, keysOf(1)]]);
  assert.equal(keepReady.keepReadyState().away, true);
  keepReady.resetKeepReady();
});

test('keep ready: Safari left for another app: every hold ends 3 s later, none is placed until Safari is used again, and nothing is held again then', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 5_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await switchTo(2, t0);
  await switchTo(3, t0 + 1000);
  await settleNow();
  t.mock.timers.tick(1250);
  const keys = { 1: keysOf(1), 2: keysOf(2) };
  keepReady.noteAway(); // windows.onFocusChanged with WINDOW_ID_NONE, or the page in front's blur
  t.mock.timers.tick(2900);
  await settleNow();
  assert.deepEqual(released(), [], 'not at once');
  t.mock.timers.tick(100);
  await settleNow();
  assert.deepEqual(Object.fromEntries(released()), keys, 'both, every key');
  assert.deepEqual(keepReady.keepReadyState().held, []);
  assert.equal(keepReady.keepReadyState().away, true);
  // A tab shown meanwhile (not by the user: a link from another app comes
  // with Safari's focus) isn't held without Safari in use.
  fake.scripts = [];
  keepReady.holdNow(3, t0 + 10_000);
  await settleNow();
  assert.deepEqual(held(), []);
  // Back: nothing is held again by itself; the next tab left is.
  keepReady.noteFocused();
  await keepReady.tick(t0 + 11_000);
  await settleNow();
  assert.deepEqual(held(), []);
  await switchTo(4, t0 + 12_000);
  await settleNow();
  assert.deepEqual(held(), [3]);
  keepReady.resetKeepReady();
});

test('keep ready: Safari back within 3 s (a glance at another app, or a WINDOW_ID_NONE between two Safari windows): the holds run on', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 6_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await switchTo(2, t0);
  await settleNow();
  keepReady.noteAway();
  t.mock.timers.tick(1500);
  keepReady.noteFocused(); // a window focused, the page in front focused, a switch
  t.mock.timers.tick(5000);
  await settleNow();
  assert.deepEqual(released(), []);
  assert.deepEqual(keepReady.keepReadyState().held, [1]);
  keepReady.resetKeepReady();
});

test('keep ready: a background started again knows the holds the one before it placed: counted toward the two, released when Safari is left, and no tab held again for it', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 7_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  fake.session.keepReadyHolds = { 8: { old8: [t0 + 40_000, 1] }, 9: { old9: [t0 + 50_000, 1] }, 7: { over: [t0 - 1, 1] } };
  keepReady.startedAgain();
  await keepReady.sessionKnown();
  await keepReady.tick(t0); // background.js, after the first sync
  await settleNow();
  assert.deepEqual(held(), [], 'nothing held afresh at a start (six before)');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [8, 9], 'the earlier run\'s, still running; not the one over');
  assert.equal(keepReady.switchFacts(9, t0).heldAtAsk, true);
  // The switch that started it: tab 1 left, the third hold.
  await switchTo(10, t0 + 100);
  await settleNow();
  t.mock.timers.tick(250);
  assert.deepEqual(released(), [[8, ['old8']]], 'the one used longest ago lets go');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 9]);
  fake.scripts = [];
  keepReady.noteAway();
  t.mock.timers.tick(3000);
  await settleNow();
  assert.deepEqual(released().map(([id, keys]) => [id, keys.length]).sort(), [[1, 1], [9, 1]]);
  assert.deepEqual(released().find(([id]) => id === 9)[1], ['old9']);
  keepReady.resetKeepReady();
  fake.session = {};
});

test('keep ready: turned off, every hold still running ends at once', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 8_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await switchTo(2, t0);
  await switchTo(3, t0 + 1000);
  await settleNow();
  const keys = { 1: keysOf(1), 2: keysOf(2) };
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepLeftTabReadyMinutes: 0 } }));
  await keepReady.tick(t0 + 5_000);
  await settleNow();
  assert.deepEqual(Object.fromEntries(released()), keys);
  assert.deepEqual(keepReady.keepReadyState().held, []);
  assert.deepEqual(keepReady.keepReadyState().holds, {});
  keepReady.resetKeepReady();
});

test('keep ready: a tab left that can\'t be held (no page: Margin\'s start page, a tab being closed) is marked, costs no held tab its hold, and is taken back by a page event or a show', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 9_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
  await switchTo(2, t0);
  await settleNow();
  t.mock.timers.tick(250);
  await switchTo(3, t0 + 300);
  await settleNow();
  t.mock.timers.tick(250);
  fake.noPage.add(3); // ⌘W on tab 3: Safari brings tab 4 to the front before the removal comes
  await switchTo(4, t0 + 600);
  await settleNow();
  t.mock.timers.tick(1000);
  await settleNow();
  assert.deepEqual(released(), [], 'tabs 1 and 2 keep theirs');
  assert.deepEqual(keepReady.keepReadyState().held.sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(keepReady.keepReadyState().noPage, [3]);
  assert.equal(keepReady.hasNoPage(3), true);
  keepReady.pageChanged(3); // tabs.onUpdated: status or address (background.js)
  assert.deepEqual(keepReady.keepReadyState().noPage, []);
  fake.noPage = new Set([4]);
  await switchTo(5, t0 + 2000);
  await settleNow();
  assert.equal(keepReady.hasNoPage(4), true);
  keepReady.shown(4);
  assert.equal(keepReady.hasNoPage(4), false, 'shown: Safari loads it then');
  keepReady.resetKeepReady();
  fake.noPage = new Set();
});

test('keep ready: a page event while a hold was on its way: the tab isn\'t marked (its page may have come just after)', async () => {
  keepReady.resetKeepReady();
  await setUp();
  const t0 = Date.now();
  let reject;
  const executeScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (call) => {
    if (call.target.tabId !== 1) return executeScript(call);
    fake.scripts.push({ tabId: 1, world: call.world, func: call.func.name, ms: call.args?.[0] });
    return new Promise((_, no) => { reject = no; });
  };
  try {
    await switchTo(2, t0);
    await settle();
    keepReady.pageChanged(1); // its load started meanwhile
    reject(new Error('Could not execute script on this tab'));
    await settle();
    assert.deepEqual(keepReady.keepReadyState().noPage, []);
  } finally {
    chrome.scripting.executeScript = executeScript;
    keepReady.resetKeepReady();
  }
});

test('keep ready: a tab shown and left again is held afresh at once (its hold ended as it was shown); a late answer from its older hold doesn\'t forget the newer', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 10_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await switchTo(2, t0);
  await switchTo(1, t0 + 10_000);
  await switchTo(2, t0 + 20_000);
  await settleNow();
  assert.deepEqual(held(), [1, 2, 1]);
  const [first, second] = keysOf(1);
  fake.ends.get(first)();
  await settleNow();
  assert.ok(keepReady.keepReadyState().held.includes(1), 'the newer hold is still known');
  assert.deepEqual(keepReady.keepReadyState().holds[1], [second]);
  keepReady.resetKeepReady();
});

test('keep ready: a held key run holds the tab it started from, not the tabs it passed', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 11_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUpMany();
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
  assert.deepEqual(held(), [1], 'only the tab the run started from');
  // Tab 4 shown again, not in passing, then left: held as any tab.
  fake.scripts = [];
  await switchTo(4, at + 5000);
  await switchTo(7, at + 6000);
  await settleNow();
  assert.deepEqual(held(), [7, 4]);
  keepReady.resetKeepReady();
});

test('keep ready: a release that comes while a hold is still on its way (its permission check answering late) calls it off: no hold sent after it', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 12_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], url: 'https://slow-permission.test/' } } }));
  /** @type {(yes: boolean) => void} */
  let answer = () => {};
  fake.contains = ({ origins }) => (origins?.some((o) => o.includes('slow-permission')) ? new Promise((resolve) => { answer = resolve; }) : true);
  await switchTo(2, t0);
  await settleNow();
  assert.ok(!held().includes(1), 'still on its way');
  keepReady.noteAway();
  t.mock.timers.tick(3000);
  await settleNow();
  assert.ok(!released().some(([id]) => id === 1), 'nothing to release there yet');
  answer(true);
  await settleNow();
  assert.ok(!held().includes(1), 'not sent after');
  assert.deepEqual(keepReady.keepReadyState().holds, {});
  fake.contains = null;
  keepReady.resetKeepReady();
});

test('keep ready: whether a tab is held, and how long since it was left, for the switch log', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 13_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  keepReady.noteLeft(1, t0);
  keepReady.holdNow(1, t0);
  assert.equal(keepReady.switchFacts(1, t0).heldAtAsk, false, 'not sent yet');
  await settleNow(); // the hold sent
  assert.deepEqual(keepReady.switchFacts(1, t0 + 4_000), { heldAtAsk: true, hiddenForMs: 4_000 });
  assert.deepEqual(keepReady.switchFacts(3, t0 + 4_000), { heldAtAsk: false, hiddenForMs: null });
  assert.equal(keepReady.switchFacts(1, t0 + 59_500).heldAtAsk, false, 'not a hold about to end');
  keepReady.shown(1, t0 + 10_000);
  assert.equal(keepReady.switchFacts(1, t0 + 10_000).heldAtAsk, false, 'shown since');
  keepReady.resetKeepReady();
});

test('keep ready: a hold that reached its page only once its tab was in front (shown before the hold landed) is named once the tab is behind', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 14_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await switchTo(2, t0);
  await settleNow();
  const [first] = keysOf(1);
  // Clicked back at once: in front, its hold kept (keepAwake doesn't end on
  // finding its page visible).
  await switchTo(1, t0 + 500);
  keepReady.noteAway();
  t.mock.timers.tick(3000);
  await settleNow();
  assert.deepEqual(released().filter(([id]) => id === 1), [], 'nothing sent to the tab in front');
  assert.deepEqual(keepReady.keepReadyState().holds[1], [first], 'its key kept');
  // Left again (held afresh), then turned off: both named.
  await switchTo(3, t0 + 5000);
  await settleNow();
  const second = keysOf(1).at(-1);
  await mutate((s) => ({ ...s, settings: { ...s.settings, keepLeftTabReadyMinutes: 0 } }));
  await keepReady.tick(t0 + 6000);
  await settleNow();
  const named = released().filter(([id]) => id === 1).flatMap(([, keys]) => keys);
  assert.deepEqual(named.sort(), [first, second].sort());
  assert.equal(keepReady.keepReadyState().holds[1], undefined);
  keepReady.resetKeepReady();
});

test('keep ready: a closed tab is forgotten at once: its holds, when it was left, whether it had a page', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 15_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  await switchTo(2, t0);
  await settleNow();
  keepReady.closed(1); // tabs.onRemoved (background.js)
  await settleNow();
  assert.equal(keepReady.hiddenFor(1, t0 + 1000), null);
  assert.deepEqual(keepReady.keepReadyState().held, []);
  assert.deepEqual(keepReady.keepReadyState().holds, {});
  assert.ok(!('1' in (fake.session.keepReadyLeftAt ?? {})), 'nor in storage.session');
  assert.ok(!('1' in (fake.session.keepReadyHolds ?? {})));
  keepReady.resetKeepReady();
});

test('keep ready: when tabs were left is forgotten for closed tabs with keep-ready off too (it\'s noted either way, and written whole at each switch)', async (t) => {
  keepReady.resetKeepReady();
  const t0 = 16_000_000;
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
  const t0 = 17_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: t0 });
  await setUp();
  keepReady.noteLeft(2, t0 - 60 * MIN);
  keepReady.shown(2, t0 - 2000); // its leave after this never noted
  assert.equal(keepReady.hiddenFor(2, t0), 2000);
  keepReady.resetKeepReady();
});

test('keep ready: the tabs marked with no page outlast the background (Safari stops it when idle); one taken back before the read is dropped from storage.session too', async () => {
  keepReady.resetKeepReady();
  await setUpMany();
  const t0 = Date.now();
  fake.session = { keepReadyNoPage: { 10: t0 + 10 * MIN, 9: t0 + 10 * MIN } };
  keepReady.startedAgain();
  keepReady.shown(9); // shown before the read: Safari loaded it
  await keepReady.sessionKnown();
  await settle();
  assert.equal(keepReady.hasNoPage(10), true);
  assert.equal(keepReady.hasNoPage(9), false);
  assert.deepEqual(Object.keys(fake.session.keepReadyNoPage), ['10'], 'storage.session forgets tab 9 too');
  keepReady.resetKeepReady();
  fake.session = {};
});
