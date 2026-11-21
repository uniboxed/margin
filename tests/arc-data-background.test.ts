// The Arc features' data through the background's own handlers (background/handlers.ts), against a fake of Safari's
// API (the harness of tests/kept-tabs.test.ts): a favorite's tab asleep opened again as that Margin tab (never a pile
// of new ones), a pin's tab moved to another space closed into the archive, a pin never taking a favorite's tab by its
// address, a split's pane leaving as its tab closes (background/store.ts mutate settles splits). The rules themselves:
// tests/arc-data.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A listener, called with whatever its event gives.
type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const event = (name: string) => ({ addListener: (fn: Listener) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = {
  tabs: new Map(),
  nextId: 500,
  created: [] as { windowId: number, url?: string, index?: number, active: boolean }[],
  removed: [] as number[],
  local: {} as Record<string, any>, // stored JSON
  session: {} as Record<string, any>,
  // What a page answers the sleep pass (background/sleep.ts sleepInPage).
  page: (() => ({ ok: true, judged: 'margin' })) as (tabId: number) => { ok: boolean, why?: string, judged?: string },
};
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, unknown> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const reindex = (windowId?: number) => [...fake.tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
// Safari closing a tab (its tab bar, ⌘W, or its window closing).
async function closeInSafari(id: number, isWindowClosing = false) {
  const tab = fake.tabs.get(id);
  fake.tabs.delete(id);
  reindex(tab.windowId);
  await fire('onRemoved', id, { windowId: tab.windowId, isWindowClosing });
}
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
    update: async (id, change) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      if (change.active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return { ...tab };
    },
    create: async ({ windowId, url, active, index }) => {
      const win = windowId ?? 1;
      const count = [...fake.tabs.values()].filter((t) => t.windowId === win).length;
      const at = Number.isInteger(index) ? Math.min(index!, count) : count; // (a number: just checked)
      for (const t of fake.tabs.values()) if (t.windowId === win && t.index >= at) t.index++;
      if (active) for (const t of fake.tabs.values()) if (t.windowId === win) t.active = false;
      const tab = { id: fake.nextId++, windowId: win, url, title: '', index: at, active: !!active, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push({ windowId: win, url, index, active: !!active });
      void fire('onCreated', { ...tab });
      return { ...tab };
    },
    remove: async (ids) => {
      for (const id of ([] as number[]).concat(ids)) {
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

// Window 1: a (in front), b, c in Work; d in Personal. Window 2: e (Work).
const OPEN = [
  { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true },
  { id: 2, windowId: 1, url: 'https://b.test/', title: 'B', index: 1, active: false },
  { id: 3, windowId: 1, url: 'https://c.test/', title: 'C', index: 2, active: false },
  { id: 4, windowId: 1, url: 'https://d.test/', title: 'D', index: 3, active: false },
  { id: 5, windowId: 2, url: 'https://e.test/', title: 'E', index: 0, active: true },
];
for (const t of OPEN) fake.tabs.set(t.id, { status: 'complete', ...t });
fake.session.alive = true; // not a relaunch: the ids are this session's
fake.session.since = 1;
fake.session.startWorkAt = Date.now(); // no start-up work (onboarding, archive) in the way

const sender = (id: number) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
// The background's answer (Margin's own protocol: any, as types/browser.d.ts has it).
type Reply = { ok: boolean, result?: any, error?: string };
function ask(type: string, payload: Record<string, unknown> = {}, from = 1) {
  return new Promise<Reply>((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply: Reply) => resolve(reply));
  });
}

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
const M = await import('../extension/state/model.ts');
const V = await import('../extension/shared/view.ts');
const { setSleepTiming } = await import('../extension/background/sleep.ts');
const { capabilities } = await import('../extension/shared/capabilities.ts');
setSleepTiming({ gapMs: 1, askMs: 100 });

// Spaces as the test wants them, once the first sync is through.
await store.mutate((s) => {
  let next = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  for (const id of [1, 2, 3, 5]) next = M.moveTab(next, id, 'work');
  next = M.moveTab(next, 4, 'personal');
  next = M.setActiveSpace(M.setActiveSpace(next, 1, 'work'), 2, 'work');
  return next;
});
const settled = () => sleep(30);
const state = () => store.load();
// A tab Safari opens (not Margin), in window 1, in Work.
async function opened(id: number, url: string) {
  fake.tabs.set(id, { id, windowId: 1, url, title: url, index: [...fake.tabs.values()].filter((t) => t.windowId === 1).length, active: false, status: 'complete' });
  await fire('onCreated', { ...fake.tabs.get(id) });
  await settled();
  await store.mutate((s) => M.moveTab(s, id, 'work'));
}

test('arc data (background): a favorite\'s tab put to sleep opens again as that Margin tab, each time: one tab per favorite, never a pile', async () => {
  const added = await ask('addFavorite', { tabId: 2, windowId: 1 });
  assert.equal(added.ok, true, JSON.stringify(added));
  const favId = added.result;
  const mid = (await state()).tabs[2].mid!;
  assert.equal((await state()).tabs[2].favoriteId, favId);
  for (let round = 0; round < 3; round++) {
    const open = Object.values((await state()).tabs).find((t) => t.favoriteId === favId)!;
    assert.equal((await ask('unloadTab', { tabId: open.id })).ok, true);
    await settled();
    let s = await state();
    assert.equal(s.keptTabs[mid]?.favoriteId, favId, `round ${round}: asleep, kept as the favorite's`);
    fake.created.length = 0;
    const reply = await ask('openFavorite', { favoriteId: favId, windowId: 1 });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    await settled();
    s = await state();
    assert.equal(fake.created.length, 1, `round ${round}: one browser tab, for its kept one`);
    const bound = Object.values(s.tabs).filter((t) => t.favoriteId === favId);
    assert.deepEqual(bound.map((t) => t.mid), [mid], `round ${round}: the same Margin tab, the favorite's`);
    assert.equal(Object.values(s.keptTabs).filter((k) => k.favoriteId === favId).length, 0, `round ${round}: nothing left hidden`);
    assert.equal(V.sidebar(s, 1, bound[0].id).favorites.find((f) => f.id === favId)?.tabId, bound[0].id);
  }
  // A hidden one an earlier build left (it opened a new tab each time): the click keeps the one used last, archives the rest.
  const open = Object.values((await state()).tabs).find((t) => t.favoriteId === favId)!;
  await ask('unloadTab', { tabId: open.id });
  await settled();
  await store.mutate((s) => ({ ...s, keptTabs: { ...s.keptTabs, 't-oldpile1': { ...s.keptTabs[mid], id: 't-oldpile1', url: 'https://b.test/older', lastActive: 1 } } }));
  fake.created.length = 0;
  await ask('openFavorite', { favoriteId: favId, windowId: 1 });
  await settled();
  const s = await state();
  assert.equal(fake.created.length, 1);
  assert.equal(Object.values(s.tabs).find((t) => t.favoriteId === favId)?.mid, mid, 'the one used last');
  assert.equal(s.keptTabs['t-oldpile1'], undefined);
  assert.ok(s.archive.some((a) => a.url === 'https://b.test/older'), 'the other: to the archive');
});

test('arc data (background): a pin\'s tab moved to another space and closed goes to the archive as any tab', async () => {
  await opened(30, 'https://pinmove.test/');
  assert.equal((await ask('pinTab', { tabId: 30 })).ok, true);
  const pin = (await state()).pins.find((p) => p.url === 'https://pinmove.test/')!;
  assert.equal((await state()).tabs[30].pinnedBy, pin.id);
  assert.equal((await ask('moveTabToSpace', { tabId: 30, spaceId: 'personal' })).ok, true);
  assert.equal((await state()).tabs[30].pinnedBy, undefined, 'no pin\'s in its new space');
  assert.equal((await ask('closeTab', { tabId: 30 })).ok, true);
  await settled();
  const s = await state();
  assert.equal(s.tabs[30], undefined);
  assert.ok(s.archive.some((a) => a.url === 'https://pinmove.test/' && a.spaceId === 'personal'), 'archived');
  assert.ok(s.pins.some((p) => p.id === pin.id), 'its pin stays');
});

test('arc data (background): closeTab checks the pin of the tab\'s own space (a binding to another space\'s pin, as an earlier build left it)', async () => {
  const pin = (await state()).pins.find((p) => p.url === 'https://pinmove.test/')!;
  assert.equal(pin.spaceId, 'work');
  await opened(32, 'https://stale.test/');
  await store.mutate((st) => ({ ...M.moveTab(st, 32, 'personal'), tabs: { ...st.tabs, 32: { ...st.tabs[32], pinnedBy: pin.id } } }));
  assert.equal((await state()).tabs[32].pinnedBy, pin.id);
  await ask('closeTab', { tabId: 32 });
  await settled();
  assert.ok((await state()).archive.some((a) => a.url === 'https://stale.test/'), 'open: archived');
  await store.mutate((st) => ({ ...st, keptTabs: { ...st.keptTabs, 't-stale1': { id: 't-stale1', url: 'https://stale-kept.test/', title: 'K', favIconUrl: '', spaceId: 'personal', order: 0.2, lastActive: Date.now(), keptAt: Date.now(), why: 'sleep', pinnedBy: pin.id } } }));
  await ask('closeTab', { tabId: 't-stale1' });
  assert.ok((await state()).archive.some((a) => a.url === 'https://stale-kept.test/'), 'kept: archived');
});

test('arc data (background): a pin opened never takes a favorite\'s tab at its address; the favorite keeps it', async () => {
  await opened(31, 'https://shared.test/');
  const fav = (await ask('addFavorite', { tabId: 31, windowId: 1 })).result;
  await store.mutate((s) => M.addPin(s, { id: 'p-shared', spaceId: 'work', url: 'https://shared.test/', title: 'Shared' }));
  fake.created.length = 0;
  const reply = await ask('openPin', { pinId: 'p-shared', windowId: 1 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  await settled();
  const s = await state();
  assert.notEqual(reply.result.shown, 31, 'not the favorite\'s tab');
  assert.equal(fake.created.length, 1, 'a tab of its own');
  assert.equal(s.tabs[31].favoriteId, fav);
  assert.equal(s.tabs[31].pinnedBy, undefined);
  assert.equal(s.tabs[reply.result.shown].pinnedBy, 'p-shared');
});

test('arc data (background): a split keeps Margin tab ids; a pane whose tab closes leaves it, and a split of one goes', async () => {
  await opened(40, 'https://s1.test/');
  await opened(41, 'https://s2.test/');
  await opened(42, 'https://s3.test/');
  const reply = await ask('createSplit', { panes: [40, 41, 42], windowId: 1, spaceId: 'work' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  let s = await state();
  const mids = [40, 41, 42].map((id) => s.tabs[id].mid);
  const split = s.splits!.find((g) => g.id === reply.result.splitId)!;
  assert.deepEqual(split.panes, mids);
  await closeInSafari(41);
  await settled();
  s = await state();
  assert.deepEqual(s.splits!.find((g) => g.id === split.id)?.panes, [mids[0], mids[2]], 'closed in Safari: out of its split');
  await closeInSafari(42);
  await settled();
  s = await state();
  assert.equal(s.splits!.some((g) => g.id === split.id), false, 'one pane left: no split');
});
