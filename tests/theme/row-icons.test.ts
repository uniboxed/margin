// Installed apps' icons in the sidebar's rows (ui/view-model.ts Face.isApp, each theme's `.app`), in every built-in
// theme, in real engines (Playwright's WebKit and Chromium, headless, every network request refused): macOS app icons
// carry transparent room inside their image, so a theme draws an app's icon bigger than a site's beside it (its glyph
// about a site icon's size), and the row stays as it was: the same height, the title where a site row's is, the icon
// centred where a site's is. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;
const script = harnessScript();

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: an app's icon in a row matches a site's, in ${name}`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, hosted: true }));
        const rows = await ev(() => T.rtAppRows());
        await page.waitForTimeout(50);
        for (const appRow of [rows.apps[0], rows.pin]) {
          await ev((i) => T.rtRowBox(i), appRow);
          const app = (await ev((i) => T.rtRowParts(i), appRow))!;
          const site = (await ev((i) => T.rtRowParts(i), appRow === rows.pin ? rows.site : rows.site))!;
          assert.equal(app.app, true, `${appRow}: drawn as an app's icon`);
          assert.equal(site.app, false);
          assert.ok(app.size! >= site.size! * 1.15 && app.size! <= site.size! * 1.45, `${appRow}: bigger than a site's (${app.size} vs ${site.size} px)`);
          assert.ok(Math.abs(app.row!.height - site.row!.height) < 0.5, `${appRow}: the row's height unchanged (${app.row!.height} vs ${site.row!.height})`);
          if (appRow !== rows.pin) {
            assert.ok(Math.abs(app.title!.left - site.title!.left) < 0.5, `the title where a site row's is (${app.title!.left} vs ${site.title!.left})`);
            const centre = (r: { left: number, width: number }) => r.left + r.width / 2;
            assert.ok(Math.abs(centre(app.icon!) - centre(site.icon!)) < 1, 'the icon centred where a site\'s is');
          }
        }
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
