import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, clickInShadow, evalInShadow, paletteSnapshot, tabsInBrowser, waitFor, gotoLauncher, readState } from './helpers.js';

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

test('sidebar is hidden by default, reveals at the left edge, hides 300ms after leaving', async () => {
  const page = await openPage('hover');
  await waitFor(async () => (await sidebarSnapshot(page)).tabs.includes('hover'));
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.mouse.move(400, 200);
  await page.mouse.move(3, 200);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(120, 200); // inside the 260px panel: stays open
  await page.waitForTimeout(450);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(600, 200);
  await page.waitForTimeout(150);
  assert.equal((await sidebarSnapshot(page)).open, true, 'still within the 300ms grace period');
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 1000 });
  await page.close();
});

test('overlay never changes the page layout', async () => {
  const page = await openPage('layout');
  await page.mouse.move(3, 200);
  const styles = await page.evaluate(() => {
    const pick = (el) => { const cs = getComputedStyle(el); return [cs.marginLeft, cs.paddingLeft, cs.transform]; };
    return [pick(document.documentElement), pick(document.body)];
  });
  assert.deepEqual(styles, [['0px', '0px', 'none'], ['0px', '0px', 'none']]);
  await page.close();
});

test('lists tabs; clicking a row activates it; the close button closes it', async () => {
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
const menuOpen = (page) => evalInShadow(page, 'margin-sidebar-host', function () { return !this.querySelector('.tab-menu').hidden; });

test('pin a tab; clicking the pin focuses the existing tab, or opens it if closed', async () => {
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

test('switching space filters tabs; new tabs join the active space', async () => {
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

test('one sidebar color: the same gray on every site, in every space, in Light and Dark Mode', async () => {
  const bg = (page) => evalInShadow(page, 'margin-sidebar-host', function () {
    const aside = this.querySelector('.margin-sidebar');
    return { theme: aside.dataset.theme, bg: getComputedStyle(aside).backgroundColor };
  });
  const darkSite = await openPage('dark');
  const lightSite = await openPage('light');
  await darkSite.emulateMedia({ colorScheme: 'light' });
  await lightSite.emulateMedia({ colorScheme: 'light' });
  const a = await bg(darkSite);
  const b = await bg(lightSite);
  assert.deepEqual(a, b, 'same color on a dark site and a light site');
  assert.equal(a.theme, 'light');
  assert.equal(a.bg, 'rgb(156, 157, 161)');

  // A space with a different color doesn't tint it.
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  await nt.evaluate((w) => chrome.runtime.sendMessage({ type: 'createSpace', windowId: w, name: 'Red', color: '#d63031' }), windowId);
  await waitFor(async () => (await sidebarSnapshot(lightSite)).chips.length >= 2);
  assert.equal((await bg(lightSite)).bg, 'rgb(156, 157, 161)');
  await nt.evaluate((w) => chrome.runtime.sendMessage({ type: 'setSpace', windowId: w, spaceId: 'personal', bringTab: false }), windowId);
  await nt.close();

  // Dark Mode keeps the same gray.
  await darkSite.emulateMedia({ colorScheme: 'dark' });
  await lightSite.emulateMedia({ colorScheme: 'dark' });
  await waitFor(async () => (await bg(lightSite)).theme === 'dark');
  assert.deepEqual(await bg(darkSite), await bg(lightSite));
  assert.equal((await bg(lightSite)).bg, 'rgb(156, 157, 161)');
  await darkSite.close();
  await lightSite.close();
});

test('new-tab page renders the sidebar itself and gets no injected overlay', async () => {
  await openPage('nt-check');
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  await nt.waitForSelector('#sidebar .margin-sidebar.newtab .tab');
  assert.equal(await nt.locator('margin-sidebar-host').count(), 0);
  // "+ New Tab" (the first row of the tab list) opens the command palette (Arc-style), here and on web pages.
  const tabsBefore = (await tabsInBrowser(ctx.worker)).length;
  await nt.locator('#sidebar .new-tab-row').click();
  await waitFor(async () => (await paletteSnapshot(nt))?.open);
  const web = await openPage('nt-plus');
  await web.mouse.move(400, 200);
  await web.mouse.move(5, 200);
  await waitFor(async () => (await sidebarSnapshot(web)).open);
  await clickInShadow(web, '.new-tab-row');
  await waitFor(async () => (await paletteSnapshot(web))?.open);
  assert.equal((await tabsInBrowser(ctx.worker)).length, tabsBefore + 1, 'only the page opened above, no extra tab');
  await web.close();
  await nt.close();
});

test('toggle shortcut: opens and closes; with "Keep open" on it switches back to auto-hide', async () => {
  const page = await openPage('toggle');
  const tabId = await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'toggle')?.id);
  const toggle = () => ctx.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'command', command: 'toggle-sidebar' }), tabId);
  const pinned = () => ctx.worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.sidebarPinnedOpen));

  await toggle();
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await toggle();
  await waitFor(async () => !(await sidebarSnapshot(page)).open);

  await page.mouse.move(3, 200);
  await clickInShadow(page, '.keep-open');
  await waitFor(pinned);
  await page.mouse.move(600, 200);
  await page.waitForTimeout(400);
  assert.equal((await sidebarSnapshot(page)).open, true, 'kept open');

  await toggle();
  await waitFor(async () => !(await pinned()));
  await page.waitForTimeout(100);
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.close();
});

const frameState = (page) =>
  evalInShadow(page, 'margin-sidebar-host', function () {
    const frame = this.querySelector('.frame');
    const r = this.querySelector('.frame .hole').getBoundingClientRect();
    return { open: frame.classList.contains('open'), hole: [r.left, r.top, innerWidth - r.right, innerHeight - r.bottom] };
  });
const htmlMargins = (page) =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { left: cs.marginLeft, right: cs.marginRight, styleAttr: document.documentElement.getAttribute('style'), styleTags: document.querySelectorAll('style').length };
  });
const setKeepOpen = (on) =>
  ctx.worker.evaluate((v) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, sidebarPinnedOpen: v } })), on);

const panelRect = (page) =>
  evalInShadow(page, 'margin-sidebar-host', function () {
    const r = this.querySelector('.margin-sidebar').getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(innerHeight - r.bottom)];
  });

test('hover: a floating sidebar over the page, no frame, page never moves', async () => {
  const page = await openPage('frame');
  await page.mouse.move(400, 200);
  await page.mouse.move(8, 200); // within the 10px reveal zone
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await page.waitForTimeout(250); // slide-in transition
  assert.deepEqual(await panelRect(page), [8, 8, 8], 'inset 8px from the edges');
  assert.equal((await frameState(page)).open, false, 'frame only with Keep open');
  assert.equal((await htmlMargins(page)).left, '0px');
  await page.mouse.move(264, 200); // over the card's right part: stays open
  await page.waitForTimeout(450);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(700, 200);
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 1500 });
  await page.close();
});

test('Keep open pushes the page to start at the sidebar edge, without touching page markup; off restores it', async () => {
  const page = await openPage('push');
  const before = await htmlMargins(page);
  await setKeepOpen(true);
  await waitFor(async () => (await htmlMargins(page)).left === '260px');
  const pushed = await htmlMargins(page);
  assert.equal(pushed.right, '8px');
  assert.equal(pushed.styleAttr, before.styleAttr, 'no inline style on <html>');
  assert.equal(pushed.styleTags, before.styleTags, 'no <style> injected into the page');
  const h1Left = await page.evaluate(() => document.querySelector('h1').getBoundingClientRect().left);
  assert.ok(h1Left >= 260, `content starts after the sidebar (h1 at ${h1Left})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
  assert.equal((await frameState(page)).open, true);
  assert.deepEqual((await frameState(page)).hole, [260, 8, 8, 8], 'frame wraps the pushed page');
  await page.waitForTimeout(250);
  assert.deepEqual(await panelRect(page), [0, 0, 0], 'docked flush to the window');

  await page.emulateMedia({ media: 'print' });
  assert.equal((await htmlMargins(page)).left, '0px', 'print is unaffected');
  await page.emulateMedia({ media: 'screen' });

  await setKeepOpen(false);
  await waitFor(async () => (await htmlMargins(page)).left === '0px');
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.close();
});

test('Keep open: sidebar and push are in place while the page is still loading', async () => {
  const { createServer } = await import('node:http');
  const slow = createServer((req, res) => {
    if (req.url === '/slow.png') return setTimeout(() => res.end(), 3000); // holds the load event
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>slow</title><body style="margin:0"><h1>slow</h1><img src="/slow.png"></body>');
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  await setKeepOpen(true);
  const page = await ctx.context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${slow.address().port}/`, { waitUntil: 'commit' });
    await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
    await waitFor(async () => (await sidebarSnapshot(page))?.open, { timeout: 1500 });
    assert.equal((await htmlMargins(page)).left, '260px');
    assert.notEqual(await page.evaluate(() => document.readyState), 'complete', 'page has not finished loading');
  } finally {
    await setKeepOpen(false);
    await page.close();
    await new Promise((r) => { slow.closeAllConnections(); slow.close(r); });
  }
});

test('Keep open registers the first-paint placeholder for the current width; Margin takes over on the page', async () => {
  const registered = () =>
    ctx.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['margin-docked'] }).then((r) => r[0]?.css?.[0] ?? null));
  const placeholder = (page) =>
    page.evaluate(() => ({
      content: getComputedStyle(document.documentElement, '::after').content,
      left: getComputedStyle(document.documentElement).marginLeft,
      attr: document.documentElement.dataset.marginDocked ?? null,
    }));

  await setKeepOpen(true);
  await waitFor(async () => (await registered())?.endsWith('themes/arcadium/docked/w-260.css'));
  const page = await openPage('placeholder');
  // The placeholder pushed the first paint; Margin's live push now holds the
  // same width and the placeholder is switched off on this page.
  await waitFor(async () => (await placeholder(page)).attr === 'off');
  assert.deepEqual(await placeholder(page), { content: 'none', left: '260px', attr: 'off' });

  const tabId = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'placeholder').id;
  await ctx.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'command', command: 'toggle-sidebar' }), tabId);
  await waitFor(async () => (await registered()) === null);
  await waitFor(async () => (await placeholder(page)).left === '0px');

  await setKeepOpen(true);
  await waitFor(async () => (await placeholder(page)).left === '260px');
  await waitFor(async () => (await registered()) !== null);
  await setKeepOpen(false);
  await waitFor(async () => (await registered()) === null);
  await page.close();
});

test('exactly one highlighted tab, the current one, after opening and switching pages', async () => {
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

test('right-click menu on tabs: pin, move to another space, close; no hover pin button', async () => {
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  const send = (message) => nt.evaluate((m) => chrome.runtime.sendMessage(m).then((r) => r?.result), message);
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  const { spaceId: work } = await send({ type: 'createSpace', name: 'Menu test', emoji: '🧪', color: '#e17055' }); // windowId omitted: stays on the current space
  const a = await openPage('menu-a');
  const b = await openPage('menu-b');
  await b.bringToFront();
  await waitFor(async () => { const { tabs } = await sidebarSnapshot(b); return tabs.includes('menu-a') && tabs.includes('menu-b'); });
  assert.equal(await evalInShadow(b, 'margin-sidebar-host', function () { return this.querySelectorAll('.pin-tab').length; }), 0, 'no hover pin button');

  const items = await openMenu(b, '.tab', 'menu-a');
  assert.equal(items[0], 'Pin Tab');
  assert.ok(items.includes('Move to 🧪 Menu test'), JSON.stringify(items));
  assert.equal(items.at(-1), 'Close Tab');
  await evalInShadow(b, 'margin-sidebar-host', function () {
    this.querySelector('.tab-menu .menu-item').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  });
  assert.equal(await menuOpen(b), false, 'Escape closes it');
  await openMenu(b, '.tab', 'menu-a');
  await b.mouse.click(700, 300);
  assert.equal(await menuOpen(b), false, 'a click on the page closes it');

  await openMenu(b, '.tab', 'menu-a');
  await clickInShadow(b, '.tab-menu .menu-item', 'Move to 🧪 Menu test');
  await waitFor(async () => !(await sidebarSnapshot(b)).tabs.includes('menu-a'));
  const tabId = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'menu-a').id;
  assert.equal((await readState(ctx.worker, 'tabSpace'))[tabId], work);

  await openMenu(b, '.tab', 'menu-b');
  const closed = b.waitForEvent('close');
  await clickInShadow(b, '.tab-menu .menu-item', 'Close Tab').catch(() => {}); // the tab may close before the helper detaches
  await closed;

  await a.close();
  await send({ type: 'deleteSpace', spaceId: work });
  assert.ok(windowId != null);
  await nt.close();
});
