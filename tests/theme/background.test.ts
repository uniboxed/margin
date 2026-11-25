// A space's background in the browsers (M2.9, docs/SPACE-BACKGROUNDS.md Part B §2; ui/background.ts), over each of the
// five built-in themes in WebKit and Chromium, Margin.app's way (the whole document) and in a shadow root:
// - none: nothing of Margin's drawn, the root unmarked, the theme's own look;
// - one: the root marked (m-background, m-appearance), Margin's variables what ui/background-look.ts says, the page
//   showing through its whole box (the layer cut out of it), the ground on screen the colour Margin computes there, the
//   text on it Margin's (the theme's ground text), the sidebar out over the page a card of the one colour, the page's
//   corners told as Margin draws them;
// - its appearance its own or the system's; each texture; a change of space cross-faded (at once with less motion);
// - gone again: the theme's own look to the pixel;
// - a theme without the contract (Neubrutalism with its [m-background] rules taken out): its own look, Margin's layer
//   wholly under it.
// Node's side (the colours, the contrast, the cut's path) is tests/ui-background.test.ts's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, GLASS, MATERIAL, NEO, PIXEL, themesInScope } from './package.ts';
import { decodePng } from './page-card.ts';
import { lookOf } from '../../app/shared/ui/background-look.ts';
import { backgroundOf } from '../../extension/state/model.ts';
import type { Harness, HarnessRt } from './harness.ts';
import type { SpaceBackground } from '../../types/margin';

declare const T: Harness;
declare const __rt: HarnessRt;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const W = 1280, H = 800;
const PAGE = [255, 0, 255, 255];
const script = harnessScript();

// Each theme: its package, its fonts, the elements of it that lie on the ground with text (drawn in Margin's text
// colour), whether its sidebar out over the page is a card of the background's one colour, and the panel it marks for
// Margin to draw the background in while it's out (`m-ground="float"`: the same background, its grain too).
const THEMES = themesInScope([
  ['arcadia', ARCADIA, [], ['.margin-sidebar'], null, '.margin-sidebar'],
  ['material', MATERIAL, ['Google Sans Flex'], ['.margin-sidebar'], null, '.margin-sidebar'],
  ['liquid-glass', GLASS, [], [], null, null],
  ['neubrutalism', NEO, [], ['.space-name'], '.sidebar', null],
  ['pixel', PIXEL, [], [], null, null],
] as const);

const LIGHT = { colors: ['#f7c7d3', '#cfe8f7'], intensity: 0.6, texture: 'grain', amount: 0, appearance: 'light' };
const read = (v: Record<string, unknown>) => backgroundOf(v) as SpaceBackground;
const hex = (rgb: string) => `#${(rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
const close = (a: number[], b: number[], d = 2) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= d);

for (const [engineName, engine] of ENGINES) {
  test(`a space's background in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [id, dir, fonts, onGround, peekCard, floatGround] of THEMES) {
        await t.test(id, async (tt) => {
          const context = await browser.newContext({ viewport: { width: W, height: H } });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await context.route('**/*', (route) => route.abort());
          await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
          await page.addScriptTag({ content: script });
          const pkg = themeForPage(dir);
          const ev = <A, R>(fn: (a: A) => R, a?: A) => page.evaluate(fn as any, a) as Promise<Awaited<R>>;
          const mount = async (container: 'document' | 'shadow' = 'document', settings: Record<string, unknown> | null = null) => {
            assert.equal((await page.evaluate(([p, i, f]) => T.loadBuiltin(p, i, [...f]), [pkg, id, fonts] as const)).ok, true);
            await ev(([c, st]) => T.mountRuntime({ width: 1280, height: 800, container: c, mode: 'fullscreen', settings: st }), [container, settings] as const);
            await ev(() => { document.body.style.background = 'rgb(255, 0, 255)'; });
            await page.waitForFunction(() => T.rtLayouts().length > 0);
          };
          const set = async (bg: Record<string, unknown> | null, space = 'personal') => {
            await ev(([s, b]) => T.rtChange('setBackground', s, b), [space, bg] as const);
            await page.waitForTimeout(450); // (a cross-fade's 0.3 s, the themes' own transitions)
          };
          const attrs = () => ev(() => { const r = __rt.runtime!.view.rootElement()!; return [r.getAttribute('m-background'), r.getAttribute('m-appearance')]; });
          const shot = async () => decodePng(await page.screenshot({ animations: 'disabled' }));
          const layout = async () => (await ev(() => T.rtLayouts())).at(-1)!;

          await mount();
          await page.emulateMedia({ colorScheme: 'light', reducedMotion: null, contrast: null });

          await tt.test('none: nothing of Margin\'s drawn, the root unmarked', async () => {
            const drawn = await ev(() => T.rtBackground());
            assert.equal(drawn.shown, false);
            assert.deepEqual([drawn.sets.length, drawn.css], [0, '']);
            assert.deepEqual(await attrs(), [null, null]);
            assert.deepEqual(await ev(() => T.rtVars(['--m-bg', '--m-fg'])), { '--m-bg': '', '--m-fg': '' });
          });
          const before = await shot();

          await tt.test('one: the root marked, Margin\'s variables, the page showing through its box, the ground Margin\'s colour', async () => {
            await set(LIGHT);
            assert.deepEqual(await attrs(), ['', 'light']);
            const want = lookOf(read(LIGHT), 'light', { size: { width: W, height: H } }).vars;
            const vars = await ev((names) => T.rtVars(names), Object.keys(want));
            assert.deepEqual(vars, want, 'the variables on the theme\'s root');
            const drawn = await ev(() => T.rtBackground());
            assert.equal(drawn.shown, true);
            assert.equal(drawn.sets.length, 1);
            assert.match(drawn.clip, /^path\(evenodd/, 'cut out of the page card');
            const l = await layout();
            const px = await shot();
            const r = l.radius + 2;
            const bad: unknown[] = [];
            for (let y = l.top + r; y < H - l.bottom - r; y += 23) for (let x = l.left + r; x < W - l.right - r; x += 23) if (!close(px(x, y), PAGE, 0)) bad.push([x, y, px(x, y)]);
            assert.deepEqual(bad.slice(0, 5), [], 'the page shows through its whole box');
            // The window's corner farthest from the sidebar: the ground there (no texture: amount 0).
            const at = [W - 2, H - 2];
            const ground = await ev(([x, y]) => T.rtBackgroundAt(x, y), at);
            assert.ok(ground && close(px(at[0], at[1]), (ground.match(/\d+/g) ?? []).map(Number)), `the ground at ${at}: ${px(at[0], at[1])} vs ${ground}`);
          });

          await tt.test('the text on the ground is Margin\'s', async () => {
            for (const sel of onGround) {
              const color = await ev((s) => { const el = __rt.target.querySelector(s); return el ? getComputedStyle(el).color : null; }, sel);
              assert.equal(color && hex(color), (await ev(() => T.rtVars(['--m-fg'])))!['--m-fg'], `${sel}: --m-fg`);
            }
          });

          await tt.test('the page\'s corners, as Margin.app is told them: Margin\'s ground outside the card where the theme paints nothing sharper', async () => {
            const l = await layout();
            const fills = (await ev(() => T.rtCornerFillGround()))?.fills ?? [];
            const plain = (await ev(() => T.rtCornerFill()))?.fills ?? [];
            const points = [[l.left + 0.5, l.top + 0.5], [W - l.right - 0.5, l.top + 0.5], [W - l.right - 0.5, H - l.bottom - 0.5], [l.left + 0.5, H - l.bottom - 0.5]];
            const grounds = await ev((ps) => ps.map(([x, y]) => T.rtBackgroundAt(x, y)), points);
            if (id === 'pixel') assert.deepEqual(fills, plain, 'a square card: its corner points are inside it, as before');
            else if (id === 'neubrutalism') assert.deepEqual(fills, [grounds[0], grounds[1], 'rgb(17, 17, 17)', grounds[3]], 'the ink shadow at the bottom right, Margin\'s ground elsewhere');
            else assert.deepEqual(fills, grounds);
          });

          await tt.test('its appearance: its own, or the system\'s (automatic)', async () => {
            await set({ ...LIGHT, appearance: 'dark' });
            assert.deepEqual(await attrs(), ['', 'dark']);
            assert.deepEqual(await ev(() => T.rtVars(['--m-fg'])), { '--m-fg': lookOf(read({ ...LIGHT, appearance: 'dark' }), 'dark', { size: { width: W, height: H } }).vars['--m-fg'] });
            await set({ ...LIGHT, appearance: 'auto' });
            assert.deepEqual(await attrs(), ['', 'light']);
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.waitForTimeout(50);
            assert.deepEqual(await attrs(), ['', 'dark'], 'the system turned dark: followed');
            await page.emulateMedia({ colorScheme: 'light' });
            await page.waitForTimeout(50);
          });

          await tt.test('each texture drawn: the tiles as images, dots and grid as lines, none at amount 0', async () => {
            for (const [texture, kind] of [['grain', 'url("data:image/png'], ['sand', 'url("data:image/png'], ['denim', 'url("data:image/png'], ['tweed', 'url("data:image/png'], ['dots', 'radial-gradient'], ['grid', 'linear-gradient']] as const) {
              await set({ ...LIGHT, texture, amount: 0.5 });
              const s = (await ev(() => T.rtBackground())).sets[0];
              assert.ok(s.texture.includes(kind), `${texture}: ${s.texture.slice(0, 60)}`);
              assert.ok(Number(s.textureOpacity) > 0, texture);
            }
            await set({ ...LIGHT, amount: 0 });
            assert.equal((await ev(() => T.rtBackground())).sets[0].textureOpacity, '0');
          });

          await tt.test('another space with one: cross-faded; at once with less motion', async () => {
            await ev(() => T.rtChange('setBackground', 'work', { colors: ['#6c5ce7'], appearance: 'light' }));
            await ev(() => T.rtChange('switchSpace', 'work'));
            await ev(() => T.rtFrames(2));
            assert.equal((await ev(() => T.rtBackground())).sets.length, 2, 'both while it fades');
            await page.waitForTimeout(450);
            assert.equal((await ev(() => T.rtBackground())).sets.length, 1, 'the new one alone after');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await ev(() => T.rtChange('switchSpace', 'personal'));
            await ev(() => T.rtFrames(2));
            assert.equal((await ev(() => T.rtBackground())).sets.length, 1, 'at once');
            await page.emulateMedia({ reducedMotion: null });
          });

          await tt.test('gone again: the theme\'s own look, to the pixel', async () => {
            await set(null);
            await set(null, 'work');
            assert.deepEqual(await attrs(), [null, null]);
            const drawn = await ev(() => T.rtBackground());
            assert.deepEqual([drawn.shown, drawn.sets.length, drawn.css], [false, 0, '']);
            const after = await shot();
            const diff: unknown[] = [];
            for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) if (!close(after(x, y), before(x, y), 0)) diff.push([x, y]);
            assert.deepEqual(diff.slice(0, 5), [], 'as before any background');
          });

          await tt.test('in a shadow root (the extension\'s overlay): drawn and cut the same', async () => {
            await mount('shadow');
            await set(LIGHT);
            const drawn = await ev(() => T.rtBackground());
            assert.deepEqual([drawn.shown, drawn.sets.length], [true, 1]);
            const l = await layout();
            const px = await shot();
            assert.ok(close(px(Math.round((l.left + W - l.right) / 2), Math.round(H / 2)), PAGE, 0), 'the page shows through');
          });

          if (peekCard) {
            await tt.test('the sidebar out over the page: a card of the background\'s one colour', async () => {
              await mount('document', { sidebarPinnedOpen: false });
              await set(LIGHT);
              await ev(() => __rt.runtime!.sidebar.show('toggle'));
              await page.waitForTimeout(300);
              assert.equal(await ev(() => __rt.runtime!.sidebar.out()), true);
              const bg = await ev((s) => { const el = __rt.target.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; }, peekCard);
              assert.equal(bg && hex(bg), (await ev(() => T.rtVars(['--m-bg'])))!['--m-bg'], `${peekCard}: --m-bg`);
            });
          }

          if (floatGround) {
            // Tirth, 2026-11-25: a hidden sidebar brought out showed a flat colour, not the space's background and its grain.
            await tt.test('the sidebar out over the page: the same background drawn in it, its grain too, lined up with the window\'s', async () => {
              const GRAINY = { ...LIGHT, amount: 0.6 };
              const settled = () => page.waitForFunction((sel) => document.querySelector(sel)!.getAnimations().length === 0, floatGround);
              await mount('document', { sidebarPinnedOpen: false });
              await set(GRAINY);
              const hidden = await ev(() => T.rtBackground());
              assert.ok(hidden.float, 'drawn in the panel while it\'s hidden (ready as it comes out)');
              assert.equal(await ev((sel) => getComputedStyle(document.querySelector(sel)!.querySelector('margin-background')!).visibility, floatGround), 'hidden', 'hidden with it');
              await ev(() => __rt.runtime!.sidebar.show('toggle'));
              await settled();
              assert.equal(await ev(() => __rt.runtime!.sidebar.out()), true);
              const d = await ev(() => T.rtBackground());
              const box = await ev((sel) => { const el = document.querySelector(sel) as HTMLElement; const r = el.getBoundingClientRect(); return { left: r.left + el.clientLeft, top: r.top + el.clientTop, right: r.right, bottom: r.bottom, isPanel: el.matches(`.${String(T.rtBackground().float?.in ?? '').trim().split(/\s+/).join('.')}`) }; }, floatGround);
              assert.equal(box.isPanel, true, 'in the theme\'s panel');
              assert.deepEqual([d.float!.left, d.float!.top, d.float!.width, d.float!.height], [`${-box.left}px`, `${-box.top}px`, `${W}px`, `${H}px`], 'the window\'s size, at the window\'s place');
              assert.deepEqual(d.float!.sets, d.sets, 'the window\'s parts, texture and all');
              assert.match(d.sets[0].texture, /^url\(/, 'the grain');
              // Its pixels the window's ground's: the panel's content hidden, the same place drawn with the sidebar docked
              // (clear, the window's background under it).
              await page.addStyleTag({ content: `${floatGround} > :not(margin-background) { visibility: hidden !important; } ${floatGround} { outline: none !important; box-shadow: none !important; } .card-edge { box-shadow: none !important; }` });
              const floated = await shot();
              await mount('document', { sidebarPinnedOpen: true });
              await set(GRAINY);
              assert.equal((await ev(() => T.rtBackground())).float, null, 'docked: none in it');
              const docked = await shot();
              const bad: unknown[] = [];
              for (let y = Math.ceil(box.top) + 14; y < box.bottom - 14; y += 9) for (let x = Math.ceil(box.left) + 14; x < Math.min(box.right, (await layout()).left) - 24; x += 9) if (!close(floated(x, y), docked(x, y), 1)) bad.push([x, y, floated(x, y), docked(x, y)]);
              assert.deepEqual(bad.slice(0, 5), [], 'the panel\'s ground, pixel for pixel, the window\'s');
            });
          }

          assert.deepEqual(errors, []);
          await context.close();
        });
      }

      await t.test('a theme without the contract keeps its own look: Margin\'s layer wholly under its ground', async () => {
        const context = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await context.newPage();
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const pkg = themeForPage(NEO);
        // Neubrutalism with every rule that reads m-background taken out (whole lines, as written).
        const bare = { ...pkg, css: pkg.css.split('\n').filter((line) => !line.includes('[m-background]')).join('\n') };
        assert.ok(pkg.css.includes('[m-background]') && !bare.css.includes('[m-background]'));
        assert.equal((await page.evaluate((p) => T.loadBuiltin(p, 'neubrutalism', []), bare)).ok, true);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen' }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const shoot = async () => decodePng(await page.screenshot({ animations: 'disabled' }));
        const own = await shoot();
        await page.evaluate((b) => T.rtChange('setBackground', 'personal', b), { ...LIGHT, amount: 0.5, texture: 'dots' });
        await page.waitForTimeout(450);
        assert.equal((await page.evaluate(() => T.rtBackground())).shown, true, 'drawn (under the theme)');
        const withOne = await shoot();
        // (Every pixel but the page card's rounded corners' edge: there the layer's cut and the theme's spread are each
        // smoothed over part of a pixel, so a little of the background mixes in: the themes README says so.)
        const l = (await page.evaluate(() => T.rtLayouts())).at(-1)!;
        const r = l.radius + 6; // its outer corner (the 3 px border) and a pixel of smoothing round it
        const nearCorner = (x: number, y: number) => (x < l.left + r || x >= W - l.right - r) && (y < l.top + r || y >= H - l.bottom - r)
          && x > l.left - 8 && x < W - l.right + 8 && y > l.top - 8 && y < H - l.bottom + 8;
        const diff: unknown[] = [];
        for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) if (!nearCorner(x, y) && !close(withOne(x, y), own(x, y), 0)) diff.push([x, y]);
        assert.deepEqual(diff.slice(0, 5), [], 'its own look, unchanged');
        await context.close();
      });
    } finally {
      await browser.close();
    }
  });
}
