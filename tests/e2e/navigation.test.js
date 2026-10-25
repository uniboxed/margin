import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, tabsInBrowser, waitFor, launcherUrl } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const storage = (key) => ctx.worker.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key);
const activeTitle = async () => (await tabsInBrowser(ctx.worker)).find((t) => t.active)?.title;

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

// Focus a tab the way a user would, then wait until its sidebar knows its tab.
async function focus(page, title) {
  await page.bringToFront();
  const id = (await tabsInBrowser(ctx.worker)).find((t) => t.title === title).id;
  await ctx.worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id);
  await waitFor(async () => (await activeTitle()) === title);
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes(title));
}

test('⌃⌘↓ / ⌃⌘↑ move through the sidebar tabs in order, wrapping', async () => {
  const pages = {};
  for (const name of ['nav-a', 'nav-b', 'nav-c']) pages[name] = await openPage(name);
  await focus(pages['nav-a'], 'nav-a');
  const order = (await sidebarSnapshot(pages['nav-a'])).tabs;
  const at = order.indexOf('nav-a');

  await pages['nav-a'].keyboard.press('Control+Meta+ArrowDown');
  await waitFor(async () => (await activeTitle()) === order[(at + 1) % order.length]);

  const back = order[(at + 1) % order.length];
  await focus(pages[back] ?? pages['nav-a'], back);
  await (pages[back] ?? pages['nav-a']).keyboard.press('Control+Meta+ArrowUp');
  await waitFor(async () => (await activeTitle()) === 'nav-a');

  // Wrap: from the last row, ↓ goes to the first.
  const last = order.at(-1);
  if (pages[last]) {
    await focus(pages[last], last);
    await pages[last].keyboard.press('Control+Meta+ArrowDown');
    await waitFor(async () => (await activeTitle()) === order[0]);
  }
  for (const p of Object.values(pages)) await p.close();
});

test('⌃⌘→ / ⌃⌘← switch the space and peek the sidebar; the page itself does not get the keys', async () => {
  const page = await openPage('nav-space');
  await focus(page, 'nav-space');
  const windowId = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  // Create the second space through the background, like the "+" button does.
  const nt = await ctx.context.newPage();
  await nt.goto(launcherUrl(ctx));
  const { result } = await nt.evaluate(() => chrome.runtime.sendMessage({ type: 'createSpace', name: 'Work', emoji: '💼' }));
  const work = result.spaceId;
  await nt.close();
  await focus(page, 'nav-space');
  await waitFor(async () => (await sidebarSnapshot(page)).chips.length >= 2);
  await page.evaluate(() => {
    window.__pageKeys = 0;
    // Count the arrow presses only: the ⌘/⌥ presses themselves always reach the page.
    addEventListener('keydown', (e) => e.key.startsWith('Arrow') && window.__pageKeys++);
  });

  await page.keyboard.press('Control+Meta+ArrowRight');
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === work);
  await waitFor(async () => (await sidebarSnapshot(page)).open, { timeout: 1000 });
  assert.equal((await sidebarSnapshot(page)).chips.find((c) => c.active).id, work);
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 2500 }); // peek ends

  await page.keyboard.press('Control+Meta+ArrowLeft');
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === 'personal');
  assert.equal(await page.evaluate(() => window.__pageKeys), 0, 'the arrow keys of the shortcuts are not passed on to the page');
  await page.close();
});

test('the new-tab page handles the same shortcuts', async () => {
  const nt = await ctx.context.newPage();
  await nt.goto(launcherUrl(ctx));
  await nt.waitForSelector('#sidebar .chip[data-space-id]');
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const before = (await storage('activeSpaceByWindow'))[windowId] ?? 'personal';
  await nt.locator('body').click({ position: { x: 600, y: 600 } });
  await nt.keyboard.press('Control+Meta+ArrowRight');
  await waitFor(async () => ((await storage('activeSpaceByWindow'))[windowId] ?? 'personal') !== before);
  await nt.close();
});

test('shortcuts are settings: record a new one, duplicates are refused, reset restores defaults', async () => {
  const nt = await ctx.context.newPage();
  await nt.goto(launcherUrl(ctx));
  await nt.click('#settings summary');
  const field = (name) => nt.locator(`.shortcut-input[data-shortcut="${name}"]`);
  assert.equal(await field('nextTab').inputValue(), '⌃⌘↓');
  assert.equal(await field('nextSpace').inputValue(), '⌃⌘→');

  // Record ⌥⇧L for "Next space".
  await field('nextSpace').click();
  await nt.keyboard.press('Alt+Shift+KeyL');
  await waitFor(async () => (await storage('settings')).shortcuts?.nextSpace === 'Alt+Shift+KeyL');
  assert.equal(await field('nextSpace').inputValue(), '⌥⇧L');
  assert.equal((await storage('settings')).shortcuts.nextTab, 'Ctrl+Meta+ArrowDown', 'others unchanged');

  // A combination already in use is refused.
  await field('prevSpace').click();
  await nt.keyboard.press('Control+Meta+ArrowDown');
  assert.match(await nt.textContent('#shortcut-help'), /already used for “Next tab”/);
  assert.equal((await storage('settings')).shortcuts.prevSpace, 'Control+Meta+ArrowLeft'.replace('Control', 'Ctrl'));
  await nt.keyboard.press('Escape');

  // The new shortcut works on web pages right away.
  const page = await openPage('custom-key');
  await focus(page, 'custom-key');
  const windowId = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const before = (await storage('activeSpaceByWindow'))[windowId] ?? 'personal';
  await page.keyboard.press('Alt+Shift+KeyL');
  await waitFor(async () => ((await storage('activeSpaceByWindow'))[windowId] ?? 'personal') !== before);

  await nt.bringToFront();
  await nt.click('#shortcuts-reset');
  await waitFor(async () => (await storage('settings')).shortcuts.nextSpace === 'Ctrl+Meta+ArrowRight');
  await page.close();
  await nt.close();
});

// The manifest-command path (Safari matches ⌃⌘ + arrows in the app) can't be
// pressed in headless Chromium, so these drive background.navigate directly.
const nav = (action, source, windowId) =>
  ctx.worker.evaluate(([a, s, w]) => globalThis.margin.navigate(a, s, w), [action, source, windowId]);

test('fast presses all count: each continues from the tab the previous one chose', async () => {
  const pages = [];
  for (const name of ['fast-1', 'fast-2', 'fast-3', 'fast-4']) pages.push(await openPage(name));
  await focus(pages[0], 'fast-1');
  const windowId = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const order = (await sidebarSnapshot(pages[0])).tabs;
  const at = order.indexOf('fast-1');
  // Three presses fired back to back, before Safari/Chrome finishes switching.
  await Promise.all([nav('next-tab', 'command', windowId), nav('next-tab', 'command', windowId), nav('next-tab', 'command', windowId)]);
  await waitFor(async () => (await activeTitle()) === order[(at + 3) % order.length]);
  for (const p of pages) await p.close();
});

test('one press arriving through both paths (command + page) moves once', async () => {
  const pages = [];
  for (const name of ['dup-1', 'dup-2', 'dup-3']) pages.push(await openPage(name));
  await focus(pages[0], 'dup-1');
  await new Promise((r) => setTimeout(r, 1600)); // let earlier chaining expire
  const windowId = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const order = (await sidebarSnapshot(pages[0])).tabs;
  const at = order.indexOf('dup-1');
  await Promise.all([nav('next-tab', 'command', windowId), nav('next-tab', 'page', windowId)]);
  await waitFor(async () => (await activeTitle()) === order[(at + 1) % order.length]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await activeTitle(), order[(at + 1) % order.length], 'moved exactly one tab');
  for (const p of pages) await p.close();
});

test('switching tabs by hand restarts the chain from that tab', async () => {
  const pages = [];
  for (const name of ['hand-1', 'hand-2', 'hand-3', 'hand-4']) pages.push(await openPage(name));
  await focus(pages[0], 'hand-1');
  const windowId = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const order = (await sidebarSnapshot(pages[0])).tabs;
  await nav('next-tab', 'command', windowId);
  await focus(pages[3], 'hand-4'); // the user clicks another tab
  await nav('next-tab', 'command', windowId);
  await waitFor(async () => (await activeTitle()) === order[(order.indexOf('hand-4') + 1) % order.length]);
  for (const p of pages) await p.close();
});
