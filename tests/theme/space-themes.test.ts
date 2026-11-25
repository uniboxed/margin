// A theme per space (2026-11-20, Tirth): every built-in theme's space editor offers the themes (the space's own
// chosen, a click picks one, Save sends it), and a space's menu offers them too (one run sends setSpaceTheme). Real
// engines (WebKit, Chromium), real mouse clicks on the theme's own buttons; nothing of the theme removed by the
// sanitizer (loadBuiltin's ok).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, NEO, PIXEL, GLASS, MATERIAL } from './package.ts';
import type { Harness } from './harness.ts';
declare const T: Harness;
const script = harnessScript();
const themes = [['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL], ['liquid-glass', GLASS], ['material', MATERIAL]] as const;
const NAMES = ['Arcadia', 'Neubrutalism', 'Pixel', 'Liquid Glass', 'Material'];

for (const [engineName, engine] of [['webkit', webkit], ['chromium', chromium]] as const) {
  for (const [id, dir] of themesInScope(themes)) {
    test(`a theme per space: ${id}'s editor and a space's menu offer the themes, ${engineName}`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: script });
        assert.equal((await page.evaluate(([pkg, name]) => T.loadBuiltin(pkg, name), [themeForPage(dir), id] as const)).ok, true);
        // (Margin.app's window: each space's theme drawn, `spaceThemes`.)
        await page.evaluate(() => T.mountRuntime({ staysOnScreen: true, platform: { browser: 'safari', os: 'mac', features: { spaceThemes: true } } } as any));
        await page.evaluate(() => T.rtSettings({ sidebarPinnedOpen: true }));

        // The editor: every theme, the space's own (none: the profile's, Arcadia) chosen.
        await page.evaluate(() => T.rtDispatch('space.edit', 'work'));
        assert.deepEqual(await page.evaluate(() => T.rtText('.theme-choice')), NAMES);
        assert.deepEqual(await page.evaluate(() => [0, 1, 2, 3, 4].map((n) => T.rtAttr('.theme-choice', 'aria-checked', n))), ['true', 'false', 'false', 'false', 'false']);
        assert.equal(await page.evaluate(() => T.rtAttr('.theme-choices', 'aria-label')), 'Space theme');
        // Laid out inside the editor (wrapping, never past its edge).
        const box = (await page.evaluate(() => T.rtRect('.theme-choices')))!;
        const last = (await page.evaluate(() => T.rtRect('.theme-choice', 4)))!;
        assert.ok(box.width > 0 && last.right <= box.right + 1 && last.left >= box.left - 1, `the row fits: ${JSON.stringify({ box, last })}`);
        // A real click on Pixel: picked; Save sends it with the rest.
        const pixel = (await page.evaluate(() => T.rtRect('.theme-choice', 2)))!;
        await page.mouse.click(pixel.x, pixel.y); // (its middle)
        assert.deepEqual(await page.evaluate(() => [0, 1, 2, 3, 4].map((n) => T.rtAttr('.theme-choice', 'aria-checked', n))), ['false', 'false', 'true', 'false', 'false']);
        await page.evaluate(() => T.rtDispatch('editor.save'));
        const saved = (await page.evaluate(() => T.rtSent().filter(([k]) => k === 'renameSpace').at(-1)))!;
        assert.equal(saved[1].spaceId, 'work');
        assert.equal(saved[1].theme, 'pixel', JSON.stringify(saved));
        assert.equal(await page.evaluate(() => T.rtCount('.theme-choice')), 0, 'the editor closed');

        // A space's menu: its Theme items, the one it's drawn with checked; one run asks for it.
        await page.evaluate(() => T.rtSetUi({ menu: { kind: 'space', id: 'work', x: 40, y: 80 } } as any));
        const labels = (await page.evaluate(() => T.rtVmFull().menu)) ?? [];
        assert.deepEqual(labels.filter((l: string) => l.startsWith('Theme:')), ['Theme: Arcadia ✓', 'Theme: Neubrutalism', 'Theme: Pixel', 'Theme: Liquid Glass', 'Theme: Material'], JSON.stringify(labels));
        // (Its items: Edit Space… i0, Rename Space i1, Edit Theme Color… i2, then the themes from i3: Pixel is i5.)
        assert.equal(labels[6], 'Theme: Pixel');
        await page.evaluate(() => T.rtDispatch('menu.run', 'i5'));
        assert.deepEqual(await page.evaluate(() => T.rtSent().filter(([k]) => k === 'setSpaceTheme').at(-1)), ['setSpaceTheme', { spaceId: 'work', theme: 'pixel' }]);
        assert.deepEqual(await page.evaluate(() => T.rtRefused()), []);
        // Where each space's theme isn't drawn (a browser's overlay): no theme row, the editor as before.
        await page.evaluate(() => T.unmountRuntime());
        await page.evaluate(() => T.mountRuntime({ staysOnScreen: true }));
        await page.evaluate(() => T.rtDispatch('space.edit', 'work'));
        assert.deepEqual(await page.evaluate(() => [T.rtCount('.theme-choice'), T.rtCount('.theme-choices'), T.rtCount('.swatch') > 0]), [0, 0, true]);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
