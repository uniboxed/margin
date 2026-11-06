// Spaces: deleting one moves its tabs to the first, moving a tab, the active space per window;
// all skipped (driven through the new-tab sidebar removed in Margin 2 Phase 2 step 5).
// Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, waitFor, gotoLauncher, readState } from './helpers.js';

let ctx, server, nt;
before(async () => {
  ctx = await launch();
  server = await startServer();
  nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  await nt.waitForSelector('#sidebar .chip[data-space-id]');
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const storage = (key) => readState(ctx.worker, key);
const chips = () => nt.$$eval('#sidebar .chip[data-space-id]', (cs) => cs.map((c) => ({ id: c.dataset.spaceId, emoji: c.textContent, active: c.classList.contains('active') })));

test('right-click opens the editor; delete needs two clicks and moves tabs to the first space', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const work = (await chips()).find((c) => c.emoji === '💼');
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/in-work`); // active space in this window is Work
  const tabId = await waitFor(async () => {
    const tabs = await storage('tabs');
    return Object.values(tabs).find((t) => t.title === 'in-work')?.id;
  });
  assert.equal((await storage('tabSpace'))[tabId], work.id);

  await nt.bringToFront();
  await nt.click(`#sidebar .chip[data-space-id="${work.id}"]`, { button: 'right' });
  await nt.waitForSelector('#sidebar .editor:not([hidden])');
  assert.equal(await nt.inputValue('#sidebar .editor .name'), 'Work');
  await nt.click('#sidebar .editor .delete');
  assert.equal(await nt.textContent('#sidebar .editor .delete'), 'Really delete?');
  assert.equal((await storage('spaces')).length, 2, 'first click only arms');
  await nt.click('#sidebar .editor .delete');
  await waitFor(async () => (await storage('spaces')).length === 1);
  assert.equal((await storage('tabSpace'))[tabId], 'personal');

  // Only one space left: delete is disabled.
  await nt.dblclick('#sidebar .chip[data-space-id="personal"]');
  assert.equal(await nt.isDisabled('#sidebar .editor .delete'), true);
  await nt.click('#sidebar .editor [data-editor="cancel"]');
  await page.close();
});

test('a tab moved to another space with its menu leaves this one; the sidebar follows', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const res = await nt.evaluate(() => chrome.runtime.sendMessage({ type: 'createSpace', name: 'Fun', emoji: '🎈' }));
  const fun = res.result.spaceId;
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/drag-me`);
  await nt.bringToFront();
  const row = nt.locator('#sidebar .tab', { hasText: 'drag-me' });
  await row.waitFor();
  // Dragging a tab (sidebar.js, pointer events) needs the tab in front: its
  // own page's sidebar, a closed shadow root here; the WebKit host's
  // `dragtab` scenario covers the drag itself.
  await row.click({ button: 'right' });
  await nt.locator('#sidebar .tab-menu .menu-item', { hasText: 'Fun' }).click();
  await waitFor(async () => (await nt.locator('#sidebar .tab', { hasText: 'drag-me' }).count()) === 0);
  const tabs = await storage('tabs');
  const id = Object.values(tabs).find((t) => t.title === 'drag-me').id;
  assert.equal((await storage('tabSpace'))[id], fun);

  // The overlay on that page shows the same thing once Fun is active in the window.
  await nt.click(`#sidebar .chip[data-space-id="${fun}"]`);
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes('drag-me'));
  await page.close();
});

test('active space is per window', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const other = await ctx.worker.evaluate(() => chrome.windows.create({ url: 'about:blank' }).then((w) => w.id));
  const fun = (await storage('spaces')).find((s) => s.name === 'Fun').id;
  await nt.evaluate(([w, s]) => chrome.runtime.sendMessage({ type: 'setSpace', windowId: w, spaceId: s, bringTab: false }), [other, fun]);
  await nt.click('#sidebar .chip[data-space-id="personal"]');
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === 'personal');
  assert.equal((await storage('activeSpaceByWindow'))[other], fun);
  await ctx.worker.evaluate((id) => chrome.windows.remove(id), other);
  await waitFor(async () => !((other) in (await storage('activeSpaceByWindow'))));
});
