import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, paletteSnapshot, sidebarSnapshot, tabsInBrowser, waitFor, gotoLauncher } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
  // Never hit real sites (search engines) from tests: the test server is http.
  await ctx.context.route(/^https:\/\//, (route) => route.fulfill({ contentType: 'text/html', body: '<title>engine</title>' }));
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes(name));
  return page;
}

test('Option+K opens the palette with focus in the field; Esc closes it', async () => {
  const page = await openPage('palette-home');
  await page.keyboard.press('Alt+KeyK');
  const snap = await waitFor(async () => {
    const s = await paletteSnapshot(page);
    return s?.open && s;
  });
  assert.equal(snap.focused, true);
  assert.ok(snap.ids.includes('action:toggle-sidebar'));
  await page.keyboard.press('Escape');
  assert.equal((await paletteSnapshot(page)).open, false);
  await page.close();
});

test('fuzzy search finds a tab; Enter activates it', async () => {
  const target = await openPage('zebra-stripes');
  const page = await openPage('palette-search');
  await page.keyboard.press('Alt+KeyK');
  await page.keyboard.type('zbr strp');
  const snap = await waitFor(async () => {
    const s = await paletteSnapshot(page);
    return s.ids[0] === `tab:${(await tabsInBrowser(ctx.worker)).find((t) => t.title === 'zebra-stripes').id}` && s;
  });
  assert.equal(snap.selected, snap.ids[0]);
  await page.keyboard.press('Enter');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'zebra-stripes')?.active);
  assert.equal((await paletteSnapshot(page)).open, false);
  await target.close();
  await page.close();
});

test('arrow keys move the selection; actions run (Toggle sidebar)', async () => {
  const page = await openPage('palette-keys');
  await page.keyboard.press('Alt+KeyK');
  await page.keyboard.type('toggle sidebar');
  await waitFor(async () => (await paletteSnapshot(page)).ids[0] === 'action:toggle-sidebar');
  const before = await paletteSnapshot(page);
  await page.keyboard.press('ArrowDown');
  const after = await paletteSnapshot(page);
  assert.equal(after.selected, before.ids[1 % before.ids.length]);
  await page.keyboard.press('ArrowUp');
  assert.equal((await paletteSnapshot(page)).selected, 'action:toggle-sidebar');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await page.close();
});

test('"Search for" opens a new tab, searching with Chrome\'s own search engine', async () => {
  const page = await openPage('palette-go');
  await page.keyboard.press('Alt+KeyK');
  await page.keyboard.type('margin browser');
  const snap = await waitFor(async () => {
    const s = await paletteSnapshot(page);
    return s.ids.at(-1) === 'go' && s;
  });
  assert.equal(snap.titles.at(-1), 'Search for “margin browser”');
  await page.keyboard.press('ArrowUp'); // wraps to the last row
  const opened = ctx.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const tab = await opened;
  await tab.waitForURL((url) => url.protocol === 'https:' && [...url.searchParams.values()].includes('margin browser'));
  await tab.close();
  await page.close();
});

test('commands fallback: a background "open-palette" command toggles the palette', async () => {
  const page = await openPage('palette-command');
  const id = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'palette-command').id;
  await ctx.worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'command', command: 'open-palette' }), id);
  await waitFor(async () => (await paletteSnapshot(page))?.open);
  await page.close();
});

test('the shortcut is a setting; the new tab has the palette and navigates in place', async () => {
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  await nt.waitForSelector('#sidebar .margin-sidebar');
  await nt.click('#settings summary');
  assert.equal(await nt.inputValue('#shortcut'), '⌥K');
  await nt.click('#shortcut');
  await nt.keyboard.press('Control+Shift+KeyP');
  await waitFor(async () => (await nt.inputValue('#shortcut')) === '⌃⇧P');
  await nt.locator('#query').click();
  await nt.keyboard.press('Control+Shift+KeyP');
  await waitFor(async () => (await paletteSnapshot(nt))?.open);
  await nt.keyboard.type(`${new URL(server.base).host}/from-palette`);
  await nt.keyboard.press('Enter');
  await nt.waitForURL(`${server.base}/from-palette`);

  // Content pages pick up the new shortcut too.
  await nt.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await nt.keyboard.press('Control+Shift+KeyP');
  await waitFor(async () => (await paletteSnapshot(nt))?.open);
  await nt.close();
});
