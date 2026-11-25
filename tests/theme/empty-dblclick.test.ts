// A double-click on an empty part of the sidebar opens the command palette, as Arc's does (docs/SIDEBAR-PRESS.md;
// app/shared/ui/empty.ts, app/shared/ui/behaviors/empty.ts), in every built-in theme, in real engines (Playwright's
// WebKit and Chromium, headless, every network request refused), real mouse input: Margin.app's own window hosting an
// app (the sidebar docked, the page card shown), the Work space (a few rows: room below them).
// - An empty point (found by the rule, and nothing busy there by the dev hook's old selector): its double-click opens
//   the palette as the palette's key does (the new-tab palette in Margin's own window), said as the key's.
// - Not on a tab's row, a folder's, the space's name, a chip, the gap between two chips (the switcher's), the address
//   field, a drag region, the resize handle, a field (the space editor's name): none opens the palette by the double-click.
// - Not when one of its two clicks was on a row, not while a menu was open at its first click.
// - `m-empty="never"` on the theme's root: nothing of it is empty.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['material', MATERIAL], ['neubrutalism', NEO], ['pixel', PIXEL], ['liquid-glass', GLASS]] as const;
const script = harnessScript();
const BY = 'a double-click on the sidebar';

for (const [name, engine] of ENGINES) for (const [id, dir] of themesInScope(THEMES)) {
  test(`${id}: a double-click on the sidebar's empty part opens the palette, nowhere else, in ${name}`, async (t) => {
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
      const pkg = themeForPage(dir);
      const mount = async (p = pkg) => {
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p, i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, hosted: true }));
        await ev(() => T.rtChange('switchSpace', 'work'));
        await page.waitForTimeout(80);
      };
      const opens = () => ev(() => T.rtPaletteOpens());
      const open = async () => !!(await ev(() => T.rtUi())).palette.open;
      const settle = async () => {
        await page.keyboard.press('Escape');
        await ev(() => T.rtClosePalette());
        await page.waitForTimeout(60);
        await opens();
      };
      // A double-click at a point: two presses there, the second with its click count 2 (as the window server's).
      const dbl = async (x: number, y: number) => { await page.mouse.dblclick(x, y); await page.waitForTimeout(60); };
      await mount();
      const spot = await ev(() => T.rtEmptySpot());

      await t.test('an empty point of the sidebar: found, nothing busy there; its double-click opens the palette as the key does (a new tab), said as the key\'s', async () => {
        assert.ok(spot, 'an empty point found by the rule');
        const there = await ev(({ x, y }) => T.rtBusyAt(x, y), spot!);
        assert.equal(there.busy, false, `nothing busy there (${there.at})`);
        t.diagnostic(`${id}, ${name}: the empty point ${spot!.x},${spot!.y} on ${there.at}`);
        await dbl(spot!.x, spot!.y);
        assert.equal(await open(), true, 'the palette open');
        assert.deepEqual(await opens(), [[BY, true]], 'opened as the palette\'s key opens it, the new-tab palette');
        // Open already: another double-click there is the palette's (a press outside it closes it, as always), never
        // opening it again.
        await dbl(spot!.x, spot!.y);
        assert.deepEqual(await opens(), [], 'not opened again');
        await settle();
        assert.equal(await open(), false);
      });

      await t.test('a single click there opens nothing', async () => {
        await page.mouse.click(spot!.x, spot!.y);
        await page.waitForTimeout(60);
        assert.equal(await open(), false);
        assert.deepEqual(await opens(), []);
      });

      // Each not-empty target: its double-click doesn't open the palette by the rule (an address field's own click does,
      // as a click: never said as the key's).
      const notEmpty: [string, string][] = [
        ['a tab\'s row', '[m-drag="tab"]'], ['a folder\'s row', '[m-drag="folder"]'], ['a pin\'s row', '[m-drag="pin"]'],
        ['the space\'s name', '[m-rename="space"]'], ['a space chip (its own space)', '.chip.active, .chip.on'], ['the address field', '.address'],
        ['a drag region', 'm-drag-region'], ['the resize handle', '[m-resize]'],
        ['the mini player (a widget: its background too)', '.mini-player'], ['the space\'s title beside its name (a decoration there)', '.space-title .emoji, .space-head .world'],
      ];
      for (const [what, selector] of notEmpty) {
        await t.test(`${what}: its double-click doesn't open the palette as the key`, async () => {
          const all = await ev((s) => T.rtCentres(s), selector);
          // (A theme with none drawn: no drag region in full screen, no decoration beside the space's name.)
          if ((selector === 'm-drag-region' || selector.includes('.world')) && all.length === 0) return;
          assert.ok(all.length > 0, `${selector} drawn`);
          const c = all[0];
          await dbl(c.x, c.y);
          assert.deepEqual(await opens(), [], `${what} (${selector}): not as the key`);
          await settle();
        });
      }

      await t.test('the gap between two space chips (the switcher\'s): its double-click doesn\'t open the palette', async () => {
        const chips = await ev(() => T.rtCentres('.chip'));
        assert.ok(chips.length >= 2, 'two chips');
        const [a, b] = chips.slice().sort((p, q) => p.left - q.left);
        assert.ok(a.top < b.bottom && b.top < a.bottom, 'side by side');
        // (Between them: a gap, the bar's; or, where the chips touch or overlap (Arcadia's, as Arc's slots: 2 pt over
        // each other), where they meet: a chip. Neither is ever empty.)
        const gap = { x: (a.right + b.left) / 2, y: (a.y + b.y) / 2 };
        await dbl(gap.x, gap.y);
        assert.deepEqual(await opens(), [], `between the chips at ${gap.x},${gap.y} (${(await ev(({ x, y }) => T.rtBusyAt(x, y), gap)).at})`);
        await settle();
      });

      await t.test('the frame around the page card (not the sidebar): its double-click doesn\'t open the palette', async () => {
        const at = { x: 1277, y: 400 };
        await dbl(at.x, at.y);
        assert.deepEqual(await opens(), [], `the frame's right edge (${(await ev(({ x, y }) => T.rtBusyAt(x, y), at)).at})`);
        await settle();
      });

      await t.test('a field (the space editor\'s name): its double-click doesn\'t open the palette', async () => {
        await ev(() => T.rtDispatch('space.edit', 'work'));
        await page.waitForTimeout(80);
        const field = (await ev(() => T.rtCentres('[m-input="space-name"]')))[0];
        assert.ok(field, 'the editor\'s name field drawn');
        await dbl(field.x, field.y);
        assert.deepEqual(await opens(), []);
        await ev(() => T.rtDispatch('editor.cancel'));
        await settle();
      });

      await t.test('one of the two clicks on a row: nothing', async () => {
        const row = (await ev(() => T.rtCentres('[m-drag="tab"]')))[0];
        await page.mouse.move(row.x, row.y);
        await page.mouse.down({ clickCount: 1 });
        await page.mouse.up({ clickCount: 1 });
        await page.mouse.move(spot!.x, spot!.y);
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        await page.waitForTimeout(60);
        assert.deepEqual(await opens(), [], 'a row first, then the empty point');
        await page.mouse.move(spot!.x, spot!.y);
        await page.mouse.down({ clickCount: 1 });
        await page.mouse.up({ clickCount: 1 });
        await page.mouse.move(row.x, row.y);
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        await page.waitForTimeout(60);
        assert.deepEqual(await opens(), [], 'the empty point first, then a row');
        await settle();
      });

      await t.test('a menu open at its first click (a row\'s right-click menu): nothing', async () => {
        const row = (await ev(() => T.rtCentres('[m-drag="tab"]')))[0];
        await page.mouse.click(row.x, row.y, { button: 'right' });
        await page.waitForTimeout(60);
        assert.ok((await ev(() => T.rtUi())).menu, 'the row\'s menu open');
        await dbl(spot!.x, spot!.y);
        assert.deepEqual(await opens(), [], 'not opened');
        await settle();
        assert.equal((await ev(() => T.rtUi())).menu, null, 'the menu closed');
      });

      await t.test('m-empty="never" on the theme\'s root: nothing of it is empty, its double-click opens nothing', async () => {
        const html = pkg.html.replace(/^(\s*<[a-z][a-z0-9-]*)/i, '$1 m-empty="never"');
        assert.notEqual(html, pkg.html, 'the root marked');
        await mount({ ...pkg, html });
        assert.equal(await ev(() => T.rtEmptySpot()), null, 'no empty point');
        await dbl(spot!.x, spot!.y);
        assert.deepEqual(await opens(), []);
        assert.equal(await open(), false);
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
