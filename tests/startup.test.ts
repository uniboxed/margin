// A background starting after a Safari relaunch: every tab but the one in
// front unloaded, and Safari's extension calls answered one after another
// (its main thread). The open-tab repair (background/tabs.ts
// injectIntoOpenTabs) asks each unloaded tab once, and gives way to a switch
// asked meanwhile; a switch starts without asking Safari for what Margin
// knows. Through background.ts's own listeners, as answer-in-time.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A listener, called with whatever its event gives.
type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const event = (name: string) => ({ addListener: (fn: Listener) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => (listeners[name] ?? []).map((fn) => fn(...args));

const fake = {
  tabs: new Map(),
  noPage: new Set(), // tabs Safari unloaded: a script there fails
  // Each extension call takes this long of Safari's main thread, one after
  // another (a busy Mac just after a relaunch).
  callMs: 0,
  calls: [] as { what: string, tabId: number | null, name: string | null, at: number }[],
  local: {} as Record<string, any>, // stored JSON
  session: {} as Record<string, any>,
  updates: [] as { id: number, change: object, at: number }[],
};
let turn: Promise<unknown> = Promise.resolve();
const safari = <T>(what: string, tabId: number | null, name: string | null, fn: () => T | Promise<T>): Promise<T> => {
  const call = turn.then(() => (fake.callMs ? sleep(fake.callMs) : null)).then(() => {
    fake.calls.push({ what, tabId, name, at: Date.now() });
    return fn();
  });
  turn = call.catch(() => {});
  return call;
};
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, unknown> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const bringToFront = (id: number) => {
  const tab = fake.tabs.get(id);
  if (!tab || tab.active) return;
  for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
  fire('onActivated', { tabId: id, windowId: tab.windowId });
};
globalThis.chrome = fakeBrowser({
  runtime: {
    id: 'test',
    getURL: (p) => `safari-web-extension://test/${p}`,
    getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'),
    sendMessage: async () => undefined,
    sendNativeMessage: async () => undefined,
  },
  permissions: { contains: () => safari('contains', null, null, () => true), onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => undefined, create: async () => {}, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    // Windows as far as Margin reads them here; its updates' answers unread.
    get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: (id) => safari('get', id, null, () => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; }),
    query: (filter = {}) => safari(Object.keys(filter).length ? 'query' : 'query all', null, null, () => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t }))),
    update: (id, change) => safari('update', id, null, () => {
      fake.updates.push({ id, change, at: Date.now() });
      if (change.active) bringToFront(id);
      return { ...fake.tabs.get(id) };
    }),
    sendMessage: (tabId, message) => (fake.noPage.has(tabId) ? Promise.reject(new Error('no page')) : sleep(2).then(() => (message?.type === 'switching' || message?.type === 'margin-release' ? true : message?.type === 'margin-hold' ? new Promise(() => {}) : undefined))),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }),
    create: async () => { throw new Error('not here'); }, remove: async () => {}, reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: ({ target, func, files, args }) => safari('script', target.tabId, files ? 'files' : func?.name ?? 'anonymous', () => {
      if (fake.noPage.has(target.tabId)) throw new Error('Could not execute script on this tab');
      let result: unknown = true;
      if (func?.name === 'prepareSidebarInPage') result = { ready: true, token: args?.[0]?.token };
      else if (func?.name === 'paintBarrierInPage') result = 'drawn';
      else if (func?.name === 'cutOffInPage') result = { cutOff: false };
      return [{ result }];
    }),
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

// Tab 1 in front and tab 2 loaded; tabs 3–42 unloaded (Safari restores only
// the tab in front of a window at a relaunch).
const UNLOADED = Array.from({ length: 40 }, (_, i) => i + 3);
for (let id = 1; id <= 42; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, status: 'complete', active: id === 1 });
for (const id of UNLOADED) fake.noPage.add(id);
// Busy from the start: the background starts, its first sync matches the
// tabs and starts the repair, and a click on tab 2's row comes at once.
fake.callMs = 15;

const sender = (id: number) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id).url });
const WAIT_MS = 3000;
// The background's answer (Margin's own protocol: any, as types/browser.d.ts has it).
type Reply = { ok: boolean, result?: any, error?: string };
function ask(type: string, payload: Record<string, unknown> = {}, from = 1) {
  const asked = Date.now();
  const deadline = asked + WAIT_MS;
  return new Promise<{ reply: Reply, ms: number }>((resolve) => {
    listeners.onMessage[0]({ type, ...payload, deadline }, sender(from), (reply: Reply) => resolve({ reply, ms: Date.now() - asked }));
  });
}

await import('../extension/background.ts');
const firstSwitch = ask('activateTab', { tabId: 2 });
const store = await import('../extension/background/store.ts');
const { injectIntoOpenTabs, tabShown } = await import('../extension/background/tabs.ts');

const scripts = (id: number, name: string | null = null) => fake.calls.filter((c) => c.what === 'script' && c.tabId === id && (name == null || c.name === name));
async function settledOn(id: number) {
  for (let i = 0; i < 200; i++) {
    if ((await store.load()).tabs[id]?.active) return;
    await sleep(10);
  }
  assert.fail(`tab ${id} never known in front`);
}

test('a click just after the background starts, while the repair of the open tabs runs, is shown at once: the repair gives way (its scripts aren\'t queued ahead of the switch\'s own calls in Safari)', async () => {
  const { reply, ms } = await firstSwitch;
  assert.deepEqual(reply, { ok: true, result: { shown: 2 } });
  assert.ok(ms < 1200, `shown ${ms} ms after the click (the page waits ${WAIT_MS})`);
  const shownAt = fake.updates.find((u) => u.id === 2)?.at ?? Infinity;
  const before = fake.calls.filter((c) => c.at <= shownAt && c.what === 'script' && fake.noPage.has(c.tabId));
  assert.ok(before.length <= 4, `${before.length} of the repair's scripts went to Safari before the show`);
});

test('the repair asks each unloaded tab once (not twice per pass, over four passes), and no pass after the first asks them again', async () => {
  await injectIntoOpenTabs(); // the one under way since the start
  fake.callMs = 0;
  for (const id of UNLOADED) assert.equal(scripts(id).length, 1, `tab ${id}: ${scripts(id).map((c) => c.name).join(', ')}`);
  const contains = fake.calls.filter((c) => c.what === 'contains').length;
  assert.ok(contains <= fake.tabs.size + 2, `site access asked about once per site, not per question (${contains})`);
  // Another repair (Margin updated meanwhile): still nothing for them.
  const before = fake.calls.length;
  await injectIntoOpenTabs({ retry: false });
  assert.deepEqual(fake.calls.slice(before).filter((c) => c.what === 'script'), []);
});

test('a tab found with no page is asked again once a tab event says its page changed, or once it\'s shown', async () => {
  await settledOn(2);
  const tab = { ...fake.tabs.get(3), status: 'loading' };
  await Promise.all(fire('onUpdated', 3, { status: 'loading' }, tab));
  tabShown(4); // its activation (background.ts)
  const before = fake.calls.length;
  await injectIntoOpenTabs({ retry: false });
  const asked = new Set(fake.calls.slice(before).filter((c) => c.what === 'script').map((c) => c.tabId!)); // (a script's call: its tab's)
  assert.deepEqual([...asked].sort((a, b) => a - b), [3, 4]);
});

test('a switch to a tab found with no page doesn\'t ask it whether it\'s cut off from Margin first (it loads with this copy)', async () => {
  bringToFront(1);
  await settledOn(1);
  const before = fake.calls.length;
  const { reply } = await ask('activateTab', { tabId: 9 });
  assert.equal(reply.ok, true);
  assert.deepEqual(fake.calls.slice(before).filter((c) => c.tabId === 9 && c.name === 'cutOffInPage'), []);
  fake.noPage.delete(9);
});

test('a row drawn from ids that aren\'t this copy\'s is found in Margin\'s own tabs once they\'re matched: Safari isn\'t asked for every tab first', async () => {
  bringToFront(1);
  await settledOn(1);
  assert.ok(store.isSynced());
  const before = fake.calls.length;
  const hint = { url: 'https://t2.test/', index: 1, title: 'T2', from: { origin: 'safari-web-extension://other/', since: 1, synced: true } };
  const { reply } = await ask('activateTab', { tabId: 777, hint });
  assert.deepEqual(reply, { ok: true, result: { shown: 2 } });
  assert.deepEqual(fake.calls.slice(before).filter((c) => c.what === 'query all'), [], 'no tabs.query({})');
  const gets = fake.calls.slice(before).filter((c) => c.what === 'get' && c.tabId === 2 && c.at <= (fake.updates.at(-1)?.at ?? Infinity));
  assert.ok(gets.length <= 1, 'the tab not looked up again by the switch (the plain switch only updates it)');
});

test('a switch whose steps are still waiting on Safari once its page was answered doesn\'t hold the repair up before every tab', async () => {
  bringToFront(1);
  await settledOn(1);
  // Safari never answers where tab 2 is (its process hung): the switch is
  // shown as it is at its deadline, its steps still waiting.
  const get = chrome.tabs.get;
  let release = () => {};
  const hung = new Promise<void>((resolve) => { release = resolve; });
  chrome.tabs.get = (id) => (id === 2 ? hung.then(() => get(id)) : get(id));
  try {
    const { reply } = await ask('activateTab', { tabId: 2 });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    // Three tabs with no page have one now (their status changed).
    for (const id of [5, 6, 7]) await Promise.all(fire('onUpdated', id, { status: 'loading' }, { ...fake.tabs.get(id), status: 'loading' }));
    const started = Date.now();
    const repaired = injectIntoOpenTabs({ retry: false }).then(() => Date.now() - started);
    const ms = await Promise.race([repaired, sleep(3000).then(() => Infinity)]);
    assert.ok(ms < 1500, `the repair done ${ms} ms after it started (it waits up to 8 s before each tab while a switch is under way)`);
  } finally {
    chrome.tabs.get = get;
    release();
  }
});

test('a row naming a tab just closed (Safari says it\'s gone, Margin\'s state doesn\'t yet) isn\'t found by its address among Margin\'s own tabs: the page is told it\'s gone, no switch is tried', async () => {
  bringToFront(1);
  await settledOn(1);
  const closed = fake.tabs.get(42);
  fake.tabs.delete(42); // onRemoved not handled yet
  const updates = fake.updates.length;
  try {
    const { reply } = await ask('activateTab', { tabId: 42, hint: { url: closed.url, index: closed.index, title: closed.title } });
    assert.equal(reply.ok, false);
    assert.match(reply.error!, /no longer open/);
    assert.deepEqual(fake.updates.slice(updates).filter((u) => u.id === 42), [], 'no switch to it');
  } finally {
    fake.tabs.set(42, closed);
  }
});

test.after(() => setTimeout(() => process.exit(0), 50));
