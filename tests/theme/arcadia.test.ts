// Arcadia as a theme package (extension/themes/arcadia/) in real engines:
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
import { pageLoaderChecks, rgba, near } from './page-card.ts';
import { settingsPageChecks } from './settings-page.ts';
import type { Harness, HarnessRt } from './harness.ts';

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
        // Keep open: the page's card beside the 260 px sidebar, in the 8 px frame, its corners 10 px.
        assert.deepEqual(await layout(), { left: 260, top: 8, right: 8, bottom: 8, radius: 10, width: 1280, height: 800, windowId: 1, mode: 'inpage' });
      });

      await t.test('the width is the theme\'s setting (160–500, step 10); hidden, the page sits in the frame or fills the window', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 330 } } } }));
        assert.equal((await layout())!.left, 330);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 900 } } } }));
        assert.equal((await layout())!.left, 260, 'out of range: the default');
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false } }));
        assert.deepEqual(await layout(), { left: 8, top: 8, right: 8, bottom: 8, radius: 10, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'the frame alone around the page');
        assert.equal(await page.evaluate(() => T.rtCount('.peek-zone')), 1);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false, frameWhenHidden: false } }));
        assert.deepEqual(await layout(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'no frame: the whole window');
        await page.evaluate(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(50);
        assert.equal((await page.evaluate(() => T.rtLayouts())).at(-1)!.left, 0, 'out over the page, the sidebar moves nothing');
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
        assert.deepEqual(await page.evaluate(() => T.rtPerformed().filter((n) => n === 'haptic.alignment')), [], 'no tick short of halfway');
        // On past halfway, still moving as they lift: the next space.
        const more = Math.ceil(width / 20) + 2;
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), more);
        assert.deepEqual(await page.evaluate(() => T.rtPerformed().filter((n) => n === 'haptic.alignment')), ['haptic.alignment'], 'one tick past halfway');
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
        // (1) On past the next space: two quick swipes, a third space.
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, replies: { setSpace: { shown: null } } }));
        const width = (await page.evaluate(() => T.rtRect('.margin-sidebar')))!.width;
        const first = await spaceOf();
        const far = Math.ceil(width * 0.075); // (20 px a step, half of it drawn: three quarters of the width, a settle left to run)
        await page.evaluate(() => T.rtWheelPhase('began'));
        await page.evaluate((n) => T.rtTrackpadRun('.space-title .title', Array(n).fill(20)), far);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        await page.evaluate(() => T.rtFrames(4)); // (let go a frame after the lift; a few frames into the settle)
        const caught = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin'), sidebar);
        const second = caught.after.space;
        assert.ok(caught.before.settling && !caught.after.settling && caught.after.swiping, `caught mid-settle: ${JSON.stringify(caught)}`);
        assert.ok(second !== first, 'nearer the space it headed for: that one shown at once');
        assert.ok(Math.abs(caught.after.drawn - (caught.before.drawn + width)) <= 1.5, `held where it's drawn, no jump (${caught.before.drawn} + ${width} → ${caught.after.drawn})`);
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
        await page.evaluate(() => T.rtFrames(2));
        const early = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin'), sidebar);
        assert.ok(early.before.settling && !early.after.settling, `caught: ${JSON.stringify(early)}`);
        assert.equal(early.after.space, home, 'nearer where it set out from: still that space');
        assert.ok(Math.abs(early.after.drawn - early.before.drawn) <= 1.5, `held where it's drawn (${early.before.drawn} → ${early.after.drawn})`);
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
        await page.evaluate(() => T.rtFrames(4));
        const touched = await page.evaluate((sel) => T.rtPhaseRead(sel, 'mayBegin'), sidebar);
        assert.ok(!touched.after.settling && touched.after.space !== start);
        await page.evaluate(() => T.rtWheelPhase('ended'));
        await page.waitForFunction(() => T.rtCount('.m-swiping') === 0, null, { timeout: 3000 });
        assert.equal(await spaceOf(), touched.after.space, 'settled again at the space it was nearest');
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
        const platform = { browser: 'safari', os: 'mac', features: { sleepTabs: 'discard', blockGestures: true, newTabHint: true, search: 'learn' } };
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
        assert.deepEqual(f.select, [['arcadia', ['Arcadia', 'Neubrutalism', 'Pixel', 'Liquid Glass', 'Material']]]);
        assert.equal(f.numbers.length, 3, 'two of Margin\'s, and Arcadia\'s own sidebar width (Settings of “Arcadia”)');
        assert.equal(f.toggles.length, 5);
        assert.equal(f.lists, 1);
        assert.equal(f.shortcuts.length, 5);
        assert.ok(f.shortcuts.every(([ro]) => ro));
        const lastSent = (type: string) => page.evaluate((t) => T.rtSent().filter(([k]) => k === t).at(-1) ?? null, type);
        await page.click('label:has-text("keep the frame") input');
        assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { frameWhenHidden: false } }]);
        await page.selectOption('.settings-form select', 'neubrutalism');
        assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { theme: 'neubrutalism' } }]);
        await page.click('label:has-text("Next tab") input');
        await page.keyboard.press('Control+Alt+KeyN');
        const saved = (await lastSent('updateSettings'))![1].patch.shortcuts;
        assert.match(saved.nextTab, /KeyN$/);
        await page.click('label:has-text("Next space") input');
        await page.keyboard.press('Alt+KeyS');
        assert.match(await page.evaluate(() => document.querySelector('.settings-form .help.error')?.textContent ?? ''), /already used for “Show or hide the sidebar”/);
        await page.keyboard.press('Escape');
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
