// The stamped platform profiles (Chrome, Safari): shortcut defaults and their upgrade, icon
// fetching, gesture blocking; all skipped (they wait for the in-page UI or open the launcher,
// both removed in Margin 2 Phase 2 step 5). Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, waitFor, buildSafariProfile, gotoLauncher, readState } from './helpers.js';

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

const storage = (ctx, key) => readState(ctx.worker, key);
async function openPage(ctx, name) {
  const page = await ctx.context.newPage();
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

test('Chrome build: Chrome profile, ⌃⌘ shortcuts, and no icon fetching (Chrome provides favIconUrl)', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
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

test('upgrading to the Safari build: saved ⌃⌘ defaults move to ⌥⌘↓/↑, customized shortcuts stay', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const dir = buildSafariProfile();
  const ctx = await launch({ extensionPath: dir });
  try {
    await waitFor(async () => (await storage(ctx, 'settings'))?.shortcuts);
    // As saved by a version before per-browser builds (⌃⌘ defaults, no
    // marker), with one custom shortcut. Then stop the background so it
    // starts fresh from storage, as after Safari reloads Margin.
    await ctx.worker.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) => {
      delete settings.shortcutDefaults;
      settings.shortcuts = { nextTab: 'Ctrl+Meta+ArrowDown', prevTab: 'Ctrl+Meta+ArrowUp', nextSpace: 'Alt+Shift+KeyL', prevSpace: 'Ctrl+Meta+ArrowLeft' };
      return chrome.storage.local.set({ settings });
    }));
    const page = await ctx.context.newPage();
    await gotoLauncher(page, ctx);
    const cdp = await ctx.context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'hello' }).catch(() => {})); // wakes it
    ctx.worker = await waitFor(() => ctx.context.serviceWorkers()[0]);
    // Only a fresh background rewrites the settings (the stopped one had
    // them cached), so this also proves the restart.
    const settings = await waitFor(async () => {
      const s = await storage(ctx, 'settings');
      return s?.shortcutDefaults === 'safari' && s;
    });
    assert.deepEqual(settings.shortcuts, {
      nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Alt+Shift+KeyL', prevSpace: 'Ctrl+Meta+ArrowLeft',
    });
  } finally {
    await ctx.context.close();
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('Safari: sideways swipes are blocked, scrolling is not; the setting turns it off (pinch: tests/gestures.test.js)', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const dir = buildSafariProfile();
  const ctx = await launch({ extensionPath: dir });
  try {
    const page = await ctx.context.newPage();
    await page.goto(`${base}/gestures`);
    await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
    await waitFor(async () => (await storage(ctx, 'settings'))?.blockGestures === true);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div id="wide" style="position:fixed;left:400px;top:300px;width:300px;height:100px;overflow-x:auto"><div style="width:900px;height:80px"></div></div><div style="height:2000px"></div>');
      window.__wheel = [];
      document.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented)); // after Margin's capture listener
    });
    const wheel = async (x, y, dx, dy) => {
      await page.mouse.move(x, y);
      await page.mouse.wheel(dx, dy);
      await waitFor(() => page.evaluate(() => window.__wheel.length > 0));
      return page.evaluate(() => window.__wheel.splice(0).some(Boolean));
    };
    assert.equal(await wheel(600, 120, -80, 0), true, 'sideways on the page (would swipe back): blocked');
    assert.equal(await wheel(600, 120, 80, 0), true, 'sideways the other way (would swipe forward): blocked');
    assert.equal(await wheel(600, 120, 0, 80), false, 'vertical scrolling: untouched');
    assert.equal(await wheel(550, 350, 80, 0), false, 'over something that scrolls sideways: it scrolls');
    await waitFor(() => page.evaluate(() => document.getElementById('wide').scrollLeft > 0));
    await page.evaluate(() => { document.getElementById('wide').scrollLeft = 0; });
    assert.equal(await wheel(550, 350, -80, 0), true, 'over it, but already at its edge: blocked');


    // The setting turns it off.
    const nt = await ctx.context.newPage();
    await gotoLauncher(nt, ctx);
    assert.equal(await nt.isVisible('label:has-text("trackpad gestures")'), false, 'collapsed under Settings');
    await nt.click('#settings summary');
    assert.equal(await nt.isChecked('label:has-text("trackpad gestures") input'), true);
    await nt.uncheck('label:has-text("trackpad gestures") input');
    await waitFor(async () => (await storage(ctx, 'settings')).blockGestures === false);
    await page.bringToFront();
    await waitFor(async () => (await wheel(600, 120, -80, 0)) === false);
    await nt.close();
    await page.close();
  } finally {
    await ctx.context.close();
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('Chrome build: no gesture blocking and no setting for it', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const ctx = await launch();
  try {
    const page = await ctx.context.newPage();
    await page.goto(`${base}/chrome-gestures`);
    await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
    await page.evaluate(() => { window.__wheel = []; document.addEventListener('wheel', (e) => window.__wheel.push(e.defaultPrevented)); });
    await page.mouse.move(600, 120);
    await page.mouse.wheel(-80, 0);
    await waitFor(() => page.evaluate(() => window.__wheel.length > 0));
    assert.equal(await page.evaluate(() => window.__wheel.some(Boolean)), false);
    const nt = await ctx.context.newPage();
    await gotoLauncher(nt, ctx);
    assert.equal(await nt.evaluate(() => document.getElementById('gestures-setting').hidden), true);
  } finally {
    await ctx.context.close();
  }
});
