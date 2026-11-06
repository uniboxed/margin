// What the sidebar did that the background still does (activate, close, pin, spaces, the
// current tab); all skipped: driven through the in-page sidebar removed in Margin 2 Phase 2
// step 5. Not run for now (no E2E runs for now).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, clickInShadow, evalInShadow, tabsInBrowser, waitFor, gotoLauncher } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

async function openPage(name) {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return page;
}

test('lists tabs; clicking a row activates it; the close button closes it', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const a = await openPage('alpha');
  const b = await openPage('beta');
  await waitFor(async () => {
    const { tabs } = await sidebarSnapshot(b);
    return tabs.includes('alpha') && tabs.includes('beta');
  });
  await clickInShadow(b, '.tab', 'alpha');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'alpha')?.active);
  await clickInShadow(b, '.tab .close', 'alpha');
  await waitFor(async () => !(await tabsInBrowser(ctx.worker)).some((t) => t.title === 'alpha'));
  assert.equal(a.isClosed(), true);
  await waitFor(async () => !(await sidebarSnapshot(b)).tabs.includes('alpha'));
  await b.close();
});

// Right-click a row (in the closed shadow root) and return the menu's items.
async function openMenu(page, selector, text) {
  return evalInShadow(page, 'margin-sidebar-host', function (sel, txt) {
    const row = [...this.querySelectorAll(sel)].find((n) => n.textContent.includes(txt));
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    const menu = this.querySelector('.tab-menu');
    return menu.hidden ? null : [...menu.querySelectorAll('.menu-item')].map((b) => b.textContent);
  }, selector, text);
}

test('pin a tab; clicking the pin focuses the existing tab, or opens it if closed', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const p = await openPage('pinme');
  const other = await openPage('other');
  await waitFor(async () => (await sidebarSnapshot(other)).tabs.includes('pinme'));
  await openMenu(other, '.tab', 'pinme');
  await clickInShadow(other, '.tab-menu .menu-item', 'Pin Tab');
  await waitFor(async () => (await sidebarSnapshot(other)).pins.includes('pinme'));
  assert.ok(!(await sidebarSnapshot(other)).tabs.includes('pinme'), 'pinned tab shows under pins, not tabs');

  await clickInShadow(other, '.pin', 'pinme');
  await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'pinme')?.active);

  await p.close();
  await waitFor(async () => !(await tabsInBrowser(ctx.worker)).some((t) => t.title === 'pinme'));
  const opened = ctx.context.waitForEvent('page');
  await clickInShadow(other, '.pin', 'pinme');
  const reopened = await opened;
  await reopened.waitForLoadState();
  assert.equal(new URL(reopened.url()).pathname, '/pinme');

  // Unpin is in the pin's menu (Arc: its × closes the tab, the pin stays).
  await evalInShadow(other, 'margin-sidebar-host', function () {
    const row = [...this.querySelectorAll('.pin')].find((n) => n.textContent.includes('pinme'));
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: r.x + 10, clientY: r.y + 10 }));
  });
  await clickInShadow(other, '.menu-item', 'Unpin');
  await waitFor(async () => (await sidebarSnapshot(other)).pins.length === 0);
  await reopened.close();
  await other.close();
});

test('switching space filters tabs; new tabs join the active space', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const page = await openPage('space-a');
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const res = await nt.evaluate((w) => chrome.runtime.sendMessage({ type: 'createSpace', windowId: w, name: 'Work', emoji: '💼' }), windowId);
  assert.equal(res.ok, true);
  await waitFor(async () => (await sidebarSnapshot(page)).chips.find((c) => c.active)?.id === res.result.spaceId);
  assert.ok(!(await sidebarSnapshot(page)).tabs.includes('space-a'), 'old space tabs hidden');

  const fresh = await openPage('space-b');
  await waitFor(async () => (await sidebarSnapshot(fresh)).tabs.includes('space-b'));
  await clickInShadow(fresh, '.chip', null); // first chip = Personal
  await waitFor(async () => {
    const { tabs } = await sidebarSnapshot(fresh);
    return tabs.includes('space-a') && !tabs.includes('space-b');
  });
  for (const p of [page, nt, fresh]) await p.close();
});

test('exactly one highlighted tab, the current one, after opening and switching pages', { skip: 'drives or observes through the in-page UI removed in Margin 2 Phase 2 step 5: to rewrite against the app or storage' }, async () => {
  const highlighted = (page) =>
    evalInShadow(page, 'margin-sidebar-host', function () {
      return [...this.querySelectorAll('.tab.active .title, .pin.active .title')].map((n) => n.textContent);
    });
  const pages = [];
  for (const name of ['one', 'two', 'three']) pages.push(await openPage(`hl-${name}`));
  for (const [i, page] of [[0, pages[0]], [2, pages[2]], [1, pages[1]]]) {
    await page.bringToFront();
    const tabId = (await tabsInBrowser(ctx.worker)).find((t) => t.title === `hl-${['one', 'two', 'three'][i]}`).id;
    await ctx.worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
    await waitFor(async () => JSON.stringify(await highlighted(page)) === JSON.stringify([`hl-${['one', 'two', 'three'][i]}`]));
  }
  for (const p of pages) await p.close();
});
