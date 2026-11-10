// Neubrutalism against its board ("Neubrutalism", Main.dc.html)
// and against Arcadia's parts, in real engines: Playwright's WebKit and
// Chromium, headless, every network request refused, through the runtime and
// the mock host. Folder heads without a count; each row's close button, the
// speaker on a row playing sound, the dashed outline on the tab shown while a
// new tab is on its way; loose pins in a card of their own; the palette's
// eight rows (then it scrolls, the selected row in view) with the board's
// tags and each row's icon, inside the window with 200 tabs; "keep the frame
// when hidden" off, the page edge to edge; nothing painted over the page's box
// (on screen); one look in light and dark system modes; and the first paint
// drawn around the box, not over it. `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, NEO } from './package.ts';
import { firstPaintCss, layoutOwnCss } from '../../extension/shared/page-box.ts';
import type { Harness, HarnessRt } from './harness.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;
declare const __rt: HarnessRt;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();
const pkg = themeForPage(NEO);
const FIRST_PAINT = firstPaintCss('neubrutalism', readFileSync(new URL('first-paint.css', `file://${NEO}`), 'utf8'));
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

      await t.test('Settings: toggles drawn as Neo switches, buttons on one line', async () => {
        await mount({ inNewTab: true });
        await ev(() => T.rtSetUi({ settingsOpen: true }));
        assert.equal(await computed('.settings-form input.toggle', 'appearance'), 'none');
        assert.equal(await computed('.settings-form input.toggle', 'border-top-style'), 'solid');
        assert.equal(await computed('.settings-form input.toggle', 'border-top-left-radius'), '999px');
        assert.equal(await computed('.settings-form .small', 'white-space'), 'nowrap');
        await ev(() => T.unmountRuntime());
      });

      await t.test('first paint: the card\'s border, shadow and ground around the box, nothing inside it', async () => {
        const fp = await context.newPage();
        await fp.setContent(`<!doctype html><html data-margin-at="neubrutalism"><head><meta charset="utf-8"><style>${FIRST_PAINT}\n${layoutOwnCss({ left: 291, top: 19, right: 19, bottom: 19, radius: 15 })}</style></head><body style="margin:0;background:${PAGE}"><p style="margin:0">a page</p></body></html>`);
        await fp.waitForTimeout(60);
        const shot = decodePng(await fp.screenshot());
        assert.equal(shot.at(700, 450), PAGE, 'the page inside its box');
        assert.equal(shot.at(292, 450), PAGE, 'right to its left edge');
        assert.equal(shot.at(700, 20), PAGE, 'and its top');
        assert.equal(shot.at(700, 17), INK, 'the border above');
        assert.equal(shot.at(289, 450), INK, 'and at its left');
        assert.equal(shot.at(1424, 450), INK, 'the hard shadow at its right');
        assert.equal(shot.at(100, 450), '#ffd23f', 'the ground where the sidebar will be');
        await fp.evaluate(() => document.documentElement.removeAttribute('data-margin-at'));
        await fp.waitForTimeout(60);
        assert.equal(decodePng(await fp.screenshot()).at(100, 450), PAGE, 'not marked for Neubrutalism: nothing');
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
