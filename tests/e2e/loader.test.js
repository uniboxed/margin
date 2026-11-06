// A page's own loads (content/loads.js rules: leaving, a reload, a page that stays); all skipped
// (they read the in-page pill removed in Margin 2 Phase 2 step 5). Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launch, evalInShadow, waitFor, gotoLauncher } from './helpers.js';

let ctx, base, server, control;
const reports = [];
before(async () => {
  ctx = await launch();
  server = createServer((req, res) => {
    if (req.url.startsWith('/slow.png')) return setTimeout(() => res.end(), 2500); // holds the load event
    if (req.url.startsWith('/slow-response')) return setTimeout(() => res.end('<!doctype html><title>arrived</title><h1>arrived</h1>'), 1500);
    if (req.url.startsWith('/report')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => { reports.push(JSON.parse(body)); res.writeHead(204).end(); });
    }
    if (req.url.startsWith('/no-content')) return res.writeHead(204).end(); // a navigation that leaves the page in place
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const slow = req.url.includes('slow');
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><body style="margin:0"><h1>page</h1>${slow ? '<img src="/slow.png">' : ''}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  control = await ctx.context.newPage();
  await gotoLauncher(control, ctx);
});
after(async () => {
  await ctx?.context.close();
  server.closeAllConnections();
  server.close();
});

// The width is Arcadia's own setting (settings.themes.arcadia).
const setSettings = async ({ sidebarWidth, ...patch }) => {
  if (Object.keys(patch).length) await control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
  if (sidebarWidth != null) await control.evaluate((w) => chrome.runtime.sendMessage({ type: 'updateThemeSettings', themeId: 'arcadia', patch: { sidebarWidth: w } }), sidebarWidth);
};
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

// While a navigation is pending, Playwright can't look at the old page (it
// waits for the new one), so the old page reports its own pill state to the
// server every 50ms: `loading` is the sidebar host's test hook, set with the
// pill's `on` class.
function reportWhileLeaving(page, navigate) {
  return page.evaluate((go) => {
    const host = document.querySelector('margin-sidebar-host');
    const title = document.title;
    setInterval(() => navigator.sendBeacon('/report', JSON.stringify({ title, loading: host.dataset.loading })), 50);
    if (go) setTimeout(() => { location.href = go; }, 20); // after evaluate returns
  }, navigate ?? null);
}

test('leaving a page shows the pill on it right away, before the next page arrives', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  await setSettings({ sidebarPinnedOpen: true, sidebarWidth: 260 });
  const page = await load('leave-from');
  await page.waitForLoadState('load');
  await waitFor(async () => (await loaderState(page))?.on === false, { timeout: 2000 });
  reports.length = 0;
  await reportWhileLeaving(page, `${base}/slow-response`);
  await page.waitForURL('**/slow-response');
  const fromOld = reports.filter((r) => r.title === 'leave-from');
  assert.ok(fromOld.some((r) => r.loading === 'true'), `pill on while the server took 1.5s (${JSON.stringify(fromOld.slice(0, 3))}…)`);
  assert.equal(fromOld.at(-1).loading, 'true', 'still on when the old page went away');
  await setSettings({ sidebarPinnedOpen: false });
  await page.close();
});

test('the same for a reload (⌘R)', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await load('slow-response?reload');
  await page.waitForLoadState('load');
  await waitFor(async () => (await loaderState(page))?.on === false, { timeout: 2000 });
  reports.length = 0;
  await reportWhileLeaving(page);
  await page.waitForTimeout(150);
  await page.reload();
  const before = reports.filter((r) => r.loading !== 'true').length;
  assert.ok(before > 0 && reports.some((r) => r.loading === 'true'), `pill turned on during the reload (${reports.length} reports)`);
  await page.close();
});

test('if the page stays after all (no navigation happens), the pill goes away once the user does something', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await load('stays');
  await page.waitForLoadState('load');
  await waitFor(async () => (await loaderState(page))?.on === false, { timeout: 2000 });
  const loading = () => page.evaluate(() => document.querySelector('margin-sidebar-host').dataset.loading);
  await page.evaluate((url) => setTimeout(() => { location.href = url; }, 20), `${base}/no-content`);
  await waitFor(async () => (await loading()) === 'true', { timeout: 2000 });
  await page.waitForTimeout(300);
  assert.equal(await page.title(), 'stays');
  assert.equal(await loading(), 'true', 'nothing tells Margin the navigation was dropped');
  await page.mouse.click(600, 300);
  await waitFor(async () => (await loading()) === 'false', { timeout: 2000 });
  await page.close();
});
