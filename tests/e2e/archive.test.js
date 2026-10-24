import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, clickInShadow, sidebarSnapshot, paletteSnapshot, tabsInBrowser, waitFor } from './helpers.js';

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
const send = (page, msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes(name));
  return page;
}

test('the background schedules the archive check with browser.alarms (Chromium)', async () => {
  const alarm = await waitFor(() => ctx.worker.evaluate(() => chrome.alarms.get('margin-archive')));
  assert.equal(alarm.periodInMinutes, 15);
});

test('stale, unpinned, inactive tabs are closed and archived; pinned and active ones stay', async () => {
  const stale = await openPage('stale');
  const pinned = await openPage('pinned-stale');
  const active = await openPage('active');
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  const tabs = await tabsInBrowser(ctx.worker);
  const id = (title) => tabs.find((t) => t.title === title).id;
  await send(nt, { type: 'pinTab', tabId: id('pinned-stale') });
  await active.bringToFront();
  await send(nt, { type: 'activateTab', tabId: id('active') });
  await waitFor(async () => (await storage('tabs'))[id('active')]?.active);

  await send(nt, { type: 'updateSettings', patch: { archiveAfterHours: 1 / 3600 } }); // 1 second
  await new Promise((r) => setTimeout(r, 1200));
  const count = await ctx.worker.evaluate(() => globalThis.margin.archiveNow());
  assert.ok(count >= 1);

  await waitFor(async () => stale.isClosed());
  assert.equal(pinned.isClosed(), false);
  assert.equal(active.isClosed(), false);
  const archive = await storage('archive');
  assert.equal(archive[0].title, 'stale');
  assert.equal(archive.some((a) => a.title === 'pinned-stale' || a.title === 'active'), false);

  await send(nt, { type: 'updateSettings', patch: { archiveAfterHours: 12 } });
  for (const p of [pinned, active, nt]) await p.close();
});

test('closing from the sidebar archives; the new-tab archive list restores in place', async () => {
  const keep = await openPage('keeper');
  await openPage('closeme');
  await clickInShadow(keep, '.tab .close', 'closeme');
  await waitFor(async () => (await storage('archive'))[0]?.title === 'closeme');

  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#archive-list li');
  assert.equal(await nt.textContent('#archive-list li .title'), 'closeme');
  await nt.click('#archive-list li');
  await nt.waitForURL(`${server.base}/closeme`);
  await waitFor(async () => !(await storage('archive')).some((a) => a.title === 'closeme'));
  await nt.close();
  await keep.close();
});

test('archived tabs are restorable from the palette, into their space', async () => {
  const page = await openPage('palette-archive');
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const { result } = await send(nt, { type: 'createSpace', windowId, name: 'Old', emoji: '📦' });
  const victim = await openPage('archived-in-old');
  const victimId = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'archived-in-old').id;
  await send(nt, { type: 'closeTab', tabId: victimId });
  await waitFor(async () => victim.isClosed());
  await send(nt, { type: 'setSpace', windowId, spaceId: 'personal' });
  await nt.close();

  await page.bringToFront();
  await page.keyboard.press('Alt+KeyK');
  await page.keyboard.type('archived in old');
  await waitFor(async () => (await paletteSnapshot(page)).ids[0]?.startsWith('archive:'));
  const opened = ctx.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const restored = await opened;
  await restored.waitForURL(`${server.base}/archived-in-old`);
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === result.spaceId);
  const restoredId = (await tabsInBrowser(ctx.worker)).find((t) => t.url.endsWith('/archived-in-old')).id;
  assert.equal((await storage('tabSpace'))[restoredId], result.spaceId);
  await restored.close();
  await page.close();
});

test('archive-after setting is editable on the new tab', async () => {
  const nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#sidebar .margin-sidebar');
  await nt.click('#settings summary');
  assert.equal(await nt.inputValue('#archive-hours'), '12');
  await nt.fill('#archive-hours', '3');
  await nt.press('#archive-hours', 'Tab');
  await waitFor(async () => (await storage('settings')).archiveAfterHours === 3);
  await nt.close();
});
