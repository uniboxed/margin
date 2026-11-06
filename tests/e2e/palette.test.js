// What's left of the palette: a search opens a new tab with Chrome's own engine (background
// `search`); skipped, as it drives the in-page palette removed in Margin 2 Phase 2 step 5.
// Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, paletteSnapshot, sidebarSnapshot, waitFor } from './helpers.js';

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

test('"Search for" opens a new tab, searching with Chrome\'s own search engine', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await openPage('palette-go');
  await page.keyboard.press('Meta+KeyT');
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
