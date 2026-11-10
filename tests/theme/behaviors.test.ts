// The runtime's behaviors (extension/ui/behaviors/) with Neo-brutalism and
// Pixel (the built-in themes that share the sidebar's classes) in real engines, Playwright's WebKit and Chromium, headless, on a blank page
// whose every network request is refused; real pointer, wheel and keyboard
// input through Playwright. The host is the mock (ui/host.ts): each test
// checks the messages it received. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, NEO, PIXEL } from './package.ts';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const script = harnessScript();
// Each theme's sidebar: its root, the page's left inset docked, and its
// width setting's default, bounds and a 50 px drag (snapped to its step).
const THEMES = [
  ['neo-brutalism', NEO, { root: '.nb', docked: 291, def: 256, min: 200, max: 400, dragged: 306 }],
  ['pixel', PIXEL, { root: '.pixel', docked: 286, def: 252, min: 200, max: 360, dragged: 304 }],
];
const SCROLL = /^(sidebarScroll|setSidebarScroll)$/;

for (const [name, engine] of ENGINES) for (const [themeId, dir, th] of THEMES) {
  const gap = th.docked - th.def; // the page's left inset less the sidebar's width
  test(`behaviors in ${themeId}, ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const seen = { requests: [], errors: [] };
    page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
    page.on('pageerror', (e) => seen.errors.push(e.message));
    await context.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: script });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    assert.equal((await ev(([p, i]) => T.loadBuiltin(p, i), [themeForPage(dir), themeId])).ok, true);

    const mount = (options = {}) => ev((o) => T.mountRuntime(o), options);
    const sent = async ({ scroll = false } = {}) => (await ev(() => T.rtSent())).filter(([type]) => scroll || !SCROLL.test(type));
    const lastSent = async (type) => (await sent({ scroll: true })).filter(([t2]) => t2 === type).at(-1) ?? null;
    const vm = () => ev(() => T.rtVmFull());
    const ui = () => ev(() => T.rtUi());
    const rect = (selector, nth = 0) => ev(({ s, n }) => T.rtRect(s, n), { s: selector, n: nth });
    // Into view in its list first (rtBox), then its box.
    const shown = async (selector, nth = 0) => { await ev(({ s, n }) => T.rtBox(s, n), { s: selector, n: nth }); return rect(selector, nth); };
    const click = async (selector, nth = 0) => { const b = await shown(selector, nth); assert.ok(b, selector); await page.mouse.click(b.x, b.y); };
    const today = () => ev(() => T.rtTodayIds(8));
    const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 3000 });

    try {
      await t.test('a press highlights its row at once and switches; the click after it sends nothing more', async () => {
        await mount({ replies: { activateTab: { shown: 0 } } });
        const ids = await today();
        const box = await shown('.today .tab', 1);
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        // Still pressed: the switch is sent and the row is lit.
        assert.deepEqual(await lastSent('activateTab'), ['activateTab', { tabId: ids[1] }]);
        assert.equal((await ui()).switchingTo, ids[1]);
        assert.ok((await ev(() => T.rtClasses('.today .tab', 1))).includes('on'), 'highlighted before the button comes up');
        assert.ok((await ev(() => T.rtClasses('.today .tab', 1))).includes('m-pressed'));
        await page.mouse.up();
        assert.equal((await sent()).filter(([type]) => type === 'activateTab').length, 1, 'the click is the same switch');
        assert.equal((await ev(() => T.rtClasses('.today .tab', 1))).includes('m-pressed'), false);
      });

      await t.test('palette: focused as it opens, typing re-ranks, arrows move, Enter runs, Escape closes, opened again empty', async () => {
        await mount();
        await click('.address');
        assert.equal((await ui()).palette.open, true);
        assert.equal((await ev(() => T.rtFocus())).input, 'palette', 'the field has the focus');
        const before = (await vm()).rows;
        await page.keyboard.type('nimbus');
        const typed = await vm();
        assert.equal(typed.query, 'nimbus');
        assert.notDeepEqual(typed.rows, before, 're-ranked');
        assert.ok(typed.rows.length >= 2 && typed.rows.slice(0, 2).every((r) => /nimbus/i.test(r)), typed.rows.slice(0, 3).join(' | '));
        const first = typed.selected;
        await page.keyboard.press('ArrowDown');
        const second = (await vm()).selected;
        assert.notEqual(second, first);
        await page.keyboard.press('ArrowUp');
        assert.equal((await vm()).selected, first);
        await page.keyboard.press('ArrowUp');
        assert.equal((await vm()).selected, typed.rowIds.at(-1), 'wraps to the last');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.equal((await vm()).selected, second);
        await page.keyboard.press('Enter');
        const [type, payload] = (await sent()).at(-1);
        if (second.startsWith('tab:')) assert.deepEqual([type, payload], ['activateTab', { tabId: Number(second.slice(4)) }]);
        else if (second.startsWith('pin:')) assert.deepEqual([type, payload], ['openPin', { pinId: second.slice(4), windowId: 1 }]);
        else assert.fail(`row ${second}`);
        assert.equal((await ui()).palette.open, false, 'closed by the choice');
        // Opened again: an empty field (a theme's m-if keeps its block), focused.
        await click('.address');
        const focus = await ev(() => T.rtFocus());
        assert.deepEqual([focus.input, focus.value], ['palette', '']);
        assert.equal((await vm()).query, '');
        await page.keyboard.type('xyz');
        const count = (await sent()).length;
        await page.keyboard.press('Escape');
        assert.equal((await ui()).palette.open, false);
        assert.equal((await sent()).length, count, 'Escape sends nothing');
        // The new-tab palette (+ New Tab) works the same way.
        await click('.new-tab');
        assert.equal((await ui()).palette.newTab, true);
        assert.equal((await ev(() => T.rtFocus())).value, '');
        await page.keyboard.type('margins.example');
        await page.keyboard.press('Enter');
        assert.equal((await ui()).palette.open, false);
        assert.ok(['activateTab', 'openPin', 'newTab'].includes((await sent()).at(-1)[0]));
      });

      await t.test('peek: the edge brings a hidden sidebar out, the page hides it again after the delay', async () => {
        await mount({ settings: { sidebarPinnedOpen: false } });
        assert.equal((await vm()).sidebar, 'hidden');
        assert.match(await ev(() => T.rtStyle('.peek-zone', '--m-reveal-zone')), /^(10|24)px$/, 'today\'s reveal zone');
        await page.mouse.move(700, 450);
        await page.mouse.move(3, 450, { steps: 4 });
        await wait(() => T.rtVmFull().sidebar === 'peek');
        // Over the sidebar, out over the page: it stays.
        await page.mouse.move(120, 450, { steps: 4 });
        await page.waitForTimeout(450);
        assert.equal((await vm()).sidebar, 'peek', 'still out while the pointer is over it');
        const left = Date.now();
        await page.mouse.move(900, 450, { steps: 4 });
        assert.equal((await vm()).sidebar, 'peek', 'not at once');
        await wait(() => T.rtVmFull().sidebar === 'hidden');
        assert.ok(Date.now() - left >= 250, `hidden after the delay (${Date.now() - left} ms)`);
        // Back over it before the delay: it stays out.
        await page.mouse.move(3, 450, { steps: 2 });
        await wait(() => T.rtVmFull().sidebar === 'peek');
        await page.mouse.move(900, 450, { steps: 2 });
        await page.mouse.move(120, 450, { steps: 2 });
        await page.waitForTimeout(450);
        assert.equal((await vm()).sidebar, 'peek');
        await page.mouse.move(900, 450, { steps: 2 });
        await wait(() => T.rtVmFull().sidebar === 'hidden');
        assert.deepEqual(await sent(), [], 'peek sends nothing');
      });

      await t.test('peek from positions only (Margin.app: its web view may not hear the pointer move): out at the edge, kept over the sidebar, hidden over the page', async () => {
        await mount({ settings: { sidebarPinnedOpen: false }, container: 'document' });
        assert.equal((await vm()).sidebar, 'hidden');
        await ev(() => T.rtPointer(700, 450));
        await ev(() => T.rtPointer(3, 450));
        await wait(() => T.rtVmFull().sidebar === 'peek');
        // Over the sidebar: kept out, with nothing but positions.
        for (let i = 0; i < 6; i++) { await ev(() => T.rtPointer(120, 450)); await page.waitForTimeout(80); }
        assert.equal((await vm()).sidebar, 'peek', 'still out while the pointer is over it');
        await ev(() => T.rtPointer(900, 450));
        await wait(() => T.rtVmFull().sidebar === 'hidden');
        // Back at the edge, then over the sidebar before the delay: it stays out.
        await ev(() => T.rtPointer(3, 450));
        await wait(() => T.rtVmFull().sidebar === 'peek');
        await ev(() => T.rtPointer(900, 450));
        await ev(() => T.rtPointer(120, 450));
        await page.waitForTimeout(450);
        assert.equal((await vm()).sidebar, 'peek');
        assert.deepEqual(await sent(), [], 'peek sends nothing');
      });

      await t.test('resize: the handle drags the width within the theme\'s bounds, live layouts, saved as the theme\'s setting', async () => {
        await mount();
        await wait(() => T.rtLayoutsAll().length > 0);
        assert.equal((await ev(() => T.rtLayoutsAll())).at(-1), th.docked);
        const handle = await rect('.resizer');
        await page.mouse.move(handle.x, handle.y);
        await page.mouse.down();
        await page.mouse.move(handle.x + 20, handle.y, { steps: 2 });
        await page.waitForTimeout(50);
        assert.ok((await ev((r) => T.rtClasses(r), th.root)).includes('m-resizing'));
        await page.mouse.move(handle.x + 50, handle.y, { steps: 3 });
        await wait((x) => T.rtLayoutsAll().at(-1) === x, th.docked + 50);
        const live = await ev(() => T.rtLayoutsAll());
        assert.ok(live.filter((l) => l > th.docked && l < th.docked + 50).length >= 1, `layouts while dragging: ${live.join(', ')}`);
        assert.equal(await lastSent('updateThemeSettings'), null, 'nothing saved while dragging');
        await page.mouse.up();
        assert.deepEqual(await lastSent('updateThemeSettings'), ['updateThemeSettings', { themeId, patch: { sidebarWidth: `${th.dragged}px` } }]);
        assert.equal((await vm()).settings.sidebarWidth, `${th.dragged}px`, 'shown before the state says so');
        // Past the theme's maximum (layout.sidebarMax) and minimum.
        const h2 = await rect('.resizer');
        await page.mouse.move(h2.x, h2.y);
        await page.mouse.down();
        await page.mouse.move(h2.x + 600, h2.y, { steps: 4 });
        await page.mouse.up();
        assert.deepEqual((await lastSent('updateThemeSettings'))[1].patch, { sidebarWidth: `${th.max}px` });
        await wait((x) => T.rtLayoutsAll().at(-1) === x, th.max + gap);
        const h3 = await rect('.resizer');
        await page.mouse.move(h3.x, h3.y);
        await page.mouse.down();
        await page.mouse.move(h3.x - 600, h3.y, { steps: 4 });
        await page.mouse.up();
        assert.deepEqual((await lastSent('updateThemeSettings'))[1].patch, { sidebarWidth: `${th.min}px` });
        // Double-click: the default.
        const h4 = await rect('.resizer');
        await page.mouse.dblclick(h4.x, h4.y);
        assert.deepEqual((await lastSent('updateThemeSettings'))[1].patch, { sidebarWidth: `${th.def}px` });
        await wait((x) => T.rtLayoutsAll().at(-1) === x, th.docked);
      });

      await t.test('menus: a right-click opens the theme\'s menu part; items run checked actions, two-value ones too', async () => {
        await mount();
        const ids = await today();
        const row = await shown('.today .tab', 0);
        await page.mouse.click(row.x, row.y, { button: 'right' });
        const labels = (await vm()).menu;
        assert.deepEqual(labels.slice(0, 4), ['Pin Tab', 'Pin to 📁 Reading', 'Pin to 📁 Lisbon', 'New Folder with Tab']);
        assert.ok(labels.includes('Move to 💼 Work') && labels.includes('Close Tab'));
        assert.equal(await ev(() => T.rtCount('m-menu .menu-item')), labels.filter((l) => l).length, 'drawn from the theme\'s part');
        const menuBox = await rect('m-menu');
        assert.ok(Math.abs(menuBox.left - row.x) <= 1, 'at the pointer');
        assert.ok(menuBox.top <= row.y + 1 && menuBox.bottom <= 900 - 4 + 1, 'kept inside the window');
        const item = await ev(() => T.rtBoxText('.menu-item', 'Move to 💼 Work'));
        await page.mouse.click(item.x, item.y);
        assert.deepEqual((await sent()).at(-1), ['moveTabToSpace', { tabId: ids[0], spaceId: 'work' }]);
        assert.equal((await ui()).menu, null, 'closed');
        assert.equal(await ev(() => T.rtCount('m-menu .menu-item')), 0);
        // The keys: ↓ to the first item, Enter runs it.
        await page.mouse.click(row.x, row.y, { button: 'right' });
        await page.keyboard.press('ArrowDown');
        assert.equal((await ev(() => T.rtFocus())).text, 'Pin Tab');
        await page.keyboard.press('Enter');
        assert.deepEqual((await sent()).at(-1), ['pinTab', { tabId: ids[0] }]);
        // A press elsewhere closes it, Escape too.
        await page.mouse.click(row.x, row.y, { button: 'right' });
        await page.keyboard.press('Escape');
        assert.equal((await ui()).menu, null);
        // A space's menu: deleting asks first.
        const count = (await sent()).length;
        const chip = await rect('.chip', 1);
        await page.mouse.click(chip.x, chip.y, { button: 'right' });
        assert.deepEqual((await vm()).menu, ['Edit Space…', 'Rename Space', '', 'New Space', '', 'Delete Space']);
        let del = await ev(() => T.rtBoxText('.menu-item', 'Delete Space'));
        await page.mouse.click(del.x, del.y);
        assert.equal((await vm()).menu.at(-1), 'Really delete?');
        assert.equal((await sent()).length, count, 'nothing yet');
        del = await ev(() => T.rtBoxText('.menu-item', 'Really delete?'));
        await page.mouse.click(del.x, del.y);
        assert.deepEqual((await sent()).at(-1), ['deleteSpace', { spaceId: 'work' }]);
        // The "+" button's menu, above it.
        await click('[aria-label="New folder or space"]');
        assert.deepEqual((await vm()).menu, ['New Folder', 'New Space']);
        const plus = await rect('[aria-label="New folder or space"]');
        assert.ok((await rect('m-menu')).bottom <= plus.top, 'above the button');
        const nf = await ev(() => T.rtBoxText('.menu-item', 'New Folder'));
        await page.mouse.click(nf.x, nf.y);
        assert.deepEqual((await sent()).at(-1), ['createFolder', { windowId: 1 }]);
      });

      await t.test('rename: a double-click edits a folder\'s name in place; Enter saves, Escape cancels, leaving saves', async () => {
        await mount();
        await ev(() => T.rtSentClear());
        const name = await shown('.folder-name', 0);
        await page.mouse.dblclick(name.x, name.y);
        // Its first click toggled the folder: undone.
        assert.deepEqual((await sent()).map(([type, p]) => [type, p.open]), [['setFolderOpen', false], ['setFolderOpen', true]]);
        assert.deepEqual((await vm()).editing, { kind: 'folder', id: 'personal-f0' });
        const focus = await ev(() => T.rtFocus());
        assert.deepEqual([focus.editable, focus.text], [true, 'Reading']);
        await page.keyboard.type('Later reads');
        await page.keyboard.press('Enter');
        assert.deepEqual((await sent()).at(-1), ['renameFolder', { folderId: 'personal-f0', name: 'Later reads' }]);
        assert.equal((await vm()).editing, null);
        assert.equal((await ev(() => T.rtText('.folder-name')))[0], 'Later reads', 'shown at once');
        assert.equal((await vm()).folders[0][1], 'Later reads');
        // Escape: back as it was, nothing sent.
        await ev(() => T.rtSentClear());
        const second = await shown('.folder-name', 1);
        await page.mouse.dblclick(second.x, second.y);
        await page.keyboard.type('Nope');
        await page.keyboard.press('Escape');
        assert.deepEqual((await sent()).filter(([type]) => type === 'renameFolder'), []);
        assert.equal((await ev(() => T.rtText('.folder-name')))[1], 'Lisbon');
        // Leaving the field saves.
        await page.mouse.dblclick(second.x, second.y);
        await page.keyboard.type('Porto');
        await page.mouse.click(900, 450);
        assert.deepEqual((await sent()).filter(([type]) => type === 'renameFolder'), [['renameFolder', { folderId: 'personal-f1', name: 'Porto' }]]);
        // The space's name too (m-rename="space").
        const space = await rect('.space-name');
        await page.mouse.dblclick(space.x, space.y);
        await page.keyboard.type('Home');
        await page.keyboard.press('Enter');
        assert.deepEqual((await sent()).at(-1), ['renameSpace', { spaceId: 'personal', name: 'Home' }]);
        assert.equal((await vm()).spaceName, 'Home');
        // The menu's Rename Folder starts it too.
        const head = await shown('.folder-head', 0);
        await page.mouse.click(head.x, head.y, { button: 'right' });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.deepEqual((await vm()).editing, { kind: 'folder', id: 'personal-f0' });
        await page.keyboard.press('Escape');
      });

      await t.test('drag and drop: a tab to another place, onto a space\'s chip, into a folder', async () => {
        await mount({ replies: { moveTab: true } });
        await ev(() => T.rtApply('toggleFolder', 'personal-f0')); // Reading closed: fewer rows
        await ev(() => T.rtSentClear());
        const ids = await today();
        await shown('.today .tab', 4); // the first rows in view, above the spaces bar
        const from = await rect('.today .tab', 0);
        const to = await rect('.today .tab', 2);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x, from.y + 2);
        assert.deepEqual(await ev(() => T.rtMarked()), [], 'under the threshold: no drag');
        await page.mouse.move(to.x, to.top + to.height * 0.8, { steps: 6 });
        const marks = Object.fromEntries(await ev(() => T.rtMarked()));
        assert.equal(marks['m-drag-ghost'], 1, 'a copy follows the pointer');
        assert.equal(marks['m-dragging'], 2, 'the row and the theme\'s root');
        assert.ok((await ev(() => T.rtClasses('.today .tab:not(.m-drag-ghost)', 2))).includes('m-drop-after'));
        await page.mouse.up();
        const moved = (await sent()).find(([type]) => type === 'moveTab');
        assert.deepEqual(moved[1], { tabId: ids[0], nextTo: ids[2], side: 'after', nextToHint: moved[1].nextToHint });
        assert.equal(typeof moved[1].nextToHint.url, 'string');
        assert.deepEqual(await ev(() => T.rtMarked()).then((m) => m.filter(([c]) => c !== 'm-drag-ghost')), [], 'marks cleared');

        // Onto another space's chip.
        await shown('.today .tab', 4);
        const row = await rect('.today .tab', 1);
        const chip = await rect('.chip', 1);
        await page.mouse.move(row.x, row.y);
        await page.mouse.down();
        await page.mouse.move(chip.x, chip.y, { steps: 8 });
        const over = await ev(({ x, y }) => T.rtAt(x, y), chip);
        assert.ok((await ev(() => T.rtClasses('.chip', 1))).includes('m-drop-into'), `the chip's drop mark (chip ${JSON.stringify(chip)}, under the pointer ${JSON.stringify(over)}, its classes ${JSON.stringify(await ev(() => T.rtClasses('.chip', 1)))})`);
        await page.mouse.up();
        assert.deepEqual((await sent()).at(-1), ['moveTabToSpace', { tabId: ids[1], spaceId: 'work' }]);

        // Into a folder (its row, below its top quarter): pinned there.
        await shown('.folder-head', 1);
        const folder = await rect('.folder-head', 1);
        const start = await rect('.today .tab', 3);
        assert.ok(start.bottom < 830, 'the row in view');
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(folder.x, folder.top + folder.height * 0.7, { steps: 8 });
        assert.ok((await ev(() => T.rtClasses('.folder-head', 1))).includes('m-drop-into'));
        await page.mouse.up();
        assert.deepEqual((await sent()).at(-1), ['pinTab', { tabId: ids[3], folderId: 'personal-f1', beforeId: null }]);

        // Escape: back, nothing sent.
        await shown('.today .tab', 4);
        const r4 = await rect('.today .tab', 4);
        await page.mouse.move(r4.x, r4.y);
        await page.mouse.down();
        await page.mouse.move(r4.x, r4.y + 60, { steps: 4 });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.equal((await sent()).filter(([type]) => /^(moveTab|pinTab|movePin|moveFolder|moveTabToSpace|unpin)$/.test(type)).length, 3, 'only the three drops');
      });

      await t.test('scroll memory: the list opens at the window\'s position; a scroll of the user\'s is saved for the window', async () => {
        await mount({ replies: { sidebarScroll: 300 } });
        await wait(() => T.rtScrollTop('.tabs') === 300);
        assert.deepEqual((await sent({ scroll: true })).find(([type]) => type === 'sidebarScroll'), ['sidebarScroll', { windowId: 1 }]);
        assert.equal(await lastSent('setSidebarScroll'), null, 'Margin\'s own scroll isn\'t saved back');
        const list = await rect('.tabs');
        await page.mouse.move(list.x, list.y);
        await page.mouse.wheel(0, 240);
        await wait(() => T.rtSent().some(([type, p]) => type === 'setSidebarScroll' && p.top > 300));
        const saved = await lastSent('setSidebarScroll');
        assert.equal(saved[1].windowId, 1);
        assert.equal(saved[1].top, await ev(() => T.rtScrollTop('.tabs')), `the saved scroll is the list's (saved ${JSON.stringify(saved)}, all ${JSON.stringify((await sent({ scroll: true })).filter(([t]) => t === 'setSidebarScroll'))})`);
        // A space switched to: from its top, saved as the window's.
        const chip2 = await shown('.chip', 2);
        const over = await ev(({ x, y }) => T.rtAt(x, y), chip2);
        await click('.chip', 2);
        assert.deepEqual(await lastSent('setSidebarScroll'), ['setSidebarScroll', { top: 0, windowId: 1 }], `the chip clicked (chip ${JSON.stringify(chip2)}, under the pointer ${JSON.stringify(over)}, sent ${JSON.stringify((await sent()).slice(-4))})`);
      });

      // Playwright's wheel is a mouse's (notches of 120), which never swipes:
      // a trackpad's events, dispatched (pixel deltas, no notches).
      await t.test('space swipe: two fingers sideways over the sidebar switch to the next space', async () => {
        await mount();
        await ev(() => T.rtTrackpad('.space-name', 30, 12));
        await wait(() => T.rtSent().some(([type]) => type === 'setSpace'));
        assert.deepEqual((await sent()).find(([type]) => type === 'setSpace'), ['setSpace', { windowId: 1, spaceId: 'work' }]);
        // Asked of the copy as the swipe settles (Safari brings the space's tab while the slide comes in), the space
        // left still drawn till the slide is in, then the space switched to (Tirth, 2026-11-07: the switch felt late).
        assert.equal((await vm()).space, 'personal', 'the slide still coming in');
        await wait(() => T.rtVmFull().spaceName === 'Work');
        assert.equal((await vm()).space, 'work', 'shown as the slide lands');
      });

      await ev(() => T.unmountRuntime());
      assert.deepEqual(seen.requests, [], 'no network request');
      assert.deepEqual(seen.errors, []);
    } finally {
      await browser.close();
    }
  });
}

// A theme's folder row whose toggle has no argument (m-action="folder.toggle", no m-arg): a double-click on it
// (beside its name), before any folder was toggled, starts no rename and throws nothing (behaviors/rename.ts undoToggle once
// read the last toggle's time though there was none).
for (const [name, engine] of ENGINES) {
  test(`rename: a folder toggle with no argument, double-clicked, throws nothing, ${name}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      await page.addScriptTag({ content: script });
      const pkg = themeForPage(NEO);
      const html = pkg.html.replace('m-action="folder.toggle" m-arg="{{g.id}}"', 'm-action="folder.toggle"');
      assert.notEqual(html, pkg.html, 'the toggle without its argument');
      assert.equal((await page.evaluate(([p, i]) => T.loadBuiltin(p, i), [{ ...pkg, html }, 'neo-brutalism'])).ok, true);
      await page.evaluate(() => T.mountRuntime());
      // On its chevron, beside the name: the toggle's own double-click (a press on the name is the name's).
      await page.evaluate(() => T.rtBox('.folder-head .chev', 0));
      const box = await page.evaluate(() => T.rtRect('.folder-head .chev', 0));
      assert.ok(box, 'a folder drawn');
      await page.mouse.dblclick(box.x, box.y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
      assert.deepEqual(errors, []);
      assert.equal((await page.evaluate(() => T.rtVmFull())).editing, null, 'no rename without a folder');
    } finally {
      await browser.close();
    }
  });
}
