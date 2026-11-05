// The theme renderer and sanitizer in real engines: Playwright's WebKit
// (Safari's engine) and Chromium, headless, on a blank page with every
// network request intercepted and refused. `npm run test:theme`.
//
// - Neo-brutalism loads from its sanitized package and renders 200 tabs;
// - updates are keyed and minimal (a MutationObserver counts every change);
// - real clicks dispatch checked actions;
// - <m-page> reports its insets and radius;
// - every XSS, CSS-leak and action-abuse payload (tests/theme/payloads.js)
//   is rendered live: the tripwire stays unset and no request is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage } from './package.js';

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

      await t.test('Neo-brutalism loads from its sanitized package: nothing removed, fonts from bundled bytes', async () => {
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
        assert.deepEqual(await page.evaluate((i) => T.mutate('activate', i), ids.today[1]), { text: 0, attributes: ['class', 'class'], added: 0, removed: 0, moved: 0 }, 'old and new active rows');
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
        assert.deepEqual(ran, [['tab.activate', ids.today[2]], ['space.switch', 'work'], ['folder.toggle', ids.folder], ['palette.open', undefined]]);
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
