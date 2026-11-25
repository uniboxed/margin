// A space's picture drawn (M2.9 step 7, docs/SPACE-BACKGROUNDS.md Part B §7; ui/background.ts, ui/background-look.ts),
// in WebKit and Chromium, over Arcadia (whose frame round the page card shows the ground): served by the host (a test
// picture, half black and half white, for every id), loaded, then drawn as its fit and focus say, washed with the
// underlay until the text reads against it, the colour Margin.app is told at the frame what's on screen there; without
// a host that serves pictures (a browser's extension), or one that fails to load, drawn without it, nothing thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA } from './package.ts';
import { decodePng } from './page-card.ts';
import { contrast, hexToRgb } from '../../app/shared/ui/color.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const W = 1280, H = 800;
const script = harnessScript();
const ID = 'c'.repeat(64);
const PICTURED = { colors: [], image: { id: ID, fit: 'cover', focus: [0.5, 0.5] }, intensity: 0.5, texture: 'grain', amount: 0, appearance: 'light' };

for (const [engineName, engine] of ENGINES) {
  test(`a space's picture in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: W, height: H } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      const ev = <A, R>(fn: (a: A) => R, a?: A) => page.evaluate(fn as any, a) as Promise<Awaited<R>>;
      // The test's picture: its left half black, its right half white (a PNG as a data: URL).
      await ev(() => {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 200;
        const g = c.getContext('2d')!;
        g.fillStyle = '#000'; g.fillRect(0, 0, 160, 200);
        g.fillStyle = '#fff'; g.fillRect(160, 0, 160, 200);
        (window as any).__testPicture = c.toDataURL('image/png');
      });
      const mount = async (pictures: boolean) => {
        assert.equal((await page.evaluate((p) => T.loadBuiltin(p, 'arcadia', []), themeForPage(ARCADIA))).ok, true);
        await ev((x) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', pictures: x }), pictures);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
      };
      const drawn = () => ev(() => T.rtBackground()) as Promise<any>;

      await t.test('served, loaded, then drawn as its fit says, washed until the text reads; what Margin.app is told is on screen', async () => {
        await mount(true);
        await ev((b) => T.rtChange('setBackground', 'personal', b), PICTURED);
        await page.waitForFunction(() => (T.rtBackground() as any).pictureState === 'ready');
        await ev(() => T.rtFrames(3));
        const d = await drawn();
        assert.equal(d.shown, true);
        assert.match(d.sets[0].picture, /^url\("data:image\/png;base64,[^"]+"\) 50% 50% \/ cover no-repeat$/);
        assert.ok(Number(d.sets[0].wash) > 0, `washed: ${d.sets[0].wash} (dark text over its black half)`);
        // The text reads against the picture's darkest part as drawn.
        const vars = (await ev(() => T.rtVars(['--m-fg'])))!;
        const fg = hexToRgb(vars['--m-fg'])!;
        const shot = decodePng(await page.screenshot({ animations: 'disabled' }));
        const l = (await ev(() => T.rtLayouts())).at(-1)!;
        // (The frame under the page card, where Arcadia lets the ground through: left (the black half), right (white).)
        const y = H - Math.max(2, Math.floor(l.bottom / 2));
        for (const x of [Math.round(l.left + 40), Math.round(W - l.right - 40)]) {
          const [r, g, b] = shot(x, y);
          const told = (await ev(([px, py]) => T.rtBackgroundAt(px, py), [x, y] as const))!;
          const [tr, tg, tb] = told.match(/\d+/g)!.map(Number);
          assert.ok(Math.max(Math.abs(r - tr), Math.abs(g - tg), Math.abs(b - tb)) <= 6, `at ${x},${y}: on screen ${[r, g, b]}, told ${told}`);
          assert.ok(contrast(fg, { r: r / 255, g: g / 255, b: b / 255 }) >= 4.4, `the text reads at ${x},${y}: ${contrast(fg, { r: r / 255, g: g / 255, b: b / 255 })}`);
        }
        const [lr] = shot(Math.round(l.left + 40), y), [rr] = shot(Math.round(W - l.right - 40), y);
        assert.ok(rr - lr > 40, `the picture's two halves show: ${lr} ${rr}`);
      });

      await t.test('its fit and focus: contain and tile drawn so', async () => {
        await ev((b) => T.rtChange('setBackground', 'personal', b), { ...PICTURED, image: { id: ID, fit: 'contain', focus: [0, 1] } });
        await ev(() => T.rtFrames(2));
        assert.match((await drawn()).sets[0].picture, /\) 0% 100% \/ contain no-repeat$/);
        await ev((b) => T.rtChange('setBackground', 'personal', b), { ...PICTURED, image: { id: ID, fit: 'tile', focus: [0.5, 0.5] } });
        await ev(() => T.rtFrames(2));
        // (WebKit writes it back without the default `auto` size.)
        assert.match((await drawn()).sets[0].picture, /\) 0(px)? 0(px)? (\/ auto )?repeat$/);
      });

      await t.test('a picture that fails to load: drawn without it, nothing thrown', async () => {
        await ev(() => { (window as any).__testPicture = 'data:image/png;base64,AAAA'; });
        await ev((b) => T.rtChange('setBackground', 'personal', b), { ...PICTURED, image: { id: 'd'.repeat(64), fit: 'cover', focus: [0.5, 0.5] } });
        await page.waitForFunction(() => (T.rtBackground() as any).pictureState === 'failed');
        await ev(() => T.rtFrames(2));
        const d = await drawn();
        assert.deepEqual([d.shown, d.sets[0].picture, d.sets[0].wash], [true, 'none', '0']);
      });

      await t.test('a host that serves no pictures (a browser\'s extension): drawn without it', async () => {
        await mount(false);
        await ev((b) => T.rtChange('setBackground', 'personal', b), { ...PICTURED, colors: ['#f7c7d3'] });
        await ev(() => T.rtFrames(2));
        const d = await drawn();
        assert.deepEqual([d.shown, d.picture, d.sets[0].picture], [true, null, 'none']);
        assert.notEqual(d.sets[0].colors, 'none', 'its colours drawn');
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
