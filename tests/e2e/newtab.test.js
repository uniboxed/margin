// The new-tab page's address field: an address opens in the tab, other text is searched with
// Chrome's engine; both skipped (they drive the launcher removed in Margin 2 Phase 2 step 5).
// Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, gotoLauncher } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
  // Never hit real sites (search engines) from tests: the test server is http.
  await ctx.context.route(/^https:\/\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>engine</title>' }),
  );
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

async function newTab() {
  const page = await ctx.context.newPage();
  await gotoLauncher(page, ctx);
  await page.waitForSelector('#sidebar .margin-sidebar');
  return page;
}

test('launcher: a host:port entry navigates this tab', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await newTab();
  await page.fill('.launcher-query', `${new URL(server.base).host}/typed`);
  await page.press('.launcher-query', 'Enter');
  await page.waitForURL(`${server.base}/typed`);
  assert.equal(await page.title(), 'typed');
  await page.close();
});

// Does `url` carry `text` as a query parameter (any engine's name for it)?
const searchesFor = (url, text) => [...new URL(url).searchParams.values()].includes(text);

test('launcher: other text searches with Chrome\'s own search engine (chrome.search), not one of Margin\'s', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await newTab();
  assert.equal(await page.locator('#engine').count(), 0, 'no engine picker');
  await page.click('#settings summary');
  assert.match(await page.textContent('.settings-form p.help'), /Chrome’s search engine/);
  await page.fill('.launcher-query', 'hello world');
  await page.press('.launcher-query', 'Enter');
  await page.waitForURL((url) => url.protocol === 'https:' && searchesFor(url.href, 'hello world'));
  await page.close();
});
