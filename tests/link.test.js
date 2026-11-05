// background/link.js, the extension's end of the link to Margin.app, against
// a fake app speaking app/PROTOCOL.md over a real WebSocket on 127.0.0.1
// (tests/fake-app.js), with a fake browser API: getting linked (the native
// port, wantLink and its nonce, the token, the app's key), hello, the
// snapshot, the theme in pieces, the keys, data.hello and the queue, ticks,
// requests run as the window's, deltas, windows, setLayout kept per window
// for pages, a resync, a drop and its reconnect, the app gone, a goodbye,
// and the data messages both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeApp } from './fake-app.js';

globalThis.chrome = { runtime: { getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '2.0.0' }) } };
const { createLink, keyBindings, themePieces, SESSION_KEY, LINK_META, STATE_KEYS, APP_REQUESTS } = await import('../extension/background/link.js');
const { APP_LINK_KEY, appDraws, boxFromLayout, layoutFor } = await import('../extension/shared/app-link.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(10);
  }
  return false;
}

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]; },
  };
}

/** A fake browser API and the app's dispatches into it. `app`: the fake app (or null: none running). */
function browser({ app = null, appOpen = null, launching = false, local = {}, profile = undefined } = {}) {
  const ports = [];
  const native = [];
  const api = {
    runtime: {
      getURL: (p) => `safari-web-extension://test/${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      connectNative() {
        const listeners = [];
        const port = { posted: [], onMessage: { addListener: (cb) => listeners.push(cb) }, onDisconnect: { addListener() {} }, postMessage(m) { port.posted.push(m); }, disconnect() {}, deliver: (m) => listeners.forEach((cb) => cb(m)) };
        ports.push(port);
        return port;
      },
      async sendNativeMessage(_, message) {
        native.push(message);
        const open = appOpen ? appOpen() : !!api.app;
        // The app answers on the port once it hears the nonce (the handler's notification).
        if (open && message.type === 'wantLink' && api.app) setTimeout(() => ports.at(-1)?.deliver(api.app.linkInfo(message.nonce)), 5);
        return { ok: true, appOpen: open, launching: !open && launching, ...(profile ? { profile } : {}) };
      },
    },
    storage: { local: area(local), session: area() },
    windows: { getAll: async () => api.windowList },
    tabs: { query: async () => [{ id: 13, windowId: 7, active: true }] },
    windowList: [{ id: 7, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: true }],
    app,
    ports,
    native,
  };
  return api;
}

const STATE = { spaces: [{ id: 's1', name: 'One' }], pins: [], folders: [], archive: [], settings: { theme: 'arcadia' }, favicons: { 'https://a.example': { data: 'data:a', at: 1 } }, openTabs: { tabs: {}, tabSpace: {}, activeSpaceByWindow: {} }, owner: { origin: 'o', since: 1 }, uiTheme: { id: 'big' }, 'dataMeta:spaces': {} };
const THEME = { id: 'arcadia', manifest: '{"id":"arcadia"}', html: '<div></div>', css: 'a{}'.repeat(300_000), files: { 'f.woff2': 'AAAA' } };
const FAST = { ping: 50, dead: 400, check: 50, linkWait: 500, openWait: 500, keptWait: 300, reconnect: [20, 40, 80], ask: [100, 400], gone: 300, windows: 50, layoutWrite: 10, launchAsk: 30, launchAsks: 5 };

function makeLink(api, { route = async (m, sender) => ({ ok: true, result: { type: m.type, sender } }), data = null, owner = () => true, timing = FAST } = {}) {
  const changed = [];
  const fakeData = data ?? {
    queue: [{ collection: 'pins', id: 'p1', updatedAt: 5, value: { url: 'https://x.example' } }],
    adopted: [],
    taken: [],
    pendingQueue: async (since) => fakeData.queue.filter((c) => c.updatedAt > since),
    snapshot: async () => ({ format: 1, items: { spaces: { s1: { updatedAt: 1, value: { name: 'One' } } } } }),
    adopt: async (set, options) => { fakeData.adopted.push([set, options]); },
    take: async (changes) => { fakeData.taken.push(changes); },
    onChanges: (cb) => { fakeData.emit = cb; },
  };
  const link = createLink({
    api, isOwner: owner, copy: () => ({ origin: 'safari-web-extension://test/', since: 1 }), instanceId: 'i1',
    WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => true, data: fakeData,
    theme: async () => THEME, commandKeys: () => ({ nextTab: 'Ctrl+Meta+ArrowDown' }), log: () => {}, timing,
  });
  link.onPageState((s) => changed.push(s));
  return { link, data: fakeData, changed, route };
}

test('link: helpers — the keys from Settings, the theme in checked pieces, what pages read', async () => {
  const keys = keyBindings({ shortcuts: { nextTab: 'Alt+Meta+ArrowDown' }, sidebarShortcut: 'Alt+KeyK' }, { nextTab: 'Ctrl+Meta+ArrowDown' });
  assert.deepEqual(keys['next-tab'], ['Alt+Meta+ArrowDown', 'Ctrl+Meta+ArrowDown'], 'the Settings key and the command key');
  assert.deepEqual(keys.palette, ['Meta+KeyT']);
  assert.deepEqual(keys['toggle-sidebar'], ['Alt+KeyK']);
  assert.ok(keys['prev-space'].length === 1, 'defaults for the rest');
  const sha = async (b) => createHash('sha256').update(b).digest('hex');
  const pieces = await themePieces(THEME, sha, 512 * 1024);
  const whole = Buffer.concat(pieces.sort((a, b) => a.part - b.part).map((p) => Buffer.from(p.data, 'base64')));
  assert.ok(pieces.length > 1 && pieces.every((p) => p.parts === pieces.length && p.size === whole.length && p.transfer === createHash('sha256').update(whole).digest('hex')));
  assert.ok(pieces.every((p) => Buffer.from(p.data, 'base64').length <= 512 * 1024), 'no piece over 512 KB of bytes');
  assert.deepEqual(JSON.parse(whole.toString('utf8')), THEME);
  assert.ok(appDraws({ state: 'linked' }) && appDraws({ state: 'reconnecting' }) && !appDraws({ state: 'off' }) && !appDraws(null));
  const a = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, container: { width: 1280, height: 800 }, mode: 'fullscreen' };
  assert.equal(layoutFor({ layouts: { 7: a } }, null), a, 'one window: its layout before the page knows its window');
  assert.equal(layoutFor({ layouts: { 7: a, 8: { ...a, insets: { ...a.insets, left: 8 } } } }, null), null, 'two that differ: not known yet');
  assert.equal(layoutFor({ layouts: { 7: a, 8: a } }, 9), null, 'another window: none');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 800 }), { left: 260, top: 8, right: 8, bottom: 8 }, 'full screen: the insets as they are');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 748 }), { left: 260, top: 0, right: 8, bottom: 8 }, 'a toolbar 52 pt above the page: the top inset less that');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1024, innerHeight: 640, zoom: 1.25 }), { left: 208, top: 6.5, right: 6.5, bottom: 6.5 }, 'zoomed: in the page\'s pixels');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1060, innerHeight: 800 }), { left: 40, top: 8, right: 8, bottom: 8 }, 'Safari\'s sidebar open (220 pt): the left inset less that');
  assert.equal(boxFromLayout({ insets: { left: 0, top: 0, right: 0, bottom: 0 } }, { outerWidth: 1, outerHeight: 1, innerWidth: 1, innerHeight: 1 }), null);
  assert.ok(STATE_KEYS.includes('openTabs') && !STATE_KEYS.includes('uiTheme'));
  for (const type of ['activateTab', 'navigate', 'openHere', 'search']) assert.ok(APP_REQUESTS.has(type), type);
  for (const type of ['hello', 'reloadForUpdate', 'getZoom', 'injectPage', 'fetchStyle', 'switchLog']) assert.ok(!APP_REQUESTS.has(type), type);
});

test('link: linked — the port kept used, wantLink, the key checked, hello, snapshot, theme, keys, data.hello', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, changed } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }), settings: { sidebarShortcut: 'Alt+KeyK' } });
    assert.ok(link.linked(), 'linked');
    assert.equal(api.native[0].type, 'wantLink');
    assert.ok(/^.{1,128}$/.test(api.native[0].nonce));
    assert.deepEqual(Object.keys(api.native[0]).sort(), ['nonce', 'type'], 'only the type and the nonce');
    const hello = await app.next('hello');
    assert.equal(hello.v, 2);
    assert.match(hello.profile, /^[A-Za-z0-9_.:-]{1,64}$/);
    assert.equal(hello.browser, 'safari');
    assert.equal(hello.owner, true);
    assert.equal(app.received[0].k, 'hello', 'hello first');
    const snap = await app.next('snapshot');
    assert.equal(snap.epoch, hello.epoch);
    assert.equal(snap.seq, 1);
    assert.deepEqual(Object.keys(snap.state).sort(), Object.keys(STATE).filter((k) => STATE_KEYS.includes(k)).sort(), 'the state as pages read it, no theme package or data times');
    assert.deepEqual(snap.windows, [{ windowId: 7, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: true, activeTabId: 13 }]);
    assert.ok(await until(() => app.received.filter((m) => m.k === 'theme').length >= 2));
    const pieces = app.received.filter((m) => m.k === 'theme');
    const whole = Buffer.concat(pieces.sort((a, b) => a.part - b.part).map((p) => Buffer.from(p.data, 'base64')));
    assert.equal(createHash('sha256').update(whole).digest('hex'), pieces[0].transfer);
    assert.equal(JSON.parse(whole.toString()).id, 'arcadia');
    const keys = await app.next('keys');
    assert.deepEqual(keys.bindings['toggle-sidebar'], ['Alt+KeyK']);
    assert.deepEqual(keys.bindings['next-tab'], ['Alt+Meta+ArrowDown', 'Ctrl+Meta+ArrowDown'], 'Safari\'s Settings default and its command key');
    const dh = await app.next('data.hello');
    assert.equal(dh.profile, hello.profile);
    assert.equal(dh.acked, 0);
    assert.equal(dh.queue.length, 1, 'the queue since nothing was acked');
    assert.deepEqual(api.storage.session.data[SESSION_KEY], { port: app.port, token: app.token, key: app.key }, 'the link kept for a background starting again');
    assert.equal(api.storage.local.data[LINK_META].profile, hello.profile, 'the profile id kept');
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.state === 'linked'), 'pages told');
    assert.deepEqual(changed, ['linked']);
    await wait(120);
    assert.ok(api.ports[0].posted.filter((m) => m.type === 'ping').length >= 2, 'the native port used again and again');
    assert.equal(api.ports.length, 1, 'one lasting port');
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: the profile id is made once and kept', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: { ...STATE, [LINK_META]: { profile: 'p-kept', acked: 42, rev: '9-x' } } });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.equal((await app.next('hello')).profile, 'p-kept');
    const dh = await app.next('data.hello');
    assert.equal(dh.acked, 42, 'and how far the app had stored');
    assert.equal(dh.rev, '9-x', 'and the set\'s rev it has');
  } finally {
    link.stop();
    await app.close();
  }
  // Storage started from defaults since (no spaces stored): the rev goes, so the app sends its set.
  const app2 = await startFakeApp();
  const api2 = browser({ app: app2, local: { [LINK_META]: { profile: 'p-kept', acked: 42, rev: '9-x' } } });
  const { link: l2 } = makeLink(api2);
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    const dh = await app2.next('data.hello');
    assert.ok(dh && !('rev' in dh), 'no rev');
    assert.equal(api2.storage.local.data[LINK_META].rev, undefined);
  } finally {
    l2.stop();
    await app2.close();
  }
});

test('link: Safari\'s own profile id (the handler\'s reply) is kept over the copy\'s, and a wiped storage finds it again', async () => {
  const app = await startFakeApp();
  const api = browser({ app, profile: 's-3f2a', local: { ...STATE, [LINK_META]: { profile: 'p-kept', acked: 42, rev: '9-x' } } });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    assert.equal(hello.profile, 's-3f2a', 'Safari\'s id');
    const dh = await app.next('data.hello');
    assert.equal(dh.profile, 's-3f2a');
    assert.equal(dh.acked, 0, 'another profile for the app: nothing acked');
    assert.ok(!('rev' in dh), 'and no rev');
    assert.equal(api.storage.local.data[LINK_META].profile, 's-3f2a', 'kept');
  } finally {
    link.stop();
    await app.close();
  }
  // Safari wiped the storage: the same id again from the handler.
  const app2 = await startFakeApp();
  const api2 = browser({ app: app2, profile: 's-3f2a' });
  const { link: l2 } = makeLink(api2);
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.equal((await app2.next('hello')).profile, 's-3f2a');
  } finally {
    l2.stop();
    await app2.close();
  }
});

test('link: what isn\'t the app — a wrong key, a link of another nonce, no app — links nothing', async () => {
  const impostor = await startFakeApp({ welcome: () => ({ k: 'welcome', v: 2, key: 'not-it' }) });
  const api = browser({ app: impostor });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked(), 'a welcome with another key: closed');
    assert.ok(await until(() => impostor.open === 0));
    assert.ok(!impostor.received.some((m) => m.k === 'hello'), 'nothing said to it');
  } finally {
    link.stop();
    await impostor.close();
  }
  const app = await startFakeApp();
  const api2 = browser({ app: null, appOpen: () => true });
  const { link: l2 } = makeLink(api2);
  try {
    const started = l2.start({ route: async () => ({ ok: true }) });
    await wait(5);
    api2.ports[0].deliver(app.linkInfo('another-nonce'));
    await started;
    assert.ok(!l2.linked(), 'another copy\'s link (another nonce): left');
  } finally {
    l2.stop();
    await app.close();
  }
  const api3 = browser({ app: null });
  const { link: l3 } = makeLink(api3);
  await l3.start({ route: async () => ({ ok: true }) });
  assert.ok(!l3.linked());
  assert.equal(l3.pageState(), 'off', 'no app: pages draw their own');
  await wait(250);
  assert.ok(api3.native.filter((m) => m.type === 'wantLink').length >= 2, 'asked again later');
  l3.stop();
});

test('link: an app started on demand (the handler says `launching`) is asked again soon, then linked', async () => {
  const app = await startFakeApp();
  let up = false;
  const api = browser({ app, appOpen: () => up, launching: true });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked());
    setTimeout(() => { up = true; }, 60);
    assert.ok(await until(() => link.linked(), 1000), 'linked once it runs');
    assert.ok(api.native.length >= 2 && api.native.length <= 6, `asked every 30 ms meanwhile (${api.native.length})`);
    // What happened, passed on to the app's log through the lasting port, each line once a minute.
    const logged = api.ports.flatMap((p) => p.posted).filter((m) => m.type === 'log').map((m) => m.line);
    assert.equal(logged.filter((l) => /starting it/.test(l)).length, 1, `the start, once: ${JSON.stringify(logged)}`);
    assert.ok(logged.some((l) => /^linked on/.test(l)), 'and the link');
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: ticks, requests as the window\'s, deltas, windows, setLayout for pages, resync', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const routed = [];
  const { link } = makeLink(api);
  try {
    await link.start({ route: async (m, sender) => { routed.push({ m, sender }); return m.type === 'closeTab' ? { ok: false, error: 'That tab is no longer open' } : { ok: true, result: { shown: 5 } }; } });
    const hello = await app.next('hello');
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'tick', at: 1 });
    assert.ok(await app.next('tock', { from }));
    app.send({ k: 'req', id: 1, epoch: hello.epoch, windowId: 7, type: 'activateTab', payload: { tabId: 5, hint: { url: 'https://a' } }, at: 1 });
    const r1 = await app.next('reply', { from, test: (m) => m.id === 1 });
    assert.deepEqual(r1, { k: 'reply', id: 1, ok: true, result: { shown: 5 } });
    assert.deepEqual(routed[0].m, { type: 'activateTab', tabId: 5, hint: { url: 'https://a' }, windowId: 7 }, 'the window stands in for the page\'s');
    assert.deepEqual(routed[0].sender, { app: true, tab: { windowId: 7 } }, 'as sender.tab.windowId');
    app.send({ k: 'req', id: 2, epoch: hello.epoch, windowId: 7, type: 'closeTab', payload: { tabId: 9 } });
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 2 })).error, 'That tab is no longer open');
    app.send({ k: 'req', id: 3, epoch: 'old', windowId: 7, type: 'activateTab', payload: {} });
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 3 })).ok, false, 'another epoch\'s: refused');
    app.send({ k: 'req', id: 4, epoch: hello.epoch, windowId: 7, type: 'reloadForUpdate', payload: {} });
    assert.match((await app.next('reply', { from, test: (m) => m.id === 4 })).error, /not a request/, 'only what the UI asks');
    assert.equal(routed.length, 2);
    // A change to stored values, and to the icons: a delta, icons as a diff.
    link.onStorage({ pins: { newValue: [{ id: 'p' }] }, favicons: { newValue: { 'https://a.example': { data: 'data:a', at: 1 }, 'https://b.example': { data: 'data:b', at: 2 } } }, 'dataMeta:pins': { newValue: {} } });
    const delta = await app.next('delta', { from });
    assert.equal(delta.seq, 2);
    assert.deepEqual(delta.changes, { pins: { newValue: [{ id: 'p' }] } });
    assert.deepEqual(delta.favicons, { set: { 'https://b.example': { data: 'data:b', at: 2 } }, del: [] });
    link.onStorage({ archive: {} });
    assert.deepEqual((await app.next('delta', { from, test: (m) => m.seq === 3 })).changes, { archive: {} }, 'a key removed');
    // A window resized: the list again, numbered on.
    api.windowList = [{ ...api.windowList[0], width: 1440 }];
    const win = await app.next('windows', { from });
    assert.equal(win.seq, 4);
    assert.equal(win.list[0].width, 1440);
    await wait(120);
    assert.equal(app.received.filter((m) => m.k === 'windows').length, 1, 'only on a change');
    // The app's layout for window 7: kept for pages, the page in front told.
    const told = [];
    link.onLayout((w, l) => told.push([w, l.insets.left]));
    app.send({ k: 'setLayout', epoch: hello.epoch, windowId: 7, seq: 2, insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6.5, radii: [6.5, 6.5, 6.5, 6.5], container: { width: 1440, height: 800 }, mode: 'fullscreen', at: 1 });
    app.send({ k: 'setLayout', epoch: hello.epoch, windowId: 7, seq: 1, insets: { left: 8, top: 8, right: 8, bottom: 8 }, container: { width: 1440, height: 800 }, mode: 'fullscreen', at: 1 });
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.layouts?.[7]?.insets?.left === 260));
    await wait(50);
    assert.equal(api.storage.local.data[APP_LINK_KEY].layouts[7].insets.left, 260, 'an older one (a lower seq) left');
    assert.deepEqual(told, [[7, 260]]);
    assert.equal(link.layout(7).radius, 6.5);
    // A window closed: its layout goes.
    api.windowList = [];
    assert.ok(await until(() => !api.storage.local.data[APP_LINK_KEY]?.layouts?.[7]));
    // A gap on the app's side: the whole state again.
    const before = app.received.length;
    app.send({ k: 'resync', epoch: hello.epoch });
    const snap = await app.next('snapshot', { from: before });
    assert.ok(snap.seq > win.seq);
    app.send({ k: 'resync', epoch: 'old' });
    await wait(60);
    assert.equal(app.received.slice(before).filter((m) => m.k === 'snapshot').length, 1, 'not for another epoch');
    // A push for one window's UI.
    assert.ok(link.push(7, { type: 'palette', newTab: true }));
    assert.deepEqual((await app.next('push', { from })).msg, { type: 'palette', newTab: true });
    // Settings changed: the keys again; the theme changed: sent again.
    link.onStorage({ settings: { newValue: { sidebarShortcut: 'Alt+KeyJ' } } });
    assert.deepEqual((await app.next('keys', { from })).bindings['toggle-sidebar'], ['Alt+KeyJ']);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: a drop — reconnecting for pages, the kept link tried again, linked again; the app gone — pages draw again', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, changed } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const first = await app.next('hello');
    // The app stops ticking: dropped after `dead`, tried again with the kept link.
    const from = app.received.length;
    assert.ok(await until(() => changed.includes('reconnecting'), 1500), 'reconnecting after no tick for the limit');
    assert.ok(await until(() => link.linked(), 1500), 'linked again');
    const again = await app.next('hello', { from });
    assert.notEqual(again.epoch, first.epoch, 'a new epoch');
    assert.equal(again.profile, first.profile, 'the same profile');
    assert.equal(api.native.filter((m) => m.type === 'wantLink').length, 1, 'the kept link: not asked again');
    assert.deepEqual(changed.slice(0, 3), ['linked', 'reconnecting', 'linked']);
    // The app crashes (its sockets gone, no goodbye) and isn't running any more.
    api.app = null;
    await app.close();
    assert.ok(await until(() => link.pageState() === 'reconnecting', 1000));
    assert.ok(await until(() => link.pageState() === 'off', 1500), 'pages draw their own UI once it\'s clear the app is gone');
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.state === 'off'));
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: the app says goodbye (it quit) — pages draw again at once', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, changed } = makeLink(api, { timing: { ...FAST, dead: 10_000 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    await app.next('hello');
    api.app = null;
    app.send({ k: 'bye', why: 'Margin.app quit' });
    assert.ok(await until(() => link.pageState() === 'off', 300));
    assert.ok(!changed.includes('reconnecting'), 'no reconnecting');
    assert.equal(api.storage.session.data[SESSION_KEY], undefined, 'the kept link forgotten');
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: data — data.need gets the converter\'s snapshot, the app\'s snapshot (in parts) and changes are taken, acks kept, this copy\'s changes sent', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, data } = makeLink(api, { timing: { ...FAST, dead: 10_000 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'data.need', epoch: hello.epoch, all: true });
    const snap = await app.next('data.snapshot', { from });
    assert.equal(snap.profile, hello.profile);
    assert.equal(snap.format, 1);
    assert.ok(snap.set.items.spaces.s1);
    assert.deepEqual([snap.part, snap.parts, typeof snap.transfer], [0, 1, 'string'], 'whole, as one part');
    // A change of this copy's after its data.hello: merged on top of the app's set when it comes.
    data.emit([{ collection: 'spaces', id: 's1', updatedAt: 99, value: { name: 'Mine' } }]);
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: hello.profile, format: 1, transfer: 't1', part: 1, parts: 2, set: { format: 1, items: { pins: { p: { updatedAt: 2, value: {} } } } } });
    app.send({ k: 'data.snapshot', epoch: 'another', format: 1, transfer: 't1', part: 0, parts: 2, set: { format: 1, items: {} } });
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: 'p-another', format: 1, transfer: 't1', part: 0, parts: 2, set: { format: 1, items: {} } });
    await wait(40);
    assert.equal(data.adopted.length, 0, 'not before every part is here (another epoch\'s or profile\'s don\'t count)');
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: hello.profile, format: 1, transfer: 't1', part: 0, parts: 2, rev: '3-abc', omitted: [['userThemes', 'big']], set: { format: 1, items: { spaces: { a: { updatedAt: 1, value: {} } }, folders: {}, userThemes: {} } } });
    assert.ok(await until(() => data.adopted.length === 1));
    const [set, options] = data.adopted[0];
    assert.deepEqual(Object.keys(set.items).sort(), ['folders', 'pins', 'spaces', 'userThemes'], 'the parts put together, an empty collection too');
    assert.deepEqual(options.omitted, [['userThemes', 'big']], 'what the app left out, kept as this copy has it');
    assert.deepEqual(options.changes.map((c) => c.id), ['s1'], 'this copy\'s change since its hello, merged on top');
    assert.ok(await until(() => link.rev() === '3-abc' && api.storage.local.data[LINK_META]?.rev === '3-abc'), 'the set\'s rev kept once it\'s applied');
    app.send({ k: 'data.changes', epoch: hello.epoch, profile: hello.profile, changes: [{ collection: 'pins', id: 'q', updatedAt: 9, value: {} }] });
    app.send({ k: 'data.changes', epoch: 'another', changes: [{ collection: 'pins', id: 'r', updatedAt: 9, value: {} }] });
    assert.ok(await until(() => data.taken.length === 1));
    await wait(30);
    assert.equal(data.taken.length, 1, 'another epoch\'s changes left');
    app.send({ k: 'data.ack', upTo: 77, rev: '4-def' });
    assert.ok(await until(() => api.storage.local.data[LINK_META]?.acked === 77 && api.storage.local.data[LINK_META]?.rev === '4-def'), 'kept as acked, with its rev');
    app.send({ k: 'data.ack', upTo: 50 });
    await wait(40);
    assert.equal(link.acked(), 77, 'never back');
    assert.equal(link.rev(), '4-def', 'an ack without a rev leaves it');
    data.emit([{ collection: 'spaces', id: 's1', updatedAt: 100, value: { name: 'Two' } }]);
    const ch = await app.next('data.changes', { from, test: (m) => m.changes[0]?.updatedAt === 100 });
    assert.deepEqual(ch.changes, [{ collection: 'spaces', id: 's1', updatedAt: 100, value: { name: 'Two' } }]);
    assert.equal(ch.profile, hello.profile);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: no socket from a worker, and none after a background that never got past opening one', async () => {
  const api = browser({ app: null, appOpen: () => true });
  const link = createLink({ api, isOwner: () => true, copy: () => ({ origin: 'o', since: 1 }), WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => false, log: () => {}, timing: FAST });
  await link.start({ route: async () => ({ ok: true }) });
  assert.equal(api.native.length, 0, 'not even asked: the app would link to nothing');
  link.stop();
  const app = await startFakeApp();
  const api2 = browser({ app, local: { appLinkOpening: { at: 1, v: '2.0.0' } } });
  const { link: l2 } = makeLink(api2);
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.ok(!l2.linked());
    assert.equal(api2.storage.local.data.appLinkOff?.v, '2.0.0', 'off for this version');
    assert.equal(app.received.length, 0);
  } finally {
    l2.stop();
    await app.close();
  }
  // Another version of Margin: tried again.
  const app3 = await startFakeApp();
  const api3 = browser({ app: app3, local: { appLinkOff: { at: 1, v: '1.9.0', why: 'x' } } });
  const { link: l3 } = makeLink(api3);
  try {
    await l3.start({ route: async () => ({ ok: true }) });
    assert.ok(l3.linked(), 'a new version: linked');
    assert.equal(api3.storage.local.data.appLinkOpening, undefined, 'the note removed once the constructor returned');
  } finally {
    l3.stop();
    await app3.close();
  }
});

test('link: a copy that doesn\'t own the state never links', async () => {
  const app = await startFakeApp();
  const api = browser({ app });
  const { link } = makeLink(api, { owner: () => false });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked());
    assert.equal(api.native.length, 0);
    assert.equal(api.ports.length, 0, 'no port either');
  } finally {
    link.stop();
    await app.close();
  }
});
