// Chrome and Edge on the Mac (app/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"), end to end: the real
// Chrome build (dist/chrome's, its fixed key), in Chrome for Testing (headless), starts the real relay helper
// (app/relay/main.swift, built here) through native messaging, the host file in the profile's own folder. A stand-in
// for Margin.app's relay socket (RelayLink.swift's words) answers the copy's wantLink as the app does and hands it the
// link; the copy then links over the same WebSocket as Safari's (tests/fake-app.ts) from its service worker, and says
// it's Chrome, with the browser's process as the relay told it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildTo } from '../../scripts/build.ts';
import { startFakeApp } from '../fake-app.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ID = 'njeebbcmlenfopaecfbphgcfihbdmkec'; // the Chrome build's key's (tests/build.test.ts)

// Margin.app's relay socket, as RelayLink.swift speaks it: the relay's hello, its welcome, then each message
// answered as Safari's handler answers, a wantLink's link dispatched into every relay of that browser process.
function relaySocket(path: string, app: any) {
  const relays = new Set<any>();
  const hellos: any[] = [];
  const messages: any[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    let hello: any = null;
    const send = (m: any) => socket.write(`${JSON.stringify(m)}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!hello) {
          hello = line;
          hellos.push(line);
          relays.add({ socket, send, hello });
          send({ k: 'relayWelcome', v: 1, version: line.version });
          continue;
        }
        const msg = line.msg;
        messages.push(msg);
        send({ ok: true, appOpen: true, launching: false, browser: hello.browser, pid: hello.pid });
        if (msg?.type === 'wantLink') for (const r of relays) if (r.hello.pid === hello.pid) r.send(app.linkInfo(msg.nonce));
      }
    });
    socket.on('close', () => { for (const r of relays) if (r.socket === socket) relays.delete(r); });
    socket.on('error', () => {});
  });
  return new Promise<{ hellos: any[], messages: any[], close: () => Promise<void> }>((resolve) => server.listen(path, () => resolve({
    hellos, messages, close: () => new Promise((done) => { for (const r of relays) r.socket.destroy(); server.close(() => done()); }),
  })));
}

test('Chrome on the Mac: the real relay finds the app, and the copy links from its service worker, saying chrome and its process', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'margin-relay-'));
  const app = await startFakeApp();
  let context: any = null;
  let relay: any = null;
  try {
    const ext = join(root, 'ext');
    buildTo(ext, { profile: 'chrome', manifest: 'chrome' });
    const binary = join(root, 'margin-relay');
    execFileSync('swiftc', ['-O', '-swift-version', '5', join(ROOT, 'app/relay/main.swift'), '-o', binary], { stdio: 'ignore' });
    const socketPath = join(root, 'r.sock');
    relay = await relaySocket(socketPath, app);

    const userData = join(root, 'profile');
    mkdirSync(join(userData, 'NativeMessagingHosts'), { recursive: true });
    const host = join(root, 'host.sh');
    writeFileSync(host, `#!/bin/sh\nMARGIN_RELAY_SOCKET="${socketPath}" MARGIN_RELAY_NO_LAUNCH=1 exec "${binary}" "$@"\n`);
    chmodSync(host, 0o755);
    writeFileSync(join(userData, 'NativeMessagingHosts', 'io.tirth.margin.json'), JSON.stringify({
      name: 'io.tirth.margin', description: 'Margin e2e relay', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`],
    }));
    context = await chromium.launchPersistentContext(userData, {
      headless: false,
      viewport: null,
      args: ['--headless=new', '--window-size=1280,800', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host, ID, 'the build\'s fixed id');

    const hello = await app.next('hello', { ms: 20_000 });
    assert.ok(hello, `linked (relays: ${JSON.stringify(relay.hellos)}, their messages: ${JSON.stringify(relay.messages.map((m: any) => m?.type))})`);
    assert.equal(hello.browser, 'chrome');
    assert.ok(Number.isInteger(hello.pid) && hello.pid > 0, 'the browser\'s process');
    assert.ok(relay.hellos.every((h: any) => h.browser === 'chrome' && h.pid === hello.pid), `the relays said the same process: ${JSON.stringify(relay.hellos)}`);
    assert.ok(relay.messages.some((m: any) => m?.type === 'wantLink'), 'it asked through the relay');
    assert.ok(/^chrome-extension:\/\//.test(hello.origin), 'from the extension');
    assert.ok(await app.next('snapshot', { ms: 5000 }), 'then its state');
  } finally {
    await context?.close().catch(() => {});
    await relay?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
