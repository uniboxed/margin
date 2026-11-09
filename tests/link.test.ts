// background/link.ts, the extension's end of the link to Margin.app, against
// a fake app speaking app/PROTOCOL.md over a real WebSocket on 127.0.0.1
// (tests/fake-app.ts), with a fake browser API: getting linked (the native
// port, wantLink and its nonce, the token, the app's key), hello, the
// snapshot, the theme in pieces, the keys, data.hello and the queue, ticks,
// requests run as the window's, deltas, windows, setLayout kept per window
// for pages, a resync, a drop and its reconnect, the app gone, a goodbye,
// and the data messages both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeApp } from './fake-app.ts';

globalThis.chrome = { runtime: { getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '2.0.0' }) } };
const { createLink, keyBindings, themePieces, SESSION_KEY, LINK_META, STATE_KEYS, APP_REQUESTS, WINDOW_CALLS, PARKED_WHY, windowCallRefusal } = await import('../extension/background/link.ts');
const { APP_LINK_KEY, appDraws, boxFromLayout, drawsWindow, layoutFor, NOT_DRAWN, unpinchedSize } = await import('../extension/shared/app-link.ts');

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
        const gone = [];
        // `lose()`: the port disconnects (its listeners told; posting throws from then on).
        const port = {
          posted: [], dead: false, onMessage: { addListener: (cb) => listeners.push(cb) }, onDisconnect: { addListener: (cb) => gone.push(cb) },
          postMessage(m) { if (port.dead) throw new Error('disconnected'); port.posted.push(m); }, disconnect() {}, deliver: (m) => listeners.forEach((cb) => cb(m)),
          lose() { port.dead = true; gone.forEach((cb) => cb()); },
        };
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
  assert.equal(layoutFor({ layouts: { 7: a } }, 9), null, 'another window, the only layout another\'s: none (not measured yet: the page keeps its box)');
  // A window Margin.app said it draws nothing over: a layout of zeros (no box), not "not measured yet".
  const undrawn = { state: 'linked', layouts: { 7: a, 8: a }, drawn: { 7: false, 8: true } };
  assert.equal(layoutFor(undrawn, 7), NOT_DRAWN);
  assert.equal(boxFromLayout(layoutFor(undrawn, 7), { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 800 }), null, 'no box');
  assert.equal(layoutFor(undrawn, 8), a, 'a drawn window: its own');
  assert.equal(layoutFor({ layouts: { 7: a } , drawn: { 7: false } }, null), null, 'a page that doesn\'t know its window yet: never an undrawn window\'s');
  assert.ok(!drawsWindow(undrawn, 7) && drawsWindow(undrawn, 8) && drawsWindow(undrawn, 9) && drawsWindow(undrawn, null), 'drawn unless the app said not');
  assert.ok(!drawsWindow({ state: 'off', drawn: {} }, 8), 'not linked: none');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 800 }), { left: 260, top: 8, right: 8, bottom: 8 }, 'full screen: the insets as they are');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 748 }), { left: 260, top: 0, right: 8, bottom: 8 }, 'a toolbar 52 pt above the page: the top inset less that');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1024, innerHeight: 640, zoom: 1.25 }), { left: 208, top: 6.5, right: 6.5, bottom: 6.5 }, 'zoomed: in the page\'s pixels');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1060, innerHeight: 800 }), { left: 40, top: 8, right: 8, bottom: 8 }, 'Safari\'s sidebar open (220 pt): the left inset less that');
  assert.equal(boxFromLayout({ insets: { left: 0, top: 0, right: 0, bottom: 0 } }, { outerWidth: 1, outerHeight: 1, innerWidth: 1, innerHeight: 1 }), null);
  // The Web Inspector docked (Phase 2 step 8): the overlay is over the page's part only, and the
  // insets the app sends are from the window's edges (the inspector's size in them).
  const bottom = { insets: { left: 260, top: 8, right: 8, bottom: 308 } };
  assert.deepEqual(boxFromLayout(bottom, { outerWidth: 1280, outerHeight: 800, innerWidth: 1280, innerHeight: 500, x: 0, y: 0 }), { left: 260, top: 8, right: 8, bottom: 8 }, 'docked at the bottom: the page\'s own frame below it');
  const right = { insets: { left: 260, top: 8, right: 408, bottom: 8 } };
  assert.deepEqual(boxFromLayout(right, { outerWidth: 1280, outerHeight: 800, innerWidth: 880, innerHeight: 800, x: 0, y: 0 }), { left: 260, top: 8, right: 8, bottom: 8 }, 'docked on the right');
  const left = { insets: { left: 660, top: 8, right: 8, bottom: 8 } };
  assert.deepEqual(boxFromLayout(left, { outerWidth: 1280, outerHeight: 800, innerWidth: 880, innerHeight: 800, x: 400, y: 0 }), { left: 260, top: 8, right: 8, bottom: 8 }, 'docked on the left');
  assert.deepEqual(boxFromLayout(a, { outerWidth: 1280, outerHeight: 800, innerWidth: 1060, innerHeight: 800, x: 9999 }), { left: 40, top: 8, right: 8, bottom: 8 }, 'a corner past the room there is: held to it');
  assert.ok(STATE_KEYS.includes('openTabs') && !STATE_KEYS.includes('uiTheme'));
  for (const type of ['activateTab', 'navigate', 'openHere', 'search']) assert.ok(APP_REQUESTS.has(type), type);
  for (const type of ['hello', 'reloadForUpdate', 'getZoom', 'injectPage', 'fetchStyle']) assert.ok(!APP_REQUESTS.has(type), type);
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

test('link: Margin.app running but sending no link (one an update left): asked again at the short wait three times, then less and less often; pages told it isn\'t answering', async () => {
  const api = browser({ app: null, appOpen: () => true });
  const at = [];
  const sendNative = api.runtime.sendNativeMessage;
  api.runtime.sendNativeMessage = async (id, message) => {
    if (message.type === 'wantLink') at.push(Date.now());
    return sendNative(id, message);
  };
  const { link } = makeLink(api, { timing: { ...FAST, linkWait: 20, noLinkAsk: 60, noLinkAsks: 3, ask: [150, 1200], gone: 50 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => at.length >= 7, 4000), `asked 7 times (${at.length})`);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    // Each gap is the link's wait (20 ms) and then the wait before asking again.
    assert.ok(gaps.slice(0, 3).every((g) => g >= 70 && g < 150), `three asks after the short wait: ${gaps}`);
    assert.ok(gaps[3] >= 150 && gaps[4] > gaps[3] + 80 && gaps[5] > gaps[4] + 160, `then doubling: ${gaps}`);
    assert.equal(link.pageState(), 'off');
    const written = api.storage.local.data[APP_LINK_KEY];
    assert.equal(written?.state, 'off');
    assert.equal(written?.why, 'no-link', 'pages: running, not answering');
  } finally {
    link.stop();
  }
  // Linked at last: no `why` left behind; the short waits again after the next drop to no link.
  const app = await startFakeApp();
  let answering = false;
  const api2 = browser({ app: null, appOpen: () => true });
  const native = api2.runtime.sendNativeMessage;
  api2.runtime.sendNativeMessage = async (id, message) => {
    if (answering && message.type === 'wantLink') setTimeout(() => api2.ports.at(-1)?.deliver(app.linkInfo(message.nonce)), 5);
    return native(id, message);
  };
  const { link: l2 } = makeLink(api2, { timing: { ...FAST, linkWait: 20, noLinkAsk: 60, noLinkAsks: 3, ask: [150, 1200], gone: 50 } });
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => api2.storage.local.data[APP_LINK_KEY]?.why === 'no-link', 1000));
    answering = true;
    assert.ok(await until(() => l2.linked(), 1000), 'linked at the next short ask');
    assert.ok(await until(() => api2.storage.local.data[APP_LINK_KEY]?.state === 'linked', 500));
    assert.equal(api2.storage.local.data[APP_LINK_KEY]?.why, undefined, 'linked: no why');
  } finally {
    l2.stop();
    await app.close();
  }
  // Not running at all: no `why` (the page offers to start it).
  const api3 = browser({ app: null });
  const { link: l3 } = makeLink(api3);
  await l3.start({ route: async () => ({ ok: true }) });
  assert.ok(await until(() => api3.storage.local.data[APP_LINK_KEY] === undefined || api3.storage.local.data[APP_LINK_KEY]?.why === undefined, 300));
  assert.equal(api3.storage.local.data[APP_LINK_KEY]?.why, undefined);
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

test('link: asked for now (the new-tab page\'s "Start Margin.app"): from the start of the waits, not at the next one; false while the link isn\'t started', async () => {
  const app = await startFakeApp();
  let up = false;
  const api = browser({ app, appOpen: () => up });
  const { link } = makeLink(api, { timing: { ...FAST, ask: [5000, 5000] } });
  try {
    assert.equal(link.askNow(), false, 'not started: nothing to ask with');
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked(), 'no app yet: the next ask is 5 s away');
    const asked = api.native.filter((m) => m.type === 'wantLink').length;
    up = true;
    assert.equal(link.askNow(), true);
    assert.ok(await until(() => link.linked(), 1000), 'linked at once');
    assert.equal(api.native.filter((m) => m.type === 'wantLink').length, asked + 1);
    assert.equal(link.askNow(), true, 'linked: nothing more to do');
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
    app.send({ k: 'req', id: 4, epoch: hello.epoch, windowId: 7, type: 'injectPage', payload: {} });
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
    // A window focused, one created: when the copy heard each, for the app to tell same-bounds windows apart.
    api.windowList = [...api.windowList, { id: 8, left: 0, top: 0, width: 1440, height: 800, state: 'fullscreen', focused: false }];
    link.windowCreated(8, 1_800_000_000_000);
    const created = await app.next('windows', { from, test: (m) => m.list.length === 2 });
    assert.equal(created.list[1].createdAt, 1_800_000_000_000);
    assert.ok(!('focusedAt' in created.list[1]) && !('createdAt' in created.list[0]), 'only what was heard');
    link.windowFocused(-1, 1_800_000_000_100); // WINDOW_ID_NONE: the browser left the front
    link.windowFocused(7, 1_800_000_000_200);
    const focused = await app.next('windows', { from, test: (m) => m.list[0].focusedAt != null });
    assert.equal(focused.list[0].focusedAt, 1_800_000_000_200);
    api.windowList = api.windowList.slice(0, 1);
    const from2 = app.received.length;
    link.windowClosed(8);
    assert.equal((await app.next('windows', { from: from2, test: (m) => m.list.length === 1 })).list[0].focusedAt, 1_800_000_000_200);
    // The Web Inspector docked: the tab in front says where its area sits, the window's entry carries it.
    const from3 = app.received.length;
    link.viewport(7, 13, { x: 0, y: 0, width: 1440, height: 500 });
    assert.deepEqual((await app.next('windows', { from: from3, test: (m) => !!m.list[0].viewport })).list[0].viewport, { x: 0, y: 0, width: 1440, height: 500 });
    // One whose start a pointer event measured: `measured` passed on (the app carves out a measured left part).
    const from3b = app.received.length;
    link.viewport(7, 13, { x: 220, y: 0, width: 1220, height: 800, measured: true });
    assert.deepEqual((await app.next('windows', { from: from3b, test: (m) => m.list[0].viewport?.x === 220 })).list[0].viewport, { x: 220, y: 0, width: 1220, height: 800, measured: true });
    const from4 = app.received.length;
    link.viewport(7, 99, { x: 0, y: 0, width: 1000, height: 800 }); // a tab behind (its inspector isn't shown): not the window's
    link.viewport(7, 13, null); // closed
    assert.ok(!('viewport' in (await app.next('windows', { from: from4, test: (m) => !m.list[0].viewport })).list[0]), 'only the tab in front\'s, and gone when it closes');
    // The tab in front gone into full screen (a video's): the window's entry says so; a tab behind doesn't; back: gone.
    const from5 = app.received.length;
    link.pageFullscreen(7, 99, true);
    link.pageFullscreen(7, 13, true);
    assert.equal((await app.next('windows', { from: from5, test: (m) => m.list[0].pageFullscreen === true })).list[0].pageFullscreen, true);
    const from6 = app.received.length;
    link.pageFullscreen(7, 13, false);
    assert.ok(!('pageFullscreen' in (await app.next('windows', { from: from6, test: (m) => !m.list[0].pageFullscreen })).list[0]), 'out of it: gone');
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

test('link: drawn — whether the app draws over each window, kept for pages apart from the layouts; dropped with older epochs\' layouts on a new epoch\'s hello and when off; a closed window\'s goes', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  api.windowList = [...api.windowList, { id: 8, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: false }];
  const { link } = makeLink(api, { timing: { ...FAST, dead: 10_000 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    const told = [];
    link.onDrawn((w, on) => told.push([w, on]));
    const layout = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6.5, container: { width: 1280, height: 800 }, mode: 'fullscreen' };
    app.send({ k: 'setLayout', epoch: hello.epoch, windowId: 7, seq: 1, ...layout, at: 1 });
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 7, on: true, at: 1 });
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 8, on: false, at: 1 });
    app.send({ k: 'drawn', epoch: 'old', windowId: 8, on: true, at: 1 });
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 8, on: false, at: 2 });
    const stored = () => api.storage.local.data[APP_LINK_KEY];
    assert.ok(await until(() => stored()?.drawn?.[8] === false && stored()?.drawn?.[7] === true && stored()?.layouts?.[7]));
    await wait(40);
    assert.deepEqual(told, [[7, true], [8, false]], 'a change only, this epoch\'s only');
    assert.equal(link.drawn(8), false);
    assert.equal(link.drawn(9), undefined, 'not said');
    assert.ok(link.drawsWindow(7) && !link.drawsWindow(8) && link.drawsWindow(9));
    assert.deepEqual(link.view().drawn, { 7: true, 8: false });
    assert.equal(stored().layouts[7].insets.left, 260, 'the layouts apart from it');
    assert.ok(!drawsWindow(stored(), 8) && drawsWindow(stored(), 7), 'pages read the same');
    // Window 8 closed: what the app said of it goes.
    api.windowList = api.windowList.slice(0, 1);
    link.windowClosed(8);
    assert.ok(await until(() => stored()?.drawn && !(8 in stored().drawn)));
    // A drop and a new epoch: what the epoch before said of the windows goes as the new one says hello.
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 7, on: false, at: 3 });
    assert.ok(await until(() => stored()?.drawn?.[7] === false));
    const from = app.received.length;
    app.drop();
    const again = await app.next('hello', { from });
    assert.notEqual(again.epoch, hello.epoch);
    assert.ok(await until(() => stored()?.state === 'linked' && stored()?.epoch === again.epoch));
    assert.deepEqual(stored().drawn, {}, 'drawn: none said yet this epoch');
    assert.deepEqual(stored().layouts, {}, 'the epoch before\'s layouts gone');
    assert.equal(stored().lastLayouts?.[7]?.insets?.left, 260, 'kept apart, only for the first paint\'s registration to start from');
    assert.ok(link.drawsWindow(7), 'not said: drawn (an app that never says behaves as before)');
    // Off: none either.
    app.send({ k: 'drawn', epoch: again.epoch, windowId: 7, on: false, at: 4 });
    assert.ok(await until(() => stored()?.drawn?.[7] === false));
    api.app = null;
    app.send({ k: 'bye', why: 'Margin.app quit' });
    assert.ok(await until(() => stored()?.state === 'off'));
    assert.deepEqual(stored().drawn, {});
    assert.ok(!link.drawsWindow(7));
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: a background started again keeps what the one before said of the windows Safari still lists, and nothing while off', async () => {
  const layout = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6.5, epoch: 'e0', seq: 1 };
  // (Margin.app running but sending no link: the state stays as read for a while, then off.)
  const api = browser({ appOpen: () => true, local: { ...STATE, [APP_LINK_KEY]: { state: 'linked', epoch: 'e0', layouts: { 7: layout, 41: layout }, drawn: { 7: true, 41: false } } } });
  const writes = [];
  const set = api.storage.local.set.bind(api.storage.local);
  api.storage.local.set = async (values) => { if (values[APP_LINK_KEY]) writes.push(structuredClone(values[APP_LINK_KEY])); return set(values); };
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => writes.length > 0));
    assert.equal(writes[0].state, 'reconnecting');
    assert.deepEqual(Object.keys(writes[0].layouts), ['7'], 'window 41 isn\'t open any more');
    assert.deepEqual(writes[0].drawn, { 7: true });
    assert.ok(await until(() => writes.at(-1).state === 'off', 3000), 'no link: off');
    assert.deepEqual([writes.at(-1).layouts, writes.at(-1).drawn], [{}, {}], 'off: nothing of the windows kept');
  } finally {
    link.stop();
  }
});

test('link: which page is shown — each window\'s `visible` from its tab in front only, forgotten as another tab is shown; the copy\'s blur; focus and flags in Margin.app\'s log', async () => {
  const T0 = Date.now() - 60_000; // the page's clock, before now
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const asked = [];
  api.tabs.sendMessage = async (tabId, message) => { asked.push([tabId, message.type]); };
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true, result: null }) });
    await app.next('hello');
    await app.next('data.hello');
    assert.ok(await until(() => asked.some(([id, type]) => id === 13 && type === 'reportVisibility')), 'the page in front asked to say again at the start');
    const logged = () => api.ports.flatMap((p) => p.posted).filter((m) => m.type === 'log').map((m) => m.line);
    // A tab behind in window 7 says it's shown (it isn't the window's word), then the tab in front.
    let from = app.received.length;
    link.visibility(7, 99, true, T0 + 0);
    await wait(120);
    assert.ok(app.received.slice(from).filter((m) => m.k === 'windows').every((m) => !('visible' in m.list[0])), 'a tab behind: not the window\'s');
    link.visibility(7, 13, false, T0 + 100);
    await wait(200); // (the log's line is written 150 ms after a word: below)
    let win = await app.next('windows', { from, test: (m) => 'visible' in m.list[0] });
    assert.equal(win.list[0].visible, false);
    assert.equal(win.list[0].visibleAt, T0 + 100);
    from = app.received.length;
    link.visibility(7, 13, true, T0 + 200);
    win = await app.next('windows', { from, test: (m) => m.list[0].visible === true });
    assert.equal(win.list[0].visibleAt, T0 + 200, 'its time is when the page said it');
    from = app.received.length;
    link.visibility(7, 13, false, T0 + 150); // an older word than the one kept: left
    await wait(120);
    assert.ok(app.received.slice(from).filter((m) => m.k === 'windows').every((m) => m.list[0].visible === true));
    // Another tab shown in window 7: the window's word is forgotten until that tab says, and it's asked.
    asked.length = 0;
    api.tabs.query = async () => [{ id: 14, windowId: 7, active: true }];
    from = app.received.length;
    link.tabActivated(14, 7);
    link.visibility(7, 13, false, T0 + 250); // the tab left behind says hidden before Safari's list has the new tab in front
    win = await app.next('windows', { from, test: (m) => m.list[0].activeTabId === 14 });
    assert.ok(!('visible' in win.list[0]) && !('visibleAt' in win.list[0]), 'unknown, not hidden');
    await wait(50);
    assert.ok(!app.received.slice(from).some((m) => m.k === 'windows' && m.list[0].visible === false), 'the tab left behind\'s hidden never sent as the window\'s');
    assert.deepEqual(asked, [[14, 'reportVisibility']]);
    link.visibility(7, 13, true, T0 + 300); // the tab left behind: not the window's
    link.visibility(7, 14, true, T0 + 400);
    win = await app.next('windows', { from, test: (m) => m.list[0].visible === true });
    assert.equal(win.list[0].visibleAt, T0 + 400);
    // (The flags' line at most once a second, as they are once it's over.)
    assert.ok(await until(() => logged().some((l) => /^windows report at [\d:.]+: 7 focused shown [\d:.]+$/.test(l)), 1500), 'a report\'s shown page in the log');
    // Its page replaced (a navigation committed after it spoke): forgotten; one committed before: kept.
    from = app.received.length;
    link.tabGone(14, T0 + 399);
    await wait(120);
    assert.ok(app.received.slice(from).filter((m) => m.k === 'windows').every((m) => m.list[0].visible === true), 'a commit before its word: kept');
    link.tabGone(14, T0 + 500);
    win = await app.next('windows', { from, test: (m) => !('visible' in m.list[0]) });
    assert.ok(!('visibleAt' in win.list[0]));
    // WINDOW_ID_NONE: the copy's blur, on each of its windows; both focus events in the log.
    from = app.received.length;
    link.windowFocused(-1, T0 + 600);
    win = await app.next('windows', { from, test: (m) => m.list[0].blurredAt != null });
    assert.equal(win.list[0].blurredAt, T0 + 600);
    link.windowFocused(7, T0 + 700);
    win = await app.next('windows', { from, test: (m) => m.list[0].focusedAt === T0 + 700 });
    assert.equal(win.list[0].blurredAt, T0 + 600, 'kept: the last blur heard');
    assert.ok(await until(() => logged().some((l) => /^focus heard: none \(WINDOW_ID_NONE\) at \d\d:\d\d:\d\d\.\d{3}$/.test(l)) && logged().some((l) => /^focus heard: window 7 at /.test(l))), `${logged()}`);
    assert.ok(await until(() => logged().some((l) => /^windows report at [\d:.]+: 7 focused \(focus heard [\d:.]+\); blur heard [\d:.]+$/.test(l)), 1500), `${logged().filter((l) => l.startsWith('windows report'))}`);
    const reports = logged().filter((l) => l.startsWith('windows report')).map((l) => Number(/at (\d\d):(\d\d):(\d\d)\.(\d{3})/.exec(l)?.slice(1).reduce((a, x, i) => a + Number(x) * [3600e3, 60e3, 1e3, 1][i], 0)));
    assert.ok(reports.every((t, i) => i === 0 || t - reports[i - 1] >= 990), `the flags' line at most once a second: ${logged().filter((l) => l.startsWith('windows report'))}`);
    assert.ok(!logged().some((l) => /https?:|example/.test(l)), 'ids and times only');
    // Each change of a window's word one line: shown or hidden, when the page saw it, what said it, how late it was heard.
    const seen = () => logged().filter((l) => l.startsWith('window 7 '));
    assert.ok(/^window 7 hidden at \d\d:\d\d:\d\d\.\d{3} \(unknown, tab 13, heard \d+ ms later\)$/.test(seen()[0] ?? ''), `${seen()}`);
    // (Shown again by tab 13 and then by 14, the tab shown next: one line, a change; which tab depends on when it was looked at.)
    assert.ok(/^window 7 shown at [\d:.]+ \(unknown, tab 1[34], heard \d+ ms later\)$/.test(seen()[1] ?? ''), `${seen()}`);
    assert.equal(seen().length, 2, `the same word again, a tab behind, another tab of the window saying shown: no line (${seen()})`);
    assert.ok(Number(/heard (\d+) ms/.exec(seen()[0])?.[1]) >= 60_000 - 100, 'how late: from the page\'s time (a minute back) to now');
    link.visibility(7, 14, false, Date.now(), 'content script');
    assert.ok(await until(() => seen().length === 3));
    assert.match(seen()[2], /^window 7 hidden at [\d:.]+ \(content script, tab 14, heard \d+ ms later\)$/);
    // The same word again (the page's answer to reportVisibility after its visibilitychange): nothing sent,
    // its first time kept; a change is sent with its own time.
    win = await app.next('windows', { from, test: (m) => m.list[0].visible === false });
    const hiddenAt = win.list[0].visibleAt;
    from = app.received.length;
    link.visibility(7, 14, false, Date.now(), 'content script');
    await wait(120);
    assert.ok(!app.received.slice(from).some((m) => m.k === 'windows'), 'the same word again: nothing sent');
    const shownAt = Date.now();
    link.visibility(7, 14, true, shownAt, 'content script');
    win = await app.next('windows', { from, test: (m) => m.list[0].visible === true });
    assert.equal(win.list[0].visibleAt, shownAt);
    assert.ok(hiddenAt < shownAt);
    // A closed window's words go with it.
    link.visibility(8, 20, true, T0 + 800);
    link.windowClosed(8);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: a drop — reconnecting for pages, the kept link tried again, linked again; the app gone — pages lose their box', async () => {
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
    assert.ok(await until(() => link.pageState() === 'off', 1500), 'off (pages lose their box) once it\'s clear the app is gone');
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.state === 'off'));
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: the app says goodbye (it quit) — off for pages at once', async () => {
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

test('link: no socket from a worker', async () => {
  const api = browser({ app: null, appOpen: () => true });
  const link = createLink({ api, isOwner: () => true, copy: () => ({ origin: 'o', since: 1 }), WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => false, log: () => {}, timing: FAST });
  await link.start({ route: async () => ({ ok: true }) });
  assert.equal(api.native.length, 0, 'not even asked: the app would link to nothing');
  link.stop();
});

// The socket guard (DECISIONS.md "Margin 2: Safari reliability"): a note left by a background that
// never got past opening a socket turns sockets off for that Safari session; found again in a later
// session, for 24 h; never "until another version" (every build is 0.1.0). A new Safari session is
// a browser() with the same storage.local and an empty storage.session.
const nextSession = (api, app, change = {}) => browser({ app, local: { ...structuredClone(api.storage.local.data), ...change } });
const logLines = (api) => api.ports.flatMap((p) => p.posted.filter((m) => m.type === 'log').map((m) => m.line));

test('link: a left socket note in an empty session — off for this session only, said to the app\'s log and to pages; the next session links and says so in its hello', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: { ...STATE, appLinkOpening: { at: 1, v: '2.0.0' } } });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked());
    assert.equal(app.received.length, 0, 'no socket');
    assert.ok(api.storage.session.data.appLinkSessionOff?.at > 0, 'off for this Safari session');
    assert.equal(api.storage.local.data.appLinkOff, undefined, 'nothing lasting');
    assert.equal(api.storage.local.data.appLinkHung?.count, 1, 'seen once');
    assert.equal(api.storage.local.data.appLinkOpening, undefined, 'the note taken');
    assert.ok(logLines(api).some((l) => l.startsWith('the socket guard turned the link off') && l.includes('the rest of this Safari session')), 'said in Margin.app\'s log');
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.why === 'sockets-off'));
    const off = api.storage.local.data[APP_LINK_KEY];
    assert.equal(off.state, 'off');
    assert.ok(off.offAt > 0 && off.offUntil === undefined, 'when, and no end but the session\'s');
    // The same session, another background (Safari unloaded the page): still off.
    const again = makeLink(api).link;
    await again.start({ route: async () => ({ ok: true }) });
    assert.ok(!again.linked() && app.received.length === 0, 'the same session: off');
    again.stop();
  } finally {
    link.stop();
  }
  const api2 = nextSession(api, app);
  const { link: l2 } = makeLink(api2);
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.ok(l2.linked(), 'the next session links');
    const hello = await app.next('hello');
    assert.match(hello.socketsOff ?? '', /unfinished socket in 1 Safari session, last at /, 'the app hears of it');
    assert.ok(await until(() => api2.storage.local.data.appLinkHung === undefined), 'forgotten once a link opened');
  } finally {
    l2.stop();
    await app.close();
  }
});

test('link: a left socket note in two Safari sessions — off until 24 h later, then it links; an old { v } off is removed, not kept', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: { ...STATE, appLinkOpening: { at: 1 }, appLinkHung: { count: 1, at: Date.now() - 3600_000 } } });
  const t0 = Date.now();
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked());
    const off = api.storage.local.data.appLinkOff;
    assert.equal(off?.count, 2);
    assert.ok(off.until >= t0 + 24 * 3600_000 && off.until <= Date.now() + 24 * 3600_000, 'off for 24 h, no longer');
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.offUntil === off.until), 'pages know until when');
    assert.ok(logLines(api).some((l) => l.includes('in 2 Safari sessions; no link until')));
  } finally {
    link.stop();
  }
  // A later session within the 24 h: off.
  const api2 = nextSession(api, app);
  const { link: l2 } = makeLink(api2);
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.ok(!l2.linked() && app.received.length === 0, 'still off');
    assert.ok(logLines(api2).some((l) => l.startsWith('sockets off since ')));
  } finally {
    l2.stop();
  }
  // Past the 24 h: on again, the lasting off gone.
  const api3 = nextSession(api, app, { appLinkOff: { ...api.storage.local.data.appLinkOff, until: Date.now() - 1 } });
  const { link: l3 } = makeLink(api3);
  try {
    await l3.start({ route: async () => ({ ok: true }) });
    assert.ok(l3.linked(), 'linked once it ended');
    assert.equal(api3.storage.local.data.appLinkOff, undefined);
  } finally {
    l3.stop();
  }
  // The old shape, "until another version" (the same version as this one's): removed, and linked.
  const api4 = browser({ app, local: { ...STATE, appLinkOff: { at: 1, v: '2.0.0', why: 'x' } } });
  const { link: l4 } = makeLink(api4);
  try {
    await l4.start({ route: async () => ({ ok: true }) });
    assert.ok(l4.linked(), 'an old { v } off is no reason to stay off');
    assert.equal(api4.storage.local.data.appLinkOff, undefined, 'removed');
  } finally {
    l4.stop();
    await app.close();
  }
});

test('link: the socket\'s handlers are on before the note is removed — the welcome is taken when the removal resolves 50 ms late, and no note is left once open', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const remove = api.storage.local.remove.bind(api.storage.local);
  api.storage.local.remove = async (keys) => {
    if ([keys].flat().includes('appLinkOpening')) await wait(50);
    return remove(keys);
  };
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(link.linked(), 'linked');
    assert.equal(api.storage.local.data.appLinkOpening, undefined, 'the note gone by the time the open returned');
    assert.ok(await app.next('hello'));
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: Try again (the new-tab page) ends the socket guard\'s off at once and links', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: { ...STATE, appLinkOpening: { at: 1 }, appLinkHung: { count: 1, at: 1 } } });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(!link.linked() && api.storage.local.data.appLinkOff, 'off for 24 h');
    assert.equal(await link.retrySockets(), true);
    assert.ok(await until(() => link.linked()), 'linked');
    assert.equal(api.storage.local.data.appLinkOff, undefined);
    assert.equal(api.storage.local.data.appLinkHung, undefined, 'its count too');
    assert.equal(api.storage.session.data.appLinkSessionOff, undefined);
    assert.ok(logLines(api).some((l) => l.startsWith('sockets on again: Try again chosen')));
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.state === 'linked' && !('why' in api.storage.local.data[APP_LINK_KEY])));
  } finally {
    link.stop();
    await app.close();
  }
});

// What Margin.app's log is told (DECISIONS.md "Margin 2: Safari reliability", link diagnostics).
const clockOf = (ms: number) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const ofDay = (hms: string) => { const [h, m, rest] = hms.split(':'); return ((Number(h) * 60 + Number(m)) * 60 + Number(rest)) * 1000; };

test('link: notes made while the native port is down arrive in order once it\'s back, each with the time it was made; the newest 20 kept', async () => {
  const api = browser({ app: null, appOpen: () => false });
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    await wait(20);
    api.ports[0].lose();
    const made = Date.now();
    link.note('first');
    await wait(5);
    link.note('second');
    link.note('first'); // already waiting: once
    assert.ok(await until(() => api.ports.length === 2, 1000), 'a new port at the next ping');
    const lines = api.ports[1].posted.filter((m) => m.type === 'log').map((m) => m.line);
    const held = lines.filter((l) => l.startsWith('(at '));
    assert.match(held[0], /^\(at \d\d:\d\d:\d\d\.\d{3}\) the native port disconnected/, 'the loss itself, first');
    const mine = held.filter((l) => / (first|second)$/.test(l));
    assert.deepEqual(mine.map((l) => l.replace(/^\(at [^)]*\) /, '')), ['first', 'second'], 'in order, once each');
    const at = mine[0].slice(4, 16);
    assert.ok(Math.abs(ofDay(at) - ofDay(clockOf(made))) <= 5, `the time it was made (${at}, ${clockOf(made)})`);
    assert.ok(lines.some((l) => /^the native port is back after \d+\.\d s \(1 disconnect since the last such note\)$/.test(l)), 'and the port back');
    assert.ok(lines.indexOf(held.at(-1)) < lines.findIndex((l) => l.startsWith('the native port is back')), 'the held notes before what came after');
    // Sent once: the same line within the minute isn't sent again.
    link.note('second');
    assert.equal(api.ports[1].posted.filter((m) => m.line?.endsWith(' second') || m.line === 'second').length, 1);
    // 25 notes with no port: the newest 20, and how many were lost.
    api.ports[1].lose();
    for (let i = 0; i < 25; i++) link.note(`n${i}`);
    assert.ok(await until(() => api.ports.length === 3, 1000));
    const third = api.ports[2].posted.filter((m) => m.type === 'log').map((m) => m.line);
    assert.equal(third[0], '(5 earlier notes lost while the native port was down)', 'n0–n4 lost (the port\'s own notes held back: one a minute)');
    assert.deepEqual(third.slice(1, 21).map((l) => l.replace(/^\(at [^)]*\) /, '')), Array.from({ length: 20 }, (_, i) => `n${i + 5}`));
  } finally {
    link.stop();
  }
});

test('link: the background\'s start and each try of the kept link are noted, with how the last link ended', async () => {
  const app = await startFakeApp();
  // Every link started here, stopped and the fake app closed whatever fails: a failure fails the run, never
  // keeps it from ending (a link's timers and the app's socket would). The stops in the steps stay as they
  // are: their order is what the lines say.
  const started = [];
  const start = (a: any, options: any) => { const l = makeLink(a, options).link; started.push(l); return l; };
  let closed = false;
  try {
    const api = browser({ app, local: STATE });
    const link = start(api, { timing: { ...FAST, dead: 10_000 } });
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(logLines(api).includes('background started (kept link: no, page state before: none, last stop: none noted this Safari session)'), `${logLines(api)}`);
    await app.next('hello');
    app.drop(); // no close frame
    assert.ok(await until(() => logLines(api).some((l) => /^kept link try 1 of 3 \(port \d+\): open in \d+ ms$/.test(l)), 1500), `${logLines(api)}`);
    assert.ok(logLines(api).includes('dropped: closed by the app (1006)'), 'why it dropped');
    // Linked again as stored, as the next background reads it (the page state is written a moment after the line:
    // under load it can still say reconnecting then).
    assert.ok(await until(() => api.storage.local.data[APP_LINK_KEY]?.state === 'linked', 1500), 'stored as linked again');
    // (No stop: the next background starts while this one was linked, as when Safari tears it down.)
    const second = start(api, { timing: { ...FAST, dead: 10_000 } });
    await second.start({ route: async () => ({ ok: true }) });
    const began = logLines(api).filter((l) => l.startsWith('background started')).at(-1);
    assert.match(began, /^background started \(kept link: yes, page state before: linked, last stop: none since linked at \d\d:\d\d:\d\d\.\d{3} \(the background before was torn down while linked\)\)$/);
    assert.ok(logLines(api).some((l) => /^kept link at the background's start \(port \d+\): open in \d+ ms$/.test(l)), `${logLines(api)}`);
    second.stop('turned off');
    link.stop();
    const third = start(api, { timing: { ...FAST, dead: 10_000 } });
    await third.start({ route: async () => ({ ok: true }) });
    assert.match(logLines(api).filter((l) => l.startsWith('background started')).at(-1), /last stop: stopped at \d\d:\d\d:\d\d\.\d{3}: turned off\)$/);
    third.stop();
    await app.close();
    closed = true;
    // A kept link nothing listens on any more: refused at once.
    const api2 = browser({ app: null, appOpen: () => false });
    api2.storage.session.data[SESSION_KEY] = { port: app.port, token: 't', key: 'k' };
    const l4 = start(api2, undefined);
    await l4.start({ route: async () => ({ ok: true }) });
    assert.ok(logLines(api2).some((l) => new RegExp(`^kept link at the background's start \\(port ${app.port}\\): refused or closed at once \\(\\d+ ms, 1006\\)$`).test(l)), `${logLines(api2)}`);
  } finally {
    for (const l of started) l.stop();
    if (!closed) await app.close().catch(() => {});
  }
});


// Busy for `ms`: the background paused (Safari suspending it, the Mac asleep), its timers and the
// socket's messages queued meanwhile.
const pause = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };

test('link: a check that runs late (the background paused) never drops a link the app is still on: it probes, and judges after what came in meanwhile', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, changed } = makeLink(api);
  const ticking = setInterval(() => app.send({ k: 'tick', at: Date.now() }), 100);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    await app.next('hello');
    await wait(300);
    app.send({ k: 'tick', at: Date.now() }); // (queued in the socket through the pause)
    pause(700); // over DEAD (400 ms here) and 3 checks
    await wait(600);
    assert.ok(link.linked() && !changed.includes('reconnecting'), 'not dropped');
    assert.ok(logLines(api).some((l) => /^paused 0\.\d s \(a link check ran late\); probing the app, judged from now$/.test(l)), `${logLines(api)}`);
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});

test('link: a check that runs late with the app silent drops within DEAD of the probe, not at once', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link, changed } = makeLink(api);
  let ticking = setInterval(() => app.send({ k: 'tick', at: Date.now() }), 100);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    await app.next('hello');
    await wait(300);
    clearInterval(ticking);
    ticking = null;
    const from = app.received.length;
    pause(700);
    const resumed = Date.now();
    await wait(200);
    assert.ok(!changed.includes('reconnecting'), 'not at once: 0.2 s after the pause it\'s still linked');
    assert.ok(await app.next('tock', { from, ms: 500 }), 'the app sent a tock (the probe)');
    assert.ok(await until(() => changed.includes('reconnecting'), 1000), 'dropped');
    const after = Date.now() - resumed;
    assert.ok(after >= 380 && after <= 900, `within DEAD (400 ms) of the probe, not before: ${after} ms`);
    assert.ok(logLines(api).includes('dropped: no word from the app for 40 s'));
  } finally {
    if (ticking) clearInterval(ticking);
    link.stop();
    await app.close();
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

test('link: the handoff\'s words — its requests taken, others refused, the windows calls\' refusals, parkedActivity pushed', async () => {
  for (const type of ['setWindowState', 'frameProbe', 'windowDrafts', 'focusWindow', 'closeWindow', 'openSpaceWindow']) assert.ok(APP_REQUESTS.has(type), type);
  for (const type of ['parked', 'parkedActivity', 'setWindowStates', 'windowsUpdate', 'framed']) assert.ok(!APP_REQUESTS.has(type), type);
  assert.deepEqual([...WINDOW_CALLS].sort(), ['closeWindow', 'focusWindow', 'setWindowState']);
  for (const type of WINDOW_CALLS) assert.ok(APP_REQUESTS.has(type), type);
  assert.deepEqual([...PARKED_WHY].sort(), ['focus', 'raise', 'tab']);

  const none = new Set();
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 1000 }, none, 1210), { refused: 'late', pastMs: 210 }, 'past notAfter');
  assert.equal(windowCallRefusal({ windowId: 3, notAfter: 1000 }, none, 1000), null, 'at notAfter: still in time');
  assert.equal(windowCallRefusal({ windowId: 3 }, none, 1e15), null, 'no notAfter (today\'s switch): never late');
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 2000 }, new Set([3]), 1000), { busy: true }, 'a call for that window pending');
  assert.equal(windowCallRefusal({ windowId: 4, notAfter: 2000 }, new Set([3]), 1000), null, 'another window\'s pending: runs');
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 1000 }, new Set([3]), 1500), { refused: 'late', pastMs: 500 }, 'late and busy: late first');

  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const routed = [];
  const { link } = makeLink(api);
  try {
    assert.equal(link.parkedActivity(3, 'focus'), false, 'not linked: nothing');
    await link.start({ route: async (m) => { routed.push(m); return { ok: true, result: m.type === 'setWindowState' ? { windowId: m.windowId, state: m.state, landedAt: 5 } : null }; } });
    const hello = await app.next('hello');
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'req', id: 1, epoch: hello.epoch, windowId: 7, type: 'setWindowState', payload: { windowId: 7, state: 'normal', notAfter: 99 } });
    assert.deepEqual((await app.next('reply', { from, test: (m) => m.id === 1 })).result, { windowId: 7, state: 'normal', landedAt: 5 });
    assert.deepEqual(routed[0], { windowId: 7, state: 'normal', notAfter: 99, type: 'setWindowState' }, 'the payload as sent');
    app.send({ k: 'req', id: 2, epoch: hello.epoch, windowId: 7, type: 'frameProbe', payload: { windowId: 7, width: 1280, height: 800, frames: 6, nudgeMs: 80, timeoutMs: 400 } });
    app.send({ k: 'req', id: 3, epoch: hello.epoch, windowId: 7, type: 'windowDrafts', payload: { windowId: 7 } });
    app.send({ k: 'req', id: 4, epoch: hello.epoch, windowId: 7, type: 'parkedActivity', payload: { windowId: 7 } });
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 2 })).ok, true);
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 3 })).ok, true);
    assert.match((await app.next('reply', { from, test: (m) => m.id === 4 })).error, /not a request/, 'a word of the copy\'s isn\'t a request');
    assert.deepEqual(routed.map((m) => m.type), ['setWindowState', 'frameProbe', 'windowDrafts']);

    assert.equal(link.parkedActivity(3, 'tab', 44), true);
    assert.equal(link.parkedActivity(3, 'focus'), true);
    assert.equal(link.parkedActivity(3, 'raise'), false, 'a raise names its tab');
    assert.equal(link.parkedActivity(3, 'tab'), false, 'so does a tab\'s');
    assert.equal(link.parkedActivity(3, ('hover' as any), 1), false, 'a why not known');
    assert.equal(link.parkedActivity(-1, 'focus'), false, 'no window');
    const tab = await app.next('push', { from, test: (m) => m.msg?.type === 'parkedActivity' && m.msg.why === 'tab' });
    assert.deepEqual(tab, { k: 'push', epoch: hello.epoch, windowId: 3, msg: { type: 'parkedActivity', windowId: 3, tabId: 44, why: 'tab' } });
    const focus = await app.next('push', { from, test: (m) => m.msg?.type === 'parkedActivity' && m.msg.why === 'focus' });
    assert.deepEqual(focus.msg, { type: 'parkedActivity', windowId: 3, why: 'focus' }, 'no tab');
    await wait(50);
    assert.equal(app.received.slice(from).filter((m) => m.msg?.type === 'parkedActivity').length, 2, 'the refused ones sent nothing');
  } finally {
    link.stop();
    await app.close();
  }
});


// A pinch magnifies the page; its area stays the window's (shared/app-link.ts unpinchedSize). WebKit's own numbers,
// measured 2026-11-07 in a 1512 × 949 web view: pinched 3×, innerWidth 504, innerHeight 316, visualViewport
// 504 × 316.328125 at scale 3 (what made Margin draw its sidebar in a corner and drop the page's box).
test('a pinch: the page\'s area as before it, not a third of it', () => {
  assert.deepEqual(unpinchedSize({ innerWidth: 1512, innerHeight: 949, visualViewport: { width: 1512, height: 949, scale: 1 } }), { width: 1512, height: 949 }, 'unpinched: as it is');
  const pinched = unpinchedSize({ innerWidth: 504, innerHeight: 316, visualViewport: { width: 504, height: 316.328125, scale: 3 } });
  assert.ok(Math.abs(pinched.width - 1512) < 0.5 && Math.abs(pinched.height - 949) < 0.5, JSON.stringify(pinched));
  assert.deepEqual(unpinchedSize({ innerWidth: 800, innerHeight: 600 }), { width: 800, height: 600 }, 'no visual viewport: as it is');
  // The page's box from the pinched size, unpinched: the same box as unpinched.
  const layout = { insets: { left: 260, top: 8, right: 8, bottom: 8 } };
  const box = (inner) => boxFromLayout(layout, { outerWidth: 1512, outerHeight: 949, innerWidth: inner.width, innerHeight: inner.height });
  assert.deepEqual(box(pinched), box({ width: 1512, height: 949 }), 'the box doesn\'t change with a pinch');
  assert.notDeepEqual(box({ width: 504, height: 316 }), box({ width: 1512, height: 949 }), '(the raw pinched size would change it)');
});
