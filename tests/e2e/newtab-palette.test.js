import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, paletteSnapshot, tabsInBrowser, waitFor, gotoLauncher, evalInShadow } from './helpers.js';

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

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).some((t) => t.title === name));
  return page;
}

test('⌘T: the new tab closes and the palette opens over the page you were on, "+ New Tab" highlighted', async () => {
  const page = await openPage('cmd-t-origin');
  await page.bringToFront();
  const before = (await tabsInBrowser(ctx.worker)).length;

  // What Safari does on ⌘T: a new tab showing Margin's new-tab page (created
  // directly, like ⌘T; Playwright's newPage would start at about:blank).
  const newTabId = await ctx.worker.evaluate(() => chrome.tabs.create({}).then((t) => t.id));

  await waitFor(async () => (await paletteSnapshot(page))?.open);
  await waitFor(async () => !(await tabsInBrowser(ctx.worker)).some((t) => t.id === newTabId));
  assert.equal((await tabsInBrowser(ctx.worker)).length, before, 'no extra tab left behind');
  assert.equal((await tabsInBrowser(ctx.worker)).find((t) => t.active)?.title, 'cmd-t-origin');
  const highlighted = () => evalInShadow(page, 'margin-sidebar-host', function () {
    return { newTab: !!this.querySelector('.new-tab-row.active'), tab: !!this.querySelector('.tab.active'), behind: !!this.querySelector('.tab.behind') };
  });
  assert.deepEqual(await highlighted(), { newTab: true, tab: false, behind: true }, '"+ New Tab" highlighted, the page\'s tab only softly');

  // Typing a URL opens it in a new tab.
  await page.keyboard.type(`${new URL(server.base).host}/from-cmd-t`);
  const opened = ctx.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const tab = await opened;
  await tab.waitForURL(`${server.base}/from-cmd-t`);
  await tab.close();
  await page.close();
});

test('⌘T then Escape: back to the page, its tab highlighted again', async () => {
  const page = await openPage('cmd-t-escape');
  await page.bringToFront();
  const before = (await tabsInBrowser(ctx.worker)).length;
  await ctx.worker.evaluate(() => chrome.tabs.create({}));
  await waitFor(async () => (await paletteSnapshot(page))?.open);
  await page.keyboard.press('Escape');
  await waitFor(async () => !(await paletteSnapshot(page))?.open);
  assert.equal((await tabsInBrowser(ctx.worker)).length, before, 'no tab opened');
  const highlighted = await evalInShadow(page, 'margin-sidebar-host', function () {
    return { newTab: !!this.querySelector('.new-tab-row.active'), tab: !!this.querySelector('.tab.active'), behind: !!this.querySelector('.tab.behind') };
  });
  assert.deepEqual(highlighted, { newTab: false, tab: true, behind: false });
  await page.close();
});

test('⌘N: a new window starts in the same space, with the palette open on the new-tab page', async () => {
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

test('the launcher page opened on purpose (#launcher) stays', async () => {
  const page = await openPage('launcher-stays');
  const launcher = await ctx.context.newPage();
  await gotoLauncher(launcher, ctx);
  await launcher.waitForSelector('#query');
  await launcher.waitForTimeout(800);
  assert.equal(launcher.isClosed(), false);
  assert.equal((await paletteSnapshot(page))?.open ?? false, false);
  await launcher.close();
  await page.close();
});

test('the palette can open the start page (with Settings) on purpose', async () => {
  const page = await openPage('to-launcher');
  await page.bringToFront();
  await page.keyboard.press('Alt+KeyK');
  await page.keyboard.type('margin start page');
  await waitFor(async () => (await paletteSnapshot(page))?.ids[0] === 'action:launcher');
  const opened = ctx.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const launcher = await opened;
  await launcher.waitForSelector('#settings');
  await launcher.waitForTimeout(800);
  assert.equal(launcher.isClosed(), false, 'not handed off to the palette');
  await launcher.close();
  await page.close();
});

test('palette "New window" opens a real window in the same space, with the palette ready', async () => {
  const page = await openPage('new-window-origin');
  await page.bringToFront();
  const fromWindow = await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
  const before = (await ctx.worker.evaluate(() => chrome.windows.getAll())).length;
  await page.keyboard.press('Alt+KeyK');
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
