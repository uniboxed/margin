import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, evalInShadow, waitFor, buildSafariProfile, gotoLauncher } from './helpers.js';

// Margin's scrolling rules in the Safari build (shared/gestures.js, shared/pull.js):
// no page bounce (and so no Safari pull-to-refresh), Margin's own pull-to-refresh,
// and scrolling over the sidebar never moves the page.
let ctx, dir, server, base, control;
before(async () => {
  dir = buildSafariProfile();
  ctx = await launch({ extensionPath: dir });
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><body style="margin:0"><h1>top</h1><div style="height:3000px"></div></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  control = await ctx.context.newPage();
  await gotoLauncher(control, ctx);
});
after(async () => {
  await ctx?.context.close();
  server?.close();
  if (dir) rmSync(dirname(dir), { recursive: true, force: true });
});

const setSettings = (patch) => control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
async function open(name, { height = 700 } = {}) {
  const page = await ctx.context.newPage();
  await page.setViewportSize({ width: 1000, height });
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.bringToFront();
  await waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () { return !!this.querySelector('.tab'); }));
  return page;
}
const overscroll = (page) => page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY);
// A trackpad-style pull at the pointer: n small upward scrolls, ~16ms apart.
async function pullDown(page, n = 18, step = -12) {
  await page.mouse.move(600, 300);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, step + (i % 3) - 1);
    await page.waitForTimeout(16);
  }
}

test('no page bounce while blocking is on (so no Safari pull-to-refresh); the setting puts it back', async () => {
  const page = await open('bounce');
  await waitFor(async () => (await overscroll(page)) === 'none');
  await setSettings({ blockGestures: false });
  await waitFor(async () => (await overscroll(page)) === 'auto');
  await setSettings({ blockGestures: true });
  await waitFor(async () => (await overscroll(page)) === 'none');
  assert.equal(await page.evaluate(() => document.querySelectorAll('style').length), 0, 'no markup added to the page');
  await page.close();
});

test('pulling down at the top shows Margin\'s indicator and reloads the page', async () => {
  const page = await open('pull');
  await page.evaluate(() => { window.__before = true; });
  const reloaded = page.waitForEvent('load', { timeout: 5000 });
  const shown = waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () {
    const p = this.querySelector('.pull');
    return p.classList.contains('armed') && Number(getComputedStyle(p).opacity) > 0.9;
  }), { timeout: 3000 });
  await pullDown(page);
  assert.ok(await shown, 'indicator armed and visible');
  await reloaded;
  assert.equal(await page.evaluate(() => window.__before), undefined, 'the page reloaded');
  await page.close();
});

test('the same pull while scrolled down (or a small one) does nothing', async () => {
  const page = await open('no-pull');
  await page.evaluate(() => { window.__before = true; window.scrollTo(0, 400); });
  await waitFor(() => page.evaluate(() => window.scrollY === 400));
  await page.mouse.move(600, 300);
  // Scroll back up to the top in the same gesture, then keep pulling: no reload.
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -14);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__before), true, 'not reloaded');
  await pullDown(page, 5); // small pull at the top
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__before), true, 'not reloaded');
  await setSettings({ pullToRefresh: false });
  await pullDown(page);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.__before), true, 'setting off: not reloaded');
  await setSettings({ pullToRefresh: true });
  await page.close();
});

test('scrolling over the sidebar never scrolls the page; its tab list scrolls when it has more than fits', async () => {
  await setSettings({ sidebarPinnedOpen: true });
  const extra = [];
  for (let i = 0; i < 8; i++) extra.push(await open(`filler-${i}`));
  const page = await open('sidebar-scroll', { height: 320 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.mouse.move(100, 200); // over the sidebar's tab list
  const list = () => evalInShadow(page, 'margin-sidebar-host', function () {
    const s = this.querySelector('.tabs-section');
    return { top: s.scrollTop, overflows: s.scrollHeight > s.clientHeight };
  });
  assert.equal((await list()).overflows, true, 'more tabs than fit');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 40);
  await waitFor(async () => (await list()).top > 0);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 80); // past the list's end
  await page.mouse.move(100, 30); // over the top row (nothing scrolls there)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -60);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.scrollY), 200, 'the page never moved');
  await page.mouse.move(600, 200); // over the page: it scrolls as usual
  await page.mouse.wheel(0, 100);
  await waitFor(() => page.evaluate(() => window.scrollY > 200));
  for (const p of [...extra, page]) await p.close();
  await setSettings({ sidebarPinnedOpen: false });
});

test('Chrome build: page bounce is left alone', async () => {
  const chrome = await launch();
  try {
    const page = await chrome.context.newPage();
    await page.goto(`${base}/chrome-bounce`);
    await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
    await page.waitForTimeout(500);
    assert.equal(await overscroll(page), 'auto');
  } finally {
    await chrome.context.close();
  }
});

// A trackpad-style sideways swipe: n small horizontal scrolls, ~16ms apart.
async function swipeSideways(page, step, { n = 14, x = 600, y = 300 } = {}) {
  await page.mouse.move(x, y);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(step + (i % 3) - 1, 0);
    await page.waitForTimeout(16);
  }
}
const swipeBadge = (page) => evalInShadow(page, 'margin-sidebar-host', function () {
  const b = this.querySelector('.swipe');
  return { active: b.classList.contains('active'), forward: b.classList.contains('forward'), opacity: Number(getComputedStyle(b).opacity) };
});

test('two-finger swipe: Arc\'s edge badge, then back (fingers moving right) and forward', async () => {
  const page = await open('swipe-a');
  await page.goto(`${base}/swipe-b`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.waitForTimeout(300);

  const shown = waitFor(async () => {
    const b = await swipeBadge(page).catch(() => null);
    return b?.active && !b.forward && b.opacity > 0.5 && b;
  }, { timeout: 3000 });
  const back = page.waitForURL(`${base}/swipe-a`);
  await swipeSideways(page, -12);
  assert.ok(await shown, 'badge on the left edge');
  await back;

  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.waitForTimeout(300);
  const forward = page.waitForURL(`${base}/swipe-b`);
  await swipeSideways(page, 12);
  await forward;
  await page.close();
});

test('no swipe navigation over something that scrolls sideways, for a small swipe, or with the setting off', async () => {
  const page = await open('swipe-c');
  await page.goto(`${base}/swipe-d`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="wide" style="position:fixed;left:400px;top:250px;width:300px;height:120px;overflow-x:auto"><div style="width:2000px;height:100px"></div></div>');
    document.getElementById('wide').scrollLeft = 900; // can scroll both ways
  });
  await swipeSideways(page, -12, { x: 550, y: 300 });
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/swipe-d', 'the box scrolled instead');
  await swipeSideways(page, -12, { n: 3 });
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/swipe-d', 'too small');
  await setSettings({ swipeNavigation: false });
  await swipeSideways(page, -12);
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, '/swipe-d', 'setting off');
  await setSettings({ swipeNavigation: true });
  await page.close();
});
