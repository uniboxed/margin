// Arcadia as a theme package (app/shared/ui/themes/arcadia/) in real engines:
// Playwright's WebKit and Chromium, headless, every network request refused.
// It loads as a built-in theme, passes the sanitizer with nothing removed,
// renders the sidebar and every part (palette, menu, space editor, notice,
// prompt, launcher) through the runtime with a mock host, places the page's
// box as today's Arcadia does (docked, hidden with and without the frame),
// and Margin's renderer keeps a guarded part's words to Margin's labels
// even for a template that never went through the sanitizer.
// `npm run test:theme`. (The pixel comparison with the old theme JS went
// with it in Phase 1 step 4.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA } from './package.ts';
import { pageLoaderChecks, rgba, near, decodePng } from './page-card.ts';
import { lookOf, appearanceOf } from '../../app/shared/ui/background-look.ts';
import { backgroundOf } from '../../extension/state/model.ts';
import type { SpaceBackground } from '../../types/margin';
import { settingsPageChecks } from './settings-page.ts';
import type { Harness, HarnessRt } from './harness.ts';
import { hitRects } from '../../app/shared/ui/host-app.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;
declare const __rt: HarnessRt;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();
const pkg = themeForPage(ARCADIA);

for (const [name, engine] of ENGINES) {
  test(`Arcadia's package in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const seen: { requests: string[], errors: string[] } = { requests: [], errors: [] };
      page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
      page.on('pageerror', (e) => seen.errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      const layout = async () => { await page.waitForFunction(() => T.rtLayouts().length > 0); return (await page.evaluate(() => T.rtLayouts())).at(-1); };

      await t.test('loads as a built-in theme: theme.json, the template and the stylesheet, nothing removed', async () => {
        const r = await page.evaluate((p) => T.loadBuiltin(p, 'arcadia'), pkg);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'arcadia');
        assert.deepEqual(r.read.sort(), ['theme.css', 'theme.html', 'theme.json']);
      });

      await t.test('the sidebar: the space, its folders and pins, "+ New Tab", the tabs, the chips; the page docked beside it', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage' }));
        assert.deepEqual(await page.evaluate(() => T.rtText('.space-title .title')), ['Personal']);
        assert.equal(await page.evaluate(() => T.rtCount('.tabs .tab')), 170);
        assert.equal(await page.evaluate(() => T.rtCount('.folder')), 2);
        assert.ok(await page.evaluate(() => T.rtCount('.pins .pin')) > 0);
        assert.equal(await page.evaluate(() => T.rtCount('.new-tab-row')), 1);
        assert.equal(await page.evaluate(() => T.rtCount('.chip')), 3);
        assert.equal(await page.evaluate(() => T.rtCount('.chip.active')), 1);
        assert.equal(await page.evaluate(() => T.rtCount('.tabs .tab.active, .pins .pin.active')), 1, 'the switch highlight: one row');
        assert.ok(await page.evaluate(() => T.rtCount('.audible-icon')) > 0, 'playing tabs show a speaker');
        assert.ok(await page.evaluate(() => T.rtCount('.tab.asleep')) > 0, 'sleeping tabs are marked');
        assert.equal(await page.evaluate(() => T.rtCount('[m-action], m-for, m-if')), 0, 'no template syntax left');
        // Keep open: the page's card beside the 260 px sidebar, in the 8 px frame, its corners Arc's 6 px.
        assert.deepEqual(await layout(), { left: 260, top: 8, right: 8, bottom: 8, radius: 6, width: 1280, height: 800, windowId: 1, mode: 'inpage' });
      });

      await t.test('the width is the theme\'s setting (160–500, step 10); hidden, the page sits in the frame or fills the window', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 330 } } } }));
        assert.equal((await layout())!.left, 330);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 900 } } } }));
        assert.equal((await layout())!.left, 260, 'out of range: the default');
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false } }));
        assert.deepEqual(await layout(), { left: 8, top: 8, right: 8, bottom: 8, radius: 6, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'the frame alone around the page');
        assert.equal(await page.evaluate(() => T.rtCount('.peek-zone')), 1);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false, frameWhenHidden: false } }));
        assert.deepEqual(await layout(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'no frame: the whole window');
        await page.evaluate(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(50);
        assert.equal((await page.evaluate(() => T.rtLayouts())).at(-1)!.left, 0, 'out over the page, the sidebar moves nothing');
      });

      // Tirth, 2026-11-25: the sidebar out over the page as tall as the page card and with its corners (as before the Arc
      // branch's 5 pt / 12 pt panel and 10 pt / 6 pt card); every page has the sidebar's button, Margin's own too.
      await t.test('out over the page, the sidebar in the page card\'s frame: its top, bottom and corners the card\'s', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', container: 'document', settings: { sidebarPinnedOpen: false } }));
        const card = (await layout())!;
        await page.evaluate(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForFunction(() => document.querySelector('.margin-sidebar')!.getAnimations().length === 0);
        const panel = await page.evaluate(() => { const el = document.querySelector('.margin-sidebar')!; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: innerHeight - r.bottom, radius: getComputedStyle(el).borderTopLeftRadius, corners: new Set(['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map((k) => (getComputedStyle(el) as any)[k])).size }; });
        assert.deepEqual(panel, { left: card.left, top: card.top, bottom: card.bottom, radius: `${card.radius}px`, corners: 1 }, 'beside the card, its height and corners');
        await page.evaluate(() => T.rtSetUi({ sidebar: null }));
      });

      await t.test('the launcher and Settings as any page: the sidebar\'s button there, the sidebar hidden with Keep open off and out at the edge', async () => {
        const shown = (sel: string) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none' && (el as HTMLElement).getBoundingClientRect().width > 0; }, sel);
        const side = () => page.evaluate(() => document.querySelector('.arcadia')!.getAttribute('data-sidebar'));
        // Margin.app's own window with nothing hosted: its page area the launcher.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'windowed', container: 'document', appWindow: true, settings: { sidebarPinnedOpen: true } }));
        assert.equal(await page.evaluate(() => document.querySelector('.arcadia')!.classList.contains('newtab')), true, 'the launcher');
        assert.deepEqual([await side(), await shown('.keep-open')], ['open', true], 'Keep open on: docked, its button there');
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'windowed', container: 'document', appWindow: true, settings: { sidebarPinnedOpen: false } }));
        assert.deepEqual([await side(), await shown('.peek-zone')], ['hidden', true], 'Keep open off: hidden, out at the left edge');
        assert.deepEqual((await layout())!.left, 8, 'the launcher in the frame, as a page');
        // Its Settings tab (margin://settings): the same.
        await page.evaluate(() => { const rt = (window as any).__rt; rt.host.settingsAsked = true; rt.runtime.render(); });
        assert.equal(await shown('.settings-page'), true, 'Settings drawn');
        assert.equal(await side(), 'hidden');
        await page.evaluate(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForFunction(() => document.querySelector('.margin-sidebar')!.getAnimations().length === 0);
        assert.equal(await shown('.keep-open'), true, 'out over Settings: its button, to keep it open');
        const toggle = await page.evaluate(() => { const b = document.querySelector('.keep-open')!.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
        const sentBefore = (await page.evaluate(() => T.rtSent())).length;
        await page.mouse.click(toggle.x, toggle.y);
        assert.deepEqual((await page.evaluate(() => T.rtSent())).slice(sentBefore).find(([k]) => k === 'updateSettings')?.[1], { patch: { sidebarPinnedOpen: true } }, 'Keep open, from Settings');
        await page.evaluate(() => T.rtSetUi({ sidebar: null }));
        await page.mouse.move(900, 400);
      });

      await t.test('every part: the palette, a menu, the space editor, a notice, a prompt', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage' }));
        await page.evaluate(() => T.rtDispatch('palette.open'));
        assert.equal(await page.evaluate(() => T.rtCount('.palette')), 1);
        assert.ok(await page.evaluate(() => T.rtCount('.palette .result[aria-selected="true"]')) === 1);
        assert.equal(await page.evaluate(() => T.rtActive()), 'palette', 'its field has the focus');
        await page.keyboard.type('zzzz-nothing');
        await page.waitForFunction(() => T.rtCount('.palette .result') >= 1);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => T.rtCount('.palette')), 0);

        const tab = (await page.evaluate(() => T.rtTodayIds(1)))[0];
        await page.evaluate((id) => T.rtSetUi({ menu: { kind: 'tab', id, x: 40, y: 400 } }), tab);
        assert.deepEqual((await page.evaluate(() => T.rtText('.tab-menu .menu-item'))).slice(0, 1), ['Pin Tab']);
        assert.equal(await page.evaluate(() => T.rtAttr('.tab-menu', 'aria-label')), 'Tab');
        await page.evaluate(() => T.rtSetUi({ menu: null }));

        await page.evaluate(() => T.rtDispatch('space.edit', 'personal'));
        assert.equal(await page.evaluate(() => T.rtCount('.space-pane .editor')), 1, 'the editor, under the space\'s name');
        assert.equal(await page.evaluate(() => T.rtCount('.editor .swatch')), 8);
        assert.deepEqual(await page.evaluate(() => T.rtText('.editor .actions button')), ['Delete', 'Cancel', 'Save']);
        assert.equal(await page.evaluate(() => T.rtAttr('.editor .name', 'placeholder')), 'Space name');
        await page.evaluate(() => T.rtDispatch('editor.cancel'));
        assert.equal(await page.evaluate(() => T.rtCount('.editor')), 0);

        await page.evaluate(() => T.rtSetUi({ notice: { id: 'fs', text: 'Margin works in full screen.', actions: [{ id: 'go', label: 'Full screen', primary: true }, { id: 'no', label: 'Not now' }] } }));
        assert.deepEqual(await page.evaluate(() => T.rtText('.notice .text, .notice button')), ['Margin works in full screen.', 'Full screen', 'Not now']);
        const go = await page.evaluate(() => T.rtBox('.notice button.primary'));
        await page.mouse.click(go!.x, go!.y);
        assert.equal(await page.evaluate(() => T.rtCount('.notice')), 0, 'a button closes it');
        assert.deepEqual(await page.evaluate(() => T.rtPerformedFull()), [['notice', { id: 'fs', action: 'go' }]], 'and the host runs it');

        await page.evaluate(() => T.rtSetUi({ prompt: { id: 'app', title: 'Install Margin.app', text: 'Margin needs its app on the Mac.', actions: [{ id: 'later', label: 'Later' }, { id: 'ok', label: 'Install', primary: true }] } }));
        assert.deepEqual(await page.evaluate(() => T.rtText('.prompt-title, .prompt-text, .prompt button')), ['Install Margin.app', 'Margin needs its app on the Mac.', 'Later', 'Install']);
        await page.evaluate(() => T.rtDispatch('prompt.close'));
        assert.equal(await page.evaluate(() => T.rtCount('.prompt')), 0);
        assert.deepEqual(await page.evaluate(() => T.rtRefused()), []);
      });

      await t.test('the new-tab launcher: the search field focused, the space\'s pins as tiles, the archive; Enter goes', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', inNewTab: true }));
        assert.equal(await page.evaluate(() => T.rtCount('.launcher')), 1);
        assert.ok(await page.evaluate(() => T.rtCount('.launcher .tile')) > 0);
        assert.ok(await page.evaluate(() => T.rtCount('.launcher .archive-row')) > 0);
        assert.equal(await page.evaluate(() => T.rtActive()), 'launcher');
        assert.equal((await layout())!.left, 260, 'beside the sidebar, which stays');
        await page.keyboard.type('example.org');
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => T.rtPerformedFull()), [['navigate', { url: 'https://example.org' }]], 'an address: this tab goes there');
      });

      await t.test('the host brings the sidebar out: the show/hide key toggles it, Escape takes it back, a flash goes by itself; Keep open turns off', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false } }));
        const side = () => page.evaluate(() => [__rt.runtime.vm.window.sidebar, __rt.runtime.sidebar.reason()]);
        assert.deepEqual(await side(), ['hidden', null]);
        await page.evaluate(() => __rt.runtime.sidebar.toggle());
        assert.deepEqual(await side(), ['peek', 'toggle']);
        await page.keyboard.press('Escape');
        assert.deepEqual(await side(), ['hidden', null]);
        await page.evaluate(() => __rt.runtime.sidebar.flash(150));
        assert.deepEqual(await side(), ['peek', 'flash']);
        await page.waitForFunction(() => __rt.runtime.vm.window.sidebar === 'hidden', null, { timeout: 2000 });
        await page.evaluate(() => T.rtSettings({ sidebarPinnedOpen: true }));
        assert.deepEqual(await side(), ['open', null]);
        await page.evaluate(() => __rt.runtime.sidebar.toggle());
        assert.deepEqual(await page.evaluate(() => T.rtSent().filter(([k]) => k === 'updateSettings').at(-1)), ['updateSettings', { patch: { sidebarPinnedOpen: false } }], 'with Keep open on, the key turns it off');
        await page.evaluate(() => T.unmountRuntime());
      });

      // Dia's own feel for the space swipe (Tirth, 2026-11-20: Arc's first, then Dia's, its haptic "exactly";
      // shared/space-swipe.ts ARC and FEELS, from their code): half the fingers' distance; with the trackpad's phases
      // (Margin.app), held while the fingers rest and let go at the lift, never by a pause; Dia's tick past halfway; its
      // spring (0.25 s) played as one transition the browser runs; the next space shown as it lands.
      await t.test('space swipe, Dia\'s feel: half the distance, held while the fingers rest, let go at the lift, a tick past halfway, its spring as one transition', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        assert.equal((await page.evaluate(() => T.rtComputed('.margin-sidebar', '--m-swipe-feel')))?.trim(), 'dia', 'Arcadia asks for Dia\'s feel');
        const width = (await page.evaluate(() => T.rtRect('.margin-sidebar')))!.width;
        await page.evaluate(() => T.rtWheelPhase('began'));
        await page.evaluate(() => T.rtTrackpadRun('.space-title .title', [20, 20, 20, 20, 20, 20]));
        const held = await page.evaluate(() => T.rtSwipeTrace('.margin-sidebar', 400)); // the fingers resting, still down
        assert.ok(held.length > 5 && held.every((f) => f.swiping && !f.settling && f.offset === -60), `half of 120 px, held while they rest: ${JSON.stringify(held.slice(-2))}`);
        // The next space's colour mixed in as far as it's drawn while the fingers hold it (Arc: the colour with the swipe).
        const mixed = await page.evaluate(() => { const r = (window as any).__rt.runtime.view.rootElement() as HTMLElement; return { blend: r.style.getPropertyValue('--m-space-blend'), color: r.style.getPropertyValue('--m-space-blend-color'), work: (window as any).__rt.mock.state.spaces.find((s: any) => s.id === 'work').color }; });
        assert.ok(Math.abs(parseFloat(mixed.blend) - 60 / width) < 0.002 && mixed.color === mixed.work, `the next space's colour 60 px of ${width} in: ${JSON.stringify(mixed)}`);
        assert.deepEqual(await page.evaluate(() => T.rtPerformed().filter((n) => n === 'haptic.alignment')), [], 'no tick short of halfway');
        // On past halfway, still moving as they lift: the next space.
        const more = Math.ceil(width / 20) + 2;
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), more);
        assert.deepEqual(await page.evaluate(() => T.rtPerformed().filter((n) => n === 'haptic.alignment')), ['haptic.alignment'], 'one tick past halfway');
        // (Dia checks its detent at each of the trackpad's events: back across halfway, the tick in that event's own task,
        // never a frame later.)
        const back = await page.evaluate((n) => T.rtTrackpadNow('.space-title .title', Array(n).fill(-20)), Math.ceil(width / 20) + 4);
        assert.equal(back.ticks, 2, `back across halfway: its tick at that event, before any frame (${JSON.stringify(back)})`);
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), Math.ceil(width / 20) + 4);
        assert.equal(await page.evaluate(() => T.rtPerformed().filter((n) => n === 'haptic.alignment').length), 3, 'and forward again: one more');
        await page.evaluate(() => T.rtWheelPhase('ended'));
        const settle = await page.evaluate(() => T.rtSwipeTrace('.margin-sidebar', 700));
        const during = settle.filter((f) => f.settling);
        assert.ok(during.length > 3 && during.every((f) => f.offset === -width), `the offset at its end at once: the browser moves it (${JSON.stringify(during.slice(0, 2))})`);
        assert.match(during[0].transition, /^transform \d+ms linear\(0, [\d., ]+, 1\)$/, 'its spring as one transition (a linear() easing)');
        const drawn = during.map((f) => f.drawn).filter((x): x is number => x != null);
        assert.ok(drawn.length > 3 && drawn.some((x) => x > -width + 1 && x < -61), `drawn on its way between frames (${drawn.slice(0, 6)})`);
        assert.ok(drawn.every((x, i) => i === 0 || x <= drawn[i - 1] + 0.05) && drawn.every((x) => x >= -width - 0.5), `toward the next space, never past it: ${drawn.slice(0, 4)} … ${drawn.slice(-2)}`);
        assert.equal(await page.evaluate(() => T.rtSent().filter(([k]) => k === 'setSpace').at(-1)?.[1].spaceId), 'work', 'the next space asked for at the lift');
        await page.waitForFunction(() => T.rtVmFull().spaceName === 'Work', null, { timeout: 2000 });
        // (Asked once: its switch as it lands takes the lift's request; each ask has Margin.app show the space's item
        // again, a second Safari show of the same tab, 2026-11-25.)
        assert.deepEqual(await page.evaluate(() => T.rtSent().filter(([k]) => k === 'setSpace').map(([, p]) => p.spaceId)), ['work'], 'asked for once');
        assert.equal(await page.evaluate(() => T.rtComputed('.space-pane', 'transition-duration')), '0s', 'no transition of the theme\'s on the moving part');
        await page.evaluate(() => T.unmountRuntime());
      });

      // A settle caught by the fingers touching again (as Arc and Dia do; 2026-11-20): held where it's drawn, never a jump;
      // nearer the space it headed for, that one shown at once and swiped on from (a third space in two quick swipes);
      // nearer the one it set out from, swiped back there and that space asked back of the copy; a touch with no swipe
      // after it, settled again to the nearest space.
      await t.test('space swipe, a settle caught: held where it\'s drawn; on to a third space; back again, asked back; a touch alone settles again', async () => {
        const spaceOf = () => page.evaluate(() => (__rt.runtime.vm as any).space.id as string);
        const asked = () => page.evaluate(() => T.rtSent().filter(([k]) => k === 'setSpace').map(([, p]) => p.spaceId as string));
        const sidebar = '.margin-sidebar';
        // Held where it's drawn: `after` (the behavior's own read, held) at `before` (the test's, just before), give or
        // take how far the settle moves (its speed from `prev` to `before`) in the time the dispatch took, and in the way
        // it was moving (rtPhaseRead): a jump is tens of pixels, this a pixel or two.
        type At = { drawn: number, at: number };
        const heldAt = (r: { prev: At, before: At, after: At }, shift = 0) => {
          const speed = (r.before.drawn - r.prev.drawn) / Math.max(1, r.before.at - r.prev.at); // px a ms
          const moved = r.after.drawn - shift - r.before.drawn;
          const allowed = Math.abs(speed) * (r.after.at - r.before.at);
          return Math.abs(moved) <= 1.5 || (Math.sign(moved) === Math.sign(speed) && Math.abs(moved) <= allowed + 1.5);
        };
        // (1) On past the next space: two quick swipes, a third space.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        const width = (await page.evaluate(() => T.rtRect('.margin-sidebar')))!.width;
        const first = await spaceOf();
        const far = Math.ceil(width * 0.075); // (20 px a step, half of it drawn: three quarters of the width, a settle left to run)
        await page.evaluate(() => T.rtWheelPhase('began'));
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), far);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        // (let go a frame after the lift; a few frames into the settle: caught in the fourth)
        const caught = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin', 4), sidebar);
        const second = caught.after.space;
        assert.ok(caught.before.settling && !caught.after.settling && caught.after.swiping, `caught mid-settle: ${JSON.stringify(caught)}`);
        assert.ok(second !== first, 'nearer the space it headed for: that one shown at once');
        assert.ok(heldAt(caught, width), `held where it's drawn, no jump (${JSON.stringify([caught.prev, caught.before])} + ${width} → ${JSON.stringify(caught.after)})`);
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), far);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        await page.waitForFunction((s) => (__rt.runtime.vm as any).space.id !== s, second, { timeout: 3000 });
        const third = await spaceOf();
        assert.ok(third !== first && third !== second, `two quick swipes: a third space (${first} → ${second} → ${third})`);
        assert.deepEqual((await asked()).slice(-1), [third]);
        await page.evaluate(() => T.unmountRuntime());

        // (2) Back to where it set out from: caught early, swiped back, at rest there: that space asked back of the copy.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        const home = await spaceOf();
        await page.evaluate(() => T.rtWheelPhase('began'));
        await page.evaluate(() => T.rtTrackpadRun('.space-title .title', [20, 20, 20, 20, 20, 20]));
        await page.evaluate(() => T.rtWheelPhase('ended')); // (still moving: it heads for the next space)
        const early = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin', 2), sidebar);
        assert.ok(early.before.settling && !early.after.settling, `caught: ${JSON.stringify(early)}`);
        assert.equal(early.after.space, home, 'nearer where it set out from: still that space');
        assert.ok(heldAt(early), `held where it's drawn (${JSON.stringify([early.prev, early.before])} → ${JSON.stringify(early.after)})`);
        const headedFor = (await asked()).at(-1);
        assert.ok(headedFor && headedFor !== home, 'the next space had been asked for at the lift');
        await page.evaluate(() => T.rtTrackpadRun('.space-title .title', [-10, -10, -10, -10, -10, -10]));
        await page.waitForTimeout(300); // (the fingers resting: no speed at the lift, the nearest space)
        await page.evaluate(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => T.rtCount('.m-swiping') === 0, null, { timeout: 3000 });
        assert.equal(await spaceOf(), home, 'back where it set out from');
        assert.deepEqual((await asked()).slice(-1), [home], 'that space asked back of the copy');
        await page.evaluate(() => T.unmountRuntime());

        // (3) A touch and no swipe: settled again, to the nearest space.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        const start = await spaceOf();
        await page.evaluate(() => T.rtWheelPhase('began'));
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), far);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        const touched = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin', 4), sidebar);
        assert.ok(!touched.after.settling && touched.after.space !== start);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => T.rtCount('.m-swiping') === 0, null, { timeout: 3000 });
        assert.equal(await spaceOf(), touched.after.space, 'settled again at the space it was nearest');
        await page.evaluate(() => T.unmountRuntime());
      });

      // What takes the pointer over the page, measured mid-swipe as Margin.app's overlay does (host-app.ts hitRects):
      // the list slid sideways under the page area, clipped by the sidebar, is nothing there (2026-11-20, his recording:
      // swiping back, its rows counted, and Margin.app's pointer catcher, alpha 0.01 a box, drew a sidebar-shaped grey
      // band over the page and took its clicks).
      await t.test('space swipe: nothing more takes the pointer over the page than at rest, held and settling', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        await page.evaluate(() => T.rtSettings({ sidebarPinnedOpen: true }));
        await page.waitForFunction(() => __rt.runtime.vm.window.sidebar === 'open', null, { timeout: 2000 });
        // (From the second space: back is a space's list too, not Arc's Library before the first.)
        await page.evaluate(() => { const rt = __rt as any; rt.mock.state = { ...rt.mock.state, activeSpaceByWindow: { 1: rt.mock.state.spaces[1].id } }; rt.host.setState(rt.mock.state); });
        await page.waitForFunction(() => (__rt.runtime.vm as any).space.id === (__rt as any).mock.state.spaces[1].id, null, { timeout: 2000 });
        const l = (await layout())!;
        assert.ok(l.left > 0, 'the page beside the sidebar');
        const slot = { left: l.left, top: l.top, right: l.width - l.right, bottom: l.height - l.bottom };
        const measure = () => page.evaluate(([src, slot]) => {
          const hits = new Function(`return (${src})`)() as typeof hitRects;
          return hits(__rt.runtime.view.rootElement()!, slot as { left: number, top: number, right: number, bottom: number });
        }, [hitRects.toString(), slot] as const);
        const rest = await measure();
        assert.equal(rest.all, false);
        // (No more than at rest: the resize edge over the page's edge goes while the sidebar clips, not drawn there.)
        const within = (now: { rects: number[][], all: boolean }) => !now.all && now.rects.every(([x, y, w, h]) =>
          rest.rects.some(([X, Y, W, H]) => x >= X && y >= Y && x + w <= X + W && y + h <= Y + H));
        const width = (await page.evaluate(() => T.rtRect('.margin-sidebar')))!.width;
        // Both ways: back (the list sliding right, toward the page: his recording) and on (away from it, the next
        // space's list coming in under the page area).
        for (const dx of [-20, 20]) {
          await page.evaluate(() => T.rtWheelPhase('began'));
          for (const steps of [6, Math.ceil(width / 40), Math.ceil(width / 20)]) {
            await page.evaluate(([n, d]) => T.rtTrackpadRun('.space-title .title', Array(n).fill(d)), [steps, dx] as const);
            assert.ok(await page.evaluate(() => T.rtCount('.m-swiping')) > 0);
            const now = await measure();
            assert.ok(within(now), `${dx < 0 ? 'back' : 'on'}, held ${steps} steps in: nothing more over the page (${JSON.stringify(now)} vs ${JSON.stringify(rest)})`);
          }
          await page.evaluate(() => T.rtWheelPhase('ended'));
          for (let i = 0; i < 4; i++) {
            await page.evaluate(() => T.rtFrames(2));
            const now = await measure();
            assert.ok(within(now), `${dx < 0 ? 'back' : 'on'}, settling: nothing more over the page (${JSON.stringify(now)})`);
          }
          await page.waitForFunction(() => T.rtCount('.m-swiping, .m-settling') === 0, null, { timeout: 3000 });
        }
        await page.evaluate(() => T.unmountRuntime());
      });

      await t.test('the launcher in Margin.app\'s overlay: not focused as it first draws, focused at the app\'s word or when it comes later', async () => {
        // (Its overlay isn't on screen as it first draws: Margin.app starting, a link back, a page reloaded.)
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', inNewTab: true, focusLauncherAtMount: false }));
        assert.equal(await page.evaluate(() => T.rtCount('.launcher')), 1);
        assert.notEqual(await page.evaluate(() => T.rtActive()), 'launcher', 'nothing focused at the mount');
        await page.evaluate(() => __rt.runtime.render());
        assert.notEqual(await page.evaluate(() => T.rtActive()), 'launcher', 'nor at a later drawing of the same launcher');
        // The app showed it over a new window in front (its `shown` push with `focus`).
        assert.equal(await page.evaluate(() => __rt.runtime.focusLauncher()), true);
        assert.equal(await page.evaluate(() => T.rtActive()), 'launcher');
        // With the palette open, the palette keeps the focus.
        await page.evaluate(() => T.rtDispatch('palette.open'));
        assert.equal(await page.evaluate(() => __rt.runtime.focusLauncher()), false);
        assert.equal(await page.evaluate(() => T.rtActive()), 'palette');
        await page.evaluate(() => T.rtDispatch('palette.close'));
        // A launcher that comes after the first drawing (a new tab in the window): focused as it shows.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', inNewTab: false, focusLauncherAtMount: false }));
        assert.equal(await page.evaluate(() => T.rtCount('.launcher')), 0);
        assert.equal(await page.evaluate(() => __rt.runtime.focusLauncher()), false, 'no launcher: nothing to focus');
        await page.evaluate(() => { __rt.host.inNewTab = true; __rt.runtime.render(); });
        assert.equal(await page.evaluate(() => T.rtCount('.launcher')), 1);
        assert.equal(await page.evaluate(() => T.rtActive()), 'launcher');
      });

      await t.test('native keyboard selection immediately highlights a saved row', async () => {
        await page.evaluate(() => T.mountRuntime({ container: 'document', mode: 'fullscreen' }));
        const result = await page.evaluate(() => {
          const state = __rt.host.getState()!;
          const id = 't-saved00001';
          __rt.host.setState({ ...state, keptTabs: { ...state.keptTabs, [id]: { id, url: 'https://saved.test/', title: 'Saved', favIconUrl: '', spaceId: state.activeSpaceByWindow[1], order: 999, lastActive: 0, keptAt: 1, why: 'window' } } });
          __rt.runtime.switchTo(id, new Promise(() => {}));
          return { target: __rt.runtime.ui.switchingTo, active: __rt.runtime.vm.space.today.find((row) => row.id === id)?.active };
        });
        assert.deepEqual(result, { target: 't-saved00001', active: true });
      });

      await t.test('dedicated Settings: its own page, as System Settings (the categories beside the chosen one\'s settings); never under the search field in Margin.app\'s window', async () => {
        await settingsPageChecks(page);
      });

      await t.test('the launcher\'s Settings: Margin\'s inputs in the theme\'s settings part, each saving through its field', async () => {
        const platform = { browser: 'safari', os: 'mac', features: { sleepTabs: 'discard', blockGestures: true, newTabHint: true, search: 'app', spaceThemes: true } };
        await page.evaluate((p) => T.mountRuntime({ container: 'document', mode: 'inpage', inNewTab: true, platform: p, replies: { wakeSleeping: 0 } }), platform);
        await page.evaluate(() => T.rtSetUi({ settingsOpen: true }));
        const form = () => page.evaluate(() => {
          const q = <El extends Element = HTMLInputElement>(s: string) => [...document.querySelectorAll<El>(s)];
          return {
            select: q<HTMLSelectElement>('.settings-form select').map((s) => [s.value, [...s.options].map((o) => o.textContent)]),
            numbers: q('.settings-form input[type="number"]').map((i) => i.value),
            toggles: q('.settings-form input[type="checkbox"][switch]').map((i) => [i.checked, i.disabled]),
            lists: q('.settings-form textarea').length,
            shortcuts: q('.settings-form input.shortcut').map((i) => [i.readOnly, i.value]),
          };
        });
        const f = await form();
        assert.deepEqual(f.select, [
          ['arcadia', ['Arcadia', 'Neubrutalism', 'Pixel', 'Liquid Glass', 'Material']],
          // (Edit Theme Color's ticks: a browser's page plays no haptics, so no Haptics only.)
          ['auto', ['Automatic: a click', 'A click', 'Off']],
          ['global', ['Global across Spaces', 'Per browser profile']],
        ]);
        assert.equal(f.numbers.length, 3, 'two of Margin\'s, and Arcadia\'s own sidebar width (Settings of “Arcadia”)');
        assert.equal(f.toggles.length, 6);
        assert.equal(f.lists, 1);
        assert.equal(f.shortcuts.length, 13, 'the five, and Margin.app\'s eight');
        assert.ok(f.shortcuts.every(([ro]) => ro));
        const lastSent = (type: string) => page.evaluate((t) => T.rtSent().filter(([k]) => k === t).at(-1) ?? null, type);
        await page.click('label:has-text("keep the frame") input');
        assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { frameWhenHidden: false } }]);
        // Theme: the theme of the space shown (2026-11-20: each space has its own), not the profile's.
        await page.selectOption('.settings-form select >> nth=0', 'neubrutalism');
        const space = await page.evaluate(() => T.rtVmFull().space);
        assert.deepEqual(await lastSent('setSpaceTheme'), ['setSpaceTheme', { spaceId: space, theme: 'neubrutalism' }]);
        assert.equal((await page.evaluate(() => T.rtSent().filter(([k, p]) => k === 'updateSettings' && 'theme' in (p?.patch ?? {})))).length, 0, 'the profile\'s theme left as it is');
        assert.match(await page.evaluate(() => document.querySelector('.settings-form')?.textContent ?? ''), /Theme of this space/);
        await page.click('label:has-text("Next tab") input');
        await page.keyboard.press('Control+Alt+KeyN');
        const saved = (await lastSent('updateSettings'))![1].patch.shortcuts;
        assert.match(saved.nextTab, /KeyN$/);
        await page.click('label:has-text("Next space") input');
        await page.keyboard.press('Alt+KeyS');
        assert.match(await page.evaluate(() => document.querySelector('.settings-form .help.error')?.textContent ?? ''), /already used for “Show or hide the sidebar”/);
        await page.keyboard.press('Escape');
        // Margin.app's keys: Delete turns one off; a numbered one takes a digit (its modifiers for 1–9).
        await page.click('label:has-text("Pin or unpin the tab") input');
        await page.keyboard.press('Backspace');
        assert.equal((await lastSent('updateSettings'))![1].patch.appKeys.togglePin, '');
        await page.click('label:has-text("Go to space 1–9") input');
        await page.keyboard.press('Alt+Meta+KeyP');
        assert.match(await page.evaluate(() => document.querySelector('.settings-form .help.error')?.textContent ?? ''), /takes a digit/);
        await page.keyboard.press('Alt+Control+Digit4');
        assert.equal((await lastSent('updateSettings'))![1].patch.appKeys.spaceDigits, 'Ctrl+Alt+Digit1');
        await page.click('button:has-text("Wake all sleeping tabs")');
        await page.waitForFunction(() => /No tabs are asleep/.test(document.querySelector('.settings-form')?.textContent ?? ''));
        assert.deepEqual(await lastSent('wakeSleeping'), ['wakeSleeping', {}]);
        assert.deepEqual(await page.evaluate(() => T.rtRefused()), []);
        await page.evaluate(() => T.unmountRuntime());
      });

      await t.test('Margin\'s renderer keeps guarded parts to Margin\'s labels, whatever template it\'s given', async () => {
        const r = await page.evaluate(() => T.guardedRaw());
        assert.equal(r.menu, 'Close Tab', 'no "Delete", no "Remove:" before the label');
        assert.equal(r.notice, 'Margin works in full screen.', 'the notice\'s own text, not "Update required."');
        assert.equal(r.prompt, '', 'the slot\'s own words are gone');
        assert.deepEqual(r.attrs, [], 'no static tooltip or label anywhere in them');
        assert.equal(r.paths, 1, 'the icon stays');
        assert.ok(r.warnings.some((w) => /Delete/.test(w)), r.warnings.join('\n'));
      });

      await t.test('Margin.app\'s own window with nothing hosted: its page area the launcher, opaque, never a see-through hole', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'windowed', appWindow: true }));
        const e = await page.evaluate(() => T.rtEmptyPage());
        assert.ok(e.page && e.launcher, 'a launcher drawn in the page card');
        const [px, py, pw, ph] = e.page!, [lx, ly, lw, lh] = e.launcher!;
        assert.ok(Math.abs(px + pw / 2 - (lx + lw / 2)) <= 1 && Math.abs(py + ph / 2 - (ly + lh / 2)) <= 1 && lw >= pw - 8 && lh >= ph - 8, `the page's box covered: ${e.page} ${e.launcher}`);
        const alpha = /^rgba\(/.test(e.background!) ? Number(e.background!.split(',').at(-1)!.replace(')', '')) : 1;
        assert.ok(/^rgba?\(/.test(e.background!) && alpha === 1, `opaque: ${e.background}`);
        await page.evaluate(() => T.unmountRuntime());
      });

      // Arcadia's own page loader (Margin.app, while an item opens): a calm white card (near-black in Dark Mode), in
      // its middle a soft tile in the space's colour with a thin ring turning in it, Margin's words under it, muted.
      await pageLoaderChecks(t, browser, {
        id: 'arcadia', dir: ARCADIA, script,
        label: '.opening-label', mark: '.opening-mark',
        animations: ['arcadia-spin'],
        icon: { size: 32 },
        skeleton: [['.space-title .title', ''], ['.space-title .emoji', ''], ['.tabs', '::after'], ['.spaces', '::before']],
        starting: ['arcadia-spin', 'arcadia-breathe'],
        look: async (_page, ev) => {
          const read = () => ev(() => ({ card: T.rtLoader()!.background, tile: T.rtComputed('.opening-mark', 'background-color'), mark: T.rtRect('.opening-mark')!, label: T.rtRect('.opening-label')!, slot: T.rtRect('m-page-loader')!,
            size: T.rtComputed('.opening-label', 'font-size'), color: T.rtComputed('.opening-label', 'color'), radius: T.rtComputed('.opening-mark', 'border-top-left-radius'), ring: T.rtPseudo('.opening-mark', '::after') }));
          const personal = await read();
          assert.deepEqual(rgba(personal.card), [255, 255, 255, 1], 'a white card');
          assert.deepEqual([personal.mark.width, personal.mark.height, personal.radius], [56, 56, '16px'], 'a soft rounded tile');
          assert.ok(Math.abs(personal.mark.x - personal.slot.x) <= 1 && Math.abs(personal.mark.y - personal.slot.y) <= 1, 'in the card\'s middle');
          assert.ok(personal.label.top >= personal.mark.bottom + 8 && Math.abs(personal.label.x - personal.mark.x) <= 1, 'the label under it');
          assert.equal(personal.size, '13px');
          assert.ok(rgba(personal.color)[3] <= 0.6, `muted (${personal.color})`);
          assert.deepEqual([personal.ring?.animation, personal.ring?.width], ['arcadia-spin', 24], 'a thin ring turning in the tile');
          // The tile is the space's colour, soft: #ffd23f at 24 % in white; another space, another tile.
          assert.ok(near(rgba(personal.tile), [255, 244, 209], 4), `the tile in the space's colour (${personal.tile})`);
          await ev(() => T.rtApply('switchSpace', 'work'));
          const work = await read();
          assert.ok(near(rgba(work.tile), [224, 237, 255], 4), `… and in another space's (${work.tile})`);
          await ev(() => T.rtApply('switchSpace', 'personal'));
        },
        looks: [
          ['Dark Mode', { colorScheme: 'dark' }, async (_page, ev) => {
            const d = await ev(() => ({ card: T.rtLoader()!.background, color: T.rtComputed('.opening-label', 'color'), tile: T.rtComputed('.opening-mark', 'background-color') }));
            assert.deepEqual(rgba(d.card), [27, 27, 31, 1], 'a near-black card');
            assert.ok(rgba(d.color)[0] > 200 && rgba(d.tile)[0] < 120, `light words, a dark tile (${d.color}, ${d.tile})`);
          }],
          ['more contrast', { contrast: 'more' }, async (_page, ev) => {
            const c = await ev(() => ({ card: T.rtLoader()!.background, color: T.rtComputed('.opening-label', 'color'), edge: T.rtComputed('.opening-mark', 'box-shadow') }));
            assert.deepEqual([rgba(c.card), rgba(c.color)], [[255, 255, 255, 1], [0, 0, 0, 1]], 'black on white');
            assert.match(c.edge ?? '', /inset/, 'the tile outlined');
          }],
        ],
      });

      await t.test('no request was made, no error thrown', () => {
        assert.deepEqual(seen.requests, []);
        assert.deepEqual(seen.errors, []);
      });
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

// Arcadia as Arc's sidebar (M2.10, docs/ARC-SIDEBAR.md: every number below was measured in Arc 1.174.2), in WebKit
// and Chromium through the runtime: the page card (8 pt in, Arc's 6 pt corner, its one shadow, no hairline); the
// sidebar's sizes (32 pt top buttons, the 36 pt address pill and title row, rows 41 pt apart with 36 pt fills, a
// folder's 22 × 16 glyph and its pins 16 pt in, titles 35 pt into their row, the 50 pt bottom bar under its edge);
// a row's hover (black at 5%, at once); what shows only under the pointer (the space's chevron and •••, the address
// pill's tools, "↓ Clear" while the pointer is anywhere in the sidebar); the inert controls doing nothing; and the
// space's ••• opening the space's own menu under it.
for (const [engineName, engine] of ENGINES) {
  test(`Arcadia as Arc's sidebar in ${engineName}`, async (t) => {
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
      assert.equal((await page.evaluate(([p]) => T.loadBuiltin(p, 'arcadia', []), [themeForPage(ARCADIA)] as const)).ok, true);
      await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed' }));
      await page.waitForFunction(() => T.rtLayouts().length > 0);
      const rect = (s: string, n = 0) => ev(([sel, i]) => T.rtRect(sel, i), [s, n] as const);
      const away = async () => { await page.mouse.move(900, 400); await page.waitForTimeout(40); };

      // (8 pt in and Arc's 6 pt corner, the sidebar out over the page's too: Tirth, 2026-11-25; Arc's inset is 10 pt.)
      await t.test('the page card: 8 pt in, Arc\'s 6 pt corner, one shadow and no hairline', async () => {
        const card = (await rect('.card-edge'))!;
        assert.deepEqual([card.top, 1280 - card.right, 800 - card.bottom], [8, 8, 8]);
        assert.equal(await ev(() => T.rtComputed('.card-edge', 'border-top-left-radius')), '6px');
        const shadow = await ev(() => T.rtComputed('.card-edge', 'box-shadow'));
        assert.match(shadow!, /^rgba\(0, 0, 0, 0\.25\) 0px 1px 7px( 0px)?$/, `Arc's one shadow (${shadow})`);
      });

      await t.test('the sizes Arc measures: top buttons, the address pill, the title row, rows, folders, the bottom bar', async () => {
        const toggle = (await rect('.keep-open'))!;
        assert.deepEqual([toggle.width, toggle.height, toggle.top], [32, 32, 7.5], 'the top bar\'s buttons: 32 pt, 7.5 pt down');
        const controls = (await rect('.window-controls'))!;
        assert.deepEqual([controls.left, controls.y], [12, 23.5], 'the window\'s buttons from 12 pt, centred on the bar');
        assert.equal(toggle.left, 77, 'the sidebar toggle at 77 pt, as Arc\'s');
        const pill = (await rect('.address'))!;
        assert.deepEqual([pill.left, pill.top, pill.height], [8, 46, 36], 'the address pill');
        const title = (await rect('.space-title'))!;
        assert.deepEqual([title.top, title.height], [90, 36], 'the title row under it');
        const emoji = (await rect('.space-title .emoji'))!;
        assert.deepEqual([emoji.left, emoji.width, emoji.height], [13, 26, 26], 'the space\'s icon in a 26 pt box');
        const folder = (await rect('.folder'))!, glyph = (await rect('.folder .folder-icon'))!;
        assert.deepEqual([folder.left, folder.top, folder.height], [8, 131, 36], 'the first row: its fill at 131, 36 tall');
        assert.deepEqual([glyph.width, glyph.height, glyph.left - folder.left], [22, 16, 8.5], 'a folder\'s glyph');
        const folderTitle = (await rect('.folder .title'))!;
        assert.equal(folderTitle.left - folder.left, 35, 'a folder\'s name 35 pt in');
        const pin = (await rect('.pin.nested'))!, pinTitle = (await rect('.pin.nested .title'))!;
        assert.equal(pin.left - folder.left, 16, 'a folder\'s pins 16 pt in');
        assert.deepEqual([pin.height, pinTitle.left - pin.left], [36, 35], 'a pin: 36 pt, its title 35 pt in');
        const rows = await ev(() => [...document.querySelectorAll('.margin-sidebar :is(.pins > .folder, .pins > .pin)')].slice(0, 6).map((e) => e.getBoundingClientRect().top));
        assert.deepEqual(rows.slice(1).map((y, i) => y - rows[i]), [41, 41, 41, 41, 41], 'rows 41 pt apart');
        assert.equal(await ev(() => T.rtComputed('.margin-sidebar .pin .title', 'font-size')), '13.5px');
        const bar = (await rect('.bar'))!, archive = (await rect('.bar .archive'))!, add = (await rect('.bar .add'))!;
        assert.deepEqual([bar.height, archive.left, archive.width, bar.right - add.right, add.width], [50, 8, 32, 8, 32], 'the bottom bar');
        assert.match((await ev(() => T.rtComputed('.bar', 'box-shadow')))!, /rgba\(0, 0, 0, 0\.05\) 0px -1px 0px/, 'its edge');
      });

      await t.test('a row under the pointer: black at 5%, at once', async () => {
        const row = (await rect('.pin.nested', 1))!;
        await page.mouse.move(row.x, row.y);
        await page.waitForTimeout(30);
        assert.equal(await ev(() => getComputedStyle(document.querySelectorAll('.pin.nested')[1]).backgroundColor), 'rgba(0, 0, 0, 0.05)');
        // Its ×: Arc's 26 pt, 4.5 pt in from the fill's right; the title ending before it.
        const x = await ev(() => { const p = document.querySelectorAll('.pin.nested')[1]; const r = p.getBoundingClientRect(), i = p.querySelector('.icon')!.getBoundingClientRect(), t = p.querySelector('.title')!.getBoundingClientRect(); return { w: i.width, inset: Math.round((r.right - i.right) * 10) / 10, mid: Math.round((i.top + i.height / 2 - r.top) * 10) / 10, before: t.right <= i.left }; });
        assert.deepEqual(x, { w: 26, inset: 4.5, mid: 18, before: true }, 'the ×');
        // Dark (Arc's, measured in a dark space): white at 10%.
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.waitForTimeout(30);
        assert.equal(await ev(() => getComputedStyle(document.querySelectorAll('.pin.nested')[1]).backgroundColor), 'rgba(255, 255, 255, 0.1)', 'dark');
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
        assert.equal(await ev(() => getComputedStyle(document.querySelectorAll('.pin.nested')[1]).transitionDuration.split(',').every((d) => d.trim() === '0s' || d.trim() === '0.18s')), true);
        await away();
      });

      await t.test('only under the pointer: the title\'s chevron and •••, the address tools, "↓ Clear" anywhere in the sidebar', async () => {
        const visible = (s: string) => ev((sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0; }, s);
        await away();
        assert.deepEqual([await visible('.title-more'), await visible('.title-chevron'), await visible('.space-title .emoji')], [false, false, true]);
        const title = (await rect('.space-title'))!;
        await page.mouse.move(title.x, title.y);
        await page.waitForTimeout(30);
        assert.deepEqual([await visible('.title-more'), await visible('.title-chevron'), await visible('.space-title .emoji')], [true, true, false], 'the chevron in the icon\'s place, ••• at the right');
        await away();
        assert.equal(await visible('.address-tools'), false);
        const pill = (await rect('.address'))!;
        await page.mouse.move(pill.x, pill.y);
        await page.waitForTimeout(30);
        assert.equal(await visible('.address-tools'), true);
        await away();
        assert.equal(await visible('.clear'), false, 'Clear: not while the pointer is over the page');
        const row = (await rect('.pin.nested'))!;
        await page.mouse.move(row.x, row.y);
        await page.waitForTimeout(30);
        assert.equal(await visible('.clear'), true, 'Clear: while it\'s anywhere in the sidebar');
        await away();
      });

      await t.test('the space switcher, as Arc\'s with ten spaces: slots, icons while each gets 24 pt, else dots; a dot under the pointer swaps with the front one', async () => {
        await ev(() => {
          const rt = (window as any).__rt;
          const extra = Array.from({ length: 10 - rt.mock.state.spaces.length }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}`, emoji: '😀', color: '#0a84ff' }));
          rt.mock.state = { ...rt.mock.state, spaces: [...rt.mock.state.spaces, ...extra] };
          rt.host.setState(rt.mock.state);
        });
        const at = async (w: number) => {
          await ev((width) => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, settings: { ...rt.mock.state.settings, themes: { arcadia: { sidebarWidth: width } } } }; rt.host.setState(rt.mock.state); }, w);
          await page.waitForTimeout(80);
          return ev(() => {
            const nav = document.querySelector('.spaces')!;
            const chips = [...nav.querySelectorAll('.chip')].map((c) => { const b = c.getBoundingClientRect(); return { left: Math.round(b.left * 10) / 10, width: Math.round(b.width * 10) / 10, active: c.classList.contains('active') }; });
            return { crowded: nav.hasAttribute('m-crowded'), chips };
          });
        };
        await away();
        // (Arc, measured: 36 pt slots centred at 500; 33.5 at 400; icons at 310; dots at 300, the front one 24 pt.)
        let d = await at(500);
        assert.deepEqual([d.crowded, d.chips[0].left, d.chips[0].width, d.chips[1].left - d.chips[0].left], [false, 79, 36, 34], 'at 500: 36 pt slots, 2 pt overlap, centred');
        d = await at(400);
        const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 0.2, `${what}: ${a} (want ${b})`);
        assert.equal(d.crowded, false);
        near(d.chips[0].left, 41, 'at 400: from 41 pt');
        near(d.chips[0].width, 33.6, 'at 400: sharing the room');
        d = await at(310);
        assert.equal(d.crowded, false, 'at 310: every icon (each slot 24.6 pt)');
        d = await at(300);
        const front = d.chips.find((c) => c.active)!, other = d.chips.find((c) => !c.active)!;
        assert.deepEqual([d.crowded, front.width], [true, 24], 'at 300: the front one 24 pt, the others dots');
        near(other.width, 23.6, 'at 300: a dot\'s slot');
        d = await at(260);
        near(d.chips.find((c) => !c.active)!.width, 19.1, 'at 260: 19 pt each, as Arc\'s');
        const look = (i: number) => ev((n) => { const c = document.querySelectorAll('.spaces .chip')[n]; const face = c.querySelector('.chip-face')!; return { icon: getComputedStyle(c.querySelector('.chip-icon')!).opacity, dot: getComputedStyle(face, '::after').opacity, dotSize: getComputedStyle(face, '::after').width }; }, i);
        const frontIndex = d.chips.findIndex((c) => c.active), dotIndex = d.chips.findIndex((c) => !c.active);
        assert.deepEqual([await look(frontIndex), await look(dotIndex)], [{ icon: '1', dot: '0', dotSize: '4px' }, { icon: '0', dot: '1', dotSize: '4px' }], 'the front one\'s icon, the others\' 4 pt dots');
        const dot = (await rect('.spaces .chip', dotIndex))!;
        await page.mouse.move(dot.x, dot.y);
        await page.waitForTimeout(60);
        const swapped = await ev(() => [...document.querySelectorAll('.spaces .chip')].map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10));
        assert.equal(swapped[dotIndex], 24, 'the dot under the pointer: its icon in a 24 pt slot');
        assert.ok(swapped[frontIndex] < 24, 'and the front one\'s gives way');
        assert.deepEqual([await look(dotIndex), await look(frontIndex)], [{ icon: '1', dot: '0', dotSize: '4px' }, { icon: '0', dot: '1', dotSize: '4px' }], 'icon and dot swapped');
        await away();
        assert.deepEqual(await look(frontIndex), { icon: '1', dot: '0', dotSize: '4px' }, 'back once the pointer leaves');
        // Arc's tooltip over a dot: after 470 ms, at once; its name; none over the icons (roomy).
        // (Above the dots: Arc's tooltip's bottom 3 pt over them, which start 8 pt into the bar.)
        const tip = (i: number) => ev((n) => { const t = document.querySelectorAll('.spaces .chip')[n].querySelector('.chip-tip')!; const b = t.getBoundingClientRect(); return { shown: getComputedStyle(t).visibility === 'visible', name: t.querySelector('.tip-name')!.textContent, keys: [...t.querySelectorAll('.tip-key')].map((k) => k.textContent), left: Math.round(b.left), above: b.bottom <= document.querySelector('.bar')!.getBoundingClientRect().top + 5.5 }; }, i);
        assert.equal(await ev(() => document.querySelector('.spaces .chip')!.hasAttribute('title')), false, 'no title: Arc shows none over its icons');
        await page.mouse.move(dot.x, dot.y);
        await page.waitForTimeout(300);
        assert.equal((await tip(dotIndex)).shown, false, 'not yet at 300 ms');
        await page.waitForTimeout(260);
        const t1 = await tip(dotIndex);
        assert.deepEqual([t1.shown, t1.above, t1.left], [true, true, 7], `shown over the bar, 7 pt in (${JSON.stringify(t1)})`);
        assert.equal(t1.name, await ev((n) => document.querySelectorAll('.spaces .chip')[n].getAttribute('aria-label'), dotIndex));
        assert.deepEqual(t1.keys, [], 'no keys outside Margin.app');
        // A drawing that leaves the bar as it was (a tab's title, a page loading: Safari's changes come all the time)
        // measures nothing: `m-crowded` never taken off, the tooltip kept shown (2026-11-25: measured after every
        // drawing, each laid the sidebar out twice and restarted the tooltip's delay under the pointer).
        const kept = await ev((n) => new Promise<{ toggles: number, shown: boolean }>((done) => {
          const nav = document.querySelector('.spaces')!;
          let toggles = 0;
          const mo = new MutationObserver((rs) => { toggles += rs.filter((r) => r.attributeName === 'm-crowded').length; });
          mo.observe(nav, { attributes: true });
          const rt = (window as any).__rt;
          const id = Object.keys(rt.mock.state.tabs)[0];
          for (let i = 0; i < 5; i++) {
            rt.mock.state = { ...rt.mock.state, tabs: { ...rt.mock.state.tabs, [id]: { ...rt.mock.state.tabs[id], title: `Retitled ${i}` } } };
            rt.host.setState(rt.mock.state);
          }
          requestAnimationFrame(() => { mo.disconnect(); done({ toggles, shown: getComputedStyle(document.querySelectorAll('.spaces .chip')[n].querySelector('.chip-tip')!).visibility === 'visible' }); });
        }), dotIndex);
        assert.deepEqual(kept, { toggles: 0, shown: true }, 'nothing measured, the tooltip kept');
        await away();
        assert.equal((await tip(dotIndex)).shown, false, 'gone at once');
        await at(500);
        const icon = (await rect('.spaces .chip', dotIndex))!;
        await page.mouse.move(icon.x, icon.y);
        await page.waitForTimeout(600);
        assert.equal((await tip(dotIndex)).shown, false, 'none over the icons');
        await away();
        // Its items changed, its size not: read again (fewer spaces fit, more don't).
        const crowdedNow = () => ev(() => document.querySelector('.spaces')!.hasAttribute('m-crowded'));
        assert.equal((await at(300)).crowded, true);
        const all = await ev(() => (window as any).__rt.mock.state.spaces);
        const withSpaces = (list: unknown[]) => ev((l) => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, spaces: l }; rt.host.setState(rt.mock.state); }, list);
        await withSpaces(all.slice(0, 3));
        assert.equal(await crowdedNow(), false, 'three spaces: every icon');
        await withSpaces(all);
        assert.equal(await crowdedNow(), true, 'ten again: dots');
        await at(260);
      });

      await t.test('a space with its icon removed: a dot in the switcher even when the icons fit; "Remove Icon" in its menu', async () => {
        await ev(() => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, spaces: rt.mock.state.spaces.map((sp: any, i: number) => (i === 1 ? { ...sp, emoji: '' } : sp)), settings: { ...rt.mock.state.settings, themes: { arcadia: { sidebarWidth: 500 } } } }; rt.host.setState(rt.mock.state); });
        await page.waitForTimeout(80);
        await away();
        const chip = await ev(() => { const c = document.querySelectorAll('.spaces .chip')[1]; return { iconless: c.classList.contains('iconless'), dot: getComputedStyle(c.querySelector('.chip-face')!, '::after').opacity, icon: getComputedStyle(c.querySelector('.chip-icon')!).display, crowded: c.parentElement!.hasAttribute('m-crowded') }; });
        assert.deepEqual(chip, { iconless: true, dot: '1', icon: 'none', crowded: false }, 'a dot, the others\' icons');
        // Its menu's "Remove Icon": the space's emoji sent as null (the model stores none).
        const front = (await ev(() => T.rtVmFull())).space;
        const title = (await rect('.space-title'))!;
        await page.mouse.move(title.x, title.y);
        const more = (await rect('.title-more'))!;
        await page.mouse.click(more.x, more.y);
        await page.waitForTimeout(40);
        const item = await ev(() => T.rtBoxText('.menu-item', 'Remove Icon'));
        assert.ok(item, 'offered while it has one');
        await page.mouse.click(item!.x, item!.y);
        await page.waitForTimeout(40);
        const sent = (await ev(() => T.rtSent())).filter(([k]) => k === 'renameSpace').at(-1);
        assert.deepEqual([sent?.[1].spaceId, sent?.[1].emoji], [front, null]);
        await ev(() => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, settings: { ...rt.mock.state.settings, themes: { arcadia: { sidebarWidth: 260 } } } }; rt.host.setState(rt.mock.state); });
      });

      await t.test('a click\'s or a key\'s switch slides the space in as Arc\'s (its spring, 251 ms); a switch mid-slide wins; none with reduced motion', async () => {
        // (A host that answers a space's switch, as the swipe's test's does.)
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', replies: { setSpace: { shown: null } } }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await away();
        const ids = await ev(() => [...document.querySelectorAll('.spaces .chip')].map((c) => c.getAttribute('data-space-id')!));
        const front = (await ev(() => T.rtVmFull())).space;
        const next = ids[ids.indexOf(front) + 1] ?? ids[ids.indexOf(front) - 1];
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        const sentBefore = (await ev(() => T.rtSent())).length;
        await ev((id) => T.rtDispatch('space.switch', id), next);
        const during = await ev(() => { const el = document.querySelector('.margin-sidebar') as HTMLElement; return { classes: [...el.classList].filter((c) => c.startsWith('m-')), transition: el.style.getPropertyValue('--m-swipe-transition'), ghosts: el.querySelectorAll('.m-swipe-ghost').length, offset: el.style.getPropertyValue('--m-swipe-offset') }; });
        assert.deepEqual(during.classes.sort(), ['m-settling', 'm-swiping'], 'sliding');
        assert.match(during.transition, /^transform 251ms linear\(0, 0\.\d+, /, `Arc's switch spring (${during.transition.slice(0, 60)})`);
        assert.equal(during.transition.split(',').length, 61, 'its 61 samples');
        assert.ok(during.ghosts >= 1, 'the space it goes to drawn beside this one');
        assert.ok(parseFloat(during.offset) < -200, `sliding toward it (${during.offset})`);
        assert.equal((await ev(() => T.rtSent())).slice(sentBefore).filter(([k]) => k === 'setSpace').at(0)?.[1].spaceId, next, 'its tab asked for at once');
        assert.equal((await ev(() => T.rtVmFull())).space, front, 'still drawn while it slides in');
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id, next, { timeout: 2000 });
        await page.waitForFunction(() => !document.querySelector('.margin-sidebar')!.classList.contains('m-swiping'), null, { timeout: 2000 });
        // (Asked once: its landing takes the request its slide sent, never a second show of the same tab, 2026-11-25.)
        assert.deepEqual((await ev(() => T.rtSent())).slice(sentBefore).filter(([k]) => k === 'setSpace').map(([, p]) => p.spaceId), [next], 'asked for once');
        // A second switch while one slides in: drawn at once, never undone by the first one's end (from a fresh start, as
        // the slide's end would otherwise switch back to its own).
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', replies: { setSpace: { shown: null } } }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const third = ids.find((id) => id !== front && id !== next)!;
        await ev((id) => T.rtDispatch('space.switch', id), next);
        assert.equal(await ev(() => document.querySelector('.margin-sidebar')!.classList.contains('m-swiping')), true, 'the first slides');
        await page.waitForTimeout(60);
        await ev((id) => T.rtDispatch('space.switch', id), third);
        await page.waitForTimeout(500);
        assert.equal(await ev(() => (window as any).__rt.runtime.vm.space.id), third, 'the last one asked for, not the slide\'s');
        // Reduced motion: at once.
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
        await ev((id) => T.rtDispatch('space.switch', id), front);
        assert.equal(await ev(() => document.querySelector('.margin-sidebar')!.classList.contains('m-swiping')), false, 'no slide');
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id, front, { timeout: 2000 });
      });

      await t.test('the space\'s colour in a slide: the one coming in mixed in as far as it\'s drawn, frame by frame; its own as it lands; its copy in its own; its background too', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', replies: { setSpace: { shown: null } } }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await away();
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        const ids = await ev(() => [...document.querySelectorAll('.spaces .chip')].map((c) => c.getAttribute('data-space-id')!));
        const front = (await ev(() => T.rtVmFull())).space;
        const next = ids[ids.indexOf(front) + 1] ?? ids[ids.indexOf(front) - 1];
        const colorOf = (id: string) => ev((s) => (window as any).__rt.mock.state.spaces.find((x: any) => x.id === s).color as string, id);
        const [fromColor, toColor] = [await colorOf(front), await colorOf(next)];
        assert.notEqual(fromColor, toColor, 'two spaces of different colours');
        // The ground as painted (the page card's spread, --frame), as sRGB bytes (each engine writes color-mix its own way).
        const ground = () => ev(() => {
          const shadow = getComputedStyle(document.querySelector('.page')!).boxShadow;
          const c = document.createElement('canvas'); c.width = c.height = 1;
          const g = c.getContext('2d')!; g.fillStyle = /(rgba?|color|oklab|oklch|lab|lch)\([^)]*\)/.exec(shadow)?.[0] ?? ''; g.fillRect(0, 0, 1, 1);
          return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
        });
        const before = await ground();
        // Each frame of the slide: the blend on the root, where the space is drawn, the ground, the copy's colour.
        const frames = await ev((id) => new Promise<{ blend: string, color: string, x: number, width: number, ground: number[], copy: string }[]>((done) => {
          const out: any[] = [];
          const el = document.querySelector('.margin-sidebar') as HTMLElement;
          const root = (window as any).__rt.runtime.view.rootElement() as HTMLElement;
          const c = document.createElement('canvas'); c.width = c.height = 1;
          const g = c.getContext('2d', { willReadFrequently: true })!;
          T.rtDispatch('space.switch', id);
          const tick = () => {
            if (!el.classList.contains('m-swiping')) return done(out);
            const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el.querySelector('.space-pane:not(.m-swipe-ghost)') ?? el).transform);
            const shadow = getComputedStyle(document.querySelector('.page')!).boxShadow;
            g.fillStyle = /(rgba?|color|oklab|oklch|lab|lch)\([^)]*\)/.exec(shadow)?.[0] ?? ''; g.fillRect(0, 0, 1, 1);
            out.push({ blend: root.style.getPropertyValue('--m-space-blend'), color: root.style.getPropertyValue('--m-space-blend-color'), x: m ? parseFloat(m[1].split(',')[4]) : NaN, width: el.getBoundingClientRect().width, ground: [...g.getImageData(0, 0, 1, 1).data].slice(0, 3), copy: (el.querySelector('.m-swipe-ghost') as HTMLElement | null)?.style.getPropertyValue('--space-color') ?? '' });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }), next);
        assert.ok(frames.length >= 8, `drawn over the slide's frames (${frames.length})`);
        const blends = frames.filter((f) => f.blend !== '').map((f) => parseFloat(f.blend));
        assert.ok(blends.length >= frames.length - 2, `the blend given while it slides (${blends.length} of ${frames.length})`);
        assert.ok(blends.every((b, i) => b >= 0 && b <= 1 && (i === 0 || b >= blends[i - 1] - 0.001)), `0 to 1, never back: ${blends.join(' ')}`);
        assert.ok(blends.some((b) => b > 0.15 && b < 0.85), `part of the way, some frames (${blends.join(' ')})`);
        // As far as the space is drawn (the colour keeps to the slide's own curve, not one of its own): this frame's place
        // or the one before (a loaded machine can read the blend a frame behind the transform).
        const drawnAt = frames.map((f) => (Number.isFinite(f.x) ? Math.min(1, Math.abs(f.x) / f.width) : NaN));
        frames.forEach((f, i) => {
          if (f.blend === '' || !Number.isFinite(drawnAt[i])) return;
          const lo = Math.min(drawnAt[i], drawnAt[i - 1] ?? 0) - 0.03, hi = Math.max(drawnAt[i], drawnAt[i - 1] ?? 0) + 0.03;
          assert.ok(parseFloat(f.blend) >= lo && parseFloat(f.blend) <= hi, `the blend where it's drawn: ${f.blend} at ${f.x} of ${f.width} (a frame before ${drawnAt[i - 1]})`);
        });
        assert.ok(frames.every((f) => f.blend === '' || f.color === toColor), 'the colour of the space coming in');
        assert.ok(frames.some((f) => f.copy === toColor), 'its copy drawn in its own colour');
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id, next, { timeout: 2000 });
        const after = await ground();
        // The ground between the two along the way: neither the first's nor the last's.
        const between = frames.find((f) => parseFloat(f.blend) > 0.3 && parseFloat(f.blend) < 0.7) ?? frames[Math.floor(frames.length / 3)];
        const off = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        assert.ok(off(before, after) > 6, `two grounds (${before} → ${after})`);
        assert.ok(off(between.ground, before) > 2 && off(between.ground, after) > 2, `between them mid-slide (${before} · ${between.ground} · ${after})`);
        // Landed: the space's own colour, nothing of the blend left.
        assert.deepEqual(await ev(() => { const r = (window as any).__rt.runtime.view.rootElement() as HTMLElement; return [r.style.getPropertyValue('--m-space-blend'), r.style.getPropertyValue('--m-space-blend-color')]; }), ['', ''], 'gone as it lands');
        assert.ok(off(frames.at(-1)!.ground, after) <= 3, `its last frame the landed ground (${frames.at(-1)!.ground} → ${after})`);

        // Both spaces with a background: the next one's drawn over this one's as far as it's come, and it's the one
        // shown as it lands (no cross-fade after the slide).
        await ev(([a, b]) => { T.rtChange('setBackground', a, { colors: ['#f7c7d3'], intensity: 0.6, appearance: 'light' }); T.rtChange('setBackground', b, { colors: ['#6c5ce7'], intensity: 0.6, appearance: 'light' }); }, [front, next] as const);
        await page.waitForTimeout(450);
        assert.equal((await ev(() => T.rtBackground())).sets.length, 1);
        const sets = await ev((id) => new Promise<{ n: number, sliding: string | null }[]>((done) => {
          const out: any[] = [];
          const el = document.querySelector('.margin-sidebar') as HTMLElement;
          T.rtDispatch('space.switch', id);
          const tick = () => {
            const d = T.rtBackground() as any;
            out.push({ n: d.sets.length, sliding: d.sets.find((s: any) => s.sliding)?.setOpacity ?? null });
            if (!el.classList.contains('m-swiping')) return done(out);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }), front);
        const opacities = sets.map((s) => s.sliding).filter((o): o is string => o !== null).map(Number);
        assert.ok(opacities.some((o) => o > 0.15 && o < 0.85), `its background part of the way (${opacities.join(' ')})`);
        assert.ok(opacities.every((o, i) => i === 0 || o >= opacities[i - 1] - 0.001), `never back (${opacities.join(' ')})`);
        assert.deepEqual(sets.at(-1), { n: 1, sliding: null }, 'landed: its set the one shown, at once');
        await ev(() => T.rtFrames(2));
        assert.equal((await ev(() => T.rtBackground())).sets.length, 1, 'no cross-fade after it');
      });

      await t.test('a folder folded and unfolded: Arc\'s curves, its pins out from under it (not faded)', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed' }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        assert.equal((await ev(() => T.rtComputed('.arcadia', '--m-rows-feel')))?.trim(), 'arc');
        const folderId = await ev(() => document.querySelector('.folder')!.getAttribute('data-folder-id')!);
        const setOpen = (open: boolean) => ev(([id, o]) => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, folders: rt.mock.state.folders.map((f: any) => (f.id === id ? { ...f, open: o } : f)) }; rt.host.setState(rt.mock.state); }, [folderId, open] as const);
        // (The rows' motion: an icon's poses held still between its moves, a paused animation, and what moves them, a
        // custom property's transition (Arcadia's folder glyph, its --fold), aren't the rows'.)
        const anims = () => ev(() => document.getAnimations().filter((a) => a.playState !== 'paused' && !String((a as Animation & { transitionProperty?: string }).transitionProperty ?? '').startsWith('--') && (a.effect as KeyframeEffect)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).closest('.margin-sidebar')).map((a) => {
          const e = a.effect as KeyframeEffect;
          const t = e.getTiming();
          const k = e.getKeyframes();
          return { cls: ((e.target as Element).getAttribute('class') ?? '').split(' ')[0], duration: t.duration, easing: t.easing, first: { transform: k[0].transform ?? null, clip: (k[0] as any).clipPath ?? null, opacity: k[0].opacity ?? null }, frames: k.length };
        }));
        await setOpen(false);
        const closing = await anims();
        assert.ok(closing.length > 0 && closing.every((a) => a.duration === 250 && a.easing === 'cubic-bezier(0.25, 0, 0.25, 1)'), `folded: the rows after it close up on Arc's closing curve (${JSON.stringify(closing.slice(0, 2))})`);
        await page.waitForTimeout(320);
        await setOpen(true);
        const opening = await anims();
        assert.ok(opening.length > 0 && opening.every((a) => a.duration === 210 && a.easing === 'cubic-bezier(0.5, 0.8, 0.75, 1)'), `unfolded: Arc's opening curve (${JSON.stringify(opening.slice(0, 2))})`);
        const pins = opening.filter((a) => a.first.clip);
        assert.ok(pins.length >= 1, 'its pins come out from under it');
        assert.ok(pins.every((a) => /^translateY\(-\d/.test(String(a.first.transform)) && /^inset\(\d/.test(String(a.first.clip)) && a.first.opacity == null), `slid and clipped, not faded (${JSON.stringify(pins[0])})`);
        await page.waitForTimeout(300);
        assert.deepEqual(await anims(), [], 'nothing left running');
        // A tab closed: where it was, fading (Arc's closing curve), under the rows closing up over it; gone after.
        const closing2 = await ev(() => {
          const rt = (window as any).__rt;
          const today = rt.runtime.vm.space.today;
          const victim = today[0];
          const rows = [...document.querySelectorAll('.margin-sidebar .tab')];
          const top = Math.round(rows[0].getBoundingClientRect().top);
          const tabs = { ...rt.mock.state.tabs }; delete tabs[victim.id];
          rt.mock.state = { ...rt.mock.state, tabs }; rt.host.setState(rt.mock.state);
          const ghost = document.querySelector('.m-row-ghost') as HTMLElement | null;
          const fade = ghost?.getAnimations()[0];
          return { title: victim.title, ghost: ghost ? { text: ghost.textContent!.trim(), top: Math.round(ghost.getBoundingClientRect().top), inert: ghost.hasAttribute('inert'), z: getComputedStyle(ghost).zIndex } : null, timing: fade ? [fade.effect!.getTiming().duration, fade.effect!.getTiming().easing] : null, top };
        });
        assert.ok(closing2.ghost, 'a copy of the closed row');
        assert.equal(await ev(() => [...document.querySelectorAll('.m-row-ghost, .m-row-ghost *')].some((n) => [...n.attributes].some((a) => a.name.startsWith('data-')))), false, 'none of its ids: nothing takes it for a row');
        assert.deepEqual([closing2.ghost!.text.startsWith(closing2.title.slice(0, 10)), closing2.ghost!.top, closing2.ghost!.inert, closing2.ghost!.z], [true, closing2.top, true, '-1'], 'where it was, inert, under the rest');
        assert.deepEqual(closing2.timing, [250, 'cubic-bezier(0.25, 0, 0.25, 1)'], 'fading on Arc\'s closing curve');
        await page.waitForTimeout(350);
        assert.equal(await ev(() => document.querySelectorAll('.m-row-ghost').length), 0, 'gone once faded');
        // A folder folding: its rows go at once (no copies).
        await setOpen(false);
        assert.equal(await ev(() => document.querySelectorAll('.m-row-ghost').length), 0, 'no copies for a folder folding');
        await page.waitForTimeout(300);
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      });

      await t.test('the tooltip in Margin.app: the space\'s profile as a chip, its key as caps', async () => {
        const features = { profileNames: { names: { safari: { 's-default': 'Personal', 's-work': 'Work' } }, fallback: { safari: 's-default' } } };
        await ev((f) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', platform: { browser: 'safari', os: 'mac', app: true, features: f } }), features);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await ev(() => {
          const rt = (window as any).__rt;
          const extra = Array.from({ length: 10 - rt.mock.state.spaces.length }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}`, emoji: '😀', color: '#0a84ff' }));
          const spaces = [...rt.mock.state.spaces, ...extra].map((sp: any, i: number) => ({ ...sp, browser: 'safari', profile: i === 1 ? 's-work' : null }));
          rt.mock.state = { ...rt.mock.state, spaces, settings: { ...rt.mock.state.settings, themes: { arcadia: { sidebarWidth: 260 } } } };
          rt.host.setState(rt.mock.state);
        });
        await page.waitForTimeout(100);
        await away();
        const tipOf = (i: number) => ev((n) => { const t = document.querySelectorAll('.spaces .chip')[n].querySelector('.chip-tip')!; return { shown: getComputedStyle(t).visibility === 'visible', profile: t.querySelector('.tip-profile')?.textContent ?? null, keys: [...t.querySelectorAll('.tip-key')].map((k) => k.textContent).join(' ') }; }, i);
        const front = await ev(() => [...document.querySelectorAll('.spaces .chip')].findIndex((c) => c.classList.contains('active')));
        const other = front === 1 ? 2 : 1;
        const dot = (await rect('.spaces .chip', other))!;
        await page.mouse.move(dot.x, dot.y);
        await page.waitForTimeout(560);
        const t = await tipOf(other);
        assert.deepEqual(t, { shown: true, profile: other === 1 ? 'Work' : 'Personal', keys: `⌃ ${other + 1}` }, 'its profile and its key');
        await away();
      });

      await t.test('"+" as Arc\'s: its popover over the button, its items (Arc\'s without New Easel); Boost does nothing; New Tab does', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', platform: { browser: 'safari', os: 'mac', features: { newSplit: true } } }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const add = (await rect('.bar .add'))!;
        await page.mouse.click(add.x, add.y);
        await page.waitForTimeout(220); // (the "+" turns in 150 ms)
        const menu = await ev(() => { const m = document.querySelector('.tab-menu')!; const b = m.getBoundingClientRect(); return { arc: m.classList.contains('arc'), labels: [...m.querySelectorAll('.menu-label')].map((l) => l.textContent), keys: [...m.querySelectorAll('.menu-item')].map((i) => i.querySelector('.menu-keys')?.textContent ?? ''), right: Math.round(b.right), bottom: Math.round(b.bottom), width: Math.round(b.width) }; });
        assert.equal(menu.arc, true);
        assert.deepEqual(menu.labels, ['New Space', 'New Folder', 'New Boost', 'New Split', 'New Tab'], 'Arc\'s items, in its order, without New Easel (Margin won\'t have Easels)');
        assert.deepEqual(menu.keys, ['', '', '', '⌃⇧=', '⌘T']);
        assert.deepEqual([menu.width, menu.right], [210, Math.round(add.right)], 'its right edge on the button\'s');
        assert.ok(menu.bottom <= add.top - 10, `over the button, its arrow between (${menu.bottom}, ${add.top})`);
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.bar .add .plus-icon')!).rotate), '45deg', '"+" as ×');
        const inert = await ev(() => [...document.querySelectorAll('.tab-menu .menu-item')].filter((i) => i.getAttribute('aria-disabled') === 'true').map((i) => [i.querySelector('.menu-label')!.textContent, i.getAttribute('title')]));
        assert.deepEqual(inert, [['New Boost', 'Boosts aren’t in Margin yet: coming soon']]);
        const sent = (await ev(() => T.rtSent())).length;
        const boost = await ev(() => T.rtBoxText('.tab-menu .menu-label', 'New Boost'));
        await page.mouse.click(boost!.x, boost!.y);
        await page.waitForTimeout(40);
        assert.deepEqual([(await ev(() => T.rtSent())).length, (await ev(() => T.rtUi())).menu?.kind], [sent, 'add'], 'Boost: nothing, the menu stays');
        const tab = await ev(() => T.rtBoxText('.tab-menu .menu-label', 'New Tab'));
        await page.mouse.click(tab!.x, tab!.y);
        await page.waitForTimeout(60);
        assert.equal((await ev(() => T.rtUi())).menu, null, 'New Tab: the menu goes');
        assert.equal((await ev(() => T.rtUi())).palette.open, true, 'and the new tab\'s palette opens');
        await page.keyboard.press('Escape');
        // A host that can't make a split: no New Split.
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed' }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await page.mouse.click(add.x, add.y);
        await page.waitForTimeout(80);
        assert.deepEqual(await ev(() => [...document.querySelectorAll('.tab-menu .menu-label')].map((l) => l.textContent)), ['New Space', 'New Folder', 'New Boost', 'New Tab']);
        await page.keyboard.press('Escape');
      });

      await t.test('the inert controls do nothing; the space\'s ••• opens its menu under it', async () => {
        const before = [await ev(() => T.rtSent().length), await ev(() => T.rtPerformed().length)];
        const title = (await rect('.space-title'))!;
        await page.mouse.move(title.x, title.y);
        const chevron = (await rect('.title-chevron'))!;
        await page.mouse.click(chevron.x, chevron.y);
        const pill = (await rect('.address'))!;
        await page.mouse.move(pill.x, pill.y);
        const site = (await rect('.address-tool.inert'))!;
        await page.mouse.click(site.x, site.y);
        await page.waitForTimeout(40);
        assert.deepEqual([await ev(() => T.rtSent().length), await ev(() => T.rtPerformed().length)], before, 'nothing asked of the host');
        assert.equal((await ev(() => T.rtUi())).menu, null, 'and no menu');
        assert.equal(await ev(() => T.rtAttr('.title-chevron', 'aria-disabled')), 'true');
        await page.mouse.move(title.x, title.y);
        const more = (await rect('.title-more'))!;
        await page.mouse.click(more.x, more.y);
        await page.waitForTimeout(40);
        const ui = (await ev(() => T.rtUi())).menu as { kind: string, id: string, y: number } | null;
        assert.equal(ui?.kind, 'space');
        assert.equal(ui?.id, (await ev(() => T.rtVmFull())).space, 'the space in front\'s');
        assert.ok(Math.abs(ui!.y - more.bottom) < 1, `under the button (${ui!.y}, ${more.bottom})`);
        assert.ok((await ev(() => T.rtVmFull())).menu?.includes('Edit Space…'), 'the space\'s own menu');
        await page.keyboard.press('Escape');
      });

      // The ends of the spaces, as Arc's (docs/ARC-SIDEBAR.md "The ends of the spaces": read from Tirth's recordings and
      // Arc's own tree): its Library before the first space, its pull and Create a Space after the last.
      const ends = () => ev(() => {
        const root = document.querySelector('.arcadia') as HTMLElement;
        const sb = document.querySelector('.margin-sidebar') as HTMLElement;
        const vm = (window as any).__rt.runtime.vm;
        return {
          space: vm.space.id as string, library: vm.library.open as boolean, newSpace: !!vm.newSpace,
          swipe: root.hasAttribute('m-library-swipe'), progress: root.style.getPropertyValue('--m-library-progress'), offset: sb.style.getPropertyValue('--m-swipe-offset'),
          drawn: !!document.querySelector('.library'), pull: sb.hasAttribute('m-pull'), armed: sb.hasAttribute('m-pull-armed'), leaving: sb.hasAttribute('m-pull-leaving'),
          left: T.rtLayouts().at(-1)?.left as number,
        };
      });
      const fresh = async (opts: Record<string, unknown> = {}) => {
        await ev((o) => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', replies: { setSpace: { shown: null }, createSpace: { spaceId: 'sp-made' } }, ...o }), opts);
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await away();
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      };

      await t.test('past the first space, Arc\'s Library: drawn as far as the fingers take it (the space stays, its page beside it to 417 pt), open at the lift past half; back the same way', async () => {
        await fresh();
        const ids = await ev(() => (window as any).__rt.mock.state.spaces.map((s: any) => s.id) as string[]);
        assert.equal((await ends()).space, ids[0], 'the first space in front');
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.margin-sidebar')!).getPropertyValue('--m-swipe-ends').trim()), 'arc', 'Arcadia asks for Arc\'s ends');
        const width = (await rect('.margin-sidebar'))!.width;
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(8).fill(-20)));
        const held = await ends();
        assert.equal(held.swipe, true, 'the Library coming in');
        assert.ok(held.drawn, 'drawn while it can be seen');
        assert.ok(Math.abs(parseFloat(held.progress) - 80 / width) < 0.002, `as far as it's drawn: half the fingers' 160 px of ${width} (${held.progress})`);
        assert.equal(held.offset, '0px', 'nothing of the space moves with the fingers');
        const cardLeft = (await rect('.card-edge'))!.left;
        assert.ok(Math.abs(cardLeft - (width + (417 - width) * parseFloat(held.progress))) < 0.6, `the page beside it as far as it's come (${cardLeft})`);
        const lib = (await rect('.library'))!;
        assert.ok(Math.abs(lib.right - 417 * parseFloat(held.progress)) < 1, `sliding in from the left (its right edge at ${lib.right})`);
        assert.equal(held.space, ids[0], 'no space asked for');
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(12).fill(-20)));
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 2000 });
        const open = await ends();
        assert.deepEqual([open.swipe, open.progress, open.left], [false, '', 417], 'open: nothing of the swipe left, the page beside its 417 pt');
        assert.equal((await rect('.library'))!.width, 417);
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.margin-sidebar')!).visibility), 'hidden', 'the space under it out of the way');
        assert.ok(!(await ev(() => T.rtSent())).some(([k]) => k === 'setSpace'), 'no switch of space');
        // Back: toward the next space, over the Library.
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.library .lib-main', Array(8).fill(20)));
        const back = await ends();
        assert.ok(back.swipe && Math.abs(parseFloat(back.progress) - (1 - 80 / 417)) < 0.003, `going as far as it's drawn (${back.progress})`);
        await ev(() => T.rtTrackpadRun('.library .lib-main', Array(16).fill(20)));
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open && !document.querySelector('.arcadia')!.hasAttribute('m-library-swipe'), null, { timeout: 2000 });
        await ev(() => T.rtFrames(2));
        const closed = await ends();
        assert.deepEqual([closed.drawn, Math.round((await rect('.card-edge'))!.left), closed.space], [false, width, ids[0]], 'closed: gone, the page back, the same space');
        // Let go short of half: back where it was, never open.
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(4).fill(-20)));
        await page.waitForTimeout(200); // (the fingers resting: no flick at the lift)
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForTimeout(700);
        assert.deepEqual([(await ends()).library, (await ends()).swipe, (await ends()).left], [false, false, width], 'short of half: back');
      });

      await t.test('one space: its ends still there (the Library before it, Create a Space after it), as Arc\'s', async () => {
        await fresh();
        await ev(() => { const rt = (window as any).__rt; const one = rt.mock.state.spaces[0]; rt.mock.state = { ...rt.mock.state, spaces: [one], activeSpaceByWindow: { 1: one.id } }; rt.host.setState(rt.mock.state); });
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.spaces.length === 1, null, { timeout: 2000 });
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(8).fill(-20)));
        assert.equal((await ends()).swipe, true, 'toward the Library');
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(36).fill(20)));
        const pulled = await ends();
        assert.deepEqual([pulled.swipe, pulled.pull, pulled.armed], [false, true, true], 'and on past it: the pull, armed');
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => !!(window as any).__rt.runtime.vm.newSpace, null, { timeout: 1000 });
        await ev(() => T.rtDispatch('newSpace.cancel'));
      });

      await t.test('a key\'s switch of space while the Library or Create a Space is open: they go, and that space is shown', async () => {
        await fresh();
        const ids = await ev(() => (window as any).__rt.mock.state.spaces.map((s: any) => s.id) as string[]);
        // (Motion allowed: a switch could slide, as the bug did: taken for the Library's settle and lost.)
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open && !document.querySelector('.arcadia')!.hasAttribute('m-library-swipe'), null, { timeout: 2000 });
        await ev((id) => T.rtDispatch('space.switch', id), ids[1]);
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id, ids[1], { timeout: 2000 });
        assert.equal((await ends()).library, false, 'the Library gone');
        await ev(() => T.rtDispatch('newSpace.open'));
        await ev((id) => T.rtDispatch('space.switch', id), ids[0]);
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id, ids[0], { timeout: 2000 });
        assert.equal((await ends()).newSpace, false, 'Create a Space gone, nothing made');
        assert.ok(!(await ev(() => T.rtSent())).some(([k]) => k === 'createSpace'));
      });

      await t.test('a space\'s background cut out where the page card is at every frame of the Library\'s slide, both ways (the card never shown over the background\'s old cut-out)', async () => {
        // (2026-11-26, Tirth's recordings: the slide moved the card without resizing it, so the view never reported its
        // place until the slide's end, and the background stayed cut out at the old place: a band of background over
        // the page, its border missing, the page "stuck" until the jump.)
        await fresh();
        await ev(() => { const r = document.querySelector('.arcadia')!; r.setAttribute('m-page-state', 'shown'); r.setAttribute('m-page-slides', ''); });
        await ev((b) => T.rtChange('setBackground', 'personal', b), { colors: ['#f7c7d3', '#cfe8f7'], intensity: 0.6, texture: 'grain', amount: 0, appearance: 'light' });
        await page.waitForTimeout(450);
        const slide = (action: string) => ev((a) => new Promise<number[][]>((done) => {
          const out: number[][] = [];
          const cut = () => { const m = /Z\s*M\s*([\d.]+)/.exec(T.rtBackground().clip as string); return m ? Number(m[1]) : -1; };
          const tick = () => {
            const card = document.querySelector('.card-edge')!.getBoundingClientRect().left;
            out.push([Math.round(card), Math.round(cut())]);
            if (out.length < 45) requestAnimationFrame(tick); else done(out);
          };
          T.rtDispatch(a);
          requestAnimationFrame(tick);
        }), action);
        for (const [action, to] of [['library.open', 417], ['library.close', null]] as const) {
          const frames = await slide(action);
          assert.ok(frames.some(([c]) => c !== frames[0][0]) || to === null, `${action}: the card moved (${JSON.stringify(frames)})`);
          // (The cut's first point is the card's left plus its top-left radius: 6 pt.)
          const off = frames.filter(([c, x]) => Math.abs(x - (c + 6)) > 1);
          assert.deepEqual(off, [], `${action}: the background cut out where the card is, every frame (${JSON.stringify(frames)})`);
          if (to) assert.equal(frames.at(-1)![0], to);
        }
        // The Library's Spaces in Margin's window: the page slid out from under the panel, so the panel is see-through over
        // the background itself (its grain, as the other sections), the background cut out only at the page's sliver;
        // in the browsers' overlay (no m-page-state: the page stays under the panel) the background's one colour there.
        const panel = () => ev(() => getComputedStyle(document.querySelector('.library')!).backgroundColor);
        const cutAt = () => ev(() => { const m = /Z\s*M\s*([\d.]+)/.exec(T.rtBackground().clip as string); return m ? Math.round(Number(m[1])) : -1; });
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await page.locator('.lib-section[data-icon="spaces"]').first().click();
        await page.waitForFunction(() => { const r = document.querySelector('.arcadia')!; return r.classList.contains('library-wide') && !r.hasAttribute('m-library-wide-slide'); }, null, { timeout: 2000 });
        await page.waitForTimeout(100);
        assert.equal(await panel(), 'rgba(0, 0, 0, 0)', 'Spaces see-through in Margin\'s window');
        // (No shadow where the panel meets the page slid out beside it: the panel's none, the card's faded out.)
        const shadows = () => ev(() => [getComputedStyle(document.querySelector('.library')!).boxShadow, getComputedStyle(document.querySelector('.card-edge')!).boxShadow]);
        const [panelShadow, cardShadow] = await shadows();
        assert.equal(panelShadow, 'none', 'the panel casts none on the page');
        assert.match(cardShadow, /^rgba\(0, 0, 0, 0\) /, `the card's shadow gone (${cardShadow})`);
        assert.equal(await cutAt(), 1280 - 56 + 6, 'the background cut out only where the page\'s sliver is');
        await ev(() => { const r = document.querySelector('.arcadia')!; r.removeAttribute('m-page-state'); r.removeAttribute('m-page-slides'); });
        await page.waitForTimeout(50);
        assert.notEqual(await panel(), 'rgba(0, 0, 0, 0)', 'the overlay: the background\'s one colour over the page');
        assert.notEqual((await shadows())[0], 'none', 'the overlay: the panel over the page casts its shadow');
        // (A hosted window that can't pass the edge (m-page-state without m-page-slides): the panel over the page, as the
        // overlay's.)
        await ev(() => document.querySelector('.arcadia')!.setAttribute('m-page-state', 'shown'));
        await page.waitForTimeout(50);
        assert.notEqual(await panel(), 'rgba(0, 0, 0, 0)', 'a window that can\'t pass the edge: the one colour over the page');
        assert.equal(Math.round((await rect('.card-edge'))!.left), 260 + Math.round((417 - 260)), 'its page beside the Library, not slid past the edge');
        await ev(() => { const r = document.querySelector('.arcadia')!; r.setAttribute('m-page-state', 'shown'); r.setAttribute('m-page-slides', ''); });
        await page.locator('.lib-section[data-icon="archive"]').first().click();
        await ev(() => T.rtDispatch('library.close'));
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await ev(() => T.rtChange('setBackground', 'personal', null));
        await ev(() => { const r = document.querySelector('.arcadia')!; r.removeAttribute('m-page-state'); r.removeAttribute('m-page-slides'); });
      });

      await t.test('the Library\'s rail and section apart as Arc\'s: a hairline and a shadow into the section from 112 pt, the rail lighter by the edge (measured on Arc)', async () => {
        await fresh();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await page.waitForTimeout(100);
        // (A row clear of the rail's sections and the section's rows: below the lowest of them, above the rail's foot.)
        const y = await ev(() => {
          const lowest = Math.max(...[...document.querySelectorAll('.lib-main *, .lib-rail *')].map((e) => e.getBoundingClientRect().bottom).filter((b) => b < innerHeight - 50));
          return Math.round(Math.min(innerHeight - 56, Math.max(lowest + 12, innerHeight / 2)));
        });
        const px = decodePng(await page.screenshot({ animations: 'disabled' }));
        const lum = (x: number) => { const [r, g, b] = px(x, y); return (r + g + b) / 3; };
        // (The section's ground well past the shadow, inside the Library's 417 pt.)
        const base = lum(380);
        assert.ok(Math.abs(lum(300) - base) <= 1 && Math.abs(lum(200) - base) <= 1, `the section's ground past the shadow (${lum(200)} ${lum(300)} ${base})`);
        const dark = (x: number) => 1 - lum(x) / base;
        const light = (x: number) => (lum(x) - base) / (255 - base);
        // (Its half-point hairline is a device pixel on a Retina screen; at this page's 1x it's dropped to the shadow's.)
        assert.ok(dark(112) > 0.042 && dark(112) < 0.075, `the edge at 112 (${dark(112).toFixed(3)})`);
        assert.ok(dark(111) < 0, `the rail's side of the edge lighter (${dark(111).toFixed(3)})`);
        assert.ok(dark(114) > 0.035 && dark(114) < 0.055, `the shadow just inside (${dark(114).toFixed(3)})`);
        assert.ok(dark(130) > 0.015 && dark(130) < 0.032, `fading by 18 pt (${dark(130).toFixed(3)})`);
        assert.ok(Math.abs(dark(152)) < 0.006, `gone by 40 pt (${dark(152).toFixed(3)})`);
        assert.ok(light(110) > 0.03 && light(110) < 0.06, `the rail lighter by the edge (${light(110).toFixed(3)})`);
        assert.ok(light(40) > 0.008 && light(40) < 0.03, `the rail a little lighter than the section (${light(40).toFixed(3)})`);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await ev(() => T.rtDispatch('library.close'));
      });

      await t.test('into Spaces and out, the Library open: the panel and the page slide there together on Arc\'s switch curve (the background cut where the card is, the host told), never at once', async () => {
        await fresh();
        await ev(() => { const r = document.querySelector('.arcadia')!; r.setAttribute('m-page-state', 'shown'); r.setAttribute('m-page-slides', ''); });
        await ev((b) => T.rtChange('setBackground', 'personal', b), { colors: ['#f7c7d3', '#cfe8f7'], intensity: 0.6, texture: 'grain', amount: 0, appearance: 'light' });
        await page.waitForTimeout(450);
        const vw = await ev(() => innerWidth);
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open && !document.querySelector('.arcadia')!.hasAttribute('m-library-swipe'), null, { timeout: 3000 });
        await page.waitForTimeout(100);
        const slide = (section: string) => ev((sec) => new Promise<number[][]>((done) => {
          const out: number[][] = [];
          const cut = () => { const m = /Z\s*M\s*([\d.]+)/.exec(T.rtBackground().clip as string); return m ? Number(m[1]) : -1; };
          const tick = () => {
            const card = document.querySelector('.card-edge')!.getBoundingClientRect(), panel = document.querySelector('.library')!.getBoundingClientRect();
            // (The panel's edge as seen: into Spaces it's its whole width from the first frame, cut back by its
            // clip-path to where the slide has come (Library 417 + the rest × the slide's progress).)
            const root = document.querySelector('.arcadia') as HTMLElement;
            const into = root.getAttribute('m-library-wide-slide') === 'in';
            const q = Number(root.style.getPropertyValue('--m-library-wide-progress') || 0);
            const seen = into ? panel.left + 417 + (panel.width - 417) * q : panel.right;
            out.push([Math.round(card.left), Math.round(seen), Math.round(cut()), Math.round(card.width), into ? Math.round(panel.width) : -1]);
            if (out.length < 50) requestAnimationFrame(tick); else done(out);
          };
          (window as any).__told = T.rtResizing().length;
          T.rtDispatch('library.section', sec);
          requestAnimationFrame(tick);
        }), section);
        for (const [section, from, to] of [['spaces', 417, vw - 56], ['archive', vw - 56, 417]] as const) {
          const frames = await slide(section);
          const lefts = frames.map(([l]) => l);
          // (Its first frame where it was: the section's own first draw comes before any move, so a hosted window never
          // runs ahead of a panel still drawing the old section.)
          assert.equal(lefts[0], from, `${section}: the first frame where it was (${lefts.slice(0, 4).join(' ')})`);
          assert.ok(lefts.some((l) => l > Math.min(from, to) + 5 && l < Math.max(from, to) - 5), `${section}: slid through the frames between (${lefts.join(' ')})`);
          assert.ok(lefts.every((l, i) => i === 0 || (to > from ? l >= lefts[i - 1] - 1 : l <= lefts[i - 1] + 1)), `${section}: one way (${lefts.join(' ')})`);
          assert.equal(lefts.at(-1), to, `${section}: lands at ${to}`);
          assert.deepEqual(frames.filter(([l, p]) => Math.abs(l - p) > 1), [], `${section}: the panel's edge where the page's is, every frame`);
          // (Into Spaces, the panel its whole width all the way, so every card is drawn before it's revealed.)
          if (section === 'spaces') {
            const sliding = frames.filter((f) => f[4] !== -1);
            assert.ok(sliding.length > 2, `into Spaces: frames of the slide (${sliding.length})`);
            assert.deepEqual([...new Set(sliding.map((f) => f[4]))], [vw - 56], 'into Spaces: the panel its whole width while it slides');
          }
          assert.deepEqual(frames.filter(([l, , c]) => Math.abs(c - (l + 6)) > 1), [], `${section}: the background cut where the card is, every frame`);
          assert.ok(frames.every(([, , , w]) => w === frames[0][3]), `${section}: the page's width kept`);
          const told = await ev(() => T.rtResizing().slice((window as any).__told).map(([on]) => on));
          assert.deepEqual(told, [true, false], `${section}: the host told it moves, then that it's over`);
          assert.equal(await ev(() => document.querySelector('.arcadia')!.hasAttribute('m-library-wide-slide')), false, `${section}: the slide's mark gone`);
        }
        // With less motion: at once, nothing told.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ev(() => { (window as any).__told = T.rtResizing().length; T.rtDispatch('library.section', 'spaces'); });
        assert.equal(Math.round((await rect('.card-edge'))!.left), vw - 56, 'less motion: there at once');
        assert.equal(await ev(() => document.querySelector('.arcadia')!.hasAttribute('m-library-wide-slide')), false);
        await ev(() => T.rtDispatch('library.section', 'archive'));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        // Two slides at once (a trackpad swipe back out of the Library begun as the slide out of Spaces starts): the host
        // told once that the page moves, and once that it's over, as the last of them ends (each told its own before:
        // the first over turned the live follow off while the other still moved the page).
        await ev(() => T.rtDispatch('library.section', 'spaces'));
        await page.waitForFunction(() => { const r = document.querySelector('.arcadia')!; return r.classList.contains('library-wide') && !r.hasAttribute('m-library-wide-slide'); }, null, { timeout: 2000 });
        await ev(() => { (window as any).__told = T.rtResizing().length; T.rtDispatch('library.section', 'archive'); });
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.library .lib-main', Array(24).fill(20)));
        const overlapped = await ev(() => document.querySelector('.arcadia')!.hasAttribute('m-library-swipe'));
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => { const r = document.querySelector('.arcadia')!; return !(window as any).__rt.runtime.vm.library.open && !r.hasAttribute('m-library-swipe') && !r.hasAttribute('m-library-wide-slide'); }, null, { timeout: 3000 });
        assert.equal(overlapped, true, 'the swipe under way');
        const both = await ev(() => T.rtResizing().slice((window as any).__told).map(([on]) => on));
        assert.deepEqual(both, [true, false], `two slides at once: told once, over once as the last ends (${both.join(' ')})`);
        await ev(() => T.rtChange('setBackground', 'personal', null));
        await ev(() => { const r = document.querySelector('.arcadia')!; r.removeAttribute('m-page-state'); r.removeAttribute('m-page-slides'); });
      });

      await t.test('the Library\'s Spaces as Arc\'s: each card on its own space\'s background (Margin draws it), its text in that space\'s colours, Arc\'s shadow; a space with none the theme\'s colour', async () => {
        await fresh();
        const ids = await ev(() => (window as any).__rt.mock.state.spaces.map((sp: any) => sp.id) as string[]);
        const DARK = { colors: ['#1b2a4a', '#3a2b5c'], intensity: 0.8, texture: 'grain', amount: 0.3, appearance: 'dark' };
        await ev(([id, b]) => T.rtChange('setBackground', id, b), [ids[1], DARK] as const);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await ev(() => T.rtDispatch('library.section', 'spaces'));
        await page.waitForFunction(() => document.querySelectorAll('.lib-card').length > 1, null, { timeout: 3000 });
        await page.waitForTimeout(100);
        const cards = await ev(() => [...document.querySelectorAll<HTMLElement>('.lib-card')].map((c) => {
          const r = c.getBoundingClientRect();
          return { id: c.dataset.spaceId, grounded: c.hasAttribute('m-grounded'), drawn: !!c.querySelector(':scope > margin-background'), color: getComputedStyle(c).color, shadow: getComputedStyle(c).boxShadow, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.75), w: r.width, h: r.height };
        }));
        const dark = cards.find((c) => c.id === ids[1])!, plain = cards.find((c) => c.id === ids[0])!;
        assert.ok(dark && plain, JSON.stringify(cards.map((c) => c.id)));
        assert.deepEqual([dark.grounded, dark.drawn], [true, true], 'its space\'s background drawn in it by Margin');
        assert.deepEqual([plain.grounded, plain.drawn], [false, false], 'a space with none: the theme\'s colour');
        const bg = backgroundOf(DARK) as SpaceBackground;
        const want = lookOf(bg, appearanceOf(bg, false), { size: { width: dark.w, height: dark.h } }).vars['--m-fg'];
        const hex = (rgb: string) => `#${(rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
        assert.equal(hex(dark.color), want.toLowerCase(), 'its text in that space\'s own colour (light on a dark space)');
        const px = decodePng(await page.screenshot({ animations: 'disabled' }));
        const lum = (x: number, y: number) => { const [r, g, b] = px(x, y); return (r + g + b) / 3; };
        assert.ok(lum(dark.x, dark.y) < 110, `the dark space's card drawn dark (${lum(dark.x, dark.y)})`);
        assert.ok(lum(plain.x, plain.y) > 150, `the plain one light (${lum(plain.x, plain.y)})`);
        // (0.155 as the browser keeps an alpha: in 255ths, 40/255 = 0.157.)
        assert.ok(cards.every((c) => /^rgba\(0, 0, 0, 0\.15[5-7]\d*\) 0px 0\.5px 16px 0px$/.test(c.shadow)), `Arc's shadow (${cards[0].shadow})`);
        // Its background gone: the card the theme's again.
        await ev(([id]) => T.rtChange('setBackground', id, null), [ids[1]] as const);
        await page.waitForTimeout(100);
        assert.deepEqual(await ev((id) => { const c = document.querySelector<HTMLElement>(`.lib-card[data-space-id="${id}"]`)!; return [c.hasAttribute('m-grounded'), !!c.querySelector(':scope > margin-background'), c.style.getPropertyValue('--m-fg')]; }, ids[1]), [false, false, ''], 'let go: nothing of Margin\'s left on it');
        await ev(() => T.rtDispatch('library.section', 'archive'));
        await ev(() => T.rtDispatch('library.close'));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      });

      await t.test('a hosted window that can\'t pass the window\'s edge (no m-page-slides): the Library makes room, the page\'s right edge where it was', async () => {
        await fresh();
        await ev(() => document.querySelector('.arcadia')!.setAttribute('m-page-state', 'shown'));
        const card0 = (await rect('.card-edge'))!;
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ev(() => T.rtDispatch('library.open'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await page.waitForTimeout(50);
        const open = (await rect('.card-edge'))!;
        assert.deepEqual([Math.round(open.left), Math.round(open.right)], [417, Math.round(card0.right)], 'beside the Library, its right edge in the window: room made');
        assert.ok((await ev(() => T.rtPlaces())).every(([, r]: number[]) => r >= 0), 'never past the window\'s edge');
        await ev(() => T.rtDispatch('library.close'));
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await ev(() => document.querySelector('.arcadia')!.removeAttribute('m-page-state'));
      });

      await t.test('a sidebar wider than the Library (500 pt): the Library as wide as it, the page never moved (no gap at the window\'s edge, nothing resized)', async () => {
        await fresh({ settings: { themes: { arcadia: { sidebarWidth: 500 } } } });
        await ev(() => { const r = document.querySelector('.arcadia')!; r.setAttribute('m-page-state', 'shown'); r.setAttribute('m-page-slides', ''); });
        const card0 = (await rect('.card-edge'))!;
        assert.equal(Math.round(card0.left), 500, 'the sidebar 500 wide');
        await ev(() => { (window as any).__told = T.rtResizing().length; });
        const frames = await ev(() => new Promise<number[][]>((done) => {
          const out: number[][] = [];
          const tick = () => {
            const c = document.querySelector('.card-edge')!.getBoundingClientRect();
            out.push([Math.round(c.left), Math.round(c.right)]);
            if (out.length < 40) requestAnimationFrame(tick); else done(out);
          };
          T.rtDispatch('library.open');
          requestAnimationFrame(tick);
        }));
        assert.ok((await ev(() => (window as any).__rt.runtime.vm.library.open)), 'open');
        assert.deepEqual([...new Set(frames.map((f) => f.join()))], [`${Math.round(card0.left)},${Math.round(card0.right)}`], `the page where it was, every frame (${JSON.stringify(frames)})`);
        assert.equal(Math.round((await rect('.library'))!.width), 500, 'the Library the sidebar\'s width');
        assert.deepEqual(await ev(() => T.rtResizing().slice((window as any).__told)), [], 'the host never told: nothing to follow');
        await ev(() => T.rtDispatch('library.close'));
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open, null, { timeout: 3000 });
        await ev(() => { const r = document.querySelector('.arcadia')!; r.removeAttribute('m-page-state'); r.removeAttribute('m-page-slides'); });
      });

      await t.test('the box button slides the Library in (Arc\'s switch spring), its back arrow out; while an app is hosted it\'s the sidebar\'s width and the page stays', async () => {
        await fresh();
        const box = (await rect('.bar .archive'))!;
        const tracing = ev(() => new Promise<string[]>((done) => {
          const out: string[] = [];
          const tick = () => { const r = document.querySelector('.arcadia') as HTMLElement; out.push(r.style.getPropertyValue('--m-library-progress')); if (!(window as any).__rt.runtime.vm.library.open && out.length < 120) requestAnimationFrame(tick); else done(out); };
          requestAnimationFrame(tick);
        }));
        await page.mouse.click(box.x, box.y);
        const ps = (await tracing).filter(Boolean).map(Number);
        assert.ok(ps.length >= 4 && ps.some((p) => p > 0.2 && p < 0.9) && ps.every((p, i) => i === 0 || p >= ps[i - 1] - 0.01), `slid in (${ps.join(' ')})`);
        assert.equal((await ends()).left, 417);
        await page.locator('.lib-back').first().click();
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open, null, { timeout: 2000 });
        await page.waitForTimeout(50);
        assert.deepEqual([(await ends()).drawn, (await ends()).left], [false, 260], 'the back arrow: gone, the page back');
        // Hosted (the host marks the root m-sidebar-fixed): the Library the sidebar's width, the page where it is; the
        // rail's icons only.
        await ev(() => document.querySelector('.arcadia')!.setAttribute('m-sidebar-fixed', ''));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.locator('.bar .archive').first().click();
        assert.equal((await ends()).library, true, 'at once with reduced motion');
        await page.waitForTimeout(50);
        assert.deepEqual([(await rect('.library'))!.width, (await ends()).left], [260, 260], 'the sidebar\'s width, the page where it was');
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.lib-label')!).display), 'none', 'icons only');
        await page.locator('.lib-back').first().click();
        await ev(() => document.querySelector('.arcadia')!.removeAttribute('m-sidebar-fixed'));
        // Margin.app's own window (m-page-state; shown: Safari full screen in its page area): the page slides right as
        // Arc's does, its width kept, the rest past the window's edge, so the hosted window is only moved, followed live
        // (the host told once, before the first moved place); never resized at every frame (each width placed Safari
        // again, out of full screen and back: 2026-11-26). The Library Arc's 417 pt, its labels shown.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await ev(() => { const r = document.querySelector('.arcadia')!; r.setAttribute('m-page-state', 'shown'); r.setAttribute('m-page-slides', ''); });
        const card0 = (await rect('.card-edge'))!;
        const vw = await ev(() => innerWidth);
        await ev(() => T.rtSentClear());
        await ev(() => { (window as any).__resized0 = T.rtResizing().length; });
        await ev(() => T.rtWheelPhase('began'));
        const cards: { left: number, width: number }[] = [];
        for (let i = 0; i < 6; i++) {
          await ev(() => T.rtTrackpadRun('.space-title .title', Array(4).fill(-20)));
          const c = (await rect('.card-edge'))!;
          cards.push({ left: c.left, width: c.width });
        }
        assert.equal((await ends()).swipe, true, 'the Library coming in');
        assert.ok(cards.some((c) => c.left > card0.left + 1), `the page slides right (${cards.map((c) => c.left).join(' ')})`);
        assert.ok(cards.every((c) => Math.abs(c.width - card0.width) < 0.5), `its width kept (${cards.map((c) => c.width).join(' ')})`);
        const told = await ev(() => T.rtResizing().slice((window as any).__resized0));
        assert.deepEqual(told.map(([on]) => on), [true], 'the host told once, while it moves');
        assert.equal(told[0][1], null, 'before the first moved place was reported');
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(12).fill(-20)));
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => (window as any).__rt.runtime.vm.library.open, null, { timeout: 2000 });
        await page.waitForTimeout(50);
        const open = (await rect('.card-edge'))!;
        assert.deepEqual([Math.round(open.left), Math.round(open.width)], [417, Math.round(card0.width)], 'open: beside the Library\'s 417 pt, as wide as before');
        assert.ok(open.right > vw, `past the window's right edge (${open.right} of ${vw})`);
        assert.equal((await rect('.library'))!.width, 417, 'Arc\'s Library');
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.lib-label')!).display) !== 'none', true, 'its labels');
        assert.equal(await ev(() => document.scrollingElement!.scrollLeft), 0, 'nothing scrolled');
        const places = await ev(() => T.rtPlaces());
        assert.ok(places.length > 1 && places.every(([l, r]: number[]) => l + r === places[0][0] + places[0][1] && Number.isInteger(l) && Number.isInteger(r)), `each place as wide, at whole points (${JSON.stringify(places)})`);
        assert.deepEqual(await ev(() => T.rtResizing().slice((window as any).__resized0)), [[true, null], [false, 417]], 'over once open, after its last place (417) was reported');
        // The Library's Spaces (Arc's whole-window manager): the page slides on to the panel's edge, its first 56 pt showing,
        // its width kept (slid there on Arc's switch curve: the next test).
        await page.locator('.lib-section[data-icon="spaces"]').first().click();
        await page.waitForFunction(() => { const r = document.querySelector('.arcadia')!; return r.classList.contains('library-wide') && !r.hasAttribute('m-library-wide-slide'); }, null, { timeout: 2000 });
        await page.waitForTimeout(50);
        const wide = (await rect('.card-edge'))!;
        assert.deepEqual([Math.round(wide.left), Math.round(wide.width)], [vw - 56, Math.round(card0.width)], 'Spaces: the page past the panel, 56 pt of it showing, as wide');
        await page.locator('.lib-section[data-icon="archive"]').first().click();
        await page.waitForFunction(() => { const r = document.querySelector('.arcadia')!; return !r.classList.contains('library-wide') && !r.hasAttribute('m-library-wide-slide'); }, null, { timeout: 2000 });
        await page.waitForTimeout(50);
        assert.equal(Math.round((await rect('.card-edge'))!.left), 417, 'back beside the Library');
        // Back out (the box's back arrow slides it): the host told before the page's first move away from 417, over at
        // its old place.
        await ev(() => { (window as any).__resized2 = T.rtResizing().length; });
        await page.locator('.lib-back').first().click();
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.library.open, null, { timeout: 2000 });
        await page.waitForTimeout(50);
        assert.deepEqual([Math.round((await rect('.card-edge'))!.left), Math.round((await rect('.card-edge'))!.width)], [Math.round(card0.left), Math.round(card0.width)], 'back: where it was');
        assert.deepEqual(await ev(() => T.rtResizing().slice((window as any).__resized2)), [[true, 417], [false, Math.round(card0.left)]], 'told before its first move back, over at its old place');
        // A tile beside the app (m-sidebar-fixed): the page stays, so the host is never told (nothing to follow or place).
        await ev(() => document.querySelector('.arcadia')!.setAttribute('m-sidebar-fixed', ''));
        await ev(() => { (window as any).__resized1 = T.rtResizing().length; });
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(16).fill(-20)));
        assert.equal((await ends()).swipe, true);
        assert.equal(Math.round((await rect('.card-edge'))!.left), Math.round(card0.left), 'the page where it is');
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForTimeout(700);
        assert.deepEqual(await ev(() => T.rtResizing().slice((window as any).__resized1)), [], 'not told');
        if ((await ends()).library) await page.locator('.lib-back').first().click();
        await ev(() => document.querySelector('.arcadia')!.removeAttribute('m-sidebar-fixed'));
        await ev(() => { const r = document.querySelector('.arcadia')!; r.removeAttribute('m-page-state'); r.removeAttribute('m-page-slides'); });
      });

      await t.test('the Library\'s rail, as Arc\'s: Archived Tabs Margin\'s archive by day (searched, a row restores it); the sections Margin hasn\'t got say so', async () => {
        await fresh();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const now = Date.now();
        await ev((t0) => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, archive: [
          { id: 'a1', title: 'Today\'s page', url: 'https://www.today.example/a', closedAt: t0 - 60_000 },
          { id: 'a2', title: 'An older page', url: 'https://old.example/b', closedAt: t0 - 10 * 86_400_000 },
        ] }; rt.host.setState(rt.mock.state); }, now);
        await ev(() => T.rtDispatch('library.open'));
        const read = () => ev(() => ({
          sections: [...document.querySelectorAll('.lib-section')].map((b) => [b.textContent!.trim(), b.classList.contains('active')]),
          days: [...document.querySelectorAll('.lib-day')].map((d) => d.textContent!.trim()),
          rows: [...document.querySelectorAll('.lib-row')].map((r) => [r.querySelector('.lib-title')!.textContent!.trim(), r.querySelector('.lib-sub')!.textContent!.trim()]),
          placeholder: (document.querySelector('.lib-search input') as HTMLInputElement | null)?.placeholder ?? null,
          filter: !!document.querySelector('.lib-filter'), empty: document.querySelector('.lib-empty-title')?.textContent?.trim() ?? null,
          line: document.querySelector('.lib-empty-text')?.textContent?.trim() ?? null,
        }));
        const a = await read();
        assert.deepEqual(a.sections.map(([l]) => l), ['Media', 'Downloads', 'Spaces', 'Boosts', 'Archived Tabs'], 'Arc\'s rail, in its order, without Easels');
        assert.deepEqual(a.sections.find(([, on]) => on)?.[0], 'Archived Tabs', 'Archived Tabs first');
        assert.deepEqual([a.placeholder, a.filter], ['Search Archive…', true]);
        assert.deepEqual(a.days, ['Today', '1 week ago']);
        assert.deepEqual(a.rows, [['Today\'s page', 'today.example/a'], ['An older page', 'old.example/b']], 'newest first, the address as Arc writes it');
        // Search.
        await page.fill('.lib-search input', 'older');
        assert.deepEqual((await read()).rows.map(([t]) => t), ['An older page'], 'searched');
        await page.fill('.lib-search input', 'nothing like it');
        assert.deepEqual([(await read()).empty, (await read()).line], [null, 'No results found for \u201cnothing like it\u201d'], 'Arc\'s words');
        await page.keyboard.press('Escape');
        assert.equal((await read()).rows.length, 2, 'Escape clears the search first');
        // A row restores its tab.
        await page.locator('.lib-row').nth(1).click();
        assert.deepEqual((await ev(() => T.rtSent())).filter(([k]) => k === 'restoreArchive').map(([, p]) => p.archiveId), ['a2'], 'restored');
        // A section Margin hasn't got: chosen, its words.
        await page.locator('.lib-section').nth(3).click();
        const e = await read();
        assert.deepEqual([e.empty, e.line, e.placeholder, e.filter, e.rows.length], ['Nothing Boosted Yet!', 'Type \u201cNew Boost\u201d in URL bar to make your own, or grab one from the Boost Gallery.', 'Search Boosts…', false, 0], 'Arc\'s words');
        // Arc's words for each (read from its app), its icons: the one shown filled white, darker.
        await page.locator('.lib-section').nth(1).click();
        assert.deepEqual([(await read()).empty, (await read()).line], ['Nothing here yet!', 'Come back after you\u2019ve found some cool stuff to save.']);
        await page.locator('.lib-section').nth(3).click();
        assert.equal((await read()).empty, 'Nothing Boosted Yet!');
        const fills = await ev(() => [...document.querySelectorAll('.lib-section')].map((b) => getComputedStyle(b.querySelector('.li:not([style*="none"]) .s, .li .s')!).fill));
        assert.ok(fills[3] !== fills[0] && /255, 255, 255|#fff/.test(fills[3]), `the one shown filled white (${fills.join(' / ')})`);
        // Spaces: Arc's space manager across the window, a card per space as its sidebar has it.
        await page.locator('.lib-section').nth(2).click();
        assert.equal((await read()).placeholder, null, 'Spaces: no search, as Arc\'s');
        await page.waitForTimeout(300);
        const cards = await ev(() => [...document.querySelectorAll('.lib-card')].map((c) => ({ name: c.querySelector('.lc-name')!.textContent!.trim(), rows: c.querySelectorAll('.lc-row').length, width: c.getBoundingClientRect().width })));
        const names = await ev(() => (window as any).__rt.runtime.vm.spaces.map((s: any) => s.name));
        assert.deepEqual(cards.map((c) => c.name), names, 'every space, in order');
        assert.ok(cards.every((c) => c.width === 240 && c.rows > 0), `240 pt cards with their rows (${JSON.stringify(cards)})`);
        assert.equal((await rect('.library'))!.width, 1280 - 56, 'across the window but its last 56 pt');
        assert.equal(Math.round((await rect('.card-edge'))!.left), 417, 'the page where it was, under it');
        await page.locator('.lib-card').nth(1).locator('.lc-edit').click();
        assert.equal((await ev(() => T.rtVmFull())).editor?.name, names[1], 'its pencil edits that space');
        await page.keyboard.press('Escape');
        await ev(() => T.rtDispatch('library.close'));
      });

      await t.test('past the last space, Arc\'s pull: the rubber band, its "+" white past 24 pt; let go then, Create a Space at once (nothing made yet); short of it, back', async () => {
        await fresh();
        const ids = await ev(() => (window as any).__rt.mock.state.spaces.map((s: any) => s.id) as string[]);
        await ev((id) => T.rtDispatch('space.switch', id), ids.at(-1)!);
        await page.waitForFunction((id) => (window as any).__rt.runtime.vm.space.id === id && !document.querySelector('.margin-sidebar')!.classList.contains('m-swiping'), ids.at(-1)!, { timeout: 2000 });
        await ev(() => T.rtSentClear());
        // Short of it.
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(5).fill(20)));
        const short = await ends();
        const px = await ev(() => parseFloat((document.querySelector('.margin-sidebar') as HTMLElement).style.getPropertyValue('--m-pull')));
        assert.deepEqual([short.pull, short.armed], [true, false], 'pulling, not armed');
        assert.ok(px > 0 && px < 24 && Math.abs(parseFloat(short.offset) + px) < 0.01, `the space drawn past its end (${px} px)`);
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.pull-button')!).display), 'block', 'its "+"');
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForTimeout(60);
        assert.equal((await ends()).leaving, true, 'its "+" going');
        await page.waitForTimeout(500);
        const back = await ends();
        assert.deepEqual([back.newSpace, back.pull, back.leaving], [false, false, false], 'back: nothing opened, nothing left');
        // Past it.
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.space-title .title', Array(26).fill(20)));
        assert.equal((await ends()).armed, true, 'armed');
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.pull-dot')!).transform), 'matrix(0, 0, 0, 0, 0, 0)', 'white: the blue gone');
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => !!(window as any).__rt.runtime.vm.newSpace, null, { timeout: 1000 });
        const made = await ends();
        assert.deepEqual([made.newSpace, made.space, made.leaving], [true, ids.at(-1), true], 'Create a Space, the space it was opened from still in front, the "+" going');
        assert.ok(!(await ev(() => T.rtSent())).some(([k]) => k === 'createSpace' || k === 'setSpace'), 'nothing made, nothing switched');
        assert.equal(await ev(() => document.querySelectorAll('.spaces .chip.making.active').length), 1, 'the space being made in front in the switcher');
        assert.equal(await ev(() => document.querySelectorAll('.spaces .chip.active:not(.making)').length), 0);
        await page.waitForTimeout(250);
        assert.equal((await ends()).pull, false, 'the "+" gone');
      });

      await t.test('Create a Space, as Arc\'s: its name focused; Create Space makes it (its name, icon, colour); Cancel and Escape make nothing; a swipe back takes it away; Choose a Theme makes it and opens Edit Theme Color', async () => {
        await fresh({ platform: { browser: 'safari', os: 'mac', app: true, features: { profileNames: { names: { safari: { 's-default': 'Personal', 's-work': 'Work' } }, fallback: { safari: 's-default' } } } } });
        await ev(() => T.rtSentClear());
        await ev(() => T.rtDispatch('newSpace.open'));
        await ev(() => T.rtFrames(2));
        assert.equal((await ev(() => T.rtFocus()))?.input, 'new-space-name', 'its name focused');
        const color = await ev(() => (window as any).__rt.runtime.vm.newSpace.color as string);
        assert.equal(await ev(() => (document.querySelector('.arcadia') as HTMLElement).style.getPropertyValue('--space-color')), color, 'drawn in the colour it\'ll get');
        assert.equal(await ev(() => document.querySelector('.ns-create')!.classList.contains('ready')), false, 'no name: Create Space can\'t');
        assert.equal(await ev(() => document.querySelector('.ns-chip')?.textContent?.trim()), 'Personal', 'its profile: the space\'s (the browser\'s default)');
        // The profile from its menu.
        await page.locator('.ns-chip').first().click();
        assert.deepEqual((await ev(() => T.rtVmFull())).menu, ['Personal', 'Work']);
        await page.locator('m-menu').getByText('Work', { exact: true }).click();
        assert.equal(await ev(() => document.querySelector('.ns-chip')?.textContent?.trim()), 'Work', 'Work chosen');
        await page.fill('.ns-emoji', '🚀');
        await page.fill('.ns-input', 'Trips');
        assert.equal(await ev(() => document.querySelector('.ns-create')!.classList.contains('ready')), true);
        await page.locator('.ns-create').first().click();
        const sent = (await ev(() => T.rtSent())).filter(([k]) => k === 'createSpace').map(([, p]) => p);
        assert.equal(sent.length, 1, 'made once');
        assert.deepEqual({ ...sent[0], windowId: undefined }, { windowId: undefined, name: 'Trips', emoji: '🚀', color, profile: 's-work' }, 'its name, icon, colour and profile');
        assert.equal((await ends()).newSpace, false, 'closed');
        // Cancel, Escape: nothing.
        await ev(() => T.rtSentClear());
        await ev(() => T.rtDispatch('newSpace.open'));
        await page.locator('.ns-cancel').first().click();
        assert.equal((await ends()).newSpace, false, 'Cancel');
        await ev(() => T.rtDispatch('newSpace.open'));
        await ev(() => T.rtFrames(2));
        await page.keyboard.press('Escape');
        assert.equal((await ends()).newSpace, false, 'Escape');
        assert.ok(!(await ev(() => T.rtSent())).some(([k]) => k === 'createSpace'), 'nothing made');
        // A swipe toward the previous space: the space it was opened from coming back, Create a Space gone.
        await ev(() => T.rtDispatch('newSpace.open'));
        await ev(() => T.rtWheelPhase('began'));
        await ev(() => T.rtTrackpadRun('.new-space', Array(10).fill(-20)));
        const sliding = await ev(() => ({ moved: (document.querySelector('.margin-sidebar') as HTMLElement).style.getPropertyValue('--m-swipe-offset'), ghost: document.querySelectorAll('.m-swipe-ghost').length }));
        assert.ok(parseFloat(sliding.moved) > 50 && sliding.ghost >= 1, `it moves with the fingers, the space beside it (${JSON.stringify(sliding)})`);
        await ev(() => T.rtTrackpadRun('.new-space', Array(14).fill(-20)));
        await ev(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => !(window as any).__rt.runtime.vm.newSpace, null, { timeout: 2000 });
        assert.ok(!(await ev(() => T.rtSent())).some(([k]) => k === 'createSpace' || k === 'setSpace'), 'cancelled: nothing made, no switch');
        // Choose a Theme: made, then Edit Theme Color for it once it's there.
        await ev(() => T.rtDispatch('newSpace.open'));
        await page.fill('.ns-input', 'Themed');
        await page.locator('.ns-theme').first().click();
        assert.equal((await ev(() => T.rtSent())).filter(([k]) => k === 'createSpace').at(-1)?.[1].name, 'Themed');
        await ev(() => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, spaces: [...rt.mock.state.spaces, { id: 'sp-made', name: 'Themed', emoji: '✨', color: '#00b894' }] }; rt.host.setState(rt.mock.state); });
        await page.waitForFunction(() => T.rtPanel().open, null, { timeout: 2000 }).catch(() => {});
        assert.equal((await ev(() => T.rtPanel())).open, true, 'Edit Theme Color opened for it');
        assert.equal((await ev(() => T.rtUi())).menu, null);
        // Arc's "+" New Space opens it too.
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !T.rtPanel().open, null, { timeout: 2000 }).catch(() => {});
        await ev(() => T.rtDispatch('menu.open', 'add'));
        await page.locator('m-menu').getByText('New Space').click();
        assert.equal((await ends()).newSpace, true, '"+" New Space: Create a Space');
        await ev(() => T.rtDispatch('newSpace.cancel'));
      });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
