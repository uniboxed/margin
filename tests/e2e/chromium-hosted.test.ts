// Chrome and Edge hosted like Safari (docs/HOSTED-WINDOWS-CHROMIUM.md §3.2), end to end: the real Chromium build in
// Chrome for Testing (headless), linked through the real connector to a stand-in app (as chromium-relay.test.ts), which
// asks the copy what Margin.app asks of a hosted window: a window made for it with a mark (its tab's title carries the
// mark), an item shown there (the marked page replaced), the item's picture, the window put in full screen by the app
// (and kept there: Chromium's own "Margin full screen" leaves a hosted window alone), its tab closed, the window closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildTo } from '../../scripts/build.ts';
import { startFakeApp } from '../fake-app.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ID = 'njeebbcmlenfopaecfbphgcfihbdmkec';

// Margin.app's connector socket (RelayLink.swift's words), as chromium-relay.test.ts has it.
function relaySocket(path: string, app: Awaited<ReturnType<typeof startFakeApp>>) {
  const relays = new Set<{ socket: import('node:net').Socket, send: (m: unknown) => void, hello: any }>();
  const server = createNetServer((socket) => {
    let buffer = '';
    let hello: any = null;
    const send = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!hello) {
          hello = line;
          relays.add({ socket, send, hello });
          send({ k: 'relayWelcome', v: 1, version: line.version });
          continue;
        }
        const msg = line.msg;
        send({ ok: true, appOpen: true, launching: false, browser: hello.browser, pid: hello.pid });
        if (msg?.type === 'wantLink') for (const r of relays) if (r.hello.pid === hello.pid) r.send(app.linkInfo(msg.nonce));
      }
    });
    socket.on('close', () => { for (const r of relays) if (r.socket === socket) relays.delete(r); });
    socket.on('error', () => {});
  });
  return new Promise<{ close: () => Promise<void> }>((resolve) => server.listen(path, () => resolve({
    close: () => new Promise((done) => { for (const r of relays) r.socket.destroy(); server.close(() => done()); }),
  })));
}

// One page to show as an item: a plain, opaque page.
async function site() {
  const server: Server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Item page</title><body style="background:#2a6;margin:0;height:100vh">item</body>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/item`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Chrome hosted: a marked window, an item shown in it, its picture, full screen kept, its tab and window closed', { timeout: 180_000, skip: process.platform !== 'darwin' && 'the Mac only (the build links where its user agent says Mac or Windows)' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'margin-hosted-'));
  const app = await startFakeApp();
  const page = await site();
  let context: any = null;
  let relay: { close: () => Promise<void> } | null = null;
  try {
    const ext = join(root, 'ext');
    buildTo(ext, { profile: 'chrome', manifest: 'chrome' });
    const cargo = process.env.CARGO ?? (existsSync(join(homedir(), '.cargo/bin/cargo')) ? join(homedir(), '.cargo/bin/cargo') : 'cargo');
    execFileSync(cargo, ['build', '-q', '--release', '-p', 'margin-connector', '--manifest-path', join(ROOT, 'Cargo.toml')], { stdio: 'ignore' });
    const binary = join(ROOT, 'target/release/margin-connector');
    const socketPath = join(root, 'r.sock');
    relay = await relaySocket(socketPath, app);
    const userData = join(root, 'profile');
    mkdirSync(join(userData, 'NativeMessagingHosts'), { recursive: true });
    const host = join(root, 'host.sh');
    writeFileSync(host, `#!/bin/sh\nMARGIN_CONNECTOR_SOCKET="${socketPath}" MARGIN_CONNECTOR_NO_LAUNCH=1 exec "${binary}" "$@"\n`);
    chmodSync(host, 0o755);
    writeFileSync(join(userData, 'NativeMessagingHosts', 'com.unibox.margin.json'), JSON.stringify({
      name: 'com.unibox.margin', description: 'Margin e2e connector', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`],
    }));
    context = await chromium.launchPersistentContext(userData, {
      headless: false,
      viewport: null,
      args: ['--headless=new', '--window-size=1280,800', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const hello = await app.next('hello', { ms: 20_000 });
    assert.ok(hello, 'linked');
    assert.equal(hello.browser, 'chrome');

    // The app's requests and their replies.
    let id = 0;
    const ask = async (type: string, payload: Record<string, unknown>, windowId: number | null = null) => {
      const n = ++id;
      const from = app.received.length;
      app.send({ k: 'req', id: n, epoch: hello.epoch, windowId, type, payload });
      const reply = await app.next('reply', { from, test: (m) => m.id === n, ms: 10_000 });
      assert.ok(reply, `${type}: answered`);
      assert.equal(reply.ok, true, `${type}: ${reply.error ?? ''}`);
      return reply.result;
    };
    const until = async <T>(what: string, check: () => Promise<T>, ms = 10_000): Promise<T> => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await check();
        if (v) return v;
        if (Date.now() > end) assert.fail(`not within ${ms} ms: ${what}`);
        await sleep(50);
      }
    };
    const tabsOf = (windowId: number) => worker.evaluate((w: number) => chrome.tabs.query({ windowId: w }).then((ts) => ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', title: t.title ?? '' }))), windowId);
    const stateOf = (windowId: number) => worker.evaluate((w: number) => chrome.windows.get(w).then((x) => x.state), windowId);

    // A window made for the app, marked: its tab's title carries the mark (what Windows finds it by).
    const mark = 'e2eMark1234';
    const made = await ask('newWindow', { fullscreen: false, hosted: true, mark });
    assert.ok(Number.isInteger(made?.windowId), JSON.stringify(made));
    const win = made.windowId as number;
    const marked = await until('the marked page\'s title', async () => (await tabsOf(win)).find((t: any) => t.title === `Margin ${mark}`));
    assert.match(marked.url, /\/newtab\/newtab\.html\?mark=e2eMark1234$/);
    assert.equal((await tabsOf(win)).length, 1, 'one tab, the marked page: never handed off as a ⌘T tab');

    // The item shown there: the marked page replaced by the item's tab.
    const shown = await ask('hostShow', { windowId: win, itemId: 't-e2eitem', url: page.url });
    assert.equal(shown.created, true);
    await until('the item\'s page alone in the window', async () => { const ts = await tabsOf(win); return ts.length === 1 && ts[0].url === page.url && ts[0].id === shown.tabId; });
    await until('the item\'s page loaded', async () => (await tabsOf(win))[0].title === 'Item page');

    // The window into full screen by the app; Chromium's own "Margin full screen" leaves it there: every windows call
    // the copy makes is recorded from here (the background's `api.windows` is this object), and its bounds changes.
    await worker.evaluate(() => {
      const g = globalThis as any;
      g.__updates = [];
      g.__bounds = 0;
      const update = chrome.windows.update.bind(chrome.windows);
      (chrome.windows as any).update = (windowId: number, props: object) => { g.__updates.push([windowId, props]); return update(windowId, props); };
      chrome.windows.onBoundsChanged?.addListener(() => { g.__bounds++; });
    });
    await ask('setWindowState', { windowId: win, state: 'fullscreen', land: false });
    await until('full screen', async () => (await stateOf(win)) === 'fullscreen');
    await until('its bounds change heard', () => worker.evaluate(() => (globalThis as any).__bounds > 0));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) { seen.add(await stateOf(win)); await sleep(50); }
    assert.deepEqual([...seen], ['fullscreen'], 'never taken out of full screen by the copy');
    assert.deepEqual(await worker.evaluate(() => (globalThis as any).__updates), [[win, { state: 'fullscreen' }]], 'the app\'s one call, nothing of the copy\'s own');

    // Its picture, for a card in another Margin window.
    const picture = await ask('hostPicture', { windowId: win, itemId: 't-e2eitem' });
    assert.match(String(picture?.data ?? ''), /^data:image\/(jpeg|png);base64,/, 'a picture of the page');

    // A second item, then the first again: a tab switch only.
    const second = await ask('hostShow', { windowId: win, itemId: 't-e2eitem2', url: 'about:blank' });
    assert.notEqual(second.tabId, shown.tabId);
    const again = await ask('hostShow', { windowId: win, itemId: 't-e2eitem', url: page.url });
    assert.deepEqual(again, { tabId: shown.tabId, created: false });

    // Closed from Margin's sidebar, then the window let go.
    assert.deepEqual(await ask('hostClose', { itemId: 't-e2eitem2' }), { closed: true });
    await until('its tab gone', async () => !(await tabsOf(win)).some((t: any) => t.id === second.tabId));
    await ask('closeWindow', { windowId: win });
    await until('the window gone', async () => !(await worker.evaluate((w: number) => chrome.windows.getAll().then((all) => all.some((x) => x.id === w)), win)));
  } finally {
    await context?.close().catch(() => {});
    await relay?.close();
    await app.close();
    await page.close();
    rmSync(root, { recursive: true, force: true });
  }
});
