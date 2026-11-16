// A window Margin.app draws nothing over (its copy told `drawn` false: not in
// full screen, or not found among the window server's yet), the background's
// side against a fake of the browser's API, with the link's word played on
// the background's own link object: Margin's keys there go the unlinked way:
// ⌘T and the palette's key open Margin's new-tab page, a new tab Safari made
// stays (no palette pushed for it), the new-tab page is told the app doesn't
// draw there, and the sidebar's key is logged; in a window the app draws,
// they're left to the app.
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
  webNavigation: { onCommitted: event('navCommitted') },
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

const sender = (id: number) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
function ask(type: string, payload: Record<string, unknown> = {}, from = 1) {
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply: unknown) => resolve(reply));
  });
}

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
const { appLink } = await import('../extension/background/app-link.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');


// The link's word, as the background's link object would have it (background/link.ts view, drawn, drawsWindow).
const pushes: [number | null | undefined, unknown][] = [];
function linkSays({ drawn = {}, linked = true }: { drawn?: Record<number, boolean>, linked?: boolean } = {}) {
  appLink.push = (windowId, msg) => { pushes.push([windowId, msg]); return linked; };
  appLink.view = () => ({ epoch: 'e1', drawn });
  appLink.drawn = (w) => drawn[w as number]; // (no window: undefined, as drawn[w] gives)
  appLink.drawsWindow = (w) => linked && drawn[w as number] !== false;
  appLink.linked = () => linked;
  appLink.pageState = () => (linked ? 'linked' : 'off');
}

// Linked, with a tab in each of windows 2 and 3 besides window 1's.
await chrome.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', drawn: {} } });
fake.tabs.set(20, { id: 20, windowId: 2, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.tabs.set(30, { id: 30, windowId: 3, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
await sleep(30);

test('⌘T, the palette\'s key and the sidebar\'s in a window Margin.app draws nothing over: Margin\'s new-tab page, the sidebar\'s logged; in one it draws: left to the app', async () => {
  linkSays({ drawn: { 1: false, 2: true } });
  fake.tabs.set(1, { ...fake.tabs.get(1), active: true });
  fake.tabs.set(20, { ...fake.tabs.get(20), active: true });
  fake.created.length = 0;
  pushes.length = 0;
  await fire('onCommand', 'new-tab', { id: 1, windowId: 1 });
  await sleep(30);
  assert.deepEqual(fake.created, [NEW_TAB], 'undrawn: Margin\'s new-tab page');
  // (The empty lists typed: deepEqual narrows what it checks to the type of what it expects.)
  assert.deepEqual(pushes, [] as typeof pushes, 'nothing pushed for the app');
  await fire('onCommand', 'new-tab', { id: 20, windowId: 2 });
  await sleep(30);
  assert.equal(fake.created.length, 1, 'drawn: no tab');
  assert.deepEqual(pushes, [[2, { type: 'keyHeard', command: 'new-tab', from: 'command' }]], 'left to the app, which is told');
  pushes.length = 0;
  await sleep(650);
  await fire('onCommand', 'toggle-sidebar', { id: 1, windowId: 1 });
  await sleep(30);
  assert.equal(fake.created.length, 1, 'the sidebar\'s key: no tab');
  assert.deepEqual(pushes, [] as typeof pushes, 'and nothing for an app that draws nothing there');
  await sleep(650);
  await ask('newTabKey', {}, 1); // ⌘T heard by the page in the undrawn window (content/core.ts drawsWindow)
  await sleep(30);
  assert.deepEqual(fake.created, [NEW_TAB, NEW_TAB], 'the page\'s ⌘T: the same');
});

test('a new tab Safari made in a window Margin.app draws nothing over stays, with no palette pushed, and its page is told the app isn\'t there; in a window it draws, handed to the app\'s palette', async () => {
  linkSays({ drawn: { 1: false, 2: true } });
  fake.tabs.set(9, { id: 9, windowId: 1, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(1).active = false;
  await fire('onCreated', { ...fake.tabs.get(9) });
  await sleep(50);
  fake.removed.length = 0;
  pushes.length = 0;
  assert.deepEqual(await ask('newTabPage', {}, 9), { ok: true, result: { app: false } }, 'undrawn: the page shows its own');
  assert.deepEqual(fake.removed, [] as number[], 'the new tab stays');
  assert.deepEqual(pushes, [] as typeof pushes, 'no palette pushed');
  await fire('onCreated', { ...fake.tabs.get(20) }); // (the web page in window 2, as Margin's state has it)
  await sleep(50);
  fake.tabs.set(29, { id: 29, windowId: 2, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(20).active = false;
  await fire('onCreated', { ...fake.tabs.get(29) });
  await sleep(50);
  // (Handed off as Safari made it: background.ts onCreated.)
  assert.deepEqual(pushes.find(([w]) => w === 2), [2, { type: 'palette', newTab: true }]);
  assert.ok(fake.removed.includes(29), 'the new tab closed');
});

test('⌘T handed off while the copy still thinks the app draws there, and the app couldn\'t show the palette (no overlay shown: its binding just gone): Margin\'s new-tab page opens there, and the next ⌘T keeps Safari\'s new tab', async () => {
  linkSays({ drawn: { 3: true } }); // the copy hasn't heard yet: the app's grace before "not drawn"
  fake.tabs.set(30, { ...fake.tabs.get(30), windowId: 3, active: false });
  await fire('onCreated', { ...fake.tabs.get(30) });
  await sleep(50);
  fake.tabs.set(39, { id: 39, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  pushes.length = 0;
  fake.removed.length = 0;
  fake.created.length = 0;
  await fire('onCreated', { ...fake.tabs.get(39) });
  await sleep(50);
  assert.deepEqual(pushes.find(([w]) => w === 3), [3, { type: 'palette', newTab: true }], 'handed off to the app');
  assert.ok(fake.removed.includes(39), 'Safari\'s new tab closed');
  fake.tabs.get(30).active = true;
  // The app (Shell.paletteDropped) says it couldn't show it, as a request of its UI's.
  const notes: string[] = [];
  const note = appLink.note;
  appLink.note = (line) => { notes.push(String(line)); };
  let done;
  try {
    done = await new Promise((resolve) => listeners.onMessage[0]({ type: 'paletteDropped', windowId: 3, newTab: true }, { app: true, tab: { windowId: 3 } }, resolve));
  } finally {
    appLink.note = note;
  }
  assert.deepEqual(done, { ok: true, result: true });
  assert.deepEqual(fake.created, [NEW_TAB], 'Margin\'s new-tab page opened in the window: ⌘T still opens something');
  assert.ok(notes.some((l) => l === 'the app couldn\'t show the palette over window 3: Margin\'s new-tab page opened there'), `${notes}`);
  // That page, and Safari's next new tab there: kept as the copy's own (no palette pushed).
  const page = fake.nextId - 1;
  fake.tabs.get(30).active = false;
  fake.tabs.set(page, { ...fake.tabs.get(page), url: NEW_TAB, active: true, status: 'complete' });
  pushes.length = 0;
  assert.deepEqual(await ask('newTabPage', {}, page), { ok: true, result: { app: false } }, 'the new-tab page shows its own');
  fake.tabs.set(49, { id: 49, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 3, active: true, status: 'complete' });
  fake.removed.length = 0;
  await fire('onCreated', { ...fake.tabs.get(49) });
  await sleep(50);
  assert.deepEqual(pushes, [] as typeof pushes, 'no palette pushed');
  assert.ok(!fake.removed.includes(49), 'the next ⌘T\'s tab stays');
  // The app saying it draws there again: at once after the drop (its binding holds, its overlay not
  // shown yet), still kept; a second later, ⌘T goes to the app's palette again.
  const { drawnChanged } = await import('../extension/background/handlers.ts');
  const backToPage = async () => {
    for (const [id, t] of fake.tabs) if (t.windowId === 3 && id !== 30) { fake.tabs.delete(id); await fire('onRemoved', id, { windowId: 3, isWindowClosing: false }); }
    fake.tabs.get(30).active = true;
    await fire('onActivated', { tabId: 30, windowId: 3 });
    await sleep(50);
  };
  const newTab = async (id: number) => {
    fake.tabs.get(30).active = false;
    fake.tabs.set(id, { id, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
    pushes.length = 0;
    await fire('onCreated', { ...fake.tabs.get(id) });
    await sleep(50);
  };
  drawnChanged(3, true);
  await backToPage();
  await newTab(59);
  assert.deepEqual(pushes, [] as typeof pushes, 'drawn at once after the drop: still kept');
  await sleep(1000);
  drawnChanged(3, true);
  await backToPage();
  await newTab(69);
  assert.deepEqual(pushes.find(([w]) => w === 3), [3, { type: 'palette', newTab: true }], 'drawn again later: handed to the app\'s palette');
});
