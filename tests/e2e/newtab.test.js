// Margin's new-tab page while Margin.app draws: the page shows nothing of
// its own and the overlay draws the theme's launcher in the slot over it; an
// address chosen there opens in that tab (openHere); an archived tab comes
// back in its place; Settings; the start page opened on purpose stays; and a
// window the app doesn't draw over says so. (The unlinked notice and Start
// are in link.test.js.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar } from './harness/ui.js';

let m;
let ui;

const SEED = (url) => ({
  spaces: SPACES,
  archive: [{ id: 'ar-feed', url: url('murmur.test', '/home'), title: '(3) Murmur', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 3600_000 }],
  settings: { sidebarPinnedOpen: true },
});

const frontId = async () => (await m.front())?.id;
async function newTabPage(hash = '') {
  const page = await m.context.newPage();
  await page.goto(m.newTabUrl() + hash);
  const tab = await m.until(async () => { const f = await m.front(); return f?.url.startsWith(m.newTabUrl()) && f; }, { what: 'the new-tab page in front' });
  return { page, tab };
}

before(async () => {
  m = await startMargin({ name: 'newtab', seed: SEED });
  ui = await m.ui();
});
after(async () => { await m?.close(); });

test('linked, the overlay draws the launcher over Margin\'s new-tab page', async (t) => {
  const { page } = await newTabPage();
  await m.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher' });
  assert.ok(await ui.isVisible('.launcher .launcher-query'));
  assert.ok((await sidebar(ui)).newTabActive, 'New Tab is the highlighted row');
  // The launcher sits in the page slot.
  const [l, s] = await Promise.all([ui.locator('.launcher-slot').boundingBox(), ui.locator('m-page').boundingBox()]);
  assert.ok(l.x >= s.x - 1 && l.x + l.width <= s.x + s.width + 1, 'inside the slot');
  await m.shoot(t, 'launcher', { page });
  await page.close();
});

// Found by this suite (2026-11-06): newtab.html's `main { display: grid }` overrides the `hidden`
// attribute, so the page lays its "Margin.app isn't running" notice out even while linked. The
// launcher covers it in the slot; it shows wherever the launcher doesn't (before it draws).
test('linked, Margin\'s new-tab page lays out nothing of its own', { todo: 'the hidden notice is drawn: main { display: grid } beats [hidden]' }, async () => {
  const { page } = await newTabPage();
  try {
    await page.waitForFunction(() => document.getElementById('notice')?.hidden === true);
    assert.equal(await page.isVisible('#notice'), false, 'the notice is not drawn');
  } finally {
    await page.close();
  }
});

test('an address chosen in the launcher opens in that tab', async () => {
  const { tab } = await newTabPage();
  await m.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher' });
  await ui.fill('.launcher-query', m.url('docs.test', '/guide/getting-started'));
  await ui.press('.launcher-query', 'Enter');
  await m.until(async () => (await m.tabs()).find((x) => x.id === tab.id)?.url === m.url('docs.test', '/guide/getting-started'), { what: 'the same tab on the docs' });
  assert.ok(m.shell.requests.some((r) => r.type === 'openHere' && r.payload.tabId === tab.id), 'openHere for that tab');
  await m.until(async () => !(await sidebar(ui)).launcher, { what: 'the launcher gone' });
});

test('an archived tab restored from the launcher takes the new-tab page\'s place', async (t) => {
  const { tab } = await newTabPage();
  await m.until(async () => ui.isVisible('.archive-row'), { what: 'the archive list' });
  await m.shoot(t, 'archive-list');
  const before = (await m.tabs()).length;
  await ui.click('.archive-row');
  await m.until(async () => (await m.front())?.url === m.url('murmur.test', '/home'), { what: 'the feed in front' });
  const now = await m.tabs();
  assert.ok(!now.some((x) => x.id === tab.id && x.url.startsWith(m.newTabUrl())), 'the new-tab page is gone');
  assert.equal(now.length, before, 'in its place, not beside it');
  await m.until(async () => !(await m.stored('archive')).archive.some((a) => a.id === 'ar-feed'), { what: 'out of the archive' });
});

test('Settings open from the launcher', async (t) => {
  const { page } = await newTabPage();
  await m.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher' });
  await ui.click('.launcher .settings-summary button');
  await m.until(() => ui.isVisible('.settings-form .setting'), { what: 'the settings form' });
  const labels = await ui.$$eval('.settings-form .setting .label', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(labels.length >= 5, `settings rows: ${labels.join(' | ')}`);
  await m.shoot(t, 'settings', { page });
  await page.close();
});

// Found by this suite (2026-11-06): Margin's start page opened on purpose (newtab.html#launcher or
// #settings: the archive button, Settings from elsewhere, openLauncher) isn't a new-tab page to the
// overlay (shared/view.js NEW_TAB_PAGE ends at an optional query, so a #hash doesn't match): no
// launcher is drawn over it, the sidebar lists it as a "New Tab" row, and the page shows its own
// "Margin.app isn't running" notice (the [hidden] bug above) while the app is linked.
test('Margin\'s start page opened on purpose (#launcher) is drawn as the launcher and stays open', { todo: 'newtab.html#launcher gets no launcher; the page says "Margin.app isn\'t running" while linked' }, async (t) => {
  const { page, tab } = await newTabPage('#launcher');
  try {
    await m.shoot(t, 'start-page', { page });
    await m.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher' });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok((await m.tabs()).some((x) => x.id === tab.id), 'the start page wasn\'t handed off and closed');
    assert.equal(await frontId(), tab.id);
  } finally {
    await page.close();
  }
});

test('a window the app says it doesn\'t draw over: the page says so itself', async (t) => {
  const { page } = await newTabPage();
  const windowId = m.shell.frontWindowId();
  m.shell.drawn(windowId, false);
  try {
    await page.waitForFunction(() => document.getElementById('notice')?.hidden === false, null, { timeout: 8000 });
    assert.equal((await page.textContent('#title')).trim(), 'Margin.app hasn’t placed this window yet');
    assert.equal(await page.isVisible('#start'), false, 'no Start: the app is running');
    await m.shoot(t, 'undrawn', { page });
  } finally {
    m.shell.drawn(windowId, true);
  }
  await page.waitForFunction(() => document.getElementById('notice')?.hidden === true, null, { timeout: 8000 });
  await page.close();
});
