// A new tab from the palette in Chrome (background/tabs.js openBehind): Chrome
// paints nothing for a page loading hidden (platform.hiddenPaints false), so
// the tab comes to the front once loaded, as before, and nothing asks its
// page whether it has painted. Its own file: the browser is told by the
// extension's own address, once, as the modules load.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://a.test/', status: 'complete', active: true }]]);
const scripts = [];
const updates = [];
const local = {};
globalThis.chrome = /** @type {any} */ ({
  runtime: { getURL: (path) => `chrome-extension://test/${path}`, getManifest: () => ({ version: '0' }) },
  permissions: { contains: async () => true },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error('no tab');
      return { ...tabs.get(id) };
    },
    create: async ({ windowId = 1, url }) => {
      const id = Math.max(...tabs.keys()) + 1;
      tabs.set(id, { id, windowId, url, status: 'loading', active: false });
      return { ...tabs.get(id) };
    },
    update: async (id, change) => {
      updates.push({ id, change, at: Date.now() });
      if (change.active) for (const t of tabs.values()) if (t.windowId === tabs.get(id).windowId) t.active = t.id === id;
      return { ...tabs.get(id) };
    },
    query: async ({ active, windowId } = {}) => [...tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map((t) => ({ ...t })),
    sendMessage: async () => true,
  },
  windows: { get: async (id) => ({ id, focused: true }), update: async () => ({}) },
  scripting: {
    // A page that would say it has painted, if asked.
    executeScript: async ({ target, func }) => {
      scripts.push({ tabId: target.tabId, name: func?.name });
      return [{ result: func?.name === 'readyInPage' ? 'painted' : true }];
    },
  },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...local } : Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])]))),
      set: async (items) => { Object.assign(local, structuredClone(items)); },
      remove: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
});
const { openBehind } = await import('../extension/background/tabs.js');

test('openBehind in Chrome: the new tab comes to the front once loaded; its page isn\'t asked whether it has painted', async () => {
  const asked = Date.now();
  const opening = openBehind({ url: 'https://slow.test/', from: { id: 1, windowId: 1 } });
  await sleep(20);
  const [id] = [...tabs.keys()].filter((key) => key !== 1);
  setTimeout(() => { tabs.get(id).status = 'complete'; }, 300);
  const { shown } = await opening;
  assert.equal(shown, id);
  const front = updates.find((u) => u.id === id && u.change.active);
  assert.ok(front && front.at - asked >= 290, `to the front once loaded (${front && front.at - asked}ms)`);
  assert.deepEqual(scripts.filter((s) => s.name === 'readyInPage'), []);
});
