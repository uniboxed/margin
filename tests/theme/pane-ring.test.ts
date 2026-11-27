// The focused pane's ring reads as "typing goes here" in all five built-in themes, light and dark, in real engines
// (Playwright's WebKit and Chromium, headless, every network request refused). Every pane of a split draws active since
// 2026-11-21 (Margin.app's PanesActive.swift: each pane's app keeps its active look, its caret and selection), so the
// ring Margin draws in the gap around the focused pane is what says where the keys go: on the focused pane only, at
// least 2 px wide, and its outer edge at least 3:1 against the gap it's drawn over (WCAG 2.1's 1.4.11, non-text
// contrast), its alpha composited over the gap's colour (Arcadia's frame takes the space's colour: an accent ring alone
// fell to 1.9:1 there, so its ring has an edge in the frame's own text colour). `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['material', MATERIAL], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;
const script = harnessScript();

// WCAG's relative luminance and contrast ratio, of sRGB 0-255.
const lum = ([r, g, b]: number[]) => {
  const c = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: the focused pane's ring says where the keys go, light and dark, in ${name}`, async () => {
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
        const tabs = (await ev(() => T.rtTodayIds(2))) as number[];
        assert.ok(await ev((t) => T.rtSplit(t), tabs.slice(0, 2)), 'a split of two');
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await frames();
          // The ring's first shadow's colour and width, the gap's colour (the divider's), each made sRGB by a canvas.
          const look = await ev(() => {
            const rgba = (c: string) => {
              const cv = document.createElement('canvas');
              cv.width = cv.height = 1;
              const x = cv.getContext('2d')!;
              x.clearRect(0, 0, 1, 1);
              x.fillStyle = '#000';
              x.fillStyle = c;
              x.fillRect(0, 0, 1, 1);
              return [...x.getImageData(0, 0, 1, 1).data];
            };
            const p = T.rtPanes();
            const focused = p.panes.find((x) => x.focused);
            const shadow = focused?.ring ?? 'none';
            // (Each shadow of the ring: split at the commas between them, never inside a colour's parentheses.)
            const parts: string[] = [];
            let depth = 0, from = 0;
            for (let i = 0; i < shadow.length; i++) {
              if (shadow[i] === '(') depth++;
              else if (shadow[i] === ')') depth--;
              else if (shadow[i] === ',' && depth === 0) { parts.push(shadow.slice(from, i)); from = i + 1; }
            }
            parts.push(shadow.slice(from));
            const rings = parts.map((part) => {
              const color = /(rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-f]{3,8})/i.exec(part)?.[1] ?? null;
              const lengths = [...part.replace(color ?? '', '').matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
              return { color: color ? rgba(color) : null, spread: Math.max(lengths[3] ?? 0, ...lengths.slice(0, 2).map(Math.abs)) };
            }).filter((r) => r.color && r.spread > 0);
            return {
              shadow,
              rings,
              gap: p.dividers[0] ? rgba(p.dividers[0].background) : null,
              others: p.panes.filter((x) => x !== focused).map((x) => x.ring),
            };
          });
          assert.ok(look.rings.length && look.gap, `${scheme}: a ring and a gap: ${JSON.stringify(look)}`);
          // (An unfocused pane has its own card's edge since 2026-11-27, never the focused one's ring.)
          assert.ok(look.others.every((s) => s !== look.shadow), `${scheme}: the ring on the focused pane only: ${look.others}`);
          assert.ok(Math.max(...look.rings.map((r) => r.spread)) >= 2, `${scheme}: the ring at least 2 px wide: ${look.shadow}`);
          const gap = look.gap!;
          assert.equal(gap[3], 255, `${scheme}: the gap is opaque (the ring is measured over it): ${gap}`);
          // (Its outer edge meets the gap: the shadow with the widest spread, at least 3:1 against the gap, its alpha
          // composited over it, and at least 1 px of its own beyond the rest of the ring.)
          const edge = look.rings.reduce((a, b) => (b.spread > a.spread ? b : a));
          const a = edge.color![3] / 255;
          const drawn = [0, 1, 2].map((i) => edge.color![i] * a + gap[i] * (1 - a));
          const r = ratio(drawn, gap);
          assert.ok(r >= 3, `${scheme}: the ring's edge against the gap at least 3:1, got ${r.toFixed(2)} (${look.shadow} over rgb(${gap.slice(0, 3)}))`);
          assert.ok(new Set(look.rings.map((x) => String(x.color))).size === 1 || edge.spread - Math.min(...look.rings.map((x) => x.spread)) >= 1, `${scheme}: the edge at least 1 px of its own: ${look.shadow}`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
