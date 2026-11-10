// A native layout stays visible while the browser reports its tab and selected space in separate updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, NEO, PIXEL } from './package.ts';
import type { Harness, HarnessRt } from './harness.ts';
declare const T: Harness;
declare const __rt: HarnessRt;
declare const spaceAnswers: { resolve: (value?: unknown) => void, reject: (error: Error) => void }[];
const script = harnessScript();
const themes = [['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;

for (const [engineName, engine] of [['webkit', webkit], ['chromium', chromium]] as const) {
  for (const [id, dir] of themesInScope(themes)) {
    test(`space selection survives a tab echo before the space commit: ${id}, ${engineName}`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (route) => route.abort());
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addScriptTag({ content: script });
        assert.equal((await page.evaluate(([pkg, name]) => T.loadBuiltin(pkg, name), [themeForPage(dir), id] as const)).ok, true);
        await page.evaluate(() => T.mountRuntime({ staysOnScreen: true, replies: { setSpace: {} } }));
        // Click the real Work chip: the native host has not committed the selected space yet.
        const chip = await page.evaluate(() => T.rtRect('.chip', 1));
        assert.ok(chip);
        await page.mouse.click(chip.x, chip.y);
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work');
        const target = (await page.evaluate(() => T.rtUi())).switchingTo;
        assert.equal(typeof target, 'number');
        // Safari activates the destination first; its selected-space storage delta arrives later.
        await page.evaluate((tab) => T.rtApply('activate', tab), target);
        assert.equal((await page.evaluate(() => T.rtUi())).switchingTo, null, 'the tab switch has landed');
        assert.equal((await page.evaluate(() => T.rtState())).activeSpaceByWindow[1], 'personal', 'the storage update is still pending');
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work', 'the sidebar must not flash back to Personal');
        await page.evaluate(() => T.rtApply('switchSpace', 'work'));
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work', 'the committed selection stays on Work');

        // Reuse the live runtime with delayed replies: old failures cannot undo newer selections.
        await page.evaluate(() => {
          Object.assign(window, { spaceAnswers: [] });
          const send = __rt.host.send;
          __rt.host.send = (type, payload) => type === 'setSpace'
            ? new Promise((resolve, reject) => spaceAnswers.push({ resolve, reject })) : send(type, payload);
          T.rtDispatch('space.switch', 'personal');
          T.rtDispatch('space.switch', 'work');
          T.rtDispatch('space.switch', 'personal');
          spaceAnswers[0].resolve(undefined);
        });
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'personal', 'an old failure cannot cancel a newer selection of the same space');
        await page.evaluate(() => spaceAnswers[1].reject(new Error('older switch failed')));
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'personal', 'another old failure cannot change the current selection');
        await page.evaluate(() => spaceAnswers[2].resolve(undefined));
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work', 'the current unanswered switch rolls back promptly');

        await page.evaluate(() => { T.rtDispatch('space.switch', 'personal'); spaceAnswers[3].reject(new Error('current switch failed')); });
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work', 'the current rejected switch also rolls back');

        // A reused native view must not carry an old window's optimistic space into a new binding.
        await page.evaluate(() => { T.rtDispatch('space.switch', 'personal'); __rt.host.windowId = 2; __rt.runtime.render(); });
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, await page.evaluate(() => __rt.host.getState()!.activeSpaceByWindow[2] ?? __rt.host.getState()!.spaces[0].id), 'rekey follows the new window');

        // Unanswered requests retain the existing bounded timeout, rather than sticking forever.
        await page.evaluate(() => {
          __rt.host.windowId = 1; __rt.runtime.render(); T.rtDispatch('space.switch', 'personal');
          T.rtApply('activate', T.rtUi().switchingTo);
        });
        assert.equal((await page.evaluate(() => T.rtUi())).switchingTo, null);
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'personal');
        await page.waitForFunction(() => T.rtVmFull().space === 'work', null, { timeout: 4500 });

        await page.evaluate(() => {
          T.rtApply('switchSpace', 'personal');
          T.rtDispatch('space.switch', 'work');
          T.rtApply('activate', T.rtUi().switchingTo);
          T.rtDispatch('space.switch', 'work'); // same destination after its tab lands, before its commit
          spaceAnswers[6].resolve(undefined);
        });
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'work', 'a repeated selection after tab arrival owns its own reply');
        await page.evaluate(() => spaceAnswers[7].resolve(undefined));
        assert.equal((await page.evaluate(() => T.rtVmFull())).space, 'personal', 'only the repeated selection\'s failure rolls back');
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }
}
