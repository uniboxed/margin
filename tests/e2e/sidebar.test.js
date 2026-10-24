import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, clickInShadow, tabsInBrowser, waitFor } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

test('sidebar is hidden by default, reveals at the left edge, hides 300ms after leaving', async () => {
  const page = await openPage('hover');
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes('hover'));
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.mouse.move(400, 200);
  await page.mouse.move(3, 200);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(120, 200); // inside the 260px panel: stays open
  await page.waitForTimeout(450);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(600, 200);
  await page.waitForTimeout(150);
  assert.equal((await sidebarSnapshot(page)).open, true, 'still within the 300ms grace period');
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 1000 });
  await page.close();
});

test('overlay never changes the page layout', async () => {
  const page = await openPage('layout');
  await page.mouse.move(3, 200);
  const styles = await page.evaluate(() => {
    const pick = (el) => { const cs = getComputedStyle(el); return [cs.marginLeft, cs.paddingLeft, cs.transform]; };
    return [pick(document.documentElement), pick(document.body)];
  });
  assert.deepEqual(styles, [['0px', '0px', 'none'], ['0px', '0px', 'none']]);
  await page.close();
});

test('lists tabs; clicking a row activates it; the close button closes it', async () => {
  const a = await openPage('alpha');
  const b = await openPage('beta');
  await waitFor(async () => {
    const { tabs } = await sidebarSnapshot(b);
    return tabs.includes('alpha') && tabs.includes('beta');
  });
  await clickInShadow(b, '.tab', 'alpha');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'alpha')?.active);
  await clickInShadow(b, '.tab .close', 'alpha');
  await waitFor(async () => !(await tabsInBrowser(ctx.worker)).some((t) => t.title === 'alpha'));
  assert.equal(a.isClosed(), true);
  await waitFor(async () => !(await sidebarSnapshot(b)).tabs.includes('alpha'));
  await b.close();
});

test('pin a tab; clicking the pin focuses the existing tab, or opens it if closed', async () => {
  const p = await openPage('pinme');
  const other = await openPage('other');
  await waitFor(async () => (await sidebarSnapshot(other)).tabs.includes('pinme'));
  await clickInShadow(other, '.tab .pin-tab', 'pinme');
  await waitFor(async () => (await sidebarSnapshot(other)).pins.includes('pinme'));
  assert.ok(!(await sidebarSnapshot(other)).tabs.includes('pinme'), 'pinned tab shows under pins, not tabs');

  await clickInShadow(other, '.pin', 'pinme');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'pinme')?.active);

  await p.close();
  await waitFor(async () => !(await tabsInBrowser(ctx.worker)).some((t) => t.title === 'pinme'));
  const opened = ctx.context.waitForEvent('page');
  await clickInShadow(other, '.pin', 'pinme');
  const reopened = await opened;
  await reopened.waitForLoadState();
  assert.equal(new URL(reopened.url()).pathname, '/pinme');

  await clickInShadow(other, '.pin .unpin', 'pinme');
  await waitFor(async () => (await sidebarSnapshot(other)).pins.length === 0);
  await reopened.close();
  await other.close();
});

test('switching space filters tabs; new tabs join the active space', async () => {
  const page = await openPage('space-a');
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const res = await nt.evaluate((w) => chrome.runtime.sendMessage({ type: 'createSpace', windowId: w, name: 'Work', emoji: '💼' }), windowId);
  assert.equal(res.ok, true);
  await waitFor(async () => (await sidebarSnapshot(page)).chips.find((c) => c.active)?.id === res.result.spaceId);
  assert.ok(!(await sidebarSnapshot(page)).tabs.includes('space-a'), 'old space tabs hidden');

  const fresh = await openPage('space-b');
  await waitFor(async () => (await sidebarSnapshot(fresh)).tabs.includes('space-b'));
  await clickInShadow(fresh, '.chip', null); // first chip = Personal
  await waitFor(async () => {
    const { tabs } = await sidebarSnapshot(fresh);
    return tabs.includes('space-a') && !tabs.includes('space-b');
  });
  for (const p of [page, nt, fresh]) await p.close();
});

test('theme follows the page background', async () => {
  const page = await openPage('dark');
  await waitFor(async () => (await sidebarSnapshot(page)).theme === 'dark');
  const light = await openPage('light');
  await waitFor(async () => (await sidebarSnapshot(light)).theme === 'light');
  await page.close();
  await light.close();
});

test('new-tab page renders the sidebar itself and gets no injected overlay', async () => {
  await openPage('nt-check');
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#sidebar .margin-sidebar.newtab .tab');
  assert.equal(await nt.locator('margin-sidebar-host').count(), 0);
  await nt.locator('#sidebar .new-tab').click();
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).filter((t) => t.url.startsWith('chrome://newtab')).length >= 2);
});

test('toggle shortcut: opens and closes; with "Keep open" on it switches back to auto-hide', async () => {
  const page = await openPage('toggle');
  const tabId = await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'toggle')?.id);
  const toggle = () => ctx.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'command', command: 'toggle-sidebar' }), tabId);
  const pinned = () => ctx.worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.sidebarPinnedOpen));

  await toggle();
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await toggle();
  await waitFor(async () => !(await sidebarSnapshot(page)).open);

  await page.mouse.move(3, 200);
  await clickInShadow(page, '.keep-open');
  await waitFor(pinned);
  await page.mouse.move(600, 200);
  await page.waitForTimeout(400);
  assert.equal((await sidebarSnapshot(page)).open, true, 'kept open');

  await toggle();
  await waitFor(async () => !(await pinned()));
  await page.waitForTimeout(100);
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.close();
});
