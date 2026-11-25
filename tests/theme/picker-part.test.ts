// A theme's own Edit Theme Color (M2.9 step 5b, docs/SPACE-BACKGROUNDS.md Part B §4 and decision 10; ui/picker/part.ts),
// in WebKit and Chromium, over Arcadia given a `background-picker` part and its `<m-picker>` slot (a test theme): it's
// the theme's, not Margin's panel, placed where the menu was and given the keys; Margin's elements in it work (the field,
// its `wheel` variant; a slider for each value, a wave and a bar; the dial); each kind of item the theme's buttons run
// does its edit, saved as the panel's are; a forged item is refused; Escape, ⌘Z, Use for All Spaces, Done, a press
// outside; no glass asked for; what the theme wrote in it as text dropped (Margin's words only); an element left out,
// an unknown variant (the default), and a part with no slot (Margin's panel). The view model and the item rules:
// tests/ui-picker-part.test.ts. The built-in themes' own pickers: their theme tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA } from './package.ts';
import { SPACE_COLORS } from '../../app/shared/ui/behaviors/menu-items.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const W = 1280, H = 800;
const script = harnessScript();

const icon = (d: string) => `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="${d}" stroke="currentColor" fill="none"></path></svg>`;
// The part: every kind of item, and Margin's three elements. "Words of the theme's own" is text the theme wrote (dropped).
const PART = (field = '<m-picker-field class="tp-field" m-variant="wheel"></m-picker-field>') => `
<template m-part="background-picker">
  <div class="tp" role="dialog" m-attr:aria-label="{{picker.title}}">
    <h2 class="tp-title">{{picker.title}}</h2>
    <p class="tp-own">Words of the theme's own</p>
    <div class="tp-appearance" role="radiogroup">
      <m-for each="picker.appearances" as="a" key="id"><button class="tp-ap" m-action="picker.run" m-arg="{{a.id}}" m-attr:aria-checked="{{a.selected}}" m-attr:aria-label="{{a.label}}">{{a.short}}</button></m-for>
    </div>
    ${field}
    <div class="tp-colors">
      <button class="tp-remove" m-action="picker.run" m-arg="{{picker.colors.remove.id}}" m-attr:disabled="{{picker.colors.remove.disabled}}" m-attr:aria-label="{{picker.colors.remove.label}}">${icon('M2 5h6')}</button>
      <button class="tp-add" m-action="picker.run" m-arg="{{picker.colors.add.id}}" m-attr:disabled="{{picker.colors.add.disabled}}" m-attr:aria-label="{{picker.colors.add.label}}">${icon('M2 5h6M5 2v6')}</button>
      <m-if test="picker.colors.hasRule"><button class="tp-rule" m-action="picker.run" m-arg="{{picker.colors.rule.id}}" m-attr:aria-label="{{picker.colors.rule.label}}">{{picker.colors.rule.text}}</button></m-if>
    </div>
    <div class="tp-presets">
      <button class="tp-prev" m-action="picker.run" m-arg="{{picker.prev.id}}" m-attr:aria-label="{{picker.prev.label}}">${icon('M6 2L3 5l3 3')}</button>
      <m-for each="picker.presets" as="p" key="id"><button class="tp-swatch" m-action="picker.run" m-arg="{{p.id}}" m-style:--swatch="{{p.color}}" m-attr:aria-checked="{{p.selected}}" m-attr:aria-label="{{p.label}}" data-color="{{p.color}}"></button></m-for>
      <button class="tp-next" m-action="picker.run" m-arg="{{picker.next.id}}" m-attr:aria-label="{{picker.next.label}}">${icon('M4 2l3 3-3 3')}</button>
    </div>
    <m-picker-slider class="tp-intensity" m-value="intensity" m-variant="wave"></m-picker-slider>
    <div class="tp-steps"><m-for each="picker.intensity.steps" as="v" key="id"><button class="tp-step" m-action="picker.run" m-arg="{{v.id}}" m-attr:aria-label="{{v.label}}" m-class:on="{{v.on}}"></button></m-for></div>
    <div class="tp-textures"><m-for each="picker.textures" as="t" key="id"><button class="tp-texture" m-action="picker.run" m-arg="{{t.id}}" m-attr:aria-pressed="{{t.selected}}">{{t.label}}</button></m-for></div>
    <button class="tp-texture-next" m-action="picker.run" m-arg="{{picker.texture.next.id}}" m-attr:aria-label="{{picker.texture.next.label}}">${icon('M4 2l3 3-3 3')}</button>
    <m-picker-slider class="tp-amount" m-value="amount" m-variant="bar"></m-picker-slider>
    <div class="tp-amounts"><m-for each="picker.amounts" as="m" key="id"><button class="tp-am" m-action="picker.run" m-arg="{{m.id}}" m-attr:aria-pressed="{{m.selected}}">{{m.label}}</button></m-for></div>
    <m-picker-dial class="tp-dial"></m-picker-dial>
    <span class="tp-text">{{picker.texture.text}}</span>
    <button class="tp-all" m-action="picker.run" m-arg="{{picker.all.id}}">{{picker.all.label}}</button>
    <button class="tp-done" m-action="picker.run" m-arg="{{picker.done.id}}">{{picker.done.label}}</button>
  </div>
</template>`;
const CSS = `
.tp { width: 320px; box-sizing: border-box; padding: 12px; background: #fff; color: #222; border: 2px solid #222; display: flex; flex-direction: column; gap: 8px; font: 12px system-ui, sans-serif; }
.tp-field { height: 160px; border-radius: 12px; }
.tp-colors, .tp-presets, .tp-steps, .tp-textures, .tp-amounts { display: flex; gap: 4px; flex-wrap: wrap; }
.tp-swatch { width: 22px; height: 22px; background: var(--swatch); border: 1px solid #0003; }
.tp-step { width: 18px; height: 12px; background: #ddd; } .tp-step.on { background: #222; }
.tp-intensity, .tp-amount { height: 28px; } .tp-dial { width: 64px; height: 64px; }
`;
/** Arcadia, given the part (and its slot, unless `slot` is false), as a package the overlay would load. */
function testTheme({ part = PART(), slot = true } = {}) {
  const pkg = themeForPage(ARCADIA) as { manifest: string, html: string, css: string, files: Record<string, string> };
  const at = '<m-menu class="menu-slot"></m-menu>';
  assert.ok(pkg.html.includes(at), 'Arcadia has its menu slot');
  // (Inside the theme's root, as its other parts are: a template has one root element.)
  return { ...pkg, html: pkg.html.replace(at, `${at}${slot ? '<m-picker class="picker-slot"></m-picker>' : ''}${part}`), css: pkg.css + CSS };
}

for (const [engineName, engine] of ENGINES) {
  test(`a theme's own Edit Theme Color in ${engineName}`, async (t) => {
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
      const mount = async (pkg: ReturnType<typeof testTheme>, extra: { materials?: number } = {}) => {
        const loaded = await ev((p) => T.loadPackage(p as any), pkg);
        assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
        await ev((x) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'fullscreen', ...x }), extra);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        return loaded;
      };
      const saves = async () => (await ev(() => T.rtSent())).filter(([type]) => type === 'renameSpace').map(([, p]) => p);
      const apply = async () => {
        const last = new Map<string, any>();
        for (const p of await saves()) if ('background' in p) last.set(p.spaceId, p);
        for (const p of last.values()) await ev((x) => T.rtChange('setBackground', x.spaceId, x.background), p);
      };
      const parts = () => ev(() => T.rtPicker()) as Promise<any>;
      const isOpen = async () => (await ev(() => T.rtPanel())).open;
      const box = (sel: string, i = 0) => ev(([s, n]) => { const e = document.querySelectorAll(s)[n]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [sel, i] as const);
      const press = async (sel: string, i = 0) => { const b = await box(sel, i); assert.ok(b, `${sel} [${i}] drawn`); await page.mouse.click(b!.x, b!.y); };
      const text = (sel: string) => ev((s) => [...document.querySelectorAll(s)].map((e) => (e.textContent ?? '').trim()), sel);
      const openFromMenu = async () => {
        const chip = (await ev(() => T.rtRect('.chip.active')))!;
        await page.mouse.click(chip.x, chip.y, { button: 'right' });
        const item = await ev(() => T.rtBoxText('.menu-item', 'Edit Theme Color…'));
        assert.ok(item);
        await page.mouse.click(item!.x, item!.y);
        await page.waitForTimeout(50);
      };

      const loaded = await mount(testTheme(), { materials: 250 });

      await t.test('the theme\'s own, opened from the menu where it was, in the window, the keys in it; no glass asked for', async () => {
        assert.ok(loaded.removed >= 1, 'the theme\'s own words in the part reported removed');
        await openFromMenu();
        assert.equal(await isOpen(), true, 'open at once (no materials to wait for)');
        assert.deepEqual(await ev(() => T.rtMaterials()), [], 'no glass asked for');
        const p = await parts();
        assert.equal(p.themed, true);
        assert.equal(await ev(() => !!document.querySelector('margin-background-picker')), false, 'not Margin\'s panel');
        assert.deepEqual(await text('.tp-title'), ['Edit Theme Color']);
        assert.deepEqual(await text('.tp-own'), [''], 'what the theme wrote as text: dropped');
        const [x, y, w, h] = (await ev(() => T.rtPanel())).rect!;
        assert.ok(x >= 8 && y >= 8 && x + w <= W - 8 && y + h <= H - 8, `placed in the window (by Margin's own rule: the theme doesn't place it): ${[x, y, w, h]}`);
        assert.deepEqual([p.panel.x, p.panel.y], [x, y], 'what takes the pointer: the theme\'s panel');
        assert.equal(p.variant, 'wheel');
        assert.match(await ev(() => (document.querySelector('m-picker-field') as HTMLElement).style.getPropertyValue('--m-field-wheel')), /conic-gradient/);
        assert.deepEqual(p.sliders.map((s: any) => [s.value, s.variant]), [['intensity', 'wave'], ['amount', 'bar']]);
        assert.equal(p.dials.length, 1);
        assert.match(p.focused ?? '', /appearance/i, 'the keys in it (no colour yet: its first button)');
        assert.deepEqual(await saves(), []);
      });

      await t.test('the field: a click the first colour; a drag drawn as it goes and saved once at its end', async () => {
        let p = await parts();
        await page.mouse.click(p.field.x + p.field.width * 0.8, p.field.y + p.field.height / 2);
        assert.equal((await saves()).length, 1);
        assert.equal((await saves())[0].background.colors.length, 1);
        await apply();
        p = await parts();
        const k = p.knobs[0];
        await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 4; i++) await page.mouse.move(k.x + k.width / 2 - i * 20, k.y + k.height / 2 - i * 10, { steps: 2 });
        assert.equal((await saves()).length, 1, 'nothing sent while dragging');
        await page.mouse.up();
        assert.equal((await saves()).length, 2, 'once at its end');
        await apply();
      });

      await t.test('the theme\'s buttons: appearance, a colour more, the rule, a colour fewer, a preset, the pages', async () => {
        await press('.tp-ap', 2);
        assert.equal((await saves()).at(-1).background.appearance, 'dark');
        assert.deepEqual(await ev(() => [...document.querySelectorAll('.tp-ap')].map((b) => b.getAttribute('aria-checked'))), ['false', 'false', 'true'], 'drawn as it is');
        await press('.tp-add');
        assert.equal((await saves()).at(-1).background.colors.length, 2);
        assert.deepEqual(await text('.tp-rule'), ['Analogous']);
        await press('.tp-rule');
        assert.equal((await saves()).at(-1).background.wheel, 'complementary');
        assert.deepEqual(await text('.tp-rule'), ['Complementary']);
        await press('.tp-remove');
        assert.equal((await saves()).at(-1).background.colors.length, 1);
        await press('.tp-swatch', 2);
        assert.equal((await saves()).at(-1).background.colors[0], SPACE_COLORS[1], 'the preset\'s exact colour');
        const first = await ev(() => [...document.querySelectorAll('.tp-swatch')].map((b) => b.getAttribute('data-color')));
        await press('.tp-next');
        assert.notDeepEqual(await ev(() => [...document.querySelectorAll('.tp-swatch')].map((b) => b.getAttribute('data-color'))), first, 'the next page');
        await press('.tp-prev');
        await apply();
      });

      await t.test('the theme\'s buttons: an intensity step, a texture, the next texture, an amount; Margin\'s slider, bar and wave, and dial', async () => {
        await press('.tp-step', 2);
        assert.equal((await saves()).at(-1).background.intensity, 0.3);
        await press('.tp-texture', 2);
        assert.deepEqual([(await saves()).at(-1).background.texture, (await saves()).at(-1).background.amount], ['denim', 0.25], 'from none: it starts showing');
        assert.deepEqual(await text('.tp-text'), ['Denim, 25%']);
        await press('.tp-texture-next');
        assert.equal((await saves()).at(-1).background.texture, 'tweed');
        await press('.tp-am', 2);
        assert.equal((await saves()).at(-1).background.amount, 0.5);
        const amount = (await parts()).sliders[1];
        await page.mouse.click(amount.x + amount.width * 0.9, amount.y + amount.height / 2);
        assert.ok((await saves()).at(-1).background.amount >= 0.85, `the bar pressed near its end: ${(await saves()).at(-1).background.amount}`);
        const wave = (await parts()).sliders[0];
        await page.mouse.click(wave.x + 16 + 0.75 * (wave.width - 32), wave.y + wave.height / 2);
        assert.ok(Math.abs((await saves()).at(-1).background.intensity - 0.75) <= 0.02);
        const dial = (await parts()).dials[0];
        await page.mouse.click(dial.x + dial.width / 2, dial.y + dial.height / 2);
        assert.equal((await saves()).at(-1).background.texture, 'dots', 'the dial clicked: the next texture');
        await apply();
      });

      await t.test('a forged item is refused; ⌘Z a step back; Use for All Spaces; Escape what was there; the keys stay in it', async () => {
        const n = (await saves()).length;
        assert.equal(await ev(() => T.rtDispatch('picker.run', 'appearance:purple')), false);
        assert.equal(await ev(() => T.rtDispatch('picker.run', 'preset:99')), false);
        assert.equal((await saves()).length, n, 'nothing saved');
        const before = (await saves()).filter((p) => p.spaceId === 'personal').at(-2).background;
        await page.keyboard.press('ControlOrMeta+z');
        assert.deepEqual((await saves()).at(-1).background, before, 'the one before');
        await apply();
        for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
        assert.ok(await ev(() => !!document.activeElement?.closest('m-picker')), 'Tab stays in it');
        const m = (await saves()).length;
        await press('.tp-all');
        assert.deepEqual((await saves()).slice(m).map((p) => p.spaceId).sort(), ['personal', 'studio', 'work']);
        assert.deepEqual(await text('.tp-all'), ['Used for all spaces']);
        await apply();
        await page.keyboard.press('Escape');
        assert.equal(await isOpen(), false);
        assert.equal((await saves()).filter((p) => p.spaceId === 'personal').at(-1).background, null, 'what it had when it opened (none)');
        assert.equal(await ev(() => document.querySelector('m-picker')?.childElementCount ?? 0), 0, 'the slot empty again');
        await apply();
      });

      await t.test('Done, a press outside: closed', async () => {
        await openFromMenu();
        await press('.tp-done');
        assert.equal(await isOpen(), false);
        await openFromMenu();
        await page.mouse.click(700, 400);
        assert.equal(await isOpen(), false);
      });

      await t.test('an element left out: the rest works; an unknown variant: the default', async () => {
        const l = await mount(testTheme({ part: PART('<m-picker-field class="tp-field" m-variant="zigzag"></m-picker-field>') }));
        assert.ok(l.removed >= 2, 'the unknown variant reported removed too');
        await ev(() => T.rtDispatch('space.editBackground', 'personal'));
        assert.equal((await parts()).variant, 'dots', 'the default variant');
        await page.keyboard.press('Escape');
        await mount(testTheme({ part: PART('') }));
        await ev(() => T.rtDispatch('space.editBackground', 'personal'));
        const p = await parts();
        assert.deepEqual([p.themed, p.field], [true, null], 'no field: the theme\'s choice');
        const n = (await saves()).length;
        await press('.tp-add');
        assert.equal((await saves()).length, n + 1, 'its buttons still work');
        await page.keyboard.press('Escape');
      });

      await t.test('a part with no slot to go in: Margin\'s own panel', async () => {
        await mount(testTheme({ slot: false }));
        await ev(() => T.rtDispatch('space.editBackground', 'personal'));
        assert.equal(await ev(() => !!document.querySelector('margin-background-picker')), true);
        assert.equal((await parts()).themed, undefined);
        await page.keyboard.press('Escape');
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
