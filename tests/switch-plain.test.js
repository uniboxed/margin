// The plain switch (Margin 2 Phase 2 step 8, brought forward from Phase 3):
// `tabs.update(active)` and the window focused if it isn't, nothing else
// (background/tabs.js focusTab); each switch's timeline as one line for
// Margin.app's log (background/switch-log.js); and, the whole way to the
// overlay, the highlight moving once, to the new tab, never back. Against the
// real background with a fake of Safari's API whose storage writes take
// STORE_MS (Safari's are tens of ms, more under load) and whose activations
// come a moment after the update, as Safari's do.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A key chain lasts NAV_CHAIN_MS (background/navigation.js): a test's presses start a chain of their own after it.
const NAV_SETTLE_MS = 1600;
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const STORE_MS = 60;
// `updateMs`: how long Safari takes to carry out and answer a tabs.update (null: at once).
const fake = { tabs: new Map(), local: {}, session: {}, updates: [], windowUpdates: [], focused: true, hang: new Set(), changes: [], updateMs: /** @type {null | (() => number)} */ (null) };
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
globalThis.fetch = async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
globalThis.chrome = {
  runtime: { id: 'test', getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'), sendMessage: async () => undefined, sendNativeMessage: async () => undefined },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}), create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: { get: async (id) => ({ id, focused: fake.focused }), getAll: async () => [{ id: 1, focused: fake.focused }], getLastFocused: async () => ({ id: 1 }),
    update: async (id, props) => { fake.windowUpdates.push({ id, ...props }); }, create: async () => ({}), onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds') },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id, props) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      fake.updates.push({ id, ...props, at: Date.now() });
      if (props.active && fake.updateMs) await sleep(fake.updateMs());
      if (props.active) {
        for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
        setTimeout(() => void fire('onActivated', { tabId: id, windowId: tab.windowId }), 3);
      }
      if (fake.hang.has(id)) await new Promise(() => {});
      return { ...tab };
    },
    create: async () => ({ id: 999, windowId: 1 }), remove: async () => {},
    sendMessage: async () => undefined, getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async () => [{ result: true }],
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        await sleep(STORE_MS);
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: fake.local[k], newValue: structuredClone(v) }]));
        Object.assign(fake.local, structuredClone(items));
        fake.changes.push(changes);
        void fire('sChanged', changes, 'local');
      },
      remove: async (keys) => { for (const k of [].concat(keys)) delete fake.local[k]; },
    },
    session: { get: async (keys) => pick(fake.session, keys), set: async (items) => { Object.assign(fake.session, structuredClone(items)); }, remove: async () => {} },
    onChanged: event('sChanged'),
  },
};
// Fourteen tabs, so a run of presses goes through them without coming round again.
for (const [id, i] of Array.from({ length: 14 }, (_, n) => [n + 1, n])) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: i, active: id === 1, status: 'complete' });
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
for (let i = 0; i < 200 && !store.isSynced(); i++) await sleep(10);
// The link, linked: what's pushed to the window's overlay (background/tabs.js tellPage).
const { appLink } = await import('../extension/background/app-link.js');
/** @type {any[]} */
const pushed = [];
appLink.linked = () => true;
/** @type {((entry: any) => void)[]} */
const takers = []; // the overlays listening (overlay() below): each push reaches them as it's sent
appLink.push = (windowId, msg) => {
  const entry = { windowId, msg, at: Date.now() };
  pushed.push(entry);
  for (const take of [...takers]) take(entry);
  return true;
};
// Margin.app's log lines (switch-log.js appLog, through the link's note).
/** @type {string[]} */
const notes = [];
appLink.note = (line) => { notes.push(String(line)); };
const keyRunLines = () => notes.filter((l) => l.startsWith('key run in window'));
const { switchLog } = await import('../extension/background/switch-log.js');
const { fromStorage } = await import('../extension/shared/stored.js');
const { createSwitching, backgroundSwitches } = await import('../extension/shared/switching.js');
const { handlers } = await import('../extension/background/handlers.js');
await sleep(300);

const ask = (type, payload) => new Promise((resolve) => listeners.onMessage[0]({ type, ...payload }, { tab: { ...fake.tabs.get(1), windowId: 1 } }, resolve));
const front = () => [...fake.tabs.values()].find((t) => t.active)?.id;
const storedFront = () => {
  const s = fake.local.openTabs ? fromStorage(fake.local) : null;
  return Object.values(s?.tabs ?? {}).find((t) => t.windowId === 1 && t.active)?.id ?? null;
};
async function inFront(id) {
  if (front() !== id) await ask('activateTab', { tabId: id, windowId: 1 });
  for (let i = 0; i < 100 && storedFront() !== id; i++) await sleep(10);
  await sleep(50);
}

// The overlay's highlight (ui/runtime.js with the app host): the switch's own
// tab from its 'switching' push until the stored state has that tab in front
// (shared/switching.js `landed`), else the stored state's tab in front; each
// change drawn recorded.
function overlay() {
  const drawn = [storedFront()];
  /** @type {any[]} */
  const runs = [];
  let target = null;
  const draw = () => { const h = target ?? storedFront(); if (drawn.at(-1) !== h) drawn.push(h); };
  const switching = createSwitching({
    doc: /** @type {any} */ ({ hidden: false, addEventListener() {}, defaultView: { addEventListener() {} } }),
    onChange: (id) => { target = id; draw(); },
    onSlow: () => {},
    failed: (r) => r === undefined,
    front: storedFront,
    onRun: (run) => runs.push(run),
  });
  const copy = backgroundSwitches();
  const onState = (changes, area) => { if (area === 'local' && 'openTabs' in changes) { switching.settle(); draw(); } };
  listeners.sChanged.push(onState);
  // Each push as the overlay takes it (app/overlay/overlay.js, ui/runtime.js switchTo), as it comes.
  const take = ({ msg }) => {
    if (msg.type === 'switching') {
      const request = copy.begin(msg.tabId, msg.switchId ?? null);
      if (msg.tabId === storedFront()) switching.toFront(msg.tabId, request);
      else switching.start(msg.tabId, request);
    } else if (msg.type === 'switch-done' || msg.type === 'switch-failed') copy.settle(msg);
    draw();
  };
  takers.push(take);
  return {
    drawn,
    runs, // each chain as it ended (shared/switching.js onRun)
    // A switch asked for in the overlay itself (a click on a row): highlighted at once, its request's answer.
    click: (id, request) => switching.start(id, request),
    stop() { listeners.sChanged.splice(listeners.sChanged.indexOf(onState), 1); takers.splice(takers.indexOf(take), 1); },
  };
}

test('a switch is one tabs.update of the tab, nothing else: no flip of the tab forward and back, no other tab updated, no script in its page', async () => {
  await inFront(1);
  fake.updates = [];
  const { reply } = { reply: await ask('activateTab', { tabId: 2, windowId: 1 }) };
  assert.deepEqual(reply, { ok: true, result: { shown: 2 } });
  assert.deepEqual(fake.updates.map((u) => [u.id, u.active]), [[2, true]]);
  assert.equal(front(), 2);
});

test('the window is focused only if it isn\'t (re-focusing the window in front can take the keyboard from the page)', async () => {
  await inFront(1);
  fake.windowUpdates = [];
  fake.focused = true;
  await ask('activateTab', { tabId: 2, windowId: 1 });
  assert.deepEqual(fake.windowUpdates, []);
  fake.focused = false;
  await ask('activateTab', { tabId: 3, windowId: 1 });
  assert.deepEqual(fake.windowUpdates, [{ id: 1, focused: true }]);
  fake.focused = true;
});

test('a tab that\'s gone: the switch fails, and says why', async () => {
  const reply = await ask('activateTab', { tabId: 77, windowId: 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /no longer open|No tab with id/);
});

test('Safari not answering the update (a hung tab process): answered as made after 1 s, not left waiting; Safari carries it out', async () => {
  await inFront(1);
  fake.hang.add(3);
  const t = Date.now();
  const reply = await ask('activateTab', { tabId: 3, windowId: 1 });
  fake.hang.delete(3);
  assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
  assert.ok(Date.now() - t >= 900 && Date.now() - t < 2000, `${Date.now() - t} ms`);
});

test('a hung tab and a page with a short deadline: answered as made before the deadline, never "too late"', async () => {
  await inFront(1);
  fake.hang.add(3);
  const t = Date.now();
  const reply = await ask('activateTab', { tabId: 3, windowId: 1, deadline: t + 1500 });
  fake.hang.delete(3);
  assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
  assert.ok(Date.now() - t < 1500, `answered ${Date.now() - t} ms after it was asked`);
});

test('each switch\'s timeline is one line for Margin.app\'s log: asked, tabs.update, updated, onActivated, stored, delta out', async () => {
  await inFront(1);
  const before = switchLog.lines().length;
  await ask('activateTab', { tabId: 2, windowId: 1 });
  for (let i = 0; i < 100 && switchLog.lines().length === before; i++) await sleep(10);
  const line = switchLog.lines().at(-1);
  assert.match(line, /^switch to tab 2 \(activateTab, window 1\): asked \+0, tabs\.update \+\d+, updated \+\d+, onActivated \+\d+, stored \+\d+/);
  assert.ok(!/activations heard/.test(line), `one activation only: ${line}`);
  // Each step after the one before.
  const times = [...line.matchAll(/\+(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), line);
});

test('a key\'s switch, the whole way to the overlay: the highlight moves once, to the new tab, never back (the copy says it\'s done before the state has it)', async () => {
  await inFront(1);
  const o = overlay();
  pushed.length = 0;
  await handlers.navigate({ action: 'next-tab' }, { app: true, tab: { windowId: 1 } });
  for (let i = 0; i < 100 && storedFront() === 1; i++) await sleep(10);
  await sleep(STORE_MS * 3);
  o.stop();
  const next = front();
  assert.notEqual(next, 1);
  const order = pushed.map((p) => p.msg.type);
  assert.deepEqual(order, ['switching', 'switch-done']);
  assert.deepEqual(o.drawn, [1, next], `highlight changes: ${JSON.stringify(o.drawn)}`);
});

test('a click\'s switch, the whole way to the overlay, with Safari\'s storage slow (writes past the old 300 ms grace): one highlight change', async () => {
  await inFront(1);
  const o = overlay();
  const slowSet = chrome.storage.local.set;
  chrome.storage.local.set = async (items) => { await sleep(400); return slowSet(items); };
  try {
    o.click(3, ask('activateTab', { tabId: 3, windowId: 1 }).then((r) => r?.result));
    for (let i = 0; i < 300 && storedFront() !== 3; i++) await sleep(10);
    await sleep(100);
  } finally {
    chrome.storage.local.set = slowSet;
    o.stop();
  }
  assert.deepEqual(o.drawn, [1, 3], `highlight changes: ${JSON.stringify(o.drawn)}`);
});

// Fast presses (a held key, quick taps: Margin 2: Safari reliability). Each press's
// target is worked out at the press and the overlay told at once; Safari gets one
// switch at a time per window, the newest press waiting in place of older ones.
const press = (sender) => handlers.navigate({ action: 'next-tab' }, sender);
const V = await import('../extension/shared/view.js');
// The tabs the next-tab key goes through from `id`, in the sidebar's order.
const nextTabs = (id, n) => {
  const s = fromStorage(fake.local);
  const out = [];
  for (let at = id; out.length < n;) out.push(at = V.cycleTab(s, 1, at, 1));
  return out;
};
const APP = { app: true, tab: { windowId: 1 } };
const PAGE = { tab: { id: 1, windowId: 1 } };

test('fast presses: the overlay told at each press, Safari only the newest waiting, the highlight never going back, nothing after the last', async () => {
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  const o = overlay();
  pushed.length = 0;
  notes.length = 0;
  fake.updates = [];
  fake.updateMs = () => 120 + Math.random() * 60;
  const presses = [];
  const targets = nextTabs(1, 12);
  const last = targets.at(-1);
  try {
    for (let i = 0; i < 12; i++) {
      presses.push(Date.now());
      await press(APP);
      await sleep(83);
    }
    for (let i = 0; i < 300 && storedFront() !== last; i++) await sleep(10);
    await sleep(400);
  } finally {
    fake.updateMs = null;
    o.stop();
  }
  const switching = pushed.filter((p) => p.msg.type === 'switching');
  assert.equal(new Set(targets).size, 12);
  assert.deepEqual(switching.map((p) => p.msg.tabId), targets, 'one target per press, each the next');
  switching.forEach((p, i) => assert.ok(p.at - presses[i] <= 5, `press ${i + 1}: told ${p.at - presses[i]} ms after it`));
  assert.ok(new Set(switching.map((p) => p.msg.switchId)).size === 12, 'each press its own switch');
  const span = presses.at(-1) - presses[0];
  const updates = fake.updates.filter((u) => u.active).map((u) => u.id);
  assert.ok(updates.length < 12 && updates.length <= 1 + Math.ceil(span / 120), `Safari asked ${updates.length} times: ${updates}`);
  assert.equal(updates.at(-1), last, 'the last switch is the last press\'s');
  const asked = updates.map((id) => targets.indexOf(id));
  assert.ok(asked.every((n, i) => n >= 0 && (i === 0 || n > asked[i - 1])), `Safari sent forward only: ${updates}`);
  assert.equal(front(), last);
  assert.equal(storedFront(), last);
  // The highlight: each change to a later press's target, ending on the last.
  const order = [1, ...switching.map((p) => p.msg.tabId)];
  const at = o.drawn.map((id) => order.indexOf(id));
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), `the highlight went back: ${JSON.stringify(o.drawn)}`);
  assert.equal(o.drawn.at(-1), last);
  // Every 'switching' has its word, and nothing is pushed or asked once it's over.
  const words = pushed.filter((p) => p.msg.type === 'switch-done' || p.msg.type === 'switch-failed').map((p) => p.msg.switchId);
  assert.deepEqual(new Set(words), new Set(switching.map((p) => p.msg.switchId)));
  const after = fake.updates.length;
  await sleep(300);
  assert.equal(fake.updates.length, after, 'nothing switching after the last press is handled');
  assert.equal(front(), last);
  // Margin.app's log: the run as one line, and the overlay's chain as it ended.
  const lines = keyRunLines();
  assert.equal(lines.length, 1, `${lines}`);
  const m = /^key run in window 1: 12 tab presses, Safari asked (\d+) times?, (\d+) skipped \(a newer press took their place\), landed (\d+) ms after the last press \(Safari's activation\); highlight told backwards 0 times$/.exec(lines[0]);
  assert.ok(m, lines[0]);
  assert.equal(Number(m[1]), updates.length, 'as many as Safari was asked');
  assert.equal(Number(m[2]), 12 - updates.length, 'the rest were taken over by newer presses');
  assert.ok(Number(m[3]) > 0 && Number(m[3]) < 1000, lines[0]);
  assert.deepEqual(o.runs.map(({ targets, landed, back, elsewhere, failed }) => ({ targets, landed, back, elsewhere, failed })),
    [{ targets: 12, landed: true, back: 0, elsewhere: 0, failed: false }], 'one chain: all 12 targets, ended on the last, never back');
});

test('fast presses with Safari slower than PASSED_MS (350-600 ms a switch, one of 1 s): the highlight never goes back, and ends on the last press\'s tab', async () => {
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  const o = overlay();
  pushed.length = 0;
  fake.updates = [];
  let n = 0;
  fake.updateMs = () => (++n === 3 ? 1000 : 350 + Math.random() * 250);
  const targets = nextTabs(1, 12);
  const last = targets.at(-1);
  try {
    for (let i = 0; i < 12; i++) {
      await press(APP);
      await sleep(83);
    }
    for (let i = 0; i < 500 && storedFront() !== last; i++) await sleep(10);
    await sleep(700);
  } finally {
    fake.updateMs = null;
    o.stop();
  }
  const switching = pushed.filter((p) => p.msg.type === 'switching');
  assert.deepEqual(switching.map((p) => p.msg.tabId), targets, 'one target per press, each the next');
  assert.equal(storedFront(), last);
  const order = [1, ...targets];
  const at = o.drawn.map((id) => order.indexOf(id));
  assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), `the highlight went back: ${JSON.stringify(o.drawn)}`);
  assert.equal(o.drawn.at(-1), last);
  assert.deepEqual(o.runs.map(({ targets: t, landed, back }) => ({ targets: t, landed, back })), [{ targets: 12, landed: true, back: 0 }], 'one chain, ended on the last, never back');
});

test('fast presses: a press after the switches are done is never skipped, and goes at once', async () => {
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  fake.updates = [];
  const [a, b] = nextTabs(1, 2);
  await press(APP);
  for (let i = 0; i < 100 && storedFront() !== a; i++) await sleep(10);
  await sleep(50);
  const t = Date.now();
  await press(APP);
  await sleep(5);
  assert.deepEqual(fake.updates.map((u) => u.id), [a, b]);
  assert.ok(fake.updates[1].at - t <= 5, `asked ${fake.updates[1].at - t} ms after the press`);
});

test('one press heard twice (the app\'s key and the page\'s keydown) counts once', async () => {
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  pushed.length = 0;
  fake.updates = [];
  notes.length = 0;
  const [a] = nextTabs(1, 1);
  await press(APP);
  await press(PAGE);
  for (let i = 0; i < 100 && storedFront() !== a; i++) await sleep(10);
  await sleep(100);
  assert.deepEqual(pushed.filter((p) => p.msg.type === 'switching').map((p) => p.msg.tabId), [a]);
  assert.deepEqual(fake.updates.map((u) => u.id), [a]);
  await sleep(500);
  assert.deepEqual(keyRunLines().map((l) => l.replace(/landed \d+ ms/, 'landed N ms')),
    ['key run in window 1: 1 tab press, Safari asked 1 time, 0 skipped (a newer press took their place), 1 press heard twice, counted once, landed N ms after the last press (Safari\'s activation); highlight told backwards 0 times']);
});

test('the activations of a chain\'s own switches don\'t restart it: presses during a slow switch go on from the last target', async () => {
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  fake.updates = [];
  pushed.length = 0;
  fake.updateMs = () => 150;
  const three = nextTabs(1, 3);
  try {
    await press(APP);
    await sleep(140);
    await press(APP); // the first's activation (Margin's own) comes while this one waits
    await sleep(40);
    await press(APP);
    for (let i = 0; i < 200 && storedFront() !== three[2]; i++) await sleep(10);
    await sleep(100);
  } finally {
    fake.updateMs = null;
  }
  assert.deepEqual(pushed.filter((p) => p.msg.type === 'switching').map((p) => p.msg.tabId), three);
  assert.equal(front(), three[2]);
});

// Held space keys repeat (Tirth, 2026-11-05: DECISIONS.md "after the merge"): the
// same one at a time, the newest press waiting in place of older ones.
test('fast space presses: one space switch with Safari at a time, the newest waiting, landing on the last press\'s space', async () => {
  const M = await import('../extension/state/model.js');
  await store.mutate((s) => {
    let next = s;
    for (const [n, id] of ['s-a', 's-b', 's-c'].entries()) {
      next = M.createSpace(next, { id, name: id, emoji: '', color: '#888888' });
      for (const tab of [2 + n * 2, 3 + n * 2]) next = M.moveTab(next, tab, id);
    }
    return next;
  });
  await inFront(1);
  await sleep(NAV_SETTLE_MS);
  const spaces = () => fromStorage(fake.local).spaces.map((x) => x.id);
  const at = () => V.activeSpaceId(fromStorage(fake.local), 1);
  const order = spaces();
  assert.equal(order.length, 4);
  const want = order[(order.indexOf(at()) + 6) % order.length];
  fake.updates = [];
  fake.updateMs = () => 150;
  try {
    for (let i = 0; i < 6; i++) {
      await handlers.navigate({ action: 'next-space' }, APP);
      await sleep(83);
    }
    for (let i = 0; i < 300 && at() !== want; i++) await sleep(10);
    await sleep(400);
  } finally {
    fake.updateMs = null;
  }
  assert.equal(at(), want, 'the sixth press\'s space');
  const shown = fromStorage(fake.local);
  assert.equal(shown.tabSpace[front()], want, 'its tab in front');
  assert.ok(fake.updates.length < 6, `Safari asked ${fake.updates.length} times`);
});

test('a page\'s word that it\'s shown carries what said it: a web page\'s content script, Margin\'s new-tab page, or unknown', async () => {
  const heard = [];
  const was = appLink.visibility;
  appLink.visibility = (...args) => { heard.push(args); };
  try {
    const tab = { tab: { id: 3, windowId: 1 } };
    await handlers.visibility({ visible: false, at: 5, from: 'page' }, tab);
    await handlers.visibility({ visible: true, at: 6, from: 'newtab' }, tab);
    await handlers.visibility({ visible: true, at: 7 }, tab);
    await handlers.visibility({ visible: true, at: 8, from: 'https://a.test/' }, tab);
  } finally {
    appLink.visibility = was;
  }
  assert.deepEqual(heard, [[1, 3, false, 5, 'content script'], [1, 3, true, 6, 'new-tab page'], [1, 3, true, 7, 'unknown'], [1, 3, true, 8, 'unknown']]);
});
