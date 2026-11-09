// A window Margin.app draws nothing over (its copy told `drawn` false: not in
// full screen, or not found among the window server's yet), the background's
// side against a fake of the browser's API, with the link's word played on
// the background's own link object: a page committing there gets no box from
// its first paint (`--margin-box-fp: off`), while one in a window not said of yet
// (a new full-screen window before its first layout) keeps the registered box;
// and Margin's keys there go the unlinked way: ⌘T and the palette's key open
// Margin's new-tab page, a new tab Safari made stays (no palette pushed for
// it), the new-tab page is told the app doesn't draw there, and the sidebar's
// key is logged; in a window the app draws, they're left to the app. The
// registration follows what the app draws at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = { tabs: new Map(), nextId: 500, created: [], removed: [], local: {}, session: {}, registered: new Map(), toPages: [], inserted: [] };
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const NEW_TAB = 'safari-web-extension://test/newtab/newtab.html';
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
    update: async (id) => ({ ...fake.tabs.get(id) }),
    create: async ({ windowId, url }) => {
      const tab = { id: fake.nextId++, windowId: windowId ?? 1, url, title: '', index: fake.tabs.size, active: false, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push(url);
      return { ...tab };
    },
    remove: async (ids) => { for (const id of [].concat(ids)) { fake.removed.push(id); fake.tabs.delete(id); } },
    sendMessage: async (tabId, message) => { fake.toPages.push(message?.type); return undefined; },
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  webNavigation: { onCommitted: event('navCommitted') },
  scripting: {
    executeScript: async () => [{ result: true }],
    insertCSS: async ({ target, css }) => { fake.inserted.push({ tabId: target.tabId, css }); },
    getRegisteredContentScripts: async ({ ids } = {}) => [...fake.registered.values()].filter((s) => !ids || ids.includes(s.id)).map((s) => structuredClone(s)),
    registerContentScripts: async (list) => { for (const s of list) fake.registered.set(s.id, structuredClone(s)); },
    unregisterContentScripts: async ({ ids } = {}) => { for (const id of ids ?? [...fake.registered.keys()]) fake.registered.delete(id); },
    updateContentScripts: async (list) => { for (const s of list) fake.registered.set(s.id, { ...fake.registered.get(s.id), ...structuredClone(s) }); },
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: fake.local[k], newValue: structuredClone(v) }]));
        Object.assign(fake.local, structuredClone(items));
        void fire('sChanged', changes, 'local');
      },
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

fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.local.settings = { fullscreenOnly: false }; // Chrome's profile (this file's): Margin in every window
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
const { whenRegistered, OFF_CSS } = await import('../extension/background/registered.ts');
const { appLink } = await import('../extension/background/app-link.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
const settled = async () => { await sleep(30); await whenRegistered(); await sleep(10); };


// The link's word, as the background's link object would have it (background/link.ts view, drawn, drawsWindow).
const pushes = [];
function linkSays({ drawn = {}, layouts = {}, linked = true } = {}) {
  appLink.push = (windowId, msg) => { pushes.push([windowId, msg]); return linked; };
  appLink.view = () => ({ epoch: 'e1', layouts, drawn });
  appLink.drawn = (w) => drawn[w];
  appLink.drawsWindow = (w) => linked && drawn[w] !== false;
  appLink.linked = () => linked;
  appLink.pageState = () => (linked ? 'linked' : 'off');
}
const commit = (tabId) => fire('navCommitted', { tabId, frameId: 0, documentId: `doc-${tabId}`, url: 'https://a.test/next' });

test('a page committing in a window Margin.app draws nothing over: no box from its first paint; in a window not said of yet: the registered box', async () => {
  await chrome.storage.local.set({ appLink: { state: 'linked', epoch: 'e1', layouts: {}, drawn: {} } });
  await settled();
  assert.ok(fake.registered.get('margin-page')?.js, 'the first paint registered');
  fake.tabs.set(20, { id: 20, windowId: 2, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
  fake.tabs.set(30, { id: 30, windowId: 3, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
  linkSays({ drawn: { 2: false } });
  await commit(20);
  await commit(30);
  await sleep(20);
  assert.deepEqual(fake.inserted, [{ tabId: 20, css: OFF_CSS }], 'only the undrawn window\'s page');
  linkSays({ drawn: { 2: true }, layouts: { 2: { insets: { left: 300, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } } });
  fake.inserted.length = 0;
  await commit(20);
  await sleep(20);
  assert.equal(fake.inserted.length, 1);
  assert.match(fake.inserted[0].css, /--margin-box-at-left: 300px/, 'drawn again: its own layout');
});

test('⌘T, the palette\'s key and the sidebar\'s in a window Margin.app draws nothing over: Margin\'s new-tab page, the sidebar\'s logged; in one it draws: left to the app', async () => {
  linkSays({ drawn: { 1: false, 2: true } });
  fake.tabs.set(1, { ...fake.tabs.get(1), active: true });
  fake.tabs.set(20, { ...fake.tabs.get(20), active: true });
  fake.created.length = 0;
  pushes.length = 0;
  await fire('onCommand', 'new-tab', { id: 1, windowId: 1 });
  await sleep(30);
  assert.deepEqual(fake.created, [NEW_TAB], 'undrawn: Margin\'s new-tab page');
  assert.deepEqual(pushes, [], 'nothing pushed for the app');
  await fire('onCommand', 'new-tab', { id: 20, windowId: 2 });
  await sleep(30);
  assert.equal(fake.created.length, 1, 'drawn: no tab');
  assert.deepEqual(pushes, [[2, { type: 'keyHeard', command: 'new-tab', from: 'command' }]], 'left to the app, which is told');
  pushes.length = 0;
  await sleep(650);
  await fire('onCommand', 'toggle-sidebar', { id: 1, windowId: 1 });
  await sleep(30);
  assert.equal(fake.created.length, 1, 'the sidebar\'s key: no tab');
  assert.deepEqual(pushes, [], 'and nothing for an app that draws nothing there');
  await sleep(650);
  await ask('newTabKey', {}, 1); // ⌘T heard by the page in the undrawn window (content/core.ts drawsWindow)
  await sleep(30);
  assert.deepEqual(fake.created, [NEW_TAB, NEW_TAB], 'the page\'s ⌘T: the same');
});

test('a new tab Safari made in a window Margin.app draws nothing over stays, with no palette pushed, and its page is told the app isn\'t there; in a window it draws, handed to the app\'s palette', async () => {
  linkSays({ drawn: { 1: false, 2: true } });
  fake.tabs.set(9, { id: 9, windowId: 1, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(1).active = false;
  await fire('onCreated', { ...fake.tabs.get(9) });
  await sleep(50);
  fake.removed.length = 0;
  pushes.length = 0;
  assert.deepEqual(await ask('newTabPage', {}, 9), { ok: true, result: { app: false } }, 'undrawn: the page shows its own');
  assert.deepEqual(fake.removed, [], 'the new tab stays');
  assert.deepEqual(pushes, [], 'no palette pushed');
  await fire('onCreated', { ...fake.tabs.get(20) }); // (the web page in window 2, as Margin's state has it)
  await sleep(50);
  fake.tabs.set(29, { id: 29, windowId: 2, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  fake.tabs.get(20).active = false;
  await fire('onCreated', { ...fake.tabs.get(29) });
  await sleep(50);
  // (Handed off as Safari made it: background.ts onCreated.)
  assert.deepEqual(pushes.find(([w]) => w === 2), [2, { type: 'palette', newTab: true }]);
  assert.ok(fake.removed.includes(29), 'the new tab closed');
});

test('⌘T handed off while the copy still thinks the app draws there, and the app couldn\'t show the palette (no overlay shown: its binding just gone): Margin\'s new-tab page opens there, and the next ⌘T keeps Safari\'s new tab', async () => {
  linkSays({ drawn: { 3: true } }); // the copy hasn't heard yet: the app's grace before "not drawn"
  fake.tabs.set(30, { ...fake.tabs.get(30), windowId: 3, active: false });
  await fire('onCreated', { ...fake.tabs.get(30) });
  await sleep(50);
  fake.tabs.set(39, { id: 39, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
  pushes.length = 0;
  fake.removed.length = 0;
  fake.created.length = 0;
  await fire('onCreated', { ...fake.tabs.get(39) });
  await sleep(50);
  assert.deepEqual(pushes.find(([w]) => w === 3), [3, { type: 'palette', newTab: true }], 'handed off to the app');
  assert.ok(fake.removed.includes(39), 'Safari\'s new tab closed');
  fake.tabs.get(30).active = true;
  // The app (Shell.paletteDropped) says it couldn't show it, as a request of its UI's.
  const notes = [];
  const note = appLink.note;
  appLink.note = (line) => { notes.push(String(line)); };
  let done;
  try {
    done = await new Promise((resolve) => listeners.onMessage[0]({ type: 'paletteDropped', windowId: 3, newTab: true }, { app: true, tab: { windowId: 3 } }, resolve));
  } finally {
    appLink.note = note;
  }
  assert.deepEqual(done, { ok: true, result: true });
  assert.deepEqual(fake.created, [NEW_TAB], 'Margin\'s new-tab page opened in the window: ⌘T still opens something');
  assert.ok(notes.some((l) => l === 'the app couldn\'t show the palette over window 3: Margin\'s new-tab page opened there'), `${notes}`);
  // That page, and Safari's next new tab there: kept as the copy's own (no palette pushed).
  const page = fake.nextId - 1;
  fake.tabs.get(30).active = false;
  fake.tabs.set(page, { ...fake.tabs.get(page), url: NEW_TAB, active: true, status: 'complete' });
  pushes.length = 0;
  assert.deepEqual(await ask('newTabPage', {}, page), { ok: true, result: { app: false } }, 'the new-tab page shows its own');
  fake.tabs.set(49, { id: 49, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 3, active: true, status: 'complete' });
  fake.removed.length = 0;
  await fire('onCreated', { ...fake.tabs.get(49) });
  await sleep(50);
  assert.deepEqual(pushes, [], 'no palette pushed');
  assert.ok(!fake.removed.includes(49), 'the next ⌘T\'s tab stays');
  // The app saying it draws there again: at once after the drop (its binding holds, its overlay not
  // shown yet), still kept; a second later, ⌘T goes to the app's palette again.
  const { drawnChanged } = await import('../extension/background/handlers.ts');
  const backToPage = async () => {
    for (const [id, t] of fake.tabs) if (t.windowId === 3 && id !== 30) { fake.tabs.delete(id); await fire('onRemoved', id, { windowId: 3, isWindowClosing: false }); }
    fake.tabs.get(30).active = true;
    await fire('onActivated', { tabId: 30, windowId: 3 });
    await sleep(50);
  };
  const newTab = async (id) => {
    fake.tabs.get(30).active = false;
    fake.tabs.set(id, { id, windowId: 3, url: NEW_TAB, title: 'New Tab', index: 1, active: true, status: 'complete' });
    pushes.length = 0;
    await fire('onCreated', { ...fake.tabs.get(id) });
    await sleep(50);
  };
  drawnChanged(3, true);
  await backToPage();
  await newTab(59);
  assert.deepEqual(pushes, [], 'drawn at once after the drop: still kept');
  await sleep(1000);
  drawnChanged(3, true);
  await backToPage();
  await newTab(69);
  assert.deepEqual(pushes.find(([w]) => w === 3), [3, { type: 'palette', newTab: true }], 'drawn again later: handed to the app\'s palette');
});

test('a page committing in a tab Margin\'s state doesn\'t have yet: its window from Safari\'s word of the tab (tabs.onCreated, onAttached), its own sheet asked for in the commit\'s own turn, nothing awaited first', async () => {
  linkSays({ drawn: { 2: true, 3: false }, layouts: { 2: { insets: { left: 300, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } } });
  fake.tabs.set(70, { id: 70, windowId: 2, url: 'https://a.test/', title: 'A', index: 5, active: false, status: 'loading' });
  void fire('onCreated', { ...fake.tabs.get(70) });
  fake.inserted.length = 0;
  void commit(70);
  assert.equal(fake.inserted.length, 1, 'asked for at once (a page paints its first frame 15 to 20 ms after it commits)');
  assert.match(fake.inserted[0].css, /--margin-box-at-left: 300px/, 'its window\'s own layout');
  // Moved to a window Margin.app draws nothing over.
  fake.tabs.set(70, { ...fake.tabs.get(70), windowId: 3 });
  void fire('onAttached', 70, { newWindowId: 3, newPosition: 0 });
  fake.inserted.length = 0;
  void commit(70);
  assert.deepEqual(fake.inserted, [{ tabId: 70, css: OFF_CSS }], 'the window it\'s in now');
  // Its window seen in its own update (a move heard no other way): that window's sheet.
  fake.tabs.set(70, { ...fake.tabs.get(70), windowId: 2 });
  void fire('onUpdated', 70, { status: 'loading' }, { ...fake.tabs.get(70) });
  fake.inserted.length = 0;
  void commit(70);
  assert.match(fake.inserted[0]?.css ?? '', /--margin-box-at-left: 300px/, 'the window its own update named');
  await sleep(50);
});

test('the app saying it draws nothing over a window: the registration follows at once, from the link\'s own word (not after layouts settle, nor once storage has it), so the window\'s new pages don\'t wait on the sheet put in as each commits; drawn again: its box registered again at once', async () => {
  const { windowDrawnChanged } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const box = { 1: { insets: { left: 300, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } };
  const stored = JSON.stringify(fake.local.appLink);
  const follows = async () => {
    const at = Date.now();
    windowDrawnChanged();
    await whenRegistered();
    return Date.now() - at;
  };
  linkSays({ drawn: { 1: true }, layouts: box });
  await follows();
  assert.equal(registered()?.left, 300, 'drawn, at its layout');
  linkSays({ drawn: { 1: false }, layouts: box });
  assert.ok(await follows() < 500, 'at once (LAYOUT_SETTLE_MS is 2 s)');
  assert.deepEqual(registered(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0 }, 'drawn nothing over: a layout of zeros, no box');
  assert.equal(JSON.stringify(fake.local.appLink), stored, '(storage not told yet)');
  linkSays({ drawn: { 1: true }, layouts: box });
  assert.ok(await follows() < 500);
  assert.equal(registered()?.left, 300, 'drawn again: its box at once');
});

test('a layout with no box anywhere (the frame turned off): registered at once; a box back after none (Keep open again, with the frame off) at once too, as zeros leave no fix-up to give new pages their window\'s box; a box after another box waits for layouts to settle', async () => {
  const { layoutsChanged } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const at = (left, top = 8) => ({ 1: { insets: { left, top, right: top, bottom: top }, radius: 6.25, epoch: 'e1' } });
  linkSays({ drawn: { 1: true }, layouts: at(300) });
  assert.equal(registered()?.left, 300, '(from the test before)');
  linkSays({ drawn: { 1: true }, layouts: at(0, 0) });
  layoutsChanged();
  await whenRegistered();
  assert.deepEqual(registered(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0 }, 'no box: at once');
  linkSays({ drawn: { 1: true }, layouts: at(280) });
  layoutsChanged();
  await whenRegistered();
  assert.equal(registered()?.left, 280, 'a box back after none: at once (else 2 s of new pages with no box beside the sidebar)');
  linkSays({ drawn: { 1: true }, layouts: at(300) });
  layoutsChanged();
  await sleep(100);
  await whenRegistered();
  assert.equal(registered()?.left, 280, 'a box after another: not yet (LAYOUT_SETTLE_MS)');
});

// Layout changes on a fake clock (background/settle.ts): what registers, and when.
test('a lone layout change (none in the 2 s before it) registered at once; a drag (a burst) registers its first at once at most, then only the layout it settles at, once it has; a burst back to the registered layout registers nothing more', async () => {
  const { layoutsChanged, useLayoutClock } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const { fakeClock } = await import('./fake-clock.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const at = (left) => ({ 1: { insets: { left, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } });
  const clock = fakeClock(Date.now() + 60_000); // (well after the tests before's changes)
  useLayoutClock(clock);
  let updates = 0;
  const update = chrome.scripting.updateContentScripts;
  chrome.scripting.updateContentScripts = async (list) => { updates++; return update(list); };
  const change = async (left) => { linkSays({ drawn: { 1: true }, layouts: at(left) }); layoutsChanged(); await settled(); };
  try {
    await change(320);
    assert.equal(registered()?.left, 320, 'lone: at once (no tick of the clock)');
    assert.equal(updates, 1);
    clock.tick(2000);
    await settled();
    assert.equal(updates, 1, 'settled at the one registered: nothing more');

    // A drag starting after a quiet while: its first at once, then nothing until it ends.
    clock.tick(500);
    for (let left = 330; left <= 400; left += 10) { await change(left); clock.tick(16); }
    assert.equal(registered()?.left, 330, 'the drag\'s first at once, nothing of the rest yet');
    assert.equal(updates, 2);
    clock.tick(2000 - 16 - 1);
    await settled();
    assert.equal(registered()?.left, 330, 'not before 2 s with no change');
    clock.tick(1);
    await settled();
    assert.equal(registered()?.left, 400, 'settled: the layout it ended at');
    assert.equal(updates, 3, 'a drag: two registrations at most');

    // A drag that comes back to where it started.
    clock.tick(5000);
    await change(410);
    assert.equal(registered()?.left, 410);
    clock.tick(16);
    await change(420);
    clock.tick(16);
    await change(410);
    const before = updates;
    clock.tick(2000);
    await settled();
    assert.equal(registered()?.left, 410);
    assert.equal(updates, before, 'back at the registered one: nothing more');
  } finally {
    chrome.scripting.updateContentScripts = update;
  }
});

test('a burst never ends at a layout it passed through: the settled one is chosen once a registration still under way (the lone change\'s, on a slow background) is done', async () => {
  const { layoutsChanged, useLayoutClock } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const { fakeClock } = await import('./fake-clock.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const at = (left) => ({ 1: { insets: { left, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' } });
  const clock = fakeClock(Date.now() + 120_000);
  useLayoutClock(clock);
  linkSays({ drawn: { 1: true }, layouts: at(500) });
  layoutsChanged();
  await settled();
  assert.equal(registered()?.left, 500);
  clock.tick(3000);
  await settled();
  // The next registration held in WebKit (a busy Mac) until let go.
  const update = chrome.scripting.updateContentScripts;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  chrome.scripting.updateContentScripts = async (list) => { await held; return update(list); };
  try {
    linkSays({ drawn: { 1: true }, layouts: at(600) });
    layoutsChanged(); // lone: its registration starts, and is held
    await sleep(30);
    clock.tick(16);
    linkSays({ drawn: { 1: true }, layouts: at(500) }); // and back, in the same burst
    layoutsChanged();
    clock.tick(2000); // settled while 600's registration is still under way
    await sleep(30);
    chrome.scripting.updateContentScripts = update;
    release();
    await settled();
    await settled();
    assert.equal(registered()?.left, 500, 'the layout the burst ended at, not the one under way as it settled');
  } finally {
    chrome.scripting.updateContentScripts = update;
    release();
  }
});

test('windows at different layouts: the registered one is most windows\' (a tie keeps it), so a lone change in one window that doesn\'t tip that registers nothing (its pages get their own as they commit), and one that does registers at once', async () => {
  const { layoutsChanged, useLayoutClock } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const { fakeClock } = await import('./fake-clock.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const box = (left) => ({ insets: { left, top: 8, right: 8, bottom: 8 }, radius: 6.25, epoch: 'e1' });
  const clock = fakeClock(Date.now() + 180_000);
  useLayoutClock(clock);
  const change = async (layouts) => { linkSays({ drawn: { 1: true, 2: true }, layouts }); layoutsChanged(); await settled(); };
  await change({ 1: box(700), 2: box(700) });
  assert.equal(registered()?.left, 700);
  clock.tick(3000);
  let updates = 0;
  const update = chrome.scripting.updateContentScripts;
  chrome.scripting.updateContentScripts = async (list) => { updates++; return update(list); };
  try {
    await change({ 1: box(700), 2: box(720) });
    assert.equal(registered()?.left, 700, 'a tie: the one registered stays');
    assert.equal(updates, 0);
    fake.inserted.length = 0;
    await commit(20); // (window 2's page)
    assert.equal(fake.inserted.length, 1);
    assert.match(fake.inserted[0].css, /--margin-box-at-left: 720px/, 'window 2\'s page: its own as it commits');
    clock.tick(3000);
    await settled();
    assert.equal(updates, 0, 'settled: still a tie');
    await change({ 1: box(720), 2: box(720) });
    assert.equal(registered()?.left, 720, 'both at 720: registered at once');
    assert.equal(updates, 1);
  } finally {
    chrome.scripting.updateContentScripts = update;
  }
});

test('in a burst, a box gone everywhere registered at once, and a box back after none at once too (not left to the settle), judged once a registration under way is done: a box back while the no-box layout\'s registration is still being written doesn\'t leave zeros for the 2 s', async () => {
  const { layoutsChanged, useLayoutClock } = await import('../extension/background/registered.ts');
  const { layoutOfFiles } = await import('../extension/shared/page-box.ts');
  const { fakeClock } = await import('./fake-clock.ts');
  const registered = () => layoutOfFiles(fake.registered.get('margin-page')?.css);
  const at = (left, top = 8) => ({ 1: { insets: { left, top, right: top, bottom: top }, radius: 6.25, epoch: 'e1' } });
  const ZEROS = { left: 0, top: 0, right: 0, bottom: 0, radius: 0 };
  const clock = fakeClock(Date.now() + 240_000);
  useLayoutClock(clock);
  const change = async (layouts) => { linkSays({ drawn: { 1: true }, layouts }); layoutsChanged(); await settled(); };
  await change(at(500));
  assert.equal(registered()?.left, 500, 'lone: at once');
  clock.tick(16);
  await change(at(520));
  assert.equal(registered()?.left, 500, 'in a burst: a box after another waits');
  clock.tick(16);
  await change(at(0, 0));
  assert.deepEqual(registered(), ZEROS, 'in a burst: no box anywhere, at once');
  clock.tick(16);
  await change(at(520));
  assert.equal(registered()?.left, 520, 'in a burst: a box back after none, at once');
  clock.tick(3000);
  await settled();

  // The no-box layout's registration held in WebKit (a busy Mac), and the box back meanwhile.
  const update = chrome.scripting.updateContentScripts;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  chrome.scripting.updateContentScripts = async (list) => { await held; return update(list); };
  try {
    linkSays({ drawn: { 1: true }, layouts: at(0, 0) });
    layoutsChanged(); // lone: its registration (zeros) starts, and is held
    await sleep(30);
    clock.tick(16);
    linkSays({ drawn: { 1: true }, layouts: at(520) }); // Keep open again, in the same burst
    layoutsChanged();
    await sleep(30);
    chrome.scripting.updateContentScripts = update;
    release();
    await settled();
    await settled();
    assert.equal(registered()?.left, 520, 'the box back, at once once the zeros are in (no tick of the clock: not the settle)');
  } finally {
    chrome.scripting.updateContentScripts = update;
    release();
  }
});

test.after(() => setTimeout(() => process.exit(0), 50));
