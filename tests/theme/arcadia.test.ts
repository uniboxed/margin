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
import { pageLoaderChecks, rgba, near } from './page-card.ts';
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
        // Keep open: the page's card beside the 260 px sidebar, in the 8 px frame, its corners 10 px.
        assert.deepEqual(await layout(), { left: 260, top: 10, right: 10, bottom: 10, radius: 6, width: 1280, height: 800, windowId: 1, mode: 'inpage' });
      });

      await t.test('the width is the theme\'s setting (160–500, step 10); hidden, the page sits in the frame or fills the window', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 330 } } } }));
        assert.equal((await layout())!.left, 330);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 900 } } } }));
        assert.equal((await layout())!.left, 260, 'out of range: the default');
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false } }));
        assert.deepEqual(await layout(), { left: 10, top: 10, right: 10, bottom: 10, radius: 6, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'the frame alone around the page');
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
        const platform = { browser: 'safari', os: 'mac', features: { sleepTabs: 'discard', blockGestures: true, newTabHint: true, search: 'learn', spaceThemes: true } };
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
// and Chromium through the runtime: the page card (10 pt in, a 6 pt corner, Arc's one shadow, no hairline); the
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

      await t.test('the page card: 10 pt in, a 6 pt corner, one shadow and no hairline', async () => {
        const card = (await rect('.card-edge'))!;
        assert.deepEqual([card.top, 1280 - card.right, 800 - card.bottom], [10, 10, 10]);
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
        await away();
        assert.equal((await tip(dotIndex)).shown, false, 'gone at once');
        await at(500);
        const icon = (await rect('.spaces .chip', dotIndex))!;
        await page.mouse.move(icon.x, icon.y);
        await page.waitForTimeout(600);
        assert.equal((await tip(dotIndex)).shown, false, 'none over the icons');
        await away();
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

      await t.test('a folder folded and unfolded: Arc\'s curves, its pins out from under it (not faded)', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed' }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
        assert.equal((await ev(() => T.rtComputed('.arcadia', '--m-rows-feel')))?.trim(), 'arc');
        const folderId = await ev(() => document.querySelector('.folder')!.getAttribute('data-folder-id')!);
        const setOpen = (open: boolean) => ev(([id, o]) => { const rt = (window as any).__rt; rt.mock.state = { ...rt.mock.state, folders: rt.mock.state.folders.map((f: any) => (f.id === id ? { ...f, open: o } : f)) }; rt.host.setState(rt.mock.state); }, [folderId, open] as const);
        const anims = () => ev(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).closest('.margin-sidebar')).map((a) => {
          const e = a.effect as KeyframeEffect;
          const t = e.getTiming();
          const k = e.getKeyframes();
          return { cls: (e.target as Element).className.split(' ')[0], duration: t.duration, easing: t.easing, first: { transform: k[0].transform ?? null, clip: (k[0] as any).clipPath ?? null, opacity: k[0].opacity ?? null }, frames: k.length };
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

      await t.test('"+" as Arc\'s: its popover over the button, its items; Easel and Boost do nothing; New Tab does', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, container: 'document', mode: 'windowed', platform: { browser: 'safari', os: 'mac', features: { newSplit: true } } }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const add = (await rect('.bar .add'))!;
        await page.mouse.click(add.x, add.y);
        await page.waitForTimeout(220); // (the "+" turns in 150 ms)
        const menu = await ev(() => { const m = document.querySelector('.tab-menu')!; const b = m.getBoundingClientRect(); return { arc: m.classList.contains('arc'), labels: [...m.querySelectorAll('.menu-label')].map((l) => l.textContent), keys: [...m.querySelectorAll('.menu-item')].map((i) => i.querySelector('.menu-keys')?.textContent ?? ''), right: Math.round(b.right), bottom: Math.round(b.bottom), width: Math.round(b.width) }; });
        assert.equal(menu.arc, true);
        assert.deepEqual(menu.labels, ['New Space', 'New Folder', 'New Easel', 'New Boost', 'New Split', 'New Tab'], 'Arc\'s items, in its order');
        assert.deepEqual(menu.keys, ['', '', '', '', '⌃⇧=', '⌘T']);
        assert.deepEqual([menu.width, menu.right], [210, Math.round(add.right)], 'its right edge on the button\'s');
        assert.ok(menu.bottom <= add.top - 10, `over the button, its arrow between (${menu.bottom}, ${add.top})`);
        assert.equal(await ev(() => getComputedStyle(document.querySelector('.bar .add .plus-icon')!).rotate), '45deg', '"+" as ×');
        const inert = await ev(() => [...document.querySelectorAll('.tab-menu .menu-item')].filter((i) => i.getAttribute('aria-disabled') === 'true').map((i) => [i.querySelector('.menu-label')!.textContent, i.getAttribute('title')]));
        assert.deepEqual(inert, [['New Easel', 'Easels aren’t in Margin yet: coming soon'], ['New Boost', 'Boosts aren’t in Margin yet: coming soon']]);
        const sent = (await ev(() => T.rtSent())).length;
        const easel = await ev(() => T.rtBoxText('.tab-menu .menu-label', 'New Easel'));
        await page.mouse.click(easel!.x, easel!.y);
        await page.waitForTimeout(40);
        assert.deepEqual([(await ev(() => T.rtSent())).length, (await ev(() => T.rtUi())).menu?.kind], [sent, 'add'], 'Easel: nothing, the menu stays');
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
        assert.deepEqual(await ev(() => [...document.querySelectorAll('.tab-menu .menu-label')].map((l) => l.textContent)), ['New Space', 'New Folder', 'New Easel', 'New Boost', 'New Tab']);
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

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
