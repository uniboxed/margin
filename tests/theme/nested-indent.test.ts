// The pinned area's indentation with nested folders, in every built-in theme, in real engines (Playwright's WebKit and
// Chromium, headless, every network request refused). Depth 0 and 1 (a loose pin, a folder, a pin in a folder) are
// drawn exactly where they were before nested folders (the numbers below: measured on 93722290, in Work's space of the
// fixture, 1280 × 800); a sub-folder's row lines up with its parent's pins, and only a deeper level (depth 2: the pins
// in a sub-folder) moves further right, by the step the theme already gives one level (Arcadia 16 px, Material 20 px,
// Liquid Glass 14 px; Neubrutalism and Pixel indent no level, their folders are boxes: 14 px). `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, NEO, PIXEL, MATERIAL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['neubrutalism', NEO], ['pixel', PIXEL], ['material', MATERIAL]] as const;
const script = harnessScript();

type Lefts = { row: number, icon: number, title: number };
// Measured on the base tree (93722290), the same in both engines (Pixel's folder glyph: 30 in WebKit, 29.75 in Chromium).
const BASE: Record<string, { loosePin: Lefts, folder: Lefts, folderPin: Lefts, step: number }> = {
  arcadia: { loosePin: { row: 10, icon: 20, title: 46 }, folder: { row: 10, icon: 20, title: 46 }, folderPin: { row: 26, icon: 36, title: 62 }, step: 16 },
  'liquid-glass': { loosePin: { row: 18, icon: 27, title: 51 }, folder: { row: 18, icon: 43, title: 65 }, folderPin: { row: 32, icon: 41, title: 65 }, step: 14 },
  neubrutalism: { loosePin: { row: 22.5, icon: 30.5, title: 57.5 }, folder: { row: 18, icon: 28, title: 51 }, folderPin: { row: 22, icon: 30, title: 57 }, step: 14 },
  pixel: { loosePin: { row: 26, icon: 52, title: 78 }, folder: { row: 26, icon: 30, title: 46 }, folderPin: { row: 26, icon: 52, title: 78 }, step: 14 },
  material: { loosePin: { row: 12, icon: 28, title: 58 }, folder: { row: 12, icon: 28, title: 56 }, folderPin: { row: 32, icon: 48, title: 78 }, step: 20 },
};
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 0.5, `${what}: ${a} (want ${b})`);

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: pins and folders keep their indentation, a sub-folder's pins one step more, in ${name}`, async () => {
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
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, hosted: true }));
        await ev(() => T.rtChange('switchSpace', 'work'));
        await page.waitForTimeout(50);
        const measure = () => ev(() => {
          const st = T.rtState();
          const loose = st.pins.find((p) => p.spaceId === 'work' && !p.folderId)!.id;
          const inFolder = st.pins.filter((p) => p.folderId === 'work-f0').map((p) => p.id);
          const inSub = st.pins.filter((p) => p.folderId === 'work-sub').map((p) => p.id);
          const pick = (x: { row: { left: number } | null, icon: { left: number } | null, title: { left: number } | null } | null) => x && { row: x.row!.left, icon: x.icon!.left, title: x.title!.left };
          return {
            loosePin: pick(T.rtRowParts(loose)), folder: pick(T.rtFolderParts('work-f0')), folderPin: pick(T.rtRowParts(inFolder[0])),
            sub: pick(T.rtFolderParts('work-sub')), subPin: inSub.length ? pick(T.rtRowParts(inSub[0])) : null,
          };
        });
        const base = BASE[id];
        const check = (m: Awaited<ReturnType<typeof measure>>, when: string) => {
          for (const k of ['loosePin', 'folder', 'folderPin'] as const) {
            for (const part of ['row', 'icon', 'title'] as const) {
              // (Pixel's folder glyph: a quarter pixel apart between the engines, as on the base tree.)
              near(m[k]![part], base[k][part] - (id === 'pixel' && k === 'folder' && part === 'icon' && name === 'chromium' ? 0.25 : 0), `${when}: ${k} ${part}`);
            }
          }
        };
        check(await measure(), 'flat');
        // A sub-folder in Q4, with Q4's last two pins.
        await ev(() => T.rtChange('nestFolder', 'work-f0', 'work-sub', 'Sub', 2));
        await page.waitForTimeout(50);
        const m = await measure();
        check(m, 'nested');
        assert.ok(m.sub && m.subPin, 'the sub-folder and its pins drawn');
        near(m.sub!.row, m.folderPin!.row, 'the sub-folder row lines up with its parent\'s pins');
        near(m.subPin!.row, m.folderPin!.row + base.step, 'a sub-folder\'s pin row: one step further');
        near(m.subPin!.icon, m.folderPin!.icon + base.step, 'a sub-folder\'s pin icon: one step further');
        near(m.subPin!.title, m.folderPin!.title + base.step, 'a sub-folder\'s pin title: one step further');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
