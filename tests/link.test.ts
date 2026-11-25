// background/link.ts, the extension's end of the link to Margin.app, against
// a fake app speaking docs/PROTOCOL.md over a real WebSocket on 127.0.0.1
// (tests/fake-app.ts), with a fake browser API: getting linked (the native
// port, wantLink and its nonce, the token, the app's key), hello, the
// snapshot, the theme in pieces, the keys, data.hello and the queue, ticks,
// requests run as the window's, deltas, windows, a resync, a drop and its reconnect, the app gone, a goodbye,
// and the data messages both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeApp } from './fake-app.ts';
import { fakeBrowser, type FakeBrowserApi } from './fake-browser.ts';
import type { Said } from '../extension/background/link.ts';

type FakeApp = Awaited<ReturnType<typeof startFakeApp>>;

globalThis.chrome = fakeBrowser({ runtime: { getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '2.0.0' }) } });
const { createLink, keyBindings, themePieces, SESSION_KEY, LINK_META, STATE_KEYS, APP_REQUESTS, WINDOW_CALLS, windowCallRefusal } = await import('../extension/background/link.ts');
const { APP_LINK_KEY, appDraws, drawsWindow } = await import('../extension/shared/app-link.ts');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => unknown, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(10);
  }
  return false;
}

function area(initial: Record<string, any> = {}) { // stored JSON
  const data = { ...initial };
  return {
    data,
    async get(keys?: string | string[] | null) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(values: Record<string, any>) { Object.assign(data, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]; },
  };
}

/** A fake browser API and the app's dispatches into it. `app`: the fake app (or null: none running). */
type FakePort = { posted: Said[], dead: boolean, deliver: (m: Said) => void, lose: () => void };
function browser({ app = null, appOpen = null, launching = false, local = {}, profile = undefined }: { app?: FakeApp | null, appOpen?: (() => boolean) | null, launching?: boolean, local?: Record<string, any>, profile?: string } = {}) {
  const ports: FakePort[] = [];
  const native: Said[] = [];
  const api = {
    runtime: {
      getURL: (p: string) => `safari-web-extension://test/${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      connectNative(): BrowserPort {
        const listeners: ((m: Said) => void)[] = [];
        const gone: (() => void)[] = [];
        // `lose()`: the port disconnects (its listeners told; posting throws from then on).
        const port = {
          posted: [] as Said[], dead: false, onMessage: { addListener: (cb: (m: Said) => void) => listeners.push(cb) }, onDisconnect: { addListener: (cb: () => void) => gone.push(cb) },
          postMessage(m: Said) { if (port.dead) throw new Error('disconnected'); port.posted.push(m); }, disconnect() {}, deliver: (m: Said) => listeners.forEach((cb) => cb(m)),
          lose() { port.dead = true; gone.forEach((cb) => cb()); },
        };
        ports.push(port);
        // A port as link.ts uses one (its events' addListener, postMessage, disconnect), with the test's own parts.
        return port as unknown as BrowserPort;
      },
      async sendNativeMessage(_: string, message: Said): Promise<Said> {
        native.push(message);
        const open = appOpen ? appOpen() : !!api.app;
        // The app answers on the port once it hears the nonce (the handler's notification).
        if (open && message.type === 'wantLink' && api.app) setTimeout(() => ports.at(-1)?.deliver(api.app!.linkInfo(message.nonce)), 5); // (api.app: checked)
        return { ok: true, appOpen: open, launching: !open && launching, ...(profile ? { profile } : {}) };
      },
    },
    storage: { local: area(local), session: area() },
    windows: { getAll: async () => api.windowList },
    // (sendMessage: a test's own, when it needs one.)
    tabs: { query: async () => [{ id: 13, windowId: 7, active: true }] } as { query: () => Promise<Partial<BrowserTab>[]>, sendMessage?: (tabId: number, message: Said) => Promise<unknown> },
    windowList: [{ id: 7, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: true }] as BrowserWindow[],
    app,
    ports,
    native,
  };
  return api;
}

const STATE = { spaces: [{ id: 's1', name: 'One' }], pins: [], folders: [], archive: [], settings: { theme: 'arcadia' }, favicons: { 'https://a.example': { data: 'data:a', at: 1 } }, openTabs: { tabs: {}, tabSpace: {}, activeSpaceByWindow: {} }, owner: { origin: 'o', since: 1 }, uiTheme: { id: 'big' }, 'dataMeta:spaces': {} };
const THEME = { id: 'arcadia', manifest: '{"id":"arcadia"}', html: '<div></div>', css: 'a{}'.repeat(300_000), files: { 'f.woff2': 'AAAA' } };
const FAST = { ping: 50, dead: 400, check: 50, linkWait: 500, openWait: 500, keptWait: 300, reconnect: [20, 40, 80], ask: [100, 400], gone: 300, windows: 50, layoutWrite: 10, launchAsk: 30, launchAsks: 5 };

type FakeApi = ReturnType<typeof browser>;
type Link = ReturnType<typeof createLink>;
// The data set's side as the link uses it, with what the test keeps of it.
type DataSide = NonNullable<Parameters<typeof createLink>[0]['data']>;
// (`emit`: the link's listener, set by its onChanges.)
type FakeData = DataSide & { queue: Said[], adopted: Parameters<DataSide['adopt']>[], taken: unknown[], emit?: (changes: any[]) => void };
function makeLink(api: FakeApi, { route = async (m: Said, sender: unknown) => ({ ok: true, result: { type: m.type, sender } }), data = null, owner = () => true, timing = FAST, now = undefined, Socket = globalThis.WebSocket }: { route?: Parameters<Link['start']>[0]['route'], data?: FakeData | null, owner?: () => boolean, timing?: Parameters<typeof createLink>[0]['timing'], now?: () => number, Socket?: unknown } = {}) {
  const changed: string[] = [];
  const fakeData: FakeData = data ?? {
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
    api: fakeBrowser(api), isOwner: owner, copy: () => ({ origin: 'safari-web-extension://test/', since: 1 }), instanceId: 'i1',
    WebSocket: Socket, ...(now ? { now } : {}), enabled: () => true, canSocket: () => true, data: fakeData,
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
  const sha = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const pieces = await themePieces(THEME, sha, 512 * 1024);
  const whole = Buffer.concat(pieces.sort((a, b) => a.part - b.part).map((p) => Buffer.from(p.data, 'base64')));
  assert.ok(pieces.length > 1 && pieces.every((p) => p.parts === pieces.length && p.size === whole.length && p.transfer === createHash('sha256').update(whole).digest('hex')));
  assert.ok(pieces.every((p) => Buffer.from(p.data, 'base64').length <= 512 * 1024), 'no piece over 512 KB of bytes');
  assert.deepEqual(JSON.parse(whole.toString('utf8')), THEME);
  assert.ok(appDraws({ state: 'linked' }) && appDraws({ state: 'reconnecting' }) && !appDraws({ state: 'off' }) && !appDraws(null));
  const undrawn = { state: 'linked', drawn: { 7: false, 8: true } };
  assert.ok(!drawsWindow(undrawn, 7) && drawsWindow(undrawn, 8) && drawsWindow(undrawn, 9) && drawsWindow(undrawn, null), 'drawn unless the app said not');
  assert.ok(!drawsWindow({ state: 'off', drawn: {} }, 8), 'not linked: none');
  assert.ok(STATE_KEYS.includes('openTabs') && !STATE_KEYS.includes('uiTheme'));
  for (const type of ['activateTab', 'navigate', 'openHere', 'search']) assert.ok(APP_REQUESTS.has(type), type);
  for (const type of ['hello', 'reloadForUpdate', 'getZoom', 'injectPage', 'fetchStyle']) assert.ok(!APP_REQUESTS.has(type), type);
});

test('link: the link in the extension handler\'s answer (the app\'s note): linked at once, with nothing dispatched; a stale or foreign one is never used', async () => {
  const app = await startFakeApp();
  // Safari's handler, answering from the app's note: the link in its reply, this copy's nonce.
  const answering = (nonce: string, patch = {}) => ({ ok: true, appOpen: true, launching: false, link: { ...JSON.parse(app.linkInfo(nonce).userInfo.e), ...patch } });
  // No dispatch ever comes (the fake browser's own sendNativeMessage would deliver one: replaced).
  const api = browser({ local: STATE });
  api.runtime.sendNativeMessage = async (_, message) => { api.native.push(message); return message.type === 'wantLink' ? answering(message.nonce) : { ok: true, appOpen: true }; };
  const { link } = makeLink(api);
  try {
    const t0 = Date.now();
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(link.linked(), 'linked');
    assert.ok(await app.next('hello'), 'said hello');
    assert.ok(Date.now() - t0 < 1000, `at once (${Date.now() - t0} ms)`);
    assert.equal(api.native.filter((m) => m.type === 'wantLink').length, 1, 'asked once');
    assert.equal(api.ports.flatMap((p) => p.posted).filter((m) => m.name === 'link').length, 0, 'nothing dispatched');
  } finally {
    await link.stop?.();
    await app.close();
  }
  // Another nonce's, or another version's: not taken (the copy waits for a dispatch that never comes: not linked).
  for (const patch of [{ nonce: 'someone-else' }, { v: 1 }, { port: 0 }]) {
    const other = await startFakeApp();
    const api2 = browser({ local: STATE });
    api2.runtime.sendNativeMessage = async (_, message) => (message.type === 'wantLink'
      ? { ok: true, appOpen: true, launching: false, link: { ...JSON.parse(other.linkInfo(message.nonce).userInfo.e), ...patch } } : { ok: true, appOpen: true });
    const { link: l2 } = makeLink(api2);
    try {
      await l2.start({ route: async () => ({ ok: true }) });
      assert.equal(l2.linked(), false, `not linked with ${JSON.stringify(patch)}`);
      assert.equal(other.received.length, 0, 'never connected');
    } finally {
      await l2.stop?.();
      await other.close();
    }
  }
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
    const hello = (await app.next('hello'))!;
    assert.equal(hello.v, 2);
    assert.match(hello.profile, /^[A-Za-z0-9_.:-]{1,64}$/);
    assert.equal(hello.browser, 'safari');
    assert.equal(hello.owner, true);
    assert.equal(app.received[0].k, 'hello', 'hello first');
    const snap = (await app.next('snapshot'))!;
    assert.equal(snap.epoch, hello.epoch);
    assert.equal(snap.seq, 1);
    assert.deepEqual(Object.keys(snap.state).sort(), Object.keys(STATE).filter((k) => STATE_KEYS.includes(k)).sort(), 'the state as pages read it, no theme package or data times');
    assert.deepEqual(snap.windows, [{ windowId: 7, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: true, activeTabId: 13 }]);
    assert.ok(await until(() => app.received.filter((m) => m.k === 'theme').length >= 2));
    const pieces = app.received.filter((m) => m.k === 'theme');
    const whole = Buffer.concat(pieces.sort((a, b) => a.part - b.part).map((p) => Buffer.from(p.data, 'base64')));
    assert.equal(createHash('sha256').update(whole).digest('hex'), pieces[0].transfer);
    assert.equal(JSON.parse(whole.toString()).id, 'arcadia');
    const keys = (await app.next('keys'))!;
    assert.deepEqual(keys.bindings['toggle-sidebar'], ['Alt+KeyK']);
    assert.deepEqual(keys.bindings['next-tab'], ['Alt+Meta+ArrowDown', 'Ctrl+Meta+ArrowDown'], 'Safari\'s Settings default and its command key');
    const dh = (await app.next('data.hello'))!;
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
    assert.equal((await app.next('hello'))!.profile, 'p-kept');
    const dh = (await app.next('data.hello'))!;
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
    const dh = (await app2.next('data.hello'))!;
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
    const hello = (await app.next('hello'))!;
    assert.equal(hello.profile, 's-3f2a', 'Safari\'s id');
    const dh = (await app.next('data.hello'))!;
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
    assert.equal((await app2.next('hello'))!.profile, 's-3f2a');
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

test('link: Safari refusing the native message (another copy of Margin\'s extension handler in use): asked again at the short busy wait, and linked as soon as the other one is idle', async () => {
  const app = await startFakeApp();
  const api = browser({ app });
  const at: number[] = [];
  let busy = true;
  const sendNative = api.runtime.sendNativeMessage;
  api.runtime.sendNativeMessage = async (id, message) => {
    if (message.type === 'wantLink') at.push(Date.now());
    if (busy && message.type === 'wantLink') throw new Error('Invalid call to runtime.sendNativeMessage(). Other version in use: <id<PKPlugIn>: 0x1; core = <[u 2C4884BB] [com.unibox.margin.Extension(0.1.1)]>');
    return sendNative(id, message);
  };
  // (The usual waits doubling from 150 ms, as on Safari from 5 s: the busy wait is the short one, 30 ms.)
  const { link } = makeLink(api, { timing: { ...FAST, ask: [150, 1200], busyAsk: 30, busyAsks: 5 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => at.length >= 4, 1000), `asked 4 times (${at.length})`);
    const gaps = at.slice(1, 4).map((t, i) => t - at[i]);
    assert.ok(gaps.every((g) => g < 120), `asked again at the busy wait, not doubling: ${gaps}`);
    busy = false;
    assert.ok(await until(() => link.linked(), 500), 'linked at the next busy ask once the other handler is idle');
  } finally {
    link.stop();
    await app.close();
  }
  // Busy past its count: as any other time (doubling).
  const api2 = browser({ app: null, appOpen: () => true });
  const at2: number[] = [];
  api2.runtime.sendNativeMessage = async (_, message) => {
    if (message.type === 'wantLink') at2.push(Date.now());
    throw new Error('Other version in use');
  };
  const { link: l2 } = makeLink(api2, { timing: { ...FAST, ask: [150, 1200], busyAsk: 30, busyAsks: 2 } });
  try {
    await l2.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => at2.length >= 5, 3000), `asked 5 times (${at2.length})`);
    const gaps = at2.slice(1, 5).map((t, i) => t - at2[i]);
    assert.ok(gaps[0] < 120 && gaps[1] < 120 && gaps[2] >= 150 && gaps[3] >= 290, `twice at the busy wait, then doubling: ${gaps}`);
  } finally {
    l2.stop();
  }
});

test('link: a copy no longer in charge (a newer copy of Margin claimed its profile\'s state) when its link drops: never reconnected or asked again, its link stopped', async () => {
  const app = await startFakeApp();
  const api = browser({ app });
  let owner = true;
  const { link } = makeLink(api, { owner: () => owner });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(await app.next('hello'), 'linked as the copy in charge');
    const hellos = () => app.received.filter((m) => m.k === 'hello').length;
    const asked = () => api.native.filter((m) => m.type === 'wantLink').length;
    const [h0, a0] = [hellos(), asked()];
    // (Another build's copy claimed the state; the app closes this copy's socket, as it does a hello with owner false.)
    owner = false;
    app.drop();
    await wait(600);
    assert.equal(hellos(), h0, 'no hello again (each would be closed by the app, and opened again at once)');
    assert.equal(asked(), a0, 'no wantLink again');
    assert.equal(app.open, 0, 'no socket open');
    assert.equal(link.linked(), false);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: Margin.app running but sending no link (one an update left): asked again at the short wait three times, then less and less often; pages told it isn\'t answering', async () => {
  const api = browser({ app: null, appOpen: () => true });
  const at: number[] = [];
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

test('link: ticks, requests as the window\'s, deltas, windows, resync', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const routed: { m: Said, sender: unknown }[] = [];
  const { link } = makeLink(api);
  try {
    await link.start({ route: async (m, sender) => { routed.push({ m, sender }); return m.type === 'closeTab' ? { ok: false, error: 'That tab is no longer open' } : { ok: true, result: { shown: 5 } }; } });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'tick', at: 1 });
    assert.ok(await app.next('tock', { from }));
    app.send({ k: 'req', id: 1, epoch: hello.epoch, windowId: 7, type: 'activateTab', payload: { tabId: 5, hint: { url: 'https://a' } }, at: 1 });
    const r1 = (await app.next('reply', { from, test: (m) => m.id === 1 }))!;
    assert.deepEqual(r1, { k: 'reply', id: 1, ok: true, result: { shown: 5 } });
    assert.deepEqual(routed[0].m, { type: 'activateTab', tabId: 5, hint: { url: 'https://a' }, windowId: 7 }, 'the window stands in for the page\'s');
    assert.deepEqual(routed[0].sender, { app: true, tab: { windowId: 7 } }, 'as sender.tab.windowId');
    app.send({ k: 'req', id: 2, epoch: hello.epoch, windowId: 7, type: 'closeTab', payload: { tabId: 9 } });
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 2 }))!.error, 'That tab is no longer open');
    app.send({ k: 'req', id: 3, epoch: 'old', windowId: 7, type: 'activateTab', payload: {} });
    assert.equal((await app.next('reply', { from, test: (m) => m.id === 3 }))!.ok, false, 'another epoch\'s: refused');
    app.send({ k: 'req', id: 4, epoch: hello.epoch, windowId: 7, type: 'injectPage', payload: {} });
    assert.match((await app.next('reply', { from, test: (m) => m.id === 4 }))!.error, /not a request/, 'only what the UI asks');
    assert.equal(routed.length, 2);
    // A change to stored values, and to the icons: a delta, icons as a diff.
    link.onStorage({ pins: { newValue: [{ id: 'p' }] }, favicons: { newValue: { 'https://a.example': { data: 'data:a', at: 1 }, 'https://b.example': { data: 'data:b', at: 2 } } }, 'dataMeta:pins': { newValue: {} } });
    const delta = (await app.next('delta', { from }))!;
    assert.equal(delta.seq, 2);
    assert.deepEqual(delta.changes, { pins: { newValue: [{ id: 'p' }] } });
    assert.deepEqual(delta.favicons, { set: { 'https://b.example': { data: 'data:b', at: 2 } }, del: [] });
    link.onStorage({ archive: {} });
    assert.deepEqual((await app.next('delta', { from, test: (m) => m.seq === 3 }))!.changes, { archive: {} }, 'a key removed');
    // A window resized: the list again, numbered on.
    api.windowList = [{ ...api.windowList[0], width: 1440 }];
    const win = (await app.next('windows', { from }))!;
    assert.equal(win.seq, 4);
    assert.equal(win.list[0].width, 1440);
    await wait(120);
    assert.equal(app.received.filter((m) => m.k === 'windows').length, 1, 'only on a change');
    // A window focused, one created: when the copy heard each, for the app to tell same-bounds windows apart.
    api.windowList = [...api.windowList, { id: 8, left: 0, top: 0, width: 1440, height: 800, state: 'fullscreen', focused: false }];
    link.windowCreated(8, 1_800_000_000_000);
    const created = (await app.next('windows', { from, test: (m) => m.list.length === 2 }))!;
    assert.equal(created.list[1].createdAt, 1_800_000_000_000);
    assert.ok(!('focusedAt' in created.list[1]) && !('createdAt' in created.list[0]), 'only what was heard');
    link.windowFocused(-1, 1_800_000_000_100); // WINDOW_ID_NONE: the browser left the front
    link.windowFocused(7, 1_800_000_000_200);
    const focused = (await app.next('windows', { from, test: (m) => m.list[0].focusedAt != null }))!;
    assert.equal(focused.list[0].focusedAt, 1_800_000_000_200);
    api.windowList = api.windowList.slice(0, 1);
    const from2 = app.received.length;
    link.windowClosed(8);
    assert.equal((await app.next('windows', { from: from2, test: (m) => m.list.length === 1 }))!.list[0].focusedAt, 1_800_000_000_200);
    // A gap on the app's side: the whole state again.
    const before = app.received.length;
    app.send({ k: 'resync', epoch: hello.epoch });
    const snap = (await app.next('snapshot', { from: before }))!;
    assert.ok(snap.seq > win.seq);
    app.send({ k: 'resync', epoch: 'old' });
    await wait(60);
    assert.equal(app.received.slice(before).filter((m) => m.k === 'snapshot').length, 1, 'not for another epoch');
    // A push for one window's UI.
    assert.ok(link.push(7, { type: 'palette', newTab: true }));
    assert.deepEqual((await app.next('push', { from }))!.msg, { type: 'palette', newTab: true });
    // Settings changed: the keys again; the theme changed: sent again.
    link.onStorage({ settings: { newValue: { sidebarShortcut: 'Alt+KeyJ' } } });
    assert.deepEqual((await app.next('keys', { from }))!.bindings['toggle-sidebar'], ['Alt+KeyJ']);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: drawn — whether the app draws over each window, kept for pages; dropped on a new epoch\'s hello and when off; a closed window\'s goes', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  api.windowList = [...api.windowList, { id: 8, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: false }];
  const { link } = makeLink(api, { timing: { ...FAST, dead: 10_000 } });
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = (await app.next('hello'))!;
    const told: [number, boolean][] = [];
    link.onDrawn((w, on) => told.push([w, on]));
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 7, on: true, at: 1 });
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 8, on: false, at: 1 });
    app.send({ k: 'drawn', epoch: 'old', windowId: 8, on: true, at: 1 });
    app.send({ k: 'drawn', epoch: hello.epoch, windowId: 8, on: false, at: 2 });
    const stored = () => api.storage.local.data[APP_LINK_KEY];
    assert.ok(await until(() => stored()?.drawn?.[8] === false && stored()?.drawn?.[7] === true));
    await wait(40);
    assert.deepEqual(told, [[7, true], [8, false]], 'a change only, this epoch\'s only');
    assert.equal(link.drawn(8), false);
    assert.equal(link.drawn(9), undefined, 'not said');
    assert.ok(link.drawsWindow(7) && !link.drawsWindow(8) && link.drawsWindow(9));
    assert.deepEqual(link.view().drawn, { 7: true, 8: false });
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
    const again = (await app.next('hello', { from }))!;
    assert.notEqual(again.epoch, hello.epoch);
    assert.ok(await until(() => stored()?.state === 'linked' && stored()?.epoch === again.epoch));
    assert.deepEqual(stored().drawn, {}, 'drawn: none said yet this epoch');
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
  // (Margin.app running but sending no link: the state stays as read for a while, then off.)
  const api = browser({ appOpen: () => true, local: { ...STATE, [APP_LINK_KEY]: { state: 'linked', epoch: 'e0', drawn: { 7: true, 41: false } } } });
  const writes: Record<string, any>[] = []; // what was written under APP_LINK_KEY (stored JSON)
  const set = api.storage.local.set.bind(api.storage.local);
  api.storage.local.set = async (values) => { if (values[APP_LINK_KEY]) writes.push(structuredClone(values[APP_LINK_KEY])); return set(values); };
  const { link } = makeLink(api);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => writes.length > 0));
    assert.equal(writes[0].state, 'reconnecting');
    assert.deepEqual(writes[0].drawn, { 7: true }, 'window 41 isn\'t open any more');
    assert.ok(await until(() => writes.at(-1)!.state === 'off', 3000), 'no link: off');
    assert.deepEqual(writes.at(-1)!.drawn, {}, 'off: nothing of the windows kept');
  } finally {
    link.stop();
  }
});

test('link: the copy\'s blur on each window\'s entry; focus and flags in Margin.app\'s log; none of the overlay\'s fields', async () => {
  const T0 = Date.now() - 60_000; // before now
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  // (A link that stays up: on a busy machine FAST's 400 ms `dead` drops it, and what follows comes in a new link's snapshot.)
  const { link } = makeLink(api, { timing: { ...FAST, dead: 10_000 } });
  try {
    await link.start({ route: async () => ({ ok: true, result: null }) });
    await app.next('hello');
    await app.next('data.hello');
    const logged = () => api.ports.flatMap((p) => p.posted).filter((m) => m.type === 'log').map((m) => m.line);
    // WINDOW_ID_NONE: the copy's blur, on each of its windows; both focus events in the log.
    const from = app.received.length;
    link.windowFocused(-1, T0 + 600);
    let win = (await app.next('windows', { from, test: (m) => m.list[0].blurredAt != null }))!;
    assert.equal(win.list[0].blurredAt, T0 + 600);
    link.windowFocused(7, T0 + 700);
    win = (await app.next('windows', { from, test: (m) => m.list[0].focusedAt === T0 + 700 }))!;
    assert.equal(win.list[0].blurredAt, T0 + 600, 'kept: the last blur heard');
    for (const field of ['viewport', 'viewportTimes', 'visible', 'visibleAt', 'pageFullscreen', 'wasParked']) assert.ok(!(field in win.list[0]), `${field}: no longer sent`);
    assert.ok(await until(() => logged().some((l) => /^focus heard: none \(WINDOW_ID_NONE\) at \d\d:\d\d:\d\d\.\d{3}$/.test(l)) && logged().some((l) => /^focus heard: window 7 at /.test(l))), `${logged()}`);
    assert.ok(await until(() => logged().some((l) => /^windows report at [\d:.]+: 7 focused \(focus heard [\d:.]+\); blur heard [\d:.]+$/.test(l)), 1500), `${logged().filter((l) => l.startsWith('windows report'))}`);
    const reports = logged().filter((l) => l.startsWith('windows report')).map((l) => Number(/at (\d\d):(\d\d):(\d\d)\.(\d{3})/.exec(l)?.slice(1).reduce((a, x, i) => a + Number(x) * [3600e3, 60e3, 1e3, 1][i], 0)));
    assert.ok(reports.every((t, i) => i === 0 || t - reports[i - 1] >= 990), `the flags' line at most once a second: ${logged().filter((l) => l.startsWith('windows report'))}`);
    assert.ok(!logged().some((l) => /https?:|example/.test(l)), 'ids and times only');
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
    const first = (await app.next('hello'))!;
    // The app stops ticking: dropped after `dead`, tried again with the kept link.
    const from = app.received.length;
    assert.ok(await until(() => changed.includes('reconnecting'), 1500), 'reconnecting after no tick for the limit');
    assert.ok(await until(() => link.linked(), 1500), 'linked again');
    const again = (await app.next('hello', { from }))!;
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
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'data.need', epoch: hello.epoch, all: true });
    const snap = (await app.next('data.snapshot', { from }))!;
    assert.equal(snap.profile, hello.profile);
    assert.equal(snap.format, 1);
    assert.ok(snap.set.items.spaces.s1);
    assert.deepEqual([snap.part, snap.parts, typeof snap.transfer], [0, 1, 'string'], 'whole, as one part');
    // A change of this copy's after its data.hello: merged on top of the app's set when it comes.
    data.emit!([{ collection: 'spaces', id: 's1', updatedAt: 99, value: { name: 'Mine' } }]);
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: hello.profile, format: 1, transfer: 't1', part: 1, parts: 2, set: { format: 1, items: { pins: { p: { updatedAt: 2, value: {} } } } } });
    app.send({ k: 'data.snapshot', epoch: 'another', format: 1, transfer: 't1', part: 0, parts: 2, set: { format: 1, items: {} } });
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: 'p-another', format: 1, transfer: 't1', part: 0, parts: 2, set: { format: 1, items: {} } });
    await wait(40);
    assert.equal(data.adopted.length, 0, 'not before every part is here (another epoch\'s or profile\'s don\'t count)');
    app.send({ k: 'data.snapshot', epoch: hello.epoch, profile: hello.profile, format: 1, transfer: 't1', part: 0, parts: 2, rev: '3-abc', omitted: [['userThemes', 'big']], set: { format: 1, items: { spaces: { a: { updatedAt: 1, value: {} } }, folders: {}, userThemes: {} } } });
    assert.ok(await until(() => data.adopted.length === 1));
    const [set, options] = data.adopted[0];
    assert.deepEqual(Object.keys(set.items).sort(), ['folders', 'pins', 'spaces', 'userThemes'], 'the parts put together, an empty collection too');
    assert.deepEqual(options!.omitted, [['userThemes', 'big']], 'what the app left out, kept as this copy has it');
    assert.deepEqual(options!.changes!.map((c) => c.id), ['s1'], 'this copy\'s change since its hello, merged on top');
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
    data.emit!([{ collection: 'spaces', id: 's1', updatedAt: 100, value: { name: 'Two' } }]);
    const ch = (await app.next('data.changes', { from, test: (m) => m.changes[0]?.updatedAt === 100 }))!;
    assert.deepEqual(ch.changes, [{ collection: 'spaces', id: 's1', updatedAt: 100, value: { name: 'Two' } }]);
    assert.equal(ch.profile, hello.profile);
  } finally {
    link.stop();
    await app.close();
  }
});

test('link: no socket from a worker', async () => {
  const api = browser({ app: null, appOpen: () => true });
  const link = createLink({ api: fakeBrowser(api), isOwner: () => true, copy: () => ({ origin: 'o', since: 1 }), WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => false, log: () => {}, timing: FAST });
  await link.start({ route: async () => ({ ok: true }) });
  assert.equal(api.native.length, 0, 'not even asked: the app would link to nothing');
  link.stop();
});

// The socket guard (DECISIONS.md "Margin 2: Safari reliability"): a note left by a background that
// never got past opening a socket turns sockets off for that Safari session; found again in a later
// session, for 24 h; never "until another version" (every build is 0.1.0). A new Safari session is
// a browser() with the same storage.local and an empty storage.session.
const nextSession = (api: FakeApi, app: FakeApp | null, change = {}) => browser({ app, local: { ...structuredClone(api.storage.local.data), ...change } });
const logLines = (api: FakeApi) => api.ports.flatMap((p) => p.posted.filter((m) => m.type === 'log').map((m) => m.line));

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
    const hello = (await app.next('hello'))!;
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
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
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
  const started: Link[] = [];
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
const pause = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };

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
  let ticking: Timer | null = setInterval(() => app.send({ k: 'tick', at: Date.now() }), 100);
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

test('link: the app\'s windows calls — its requests taken, the removed ones refused, the windows calls\' refusals', async () => {
  for (const type of ['setWindowState', 'closeWindow', 'newWindow', 'hostShow', 'hostClose', 'hostFocusWindow']) assert.ok(APP_REQUESTS.has(type), type);
  for (const type of ['parked', 'parkedActivity', 'frameProbe', 'windowDrafts', 'focusWindow', 'openSpaceWindow', 'orderSpaces', 'paletteDropped', 'devTabMoveProbe', 'framed']) assert.ok(!APP_REQUESTS.has(type), type);
  assert.deepEqual([...WINDOW_CALLS].sort(), ['closeWindow', 'hostFocusWindow', 'setWindowState']);
  for (const type of WINDOW_CALLS) assert.ok(APP_REQUESTS.has(type), type);

  const none = new Set();
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 1000 }, none, 1210), { refused: 'late', pastMs: 210 }, 'past notAfter');
  assert.equal(windowCallRefusal({ windowId: 3, notAfter: 1000 }, none, 1000), null, 'at notAfter: still in time');
  assert.equal(windowCallRefusal({ windowId: 3 }, none, 1e15), null, 'no notAfter (today\'s switch): never late');
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 2000 }, new Set([3]), 1000), { busy: true }, 'a call for that window pending');
  assert.equal(windowCallRefusal({ windowId: 4, notAfter: 2000 }, new Set([3]), 1000), null, 'another window\'s pending: runs');
  assert.deepEqual(windowCallRefusal({ windowId: 3, notAfter: 1000 }, new Set([3]), 1500), { refused: 'late', pastMs: 500 }, 'late and busy: late first');

  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const routed: Said[] = [];
  const { link } = makeLink(api);
  try {
    await link.start({ route: async (m) => { routed.push(m); return { ok: true, result: m.type === 'setWindowState' ? { windowId: m.windowId, state: m.state, landedAt: 5 } : null }; } });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send({ k: 'req', id: 1, epoch: hello.epoch, windowId: 7, type: 'setWindowState', payload: { windowId: 7, state: 'normal', notAfter: 99 } });
    assert.deepEqual((await app.next('reply', { from, test: (m) => m.id === 1 }))!.result, { windowId: 7, state: 'normal', landedAt: 5 });
    assert.deepEqual(routed[0], { windowId: 7, state: 'normal', notAfter: 99, type: 'setWindowState' }, 'the payload as sent');
    app.send({ k: 'req', id: 2, epoch: hello.epoch, windowId: 7, type: 'frameProbe', payload: { windowId: 7, width: 1280, height: 800 } });
    app.send({ k: 'req', id: 3, epoch: hello.epoch, windowId: 7, type: 'windowDrafts', payload: { windowId: 7 } });
    assert.match((await app.next('reply', { from, test: (m) => m.id === 2 }))!.error, /not a request/, 'the handoff\'s probe: gone');
    assert.match((await app.next('reply', { from, test: (m) => m.id === 3 }))!.error, /not a request/, 'its drafts too');
    assert.deepEqual(routed.map((m) => m.type), ['setWindowState']);
  } finally {
    link.stop();
    await app.close();
  }
});


// ---- requests end on evidence, a slow copy never sticks (docs/LINK-RESILIENCE.md §1 rules 11–14, §2 rules 5–7) ----

const { createHostedTabs } = await import('../extension/background/hosted.ts');
// The app's ticks every 100 ms (FAST's dead is 400 ms), for a test that waits on the copy.
const ticks = (app: FakeApp) => setInterval(() => app.send({ k: 'tick', at: Date.now() }), 100);
const replies = (app: FakeApp, from: number, id: number) => app.received.slice(from).filter((m) => m.k === 'reply' && m.id === id);
const req = (epoch: string, id: number, type: string, payload: Said, windowId: number | null = 7) => ({ k: 'req', id, epoch, windowId, type, payload, at: Date.now() });

test('link: a req is acked before its handler resolves; a repeated id runs once, and once answered gets its reply again; a tick\'s number is echoed', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link } = makeLink(api);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const routed: Said[] = [];
  const ticking = ticks(app);
  try {
    await link.start({ route: async (m) => { routed.push(m); await gate; return { ok: true, result: { shown: m.itemId } }; } });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    const show = req(hello.epoch, 1, 'hostShow', { windowId: 7, itemId: 'a', url: 'https://a.example/' });
    app.send(show);
    assert.deepEqual(await app.next('ack', { from }), { k: 'ack', id: 1 }, 'acked at once');
    assert.equal(replies(app, from, 1).length, 0, 'before its handler resolved');
    app.send(show); // the app sending it again (read past: §1 rule 4)
    assert.ok(await until(() => app.received.slice(from).filter((m) => m.k === 'ack').length === 2), 'acked again');
    await wait(50);
    assert.equal(routed.length, 1, 'a repeated id that\'s running: left, its reply comes');
    release();
    assert.ok(await until(() => replies(app, from, 1).length === 1));
    assert.deepEqual(replies(app, from, 1)[0], { k: 'reply', id: 1, ok: true, result: { shown: 'a' } });
    assert.ok(app.tooks.length > 0, 'its reply says the copy\'s own time on it (`took`, ms)');
    app.send(show);
    assert.ok(await until(() => replies(app, from, 1).length === 2), 'answered already: its reply again');
    assert.deepEqual(replies(app, from, 1)[1], replies(app, from, 1)[0]);
    assert.equal(routed.length, 1, 'run once');
    app.send({ k: 'req', id: 2, epoch: 'old', windowId: 7, type: 'activateTab', payload: {} });
    assert.ok(await app.next('ack', { from, test: (m) => m.id === 2 }), 'every req read is acked, even one refused');
    app.send({ k: 'tick', at: 1, seq: 4 });
    assert.equal((await app.next('tock', { from, test: (m) => m.seq != null }))!.seq, 4, 'the tick\'s number, echoed');
    assert.ok(app.received.slice(from).some((m) => m.k === 'tock' && !('seq' in m)), 'an older app\'s tick: a tock with none');
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});

test('link: cancel — a req not started yet (held after a pause) is dropped; one under way stops at its next check; neither is answered', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link } = makeLink(api);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const routed: number[] = [];
  const checks: boolean[] = [];
  const ticking = ticks(app);
  try {
    await link.start({ route: async (m, sender) => { routed.push(m.n); if (m.n === 1) { await gate; checks.push(sender.stopped()); } return { ok: true }; } });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send(req(hello.epoch, 1, 'hostShow', { n: 1, windowId: 7, itemId: 'a', url: 'https://a.example/' }));
    await app.next('ack', { from });
    app.send({ k: 'cancel', id: 1 });
    await wait(60);
    release();
    await wait(100);
    assert.deepEqual(checks, [true], 'under way: its check says stop');
    assert.equal(replies(app, from, 1).length, 0, 'and it isn\'t answered');
    app.send(req(hello.epoch, 2, 'hostShow', { n: 2, windowId: 7, itemId: 'b', url: 'https://b.example/' }));
    app.send({ k: 'cancel', id: 2 });
    pause(700); // both queued in the socket: read after the pause, the queue first
    await wait(300);
    assert.ok(app.received.slice(from).some((m) => m.k === 'ack' && m.id === 2), 'acked as it was read');
    assert.deepEqual(routed, [1], 'not started: dropped');
    assert.equal(replies(app, from, 2).length, 0, 'and answered nothing');
    assert.ok(link.linked());
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});

// (2026-11-25, measured on the real Mac: shows overlapping in one window, every 110 ms of a held key, each took Safari
// ~210 ms and none was drawn until the run ended; one at a time each took 25-40 ms.)
test('link: hostShows for one window run one at a time — the running one finishes, one overtaken while it waits answers overtaken with no Safari call, the newest runs after', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link } = makeLink(api);
  const calls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let gated = true;
  let next = 100;
  const tabs = [{ id: 1, windowId: 9, url: 'https://other.example/', active: true }];
  const hosted = createHostedTabs(() => ({
    async get(id: number) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('no tab'); return { ...t }; },
    async query({ windowId }: { windowId?: number }) { if (gated) { gated = false; await gate; } return tabs.filter((t) => windowId == null || t.windowId === windowId); },
    async create({ windowId, url }: { windowId: number, url: string, active: boolean }) { calls.push(`create ${url}`); const t = { id: next++, windowId, url, active: true }; tabs.push(t); return { ...t }; },
    async update(id: number, { url }: { url?: string }) { calls.push(`update ${id}${url ? ` ${url}` : ''}`); return { ...tabs.find((t) => t.id === id)! }; },
    async remove(id: number) { calls.push(`remove ${id}`); },
  }));
  const ticking = ticks(app);
  try {
    await link.start({ route: async (m, sender) => hosted.show(m, sender.stopped).then((result) => ({ ok: true, result }), (err) => ({ ok: false, error: String(err?.message ?? err) })) });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send(req(hello.epoch, 1, 'hostShow', { windowId: 9, itemId: 'a', url: 'https://a.example/' }, null));
    await app.next('ack', { from, test: (m) => m.id === 1 });
    app.send(req(hello.epoch, 2, 'hostShow', { windowId: 9, itemId: 'b', url: 'https://b.example/' }, null));
    await app.next('ack', { from, test: (m) => m.id === 2 });
    app.send(req(hello.epoch, 3, 'hostShow', { windowId: 9, itemId: 'c', url: 'https://c.example/' }, null));
    await app.next('ack', { from, test: (m) => m.id === 3 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(calls, [], 'the newer ones wait for the one running (its Safari call under way)');
    assert.equal(replies(app, from, 2).length + replies(app, from, 3).length, 0);
    release();
    assert.ok(await until(() => replies(app, from, 3).length === 1), 'the newest shown after it');
    assert.equal(replies(app, from, 1)[0]?.ok, true, 'the running one finished: its tab shown');
    assert.deepEqual(replies(app, from, 2)[0], { k: 'reply', id: 2, ok: false, error: 'overtaken' }, 'overtaken while it waited');
    assert.equal(replies(app, from, 3)[0].ok, true);
    assert.deepEqual(calls, ['create https://a.example/', 'create https://c.example/'], 'one at a time; the overtaken one never reached Safari');
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});

test('link: after a detected pause, a show and a newer show for that window queued together: only the newer runs', async () => {
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link } = makeLink(api);
  const routed: Said[] = [];
  const ticking = ticks(app);
  try {
    await link.start({ route: async (m) => { routed.push(m); return { ok: true, result: { tabId: 5 } }; } });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    const from = app.received.length;
    app.send(req(hello.epoch, 1, 'hostShow', { windowId: 7, itemId: 'a', url: 'https://a.example/' }));
    app.send(req(hello.epoch, 2, 'hostShow', { windowId: 8, itemId: 'c', url: 'https://c.example/' }));
    app.send(req(hello.epoch, 3, 'hostShow', { windowId: 7, itemId: 'b', url: 'https://b.example/' }));
    pause(700);
    assert.ok(await until(() => [1, 2, 3].every((id) => replies(app, from, id).length === 1)), 'each answered');
    assert.deepEqual(routed.map((m) => m.itemId), ['c', 'b'], 'the newest of window 7, and window 8\'s');
    assert.deepEqual(replies(app, from, 1)[0], { k: 'reply', id: 1, ok: false, error: 'overtaken' });
    assert.ok(logLines(api).some((l) => /^paused 0\.\d s \(a link check ran late\)/.test(l)));
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});

test('link: waits advanced by events — an extension event runs the ask that was due, not its late timer', async () => {
  const api = browser({ app: null }); // Margin.app not running: each ask paced
  let offset = 0;
  const { link } = makeLink(api, { now: () => performance.now() + offset, timing: { ...FAST, ask: [5000, 60_000] } });
  const asks = () => api.native.filter((m) => m.type === 'wantLink').length;
  try {
    await link.start({ route: async () => ({ ok: true }) });
    assert.equal(asks(), 1);
    link.windowFocused(7);
    await wait(50);
    assert.equal(asks(), 1, 'not due yet: an event changes nothing');
    offset += 5000; // 5 s gone for the copy, its timer not run (the background's loop late)
    link.windowFocused(7);
    assert.ok(await until(() => asks() === 2, 300), 'asked at the event');
    offset += 10_000;
    link.due(); // (tabs.onUpdated, runtime.onMessage: background.ts)
    assert.ok(await until(() => asks() === 3, 300), 'and at any other event');
  } finally {
    link.stop();
  }
});

test('link: a welcome wait whose timer ran late doesn\'t give up (the welcome then taken); one on time does', async () => {
  const app = await startFakeApp();
  // A socket the test drives: it opens and says welcome when told.
  class Sock {
    static made: Sock[] = [];
    readyState = 0;
    sent: Said[] = [];
    closed: string | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number, reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;
    constructor(url: string) { this.url = url; Sock.made.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    close(_code: number, reason: string) { this.closed = reason; this.readyState = 3; }
    welcome() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ k: 'welcome', v: 2, key: app.key }) }); }
  }
  const links: Link[] = [];
  try {
    // Late: 1 s gone for the copy while its 500 ms wait ran (over 1.5×): re-armed, and the welcome that comes is taken.
    let offset = 0;
    const api = browser({ app, local: STATE });
    const { link } = makeLink(api, { now: () => performance.now() + offset, Socket: Sock });
    links.push(link);
    void link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => Sock.made.length === 1, 1000));
    await wait(100);
    offset += 1000;
    await wait(550); // its timer ran (late)
    Sock.made[0].welcome();
    assert.ok(link.linked(), 'linked');
    assert.equal(Sock.made[0].closed, null);
    assert.ok(!logLines(api).some((l) => l.includes('no welcome within')), `${logLines(api)}`);
    assert.equal(Sock.made[0].sent[0]?.k, 'hello');
    link.stop();
    // On time: given up.
    const api2 = browser({ app, local: STATE });
    const { link: l2 } = makeLink(api2, { Socket: Sock });
    links.push(l2);
    void l2.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => Sock.made.length === 2, 1000));
    assert.ok(await until(() => Sock.made[1].closed != null, 1000), 'closed');
    assert.ok(logLines(api2).some((l) => l.includes('no welcome within 500 ms (slow)')), `${logLines(api2)}`);
    assert.ok(!l2.linked());
  } finally {
    for (const l of links) l.stop();
    await app.close();
  }
});

test('link: the copy\'s answers to the shared link vectors (tests/fixtures/link-protocol.json)', async () => {
  const { readFileSync } = await import('node:fs');
  const v = JSON.parse(readFileSync(new URL('./fixtures/link-protocol.json', import.meta.url), 'utf8'));
  const app = await startFakeApp();
  const api = browser({ app, local: STATE });
  const { link } = makeLink(api);
  const ticking = ticks(app);
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = (await app.next('hello'))!;
    await app.next('data.hello');
    for (const c of v.answers) {
      const from = app.received.length;
      app.send({ ...c.app, ...(c.app.k === 'req' ? { epoch: hello.epoch } : {}) });
      const got = await app.next(c.copy.k, { from, test: (m) => Object.entries(c.copy).every(([k, x]) => m[k] === x) && !(c.none ?? []).some((k: string) => k in m) });
      assert.ok(got, c.about);
    }
  } finally {
    clearInterval(ticking);
    link.stop();
    await app.close();
  }
});
