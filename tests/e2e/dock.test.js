import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, waitFor } from './helpers.js';

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
const windows = () => ctx.worker.evaluate(() => chrome.windows.getAll({ populate: true }).then((ws) =>
  ws.map((w) => ({ id: w.id, type: w.type, left: w.left, top: w.top, width: w.width, height: w.height, urls: w.tabs.map((t) => t.url) }))));

test('dock-window experiment: docks beside the window, follows it, and undocks', async () => {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/docked-page`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  const [main] = await windows();

  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#sidebar .margin-sidebar');
  // Give the window a known size so the layout is checkable (after opening
  // pages: Playwright resets the window size then; headless Chromium checks
  // bounds against an 800×600 virtual display).
  await ctx.worker.evaluate((id) => chrome.windows.update(id, { left: 0, top: 0, width: 800, height: 600, state: 'normal' }), main.id);
  const res = await nt.evaluate(() => chrome.runtime.sendMessage({ type: 'setDock', on: true }));
  assert.equal(res.ok, true, res.error);

  const dock = await storage('dock');
  assert.equal(dock.targetWindowId, main.id);
  assert.equal(dock.actual.targetError, null);
  assert.deepEqual(dock.requested.dock, { left: 0, top: 0, width: 260, height: 600 });
  assert.deepEqual(dock.requested.target, { left: 260, top: 0, width: 540, height: 600 });
  const all = await windows();
  const dockWin = all.find((w) => w.id === dock.dockWindowId);
  assert.equal(dockWin.type, 'popup');
  assert.ok(dockWin.urls[0].endsWith(`/dock/dock.html?target=${main.id}`));
  console.log('# chromium bounds', JSON.stringify(dock.actual));

  // The dock lists the target window's tabs; its own tab isn't listed anywhere.
  const dockPage = ctx.context.pages().find((p) => p.url().includes('/dock/dock.html'));
  await dockPage.waitForSelector('#sidebar .tab');
  const titles = await dockPage.$$eval('#sidebar .tab .title', (n) => n.map((x) => x.textContent));
  assert.ok(titles.includes('docked-page'));
  assert.equal(Object.values(await storage('tabs')).some((t) => t.url.includes('/dock/dock.html')), false);

  // In-page and new-tab sidebars step aside in the docked window.
  await page.bringToFront();
  await page.mouse.move(400, 200);
  await page.mouse.move(5, 200);
  await page.waitForTimeout(200);
  assert.equal((await sidebarSnapshot(page)).open, false);
  assert.equal(await nt.isHidden('#sidebar'), true);

  // Nothing moving: the dock stays perfectly still across several follow
  // cycles (it used to fight Safari's coordinates and jump twice a second).
  const samples = [];
  for (let i = 0; i < 4; i++) {
    samples.push(JSON.stringify((await windows()).find((w) => w.id === dock.dockWindowId)));
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.equal(new Set(samples).size, 1, `dock moved while idle: ${samples.join(' | ')}`);

  // Move the main window: the dock follows (it polls every 500ms).
  await ctx.worker.evaluate((id) => chrome.windows.update(id, { left: 300, top: 0, width: 500, height: 550 }), main.id);
  const mainNow = (await windows()).find((w) => w.id === main.id);
  await waitFor(async () => {
    const d = (await windows()).find((w) => w.id === dock.dockWindowId);
    return d && Math.abs(d.left - (mainNow.left - 260)) <= 2 && Math.abs(d.top - mainNow.top) <= 2 && Math.abs(d.height - mainNow.height) <= 2;
  }, { timeout: 4000 });

  // Undock from the dock window's button: dock closes, width comes back.
  await dockPage.click('#undock');
  await waitFor(async () => !(await windows()).some((w) => w.id === dock.dockWindowId));
  await waitFor(async () => (await storage('dock')) === null);
  const restored = (await windows()).find((w) => w.id === main.id);
  assert.equal(restored.width, mainNow.width + 260);
  assert.equal((await storage('settings')).dockWindow, false);
  await nt.close();
  await page.close();
});

test('closing the dock window by hand also undocks', async () => {
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#sidebar .margin-sidebar');
  await ctx.worker.evaluate(() => chrome.windows.getLastFocused().then((w) => chrome.windows.update(w.id, { left: 0, top: 0, width: 800, height: 600 })));
  const res = await nt.evaluate(() => chrome.runtime.sendMessage({ type: 'setDock', on: true }));
  assert.equal(res.ok, true, res.error);
  const { dockWindowId } = await storage('dock');
  await ctx.worker.evaluate((id) => chrome.windows.remove(id), dockWindowId);
  await waitFor(async () => (await storage('dock')) === null);
  await nt.close();
});
