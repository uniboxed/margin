// Navigation: the app's next/previous tab and space keys (the copy's
// `navigate`, as Shortcuts.swift sends it), in the sidebar's order and
// wrapping, fast presses chained, a switch by hand starting a new chain;
// linked, the page's own keys and the extension's commands do nothing but
// say so, and Margin's new-tab page takes the same keys; Back, Forward and
// Reload from the overlay's buttons; addresses a site changes itself
// (pushState, a hash) stored at once; and a slow same-page navigation (the
// Navigation API) drawn as loading.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar, tabRow, chip } from './harness/ui.ts';

let m;
let ui;
let windowId;

const view = () => sidebar(ui);
const frontId = async () => (await m.front())?.id;
const order = async () => (await view()).tabs.map((r) => r.id);
// A window not switched yet shows the first space.
const spaceOfWindow = async () => (await m.state()).activeSpaceByWindow?.[windowId] ?? 'sp-home';
async function show(id) {
  await ui.click(tabRow(id));
  await m.until(async () => (await frontId()) === id && (await view()).tabs.find((r) => r.active)?.id === id, { what: `tab ${id} in front` });
  // A press after a switch by hand starts a new chain (background/navigation.ts): let the last one end.
  await new Promise((r) => setTimeout(r, 1600));
}
const pushes = (type, from = 0) => m.shell.received.slice(from).filter((x) => x.k === 'push' && x.msg?.type === type).map((x) => x.msg);

before(async () => {
  m = await startMargin({ name: 'navigation', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  windowId = m.shell.frontWindowId();
  for (const [host, path] of [['dispatch.test', '/2026/11/the-quiet-city'], ['shop.test', '/'], ['docs.test', '/guide/getting-started'], ['radio.test', '/']]) await m.open(host, path);
  ui = await m.ui();
  await m.until(async () => (await order()).length === 5, { what: 'five rows' });
});
after(async () => { await m?.close(); });

test('next and previous tab follow the sidebar\'s order and wrap', async (t) => {
  const rows = await order();
  await show(rows[1]);
  await m.shell.navigate('next-tab');
  await m.until(async () => (await frontId()) === rows[2], { what: 'the next row' });
  await m.until(async () => (await view()).tabs.find((r) => r.active)?.id === rows[2], { what: 'its highlight' });
  await m.shell.navigate('prev-tab');
  await m.until(async () => (await frontId()) === rows[1], { what: 'back up' });
  await show(rows.at(-1));
  await m.shell.navigate('next-tab');
  await m.until(async () => (await frontId()) === rows[0], { what: 'from the last row to the first' });
  await m.shell.navigate('prev-tab');
  await m.until(async () => (await frontId()) === rows.at(-1), { what: 'from the first to the last' });
  await m.shoot(t, 'wrapped');
});

test('fast presses all count: each goes on from the one before, told to the overlay as one chain', async () => {
  const rows = await order();
  await show(rows[0]);
  const from = m.shell.received.length;
  await Promise.all([m.shell.navigate('next-tab'), m.shell.navigate('next-tab'), m.shell.navigate('next-tab')]);
  await m.until(async () => (await frontId()) === rows[3], { what: 'three rows down' });
  await m.until(async () => (await view()).tabs.find((r) => r.active)?.id === rows[3], { what: 'the highlight there' });
  const switching = pushes('switching', from);
  assert.equal(switching.length, 3, 'each press told at once');
  assert.equal(new Set(switching.map((s) => s.chain)).size, 1, 'one chain');
  assert.deepEqual(switching.map((s) => s.tabId), [rows[1], rows[2], rows[3]]);
  await m.until(() => pushes('switch-done', from).length === 3, { what: 'each one settled' });
  assert.deepEqual(pushes('switch-failed', from), []);
  const back = m.shell.overlayLogs.filter((l) => /went back [1-9]/.test(l.text)).map((l) => l.text);
  assert.deepEqual(back, [], 'the highlight never went back');
});

test('a switch by hand starts a new chain', async () => {
  const rows = await order();
  // A chain to the last row, then a click on the first and a press, all inside the chain's 1.5 s.
  // Kept going, the chain would go on from the last row: wrapping to the first, the one clicked.
  // A machine too slow to fit it in that time tries again (the chain ran out: nothing proved).
  for (let attempt = 1; ; attempt++) {
    await show(rows[2]);
    await m.shell.navigate('next-tab');
    const t0 = Date.now();
    await m.shell.navigate('next-tab');
    await m.until(async () => (await frontId()) === rows[4], { what: 'two rows down, the last row' });
    await ui.click(tabRow(rows[0]));
    // In front, and the copy's state says so (what the next press counts from).
    await m.until(async () => (await frontId()) === rows[0] && (await m.state()).tabs[rows[0]]?.active === true, { what: 'the clicked row in front' });
    await m.shell.navigate('next-tab');
    const elapsed = Date.now() - t0;
    if (elapsed >= 1400 && attempt < 3) continue;
    assert.ok(elapsed < 1400, `pressed inside the chain's time (${elapsed} ms after the chain's last press)`);
    await m.until(async () => (await frontId()) === rows[1], { what: 'one down from the clicked row' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await frontId(), rows[1], 'exactly one row down');
    return;
  }
});

test('Margin\'s new-tab page takes the same next-tab key as web pages', async () => {
  const rows = await order();
  const nt = await m.context.newPage();
  await nt.goto(m.newTabUrl());
  await m.until(async () => (await m.front())?.url.startsWith(m.newTabUrl()), { what: 'the new-tab page in front' });
  // It has no row of its own (the sidebar's New Tab row is lit): the next tab is the first row.
  await m.until(async () => (await view()).newTabActive, { what: 'the New Tab row lit' });
  assert.deepEqual(await order(), rows, 'no row for the new-tab page');
  const key = (await m.stored('settings')).settings.shortcuts.nextTab;
  await nt.bringToFront();
  await nt.keyboard.press(key.replace(/\bCtrl\b/, 'Control'));
  await m.until(async () => (await frontId()) === rows[0], { what: 'the first row, from the new-tab page' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await frontId(), rows[0], 'exactly one');
  await nt.close();
});

test('next and previous space, wrapping', async (t) => {
  assert.equal(await spaceOfWindow(), 'sp-home');
  await m.shell.navigate('next-space');
  await m.until(async () => (await spaceOfWindow()) === 'sp-work', { what: 'Work' });
  await m.until(async () => (await view()).space === 'Work', { what: 'Work drawn' });
  await m.shell.navigate('prev-space');
  await m.until(async () => (await spaceOfWindow()) === 'sp-home', { what: 'Home' });
  await m.shell.navigate('prev-space');
  await m.until(async () => (await spaceOfWindow()) === 'sp-trips', { what: 'from the first space to the last' });
  await m.shoot(t, 'trips');
  await ui.click(chip('sp-home'));
  await m.until(async () => (await view()).space === 'Home', { what: 'Home again' });
});

test('linked, the page\'s own keys: its next-tab key moves one tab; ⌘T only tells the app it was heard', async () => {
  const rows = await order();
  await show(rows[1]);
  const page = await m.pageOf(rows[1]);
  const key = (await m.stored('settings')).settings.shortcuts.nextTab;
  await page.bringToFront();
  await page.keyboard.press(key.replace(/\bCtrl\b/, 'Control'));
  await m.until(async () => (await frontId()) === rows[2], { what: 'one row down' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await frontId(), rows[2], 'exactly one');

  // ⌘T is the app's hot key while it draws: a page that hears it anyway does nothing but say so.
  const next = await m.pageOf(rows[2]);
  const tabs = (await m.tabs()).length;
  const from = m.shell.received.length;
  await next.keyboard.press('Meta+KeyT');
  const heard = await m.until(() => pushes('keyHeard', from)[0], { what: 'keyHeard' });
  assert.deepEqual({ command: heard.command, from: heard.from }, { command: 'palette', from: 'page' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await m.tabs()).length, tabs, 'no new tab');
  assert.equal((await view()).palette, false, 'no palette: the app\'s key opens it, not the page');
});

test('a site\'s own address changes are stored at once: pushState and a hash', async () => {
  const appPage = await m.open('app.test', '/');
  const tab = await frontId();
  await appPage.click('a[href="/projects"][data-link]');
  await m.until(async () => (await m.state()).tabs[tab]?.url === m.url('app.test', '/projects'), { timeout: 2000, what: 'the pushState address stored' });
  const docs = await m.open('docs.test', '/guide/getting-started');
  const docsTab = await frontId();
  await docs.click('h2 a.anchor');
  const hash = await docs.evaluate(() => location.hash);
  assert.ok(hash.length > 1);
  await m.until(async () => (await m.state()).tabs[docsTab]?.url === m.url('docs.test', `/guide/getting-started${hash}`), { timeout: 2000, what: 'the hash stored' });
});

test('a slow same-page navigation (the Navigation API) shows as loading on its row', async (t) => {
  const appPage = await m.open('app.test', '/');
  const tab = await frontId();
  const from = m.shell.received.length;
  await appPage.click('a[href="/reports"]');
  await m.until(async () => (await view()).tabs.find((r) => r.id === tab)?.busy, { timeout: 2000, what: 'the row busy' });
  await m.shoot(t, 'loading');
  assert.ok(pushes('loading', from).some((p) => p.tabIds.includes(tab)), 'the copy said it\'s loading');
  await appPage.waitForSelector('.report-ready');
  await m.until(async () => !(await view()).tabs.find((r) => r.id === tab)?.busy, { what: 'not busy once drawn' });
});

test('Back, Forward and Reload from the overlay\'s buttons (Neo-brutalism draws them)', async (t) => {
  assert.equal((await m.shell.request('updateSettings', { patch: { theme: 'neo-brutalism' } }, windowId)).ok, true);
  await m.until(() => m.shell.themeId === 'neo-brutalism', { what: 'the theme sent' });
  await m.until(() => ui.isVisible('[m-action="nav.back"], button[aria-label="Back"]'), { what: 'the Back button' });
  try {
    const docs = await m.open('docs.test', '/guide/getting-started');
    const tab = await frontId();
    await docs.click('nav.pager a.nx');
    await docs.waitForURL(m.url('docs.test', '/guide/installation'));
    await m.shoot(t, 'neo-docs');
    await ui.click('button[aria-label="Back"]');
    await m.until(async () => (await m.tabs()).find((x) => x.id === tab)?.url === m.url('docs.test', '/guide/getting-started'), { what: 'back' });
    await ui.click('button[aria-label="Forward"]');
    await m.until(async () => (await m.tabs()).find((x) => x.id === tab)?.url === m.url('docs.test', '/guide/installation'), { what: 'forward' });
    const page = await m.pageOf(tab);
    await page.evaluate(() => { window.__before = true; });
    await ui.click('button[aria-label="Reload"]');
    await m.until(() => page.evaluate(() => !window.__before).catch(() => false), { what: 'the page loaded again' });
  } finally {
    await m.shell.request('updateSettings', { patch: { theme: 'arcadia' } }, windowId);
    await m.until(() => m.shell.themeId === 'arcadia', { what: 'Arcadia again' });
  }
});
