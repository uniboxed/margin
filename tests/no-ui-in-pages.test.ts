// Margin 2 Phase 2 step 5: pages draw none of Margin's UI, linked to
// Margin.app or not. The background's side, against a fake of the browser's
// API: not linked, ⌘T and the palette's key open Margin's new-tab page (once
// a press, whichever way it came), a new tab made by the browser stays (no
// palette to hand it to), and nothing is registered for the first paint, so
// a page has no box or frame; linked (or reconnecting), the first-paint box
// is registered again, and dropped once the link is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = { tabs: new Map(), nextId: 500, created: [], removed: [], local: {}, session: {}, registered: new Map(), toPages: [] };
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const NEW_TAB = 'safari-web-extension://test/newtab/newtab.html';
globalThis.fetch = async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
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
  alarms: { get: async () => ({}), create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
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
    remove: async (ids) => { for (const id of [].concat(ids)) { fake.removed.push(id); fake.tabs.delete(id); } },
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

fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.local.settings = { fullscreenOnly: false }; // Chrome's profile (this file's): Margin in every window
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
function ask(type, payload = {}, from = 1) {
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply) => resolve(reply));
  });
}

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
const { queueRegistrations, whenRegistered } = await import('../extension/background/registered.ts');
const { layoutFiles } = await import('../extension/shared/page-box.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
const settled = async () => { await sleep(30); await whenRegistered(); await sleep(10); };

test('not linked: nothing is registered for the first paint (no box, no frame); linked or reconnecting, the first paint is; off again, the same at no box (updated, never taken away); the build before\'s placeholder dropped', async () => {
  await settled();
  assert.deepEqual([...fake.registered.keys()], [], 'not linked: nothing');
  fake.registered.set('margin-docked', { id: 'margin-docked', css: ['themes/arcadia/docked/w-260.css'] }); // the build before Phase 3's
  await chrome.storage.local.set({ appLink: { state: 'linked', layouts: {} } });
  await settled();
  assert.deepEqual([...fake.registered.keys()], ['margin-page'], 'the build before\'s placeholder dropped');
  const page = fake.registered.get('margin-page');
  assert.deepEqual(page.js, ['content/page.bundle.js']);
  assert.deepEqual(page.css, [...layoutFiles({ left: 8, top: 8, right: 8, bottom: 8, radius: 6.25 }), 'content/layout/theme-arcadia.css'], 'no window measured yet: the frame from the settings');
  assert.equal(page.world, 'MAIN');
  await chrome.storage.local.set({ appLink: { state: 'reconnecting', layouts: { 1: { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 10 } } } });
  await settled();
  assert.ok(fake.registered.get('margin-page')?.js, 'reconnecting: still there');
  void queueRegistrations(); // (the link's layouts settled: background.ts layoutsChanged)
  await settled();
  assert.deepEqual(fake.registered.get('margin-page').css.slice(0, -1), layoutFiles({ left: 260, top: 8, right: 8, bottom: 8, radius: 10 }), 'at the window\'s layout');
  await chrome.storage.local.set({ appLink: { state: 'off', layouts: {} } });
  await settled();
  assert.deepEqual([...fake.registered.keys()], ['margin-page']);
  assert.deepEqual(fake.registered.get('margin-page').css, [...layoutFiles({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 }), 'content/layout/theme-arcadia.css'], 'off: no box');
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

test('not linked: a new tab the browser made stays, its page told there\'s no app; the start button asks for the link (none here: Chrome\'s profile has no link)', async () => {
  fake.tabs.set(9, { id: 9, windowId: 1, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(1).active = false;
  fake.removed.length = 0;
  const reply = await ask('newTabPage', {}, 9);
  assert.deepEqual(reply, { ok: true, result: { app: false } });
  assert.deepEqual(fake.removed, [], 'the new tab stays');
  assert.ok(!fake.toPages.includes('show-palette'));
  assert.deepEqual(await ask('startApp', {}, 9), { ok: true, result: false });
});

test.after(() => setTimeout(() => process.exit(0), 50));
