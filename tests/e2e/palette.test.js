// The palette in the overlay, over real pages: the app's key opens it with
// its field focused, typing ranks real titles, arrows and Enter, an address
// opens, a search goes to Safari's engine (answered locally), archived tabs
// and pins are found, New window. And the Safari profile's search engine:
// Google with Safari's parameters until Safari searches, then the engine
// Safari used (learned from its own search addresses, not a site's).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, palette } from './harness/ui.js';

let m;
let ui;
const ids = {};

const DAY = 24 * 3600_000;
const SEED = (url) => ({
  spaces: SPACES,
  pins: [{ id: 'pin-radio', spaceId: 'sp-home', url: url('radio.test', '/'), title: 'The sound of low tide · Radio Field', pos: 0 }],
  archive: [
    { id: 'ar-tote', url: url('shop.test', '/p/canvas-tote'), title: 'Canvas Tote — Common Goods', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 2 * DAY },
    { id: 'ar-report', url: url('slow.test', '/report'), title: 'Q3 2026 Field Report · Almanac', spaceId: 'sp-work', favIconUrl: '', closedAt: Date.now() - 5 * DAY },
  ],
  settings: { sidebarPinnedOpen: true },
});

const frontId = async () => (await m.front())?.id;
const settings = async () => (await m.stored('settings')).settings;
async function openPalette() {
  m.shell.key('palette');
  return m.until(async () => { const p = await palette(ui); return p.open && p.focused && p; }, { what: 'the palette open, its field focused' });
}
async function type(text) {
  await ui.keyboard.type(text);
  return m.until(async () => { const p = await palette(ui); return p.query === text && p.rows.length && p; }, { what: `rows for "${text}"` });
}
async function closePalette() {
  if (!(await palette(ui)).open) return;
  await ui.keyboard.press('Escape');
  await m.until(async () => !(await palette(ui)).open, { what: 'the palette closed' });
}

before(async () => {
  m = await startMargin({ name: 'palette', seed: SEED });
  await m.open('dispatch.test', '/2026/11/the-quiet-city');
  ids.article = await frontId();
  await m.open('docs.test', '/guide/getting-started');
  ids.docs = await frontId();
  await m.open('murmur.test', '/home');
  ids.feed = await frontId();
  ui = await m.ui();
  await m.until(async () => (await sidebar(ui)).tabs.length >= 4, { what: 'the rows' });
});
after(async () => { await m?.close(); });

test('the app\'s key opens the palette; typing finds a page by its title; Enter shows it', async (t) => {
  await openPalette();
  const p = await type('quiet city');
  assert.equal(p.rows[0].id, `tab:${ids.article}`, `the article first: ${JSON.stringify(p.rows.map((r) => r.title))}`);
  assert.equal(p.rows[0].title, 'The Quiet City | The Dispatch');
  await m.shoot(t, 'quiet-city');
  await ui.keyboard.press('Enter');
  await m.until(async () => (await frontId()) === ids.article, { what: 'the article in front' });
  await m.until(async () => !(await palette(ui)).open, { what: 'the palette closed' });
});

test('arrows move the selection; Enter runs the selected row', async () => {
  await openPalette();
  const p = await type('getting started');
  const docsAt = p.rows.findIndex((r) => r.id === `tab:${ids.docs}`);
  assert.ok(docsAt >= 0, 'the docs are found');
  // Down from the first row to the docs' row.
  for (let i = 0; i < docsAt; i++) await ui.keyboard.press('ArrowDown');
  await m.until(async () => (await palette(ui)).rows.find((r) => r.selected)?.id === `tab:${ids.docs}`, { what: 'the docs selected' });
  await ui.keyboard.press('Enter');
  await m.until(async () => (await frontId()) === ids.docs, { what: 'the docs in front' });
});

test('archived tabs and pins are found, and an archived tab comes back in its space', async (t) => {
  await openPalette();
  let p = await type('canvas tote');
  const row = p.rows.find((r) => r.id === 'archive:ar-tote');
  assert.ok(row, `the archived tote is found: ${JSON.stringify(p.rows.map((r) => r.id))}`);
  await m.shoot(t, 'archived');
  await ui.click(`.palette .result[data-id="archive:ar-tote"]`);
  await m.until(async () => (await m.front())?.url === m.url('shop.test', '/p/canvas-tote'), { what: 'the tote open again' });
  const tote = await frontId();
  assert.equal((await m.state()).tabSpace[tote], 'sp-home');
  await m.until(async () => !(await m.stored('archive')).archive.some((a) => a.id === 'ar-tote'), { what: 'out of the archive' });

  await openPalette();
  p = await type('low tide');
  assert.ok(p.rows.some((r) => r.id === 'pin:pin-radio'), 'the pin is found');
  await closePalette();
});

test('an address opens in a new tab: a local address with a port, and a site typed with http://', async () => {
  await openPalette();
  // A local address with a port: http (the test server maps it to its index).
  const local = `127.0.0.1:${m.site.port}/`;
  let p = await type(local);
  assert.equal(p.rows[0].id, 'go');
  assert.equal(p.rows[0].title, `Open http://${local}`);
  const before = (await m.tabs()).length;
  await ui.keyboard.press('Enter');
  await m.until(async () => (await m.front())?.url === `http://${local}`, { what: 'the local address in front' });
  assert.equal((await m.tabs()).length, before + 1);

  // A name with a dot and no scheme is taken as https (the .test hosts have none): typed with http://.
  await openPalette();
  p = await type(`harbor.test:${m.site.port}/`);
  assert.equal(p.rows[0].title, `Open https://harbor.test:${m.site.port}/`);
  await ui.keyboard.press('Meta+A');
  p = await type(m.url('harbor.test', '/'));
  assert.equal(p.rows[0].title, `Open ${m.url('harbor.test', '/')}`);
  await ui.keyboard.press('Enter');
  await m.until(async () => (await m.front())?.url === m.url('harbor.test', '/'), { what: 'the travel site in front' });
});

test('before Safari has searched, a search goes to Google with Safari\'s parameters (answered locally)', async (t) => {
  assert.equal((await settings()).safariSearch, null);
  await openPalette();
  const p = await type('tide tables');
  const go = p.rows.find((r) => r.id === 'go');
  assert.equal(go.title, 'Search for “tide tables”');
  await ui.click('.palette .result[data-id="go"]');
  const tab = await m.until(async () => { const f = await m.front(); return f?.url.startsWith('https://www.google.com/') && f; }, { what: 'the search in front' });
  assert.equal(tab.url, 'https://www.google.com/search?client=safari&rls=en&q=tide%20tables&ie=UTF-8&oe=UTF-8');
  const page = await m.pageOf(tab.id);
  await page.waitForLoadState('load');
  assert.match(await page.title(), /tide tables/);
  await m.shoot(t, 'results');
  assert.deepEqual(m.leaks, []);
});

test('a search on an engine\'s own site isn\'t learned; Safari\'s own search is, and the palette follows it', async () => {
  const site = await m.context.newPage();
  await site.goto('https://duckduckgo.com/?q=typed+on+the+site');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await settings()).safariSearch, null, 'a search typed on the site itself');
  await site.goto('https://duckduckgo.com/?q=from+the+address+bar&t=osx&ia=web'); // what Safari opens
  const learned = await m.until(async () => (await settings()).safariSearch, { what: 'the engine learned' });
  assert.equal(learned.name, 'DuckDuckGo');

  await openPalette();
  const p = await type('two words');
  assert.equal(p.rows.find((r) => r.id === 'go')?.title, 'Search for “two words”');
  await ui.click('.palette .result[data-id="go"]');
  await m.until(async () => (await m.front())?.url === 'https://duckduckgo.com/?q=two%20words&t=osx&ia=web', { what: 'the search on DuckDuckGo' });

  // Switching engines in Safari right after a Margin search, in the same tab: still learned.
  const page = await m.pageOf(await frontId());
  await page.goto('https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=second');
  await m.until(async () => (await settings()).safariSearch?.name === 'Yahoo', { what: 'Yahoo learned' });
  await openPalette();
  await type('third');
  await ui.click('.palette .result[data-id="go"]');
  await m.until(async () => (await m.front())?.url === 'https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=third', { what: 'the search on Yahoo' });
  assert.deepEqual(m.leaks, []);
});

test('New window: a second window, in full screen, with the palette open for its new tab', async (t) => {
  const first = m.shell.frontWindowId();
  await openPalette();
  await type('new window');
  await ui.click('.palette .result[data-id="action:new-window"]');
  const second = await m.until(() => m.shell.windows.find((w) => w.windowId !== first && w.state === 'fullscreen')?.windowId, { timeout: 8000, what: 'a second full-screen window' });
  const ui2 = await m.ui(second);
  const p = await m.until(async () => { const x = await palette(ui2); return x.open && x; }, { what: 'the palette in the new window' });
  assert.equal(p.query, '');
  await m.shoot(t, 'new-window', { windowId: second });
  await m.bg((id) => chrome.windows.remove(id), second);
  await m.until(() => !m.shell.overlays.has(second), { what: 'its overlay closed' });
});
