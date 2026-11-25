// What a tab switch costs the background (2026-11-25, Tirth: a fast run of tab switches lagged, the background busy
// with each one's bookkeeping): a run of the app's shows (hostShow) is written once it's over, not once each (every
// write reaches every open page and Margin.app, which saves its data set and acks it), with the state right at once;
// a switch made in the browser and Margin's own (activateTab), whose sidebar and asker follow the stored state, are
// written at once; and a tab's copy of
// Margin is checked once its window has settled, for the tab in front only. Against the real background with a fake
// of Safari's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';
import type { State } from '../types/margin.d.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const event = (name: string) => ({ addListener: (fn: Listener) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const STORE_MS = 30;
// writes: each storage.local.set's keys and when; scripts: the tabs a script was run in.
const fake = { tabs: new Map<number, any>(), local: {} as Record<string, any>, session: {} as Record<string, any>, writes: [] as { keys: string[], at: number }[], scripts: [] as number[] };
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, unknown> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
globalThis.fetch = (async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
globalThis.chrome = fakeBrowser({
  runtime: { id: 'test', getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'), sendMessage: async () => undefined, sendNativeMessage: async () => undefined },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}) as { name: string, scheduledTime: number }, create: async () => {}, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: { get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, create: async () => ({}), onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds') },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    // Safari's activation a moment after its answer, as it comes.
    update: async (id, props) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      if (props.active) {
        for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
        setTimeout(() => void fire('onActivated', { tabId: id, windowId: tab.windowId }), 3);
      }
      return { ...tab };
    },
    create: async () => ({ id: 999, windowId: 1 }), remove: async () => {},
    sendMessage: async () => undefined, getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async (injection) => { fake.scripts.push(injection.target.tabId); return [{ result: true }]; },
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        fake.writes.push({ keys: Object.keys(items), at: Date.now() });
        await sleep(STORE_MS);
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: fake.local[k], newValue: structuredClone(v) }]));
        Object.assign(fake.local, structuredClone(items));
        void fire('sChanged', changes, 'local');
      },
      remove: async (keys) => { for (const k of ([] as string[]).concat(keys)) delete fake.local[k]; },
    },
    session: { get: async (keys) => pick(fake.session, keys), set: async (items) => { Object.assign(fake.session, structuredClone(items)); }, remove: async () => {} },
    onChanged: event('sChanged'),
  },
});
// Twenty tabs in one window, the first in front.
for (let id = 1; id <= 20; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, active: id === 1, status: 'complete' });
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
for (let i = 0; i < 300 && !store.isSynced(); i++) await sleep(10);
const { fromStorage } = await import('../extension/shared/stored.ts');
// What the background left from starting (its first writes, the data set's times) over before each test.
await sleep(2000);

type Reply = { ok: boolean, result?: any, error?: string };
// A request as Margin.app's link runs it (background/link.ts: the app's window standing in for the page's sender), or
// as a page sends it.
const fromApp = (type: string, payload: Record<string, unknown>) => new Promise<Reply>((resolve) => listeners.onMessage[0]({ type, ...payload }, { app: true, tab: { windowId: 1 } }, resolve));
const fromPage = (type: string, payload: Record<string, unknown>) => new Promise<Reply>((resolve) => listeners.onMessage[0]({ type, ...payload }, { tab: { ...fake.tabs.get(1), windowId: 1 } }, resolve));
const openTabsWrites = (since: number) => fake.writes.filter((w) => w.at >= since && w.keys.includes('openTabs'));
const storedFront = () => {
  const s: State | null = fake.local.openTabs ? fromStorage(fake.local) : null;
  return Object.values(s?.tabs ?? {}).find((t) => t.windowId === 1 && t.active)?.id ?? null;
};
const cachedFront = () => Object.values(store.cached()?.tabs ?? {}).find((t) => t.windowId === 1 && t.active)?.id ?? null;

test('a run of the app\'s shows is written once it\'s over, its state right at once; the page check is the last tab\'s only', async () => {
  const from = Date.now();
  fake.scripts.length = 0;
  // Eight shows 40 ms apart (a held key's repeats), each landing.
  for (let id = 2; id <= 9; id++) {
    const reply = await fromApp('hostShow', { windowId: 1, itemId: `item${id}`, url: `https://t${id}.test/` });
    assert.equal(reply.ok, true, `show ${id}`);
    await sleep(40);
    assert.equal(cachedFront(), id, `the state has tab ${id} in front at once`);
  }
  const over = Date.now();
  assert.equal(openTabsWrites(from).length, 0, 'nothing written during the run');
  for (let i = 0; i < 150 && storedFront() !== 9; i++) await sleep(10);
  assert.equal(storedFront(), 9, 'the last tab stored in front');
  assert.equal(openTabsWrites(from).length, 1, 'one write for the run');
  assert.ok(openTabsWrites(from)[0].at - from <= 1200, 'within the activation\'s wait of the first switch');
  const stored = fromStorage(fake.local);
  assert.ok((stored.tabs[9]?.lastActive ?? 0) >= over - 100, 'when it was last used, stored with it');
  await sleep(500);
  assert.deepEqual([...new Set(fake.scripts)], [9], 'the tab in front once the window settled, none of those passed');
});

test('Margin\'s own switch (activateTab: its asker follows the stored state) is written at once', async () => {
  await sleep(1500);
  const from = Date.now();
  const reply = await fromPage('activateTab', { tabId: 12, windowId: 1 });
  assert.equal(reply.ok, true);
  for (let i = 0; i < 50 && storedFront() !== 12; i++) await sleep(10);
  assert.equal(storedFront(), 12, 'stored in front');
  assert.ok(openTabsWrites(from)[0].at - from < 400, `written at once (${openTabsWrites(from)[0].at - from} ms)`);
});

test('a switch made in the browser (its tab bar: its sidebar follows the stored state) is written at once', async () => {
  await sleep(1500);
  const from = Date.now();
  for (const t of fake.tabs.values()) t.active = t.id === 13;
  await fire('onActivated', { tabId: 13, windowId: 1 });
  for (let i = 0; i < 50 && storedFront() !== 13; i++) await sleep(10);
  assert.equal(storedFront(), 13, 'stored in front');
  assert.ok(openTabsWrites(from)[0].at - from < 400, `written at once (${openTabsWrites(from)[0].at - from} ms)`);
});

test('a write before the wait is over takes the switch along', async () => {
  await sleep(1500);
  const from = Date.now();
  await fromApp('hostShow', { windowId: 1, itemId: 'item14', url: 'https://t14.test/' });
  for (let i = 0; i < 50 && cachedFront() !== 14; i++) await sleep(5);
  // Another tab's change that's written at once (a tab created): the switch goes with it.
  fake.tabs.set(30, { id: 30, windowId: 1, url: 'https://t30.test/', title: 'T30', index: 20, active: false, status: 'complete' });
  await fire('onCreated', { ...fake.tabs.get(30) });
  for (let i = 0; i < 50 && storedFront() !== 14; i++) await sleep(10);
  assert.equal(storedFront(), 14, 'the switch stored with it');
  assert.ok(openTabsWrites(from)[0].at - from < 400, 'not held to the wait');
});
