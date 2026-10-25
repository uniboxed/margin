import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launch, evalInShadow, waitFor, launcherUrl } from './helpers.js';

let ctx, base, server, control;
before(async () => {
  ctx = await launch();
  server = createServer((req, res) => {
    if (req.url.startsWith('/slow.png')) return setTimeout(() => res.end(), 2500); // holds the load event
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const slow = req.url.includes('slow');
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><body style="margin:0"><h1>page</h1>${slow ? '<img src="/slow.png">' : ''}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  control = await ctx.context.newPage();
  await control.goto(launcherUrl(ctx));
});
after(async () => {
  await ctx?.context.close();
  server.closeAllConnections();
  server.close();
});

const setSettings = (patch) => control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
const loaderState = (page) =>
  evalInShadow(page, 'margin-sidebar-host', function () {
    const el = this.querySelector('.loader');
    const r = el.getBoundingClientRect();
    return { on: el.classList.contains('on'), inFrame: el.classList.contains('in-frame'), centerX: Math.round(r.left + r.width / 2), top: Math.round(r.top), vw: innerWidth };
  });

async function load(path) {
  const page = await ctx.context.newPage();
  await page.goto(`${base}/${path}`, { waitUntil: 'commit' });
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

test('auto-hide: the pill shows centered at the top while the page loads, then goes away', async () => {
  await setSettings({ sidebarPinnedOpen: false });
  const page = await load('slow-hover');
  const s = await waitFor(async () => {
    const v = await loaderState(page);
    return v?.on && v;
  });
  assert.equal(await page.evaluate(() => document.readyState !== 'complete'), true, 'still loading');
  assert.equal(s.inFrame, false);
  assert.ok(Math.abs(s.centerX - s.vw / 2) <= 1, `centered on the window (${s.centerX} vs ${s.vw / 2})`);
  assert.equal(s.top, 2);
  await page.waitForLoadState('load');
  await waitFor(async () => !(await loaderState(page)).on, { timeout: 2000 });
  await page.close();
});

test('Keep open: the pill sits in the frame strip, centered over the page', async () => {
  await setSettings({ sidebarPinnedOpen: true, sidebarWidth: 300 });
  const page = await load('slow-docked');
  const s = await waitFor(async () => {
    const v = await loaderState(page);
    return v?.on && v?.inFrame && v;
  });
  const pageCenter = 300 + (s.vw - 300 - 8) / 2;
  assert.ok(Math.abs(s.centerX - pageCenter) <= 1, `centered over the page area (${s.centerX} vs ${pageCenter})`);
  assert.ok(s.top >= 0 && s.top + 4 <= 8, 'inside the 8px top strip');
  await page.waitForLoadState('load');
  await waitFor(async () => !(await loaderState(page)).on, { timeout: 2000 });
  await setSettings({ sidebarPinnedOpen: false, sidebarWidth: 260 });
  await page.close();
});

test('a page that finishes quickly never leaves the pill showing', async () => {
  const page = await load('fast');
  await page.waitForLoadState('load');
  await waitFor(async () => (await loaderState(page))?.on === false, { timeout: 2000 });
  await page.waitForTimeout(700);
  assert.equal((await loaderState(page)).on, false);
  await page.close();
});
