// The page card's state in Margin.app's own window (ui/runtime.ts followPage, ui/host-app.ts pageState; DECISIONS.md
// "Margin's window in front of what it hosts"): Margin's window is in front of the app it hosts, so what each theme
// paints in and around the page's place is what's seen over that app. Checked on each built-in theme's own pixels, in
// Playwright's WebKit and Chromium, headless, every request refused, the page behind see-through (a screenshot with
// no background: its alpha is what the hosted window would show through):
// - `shown`: nothing painted in the page's place (alpha 0 across it, up to each edge and inside each rounded corner),
//   the theme's frame and the corners outside the curve painted (over the app), the rest of the window painted;
// - `loading`: the page card opaque, the theme's own loader in it with Margin's words, taking the pointer; back to
//   `shown` it's gone in at most 150 ms and the place is see-through again (each theme's own look, its motion and its
//   start-up skeleton: its own test file, through page-card.ts);
// - `empty`: the launcher, opaque;
// - a theme with no `page-loader` part gets Margin's default loader: over the page's place exactly, with its words,
//   fading out in at most 150 ms (at once with reduced motion);
// - a theme's own `page-loader` part in its `<m-page-loader>` is drawn instead of the default.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, NEO, PIXEL, GLASS, themesInScope } from './package.ts';
import { decodePng, cardPoints, px, W, H, APPS, ICONS } from './page-card.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = themesInScope([['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL], ['liquid-glass', GLASS]] as const);
const script = harnessScript();

// A built-in theme without its own loader: its `page-loader` part and its `<m-page-loader>` taken out (Margin's default then).
const withoutLoader = (dir: string) => {
  const pkg = themeForPage(dir);
  const html = pkg.html.replace(/<template m-part="page-loader">[\s\S]*?<\/template>/, '').replace(/<m-page-loader[^>]*><\/m-page-loader>/, '');
  assert.ok(html.length < pkg.html.length && !html.includes('m-page-loader') && !html.includes('m-part="page-loader"'), 'the part and its slot taken out');
  return { ...pkg, html };
};

for (const [engineName, engine] of ENGINES) {
  test(`the page card's state in Margin's own window, in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [id, dir] of THEMES) {
        await t.test(`${id}: shown is a hole with the frame and corners drawn around it; loading is opaque with the theme's loader; empty is the launcher`, async () => {
          const context = await browser.newContext({ viewport: { width: W, height: H } });
          const page = await context.newPage();
          await context.route('**/*', (route) => route.abort());
          await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
          await page.addScriptTag({ content: script });
          const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
          const loaded = await ev(([p, i]) => T.loadBuiltin(p, i, []), [themeForPage(dir), id] as const);
          assert.equal(loaded.ok, true);
          await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, hosted: true }));
          await page.waitForFunction(() => T.rtLayouts().length > 0);
          await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await page.waitForTimeout(350); // (the card's own transitions, as it settles)
          await page.mouse.move(40, 450); // (over the sidebar: nothing of the theme's hover over the page's place)
          const l = (await ev(() => T.rtLayouts())).at(-1)!;
          const radii = (await ev(() => T.rtRadii())) ?? [];
          const box = { left: l.left, top: l.top, right: W - l.right, bottom: H - l.bottom };
          const shot = async () => decodePng(await page.screenshot({ omitBackground: true }));
          // Points of the page's place: a grid across it, just inside each edge, and just inside each rounded corner's curve.
          const { inside, onDiagonal } = cardPoints(box, radii);

          // ---- shown: the hole ----
          const first = await ev(() => T.rtPageState('shown'));
          assert.equal(first.attr, 'shown', `${id}: the root says shown`);
          assert.deepEqual(first.loader, { own: true, text: '' }, `${id}: the theme's own slot for its loader, empty (no default loader of Margin's)`);
          let at = await shot();
          const painted = inside.filter((p) => px(at, p)[3] !== 0);
          assert.deepEqual(painted, [], `${id}: shown: nothing painted in the page's place (alpha 0 at ${inside.length} points)`);
          // The frame around it: the nearest point outside each edge that the theme paints is within its frame (a
          // border, a gutter), and the whole window outside the page's place is painted.
          const ring: [number, number][] = [];
          for (const f of [0.25, 0.5, 0.75]) {
            const x = box.left + (box.right - box.left) * f, y = box.top + (box.bottom - box.top) * f;
            if (box.top >= 2) ring.push([x, box.top - 1.5]);
            if (H - box.bottom >= 2) ring.push([x, box.bottom + 0.5]);
            if (box.left >= 2) ring.push([box.left - 1.5, y]);
            if (W - box.right >= 2) ring.push([box.right + 0.5, y]);
          }
          const openRing = ring.filter((p) => px(at, p)[3] < 250);
          assert.deepEqual(openRing, [], `${id}: shown: the frame around the page's place is painted, over the app`);
          for (let i = 0; i < 4; i++) {
            const r = radii[i] ?? 0;
            if (r < 3) continue;
            const outside = px(at, onDiagonal(i, r * Math.SQRT2 - 0.8));
            assert.ok(outside[3] >= 250, `${id}: shown: corner ${i} (radius ${r}): painted outside its curve (alpha ${outside[3]}), over the app's square corner`);
          }
          const outsidePoints: [number, number][] = [];
          for (let x = 4; x < W; x += 61) for (let y = 4; y < H; y += 53) if (x < box.left - 1 || x > box.right + 1 || y < box.top - 1 || y > box.bottom + 1) outsidePoints.push([x, y]);
          const seeThrough = outsidePoints.filter((p) => px(at, p)[3] < 250);
          assert.deepEqual(seeThrough, [], `${id}: shown: nothing of the window see-through outside the page's place (${outsidePoints.length} points)`);
          const paints = await ev(() => T.rtAt(900, 450));
          assert.ok(paints != null, `${id}: the page's place read`);

          // ---- loading: the card opaque, the theme's own loader ----
          const loading = await ev(() => T.rtPageState('loading', 'Safari'));
          assert.deepEqual([loading.attr, loading.loader?.own, loading.loader?.text.trim()], ['loading', true, 'Opening Safari…'], `${id}: loading: the root says so, the theme's own loader with Margin's words`);
          const lo = (await ev(() => T.rtLoader()))!;
          assert.ok(Math.abs(lo.left - box.left) <= 0.5 && Math.abs(lo.top - box.top) <= 0.5 && Math.abs(lo.width - (box.right - box.left)) <= 0.5 && Math.abs(lo.height - (box.bottom - box.top)) <= 0.5,
            `${id}: loading: the loader over the page's place exactly (${JSON.stringify(lo)} vs ${JSON.stringify(box)})`);
          assert.deepEqual([lo.opacity, lo.visibility, lo.pointer, parseFloat(lo.radius)], [1, 'visible', 'auto', radii[0] ?? 0], `${id}: loading: drawn at once, taking the pointer, the card's corners`);
          at = await shot();
          const open = inside.filter((p) => px(at, p)[3] < 250);
          assert.deepEqual(open, [], `${id}: loading: the page card opaque everywhere (whatever opens behind it isn't seen)`);
          assert.equal(await ev(() => document.elementsFromPoint(900, 450).length > 0), true);
          const renamed = await ev(() => T.rtPageState('loading', 'Notes'));
          assert.equal(renamed.loader?.text.trim(), 'Opening Notes…', `${id}: another item opening: its name`);

          // ---- back to shown: faded out within 150 ms, the hole again ----
          await ev(() => T.rtPageState('shown'));
          const fading = (await ev(() => T.rtLoader()))!;
          assert.ok(fading.pointer === 'none' && parseFloat(fading.transition) <= 0.15 && parseFloat(fading.transition) > 0, `${id}: shown again: the card lets the pointer through at once and fades in at most 150 ms (${fading.transition})`);
          await page.waitForTimeout(260);
          const gone = (await ev(() => T.rtLoader()))!;
          assert.deepEqual([gone.opacity, gone.visibility], [0, 'hidden'], `${id}: … and it's gone`);
          at = await shot();
          assert.deepEqual(inside.filter((p) => px(at, p)[3] !== 0), [], `${id}: shown again: nothing painted in the page's place`);

          // ---- loading again (a placing again, the next first open): opaque again at once, no fade in ----
          await ev(() => T.rtPageState('loading', 'Safari'));
          const back = (await ev(() => T.rtLoader()))!;
          assert.deepEqual([back.opacity, back.visibility, back.pointer], [1, 'visible', 'auto'], `${id}: loading again: the loader back at once`);
          await page.waitForTimeout(60);
          at = await shot();
          assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], `${id}: loading again: the page card opaque again`);
          await ev(() => T.rtPageState('shown'));
          await page.waitForTimeout(260);

          // ---- empty: the launcher, opaque ----
          const empty = await ev(() => T.rtPageState('empty'));
          assert.equal(empty.attr, 'empty');
          await page.waitForTimeout(300);
          at = await shot();
          assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], `${id}: empty: the launcher over the page's place, opaque`);
          assert.equal(await ev(() => T.rtShown('.launcher')), true, `${id}: empty: the launcher drawn`);
          await context.close();
        });
      }

      await t.test("a theme with no page-loader part: Margin's default loader, over the page's place exactly with its words, fading out in at most 150 ms", async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        const loaded = await ev(([p, i]) => T.loadBuiltin(p, i, []), [withoutLoader(ARCADIA), 'arcadia'] as const);
        assert.equal(loaded.ok, true);
        await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, hosted: true }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.waitForTimeout(350);
        await page.mouse.move(40, 450);
        const l = (await ev(() => T.rtLayouts())).at(-1)!;
        const radii = (await ev(() => T.rtRadii())) ?? [];
        const box = { left: l.left, top: l.top, right: W - l.right, bottom: H - l.bottom };
        const { inside } = cardPoints(box, radii);
        const shot = async () => decodePng(await page.screenshot({ omitBackground: true }));
        const first = await ev(() => T.rtPageState('shown'));
        assert.deepEqual([first.attr, first.loader], ['shown', null], 'shown: no loader in the tree until one is needed');
        const loading = await ev(() => T.rtPageState('loading', 'Safari'));
        assert.deepEqual([loading.attr, loading.loader], ['loading', { own: false, text: 'Opening Safari…' }], "loading: Margin's default loader with its words");
        const lo = (await ev(() => T.rtLoader()))!;
        assert.ok(Math.abs(lo.left - box.left) <= 0.5 && Math.abs(lo.top - box.top) <= 0.5 && Math.abs(lo.width - (box.right - box.left)) <= 0.5 && Math.abs(lo.height - (box.bottom - box.top)) <= 0.5,
          `loading: the loader over the page's place exactly (${JSON.stringify(lo)} vs ${JSON.stringify(box)})`);
        assert.deepEqual([lo.opacity, lo.visibility, lo.pointer, parseFloat(lo.radius)], [1, 'visible', 'auto', radii[0] ?? 0], "loading: drawn at once, taking the pointer, the card's corners");
        let at = await shot();
        assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], 'loading: the page card opaque everywhere');
        assert.equal((await ev(() => T.rtPageState('loading', 'Notes'))).loader?.text, 'Opening Notes…', 'another item opening: its name');
        await ev((apps) => T.rtApps(apps), APPS);
        await ev(() => T.rtPageState('loading', 'Notes', 'com.apple.Notes'));
        const icons = (await ev(() => T.rtLoaderIcons())).filter((i) => i.visible);
        assert.deepEqual(icons.map((i) => [i.src === ICONS.notes, i.complete, i.natural, i.size]), [[true, true, [64, 64], [32, 32]]], "the opening app's icon over the spinner, 32 px");
        await ev(() => T.rtPageState('loading', 'Example', 'com.apple.Safari'));
        assert.deepEqual((await ev(() => T.rtLoaderIcons())).filter((i) => i.visible).map((i) => i.src === ICONS.safari), [true], "a web item: Safari's icon");
        await ev(() => T.rtPageState('loading', 'Something', 'com.example.Gone'));
        assert.deepEqual((await ev(() => T.rtLoaderIcons())).filter((i) => i.visible), [], 'an app not installed: no icon, the spinner and the words');
        await ev(() => T.rtPageState('shown'));
        const fading = (await ev(() => T.rtLoader()))!;
        assert.ok(fading.pointer === 'none' && parseFloat(fading.transition) <= 0.15 && parseFloat(fading.transition) > 0, `shown again: the loader lets the pointer through at once and fades in at most 150 ms (${fading.transition})`);
        await page.waitForTimeout(260);
        const gone = (await ev(() => T.rtLoader()))!;
        assert.deepEqual([gone.opacity, gone.visibility], [0, 'hidden'], "… and it's gone");
        at = await shot();
        assert.deepEqual(inside.filter((p) => px(at, p)[3] !== 0), [], "shown again: nothing painted in the page's place");
        await ev(() => T.rtPageState('loading', 'Safari'));
        const back = (await ev(() => T.rtLoader()))!;
        assert.deepEqual([back.opacity, back.visibility, back.pointer], [1, 'visible', 'auto'], 'loading again: the loader back at once');
        await page.waitForTimeout(60);
        at = await shot();
        assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], 'loading again: the page card opaque again');
        await context.close();
      });

      await t.test("reduced motion: Margin's default loader goes at once, and its spinner stands still", async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        await ev(([p, i]) => T.loadBuiltin(p, i, []), [withoutLoader(ARCADIA), 'arcadia'] as const);
        await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, hosted: true }));
        await ev(() => T.rtPageState('loading', 'Safari'));
        const spin = await ev(() => getComputedStyle((window as any).__rt.runtime.view.rootElement().querySelector('[m-loader-spin]')).animationName);
        assert.equal(spin, 'none');
        await ev(() => T.rtPageState('shown'));
        const lo = (await ev(() => T.rtLoader()))!;
        assert.deepEqual([lo.opacity, lo.visibility, parseFloat(lo.transition)], [0, 'hidden', 0]);
        await context.close();
      });

      await t.test("a theme's own page-loader part, in its <m-page-loader>: drawn instead of Margin's default, with Margin's words only", async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        const pkg = themeForPage(NEO);
        // (Neubrutalism's own part, with words of the theme's own written into it.)
        const own = '<template m-part="page-loader"><div class="own-card"><span class="own-dot"></span><b class="own-words">{{pageLoader.label}}</b><i>Not the theme\'s to say</i></div></template>';
        const html = pkg.html.replace(/<template m-part="page-loader">[\s\S]*?<\/template>/, own);
        assert.ok(html.includes(own) && html.split('<m-page-loader').length === 2, 'one slot, the part swapped');
        pkg.html = html;
        const loaded = await ev(([p]) => T.loadBuiltin(p, 'neubrutalism', []), [pkg] as const);
        assert.equal(loaded.ok, true);
        await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, hosted: true }));
        const shown = await ev(() => T.rtPageState('shown'));
        assert.deepEqual([shown.attr, shown.loader], ['shown', { own: true, text: '' }], 'shown: its slot there, empty');
        const loading = await ev(() => T.rtPageState('loading', 'Maps'));
        assert.deepEqual(loading.loader, { own: true, text: 'Opening Maps…' }, "loading: the theme's part with Margin's label; the theme's own words dropped");
        assert.equal(await ev(() => (window as any).__rt.runtime.view.rootElement().querySelectorAll('m-page-loader').length), 1, "no default loader beside the theme's");
        await context.close();
      });

      await t.test('m-starting: on the root from its first frame until the state\'s data is drawn; never when the data is there at the first draw', async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        await ev(([p, i]) => T.loadBuiltin(p, i, []), [themeForPage(ARCADIA), 'arcadia'] as const);
        await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, appWindow: true }));
        assert.equal(await ev(() => (window as any).__rt.runtime.view.rootElement().hasAttribute('m-starting')), false, 'the data there at the first draw: never starting');
        const late = await ev(() => T.rtStartLate());
        assert.deepEqual(late, { before: true, drawn: true, after: false }, 'no data at the first draw: starting until a frame after it is drawn');
        await context.close();
      });
    } finally {
      await browser.close();
    }
  });
}
