// A sidebar tab dropped on the page (docs/FLEX-SPLIT.md step 2) in all five built-in themes, in real engines
// (Playwright's WebKit and Chromium, headless, every network request refused), as Margin.app's own window draws it
// while a window is hosted: dragged over the page alone, the half it would take on the nearest edge is marked
// (`m-drop-zone`, Margin's own element) and a drop asks for a new split there (the press's switch to the row's tab
// undone as it first reaches the page: it goes beside what was shown); over a split, a pane's ends and the
// gap mark the half of a pane it'd take beside it (any side), its middle the pane it would take the place of, and the
// drop asks for that;
// a browser's window (not Margin's own) marks nothing; the mark goes with the drag. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['material', MATERIAL], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;
const script = harnessScript();
const near = (a: number, b: number, e = 2) => Math.abs(a - b) <= e;

async function eventually<R>(check: () => Promise<R>, ms = 2000): Promise<R> {
  const end = Date.now() + ms;
  for (;;) {
    try { return await check(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 30)); }
  }
}

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: a tab dropped on the page: beside it, beside a pane on any side, in a pane's place, in ${name}`, async () => {
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
        const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, appWindow: true, hosted: true }));
        const tabs = (await ev(() => T.rtTodayIds(3))) as number[];
        assert.equal(tabs.length, 3);
        // (tabs[0] in front, no split.)
        await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
        await ev(() => T.rtNoSplit());
        await frames();

        // Pressed on a row and moved past the drag's start, then to a point; the mark there (eventually: a redraw).
        const drag = async (tab: number, x: number, y: number) => {
          const row = (await ev((i) => T.rtRowBox(i), tab))!;
          await page.mouse.move(row.x, row.y);
          await page.mouse.down();
          await page.mouse.move(row.x + 4, row.y + 12, { steps: 4 });
          await page.mouse.move(x, y, { steps: 8 });
          await frames();
        };
        const sentAdd = () => ev(() => T.rtSent().filter(([type]) => type === 'addToSplit').map(([, p]) => p));

        // The page alone: its right edge, the right half marked; dropped, a new split with the one in front, side by side.
        const box = (await ev(() => T.rtRect('m-page')))!;
        assert.ok(box.width > 400, `the page's box: ${JSON.stringify(box)}`);
        await ev(() => T.rtSentClear());
        await drag(tabs[1], box.right - 30, box.y);
        // (Its box glides to where it goes: waited for.)
        const side = await eventually(async () => {
          const z = await ev(() => T.rtDropZone());
          assert.equal(z?.kind, 'side');
          assert.ok(near(z!.left, box.left + box.width / 2) && near(z!.width, box.width / 2) && near(z!.height, box.height), `the right half: ${JSON.stringify(z)} of ${JSON.stringify(box)}`);
          return z!;
        });
        assert.ok(side.shown && side.events === 'none', `drawn, taking no pointer: ${JSON.stringify(side)}`);
        // (Moved to the top edge: the top half, stacked.)
        await page.mouse.move(box.x, box.top + 20, { steps: 4 });
        await frames();
        await eventually(async () => { const z = await ev(() => T.rtDropZone()); assert.ok(z && near(z.height, box.height / 2) && near(z.width, box.width) && near(z.top, box.top), `the top half: ${JSON.stringify(z)}`); });
        await page.mouse.move(box.right - 30, box.y, { steps: 4 });
        await frames();
        await page.mouse.up();
        await eventually(async () => assert.deepEqual(await sentAdd(), [{ tabId: tabs[1], windowId: 1, nextTo: tabs[0], axis: 'horizontal', at: 1 }]));
        // (The press switched to the row's tab, as a press does; over the page, the one shown before asked back, once.)
        const activated = await ev(() => T.rtSent().filter(([type]) => type === 'activateTab').map(([, p]) => p?.tabId));
        assert.deepEqual(activated, [tabs[1], tabs[0]], 'pressed: its tab; over the page: the one shown before, once');
        assert.equal(await ev(() => T.rtDropZone()), null, 'the mark gone with the drag');

        // A split of two: near the second pane's bottom edge, its bottom half marked (a pane split across the split,
        // docs/FLEX-SPLIT.md step 3); its middle, that pane; dropped there, in its place.
        await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
        await frames();
        const p = await ev(() => T.rtPanes());
        assert.equal(p.panes.length, 2);
        const second = p.panes[1];
        const low = { x: second.x, y: second.top + second.height * 0.92 };
        await ev(() => T.rtSentClear());
        await drag(tabs[2], low.x, low.y);
        await eventually(async () => {
          const z = await ev(() => T.rtDropZone());
          assert.equal(z?.kind, 'beside');
          assert.ok(near(z!.left, second.left) && near(z!.width, second.width) && near(z!.top, second.top + second.height / 2) && near(z!.height, second.height / 2), `the second pane's bottom half: ${JSON.stringify(z)} ${JSON.stringify(second)}`);
        });
        await page.mouse.move(second.x, second.y, { steps: 4 });
        await frames();
        await eventually(async () => {
          const z = await ev(() => T.rtDropZone());
          assert.equal(z?.kind, 'replace');
          assert.ok(near(z!.left, second.left) && near(z!.width, second.width), `the second pane: ${JSON.stringify(z)} ${JSON.stringify(second)}`);
        });
        await page.mouse.up();
        await eventually(async () => assert.deepEqual(await sentAdd(), [{ tabId: tabs[2], windowId: 1, splitId: 'spv-1', replace: String(tabs[1]) }]));
        // (Dropped near its bottom edge this time: below it.)
        await ev(() => T.rtSentClear());
        await drag(tabs[2], low.x, low.y);
        await eventually(async () => assert.equal((await ev(() => T.rtDropZone()))?.kind, 'beside'));
        await page.mouse.up();
        await eventually(async () => assert.deepEqual(await sentAdd(), [{ tabId: tabs[2], windowId: 1, splitId: 'spv-1', beside: String(tabs[1]), side: 'bottom' }]));
        // (The gap between the two: beside the nearer pane, on its side facing the gap.)
        const gap = p.dividers[0];
        await ev(() => T.rtSentClear());
        await drag(tabs[2], gap.x - 1, gap.y);
        await eventually(async () => assert.equal((await ev(() => T.rtDropZone()))?.kind, 'beside'));
        await page.mouse.up();
        await eventually(async () => assert.deepEqual(await sentAdd(), [{ tabId: tabs[2], windowId: 1, splitId: 'spv-1', beside: String(tabs[0]), side: 'right' }]));

        // Not Margin's own window (the overlay over a browser's window, whose page is the browser's): no mark. (Nothing
        // hosted in Margin's window shows its launcher, which has no sidebar to drag from.)
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false }));
        await frames();
        const [, other] = (await ev(() => T.rtTodayIds(2))) as number[];
        await drag(other, box.right - 30, box.y);
        assert.equal(await ev(() => T.rtDropZone()), null, 'not Margin\'s window: no drop on the page');
        await page.mouse.up();
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
