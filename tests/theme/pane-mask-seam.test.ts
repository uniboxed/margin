// A split's inner-corner masks (render.ts `m-pane::before`: the theme's --m-pane-ground outside a pane's corners where it
// meets another pane) never draw a line down a pane. Each pane's mask is clipped to its half facing the other pane, and a
// clip edge on a fraction of a device pixel left WebKit painting one column of the ground across the whole pane (seen
// 2026-11-28 in Margin.app: a teal hairline down the middle of Music's pane, 1088.5 pt). The rules as shipped (read from
// render.ts), two panes at sizes whose middles fall between pixels, rows and columns, at 2×, in real engines; every
// pixel along each pane's middle (20 pt from its ends: its rounded corners) the window under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const source = readFileSync(new URL('../../app/shared/ui/render.ts', import.meta.url), 'utf8');
const RULES = source.split('\n').filter((l) => /^m-pane::before\{|^m-page\[m-split="(row|column)"\]>m-pane:(first|last)-of-type::before\{/.test(l)).join('\n');
const DARK = [37, 39, 34], GROUND = [134, 188, 189];
const CASES: [string, number, number][] = [['row', 1233, 0.3], ['row', 1233.5, 0.41], ['row', 1233.75, 0.5], ['column', 1100.5, 0.5], ['column', 977.3, 0.63]];

test('the pane masks\' rules are found in render.ts (the mask, its row and column halves)', () => {
  assert.equal(RULES.split('\n').length, 5, RULES);
});

for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]] as const) {
  test(`a split's inner-corner masks draw no line down a pane, in ${name}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1512, height: 1300 }, deviceScaleFactor: 2 });
      for (const [dir, total, ratio] of CASES) {
        const size = dir === 'row' ? `width:${total}px;height:933px` : `width:933px;height:${total}px`;
        await page.setContent(`<style>html,body{margin:0;background:rgb(${DARK})}m-page{position:absolute;left:270px;top:41px;${size};display:flex;flex-direction:${dir};isolation:isolate;gap:8px}m-pane{position:relative;display:block;min-width:0;border-radius:10px;z-index:1;--m-pane-ground:rgb(${GROUND})}m-pane:nth-child(1){flex:${ratio} 1 0}m-pane:nth-child(2){flex:${1 - ratio} 1 0}${RULES}</style><m-page m-split="${dir}"><m-pane></m-pane><m-pane></m-pane></m-page>`);
        const panes = await page.evaluate(() => [...document.querySelectorAll('m-pane')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
        const shot = (await page.screenshot()).toString('base64');
        // (Decoded in the page itself: a canvas reads the screenshot back, no image library needed.)
        const strays = await page.evaluate(async ({ shot, panes, dir, DARK }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${shot}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const g = c.getContext('2d')!;
          g.drawImage(img, 0, 0);
          const data = g.getImageData(0, 0, c.width, c.height).data;
          const off = (x: number, y: number) => { const i = (y * c.width + x) * 4; return Math.abs(data[i] - DARK[0]) + Math.abs(data[i + 1] - DARK[1]) + Math.abs(data[i + 2] - DARK[2]) > 6; };
          const out: string[] = [];
          for (const [l, t, r, b] of panes) {
            if (dir === 'row') { const y = Math.round((t + b)); for (let x = Math.ceil((l + 20) * 2); x < Math.floor((r - 20) * 2); x++) if (off(x, y)) { out.push(`x ${x / 2}`); break; } }
            else { const x = Math.round((l + r)); for (let y = Math.ceil((t + 20) * 2); y < Math.floor((b - 20) * 2); y++) if (off(x, y)) { out.push(`y ${y / 2}`); break; } }
          }
          return out;
        }, { shot, panes, dir, DARK });
        assert.deepEqual(strays, [], `${dir} ${total} at ${ratio}: a line of the ground across a pane at ${strays.join(', ')}`);
      }
    } finally {
      await browser.close();
    }
  });
}
