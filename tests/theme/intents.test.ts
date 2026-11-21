// What a click on the sidebar draws before the state comes back (ui/intents.ts, shared/switching.ts) and how rows
// leave (ui/row-motion.ts), in every built-in theme, in real engines (Playwright's WebKit and Chromium, headless,
// every network request refused), with Margin.app's host answering `SLOW` ms late (the state, then the answer, as
// Margin.app does): a tab's row and a pin with no tab are in front on the next frame; a closed row is gone on the next
// frame and the rows after it slide up; the state then agrees with no flicker; a failed request goes back to the
// state; the newest of two clicks wins; reduced motion draws the change at once; a close over 50 rows stays inside a
// frame. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import type { Page } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, NEO, PIXEL, MATERIAL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['neubrutalism', NEO], ['pixel', PIXEL], ['material', MATERIAL]] as const;
const SLOW = 400;
const script = harnessScript();

async function open(engine: typeof webkit, dir: string, id: string) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
  await page.addScriptTag({ content: script });
  const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
  assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
  // Margin.app's own window hosting an app: the sidebar docked; the UI stays on screen through a switch.
  await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, hosted: true, staysOnScreen: true }));
  return { browser, page, ev, errors };
}

// A row's close button pressed: the pointer over the row first (a theme may show it only then).
async function pressClose(page: Page, id: number | string) {
  const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
  const box = (await ev((i) => T.rtRowBox(i), id))!;
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(60);
  const again = (await ev((i) => T.rtRowBox(i), id))!;
  await page.mouse.click(again.close.x, again.close.y);
}

// Every frame from the first one that had it, still had it (no flicker back).
const steady = (seen: boolean[]) => { const at = seen.indexOf(true); return at >= 0 && seen.slice(at).every(Boolean); };

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: clicks drawn at once, rows sliding, in ${name}`, async (t) => {
      const { browser, page, ev, errors } = await open(engine, dir, id);
      try {
        await ev((ms) => T.rtSlowHost(ms), SLOW);

        await t.test('a tab\'s row: active on the next frame, long before the answer, and it stays', async () => {
          const target = (await ev(() => T.rtTodayIds(6)))[4];
          const box = (await ev((i) => T.rtRowBox(i), target))!;
          await ev(({ i, ms }) => T.rtWatch('pointerdown', i, 'active', ms), { i: target, ms: SLOW + 500 });
          await page.mouse.click(box.x, box.y);
          const r = await ev(() => T.rtWatched());
          assert.ok(r.frames >= 1 && r.frames <= 2, `active on the next frame (frame ${r.frames}, ${Math.round(r.ms)} ms)`);
          assert.ok(r.ms < SLOW, 'before the state came back');
          assert.ok(steady(r.seen), 'no flicker when the state agrees');
          assert.ok((await ev(() => T.rtSlowSent())).some((s) => s.type === 'activateTab'));
        });

        await t.test('a pin with no tab: in front on the next frame (the switch has no tab to light), then the state agrees', async () => {
          const pin = await ev(() => T.rtUnopenPin(3));
          await page.waitForTimeout(50);
          const box = (await ev((i) => T.rtRowBox(i), pin))!;
          await ev(({ i, ms }) => T.rtWatch('click', i, 'active', ms), { i: pin, ms: SLOW + 600 });
          await page.mouse.click(box.x, box.y);
          const r = await ev(() => T.rtWatched());
          assert.ok(r.frames >= 1 && r.frames <= 2, `in front on the next frame (frame ${r.frames}, ${Math.round(r.ms)} ms)`);
          assert.ok(r.ms < SLOW, 'before the state came back');
          assert.ok(steady(r.seen), 'no flicker when the state agrees');
          assert.equal(await ev((i) => T.rtRowActive(i), pin), true, 'the state has it in front');
          const others = await ev(() => T.rtTodayIds(30));
          for (const o of others) assert.notEqual(await ev((i) => T.rtRowActive(i), o), true, `only the pin is lit (${o})`);
        });

        await t.test('a close: the row gone on the next frame, the rows after it slide up, the state agrees, no flicker', async () => {
          const ids = await ev(() => T.rtTodayIds(8));
          const victim = ids[2];
          await ev((i) => T.rtRowBox(i), victim); // (scrolled to it first: the tops are where it's pressed)
          const tops = new Map(await ev(() => T.rtTodayTops()));
          await ev(({ i, ms }) => T.rtWatch('click', i, 'gone', ms), { i: victim, ms: SLOW + 500 });
          await pressClose(page, victim);
          const sliding = await ev(() => T.rtTodayTransforms(2, 3));
          const r = await ev(() => T.rtWatched());
          assert.ok(r.frames >= 1 && r.frames <= 2, `gone on the next frame (frame ${r.frames}, ${Math.round(r.ms)} ms)`);
          assert.ok(r.ms < SLOW, 'before the state came back');
          assert.ok(steady(r.seen), 'it never comes back (the state agreed)');
          assert.ok(sliding.some((v) => v && v !== 'none'), `the rows after it slide (${sliding.join(' | ')})`);
          await page.waitForTimeout(300);
          assert.deepEqual(await ev(() => T.rtTodayTransforms(2, 3)), ['none', 'none', 'none'], 'the slide is over');
          const after = new Map(await ev(() => T.rtTodayTops()));
          assert.ok(Math.abs(after.get(ids[3])! - tops.get(victim)!) < 1, 'the next row took its place');
          assert.equal((await ev(() => T.rtSlowSent())).filter((s) => s.type === 'closeTab').length, 1);
        });

        await t.test('a close that fails: the row comes back', async () => {
          await ev((ms) => T.rtSlowHost(ms, { fail: ['closeTab'] }), 150);
          const victim = (await ev(() => T.rtTodayIds(3)))[0];
          await ev((i) => T.rtDispatch('tab.close', i), victim);
          assert.equal(await ev((i) => T.rtRow(i) != null, victim), false, 'gone at once');
          await page.waitForFunction((i) => T.rtRow(i) != null, victim, { timeout: 3000 });
        });

        await t.test('a pin\'s open that fails: back to the row in front', async () => {
          await ev((ms) => T.rtSlowHost(ms, { fail: ['openPin'] }), 150);
          const pin = await ev(() => T.rtUnopenPin(5));
          await page.waitForTimeout(50);
          await ev((i) => T.rtDispatch('pin.open', i), pin);
          assert.equal(await ev((i) => T.rtRowActive(i), pin), true, 'in front at once');
          await page.waitForFunction((i) => T.rtRowActive(i) === false, pin, { timeout: 1500 });
        });

        await t.test('a second click while the first is pending: the newest wins, and stays', async () => {
          await ev((ms) => T.rtSlowHost(ms), SLOW);
          const pin = await ev(() => T.rtUnopenPin(7));
          await page.waitForTimeout(50);
          const tab = (await ev(() => T.rtTodayIds(8)))[6];
          await ev((i) => T.rtDispatch('pin.open', i), pin);
          await ev((i) => T.rtDispatch('tab.activate', i), tab);
          assert.equal(await ev((i) => T.rtRowActive(i), tab), true, 'the tab, at once');
          assert.equal(await ev((i) => T.rtRowActive(i), pin), false, 'not the pin');
          await page.waitForTimeout(SLOW * 2 + 200);
          assert.equal(await ev((i) => T.rtRowActive(i), tab), true, 'the tab, once both have come back');
          assert.equal(await ev((i) => T.rtRowActive(i), pin), false);
        });

        // (A slide still running when a change is drawn with no slide (reduced motion, a hidden page, a drag): stopped at
        // once, the rows at their own places. Before, it ran on toward the old places: the reduced-motion check below
        // read a row still mid-slide whenever the step before's slide outlasted its wait, 2026-11-21.)
        await t.test('a slide still running when a change is drawn with reduced motion: stopped at once, the rows at their places', async () => {
          await page.waitForTimeout(300);
          const ids = await ev(() => T.rtTodayIds(8));
          await ev((i) => T.rtDispatch('tab.close', i), ids[1]); // (a slide starts)
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await ev((i) => T.rtDispatch('tab.close', i), ids[3]);
          // (By the next frame, what's drawn: WebKit's computed style shows a cancelled slide's last value until then.)
          await ev(() => new Promise((r) => requestAnimationFrame(() => r(null))));
          assert.deepEqual(still(await ev(() => T.rtTodayTransforms(1, 4))), ['none', 'none', 'none', 'none']);
          await page.emulateMedia({ reducedMotion: 'no-preference' });
        });

        await t.test('reduced motion: a close is drawn at once, nothing slides', async () => {
          await page.waitForTimeout(300); // (any slide of the last step over)
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const ids = await ev(() => T.rtTodayIds(6));
          await ev((i) => T.rtDispatch('tab.close', i), ids[1]);
          assert.equal(await ev((i) => T.rtRow(i) != null, ids[1]), false);
          await ev(() => new Promise((r) => requestAnimationFrame(() => r(null))));
          assert.deepEqual(still(await ev(() => T.rtTodayTransforms(1, 3))), ['none', 'none', 'none']);
          await page.emulateMedia({ reducedMotion: 'no-preference' });
        });

        await t.test('a space switched: drawn whole, nothing slides', async () => {
          await page.waitForTimeout(300);
          const spaces = await ev(() => T.rtState().spaces.map((s) => s.id));
          await ev((s) => T.rtDispatch('space.switch', s), spaces[1]);
          assert.deepEqual(await ev(() => T.rtTodayTransforms(0, 3)), ['none', 'none', 'none']);
          await ev((s) => T.rtDispatch('space.switch', s), spaces[0]);
          assert.deepEqual(await ev(() => T.rtTodayTransforms(0, 3)), ['none', 'none', 'none']);
        });

        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}

// The frame budget: a close over 50 rows (its click's work, the slide set up included) and the frames while the rows
// slide. Arcadia, the reference theme.
// A row not moved: no transform, or the identity matrix (WebKit's computed style can read a just-cancelled slide's row
// as `matrix(1, 0, 0, 1, 0, 0)` for that moment: the same place). Any offset still shows.
function still(list: (string | null)[]) { return list.map((v) => (v === 'matrix(1, 0, 0, 1, 0, 0)' ? 'none' : v)); }

for (const [name, engine] of ENGINES) {
  test(`a close over 50 rows stays within a frame, in ${name}`, async () => {
    const { browser, page, ev, errors } = await open(engine, ARCADIA, 'arcadia');
    try {
      await ev(() => T.rtSlowHost(400));
      // 50 of today's rows, beside the pinned area's.
      await ev(() => T.rtApply('removeTabs', 120));
      assert.equal((await ev(() => T.rtVm())).today, 50);
      const times: number[] = [];
      const gaps: number[] = [];
      for (let k = 0; k < 5; k++) {
        const victim = (await ev(() => T.rtTodayIds(8)))[3];
        times.push(await ev((i) => T.rtTimed('tab.close', i), victim));
        gaps.push(...await ev(() => T.rtFrameGaps(260)));
        await page.waitForTimeout(500);
      }
      times.sort((a, b) => a - b);
      const median = times[2];
      console.log(`# ${name}: a close over 50 rows: ${times.map((v) => v.toFixed(1)).join(', ')} ms (median ${median.toFixed(1)}); frames while sliding: longest ${Math.max(...gaps).toFixed(1)} ms`);
      assert.ok(median < 16, `the close's work fits a frame (median ${median.toFixed(1)} ms)`);
      assert.ok(Math.max(...gaps) < 50, `no frame dropped badly while sliding (${Math.max(...gaps).toFixed(1)} ms)`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
