// Margin 2 Phase 2 step 5: pages draw none of Margin's UI, linked to
// Margin.app or not. The background's side, against a fake of the browser's
// API: not linked, ⌘T and the palette's key open Margin's new-tab page (once
// a press, whichever way it came), a new tab made by the browser stays (no
// palette to hand it to); and what the page box left from before its removal
// (2026-11-16: its registration, its kept sheet walks) is dropped at start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A listener, called with whatever its event gives.
type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const event = (name: string) => ({ addListener: (fn: Listener) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

// local, session: stored JSON. toPages: the types of the messages sent to pages.
const fake = { tabs: new Map(), nextId: 500, created: [] as (string | undefined)[], removed: [] as number[], local: {} as Record<string, any>, session: {} as Record<string, any>, registered: new Map(), toPages: [] as (string | undefined)[] };
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, unknown> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const NEW_TAB = 'safari-web-extension://test/newtab/newtab.html';
// Only what Margin reads of a response.
globalThis.fetch = (async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
globalThis.chrome = fakeBrowser({
  runtime: {
    id: 'test',
    getURL: (p) => `safari-web-extension://test/${p}`,
    getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'),
    sendMessage: async () => undefined,
    sendNativeMessage: async () => undefined,
  },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  // An alarm there already (its fields unread: background.ts).
  alarms: { get: async () => ({}) as { name: string, scheduledTime: number }, create: async () => {}, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    // Windows as far as Margin reads them here; its updates' answers unread.
    get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, create: async () => ({}), onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id) => ({ ...fake.tabs.get(id) }),
    create: async ({ windowId, url }) => {
      const tab = { id: fake.nextId++, windowId: windowId ?? 1, url, title: '', index: fake.tabs.size, active: false, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push(url);
      return { ...tab };
    },
    remove: async (ids) => { for (const id of ([] as number[]).concat(ids)) { fake.removed.push(id); fake.tabs.delete(id); } },
    sendMessage: async (tabId, message) => { fake.toPages.push(message?.type); return undefined; },
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async () => [{ result: true }],
    getRegisteredContentScripts: async ({ ids } = {}) => [...fake.registered.values()].filter((s) => !ids || ids.includes(s.id)).map((s) => structuredClone(s)),
    registerContentScripts: async (list) => { for (const s of list) fake.registered.set(s.id, structuredClone(s)); },
    unregisterContentScripts: async ({ ids } = {}) => { for (const id of ids ?? [...fake.registered.keys()]) fake.registered.delete(id); },
    updateContentScripts: async (list) => { for (const s of list) fake.registered.set(s.id, { ...fake.registered.get(s.id), ...structuredClone(s) }); },
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: fake.local[k], newValue: structuredClone(v) }]));
        Object.assign(fake.local, structuredClone(items));
        void fire('sChanged', changes, 'local');
      },
      remove: async (keys) => { for (const k of ([] as string[]).concat(keys)) delete fake.local[k]; },
    },
    session: {
      get: async (keys) => pick(fake.session, keys),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
});

fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.local.settings = { fullscreenOnly: false }; // Chrome's profile (this file's): Margin in every window
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();
// Left by a build with the page box.
fake.registered.set('margin-page', { id: 'margin-page', js: ['content/page.bundle.js'], css: [], matches: ['<all_urls>'] });
fake.local.sheetWalkIndex = { 'https://a.test': [1, 1, 1] };
fake.local['sheetWalk:https://a.test'] = { v: 'x', files: {} };

const sender = (id: number) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
function ask(type: string, payload: Record<string, unknown> = {}, from = 1) {
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply: unknown) => resolve(reply));
  });
}

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');

test('the page box\'s registration and kept sheet walks, left from before its removal, are dropped at start; nothing is registered', async () => {
  for (let i = 0; i < 50 && (fake.registered.size || 'sheetWalkIndex' in fake.local); i++) await sleep(10);
  assert.equal(fake.registered.size, 0);
  assert.ok(!('sheetWalkIndex' in fake.local) && !('sheetWalk:https://a.test' in fake.local));
});

test('not linked: ⌘T and the palette\'s key open Margin\'s new-tab page, once a press however it came; the sidebar\'s key does nothing; no page is asked to draw a palette', async () => {
  fake.created.length = 0;
  await fire('onCommand', 'new-tab', { id: 1, windowId: 1 });
  await ask('newTabKey'); // the same press, heard in the page too (content/core.ts)
  await sleep(20);
  assert.deepEqual(fake.created, [NEW_TAB], 'one new tab, Margin\'s new-tab page');
  await sleep(650);
  await fire('onCommand', 'open-palette', { id: 1, windowId: 1 });
  await sleep(20);
  assert.deepEqual(fake.created, [NEW_TAB, NEW_TAB], 'the palette\'s key: the same');
  await sleep(650);
  await fire('onCommand', 'toggle-sidebar', { id: 1, windowId: 1 });
  await sleep(20);
  assert.equal(fake.created.length, 2, 'the sidebar\'s key: nothing');
  assert.ok(!fake.toPages.some((t) => t === 'show-palette' || t === 'command'), 'nothing asked of a page');
});

test('not linked: a new tab the browser made stays, its page told there\'s no app (the page hands it to the browser\'s own: newtab-page.test.ts)', async () => {
  fake.tabs.set(9, { id: 9, windowId: 1, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(1).active = false;
  fake.removed.length = 0;
  const reply = await ask('newTabPage', {}, 9);
  assert.deepEqual(reply, { ok: true, result: { app: false } });
  assert.deepEqual(fake.removed, [], 'the new tab stays');
  assert.ok(!fake.toPages.includes('show-palette'));
});

test.after(() => setTimeout(() => process.exit(0), 50));
