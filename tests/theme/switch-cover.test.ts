// The "switching" cover (Margin's <m-switch-cover>, app/HANDOFF.md §7) in
// both built-in themes and Margin's own default part, in Playwright's WebKit
// and Chromium, headless, every network request refused, with the mock host
// (ui/host.ts) holding `across` as Margin.app's host does: drawn over the
// page's place only in the window a switch leaves and only before the
// switch hands over, under a sidebar out over the page, above the
// launcher, Margin's words only; and "Close windows to save memory" in
// Settings, saved through the app. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, ARCADIA, NEO } from './package.ts';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const THEMES = [['arcadia', ARCADIA], ['neo-brutalism', NEO]];
const script = harnessScript();
const HERE = 'here';
const WORK = 's-work';
const across = (phase, more = {}) => ({
  v: 1,
  profile: HERE,
  profiles: [
    { id: HERE, name: 'Personal', emoji: '', color: '#6c5ce7', here: true, linked: true, spaces: 0 },
    { id: WORK, name: 'Work', emoji: '💼', color: '#00b894', here: false, linked: true, spaces: 1 },
  ],
  spaces: [{ profile: WORK, id: 'mail', name: 'Mail', emoji: '✉️', color: '#e17055', tabCount: 1 }],
  switchSettings: { closeWindows: false },
  switching: phase ? { profile: WORK, space: 'mail', phase, from: { profile: HERE, windowId: 1 }, ...more } : undefined,
});
// A theme with no switch-cover part: Margin's own default fills its slot.
const withoutPart = (pkg) => ({ ...pkg, html: pkg.html.replace(/<template m-part="switch-cover">[\s\S]*?<\/template>/, '') });

async function open(engine, pkg, id) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const seen = { requests: [], errors: [] };
  page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
  await page.addScriptTag({ content: script });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  assert.equal((await ev(([p, i]) => T.loadBuiltin(p, i), [pkg, id])).ok, true);
  return { browser, page, seen, ev };
}

for (const [engineName, engine] of ENGINES) {
  for (const [id, dir] of THEMES) {
    test(`the switching cover in ${id}, ${engineName}`, async (t) => {
      const { browser, page, seen, ev } = await open(engine, themeForPage(dir), id);
      try {
        const count = (s) => ev((x) => T.rtCount(x), s);
        const mount = (o = {}) => ev((x) => T.mountRuntime({ container: 'document', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac' }, ...x }), o);

        await t.test('over the page\'s place while the switch gets ready, in Margin\'s words; gone once it hands over', async () => {
          await mount({ settings: { sidebarPinnedOpen: true } });
          await ev((a) => T.rtAcross(a), across(null));
          assert.equal(await count('.switch-cover'), 0, 'no switch: no cover');
          for (const phase of ['preparing', 'waitingForLink', 'frozen']) {
            await ev((a) => T.rtAcross(a), across(phase));
            assert.equal(await count('.switch-cover'), 1, phase);
          }
          assert.deepEqual(await ev(() => T.rtText('.switch-cover-text')), ['Switching to Work…']);
          assert.deepEqual(await ev(() => T.rtText('.switch-cover-space')), ['✉️ Mail']);
          assert.equal(await ev(() => T.rtAttr('.switch-cover', 'aria-label')), 'Switching to Work… Mail');
          assert.equal(await ev(() => T.rtVisible('.switch-cover')), true);
          // It covers the page's place exactly, and takes the pointer there.
          const pageBox = await ev(() => T.rtRect('m-page'));
          const cover = await ev(() => T.rtRect('.switch-cover'));
          for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(pageBox[k] - cover[k]) <= 4, `${k}: page ${pageBox[k]}, cover ${cover[k]}`);
          assert.ok((await ev(([x, y]) => T.rtHitClasses(x, y), [pageBox.x, pageBox.y])).some((c) => c.includes('switch-cover')), 'what\'s at the page\'s middle is the cover');
          const ground = await ev(() => T.rtComputed('.switch-cover', 'background-color'));
          assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(ground), `solid: ${ground}`);
          for (const phase of ['after', 'landed', 'settling']) {
            await ev((a) => T.rtAcross(a), across(phase));
            assert.equal(await count('.switch-cover'), 0, phase);
          }
          // Another window's switch (the same id in another profile): not here.
          await ev((a) => T.rtAcross(a), across('frozen', { from: { profile: WORK, windowId: 1 } }));
          assert.equal(await count('.switch-cover'), 0);
        });

        await t.test('a profile with no emoji: its initial on its color', async () => {
          const a = across('preparing');
          a.profiles[1].emoji = '';
          await ev((x) => T.rtAcross(x), a);
          assert.deepEqual(await ev(() => T.rtText('.switch-cover-mark')), ['W']);
        });

        await t.test('a sidebar out over the page stays in front of it', async () => {
          await mount({ settings: { sidebarPinnedOpen: false } });
          await ev(() => T.rtSetUi({ sidebar: 'peek' }));
          await ev((a) => T.rtAcross(a), across('frozen'));
          assert.equal(await count('.switch-cover'), 1);
          const side = await ev((s) => T.rtRect(s), id === 'arcadia' ? '.margin-sidebar' : '.sidebar');
          assert.ok(side && side.width > 0);
          const hit = await ev(([x, y]) => T.rtHitClasses(x, y), [side.x, side.y]);
          assert.ok(!hit.some((c) => c.includes('switch-cover')), `the sidebar, not the cover: ${hit.join(' < ')}`);
        });

        await t.test('above the new-tab launcher', async () => {
          await mount({ mode: 'inpage', inNewTab: true });
          assert.equal(await count('.launcher'), 1);
          await ev((a) => T.rtAcross(a), across('preparing'));
          const pageBox = await ev(() => T.rtRect('m-page'));
          const hit = await ev(([x, y]) => T.rtHitClasses(x, y), [pageBox.x, pageBox.y]);
          assert.ok(hit.some((c) => c.includes('switch-cover')), `the cover over the launcher: ${hit.join(' < ')}`);
        });

        await t.test('"Close windows to save memory" in Settings, saved through the app', async () => {
          const platform = { browser: 'safari', os: 'mac', features: { cloudTabs: true, switchSettings: { closeWindows: false } } };
          await mount({ mode: 'inpage', inNewTab: true, platform });
          await ev(() => T.rtSetUi({ settingsOpen: true }));
          const label = 'label:has-text("Close windows to save memory") input';
          assert.equal(await page.locator(label).count(), 1);
          assert.equal(await page.locator(label).isChecked(), false);
          await page.click(label);
          assert.deepEqual((await ev(() => T.rtPerformedFull())).at(-1), ['switch.closeWindows', { on: true }]);
          assert.equal((await ev(() => T.rtSent())).filter(([k, p]) => k === 'updateSettings' && 'closeWindows' in (p?.patch ?? {})).length, 0, 'never the copy\'s setting');
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

  test(`Margin's own cover for a theme with no part, ${engineName}`, async () => {
    const { browser, seen, ev } = await open(engine, withoutPart(themeForPage(ARCADIA)), 'arcadia');
    try {
      await ev(() => T.mountRuntime({ container: 'document', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac' }, settings: { sidebarPinnedOpen: true } }));
      await ev((a) => T.rtAcross(a), across('frozen'));
      assert.equal(await ev(() => T.rtCount('.switch-cover')), 0, 'the theme\'s part is gone');
      assert.equal(await ev(() => T.rtCount('m-switch-cover .m-cover')), 1);
      assert.deepEqual(await ev(() => T.rtText('.m-cover-text')), ['Switching to Work…']);
      assert.deepEqual(await ev(() => T.rtText('.m-cover-space')), ['✉️ Mail']);
      assert.deepEqual(await ev(() => T.rtText('.m-cover-mark')), ['💼']);
      assert.equal(await ev(() => T.rtVisible('.m-cover')), true);
      const pageBox = await ev(() => T.rtRect('m-page'));
      const cover = await ev(() => T.rtRect('.m-cover'));
      for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(pageBox[k] - cover[k]) <= 4, `${k}: page ${pageBox[k]}, cover ${cover[k]}`);
      assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(await ev(() => T.rtComputed('.m-cover', 'background-color'))), 'solid');
      await ev((a) => T.rtAcross(a), across('landed'));
      assert.equal(await ev(() => T.rtCount('.m-cover')), 0);
      assert.deepEqual(seen.requests, []);
      assert.deepEqual(seen.errors, []);
    } finally {
      await browser.close();
    }
  });
}
