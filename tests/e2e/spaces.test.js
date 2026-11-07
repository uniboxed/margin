// Spaces in the overlay: chips switch the window's space and its tabs, new
// tabs join the space in front, the menus and the editor make, rename,
// colour and delete spaces (a deleted space's tabs go to the first), a tab
// moves to another space, each window has its own space, and another
// profile's chip asks the app. (The old spaces.test.js drove the in-page
// sidebar.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { sidebar, chip, tabRow, menuItem } from './harness/ui.js';
import { foreignKey } from '../../extension/shared/across.js';

let m;
let ui;

const view = () => sidebar(ui);
const frontId = async () => (await m.front())?.id;
const spaceOfWindow = async (windowId) => (await m.state()).activeSpaceByWindow?.[windowId];

before(async () => {
  m = await startMargin({ name: 'spaces', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  await m.open('dispatch.test', '/2026/11/the-quiet-city');
  ui = await m.ui();
  await m.until(async () => (await view()).tabs.length >= 2, { what: 'the home space\'s rows' });
});
after(async () => { await m?.close(); });

test('chips switch the space; its tabs come with it, and a new tab joins the space in front', async (t) => {
  const windowId = m.shell.frontWindowId();
  const home = (await view()).tabs.map((r) => r.id);
  await ui.click(chip('sp-work'));
  await m.until(async () => (await view()).space === 'Work', { what: 'the Work space shown' });
  assert.equal(await spaceOfWindow(windowId), 'sp-work');
  assert.ok(!(await view()).tabs.some((r) => home.includes(r.id)), 'Home\'s tabs aren\'t listed in Work');
  // A new page opened now is Work's.
  await m.open('metrics.test', '/');
  const dash = await frontId();
  await m.until(async () => (await view()).tabs.some((r) => r.id === dash && r.active), { what: 'the dashboard in Work, highlighted' });
  assert.equal((await m.state()).tabSpace[dash], 'sp-work');
  await m.shoot(t, 'work');

  await ui.click(chip('sp-home'));
  await m.until(async () => (await view()).space === 'Home', { what: 'Home again' });
  const rows = (await view()).tabs.map((r) => r.id);
  assert.ok(home.every((id) => rows.includes(id)) && !rows.includes(dash), 'Home\'s tabs again, not the dashboard');
  // The browser shows a tab of the space switched to.
  assert.equal((await m.state()).tabSpace[await frontId()], 'sp-home');
});

test('a tab moved to another space with its menu', async (t) => {
  await m.open('noir.test', '/');
  const noir = await frontId();
  await m.until(async () => (await view()).tabs.some((r) => r.id === noir), { what: 'the portfolio\'s row' });
  await ui.click(tabRow(noir), { button: 'right' });
  await m.until(async () => (await view()).menu.length, { what: 'the tab\'s menu' });
  assert.deepEqual((await view()).menu, ['Pin Tab', 'New Folder with Tab', 'Move to 💼 Work', 'Move to 🧭 Trips', 'Close Tab']);
  await m.shoot(t, 'menu');
  await menuItem(ui, 'Move to 🧭 Trips');
  await m.until(async () => (await m.state()).tabSpace[noir] === 'sp-trips', { what: 'the tab in Trips' });
  await m.until(async () => !(await view()).tabs.some((r) => r.id === noir), { what: 'its row gone from Home' });
  await ui.click(chip('sp-trips'));
  await m.until(async () => (await view()).tabs.some((r) => r.id === noir), { what: 'its row in Trips' });
  await ui.click(chip('sp-home'));
  await m.until(async () => (await view()).space === 'Home', { what: 'Home again' });
});

test('a space made from +, renamed in place, coloured in the editor, and deleted with two presses', async (t) => {
  await ui.click('.bar-button.add');
  await m.until(async () => (await view()).menu.includes('New Space'), { what: 'the + menu' });
  await menuItem(ui, 'New Space');
  // A new space opens its editor.
  await m.until(async () => (await view()).editor, { what: 'the space editor' });
  const made = await m.until(async () => (await m.state()).spaces.find((s) => !SPACES.some((x) => x.id === s.id)), { what: 'the new space stored' });
  const name = ui.locator('.editor input.name');
  await name.fill('Reading list');
  await ui.locator('.editor .swatch').nth(3).click();
  const color = await ui.locator('.editor .swatch').nth(3).getAttribute('title');
  await m.shoot(t, 'editor');
  await ui.click('.editor .primary');
  await m.until(async () => (await m.state()).spaces.find((s) => s.id === made.id)?.name === 'Reading list', { what: 'the name saved' });
  assert.equal((await m.state()).spaces.find((s) => s.id === made.id).color, color);

  // Renamed in place: a double-click on the space's name.
  await m.until(async () => (await view()).space === 'Reading list', { what: 'the new space shown' });
  await ui.dblclick('.space-title .title');
  await ui.keyboard.press('Meta+A');
  await ui.keyboard.type('Weekend reads');
  await ui.keyboard.press('Enter');
  await m.until(async () => (await m.state()).spaces.find((s) => s.id === made.id)?.name === 'Weekend reads', { what: 'renamed in place' });
  await m.shoot(t, 'renamed');

  // A page opened now is the new space's: deleting the space moves it to the first space.
  const windowId = m.shell.frontWindowId();
  await m.open('focus.test', '/');
  const timer = await frontId();
  await m.until(async () => (await m.state()).tabSpace[timer] === made.id, { what: 'the timer in the new space' });
  await m.until(async () => (await view()).tabs.some((r) => r.id === timer), { what: 'its row in the new space' });

  // Delete: the first press asks, the second deletes.
  await ui.click(chip(made.id), { button: 'right' });
  await m.until(async () => (await view()).menu.includes('Delete Space'), { what: 'the space\'s menu' });
  await menuItem(ui, 'Delete Space');
  await m.until(async () => (await view()).menu.includes('Really delete?'), { what: 'asked again' });
  assert.ok((await m.state()).spaces.some((s) => s.id === made.id), 'not deleted by the first press');
  await menuItem(ui, 'Really delete?');
  await m.until(async () => !(await m.state()).spaces.some((s) => s.id === made.id), { what: 'deleted' });
  await m.until(async () => (await view()).chips.length === 3, { what: 'three chips again' });
  assert.equal((await m.state()).tabSpace[timer], 'sp-home', 'its tab moved to the first space');
  await m.until(async () => (await spaceOfWindow(windowId)) === 'sp-home' && (await view()).space === 'Home', { what: 'the window on Home' });
  await m.until(async () => (await view()).tabs.some((r) => r.id === timer), { what: 'the tab\'s row drawn in Home' });
  assert.ok((await m.tabs()).some((x) => x.id === timer), 'the tab still open');
  await m.shoot(t, 'deleted');
});

test('each window has its own space', async (t) => {
  const first = m.shell.frontWindowId();
  const res = await m.shell.request('newWindow', {}, first);
  assert.equal(res.ok, true);
  // macOS puts a new window of a full-screen app in full screen too (the harness does it for the shell).
  const second = await m.until(() => m.shell.windows.find((w) => w.windowId !== first && w.state === 'fullscreen')?.windowId, { timeout: 8000, what: 'a second full-screen window' });
  const ui2 = await m.ui(second);
  // Its new tab hands off to the palette, open in the new window's overlay (as ⌘N).
  await m.until(async () => (await sidebar(ui2)).palette, { what: 'the palette in the new window' });
  await ui2.keyboard.press('Escape');
  await m.until(async () => !(await sidebar(ui2)).palette, { what: 'the palette closed' });
  await ui2.click(chip('sp-work'));
  await m.until(async () => (await spaceOfWindow(second)) === 'sp-work', { what: 'Work in the second window' });
  assert.equal(await spaceOfWindow(first), 'sp-home', 'the first window keeps Home');
  assert.equal((await sidebar(ui2)).space, 'Work');
  assert.equal((await view()).space, 'Home');
  await m.shoot(t, 'second-window', { windowId: second });
  await m.bg((id) => chrome.windows.remove(id), second);
  await m.until(() => !m.shell.overlays.has(second), { what: 'its overlay closed' });
});

test('another profile\'s chip asks the app to switch', async (t) => {
  const here = m.shell.hello.profile;
  m.shell.setAcross({
    profile: here,
    profiles: [
      { id: here, name: 'Personal', emoji: '🙂', color: '#7c9cff', linked: true, spaces: 3 },
      { id: 'p-work0000000000000000', name: 'Studio', emoji: '🎨', color: '#e86f68', linked: false, spaces: 1 },
    ],
    spaces: [
      ...SPACES.map((s) => ({ profile: here, id: s.id, name: s.name, emoji: s.emoji, color: s.color, tabCount: 1 })),
      { profile: 'p-work0000000000000000', id: 'sp-clients', name: 'Clients', emoji: '📐', color: '#e86f68', tabCount: 4 },
    ],
    switching: null,
  });
  const chipId = foreignKey('p-work0000000000000000', 'sp-clients');
  await m.until(async () => (await view()).chips.some((c) => c.id === chipId), { what: 'the other profile\'s chip' });
  await m.shoot(t, 'across');
  const before = m.shell.performs.length;
  await ui.click(chip(chipId));
  const asked = await m.until(() => m.shell.performs.slice(before).find((p) => p.name === 'profile.switch'), { what: 'profile.switch asked of the app' });
  assert.deepEqual(asked.arg, { profile: 'p-work0000000000000000', space: 'sp-clients' });
  assert.ok(!m.shell.requests.some((r) => r.type === 'setSpace' && r.payload.spaceId === chipId), 'nothing went to this copy for it');
  m.shell.setAcross(null);
});
