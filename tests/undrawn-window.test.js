// A window Margin.app draws nothing over (its copy told `drawn` false: not in
// full screen, or not found among the window server's yet), the background's
// side against a fake of the browser's API, with the link's word played on
// the background's own link object: a page committing there gets no box from
// its first paint (`--margin-fp: off`), while one in a window not said of yet
// (a new full-screen window before its first layout) keeps the registered box.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = { tabs: new Map(), nextId: 500, created: [], removed: [], local: {}, session: {}, registered: new Map(), toPages: [], inserted: [] };
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
  webNavigation: { onCommitted: event('navCommitted') },
  scripting: {
    executeScript: async () => [{ result: true }],
    insertCSS: async ({ target, css }) => { fake.inserted.push({ tabId: target.tabId, css }); },
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

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
const { whenRegistered, OFF_CSS } = await import('../extension/background/registered.js');
const { appLink } = await import('../extension/background/app-link.js');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
const settled = async () => { await sleep(30); await whenRegistered(); await sleep(10); };


// The link's word, as the background's link object would have it (background/link.js view, drawn, drawsWindow).
function linkSays({ drawn = {}, layouts = {}, linked = true } = {}) {
  appLink.view = () => ({ epoch: 'e1', layouts, drawn });
  appLink.drawn = (w) => drawn[w];
  appLink.drawsWindow = (w) => linked && drawn[w] !== false;
  appLink.linked = () => linked;
  appLink.pageState = () => (linked ? 'linked' : 'off');
}
const commit = (tabId) => fire('navCommitted', { tabId, frameId: 0, documentId: `doc-${tabId}`, url: 'https://a.test/next' });

test('a page committing in a window Margin.app draws nothing over: no box from its first paint; in a window not said of yet: the registered box', async () => {
  await chrome.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', layouts: {}, drawn: {} } });
  await settled();
  assert.ok(fake.registered.get('margin-page')?.js, 'the first paint registered');
  fake.tabs.set(20, { id: 20, windowId: 2, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
  fake.tabs.set(30, { id: 30, windowId: 3, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
  linkSays({ drawn: { 2: false } });
  await commit(20);
  await commit(30);
  await sleep(20);
  assert.deepEqual(fake.inserted, [{ tabId: 20, css: OFF_CSS }], 'only the undrawn window\'s page');
  linkSays({ drawn: { 2: true }, layouts: { 2: { insets: { left: 300, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } } });
  fake.inserted.length = 0;
  await commit(20);
  await sleep(20);
  assert.equal(fake.inserted.length, 1);
  assert.match(fake.inserted[0].css, /--margin-at-left: 300px/, 'drawn again: its own layout');
});

test.after(() => setTimeout(() => process.exit(0), 50));
