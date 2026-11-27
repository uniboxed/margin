// Material (app/shared/ui/themes/material/): Material 3 on Arcadia's template, in WebKit and Chromium. The package loads
// with nothing removed and its bundled Google Sans Flex; colour comes from the space's colour (dynamic colour, light and
// dark); the drawer's parts are Material's (a 48 px search bar, pill rows with the secondary container as the active
// indicator, "New Tab" as an extended FAB, round icon buttons); menus, the command bar and dialogs at Material's
// corners; its own loader (Material 3 Expressive's morphing shape); Settings as its own page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, MATERIAL } from './package.ts';
import { pageLoaderChecks } from './page-card.ts';
import { settingsPageChecks } from './settings-page.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();
const pkg = themeForPage(MATERIAL);

for (const [name, engine] of ENGINES) {
  test(`Material in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const seen: { requests: string[], errors: string[] } = { requests: [], errors: [] };
      page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
      page.on('pageerror', (e) => seen.errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
      const count = (s: string) => ev((x) => T.rtCount(x), s);
      const computed = (s: string, p: string) => ev(([x, y]) => T.rtComputed(x, y), [s, p] as const);
      const rect = async (s: string, nth = 0) => (await ev(([x, n]) => T.rtRect(x, n), [s, nth] as const))!;
      const mount = (o = {}) => ev((x) => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, ...x }), o);

      await t.test('loads with nothing removed, as a package and as a built-in theme, with Google Sans Flex', async () => {
        const raw = await ev((p) => T.loadNeo(p), pkg);
        assert.equal(raw.ok, true);
        assert.deepEqual([raw.removed, raw.errors], [[], []], 'the sanitizer removes nothing');
        const r = await ev((p) => T.loadBuiltin(p, 'material', ['Google Sans Flex']), pkg);
        assert.deepEqual([r.ok, r.id, r.fontErrors], [true, 'material', []]);
        assert.deepEqual(r.fonts, [true], 'its font loaded from its own bytes');
      });

      await t.test('the drawer: a search bar, pill rows, the active one on the secondary container, New Tab as an extended FAB', async () => {
        await mount();
        assert.equal(await count('[m-action], m-for, m-if'), 0, 'no template syntax left');
        assert.ok(await count('.tabs .tab') > 0 && await count('.chip') > 0);
        const address = await rect('.address');
        assert.deepEqual([address.height, await computed('.address', 'border-top-left-radius')], [48, '24px'], 'a full-pill search bar');
        assert.equal(await count('.address .search-icon'), 1, 'a search icon leading');
        assert.match(await computed('.address', 'font-family') ?? '', /^"?Google Sans Flex/);
        const row = await rect('.tabs .tab');
        assert.deepEqual([row.height, await computed('.tabs .tab', 'border-top-left-radius')], [44, '22px'], 'rows as full pills');
        const fab = await rect('.new-tab-row');
        assert.deepEqual([fab.height, await computed('.new-tab-row', 'border-top-left-radius')], [48, '16px'], 'New Tab: an extended FAB');
        assert.ok(fab.width < row.width, 'as wide as its words');
        assert.notEqual(await computed('.new-tab-row', 'box-shadow'), 'none', 'raised');
        const active = await computed('.tabs .tab.active, .pins .pin.active', 'background-color');
        const fabFill = await computed('.new-tab-row', 'background-color');
        assert.ok(active && fabFill && active !== fabFill, `the active indicator (secondary container) apart from the FAB (primary container): ${active} ${fabFill}`);
        assert.deepEqual([(await rect('.bar-button')).width, await computed('.bar-button', 'border-top-left-radius')], [36, '50%'], 'round icon buttons');
        // Dynamic colour: the ground is the space's colour in a neutral surface, an sRGB colour Margin.app can read.
        assert.match(await computed('.margin-sidebar', 'background-color') ?? '', /^rgba?\(|^color\(srgb/);
        await ev(() => T.unmountRuntime());
      });

      await t.test('the command bar: a search view with Material\'s extra-large corner; a dialog\'s 28 px corner', async () => {
        await mount();
        await ev(() => T.rtSetUi({ palette: { open: true, query: '', selected: 0 } }));
        assert.equal(await computed('.palette', 'border-top-left-radius'), '28px');
        assert.equal(await computed('.palette .result', 'border-top-left-radius'), '24px', 'pill rows');
        await ev(() => T.rtSetUi({ palette: { open: false }, prompt: { id: 'p', title: 'Remove theme', text: 'Remove it?', actions: [{ id: 'remove', label: 'Remove', danger: true }, { id: 'cancel', label: 'Cancel' }] } }));
        assert.equal(await computed('.prompt', 'border-top-left-radius'), '28px');
        assert.equal(await computed('.prompt-title', 'font-size'), '24px', 'a headline');
        await ev(() => T.rtSetUi({ prompt: null, notice: { id: 'n', text: 'That tab is no longer open.', actions: [{ id: 'ok', label: 'OK' }] } }));
        const notice = await rect('.notice');
        const bottom = await ev(() => document.documentElement.clientHeight);
        assert.ok(notice.y + notice.height > bottom / 2, 'a snackbar at the bottom');
        await ev(() => T.unmountRuntime());
      });

      await t.test('Settings: Material\'s switches (52 × 32)', async () => {
        await mount({ appWindow: true, platform: { browser: 'safari', os: 'mac', features: { sleepTabs: 'close', blockGestures: true, newTabHint: true, search: 'app' } } });
        await ev(() => T.rtSetUi({ settingsPage: true, settingsCategory: 'browsing' }));
        const toggle = await rect('.settings-form input.toggle');
        assert.deepEqual([toggle.width, toggle.height, await computed('.settings-form input.toggle', 'appearance')], [52, 32, 'none']);
        await ev(() => T.unmountRuntime());
      });

      await t.test('dedicated Settings: its own page, as System Settings (the categories beside the chosen one\'s settings); never under the search field in Margin.app\'s window', async () => {
        await settingsPageChecks(page);
      });

      await pageLoaderChecks(t, browser, {
        id: 'material', dir: MATERIAL, script,
        label: '.opening-label', mark: '.opening-mark',
        animations: ['m3-morph'],
        icon: { size: 32 },
        skeleton: [['.space-title .title', ''], ['.space-title .emoji', ''], ['.tabs', '::after'], ['.spaces', '::before']],
        starting: ['m3-morph', 'm3-breathe'],
      });

      assert.deepEqual(seen.errors, []);
      assert.deepEqual(seen.requests, []);
    } finally {
      await browser.close();
    }
  });
}
