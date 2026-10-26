import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, evalInShadow } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

test('background service worker starts', () => {
  assert.match(ctx.worker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.bundle\.js$/);
});

test('content script injects a closed shadow host on a web page', async () => {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/page`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  // Closed: the page cannot reach the shadow root.
  assert.equal(await page.evaluate(() => document.querySelector('margin-sidebar-host').shadowRoot), null);
  assert.equal(await evalInShadow(page, 'margin-sidebar-host', function () { return this.mode; }), 'closed');
  await page.close();
});

test('opening a new tab shows newtab.html', async () => {
  const page = await ctx.context.newPage();
  await page.goto('chrome://newtab');
  assert.equal(page.url(), `chrome-extension://${ctx.extensionId}/newtab/newtab.html`);
  await page.close();
});
