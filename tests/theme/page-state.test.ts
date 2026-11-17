// The page card's state in Margin.app's own window (ui/runtime.ts followPage, ui/host-app.ts pageState; DECISIONS.md
// "Margin's window in front of what it hosts"): Margin's window is in front of the app it hosts, so what each theme
// paints in and around the page's place is what's seen over that app. Checked on each built-in theme's own pixels, in
// Playwright's WebKit and Chromium, headless, every request refused, the page behind see-through (a screenshot with
// no background: its alpha is what the hosted window would show through):
// - `shown`: nothing painted in the page's place (alpha 0 across it, up to each edge and inside each rounded corner),
//   the theme's frame and the corners outside the curve painted (over the app), the rest of the window painted;
// - `loading`: the page card opaque, Margin's default loader over the page's place with its words, taking the pointer;
//   back to `shown` it fades out in at most 150 ms (at once with reduced motion) and the place is see-through again;
// - `empty`: the launcher, opaque;
// - a theme's own `page-loader` part in its `<m-page-loader>` is drawn instead of the default.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, NEO, PIXEL, GLASS, themesInScope } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = themesInScope([['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL], ['liquid-glass', GLASS]] as const);
const script = harnessScript();

// A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced), as [r, g, b, a].
function decodePng(buf: Buffer) {
  let at = 8, width = 0, height = 0, type = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; } else if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return (x: number, y: number) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255]; };
}

const W = 1440, H = 900;

for (const [engineName, engine] of ENGINES) {
  test(`the page card's state in Margin's own window, in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [id, dir] of THEMES) {
        await t.test(`${id}: shown is a hole with the frame and corners drawn around it; loading is opaque with Margin's loader; empty is the launcher`, async () => {
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
          const inside: [number, number][] = [];
          for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) inside.push([box.left + ((box.right - box.left) * i) / 8, box.top + ((box.bottom - box.top) * j) / 8]);
          for (const f of [0.2, 0.5, 0.8]) {
            const x = box.left + (box.right - box.left) * f, y = box.top + (box.bottom - box.top) * f;
            inside.push([x, box.top + 1.5], [x, box.bottom - 2.5], [box.left + 1.5, y], [box.right - 2.5, y]);
          }
          const corners = [[box.left, box.top, 1, 1], [box.right, box.top, -1, 1], [box.right, box.bottom, -1, -1], [box.left, box.bottom, 1, -1]];
          // A point on a corner's diagonal, its centre `d` from the curve's centre (r, r in from the corner), outward.
          const onDiagonal = (i: number, d: number): [number, number] => {
            const [x, y, dx, dy] = corners[i];
            const off = (radii[i] ?? 0) - d / Math.SQRT2;
            return [x + dx * off, y + dy * off];
          };
          for (let i = 0; i < 4; i++) if ((radii[i] ?? 0) >= 3) inside.push(onDiagonal(i, radii[i] - 2));
          const px = (at: ReturnType<typeof decodePng>, [x, y]: [number, number]) => at(Math.floor(x), Math.floor(y));

          // ---- shown: the hole ----
          const first = await ev(() => T.rtPageState('shown'));
          assert.equal(first.attr, 'shown', `${id}: the root says shown`);
          assert.equal(first.loader, null, `${id}: no loader in the tree until one is needed`);
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

          // ---- loading: the card opaque, Margin's default loader ----
          const loading = await ev(() => T.rtPageState('loading', 'Safari'));
          assert.deepEqual([loading.attr, loading.loader], ['loading', { own: false, text: 'Opening Safari…' }], `${id}: loading: the root says so, Margin's default loader with its words`);
          const lo = (await ev(() => T.rtLoader()))!;
          assert.ok(Math.abs(lo.left - box.left) <= 0.5 && Math.abs(lo.top - box.top) <= 0.5 && Math.abs(lo.width - (box.right - box.left)) <= 0.5 && Math.abs(lo.height - (box.bottom - box.top)) <= 0.5,
            `${id}: loading: the loader over the page's place exactly (${JSON.stringify(lo)} vs ${JSON.stringify(box)})`);
          assert.deepEqual([lo.opacity, lo.visibility, lo.pointer, parseFloat(lo.radius)], [1, 'visible', 'auto', radii[0] ?? 0], `${id}: loading: drawn at once, taking the pointer, the card's corners`);
          at = await shot();
          const open = inside.filter((p) => px(at, p)[3] < 250);
          assert.deepEqual(open, [], `${id}: loading: the page card opaque everywhere (whatever opens behind it isn't seen)`);
          assert.equal(await ev(() => document.elementsFromPoint(900, 450).length > 0), true);
          const renamed = await ev(() => T.rtPageState('loading', 'Notes'));
          assert.equal(renamed.loader?.text, 'Opening Notes…', `${id}: another item opening: its name`);

          // ---- back to shown: faded out within 150 ms, the hole again ----
          await ev(() => T.rtPageState('shown'));
          const fading = (await ev(() => T.rtLoader()))!;
          assert.ok(fading.pointer === 'none' && parseFloat(fading.transition) <= 0.15 && parseFloat(fading.transition) > 0, `${id}: shown again: the loader lets the pointer through at once and fades in at most 150 ms (${fading.transition})`);
          await page.waitForTimeout(260);
          const gone = (await ev(() => T.rtLoader()))!;
          assert.deepEqual([gone.opacity, gone.visibility], [0, 'hidden'], `${id}: … and it's gone`);
          at = await shot();
          assert.deepEqual(inside.filter((p) => px(at, p)[3] !== 0), [], `${id}: shown again: nothing painted in the page's place`);

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

      await t.test('reduced motion: the loader goes at once, and its spinner stands still', async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        await ev(([p, i]) => T.loadBuiltin(p, i, []), [themeForPage(ARCADIA), 'arcadia'] as const);
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
        pkg.html = pkg.html.replace('<m-page class="page"></m-page>', '<m-page class="page"></m-page><m-page-loader class="own-loader"></m-page-loader>'
          + '<template m-part="page-loader"><div class="own-card"><span class="own-dot"></span><b class="own-words">{{pageLoader.label}}</b><i>Not the theme\'s to say</i></div></template>');
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
