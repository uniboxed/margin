// The link (app/PROTOCOL.md): the real extension, built with Safari's
// profile, linking to the stand-in Margin.app through the native messaging
// relay, and the real overlay drawing in WebKit. Then the page box, and the
// app starting after Safari (appUp, and Start on Margin's new-tab page).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, pageBox, slot } from './harness/ui.js';

const SEED = { spaces: SPACES, settings: { sidebarPinnedOpen: true } };

let m;
before(async () => { m = await startMargin({ name: 'link', seed: SEED }); });
after(async () => { await m?.close(); });

test('linking at start: hello, snapshot, theme, keys, the data set, and the overlay drawn', async (t) => {
  const { shell } = m;
  const kinds = shell.received.map((x) => x.k);
  assert.deepEqual(kinds.slice(0, 2), ['hello', 'snapshot'], 'hello first, then the snapshot');
  for (const k of ['theme', 'keys', 'data.hello']) assert.ok(kinds.includes(k), `the copy sent ${k}`);
  assert.equal(shell.hello.v, 2);
  assert.equal(shell.hello.browser, 'safari');
  assert.equal(shell.hello.owner, true);
  assert.match(shell.hello.profile, /^[A-Za-z0-9_.:-]{1,64}$/);
  const snapshot = shell.received.find((x) => x.k === 'snapshot');
  for (const key of ['openTabs', 'spaces', 'settings']) assert.ok(key in snapshot.state, `the snapshot has ${key}`);
  assert.ok(!('uiTheme' in snapshot.state), 'the theme goes as pieces, not in the state');
  assert.equal(shell.themeId, 'arcadia');
  assert.deepEqual(shell.keys.palette, ['Meta+KeyT']);

  // The seed came in as the app's data set: its spaces are the copy's, and the sidebar is kept open.
  await m.until(async () => (await m.stored('spaces')).spaces?.map((s) => s.id).join() === SPACES.map((s) => s.id).join(), { what: 'the seeded spaces' });
  const ui = await m.ui();
  await m.until(async () => (await sidebar(ui)).chips.length === 3, { what: 'three chips' });
  const drawn = await sidebar(ui);
  assert.deepEqual(drawn.chips.map((c) => c.id), SPACES.map((s) => s.id));
  assert.equal(drawn.space, 'Home');

  // drawn on before the first layout, and the layout is where the theme put the page.
  const windowId = shell.frontWindowId();
  assert.ok(shell.drawnSent.some((d) => d.windowId === windowId && d.on), 'the copy was told the app draws over the window');
  const layout = await m.until(() => shell.layoutsSent.findLast((l) => l.windowId === windowId), { what: 'a setLayout' });
  const s = await slot(ui);
  assert.deepEqual(layout.insets, { left: s.left, top: s.top, right: s.right, bottom: s.bottom });
  assert.deepEqual(layout.container, { width: 1440, height: 900 });

  // The copy's notes reach the app's log through the port; its pings are answered.
  await m.until(() => m.relay.logs.some((l) => /^linked on \d+/.test(l.line)), { what: 'the copy noting its link' });
  assert.equal(m.relay.ports, 1, 'one lasting native port');
  assert.ok(m.relay.asks.length >= 1, 'it asked for the link (wantLink)');

  assert.deepEqual(m.leaks, [], 'nothing left the Mac');
  assert.deepEqual(shell.blocked, [], 'the overlay loaded nothing from the web');
  assert.deepEqual(shell.pageErrors, [], 'no errors in the overlay');
  await m.shoot(t, 'linked');
});

test('a page opened while linked sits in the slot from its first frame', async (t) => {
  const page = await m.open('dispatch.test', '/2026/11/the-quiet-city?fp');
  const ui = await m.ui();
  const s = await slot(ui);
  const box = await m.until(() => pageBox(page), { what: 'the article\'s box' });
  assert.deepEqual({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }, s);
  assert.equal(box.width, 1440 - s.left - s.right, 'the page lays out at the slot\'s width');
  // The recorder (site/sites/common.js FIRST_FRAMES): where <html> sat in each early frame.
  const frames = await m.until(() => page.evaluate(() => (globalThis.__fp?.frames.length >= 10 ? globalThis.__fp.frames : null)), { what: 'the first frames' });
  assert.equal(Math.round(frames[0].x), s.left, `the first frame is already in the box: ${JSON.stringify(frames.slice(0, 3))}`);
  assert.equal(Math.round(frames[0].y), s.top);
  await m.shoot(t, 'article');
  await page.close();
});

test('the overlay follows the state: a tab opened, retitled and closed', async () => {
  const ui = await m.ui();
  const page = await m.open('shop.test', '/p/canvas-tote');
  const tab = await m.front();
  await m.until(async () => (await sidebar(ui)).tabs.find((r) => r.id === tab.id && r.active), { what: 'the product\'s row, highlighted' });
  await page.click('#add');
  await m.until(async () => (await sidebar(ui)).tabs.find((r) => r.id === tab.id)?.title.startsWith('(1) Bag'), { what: 'the new title in the row' });
  await page.close();
  await m.until(async () => !(await sidebar(ui)).tabs.some((r) => r.id === tab.id), { what: 'the row gone' });
});

test('the app starting after Safari: unlinked, the new-tab notice; then appUp links', async (t) => {
  const late = await startMargin({ name: 'link', running: false, seed: SEED });
  try {
    const page = await late.context.newPage();
    await page.goto(late.newTabUrl());
    await page.waitForSelector('#notice:not([hidden])');
    assert.equal((await page.textContent('#title')).trim(), 'Margin.app isn’t running');
    assert.equal(await page.isVisible('#start'), true);
    await late.shoot(t, 'not-running', { page });
    assert.equal(late.shell.hello, null);
    late.shell.setRunning(true);
    late.relay.dispatch('appUp', { v: 2, at: Date.now() });
    await late.linked();
    await late.fullscreen();
    // Linked: the new-tab page says nothing of its own (it loads again) and the overlay draws the launcher over it.
    await page.waitForFunction(() => document.getElementById('notice')?.hidden === true, null, { timeout: 10_000 });
    const ui = await late.ui();
    await late.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher in the overlay' });
    await late.shoot(t, 'linked-launcher', { page });
  } finally {
    await late.close();
  }
});

test('Start on Margin\'s new-tab page: the handler starts the app, and the copy links once it\'s up', async (t) => {
  const late = await startMargin({ name: 'link', running: false, seed: SEED });
  try {
    const page = await late.context.newPage();
    await page.goto(late.newTabUrl());
    await page.waitForSelector('#start:not([hidden])');
    late.shell.setRunning(false, { starting: true });
    const asked = late.relay.asks.length;
    await page.click('#start');
    assert.equal((await page.textContent('#status')).trim(), 'Starting Margin.app…');
    // Told it's starting, the copy asks again every half second (PROTOCOL.md Transport, step 1).
    await late.until(() => late.relay.asks.length >= asked + 2, { what: 'the copy asking again while the app starts' });
    late.shell.setRunning(true);
    await late.linked();
    assert.equal(late.shell.hello.browser, 'safari');
    await late.shoot(t, 'started', { page });
  } finally {
    await late.close();
  }
});
