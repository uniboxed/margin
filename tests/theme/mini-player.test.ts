// The background mini player (M2.4) in all five built-in themes, in real engines (Playwright's WebKit and Chromium,
// headless, every network request refused), drawn from Margin.app's `media` push as the overlay sets it
// (app/shared/host/overlay.ts: ui.media, the sources by the UI's numbers): shown for a tab playing in the
// background, with its title, artist and artwork, its buttons; never for the tab in front; paused, still there; no
// sources: gone. A real press on Play/Pause sends `mediaControl` for that tab, Mute `muteTab`, its title `activateTab`.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, GLASS, MATERIAL, NEO, PIXEL } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['liquid-glass', GLASS], ['material', MATERIAL], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const script = harnessScript();

for (const [name, engine] of ENGINES) {
  for (const [id, dir] of themesInScope(THEMES)) {
    test(`${id}: the background mini player in ${name}`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await context.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
        await page.addScriptTag({ content: script });
        const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
        assert.equal((await ev(({ p, i }) => T.loadBuiltin(p, i), { p: themeForPage(dir), i: id })).ok, true);
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, appWindow: true, hosted: true }));
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const { front, today } = await ev(() => T.rtMedia());
        const bg = today.find((t) => t !== front) as number;
        assert.ok(Number.isInteger(bg), 'a tab not in front');
        // (The fixture has a tab Safari says is audible, not in front: the extension's own UI shows it from the state.)
        assert.equal(await ev(() => T.rtCount('.mini-player')), 1, 'an audible tab in the background (the state\'s): shown');
        await ev(() => T.rtSilence());
        assert.equal(await ev(() => T.rtCount('.mini-player')), 0, 'nothing playing: no mini player');

        const source = (tabId: unknown, extra = {}) => ({ id: `tab:${tabId}`, source: 'tab', tabId, title: 'Background Song', subtitle: 'The Band', artwork: PNG, playing: true, muted: false, canPrev: true, canNext: true, updatedAt: Date.now(), pausedAt: null, ...extra });
        await ev((m) => T.rtSetUi({ media: m as any }), [source(bg)]);
        assert.equal(await ev(() => T.rtCount('.mini-player')), 1, 'a tab playing in the background: shown');
        assert.equal(await ev(() => T.rtVisible('.mini-player')), true, 'on screen');
        assert.equal(await ev(() => T.rtVisible('.mini-title')), true);
        assert.deepEqual(await ev(() => T.rtText('.mini-title')), ['Background Song']);
        assert.deepEqual(await ev(() => T.rtText('.mini-sub')), ['The Band']);
        assert.equal(await ev(() => T.rtCount('img.mini-art')), 1, 'its artwork');
        for (const label of ['Previous track', 'Play or pause', 'Next track', 'Mute or unmute', 'Jump to playing media']) {
          assert.equal(await ev((l) => T.rtCount(`.mini-player [aria-label="${l}"]`), label), 1, label);
        }
        const r = (await ev(() => T.rtRect('.mini-player')))!;
        assert.ok(r.width > 60 && r.height > 20 && r.left >= 0 && r.right <= 1280 && r.bottom <= 800, `inside the window: ${JSON.stringify(r)}`);

        // A real press on each button: the request for that tab.
        const press = async (label: string) => {
          const at = (await ev((l) => T.rtRect(`.mini-player [aria-label="${l}"]`), label))!;
          await page.mouse.click(at.x, at.y);
        };
        const sentBefore = (await ev(() => T.rtSent())).length;
        await press('Play or pause');
        await press('Next track');
        await press('Mute or unmute');
        const sent = (await ev(() => T.rtSent())).slice(sentBefore);
        assert.deepEqual(sent.map(([type, p]) => [type, p.command ?? null, p.tabId]), [['mediaControl', 'toggle', bg], ['mediaControl', 'next', bg], ['muteTab', null, bg]]);

        await ev((m) => T.rtSetUi({ media: m as any }), [source(front), source(bg, { playing: false, pausedAt: Date.now() - 1000 })]);
        assert.equal((await ev(() => T.rtMedia())).media?.tabId, bg, 'the tab in front never: the paused one in the background instead');
        assert.equal(await ev(() => T.rtCount('.mini-player.paused')), 1, 'paused: still there, drawn paused');
        await ev((m) => T.rtSetUi({ media: m as any }), [source(front)]);
        assert.equal(await ev(() => T.rtCount('.mini-player')), 0, 'only the tab in front plays: none');
        await ev((m) => T.rtSetUi({ media: m as any }), [source(bg, { playing: false, pausedAt: Date.now() - 31_000 })]);
        assert.equal(await ev(() => T.rtCount('.mini-player')), 0, 'paused over 30 s ago: gone');
        await ev((m) => T.rtSetUi({ media: m as any }), [source(bg), source(bg + 1000, { artwork: 'https://evil.example/a.jpg' })]);
        assert.equal(await ev(() => T.rtCount('.mini-player')), 1);
        await ev(() => T.rtSetUi({ media: [] }));
        assert.equal(await ev(() => T.rtCount('.mini-player')), 0, 'no sources: gone');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  }
}
