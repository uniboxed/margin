// Scrolling and Margin's trackpad gestures in Safari's profile, on pages in
// their box (content/trackpad.ts, shared/gestures.ts, shared/pull.ts):
// the wheel scrolls the page, a sticky bar sticks at the box's top, the
// feed loads more, scroll is kept across switches; no page bounce and no
// sideways swipes leaving the page while blocking is on; Margin's pull to
// refresh and swipe back and forward, their feedback drawn by the overlay
// (the copy's `push gesture`); none over a sideways scroller, for a small
// gesture, toward no history, or with the settings off. (The old
// scroll.test.ts, platform.test.js and enhancements.test.js read the
// in-page UI.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { slot, tabRow } from './harness/ui.ts';

let m;
let ui;
let windowId;

const frontId = async () => (await m.front())?.id;
const gestures = (from) => m.shell.received.slice(from).filter((x) => x.k === 'push' && x.msg?.type === 'gesture').map((x) => x.msg);
const setSettings = (patch) => m.shell.request('updateSettings', { patch }, windowId);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A trackpad's run of small wheel events, ~16 ms apart, at the pointer.
async function wheelRun(page, { dx = 0, dy = 0, n = 18, x = 800, y = 450 } = {}) {
  await page.mouse.move(x, y);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(dx ? dx + (i % 3) - 1 : 0, dy ? dy + (i % 3) - 1 : 0);
    await pause(16);
  }
}
// Whether the page's own listener saw the last wheel events stopped (after Margin's capture listener).
async function watchWheels(page) {
  await page.evaluate(() => { window.__wheel = []; document.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented)); });
}
const stopped = async (page) => {
  await m.until(() => page.evaluate(() => window.__wheel.length > 0), { what: 'the wheel seen' });
  return page.evaluate(() => window.__wheel.splice(0).some(Boolean));
};

before(async () => {
  m = await startMargin({ name: 'scroll', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  ui = await m.ui();
  windowId = m.shell.frontWindowId();
});
after(async () => { await m?.close(); });

test('the wheel scrolls the article in its box; its section bar sticks at the box\'s top', async (t) => {
  const page = await m.open('dispatch.test', '/2026/11/the-quiet-city');
  const s = await slot(ui);
  await page.mouse.move(800, 500);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 150);
  await m.until(() => page.evaluate(() => scrollY > 1200), { what: 'scrolled down' });
  await m.until(async () => Math.round((await page.locator('#sections').boundingBox()).y) === s.top, { what: 'the section bar stuck at the box\'s top' });
  const progress = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('progress')).width));
  assert.ok(progress > 0, 'the reading progress follows the scroll');
  await m.shoot(t, 'scrolled');
  await page.close();
});

test('the feed loads more posts as it nears the end', async (t) => {
  const page = await m.open('murmur.test', '/home');
  const count = () => page.evaluate(() => document.querySelectorAll('#posts .post').length);
  const first = await count();
  await page.mouse.move(800, 500);
  for (let round = 0; round < 3; round++) {
    const before = await count();
    // Scrolled on by the wheel, as a person reads down, until the next page comes.
    await m.until(async () => { await page.mouse.wheel(0, 700); return (await count()) > before; }, { timeout: 8000, interval: 120, what: `page ${round + 2} of the feed` });
  }
  assert.ok((await count()) >= first * 3, 'three more pages of posts');
  await m.shoot(t, 'more-posts');
  await page.close();
});

test('scroll is kept across switches in the overlay', async () => {
  const docs = await m.open('docs.test', '/guide/getting-started');
  const docsTab = await frontId();
  await docs.mouse.move(800, 500);
  for (let i = 0; i < 6; i++) await docs.mouse.wheel(0, 200);
  const y = await m.until(async () => { const v = await docs.evaluate(() => scrollY); return v > 600 && v; }, { what: 'the docs scrolled' });
  await pause(200);
  const at = await docs.evaluate(() => scrollY);
  await m.open('noir.test', '/');
  await ui.click(tabRow(docsTab));
  await m.until(async () => (await frontId()) === docsTab, { what: 'the docs in front again' });
  assert.equal(await docs.evaluate(() => scrollY), at, `still at ${y}`);
});

test('no page bounce while blocking is on; the setting gives it back', async () => {
  const page = await m.open('noir.test', '/');
  const bounce = () => page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY);
  await m.until(async () => (await bounce()) === 'none', { what: 'no bounce' });
  await setSettings({ blockGestures: false });
  await m.until(async () => (await bounce()) === 'auto', { what: 'bounce back' });
  await setSettings({ blockGestures: true });
  await m.until(async () => (await bounce()) === 'none', { what: 'no bounce again' });
  await page.close();
});

test('sideways swipes can\'t leave the page; scrolling and a sideways scroller are untouched; the setting gives them back', async () => {
  const page = await m.open('shop.test', '/');
  await watchWheels(page);
  await page.mouse.move(800, 200);
  await page.mouse.wheel(-80, 0);
  assert.equal(await stopped(page), true, 'sideways on the page (Safari would go back): stopped');
  await page.mouse.wheel(0, 80);
  assert.equal(await stopped(page), false, 'scrolling: untouched');
  const carousel = page.locator('#carousel');
  await carousel.scrollIntoViewIfNeeded();
  const c = await carousel.boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.wheel(120, 0);
  assert.equal(await stopped(page), false, 'over the carousel: it scrolls');
  await m.until(() => page.evaluate(() => document.getElementById('carousel').scrollLeft > 0), { what: 'the carousel scrolled' });
  // The setting off: sideways swipes are Safari's again.
  await setSettings({ blockGestures: false });
  await m.until(async () => { await page.mouse.move(800, 200); await page.mouse.wheel(-80, 0); return !(await stopped(page)); }, { what: 'sideways left alone with blocking off' });
  await setSettings({ blockGestures: true });
  await m.until(async () => { await page.mouse.move(800, 200); await page.mouse.wheel(-80, 0); return stopped(page); }, { what: 'stopped again' });
  await page.close();
});

test('pulling down at the top: the overlay draws the pull, armed, then the page reloads', async (t) => {
  const page = await m.open('harbor.test', '/');
  const tab = await frontId();
  await page.evaluate(() => { window.__before = true; });
  const from = m.shell.received.length;
  const reloaded = page.waitForEvent('load', { timeout: 8000 });
  let drawnArmed = false;
  const watch = (async () => {
    const end = Date.now() + 4000;
    while (!drawnArmed && Date.now() < end) {
      drawnArmed = await ui.evaluate(() => !!document.querySelector('.gesture.pull.armed')).catch(() => false);
      if (drawnArmed) await m.shoot(t, 'armed');
      await pause(10);
    }
  })();
  await wheelRun(page, { dy: -12 });
  await reloaded;
  await watch;
  assert.equal(await page.evaluate(() => window.__before), undefined, 'the page loaded again');
  const states = gestures(from).filter((g) => g.kind === 'pull' && g.tabId === tab).map((g) => g.state);
  assert.ok(states.includes('pulling'), `pulling told: ${states.join(' ')}`);
  assert.ok(states.includes('armed'), 'armed told');
  assert.ok(states.includes('trigger'), 'trigger told');
  assert.ok(drawnArmed, 'the overlay drew the pull, armed');
  await page.close();
});

test('the same pull scrolled down, a small one, or with the setting off: no reload', async () => {
  const page = await m.open('dispatch.test', '/2026/11/the-quiet-city');
  await page.evaluate(() => { window.__before = true; scrollTo(0, 400); });
  await m.until(() => page.evaluate(() => scrollY === 400), { what: 'scrolled to 400' });
  const from = m.shell.received.length;
  // Back up to the top in the same gesture, then on: not a pull.
  await wheelRun(page, { dy: -14, n: 60 });
  await pause(500);
  assert.equal(await page.evaluate(() => window.__before), true, 'not reloaded');
  await wheelRun(page, { dy: -12, n: 5 });
  await pause(500);
  assert.equal(await page.evaluate(() => window.__before), true, 'a small pull: not reloaded');
  assert.ok(!gestures(from).some((g) => g.state === 'trigger'), 'nothing triggered');
  await setSettings({ pullToRefresh: false });
  await wheelRun(page, { dy: -12 });
  await pause(500);
  assert.equal(await page.evaluate(() => window.__before), true, 'setting off: not reloaded');
  await setSettings({ pullToRefresh: true });
  await page.close();
});

test('a two-finger swipe: the overlay draws the edge badge, then back and forward', async (t) => {
  const page = await m.open('docs.test', '/guide/getting-started');
  const tab = await frontId();
  await page.click('nav.pager a.nx');
  await page.waitForURL(/installation/);
  await m.until(async () => (await m.tabs()).find((x) => x.id === tab)?.status === 'complete', { what: 'loaded' });
  const from = m.shell.received.length;
  let drawn = null;
  const watch = (async () => {
    const end = Date.now() + 4000;
    while (!drawn && Date.now() < end) {
      drawn = await ui.evaluate(() => { const g = document.querySelector('.gesture.swipe'); return g ? { back: g.classList.contains('back'), armed: g.classList.contains('armed') } : null; }).catch(() => null);
      if (drawn) await m.shoot(t, 'swipe-back');
      await pause(10);
    }
  })();
  // Fingers moving right: back.
  await wheelRun(page, { dx: -12, n: 14 });
  await page.waitForURL(/getting-started/);
  await watch;
  assert.ok(drawn?.back, `the overlay drew the badge at the back edge: ${JSON.stringify(drawn)}`);
  assert.ok(gestures(from).some((g) => g.kind === 'swipe' && g.state === 'trigger' && g.direction < 0), 'a swipe back told');
  await m.until(async () => (await m.tabs()).find((x) => x.id === tab)?.status === 'complete', { what: 'loaded' });
  await wheelRun(page, { dx: 12, n: 14 });
  await page.waitForURL(/installation/);
  await page.close();
});

test('no swipe over a sideways scroller, for a small one, toward no history, or with the setting off', async () => {
  const page = await m.open('shop.test', '/');
  const tab = await frontId();
  // A fresh tab: no history. The Navigation API says so, and nothing is drawn or done.
  let from = m.shell.received.length;
  await wheelRun(page, { dx: -12, n: 14 });
  await pause(400);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.ok(!gestures(from).some((g) => g.kind === 'swipe' && g.state !== 'idle'), 'toward no history: nothing told');

  await page.goto(m.url('shop.test', '/p/canvas-tote'));
  await m.until(async () => (await m.tabs()).find((x) => x.id === tab)?.status === 'complete', { what: 'loaded' });
  await page.goBack();
  await page.waitForURL(m.url('shop.test', '/'));
  const carousel = page.locator('#carousel');
  await carousel.scrollIntoViewIfNeeded();
  await page.evaluate(() => { document.getElementById('carousel').scrollLeft = 300; });
  const c = await carousel.boundingBox();
  from = m.shell.received.length;
  await wheelRun(page, { dx: 12, n: 14, x: c.x + c.width / 2, y: c.y + c.height / 2 });
  await pause(400);
  assert.equal(new URL(page.url()).pathname, '/', 'the carousel scrolled instead');
  await wheelRun(page, { dx: 12, n: 3, y: 120 });
  await pause(400);
  assert.equal(new URL(page.url()).pathname, '/', 'too small');
  assert.ok(!gestures(from).some((g) => g.kind === 'swipe' && g.state === 'trigger'), 'nothing triggered');
  await setSettings({ swipeNavigation: false });
  await wheelRun(page, { dx: 12, n: 14, y: 120 });
  await pause(400);
  assert.equal(new URL(page.url()).pathname, '/', 'setting off');
  await setSettings({ swipeNavigation: true });
  await page.close();
});
