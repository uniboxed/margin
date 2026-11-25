// Edit Theme Color's ticks (M2.9 step 6, docs/SPACE-BACKGROUNDS.md Part B §6; ui/picker/feedback.ts), in WebKit and
// Chromium, through the runtime: the picker's own controls (an appearance, the dial's click for the next texture, a
// colour more) tick; on a trackpad that plays haptics (as Margin.app says the gesture comes from) Margin.app's haptic,
// its alignment, a texture its level; with a mouse a click (WebAudio, nothing asked of Margin.app); with the setting
// off nothing; a theme's own picker's buttons the same. The table and the 20 ms limit: tests/ui-picker-feedback.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, MATERIAL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();

for (const [engineName, engine] of ENGINES) {
  test(`Edit Theme Color's ticks in ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      const ev = <A, R>(fn: (a: A) => R, a?: A) => page.evaluate(fn as any, a) as Promise<Awaited<R>>;
      const mount = async (dir: string, id: string, fonts: string[], settings: Record<string, unknown> | null = null) => {
        assert.equal((await page.evaluate(([p, i, f]) => T.loadBuiltin(p, i, f), [themeForPage(dir), id, fonts] as const)).ok, true);
        await ev((x) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', settings: x }), settings);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await ev(() => T.rtDispatch('space.editBackground', 'personal'));
        assert.equal((await ev(() => T.rtPanel())).open, true);
      };
      const device = (kind: 'trackpad' | 'mouse' | null, haptics = true) => ev(([k, h]) => { (window as any).__feedbackDevice = k ? { pointer: k, haptics: h, uiSounds: true } : null; }, [kind, haptics] as const);
      const haptics = async () => (await ev(() => T.rtPerformed())).filter((n) => n.startsWith('haptic.'));
      const ticks = () => ev(() => T.rtPickerTicks());
      const parts = () => ev(() => T.rtPicker()) as Promise<any>;
      const click = async (b: { x: number, y: number, width?: number, height?: number }) => { await page.mouse.click(b.x + (b.width ?? 0) / 2, b.y + (b.height ?? 0) / 2); await page.waitForTimeout(30); };

      await t.test('a trackpad that plays haptics: Margin.app\'s, its alignment for an appearance and a colour, its level for a texture', async () => {
        await device('trackpad');
        await mount(ARCADIA, 'arcadia', []);
        const p = await parts();
        await click(p.appearance[2]);
        assert.deepEqual(await haptics(), ['haptic.alignment']);
        await click(p.dial);
        assert.deepEqual(await haptics(), ['haptic.alignment', 'haptic.level'], 'the dial\'s click: the next texture');
        await click(p.plus);
        assert.deepEqual(await haptics(), ['haptic.alignment', 'haptic.level', 'haptic.alignment']);
        assert.deepEqual(await ticks(), { haptic: 3, sound: 0 });
      });

      await t.test('a mouse: a click, nothing asked of Margin.app; with no trackpad that plays haptics, the same', async () => {
        await device('mouse');
        const p = await parts();
        await click(p.appearance[1]);
        assert.deepEqual(await ticks(), { haptic: 3, sound: 1 });
        await device('trackpad', false);
        await click(p.appearance[0]);
        assert.deepEqual(await ticks(), { haptic: 3, sound: 2 });
        assert.equal((await haptics()).length, 3, 'no haptic asked for');
        await page.keyboard.press('Escape');
      });

      await t.test('the setting off: nothing; sound: a click even on a trackpad', async () => {
        await device('trackpad');
        await mount(ARCADIA, 'arcadia', [], { pickerFeedback: 'off' });
        let p = await parts();
        await click(p.appearance[2]);
        await click(p.dial);
        assert.deepEqual([await ticks(), await haptics()], [{ haptic: 0, sound: 0 }, []]);
        await page.keyboard.press('Escape');
        await mount(ARCADIA, 'arcadia', [], { pickerFeedback: 'sound' });
        p = await parts();
        await click(p.appearance[2]);
        assert.deepEqual([await ticks(), await haptics()], [{ haptic: 0, sound: 1 }, []]);
        await page.keyboard.press('Escape');
      });

      await t.test('a theme\'s own picker (Material): its buttons tick the same', async () => {
        await device('trackpad');
        await mount(MATERIAL, 'material', ['Google Sans Flex']);
        const dark = await ev(() => T.rtBoxText('m-picker [role="radio"]', 'Dark'));
        assert.ok(dark);
        await click(dark!);
        const chip = await ev(() => T.rtBoxText('m-picker button', 'Sand'));
        assert.ok(chip);
        await click(chip!);
        assert.deepEqual(await haptics(), ['haptic.alignment', 'haptic.level']);
        await page.keyboard.press('Escape');
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
