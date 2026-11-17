// The page card's corners Margin.app draws over a hosted app's window (app/platforms/macos/shell/MarginWindow.swift
// HostCorners): the hosted window sits above Margin's window with square corners, so Margin draws, in each corner's
// square of the page area (its inner radius), the colour the theme draws there outside the rounded curve
// (ui/host-app.ts cornerFill, read from computed styles). Checked against what each built-in theme actually paints, on
// screen in Playwright's WebKit and Chromium, headless, every request refused: just outside the curve, inside the page
// area's corner, the theme's own pixel is that colour; inside the curve, the page shows through. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, NEO, PIXEL, themesInScope } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = themesInScope([['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL]] as const);
const script = harnessScript();

// A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced), as [r, g, b].
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
  return (x: number, y: number) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; };
}
// (A computed colour: "rgb(r, g, b)", or "color(srgb r g b)" for a mixed one: Arcadia's ground is the space's colour mixed into a near-white.)
const rgb = (css: string | null) => {
  const mixed = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css ?? '');
  if (mixed) return mixed.slice(1, 4).map((v) => Math.round(Number(v) * 255));
  return (/^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? '') ?? []).slice(1, 4).map(Number);
};
const near = (a: number[], b: number[], within = 3) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= within);

for (const [engineName, engine] of ENGINES) {
  test(`the page card's corners over a hosted window, in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [id, dir] of THEMES) {
        await t.test(`${id}: the colour Margin draws around the page area's rounded corners is the theme's own there`, async () => {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          await context.route('**/*', (route) => route.abort());
          await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
          await page.addScriptTag({ content: script });
          const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
          const loaded = await ev(([p, i]) => T.loadBuiltin(p, i, []), [themeForPage(dir), id] as const);
          assert.equal(loaded.ok, true);
          await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' } }));
          await page.waitForFunction(() => T.rtLayouts().length > 0);
          await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await page.waitForTimeout(350); // (the card's own transitions, as it settles)
          const l = (await ev(() => T.rtLayouts())).at(-1)!;
          const radii = (await ev(() => T.rtRadii())) ?? [];
          const corner = await ev(() => T.rtCornerFill());
          const fills = (corner?.fills ?? []).map((c) => rgb(c)), edge = corner?.edge ? { width: corner.edge.width, color: rgb(corner.edge.color) } : null;
          // (A square card has nothing to draw over the hosted window: no colour needed.)
          if (radii.some((r) => r >= 3)) assert.ok(fills.length === 4 && fills.every((c) => c.length === 3), `${id}: each corner's colour read (${JSON.stringify(corner)})`);
          // (The page's own pixels: what shows through the page area, magenta.)
          await ev(() => { document.documentElement.style.background = '#ff00ff'; document.body.style.background = '#ff00ff'; });
          await page.mouse.move(720, 450);
          await page.waitForTimeout(60);
          const at = decodePng(await page.screenshot());
          const box = { left: l.left, top: l.top, right: 1440 - l.right, bottom: 900 - l.bottom };
          // Each corner: its point of the page area, and the way into the page from it.
          const corners = [[box.left, box.top, 1, 1], [box.right, box.top, -1, 1], [box.right, box.bottom, -1, -1], [box.left, box.bottom, 1, -1]];
          for (const [i, [x, y, dx, dy]] of corners.entries()) {
            const r = radii[i] ?? 0;
            if (r < 3) continue; // (a square corner: nothing drawn over the hosted window there)
            // A pixel on the diagonal, its centre `d` from the curve's centre (r, r in from the corner), outward.
            const pixel = (d: number) => {
              const off = r - d / Math.SQRT2;
              return at(Math.floor(x + dx * off), Math.floor(y + dy * off));
            };
            // What Margin draws there (HostCorners): the page inside the curve, the edge in its band, the fill beyond.
            const fill = fills[i];
            const want = (d: number) => d < r - 1 ? [255, 0, 255] : edge && d > r + 1 && d < r + edge.width - 1 ? edge.color : !edge || d > r + edge.width + 1 ? fill : null;
            for (const d of [r - 2, r + (edge ? edge.width / 2 : 1.5), r * Math.SQRT2 - 0.8]) {
              const w = want(d);
              if (!w || d > r * Math.SQRT2 - 0.5 || d < 0) continue;
              const got = pixel(d);
              // (Arcadia's card casts a soft shadow onto its frame there, left out: up to 10 levels darker at the bottom.)
              assert.ok(near(got, w, 12), `${id} corner ${i} (radius ${r}, ${d.toFixed(1)} from its centre): the theme paints ${got}, Margin draws ${w}`);
            }
          }
          if (id === 'pixel') assert.deepEqual(radii.map((r) => r > 0), [false, false, false, false], 'pixel: a square card, no corners to draw');
          else assert.ok(radii.every((r) => r >= 3), `${id}: rounded corners (${radii})`);
          await context.close();
        });
      }
    } finally {
      await browser.close();
    }
  });
}
