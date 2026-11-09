// The bar over a theme being previewed (ui/theme-preview.ts), in WebKit and
// Chromium, headless: in the top layer, in a closed shadow root, and a
// hostile theme's stylesheet (adopted by the document, as in Margin.app's
// overlay) can't hide, restyle or cover it: it stays on top and takes the
// press. Escape cancels, and with no answer it cancels by itself.
// Part of npm run test:theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const bundle = buildSync({
  stdin: {
    contents: `import { createPreviewBar } from './theme-preview.js';
      window.P = { log: [], make(ms) { window.P.bar = createPreviewBar({ ms, onUse: () => P.log.push('use'), onCancel: (why) => P.log.push('cancel:' + why) }); } };`,
    resolveDir: fileURLToPath(new URL('../../extension/ui/', import.meta.url)),
  },
  bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'silent',
}).outputFiles[0].text;

// A theme that tries everything a stylesheet and its own elements can to hide or cover the bar.
const HOSTILE = `
  margin-preview-bar, [popover], :popover-open { display: none !important; opacity: 0 !important; visibility: hidden !important; transform: scale(0) !important; clip-path: inset(50%) !important; filter: opacity(0) !important; pointer-events: none !important; width: 0 !important; height: 0 !important; translate: -9999px 0 !important; zoom: .01 !important; }
  margin-preview-bar::before, margin-preview-bar::after { content: "" !important; position: absolute !important; inset: -100vmax !important; z-index: 2147483647 !important; background: #000 !important; display: block !important; }
  margin-preview-bar::backdrop { background: #000 !important; }
  * { pointer-events: none !important; }
  body { display: none !important; }
  .cover { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; background: red !important; pointer-events: auto !important; display: block !important; }
  :root { --x: 1; }
`;

for (const [name, engine] of ENGINES) {
  test(`the preview bar in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div class="cover"></div></body></html>');
      await page.addScriptTag({ content: bundle });
      await page.evaluate((css) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [sheet];
        // And a theme element of its own on top of everything, outside <body>.
        const top = document.createElement('div');
        top.className = 'cover';
        document.documentElement.append(top);
      }, HOSTILE);

      await t.test('shown with Margin\'s words, the theme\'s name and author as text, cleaned', async () => {
        await page.evaluate(() => { P.make(60000); P.bar.show({ name: 'Evil‮txt.exe', version: '1.0.0', author: '<b>Me</b>', replaces: '0.9.0' }); });
        assert.equal(await page.evaluate(() => P.bar.text()), 'Previewing “Eviltxt.exe” 1.0.0 by <b>Me</b>. Use this theme?Replaces version 0.9.0.');
        assert.equal(await page.evaluate(() => document.querySelector('margin-preview-bar')?.matches(':popover-open')), true, 'in the top layer');
        assert.equal(await page.evaluate(() => document.querySelector('margin-preview-bar')?.shadowRoot), null, 'its shadow root is closed');
      });

      await t.test('the hostile theme can\'t hide, shrink or cover it: it\'s on top where it is, and takes the press', async () => {
        const rect = await page.evaluate(() => P.bar.rect());
        assert.ok(rect && rect[2] > 300 && rect[3] > 30, JSON.stringify(rect));
        const style = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('margin-preview-bar')); return [s.display, s.opacity, s.visibility, s.pointerEvents, s.transform === 'none' ? 'none' : 'moved']; });
        assert.deepEqual(style.slice(0, 4), ['block', '1', 'visible', 'auto']);
        const [x, y] = [rect[0] + rect[2] - 40, rect[1] + rect[3] / 2];
        assert.equal(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.localName, [x, y]), 'margin-preview-bar', 'the bar is what\'s at its own place');
        await page.mouse.click(x, y);
        assert.deepEqual(await page.evaluate(() => P.log), ['use'], 'Use Theme pressed through everything the theme drew');
        assert.equal(await page.evaluate(() => P.bar.shown), false);
      });

      await t.test('Escape cancels, wherever the focus is', async () => {
        await page.evaluate(() => { P.log.length = 0; P.bar.show({ name: 'A', version: '1.0.0' }); });
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.evaluate(() => P.log), ['cancel:escape']);
        assert.equal(await page.evaluate(() => !!document.querySelector('margin-preview-bar')), false, 'and it\'s gone');
      });

      await t.test('with no answer it cancels by itself', async () => {
        await page.evaluate(() => { P.log.length = 0; P.make(300); P.bar.show({ name: 'A', version: '1.0.0' }); });
        await page.waitForFunction(() => P.log.length > 0, null, { timeout: 3000 });
        assert.deepEqual(await page.evaluate(() => P.log), ['cancel:timeout']);
      });
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
