import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, evalInShadow, sidebarSnapshot, waitFor, launcherUrl } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const settings = () => ctx.worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings));
// Change settings through the background, like the UI does (writing storage
// directly would leave the background's copy stale).
let control;
const setSettings = async (patch) => {
  if (!control || control.isClosed()) {
    control = await ctx.context.newPage();
    await control.goto(launcherUrl(ctx));
  }
  await control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
};
const registered = () =>
  ctx.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['margin-docked'] }).then((r) => r[0]?.css?.[0] ?? null));
const panelWidth = (page) => evalInShadow(page, 'margin-sidebar-host', function () {
  return Math.round(this.querySelector('.margin-sidebar').getBoundingClientRect().width);
});
const htmlLeft = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).marginLeft));

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes(name));
  return page;
}

async function drag(page, fromX, toX, y = 400) {
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move((fromX + toX) / 2, y, { steps: 4 });
  await page.mouse.move(toX, y, { steps: 4 });
  await page.mouse.up();
}

test('Keep open: dragging the edge resizes live, pushes the page with it, snaps, saves, and updates the placeholder', async () => {
  await setSettings({ sidebarPinnedOpen: true, sidebarWidth: 260 });
  const page = await openPage('resize-docked');
  await page.bringToFront();
  await waitFor(async () => (await htmlLeft(page)) === 260);

  // Live: mid-drag the page already follows.
  await page.mouse.move(260, 400);
  await page.mouse.down();
  await page.mouse.move(310, 400, { steps: 5 });
  assert.equal(await panelWidth(page), 310);
  await waitFor(async () => (await htmlLeft(page)) === 310);
  await page.mouse.move(334, 400, { steps: 3 });
  await page.mouse.up();

  await waitFor(async () => (await settings()).sidebarWidth === 330, { timeout: 2000 });
  assert.equal(await panelWidth(page), 330, 'snapped to 10px');
  assert.equal(await htmlLeft(page), 330);
  const hole = await evalInShadow(page, 'margin-sidebar-host', function () {
    return this.querySelector('.frame .hole').getBoundingClientRect().left;
  });
  assert.equal(hole, 330, 'frame edge follows');
  const edge = await evalInShadow(page, 'margin-sidebar-host', function () {
    const e = this.querySelector('.card-edge');
    const s = getComputedStyle(e);
    return { left: e.getBoundingClientRect().left, open: e.classList.contains('open'), image: s.borderImageSource.slice(0, 30), opacity: s.opacity };
  });
  assert.deepEqual(edge, { left: 330, open: true, image: 'url("data:image/svg+xml,%3Csvg', opacity: '1' }, 'card corners and shadow follow');
  await waitFor(async () => (await registered())?.endsWith('content/docked/w-330.css'));

  // Other tabs pick the width up.
  const other = await openPage('resize-other');
  await waitFor(async () => (await panelWidth(other)) === 330 && (await htmlLeft(other)) === 330);
  await other.close();

  // Clamped to 160–500.
  await drag(page, 330, 20);
  await waitFor(async () => (await settings()).sidebarWidth === 160);
  await drag(page, 160, 1100);
  await waitFor(async () => (await settings()).sidebarWidth === 500);

  // Double-click resets to 260.
  await page.mouse.dblclick(500, 400);
  await waitFor(async () => (await settings()).sidebarWidth === 260);
  assert.equal(await htmlLeft(page), 260);
  await setSettings({ sidebarPinnedOpen: false });
  await page.close();
});

test('the resize handle: a light pill just inside the sidebar edge, shown on hover', async () => {
  await setSettings({ sidebarPinnedOpen: true, sidebarWidth: 260 });
  const page = await openPage('resize-handle');
  await page.bringToFront();
  await waitFor(async () => (await htmlLeft(page)) === 260);
  const pill = () => evalInShadow(page, 'margin-sidebar-host', function () {
    const handle = this.querySelector('.margin-sidebar .resizer');
    const r = handle.getBoundingClientRect();
    const s = getComputedStyle(handle, '::after');
    const left = r.right - parseFloat(s.right) - parseFloat(s.width);
    return { opacity: s.opacity, left, right: left + parseFloat(s.width), top: r.top + parseFloat(s.top), bottom: r.bottom - parseFloat(s.bottom), radius: s.borderRadius, vh: innerHeight };
  });
  await page.mouse.move(600, 400);
  assert.equal((await pill()).opacity, '0', 'hidden until hovered');
  await page.mouse.move(258, 400); // inside the hit area
  const p = await waitFor(async () => {
    const v = await pill();
    return v.opacity === '1' && v;
  });
  assert.deepEqual([p.left, p.right], [254, 258], '4px wide, 2px from the page edge at 260');
  assert.deepEqual([p.top, p.bottom], [8, p.vh - 8], 'as tall as the page card');
  assert.equal(p.radius, '2px');
  await page.mouse.move(600, 400);
  await setSettings({ sidebarPinnedOpen: false });
  await page.close();
});

test('hover mode: resizing keeps the sidebar open and never moves the page', async () => {
  await setSettings({ sidebarPinnedOpen: false, sidebarWidth: 260 });
  const page = await openPage('resize-hover');
  await page.bringToFront();
  await page.mouse.move(400, 300);
  await page.mouse.move(5, 300);
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await page.waitForTimeout(250);
  // Floating card: left 8, so its edge is at 268.
  await drag(page, 268, 408);
  await waitFor(async () => (await settings()).sidebarWidth === 400);
  assert.equal((await sidebarSnapshot(page)).open, true, 'stayed open through the drag');
  assert.equal(await htmlLeft(page), 0);
  await page.mouse.move(900, 300);
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 1500 });
  assert.equal(await evalInShadow(page, 'margin-sidebar-host', function () {
    return this.querySelector('.card-edge').classList.contains('open');
  }), false, 'no card edge in auto-hide mode');
  await setSettings({ sidebarWidth: 260 });
  await page.close();
});

test('the new-tab sidebar resizes too', async () => {
  const nt = await ctx.context.newPage();
  await nt.goto(launcherUrl(ctx));
  await nt.waitForSelector('#sidebar .resizer');
  const box = await nt.locator('#sidebar .margin-sidebar').boundingBox();
  await drag(nt, box.x + box.width - 1, box.x + box.width + 99);
  await waitFor(async () => (await settings()).sidebarWidth === 360);
  assert.equal(Math.round((await nt.locator('#sidebar .margin-sidebar').boundingBox()).width), 360);
  await setSettings({ sidebarWidth: 260 });
  await nt.close();
});
