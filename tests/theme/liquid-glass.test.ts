// Liquid Glass in real engines: Playwright's WebKit and Chromium, headless, every network request refused, through
// the runtime and the mock host. Neither engine has the system's materials (Margin.app turns them on for its own web
// view, on macOS 26 and later), so what's checked here is the look every other browser gets, and that it stands on its
// own: translucent fills, hairlines and soft shadows, never a backdrop-filter; the panel 8 px in from the window's
// edges with the page card beside it at the same corner; the tab in front lit, other rows plain; the command bar,
// a menu, the editor, a notice and a prompt; the ground from the space's color, never over the page; light and dark;
// more contrast, less transparency, less motion; the arrow cursor, nothing selectable. Its behaviors (drag and drop,
// resizing, renaming, menus, swipes, the peek) run with the other themes' in behaviors.test.ts; the real glass is
// seen off screen in a WKWebView (tools/glass-shots/, DECISIONS.md "Liquid Glass"). `npm run test:theme`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage, GLASS } from './package.ts';
import { pageLoaderChecks } from './page-card.ts';
import type { Harness, HarnessRt } from './harness.ts';
import { settingsPageChecks } from './settings-page.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;

const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const script = harnessScript();
const pkg = themeForPage(GLASS);
const PAGE = [255, 0, 255];

// A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced), as [r, g, b].
function decodePng(buf: Buffer) {
  let at = 8, width = 0, height = 0, type = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; } else if (kind === 'IDAT') idat.push(data);
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
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return (x: number, y: number) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; };
}
// A computed color as [r, g, b, alpha]: rgb(), rgba() and color(srgb …), the forms Margin.app reads too
// (app/platforms/macos/shell/MarginWindow.swift HostCorners.color).
function rgba(css: string | null) {
  const s = (css ?? '').trim();
  const n = (inner: string) => inner.split(/[\s,/]+/).filter(Boolean).map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p)));
  let m = /^rgba?\((.*)\)$/.exec(s);
  if (m) { const v = n(m[1]); return [v[0], v[1], v[2], v[3] ?? 1]; }
  m = /^color\(srgb (.*)\)$/.exec(s);
  if (m) { const v = n(m[1]); return [Math.round(v[0] * 255), Math.round(v[1] * 255), Math.round(v[2] * 255), v[3] ?? 1]; }
  return [];
}
const near = (a: number[], b: number[], within = 3) => a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= within);

for (const [name, engine] of ENGINES) {
  test(`Liquid Glass's plain look in ${name}`, async (t) => {
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
      const rect = async (s: string, nth = 0) => (await ev(([x, n]) => T.rtRect(x, n), [s, nth] as const))!;
      // The last layout, once no more come (two frames with none new).
      const layout = async () => {
        await page.waitForFunction(() => T.rtLayouts().length > 0);
        const frames = () => ev(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(T.rtLayouts().length)))));
        for (let n = -1, i = 0; i < 40; i++) { const now = await frames(); if (now === n) break; n = now; }
        return (await ev(() => T.rtLayouts())).at(-1)!;
      };
      const mount = (o = {}) => ev((x) => T.mountRuntime({ width: 1440, height: 900, platform: { browser: 'safari', os: 'mac' }, ...x }), o);
      // Every element's computed value of a property, the distinct ones (the theme's root and all under it).
      const everywhere = (prop: string) => ev((p) => {
        const root = (window as typeof window & { __rt: HarnessRt }).__rt.target;
        return [...new Set([...root.querySelectorAll('*')].map((el) => getComputedStyle(el).getPropertyValue(p)))];
      }, prop);

      await t.test('loads with nothing removed, as a package and as a built-in theme, with no file of its own', async () => {
        const raw = await ev((p) => T.loadNeo(p), pkg);
        assert.equal(raw.ok, true);
        assert.deepEqual([raw.removed, raw.errors], [[], []], 'the sanitizer removes nothing');
        const r = await ev((p) => T.loadBuiltin(p, 'liquid-glass', []), pkg);
        assert.deepEqual([r.ok, r.id, r.fontErrors, r.read], [true, 'liquid-glass', [], ['theme.json', 'theme.html', 'theme.css']]);
      });

      await t.test('the panel floats 8 px in from the window\'s edges, the page card beside it with the same corner', async () => {
        const at = (o: Record<string, unknown>) => ({ width: 1440, height: 900, windowId: 1, mode: 'fullscreen', ...o });
        await mount();
        assert.deepEqual(await layout(), at({ left: 281, top: 9, right: 9, bottom: 9, radius: 23 }), '8 + 264 + 8, inside the 1 px hairline');
        const panel = await rect('.panel');
        assert.deepEqual([panel.left, panel.top, panel.width, panel.height], [8, 8, 264, 884]);
        assert.equal(await computed('.panel', 'border-top-left-radius'), '24px');
        assert.equal(await computed('.page', 'border-top-left-radius'), '24px', 'the same corner');
        // Concentric: the rows' corner is the panel's less its padding; capsules are round.
        assert.equal(await computed('.column', 'padding-left'), '10px');
        assert.equal(await computed('.today .tab', 'border-top-left-radius'), '14px');
        for (const capsule of ['.address', '.nav', '.spaces']) assert.equal(await computed(capsule, 'border-top-left-radius'), '999px', capsule);
        assert.equal(await count('[m-action], [m-arg], m-for, m-if, m-else'), 0, 'no template syntax left');
        // The resize handle beside the panel, not in it (nothing of a glass element may reach past its box).
        const handle = await rect('.resizer');
        assert.ok(handle.left >= panel.right && handle.right <= 281, `in the gap (${handle.left}–${handle.right})`);
        assert.equal(await ev(() => T.rtClosest('.resizer', '.panel')), false);
      });

      await t.test('the plain look: translucent fills, hairlines and soft shadows; no material here, and no backdrop-filter anywhere', async () => {
        await mount();
        assert.equal(await ev(() => CSS.supports('-apple-visual-effect', '-apple-system-glass-material')), false, 'not in this engine');
        assert.deepEqual(await everywhere('-apple-visual-effect'), [''], 'the property isn\'t known, so nothing has it');
        for (const prop of ['backdrop-filter', '-webkit-backdrop-filter', 'filter']) assert.deepEqual((await everywhere(prop)).filter((v) => v && v !== 'none'), [], prop);
        // The panel: see-through (the ground's lights show), a hairline and a soft shadow.
        const fill = rgba(await computed('.panel', 'background-color'));
        assert.ok(fill[3] > 0.3 && fill[3] < 0.8, `the panel's fill is translucent (${fill})`);
        assert.match((await computed('.panel', 'box-shadow'))!, /inset/, 'a hairline');
        assert.match((await computed('.panel', 'box-shadow'))!, /7px/, 'a soft shadow, short of the page');
        // The capsules in it, lighter still; the address is one of them.
        for (const capsule of ['.address', '.nav', '.spaces']) assert.ok(rgba(await computed(capsule, 'background-color'))[3] > 0.3, capsule);
        // Rows: plain text on the panel, but the tab in front, lit.
        await ev(() => T.rtBox('.tab.on'));
        assert.equal(await count('.tab.on'), 1);
        assert.ok(rgba(await computed('.tab.on', 'background-color'))[3] > 0.8, 'the tab in front is lit');
        assert.notEqual(await computed('.tab.on', 'box-shadow'), 'none');
        assert.equal(rgba(await computed('.today .tab:not(.on)', 'background-color'))[3], 0, 'other rows have no fill');
        await ev(() => T.rtBox('.today .tab:not(.on)'));
        const row = await rect('.today .tab:not(.on)');
        await page.mouse.move(row.x, row.y);
        await page.waitForFunction(() => /0\.0[4-9]|0\.1/.test(T.rtComputed('.today .tab:not(.on):hover', 'background-color') ?? ''));
        assert.equal(await ev(() => T.rtVisible('.today .tab:hover .close')), true, 'its close button under the pointer');
        await page.mouse.move(700, 450);
      });

      await t.test('as a native app\'s: the arrow over buttons and rows, labels not selected, fields still typed in', async () => {
        await mount({ container: 'document' }); // (in the document: its selection is the window's)
        await ev(() => T.rtDispatch('palette.open'));
        for (const s of ['.lg', '.today .tab', '.address', '.chip', '.folder-head', '.new-tab', '.palette-row', '.round']) assert.equal(await computed(s, 'cursor'), 'default', s);
        assert.equal(await computed('.resizer', 'cursor'), 'col-resize');
        assert.equal(await computed('.palette-input', 'cursor'), 'text');
        for (const s of ['.lg', '.today .tab', '.address', '.palette-row']) assert.equal(await ev((x) => T.rtComputed(x, 'user-select') || T.rtComputed(x, '-webkit-user-select'), s), 'none', s);
        assert.equal(await ev(() => T.rtComputed('.palette-input', 'user-select') || T.rtComputed('.palette-input', '-webkit-user-select')), 'text');
        assert.equal(await computed('.lg', 'overscroll-behavior-y'), 'none', 'the window doesn\'t bounce');
        assert.equal(await computed('.tabs', 'overscroll-behavior-y'), 'contain', 'the list does, alone');
        assert.match((await computed('.lg', 'font-family'))!, /^-apple-system|system-ui/);
        await page.keyboard.press('Escape');
        // A label dragged over selects nothing.
        const title = await rect('.space-name');
        await page.mouse.move(title.left + 2, title.y);
        await page.mouse.down();
        await page.mouse.move(title.right - 2, title.y, { steps: 3 });
        await page.mouse.up();
        assert.equal(await ev(() => String(getSelection() ?? '')), '');
      });

      await t.test('the command bar: a large panel in the middle, eight rows then it scrolls, the selected row kept in view', async () => {
        for (const height of [900, 600]) {
          await mount({ height });
          await ev(() => T.rtDispatch('palette.open'));
          assert.ok(await count('.palette-row') > 8);
          await page.waitForTimeout(220); // (it drops in)
          const box = await rect('.palette');
          assert.ok(box.top >= 0 && box.bottom <= height, `${height}: the box stays in the window (${box.top}–${box.bottom})`);
          assert.ok(Math.abs(box.x - 720) <= 1 && box.width === 680, `${height}: centred, 680 wide (${box.left}–${box.right})`);
          const list = await rect('.palette-rows');
          assert.ok(list.height <= 8 * 40 + 7 * 2 + 12, `${height}: eight rows at most (${list.height} px)`);
        }
        assert.equal(await computed('.palette', 'border-top-left-radius'), '24px');
        assert.equal(await computed('.palette-row', 'border-top-left-radius'), '16px', 'concentric: 24 less its 8 px padding');
        assert.equal(await ev(() => T.rtActive()), 'palette');
        assert.ok(rgba(await computed('.palette', 'background-color'))[3] >= 0.9, 'nearly solid with no glass: what\'s under it doesn\'t read through');
        for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
        const vm = (await ev(() => T.rtVmFull()))!;
        assert.equal(vm.selected, vm.rowIds[11]);
        const list = await rect('.palette-rows');
        const on = await rect('.palette-row.on');
        assert.ok(on.top >= list.top - 1 && on.bottom <= list.bottom + 1, 'the selected row scrolled into view');
        // Each row: an icon, its title, where it is (a capsule with that space's color as a dot).
        const n = await count('.palette-row');
        assert.equal(await count('.palette-row .fav'), n);
        assert.equal(await count('.palette-row .tag'), n);
        assert.deepEqual(rgba(await ev(() => getComputedStyle((window as typeof window & { __rt: HarnessRt }).__rt.target.querySelector('.palette-row .tag')!, '::before').backgroundColor)).slice(0, 3), [255, 210, 63], 'Personal\'s color');
        await page.keyboard.type('nimbus');
        assert.ok((await ev(() => T.rtVmFull()))!.rows.slice(0, 2).every((r) => /nimbus/i.test(r)));
        await page.keyboard.press('Enter');
        assert.equal(await count('.palette'), 0);
        assert.equal((await ev(() => T.rtSent())).at(-1)![0], 'activateTab');
      });

      await t.test('a menu, the space editor, a notice and a prompt: panels of their own, and the page keeps its box', async () => {
        await mount();
        const before = await layout();
        await ev(() => T.rtBox('.today .tab', 1));
        const row = await rect('.today .tab', 1);
        await page.mouse.click(row.x, row.y, { button: 'right' });
        await page.waitForFunction(() => T.rtCount('.menu-item') > 0);
        assert.equal(await computed('.menu', 'border-top-left-radius'), '14px');
        assert.equal(await computed('.menu-item', 'height'), '26px');
        const item = await rect('.menu-item');
        await page.mouse.move(item.x, item.y);
        await page.waitForFunction(() => T.rtComputed('.menu-item:hover', 'color') === 'rgb(255, 255, 255)');
        await page.keyboard.press('Escape');
        assert.equal(await count('.menu-item'), 0);
        await ev(() => T.rtSetUi({ notice: { id: 'n', text: 'That tab is no longer open.', actions: [{ id: 'go', label: 'OK', primary: true }] } }));
        assert.equal(await count('.notice'), 1);
        const notice = await rect('.notice');
        const panel = await rect('.panel');
        assert.ok(notice.left >= panel.left && notice.right <= panel.right && notice.bottom <= panel.bottom, 'over the panel\'s foot: seen whatever the page area shows');
        assert.ok(notice.width >= 160 && (await rect('.notice .text')).height < 40, 'on a line or two');
        assert.deepEqual(await layout(), before, 'a notice');
        await ev(() => T.rtSetUi({ notice: null, prompt: { id: 'app', title: 'Install Margin.app', text: 'Margin needs its app.', actions: [{ id: 'ok', label: 'Install', primary: true }] } }));
        assert.equal(await count('.prompt'), 1);
        assert.notEqual(await computed('.prompt .pill.primary', 'background-color'), await computed('.lg', 'background-color'), 'its main button in the accent');
        assert.deepEqual(await layout(), before, 'a prompt');
        await ev(() => T.rtDispatch('prompt.close'));
        await ev(() => T.rtDispatch('space.edit', 'personal'));
        assert.equal(await count('.editor'), 1);
        assert.ok(await count('.editor .swatch') > 3 && await count('.editor .pill.primary') === 1);
        assert.deepEqual(await layout(), before, 'the editor');
        await ev(() => T.rtDispatch('editor.cancel'));
      });

      await t.test('the page\'s box: docked, hidden with the frame, and edge to edge with "keep the frame" off; the loading light', async () => {
        const at = (o: Record<string, unknown>) => ({ width: 1440, height: 900, windowId: 1, mode: 'fullscreen', ...o });
        await mount({ settings: { sidebarPinnedOpen: false } });
        assert.deepEqual(await layout(), at({ left: 9, top: 9, right: 9, bottom: 9, radius: 23 }), 'hidden, with the frame');
        await ev(() => T.rtSetUi({ sidebar: 'peek' }));
        await page.waitForTimeout(320);
        assert.equal((await ev(() => T.rtLayouts())).at(-1)!.left, 9, 'peek moves nothing');
        const side = await rect('.sidebar');
        assert.deepEqual([side.left, side.top, side.width], [8, 8, 264], 'the peeking panel floats in from the edge');
        assert.ok(rgba(await computed('.panel', 'background-color'))[3] >= 0.9, 'out over the page: nearly solid');
        await mount({ settings: { sidebarPinnedOpen: false, frameWhenHidden: false } });
        assert.deepEqual(await layout(), at({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 }), 'no frame: the whole window, square');
        await ev(() => T.rtLoading(true));
        const bar = await rect('.load-bar');
        assert.deepEqual([bar.top, bar.left, bar.right], [0, 0, 1440], 'loading with no frame: along the page\'s top edge');
        await ev(() => T.rtLoading(false));
        await mount();
        assert.equal(await ev(() => T.rtVisible('.load-bar')), false);
        await ev(() => T.rtLoading(true));
        await page.waitForFunction(() => T.rtComputed('.load-bar', 'opacity') === '1');
        const docked = await rect('.load-bar');
        assert.ok(docked.top >= 0 && docked.bottom <= 8 && docked.left > 281, `in the gutter above the page (${docked.top}–${docked.bottom})`);
        assert.equal(await ev(() => T.rtClasses('.reload')!.includes('loading')), true, 'and the reload button turns');
        await ev(() => T.rtLoading(false));
      });

      await t.test('the ground is the space\'s color, read by Margin.app for the card\'s corners, and never over the page (on screen)', async () => {
        const grounds: number[][] = [];
        for (const space of ['personal', 'work']) {
          await mount({ container: 'document' });
          if (space !== 'personal') await ev((s) => T.rtApply('switchSpace', s), space);
          const l = await layout();
          const corner = (await ev(() => T.rtCornerFill()))!;
          const fills = corner.fills.map((c) => rgba(c));
          assert.ok(fills.length === 4 && fills.every((c) => c.length === 4 && c[3] === 1), `${space}: four solid colors Margin.app can read (${JSON.stringify(corner.fills)})`);
          assert.ok(fills.every((c) => near(c, fills[0], 0)), 'the same at every corner: the ground is flat around the page');
          assert.ok(corner.edge && corner.edge.width === 1 && rgba(corner.edge.color)[3] === 1, `the hairline, solid (${JSON.stringify(corner.edge)})`);
          grounds.push(fills[0]);
          await ev(() => { document.documentElement.style.background = '#ff00ff'; document.body.style.background = '#ff00ff'; });
          await page.mouse.move(700, 450);
          await page.waitForTimeout(80);
          const shot = decodePng(await page.screenshot());
          const bad = [];
          const r = l.radius + 1; // the rounded corners: the page is cut there
          for (let y = l.top; y < 900 - l.bottom; y += 7) {
            for (let x = l.left; x < 1440 - l.right; x += 7) {
              const inCorner = (x < l.left + r || x >= 1440 - l.right - r) && (y < l.top + r || y >= 900 - l.bottom - r);
              if (!inCorner && !near(shot(x, y), PAGE, 0)) bad.push([x, y, shot(x, y)]);
            }
          }
          assert.deepEqual(bad.slice(0, 5), [], `${space}: the page shows through everywhere in its box`);
          // Around the card, and in each corner's square outside the curve: the color Margin.app is told.
          for (const [x, y] of [[l.left + 300, 3], [1440 - 4, 400], [l.left + 300, 900 - 4], [l.left + 1, l.top + 1], [1440 - l.right - 2, l.top + 1], [1440 - l.right - 2, 900 - l.bottom - 2], [l.left + 1, 900 - l.bottom - 2]]) {
            assert.ok(near(shot(x, y), fills[0], 2), `${space}: the ground at ${x},${y} is ${shot(x, y)}, told ${fills[0]}`);
          }
          // Behind the panel the ground has its lights: not the flat color there.
          assert.ok(!near(shot(3, 3), fills[0], 6), `${space}: lit at the panel's corner (${shot(3, 3)} against ${fills[0]})`);
          await ev(() => { document.documentElement.style.background = ''; document.body.style.background = ''; });
        }
        assert.ok(!near(grounds[0], grounds[1], 3), `another space, another ground (${grounds})`);
      });

      await t.test('light and dark from the system; more contrast and less transparency make the fills solid; less motion stills it', async () => {
        const look = async (media: Parameters<typeof page.emulateMedia>[0]) => {
          await page.emulateMedia({ colorScheme: null, contrast: null, reducedMotion: null, ...media });
          await mount();
          await ev(() => T.rtLoading(true));
          return { label: rgba(await computed('.lg', 'color')), panel: rgba(await computed('.panel', 'background-color')), scheme: await computed('.lg', 'color-scheme'),
            run: await ev(() => getComputedStyle((window as typeof window & { __rt: HarnessRt }).__rt.target.querySelector('.load-bar')!, '::before').animationName),
            spin: await computed('.reload .ico', 'animation-name') };
        };
        const light = await look({ colorScheme: 'light' });
        const dark = await look({ colorScheme: 'dark' });
        assert.equal(light.scheme, 'light dark', 'Margin\'s inputs and scroll bars follow the system too');
        assert.ok(light.label[0] < 40 && dark.label[0] > 215, `dark text in light, light in dark (${light.label} / ${dark.label})`);
        assert.ok(light.panel[0] > 200 && dark.panel[0] < 80, 'and the panel\'s fill');
        assert.deepEqual([light.run, light.spin], ['lg-run', 'lg-spin'], 'loading: the light runs, the reload button turns');
        const contrast = await look({ colorScheme: 'light', contrast: 'more' });
        assert.ok(contrast.panel[3] >= 0.95 && contrast.label.slice(0, 3).join() === '0,0,0', `more contrast: ${JSON.stringify(contrast)}`);
        const still = await look({ colorScheme: 'light', reducedMotion: 'reduce' });
        assert.deepEqual([still.run, still.spin], ['none', 'none'], 'less motion: nothing loops');
        if (await ev(() => matchMedia('(prefers-reduced-transparency: reduce)').media !== 'not all')) {
          // (Chromium has the query, emulated through its DevTools; WebKit doesn't have it yet.)
          if (name === 'chromium') {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
            await mount();
            assert.equal(rgba(await computed('.panel', 'background-color'))[3], 1, 'less transparency: solid');
            await cdp.send('Emulation.setEmulatedMedia', { features: [] });
          }
        }
        await page.emulateMedia({ colorScheme: null, contrast: null, reducedMotion: null });
      });

      await t.test('Margin.app\'s own window with nothing hosted: its page area the launcher, solid; its Settings tab with the theme\'s own settings', async () => {
        await ev(() => T.mountRuntime({ width: 1280, height: 800, mode: 'windowed', appWindow: true }));
        const e = await ev(() => T.rtEmptyPage());
        assert.ok(e.page && e.launcher, 'a launcher drawn in the page card');
        const [px, py, pw, ph] = e.page!, [lx, ly, lw, lh] = e.launcher!;
        assert.ok(Math.abs(px + pw / 2 - (lx + lw / 2)) <= 1 && Math.abs(py + ph / 2 - (ly + lh / 2)) <= 1 && lw >= pw - 8 && lh >= ph - 8, `the page's box covered: ${e.page} ${e.launcher}`);
        assert.match(e.background!, /^rgb\(/, `solid, a plain color Margin.app's checks read: ${e.background}`);
        // Windowed: room for the window's buttons and a place to drag it by.
        const controls = await rect('.window-controls');
        assert.deepEqual([controls.width, controls.height], [60, 14]);
        assert.ok((await rect('.drag-region')).width > 100);
        assert.ok(await count('.launcher .tile') > 0 && await count('.launcher .archive-row') > 0);
        assert.equal(await count('.launcher [aria-expanded]'), 0, 'no Settings under the search field: its own tab');
        // Its Settings tab (margin://settings): the theme's own settings under its name in Appearance, its switches in Browsing.
        await ev(() => T.rtSetUi({ settingsPage: true }));
        assert.ok(await count('.settings-form select') > 0);
        assert.ok((await ev(() => T.rtText('.setting-group'))).some((g) => /Liquid Glass/.test(g)), 'its own settings under its name');
        await ev(() => T.rtSetUi({ settingsCategory: 'browsing' }));
        assert.ok(await count('.settings-form input.toggle') > 0);
        assert.equal(await computed('.settings-form input.toggle', 'appearance'), 'none', 'the switch drawn by the theme');
        await ev(() => T.unmountRuntime());
      });

      await t.test('dedicated Settings: its own page, as System Settings (the categories beside the chosen one\'s settings); never under the search field in Margin.app\'s window', async () => {
        await settingsPageChecks(page);
      });

      // Liquid Glass's own page loader (Margin.app, while an item opens): the card as the ground, lit in the space's
      // color, and on it one capsule with a small spinner and Margin's words. Plain here (a translucent fill, a
      // hairline, a soft shadow); the system's glass where it's known (tools/glass-shots, tests/theme-liquid-glass).
      await pageLoaderChecks(t, browser, {
        id: 'liquid-glass', dir: GLASS, script,
        label: '.opening-label', mark: '.opening-spin',
        animations: ['lg-spin'],
        icon: { size: 24 },
        skeleton: [['.space-name', ''], ['.today', '::before'], ['.chips', '::before']],
        starting: ['lg-spin', 'lg-wait'],
        look: async (_page, ev) => {
          const read = () => ev(() => ({ card: T.rtLoader()!.background, lights: T.rtComputed('m-page-loader', 'background-image'), capsules: T.rtCount('m-page-loader .opening'), capsule: T.rtRect('.opening')!, spin: T.rtRect('.opening-spin')!, label: T.rtRect('.opening-label')!, slot: T.rtRect('m-page-loader')!,
            fill: T.rtComputed('.opening', 'background-color'), shadow: T.rtComputed('.opening', 'box-shadow'), radius: T.rtComputed('.opening', 'border-top-left-radius'), effect: T.rtComputed('.opening', '-apple-visual-effect'),
            size: T.rtComputed('.opening-label', 'font-size'), color: T.rtComputed('.opening', 'color'), ring: [T.rtComputed('.opening-spin', 'width'), T.rtComputed('.opening-spin', 'height')] }));
          const a = await read();
          assert.deepEqual(rgba(a.card), [246, 247, 249, 1], 'a solid ground under the lights');
          assert.equal((a.lights ?? '').split('radial-gradient').length - 1, 3, 'three soft lights');
          assert.equal(a.capsules, 1, 'one capsule (one glass layer, while an item opens only)');
          assert.deepEqual([a.capsule.height, a.radius], [44, '22px'], 'a capsule');
          assert.ok(Math.abs(a.capsule.x - a.slot.x) <= 1 && Math.abs(a.capsule.y - a.slot.y) <= 1, 'in the card\'s middle');
          assert.ok(a.spin.left >= a.capsule.left && a.label.right <= a.capsule.right && a.spin.right <= a.label.left && a.spin.top >= a.capsule.top && a.spin.bottom <= a.capsule.bottom, 'the spinner and the words in it, side by side (nothing past its box)');
          assert.deepEqual([...a.ring, a.size], ['16px', '16px', '13px'], 'a small spinner, 13 px words');
          const fill = rgba(a.fill);
          assert.ok(fill[3] > 0.4 && fill[3] < 0.9, `plain here: a translucent fill (${a.fill})`);
          assert.match(a.shadow ?? '', /inset/, 'a hairline');
          assert.equal(a.effect, '', 'no material in this engine');
          assert.ok(rgba(a.color)[0] < 40, 'dark words on the light ground');
          // The lights are the space's color: another space, other lights.
          await ev(() => T.rtApply('switchSpace', 'work'));
          assert.notEqual((await read()).lights, a.lights, 'another space, its lights');
          await ev(() => T.rtApply('switchSpace', 'personal'));
        },
        looks: [
          ['Dark Mode', { colorScheme: 'dark' }, async (_page, ev) => {
            const d = await ev(() => ({ card: T.rtLoader()!.background, color: T.rtComputed('.opening', 'color'), fill: T.rtComputed('.opening', 'background-color') }));
            assert.deepEqual(rgba(d.card), [20, 21, 24, 1], 'a dark ground');
            assert.ok(rgba(d.color)[0] > 215 && rgba(d.fill)[3] < 0.3, `light words in a faint capsule (${d.color}, ${d.fill})`);
          }],
          ['more contrast', { contrast: 'more' }, async (_page, ev) => {
            const c = await ev(() => ({ card: T.rtLoader()!.background, lights: T.rtComputed('m-page-loader', 'background-image'), fill: T.rtComputed('.opening', 'background-color'), color: T.rtComputed('.opening', 'color'), edge: T.rtComputed('.opening', 'box-shadow') }));
            assert.deepEqual([rgba(c.card), c.lights, rgba(c.fill), rgba(c.color)], [[255, 255, 255, 1], 'none', [255, 255, 255, 1], [0, 0, 0, 1]], 'a flat white ground, a solid capsule, black words');
            assert.match(c.edge ?? '', /inset/, 'a line around it');
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
