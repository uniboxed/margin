// Tabs in the overlay's sidebar, on real-looking pages: a click shows the
// tab, a switch made in the browser moves the highlight, one highlight only
// (also when the browser switches right after a click), × closes and
// archives, New Tab opens the palette, a drag reorders, and a tab closed
// meanwhile says so. (The old sidebar.test.js drove the in-page sidebar.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, palette, drag, tabRow, pageBox, slot } from './harness/ui.js';

let m;
let ui;
const ids = {};

const rows = async () => (await sidebar(ui)).tabs;
const activeRows = async () => (await rows()).filter((r) => r.active).map((r) => r.id);
const frontId = async () => (await m.front())?.id;

before(async () => {
  m = await startMargin({ name: 'tabs', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  await m.open('dispatch.test', '/2026/11/the-quiet-city');
  ids.article = await frontId();
  await m.open('shop.test', '/');
  ids.shop = await frontId();
  await m.open('docs.test', '/guide/getting-started');
  ids.docs = await frontId();
  ui = await m.ui();
  await m.until(async () => (await rows()).length >= 4, { what: 'four rows' });
});
after(async () => { await m?.close(); });

test('a click in the overlay shows that tab; a switch in the browser moves the highlight', async (t) => {
  await ui.click(tabRow(ids.shop));
  await m.until(async () => (await frontId()) === ids.shop, { what: 'the shop in front' });
  await m.until(async () => (await activeRows()).join() === String(ids.shop), { what: 'the shop highlighted' });
  // The page in front is in the slot.
  const page = await m.pageOf(ids.shop);
  const box = await pageBox(page);
  assert.deepEqual({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }, await slot(ui));
  await m.shoot(t, 'shop-clicked');

  await m.bg((id) => chrome.tabs.update(id, { active: true }), ids.article);
  await m.until(async () => (await activeRows()).join() === String(ids.article), { what: 'the article highlighted' });
  await m.shoot(t, 'article-from-browser');
});

test('one highlight only, also when the browser switches right after a click', async () => {
  const times = [];
  for (let round = 0; round < 4; round++) {
    await ui.click(tabRow(ids.docs));
    await new Promise((r) => setTimeout(r, 100));
    const from = Date.now();
    await m.bg((id) => chrome.tabs.update(id, { active: true }), ids.shop);
    // Sampled while it settles: never two rows highlighted.
    let seenTwo = false;
    await m.until(async () => {
      const act = await activeRows();
      if (act.length > 1) seenTwo = true;
      return act.length === 1 && act[0] === ids.shop;
    }, { interval: 10, timeout: 4000, what: 'the shop highlighted after the browser\'s switch' });
    times.push(Date.now() - from);
    assert.equal(seenTwo, false, 'two rows were highlighted at once');
    assert.equal(await frontId(), ids.shop);
    await m.until(async () => (await activeRows()).join() === String(ids.shop), { what: 'settled' });
  }
  // The probe saw 2.3 s once (docs/e2e-plan.md, open questions); a person notices anything near a second.
  assert.ok(Math.max(...times) < 1000, `the highlight followed the browser in ${times.join(', ')} ms`);
  assert.ok(!m.shell.overlayLogs.some((l) => /went back/.test(l.text)), `the overlay's highlight went back: ${m.shell.overlayLogs.map((l) => l.text).join(' | ')}`);
});

test('× closes the tab and archives it', async (t) => {
  await m.open('focus.test', '/');
  const timer = await frontId();
  await m.until(async () => (await rows()).some((r) => r.id === timer), { what: 'the timer\'s row' });
  await ui.hover(tabRow(timer));
  await m.shoot(t, 'hover');
  await ui.click(`${tabRow(timer)} .close`);
  await m.until(async () => !(await m.tabs()).some((x) => x.id === timer), { what: 'the browser tab closed' });
  await m.until(async () => !(await rows()).some((r) => r.id === timer), { what: 'the row gone' });
  const { archive } = await m.stored('archive');
  assert.ok(archive.some((a) => a.url.startsWith(m.url('focus.test', '/')) && /Focus/.test(a.title)), 'the timer is in the archive');
});

test('the New Tab row opens the palette, for a new tab', async (t) => {
  await ui.click('.new-tab-row');
  const p = await m.until(async () => { const x = await palette(ui); return x.open && x.focused && x; }, { what: 'the palette, its field focused' });
  assert.equal(p.query, '');
  assert.ok(m.shell.overlays.get(m.shell.frontWindowId()).focus, 'the overlay asked the app for the keyboard');
  await m.shoot(t, 'palette');
  await ui.keyboard.press('Escape');
  await m.until(async () => !(await palette(ui)).open, { what: 'the palette closed' });
});

test('dragging a row reorders the tabs, in the sidebar and the browser', async (t) => {
  const before = (await rows()).map((r) => r.id);
  const last = before.at(-1);
  const first = before[0];
  await drag(ui, tabRow(last), tabRow(first), { at: 0.15 });
  await m.until(async () => (await rows())[0]?.id === last, { what: `the dragged row first (was ${before.join()})` });
  const move = m.shell.requests.findLast((r) => r.type === 'moveTab');
  assert.equal(move?.payload.tabId, last);
  assert.equal(move.reply?.ok, true);
  // Each tab once (what the drag drew is gone).
  const after = await m.until(async () => { const ids2 = (await rows()).map((r) => r.id); return new Set(ids2).size === ids2.length && ids2; }, { timeout: 2000, what: 'one row per tab after the drop' });
  assert.deepEqual([...after].sort(), [...before].sort(), 'the same tabs');
  await m.shoot(t, 'reordered');
});

test('a tab closed meanwhile: its row says it is no longer open', async (t) => {
  await m.open('noir.test', '/');
  const noir = await frontId();
  await m.until(async () => (await rows()).some((r) => r.id === noir), { what: 'the portfolio\'s row' });
  await ui.click(tabRow(ids.shop));
  await m.until(async () => (await frontId()) === ids.shop, { what: 'the shop in front' });
  // The overlay lags behind (the app's word held back) while the tab closes in the browser.
  m.shell.hold(true);
  try {
    await m.bg((id) => chrome.tabs.remove(id), noir);
    await m.until(async () => !(await m.tabs()).some((x) => x.id === noir), { what: 'the tab gone' });
    await ui.click(tabRow(noir));
    const notice = await m.until(async () => (await sidebar(ui)).notice, { what: 'a notice' });
    assert.equal(notice, 'That tab is no longer open.');
    await m.shoot(t, 'notice');
  } finally {
    m.shell.hold(false);
  }
  await m.until(async () => !(await rows()).some((r) => r.id === noir), { what: 'the row gone once the overlay catches up' });
  assert.equal(await frontId(), ids.shop, 'the tab in front stayed');
});

// Found by this suite (2026-11-06): a tab open before the app's data set came in (a first link, or
// Safari's storage wiped) stays in the copy's default space, which the set replaces: the tab is in
// no space the sidebar shows, and no row draws it.
test('a tab open before the app\'s set came in is in a space the sidebar shows', { todo: 'the tab keeps the default space the set removed (tabSpace "personal"), and no row shows it' }, async () => {
  const early = await startMargin({ name: 'tabs', running: false });
  try {
    const page = early.context.pages()[0];
    await page.goto(early.url('harbor.test', '/'));
    const tab = (await early.tabs()).find((x) => x.url.startsWith(early.url('harbor.test', '/')));
    early.shell.seed((await import('./harness/seed.js')).seedSet({ spaces: SPACES, settings: { sidebarPinnedOpen: true } }));
    early.shell.setRunning(true);
    early.relay.dispatch('appUp', { v: 2, at: Date.now() });
    await early.linked();
    await early.fullscreen();
    const view = await early.ui();
    await early.until(async () => (await early.stored('spaces')).spaces?.[0]?.id === 'sp-home', { what: 'the seed taken' });
    const state = await early.state();
    assert.ok(state.spaces.some((s) => s.id === state.tabSpace[tab.id]), `the tab's space (${state.tabSpace[tab.id]}) is one of the spaces`);
    await early.until(async () => (await sidebar(view)).tabs.some((r) => r.id === tab.id), { what: 'the travel page\'s row' });
  } finally {
    await early.close();
  }
});
