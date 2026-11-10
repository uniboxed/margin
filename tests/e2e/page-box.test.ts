// The page box (content/page/box.ts, shared/page-box.ts): every site sits in
// the slot the overlay's theme leaves for it, from its first frame; the box
// follows Keep open and the sidebar's width live; fixed and sticky parts, a
// cookie bar, a chat bubble and a modal that locks scroll stay in it; media
// queries and vw units follow it; frames sit in it; a window the app doesn't
// draw over has no box. Positions are read as the window draws them
// (Playwright's boxes come from the browser, not the page's own script).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin, type Margin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { pageBox, slot, settled } from './harness/ui.ts';
import type { Page } from 'playwright';

// The test site's first-frames recorder (site/sites/common.ts FIRST_FRAMES), on a page's window.
type FirstFrames = { __fp?: { frames: { x: number, y: number }[] } };

let m: Margin;
let ui: Page;
let windowId: number | null;

const sides = (b: Awaited<ReturnType<typeof pageBox>>) => b && { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
const inSlot = (rect: { x: number, y: number, width: number, height: number } | null, s: { left: number, top: number, right: number, bottom: number }, what: string) => {
  const tol = 1;
  assert.ok(rect, `${what}: drawn`);
  assert.ok(rect.x >= s.left - tol, `${what}: left ${rect.x} inside ${s.left}`);
  assert.ok(rect.y >= s.top - tol, `${what}: top ${rect.y} inside ${s.top}`);
  assert.ok(rect.x + rect.width <= 1440 - s.right + tol, `${what}: right ${rect.x + rect.width} inside ${1440 - s.right}`);
  assert.ok(rect.y + rect.height <= 900 - s.bottom + tol, `${what}: bottom ${rect.y + rect.height} inside ${900 - s.bottom}`);
};
const boxIs = (page: Page, s: { left: number, top: number, right: number, bottom: number }, what: string) => m.until(async () => JSON.stringify(sides(await pageBox(page))) === JSON.stringify(s), { what: `${what} in the slot ${JSON.stringify(s)}` });
const setTheme = (patch: Record<string, unknown>) => m.shell.request('updateThemeSettings', { themeId: 'arcadia', patch }, windowId);

before(async () => {
  m = await startMargin({ name: 'page-box', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  ui = await m.ui();
  windowId = m.shell.frontWindowId();
});
after(async () => { await m?.close(); });

test('every site sits in the slot, laid out at the slot\'s width', async (t) => {
  const s = (await slot(ui))!;
  assert.ok(s.left > 100, `the sidebar kept open: ${JSON.stringify(s)}`);
  const page = await m.context.newPage();
  const seen = [];
  for (const site of m.site.sites) {
    const path = site.pages[0]?.path ?? '/';
    await page.goto(m.url(site.host, path), { waitUntil: 'load' });
    await boxIs(page, s, site.host);
    assert.equal(await page.evaluate(() => innerWidth), 1440 - s.left - s.right, `${site.host}: its width`);
    const root = (await page.locator('html').boundingBox())!;
    assert.equal(Math.round(root.x), s.left, `${site.host}: <html> drawn at the slot's left`);
    seen.push(site.host);
    await m.shoot(t, site.host, { page });
  }
  assert.ok(seen.length >= 17, `${seen.length} sites`);
  await page.close();
});

// A body's gradient background (a full-height timer, a podcast's glow) is drawn for the whole box:
// no step at the box's right edge or along its bottom. Each point: on the page's background only.
const GRADIENTS = [
  { host: 'focus.test', path: '/', row: 760, column: 700 },
  { host: 'radio.test', path: '/', row: 95, column: 700 },
];
const step = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// Found by this suite (2026-11-06), fixed: the body's background was the canvas's, laid out from
// the window's corner at the box's size (content/page/box.ts checkBackground).
test('a body\'s gradient background fills the box, with no seam at its right edge or bottom', async (t) => {
  const s = (await slot(ui))!;
  const page = await m.context.newPage();
  const seams = [];
  for (const { host, path, row, column } of GRADIENTS) {
    await page.goto(m.url(host, path), { waitUntil: 'load' });
    await boxIs(page, s, host);
    const { width: w, height: h } = (await pageBox(page))!;
    assert.ok(s.bottom >= 6, `room below the box's height to look at (${s.bottom})`);
    const png = await page.screenshot();
    // Across the box's width, and two steps further right (the gradient's own change); the same down its height.
    const [a, b, c, d, e, f] = await m.pixels(png, [[w - 6, row], [w + 6, row], [w + 18, row], [column, h - 18], [column, h - 6], [column, h + 4]]);
    const across = { seam: step(a, b), gradient: step(b, c) };
    const down = { seam: step(e, f), gradient: step(d, e) };
    if (across.seam > across.gradient + 6) seams.push(`${host}: a step of ${across.seam} at x ${w} (the gradient ${across.gradient}): ${a} | ${b}`);
    if (down.seam > down.gradient + 6) seams.push(`${host}: a step of ${down.seam} at y ${h} (the gradient ${down.gradient}): ${e} | ${f}`);
    await m.shoot(t, host, { page });
  }
  await page.close();
  assert.deepEqual(seams, [], 'no seam in the background');
});

test('?fp pages are in their box from their first frame: the streamed report, the dark portfolio, the travel page', async (t) => {
  const s = (await slot(ui))!;
  for (const [host, path] of [['slow.test', '/report?fp&ms=1500'], ['noir.test', '/?fp'], ['harbor.test', '/?fp']]) {
    const page = await m.open(host, path, { wait: 'commit' });
    const frames = await m.until(() => page.evaluate(() => ((globalThis as unknown as FirstFrames).__fp?.frames.length! >= 10 ? (globalThis as unknown as FirstFrames).__fp!.frames : null)).catch(() => null), { what: `${host}'s first frames` });
    const off = frames.filter((f) => Math.round(f.x) !== s.left || Math.round(f.y) !== s.top);
    assert.deepEqual(off, [], `${host}: every early frame in the box`);
    await page.waitForLoadState('load');
    if (host === 'noir.test') await m.shoot(t, 'noir', { page });
    await page.close();
  }
});

test('Keep open off and on, and a wider sidebar, move the box live; a peek doesn\'t', async (t) => {
  const page = await m.open('docs.test', '/guide/getting-started');
  const open = (await slot(ui))!;
  await boxIs(page, open, 'the docs');

  m.shell.key('toggle-sidebar');
  const hidden = await m.until(async () => { const x = (await slot(ui))!; return x.left < 40 && x; }, { what: 'the hidden sidebar\'s slot' });
  await boxIs(page, hidden, 'the docs, sidebar hidden');
  assert.equal(await page.evaluate(() => innerWidth), 1440 - hidden.left - hidden.right);
  await m.shoot(t, 'hidden');

  // The key again: the sidebar comes out over the page (peek); the box stays where it is.
  m.shell.key('toggle-sidebar');
  await m.until(() => ui.locator('.keep-open[aria-pressed="false"]').isVisible(), { what: 'the sidebar out over the page' });
  assert.deepEqual(await slot(ui), hidden, 'the slot doesn\'t move for a peek');
  assert.deepEqual(sides(await pageBox(page)), hidden);
  await settled(ui);
  // What takes the pointer covers the sidebar where it ended up, not where its slide began (measured again once
  // the slide is over: app/shared/host/overlay.ts; a real session's recording 2026-11-07 2:11, nothing in the peek clickable).
  const bar = await ui.evaluate(() => { const r = document.querySelector('.margin-sidebar')!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const wid = m.shell.frontWindowId();
  await m.until(() => { const h = m.shell.overlays.get(wid)?.hits; return h && (h.all || h.rects.some(([x, y, w, hh]) => bar.x >= x && bar.x <= x + w && bar.y >= y && bar.y <= y + hh)); },
    { timeout: 3000, what: 'the sidebar out over the page in what takes the pointer' });
  await m.shoot(t, 'peek');

  // Keep open from the sidebar's own button: docked again, the box back beside it.
  await ui.click('.keep-open[aria-pressed="false"]');
  await m.until(async () => (await slot(ui))!.left === open.left, { what: 'the sidebar back' });
  await boxIs(page, open, 'the docs, sidebar back');

  assert.equal((await setTheme({ sidebarWidth: 400 })).ok, true);
  const wide = await m.until(async () => { const x = (await slot(ui))!; return x.left > open.left + 100 && x; }, { what: 'a wider sidebar' });
  await boxIs(page, wide, 'the docs beside the wider sidebar');
  await settled(ui);
  await m.shoot(t, 'wide');
  await setTheme({ sidebarWidth: 260 });
  await boxIs(page, open, 'the docs, the width back');
  await page.close();
});

// vw in the docs' padding: clamp(24px, 4vw, 72px). Its h1: font: 800 clamp(30px, 3.2vw, 44px)/1.15 var(--sans).
const readDocs = (page: Page) => page.evaluate(() => ({ w: innerWidth, narrow: matchMedia('(max-width: 1180px)').matches, toc: getComputedStyle(document.querySelector('.toc')!).display, pad: parseFloat(getComputedStyle(document.querySelector('.content')!).paddingLeft), h1: parseFloat(getComputedStyle(document.querySelector('h1')!).fontSize) }));
const clamp = (lo: number, vw: number, hi: number, w: number) => Math.min(hi, Math.max(lo, vw * w / 100));

test('the docs\' media queries and vw units follow the box', async (t) => {
  const page = await m.open('docs.test', '/guide/getting-started');
  const open = (await slot(ui))!;
  await boxIs(page, open, 'the docs');

  const inBox = await m.until(async () => { const r = await readDocs(page); return r.toc === 'none' && r; }, { what: 'the docs laid out for the box' });
  assert.equal(inBox.narrow, true, `at ${inBox.w} px, the 1180 px query holds`);
  assert.equal(inBox.toc, 'none', 'the table of contents goes, as the site means it to under 1180 px');
  assert.ok(Math.abs(inBox.pad - clamp(24, 4, 72, inBox.w)) < 0.6, `padding ${inBox.pad}px is 4vw of the box (${clamp(24, 4, 72, inBox.w)})`);

  m.shell.key('toggle-sidebar');
  await m.until(async () => (await readDocs(page)).w > 1300, { what: 'the box widened' });
  const wide = await m.until(async () => { const r = await readDocs(page); return r.toc !== 'none' && r; }, { what: 'the table of contents back' });
  assert.equal(wide.narrow, false);
  assert.ok(Math.abs(wide.pad - clamp(24, 4, 72, wide.w)) < 0.6, `padding ${wide.pad}px at ${wide.w}`);
  await m.shoot(t, 'wide-docs');
  await m.shell.request('updateSettings', { patch: { sidebarPinnedOpen: true } }, windowId);
  await m.until(async () => (await readDocs(page)).narrow, { what: 'the box back' });
  await page.close();
});

// Found by this suite (2026-11-06), fixed: the docs' h1 stayed 44 px in a 1172 px box (3.2vw of it
// is 37.5 px). Its rule is a `font` shorthand with a var() in it, whose longhands read empty while
// the var() is pending: the shorthand is now set again as a whole (shared/page-css.ts shiftStyle).
test('vw inside a font shorthand that also has a var() follows the box', async () => {
  const page = await m.open('docs.test', '/guide/getting-started');
  await boxIs(page, (await slot(ui))!, 'the docs');
  try {
    const r = await m.until(async () => { const x = await readDocs(page); return x.toc === 'none' && x; }, { what: 'the docs laid out for the box' });
    assert.ok(Math.abs(r.h1 - clamp(30, 3.2, 44, r.w)) < 0.6, `h1 ${r.h1}px is 3.2vw of the box (${clamp(30, 3.2, 44, r.w)})`);
  } finally {
    await page.close();
  }
});

test('the travel page\'s fixed bar, sticky sub-nav, cookie bar and chat stay in the box; its modal locks scroll inside it', async (t) => {
  const s = (await slot(ui))!;
  const page = await m.open('harbor.test', '/');
  await boxIs(page, s, 'the travel page');
  const bar = (await page.locator('.nav').boundingBox())!;
  inSlot(bar, s, 'the fixed bar');
  assert.equal(Math.round(bar.x), s.left);
  assert.equal(Math.round(bar.y), s.top, 'the fixed bar at the box\'s top');
  assert.equal(Math.round(bar.width), 1440 - s.left - s.right, 'as wide as the box');
  const chat = (await page.locator('#chat').boundingBox())!;
  inSlot(chat, s, 'the chat bubble');
  assert.equal(Math.round(1440 - s.right - (chat.x + chat.width)), 24, 'the chat bubble 24 px in from the box\'s right');
  assert.equal(Math.round(900 - s.bottom - (chat.y + chat.height)), 24, 'and from its bottom');
  inSlot(await page.locator('#cookie').boundingBox(), s, 'the cookie bar');

  // Scrolled: the sub-nav sticks under the fixed bar, in the box.
  await page.mouse.move(800, 500);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 120);
  await m.until(() => page.evaluate(() => scrollY > 700), { what: 'scrolled down' });
  await m.until(async () => Math.round((await page.locator('.subnav').boundingBox())!.y) === s.top + 72, { what: 'the sub-nav stuck under the bar' });
  await m.shoot(t, 'scrolled');

  // The modal covers the box, not the window, and the page under it doesn't scroll.
  await page.evaluate(() => scrollTo(0, 0));
  await page.click('#open-dates');
  await page.waitForSelector('#modal:not([hidden])');
  const veil = (await page.locator('#modal').boundingBox())!;
  assert.deepEqual([veil.x, veil.y, veil.width, veil.height].map(Math.round), [s.left, s.top, 1440 - s.left - s.right, 900 - s.top - s.bottom], 'the modal\'s veil is the box');
  const y0 = await page.evaluate(() => scrollY);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => scrollY), y0, 'locked while the modal is open');
  await m.shoot(t, 'modal');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal', { state: 'hidden' });
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 200);
  await m.until(() => page.evaluate((y) => scrollY > y, y0), { what: 'scrolling again once it closed' });
  await page.close();
});

test('frames sit in the box: the same site\'s, another site\'s, a srcdoc and a sandboxed one', async (t) => {
  const s = (await slot(ui))!;
  const page = await m.open('embed.test', '/');
  await boxIs(page, s, 'the embeds page');
  for (const id of ['f-weather', 'f-map', 'f-poll', 'f-comments']) {
    const frame = page.locator(`#${id}`);
    await frame.scrollIntoViewIfNeeded();
    inSlot(await frame.boundingBox(), s, id);
  }
  const map = page.frameLocator('#f-map');
  const inner = await map.locator('body').evaluate(() => ({ w: innerWidth, boxed: getComputedStyle(document.documentElement).getPropertyValue('--margin-box-left').trim() }));
  const outer = await page.locator('#f-map').evaluate((el) => el.clientWidth);
  assert.equal(inner.w, outer, 'a frame lays out at its own width');
  assert.equal(inner.boxed, '', 'and has no box of its own');
  await page.locator('#f-map').scrollIntoViewIfNeeded();
  await m.shoot(t, 'frames', { page });
  await page.close();
});

test('a window the app says it doesn\'t draw over: its pages have no box; drawn again, the box comes back', async (t) => {
  const s = (await slot(ui))!;
  const page = await m.open('noir.test', '/');
  await boxIs(page, s, 'the portfolio');
  m.shell.drawn(windowId!, false);
  await m.until(async () => (await pageBox(page)) === null, { what: 'no box' });
  assert.equal(await page.evaluate(() => innerWidth), 1440, 'the whole window');
  assert.equal(Math.round((await page.locator('html').boundingBox())!.x), 0);
  await m.shoot(t, 'no-box', { page });
  m.shell.drawn(windowId!, true);
  await boxIs(page, s, 'the portfolio again');
  await page.close();
});
