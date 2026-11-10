// Pixel as a theme package (extension/themes/pixel/, the "Sidebar ·
// Pixel / 8-bit" board) in real engines: Playwright's WebKit and Chromium,
// headless, every network request refused. It loads as a built-in theme with
// nothing removed and its two fonts from bundled bytes; draws the board's
// sidebar (WORLD n-1, folders, rows and their states, TODAY, the numbered
// chips) through the runtime with a mock host; places the page's box (docked,
// hidden with and without the frame, peek, the width setting); never paints
// over the page's box (checked on screen, pixel by pixel); caps the palette
// and drives it from the keyboard; draws every part with Margin's words only;
// blinks only while its setting is on and motion is allowed; and its first
// paint draws the card's pixel border and the ground around the box, nothing
// inside it. `npm run test:theme`. (Its iCloud Tabs, loading, gestures,
// notices and behaviors run in cloud.test.ts, feedback.test.ts and
// behaviors.test.ts with the other themes.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, PIXEL } from './package.ts';
import { firstPaintCss, layoutOwnCss } from '../../extension/shared/page-box.ts';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const script = harnessScript();
const pkg = themeForPage(PIXEL);
const FONTS = ['Press Start 2P', 'Pixelify Sans'];
const FIRST_PAINT = firstPaintCss('pixel', readFileSync(new URL('first-paint.css', `file://${PIXEL}`), 'utf8'));

// A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced).
function decodePng(buf) {
  let at = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; }
    else if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  const at2 = (x, y) => { const i = y * stride + x * bpp; return `#${[out[i], out[i + 1], out[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
  return { width, height, at: at2 };
}

for (const [name, engine] of ENGINES) {
  test(`Pixel's package in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const seen = { requests: [], errors: [] };
      page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
      page.on('pageerror', (e) => seen.errors.push(e.message));
      await context.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
      await page.addScriptTag({ content: script });
      const ev = (fn, arg) => page.evaluate(fn, arg);
      const count = (s) => ev((x) => T.rtCount(x), s);
      const text = (s) => ev((x) => T.rtText(x), s);
      // The last layout, once no more come (two frames with none new: a frame is later on a slow machine).
      const layout = async () => {
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const frames = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(T.rtLayouts().length)))));
        for (let n = -1, i = 0; i < 40; i++) { const now = await frames(); if (now === n) break; n = now; }
        return (await ev(() => T.rtLayouts())).at(-1);
      };
      const mount = (o = {}) => ev((x) => T.mountRuntime({ width: 1440, height: 900, platform: { browser: 'safari', os: 'mac' }, ...x }), o);
      // The state as the background would change it.
      const edit = (js) => ev((code) => { const rt = window.__rt; rt.mock.state = new Function('s', code)(rt.mock.state); rt.host.setState(rt.mock.state); }, js);

      await t.test('loads with nothing removed, its two fonts from the bundled bytes and nothing else', async () => {
        const raw = await ev(([p, f]) => T.loadNeo(p).then((r) => ({ ...r, fonts: f.map((x) => document.fonts.check(`16px "${x}"`)) })), [pkg, FONTS]);
        assert.equal(raw.ok, true);
        assert.deepEqual([raw.removed, raw.errors], [[], []], 'the sanitizer removes nothing');
        const r = await ev(([p, f]) => T.loadBuiltin(p, 'pixel', f), [pkg, FONTS]);
        assert.equal(r.ok, true);
        assert.equal(r.id, 'pixel');
        assert.deepEqual(r.read.slice(0, 3).sort(), ['theme.css', 'theme.html', 'theme.json']);
        assert.deepEqual(r.read.slice(3).sort(), ['fonts/pixelify-sans-latin-ext.woff2', 'fonts/pixelify-sans-latin.woff2', 'fonts/press-start-2p-latin-ext.woff2', 'fonts/press-start-2p-latin.woff2'], 'the fonts theme.json lists, nothing else');
        assert.deepEqual(r.fontErrors, []);
        assert.deepEqual(r.fonts, [true, true], 'Press Start 2P and Pixelify Sans are ready');
      });

      await t.test('the board\'s sidebar: WORLD 1-1, the name, ×count, folders, rows, TODAY, CLEAR, the numbered chips', async () => {
        await mount();
        assert.deepEqual(await text('.space-head .world'), ['WORLD 1-1']);
        assert.deepEqual(await text('.space-name'), ['Personal']);
        assert.equal(await ev(() => T.rtComputed('.space-name', 'text-transform')), 'uppercase', 'in capitals, as the board');
        assert.deepEqual(await text('.space-head .count'), ['×200']);
        assert.equal(await count('.tab'), 200);
        assert.equal(await count('.folder'), 2);
        assert.deepEqual(await text('.folder-name'), ['Reading', 'Lisbon']);
        assert.deepEqual(await text('.chip'), ['1', '2', '3'], 'chips by number, counted from 1');
        assert.equal(await count('.chip.on'), 1);
        assert.equal(await count('.tab.on'), 1, 'one row lit');
        assert.equal(await ev(() => T.rtShown('.tab.on .cursor .now')), true, 'the ▶ cursor before it (shown; it blinks)');
        assert.equal(await count('.clear'), 1);
        assert.deepEqual(await text('.today-label'), ['TODAY']);
        assert.equal(await count('.new-tab'), 1);
        assert.ok(await count('.tab .letter') > 0, 'a letter on the site\'s color where there\'s no icon');
        assert.ok(await count('.tab img.fav') > 0, 'the site\'s icon where there is one');
        assert.equal(await count('.today .tab .x'), 170, 'every tab has its ×');
        assert.equal(await ev(() => T.rtVisible('.today .tab .x')), false, 'shown on hover only');
        assert.equal(await count('[m-action], [m-arg], m-for, m-if, m-else'), 0, 'no template syntax left');
        // The board's colors and type.
        assert.equal(await ev(() => T.rtComputed('.sidebar', 'background-color')), 'rgb(42, 40, 80)');
        assert.equal(await ev(() => T.rtComputed('.tab.on', 'color')), 'rgb(255, 236, 39)');
        assert.equal(await ev(() => T.rtComputed('.tab.on', 'background-color')), 'rgb(59, 56, 112)');
        assert.match(await ev(() => T.rtComputed('.space-name', 'font-family')), /Press Start 2P/);
        assert.match(await ev(() => T.rtComputed('.tab .title', 'font-family')), /Pixelify Sans/);
        assert.equal(await ev(() => T.rtComputed('.space-head .world', 'color')), 'rgb(255, 210, 63)', 'WORLD in the space\'s color');
        // Another space: WORLD 2-1.
        await ev(() => T.rtApply('switchSpace', 'work'));
        assert.deepEqual(await text('.space-head .world'), ['WORLD 2-1']);
        assert.deepEqual(await text('.space-name'), ['Work']);
        assert.equal(await count('.chip.on'), 1);
        assert.deepEqual(await ev(() => T.rtAttr('.chip', 'aria-pressed', 1)), 'true');
      });

      await t.test('row states: asleep, playing, loading, behind, not open, a pin\'s ×; STAGE CLEAR! when today is empty', async () => {
        await mount();
        assert.ok(await count('.tab.asleep') > 0);
        assert.equal(await count('.tab.asleep .zz'), await count('.tab.asleep'), 'a "z" on each sleeping row');
        assert.equal(await ev(() => T.rtComputed('.tab.asleep .title', 'opacity')), '0.55');
        assert.ok(await count('.tab .eq') > 0, 'playing rows: the green bars');
        assert.equal(await count('.tab .eq i'), 3 * await count('.tab .eq'));
        assert.equal(await ev(() => T.rtComputed('.tab .eq i', 'animation-name')), 'px-eq');
        assert.equal(await count('.busy'), 0);
        await ev(() => T.rtLoading(true));
        assert.ok(await count('.tab.busy') > 0);
        assert.equal(await ev(() => T.rtComputed('.tab.busy .fav', 'animation-name')), 'px-busy', 'its icon box blinks');
        assert.match(await ev(() => T.rtComputed('.tab.busy .fav', 'animation-timing-function')), /steps\(1/, 'in steps');
        await ev(() => T.rtLoading(false));
        // A new tab on the way (⌘T, the palette): the tab in front only softly, a hollow, still ▷.
        await ev(() => T.rtDispatch('tab.new'));
        assert.equal(await count('.tab.behind'), 1);
        assert.equal(await count('.tab.on'), 0);
        assert.equal(await ev(() => T.rtVisible('.tab.behind .cursor .was')), true);
        assert.equal(await ev(() => T.rtComputed('.tab.behind .cursor .was', 'animation-name')), 'none', 'still');
        await page.keyboard.press('Escape');
        // A Margin tab with no browser tab: drawn as any tab (2026-11-08), only marked for a theme that wants to.
        await edit("return { ...s, keptTabs: { 't-k1': { id: 't-k1', url: 'https://kept.example/', title: 'Kept for later', favIconUrl: '', spaceId: 'personal', order: 0.5, lastActive: 1, keptAt: 1, why: 'window' } } };");
        assert.equal(await count('.tab.not-open'), 1);
        assert.equal(await ev(() => T.rtComputed('.tab.not-open .title', 'opacity')), '1');
        assert.notEqual(await ev(() => T.rtComputed('.tab.not-open .fav', 'outline-style')), 'dashed');
        // Pins: × only on those open in a tab, closing the tab (the pin stays).
        const pins = await count('.folder .tab.pin');
        assert.ok(pins > 0);
        assert.equal(await count('.folder .tab.pin .x'), await count('.folder .tab.pin.open'));
        await ev(() => T.rtSentClear());
        const row = await ev(() => T.rtBox('.today .tab', 0));
        await page.mouse.move(row.x, row.y);
        assert.equal(await ev(() => T.rtVisible('.today .tab .x')), true, 'hovered: its ×');
        const x = await ev(() => T.rtRect('.today .tab .x'));
        const id = (await ev(() => T.rtTodayIds(1)))[0];
        await page.mouse.click(x.x, x.y);
        assert.deepEqual((await ev(() => T.rtSent())).filter(([k]) => k === 'closeTab'), [['closeTab', { tabId: id }]]);
        // Today emptied: the board's line.
        await edit('return { ...s, keptTabs: {} };');
        await ev(() => T.rtApply('clearToday'));
        assert.equal(await count('.clear'), 0);
        assert.deepEqual(await text('.stage-clear'), ['STAGE CLEAR!NEW TABS LAND HERE.']);
        assert.deepEqual(await ev(() => T.rtRefused()), []);
      });

      await t.test('the page\'s box: docked beside the 252 px sidebar, 16 px gutters, no radius; the width setting; hidden, peek, no frame', async () => {
        await mount();
        assert.deepEqual(await layout(), { left: 286, top: 16, right: 16, bottom: 16, radius: 0, width: 1440, height: 900, windowId: 1, mode: 'fullscreen' }, '16 + 252 + 18');
        await mount({ settings: { themes: { pixel: { sidebarWidth: '300px' } } } });
        assert.equal((await layout()).left, 334);
        await mount({ settings: { themes: { pixel: { sidebarWidth: '520px' } } } });
        assert.equal((await layout()).left, 286, 'out of range: the default');
        await mount({ settings: { sidebarPinnedOpen: false } });
        assert.deepEqual(await layout(), { left: 16, top: 16, right: 16, bottom: 16, radius: 0, width: 1440, height: 900, windowId: 1, mode: 'fullscreen' }, 'hidden: the gutter all round');
        assert.equal(await count('.peek-zone'), 1);
        assert.equal(await ev(() => T.rtVisible('.peek-zone')), true);
        await ev(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(60);
        assert.equal((await ev(() => T.rtLayouts())).at(-1).left, 16, 'out over the page, the sidebar moves nothing');
        const side = await ev(() => T.rtRect('.sidebar'));
        assert.deepEqual([side.left, side.top, side.width], [14, 14, 252], 'a floating card 14 px from the edges');
        assert.equal(await ev(() => T.rtComputed('.sidebar', 'z-index')), '8');
        await mount({ settings: { sidebarPinnedOpen: false, frameWhenHidden: false } });
        assert.deepEqual(await layout(), { left: 0, top: 0, right: 0, bottom: 0, radius: 0, width: 1440, height: 900, windowId: 1, mode: 'fullscreen' }, '"keep the frame" off: the whole window');
        await mount({ mode: 'windowed' });
        assert.equal((await layout()).left, 286, 'windowed: the same box');
      });

      await t.test('never paints over the page\'s box: the ground, its dots and the border all stop at its edge (on screen)', async () => {
        for (const settings of [{}, { sidebarPinnedOpen: false }]) {
          await mount({ container: 'document', settings });
          const l = await layout();
          await ev(() => { document.body.style.background = '#ff00ff'; });
          await page.mouse.move(700, 450);
          await page.waitForTimeout(60);
          const shot = decodePng(await page.screenshot());
          const bad = [];
          for (let y = l.top; y < 900 - l.bottom; y += 7) for (let x = l.left; x < 1440 - l.right; x += 7) if (shot.at(x, y) !== '#ff00ff') bad.push([x, y, shot.at(x, y)]);
          assert.deepEqual(bad.slice(0, 5), [], `${JSON.stringify(settings)}: the page shows through everywhere in its box`);
          // Just outside: the light pixel border, and its notched corner the ground.
          assert.equal(shot.at(l.left + 40, l.top - 2), '#f1f1f1', 'the border above');
          assert.equal(shot.at(l.left - 2, l.top + 40), '#f1f1f1', 'the border at its left');
          assert.equal(shot.at(l.left - 2, l.top - 2), '#1d1b33', 'a notched corner: the ground');
          assert.equal(shot.at(1440 - 6, 450), '#1d1b33', 'the ground in the gutter');
        }
      });

      await t.test('the palette: SELECT DESTINATION, the > field focused, at most eight rows then it scrolls, driven from the keyboard', async () => {
        await mount();
        const address = await ev(() => T.rtBox('.address'));
        await page.mouse.click(address.x, address.y);
        assert.equal(await count('.palette'), 1);
        assert.deepEqual(await text('.palette-title'), ['SELECT DESTINATION']);
        assert.equal(await ev(() => T.rtActive()), 'palette', 'its field has the focus');
        const rows = await count('.palette-row');
        assert.ok(rows > 8, `${rows} rows`);
        const list = await ev(() => T.rtRect('.palette-rows'));
        assert.ok(list.height <= 8 * 42 + 1, `eight rows show (${list.height} px)`);
        const box = await ev(() => T.rtRect('.palette'));
        assert.ok(box.bottom <= 900 && box.top >= 0, 'the box stays in the window');
        assert.deepEqual([Math.round(box.width), Math.round(box.left + box.width / 2)], [696, 720], 'the board\'s 660 px box and its padding, centred');
        assert.equal(await count('.palette-row.on'), 1);
        for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
        const vm = await ev(() => T.rtVmFull());
        assert.equal(vm.selected, vm.rowIds[11]);
        const on = await ev(() => T.rtRect('.palette-row.on'));
        assert.ok(on.top >= list.top - 1 && on.bottom <= list.bottom + 1, 'the selected row scrolled into view');
        assert.equal(await ev(() => T.rtShown('.palette-row.on .cursor .now')), true, 'with its ▶ (shown; it blinks)');
        await page.keyboard.type('nimbus');
        assert.ok((await ev(() => T.rtVmFull())).rows.slice(0, 2).every((r) => /nimbus/i.test(r)));
        await page.keyboard.press('Enter');
        assert.equal(await count('.palette'), 0, 'Enter goes and closes it');
        assert.equal((await ev(() => T.rtSent())).at(-1)[0], 'activateTab');
        await ev(() => T.rtDispatch('palette.open'));
        await page.keyboard.type('zzzz-nothing-at-all');
        await page.keyboard.press('Escape');
        assert.equal(await count('.palette'), 0, 'Escape closes it');
      });

      await t.test('every other part, in Margin\'s words: a menu, the space editor, a notice, a prompt', async () => {
        await mount();
        const tab = (await ev(() => T.rtTodayIds(1)))[0];
        await ev((id) => T.rtSetUi({ menu: { kind: 'tab', id, x: 60, y: 400 } }), tab);
        const items = (await ev(() => T.rtVmFull())).menu.filter(Boolean);
        assert.deepEqual(await text('.menu .menu-item'), items, 'each item its label, nothing more');
        assert.equal(await ev(() => T.rtAttr('.menu', 'aria-label')), 'Tab');
        assert.ok(await count('.menu-sep') > 0);
        assert.equal(await ev(() => T.rtComputed('.menu', 'background-color')), 'rgb(29, 27, 51)', 'a dark box with the light pixel border');
        await ev(() => T.rtSetUi({ menu: null }));

        await ev(() => T.rtDispatch('space.edit', 'personal'));
        assert.deepEqual(await text('.editor-title'), ['Edit space']);
        assert.equal(await count('.editor .swatch'), 8);
        assert.deepEqual(await text('.editor .actions button'), ['Delete', 'Cancel', 'Save']);
        assert.equal(await ev(() => T.rtAttr('.editor-name', 'placeholder')), 'Space name');
        await ev(() => T.rtDispatch('editor.cancel'));
        assert.equal(await count('.editor'), 0);

        await ev(() => T.rtSetUi({ notice: { id: 'fs', text: 'Margin works in full screen.', actions: [{ id: 'go', label: 'Full screen', primary: true }, { id: 'no', label: 'Not now' }] } }));
        assert.deepEqual(await text('.notice .text, .notice button'), ['Margin works in full screen.', 'Full screen', 'Not now']);
        assert.equal(await count('.notice svg.more'), 1, 'the RPG box\'s ▼, an svg');
        const slot = await layout();
        const notice = await ev(() => T.rtRect('.notice'));
        assert.ok(notice.left >= slot.left && notice.bottom <= 900 - slot.bottom, 'over the page');
        assert.equal(slot.right, 16, 'a notice moves nothing');
        await ev(() => T.rtSetUi({ notice: null }));
        await ev(() => T.rtSetUi({ prompt: { id: 'app', title: 'Install Margin.app', text: 'Margin needs its app on the Mac.', actions: [{ id: 'later', label: 'Later' }, { id: 'ok', label: 'Install', primary: true }] } }));
        assert.deepEqual(await text('.prompt-title, .prompt-text, .prompt button'), ['Install Margin.app', 'Margin needs its app on the Mac.', 'Later', 'Install']);
        assert.equal(await ev(() => T.rtComputed('.prompt-title', 'color')), 'rgb(255, 236, 39)');
        assert.equal((await ev(() => T.rtLayouts())).at(-1).right, 16, 'a prompt moves nothing either');
        await ev(() => T.rtDispatch('prompt.close'));
        assert.equal(await count('.prompt'), 0);
        assert.deepEqual(await ev(() => T.rtRefused()), []);
      });

      await t.test('the new-tab page: a title screen, the > field focused, pinned tiles, the archive; Settings in Pixel\'s inputs', async () => {
        await mount({ inNewTab: true, mode: 'inpage', platform: { browser: 'safari', os: 'mac', features: { sleepTabs: 'discard', blockGestures: true, newTabHint: true, search: 'learn' } }, replies: { wakeSleeping: 0 } });
        assert.equal(await count('.launcher'), 1);
        assert.deepEqual(await text('.title-screen .world, .title-screen .stage'), ['WORLD 1-1', 'Personal']);
        assert.equal(await ev(() => T.rtActive()), 'launcher');
        assert.ok(await count('.launcher .tile') > 0);
        assert.ok(await count('.launcher .archive-row') > 0);
        assert.equal((await layout()).left, 286, 'beside the sidebar, which stays');
        await ev(() => T.rtSetUi({ settingsOpen: true }));
        assert.ok(await count('.settings-form .setting') > 5);
        const options = await ev(() => [...__rt.target.querySelectorAll('.settings-form select option')].map((o) => o.textContent));
        assert.deepEqual(options.slice(0, 3), ['Arcadia', 'Neubrutalism', 'Pixel'], 'Pixel in the theme choice');
        assert.equal(await ev(() => T.rtComputed('.settings-form select', 'background-color')), 'rgb(11, 10, 26)');
        assert.equal(await ev(() => T.rtComputed('.settings-form input.toggle', 'appearance')), 'none', 'toggles drawn as pixel boxes');
        assert.ok(await count('.setting-group') > 0);
      });

      await t.test('windowed: three square controls that run the window\'s actions; none in full screen', async () => {
        await mount();
        assert.equal(await ev(() => T.rtVisible('.window-controls')), false);
        await mount({ mode: 'windowed' });
        assert.equal(await count('.window-controls .wc'), 3);
        assert.equal(await ev(() => T.rtVisible('.window-controls')), true);
        const close = await ev(() => T.rtBox('.wc.close'));
        await page.mouse.click(close.x, close.y);
        const full = await ev(() => T.rtBox('.wc.full'));
        await page.mouse.click(full.x, full.y);
        assert.deepEqual(await ev(() => T.rtPerformed()), ['window.close', 'window.fullscreen']);
        await mount({ mode: 'inpage' });
        assert.equal(await ev(() => T.rtVisible('.toolbar')), false, 'in a page, the browser\'s toolbar stays');
      });

      await t.test('blinking: the cursor and the address\'s block blink in steps while the setting is on, never with reduced motion', async () => {
        await mount();
        assert.ok((await ev(() => T.rtClasses('.pixel'))).includes('blink'));
        assert.equal(await ev(() => T.rtComputed('.address .caret', 'animation-name')), 'px-blink');
        assert.match(await ev(() => T.rtComputed('.address .caret', 'animation-timing-function')), /steps\(1/);
        await mount({ settings: { themes: { pixel: { blink: false } } } });
        assert.equal((await ev(() => T.rtClasses('.pixel'))).includes('blink'), false);
        assert.equal(await ev(() => T.rtComputed('.address .caret', 'animation-name')), 'none');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await mount();
        assert.equal(await ev(() => T.rtComputed('.address .caret', 'animation-name')), 'none');
        assert.equal(await ev(() => T.rtComputed('.tab.on .cursor .now', 'animation-name')), 'none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      });

      await t.test('one look, dark, in both system modes', async () => {
        const look = async (scheme) => {
          await page.emulateMedia({ colorScheme: scheme });
          await mount({ inNewTab: true });
          return ev(() => ['.sidebar', '.tab.on', '.launcher', '.address'].map((s) => [T.rtComputed(s, 'background-color'), T.rtComputed(s, 'color')]));
        };
        assert.deepEqual(await look('light'), await look('dark'));
        await page.emulateMedia({ colorScheme: null });
        await ev(() => T.unmountRuntime());
      });

      await t.test('first paint: the card\'s light pixel border and the night ground around the box, nothing inside it', async () => {
        const fp = await context.newPage();
        await fp.setContent(`<!doctype html><html data-margin-at="pixel"><head><meta charset="utf-8"><style>${FIRST_PAINT}\n${layoutOwnCss({ left: 286, top: 16, right: 16, bottom: 16, radius: 0 })}</style></head><body style="margin:0;background:#ff00ff"><p style="margin:0">a page</p></body></html>`);
        await fp.waitForTimeout(60);
        const shot = decodePng(await fp.screenshot());
        assert.equal(shot.at(700, 450), '#ff00ff', 'the page inside its box');
        assert.equal(shot.at(287, 17), '#ff00ff', 'right to its corner');
        assert.equal(shot.at(700, 14), '#f1f1f1', 'the border above');
        assert.equal(shot.at(284, 450), '#f1f1f1', 'and at its left');
        assert.equal(shot.at(284, 14), '#1d1b33', 'a notched corner');
        assert.equal(shot.at(100, 450), '#1d1b33', 'the ground where the sidebar will be');
        assert.equal(shot.at(1436, 896), '#1d1b33');
        // Not marked for Pixel (another theme's, or none): nothing at all.
        await fp.evaluate(() => document.documentElement.removeAttribute('data-margin-at'));
        await fp.waitForTimeout(60);
        assert.equal(decodePng(await fp.screenshot()).at(100, 450), '#ff00ff');
        await fp.close();
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
