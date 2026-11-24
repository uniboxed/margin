// Edit Theme Color in the browsers (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4; ui/picker/panel.ts,
// ui/behaviors/background-picker.ts), as a person uses it, over Arcadia in WebKit and Chromium: opened from the space's
// menu at the menu's place; a click on the empty field picks the first colour; a drag previews (drawn, nothing sent)
// and saves once at its end; + / − / the rule; a preset (its exact colour) and the pages; the slider; the dial (a
// click the next texture, its ring turned and its centre dragged (saved once at the end), scrolling its amount (saved
// once at rest), a sideways swipe the next texture); the appearance; the keyboard (a burst of keys saved once); ⌘Z a
// step back; Use for All Spaces; Escape what was there before; Done, a press outside, another space shown: closed.
// Each save is `renameSpace` with the background as the model reads it and its key colour; the app's part (the state
// having it) is played here (`apply`). Then each built-in theme: the menu has it and it opens. The model and the
// actions: tests/ui-picker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, GLASS, MATERIAL, NEO, PIXEL, themesInScope } from './package.ts';
import { SPACE_COLORS } from '../../app/shared/ui/behaviors/menu-items.ts';
import type { Harness, HarnessRt } from './harness.ts';

declare const T: Harness;
declare const __rt: HarnessRt;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const W = 1280, H = 800;
const script = harnessScript();
// The themes the last check opens it in (MARGIN_TEST_THEMES narrows them: scripts/ci-plan.mts).
const THEMES = themesInScope([
  ['arcadia', ARCADIA, []], ['material', MATERIAL, ['Google Sans Flex']], ['liquid-glass', GLASS, []], ['neubrutalism', NEO, []], ['pixel', PIXEL, []],
] as const);

for (const [engineName, engine] of ENGINES) {
  test(`Edit Theme Color in ${engineName}`, async (t) => {
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
      const mount = async (pkgDir: string, id: string, fonts: string[] = []) => {
        assert.equal((await page.evaluate(([p, i, f]) => T.loadBuiltin(p, i, f), [themeForPage(pkgDir), id, fonts] as const)).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen' }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
      };
      const saves = async () => (await ev(() => T.rtSent())).filter(([type]) => type === 'renameSpace').map(([, p]) => p);
      // The app's part: the state has what was saved last (each space's last).
      const apply = async () => {
        const last = new Map<string, any>();
        for (const p of await saves()) if ('background' in p) last.set(p.spaceId, p);
        for (const p of last.values()) await ev((x) => T.rtChange('setBackground', x.spaceId, x.background), p);
      };
      const parts = () => ev(() => T.rtPicker());
      const centre = (b: { x: number, y: number, width: number, height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const click = async (b: { x: number, y: number, width: number, height: number }) => { const c = centre(b); await page.mouse.click(c.x, c.y); };
      const openFromMenu = async () => {
        const chip = (await ev(() => T.rtRect('.chip.active')))!;
        await page.mouse.click(chip.x, chip.y, { button: 'right' });
        const item = await ev(() => T.rtBoxText('.menu-item', 'Edit Theme Color…'));
        assert.ok(item, 'the space\'s menu has Edit Theme Color…');
        await page.mouse.click(item!.x, item!.y);
        await page.waitForTimeout(50);
        return chip;
      };

      await mount(ARCADIA, 'arcadia');

      await t.test('opened from the space\'s menu, where the menu was, in the window; nothing yet: the empty field', async () => {
        await openFromMenu();
        const panel = await ev(() => T.rtPanel());
        assert.equal(panel.open, true);
        const [x, y, w, h] = panel.rect!;
        assert.ok(x >= 8 && y >= 8 && x + w <= W - 8 && y + h <= H - 8, `in the window: ${panel.rect}`);
        const p = (await parts())!;
        assert.deepEqual([p.empty, p.minus.disabled, p.plus.disabled, p.wheel.shown, p.knobs.length], [true, true, false, false, 0]);
        assert.deepEqual(p.appearance.map((a: any) => [a.value, a.checked]), [['auto', true], ['light', false], ['dark', false]]);
        assert.match(p.focused ?? '', /^Automatic appearance/, 'the keys start in it');
        assert.deepEqual(await saves(), []);
      });

      await t.test('a click on the empty field: the first colour, saved with its key colour', async () => {
        const p = (await parts())!;
        await page.mouse.click(p.field.x + p.field.width * 0.8, p.field.y + p.field.height / 2);
        const s = await saves();
        assert.equal(s.length, 1);
        assert.equal(s[0].spaceId, 'personal');
        assert.equal(s[0].background.colors.length, 1);
        assert.equal(s[0].color, s[0].background.colors[0], 'the key colour, the space\'s');
        assert.equal((await ev(() => T.rtBackground())).shown, true, 'drawn at once (ahead of the state)');
        await apply();
        assert.equal((await parts())!.knobs.length, 1);
      });

      await t.test('a drag: drawn as it goes, nothing sent; saved once, at its end', async () => {
        const before = (await ev(() => T.rtBackground())).sets[0].colors;
        const key = centre((await parts())!.knobs[0]);
        await page.mouse.move(key.x, key.y);
        await page.mouse.down();
        for (let i = 1; i <= 4; i++) await page.mouse.move(key.x - i * 25, key.y - i * 15, { steps: 2 });
        await page.waitForTimeout(50);
        const during = (await ev(() => T.rtBackground())).sets[0].colors;
        assert.notEqual(during, before, 'redrawn while dragging');
        assert.equal((await saves()).length, 1, 'nothing sent while dragging');
        await page.mouse.up();
        assert.equal((await saves()).length, 2, 'one save at the end');
        await apply();
      });

      await t.test('+, the rule, −: the others follow the key', async () => {
        await click((await parts())!.plus);
        let p = (await parts())!;
        assert.deepEqual([p.knobs.length, p.wheel.shown, p.wheel.text], [2, true, 'Analogous']);
        assert.equal((await saves()).at(-1).background.colors.length, 2);
        await click(p.wheel);
        p = (await parts())!;
        assert.equal(p.wheel.text, 'Complementary');
        assert.equal((await saves()).at(-1).background.wheel, 'complementary');
        await click(p.minus);
        assert.equal((await saves()).at(-1).background.colors.length, 1);
        await apply();
      });

      await t.test('a preset: its exact colour; the pages turn', async () => {
        let p = (await parts())!;
        const swatch = p.swatches.find((s: any) => s.color === SPACE_COLORS[1])!;
        await click(swatch);
        assert.equal((await saves()).at(-1).background.colors[0], SPACE_COLORS[1]);
        p = (await parts())!;
        assert.equal(p.swatches.find((s: any) => s.checked)?.color, SPACE_COLORS[1]);
        const first = p.swatches.map((s: any) => s.color);
        await click(p.next);
        assert.notDeepEqual((await parts())!.swatches.map((s: any) => s.color), first, 'the next page');
        await click((await parts())!.prev);
        assert.deepEqual((await parts())!.swatches.map((s: any) => s.color), first);
        await apply();
      });

      await t.test('the slider: the intensity where it\'s pressed; the keys: one save for a burst', async () => {
        const p = (await parts())!;
        await page.mouse.click(p.slider.x + 16 + 0.75 * (p.slider.width - 32), p.slider.y + p.slider.height / 2);
        assert.ok(Math.abs((await saves()).at(-1).background.intensity - 0.75) <= 0.02, `${(await saves()).at(-1).background.intensity}`);
        const n = (await saves()).length;
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        assert.equal((await saves()).length, n, 'not yet: a burst');
        await page.waitForTimeout(450);
        assert.equal((await saves()).length, n + 1, 'once at rest');
        assert.ok(Math.abs((await saves()).at(-1).background.intensity - 0.65) <= 0.02);
        await apply();
      });

      await t.test('the dial: a click the next texture; scrolling its amount (saved at rest); a sideways swipe the next texture', async () => {
        let p = (await parts())!;
        const dial = centre(p.dial);
        await page.mouse.click(dial.x, dial.y);
        assert.deepEqual([(await saves()).at(-1).background.texture, (await saves()).at(-1).background.amount], ['sand', 0.25], 'from none: it starts showing');
        assert.equal((await parts())!.dialValue, 'Sand, 25%');
        const n = (await saves()).length;
        await page.mouse.move(dial.x, dial.y);
        await page.mouse.wheel(0, 44);
        await page.waitForTimeout(450);
        assert.equal((await saves()).length, n + 1);
        assert.equal((await saves()).at(-1).background.amount, 0.35, 'two steps');
        await page.mouse.wheel(80, 0);
        await page.waitForTimeout(50);
        assert.equal((await saves()).at(-1).background.texture, 'denim');
        p = (await parts())!;
        assert.equal(p.dialValue, 'Denim, 35%');
        await apply();
      });

      await t.test('the dial turned by its ring, and its centre dragged: drawn as it goes, saved once at the end, the texture kept', async () => {
        const dial = centre((await parts())!.dial);
        const n = (await saves()).length;
        // The ring (radius 40, from bottom left round to bottom right): its top is half, its right 225/270 of it.
        await page.mouse.move(dial.x, dial.y - 40);
        await page.mouse.down();
        await page.waitForTimeout(50);
        assert.equal((await parts())!.dialValue, 'Denim, 50%', 'turned to where it was pressed');
        await page.mouse.move(dial.x + 40, dial.y, { steps: 4 });
        await page.waitForTimeout(50);
        assert.equal((await parts())!.dialValue, 'Denim, 85%');
        assert.equal((await saves()).length, n, 'nothing sent while turning');
        await page.mouse.up();
        assert.equal((await saves()).length, n + 1);
        assert.deepEqual([(await saves()).at(-1).background.texture, (await saves()).at(-1).background.amount], ['denim', 0.85]);
        // The centre: dragged down 75 px, 150 px a full turn.
        await page.mouse.move(dial.x, dial.y);
        await page.mouse.down();
        await page.mouse.move(dial.x, dial.y + 75, { steps: 6 });
        await page.waitForTimeout(50);
        assert.equal((await saves()).length, n + 1, 'nothing sent while dragging');
        await page.mouse.up();
        assert.equal((await saves()).length, n + 2);
        assert.deepEqual([(await saves()).at(-1).background.texture, (await saves()).at(-1).background.amount], ['denim', 0.35], 'a drag, not a click: the texture kept');
        await apply();
      });

      await t.test('the appearance: saved, and what the background is drawn in', async () => {
        const dark = (await parts())!.appearance.find((a: any) => a.value === 'dark')!;
        await click(dark);
        assert.equal((await saves()).at(-1).background.appearance, 'dark');
        await apply();
        assert.equal(await ev(() => __rt.runtime!.view.rootElement()!.getAttribute('m-appearance')), 'dark');
      });

      await t.test('⌘Z: a step back, saved again', async () => {
        const all = (await saves()).filter((p) => p.spaceId === 'personal');
        await page.keyboard.press('ControlOrMeta+z');
        const back = (await saves()).at(-1);
        assert.deepEqual(back.background, all.at(-2).background, 'the one before');
        await apply();
      });

      await t.test('Tab stays in the panel', async () => {
        for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
        assert.equal((await ev(() => T.rtPanel())).open, true);
        assert.ok((await parts())!.focused, 'something of the panel\'s has the keys');
      });

      await t.test('Use for All Spaces: saved to every space; this one stays drawn ahead of the state', async () => {
        // (A preset saved that the state hasn't yet: drawn ahead; the other spaces' saves don't take that away.)
        await click((await parts())!.swatches.find((s: any) => s.color === SPACE_COLORS[3])!);
        const drawn = await ev(() => T.rtBackground());
        const n = (await saves()).length;
        const mine = (await saves()).at(-1).background;
        assert.equal(mine.colors[0], SPACE_COLORS[3]);
        await click((await parts())!.all);
        assert.deepEqual(await ev(() => T.rtBackground()), drawn, 'still drawn as saved');
        const s = (await saves()).slice(n);
        assert.deepEqual(s.map((p) => p.spaceId).sort(), ['personal', 'studio', 'work'].sort());
        assert.ok(s.every((p) => JSON.stringify(p.background) === JSON.stringify(mine)));
        assert.equal((await parts())!.all.text, 'Used for all spaces');
        await apply();
      });

      await t.test('Escape: what the space had when it opened (none), and closed', async () => {
        await page.keyboard.press('Escape');
        const last = (await saves()).filter((p) => p.spaceId === 'personal').at(-1);
        assert.equal(last.background, null);
        assert.equal((await ev(() => T.rtPanel())).open, false);
        await apply();
        assert.equal((await ev(() => T.rtBackground())).shown, false, 'the theme\'s own again');
      });

      await t.test('Done, a press outside, another space shown: closed, what\'s saved kept', async () => {
        await openFromMenu();
        const n = (await saves()).length;
        await click((await parts())!.done);
        assert.equal((await ev(() => T.rtPanel())).open, false);
        await openFromMenu();
        await page.mouse.click(700, 400); // (the page's place)
        assert.equal((await ev(() => T.rtPanel())).open, false, 'a press outside');
        await openFromMenu();
        await ev(() => T.rtChange('switchSpace', 'work'));
        await ev(() => T.rtFrames(2));
        assert.equal((await ev(() => T.rtPanel())).open, false, 'another space shown');
        assert.equal((await saves()).length, n, 'nothing sent');
      });

      await t.test('each built-in theme (in scope): the menu has it, and it opens', async () => {
        for (const [id, dir, fonts] of THEMES) {
          await mount(dir, id, [...fonts]);
          await ev(() => T.rtSetUi({ menu: { kind: 'space', id: 'personal', x: 40, y: 80 } } as any));
          assert.ok(((await ev(() => T.rtVmFull().menu)) ?? []).includes('Edit Theme Color…'), id);
          await ev(() => T.rtSetUi({ menu: null } as any));
          await ev(() => T.rtDispatch('space.editBackground', 'personal'));
          assert.equal((await ev(() => T.rtPanel())).open, true, `${id}: open`);
          await page.keyboard.press('Escape');
          assert.equal((await ev(() => T.rtPanel())).open, false, `${id}: closed`);
        }
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
