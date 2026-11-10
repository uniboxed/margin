// background/link.ts in Chrome's build (Chrome and Edge on the Mac, docs/PROTOCOL.md "Transport (Chrome and Edge, on
// the Mac)"): the same link as Safari's, found through Margin.app's relay helper. Its socket opened from the service
// worker, no socket guard, the browser's process (the relay's word) and Edge told apart in hello, the process kept
// with the link through the worker starting again; and where the Chrome build links at all (shared/platform.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApp } from './fake-app.ts';

// Chrome's build, as detected (shared/platform.ts detect): its own scheme.
globalThis.chrome = { runtime: { getURL: (p: string) => `chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec/${p}`, getManifest: () => ({ version: '2.0.0' }) } } as any;
const setAgent = (userAgent: string) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const MAC_EDGE = `${MAC_CHROME} Edg/153.0.0.0`;
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
setAgent(MAC_CHROME);
const { createLink, SESSION_KEY } = await import('../extension/background/link.ts');
const { platform, linksApp, browserName } = await import('../extension/shared/platform.ts');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function area(initial: Record<string, any> = {}) {
  const data: Record<string, any> = { ...initial };
  return {
    data,
    async get(keys: string | string[] | null) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(values: Record<string, any>) { Object.assign(data, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]; },
  };
}

// Chrome's API as the relay helper answers it: a reply with the browser's process, then the link dispatched into
// the lasting port (as Safari's dispatchMessage would deliver it).
function chromium(app: any, { pid = 4242 } = {}) {
  const ports: any[] = [];
  const native: any[] = [];
  const api: any = {
    runtime: {
      getURL: (p: string) => `chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec/${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      connectNative() {
        const listeners: any[] = [];
        const port = {
          posted: [] as any[], onMessage: { addListener: (cb: any) => listeners.push(cb) }, onDisconnect: { addListener: () => {} },
          postMessage(m: any) { port.posted.push(m); }, disconnect() {}, deliver: (m: any) => listeners.forEach((cb) => cb(m)),
        };
        ports.push(port);
        return port;
      },
      async sendNativeMessage(_: string, message: any) {
        native.push(message);
        if (message.type === 'wantLink') setTimeout(() => ports.at(-1)?.deliver(app.linkInfo(message.nonce)), 5);
        return { ok: true, appOpen: true, launching: false, browser: 'chrome', pid };
      },
    },
    storage: { local: area(), session: area() },
    windows: { getAll: async () => [{ id: 7, left: 0, top: 0, width: 1280, height: 800, state: 'fullscreen', focused: true }] },
    tabs: { query: async () => [{ id: 13, windowId: 7, active: true }] },
    ports,
    native,
  };
  return api;
}

const FAST = { ping: 50, dead: 2000, check: 50, linkWait: 500, openWait: 500, keptWait: 300, reconnect: [20, 40, 80], ask: [100, 400], gone: 300, windows: 50, layoutWrite: 10 };
// Chrome's defaults for canSocket and the socket guard (no override), in a service worker (no document).
const makeLink = (api: any) => createLink({
  api, isOwner: () => true, copy: () => ({ origin: 'chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec/', since: 1 }), instanceId: 'i1',
  WebSocket: globalThis.WebSocket, enabled: () => true, log: () => {}, timing: FAST,
});

test('Chrome\'s build: it links on the Mac only, and names Chrome or Edge', () => {
  assert.equal(platform.name, 'chrome');
  setAgent(MAC_CHROME);
  assert.equal(linksApp(), true);
  assert.equal(browserName(), 'chrome');
  setAgent(MAC_EDGE);
  assert.equal(linksApp(), true);
  assert.equal(browserName(), 'edge');
  setAgent(WINDOWS_CHROME);
  assert.equal(linksApp(), false, 'not on Windows (yet)');
  setAgent(MAC_CHROME);
});

test('a Chrome copy links from its service worker through the relay: hello says chrome and the browser\'s process, and no socket guard', async () => {
  const app = await startFakeApp();
  const api = chromium(app);
  const link = makeLink(api);
  try {
    assert.equal(typeof (globalThis as any).document, 'undefined', 'a worker, as Chrome\'s background is');
    await link.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    assert.ok(hello, 'linked');
    assert.equal(hello.browser, 'chrome');
    assert.equal(hello.pid, 4242);
    assert.ok(/^p-[A-Za-z0-9]{20}$/.test(hello.profile), 'its own profile id (Chromium gives none)');
    assert.deepEqual(api.native.map((m: any) => m.type), ['wantLink']);
    assert.deepEqual(Object.keys(api.storage.local.data).filter((k) => /^appLink(Opening|Off|Hung)$/.test(k)), [], 'no socket guard notes');
    assert.equal(api.storage.session.data[SESSION_KEY].pid, 4242, 'the process kept with the link');
  } finally {
    link.stop();
    await app.close();
  }
});

test('a Chrome copy in Edge says edge; one started again links with its kept link and the process it kept', async () => {
  setAgent(MAC_EDGE);
  const app = await startFakeApp();
  const api = chromium(app, { pid: 5151 });
  const first = makeLink(api);
  let second: any = null;
  try {
    await first.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    assert.equal(hello.browser, 'edge');
    assert.equal(hello.pid, 5151);
    // The worker torn down and started again (Chrome does that): the kept link first, no wantLink.
    const asked = api.native.length;
    second = makeLink(api);
    await second.start({ route: async () => ({ ok: true }) });
    const again = await app.next('hello', { from: app.received.indexOf(hello) + 1 });
    assert.ok(again, 'linked again');
    assert.equal(again.browser, 'edge');
    assert.equal(again.pid, 5151, 'from the kept link');
    assert.equal(api.native.length, asked, 'no wantLink: the kept link opened');
  } finally {
    second?.stop();
    first.stop();
    await wait(10);
    await app.close();
    setAgent(MAC_CHROME);
  }
});
