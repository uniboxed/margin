// Margin's tabs through the background's own listeners (background.js), against
// a fake of Safari's API: what a browser tab's close does to its Margin tab
// (to the archive when closed on its own, kept when its window closes or
// Margin puts it to sleep), opening a tab that isn't open where it's clicked,
// closing, pinning and archiving one.
// The rules themselves (state/model.js) are in tests/margin-tabs.test.js.
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
  local: {},
  session: {},
  // What a page answers the sleep pass (background/sleep.js sleepInPage).
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
      const at = Number.isInteger(index) ? Math.min(index, count) : count;
      for (const t of fake.tabs.values()) if (t.windowId === win && t.index >= at) t.index++;
      if (active) for (const t of fake.tabs.values()) if (t.windowId === win) t.active = false;
      const tab = { id: fake.nextId++, windowId: win, url, title: '', index: at, active: !!active, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push({ windowId: win, url, index, active: !!active });
      void fire('onCreated', { ...tab });
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

const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
function ask(type, payload = {}, from = 1) {
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply) => resolve(reply));
  });
}

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
const M = await import('../extension/state/model.js');
const V = await import('../extension/shared/view.js');
const { setSleepTiming } = await import('../extension/background/sleep.js');
const { platform } = await import('../extension/shared/platform.js');
setSleepTiming({ gapMs: 1, askMs: 100 });
(await import('../extension/background/tabs.js')).assumeMarkedForTests(true);

// Spaces as the test wants them, once the first sync is through.
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
await store.mutate((s) => {
  let next = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  for (const id of [1, 2, 3, 5]) next = M.moveTab(next, id, 'work');
  next = M.moveTab(next, 4, 'personal');
  next = M.setActiveSpace(M.setActiveSpace(next, 1, 'work'), 2, 'work');
  return next;
});
const settled = () => sleep(30);
const state = () => store.load();

test('a tab closed on its own (⌘W, Safari\'s tab bar) goes to the archive; one lost with its window stays, not open, in its space', async () => {
  const before = await state();
  const cMid = before.tabs[3].mid;
  await closeInSafari(2, false);
  await settled();
  let s = await state();
  assert.equal(s.tabs[2], undefined);
  assert.deepEqual(s.archive.map((a) => a.url), ['https://b.test/'], 'archived');
  assert.equal(Object.values(s.keptTabs).some((k) => k.url === 'https://b.test/'), false);
  await closeInSafari(3, true);
  await settled();
  s = await state();
  const kept = Object.values(s.keptTabs).find((k) => k.url === 'https://c.test/');
  assert.ok(kept, 'kept');
  assert.deepEqual([kept.id, kept.spaceId, kept.why], [cMid, 'work', 'window']);
  assert.equal(s.archive.length, 1, 'not archived');
  // Drawn in every window showing Work, not open.
  for (const [windowId, tabId] of [[1, 1], [2, 5]]) assert.ok(V.sidebar(s, windowId, tabId).tabs.some((t) => t.id === cMid && t.kept), `window ${windowId}`);
});

test('a tab that isn\'t open, clicked: it opens in the window where it was clicked, at its place in the tab strip, as the same Margin tab', async () => {
  // Put c back between a and d first (it was lost with its window).
  const s0 = await state();
  const kept = Object.values(s0.keptTabs).find((k) => k.url === 'https://c.test/');
  fake.created.length = 0;
  const reply = await ask('activateTab', { tabId: kept.id }, 1);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  await settled();
  assert.deepEqual(fake.created, [{ windowId: 1, url: 'https://c.test/', index: 1, active: true }], 'in window 1, before d (placed after it): a, c, d');
  const s = await state();
  const opened = Object.values(s.tabs).find((t) => t.url === 'https://c.test/');
  assert.equal(reply.result.shown, opened.id);
  assert.equal(opened.mid, kept.id, 'the same Margin tab');
  assert.equal(s.tabSpace[opened.id], 'work');
  assert.equal(s.keptTabs[kept.id], undefined, 'open now');
  assert.deepEqual(V.sidebar(s, 1, opened.id).tabs.map((t) => t.url), ['https://c.test/', 'https://a.test/'], 'its place kept (Work: c above a)');
  // From another window (Margin.app names the window): it opens there.
  await closeInSafari(opened.id, true);
  await settled();
  fake.created.length = 0;
  const again = Object.values((await state()).keptTabs).find((k) => k.url === 'https://c.test/');
  const there = await ask('activateTab', { tabId: again.id, windowId: 2 }, 1);
  assert.equal(there.ok, true);
  assert.equal(fake.created[0].windowId, 2);
  await settled();
  const s2 = await state();
  assert.equal(Object.values(s2.tabs).find((t) => t.url === 'https://c.test/')?.windowId, 2);
});

test('a tab that isn\'t open: closed from Margin it goes to the archive; pinned, its pin is it from then on; moved to another space', async () => {
  const c = Object.values((await state()).tabs).find((t) => t.url === 'https://c.test/');
  await closeInSafari(c.id, true);
  await settled();
  let kept = Object.values((await state()).keptTabs).find((k) => k.url === 'https://c.test/');
  assert.equal((await ask('moveTabToSpace', { tabId: kept.id, spaceId: 'personal' })).ok, true);
  assert.equal((await state()).keptTabs[kept.id].spaceId, 'personal');
  assert.equal((await ask('closeTab', { tabId: kept.id })).ok, true);
  let s = await state();
  assert.equal(s.keptTabs[kept.id], undefined);
  assert.equal(s.archive[0].url, 'https://c.test/');
  assert.equal(s.archive[0].spaceId, 'personal');
  // Another kept, then pinned.
  await closeInSafari(4, true);
  await settled();
  kept = Object.values((await state()).keptTabs).find((k) => k.url === 'https://d.test/');
  const pinned = await ask('pinTab', { tabId: kept.id });
  assert.equal(pinned.ok, true);
  s = await state();
  assert.equal(s.keptTabs[kept.id], undefined, 'the pin is it');
  assert.deepEqual(s.pins.map((p) => [p.url, p.spaceId]), [['https://d.test/', 'personal']]);
});

test('a pin whose tab isn\'t open opens as that Margin tab (one kept from before it was pinned)', async () => {
  const s0 = await state();
  // A kept tab in Work at a pinned address (kept before the pin was made).
  await store.mutate((s) => ({ ...s, keptTabs: { ...s.keptTabs, 't-pinned1': { id: 't-pinned1', url: 'https://p.test/', title: 'P', favIconUrl: '', spaceId: 'work', order: 0.5, lastActive: 1, keptAt: 1, why: 'window' } }, pins: [...s.pins, { id: 'pp', spaceId: 'work', url: 'https://p.test/', title: 'P' }] }));
  assert.ok(s0);
  const reply = await ask('openPin', { pinId: 'pp', windowId: 1 });
  assert.equal(reply.ok, true);
  await settled();
  const s = await state();
  const t = Object.values(s.tabs).find((x) => x.url === 'https://p.test/');
  assert.equal(t.mid, 't-pinned1');
  assert.equal(s.keptTabs['t-pinned1'], undefined);
});

test('auto-archive: a tab unused for archiveAfterHours goes to the archive whether it\'s open or not', async () => {
  const old = Date.now() - 13 * 3600_000;
  await store.mutate((s) => ({ ...s, keptTabs: { ...s.keptTabs, 't-old1': { id: 't-old1', url: 'https://old.test/', title: 'Old', favIconUrl: '', spaceId: 'work', order: 0.1, lastActive: old, keptAt: old, why: 'window' } } }));
  const count = await globalThis.margin.archiveNow();
  assert.ok(count >= 1);
  const s = await state();
  assert.equal(s.keptTabs['t-old1'], undefined);
  assert.ok(s.archive.some((a) => a.url === 'https://old.test/'));
});

test('sleep (Safari): a tab unused for sleepAfterHours is closed by Margin and kept, not open, in its space; the tab in front, one with a draft, one playing and the never-sleep list stay open', async () => {
  assert.equal(platform.sleepTabs, 'close');
  for (const t of [
    { id: 20, windowId: 1, url: 'https://s1.test/', title: 'S1', index: 10 },
    { id: 21, windowId: 1, url: 'https://draft.test/', title: 'Draft', index: 11 },
    { id: 22, windowId: 1, url: 'https://music.test/', title: 'Music', index: 12, audible: true },
    { id: 23, windowId: 1, url: 'https://never.test/', title: 'Never', index: 13 },
  ]) {
    fake.tabs.set(t.id, { status: 'complete', active: false, ...t });
    await fire('onCreated', { ...fake.tabs.get(t.id) });
  }
  await settled();
  await store.mutate((s) => ({ ...s, settings: { ...s.settings, neverSleepSites: ['never.test'] } }));
  const s1 = (await state()).tabs[20];
  fake.page = (tabId) => (tabId === 21 ? { ok: false, why: 'edited', judged: 'margin' } : { ok: true, judged: 'margin' });
  fake.removed.length = 0;
  const fronts = [...fake.tabs.values()].filter((t) => t.active).map((t) => t.id);
  const result = await ask('sleepNow', { afterMs: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  await settled();
  const s = await state();
  assert.ok(fake.removed.includes(20), 'closed');
  assert.equal(s.tabs[20], undefined);
  const kept = s.keptTabs[s1.mid];
  assert.ok(kept, 'its Margin tab kept');
  assert.deepEqual([kept.url, kept.why, kept.spaceId], ['https://s1.test/', 'sleep', 'work']);
  assert.equal(s.archive.some((a) => a.url === 'https://s1.test/'), false, 'not archived');
  for (const id of [21, 22, 23]) assert.ok(s.tabs[id], `tab ${id} still open`);
  for (const id of fronts) assert.ok(s.tabs[id] && !fake.removed.includes(id), 'never the tab in front of a window');
});
