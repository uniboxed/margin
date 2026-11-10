// Sleeping tabs in Chrome (background/sleep.ts): tabs.discard, with the same
// choice of tabs and the same look in the page first; no sleep page. A fake of
// Chrome's API (its extension address makes shared/capabilities.ts pick Chrome's
// profile).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOUR = 3600_000;
const fake = { tabs: new Map(), discards: [], updates: [], reloads: [], scripts: [], local: {}, page: () => ({ ok: true }) };
globalThis.chrome = {
  runtime: { id: 'test', getURL: (path) => `chrome-extension://test/${path}`, getManifest: () => ({ version: '0' }), sendMessage: async () => undefined },
  permissions: { contains: async () => true },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { ...tab };
    },
    update: async (id, change) => { fake.updates.push({ id, change }); return { ...fake.tabs.get(id) }; },
    discard: async (id) => {
      fake.discards.push(id);
      Object.assign(fake.tabs.get(id), { discarded: true });
      return { ...fake.tabs.get(id) };
    },
    reload: async (id) => {
      fake.reloads.push(id);
      Object.assign(fake.tabs.get(id), { discarded: false });
    },
    query: async () => [...fake.tabs.values()].map((t) => ({ ...t })),
    sendMessage: async () => undefined,
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      fake.scripts.push({ tabId: target.tabId, func: func?.name, args });
      return [{ result: func?.name === 'sleepInPage' ? fake.page(target.tabId) : true }];
    },
  },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...fake.local } : Object.fromEntries([].concat(keys).filter((k) => k in fake.local).map((k) => [k, structuredClone(fake.local[k])]))),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
    },
  },
};

const { capabilities } = await import('../extension/shared/capabilities.ts');
const M = await import('../extension/state/model.ts');
const { sleepIdle, setSleepTiming, wakeAll } = await import('../extension/background/sleep.ts');
const { decided, mutate } = await import('../extension/background/store.ts');
setSleepTiming({ gapMs: 1, askMs: 100, wakeGapMs: 1 });

async function setUp(tabs) {
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, title: `T${t.id}`, ...t }]));
  fake.discards = [];
  fake.updates = [];
  fake.reloads = [];
  fake.scripts = [];
  await decided();
  await mutate((s) => {
    let next = { ...s, tabs: {}, tabSpace: {}, settings: { ...s.settings, sleepAfterHours: 4 } };
    for (const t of fake.tabs.values()) {
      next = M.upsertTab(next, t, Date.now());
      next = { ...next, tabs: { ...next.tabs, [t.id]: { ...next.tabs[t.id], active: !!t.active, lastActive: Date.now() - 6 * HOUR } } };
    }
    return next;
  });
}

test('chrome: a tab long unused is discarded (tabs.discard) once its page says it may sleep; never sent to a sleep page', async () => {
  assert.equal(capabilities.name, 'chrome');
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, { id: 2, url: 'https://idle.test/' }, { id: 3, url: 'https://draft.test/' }]);
  fake.page = (tabId) => (tabId === 3 ? { ok: false, why: 'edited' } : { ok: true });
  const pass = await sleepIdle();
  assert.deepEqual(pass, { due: 2, slept: 1, skipped: { edited: 1 }, stopped: null });
  assert.deepEqual(fake.discards, [2]);
  assert.deepEqual(fake.updates, [], 'no sleep page');
  assert.deepEqual(fake.scripts.filter((x) => x.func === 'sleepInPage').map((x) => x.tabId), [2, 3], 'each page asked first');
});

test('chrome: a discarded tab keeps its record, marked asleep (not due again); Wake all loads the discarded ones again', async () => {
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, { id: 4, url: 'https://gone.test/', discarded: true }, { id: 5, url: 'https://idle.test/' }]);
  const s = M.upsertTab(M.defaultState(), { id: 4, windowId: 1, url: 'https://gone.test/', discarded: true, title: 'Gone' }, Date.now());
  assert.equal(s.tabs[4].url, 'https://gone.test/');
  assert.ok(s.tabs[4].sleeping);
  const pass = await sleepIdle();
  assert.deepEqual(fake.discards, [5]);
  assert.equal(pass.due, 1, 'the discarded one isn\'t due');
  assert.equal(await wakeAll(), 2);
  assert.deepEqual(fake.reloads.sort(), [4, 5]);
});
