import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, evalInShadow, boxInShadow, waitFor, buildSafariProfile, paletteSnapshot, gotoLauncher } from './helpers.js';

// Progressive enhancements (DECISIONS.md "Arc-closer with newer Safari
// features"): each is used only where supported; otherwise Margin behaves as
// before. Chromium here supports all of them; the fallbacks are covered by
// feature checks in the code. (CSS corner-shape is deliberately not used:
// see the first test.)
let ctx, dir, server, base, control;
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
  control = await ctx.context.newPage();
  await gotoLauncher(control, ctx);
});
after(async () => {
  await ctx?.context.close();
  server?.close();
  if (dir) rmSync(dirname(dir), { recursive: true, force: true });
});

const setSettings = (patch) => control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
async function open(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.bringToFront();
  await waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () { return !!this.querySelector('.tab'); }));
  return page;
}

test('plain rounded corners even where corner-shape is supported (no squircles yet)', async () => {
  await setSettings({ sidebarPinnedOpen: true });
  const page = await open('rounded');
  assert.equal(await page.evaluate(() => CSS.supports('corner-shape', 'squircle')), true, 'this Chromium supports it');
  const styles = await waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () {
    const pick = (sel) => {
      const s = getComputedStyle(this.querySelector(sel));
      // The default, round, is reported as 'round' or 'superellipse(1)'.
      return { radius: s.borderTopLeftRadius, shape: s.cornerTopLeftShape === 'superellipse(1)' ? 'round' : s.cornerTopLeftShape };
    };
    return this.querySelector('.card-edge').classList.contains('open') && { hole: pick('.frame .hole'), edge: pick('.card-edge'), row: pick('.tab') };
  }));
  assert.deepEqual(styles.hole, { radius: '6.25px', shape: 'round' });
  assert.deepEqual(styles.edge, { radius: '6.25px', shape: 'round' });
  assert.deepEqual(styles.row, { radius: '12px', shape: 'round' });
  await setSettings({ sidebarPinnedOpen: false });
  await page.close();
});

test('the palette opens in the top layer, above a site\'s own popover; not while a site modal is open', async () => {
  const page = await open('top-layer');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="site-popover" popover="manual" style="width:90vw;height:90vh;margin:auto">site popover</div>');
    document.getElementById('site-popover').showPopover();
  });
  await page.keyboard.press('Meta+KeyT');
  await waitFor(async () => (await paletteSnapshot(page))?.open);
  const state = await page.evaluate(() => {
    const host = document.querySelector('margin-palette-host');
    return { open: host.matches(':popover-open'), onTop: document.elementFromPoint(innerWidth / 2, innerHeight * 0.4) === host };
  });
  assert.deepEqual(state, { open: true, onTop: true });
  await page.keyboard.press('Escape');
  await waitFor(() => page.evaluate(() => !document.querySelector('margin-palette-host').matches(':popover-open')));

  await page.evaluate(() => {
    document.getElementById('site-popover').hidePopover();
    document.body.insertAdjacentHTML('beforeend', '<dialog id="site-modal">modal</dialog>');
    document.getElementById('site-modal').showModal();
  });
  await page.keyboard.press('Meta+KeyT');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelector('margin-palette-host')?.matches(':popover-open') ?? false), false, 'falls back to the z-index');
  await page.close();
});

test('the tab right-click menu opens in the top layer, at the pointer', async () => {
  const page = await open('menu-layer');
  const isOpen = await evalInShadow(page, 'margin-sidebar-host', function () {
    const row = this.querySelector('.tab');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 60, clientY: 90 }));
    const m = this.querySelector('.tab-menu');
    return m.matches(':popover-open');
  });
  const menu = await boxInShadow(page, 'margin-sidebar-host', '.tab-menu');
  assert.deepEqual({ open: isOpen, left: Math.round(menu.left), top: Math.round(menu.top) }, { open: true, left: 60, top: 90 });
  await page.keyboard.press('Escape').catch(() => {});
  await evalInShadow(page, 'margin-sidebar-host', function () {
    this.querySelector('.tab-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  });
  assert.equal(await evalInShadow(page, 'margin-sidebar-host', function () { return this.querySelector('.tab-menu').matches(':popover-open'); }), false);
  await page.close();
});

test('with the Navigation API, a swipe toward no history shows no badge and goes nowhere', async () => {
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

test('a slow same-page navigation run through the Navigation API shows the loading pill; a fast one doesn\'t', async () => {
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
