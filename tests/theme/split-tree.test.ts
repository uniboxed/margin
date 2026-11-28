// A split's tree (docs/FLEX-SPLIT.md step 3) in all five built-in themes, in real engines (Playwright's WebKit and
// Chromium, headless, every network request refused), as Margin.app's own window draws it while a window is hosted:
// a pane beside a column of two (`<m-split-group m-split="column">` in `<m-page m-split="row">`), each laid out by its
// node's ratios, the dividers each its node's way (`m-axis`, the cursor), every pane reported with its box, each
// pane's corner masks where it meets another (the page card's own corners left alone); the column's divider dragged
// saves that node's ratios (`path`); a pane in the column opened to fit its app along the column, the one beside it
// folded. `npm run test:theme`.
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

async function eventually<R>(check: () => Promise<R>, ms = 3000): Promise<R> {
  const end = Date.now() + ms;
  for (;;) {
    try { return await check(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 30)); }
  }
}

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: a split's tree (a pane beside a column of two) in ${name}`, async () => {
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
        const [a, b, c] = tabs.map(String);
        const tree = { axis: 'horizontal', kids: [a, { axis: 'vertical', kids: [b, c], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] };
        assert.ok(await ev(({ t, tree }) => T.rtSplit(t, { ratios: [0.5, 0.25, 0.25], tree }), { t: tabs, tree }));
        await frames();
        const s = await ev(() => T.rtSplitTree());
        assert.equal(s.axis, 'row');
        assert.deepEqual(s.groups.map((g) => [g.path, g.axis, g.parent]), [['1', 'column', 'm-page']], 'the column a group in the page');
        assert.deepEqual(s.panes.map((p) => p.id), [a, b, c], 'every pane, in order');
        const [pa, pb, pc] = s.panes;
        const col = s.groups[0];
        // (The pane beside the column: as tall as the page; the column's two stacked in its width.)
        assert.ok(near(pa.height, col.height) && near(pa.top, col.top), `a beside the column: ${JSON.stringify(pa)} ${JSON.stringify(col)}`);
        assert.ok(near(pa.width, col.width, 3), `half and half: ${pa.width} ${col.width}`);
        assert.ok(near(pb.left, col.left) && near(pb.width, col.width) && near(pc.width, col.width) && pb.top < pc.top && near(pb.height, pc.height, 3), `b over c in the column: ${JSON.stringify([pb, pc])}`);
        const rowDivider = s.dividers.find((d) => d.path === '')!;
        const colDivider = s.dividers.find((d) => d.path === '1')!;
        assert.deepEqual([rowDivider.axis, colDivider.axis], ['row', 'column']);
        assert.equal(rowDivider.cursor, 'col-resize');
        assert.equal(colDivider.cursor, 'row-resize');
        assert.ok(near(colDivider.width, col.width) && colDivider.top > pb.top + pb.height - 1 && colDivider.top < pc.top + 1, `the column's divider between b and c: ${JSON.stringify(colDivider)}`);
        // Each pane reported with its box, by its item, in order.
        await eventually(async () => {
          const l = (await ev(() => T.rtSplitTree())).layout;
          assert.deepEqual(l?.map((x) => x.id), [a, b, c]);
          assert.ok(l!.every((x, i) => near(x.rect[0], s.panes[i].left, 1) && near(x.rect[1], s.panes[i].top, 1) && near(x.rect[3], s.panes[i].height, 1)), `the boxes sent: ${JSON.stringify(l)}`);
        });
        // The masks: a's right half (its inner corners), b's and c's all but their page-card corner.
        assert.equal(pa.clip, 'inset(0px 0px 0px round(up, 50%, 1px))');
        assert.match(pb.clip, /^polygon\(/);
        assert.match(pc.clip, /^polygon\(/);
        assert.notEqual(pb.clip, pc.clip);

        // The column's divider dragged down: that node's ratios saved, by its path.
        await ev(() => T.rtSentClear());
        await page.mouse.move(colDivider.x, colDivider.y);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) { await page.mouse.move(colDivider.x, colDivider.y + 12 * i); await frames(); }
        await page.mouse.up();
        await eventually(async () => {
          const sent = (await ev(() => T.rtSent())).filter(([type]) => type === 'resizeSplit').map(([, p]) => p);
          assert.equal(sent.length, 1);
          assert.deepEqual(sent[0].path, [1]);
          assert.ok(sent[0].ratios[0] > 0.55 && near(sent[0].ratios[0] + sent[0].ratios[1], 1, 0.01), JSON.stringify(sent[0]));
        });
        assert.ok(near((await ev(() => T.rtSplitTree())).panes[0].width, pa.width, 1), 'the pane beside the column as it was');

        // b opened to fit its app along the column (taller than its half), c folded beside it; a as it was.
        await ev(({ b, c }) => T.rtPaneMin({ [b]: [300, 600], [c]: [300, 300] }), { b, c });
        await ev(({ b }) => T.rtPaneCuts({ [b]: { window: 20 } }), { b });
        await ev(() => T.rtPaneHover(20));
        await eventually(async () => {
          const f = await ev(() => T.rtPaneFolds());
          const fb = f.find((x) => x.id === b)!, fc = f.find((x) => x.id === c)!;
          assert.ok(near(fb.height, 600, 3), `b opened to its app's 600: ${JSON.stringify(fb)}`);
          assert.ok(fc.folded && fc.card?.shown, `c folded: ${JSON.stringify(fc)}`);
          assert.ok(!f.find((x) => x.id === a)!.folded);
        });
        assert.ok(near((await ev(() => T.rtSplitTree())).panes[0].width, pa.width, 1), 'a not moved: b fits its width');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
