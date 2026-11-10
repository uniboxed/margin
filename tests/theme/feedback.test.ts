// What Margin.app's overlay draws about the window's pages (Margin 2 Phase 2
// step 7), in Arcadia, Neubrutalism and Pixel, in real engines (Playwright's WebKit
// and Chromium, headless, every network request refused): a tab loading (its
// row, and the tab in front's indicator, shown with the sidebar hidden too:
// no hover needed), the trackpad gestures' badges over the page (never
// taking the pointer), and Margin's own notices in each theme's notice part.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const THEMES = [
  ['arcadia', ARCADIA, { root: '.arcadia', indicator: '.loader', loadingRoot: true }],
  ['neubrutalism', NEO, { root: '.nb', indicator: '.load-bar.on', loadingRoot: false }],
  ['pixel', PIXEL, { root: '.pixel', indicator: '.load-bar.on', loadingRoot: false }],
];
const script = harnessScript();

for (const [name, engine] of ENGINES) {
  for (const [id, dir, sel] of themesInScope(THEMES)) {
    test(`${id}: loading, gestures and notices in ${name}`, async (t) => {
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const seen = { requests: [], errors: [] };
        page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
        page.on('pageerror', (e) => seen.errors.push(e.message));
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const slot = (await ev(() => T.rtLayouts())).at(-1);

        await t.test('a tab loading: its row marked, the indicator for the tab in front shown; hidden sidebar: still shown', async () => {
          assert.equal(await ev(() => T.rtCount('.busy')), 0);
          assert.equal(await ev((s) => T.rtVisible(s), sel.indicator), false, 'nothing loading: no indicator');
          assert.ok((await ev(() => T.rtLoading(true))) > 0);
          // Past the indicator's fade in (it can take longer than its 350 ms on a slow machine).
          await page.waitForFunction((s) => T.rtVisible(s), sel.indicator, { timeout: 3000 }).catch(() => {});
          assert.ok((await ev(() => T.rtCount('.busy'))) > 0, 'rows marked');
          if (sel.loadingRoot) assert.ok((await ev((r) => T.rtClasses(r), sel.root)).includes('loading'));
          assert.equal(await ev((s) => T.rtVisible(s), sel.indicator), true, 'the indicator shows');
          await ev(() => T.rtSetUi({ sidebar: 'hidden' }));
          await page.waitForTimeout(350);
          await page.waitForFunction((s) => T.rtVisible(s), sel.indicator, { timeout: 3000 }).catch(() => {});
          assert.equal(await ev((s) => T.rtVisible(s), sel.indicator), true, 'with the sidebar hidden too, no hover');
          await ev(() => T.rtLoading(false));
          await ev(() => T.rtSetUi({ sidebar: 'open' }));
          // Past its fade out (as long as the fade in on a slow machine).
          await page.waitForFunction((s) => T.rtCount('.busy') === 0 && !T.rtVisible(s), sel.indicator, { timeout: 3000 }).catch(() => {});
          assert.equal(await ev(() => T.rtCount('.busy')), 0);
          assert.equal(await ev((s) => T.rtVisible(s), sel.indicator), false, 'done: gone');
        });

        await t.test('gestures: a pull\'s badge at the top of the page, a swipe\'s at its side; over the page, never taking the pointer', async () => {
          await ev(() => T.rtSetUi({ gesture: { kind: 'pull', state: 'pulling', progress: 0.5 } }));
          assert.equal(await ev(() => T.rtCount('.gesture.pull')), 1);
          assert.equal(await ev(() => T.rtCount('.gesture.armed')), 0);
          assert.equal(await ev(() => T.rtComputed('.gesture', 'pointer-events')), 'none');
          // Armed: all the way in (it comes in from above with the pull).
          await ev(() => T.rtSetUi({ gesture: { kind: 'pull', state: 'armed', progress: 1 } }));
          assert.equal(await ev(() => T.rtCount('.gesture.pull.armed')), 1, 'armed');
          const pull = await ev(() => T.rtRect('.gesture.pull'));
          assert.ok(pull.left >= slot.left && pull.right <= 1280 - slot.right && pull.top >= slot.top - 1, `over the page: ${JSON.stringify(pull)} in ${JSON.stringify(slot)}`);
          assert.ok(Math.abs(pull.x - (slot.left + (1280 - slot.left - slot.right) / 2)) < 4, 'centred over the page');
          await ev(() => T.rtSetUi({ gesture: { kind: 'swipe', state: 'armed', progress: 1, direction: -1 } }));
          const back = await ev(() => T.rtRect('.gesture.swipe.back'));
          assert.ok(back.left >= slot.left - 1 && back.left < slot.left + 80, `back: at the page's left (${back.left})`);
          await ev(() => T.rtSetUi({ gesture: { kind: 'swipe', state: 'pulling', progress: 0.6, direction: 1 } }));
          const forward = await ev(() => T.rtRect('.gesture.swipe.forward'));
          assert.ok(forward.right <= 1280 - slot.right + 1 && forward.right > 1280 - slot.right - 80, `forward: at the page's right (${forward.right})`);
          assert.equal(await ev(() => T.rtCount('.gesture svg')), 1, 'an icon, no words');
          assert.equal((await ev(() => T.rtText('.gesture'))).join(''), '');
          await ev(() => T.rtSetUi({ gesture: null }));
          assert.equal(await ev(() => T.rtCount('.gesture')), 0);
        });

        await t.test('Margin\'s notices in the theme\'s notice part: the words and buttons it\'s given', async () => {
          await ev(() => T.rtSetUi({ notice: { id: 'not-responding#1', text: 'Margin isn’t responding on this page (it was probably updated). Reload the page to fix it.', actions: [{ id: 'reload', label: 'Reload', primary: true }, { id: 'later', label: 'Not now' }] } }));
          assert.deepEqual(await ev(() => T.rtText('.notice .text, .notice button')), ['Margin isn’t responding on this page (it was probably updated). Reload the page to fix it.', 'Reload', 'Not now']);
          assert.equal(await ev(() => T.rtVisible('.notice')), true);
          const reload = await ev(() => T.rtBox('.notice button.primary'));
          await page.mouse.click(reload.x, reload.y);
          assert.equal(await ev(() => T.rtCount('.notice')), 0);
          assert.deepEqual((await ev(() => T.rtPerformedFull())).at(-1), ['notice', { id: 'not-responding#1', action: 'reload' }]);
        });

        assert.deepEqual(seen.errors, []);
        assert.deepEqual(seen.requests, []);
      } finally {
        await browser.close();
      }
    });
  }
}
