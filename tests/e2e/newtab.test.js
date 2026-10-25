import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, tabsInBrowser, waitFor, launcherUrl } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
  // Never hit real search engines from tests.
  await ctx.context.route(/^https:\/\/(duckduckgo\.com|www\.google\.com)\//, (route) =>
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

test('launcher: other text searches DuckDuckGo by default, and the engine is a setting', async () => {
  const page = await newTab();
  await page.fill('#query', 'hello world');
  await page.press('#query', 'Enter');
  await page.waitForURL('https://duckduckgo.com/?q=hello%20world');

  const again = await newTab();
  await again.click('#settings summary');
  await again.selectOption('#engine', { label: 'Google' });
  await waitFor(() => ctx.worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.searchEngine.includes('google'))));
  await again.fill('#query', 'margin');
  await again.press('#query', 'Enter');
  await again.waitForURL('https://www.google.com/search?q=margin');
  await page.close();
  await again.close();
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
