import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, waitFor } from './helpers.js';

let ctx, server, nt;
before(async () => {
  ctx = await launch();
  server = await startServer();
  nt = await ctx.context.newPage();
  await nt.goto('chrome://newtab');
  await nt.waitForSelector('#sidebar .chip[data-space-id]');
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const storage = (key) => ctx.worker.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key);
const chips = () => nt.$$eval('#sidebar .chip[data-space-id]', (cs) => cs.map((c) => ({ id: c.dataset.spaceId, emoji: c.textContent, active: c.classList.contains('active') })));

test('create a space with "+", then rename, re-emoji and recolor it', async () => {
  await nt.click('#sidebar .chip.add');
  await nt.waitForSelector('#sidebar .editor:not([hidden])');
  assert.equal(await nt.evaluate(() => document.activeElement?.className), 'name');
  const created = await waitFor(async () => (await chips()).find((c) => c.active && c.id !== 'personal'));

  await nt.fill('#sidebar .editor .name', 'Work');
  await nt.fill('#sidebar .editor .emoji', '💼');
  await nt.click('#sidebar .swatch[data-color="#e17055"]');
  await nt.click('#sidebar .editor .primary');
  assert.equal(await nt.isHidden('#sidebar .editor'), true);
  await waitFor(async () => {
    const space = (await storage('spaces')).find((s) => s.id === created.id);
    return space.name === 'Work' && space.emoji === '💼' && space.color === '#e17055';
  });
});

test('right-click opens the editor; delete needs two clicks and moves tabs to the first space', async () => {
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

test('drag a tab onto a space chip moves it there; the sidebar follows', async () => {
  const res = await nt.evaluate(() => chrome.runtime.sendMessage({ type: 'createSpace', name: 'Fun', emoji: '🎈' }));
  const fun = res.result.spaceId;
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/drag-me`);
  await nt.bringToFront();
  const row = nt.locator('#sidebar .tab', { hasText: 'drag-me' });
  await row.waitFor();
  await row.dragTo(nt.locator(`#sidebar .chip[data-space-id="${fun}"]`));
  await waitFor(async () => (await nt.locator('#sidebar .tab', { hasText: 'drag-me' }).count()) === 0);
  const tabs = await storage('tabs');
  const id = Object.values(tabs).find((t) => t.title === 'drag-me').id;
  assert.equal((await storage('tabSpace'))[id], fun);

  // The overlay on that page shows the same thing once Fun is active in the window.
  await nt.click(`#sidebar .chip[data-space-id="${fun}"]`);
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes('drag-me'));
  await page.close();
});

test('active space is per window', async () => {
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const other = await ctx.worker.evaluate(() => chrome.windows.create({ url: 'about:blank' }).then((w) => w.id));
  const fun = (await storage('spaces')).find((s) => s.name === 'Fun').id;
  await nt.evaluate(([w, s]) => chrome.runtime.sendMessage({ type: 'setSpace', windowId: w, spaceId: s }), [other, fun]);
  await nt.click('#sidebar .chip[data-space-id="personal"]');
  await waitFor(async () => (await storage('activeSpaceByWindow'))[windowId] === 'personal');
  assert.equal((await storage('activeSpaceByWindow'))[other], fun);
  await ctx.worker.evaluate((id) => chrome.windows.remove(id), other);
  await waitFor(async () => !((other) in (await storage('activeSpaceByWindow'))));
});

test('"+" opens the editor even when the new space arrives before the reply', async () => {
  // Force the race: hold the createSpace reply until storage has already
  // delivered the new space to the page.
  await nt.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (msg) => {
      const res = await original(msg);
      if (msg?.type === 'createSpace') await new Promise((r) => setTimeout(r, 400));
      return res;
    };
  });
  const before = (await storage('spaces')).length;
  await nt.click('#sidebar .chip.add');
  await waitFor(async () => (await storage('spaces')).length === before + 1);
  await nt.waitForSelector('#sidebar .editor:not([hidden])', { timeout: 3000 });
  await nt.click('#sidebar .editor [data-editor="cancel"]');
});
