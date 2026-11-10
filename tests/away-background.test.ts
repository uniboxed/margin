// Tabs following the window in front through the background's own listeners (background.ts, background/away.ts,
// docs/BROWSER-WINDOWS.md §9), against a fake of Safari's API: the stand-in's events left out, the move, the focus coming
// back, the stand-in clicked, the tab closed. The rules: tests/away.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = {
  tabs: new Map(),
  nextId: 500,
  created: [],
  removed: [],
  moves: [],
  local: {},
  session: {},
  focused: 2,
  // What a page answers the sleep pass (background/sleep.ts sleepInPage).
  page: () => ({ ok: true, judged: 'margin' }),
};
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const reindex = (windowId) => [...fake.tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
// Safari closing a tab (its tab bar, ⌘W, or its window closing).
async function closeInSafari(id, isWindowClosing = false) {
  const tab = fake.tabs.get(id);
  fake.tabs.delete(id);
  reindex(tab.windowId);
  await fire('onRemoved', id, { windowId: tab.windowId, isWindowClosing });
}
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
    get: async (id) => ({ id, focused: id === fake.focused }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, create: async () => ({}), onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id, change) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      const was = tab.active;
      if (change.active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      if (change.url) tab.url = change.url;
      if (change.active && !was) void fire('onActivated', { tabId: id, windowId: tab.windowId });
      return { ...tab };
    },
    move: async (id, { windowId, index }) => {
      const tab = fake.tabs.get(id);
      const from = tab.windowId;
      fake.moves.push({ id, from, to: windowId });
      tab.windowId = windowId;
      tab.active = false;
      tab.index = index < 0 ? 999 : index - 0.5;
      reindex(from);
      reindex(windowId);
      await fire('onDetached', id, { oldWindowId: from });
      await fire('onAttached', id, { newWindowId: windowId });
      return { ...tab };
    },
    captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
    create: async ({ windowId, url, active, index }) => {
      const win = windowId ?? 1;
      const count = [...fake.tabs.values()].filter((t) => t.windowId === win).length;
      const at = Number.isInteger(index) ? Math.min(index, count) : count;
      for (const t of fake.tabs.values()) if (t.windowId === win && t.index >= at) t.index++;
      if (active) for (const t of fake.tabs.values()) if (t.windowId === win) t.active = false;
      const tab = { id: fake.nextId++, windowId: win, url, title: '', index: at, active: !!active, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push({ windowId: win, url, index, active: !!active });
      void fire('onCreated', { ...tab, url: '' }); // (Safari: no address yet)
      if (active) void fire('onActivated', { tabId: tab.id, windowId: win });
      return { ...tab };
    },
    remove: async (ids) => {
      for (const id of [].concat(ids)) {
        if (!fake.tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        fake.removed.push(id);
        await closeInSafari(id, false);
      }
    },
    sendMessage: async () => undefined,
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async ({ target, func }) => {
      if (func?.name === 'sleepInPage') return [{ frameId: 0, result: { top: true, ...fake.page(target.tabId) } }];
      return [{ result: true }];
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
      get: async (keys) => pick(fake.session, keys),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
};


// Window 1: a (in front) and b; window 2: c (in front). All in the first space.
const OPEN = [
  { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true },
  { id: 2, windowId: 1, url: 'https://b.test/', title: 'B', index: 1, active: false },
  { id: 3, windowId: 2, url: 'https://c.test/', title: 'C', index: 0, active: true },
];
for (const t of OPEN) fake.tabs.set(t.id, { status: 'complete', ...t });
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
const V = await import('../extension/shared/view.ts');
const { setAwayTiming } = await import('../extension/background/away.ts');
setAwayTiming({ settleMs: 5 });
const STAND_IN = 'safari-web-extension://test/away/away.html';
const state = async () => { await sleep(30); return store.load(); };
const standIn = (windowId) => [...fake.tabs.values()].find((t) => t.windowId === windowId && t.url === STAND_IN);

test('a: chosen in window 2, it moves there; window 1 shows it away, its stand-in never a Margin tab', async () => {
  await state();
  const reply = await ask('activateTab', { tabId: 1 }, 3);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const s = await state();
  assert.deepEqual(fake.moves, [{ id: 1, from: 1, to: 2 }]);
  assert.equal(s.tabs[1].windowId, 2);
  assert.equal(s.tabs[1].active, true, 'in front of window 2');
  assert.deepEqual(s.awayByWindow, { 1: 1 });
  const stand = standIn(1);
  assert.ok(stand?.active, 'the stand-in in front of window 1');
  assert.equal(s.tabs[stand.id], undefined, 'not a Margin tab, though Safari said no address at first');
  assert.equal(Object.keys(s.tabs).length, 3);
  const one = V.sidebar(s, 1).tabs.find((t) => t.id === 1);
  assert.deepEqual([one.active, one.away], [true, true]);
  assert.equal(V.sidebar(s, 1).tabs.filter((t) => t.active).length, 1, 'only it chosen in window 1');
  const shown = await ask('awayShown', {}, stand.id);
  assert.equal(shown.result.tabId, 1);
  assert.match(shown.result.picture, /^data:image\/jpeg/);
});

test('b: window 1 to the front: the tab follows it back; window 2 shows it away', async () => {
  const first = standIn(1).id;
  fake.focused = 1;
  await fire('onFocusChanged', 1);
  const s = await state();
  assert.equal(fake.tabs.get(1).windowId, 1);
  assert.equal(s.tabs[1].active, true);
  assert.ok(!fake.tabs.has(first), 'window 1\'s stand-in gone');
  assert.deepEqual(s.awayByWindow, { 2: 1 });
  assert.ok(standIn(2)?.active);
  assert.equal(V.sidebar(s, 2).tabs.find((t) => t.id === 1).away, true);
});

test('c: the stand-in clicked: its tab back in its window', async () => {
  const stand = standIn(2).id;
  fake.focused = 2;
  const reply = await ask('bringAway', {}, stand);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const s = await state();
  assert.equal(fake.tabs.get(1).windowId, 2);
  assert.ok(!fake.tabs.has(stand));
  assert.deepEqual(s.awayByWindow, { 1: 1 });
});

test('d: closed: the window that showed it away shows its next tab', async () => {
  const stand = standIn(1).id;
  await closeInSafari(1);
  const s = await state();
  assert.deepEqual(s.awayByWindow, {});
  assert.equal(fake.tabs.get(2).active, true, 'b in front of window 1');
  assert.ok(!fake.tabs.has(stand));
});
