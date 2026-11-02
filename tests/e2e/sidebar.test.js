import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, sidebarSnapshot, clickInShadow, evalInShadow, paletteSnapshot, tabsInBrowser, waitFor, gotoLauncher, readState, updateSettings } from './helpers.js';

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
  const styles = () => page.evaluate(() => {
    const pick = (el) => { const cs = getComputedStyle(el); return [cs.marginLeft, cs.paddingLeft, cs.transform]; };
    return [pick(document.documentElement), pick(document.body)];
  });
  const before = await styles();
  await page.mouse.move(3, 200);
  assert.deepEqual(await styles(), before);
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
  await waitFor(async () => (await readState(ctx.worker, 'activeSpaceByWindow'))?.[windowId] === res.result.spaceId);

  const fresh = await openPage('space-b');
  await waitFor(async () => {
    const sidebar = await sidebarSnapshot(fresh);
    return sidebar.chips.find((c) => c.active)?.id === res.result.spaceId && sidebar.tabs.includes('space-b') && !sidebar.tabs.includes('space-a');
  });
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

test('toggle shortcut opens and closes', async () => {
  const page = await openPage('toggle');
  const tabId = await waitFor(async () => (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'toggle')?.id);
  const toggle = () => ctx.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'command', command: 'toggle-sidebar' }), tabId);

  await toggle();
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await page.waitForTimeout(220); // distinct from the duplicate command/page-key event guard
  await toggle();
  await waitFor(async () => !(await sidebarSnapshot(page)).open);
  await page.close();
});

const frameState = (page) =>
  evalInShadow(page, 'margin-sidebar-host', function () {
    const frame = this.querySelector('.frame');
    const style = getComputedStyle(this.querySelector('.frame .hole'));
    return { open: frame.classList.contains('open'), hole: [style.left, style.top, style.right, style.bottom].map((value) => Math.round(parseFloat(value))) };
  });
const htmlMargins = (page) =>
  page.evaluate(() => {
    // Where the page's box starts in the window (shared/page-box.js).
    const left = new DOMMatrix(getComputedStyle(document.documentElement).transform).e;
    return { left: `${left}px`, styleAttr: document.documentElement.getAttribute('style'), styleTags: document.querySelectorAll('style').length };
  });
const setKeepOpen = (on) =>
  updateSettings(ctx, { sidebarPinnedOpen: on });

const panelRect = (page) =>
  evalInShadow(page, 'margin-sidebar-host', function () {
    const panel = this.querySelector('.margin-sidebar');
    const style = getComputedStyle(panel);
    const inset = Math.round(parseFloat(style.top));
    return [Math.round(parseFloat(style.left)), inset, panel.classList.contains('docked') ? 0 : inset];
  });

test('hover: the sidebar floats over the framed page without changing its box', async () => {
  const page = await openPage('frame');
  await page.mouse.move(400, 200);
  await page.mouse.move(8, 200); // within the 10px reveal zone
  await waitFor(async () => (await sidebarSnapshot(page)).open);
  await page.waitForTimeout(250); // slide-in transition
  assert.deepEqual(await panelRect(page), [8, 8, 8], 'inset 8px from the edges');
  assert.equal((await frameState(page)).open, true, 'the always-on 8px page frame stays present');
  assert.equal((await htmlMargins(page)).left, '8px');
  await page.mouse.move(264, 200); // over the card's right part: stays open
  await page.waitForTimeout(450);
  assert.equal((await sidebarSnapshot(page)).open, true);
  await page.mouse.move(700, 200);
  await waitFor(async () => !(await sidebarSnapshot(page)).open, { timeout: 1500 });
  await page.close();
});

test('Keep open puts the page in its box at the sidebar edge, without touching page markup; off goes back to the frame', async () => {
  const page = await openPage('box');
  const before = await htmlMargins(page);
  await setKeepOpen(true);
  await waitFor(async () => (await htmlMargins(page)).left === '260px');
  const pushed = await htmlMargins(page);
  assert.equal(pushed.styleAttr, before.styleAttr, 'no inline style on <html>');
  assert.equal(pushed.styleTags, before.styleTags, 'no <style> injected into the page');
  const h1Left = await page.evaluate(() => document.querySelector('h1').getBoundingClientRect().left);
  assert.ok(h1Left >= 0 && h1Left < 40, `the page's own coordinates start at its box (h1 at ${h1Left})`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
  assert.equal((await frameState(page)).open, true);
  assert.deepEqual((await frameState(page)).hole, [260, 8, 8, 8], "frame wraps the page's box");
  await page.waitForTimeout(250);
  assert.deepEqual(await panelRect(page), [0, 0, 0], 'docked flush to the window');

  await page.emulateMedia({ media: 'print' });
  assert.equal((await htmlMargins(page)).left, '0px', 'print is unaffected');
  await page.emulateMedia({ media: 'screen' });

  await setKeepOpen(false);
  await waitFor(async () => (await htmlMargins(page)).left === '8px');
  assert.equal((await sidebarSnapshot(page)).open, false);
  await page.close();
});

test('Keep open virtualizes late CSSOM, shadow sheets, keyframes, media edits, and negated :has()', async () => {
  await setKeepOpen(true);
  const page = await openPage('dynamic-css');
  try {
    await waitFor(async () => (await htmlMargins(page)).left === '260px');
    const setup = await page.evaluate(() => {
      // The private hold/cover selector must remain true for ordinary author
      // ids; repeating one id in :not() would accidentally exclude this body.
      document.body.id = 'm';
      const host = document.createElement('section');
      host.id = 'dynamic-shadow-host';
      window.__dynamicShadowHost = host;
      document.body.append(host);
      const root = host.attachShadow({ mode: 'closed' });
      window.__dynamicShadowRoot = root;
      const adopted = new CSSStyleSheet();
      adopted.replaceSync('#adopted { display:block; width:100vw; height:1px } #adopted:has(+ #text) { color: rgb(1, 2, 3) }');
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, adopted];
      root.innerHTML = '<i id="adopted"></i><i id="text"></i>';
      const text = document.createElement('style');
      text.textContent = '#text { display:block; width:10px; height:1px }';
      root.prepend(text);
      text.textContent = '#text { display:block; width:100vw; height:1px }';

      const dynamic = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, dynamic];
      dynamic.addRule('#added', 'display:block; width:100vw; height:1px');
      const retainedRuleStyle = dynamic.cssRules[0].style;
      retainedRuleStyle.setProperty('height', '10vh');
      document.body.insertAdjacentHTML('beforeend', '<i id="added"></i>');

      const keyframes = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, keyframes];
      keyframes.replaceSync('@keyframes margin-grow {}');
      keyframes.cssRules[0].appendRule('from { width: 100vw }');

      const mediaStyle = document.createElement('style');
      mediaStyle.textContent = '@media (max-width: 900px) { #added { color: rgb(1, 2, 3) } }';
      document.head.append(mediaStyle);
      const medium = mediaStyle.sheet.cssRules[0].media;
      const beforeMedium = medium.mediaText;
      let threw = false;
      try { medium.deleteMedium('(max-width: 999999px)'); } catch { threw = true; }

      const hasStyle = document.createElement('style');
      hasStyle.textContent = 'body:not(:has(.ghost)) { margin-left: 100px !important }';
      document.head.append(hasStyle);
      return {
        threw,
        beforeMedium,
        afterMedium: medium.mediaText,
        keyframeWidth: keyframes.cssRules[0].cssRules[0].style.width,
        retainedRuleHeight: retainedRuleStyle.height,
        ruleMethodIsOwn: Object.hasOwn(retainedRuleStyle, 'setProperty'),
        inlinePrototypeIsNative: Function.prototype.toString.call(CSSStyleDeclaration.prototype.setProperty).includes('[native code]'),
      };
    });
    assert.equal(setup.threw, true, 'the native missing-medium exception is preserved');
    assert.equal(setup.afterMedium, setup.beforeMedium, 'a throwing edit keeps the virtual query shift');
    assert.match(setup.keyframeWidth, /--margin-dw/, 'a dynamic keyframe uses the virtual viewport');
    assert.match(setup.retainedRuleHeight, /--margin-dh/, 'a retained rule method still rewrites viewport units');
    assert.equal(setup.ruleMethodIsOwn, false, 'rule declarations inherit their mutation hooks from one shared prototype');
    assert.equal(setup.inlinePrototypeIsNative, true, 'ordinary element.style writes retain the browser\'s native hot path');

    await page.waitForTimeout(200);
    const dynamicWidths = await page.evaluate(() => ({
      expected: Math.round(innerWidth),
      adopted: Math.round(window.__dynamicShadowRoot.getElementById('adopted').getBoundingClientRect().width),
      text: Math.round(window.__dynamicShadowRoot.getElementById('text').getBoundingClientRect().width),
      added: Math.round(document.getElementById('added').getBoundingClientRect().width),
    }));
    assert.deepEqual(dynamicWidths, { expected: dynamicWidths.expected, adopted: dynamicWidths.expected, text: dynamicWidths.expected, added: dynamicWidths.expected });
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 100));
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('i'), { className: 'ghost' })));
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 0));
    await page.evaluate(() => document.querySelector('.ghost').remove());
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 100));
    await page.evaluate(() => {
      const style = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((rule) => rule.selectorText?.includes(':has(.ghost)'))?.parentStyleSheet?.ownerNode;
      style.textContent = 'body:not(:has([data-x=")"])) { margin-left: 100px !important }';
      document.body.append(Object.assign(document.createElement('i'), { id: 'quoted-has' }));
      document.getElementById('quoted-has').setAttribute('data-x', ')');
    });
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 0));
    await page.evaluate(() => document.getElementById('quoted-has').remove());
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 100));
    await page.evaluate(() => window.__dynamicShadowHost.remove());
    await page.waitForTimeout(100);
    await page.evaluate(() => document.body.append(window.__dynamicShadowHost));
    await waitFor(() => page.evaluate(() => {
      return Math.round(window.__dynamicShadowRoot.getElementById('adopted').getBoundingClientRect().width) === Math.round(innerWidth);
    }));
  } finally {
    await setKeepOpen(false);
    await page.close();
  }
});

test('Keep open tracks logical rule properties and adopted-sheet removal, re-adoption, and moves', async () => {
  await setKeepOpen(true);
  const page = await openPage('dynamic-css-lifecycle');
  try {
    await waitFor(async () => (await htmlMargins(page)).left === '260px');
    const initial = await page.evaluate(async () => {
      document.body.style.margin = '';
      const bodySheet = new CSSStyleSheet();
      bodySheet.replaceSync('body { margin: 0 } .probe { width: 1px }');
      window.__logicalRule = bodySheet.cssRules[0].style;
      window.__secondRule = bodySheet.cssRules[1].style;

      const documentMedia = new CSSStyleSheet();
      documentMedia.replaceSync('@media (max-width: 900px) { body { color: rgb(1, 2, 3) } }');
      window.__documentMedia = documentMedia;

      const host = document.createElement('section');
      document.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      window.__mediaRoot = root;
      const shadowMedia = new CSSStyleSheet();
      shadowMedia.replaceSync('@media (max-width: 900px) { :host { display: block } }');
      window.__shadowMedia = shadowMedia;

      const importUrl = URL.createObjectURL(new Blob(['@media (max-width: 900px) { body { color: rgb(4, 5, 6) } }'], { type: 'text/css' }));
      const importStyle = document.createElement('style');
      importStyle.textContent = `@import url("${importUrl}");`;
      document.head.append(importStyle);
      window.__importStyle = importStyle;
      for (let i = 0; i < 100; i++) {
        if (importStyle.sheet?.cssRules[0]?.styleSheet?.cssRules?.[0]?.media.mediaText === '(max-width: 1168px)') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      document.adoptedStyleSheets = [...document.adoptedStyleSheets, bodySheet, documentMedia];
      root.adoptedStyleSheets = [shadowMedia];
      const media = (sheet) => sheet.cssRules[0].media.mediaText;
      const imported = importStyle.sheet.cssRules[0].styleSheet.cssRules[0].media.mediaText;
      return {
        document: media(documentMedia), shadow: media(shadowMedia), imported,
        sharedPrototype: Object.getPrototypeOf(window.__logicalRule) === Object.getPrototypeOf(window.__secondRule),
        inlinePrototypeIsNative: Object.getPrototypeOf(document.body.style) === CSSStyleDeclaration.prototype,
        ownSetProperty: Object.hasOwn(window.__logicalRule, 'setProperty'),
      };
    });
    assert.deepEqual(initial, {
      document: '(max-width: 1168px)', shadow: '(max-width: 1168px)', imported: '(max-width: 1168px)',
      sharedPrototype: true, inlinePrototypeIsNative: true, ownSetProperty: false,
    });

    await page.evaluate(() => {
      window.__logicalRule.marginInlineStart = '120px';
      window.__logicalRule.inlineSize = 'calc(100vw - 20px)';
    });
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 120));
    assert.match(await page.evaluate(() => window.__logicalRule.inlineSize), /--margin-dw/, 'a direct modern IDL property write virtualizes viewport units');

    await page.evaluate(() => document.body.style.setProperty('margin-left', '100px', 'important'));
    await waitFor(() => page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return Math.round(document.querySelector('h1').getBoundingClientRect().left) === 100 && style.marginLeft === '100px' && style.paddingLeft === '0px';
    }));
    await page.evaluate(() => document.body.style.removeProperty('margin-left'));
    await waitFor(() => page.evaluate(() => Math.round(document.querySelector('h1').getBoundingClientRect().left) === 120));

    const removed = await page.evaluate(() => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== window.__documentMedia);
      window.__mediaRoot.adoptedStyleSheets = [];
      const media = (sheet) => sheet.cssRules[0].media.mediaText;
      return { document: media(window.__documentMedia), shadow: media(window.__shadowMedia) };
    });
    assert.deepEqual(removed, { document: '(max-width: 900px)', shadow: '(max-width: 900px)' }, 'detached sheets regain their authored queries');

    const readopted = await page.evaluate(() => {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, window.__documentMedia];
      window.__mediaRoot.adoptedStyleSheets = [window.__shadowMedia];
      const media = (sheet) => sheet.cssRules[0].media.mediaText;
      return { document: media(window.__documentMedia), shadow: media(window.__shadowMedia) };
    });
    assert.deepEqual(readopted, { document: '(max-width: 1168px)', shadow: '(max-width: 1168px)' }, 're-adopted sheets are visited exactly once');

    const replaced = await page.evaluate(() => {
      const old = [];
      for (let i = 0; i < 40; i++) {
        old.push(window.__documentMedia.cssRules[0]);
        window.__documentMedia.replaceSync(`@media (max-width: 900px) { body { color: rgb(${i}, 0, 0) } }`);
      }
      return {
        current: window.__documentMedia.cssRules[0].media.mediaText,
        old: old.every((rule) => rule.parentStyleSheet === null && rule.media.mediaText === '(max-width: 900px)'),
      };
    });
    assert.deepEqual(replaced, { current: '(max-width: 1168px)', old: true }, 'replaceSync restores detached retained media rules instead of leaking shifted holders');

    await page.evaluate(() => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== window.__documentMedia);
      window.__mediaRoot.adoptedStyleSheets = [...window.__mediaRoot.adoptedStyleSheets, window.__documentMedia];
    });
    await setKeepOpen(false);
    await waitFor(() => page.evaluate(() => {
      const media = (sheet) => sheet.cssRules[0].media.mediaText;
      const imported = window.__importStyle.sheet.cssRules[0].styleSheet.cssRules[0].media.mediaText;
      return media(window.__documentMedia) === '(max-width: 916px)' && media(window.__shadowMedia) === '(max-width: 916px)' && imported === '(max-width: 916px)';
    }));
    await page.evaluate(() => document.body.append(document.createElement('i')));
    await page.waitForTimeout(100);
    await setKeepOpen(true);
    await waitFor(() => page.evaluate(() => {
      const media = (sheet) => sheet.cssRules[0].media.mediaText;
      const imported = window.__importStyle.sheet.cssRules[0].styleSheet.cssRules[0].media.mediaText;
      return media(window.__documentMedia) === '(max-width: 1168px)' && media(window.__shadowMedia) === '(max-width: 1168px)' && imported === '(max-width: 1168px)';
    }));
  } finally {
    await setKeepOpen(false);
    await page.close();
  }
});

test('Keep open: sidebar and box are in place while the page is still loading', async () => {
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
      left: `${new DOMMatrix(getComputedStyle(document.documentElement).transform).e}px`,
      attr: document.documentElement.dataset.marginDocked ?? null,
    }));

  await setKeepOpen(true);
  await waitFor(async () => (await registered())?.endsWith('themes/arcadia/docked/w-260.css'));
  const page = await openPage('placeholder');
  // The placeholder placed the first paint; the page's own box now holds the
  // same width and the placeholder is switched off on this page.
  await waitFor(async () => (await placeholder(page)).attr === 'off');
  assert.deepEqual(await placeholder(page), { content: 'none', left: '260px', attr: 'off' });

  const tabId = (await tabsInBrowser(ctx.worker)).find((t) => t.title === 'placeholder').id;
  await ctx.worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'command', command: 'toggle-sidebar' }), tabId);
  await waitFor(async () => (await registered())?.endsWith('closed.css'));
  await waitFor(async () => (await placeholder(page)).left === '8px');

  await setKeepOpen(true);
  await waitFor(async () => (await placeholder(page)).left === '260px');
  await waitFor(async () => (await registered())?.endsWith('w-260.css'));
  await setKeepOpen(false);
  await waitFor(async () => (await registered())?.endsWith('closed.css'));
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
