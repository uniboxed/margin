import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, tabsInBrowser, waitFor, launcherUrl } from './helpers.js';

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
  await page.goto(launcherUrl(ctx));
  await page.waitForSelector('#sidebar .margin-sidebar');
  return page;
}

test('launcher: a host:port entry navigates this tab', async () => {
  const page = await newTab();
  await page.fill('#query', `${new URL(server.base).host}/typed`);
  await page.press('#query', 'Enter');
  await page.waitForURL(`${server.base}/typed`);
  assert.equal(await page.title(), 'typed');
  await page.close();
});

// Does `url` carry `text` as a query parameter (any engine's name for it)?
const searchesFor = (url, text) => [...new URL(url).searchParams.values()].includes(text);

test('launcher: other text searches with Chrome\'s own search engine (chrome.search), not one of Margin\'s', async () => {
  const page = await newTab();
  assert.equal(await page.locator('#engine').count(), 0, 'no engine picker');
  await page.click('#settings summary');
  assert.match(await page.textContent('#engine-info'), /Chrome’s search engine/);
  await page.fill('#query', 'hello world');
  await page.press('#query', 'Enter');
  await page.waitForURL((url) => url.protocol === 'https:' && searchesFor(url.href, 'hello world'));
  await page.close();
});

test('launcher: pins of the active space show as tiles; a tile focuses or opens its page', async () => {
  const site = await ctx.context.newPage();
  await site.goto(`${server.base}/tile`);
  const tabId = await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'tile')?.id);
  await waitFor(() => ctx.worker.evaluate((id) => chrome.storage.local.get('tabs').then((s) => s.tabs[id]?.title === 'tile'), tabId));

  const nt = await newTab();
  assert.equal(await nt.isHidden('#pins-section'), true);
  await nt.evaluate((id) => chrome.runtime.sendMessage({ type: 'pinTab', tabId: id }), tabId);
  await nt.waitForSelector('#pin-tiles .tile');
  assert.equal(await nt.textContent('#pin-tiles .tile .title'), 'tile');

  await nt.click('#pin-tiles .tile');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.id === tabId)?.active);

  await site.close();
  await nt.bringToFront();
  await nt.click('#pin-tiles .tile');
  await nt.waitForURL(`${server.base}/tile`);
  await nt.close();
});
