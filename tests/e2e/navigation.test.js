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

test('⌘⌥↓ / ⌘⌥↑ move through the sidebar tabs in order, wrapping', async () => {
  const pages = {};
  for (const name of ['nav-a', 'nav-b', 'nav-c']) pages[name] = await openPage(name);
  await focus(pages['nav-a'], 'nav-a');
  const order = (await sidebarSnapshot(pages['nav-a'])).tabs;
  const at = order.indexOf('nav-a');

  await pages['nav-a'].keyboard.press('Meta+Alt+ArrowDown');
  await waitFor(async () => (await activeTitle()) === order[(at + 1) % order.length]);

  const back = order[(at + 1) % order.length];
  await focus(pages[back] ?? pages['nav-a'], back);
  await (pages[back] ?? pages['nav-a']).keyboard.press('Meta+Alt+ArrowUp');
  await waitFor(async () => (await activeTitle()) === 'nav-a');

  // Wrap: from the last row, ↓ goes to the first.
  const last = order.at(-1);
  if (pages[last]) {
    await focus(pages[last], last);
    await pages[last].keyboard.press('Meta+Alt+ArrowDown');
    await waitFor(async () => (await activeTitle()) === order[0]);
  }
  for (const p of Object.values(pages)) await p.close();
});

test('⌘⌥→ / ⌘⌥← switch the space and peek the sidebar; the page itself does not get the keys', async () => {
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

  await page.keyboard.press('Meta+Alt+ArrowRight');
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === work);
  await waitFor(async () => (await sidebarSnapshot(page)).open, { timeout: 1000 });
  assert.equal((await sidebarSnapshot(page)).chips.find((c) => c.active).id, work);
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 2500 }); // peek ends

  await page.keyboard.press('Meta+Alt+ArrowLeft');
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
  await nt.keyboard.press('Meta+Alt+ArrowRight');
  await waitFor(async () => ((await storage('activeSpaceByWindow'))[windowId] ?? 'personal') !== before);
  await nt.close();
});
