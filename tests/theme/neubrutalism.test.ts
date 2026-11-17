// Neubrutalism against its board ("Neubrutalism", Main.dc.html)
// and against Arcadia's parts, in real engines: Playwright's WebKit and
// Chromium, headless, every network request refused, through the runtime and
// the mock host. Folder heads without a count; each row's close button, the
// speaker on a row playing sound, the dashed outline on the tab shown while a
// new tab is on its way; loose pins in a card of their own; the palette's
// eight rows (then it scrolls, the selected row in view) with the board's
// tags and each row's icon, inside the window with 200 tabs; "keep the frame
// when hidden" off, the page edge to edge; nothing painted over the page's box
// (on screen); and one look in light and dark system modes. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, NEO } from './package.ts';
import { pageLoaderChecks, rgba } from './page-card.ts';
import type { Harness, HarnessRt } from './harness.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;
declare const __rt: HarnessRt;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();
const pkg = themeForPage(NEO);
const INK = '#111111';
const PAGE = '#ff00ff';

// A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced).
function decodePng(buf: Buffer) {
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
  const at2 = (x: number, y: number) => { const i = y * stride + x * bpp; return `#${[out[i], out[i + 1], out[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
  return { width, height, at: at2 };
}

for (const [name, engine] of ENGINES) {
  test(`Neubrutalism against its board in ${name}`, async (t) => {
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
      const computed = (s: string, p: string) => ev(([x, y]) => T.rtComputed(x, y), [s, p]);
      // The last layout, once no more come (two frames with none new: a frame is later on a slow machine).
      const layout = async () => {
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const frames = () => ev(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(T.rtLayouts().length)))));
        for (let n = -1, i = 0; i < 40; i++) { const now = await frames(); if (now === n) break; n = now; }
        return (await ev(() => T.rtLayouts())).at(-1)!;
      };
      const mount = (o = {}) => ev((x) => T.mountRuntime({ width: 1440, height: 900, platform: { browser: 'safari', os: 'mac' }, ...x }), o);
      // The state as the background would change it.
      const edit = (js: string) => ev((code) => { const rt = (window as typeof window & { __rt: HarnessRt }).__rt; rt.mock.state = new Function('s', code)(rt.mock.state); rt.host.setState(rt.mock.state); }, js);

      await t.test('loads with nothing removed, as a package and as a built-in theme', async () => {
        const raw = await ev((p) => T.loadNeo(p), pkg);
        assert.equal(raw.ok, true);
        assert.deepEqual([raw.removed, raw.errors], [[], []], 'the sanitizer removes nothing');
        const r = await ev((p) => T.loadBuiltin(p), pkg);
        assert.equal(r.ok, true);
        assert.deepEqual(r.fontErrors, []);
        assert.deepEqual(r.fonts, [true, true]);
      });

      await t.test('folder heads as the board\'s: a chevron and the name, no count', async () => {
        await mount();
        assert.equal(await count('.folder'), 2);
        assert.equal(await count('.folder-head .folder-count'), 0);
        assert.deepEqual(await ev(() => T.rtText('.folder-head')), ['Reading', 'Lisbon']);
        assert.equal(await count('[m-action], [m-arg], m-for, m-if, m-else'), 0, 'no template syntax left');
      });

      await t.test('rows: a close button on hover (tabs, and pins open in a tab), the speaker, the tab shown behind a new one', async () => {
        await mount();
        const today = (await ev(() => T.rtVm()))!.today;
        assert.equal(await count('.today .tab'), today);
        assert.equal(await count('.today .close'), today, 'every tab has its close button');
        assert.equal(await count('.folder .close'), await count('.folder .tab.pin.open'), 'pins: only those open in a tab');
        assert.ok(await count('.folder .close') > 0);
        assert.equal(await ev(() => T.rtVisible('.today .close')), false, 'hidden until hovered');
        assert.equal(await ev(() => T.rtAttr('.today .close', 'aria-label')), 'Close tab');
        assert.equal(await ev(() => T.rtAttr('.folder .close', 'aria-label')), 'Close tab (stays pinned)');
        // Hovered: the ×, in a bordered box; a click closes the tab, nothing else.
        await ev(() => T.rtSentClear());
        const row = (await ev(() => T.rtBox('.today .tab', 0)))!;
        await page.mouse.move(row.x, row.y);
        assert.equal(await ev(() => T.rtVisible('.today .close')), true, 'hovered: its ×');
        assert.equal(await computed('.today .close', 'border-top-style'), 'solid');
        assert.equal(await computed('.today .close', 'width'), '20px');
        const x = (await ev(() => T.rtRect('.today .close')))!;
        const r = (await ev(() => T.rtRect('.today .tab')))!;
        assert.ok(x.right <= r.right && x.top >= r.top && x.bottom <= r.bottom, 'inside its row');
        const id = (await ev(() => T.rtTodayIds(1)))[0];
        await page.mouse.click(x.x, x.y);
        const sent = (await ev(() => T.rtSent())).map(([k]) => k).filter((k) => !/^(sidebarScroll|setSidebarScroll)$/.test(k));
        assert.deepEqual(sent, ['closeTab'], 'closing doesn\'t switch to the tab first');
        assert.deepEqual((await ev(() => T.rtSent())).find(([k]) => k === 'closeTab'), ['closeTab', { tabId: id }]);
        // Playing sound: a speaker after the title, gone under the ×.
        await mount();
        const playing = await count('.tab .audible');
        assert.ok(playing > 0, 'the mock has tabs playing');
        assert.equal(await ev(() => T.rtAttr('.tab .audible', 'aria-label')), 'Playing audio');
        assert.equal(await ev(() => T.rtVisible('.tab .audible')), true);
        // The tab shown while a new tab is on its way (⌘T): outlined, dashed.
        await ev(() => T.rtDispatch('tab.new'));
        assert.equal(await count('.tab.behind'), 1);
        assert.equal(await count('.tab.on'), 0);
        assert.equal(await computed('.tab.behind', 'outline-style'), 'dashed');
        await page.keyboard.press('Escape');
        assert.equal(await count('.tab.behind'), 0);
        // Dragged, a row's copy follows the pointer (nothing around it holds
        // containment that would move or clip the fixed copy).
        const g0 = (await ev(() => T.rtBox('.today .tab', 1)))!;
        await page.mouse.move(g0.x, g0.y);
        await page.mouse.down();
        await page.mouse.move(g0.x + 30, g0.y - 40, { steps: 5 });
        // The copy follows each move a frame or more later (on a loaded machine, more than 80 ms): asked again until it's there.
        const end = Date.now() + 3000;
        for (;;) {
          const ghost = (await ev(() => T.rtRect('.m-drag-ghost')))!;
          const under = ghost && Math.abs(ghost.y - (g0.y - 40)) < 20 && Math.abs(ghost.x - (g0.x + 30)) < 40;
          if (under) break;
          assert.ok(Date.now() < end, `the copy under the pointer (${JSON.stringify([g0, ghost])})`);
          await page.waitForTimeout(25);
        }
        await page.keyboard.press('Escape');
        await page.mouse.up();
        assert.deepEqual(await ev(() => T.rtRefused()), []);
      });

      await t.test('loose pins: the board\'s folder rows in one borderless card, open or not', async () => {
        await mount();
        await ev(() => T.rtApply('switchSpace', 'work'));
        assert.equal(await count('.loose-card'), 1);
        assert.equal(await count('.loose-card .tab.pin.open'), 1, 'open in a tab: marked so');
        assert.equal(await count('.loose-card .close'), 1);
        assert.equal(await computed('.loose-card', 'background-color'), 'rgb(255, 255, 255)');
        assert.equal(await computed('.loose-card', 'border-top-width'), '0px');
        // A second one beside it, not open: the same card, no ×.
        await edit("return { ...s, pins: [...s.pins, { id: 'pin-x', spaceId: 'work', url: 'https://later.example/', title: 'Read later', pos: 99 }] };");
        assert.equal(await count('.loose-card'), 2);
        assert.equal(await count('.loose-card .tab.pin.open'), 1);
        assert.equal(await count('.loose-card .close'), 1);
        const a = (await ev(() => T.rtRect('.loose-card', 0)))!;
        const b = (await ev(() => T.rtRect('.loose-card', 1)))!;
        assert.ok(Math.abs(b.top - a.bottom) < 0.5, `one card: no gap between them (${a.bottom} → ${b.top})`);
        assert.equal(await ev(() => getComputedStyle((window as typeof window & { __rt: HarnessRt }).__rt.target.querySelectorAll('.loose-card')[0]).borderBottomLeftRadius), '0px');
        assert.equal(await ev(() => getComputedStyle((window as typeof window & { __rt: HarnessRt }).__rt.target.querySelectorAll('.loose-card')[1]).borderTopLeftRadius), '0px');
      });

      await t.test('the palette: eight rows then it scrolls, in the window with 200 tabs; the board\'s tags, each row\'s icon', async () => {
        for (const height of [900, 600]) {
          await mount({ height });
          await ev(() => T.rtDispatch('palette.open'));
          const rows = await count('.palette-row');
          assert.ok(rows > 8, `${rows} rows`);
          const box = (await ev(() => T.rtRect('.palette')))!;
          assert.ok(box.top >= 0 && box.bottom <= height, `${height}: the box stays in the window (${box.top}–${box.bottom})`);
          const list = (await ev(() => T.rtRect('.palette-rows')))!;
          assert.ok(list.height <= 8 * 46 + 7 * 10 + 1, `${height}: eight rows at most (${list.height} px)`);
          assert.equal(await computed('.palette-rows', 'overflow-y'), 'auto');
        }
        assert.equal(Math.round((await ev(() => T.rtRect('.palette')))!.top), 102, 'a short window: nearer the top');
        await mount();
        await ev(() => T.rtDispatch('palette.open'));
        assert.equal(Math.round((await ev(() => T.rtRect('.palette')))!.top), 150, 'the board\'s place');
        assert.equal(await ev(() => T.rtActive()), 'palette');
        for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
        const vm = await ev(() => T.rtVmFull());
        assert.equal(vm.selected, vm.rowIds[11]);
        const list = (await ev(() => T.rtRect('.palette-rows')))!;
        const on = (await ev(() => T.rtRect('.palette-row.on')))!;
        assert.ok(on.top >= list.top - 1 && on.bottom <= list.bottom + 1, 'the selected row scrolled into view');
        // Tags: the row's badge, in the space's color, capitals, a 2 px ink border.
        const n = await count('.palette-row');
        assert.equal(await count('.palette-row .tag'), n);
        assert.equal(await computed('.palette-row .tag', 'background-color'), 'rgb(255, 210, 63)');
        assert.equal(await computed('.palette-row .tag', 'text-transform'), 'uppercase');
        assert.equal(await computed('.palette-row .tag', 'border-top-width'), '2px');
        assert.equal(await computed('.palette-row .tag', 'border-top-color'), 'rgb(17, 17, 17)');
        // Each row's icon box: the site's icon, its letter, or the row's emoji.
        assert.equal(await count('.palette-row .fav'), n);
        assert.ok(await count('.palette-row img.fav') > 0);
        await page.keyboard.type('nimbus');
        assert.ok((await ev(() => T.rtVmFull()))!.rows.slice(0, 2).every((r) => /nimbus/i.test(r)));
        await page.keyboard.press('Enter');
        assert.equal(await count('.palette'), 0);
        assert.equal((await ev(() => T.rtSent())).at(-1)![0], 'activateTab');
        // In another space, its color.
        await ev(() => T.rtApply('switchSpace', 'work'));
        await ev(() => T.rtDispatch('palette.open'));
        assert.equal(await computed('.palette-row .tag', 'background-color'), 'rgb(127, 179, 255)');
        await page.keyboard.press('Escape');
      });

      await t.test('the page\'s box: docked, hidden with the frame, and edge to edge with "keep the frame" off', async () => {
        const at = (o: Record<string, unknown>) => ({ width: 1440, height: 900, windowId: 1, mode: 'fullscreen', ...o });
        await mount();
        assert.deepEqual(await layout(), at({ left: 291, top: 19, right: 19, bottom: 19, radius: 15 }), '16 + 256 + 16, inside the 3 px border');
        await mount({ settings: { sidebarPinnedOpen: false } });
        assert.deepEqual(await layout(), at({ left: 19, top: 19, right: 19, bottom: 19, radius: 15 }), 'hidden, with the frame');
        await ev(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(60);
        assert.equal((await ev(() => T.rtLayouts())).at(-1)!.left, 19, 'peek moves nothing');
        await mount({ settings: { sidebarPinnedOpen: false, frameWhenHidden: false } });
        assert.deepEqual(await layout(), at({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 }), 'no frame: the whole window, square');
        assert.ok(!(await ev(() => T.rtClasses('.nb')))!.includes('framed'));
        await ev(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(60);
        assert.deepEqual((await ev(() => T.rtLayouts())).at(-1), at({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 }), 'and while the sidebar peeks');
        const side = (await ev(() => T.rtRect('.sidebar')))!;
        assert.deepEqual([side.left, side.top], [16, 16], 'the peeking card still floats in from the edge');
        // Loading with no frame: the stripe along the page's top edge.
        await ev(() => T.rtLoading(true));
        const bar = (await ev(() => T.rtRect('.load-bar')))!;
        assert.deepEqual([bar.top, bar.left, bar.right], [0, 0, 1440]);
        await ev(() => T.rtLoading(false));
        // Docked, the setting changes nothing.
        await mount({ settings: { frameWhenHidden: false } });
        assert.equal((await layout())!.left, 291);
      });

      await t.test('a notice, a prompt or the space editor moves nothing: the page keeps its box', async () => {
        await mount();
        const before = await layout();
        await ev(() => T.rtSetUi({ notice: { id: 'n', text: 'Margin works in full screen.', actions: [{ id: 'go', label: 'Full screen', primary: true }] } }));
        assert.equal(await count('.notice'), 1);
        await page.waitForTimeout(60);
        assert.deepEqual(await layout(), before, 'a notice');
        await ev(() => T.rtSetUi({ notice: null, prompt: { id: 'app', title: 'Install Margin.app', text: 'Margin needs its app.', actions: [{ id: 'ok', label: 'Install', primary: true }] } }));
        assert.equal(await count('.prompt'), 1);
        await page.waitForTimeout(60);
        assert.deepEqual(await layout(), before, 'a prompt');
        await ev(() => T.rtDispatch('prompt.close'));
        await ev(() => T.rtDispatch('space.edit', 'personal'));
        assert.equal(await count('.editor'), 1);
        await page.waitForTimeout(60);
        assert.deepEqual(await layout(), before, 'the editor');
        await ev(() => T.rtDispatch('editor.cancel'));
      });

      await t.test('never paints over the page\'s box (on screen): docked, hidden, no frame', async () => {
        for (const settings of [{}, { sidebarPinnedOpen: false }, { sidebarPinnedOpen: false, frameWhenHidden: false }]) {
          await mount({ container: 'document', settings });
          const l = await layout();
          await ev((c) => { document.body.style.background = c; }, PAGE);
          await page.mouse.move(700, 450);
          await page.waitForTimeout(80);
          const shot = decodePng(await page.screenshot());
          const bad = [];
          const r = l.radius + 1; // the rounded corners: the page is cut there
          for (let y = l.top; y < 900 - l.bottom; y += 7) {
            for (let x = l.left; x < 1440 - l.right; x += 7) {
              const corner = (x < l.left + r || x >= 1440 - l.right - r) && (y < l.top + r || y >= 900 - l.bottom - r);
              if (!corner && shot.at(x, y) !== PAGE) bad.push([x, y, shot.at(x, y)]);
            }
          }
          assert.deepEqual(bad.slice(0, 5), [], `${JSON.stringify(settings)}: the page shows through everywhere in its box`);
          if (l.left > 0) {
            assert.equal(shot.at(l.left + 60, l.top - 2), INK, 'the border above');
            assert.equal(shot.at(l.left - 2, l.top + 60), INK, 'and at its left');
          }
        }
      });

      await t.test('one look, the board\'s, in light and dark system modes', async () => {
        const look = async (scheme: 'light' | 'dark') => {
          await page.emulateMedia({ colorScheme: scheme });
          await mount({ inNewTab: true });
          await ev(() => T.rtSetUi({ settingsOpen: true }));
          return ev(() => ['.nb', '.tab.on', '.launcher', '.address', '.folder', '.settings-form select', '.settings-form input.toggle'].map((s) => [s, T.rtComputed(s, 'background-color'), T.rtComputed(s, 'color'), T.rtComputed(s, 'color-scheme')]));
        };
        const light = await look('light');
        assert.deepEqual(await look('dark'), light);
        assert.equal(light[0][3], 'light', 'Margin\'s inputs light too');
        await page.emulateMedia({ colorScheme: null });
      });

      await t.test('dedicated Settings has a heading and controls without a start-page field', async () => {
        await mount({ inNewTab: true });
        await ev(() => T.rtSetUi({ settingsPage: true }));
        assert.equal(await count('.launcher h1'), 1);
        assert.equal(await count('.launcher-query'), 0);
        assert.equal(await count('.launcher .archive-row, .launcher .tile'), 0);
        assert.ok(await count('.settings-form input') > 0);
      });

      await t.test('Settings: toggles drawn as Neo switches, buttons on one line', async () => {
        await mount({ inNewTab: true });
        await ev(() => T.rtSetUi({ settingsOpen: true }));
        assert.equal(await computed('.settings-form input.toggle', 'appearance'), 'none');
        assert.equal(await computed('.settings-form input.toggle', 'border-top-style'), 'solid');
        assert.equal(await computed('.settings-form input.toggle', 'border-top-left-radius'), '999px');
        assert.equal(await computed('.settings-form .small', 'white-space'), 'nowrap');
        await ev(() => T.unmountRuntime());
      });

      await t.test('Margin.app\'s own window with nothing hosted: its page area the launcher, opaque, never a see-through hole', async () => {
        await page.evaluate(() => T.mountRuntime({ width: 1280, height: 800, mode: 'windowed', appWindow: true }));
        const e = await page.evaluate(() => T.rtEmptyPage());
        assert.ok(e.page && e.launcher, 'a launcher drawn in the page card');
        const [px, py, pw, ph] = e.page!, [lx, ly, lw, lh] = e.launcher!;
        assert.ok(Math.abs(px + pw / 2 - (lx + lw / 2)) <= 1 && Math.abs(py + ph / 2 - (ly + lh / 2)) <= 1 && lw >= pw - 8 && lh >= ph - 8, `the page's box covered: ${e.page} ${e.launcher}`);
        const alpha = /^rgba\(/.test(e.background!) ? Number(e.background!.split(',').at(-1)!.replace(')', '')) : 1;
        assert.ok(/^rgba?\(/.test(e.background!) && alpha === 1, `opaque: ${e.background}`);
        await page.evaluate(() => T.unmountRuntime());
      });

      // Neubrutalism's own page loader (Margin.app, while an item opens): a cream card, Margin's words in the heavy
      // type over a chunky bar in the space's color (a thick ink border, a hard offset shadow), a striped block
      // running along it.
      await pageLoaderChecks(t, browser, {
        id: 'neubrutalism', dir: NEO, script,
        label: '.opening-label', mark: '.opening-run',
        animations: ['nb-run'],
        skeleton: [['.space-name', ''], ['.folders', '::before'], ['.today', '::before'], ['.chips', '::before'], ['.chips', '::after']],
        starting: ['nb-run', 'nb-wait'],
        look: async (page, ev) => {
          const read = () => ev(() => ({ card: T.rtLoader()!.background, bar: T.rtRect('.opening-bar')!, run: T.rtRect('.opening-run')!, label: T.rtRect('.opening-label')!, slot: T.rtRect('m-page-loader')!,
            fill: T.rtComputed('.opening-bar', 'background-color'), border: [T.rtComputed('.opening-bar', 'border-top-width'), T.rtComputed('.opening-bar', 'border-top-style'), T.rtComputed('.opening-bar', 'border-top-color')],
            shadow: T.rtComputed('.opening-bar', 'box-shadow'), stripes: T.rtComputed('.opening-run', 'background-image'),
            font: T.rtComputed('.opening-label', 'font-family'), size: parseFloat(T.rtComputed('.opening-label', 'font-size') ?? '0'), upper: T.rtComputed('.opening-label', 'text-transform'), ink: T.rtComputed('.opening-label', 'color') }));
          const a = await read();
          assert.deepEqual(rgba(a.card), [255, 253, 247, 1], 'a cream card');
          assert.deepEqual([a.border[0], a.border[1], rgba(a.border[2])], ['3px', 'solid', [17, 17, 17, 1]], 'a thick ink border');
          assert.match(a.shadow ?? '', /6px 6px 0px/, 'a hard offset shadow (no blur)');
          assert.deepEqual(rgba(a.fill), [255, 210, 63, 1], 'the bar in the space\'s color');
          assert.match(a.stripes ?? '', /repeating-linear-gradient/, 'a striped block');
          assert.ok(Math.abs(a.bar.x - a.slot.x) <= 1 && Math.abs(a.bar.y - a.slot.y) <= 1, 'the bar in the card\'s middle');
          assert.ok(a.label.bottom <= a.bar.top - 8 && Math.abs(a.label.x - a.bar.x) <= 1, 'the words over it');
          assert.match(a.font ?? '', /Archivo Black/);
          assert.deepEqual([a.upper, rgba(a.ink)], ['uppercase', [17, 17, 17, 1]], 'heavy, upper case, ink');
          assert.ok(a.size >= 28, `large (${a.size}px)`);
          assert.equal(await ev(() => document.fonts.check('30px "Archivo Black"')), true, 'its bundled font');
          // The block runs along the bar, always inside its border.
          const seen = new Set<number>();
          for (let i = 0; i < 8; i++) {
            const b = await read();
            assert.ok(b.run.left >= b.bar.left + 3 && b.run.right <= b.bar.right - 3 && b.run.top >= b.bar.top + 3 && b.run.bottom <= b.bar.bottom - 3, `the block inside the bar (${JSON.stringify([b.run, b.bar])})`);
            seen.add(Math.round(b.run.left));
            await page.waitForTimeout(90);
          }
          assert.ok(seen.size >= 3, `… and moving (${[...seen]})`);
          await ev(() => T.rtApply('switchSpace', 'work'));
          assert.deepEqual(rgba((await read()).fill), [127, 179, 255, 1], 'another space, its color');
          await ev(() => T.rtApply('switchSpace', 'personal'));
        },
        looks: [
          ['Dark Mode: the same look', { colorScheme: 'dark' }, async (_page, ev) => {
            assert.deepEqual(rgba((await ev(() => T.rtLoader()))!.background), [255, 253, 247, 1]);
            assert.deepEqual(rgba(await ev(() => T.rtComputed('.opening-label', 'color'))), [17, 17, 17, 1]);
          }],
        ],
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
