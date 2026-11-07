// Pins and folders in the overlay: pin a tab from its menu, a pin opens its
// tab or shows the one it has, unpin, folders made, renamed, closed and
// opened, pins moved in and out, and a closed pin keeps its site's icon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, tabRow, pinRow, folderRow, menuItem } from './harness/ui.js';

let m;
let ui;

const view = () => sidebar(ui);
const frontId = async () => (await m.front())?.id;
const pinsStored = async () => (await m.stored('pins')).pins ?? [];

// Two pins the person made before: the docs and the travel site (not open now).
const SEED = (url) => ({
  spaces: SPACES,
  pins: [
    { id: 'pin-docs', spaceId: 'sp-home', url: url('docs.test', '/guide/getting-started'), title: 'Getting started · Lattice docs', pos: 0 },
    { id: 'pin-harbor', spaceId: 'sp-home', url: url('harbor.test', '/'), title: 'Harbor — Quiet places by the sea', pos: 1 },
  ],
  settings: { sidebarPinnedOpen: true },
});

before(async () => {
  m = await startMargin({ name: 'pins', seed: SEED });
  await m.open('dispatch.test', '/2026/11/the-quiet-city');
  ui = await m.ui();
  await m.until(async () => (await view()).pins.length === 2, { what: 'the two seeded pins' });
});
after(async () => { await m?.close(); });

test('a pin opens its tab, and shows the same tab the next time', async (t) => {
  const before = (await m.tabs()).length;
  await ui.click(pinRow('pin-docs'));
  await m.until(async () => (await m.front())?.url.startsWith(m.url('docs.test', '/guide/getting-started')), { what: 'the docs in front' });
  const docs = await frontId();
  assert.equal((await m.tabs()).length, before + 1, 'one tab opened');
  await m.until(async () => (await view()).pins.find((p) => p.id === 'pin-docs')?.active, { what: 'the pin highlighted' });
  assert.ok(!(await view()).tabs.some((r) => r.id === docs), 'a pin\'s tab isn\'t also a tab row');
  await m.shoot(t, 'docs-pin');

  await ui.click(tabRow((await view()).tabs[0].id));
  await m.until(async () => (await frontId()) !== docs, { what: 'another tab in front' });
  await ui.click(pinRow('pin-docs'));
  await m.until(async () => (await frontId()) === docs, { what: 'the same docs tab in front' });
  assert.equal((await m.tabs()).length, before + 1, 'no second tab');
});

test('a tab pinned from its menu becomes a pin, and Unpin makes it a tab again', async (t) => {
  await m.open('shop.test', '/p/canvas-tote');
  const tote = await frontId();
  await m.until(async () => (await view()).tabs.some((r) => r.id === tote), { what: 'the product\'s row' });
  await ui.click(tabRow(tote), { button: 'right' });
  await menuItem(ui, 'Pin Tab');
  const pin = await m.until(async () => (await pinsStored()).find((p) => p.url.startsWith(m.url('shop.test', '/p/canvas-tote'))), { what: 'the pin stored' });
  await m.until(async () => { const v = await view(); return v.pins.some((p) => p.id === pin.id && p.active) && !v.tabs.some((r) => r.id === tote); }, { what: 'drawn as a pin, highlighted' });
  assert.equal(pin.spaceId, 'sp-home');
  await m.shoot(t, 'pinned');

  await ui.click(pinRow(pin.id), { button: 'right' });
  await m.until(async () => (await view()).menu.includes('Unpin'), { what: 'the pin\'s menu' });
  await menuItem(ui, 'Unpin');
  await m.until(async () => !(await pinsStored()).some((p) => p.id === pin.id), { what: 'the pin gone' });
  await m.until(async () => (await view()).tabs.some((r) => r.id === tote), { what: 'a tab row again' });
  assert.ok((await m.tabs()).some((x) => x.id === tote), 'the tab stayed open');
});

test('folders: made with a pin, named in place, closed and opened, a pin moved in and out', async (t) => {
  await ui.click(pinRow('pin-harbor'), { button: 'right' });
  await menuItem(ui, 'New Folder with Pin');
  const folder = await m.until(async () => (await m.stored('folders')).folders?.[0], { what: 'a folder stored' });
  // Just made, its name is edited in place.
  await m.until(() => ui.evaluate(() => !!document.querySelector('.m-renaming')), { what: 'the name being edited' });
  await ui.keyboard.press('Meta+A');
  await ui.keyboard.type('Travel');
  await ui.keyboard.press('Enter');
  await m.until(async () => (await m.stored('folders')).folders?.[0]?.name === 'Travel', { what: 'named Travel' });
  await m.until(async () => (await view()).pins.find((p) => p.id === 'pin-harbor')?.nested, { what: 'the travel pin inside' });

  // The docs pin moved in from its menu.
  await ui.click(pinRow('pin-docs'), { button: 'right' });
  await m.until(async () => (await view()).menu.includes('Move to 📁 Travel'), { what: 'the folder in the pin\'s menu' });
  await menuItem(ui, 'Move to 📁 Travel');
  await m.until(async () => (await pinsStored()).find((p) => p.id === 'pin-docs')?.folderId === folder.id, { what: 'the docs pin in the folder' });
  await m.shoot(t, 'folder-open');

  // Closed: its pins aren't drawn (a pin whose tab is in front stays, as Arc does); opened again: they are.
  await ui.click(folderRow(folder.id));
  await m.until(async () => (await m.stored('folders')).folders[0].open === false, { what: 'closed' });
  await m.until(async () => !(await view()).pins.some((p) => p.id === 'pin-harbor'), { what: 'the travel pin hidden' });
  await m.shoot(t, 'folder-closed');
  await ui.click(folderRow(folder.id));
  await m.until(async () => (await view()).pins.some((p) => p.id === 'pin-harbor'), { what: 'shown again' });

  await ui.click(pinRow('pin-docs'), { button: 'right' });
  await menuItem(ui, 'Remove from Folder');
  await m.until(async () => !(await pinsStored()).find((p) => p.id === 'pin-docs')?.folderId, { what: 'out of the folder' });
  await m.until(async () => (await view()).pins.find((p) => p.id === 'pin-docs')?.nested === false, { what: 'drawn outside it' });
});

test('a pin\'s tab closed with its × stays pinned, with its site\'s icon', async (t) => {
  await ui.click(pinRow('pin-docs'));
  await m.until(async () => (await m.front())?.url.startsWith(m.url('docs.test', '/')), { what: 'the docs in front' });
  // Its own icon (an ICO the site links) fetched and kept for the site.
  await m.until(async () => (await view()).pins.find((p) => p.id === 'pin-docs')?.icon?.kind === 'image', { timeout: 8000, what: 'the docs icon drawn on its pin' });
  const docsTab = await frontId();
  await ui.hover(pinRow('pin-docs'));
  await ui.click(`${pinRow('pin-docs')} .close`);
  await m.until(async () => !(await m.tabs()).some((x) => x.id === docsTab), { what: 'its tab closed' });
  const pin = await m.until(async () => (await view()).pins.find((p) => p.id === 'pin-docs' && !p.open), { what: 'the pin, not open' });
  assert.equal(pin.icon?.kind, 'image', 'the closed pin keeps the icon');
  assert.ok(pin.icon.loaded, 'and it draws');
  assert.ok((await pinsStored()).some((p) => p.id === 'pin-docs'), 'still pinned');
  await m.shoot(t, 'closed-pin');
});
