// Split View's panes (docs/PEEK-SPLIT.md §4) in all five built-in themes, in real engines (Playwright's WebKit and
// Chromium, headless, every network request refused), as Margin.app's own window draws them while a window is hosted:
// Margin's <m-pane>s in <m-page>, one per pane flexed by the split's ratios, side by side or stacked, an <m-divider>
// between each two (the theme's gap and grip), the focused pane's ring; each pane measured and reported with the page;
// a real drag of a divider changes the ratios as it moves (the app told `split.resizing`, each frame's layout sent),
// stopping at a pane's minimum; let go, `resizeSplit` saved; a double-click makes them equal. None outside Margin's
// own window, none while nothing is hosted. `npm run test:theme`.
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

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: split view's panes and dividers in ${name}`, async () => {
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

        // Margin's own window with nothing hosted (the launcher): a split's item in front draws no panes.
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, appWindow: true }));
        const tabs = (await ev(() => T.rtTodayIds(3))) as number[];
        assert.equal(tabs.length, 3, 'three tabs to split');
        await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
        await frames();
        assert.equal((await ev(() => T.rtPanes())).panes.length, 0, 'nothing hosted: no panes in the launcher');

        // Hosting: the split's panes.
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, appWindow: true, hosted: true }));
        const split = await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
        assert.ok(split, 'the front tab is a pane: the view model has the split');
        await frames();
        let p = await ev(() => T.rtPanes());
        assert.equal(p.axis, 'row');
        assert.equal(p.split, 'spv-1');
        assert.deepEqual(p.panes.map((x) => x.id), tabs.slice(0, 2).map(String), 'one <m-pane> per pane, in order');
        assert.deepEqual(p.panes.map((x) => x.focused), [true, false], 'the one in front focused');
        assert.equal(p.dividers.length, 1, 'a divider between them');
        assert.equal(p.dividers[0].role, 'separator');
        const [a, b] = p.panes;
        assert.ok(near(a.width, b.width), `equal ratios, equal widths: ${a.width} ${b.width}`);
        assert.ok(near(a.left + a.width + p.dividers[0].width, b.left, 1), 'the divider is the gap between them');
        assert.ok(p.dividers[0].width >= 6 && p.dividers[0].width <= 14, `the theme's gap: ${p.dividers[0].width}`);
        assert.equal(p.dividers[0].band, false, 'side by side: no toolbar band (Safari\'s toolbars rest under Margin\'s top frame)');
        assert.equal(p.dividers[0].cursor, 'col-resize');
        assert.ok(p.panes[0].ring !== 'none' && p.panes[1].ring === 'none', `the focused pane's ring only: ${p.panes[0].ring} / ${p.panes[1].ring}`);
        assert.ok(p.dividers[0].grip && !/^rgba\(0, 0, 0, 0\)\|none$/.test(p.dividers[0].grip), `a grip drawn: ${p.dividers[0].grip}`);
        assert.equal(p.layoutSplit, 'spv-1', 'the layout sent says the split');
        assert.deepEqual(p.layout?.map((x) => x.id), tabs.slice(0, 2).map(String), 'and each pane by its item');
        assert.ok(p.layout!.every((x, i) => near(x.rect[0], p.panes[i].left, 1) && near(x.rect[2], p.panes[i].width, 1)), `each pane's box sent: ${JSON.stringify(p.layout)}`);

        // A real drag of the divider: the panes follow each frame, the app told it's being dragged, then the ratios saved.
        await ev(() => T.rtSentClear());
        const d = p.dividers[0];
        await page.mouse.move(d.x, d.y);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(d.x - 30 * i, d.y); await frames(); }
        const mid = await ev(() => T.rtPanes());
        assert.ok(mid.panes[0].width < a.width - 150, `the left pane narrower as it's dragged: ${mid.panes[0].width}`);
        assert.ok(near(mid.layout![0].rect[2], mid.panes[0].width, 1), 'each frame\'s layout sent with the panes as drawn');
        await page.mouse.up();
        await frames();
        const performed = (await ev(() => T.rtPerformedFull())).filter(([n]) => n === 'split.resizing').map(([, arg]) => (arg as { on: boolean }).on);
        assert.deepEqual(performed, [true, false], 'the app told the drag began and ended');
        const saved = (await ev(() => T.rtSent())).filter(([type]) => type === 'resizeSplit');
        assert.equal(saved.length, 1, 'saved once, at the release');
        assert.equal(saved[0][1].splitId, 'spv-1');
        assert.ok(saved[0][1].ratios[0] < 0.4 && near(saved[0][1].ratios[0] + saved[0][1].ratios[1], 1, 0.01), `its ratios: ${saved[0][1].ratios}`);

        // A minimum (the app's, for the left pane's window): the divider stops there.
        await ev((m) => T.rtPaneMin(m), { [String(tabs[0])]: [500, 0] });
        await frames();
        p = await ev(() => T.rtPanes());
        assert.ok(p.panes[0].width >= 499, `laid out at its minimum at least: ${p.panes[0].width}`);
        await page.mouse.move(p.dividers[0].x, p.dividers[0].y);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) { await page.mouse.move(p.dividers[0].x - 60 * i, p.dividers[0].y); await frames(); }
        await page.mouse.up();
        await frames();
        p = await ev(() => T.rtPanes());
        assert.ok(p.panes[0].width >= 499, `the divider stopped at its minimum: ${p.panes[0].width}`);
        await ev((m) => T.rtPaneMin(m), {});
        await frames();
        // Its app's known minimum alone (Safari's, for every web pane, whether its window is open or not: the real
        // screen's 574 × 220): no pane laid out below it, the divider stops there (2026-11-21: a pane laid at 481).
        await ev((m) => T.rtAppMin(m), { web: [500, 0] });
        await frames();
        p = await ev(() => T.rtPanes());
        assert.ok(p.panes.every((x) => x.width >= 499), `every web pane at its app's minimum at least: ${p.panes.map((x) => x.width)}`);
        await page.mouse.move(p.dividers[0].x, p.dividers[0].y);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) { await page.mouse.move(p.dividers[0].x + 60 * i, p.dividers[0].y); await frames(); }
        await page.mouse.up();
        await frames();
        p = await ev(() => T.rtPanes());
        assert.ok(p.panes[1].width >= 499, `the divider stopped at the other pane's app minimum: ${p.panes.map((x) => x.width)}`);
        await ev((m) => T.rtAppMin(m), {});
        await frames();
        p = await ev(() => T.rtPanes());

        // A pane's window opening beside the one shown (Notes added): its loader over its own box only, the other pane
        // drawn as it was (its window shows and takes the pointer); gone when it's in place.
        await ev((item) => T.rtPaneLoading({ item, name: 'Notes' }), String(tabs[1]));
        await frames();
        let loaders = await ev(() => T.rtPaneLoaders());
        assert.deepEqual(loaders.map((l) => l.loading), [false, true], 'only the pane opening is loading');
        assert.ok(loaders[1].visible && loaders[1].inside && loaders[1].text === 'Opening Notes…' && loaders[1].spinning, `its loader in its box: ${JSON.stringify(loaders)}`);
        assert.ok(loaders[1].background !== 'rgba(0, 0, 0, 0)' && loaders[1].color !== loaders[1].background, `readable on its own ground: ${loaders[1].color} on ${loaders[1].background}`);
        assert.equal(loaders[0].text, null, 'the other pane: nothing over it');
        assert.equal(await ev(() => T.rtComputed('m-pane[m-loading]', 'pointer-events')), 'none', 'never the pointer\'s');
        await ev(() => T.rtPaneLoading(null));
        await frames();
        loaders = await ev(() => T.rtPaneLoaders());
        assert.deepEqual(loaders.map((l) => [l.loading, l.text]), [[false, null], [false, null]], 'in place: gone');

        // A double-click: equal sizes again.
        await ev(() => T.rtSentClear());
        await page.mouse.dblclick(p.dividers[0].x, p.dividers[0].y);
        await frames();
        const equal = (await ev(() => T.rtSent())).filter(([type]) => type === 'resizeSplit').at(-1);
        assert.deepEqual(equal?.[1].ratios, [0.5, 0.5], 'equal sizes saved');

        // A third pane that can't fit (each pane's least and the gaps wider than the page area): refused, said.
        const tight = await ev(({ t, w }) => T.rtSplitAdd(t, w), { t: tabs[2], w: 560 });
        assert.deepEqual(tight.sent, [], 'nothing asked of the library');
        assert.equal(tight.toast, 'Not enough room for another pane');
        // The real screen's (2026-11-21 13:26:54): a third Safari pane beside two in a 1264 pt page area. Safari's minimum
        // is known for every web pane (`appMin`, from any of its windows), the new one's too before its window exists:
        // 3 × 574 and the gaps don't fit, refused before anything is opened.
        await ev((m) => T.rtAppMin(m), { web: [574, 220] });
        const safariTight = await ev(({ t, w }) => T.rtSplitAdd(t, w), { t: tabs[2], w: 1264 });
        assert.deepEqual(safariTight.sent, [], 'three Safari panes in 1264 pt: nothing asked of the library');
        assert.equal(safariTight.toast, 'Not enough room for another pane');
        const safariRoomy = await ev(({ t, w }) => T.rtSplitAdd(t, w), { t: tabs[2], w: 1760 });
        assert.deepEqual(safariRoomy.sent, ['addToSplit'], '3 × 574 and the gaps in 1760: added');
        await ev((m) => T.rtAppMin(m), {});
        const roomy = await ev(({ t, w }) => T.rtSplitAdd(t, w), { t: tabs[2], w: 1200 });
        assert.deepEqual(roomy.sent, ['addToSplit'], 'room for it: added');

        // Three panes stacked.
        await ev((t) => T.rtSplit(t, { axis: 'vertical', ratios: [0.5, 0.25, 0.25] }), tabs);
        await frames();
        p = await ev(() => T.rtPanes());
        assert.equal(p.axis, 'column');
        assert.equal(p.panes.length, 3);
        assert.equal(p.dividers.length, 2);
        assert.ok(near(p.panes[1].height, p.panes[2].height) && p.panes[0].height > p.panes[1].height * 1.8, `by their ratios: ${p.panes.map((x) => x.height)}`);
        assert.ok(p.panes.every((x) => near(x.left, p.panes[0].left) && near(x.width, p.panes[0].width)), 'one above the other');
        assert.equal(p.dividers[0].cursor, 'row-resize');
        // Stacked, each pane below another is a Safari window here (web tabs): the gap above it is a band at least as
        // tall as Safari's full-screen toolbar window (52 pt, resting just above its window), so that toolbar rests in
        // Margin's opaque ground, never over the pane above; the band names the pane below it; side by side there's none.
        for (const [i, dv] of p.dividers.entries()) {
          assert.ok(dv.band && dv.height >= 52 && dv.height <= 60, `the band above pane ${i + 1}: ${dv.height}`);
          assert.ok(near(p.panes[i].top + p.panes[i].height + dv.height, p.panes[i + 1].top, 1), 'the band is the gap between them');
          assert.ok(dv.label && dv.label.length > 0, `it names the pane below: ${dv.label}`);
          assert.ok(dv.labelBox && dv.labelBox.top >= dv.top - 0.5 && dv.labelBox.top + dv.labelBox.height <= dv.top + dv.height + 0.5 && dv.labelBox.left + dv.labelBox.width <= dv.x - 20, `its name inside the band, clear of the grip: ${JSON.stringify(dv.labelBox)} in ${JSON.stringify(dv)}`);
          assert.ok(dv.labelColor && dv.labelColor !== dv.background, `its name readable: ${dv.labelColor} on ${dv.background}`);
        }
        assert.ok(p.panes[0].height > 0 && near(p.layout![1].rect[1] - (p.layout![0].rect[1] + p.layout![0].rect[3]), p.dividers[0].height, 1), `the panes sent with the band between them: ${JSON.stringify(p.layout)}`);
        // Room for another stacked pane counts the bands: three floors (140) and two plain gaps would fit in 470, not
        // with two 52 pt bands.
        await ev((t) => T.rtSplit(t, { axis: 'vertical' }), tabs.slice(0, 2));
        await frames();
        const stackedTight = await ev(({ t }) => T.rtSplitAdd(t, 1200, 140 * 3 + 2 * 12 + 10), { t: tabs[2] });
        assert.equal(stackedTight.toast, 'Not enough room for another pane', 'stacked: the bands counted in the room');
        const stackedRoomy = await ev(({ t }) => T.rtSplitAdd(t, 1200, 140 * 3 + 2 * 60), { t: tabs[2] });
        assert.deepEqual(stackedRoomy.sent, ['addToSplit']);
        // Side by side again only where they fit along the width (each web pane's app minimum known): refused, said.
        await ev((m) => T.rtAppMin(m), { web: [700, 220] });
        const unstackTight = await ev(() => T.rtSplitAxis('spv-1', 1264));
        assert.deepEqual(unstackTight.sent, [], 'two 700 pt panes side by side in 1264: not asked');
        assert.equal(unstackTight.toast, 'Not enough room for these panes side by side');
        const unstack = await ev(() => T.rtSplitAxis('spv-1', 1500));
        assert.deepEqual(unstack.sent, ['toggleSplitAxis'], 'room for them: asked');
        await ev((m) => T.rtAppMin(m), {});

        // No split: the page's place as before.
        await ev(() => T.rtNoSplit());
        await frames();
        p = await ev(() => T.rtPanes());
        assert.equal(p.panes.length + p.dividers.length, 0, 'no split: nothing in the page\'s place');
        assert.equal(p.axis, null);
        assert.equal(p.layout, null, 'and no panes sent');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
