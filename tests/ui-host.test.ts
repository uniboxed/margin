// The host adapters (extension/ui/host.ts): the in-page host against a fake
// browser API (storage.local, storage.onChanged, runtime.sendMessage), read
// as content/core.ts reads today; and the mock host the browser tests use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInPageHost, createMockHost } from '../extension/ui/host.ts';
import { toStorage, faviconsMark, firstReadKeys } from '../extension/shared/stored.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { smallState, W, OTHER_WINDOW } from './ui/fixtures.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

// storage.local as the background writes it (shared/stored.ts toStorage).
function stored(state = smallState()) {
  const keys = ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'];
  return toStorage(state, keys, { origin: 'safari-web-extension://margin', since: 1, synced: true });
}

function fakeBrowser(local = stored()) {
  const listeners = new Set();
  const fake = {
    local,
    gets: [],
    messages: [],
    reply: (message) => ({ ok: true, result: { echoed: message.type } }),
    storage: {
      local: {
        get: async (keys) => {
          fake.gets.push(keys);
          if (keys == null) return structuredClone(fake.local);
          return Object.fromEntries(keys.filter((k) => k in fake.local).map((k) => [k, structuredClone(fake.local[k])]));
        },
      },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
    runtime: {
      id: 'margin',
      sendMessage: async (message) => { fake.messages.push(message); return fake.reply(message); },
    },
    listeners,
    // A write by the background: storage changes, then the event.
    write(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) { changes[key] = { oldValue: fake.local[key], newValue: value }; fake.local[key] = value; }
      for (const fn of [...listeners]) fn(structuredClone(changes), 'local');
    },
  };
  return fake;
}

function fakeWindow({ href = 'https://docs.example/x', hidden = false } = {}) {
  const docListeners = new Set();
  const win = {
    calls: [],
    location: { href, reload: () => win.calls.push('reload') },
    history: { back: () => win.calls.push('back'), forward: () => win.calls.push('forward') },
    document: {
      visibilityState: hidden ? 'hidden' : 'visible',
      addEventListener: (type, fn) => type === 'visibilitychange' && docListeners.add(fn),
      removeEventListener: (type, fn) => docListeners.delete(fn),
    },
    setHidden(on) { win.document.visibilityState = on ? 'hidden' : 'visible'; for (const fn of [...docListeners]) fn(); },
    docListeners,
  };
  return win;
}

test('in-page host: the first read is what pages read first (shared/stored.ts firstReadKeys), as pages read it; then state for the view model', async () => {
  const api = fakeBrowser();
  const host = createInPageHost({ api, window: fakeWindow(), warn: () => {} });
  const seen = [];
  host.onState((s) => seen.push(s));
  assert.equal(host.getState(), null);
  assert.equal(await host.ready, true);
  assert.deepEqual(api.gets, [firstReadKeys()], 'the page\'s keys and the icons the first time');
  const state = host.getState();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], state);
  assert.deepEqual(Object.keys(state.tabs).map(Number).sort(), [11, 12, 13, 14, 15, 16, 21]);
  assert.deepEqual(state.openTabsBy, { origin: 'safari-web-extension://margin', since: 1, synced: true });
  // Its window: a guess from the page's address until it's told (hello).
  assert.equal(host.windowId, W);
  const vm = buildViewModel({ state, ui: { windowId: host.windowId } });
  assert.deepEqual(vm.space.today.map((t) => t.id), [15, 14, 12, 16]);
  host.destroy();
});

test('in-page host: changes come from the events themselves; the icons\' mark alone draws nothing', async () => {
  const api = fakeBrowser();
  const host = createInPageHost({ api, window: fakeWindow(), warn: () => {} });
  await host.ready;
  const seen = [];
  host.onState((s) => seen.push(s));
  const s = smallState();
  api.write({ openTabs: { ...api.local.openTabs, tabs: { ...s.tabs, 14: { ...s.tabs[14], title: 'Changed' } } } });
  assert.equal(seen.length, 1, 'drawn at once from the event');
  assert.equal(api.gets.length, 1, 'no read');
  assert.equal(host.getState().tabs[14].title, 'Changed');
  api.write({ settings: { ...s.settings, sidebarPinnedOpen: true } });
  assert.equal(seen.length, 2);
  assert.equal(host.getState().settings.sidebarPinnedOpen, true);
  // The icons, then their mark (the background's two writes): the icons draw, the mark doesn't.
  const favicons = { ...s.favicons, 'https://nofav.example': s.favicons['https://news.example'] };
  api.write({ favicons });
  assert.equal(seen.length, 3);
  api.write({ faviconsMark: faviconsMark(favicons) });
  assert.equal(seen.length, 3, 'only the mark: nothing to draw');
  // The background's note of a tab being shown: that page's own business.
  api.write({ showing: { tabId: 13 } });
  assert.equal(seen.length, 3);
  // An event it can't take (a removal: storage cleared) → it reads.
  for (const fn of api.listeners) fn({ pins: { oldValue: [] } }, 'local');
  await tick(); await tick();
  assert.equal(api.gets.length, 2);
  assert.ok(Array.isArray(api.gets[1]), 'a read of the page\'s keys, not all of storage');
  assert.equal(seen.length, 4);
  // Not storage.local: ignored.
  for (const fn of api.listeners) fn({ spaces: { newValue: [] } }, 'session');
  assert.equal(seen.length, 4);
  host.destroy();
  assert.equal(api.listeners.size, 0, 'destroy stops listening');
  api.write({ settings: s.settings });
  assert.equal(seen.length, 4);
});

test('in-page host: hidden, it keeps the state without drawing; shown, it draws and reads again', async () => {
  const api = fakeBrowser();
  const win = fakeWindow();
  const host = createInPageHost({ api, window: win, warn: () => {} });
  await host.ready;
  const seen = [];
  host.onState((s) => seen.push(s));
  win.setHidden(true);
  const s = smallState();
  api.write({ spaces: [...s.spaces, { id: 'new', name: 'New', emoji: '', color: '#000' }] });
  assert.equal(seen.length, 0, 'not drawn while hidden');
  assert.equal(host.getState().spaces.length, 4, 'but kept');
  win.setHidden(false);
  assert.equal(seen.length, 1, 'drawn as it\'s shown');
  await tick(); await tick();
  assert.equal(api.gets.length, 2, 'and read again (a hidden page can miss events)');
  assert.equal(seen.length, 2);
  host.destroy();
  assert.equal(win.docListeners.size, 0);
});

test('in-page host: a read overtaken by an event is dropped; no state yet waits for the background', async () => {
  const empty = fakeBrowser({});
  const host = createInPageHost({ api: empty, window: fakeWindow(), warn: () => {} });
  assert.equal(await host.ready, false, 'nothing stored yet');
  assert.equal(host.getState(), null);
  assert.equal(host.windowId, null);
  // The background writes its first state: the event makes it read.
  const seen = [];
  host.onState((s) => seen.push(s));
  empty.write(stored());
  await tick(); await tick();
  assert.equal(seen.length, 1);
  assert.equal(host.getState().spaces.length, 3);
  host.destroy();

  // A slow read and an event during it: the event can't be taken (the read
  // may bring older or newer), so it reads again, and the first read's
  // answer is dropped.
  const api = fakeBrowser();
  const host2 = createInPageHost({ api, window: fakeWindow(), warn: () => {} });
  await host2.ready;
  const releases = [];
  const get = api.storage.local.get;
  api.storage.local.get = (keys) => new Promise((r) => { releases.push(() => r(get(keys))); });
  const reading = host2.refresh();
  const s = smallState();
  api.write({ settings: { ...s.settings, sidebarPinnedOpen: true } });
  assert.equal(releases.length, 2, 'read again');
  for (const release of releases) release();
  assert.equal(await reading, false, 'the first read is older than the second');
  await tick(); await tick();
  assert.equal(host2.getState().settings.sidebarPinnedOpen, true);
  host2.destroy();
});

test('in-page host: requests go by runtime.sendMessage; a tab named carries its address; failures resolve to nothing', async () => {
  const api = fakeBrowser();
  const warned = [];
  const host = createInPageHost({ api, window: fakeWindow(), tabId: 13, warn: (...a) => warned.push(a), timeoutMs: 30 });
  await host.ready;
  assert.deepEqual(await host.send('setSpace', { windowId: W, spaceId: 'work' }), { echoed: 'setSpace' });
  assert.deepEqual(api.messages.at(-1), { type: 'setSpace', windowId: W, spaceId: 'work' });
  await host.send('activateTab', { tabId: 14 });
  assert.deepEqual(api.messages.at(-1), { type: 'activateTab', tabId: 14, hint: { url: 'https://nofav.example/page', index: 3, title: 'No icon here', from: { origin: 'safari-web-extension://margin', since: 1, synced: true } } }, 'as content/core.ts sends it');
  await host.send('closeTab', { tabId: 13 });
  assert.deepEqual(api.messages.at(-1), { type: 'closeTab', tabId: 13 }, 'its own tab: no hint');
  // An error answer, no answer, a throw: undefined, and said.
  api.reply = () => ({ ok: false, error: 'That tab is no longer open' });
  assert.equal(await host.send('activateTab', { tabId: 14 }), undefined);
  api.reply = () => new Promise(() => {});
  assert.equal(await host.send('openPin', { pinId: 'pa' }), undefined);
  api.reply = () => { throw new Error('Extension context invalidated'); };
  assert.equal(await host.send('openPin', { pinId: 'pa' }), undefined);
  assert.equal(warned.length, 3);
  // A copy that doesn't own the state: this host stays quiet from then on.
  api.reply = () => ({ stale: true });
  assert.equal(await host.send('newTab', {}), undefined);
  assert.equal(host.dormant, true);
  const before = api.messages.length;
  assert.equal(await host.send('newTab', {}), undefined);
  assert.equal(api.messages.length, before, 'nothing sent');
  host.destroy();
  // Margin reloaded under the page (no runtime id): nothing sent.
  const gone = fakeBrowser();
  gone.runtime.id = undefined;
  const h = createInPageHost({ api: gone, window: fakeWindow(), warn: () => {} });
  assert.equal(await h.send('newTab', {}), undefined);
  assert.equal(gone.messages.length, 0);
  h.destroy();
});

test('in-page host: its window and tab, layout reports, the page\'s history', async () => {
  const api = fakeBrowser();
  const win = fakeWindow({ href: 'https://elsewhere.example/' });
  const layouts = [];
  const host = createInPageHost({ api, window: win, onLayout: (g) => layouts.push(g), platform: { browser: 'chrome', os: 'linux' }, warn: () => {} });
  await host.ready;
  assert.equal(host.windowId, OTHER_WINDOW, 'guessed from the address (shared/view.ts guessWindow)');
  assert.equal(host.tabId, null);
  let drawn = 0;
  host.onState(() => drawn++);
  host.identify({ tabId: 14 });
  assert.equal(host.windowId, W, 'its tab\'s record says');
  assert.equal(drawn, 1, 'drawn again for its tab');
  host.identify({ windowId: 99 });
  assert.equal(host.windowId, 99);
  assert.equal(host.tabId, 14);
  const g = { insets: { left: 291, top: 19, right: 19, bottom: 19 }, radius: 15, radii: [15, 15, 15, 15], outer: { left: 288, top: 16, right: 16, bottom: 16, radius: 18 }, container: { width: 1440, height: 900 } };
  host.reportLayout(g);
  assert.deepEqual(layouts, [g]);
  assert.equal(host.layout, g);
  assert.equal(api.messages.length, 0, 'no message for it yet (Phase 1 step 4)');
  assert.equal(host.perform('nav.back'), true);
  assert.equal(host.perform('nav.forward'), true);
  assert.equal(host.perform('nav.reload'), true);
  assert.equal(host.perform('window.close'), false, 'the browser\'s own window buttons, in pages');
  assert.deepEqual(win.calls, ['back', 'forward', 'reload']);
  assert.deepEqual(host.platform, { browser: 'chrome', os: 'linux' });
  assert.equal(host.mode, 'inpage');
  host.destroy();
});

test('mock host: state by hand, requests, layouts and host actions recorded', async () => {
  const host = createMockHost({ state: smallState(), windowId: W, replies: { createSpace: () => ({ spaceId: 'x' }) } });
  const seen = [];
  const off = host.onState((s) => seen.push(s));
  assert.deepEqual(await host.send('createSpace', { windowId: W }), { spaceId: 'x' });
  assert.equal(await host.send('closeTab', { tabId: 1 }), undefined);
  assert.deepEqual(host.sent.map((s) => s.type), ['createSpace', 'closeTab']);
  host.update((s) => ({ ...s, spaces: s.spaces.slice(0, 1) }));
  assert.equal(seen.length, 1);
  assert.equal(host.getState().spaces.length, 1);
  off();
  host.setState(null);
  assert.equal(seen.length, 1);
  host.reportLayout(({ insets: {} } as any));
  assert.equal(host.layouts.length, 1);
  assert.equal(host.perform('nav.back'), true);
  assert.deepEqual(host.performed, [{ name: 'nav.back', arg: undefined }]);
});

test('in-page host with a state kept elsewhere (content/core.ts): no reads of its own, its send and actions first', async () => {
  const api = fakeBrowser();
  let state = smallState();
  const subscribers = new Set();
  const source = { getState: () => state, onState: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); } };
  const sent = [];
  const performed = [];
  const win = fakeWindow();
  const host = createInPageHost({
    api, window: win, source, warn: () => {},
    send: async (type, payload) => { sent.push([type, payload]); return 'ok'; },
    perform: (name, arg) => (name === 'notice' ? (performed.push(arg), true) : undefined),
  });
  assert.equal(await host.ready, true);
  assert.equal(host.getState(), state, 'the state as given');
  assert.deepEqual(api.gets, [], 'nothing read');
  assert.equal(api.listeners.size, 0, 'no storage listener');
  const seen = [];
  host.onState((s) => seen.push(s));
  state = { ...state, settings: { ...state.settings, frameWhenHidden: false } };
  for (const cb of subscribers) cb(state);
  assert.equal(seen.at(-1), state);
  assert.equal(await host.send('activateTab', { tabId: 12 }), 'ok');
  assert.deepEqual(sent, [['activateTab', { tabId: 12 }]], 'its send, as given (it adds its own hints)');
  assert.deepEqual(api.messages, []);
  assert.equal(host.perform('notice', { id: 'n1', action: 'a0' }), true);
  assert.deepEqual(performed, [{ id: 'n1', action: 'a0' }]);
  assert.equal(host.perform('nav.back'), true, 'the rest as before: the page\'s history');
  assert.deepEqual(win.calls, ['back']);
  host.destroy();
  assert.equal(subscribers.size, 0);
});
