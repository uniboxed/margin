// ⌘D's toast waits for the request (ui/shortcut-targets.ts togglePin): a pin asked of the runtime as Margin's
// behaviors do hands back the host's answer (the new pin's id, or null), not true at once. Real engines, Arcadia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;
const script = harnessScript();

for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]] as const) {
  test(`tab.pin and tab.unpin answer with the host's reply, in ${name}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
      assert.equal((await ev(({ p }) => T.loadBuiltin(p, 'arcadia'), { p: themeForPage(ARCADIA) })).ok, true);
      await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'fullscreen', closed: false, replies: { pinTab: 'pin-new', unpin: null } }));
      const tab = await ev(() => T.rtTodayIds(1));
      assert.equal(await ev((id) => T.rtBehavior('tab.pin', id), tab[0]), 'pin-new');
      const pin = await ev(() => T.rtState().pins[0].id);
      assert.equal(await ev((id) => T.rtBehavior('tab.unpin', id), pin), null);
    } finally {
      await browser.close();
    }
  });
}
