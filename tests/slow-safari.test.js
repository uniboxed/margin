// A Safari slow to answer, and a background whose timers fire late (a Mac
// just rebooted, load average 74: 2026-11-03). A switch starts from what
// Margin knows instead of waiting seconds for Safari to say where its tab
// is; a restore behind the page is bounded once Safari is found slow, and
// the tab shown soon after the click, as far as it got; and the page is
// answered that its tab was shown, not that it didn't switch, however late
// the timers (background/slow.js, background/tabs.js focusTab, background.js).
// Through background.js's own listeners, as answer-in-time.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The test's own clock and Safari's run on time; the background's timers
// fire `fake.lagMs` late (patched below).
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const never = () => new Promise(() => {});
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => (listeners[name] ?? []).map((fn) => fn(...args));

const fake = {
  tabs: new Map(),
  // How long Safari takes to answer a tabs.get (per tab), a script that
  // finds no page, and any tabs.update.
  getMs: () => 0,
  noPageMs: 0,
  updateMs: 0,
  hung: new Set(), // tabs whose update is carried out but never answered (a hung process)
  scriptsAt: new Map(), // tab → when its scripts run (a process Safari resumes then, at background priority)
  noPage: new Set(), // tabs Safari unloaded: a script there fails
  // Tabs Safari loads as they're first selected: { startMs, commitMs,
  // paintMs, loadMs } from then (the page's scripts fail until it commits).
  loads: new Map(),
  painted: new Set(),
  lagMs: 0,
  sessionStuck: false, // storage.session doesn't answer whether introductions are off
  local: {},
  session: {},
  updates: [],
};
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, (Number(ms) || 0) + fake.lagMs, ...args);

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
// A tab Safari unloaded, loading once it's first selected.
function startLoad(id) {
  const how = fake.loads.get(id);
  if (!how) return;
  fake.loads.delete(id);
  sleep(how.startMs ?? 0).then(() => { if (fake.tabs.has(id)) fake.tabs.get(id).status = 'loading'; });
  sleep(how.commitMs ?? 0).then(() => fake.noPage.delete(id));
  if (how.paintMs != null) sleep(how.paintMs).then(() => fake.painted.add(id));
  if (how.loadMs != null) sleep(how.loadMs).then(() => { if (fake.tabs.has(id)) fake.tabs.get(id).status = 'complete'; });
}
const readiness = async (id, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const tab = fake.tabs.get(id);
    if (tab?.status === 'complete' && !fake.loads.has(id)) return 'loaded';
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
    get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: async (id) => {
      const ms = fake.getMs(id);
      if (ms === Infinity) return never();
      if (ms) await sleep(ms);
      const t = fake.tabs.get(id);
      if (!t) throw new Error(`No tab with id ${id}`);
      return { ...t };
    },
    query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map((t) => ({ ...t })),
    update: async (id, change) => {
      if (!fake.tabs.has(id)) throw new Error(`No tab with id ${id}`);
      fake.updates.push({ id, change, at: Date.now() });
      if (change.active) {
        startLoad(id);
        bringToFront(id);
      }
      if (fake.hung.has(id)) return never();
      if (fake.updateMs) await sleep(fake.updateMs);
      return { ...fake.tabs.get(id) };
    },
    sendMessage: (tabId, message) => (fake.noPage.has(tabId) ? sleep(fake.noPageMs).then(() => { throw new Error('no page'); }) : message?.type === 'margin-hold' ? never() : sleep(2).then(() => (message?.type === 'switching' || message?.type === 'margin-release' ? true : undefined))),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }),
    create: async () => { throw new Error('not here'); }, remove: async () => {}, reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      if (fake.noPage.has(target.tabId)) {
        await sleep(fake.noPageMs);
        throw new Error('Could not execute script on this tab');
      }
      await sleep(Math.max(2, (fake.scriptsAt.get(target.tabId) ?? 0) - Date.now()));
      let result = true;
      if (func?.name === 'prepareSidebarInPage') result = { ready: true, token: args?.[0]?.token };
      else if (func?.name === 'paintBarrierInPage') result = 'drawn';
      else if (func?.name === 'cutOffInPage') result = { cutOff: false };
      else if (func?.name === 'readyInPage') result = await readiness(target.tabId, args?.[0] ?? 0);
      return [{ result }];
    },
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete fake.local[k]; },
    },
    session: {
      get: async (keys) => (fake.sessionStuck && keys === 'introductionsOff' ? never() : pick(fake.session, keys)),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
};

// Tabs 1–9 loaded (1 in front), 20–29 unloaded (as after a relaunch).
for (let id = 1; id <= 9; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, status: 'complete', active: id === 1 });
for (let id = 20; id <= 29; id++) {
  fake.tabs.set(id, { id, windowId: 1, url: `https://u${id}.test/`, title: `U${id}`, index: id - 11, status: 'complete', active: false });
  fake.noPage.add(id);
}

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
const { focusTab, injectIntoOpenTabs, resetIntroductions } = await import('../extension/background/tabs.js');
// Tabs these tests didn't prove to have WebKit's mark count as having it, as
// every tab did before it was tracked (background/tabs.js; its own tests:
// tests/in-window.test.js).
(await import('../extension/background/tabs.js')).assumeMarkedForTests(true);
const { tapLog } = await import('../extension/background/diagnostics.js');
const slow = await import('../extension/background/slow.js');

const front = () => [...fake.tabs.values()].find((t) => t.active).id;
const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id).url });
// A page's request, as content/core.js send() makes it: its deadline, and
// the grace it waits past it.
const WAIT_MS = 7000;
const GRACE_MS = 3000;
function ask(type, payload = {}, { waitMs = WAIT_MS, graceMs = GRACE_MS } = {}) {
  const asked = Date.now();
  const deadline = asked + waitMs;
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload, deadline, ...(graceMs != null ? { waitsUntil: deadline + graceMs } : {}) }, sender(front()), (reply) => resolve({ reply, ms: Date.now() - asked, asked, deadline }));
  });
}
async function settledOn(id) {
  for (let i = 0; i < 200; i++) {
    if ((await store.load()).tabs[id]?.active) return;
    await sleep(10);
  }
  assert.fail(`tab ${id} never known in front`);
}
// Back to tab 1, Safari quick again, not known slow.
async function calm() {
  fake.getMs = () => 0;
  fake.noPageMs = 0;
  fake.updateMs = 0;
  fake.lagMs = 0;
  fake.hung.clear();
  fake.scriptsAt.clear();
  bringToFront(1);
  await settledOn(1);
  await sleep(50);
  slow.resetSlow();
  fake.updates = [];
}
// The switch log's entries for tab `id` while `fn` runs.
async function logged(id, fn) {
  const entries = [];
  tapLog((e) => entries.push(e));
  try {
    const out = await fn();
    await sleep(20);
    return { out, entry: entries.find((e) => e.kind === 'switch' && e.tabId === id) };
  } finally {
    tapLog(null);
  }
}
// When the real show of tab `id` went out (its last update), from `asked`.
const shownAt = (id, asked) => (fake.updates.filter((u) => u.id === id && u.change.active).at(-1)?.at ?? Infinity) - asked;

test('setup: Margin started, its tabs matched, the open-tab repair done', async () => {
  for (let i = 0; i < 200 && !store.isSynced(); i++) await sleep(20);
  assert.ok(store.isSynced());
  await settledOn(1);
  await injectIntoOpenTabs({ retry: false });
  await calm();
});

test('a switch to a tab Margin knows doesn\'t wait seconds for Safari to say where it is: it starts at once, and with Safari that slow the tab is shown as it is, as Safari would show it', async () => {
  await calm();
  fake.getMs = (id) => (id === 2 ? 2500 : 0);
  const { out: { reply, ms, asked }, entry } = await logged(2, () => ask('activateTab', { tabId: 2 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 2 } });
  assert.ok(shownAt(2, asked) < 900, `shown ${shownAt(2, asked)} ms after the ask (Safari answers where it is after 2500)`);
  assert.ok(ms < 1200, `answered after ${ms} ms`);
  assert.equal(front(), 2);
  assert.ok(entry?.before && entry.before.resolve < 400, `the lookup before the switch took ${entry?.before?.resolve} ms`);
  assert.equal(entry?.plain, 'tab');
  assert.ok(entry?.slow, 'the switch log says what showed Safari slow');
});

test('a tab Margin knows that Safari says is gone (late) isn\'t shown: the page is told it\'s no longer open', async () => {
  await calm();
  const gone = fake.tabs.get(9);
  fake.getMs = (id) => (id === 9 ? 1500 : 0);
  fake.tabs.delete(9); // closed, its removal not handled yet
  try {
    const { reply } = await ask('activateTab', { tabId: 9 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /No tab with id|no longer open/);
    assert.equal(front(), 1);
  } finally {
    fake.tabs.set(9, gone);
  }
});

test('an unloaded tab, with Safari slow to fail a script where there\'s no page: shown soon after the click, loading, not restored behind the page for seconds', async () => {
  await calm();
  fake.noPageMs = 600;
  fake.loads.set(20, { startMs: 100, commitMs: 1500, paintMs: 3000, loadMs: 5000 });
  const { out: { reply, asked }, entry } = await logged(20, () => ask('activateTab', { tabId: 20 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 20 } });
  const at = shownAt(20, asked);
  assert.ok(at < 1600, `shown ${at} ms after the ask: ${JSON.stringify(entry)}`);
  assert.equal(front(), 20);
  assert.ok(entry?.slow, JSON.stringify(entry));
  await sleep(200);
});

test('a restore behind the page that finds Safari slow on its way (its calls taking seconds from the flip on) is cut short: the tab is shown about 1.5 s after the ask, as far as it got', async () => {
  await calm();
  fake.loads.set(21, { startMs: 50, commitMs: 2500, paintMs: 4000, loadMs: 6000 });
  // From the restore's flip on, Safari takes 3 s to say where a tab is.
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, change) => {
    if (id === 21 && change.active) fake.getMs = () => 3000;
    return update(id, change);
  };
  try {
    const { out: { reply, asked }, entry } = await logged(21, () => ask('activateTab', { tabId: 21 }));
    assert.deepEqual(reply, { ok: true, result: { shown: 21 } });
    const at = shownAt(21, asked);
    assert.ok(at < 2100, `shown ${at} ms after the ask: ${JSON.stringify({ updates: fake.updates.map((u) => [u.id, u.at - asked]), entry })}`);
    assert.ok(fake.updates.filter((u) => u.id === 21).length >= 2, 'restored behind the page first (Safari was quick then)');
    assert.equal(front(), 21);
    assert.equal(entry?.restored, 'cut', JSON.stringify(entry));
    assert.ok(!entry?.introduced, 'no introduction: no time left for it');
    assert.match(String(entry?.markReason), /:skipped:cut$/, JSON.stringify(entry));
  } finally {
    chrome.tabs.update = update;
    await sleep(3200); // Safari's late answers
  }
});

test('the background\'s timers firing 1.5 s late: a tab whose show Safari doesn\'t answer (a hung process) is answered as shown before its page\'s deadline', async () => {
  await calm();
  fake.hung.add(3);
  fake.lagMs = 1500;
  try {
    const { reply, ms } = await Promise.race([ask('activateTab', { tabId: 3 }), sleep(WAIT_MS + GRACE_MS + 3000).then(() => ({ reply: 'no answer', ms: Infinity }))]);
    assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
    assert.ok(ms < WAIT_MS, `answered ${ms} ms after the ask (the page's deadline is ${WAIT_MS})`);
    assert.equal(front(), 3);
  } finally {
    fake.lagMs = 0;
    fake.hung.clear();
  }
});

test('a switch that reaches Margin with too little of its page\'s wait left for its steps, but within the grace the page gives, is shown at once (not refused)', async () => {
  await calm();
  const { out: { reply, ms }, entry } = await logged(4, () => ask('activateTab', { tabId: 4 }, { waitMs: 800, graceMs: 3000 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 4 } });
  assert.ok(ms < 800, `answered after ${ms} ms`);
  assert.equal(front(), 4);
  assert.equal(entry?.plain, 'late');
  // A page that gives no grace (an older one) is refused, as before.
  await calm();
  const { reply: refused } = await ask('activateTab', { tabId: 5 }, { waitMs: 800, graceMs: null });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Too late/);
  assert.equal(front(), 1);
});

test('with Safari quick, nothing changes: an unloaded tab is restored behind the page and introduced before it\'s shown, and Safari isn\'t taken as slow', async () => {
  await calm();
  fake.loads.set(22, { startMs: 20, commitMs: 150, paintMs: 300, loadMs: 600 });
  const { out: { reply }, entry } = await logged(22, () => ask('activateTab', { tabId: 22 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 22 } });
  assert.equal(entry?.restored, 'painted', JSON.stringify(entry));
  assert.equal(entry?.introduced, true);
  assert.equal(entry?.plain, undefined);
  assert.equal(entry?.slow, undefined);
  assert.equal(slow.isSlow(), false);
});


// ---- Safari found slow only where it is (reviews of 2026-11-03) ----

test('one sign isn\'t Safari slow: a tab whose lookup took 700 ms (its process hung) doesn\'t make the next switch, Safari quick, show an unloaded tab before it has drawn', async () => {
  await calm();
  fake.getMs = (id) => (id === 2 ? 700 : 0);
  const first = await ask('activateTab', { tabId: 2 });
  assert.deepEqual(first.reply, { ok: true, result: { shown: 2 } });
  fake.getMs = () => 0;
  bringToFront(1);
  await settledOn(1);
  await sleep(50);
  fake.updates = [];
  fake.loads.set(25, { startMs: 20, commitMs: 150, paintMs: 1300, loadMs: 1700 });
  const { out: { reply, asked }, entry } = await logged(25, () => ask('activateTab', { tabId: 25 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 25 } });
  assert.equal(entry?.restored, 'painted', JSON.stringify(entry));
  assert.equal(entry?.introduced, true);
  assert.equal(entry?.slow, undefined);
  assert.ok(shownAt(25, asked) >= 1300, `shown ${shownAt(25, asked)} ms after the ask, before its paint at 1300`);
  assert.equal(slow.isSlow(), false);
});

test('one stall of the background (its timers 600 ms late once) during a restore at normal speed doesn\'t cut it short', async () => {
  await calm();
  fake.loads.set(26, { startMs: 20, commitMs: 150, paintMs: 1300, loadMs: 1700 });
  sleep(300).then(() => { fake.lagMs = 600; return sleep(30); }).then(() => { fake.lagMs = 0; });
  const { out: { reply, asked }, entry } = await logged(26, () => ask('activateTab', { tabId: 26 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 26 } });
  assert.equal(entry?.restored, 'painted', JSON.stringify(entry));
  assert.equal(entry?.introduced, true);
  assert.ok(shownAt(26, asked) >= 1300, `shown ${shownAt(26, asked)} ms after the ask, before its paint at 1300`);
});

test('signs from two tabs are Safari slow: the next switch plans to show its tab soon after the click, its own calls quick', async () => {
  await calm();
  slow.noteCall('tabs.get', 700, 2);
  assert.equal(slow.isSlow(), false);
  slow.noteCall('tabs.get', 700, 2); // (the same tab again: still one)
  assert.equal(slow.isSlow(), false);
  slow.noteLag(600);
  slow.noteLag(650); // (the same stall)
  assert.equal(slow.isSlow(), true, 'a tab and the Mac');
  slow.resetSlow();
  slow.noteCall('tabs.get', 40_000, 2); // (the Mac asleep meanwhile)
  slow.noteCall('tabs.get', 40_000, 3);
  assert.equal(slow.isSlow(), false, 'a sign as long as a sleep isn\'t one');
  slow.noteCall('tabs.get', 700, 2);
  slow.noteCall('tabs.get', 700, 3);
  assert.equal(slow.isSlow(), true);
  fake.loads.set(27, { startMs: 20, commitMs: 150, paintMs: 3000, loadMs: 4000 });
  const { out: { reply, asked }, entry } = await logged(27, () => ask('activateTab', { tabId: 27 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 27 } });
  const at = shownAt(27, asked);
  assert.ok(at < 1700, `shown ${at} ms after the ask`);
  assert.ok(entry?.slow, JSON.stringify(entry));
  await sleep(200);
});

test('a Safari call still unanswered as its timer fires a little early by the wall clock is still a sign', async () => {
  await calm();
  const since = Date.now();
  fake.lagMs = -3; // (the timer for the call's SLOW_CALL_MS fires 3 ms early)
  try {
    void slow.timed('tabs.get', never(), 42);
  } finally {
    fake.lagMs = 0;
  }
  await sleep(600);
  assert.equal(slow.slowFoundAt(42, since) != null, true, 'found slow by its own call');
});

test('a restore whose flip Safari is slow to carry out (its lookups quick) is cut short, with no introduction after: shown about 1.5 s after the ask', async () => {
  await calm();
  fake.getMs = () => 300;
  fake.updateMs = 3000;
  fake.loads.set(23, { startMs: 100, commitMs: 2500, paintMs: 3500, loadMs: 5000 });
  try {
    const { out: { reply, ms, asked }, entry } = await logged(23, () => ask('activateTab', { tabId: 23 }));
    assert.deepEqual(reply, { ok: true, result: { shown: 23 } });
    const at = shownAt(23, asked);
    assert.ok(at < 2100, `shown ${at} ms after the ask`);
    assert.ok(ms < WAIT_MS, `answered after ${ms} ms`);
    assert.equal(fake.updates.filter((u) => u.id === 23).length, 2, `the restore's flip, then the show: ${JSON.stringify(fake.updates.map((u) => [u.id, u.at - asked]))}`);
    assert.equal(entry?.introduced ?? null, null, JSON.stringify(entry));
  } finally {
    await sleep(3200); // Safari's late answers
  }
});

test('a tab Margin knows, closed meanwhile, with Safari slow to say so and to fail its show: the page is told it isn\'t there, not that it was shown', async () => {
  await calm();
  const gone = fake.tabs.get(9);
  fake.getMs = (id) => (id === 9 ? 1500 : 0);
  fake.tabs.delete(9); // its removal not handled yet
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, change) => {
    if (!fake.tabs.has(id)) {
      await sleep(1000);
      throw new Error(`No tab with id ${id}`);
    }
    return update(id, change);
  };
  try {
    const { reply } = await ask('activateTab', { tabId: 9 });
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.match(reply.error, /No tab with id|no longer open/);
    assert.equal(front(), 1);
  } finally {
    chrome.tabs.update = update;
    fake.tabs.set(9, gone);
    await sleep(1200);
  }
});

test('a space\'s switch doesn\'t wait seconds for Safari to say which tab is in front: it starts from Margin\'s record', async () => {
  await calm();
  const call = (type, payload) => new Promise((resolve) => listeners.onMessage[0]({ type, ...payload }, sender(front()), resolve));
  const first = (await store.load()).spaces.find(Boolean)?.id;
  const { result: { spaceId } } = await call('createSpace', { name: 'Two' });
  await call('moveTabToSpace', { tabId: 5, spaceId });
  await call('setSpace', { windowId: 1, spaceId: first, bringTab: false });
  await sleep(100);
  const query = chrome.tabs.query;
  chrome.tabs.query = async (q = {}) => {
    if (q.active) await sleep(2500);
    return query(q);
  };
  fake.updates = [];
  try {
    const { out: { reply, asked } } = await logged(5, () => ask('setSpace', { windowId: 1, spaceId }));
    assert.deepEqual(reply, { ok: true, result: { shown: 5 } });
    const at = shownAt(5, asked);
    assert.ok(at < 600, `shown ${at} ms after the ask (Safari says which tab is in front after 2500)`);
    assert.equal(front(), 5);
  } finally {
    chrome.tabs.query = query;
    await call('setSpace', { windowId: 1, spaceId: first, bringTab: false });
    await sleep(2600);
  }
});

test('Safari found slow partway through a restore at normal speed, past 2 s: its tab isn\'t shown at once, at the step it was at, but once it has painted', async () => {
  await calm();
  fake.loads.set(28, { startMs: 20, commitMs: 2000, paintMs: 2900, loadMs: 6000 });
  let asked = Infinity;
  let once = false;
  fake.getMs = (id) => {
    if (id !== 28 || once || Date.now() - asked < 2300) return 0;
    once = true;
    return 600;
  };
  asked = Date.now();
  const { out: { reply }, entry } = await logged(28, () => ask('activateTab', { tabId: 28 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 28 } });
  assert.ok(once, 'Safari was slow once');
  assert.notEqual(entry?.forced, true, JSON.stringify(entry));
  assert.equal(entry?.restored, 'painted', JSON.stringify(entry));
  const at = shownAt(28, asked);
  assert.ok(at >= 2900 && at < 4200, `shown ${at} ms after the ask`);
});

test('with Safari slow, a tab whose wake answers only once its process is resumed (1.5 s) is still drawn before it\'s shown', async () => {
  await calm();
  slow.noteCall('tabs.get', 700, 2);
  slow.noteCall('tabs.get', 700, 3);
  const asked = Date.now();
  fake.scriptsAt.set(6, asked + 1500);
  const { out: { reply }, entry } = await logged(6, () => ask('activateTab', { tabId: 6 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 6 } });
  assert.equal(entry?.wakeOutcome, 'resumed', JSON.stringify(entry));
  assert.ok(entry?.barrier?.length >= 1, `drawn first: ${JSON.stringify(entry)}`);
  const at = shownAt(6, asked);
  assert.ok(at < 2100, `shown ${at} ms after the ask`);
});

test('a switch with no page waiting for it (a key, a command) waits for Safari to say where its tab is, as before: not shown as it is', async () => {
  await calm();
  fake.getMs = (id) => (id === 7 ? 700 : 0);
  const { out, entry } = await logged(7, () => focusTab(7, { source: 'next-tab' }));
  assert.equal(out?.tab?.id, 7);
  assert.equal(entry?.plain, undefined, JSON.stringify(entry));
  assert.equal(entry?.forced ?? null, null);
  assert.equal(front(), 7);
});

test('a show forced out of time with Safari quick (the switch stuck on Margin\'s own storage) waits for Safari\'s answer, as before: not taken as unconfirmed after 250 ms', async () => {
  await calm();
  fake.updateMs = 400;
  fake.sessionStuck = true;
  resetIntroductions();
  try {
    const { out: { reply, ms }, entry } = await logged(3, () => ask('activateTab', { tabId: 3 }));
    assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
    assert.ok(ms < WAIT_MS, `answered after ${ms} ms`);
    assert.equal(entry?.forced, true, JSON.stringify(entry));
    assert.equal(entry?.unconfirmed, false, JSON.stringify(entry));
    assert.equal(entry?.slow, undefined, JSON.stringify(entry));
  } finally {
    fake.sessionStuck = false;
    resetIntroductions();
  }
});

test('a lookup Safari never answers (a hung process) isn\'t waited on by every later switch to the tab: asked again', async () => {
  await calm();
  let calls = 0;
  fake.getMs = (id) => (id === 8 && calls++ === 0 ? Infinity : 0);
  const { entry: first } = await logged(8, () => ask('activateTab', { tabId: 8 }));
  assert.equal(first?.plain, 'tab', JSON.stringify(first));
  await sleep(3100);
  bringToFront(1);
  await settledOn(1);
  await sleep(50);
  const { out: { reply }, entry } = await logged(8, () => ask('activateTab', { tabId: 8 }));
  assert.deepEqual(reply, { ok: true, result: { shown: 8 } });
  assert.equal(entry?.plain, undefined, JSON.stringify(entry));
});

test.after(() => realSetTimeout(() => process.exit(0), 50));
