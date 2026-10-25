import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, sidebarSnapshot, tabsInBrowser, waitFor, buildSafariProfile } from './helpers.js';

const PNG = readFileSync(new URL('../../extension/icons/icon-48.png', import.meta.url));
let server, base;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/icon.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    const name = req.url.slice(1) || 'home';
    res.writeHead(200, { 'content-type': 'text/html' })
      .end(`<!doctype html><title>${name}</title><link rel="icon" href="/icon.png"><h1>${name}</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const storage = (ctx, key) => ctx.worker.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key);
async function openPage(ctx, name) {
  const page = await ctx.context.newPage();
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

test('Chrome build: Chrome profile, ⌃⌘ shortcuts, and no icon fetching (Chrome provides favIconUrl)', async () => {
  const ctx = await launch();
  try {
    assert.equal(await ctx.worker.evaluate(() => globalThis.Margin.platform.name), 'chrome');
    const page = await openPage(ctx, 'chrome-icons');
    assert.equal(await page.evaluate(() => document.title), 'chrome-icons');
    await waitFor(async () => (await storage(ctx, 'settings'))?.shortcuts);
    assert.equal((await storage(ctx, 'settings')).shortcuts.nextTab, 'Ctrl+Meta+ArrowDown');
    await page.waitForTimeout(1500);
    assert.deepEqual((await storage(ctx, 'favicons')) ?? {}, {}, 'nothing fetched');
  } finally {
    await ctx.context.close();
  }
});

test('Safari profile: ⌥⌘↓/↑ are the default tab shortcuts on the page, and icons are fetched', async () => {
  const dir = buildSafariProfile();
  const ctx = await launch({ extensionPath: dir });
  try {
    assert.equal(await ctx.worker.evaluate(() => globalThis.Margin.platform.name), 'safari');
    const a = await openPage(ctx, 'safari-a');
    const b = await openPage(ctx, 'safari-b');
    await waitFor(async () => (await storage(ctx, 'settings'))?.shortcuts);
    const { shortcuts } = await storage(ctx, 'settings');
    assert.equal(shortcuts.nextTab, 'Alt+Meta+ArrowDown');
    assert.equal(shortcuts.prevTab, 'Alt+Meta+ArrowUp');
    assert.equal(shortcuts.nextSpace, 'Ctrl+Meta+ArrowRight');
    await waitFor(async () => (await storage(ctx, 'favicons'))?.[base]);

    const activeTitle = async () => (await tabsInBrowser(ctx.worker)).find((t) => t.active)?.title;
    const id = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'safari-a').id;
    await a.bringToFront();
    await ctx.worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), id);
    await waitFor(async () => (await activeTitle()) === 'safari-a');
    await waitFor(async () => (await sidebarSnapshot(a)).tabs.includes('safari-b'));
    const order = (await sidebarSnapshot(a)).tabs;
    await a.keyboard.press('Alt+Meta+ArrowDown');
    await waitFor(async () => (await activeTitle()) === order[(order.indexOf('safari-a') + 1) % order.length]);
    await b.close();
    await a.close();
  } finally {
    await ctx.context.close();
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});
