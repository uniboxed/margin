// A new tab from the palette in Safari (background/tabs.ts openBehind): it
// opens behind the page the user is on, which is told at once ('switching',
// `cover: 'now'`), and comes to the front once loaded, or at its limit
// ('switch-done'); the user going elsewhere, the tab closed, or the page
// they're on going somewhere else leaves it behind ('switch-failed'). The
// overlay of the window hears the same words (tabs.ts tellApp). Against a
// fake of Safari's API (Chrome's: tests/open-behind-chrome.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// tabs: id → { id, url, active, windowId, status }. New tabs get ids never
// used before in this file (a tab Margin brought to the front counts as
// Margin's for a moment: tabs.ts activatedByMargin; a later test's tab with
// the same id would inherit that).
let nextId = 100;
const fake = {
  tabs: new Map(),
  created: [] as any[],
  updates: [] as any[],
  asked: [] as number[], // every tabs.update asked for, carried out or not
  messages: [] as any[], // to a page's content script: { tabId, message }
  broadcasts: [] as any[], // runtime.sendMessage (Margin's own pages)
  noContentScript: new Set<number>(), // pages that can't be sent to (Margin's own)
  failUpdate: new Set<number>(), // tabs.update refused (Safari: no tab)
  local: {},
};
const pick = (store, keys) => (keys == null ? structuredClone(store) : Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])));
globalThis.chrome = ({
  runtime: {
    getURL: (path) => `safari-web-extension://test/${path}`,
    getManifest: () => ({ version: '0' }),
    sendMessage: async (message) => { fake.broadcasts.push(message); },
  },
  permissions: { contains: async () => true },
  windows: { get: async (id) => ({ id, focused: true }), update: async () => ({}) },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    },
    // A new tab, still loading (a test says when it has loaded).
    create: async ({ windowId = 1, url, active = true }) => {
      const id = nextId++;
      fake.created.push({ id, url, active });
      fake.tabs.set(id, { id, windowId, url, status: 'loading', active: false });
      if (active) for (const t of fake.tabs.values()) if (t.windowId === windowId) t.active = t.id === id;
      return { ...fake.tabs.get(id) };
    },
    update: async (id, change) => {
      fake.asked.push(id);
      const tab = fake.tabs.get(id);
      if (!tab || fake.failUpdate.has(id)) throw new Error(`No tab with id: ${id}`);
      fake.updates.push({ id, change, at: Date.now() });
      if (change.active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return { ...tab };
    },
    query: async ({ active, windowId } = {} as any) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map((t) => ({ ...t })),
    sendMessage: async (tabId, message) => {
      if (fake.noContentScript.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
      fake.messages.push({ tabId, message });
      return true;
    },
  },
  scripting: { executeScript: async () => [{ result: true }] },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
      remove: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
} as any);

const { focusTab, openBehind, userSwitched } = await import('../../../../background/tabs.ts');
const { decided, load } = await import('../../../../background/store.ts');
// Margin.app's overlay, linked: what's pushed to it.
const { appLink } = await import('../../../../background/app-link.ts');
const pushed: any[] = [];
appLink.linked = () => true;
appLink.push = (windowId, msg) => { pushed.push({ windowId, msg }); return true; };
await decided();

function reset(tabs) {
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, ...t }]));
  fake.created = [];
  fake.updates = [];
  fake.asked = [];
  fake.messages = [];
  fake.broadcasts = [];
  fake.noContentScript = new Set();
  fake.failUpdate = new Set();
  pushed.length = 0;
}
const told = (type) => fake.messages.filter((m) => m.message?.type === type);
const front = (windowId = 1) => [...fake.tabs.values()].find((t) => t.active && t.windowId === windowId)?.id;
const newTab = () => fake.created.at(-1)?.id;
const from = { id: 1, windowId: 1 };

test('openBehind: the tab opens behind the page, which is told at once (covered), the overlay too; it comes to the front once loaded', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  assert.deepEqual(fake.created, [{ id, url: 'https://slow.test/', active: false }], 'opened behind');
  assert.equal(front(), 1, 'the page stays in front while it loads');
  assert.deepEqual(told('switching').map((m) => [m.tabId, m.message.tabId, m.message.from, m.message.windowId, m.message.cover]), [[1, id, 1, 1, 'now']]);
  assert.deepEqual(pushed, [{ windowId: 1, msg: { type: 'switching', tabId: id } }], 'the overlay told at once');
  assert.deepEqual(told('switch-done'), []);
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: id });
  assert.equal(front(), id);
  assert.deepEqual(told('switch-done').map((m) => [m.tabId, m.message.tabId]), [[1, id]]);
  assert.equal(told('switch-failed').length, 0);
  assert.deepEqual(pushed.map((p) => p.msg.type), ['switching', 'switch-done']);
});

test('openBehind: the user going elsewhere meanwhile leaves it behind, loaded; the page stops waiting, no reason given', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  userSwitched(3, 1); // Safari's tab bar, say (background.ts onActivated)
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: null });
  assert.equal(fake.updates.some((u) => u.id === id), false, 'not brought to the front');
  assert.equal(told('switch-failed').length, 1, 'the page stops waiting');
  assert.equal(told('switch-failed')[0].message.reason, undefined, 'no notice: nothing went wrong');
  assert.equal(told('switch-done').length, 0);
});

test('openBehind: closed while it loads: nothing comes to the front, the page stops waiting', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  fake.tabs.delete(id);
  assert.deepEqual(await shown, { tabId: id, shown: null });
  assert.equal(front(), 1);
  assert.deepEqual(fake.asked, [], 'not asked to come forward');
  assert.equal(told('switch-failed').length, 1);
  assert.equal(told('switch-failed')[0].message.reason, undefined, 'no notice');
  assert.deepEqual(pushed.map((p) => p.msg.type), ['switching', 'switch-failed']);
});

test('openBehind: a page that never finishes loading still comes up at the limit, as far as it got, covered once', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const started = Date.now();
  const result = await openBehind({ url: 'https://endless.test/', from, maxMs: 400 });
  const id = newTab();
  assert.deepEqual(result, { tabId: id, shown: id });
  const shownAt = fake.updates.find((u) => u.id === id && u.change.active).at - started;
  assert.ok(shownAt >= 390 && shownAt < 900, `shown at the limit (${shownAt} ms)`);
  assert.equal(front(), id);
  assert.equal(fake.tabs.get(id).status, 'loading', 'still loading as it was shown');
  assert.equal(told('switching').length, 1, 'covered once');
  assert.equal(told('switch-done').length, 1);
});

test('openBehind: a search starting from a blank page waits for the search, not the blank page', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ from, then: async (tab) => {
    Object.assign(fake.tabs.get(tab.id), { url: 'about:blank', status: 'complete' });
    setTimeout(() => Object.assign(fake.tabs.get(tab.id), { url: 'https://search.test/?q=x', status: 'loading' }), 250);
  } });
  await sleep(10);
  const id = newTab();
  assert.equal(fake.created[0].url, 'about:blank', 'made blank, the search sent after');
  await sleep(350);
  assert.equal(front(), 1, 'not for the blank page');
  const started = Date.now();
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: id });
  assert.ok(Date.now() - started < 400, 'once the search loaded, not at the limit');
});

test('openBehind: what loads it failing (`then`): it stays behind, the page told why', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const result = await openBehind({ from, then: async () => { throw new Error('no search engine'); } });
  assert.deepEqual(result, { tabId: newTab(), shown: null });
  assert.equal(front(), 1);
  assert.deepEqual(told('switch-failed').map((m) => m.message.reason), ['no search engine']);
  assert.deepEqual(pushed.at(-1).msg, { type: 'switch-failed', tabId: newTab(), reason: 'no search engine' }, 'the overlay told why too');
});

test('openBehind: a switch in another window doesn\'t call it off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 5, url: 'https://e.test/', windowId: 9, active: true }, { id: 6, url: 'https://f.test/', windowId: 9 }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  userSwitched(6, 9);
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: id });
  assert.equal(told('switch-failed').length, 0);
});

test('openBehind: the page the user is on going somewhere else meanwhile calls it off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  fake.tabs.get(1).status = 'loading'; // a link, the address bar, ⌘R
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: null });
  assert.equal(front(), 1);
  assert.deepEqual(fake.asked, []);
  assert.equal(told('switch-failed').length, 1);
});

test('openBehind: the page the user is on still loading itself when it asks doesn\'t call it off', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true, status: 'loading' }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(250);
  const id = newTab();
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: id });
});

test('openBehind: its own row clicked meanwhile: that switch brings it, the page isn\'t told it failed', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  const clicked = focusTab(id, { source: 'activateTab' });
  assert.deepEqual(await shown, { tabId: id, shown: null });
  await clicked;
  assert.equal(front(), id);
  assert.equal(told('switch-failed').length, 0, 'that switch ends the page\'s wait');
  assert.equal(told('switch-done').length, 0);
});

test('openBehind: something else chosen while the tab was being made: it stays behind, never covered', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }, { id: 3, url: 'https://c.test/' }]);
  const result = await openBehind({ url: 'https://slow.test/', from, created: () => userSwitched(3, 1) });
  assert.deepEqual(result, { tabId: newTab(), shown: null });
  assert.equal(told('switching').length, 0, 'the page wasn\'t covered');
  assert.equal(told('switch-failed').length, 1);
  assert.equal(fake.updates.length, 0);
});

test('openBehind: within the page\'s deadline (the wait shortened to leave time to bring it forward)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const started = Date.now();
  const result = await openBehind({ url: 'https://endless.test/', from, deadline: started + 2000 });
  assert.deepEqual(result, { tabId: newTab(), shown: newTab() });
  const took = Date.now() - started;
  assert.ok(took >= 450 && took < 1200, `waited until the deadline less the time to bring it forward, not the 1.5 s limit (${took} ms)`);
});

test('openBehind: too close to the page\'s deadline: no tab opened', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  await assert.rejects(openBehind({ url: 'https://late.test/', from, deadline: Date.now() + 500 }), /Too late/);
  assert.deepEqual(fake.created, []);
});

test('openBehind: without site access (no address from Safari) it counts as loaded once seen loading, then complete', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://private.test/', from });
  await sleep(150);
  const id = newTab();
  Object.assign(fake.tabs.get(id), { url: undefined, status: 'complete' });
  const started = Date.now();
  assert.deepEqual(await shown, { tabId: id, shown: id });
  assert.ok(Date.now() - started < 600, 'not the full limit');
});

test('openBehind: told the tab at once (created), its row titled meanwhile (label)', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  let createdId = null;
  const shown = openBehind({ url: 'https://slow.test/', from, created: (tab) => { createdId = tab.id; }, label: 'two words' });
  await sleep(150);
  const id = newTab();
  assert.equal(createdId, id);
  assert.equal((await load()).tabs[id]?.title, 'two words');
  fake.tabs.get(id).status = 'complete';
  await shown;
});

test('openBehind: Safari refusing to bring it forward: the page told why', async () => {
  reset([{ id: 1, url: 'https://a.test/', active: true }]);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  fake.failUpdate.add(id);
  fake.tabs.get(id).status = 'complete';
  assert.deepEqual(await shown, { tabId: id, shown: null });
  assert.equal(front(), 1);
  assert.deepEqual(told('switch-failed').map((m) => m.message.reason), [`No tab with id: ${id}`]);
});

test('openBehind: asked from one of Margin\'s own pages (no content script): told by a broadcast that names it', async () => {
  reset([{ id: 1, url: 'safari-web-extension://test/newtab/newtab.html', active: true }]);
  fake.noContentScript.add(1);
  const shown = openBehind({ url: 'https://slow.test/', from });
  await sleep(150);
  const id = newTab();
  fake.tabs.get(id).status = 'complete';
  await shown;
  assert.deepEqual(fake.broadcasts.map((m) => [m.type, m.tabId, m.from]), [['switching', id, 1], ['switch-done', id, 1]]);
});
