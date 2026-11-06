// New windows and new-tab pages: a new window keeps its space, the start page (#launcher) is
// never handed off; all skipped (they read the in-page palette or the launcher, removed in
// Margin 2 Phase 2 step 5). Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, paletteSnapshot, tabsInBrowser, waitFor, gotoLauncher, readState } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const storage = (key) => readState(ctx.worker, key);

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).some((t) => t.title === name));
  return page;
}

test('⌘N: a new window starts in the same space, with the palette open on the new-tab page', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await openPage('cmd-n-origin');
  const launcher = await ctx.context.newPage();
  await gotoLauncher(launcher, ctx);
  const windowId = await launcher.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const { result } = await launcher.evaluate((w) => chrome.runtime.sendMessage({ type: 'createSpace', windowId: w, name: 'Work' }), windowId);
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === result.spaceId);
  await launcher.close();
  await page.bringToFront();

  // What Safari does on ⌘N with "New windows open with: Margin".
  const opened = ctx.context.waitForEvent('page');
  const newWindowId = await ctx.worker.evaluate(() => chrome.windows.create({}).then((w) => w.id));
  const nt = await opened;
  await nt.waitForLoadState();
  await waitFor(async () => (await paletteSnapshot(nt))?.open);
  assert.equal(nt.isClosed(), false, 'nowhere to hand off to: the new-tab page stays');
  assert.equal((await storage('activeSpaceByWindow'))[newWindowId], result.spaceId, 'same space as the window it came from');
  await ctx.worker.evaluate((id) => chrome.windows.remove(id), newWindowId);
  await page.close();
});

test('the launcher page opened on purpose (#launcher) stays', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await openPage('launcher-stays');
  const launcher = await ctx.context.newPage();
  await gotoLauncher(launcher, ctx);
  await launcher.waitForSelector('.launcher-query');
  await launcher.waitForTimeout(800);
  assert.equal(launcher.isClosed(), false);
  assert.equal((await paletteSnapshot(page))?.open ?? false, false);
  await launcher.close();
  await page.close();
});

test('palette "New window" opens a real window in the same space, with the palette ready', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await openPage('new-window-origin');
  await page.bringToFront();
  const fromWindow = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const before = (await ctx.worker.evaluate(() => chrome.windows.getAll())).length;
  await page.keyboard.press('Meta+KeyT');
  await page.keyboard.type('new window');
  await waitFor(async () => (await paletteSnapshot(page))?.ids[0] === 'action:new-window');
  const opened = ctx.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const nt = await opened;
  await waitFor(async () => (await ctx.worker.evaluate(() => chrome.windows.getAll())).length === before + 1);
  await waitFor(async () => (await paletteSnapshot(nt))?.open);
  const newWindowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const spaces = await storage('activeSpaceByWindow');
  assert.equal(spaces[newWindowId] ?? 'personal', spaces[fromWindow] ?? 'personal');
  await ctx.worker.evaluate((id) => chrome.windows.remove(id), newWindowId);
  await page.close();
});
