// Smoke checks left since Margin 2 Phase 2 step 5 (no UI in pages): the background starts, and
// the new-tab override is Margin's page. Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer } from './helpers.js';

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

test('opening a new tab shows newtab.html', async () => {
  const page = await ctx.context.newPage();
  await page.goto('chrome://newtab');
  assert.equal(page.url(), `chrome-extension://${ctx.extensionId}/newtab/newtab.html`);
  await page.close();
});
