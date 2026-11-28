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
// (Themes whose page card has no edge of its own: their panes none either.)
const EDGELESS = new Set(['material']);
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
        assert.ok(p.dividers[0].width >= 6 && p.dividers[0].width <= 16, `the theme's gap: ${p.dividers[0].width}`);
        assert.equal(p.dividers[0].band, false, 'side by side: no toolbar band (Safari\'s toolbars rest under Margin\'s top frame)');
        assert.equal(p.dividers[0].cursor, 'col-resize');
        assert.ok(p.panes[0].ring !== 'none' && p.panes[0].ring !== p.panes[1].ring, `the focused pane's ring: ${p.panes[0].ring} / ${p.panes[1].ring}`);
        // Each pane a card of its own (2026-11-27): its edge on every side (the card's, where the card has one), the
        // gap's too, painted above the gap with the grip above it; the card's corners, the inner ones masked over its
        // window in the theme's ground, the outer ones left to the page card's.
        assert.ok(p.panes.every((x) => x.z === '1') && p.dividers[0].gripZ === '2', `panes above the gap, the grip above them: ${p.panes.map((x) => x.z)} ${p.dividers[0].gripZ}`);
        if (!EDGELESS.has(id)) assert.ok(p.panes[1].ring !== 'none', `an unfocused pane's own edge: ${p.panes[1].ring}`);
        if (p.pageRadius > 0) {
          assert.ok(p.panes.every((x) => x.radii.every((r) => near(r, p.pageRadius, 0.5))), `the card's corners on each pane: ${JSON.stringify(p.panes.map((x) => x.radii))}, the card's ${p.pageRadius}`);
          assert.ok(p.panes.every((x) => near(x.mask.radius, p.pageRadius, 0.5) && x.mask.shadow !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(x.mask.shadow)), `its corners masked in the theme's ground: ${JSON.stringify(p.panes.map((x) => x.mask))}`);
        }
        // (Each half's edge on a whole CSS pixel: tests/theme/pane-mask-seam.test.ts.)
        assert.deepEqual(p.panes.map((x) => x.mask.clip), ['inset(0px 0px 0px round(up, 50%, 1px))', 'inset(0px round(up, 50%, 1px) 0px 0px)'], 'only the inner corners masked (the outer ones are the page card\'s)');
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

        // Arc's least (220, docs/PEEK-SPLIT.md §4): the divider stops there whatever a pane's window needs (its own 500,
        // Safari's 574: that window is shown cut by Margin.app, §4b), never at the window's minimum.
        await ev((m) => T.rtPaneMin(m), { [String(tabs[0])]: [500, 0] });
        await ev((m) => T.rtAppMin(m), { web: [574, 220] });
        await frames();
        p = await ev(() => T.rtPanes());
        await page.mouse.move(p.dividers[0].x, p.dividers[0].y);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(p.dividers[0].x - 200 * i, p.dividers[0].y); await frames(); }
        await page.mouse.up();
        await frames();
        p = await ev(() => T.rtPanes());
        assert.ok(near(p.panes[0].width, 220, 1.5), `stopped at Arc's 220, not at its window's 500: ${p.panes.map((x) => x.width)}`);
        await ev((m) => T.rtPaneMin(m), {});
        await ev((m) => T.rtAppMin(m), {});
        await frames();
        // The snap (Arc's 14 pt): dragged slowly to within it of an even split, even, with one haptic (a slow drag:
        // 120 pt/s at most); dragged fast through it, even too, no haptic.
        p = await ev(() => T.rtPanes());
        const even = (q: typeof p) => q.dividers[0].x + (q.panes[1].width - q.panes[0].width) / 2;
        await ev(() => T.rtSentClear());
        let target = even(p);
        await page.mouse.move(p.dividers[0].x, p.dividers[0].y);
        await page.mouse.down();
        await page.mouse.move(target - 40, p.dividers[0].y, { steps: 4 });
        await frames();
        for (let i = 1; i <= 30; i++) { await page.mouse.move(target - 40 + i, p.dividers[0].y); await page.waitForTimeout(16); }
        await page.mouse.up();
        await frames();
        let haptics = (await ev(() => T.rtPerformedFull())).filter(([n]) => n === 'haptic.alignment').length;
        let snapSaved = (await ev(() => T.rtSent())).filter(([type]) => type === 'resizeSplit').at(-1);
        assert.deepEqual(snapSaved?.[1].ratios, [0.5, 0.5], `within 14 of even: even (${JSON.stringify(snapSaved?.[1].ratios)})`);
        assert.equal(haptics, 1, 'one haptic as it snapped, a slow drag');
        p = await ev(() => T.rtPanes());
        await page.mouse.move(p.dividers[0].x, p.dividers[0].y);
        await page.mouse.down();
        await page.mouse.move(p.dividers[0].x - 120, p.dividers[0].y, { steps: 3 });
        await frames();
        await ev(() => T.rtSentClear());
        const before = (await ev(() => T.rtPerformedFull())).filter(([n]) => n === 'haptic.alignment').length;
        target = p.dividers[0].x;
        await page.mouse.move(target - 6, p.dividers[0].y, { steps: 2 });
        await frames();
        await page.mouse.up();
        await frames();
        haptics = (await ev(() => T.rtPerformedFull())).filter(([n]) => n === 'haptic.alignment').length - before;
        snapSaved = (await ev(() => T.rtSent())).filter(([type]) => type === 'resizeSplit').at(-1);
        assert.deepEqual(snapSaved?.[1].ratios, [0.5, 0.5], 'a fast drag into the snap: even too');
        assert.equal(haptics, 0, 'a fast drag: no haptic');
        p = await ev(() => T.rtPanes());

        // A cut pane opens to fit its app (docs/FLEX-SPLIT.md step 1): its window wider than its box. The pointer resting
        // on it (Margin.app's `paneHover`) opens it after the pause to its app's minimum; the other folds into a card (its
        // name and icon, readable, Margin's to take the pointer), the move through the drag's path (`split.resizing`),
        // the folded pane reported. The pointer on the sidebar puts it back; resting on the folded card opens that one;
        // pressing a folded card opens it at once and focuses it (`split.focus`). Click mode: no opening on hover.
        const cutId = String(tabs[1]), otherId = String(tabs[0]);
        await ev((s) => T.rtSettings(s), { splitExpand: 'hover' });
        p = await ev(() => T.rtPanes());
        const room = p.panes[0].width + p.panes[1].width;
        const need = Math.round(room - 120);
        await ev((m) => T.rtPaneMin(m), { [cutId]: [need, 300], [otherId]: [Math.round(room / 2) + 60, 300] });
        await ev((c) => T.rtPaneCuts(c), { [cutId]: { window: 20 } });
        const performedBefore = (await ev(() => T.rtPerformedFull())).length;
        await ev(() => T.rtSentClear());
        await frames();
        let folds = await ev(() => T.rtPaneFolds());
        assert.ok(folds.every((f) => !f.folded && !f.card), `at rest: nothing folded, no card: ${JSON.stringify(folds)}`);
        assert.ok((await ev(() => T.rtPerformedFull())).every(([n]) => n !== 'split.slide'), 'no arrows, no slides');
        await ev(() => T.rtPaneHover(20));
        await page.waitForTimeout(120);
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[1].width, folds[0].width, 3), `not yet: the pause first (${folds.map((f) => f.width)})`);
        await page.waitForTimeout(600);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[1].width, need, 2), `opened to its app's minimum: ${folds[1].width} of ${need}`);
        assert.ok(near(folds[0].width, room - need, 2) && folds[0].folded && !folds[1].folded, `the other folded: ${JSON.stringify(folds)}`);
        const fc = folds[0].card!;
        assert.ok(fc.shown && fc.pointer === 'auto' && fc.inside, `its card shown in its box, taking the pointer: ${JSON.stringify(fc)}`);
        assert.ok((fc.img ?? fc.letter ?? '').length > 0 && (fc.name ?? '').length > 0 && /^Open /.test(fc.label ?? ''), `its icon (or letter) and name: ${JSON.stringify(fc)}`);
        assert.ok(fc.color !== fc.background, `readable: ${fc.color} on ${fc.background}`);
        const moved = (await ev(() => T.rtPerformedFull())).slice(performedBefore).filter(([n]) => n === 'split.resizing').map(([, a]) => (a as { on: boolean }).on);
        assert.deepEqual([moved[0], moved.at(-1)], [true, false], `the move through the drag's path: ${JSON.stringify(moved)}`);
        let lay = (await ev(() => T.rtPanes())).layout!;
        assert.deepEqual(lay.map((x: any) => [x.id, !!x.folded]), [[otherId, true], [cutId, false]], `the folded pane reported: ${JSON.stringify(lay)}`);
        const inHits = (hits: number[][], a: { x: number, y: number }) => hits.some(([x, y, w, h]) => a.x >= x && a.x <= x + w && a.y >= y && a.y <= y + h);
        assert.ok(inHits(await ev(() => T.rtPageHits()), fc), 'the folded card is Margin\'s to take the pointer (hitRects)');
        // The pointer leaves the pane for the sidebar: back at its sizes after a pause.
        await ev(() => T.rtPaneHover(null));
        await page.mouse.move(40, 400);
        await page.waitForTimeout(900);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[0].width, folds[1].width, 3) && folds.every((f) => !f.folded && !f.card), `the pointer on the sidebar: back at its ratios: ${JSON.stringify(folds)}`);
        assert.deepEqual((await ev(() => T.rtSent())).filter(([t]) => t === 'resizeSplit').length, 0, 'opening never saves the ratios');
        // Opened again; the pointer resting on the folded card opens that one (its app's minimum), the first folding.
        await ev(() => T.rtPaneHover(20));
        await page.waitForTimeout(800);
        await ev(() => T.rtPaneHover(null));
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(folds[0].folded, 'opened again');
        await page.mouse.move(folds[0].card!.x, folds[0].card!.y, { steps: 3 });
        await page.waitForTimeout(900);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[0].width, Math.round(room / 2) + 60, 2) && folds[1].folded, `resting on the folded card: it opens, the other folds: ${JSON.stringify(folds)}`);
        // A press on the folded card: open at once, its pane focused.
        await ev(() => T.rtSentClear());
        const press = folds[1].card!;
        await page.mouse.move(press.x, press.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(400);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[1].width, need, 2) && folds[0].folded, `pressed: open at once: ${JSON.stringify(folds)}`);
        const focused = (await ev(() => T.rtSent())).filter(([t]) => t === 'activateTab').map(([, a]) => a.tabId);
        assert.deepEqual(focused, [tabs[1]], `and its pane focused (split.focus): ${JSON.stringify(focused)}`);
        // A folded pane that fits at the split's own sizes (its app's minimum less than its share): resting on its card
        // puts the split back to them.
        await ev((m) => T.rtPaneMin(m), { [cutId]: [need, 300], [otherId]: [Math.round(room / 2) - 60, 300] });
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(folds[0].folded && !folds[1].folded, `still open, the other folded: ${JSON.stringify(folds)}`);
        await page.mouse.move(folds[0].card!.x, folds[0].card!.y, { steps: 2 });
        await page.waitForTimeout(900);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[0].width, folds[1].width, 3) && folds.every((f) => !f.folded), `resting on a folded pane that fits: the split back at its sizes: ${JSON.stringify(folds)}`);
        // Click mode: resting doesn't open (a new split shown: at its ratios).
        await ev((s) => T.rtSettings(s), { splitExpand: 'click' });
        await ev((t) => T.rtSplit(t, { id: 'spv-click' }), tabs.slice(0, 2));
        await ev(() => T.rtPaneHover(20));
        await page.waitForTimeout(700);
        await frames();
        folds = await ev(() => T.rtPaneFolds());
        assert.ok(near(folds[0].width, folds[1].width, 3) && folds.every((f) => !f.folded), `click mode: the pointer's rest opens nothing: ${JSON.stringify(folds)}`);
        await ev(() => T.rtPaneHover(null));
        await ev((c) => T.rtPaneCuts(c), {});
        await ev((m) => T.rtPaneMin(m), {});
        await ev((s) => T.rtSettings(s), { splitExpand: 'hover' });
        await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
        await frames();
        assert.equal(errors.length, 0, errors.join('\n'));

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
        // Three Safari panes in a 1264 pt page area (the real screen's, 2026-11-21 13:26:54, refused then by Safari's 574):
        // added now, each 220 at least by Arc's rule, a window that needs more shown cut (docs/PEEK-SPLIT.md §4b).
        await ev((m) => T.rtAppMin(m), { web: [574, 220] });
        const threeSafari = await ev(({ t, w }) => T.rtSplitAdd(t, w), { t: tabs[2], w: 1264 });
        assert.deepEqual(threeSafari.sent, ['addToSplit'], 'three Safari panes in 1264 pt: added (each 220 at least, cut)');
        // The pairing (the real screen's 2026-11-21 19:32:02): "Add to Split View" on the row of the Safari tab in front
        // splits it with Notes (the item used last besides it, by the library), so the check pairs it so too; refused
        // only where two of 220 and the gap don't fit (440 pt), each said in Margin.app's log with the inputs.
        await ev((m) => T.rtAppMin(m), { web: [574, 220], 'com.apple.Notes': [701, 53] });
        await ev(() => T.rtNoSplit());
        // (Both open in Margin's window, as on the real screen: rows of a number, the menu's add names them so.)
        await ev(() => T.rtKept('t-notes', 'app://com.apple.Notes', { lastActive: 1000, name: 'Notes', row: 902 }));
        await ev(() => T.rtKept('t-web', 'https://maps.example/', { lastActive: 2000, wasActive: true, row: 901 }));
        const ownRowRoomy = await ev(({ w }) => T.rtSplitAdd(901, w), { w: 1264 });
        assert.deepEqual(ownRowRoomy.sent, ['addToSplit'], 'the front tab\'s own row beside Notes in 1264: added (Notes shown cut)');
        assert.match(ownRowRoomy.note ?? '', /^split add: com\.apple\.Notes 220 \+ web 220 \+ gaps \d+ in 1264 \(horizontal\): fits;/, `the check said: ${ownRowRoomy.note}`);
        const ownRow = await ev(({ w }) => T.rtSplitAdd(901, w), { w: 440 });
        assert.deepEqual(ownRow.sent, [], 'in 440: nothing asked of the library');
        assert.equal(ownRow.toast, 'Not enough room for another pane');
        assert.match(ownRow.note ?? '', /^split add: com\.apple\.Notes 220 \+ web 220 \+ gaps \d+ in 440 \(horizontal\): refused; apps known: web, com\.apple\.Notes$/, `the check said: ${ownRow.note}`);
        const notesRow = await ev(({ w }) => T.rtSplitAdd(902, w), { w: 440 });
        assert.deepEqual(notesRow.sent, [], 'Notes\' row beside the front tab in 440: refused');
        assert.match(notesRow.note ?? '', /^split add: web 220 \+ com\.apple\.Notes 220 \+ gaps \d+ in 440 \(horizontal\): refused;/, `the check said: ${notesRow.note}`);
        // Notes closed (a kept item, by its id), the tab open: the same pair.
        await ev(() => T.rtKept('t-notes2', 'app://com.apple.Notes', { lastActive: 1500, name: 'Notes' }));
        const closedNotes = await ev(({ w }) => T.rtSplitAdd(901, w), { w: 440 });
        assert.deepEqual(closedNotes.sent, [], 'beside a closed Notes item used before it, in 440: refused');
        assert.match(closedNotes.note ?? '', /^split add: com\.apple\.Notes 220 \+ web 220 /, `the check said: ${closedNotes.note}`);
        await ev((t) => T.rtSplit(t), tabs.slice(0, 2));
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
        // (By their ratios, each 220 at least, Arc's least height stacked: in this 800 pt window the two quarters are held
        // at 220 and the half takes the rest.)
        assert.ok(near(p.panes[1].height, p.panes[2].height) && p.panes[1].height >= 219 && p.panes[0].height >= p.panes[1].height, `by their ratios, 220 at least: ${p.panes.map((x) => x.height)}`);
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
        // Room for another stacked pane counts the bands: three floors (Arc's 220) and two plain gaps would fit in 694,
        // not with two 52 pt bands.
        await ev((t) => T.rtSplit(t, { axis: 'vertical' }), tabs.slice(0, 2));
        await frames();
        const stackedTight = await ev(({ t }) => T.rtSplitAdd(t, 1200, 220 * 3 + 2 * 12 + 10), { t: tabs[2] });
        assert.equal(stackedTight.toast, 'Not enough room for another pane', 'stacked: the bands counted in the room');
        const stackedRoomy = await ev(({ t }) => T.rtSplitAdd(t, 1200, 220 * 3 + 2 * 60), { t: tabs[2] });
        assert.deepEqual(stackedRoomy.sent, ['addToSplit']);
        // Side by side again only where they fit along the width (each 220 at least, whatever their windows need):
        // refused, said.
        await ev((m) => T.rtAppMin(m), { web: [700, 220] });
        const unstackTight = await ev(() => T.rtSplitAxis('spv-1', 440));
        assert.deepEqual(unstackTight.sent, [], 'two panes side by side in 440 (2 × 220 and the gap): not asked');
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
