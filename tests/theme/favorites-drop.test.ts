// The first favorite, dragged in: with no favorites yet, each built-in theme draws an empty drop target while a tab
// (or a pin, or an app's row: a tab too) is dragged, over what follows it so nothing moves, and none at rest. Real
// engines (Playwright's WebKit and Chromium, headless, every network request refused). `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, NEO, PIXEL, MATERIAL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['neubrutalism', NEO], ['pixel', PIXEL], ['material', MATERIAL]] as const;
const script = harnessScript();

async function eventually<R>(check: () => Promise<R>, ms = 2000): Promise<R> {
  const end = Date.now() + ms;
  for (;;) {
    try { return await check(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 30)); }
  }
}

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: no favorites yet, a tab dragged: an empty drop target over the list, nothing moved; none at rest, in ${name}`, async () => {
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
        await page.waitForTimeout(100);
        // At rest: nothing drawn for it.
        assert.equal(await ev(() => ((T.rtState() as { favorites?: unknown[] }).favorites ?? []).length), 0);
        assert.equal(await ev(() => T.rtDisplay('.favorites-drop')), 'none', 'none at rest');
        const [tabId] = await ev(() => T.rtTodayIds(1));
        const row = (await ev((i) => T.rtRowBox(i), tabId))!;
        const tops = await ev(() => T.rtTodayTops());
        await ev(() => T.rtSentClear());
        await page.mouse.move(row.x, row.y);
        await page.mouse.down();
        await page.mouse.move(row.x + 4, row.y + 12, { steps: 4 });
        // Dragging: the target drawn, the rows where they were.
        const zone = await eventually(async () => {
          const z = await ev(() => T.rtRect('.favorites-drop-zone'));
          assert.ok(z && z.width > 100 && z.height >= 30, `the drop target drawn: ${JSON.stringify(z)}`);
          return z!;
        });
        // (The row dragged aside: pressed, a theme may scale it a little.)
        const others = (list: (readonly [number | string, number | null])[]) => list.filter(([t]) => t !== tabId);
        assert.deepEqual(others(await ev(() => T.rtTodayTops())), others(tops), 'nothing moved');
        await page.mouse.move(zone.x, zone.y, { steps: 6 });
        await eventually(async () => assert.ok((await ev(() => T.rtClasses('.favorites-drop', 0)))!.includes('m-drop-into'), 'marked as the drop\'s place'));
        await page.mouse.up();
        await eventually(async () => assert.ok((await ev(() => T.rtSent())).some(([type, p]) => type === 'addFavorite' && p?.tabId === tabId), `asked to add it: ${JSON.stringify(await ev(() => T.rtSent()))}`));
        assert.equal(await ev(() => T.rtDisplay('.favorites-drop')), 'none', 'gone with the drag');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
