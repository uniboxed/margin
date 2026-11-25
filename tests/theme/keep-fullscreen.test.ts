// Esc in a page Margin.app hosts (content/keep-fullscreen.ts), in real engines (Playwright's WebKit and Chromium,
// headless, nothing loaded): the DOM's own dispatch decides the order, so this proves what the stand-in in
// tests/keep-fullscreen.test.ts assumes. An Escape no page handler took has its default prevented, after every
// listener the page has (on the window too, registered after Margin's); one the page handled, a video's (an element
// in full screen), a modal dialog's, an open popover's and a search field's are the engine's own: a dialog still
// closes, a popover still hides. Not a theme's test: it's here for the real engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright';

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const bundle = buildSync({
  stdin: { contents: `import { startKeepFullscreen } from './keep-fullscreen.ts'; globalThis.startKeepFullscreen = startKeepFullscreen;`, resolveDir: fileURLToPath(new URL('../../extension/content/', import.meta.url)), sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, format: 'iife', write: false, target: 'es2022',
}).outputFiles[0].text;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<input id="text" type="text"><input id="search" type="search" value="query">
<div id="menu" tabindex="0">menu</div>
<dialog id="dialog"><p>dialog</p></dialog>
<div id="pop" popover>popover</div>
</body></html>`;

for (const [name, engine] of ENGINES) {
  test(`keep full screen in ${name}: an unhandled Escape prevented last; the page's, a dialog's, a popover's and a search field's own`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(PAGE);
      // The page's listeners: on the window before Margin's script and after it, and one on the document.
      await page.evaluate(() => {
        (window as any).heard = [];
        addEventListener('keydown', (e) => (window as any).heard.push(`window-before ${e.key} ${e.defaultPrevented}`));
      });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        const w = window as any;
        w.drawn = true;
        w.startKeepFullscreen({ isDrawn: () => w.drawn });
        addEventListener('keydown', (e) => w.heard.push(`window-after ${e.key} ${e.defaultPrevented}`));
        document.addEventListener('keydown', (e) => w.heard.push(`document ${e.key} ${e.defaultPrevented}`));
        // Last of all, the outcome (as Safari reads it once the page is done with the key).
        w.outcome = [];
        addEventListener('keydown', (e) => setTimeout(() => w.outcome.push(`${e.key} ${e.defaultPrevented}`)));
        document.getElementById('menu')!.addEventListener('keydown', (e) => { if (e.key === 'Escape' && w.menuHandles) e.preventDefault(); });
      });
      const outcome = async () => { await page.waitForTimeout(30); return page.evaluate(() => { const w = window as any; const o = w.outcome.splice(0); return o; }); };
      const heard = () => page.evaluate(() => (window as any).heard.splice(0));

      await page.focus('#menu');
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape true'], 'unhandled: prevented');
      assert.deepEqual(await heard(), ['document Escape false', 'window-before Escape false', 'window-after Escape false'], 'every listener of the page heard it unhandled first');

      await page.evaluate(() => { (window as any).menuHandles = true; });
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape true'], 'the page handled it: its own');
      await page.evaluate(() => { (window as any).menuHandles = false; });
      await heard();

      await page.keyboard.press('a');
      await page.keyboard.press('Shift+Escape');
      assert.deepEqual(await outcome(), ['a false', 'Shift false', 'Escape false'], 'other keys untouched');

      await page.evaluate(() => { (window as any).drawn = false; });
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape false'], 'a window Margin.app doesn\'t draw: nothing');
      await page.evaluate(() => { (window as any).drawn = true; });

      await page.focus('#text');
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape true'], 'a text field has no Esc of its own');

      await page.focus('#search');
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape false'], 'a search field keeps its own Esc');
      // (Playwright's WebKit build doesn't clear a search field on Esc even with nothing of Margin's: Chromium does.)
      if (name === 'chromium') assert.equal(await page.inputValue('#search'), '', 'and it still clears');

      await page.evaluate(() => (document.getElementById('dialog') as HTMLDialogElement).showModal());
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape false'], 'a modal dialog keeps its Esc');
      assert.equal(await page.evaluate(() => (document.getElementById('dialog') as HTMLDialogElement).open), false, 'and it closed');

      const popover = await page.evaluate(() => { const p = document.getElementById('pop') as any; if (typeof p.showPopover !== 'function') return false; p.showPopover(); return true; });
      if (popover) {
        await page.keyboard.press('Escape');
        assert.deepEqual(await outcome(), ['Escape false'], 'an open popover keeps its Esc');
        assert.equal(await page.evaluate(() => document.getElementById('pop')!.matches(':popover-open')), false, 'and it hid');
      }

      await page.focus('#menu');
      await page.keyboard.press('Escape');
      assert.deepEqual(await outcome(), ['Escape true'], 'back to a plain Esc: prevented');
    } finally {
      await browser.close();
    }
  });
}
