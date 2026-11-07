// The link going and coming back (app/PROTOCOL.md "Liveness", background/
// link.js): a socket dropped and mended at once; the app gone for a moment
// (the overlay dimmed, "Reconnecting", pages keep their box) and back within
// the grace; gone for longer than 6 s (no box, the new-tab notice), then a
// new app; the app's goodbye (off at once); a socket whose welcome has the
// wrong key, refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, pageBox, slot } from './harness/ui.js';

let m;
let page;

const sides = (b) => b && { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
const hellos = () => m.shell.received.filter((x) => x.k === 'hello').length;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const s = await slot(await m.ui());
  await m.until(async () => JSON.stringify(sides(await pageBox(page))) === JSON.stringify(s), { what: 'the travel page in its box' });
});
after(async () => { await m?.close(); });

test('a dropped socket is mended at once from the kept link', async () => {
  const before = hellos();
  const box = sides(await pageBox(page));
  const t0 = Date.now();
  m.shell.drop();
  await m.until(() => hellos() > before && m.shell.linked, { what: 'linked again' });
  assert.ok(Date.now() - t0 < 2000, `linked again in ${Date.now() - t0} ms`);
  await m.until(() => m.relay.logs.some((l) => /^kept link try 1 of \d+ \(port \d+\): open/.test(l.line)), { what: 'the copy noting its first try worked' });
  assert.deepEqual(sides(await pageBox(page)), box, 'the page kept its box');
  assert.equal(m.shell.overlays.size, 1, 'the overlay stayed');
});

test('the app gone a moment: the overlay dimmed, "Reconnecting", pages keep their box; back within the grace, as it was', async (t) => {
  const ui = await m.ui();
  await ui.evaluate(() => { window.__same = true; });
  const box = sides(await pageBox(page));
  await m.shell.kill();
  await m.until(() => ui.evaluate(() => document.documentElement.hasAttribute('data-reconnecting')), { what: 'the overlay dimmed' });
  const words = await ui.evaluate(() => document.getElementById('margin-reconnecting')?.textContent ?? '');
  assert.match(words, /Reconnecting/);
  await pause(1500);
  assert.deepEqual(sides(await pageBox(page)), box, 'the page keeps its box while the app may come back');
  await m.shoot(t, 'reconnecting');

  await m.shell.restart();
  await appUp();
  await m.until(() => ui.evaluate(() => !document.documentElement.hasAttribute('data-reconnecting')), { what: 'the overlay lit again' });
  assert.equal(await ui.evaluate(() => window.__same === true), true, 'the same overlay page, not a new one');
  assert.deepEqual(sides(await pageBox(page)), box);
  assert.ok((await sidebar(ui)).tabs.length >= 2, 'its rows still there');
});

test('the app gone past 6 s: no box, the new-tab page says so; a new app links and the box comes back', async (t) => {
  const box = sides(await pageBox(page));
  await m.shell.kill();
  const t0 = Date.now();
  await m.until(async () => (await pageBox(page)) === null, { timeout: 10_000, interval: 100, what: 'no box' });
  const after = Date.now() - t0;
  assert.ok(after >= 5500, `the box held through the grace (${after} ms)`);
  assert.equal(await page.evaluate(() => innerWidth), 1440, 'the page has the whole window');
  await m.until(() => m.shell.overlays.size === 0, { what: 'the overlays closed' });
  const nt = await m.context.newPage();
  await nt.goto(m.newTabUrl());
  await nt.waitForSelector('#notice:not([hidden])');
  assert.equal((await nt.textContent('#title')).trim(), 'Margin.app isn’t running');
  await m.shoot(t, 'off', { page: nt });

  await m.shell.restart();
  await appUp();
  await m.shell.overlay();
  await m.until(async () => JSON.stringify(sides(await pageBox(page))) === JSON.stringify(box), { what: 'the box back' });
  await nt.waitForFunction(() => document.getElementById('notice')?.hidden === true, null, { timeout: 10_000 });
  await nt.close();
  await page.bringToFront();
  await m.shoot(t, 'back');
});

test('the app\'s goodbye: off at once, no waiting out the grace', async () => {
  await m.until(async () => (await pageBox(page)) !== null, { what: 'a box' });
  const t0 = Date.now();
  m.shell.bye('quitting');
  await m.until(async () => (await pageBox(page)) === null, { timeout: 3000, interval: 50, what: 'no box' });
  assert.ok(Date.now() - t0 < 2500, `off in ${Date.now() - t0} ms`);
  assert.equal(m.shell.overlays.size, 0, 'the overlays closed at once');
  await m.shell.restart();
  await appUp();
  await m.shell.overlay();
  await m.until(async () => (await pageBox(page)) !== null, { what: 'the box back' });
});

test('a welcome with another key is refused: no hello on that socket', async () => {
  const before = hellos();
  await m.shell.kill();
  await m.until(async () => (await pageBox(page)) === null || !m.shell.linked, { what: 'the link down' });
  await m.shell.restart({ welcome: () => ({ k: 'welcome', v: 2, key: 'not-the-key-it-was-given' }) });
  const asked = m.relay.asks.length;
  m.relay.dispatch('appUp', { v: 2, at: Date.now() });
  await m.until(() => m.relay.asks.length > asked, { what: 'the copy asking for the new app\'s link' });
  await pause(2000);
  assert.equal(hellos(), before, 'no hello to an app that said the wrong key');
  assert.equal(m.shell.app.received.length, 0, 'nothing sent on that socket');
  // The real app again.
  await m.shell.restart();
  await appUp();
});
