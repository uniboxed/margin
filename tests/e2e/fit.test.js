import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launch, waitFor, launcherUrl, evalInShadow } from './helpers.js';

// "Keep open" pushes the page; shared/fit.js re-anchors fixed and
// window-wide elements to the page card. Window 1000px, sidebar 260px, 8px
// frame: the card spans from the sidebar's edge to 8px from the window's.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>fit</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  #header { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #36c; }
  #logo { position: fixed; top: 50px; left: 12px; width: 80px; height: 20px; background: #c36; }
  #modal { position: fixed; top: 100px; left: 50%; width: 300px; transform: translateX(-50%); height: 50px; background: #6c3; }
  #backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.05); pointer-events: none; }
  #pct { position: fixed; top: 200px; left: 10%; width: 50%; height: 20px; background: #cc3; }
  #widget { position: fixed; right: 10px; bottom: 10px; width: 60px; height: 30px; background: #3a3; }
  #fixedvw { position: fixed; top: 300px; left: 0; width: 100vw; height: 20px; background: #3cc; }
  #late { top: 400px; left: 0; right: 0; height: 20px; background: #c93; }
  .stuck { position: fixed; }
  #tooltip { position: fixed; top: 0; width: 20px; background: #000; color: #fff; }
  #moving { transform: translateZ(0); }
  #inside { position: fixed; left: 0; top: 0; width: 10px; height: 10px; }
  .container { max-width: 500px; margin: 450px auto 0; }
  #wide { width: 100vw; height: 30px; background: #c63; }
  #bleed { width: 100vw; margin-left: calc(50% - 50vw); height: 30px; background: #6c3; }
  #bleedchild { width: 100%; height: 10px; background: #000; }
  #bleed2 { width: 100vw; position: relative; left: 50%; transform: translateX(-50%); height: 30px; background: #63c; }
  #normal { height: 30px; background: #999; }
</style></head><body>
<div id="header"></div><div id="logo"></div><div id="modal"></div><div id="backdrop"></div><div id="pct"></div>
<div id="widget"></div><div id="fixedvw"></div><div id="late"></div>
<div id="tooltip" style="left: 300px">tip</div>
<div id="moving"><div id="inside"></div></div>
<div class="container"><div id="wide"></div><div id="bleed"><div id="bleedchild"></div></div><div id="bleed2"></div><div id="normal"></div></div>
<div style="height: 3000px"></div>
</body></html>`;

let ctx, server, base, control;
before(async () => {
  ctx = await launch();
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  control = await ctx.context.newPage();
  await control.goto(launcherUrl(ctx));
});
after(async () => {
  await ctx?.context.close();
  server?.close();
});

const setSettings = (patch) => control.evaluate((p) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: p }), patch);
const edges = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[id]')].map((e) => {
  const r = e.getBoundingClientRect();
  return [e.id, [Math.round(r.left), Math.round(r.right)]];
})));

async function open(name) {
  const page = await ctx.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${base}/${name}`);
  await page.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await page.bringToFront();
  return page;
}

// Where everything should be with a `w`px sidebar. `cw` is the window's
// width without its scrollbar (headless Chromium shows a 15px one, like
// Safari with "Always show scroll bars"); 100vw still includes it.
function fitted(w, cw) {
  const card = cw - w - 8;
  const r = (a, b) => [Math.round(a), Math.round(b)];
  return {
    header: r(w, w + card),
    logo: r(w + 12, w + 92),
    modal: r(w + card / 2 - 150, w + card / 2 + 150), // centred in the card
    backdrop: r(w, w + card),
    pct: r(w + card * 0.1, w + card * 0.6),
    widget: r(cw - 8 - 70, cw - 8 - 10), // 10px from the card's right edge
    fixedvw: r(w, w + card),
    wide: r(w, w + card),
    bleed: r(w, w + card),
    bleedchild: r(w, w + card),
    bleed2: r(w, w + card),
    normal: r(w + (card - 500) / 2, w + (card + 500) / 2), // ordinary content: just pushed
    tooltip: [300, 320], // placed by script: left alone
    inside: r(w, w + 10), // inside a transformed ancestor: moves with it (pushed), not shifted again
  };
}
const pick = (all, keys) => Object.fromEntries(keys.map((k) => [k, all[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('Keep open: fixed and window-wide elements fit the page card; off puts the page back as it was', async () => {
  await setSettings({ sidebarPinnedOpen: false, sidebarWidth: 260 });
  const page = await open('fit');
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  const natural = await edges(page);
  assert.deepEqual(natural.header, [0, cw]);
  assert.equal(natural.wide[1] - natural.wide[0], 1000, 'window-wide');

  await setSettings({ sidebarPinnedOpen: true });
  await waitFor(() => page.evaluate(() => document.documentElement.getBoundingClientRect().left === 260));
  const want = fitted(260, cw);
  await waitFor(async () => same(pick(await edges(page), Object.keys(want)), want), { timeout: 3000 }).catch(() => {});
  assert.deepEqual(pick(await edges(page), Object.keys(want)), want);

  // Stays fixed while scrolling; elements that turn fixed later are fitted too.
  await page.evaluate(() => scrollTo(0, 500));
  await page.evaluate(() => document.getElementById('late').classList.add('stuck'));
  await waitFor(async () => same((await edges(page)).late, want.header));
  assert.deepEqual((await edges(page)).header, want.header);
  assert.equal(await page.evaluate(() => document.getElementById('header').getBoundingClientRect().top), 0, 'still fixed');

  // Nothing added to the page but marker attributes; no inline styles.
  const markup = await page.evaluate(() => ({
    styles: document.querySelectorAll('style').length,
    inline: [...document.querySelectorAll('[data-margin-fit]')].filter((e) => e.style.length && e.id !== 'tooltip').length,
  }));
  assert.deepEqual(markup, { styles: 1, inline: 0 });

  await setSettings({ sidebarPinnedOpen: false });
  await waitFor(() => page.evaluate(() => document.documentElement.getBoundingClientRect().left === 0));
  const back = await edges(page);
  assert.deepEqual(pick(back, ['header', 'logo', 'wide', 'bleed', 'tooltip']), pick(natural, ['header', 'logo', 'wide', 'bleed', 'tooltip']));
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-margin-fit]').length), 0, 'markers removed');
  await page.close();
});

test('Keep open: resizing the sidebar refits the page to the new card', async () => {
  await setSettings({ sidebarPinnedOpen: true, sidebarWidth: 260 });
  const page = await open('fit-resize');
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  await waitFor(async () => same((await edges(page)).header, fitted(260, cw).header));
  await setSettings({ sidebarWidth: 360 });
  await waitFor(() => evalInShadow(page, 'margin-sidebar-host', function () {
    return Math.round(this.querySelector('.margin-sidebar').getBoundingClientRect().width) === 360;
  }));
  const want = fitted(360, cw);
  await waitFor(async () => same(pick(await edges(page), Object.keys(want)), want), { timeout: 3000 }).catch(() => {});
  assert.deepEqual(pick(await edges(page), Object.keys(want)), want);
  await setSettings({ sidebarPinnedOpen: false, sidebarWidth: 260 });
  await page.close();
});
