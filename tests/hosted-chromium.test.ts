// Chrome and Edge hosted like Safari (docs/HOSTED-WINDOWS-CHROMIUM.md §3.2), against the real background with a fake of
// Chrome's API (its extension address makes shared/capabilities.ts pick Chromium's): the windows Margin.app hosts are
// known to the copy (made for it with `newWindow { hosted }` or `{ mark }`, or an item shown there), Chrome's own
// "Margin full screen" leaves them alone (the app puts them in full screen itself), they count as in full screen for
// "only in full screen", and a marked window opens at Margin's new-tab page with the mark, which hostShow replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners: Record<string, ((...args: any[]) => unknown)[]> = {};
const event = (name: string) => ({ addListener: (fn: (...args: any[]) => unknown) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, any> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const ORIGIN = 'chrome-extension://test/';

const fake = {
  tabs: new Map<number, BrowserTab>(), windows: new Map<number, BrowserWindow>(), local: {} as Record<string, any>, session: {} as Record<string, any>,
  windowUpdates: [] as ({ id: number } & Record<string, unknown>)[], createdWith: [] as any[], removedTabs: [] as number[],
};
const win = (id: number, extra: Partial<BrowserWindow> = {}): BrowserWindow => ({ id, state: 'normal', focused: false, left: 0, top: 0, width: 1280, height: 800, type: 'normal', ...extra });
globalThis.fetch = (async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
globalThis.chrome = fakeBrowser({
  runtime: {
    id: 'test', getURL: (p) => `${ORIGIN}${p}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'), sendMessage: async () => undefined, sendNativeMessage: async () => undefined,
  },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}), create: async () => {}, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    get: async (id) => { const w = fake.windows.get(id); if (!w) throw new Error(`No window with id: ${id}`); return { ...w }; },
    getAll: async () => [...fake.windows.values()].map((w) => ({ ...w })),
    getLastFocused: async () => ({ ...[...fake.windows.values()].find((w) => w.focused) ?? fake.windows.get(1) }),
    update: async (id, props) => {
      const w = fake.windows.get(id);
      if (!w) throw new Error(`No window with id: ${id}`);
      fake.windowUpdates.push({ id, ...props });
      if (props.state) w.state = props.state;
      return { ...w };
    },
    create: async (props) => {
      const id = 100 + fake.windows.size;
      fake.createdWith.push(props);
      const w = win(id, { state: props.state ?? 'normal', focused: props.focused !== false });
      fake.windows.set(id, w);
      const tab = { id: id * 10, windowId: id, url: (props.url ?? `${ORIGIN}newtab/newtab.html`) as string, title: '', index: 0, active: true, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      return { ...w, tabs: [{ ...tab }] };
    },
    remove: async (id) => { fake.windows.delete(id); },
    onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'), onCreated: event('wCreated'),
  },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id, props) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      if (props.url) tab.url = props.url;
      if (props.active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return { ...tab };
    },
    create: async ({ windowId, url, active }) => {
      const tab = { id: 900 + fake.tabs.size, windowId: windowId ?? 1, url, title: '', index: 9, active: !!active, status: 'loading' };
      if (active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = false;
      fake.tabs.set(tab.id, tab);
      return { ...tab };
    },
    remove: async (id) => { fake.removedTabs.push(id as number); fake.tabs.delete(id as number); },
    sendMessage: async () => undefined,
    discard: async (id) => ({ ...fake.tabs.get(id) }),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'), onReplaced: event('onReplaced'),
  },
  scripting: {
    // (No page in full screen anywhere: a window's full screen is the window's own.)
    executeScript: async () => [{ frameId: 0, result: false }],
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
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
      remove: async (keys) => { for (const k of ([] as string[]).concat(keys)) delete fake.session[k]; },
    },
    onChanged: event('sChanged'),
  },
});

// Window 1: the person's own window. Its tab: a web page.
fake.windows.set(1, win(1, { focused: true }));
fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
const { capabilities } = await import('../extension/shared/capabilities.ts');
const { handlers, hostedTabs } = await import('../extension/background/handlers.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
assert.equal(capabilities.name, 'chrome', 'Chromium\'s build');
const app = { app: true } as BrowserMessageSender;

test('newWindow from the app with hosted: the window is the app\'s from its making; from anything else, or without hosted, as before', async () => {
  const made = await handlers.newWindow({ fullscreen: false, hosted: true }, app);
  assert.ok(made?.windowId != null);
  assert.equal(hostedTabs.isHosted(made.windowId), true);
  const plain = await handlers.newWindow({ fullscreen: false }, app);
  assert.equal(hostedTabs.isHosted(plain!.windowId), false, 'the app\'s ⌘N window (the old Windows shell) stays the person\'s');
  const page = await handlers.newWindow({ fullscreen: false, hosted: true });
  assert.equal(hostedTabs.isHosted(page!.windowId), false, 'only the app says hosted');
});

test('newWindow with a mark: opened at Margin\'s new-tab page with the mark; a bad mark, or one not from the app, opens it as before', async () => {
  fake.createdWith.length = 0;
  const marked = await handlers.newWindow({ fullscreen: false, mark: 'm1A2b3C4d5' }, app);
  assert.equal(fake.createdWith[0].url, `${ORIGIN}newtab/newtab.html?mark=m1A2b3C4d5`);
  assert.equal(hostedTabs.isHosted(marked!.windowId), true, 'a marked window is one the app will host');
  for (const [mark, sender] of [['short', app], ['has spaces in it', app], ['a/b?c=d#e1234', app], ['m1A2b3C4d5', undefined]] as const) {
    fake.createdWith.length = 0;
    await handlers.newWindow({ fullscreen: false, mark }, sender);
    assert.equal(fake.createdWith[0].url, undefined, `${mark}: no address (the browser's new window)`);
  }
  fake.createdWith.length = 0;
  await handlers.newWindow({ fullscreen: false, mark: 'm1A2b3C4d5', url: 'https://card.test/' }, app);
  assert.equal(fake.createdWith[0].url, 'https://card.test/', 'a page\'s address wins over the mark');
});

test('hostShow into a marked window: its lone marked new-tab page replaced by the item\'s tab', async () => {
  const marked = await handlers.newWindow({ fullscreen: false, mark: 'q9W8e7R6t5' }, app);
  const winId = marked!.windowId;
  const [first] = [...fake.tabs.values()].filter((t) => t.windowId === winId);
  assert.match(first.url ?? '', /newtab\.html\?mark=q9W8e7R6t5$/);
  fake.removedTabs.length = 0;
  const shown = await handlers.hostShow({ windowId: winId, itemId: 't-item1', url: 'https://item.test/' }, app);
  assert.equal(shown.created, true);
  assert.deepEqual(fake.removedTabs, [first.id], 'the marked page closed after the item\'s tab was made');
  assert.deepEqual([...fake.tabs.values()].filter((t) => t.windowId === winId).map((t) => t.url), ['https://item.test/']);
});

test('Chrome\'s own "Margin full screen" leaves a hosted window alone, and still follows the person\'s own full screen elsewhere', async () => {
  const hosted = await handlers.newWindow({ fullscreen: false, hosted: true }, app);
  const id = hosted!.windowId;
  fake.windowUpdates.length = 0;
  // The app puts it in full screen (setWindowState), and the bounds change is heard.
  await handlers.setWindowState({ windowId: id, state: 'fullscreen', land: false });
  fake.windowUpdates.length = 0;
  await fire('wBounds', { ...fake.windows.get(id) });
  await sleep(30);
  assert.deepEqual(fake.windowUpdates, [], 'no exit and entry of its own in a window the app hosts');

  // The person's own window going full screen (F11): Margin full screen, as before (out, then in again).
  fake.windows.get(1)!.state = 'fullscreen';
  await fire('wBounds', { ...fake.windows.get(1) });
  for (let i = 0; i < 50 && fake.windowUpdates.length < 2; i++) await sleep(10);
  const updates: ({ id: number } & Record<string, unknown>)[] = fake.windowUpdates; // (not narrowed by the deepEqual above)
  assert.deepEqual(updates.map((u) => [u.id, u.state]), [[1, 'normal'], [1, 'fullscreen']]);
});

test('"only in full screen": a hosted window counts as full screen whatever its state; the person\'s normal window doesn\'t', async () => {
  const hosted = await handlers.newWindow({ fullscreen: false, hosted: true }, app);
  const id = hosted!.windowId;
  assert.equal(fake.windows.get(id)!.state, 'normal');
  assert.deepEqual(await handlers.windowState({}, { tab: { id: 1, windowId: id } } as BrowserMessageSender), { fullscreen: true });
  fake.windows.set(7, win(7));
  assert.deepEqual(await handlers.windowState({}, { tab: { id: 1, windowId: 7 } } as BrowserMessageSender), { fullscreen: false });
  // Closed: not the app's any more.
  hostedTabs.windowRemoved(id);
  assert.equal(hostedTabs.isHosted(id), false);
});
