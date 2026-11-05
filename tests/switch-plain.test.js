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
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const STORE_MS = 60;
const fake = { tabs: new Map(), local: {}, session: {}, updates: [], windowUpdates: [], focused: true, hang: new Set(), changes: [] };
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
for (const [id, i] of [[1, 0], [2, 1], [3, 2]]) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: i, active: id === 1, status: 'complete' });
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
appLink.push = (windowId, msg) => { pushed.push({ windowId, msg, at: Date.now() }); return true; };
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
  let target = null;
  const draw = () => { const h = target ?? storedFront(); if (drawn.at(-1) !== h) drawn.push(h); };
  const switching = createSwitching({
    doc: /** @type {any} */ ({ hidden: false, addEventListener() {}, defaultView: { addEventListener() {} } }),
    onChange: (id) => { target = id; draw(); },
    onSlow: () => {},
    failed: (r) => r === undefined,
    front: storedFront,
    landed: (id, from) => { const f = storedFront(); return f === id ? true : f === from ? null : false; },
  });
  const copy = backgroundSwitches();
  const seen = pushed.length;
  const onState = (changes, area) => { if (area === 'local' && 'openTabs' in changes) { switching.settle(); draw(); } };
  listeners.sChanged.push(onState);
  const timer = setInterval(() => {
    while (pushedSeen < pushed.length) {
      const { msg } = pushed[pushedSeen++];
      if (msg.type === 'switching') switching.start(msg.tabId, copy.begin(msg.tabId));
      else if (msg.type === 'switch-done' || msg.type === 'switch-failed') copy.settle(msg);
      draw();
    }
  }, 1);
  let pushedSeen = seen;
  return {
    drawn,
    // A switch asked for in the overlay itself (a click on a row): highlighted at once, its request's answer.
    click: (id, request) => switching.start(id, request),
    stop() { clearInterval(timer); listeners.sChanged.splice(listeners.sChanged.indexOf(onState), 1); },
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

test('Safari not answering the update (a hung tab process): answered as made after 2 s, not left waiting; Safari carries it out', async () => {
  await inFront(1);
  fake.hang.add(3);
  const t = Date.now();
  const reply = await ask('activateTab', { tabId: 3, windowId: 1 });
  fake.hang.delete(3);
  assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
  assert.ok(Date.now() - t >= 1900 && Date.now() - t < 3000, `${Date.now() - t} ms`);
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
