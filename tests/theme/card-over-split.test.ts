// The preview card over a stacked split (docs/PEEK-SPLIT.md §2, §4; the real screen, 2026-11-21: the split's band drawn as
// a dark stripe across the card's page) in all five built-in themes and Margin's default card, in real engines
// (Playwright's WebKit and Chromium, headless, every network request refused): while the card is up, nothing of
// Margin's `<m-page>` paints or takes a press inside the card's `<m-preview-page>` (a split's dividers and toolbar bands,
// a pane's loader, a theme's pane ring), so its see-through page shows only the card's window; outside the card's page
// the split is drawn as before (under the dim), and once the card's gone, everywhere again. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['material', MATERIAL], ['neubrutalism', NEO], ['pixel', PIXEL], ['default', ARCADIA]] as const;
const script = harnessScript();
const W = 1280, H = 800;
const PAGE_PARTS = ['m-page', 'm-pane', 'm-divider', 'm-band-title', 'm-pane-loader', 'm-pane-spinner', 'm-pane-label'];

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id === 'default' ? 'Margin\'s default card' : id}: a card over a stacked split paints nothing of the page's place in its page, in ${name}`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        const pkg = themeForPage(dir);
        if (id === 'default') pkg.html = pkg.html.replace(/<template m-part="preview">[\s\S]*?<\/template>/, '');
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: pkg, i: id === 'default' ? 'arcadia' : id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', closed: false, appWindow: true, hosted: true }));
        await page.mouse.move(2, H - 2); // (the pointer out of the way: no hover drawn)

        // A stacked split of two web tabs: a band between them (where the lower pane's Safari toolbar rests).
        const tabs = (await ev(() => T.rtTodayIds(2))) as number[];
        assert.ok(await ev((t) => T.rtSplit(t, { axis: 'vertical' }), tabs), 'the split shown');
        await ev(() => T.rtFrames(2));
        const split = await ev(() => T.rtPanes());
        assert.equal(split.dividers.length, 1);
        const band = split.dividers[0];
        assert.ok(band.band && band.height >= 52, `a band between the panes: ${band.height}`);

        // The card up, its window in place (its page see-through).
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', title: 'The Guide', loading: false }));
        await page.waitForTimeout(250); // (its open's animation over)
        await ev(() => T.rtFrames(2));
        const r = (await ev(() => T.rtPeekPage()))!;
        assert.ok(r && r.width > 0 && r.height > 0, 'the card\'s page measured');
        const y = band.top + band.height / 2;
        assert.ok(y > r.y + 4 && y < r.y + r.height - 4, `the band crosses the card's page: band at ${y}, card's page ${JSON.stringify(r)}`);
        const inside = [r.x + r.width * 0.25, r.x + r.width * 0.5, r.x + r.width * 0.75].map((x) => ({ x, y }));
        for (const p of inside) {
          const at = await ev(({ x, y }) => T.rtElementsAt(x, y), p);
          assert.deepEqual(at.filter((n) => PAGE_PARTS.includes(n)), [], `nothing of <m-page> at ${JSON.stringify(p)} in the card's page: ${at.join(' > ')}`);
        }
        // What's painted in the card's page is what the rest of the page paints there, <m-page> or not.
        const clip = { x: Math.round(r.x) + 2, y: Math.round(r.y) + 2, width: Math.round(r.width) - 4, height: Math.round(r.height) - 4 };
        const shot = () => page.screenshot({ clip, animations: 'disabled' });
        const drawn = await shot();
        await ev(() => T.rtPageHidden(true));
        await ev(() => T.rtFrames(2));
        const without = await shot();
        await ev(() => T.rtPageHidden(false));
        await ev(() => T.rtFrames(2));
        assert.ok(drawn.equals(without), 'the card\'s page painted exactly as with no <m-page> at all: no band, divider, grip or pane ring across it');
        // A pane's window opening meanwhile: its loader in its box, never over the card's page.
        await ev((item) => T.rtPaneLoading({ item, name: 'Notes' }), String(tabs[1]));
        await ev(() => T.rtFrames(2));
        assert.equal(await ev(() => T.rtCount('m-pane-loader')), 1, 'the pane\'s loader drawn');
        assert.ok((await shot()).equals(without), 'a pane\'s loader under the card never paints in the card\'s page');
        await ev(() => T.rtPaneLoading(null));
        await ev(() => T.rtFrames(2));
        assert.equal(await ev(() => T.rtCount('m-divider')), 1, 'the divider still there, only cut where the card\'s page is');

        // The card gone: the band takes the pointer across the page again.
        await ev(() => T.rtCard(null));
        await page.waitForTimeout(250);
        await ev(() => T.rtFrames(2));
        const after = await ev(({ x, y }) => T.rtElementsAt(x, y), inside[1]);
        assert.ok(after.includes('m-divider'), `no card: the band where it was: ${after.join(' > ')}`);
        assert.equal(await ev(() => T.rtComputed('m-page', 'clip-path')), 'none', 'and <m-page> not clipped any more');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
