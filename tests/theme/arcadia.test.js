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
import { harnessScript, themeForPage, ARCADIA } from './package.js';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const script = harnessScript();
const pkg = themeForPage(ARCADIA);

for (const [name, engine] of ENGINES) {
  test(`Arcadia's package in ${name}`, async (t) => {
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
        // Keep open: the page's card beside the 260 px sidebar, in Arc's 8 px frame, its corners 6.25 px.
        assert.deepEqual(await layout(), { left: 260, top: 8, right: 8, bottom: 8, radius: 6.25, width: 1280, height: 800, windowId: 1, mode: 'inpage' });
      });

      await t.test('the width is the theme\'s setting (160–500, step 10); hidden, the page sits in the frame or fills the window', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 330 } } } }));
        assert.equal((await layout()).left, 330);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { themes: { 'arcadia': { sidebarWidth: 900 } } } }));
        assert.equal((await layout()).left, 260, 'out of range: the default');
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false } }));
        assert.deepEqual(await layout(), { left: 8, top: 8, right: 8, bottom: 8, radius: 6.25, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'the frame alone around the page');
        assert.equal(await page.evaluate(() => T.rtCount('.peek-zone')), 1);
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'inpage', settings: { sidebarPinnedOpen: false, frameWhenHidden: false } }));
        assert.deepEqual(await layout(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0, width: 1280, height: 800, windowId: 1, mode: 'inpage' }, 'no frame: the whole window');
        await page.evaluate(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(50);
        assert.equal((await page.evaluate(() => T.rtLayouts())).at(-1).left, 0, 'out over the page, the sidebar moves nothing');
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
        await page.mouse.click(go.x, go.y);
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
        assert.equal((await layout()).left, 260, 'beside the sidebar, which stays');
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

      await t.test('the launcher\'s Settings: Margin\'s inputs in the theme\'s settings part, each saving through its field', async () => {
        const platform = { browser: 'safari', os: 'mac', features: { sleepTabs: 'page', blockGestures: true, newTabHint: true, search: 'learn' } };
        await page.evaluate((p) => T.mountRuntime({ container: 'document', mode: 'inpage', inNewTab: true, platform: p, replies: { wakeSleeping: 0 } }), platform);
        await page.evaluate(() => T.rtSetUi({ settingsOpen: true }));
        const form = () => page.evaluate(() => {
          const q = (s) => [...document.querySelectorAll(s)];
          return {
            select: q('.settings-form select').map((s) => [s.value, [...s.options].map((o) => o.textContent)]),
            numbers: q('.settings-form input[type="number"]').map((i) => i.value),
            toggles: q('.settings-form input[type="checkbox"][switch]').map((i) => [i.checked, i.disabled]),
            lists: q('.settings-form textarea').length,
            shortcuts: q('.settings-form input.shortcut').map((i) => [i.readOnly, i.value]),
          };
        });
        const f = await form();
        assert.deepEqual(f.select, [['arcadia', ['Arcadia', 'Neo-brutalism']]]);
        assert.equal(f.numbers.length, 2);
        assert.equal(f.toggles.length, 5);
        assert.equal(f.lists, 1);
        assert.equal(f.shortcuts.length, 5);
        assert.ok(f.shortcuts.every(([ro]) => ro));
        const lastSent = (type) => page.evaluate((t) => T.rtSent().filter(([k]) => k === t).at(-1) ?? null, type);
        await page.click('label:has-text("keep the frame") input');
        assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { frameWhenHidden: false } }]);
        await page.selectOption('.settings-form select', 'neo-brutalism');
        assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { theme: 'neo-brutalism' } }]);
        await page.click('label:has-text("Next tab") input');
        await page.keyboard.press('Control+Alt+KeyN');
        const saved = (await lastSent('updateSettings'))[1].patch.shortcuts;
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
