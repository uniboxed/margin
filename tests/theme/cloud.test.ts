// iCloud Tabs' live folder (Margin's <m-cloud-tabs>, each theme's
// `cloud-tabs` part) and the palette's section for them, in every built-in
// themes, in Playwright's WebKit and Chromium, headless, every network
// request refused, with the mock host (ui/host.ts) holding iCloud Tabs as
// Margin.app's host does (tests/fixtures/cloud-tabs.ts through
// shared/cloud-tabs.ts cloudOf). Real pointer and keyboard input.
// `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, themesInScope, ARCADIA, NEO, PIXEL } from './package.ts';
import { AIR } from '../fixtures/cloud-tabs.ts';
import type { Harness } from './harness.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [
  ['arcadia', ARCADIA, { newTab: '.new-tab-row', list: '.tabs-section', section: '.result-section' }],
  ['neubrutalism', NEO, { newTab: '.new-tab', list: '.tabs', section: '.palette-section' }],
  ['pixel', PIXEL, { newTab: '.new-tab', list: '.tabs', section: '.palette-section' }],
] as const;
const script = harnessScript();

for (const [engineName, engine] of ENGINES) {
  for (const [id, dir, sel] of themesInScope(THEMES)) {
    test(`iCloud Tabs in ${id}, ${engineName}`, async (t) => {
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
        assert.equal((await ev(([p, i]) => T.loadBuiltin(p, i), [themeForPage(dir), id])).ok, true);
        const count = (s: string) => ev((x) => T.rtCount(x), s);
        const box = async (s: string, n = 0) => { const b = await ev(([x, k]) => T.rtBox(x, k), [s, n]); assert.ok(b, s); return b; };
        const click = async (s: string, n = 0, options: Parameters<typeof page.mouse.click>[2] = {}) => { const b = (await box(s, n))!; await page.mouse.click(b.x, b.y, options); };
        const lastSent = async (type: string) => (await ev(() => T.rtSent())).filter(([x]) => x === type).at(-1) ?? null;
        const performed = () => ev(() => T.rtPerformedFull());
        await ev(() => T.mountRuntime({ width: 1440, height: 900, mode: 'fullscreen', platform: { browser: 'safari', os: 'mac' }, settings: { sidebarPinnedOpen: true } }));

        await t.test('none without Margin.app\'s data; then the folder above the new-tab row, outside every drop zone, nothing to drag', async () => {
          assert.equal(await count('.cloud'), 0);
          await ev(() => T.rtCloud());
          assert.equal(await count('.cloud'), 1);
          assert.equal(await count('.cloud-device'), 3);
          assert.equal(await count('.cloud-tab'), 6);
          assert.equal(await ev(([a, b]) => T.rtOrder(a, b), ['.cloud', sel.newTab]), 'before');
          assert.equal(await ev(() => T.rtClosest('.cloud', '[m-drop]')), false, 'no drop zone holds it');
          assert.equal(await count('.cloud [m-drag], .cloud [m-drop]'), 0, 'nothing dragged out or into it');
          assert.deepEqual(await ev(() => T.rtText('.cloud-head .title, .cloud-head .cloud-name')), ['iCloud Tabs']);
          const devices = await ev(() => T.rtText('.cloud-device'));
          assert.ok(devices[0].includes('Nora’s iPhone') && devices[0].includes('updated'), devices[0]);
          assert.equal(await count('.cloud-device.stale'), 1, 'the iPad not used for ten days: dimmed');
          assert.equal(await count('.cloud-tab.stale'), 1);
          assert.equal(await count('.cloud-tab .pinned-mark'), 1, 'a tab pinned on the phone, marked');
          assert.ok((await ev(() => T.rtText('.cloud-host'))).includes('tagus.example'), 'each tab\'s site under its title');
          assert.ok(await count('.cloud-tab img[src^="data:image/png"]') >= 1, 'Margin\'s own icon for a site it knows');
          assert.ok(await count('.cloud-tab .letter') >= 1, 'a letter for one it doesn\'t');
          assert.equal(await ev(() => T.rtVisible('.cloud-head')), true);
        });

        await t.test('a tab clicked opens it here, as an address typed in; its menu: Open, Copy Link', async () => {
          await click('.cloud-tab', 0);
          assert.deepEqual((await performed()).at(-1), ['navigate', { url: 'https://tagus.example/ferries' }]);
          await click('.cloud-tab', 3, { button: 'right' });
          assert.deepEqual((await ev(() => T.rtVmFull()))!.menu, ['Open', 'Copy Link']);
          const copy = (await ev(() => T.rtBoxText('.menu-item', 'Copy Link')))!;
          await page.mouse.click(copy!.x, copy!.y);
          assert.deepEqual((await performed()).at(-1), ['copyText', { text: 'https://cloudrender.example/queue' }]);
          assert.equal((await ev(() => T.rtUi())).menu, null);
        });

        await t.test('a device and the whole folder close at once and stay closed (Settings)', async () => {
          await click('.cloud-device', 1);
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsClosed: [AIR] } }]);
          assert.equal(await count('.cloud-tab'), 4, 'shown before the state agrees');
          await ev((a) => T.rtSettings({ cloudTabsClosed: [a] }), AIR);
          assert.equal(await count('.cloud-tab'), 4);
          assert.equal(await ev(() => T.rtAttr('.cloud-device', 'aria-expanded', 1)), 'false');
          await click('.cloud-head');
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsOpen: false } }]);
          assert.equal(await count('.cloud-tab'), 0);
          assert.equal(await count('.cloud-device'), 0);
          assert.equal(await count('.cloud-head'), 1, 'its head stays');
          await ev(() => T.rtSettings({ cloudTabsOpen: false }));
          assert.equal(await count('.cloud-tab'), 0);
          await click('.cloud-head');
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsOpen: true } }]);
          await ev(() => T.rtSettings({ cloudTabsOpen: true, cloudTabsClosed: [] }));
          assert.equal(await count('.cloud-tab'), 6);
          // Pressed twice before the state agrees: each press from what's drawn (closed, then open).
          await click('.cloud-head');
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsOpen: false } }]);
          await click('.cloud-head');
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsOpen: true } }], 'open again, not closed twice');
          assert.equal(await count('.cloud-tab'), 6, 'drawn open');
          await click('.cloud-device', 1);
          await click('.cloud-device', 1);
          assert.deepEqual(await lastSent('updateSettings'), ['updateSettings', { patch: { cloudTabsClosed: [] } }], 'a device: closed, then open again');
          await ev(() => T.rtSettings({ cloudTabsOpen: true, cloudTabsClosed: [] }));
          assert.equal(await count('.cloud-tab'), 6);
        });

        await t.test('live: a tab retitled on another device changes that row only; the list keeps its scroll', async () => {
          const top = await ev(([s]) => T.rtSetScroll(s, 120), [sel.list]);
          assert.ok(top > 0);
          const changed = await ev(() => T.rtCloud(null, "raw.devices[0].tabs[1].title = 'Slow software, revised — Margins'"));
          assert.ok(changed.text <= 2 && changed.added === 0, `only the title's text: ${JSON.stringify(changed)}`);
          assert.ok((await ev(() => T.rtText('.cloud-tab .title'))).includes('Slow software, revised — Margins'));
          assert.equal(await ev(([s]) => T.rtScrollTop(s), [sel.list]), top, 'the scroll kept');
          const same = await ev(() => T.rtCloud(null, "raw.devices[0].tabs[1].title = 'Slow software, revised — Margins'"));
          assert.equal(same.records, 0, 'the same again: nothing touched');
        });

        await t.test('no Full Disk Access: one calm row whose button opens System Settings; Settings off: no folder', async () => {
          await ev(() => T.rtCloud({ status: 'noAccess', devices: [] }));
          assert.equal(await count('.cloud-tab'), 0);
          assert.match((await ev(() => T.rtText('.cloud-note .text')))[0], /Full Disk Access/);
          await click('.cloud-fix');
          assert.deepEqual((await performed()).at(-1), ['cloud.access', null]);
          await ev(() => T.rtCloud({ status: 'ready', devices: [] }));
          assert.match((await ev(() => T.rtText('.cloud-note .text')))[0], /No tabs are open on your other devices/);
          assert.equal(await count('.cloud-fix'), 0);
          await ev(() => T.rtSettings({ showCloudTabs: false }));
          await ev(() => T.rtCloud());
          assert.equal(await count('.cloud'), 0);
          await ev(() => T.rtSettings({ showCloudTabs: true }));
          assert.equal(await count('.cloud'), 1);
        });

        await t.test('the palette: typed, iCloud tabs in their own section per device; Enter opens one in this window', async () => {
          await ev(() => T.rtDispatch('palette.open'));
          await page.keyboard.type('ferry');
          const rows = (await ev(() => T.rtVmFull()))!.rowIds;
          assert.deepEqual(rows.filter((r) => r.startsWith('cloud:')), ['cloud:T-PHONE-1', 'cloud:T-AIR-2']);
          assert.equal(rows.at(-1), 'go', '"Search for …" last');
          assert.ok(rows.indexOf('cloud:T-PHONE-1') > rows.findLastIndex((r) => /^(tab|pin|action|archive):/.test(r)), 'after Margin\'s own rows');
          assert.deepEqual(await ev((s) => T.rtText(s), sel.section), ['On Nora’s iPhone', 'On Studio MacBook Air']);
          // Margin's own matches come first: down to the first iCloud tab, then Enter.
          for (let i = 0; i < rows.indexOf('cloud:T-PHONE-1'); i++) await page.keyboard.press('ArrowDown');
          assert.equal((await ev(() => T.rtVmFull()))!.selected, 'cloud:T-PHONE-1');
          await page.keyboard.press('Enter');
          assert.deepEqual(await lastSent('newTab'), ['newTab', { windowId: 1, url: 'https://tagus.example/ferries' }]);
          assert.equal((await ev(() => T.rtUi())).palette.open, false);
        });

        await t.test('nothing went to the network; no page errors', () => {
          assert.deepEqual(seen.requests, []);
          assert.deepEqual(seen.errors, []);
        });
      } finally {
        await browser.close();
      }
    });
  }
}
