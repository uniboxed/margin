// One e2e file's world: the test site, the test build of Margin in headless
// Chromium (Safari's profile, linked through the native messaging relay to
// the stand-in shell), and the overlays in headless WebKit.
//
//   const m = await startMargin({ seed: { spaces, pins, settings } });
//   const ui = await m.ui();                 // the front window's overlay page (Playwright Page)
//   const page = await m.open('shop.test', '/'); // a site page, in a new tab
//   await m.shoot(t, 'after-click');         // page.png, overlay.png, window.png
//   await m.close();
//
// Nothing leaves the Mac: `.test` hosts go to the site, every other host
// fails to resolve (and is recorded: `m.leaks`), search engines' addresses
// are answered by the site's local results page.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RULES, startSite, searchResults } from '../site/server.js';
import { testBuild } from './build.js';
import { startRelay } from './relay.js';
import { startShell } from './shell.js';
import { seedSet } from './seed.js';
import { shoot, forgetComposer } from './shots.js';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require('playwright');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../../dist/app/', import.meta.url));
// The app's Content Security Policy for its overlay pages (app/shell/OverlayWebView.swift policy).
export const OVERLAY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
// Addresses of search engines the copy may go to (Safari's default, the learned ones).
const ENGINES = /^https?:\/\/([a-z0-9-]+\.)*(google|bing|duckduckgo|yahoo|ecosia|startpage|baidu|yandex|kagi)\.[a-z.]+\//i;
export const SIZE = { width: 1440, height: 900 };

// The overlay's files, served as the app serves them (its own origin, its policy, nothing cached).
async function serveOverlay() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    const file = join(APP_DIR, name);
    if (!/^[\w.-]+$/.test(name) || !existsSync(file)) { res.writeHead(404, { 'content-security-policy': OVERLAY_POLICY }); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-security-policy': OVERLAY_POLICY, 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/overlay.html`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   seed?: any,           // what the app's data set holds (seed.js seedSet's input), or a data set;
 *                         // or a function of the site's `url(host, path)` returning one (pins of the test site)
 *   fullscreen?: boolean, // the first window in full screen (default) — Margin's overlays draw only there
 *   running?: boolean,    // Margin.app running at the start (default true)
 *   cloudTabs?: any, across?: any,
 *   name?: string,        // for the screenshots' folder
 * }} [options]
 */
export async function startMargin({ seed = null, fullscreen = true, running = true, cloudTabs = null, across = null, name = 'e2e' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'margin-e2e-'));
  const t0 = Date.now();
  const site = await startSite();
  if (typeof seed === 'function') seed = seed(site.url);
  const build = testBuild(root);
  const overlayServer = await serveOverlay();
  const wk = await webkit.launch({ headless: true });

  let worker = null;
  const shell = await startShell({
    webkit: wk,
    overlayUrl: overlayServer.url,
    dataSet: seed ? seedSet(seed) : null,
    cloudTabs, across,
    makeFullscreen: (id) => worker?.evaluate((wid) => chrome.windows.update(wid, { state: 'fullscreen' }).then(() => {}), id),
  });
  if (!running) shell.setRunning(false);
  const relay = await startRelay({ wantLink: (nonce) => shell.wantLink(nonce) });

  // The native host, found in the profile's own folder (nothing written outside it).
  const userData = join(root, 'profile');
  mkdirSync(join(userData, 'NativeMessagingHosts'), { recursive: true });
  const hostScript = join(root, 'native-host.sh');
  writeFileSync(hostScript, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'native-host.mjs')}" "$@"\n`);
  chmodSync(hostScript, 0o755);
  writeFileSync(join(userData, 'NativeMessagingHosts', 'io.tirth.margin.json'), JSON.stringify({
    name: 'io.tirth.margin', description: 'Margin e2e relay', path: hostScript, type: 'stdio', allowed_origins: [`chrome-extension://${build.id}/`],
  }));

  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    viewport: null,
    args: [
      '--headless=new',
      `--window-size=${SIZE.width},${SIZE.height}`,
      `--screen-info={${SIZE.width}x${SIZE.height}}`,
      `--host-resolver-rules=${HOST_RULES}`,
      '--autoplay-policy=no-user-gesture-required',
      `--disable-extensions-except=${build.path}`,
      `--load-extension=${build.path}`,
    ],
    env: { ...process.env, MARGIN_E2E_RELAY: String(relay.port) },
  });
  // The network guard: anything not for the test site, the extension or a page's own data is recorded.
  const leaks = [];
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (!/^https?:$|^wss?:$/.test(u.protocol)) return;
    if (u.hostname.endsWith('.test') || u.hostname === '127.0.0.1') return;
    if (ENGINES.test(r.url())) return; // answered locally (the route below)
    leaks.push(r.url());
  });
  await context.route(ENGINES, (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q') ?? u.searchParams.get('p') ?? u.searchParams.get('text') ?? '';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: searchResults(q, site.port) });
  });

  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // A background that stopped and started again (a test can stop it): `m.bg` and the rest follow the new one.
  context.on('serviceworker', (w) => {
    if (new URL(w.url()).host !== extensionId) return;
    worker = w;
    m.worker = w;
  });
  if (extensionId !== build.id) throw new Error(`the extension's id is ${extensionId}, not the one its key gives (${build.id})`);

  const m = {
    root, site, build, relay, shell, context, worker, extensionId, leaks, name, webkit: wk,
    startedAt: t0,
    /** The address of a page of the test site. */
    url: (host, path = '/') => site.url(host, path),
    newTabUrl: () => `chrome-extension://${extensionId}/newtab/newtab.html`,
    /** Runs `fn(arg)` in the background. */
    bg: (fn, arg) => worker.evaluate(fn, arg),
    /** Every browser tab: { id, windowId, index, title, url, active, status }. */
    tabs: () => worker.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, windowId: t.windowId, index: t.index, title: t.title, url: t.url, active: t.active, status: t.status, audible: t.audible })))),
    /** The browser tab in front of a window (the front window by default). */
    async front(windowId = shell.frontWindowId()) {
      return (await m.tabs()).find((t) => t.windowId === windowId && t.active) ?? null;
    },
    /** All of storage.local (the copy's stored values). */
    stored: (keys = null) => worker.evaluate((k) => chrome.storage.local.get(k), keys),
    /** The copy's state as pages read it (shared/stored.js fromStorage's keys). */
    async state() {
      const raw = await m.stored();
      return { ...raw, ...(raw.openTabs ?? {}) };
    },
    /** The Playwright page of a browser tab, by id (or the front tab's). */
    async pageOf(tabId) {
      const tab = tabId == null ? await m.front() : (await m.tabs()).find((t) => t.id === tabId);
      if (!tab) return null;
      for (let i = 0; i < 100; i++) {
        const page = context.pages().find((p) => p.url() === tab.url) ?? null;
        if (page) return page;
        await sleep(30);
      }
      return null;
    },
    /** A site page opened in a new tab of the front window (Chromium's own way: a new page). Waits for its load. */
    async open(host, path = '/', { wait = 'load' } = {}) {
      const page = await context.newPage();
      await page.goto(host.includes('://') ? host : site.url(host, path), { waitUntil: wait });
      return page;
    },
    /** The overlay page over a window (Playwright Page), once drawn. */
    async ui(windowId = shell.frontWindowId()) {
      return (await shell.overlay(windowId)).page;
    },
    /** Waits until `check()` (sync or async) is truthy. */
    async until(check, { timeout = 5000, interval = 30, what = 'a condition' } = {}) {
      const end = Date.now() + timeout;
      let last;
      for (;;) {
        last = await check();
        if (last) return last;
        if (Date.now() > end) throw new Error(`waited ${timeout} ms for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
        await sleep(interval);
      }
    },
    /** Waits for the link: hello, snapshot, the theme and the keys. */
    linked: () => waitLinked(m),
    /** A window put in full screen (Margin draws over it there), and its overlay drawn. */
    fullscreen: (windowId) => goFullscreen(m, windowId),
    /** Screenshots for a person to look at: page.png, overlay.png, window.png. */
    shoot: (t, label, options = {}) => shoot(m, t, label, options),
    /** The app's set sent again (the seed, or another), as the app would after a change elsewhere. */
    reseed(next = seed) {
      shell.seed(seedSet(typeof next === 'function' ? next(site.url) : next), { now: true });
    },
    async close() {
      await context.close().catch(() => {});
      await shell.close().catch(() => {});
      await wk.close().catch(() => {});
      forgetComposer();
      await relay.close().catch(() => {});
      await overlayServer.close().catch(() => {});
      await site.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };

  if (!running) return m;
  await m.linked();
  // The window's first tab: the test site's index, as a start page (about:blank, which Margin leaves out,
  // until the seed is in: a tab opened before it is in the copy's default space, which the seed replaces).
  if (seed?.spaces) await m.until(async () => (await m.stored('spaces')).spaces?.map((x) => x.id).join() === seed.spaces.map((x) => x.id).join(), { timeout: 5000, what: 'the seed taken' });
  await context.pages()[0]?.goto(site.url('margin.test', '/')).catch(() => {});
  if (fullscreen) await m.fullscreen();
  return m;
}

/** @param {any} m */
async function waitLinked(m) {
  const { shell } = m;
  await shell.until(() => shell.hello && shell.state && shell.windows.length && shell.themeId && shell.keys, { timeout: 15_000, what: 'the copy to link (hello, snapshot, theme, keys)' });
}

/** @param {any} m @param {number} [windowId] */
async function goFullscreen(m, windowId = m.shell.frontWindowId()) {
  await m.bg((id) => chrome.windows.update(id, { state: 'fullscreen' }).then(() => {}), windowId);
  await m.shell.until(() => m.shell.windows.find((w) => w.windowId === windowId)?.state === 'fullscreen', { timeout: 5000, what: 'full screen' });
  return m.shell.overlay(windowId);
}

