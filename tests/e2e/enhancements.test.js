import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, evalInShadow, waitFor, buildSafariProfile } from './helpers.js';

// What's left of the Navigation API enhancements (Safari profile): swipes only toward history
// there is, and slow same-page navigations told as loading; both skipped (they read the in-page
// UI removed in Margin 2 Phase 2 step 5). Not run for now (no E2E runs for now).
let ctx, dir, server, base;
before(async () => {
  dir = buildSafariProfile();
  ctx = await launch({ extensionPath: dir });
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const name = req.url.slice(1).split(/[?#]/)[0];
    const spa = name === 'spa'
      ? `<script>
          // A single-page app using the Navigation API: '#slow' takes 800ms, '#fast' 20ms.
          navigation.addEventListener('navigate', (e) => {
            const ms = e.destination.url.endsWith('#slow') ? 800 : e.destination.url.endsWith('#fast') ? 20 : 0;
            if (ms && e.canIntercept) e.intercept({ handler: () => new Promise((r) => setTimeout(r, ms)) });
          });
        </script>`
      : '';
    res.end(`<!doctype html><title>${name}</title><body style="margin:0"><h1>${name}</h1>${spa}<div style="height:1500px"></div></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await ctx?.context.close();
  server?.close();
  if (dir) rmSync(dirname(dir), { recursive: true, force: true });
});

async function open(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.bringToFront();
  await waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () { return !!this.querySelector('.tab'); }));
  return page;
}

test('with the Navigation API, a swipe toward no history shows no badge and goes nowhere', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await open('no-history'); // a fresh tab: nothing to go back to
  await page.mouse.move(600, 300);
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(-12 + (i % 3) - 1, 0);
    await page.waitForTimeout(16);
  }
  const badge = await evalInShadow(page, 'margin-sidebar-host', function () { return this.querySelector('.swipe').classList.contains('active'); });
  assert.equal(badge, false);
  await page.waitForTimeout(400);
  assert.equal(new URL(page.url()).pathname, '/no-history');
  await page.close();
});

test('a slow same-page navigation run through the Navigation API shows the loading pill; a fast one doesn\'t', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await open('spa');
  await page.waitForTimeout(800); // the page's own load pill is gone
  const loading = () => page.evaluate(() => document.querySelector('margin-sidebar-host').dataset.loading);
  assert.notEqual(await loading(), 'true');
  await page.evaluate(() => { navigation.navigate('#fast'); });
  await page.waitForTimeout(300);
  assert.notEqual(await loading(), 'true', 'under 150ms: no pill');
  await page.evaluate(() => { navigation.navigate('#slow'); });
  await waitFor(async () => (await loading()) === 'true', { timeout: 1500 });
  await waitFor(async () => (await loading()) === 'false', { timeout: 2500 });
  await page.close();
});
