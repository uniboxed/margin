// The link going and coming back (docs/PROTOCOL.md "Liveness", background/
// link.ts): a socket dropped and mended at once; the app gone for a moment
// (the overlay dimmed, "Reconnecting") and back within the grace; gone for
// longer than 6 s (off, the new-tab notice), then a
// new app; the app's goodbye (off at once); a socket whose welcome has the
// wrong key, refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin, type Margin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar } from './harness/ui.ts';
import type { Page } from 'playwright';

let m: Margin;
let page: Page;

// The copy's own word on the link, as its pages read it (background/link.ts writePageState).
const stored = async () => (await m.stored('appLink')).appLink ?? null;
const state = async () => (await stored())?.state ?? null;
const hellos = () => m.shell.received.filter((x) => x.k === 'hello').length;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The new app says it's up (the handler's `appUp`): linked once the copy says hello to it.
async function appUp() {
  const before = hellos();
  m.relay.dispatch('appUp', { v: 2, at: Date.now() });
  await m.until(() => hellos() > before && m.shell.linked, { timeout: 10_000, what: 'a hello to the new app' });
  await m.linked();
}

before(async () => {
  m = await startMargin({ name: 'link-drops', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  page = await m.open('harbor.test', '/');
  await m.until(async () => (await state()) === 'linked', { what: 'the copy linked' });
});
after(async () => { await m?.close(); });

test('a dropped socket is mended at once from the kept link', async () => {
  const before = hellos();
  const t0 = Date.now();
  m.shell.drop();
  await m.until(() => hellos() > before && m.shell.linked, { what: 'linked again' });
  assert.ok(Date.now() - t0 < 2000, `linked again in ${Date.now() - t0} ms`);
  await m.until(() => m.relay.logs.some((l) => /^kept link try 1 of \d+ \(port \d+\): open/.test(l.line)), { what: 'the copy noting its first try worked' });
  assert.equal(await state(), 'linked', 'pages still see it linked');
  assert.equal(m.shell.overlays.size, 1, 'the overlay stayed');
});

test('the app gone a moment: the overlay dimmed, "Reconnecting", pages see it reconnecting; back within the grace, as it was', async (t) => {
  const ui = await m.ui();
  await ui.evaluate(() => { (window as Window & { __same?: boolean }).__same = true; });
  await m.shell.kill();
  await m.until(() => ui.evaluate(() => document.documentElement.hasAttribute('data-reconnecting')), { what: 'the overlay dimmed' });
  const words = await ui.evaluate(() => document.getElementById('margin-reconnecting')?.textContent ?? '');
  assert.match(words, /Reconnecting/);
  await pause(1500);
  assert.equal(await state(), 'reconnecting', 'pages see it reconnecting while the app may come back');
  await m.shoot(t, 'reconnecting');

  await m.shell.restart();
  await appUp();
  await m.until(() => ui.evaluate(() => !document.documentElement.hasAttribute('data-reconnecting')), { what: 'the overlay lit again' });
  assert.equal(await ui.evaluate(() => (window as Window & { __same?: boolean }).__same === true), true, 'the same overlay page, not a new one');
  assert.equal(await state(), 'linked');
  assert.ok((await sidebar(ui)).tabs.length >= 2, 'its rows still there');
});

test('the app gone past 6 s: off, the new-tab page says so; a new app links again', async (t) => {
  await m.shell.kill();
  const t0 = Date.now();
  await m.until(async () => (await state()) === 'off', { timeout: 10_000, interval: 100, what: 'off' });
  const after = Date.now() - t0;
  assert.ok(after >= 5500, `reconnecting through the grace (${after} ms)`);
  assert.equal(await page.evaluate(() => innerWidth), 1440, 'the page has the whole window');
  await m.until(async () => { const l = await stored(); return l?.state === 'off' && Object.keys(l.drawn ?? {}).length === 0; }, { what: 'the copy\'s link off, no window drawn' });
  const nt = await m.context.newPage();
  await nt.goto(m.newTabUrl());
  await nt.waitForSelector('#notice:not([hidden])');
  assert.equal((await nt.textContent('#title'))!.trim(), 'Margin.app isn’t running');
  await m.shoot(t, 'off', { page: nt });

  await m.shell.restart();
  await appUp();
  await m.shell.overlay();
  await m.until(async () => (await state()) === 'linked', { what: 'linked again' });
  await nt.waitForFunction(() => document.getElementById('notice')?.hidden === true, null, { timeout: 10_000 });
  await nt.close();
  await page.bringToFront();
  await m.shoot(t, 'back');
});

test('the app\'s goodbye: off at once, no waiting out the grace', async () => {
  await m.until(async () => (await state()) === 'linked', { what: 'linked' });
  const t0 = Date.now();
  m.shell.bye('quitting');
  await m.until(async () => (await state()) === 'off', { timeout: 3000, interval: 50, what: 'off' });
  assert.ok(Date.now() - t0 < 2500, `off in ${Date.now() - t0} ms`);
  const off = await stored();
  assert.equal(off?.state, 'off', 'the copy\'s link off at once');
  assert.deepEqual(off.drawn ?? {}, {}, 'no window drawn');
  await m.shell.restart();
  await appUp();
  await m.shell.overlay();
  await m.until(async () => (await state()) === 'linked', { what: 'linked again' });
});

test('a welcome with another key is refused: no hello on that socket', async () => {
  const before = hellos();
  await m.shell.kill();
  await m.until(async () => !m.shell.linked, { what: 'the link down' });
  await m.shell.restart({ welcome: () => ({ k: 'welcome', v: 2, key: 'not-the-key-it-was-given' }) });
  const asked = m.relay.asks.length;
  m.relay.dispatch('appUp', { v: 2, at: Date.now() });
  await m.until(() => m.relay.asks.length > asked, { what: 'the copy asking for the new app\'s link' });
  await pause(2000);
  assert.equal(hellos(), before, 'no hello to an app that said the wrong key');
  assert.equal(m.shell.app!.received.length, 0, 'nothing sent on that socket');
  // The real app again.
  await m.shell.restart();
  await appUp();
});
