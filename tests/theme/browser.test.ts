// The theme renderer and sanitizer in real engines: Playwright's WebKit
// (Safari's engine) and Chromium, headless, on a blank page with every
// network request intercepted and refused. `npm run test:theme`.
//
// - Neubrutalism loads from its sanitized package and renders 200 tabs;
// - updates are keyed and minimal (a MutationObserver counts every change);
// - real clicks dispatch checked actions;
// - <m-page> reports its insets and radius;
// - every XSS, CSS-leak and action-abuse payload (tests/theme/payloads.ts)
//   is rendered live: the tripwire stays unset and no request is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage } from './package.ts';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const MANIFEST = JSON.stringify({ format: 2, id: 'payload', name: 'Payload', version: '1.0.0' });
const script = harnessScript();
const pkg = themeForPage();

async function open(browser, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const seen = { requests: [], dialogs: [], errors: [] };
  page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
  page.on('dialog', (d) => { seen.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.addScriptTag({ content: script });
  return { context, page, seen };
}

for (const [name, engine] of ENGINES) {
  test(`theme runtime in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const { page, seen, context } = await open(browser);

      await t.test('Neubrutalism loads from its sanitized package: nothing removed, fonts from bundled bytes', async () => {
        const r = await page.evaluate((p) => T.loadNeo(p), pkg);
        assert.equal(r.ok, true);
        assert.deepEqual(r.removed, []);
        assert.deepEqual(r.fonts, [true, true], 'Archivo Black and Space Grotesk are ready');
      });

      await t.test('renders the sidebar with 200 tabs, three spaces and the page slot', async () => {
        await page.evaluate(() => T.mountNeo({}));
        assert.equal(await page.evaluate(() => T.count('.tab')), 200);
        assert.equal(await page.evaluate(() => T.count('.chip')), 3);
        assert.deepEqual(await page.evaluate(() => T.text('.space-name')), ['Personal']);
        assert.deepEqual(await page.evaluate(() => T.text('.pill')), ['200 TABS']);
        assert.equal(await page.evaluate(() => T.count('m-page')), 1);
        assert.equal(await page.evaluate(() => T.count('[m-action], [m-arg], m-for, m-if, m-else')), 0, 'no template syntax left in the DOM');
      });

      await t.test('updates are keyed and minimal', async () => {
        const id = await page.evaluate(() => T.firstTodayId());
        assert.deepEqual(await page.evaluate((i) => T.mutate('retitle', i, 'A new title'), id), { text: 1, attributes: ['title'], added: 0, removed: 0, moved: 0 }, 'one title: its text and its title attribute');
        assert.deepEqual(await page.evaluate(() => T.mutate('addTabs', 10)), { text: 1, attributes: [], added: 10, removed: 0, moved: 0 }, '10 rows and the tab count');
        assert.deepEqual(await page.evaluate(() => T.mutate('removeTabs', 10)), { text: 1, attributes: [], added: 0, removed: 10, moved: 0 });
        assert.deepEqual(await page.evaluate(() => T.mutate('moveTab', 0, 120)), { text: 0, attributes: [], added: 0, removed: 0, moved: 1 }, 'a reorder moves one node');
        const ids = await page.evaluate(() => T.vmIds());
        // The window's active tab changes: old and new rows, and the address (its host, its label).
        assert.deepEqual(await page.evaluate((i) => T.mutate('activate', i), ids.today[1]), { text: 1, attributes: ['aria-label', 'class', 'class'], added: 0, removed: 0, moved: 0 }, 'old and new active rows, and the address');
        assert.deepEqual(await page.evaluate((f) => T.mutate('toggleFolder', f), ids.folder), { text: 0, attributes: ['class', 'aria-expanded'], added: 0, removed: 1, moved: 0 }, 'folder closes: one subtree out');
        assert.deepEqual(await page.evaluate((f) => T.mutate('toggleFolder', f), ids.folder), { text: 0, attributes: ['class', 'aria-expanded'], added: 1, removed: 0, moved: 0 }, 'and back');
        assert.equal(await page.evaluate(() => T.tag('.today .tab', 'first-row')), true);
        const away = await page.evaluate(() => T.mutate('switchSpace', 'work'));
        assert.ok(away.removed >= 170, 'Personal\'s rows leave');
        assert.deepEqual(await page.evaluate(() => T.text('.space-name')), ['Work']);
        await page.evaluate(() => T.mutate('switchSpace', 'personal'));
        assert.equal(await page.evaluate(() => T.tagged('.today .tab')), 'first-row', 'switching back reuses the same row nodes');
        assert.equal(await page.evaluate(() => T.count('.tab')), 200);
        const cleared = await page.evaluate(() => T.mutate('clearToday'));
        assert.equal(await page.evaluate(() => T.count('.clear')), 0, 'm-if hides Clear once today is empty');
        assert.ok(cleared.removed >= 171);
        assert.deepEqual(await page.evaluate(() => T.mutate('openPalette', 'q')), { text: 0, attributes: [], added: 1, removed: 0, moved: 0 }, 'the palette: one subtree');
      });

      await t.test('real clicks run checked actions; synthetic clicks do nothing', async () => {
        await page.evaluate(() => { T.unmountAll(); T.mountNeo({}); });
        const ids = await page.evaluate(() => T.vmIds());
        await page.click('.today .tab >> nth=2');
        await page.click('.chip >> nth=1');
        await page.click('.folder-head >> nth=0');
        await page.click('.new-tab');
        await page.evaluate(() => document.querySelector('.margin-host').shadowRoot.querySelector('.today .tab').click());
        const { ran } = await page.evaluate(() => T.actions());
        assert.deepEqual(ran, [['tab.activate', ids.today[2]], ['space.switch', 'work'], ['folder.toggle', ids.folder], ['tab.new', undefined]]);
      });

      await t.test('the runtime: Neubrutalism as a built-in theme, a mock host, real clicks', async () => {
        await page.evaluate(() => T.unmountAll());
        const b = await page.evaluate((p) => T.loadBuiltin(p), pkg);
        assert.equal(b.ok, true);
        assert.equal(b.id, 'neubrutalism');
        assert.deepEqual(b.read.slice(0, 3).sort(), ['theme.css', 'theme.html', 'theme.json'], 'theme.json, the template and the stylesheet');
        assert.equal(b.read.filter((f) => f.endsWith('.woff2')).length, 4, 'and the fonts it lists, nothing else');
        assert.deepEqual(b.fontErrors, []);
        assert.deepEqual(b.fonts, [true, true]);

        await page.evaluate(() => T.mountRuntime({ closed: true }));
        assert.equal(await page.evaluate(() => T.rtCount('.tab')), 200);
        assert.deepEqual(await page.evaluate(() => T.rtText('.space-name')), ['Personal']);
        assert.equal(await page.evaluate(() => T.rtCount('[m-action], m-for, m-if')), 0);
        // The first layout, once a frame has gone by.
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        assert.deepEqual((await page.evaluate(() => T.rtLayouts())).at(-1), { left: 291, top: 19, right: 19, bottom: 19, radius: 15, width: 1440, height: 900, windowId: 1, mode: 'fullscreen' });

        // A state change from the host: one title, one text node and its title attribute.
        const id = (await page.evaluate(() => T.rtTodayIds()))[0];
        assert.deepEqual(await page.evaluate((i) => T.rtChange('retitle', i, 'Changed by the host'), id), { records: 2, text: 1 });
        assert.ok((await page.evaluate(() => T.rtText('.today .title'))).includes('Changed by the host'));

        // Real clicks, by position (the shadow root is closed).
        const click = async (selector, nth = 0) => {
          const box = await page.evaluate(({ s, n }) => T.rtBox(s, n), { s: selector, n: nth });
          assert.ok(box, selector);
          await page.mouse.click(box.x, box.y);
        };
        const today = await page.evaluate(() => T.rtTodayIds());
        const sentNow = async () => (await page.evaluate(() => T.rtSent())).filter(([type]) => !/^(sidebarScroll|setSidebarScroll)$/.test(type));
        await click('.today .tab', 2);
        await click('.chip', 1);
        await click('.folder-head', 0);
        await click('[aria-label="Back"]');
        await click('.clear');
        await click('[aria-label="Archive and library"]');
        assert.deepEqual(await sentNow(), [
          ['activateTab', { tabId: today[2] }],
          ['setSpace', { windowId: 1, spaceId: 'work' }],
          ['setFolderOpen', { folderId: 'personal-f0', open: false }],
          ['clearToday', { windowId: 1 }],
          ['openLauncher', { windowId: 1 }],
        ]);
        assert.deepEqual(await page.evaluate(() => T.rtPerformed()), ['nav.back'], 'the page\'s history is the host\'s');
        assert.deepEqual(await page.evaluate(() => T.rtRefused()), [], 'nothing refused');

        // The palette: "New tab" opens it (local), a row runs its own request and closes it.
        await click('.new-tab');
        assert.deepEqual(await page.evaluate(() => T.rtUi().palette), { open: true, query: '', selected: 0, newTab: true });
        assert.ok(await page.evaluate(() => T.rtCount('.palette-row')) > 3);
        await click('.palette-row', 1);
        assert.equal((await page.evaluate(() => T.rtUi().palette)).open, false);
        assert.equal(await page.evaluate(() => T.rtCount('.palette-row')), 0);
        const sent = await sentNow();
        assert.equal(sent.length, 6);
        assert.equal(sent[5][0], 'activateTab', 'the second row of an empty query is a tab');

        // Keep open off, from the theme's toggle: drawn at once, before the state says so.
        await click('[aria-label="Toggle sidebar"]');
        assert.deepEqual((await sentNow()).at(-1), ['updateSettings', { patch: { sidebarPinnedOpen: false } }]);
        assert.equal((await page.evaluate(() => T.rtVm())).sidebar, 'hidden', 'at once');

        // Abuse through dispatch: refused, nothing sent.
        assert.equal(await page.evaluate(() => T.rtDispatch('tab.close', 999999)), false);
        assert.equal(await page.evaluate(() => T.rtDispatch('palette.run', 'tab:1000')), false, 'the palette is closed');
        assert.equal(await page.evaluate(() => T.rtDispatch('space.switch', '__proto__')), false);
        assert.equal(await page.evaluate((t) => T.rtDispatch('tab.moveToSpace', { tab: t, space: 'work' }), today[0]), false, 'only behaviors and menus');
        assert.equal((await sentNow()).length, 7);

        // The sidebar setting goes off in the state: the page's place follows, and is reported.
        await page.evaluate(() => T.rtSettings({ sidebarPinnedOpen: false }));
        await page.waitForFunction(() => T.rtLayouts().at(-1).left === 19);
        assert.deepEqual((await page.evaluate(() => T.rtLayouts())).at(-1), { left: 19, top: 19, right: 19, bottom: 19, radius: 15, width: 1440, height: 900, windowId: 1, mode: 'fullscreen' });
        assert.equal((await page.evaluate(() => T.rtVm())).sidebar, 'hidden');
        // And the window resized, in the document itself.
        await page.evaluate(() => T.mountRuntime({ container: 'document', width: 1280, height: 800 }));
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForFunction(() => T.rtLayouts().some((l) => l.width === 1280));
        assert.deepEqual((await page.evaluate(() => T.rtLayouts())).at(-1), { left: 291, top: 19, right: 19, bottom: 19, radius: 15, width: 1280, height: 800, windowId: 1, mode: 'fullscreen' });
        await page.setViewportSize({ width: 1100, height: 700 });
        await page.waitForFunction(() => T.rtLayouts().some((l) => l.width === 1100));
        assert.deepEqual((await page.evaluate(() => T.rtLayouts())).at(-1), { left: 291, top: 19, right: 19, bottom: 19, radius: 15, width: 1100, height: 700, windowId: 1, mode: 'fullscreen' }, 'a resize is reported through the ResizeObserver');
        await page.evaluate(() => T.unmountRuntime());
        await page.setViewportSize({ width: 1440, height: 900 });
      });

      await t.test('<m-page> reports its insets and radius', async () => {
        const rows = [];
        for (const [width, height] of [[1440, 900], [1280, 800]]) {
          await page.setViewportSize({ width, height });
          for (const container of ['shadow', 'document']) {
            for (const sidebar of ['open', 'hidden', 'peek']) {
              await page.evaluate(({ w, h, c, s }) => { T.unmountAll(); T.mountNeo({ width: w, height: h, container: c }); if (s !== 'open') T.mutate('setSidebar', s); }, { w: width, h: height, c: container, s: sidebar });
              const l = await page.evaluate(() => T.layout());
              rows.push({ size: `${width}×${height}`, container, sidebar, ...l.insets, radius: l.radius, outer: l.outer });
              assert.deepEqual(l.container, { width, height });
              assert.deepEqual(l.insets, sidebar === 'open' ? { left: 291, top: 19, right: 19, bottom: 19 } : { left: 19, top: 19, right: 19, bottom: 19 }, `${width}×${height} ${container} ${sidebar}`);
              assert.equal(l.radius, 15, 'inner radius: 18 px card, 3 px border');
              assert.equal(l.outer.radius, 18);
            }
          }
        }
        // The layout callback fires once a frame after a change.
        await page.waitForTimeout(100);
        const log = await page.evaluate(() => T.layoutLog());
        assert.ok(log.length > 0);
        t.diagnostic(JSON.stringify(rows.map(({ outer, ...r }) => r)));
        await page.setViewportSize({ width: 1440, height: 900 });
      });

      assert.deepEqual(seen.requests, [], 'no request at all while rendering the theme');
      assert.deepEqual(seen.errors, []);
      await context.close();

      await t.test('controls: the tripwire and the request watch work', async () => {
        const c = await open(browser);
        await c.page.evaluate(() => { T.controlScript(); T.controlNetwork(); });
        await c.page.waitForFunction(() => T.tripped().includes('control'));
        for (let i = 0; i < 40 && !c.seen.requests.length; i++) await c.page.waitForTimeout(50);
        assert.ok(c.seen.requests.some((u) => u.includes('evil.test/control.png')), 'an unsanitized url() is seen');
        await c.context.close();
      });

      await t.test('security: every payload rendered live, nothing runs, nothing loads', async () => {
        const s = await open(browser);
        const results = await s.page.evaluate((m) => T.runHtmlPayloads(m), MANIFEST);
        const bad = results.filter((r) => r.violations.length);
        assert.deepEqual(bad.map((r) => [r.name, r.violations]), [], 'the DOM audit finds nothing');
        // Action abuse through the rendered theme, with real clicks.
        await s.page.click('.bad-close >> nth=0');
        await s.page.click('.bad-proto >> nth=0');
        const { ran, refused } = await s.page.evaluate(() => T.actions());
        assert.deepEqual(ran, [], 'no abusive action ran');
        assert.deepEqual(refused.map((r) => r.name), ['tab.close', 'space.switch']);
        const css = await s.page.evaluate(() => T.runCssPayloads());
        for (const r of css) assert.doesNotMatch(r.css, /evil\.test|javascript:|expression\(/, r.name);
        // Give images, fonts and backgrounds time to try.
        await s.page.waitForTimeout(1500);
        await s.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.deepEqual(await s.page.evaluate(() => T.tripped()), [], 'the tripwire is unset');
        assert.deepEqual(s.seen.dialogs, [], 'no dialog');
        assert.deepEqual(s.seen.requests, [], 'no network request');
        t.diagnostic(`${results.length - 1} HTML payloads (each in a shadow root and in the document), ${css.length} CSS payloads, 2 action-abuse clicks`);
        await s.context.close();
      });
    } finally {
      await browser.close();
    }
  });
}
