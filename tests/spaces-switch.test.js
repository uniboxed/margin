// Showing a space (background/navigation.js showSpace), and the wake's use
// of Margin's own state and its site-access cache (background/tabs.js),
// against a fake browser API (Safari's profile: the wake runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = { tabs: new Map(), nextId: 100, calls: { get: 0, contains: 0, create: [] }, access: true, local: {}, current: new Set(), injected: [], probes: 0, probeHangs: false };
const asTab = (t) => ({ ...t });
globalThis.chrome = {
  runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ content_scripts: [{ js: ['content/shell-main.bundle.js'], world: 'MAIN' }, { js: ['content/content.bundle.js'] }] }) },
  permissions: { contains: async () => { fake.calls.contains++; return fake.access; }, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  tabs: {
    get: async (id) => {
      fake.calls.get++;
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return asTab(tab);
    },
    query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map(asTab),
    update: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return asTab(tab);
    },
    create: async ({ windowId, url, active }) => {
      const tab = { id: fake.nextId++, windowId, url, active: !!active, index: 99, title: '' };
      if (active) for (const t of fake.tabs.values()) if (t.windowId === windowId) t.active = false;
      fake.tabs.set(tab.id, tab);
      fake.calls.create.push(url);
      return asTab(tab);
    },
  },
  windows: { get: async (id) => ({ id, focused: true }), update: async () => ({}) },
  scripting: {
    executeScript: ({ target, func, files }) => {
      if (files) {
        fake.injected.push({ tabId: target.tabId, files });
        fake.current.add(target.tabId);
        return Promise.resolve([]);
      }
      // ensureCurrent's question: is Margin's current copy there?
      if (String(func).includes('Margin?.content')) {
        fake.probes++;
        if (fake.probeHangs) return new Promise(() => {});
        return sleep(2).then(() => [{ result: fake.current.has(target.tabId) }]);
      }
      return sleep(2).then(() => [{ result: true }]);
    },
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in fake.local).map((k) => [k, fake.local[k]])),
      set: async (items) => { Object.assign(fake.local, items); },
    },
  },
};

const M = await import('../extension/state/model.js');
const V = await import('../extension/shared/view.js');
const { mutate, load } = await import('../extension/background/store.js');
const { showSpace } = await import('../extension/background/navigation.js');
const { wakeTab, ensureCurrent, forgetCurrent } = await import('../extension/background/tabs.js');

// Window 1: Personal tabs 1 (in front), 2; Work tabs 3, 4 (4 used last); window 2: Work tab 5.
async function setup() {
  fake.tabs = new Map();
  fake.calls = { get: 0, contains: 0, create: [] };
  const tabs = [
    { id: 1, windowId: 1, url: 'https://p1.com/', active: true, index: 0 },
    { id: 2, windowId: 1, url: 'https://p2.com/', active: false, index: 1 },
    { id: 3, windowId: 1, url: 'https://w3.com/', active: false, index: 2 },
    { id: 4, windowId: 1, url: 'https://w4.com/', active: false, index: 3 },
    { id: 5, windowId: 2, url: 'https://w5.com/', active: true, index: 0 },
  ];
  for (const t of tabs) fake.tabs.set(t.id, { title: '', ...t });
  await mutate(() => {
    let s = M.defaultState();
    s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
    s = M.createSpace(s, { id: 'empty', name: 'Empty', emoji: '🫙', color: '#00b894' });
    for (const t of tabs) s = M.upsertTab(s, t, 0);
    s = M.moveTab(M.moveTab(M.moveTab(s, 3, 'work'), 4, 'work'), 5, 'work');
    s = { ...s, tabs: { ...s.tabs, 3: { ...s.tabs[3], lastActive: 10 }, 4: { ...s.tabs[4], lastActive: 20 }, 5: { ...s.tabs[5], lastActive: 99 } } };
    return s;
  });
}
const front = (windowId = 1) => [...fake.tabs.values()].find((t) => t.windowId === windowId && t.active)?.id;

test('showSpace: the space\'s most recent tab in that window comes to the front', async () => {
  await setup();
  await showSpace(1, 'work');
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
  assert.equal(front(1), 4, 'tab 4, used last in window 1 (not tab 5 of window 2)');
  assert.equal(front(2), 5, 'the other window untouched');
});

test('showSpace: a tab of the space already in front stays; bringTab: false changes only the sidebar', async () => {
  await setup();
  await showSpace(1, 'personal');
  assert.equal(front(1), 1);
  await showSpace(1, 'work', { bringTab: false });
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
  assert.equal(front(1), 1, 'the page in front stayed');
});

test('showSpace: a tab closed meanwhile: the next most recent one', async () => {
  await setup();
  fake.tabs.delete(4); // Margin's state still lists it
  await showSpace(1, 'work');
  assert.equal(front(1), 3);
});

test('showSpace: an empty space opens the start page in it; an untouched start page in front moves instead', async () => {
  await setup();
  await showSpace(1, 'empty');
  assert.deepEqual(fake.calls.create, ['safari-web-extension://test/newtab/newtab.html#launcher']);
  const opened = front(1);
  assert.equal((await load()).tabSpace[opened], 'empty');
  await mutate((s) => M.upsertTab(s, fake.tabs.get(opened), 0));
  await mutate((s) => M.createSpace(s, { id: 'empty2', name: 'Empty 2', emoji: '📭', color: '#636e72' }));
  await showSpace(1, 'empty2');
  assert.equal(fake.calls.create.length, 1, 'no second start page');
  assert.equal((await load()).tabSpace[opened], 'empty2', 'the untouched one moved');
});

test('wake: uses Margin\'s own state (no lookups before waking), but not a stale "shown" flag; "no access" isn\'t remembered', async () => {
  await setup();
  // Sites no earlier test woke (the access cache lives for the whole run).
  const add = async (id, url) => {
    fake.tabs.set(id, { id, windowId: 1, url, active: false, index: id, title: '' });
    await mutate((st) => M.upsertTab(st, fake.tabs.get(id), 0));
  };
  await add(6, 'https://six.test/');
  await add(7, 'https://seven.test/');
  fake.calls.get = 0;
  fake.calls.contains = 0;
  assert.equal((await wakeTab(6)).outcome, 'awake');
  assert.equal(fake.calls.get, 0, 'no tabs.get: the state knows the tab');
  assert.equal(fake.calls.contains, 1);
  await sleep(650);
  await wakeTab(6);
  assert.equal(fake.calls.contains, 1, 'access remembered for the site');
  // Margin thinks 6 is in front; the browser says otherwise: it's woken.
  await mutate((st) => ({ ...st, tabs: { ...st.tabs, 6: { ...st.tabs[6], active: true } } }));
  await sleep(650);
  assert.equal((await wakeTab(6)).outcome, 'awake');
  fake.access = false;
  assert.equal((await wakeTab(7)).outcome, 'no access');
  fake.access = true;
  await sleep(650);
  assert.equal((await wakeTab(7)).outcome, 'awake', 'granted later: seen at once');
});

test('pins: only a tab of the pin\'s own space is the pin\'s (no jump to another space)', async () => {
  await setup();
  let s = await load();
  s = M.addPin(s, { id: 'p', spaceId: 'work', url: 'https://p1.com/', title: 'p1' });
  assert.equal(V.pinTabId(s, 'p', 1), null, 'p1.com is open only in Personal');
  assert.equal(M.recentTabOfSpace(s, 1, 'work')?.id, 4);
  assert.equal(M.recentTabOfSpace(s, 1, 'work', 4)?.id, 3);
  assert.equal(M.recentTabOfSpace(s, 1, 'empty'), null);
});

test('ensureCurrent: a tab without the current copy gets it once; one that has it, nothing; once per run, again after it closes', async () => {
  await setup();
  fake.current = new Set([1]);
  fake.injected = [];
  fake.probes = 0;
  await ensureCurrent(1);
  assert.deepEqual(fake.injected, [], 'it has the current copy');
  await Promise.all([ensureCurrent(2), ensureCurrent(2)]); // two activations at once
  assert.deepEqual(fake.injected, [{ tabId: 2, files: ['content/content.bundle.js'] }], 'the sidebar\'s scripts (not the page-world one), once');
  const probes = fake.probes;
  await ensureCurrent(2);
  await ensureCurrent(1);
  assert.equal(fake.probes, probes, 'checked once per run');
  forgetCurrent(2); // closed
  fake.current.delete(2);
  await ensureCurrent(2);
  assert.equal(fake.injected.length, 2, 'checked again');
});

test('ensureCurrent: a page that doesn\'t answer (busy, asleep) isn\'t injected, and is checked again next time', async () => {
  await setup();
  fake.current = new Set();
  fake.injected = [];
  fake.probeHangs = true;
  await ensureCurrent(3);
  assert.deepEqual(fake.injected, []);
  fake.probeHangs = false;
  await ensureCurrent(3);
  assert.equal(fake.injected.length, 1, 'next time it answered: injected');
});
