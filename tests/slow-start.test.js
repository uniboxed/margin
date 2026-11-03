// A click in the first seconds after a Safari relaunch, before the first
// sync is through, with Safari slow (a Mac just rebooted, 2026-11-03): the
// page's rows are the last session's (their ids no longer Safari's), so its
// switch names its tab by address too (`hint`). It doesn't wait seconds for
// the sync and its write: it finds its tab among Safari's open tabs, by the
// sync's own question to Safari (store.js openTabsAsked), and starts then.
// Through background.js's own listeners, as answer-in-time.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => (listeners[name] ?? []).map((fn) => fn(...args));

const fake = {
  tabs: new Map(),
  local: {},
  session: {},
  updates: [],
  queries: 0, // tabs.query({}) asked
};
const started = Date.now();
// Safari's first list of the open tabs takes QUERY_MS, and Margin's writes of
// its tabs SLOW_WRITE_MS, for the first few seconds.
const QUERY_MS = 1200;
const SLOW_WRITE_MS = 2500;
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
      const t = fake.tabs.get(id);
      if (!t) throw new Error(`No tab with id ${id}`);
      return { ...t };
    },
    query: async (filter = {}) => {
      if (!Object.keys(filter).length && fake.queries++ === 0) await sleep(QUERY_MS);
      return [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t }));
    },
    update: async (id, change) => {
      if (!fake.tabs.has(id)) throw new Error(`No tab with id ${id}`);
      fake.updates.push({ id, change, at: Date.now() });
      if (change.active) bringToFront(id);
      return { ...fake.tabs.get(id) };
    },
    sendMessage: (tabId, message) => sleep(2).then(() => (message?.type === 'switching' || message?.type === 'margin-release' ? true : message?.type === 'margin-hold' ? new Promise(() => {}) : undefined)),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }),
    create: async () => { throw new Error('not here'); }, remove: async () => {}, reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async ({ func, args }) => {
      await sleep(2);
      let result = true;
      if (func?.name === 'prepareSidebarInPage') result = { ready: true, token: args?.[0]?.token };
      else if (func?.name === 'paintBarrierInPage') result = 'drawn';
      else if (func?.name === 'cutOffInPage') result = { cutOff: false };
      return [{ result }];
    },
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        if ('openTabs' in items && Date.now() - started < 5000) await sleep(SLOW_WRITE_MS);
        Object.assign(fake.local, structuredClone(items));
      },
      remove: async (keys) => { for (const k of [].concat(keys)) delete fake.local[k]; },
    },
    session: {
      get: async (keys) => pick(fake.session, keys),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
};

// Tabs 1–6 loaded, 1 in front.
for (let id = 1; id <= 6; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, status: 'complete', active: id === 1 });

const WAIT_MS = 7000;
const GRACE_MS = 3000;
await import('../extension/background.js');
const store = await import('../extension/background/store.js');
await sleep(100);

test('a click before the first sync is through, its row the last session\'s: its tab is found among Safari\'s open tabs, by the sync\'s own question, and shown without waiting for the sync\'s write', async () => {
  assert.equal(store.isSynced(), false, 'the sync still under way');
  const asked = Date.now();
  const deadline = asked + WAIT_MS;
  // Tab 5's row, drawn from the last session's tabs (another id then).
  const hint = { url: 'https://t5.test/', index: 4, title: 'T5', from: { origin: 'safari-web-extension://old/', since: 1, synced: false } };
  const { reply, ms } = await new Promise((resolve) => {
    listeners.onMessage[0]({ type: 'activateTab', tabId: 905, hint, deadline, waitsUntil: deadline + GRACE_MS }, { tab: { ...fake.tabs.get(1) }, url: fake.tabs.get(1).url }, (r) => resolve({ reply: r, ms: Date.now() - asked }));
  });
  assert.deepEqual(reply, { ok: true, result: { shown: 5 } });
  const at = (fake.updates.find((u) => u.id === 5 && u.change.active)?.at ?? Infinity) - asked;
  assert.ok(at < QUERY_MS + 600, `shown ${at} ms after the click (Safari listed the open tabs after ${QUERY_MS}, the sync was written after ${QUERY_MS + SLOW_WRITE_MS})`);
  assert.ok(ms < WAIT_MS, `answered after ${ms} ms`);
  assert.equal(fake.queries, 1, 'Safari asked for its open tabs once');
});

test.after(() => setTimeout(() => process.exit(0), 50));
