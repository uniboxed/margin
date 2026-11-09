// The Chrome build (dist/chrome) on its own: no Margin.app for Chrome until
// Phase 5. Its background starts and its new-tab page is Margin's (the old
// smoke tests); Chrome's profile: its shortcuts, Chrome's own site icons (no
// fetching), searches through chrome.search, no gesture blocking and the
// page bounce left alone; and pages get nothing of Margin's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_RULES, startSite, searchResults } from './site/server.ts';
import { ENGINES, SIZE } from './harness/margin.ts';
import { pageBox } from './harness/ui.ts';
import { shoot } from './harness/shots.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXTENSION = fileURLToPath(new URL('../../dist/chrome', import.meta.url));

let context;
let worker;
let site;
let root;
const leaks = [];
// For the screenshots (harness/shots.js: there's no overlay here, so only page.png).
const world = { name: 'chrome-build', shell: { frontWindowId: () => null, overlays: new Map() }, front: async () => null, pageOf: async () => null };
const bg = (fn, arg) => worker.evaluate(fn, arg);
const until = async (check, { timeout = 5000, what = 'a condition' } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${timeout} ms for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'margin-e2e-chrome-'));
  site = await startSite();
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    headless: false,
    viewport: null,
    args: ['--headless=new', `--window-size=${SIZE.width},${SIZE.height}`, `--screen-info={${SIZE.width}x${SIZE.height}}`, `--host-resolver-rules=${HOST_RULES}`, `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (!/^https?:$|^wss?:$/.test(u.protocol) || u.hostname.endsWith('.test') || u.hostname === '127.0.0.1' || ENGINES.test(r.url())) return;
    leaks.push(r.url());
  });
  await context.route(ENGINES, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: searchResults(q, site.port) });
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
});
after(async () => {
  await context?.close();
  await site?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('the background starts, as Chrome\'s profile', async () => {
  assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.bundle\.js$/);
  assert.equal(await bg(() => globalThis.Margin.platform.name), 'chrome');
  assert.equal(await bg(() => globalThis.Margin.platform.nativeApp), false, 'no app for Chrome yet');
});

test('a new tab is Margin\'s new-tab page, with its own address field', async (t) => {
  const page = await context.newPage();
  await page.goto('chrome://newtab');
  const id = new URL(worker.url()).host;
  assert.equal(page.url(), `chrome-extension://${id}/newtab/newtab.html`);
  await page.waitForSelector('#address');
  await shoot(world, t, 'newtab', { page });
  await page.close();
});

test('Chrome\'s shortcuts', async () => {
  const settings = await until(() => bg(() => chrome.storage.local.get('settings').then((r) => r.settings?.shortcuts && r.settings)), { what: 'the settings' });
  assert.equal(settings.shortcuts.nextTab, 'Ctrl+Meta+ArrowDown');
  assert.equal(settings.shortcuts.prevTab, 'Ctrl+Meta+ArrowUp');
});

test('Chrome\'s own site icons: nothing fetched', async () => {
  const page = await context.newPage();
  await page.goto(site.url('shop.test', '/'));
  const tab = await until(() => bg(() => chrome.tabs.query({ url: '*://shop.test/*' }).then(([x]) => x?.favIconUrl && x)), { what: 'Chrome\'s icon for the shop' });
  assert.match(tab.favIconUrl, /^http:\/\/shop\.test:\d+\//, 'the shop\'s own icon, as Chrome found it');
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(await bg(() => chrome.storage.local.get('favicons').then((r) => r.favicons ?? {})), {}, 'Margin fetched nothing');
  await page.close();
});

test('pages get nothing of Margin\'s: no box, no gesture blocking, the bounce left alone', async (t) => {
  const page = await context.newPage();
  await page.goto(site.url('harbor.test', '/'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await pageBox(page), null, 'no box');
  assert.equal(await page.evaluate(() => innerWidth), SIZE.width);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'auto', 'the bounce left alone');
  await page.evaluate(() => { window.__wheel = []; document.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented)); });
  await page.mouse.move(700, 300);
  await page.mouse.wheel(-80, 0);
  await until(() => page.evaluate(() => window.__wheel.length > 0), { what: 'the wheel seen' });
  assert.equal(await page.evaluate(() => window.__wheel.some(Boolean)), false, 'a sideways swipe left to Chrome');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[class*="margin"], margin-sidebar-host').length), 0, 'nothing added to the page');
  await shoot(world, t, 'harbor', { page });
  await page.close();
});

test('the new-tab page: an address goes there, words go to Chrome\'s search (answered locally)', async () => {
  const page = await context.newPage();
  await page.goto('chrome://newtab');
  await page.waitForSelector('#address');
  // Typed with its scheme: a bare host goes to https:, which the test server doesn't speak.
  await page.fill('#address', site.url('docs.test', '/guide/getting-started'));
  await page.press('#address', 'Enter');
  await page.waitForURL(site.url('docs.test', '/guide/getting-started'));

  await page.goto('chrome://newtab');
  await page.waitForSelector('#address');
  await page.fill('#address', 'quiet ferries');
  await page.press('#address', 'Enter');
  await page.waitForURL(ENGINES);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'quiet ferries');
  assert.match(await page.textContent('body'), /quiet ferries/);
  await page.close();
  assert.deepEqual(leaks, [], 'nothing left the Mac');
});
