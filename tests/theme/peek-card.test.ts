// Peek's card and Little Arc (docs/PEEK-SPLIT.md §2, §3) in all five built-in themes and Margin's default card (a
// theme with no `peek` part), in real engines (Playwright's WebKit and Chromium, headless, every network request
// refused), drawn from Margin.app's `peek` word as the overlay passes it on (ui/behaviors/card.ts): the page area
// dimmed around the card, its `<m-peek-page>` where the card's window goes (measured as laid out, centred with 8% and
// 7% margins at least 420×320 under a bar), covered while it loads and clear once it's in place, never the pointer's
// then; the bar's buttons sending their requests; the open and close in 150 ms (transform and opacity; a fade with
// Reduce Motion); Little Arc's field taking an address or a search; light and dark. `npm run test:theme`.
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

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id === 'default' ? 'Margin\'s default card (a theme with no peek part)' : id}: Peek's card and Little Arc in ${name}`, async () => {
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
        if (id === 'default') pkg.html = pkg.html.replace(/<template m-part="peek">[\s\S]*?<\/template>/, '');
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: pkg, i: id === 'default' ? 'arcadia' : id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', closed: false, appWindow: true, hosted: true }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const L = (await ev(() => T.rtLayouts())).at(-1)!;
        const pageArea = { x: L.left, y: L.top, width: W - L.left - L.right, height: H - L.top - L.bottom };
        const slot = id === 'default' ? 'm-peek[m-default]' : '.peek-backdrop';
        const card = id === 'default' ? '[m-peek-card]' : '.peek-card';
        const bar = id === 'default' ? '[m-peek-bar]' : '.peek-bar';
        // (A theme's buttons by what they say: Margin's labels; Expand by its look, the bar's one primary button.)
        const LABELS: Record<string, string> = { 'peek.back': 'Back', 'peek.forward': 'Forward', 'peek.copyUrl': 'Copy URL', 'peek.close': 'Close' };
        const button = (action: string) => (id === 'default' ? `[m-peek-button="${action}"]` : action === 'peek.expand' ? '.peek-bar .primary' : `.peek-bar [aria-label="${LABELS[action]}"]`);
        assert.equal(await ev(() => T.rtCount('m-peek-page')), 0, 'no card: nothing drawn');

        // Peek: the app's word, its window not in place yet.
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', title: 'The Guide', loading: true }));
        await ev(() => T.rtFrames(2));
        assert.equal(await ev((s) => T.rtCount(s), slot), 1, 'the card drawn');
        assert.deepEqual(await ev(() => T.rtPeekVm()), { loading: true, ready: false, closing: false, littleArc: false, host: 'docs.example.org', url: 'https://docs.example.org/guide' });
        assert.ok((await ev(() => T.rtText('*'))).some((t) => t.includes('docs.example.org')), 'its address in the bar');
        // Where the card's window goes: centred in the page area, 8% each side and 7% above and below at most, a bar over it.
        await page.waitForTimeout(200); // (its open's animation over: measured as laid out either way)
        const r = (await ev(() => T.rtPeekPage()))!;
        assert.ok(r, 'the card\'s page measured ' + JSON.stringify([await ev(() => T.rtCount('m-peek-page')), await ev(() => T.rtRect('m-peek-page')), await ev(() => T.rtComputed('m-peek-page', 'display')), await ev(() => T.rtCount('.peek-backdrop'))]));
        const cardBox = (await ev((s) => T.rtRect(s), card))!;
        const barBox = (await ev((s) => T.rtRect(s), bar))!;
        const near = (a: number, b: number, d = 3) => Math.abs(a - b) <= d;
        assert.ok(near(r.x - pageArea.x, pageArea.x + pageArea.width - (r.x + r.width), 2), `centred across the page area: ${JSON.stringify({ r, pageArea, slot: await ev(() => T.rtRect('.peek-slot, m-peek')), pg: await ev(() => T.rtRect('m-page')), card: await ev((c) => T.rtRect(c), card), L: (await ev(() => T.rtLayouts())).at(-1) })}`);
        assert.ok(near(cardBox.left - pageArea.x, Math.round(pageArea.width * 0.08), 4), `8% beside it: ${cardBox.left - pageArea.x} of ${pageArea.width}`);
        assert.ok(near(cardBox.top - pageArea.y, Math.round(pageArea.height * 0.07), 4), `7% above it: ${cardBox.top - pageArea.y} of ${pageArea.height}`);
        assert.ok(r.width >= 420 && r.height >= 320 - 60, `at least 420 wide: ${JSON.stringify(r)}`);
        assert.ok(barBox.bottom <= r.y + 1 && barBox.height >= 40 && barBox.height <= 56, `the bar above the card's page: ${JSON.stringify({ barBox, r })}`);
        assert.ok(r.x >= pageArea.x && r.y >= pageArea.y && r.x + r.width <= pageArea.x + pageArea.width && r.y + r.height <= pageArea.y + pageArea.height, 'inside the page area');
        // Loading: its page covered (opaque), taking the pointer (nothing reaches main under the dim meanwhile).
        const cover = await ev(() => T.rtComputed('m-peek-page', 'background-color'));
        assert.notEqual(cover, 'rgba(0, 0, 0, 0)', `covered while it loads: ${cover}`);
        assert.equal(await ev(() => T.rtComputed('m-peek-page', 'pointer-events')), 'auto');

        // Its window in place: the card's page clear, the pointer through it (Margin.app's hole), the bar the theme's.
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', title: 'The Guide', loading: false }));
        await ev(() => T.rtFrames(2));
        assert.equal((await ev(() => T.rtPeekVm()))!.ready, true);
        assert.equal(await ev(() => T.rtComputed('m-peek-page', 'background-color')), 'rgba(0, 0, 0, 0)', 'clear: the card\'s window shows through');
        assert.equal(await ev(() => T.rtComputed('m-peek-page', 'pointer-events')), 'none', 'never the theme\'s: a click there is the page\'s');
        assert.equal(await ev((s) => T.rtComputed(s, 'pointer-events'), bar), 'auto', 'the bar takes the pointer');
        // The page area around the card: dimmed (main shows through, darker), the dim never taking the pointer now.
        if (id !== 'default') {
          const dim = await ev(() => T.rtComputed('.peek-dim', 'box-shadow'));
          assert.match(dim ?? '', /(rgba?|color)\(.*\b\d{3,}px/, `the dim: ${dim}`);
          assert.equal(await ev(() => T.rtComputed('.peek-backdrop > button', 'pointer-events')), 'none', 'the scrim never the pointer\'s once the window is in place');
        }
        const sizeAgain = (await ev(() => T.rtPeekPage()))!;
        assert.deepEqual([sizeAgain.x, sizeAgain.y, sizeAgain.width, sizeAgain.height], [r.x, r.y, r.width, r.height], 'the same place, ready or not');

        // The open's motion: 150 ms, a scale and a fade (compositor only).
        const anim = await ev((s) => [T.rtComputed(s, 'animation-name'), T.rtComputed(s, 'animation-duration')], card);
        assert.match(String(anim[0]), /peek-in$/, `the card comes in: ${anim[0]}`);
        assert.equal(anim[1], '0.15s');

        // Its buttons, really pressed (once its open's motion is over: never a scaled button's place).
        const press = async (sel: string) => { await page.waitForTimeout(180); const b = (await ev((s) => T.rtRect(s), sel))!; await page.mouse.click(b.x, b.y); };
        const before = (await ev(() => T.rtPerformedFull())).length;
        await press(button('peek.back'));
        await press(button('peek.forward'));
        await press(button('peek.copyUrl'));
        const done = (await ev(() => T.rtPerformedFull())).slice(before);
        assert.deepEqual(done.map(([n]) => n), ['peek.back', 'peek.forward', 'copyUrl'], JSON.stringify(done));
        assert.deepEqual(done[2][1], { url: 'https://docs.example.org/guide' });
        await press(button('peek.expand'));
        const expand = (await ev(() => T.rtPerformedFull())).at(-1)!;
        assert.equal(expand[0], 'peek.expand');
        assert.equal((await ev(() => T.rtPeekVm()))!.closing, true, 'expanded: the card goes (its window covered first)');
        await page.waitForTimeout(220);
        assert.equal(await ev((s) => T.rtCount(s), slot), 0, 'gone after its close');

        // Close: the reverse of the open, then gone; the app told.
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', loading: false }));
        await ev(() => T.rtFrames(2));
        await press(button('peek.close'));
        assert.equal((await ev(() => T.rtPerformedFull())).at(-1)![0], 'peek.close');
        assert.match(String(await ev((s) => T.rtComputed(s, 'animation-name'), card)), /peek-out$/);
        assert.notEqual(await ev(() => T.rtComputed('m-peek-page', 'background-color')), 'rgba(0, 0, 0, 0)', 'covered as it goes');
        await page.waitForTimeout(220);
        assert.equal(await ev((s) => T.rtCount(s), slot), 0);
        // The app closing it (its null): the same, nothing asked of the app.
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', loading: false }));
        const asked = (await ev(() => T.rtPerformedFull())).length;
        await ev(() => T.rtCard(null));
        await page.waitForTimeout(220);
        assert.equal(await ev((s) => T.rtCount(s), slot), 0);
        assert.equal((await ev(() => T.rtPerformedFull())).length, asked, 'the app\'s own close isn\'t sent back');

        // Esc in Margin's UI closes it; ⌘↩ expands it.
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', loading: false }));
        await ev(() => T.rtFrames(2));
        await press(bar);
        await page.keyboard.press('Meta+Enter');
        assert.equal((await ev(() => T.rtPerformedFull())).at(-1)![0], 'peek.expand');
        await page.waitForTimeout(220);
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', loading: false }));
        await ev(() => T.rtFrames(2));
        await press(bar);
        await page.keyboard.press('Escape');
        assert.equal((await ev(() => T.rtPerformedFull())).at(-1)![0], 'peek.close');
        await page.waitForTimeout(220);

        // Little Arc: Margin's field, no page yet; an address taken as the palette takes it.
        await ev(() => T.rtDispatch('littleArc.open'));
        await ev(() => T.rtFrames(2));
        assert.equal((await ev(() => T.rtPerformedFull())).at(-1)![0], 'peek.littleArc');
        assert.equal((await ev(() => T.rtPeekVm()))!.littleArc, true);
        assert.equal(await ev(() => T.rtPeekPage()), null, 'no card page yet: nothing for a window');
        if (id !== 'default') assert.equal(await ev(() => T.rtActive()), 'peek', 'its field has the keys');
        await page.keyboard.type('example.org');
        await page.keyboard.press('Enter');
        const go = (await ev(() => T.rtPerformedFull())).at(-1)!;
        assert.deepEqual(go, ['peek.go', { url: 'https://example.org', spaceId: go[1]?.spaceId ?? null }]);
        assert.deepEqual((await ev(() => T.rtPeekVm()))!.loading, true, 'then Peek: its card loading');
        assert.ok(await ev(() => T.rtPeekPage()), 'its page measured for the window');
        await ev(() => T.rtCard(null));
        await page.waitForTimeout(220);
        // A search; Escape closes it.
        await ev(() => T.rtDispatch('littleArc.open'));
        await ev(() => T.rtFrames(2));
        await page.keyboard.type('margin themes');
        await page.keyboard.press('Enter');
        assert.deepEqual((await ev(() => T.rtPerformedFull())).at(-1)![1]?.query, 'margin themes');
        await ev(() => T.rtCard(null));
        await page.waitForTimeout(220);
        await ev(() => T.rtDispatch('littleArc.open'));
        await ev(() => T.rtFrames(2));
        await page.keyboard.press('Escape');
        assert.equal((await ev(() => T.rtPerformedFull())).at(-1)![0], 'peek.close');
        await page.waitForTimeout(220);
        assert.equal(await ev((s) => T.rtCount(s), slot), 0);

        // Reduce Motion: a fade only. Dark: drawn too, its dim deeper.
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
        await ev(() => T.rtCard({ url: 'https://docs.example.org/guide', loading: false }));
        await ev(() => T.rtFrames(2));
        assert.match(String(await ev((s) => T.rtComputed(s, 'animation-name'), card)), /peek-fade-in$/, 'Reduce Motion: no scale');
        assert.equal(await ev((s) => T.rtVisible(s), bar), true, 'dark: the bar drawn');
        assert.deepEqual(errors, []);
        assert.deepEqual(await ev(() => T.rtWarnings()), []);
      } finally {
        await browser.close();
      }
    });
  }
}
