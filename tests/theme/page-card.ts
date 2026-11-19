// The page card in Margin.app's own window, for the theme tests (page-state.test.ts and each built-in theme's own
// file): a screenshot's pixels, the points of the page's place read in it, and what every built-in theme's own loader
// (its `page-loader` part in its `<m-page-loader>`) and start-up skeleton (the root's `m-starting`) must do, in a real
// engine with every request refused (extension/themes/README.md "The page card's state"):
// - `loading`: the card exactly over the page's place with its corners, opaque edge to edge (the screenshot's alpha:
//   what a hosted window would show through), drawn at once, the pointer Margin's, the arrow over it, nothing
//   selectable, Margin's words in it and no others; what moves changes `transform` and `opacity` only;
// - `shown`: the part gone at once, the card in at most 150 ms, then nothing painted in the page's place and no
//   animation of the loader's left running; `loading` again: opaque again at once; `empty`: the launcher, the same;
// - reduced motion: nothing moves, the mark still drawn, the card goes at once;
// - `m-starting`: the same card with no words (the slot's own boxes), the sidebar's skeleton on what's already
//   there, a handful of soft pulses at most; all gone a frame after the data is drawn. Never over a hosted window
//   that's shown, never outside Margin.app.
import assert from 'node:assert/strict';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { TestContext } from 'node:test';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { themeForPage } from './package.ts';
import type { Harness } from './harness.ts';

declare const T: Harness;

/** A screenshot's pixels (Playwright's PNGs: 8-bit RGB or RGBA, not interlaced), as [r, g, b, a]. */
export function decodePng(buf: Buffer) {
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
  return (x: number, y: number) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2], bpp === 4 ? out[i + 3] : 255]; };
}
export type Pixels = ReturnType<typeof decodePng>;

/** A PNG (8-bit RGBA) of `size` × `size` pixels, `color(x, y)` each, as Margin.app's icons are sent: a data URL. */
export function iconPng(size: number, color: (x: number, y: number) => [number, number, number, number]) {
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(color(x, y), y * (size * 4 + 1) + 1 + x * 4);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
// Two apps' icons, 64 px as AppCatalog makes them: a rounded square in a colour (Notes' yellow, Safari's blue), a
// checkerboard inside it (what a blurred scaling would smear).
const appIcon = (r: number, g: number, b: number) => iconPng(64, (x, y) => {
  const inside = Math.hypot(Math.max(0, Math.abs(x - 31.5) - 18), Math.max(0, Math.abs(y - 31.5) - 18)) <= 12;
  if (!inside) return [0, 0, 0, 0];
  return (x >> 2) % 2 === (y >> 2) % 2 ? [r, g, b, 255] : [255, 255, 255, 255];
});
export const ICONS = { notes: appIcon(250, 200, 40), safari: appIcon(20, 120, 240) };
export const APPS = [
  { bundleId: 'com.apple.Notes', name: 'Notes', icon: ICONS.notes },
  { bundleId: 'com.apple.Safari', name: 'Safari', icon: ICONS.safari },
  { bundleId: 'com.example.NoIcon', name: 'No Icon', icon: null },
];
export const px = (at: Pixels, [x, y]: [number, number]) => at(Math.floor(x), Math.floor(y));

export const W = 1440, H = 900;
export type Box = { left: number, top: number, right: number, bottom: number };

/**
 * Points of the page's place: a grid across it, just inside each edge, and just inside each rounded corner's curve
 * (`inside`); `onDiagonal(i, d)`: a point on corner i's diagonal, `d` from the curve's centre, outward.
 */
export function cardPoints(box: Box, radii: number[]) {
  const inside: [number, number][] = [];
  for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) inside.push([box.left + ((box.right - box.left) * i) / 8, box.top + ((box.bottom - box.top) * j) / 8]);
  for (const f of [0.2, 0.5, 0.8]) {
    const x = box.left + (box.right - box.left) * f, y = box.top + (box.bottom - box.top) * f;
    inside.push([x, box.top + 1.5], [x, box.bottom - 2.5], [box.left + 1.5, y], [box.right - 2.5, y]);
  }
  const corners = [[box.left, box.top, 1, 1], [box.right, box.top, -1, 1], [box.right, box.bottom, -1, -1], [box.left, box.bottom, 1, -1]];
  const onDiagonal = (i: number, d: number): [number, number] => {
    const [x, y, dx, dy] = corners[i];
    const off = (radii[i] ?? 0) - d / Math.SQRT2;
    return [x + dx * off, y + dy * off];
  };
  for (let i = 0; i < 4; i++) if ((radii[i] ?? 0) >= 3) inside.push(onDiagonal(i, radii[i] - 2));
  return { inside, onDiagonal };
}

/** A computed color as [r, g, b, alpha]: rgb(), rgba() and color(srgb …). */
export function rgba(css: string | null | undefined) {
  const s = (css ?? '').trim();
  const n = (inner: string) => inner.split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v)));
  let m = /^rgba?\((.*)\)$/.exec(s);
  if (m) { const v = n(m[1]); return [v[0], v[1], v[2], v[3] ?? 1]; }
  m = /^color\(srgb (.*)\)$/.exec(s);
  if (m) { const v = n(m[1]); return [Math.round(v[0] * 255), Math.round(v[1] * 255), Math.round(v[2] * 255), v[3] ?? 1]; }
  return [];
}
export const near = (a: number[], b: number[], within = 3) => a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= within);

const BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>';
/** What may move: the compositor's own properties. */
const COMPOSITED = new Set(['transform', 'opacity', 'rotate', 'scale', 'translate']);

export type Ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => Promise<R>;
export type LoaderLook = {
  /** The theme: its id, its folder, the harness's script. */
  id: string, dir: string, script: string,
  /** The element with Margin's words, and what moves (drawn, and still there with reduced motion). */
  label: string, mark: string,
  /** The loader's own animations while an item opens, by name. */
  animations: string[],
  /** What the sidebar draws while starting: an element's own box (`::before`, `::after`), or the element itself (''). */
  skeleton: [selector: string, pseudo: '' | '::before' | '::after'][],
  /** The animations allowed while starting, by name: the card's mark and the skeleton's pulse. */
  starting: string[],
  /** The opening app's icon in the loader: its size (CSS px: the 64 px icon sharp at 2x up to 32), its scaling. */
  icon: { size: number, rendering?: string },
  /** The theme's own look, checked while its loader is drawn (`loading`, "Opening Safari…"). */
  look?: (page: Page, ev: Ev) => Promise<void>,
  /** The same in other system looks (dark, more contrast): each in a context of its own. */
  looks?: [name: string, options: BrowserContextOptions, check: (page: Page, ev: Ev) => Promise<void>][],
};

/** A page with the theme loaded, at the tests' window size. */
async function open(browser: Browser, o: LoaderLook, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, ...options });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.route('**/*', (route) => route.abort());
  await page.setContent(BLANK);
  await page.addScriptTag({ content: o.script });
  const ev: Ev = (fn, arg) => page.evaluate(fn as (arg: unknown) => any, arg);
  const loaded = await ev(([p, i]) => T.loadBuiltin(p, i, []), [themeForPage(o.dir), o.id] as const);
  assert.equal(loaded.ok, true, `${o.id} loads`);
  const frames = () => ev(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  // Margin.app's own window hosting a window in its page area: the page card `shown`.
  const hosted = async () => {
    await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, hosted: true }));
    await page.waitForFunction(() => T.rtLayouts().length > 0);
    await frames();
    await page.waitForTimeout(350); // (the theme's own transitions, as it settles)
    await page.mouse.move(40, 450); // (over the sidebar: none of the theme's hovers over the page's place)
  };
  // The page's place, as the host was last told it.
  const place = async () => {
    await page.waitForFunction(() => T.rtLayouts().length > 0);
    const l = (await ev(() => T.rtLayouts())).at(-1)!;
    const radii = (await ev(() => T.rtRadii())) ?? [];
    return { box: { left: l.left, top: l.top, right: W - l.right, bottom: H - l.bottom }, radii };
  };
  const shot = async () => decodePng(await page.screenshot({ omitBackground: true }));
  return { context, page, ev, frames, hosted, place, shot, errors };
}

/** The loader's box over the page's place, within half a pixel. */
function over(lo: { left: number, top: number, width: number, height: number }, box: Box) {
  return Math.abs(lo.left - box.left) <= 0.5 && Math.abs(lo.top - box.top) <= 0.5 && Math.abs(lo.width - (box.right - box.left)) <= 0.5 && Math.abs(lo.height - (box.bottom - box.top)) <= 0.5;
}

/** A built-in theme's own page loader and start-up skeleton: three steps of the theme's test. */
export async function pageLoaderChecks(t: TestContext, browser: Browser, o: LoaderLook) {
  await t.test('the page card while an item opens: the theme\'s own loader, opaque over the page\'s place with Margin\'s words; gone as it\'s shown, nothing left painted or running', async () => {
    const { context, page, ev, hosted, place, shot, errors } = await open(browser, o);
    await hosted();
    const { box, radii } = await place();
    const { inside } = cardPoints(box, radii);
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;

    // ---- shown: its slot there, empty, drawing nothing ----
    const first = await ev(() => T.rtPageState('shown'));
    assert.deepEqual([first.attr, first.loader], ['shown', { own: true, text: '' }], 'shown: the theme\'s slot, empty; no default loader of Margin\'s');
    const rest = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([rest.visibility, rest.opacity, rest.pointer], ['hidden', 0, 'none'], 'shown: the card hidden, the pointer let through');
    let at = await shot();
    assert.deepEqual(inside.filter((p) => px(at, p)[3] !== 0), [], `shown: nothing painted in the page's place (alpha 0 at ${inside.length} points)`);
    // (What the theme animates anyway, by name: Pixel's cursors. Not its transitions: a hover's may be under way.)
    const looping = (list: Awaited<ReturnType<Harness['rtAnimations']>>) => list.filter((a) => a.running && !a.name.startsWith('transition:')).map((a) => a.name).sort();
    const ambient = looping(await ev(() => T.rtAnimations()));
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((a) => a.loader), [], 'shown: no animation of the loader\'s');

    // ---- loading: the card, at once ----
    const loading = await ev(() => T.rtPageState('loading', 'Safari'));
    assert.equal(loading.attr, 'loading');
    assert.equal(loading.loader?.own, true, 'loading: the theme\'s own part');
    assert.equal(loading.loader?.text.trim(), 'Opening Safari…', 'loading: Margin\'s words, and no others in the card');
    assert.deepEqual(await ev((s) => T.rtText(s), o.label), ['Opening Safari…'], 'the label says them');
    assert.equal(await ev(() => (window as any).__rt.runtime.view.rootElement().querySelectorAll('m-page-loader').length), 1, 'one loader: no default beside the theme\'s');
    const lo = (await ev(() => T.rtLoader()))!;
    assert.ok(over(lo, box), `loading: the card over the page's place exactly (${JSON.stringify(lo)} vs ${JSON.stringify(box)})`);
    assert.deepEqual([lo.opacity, lo.visibility, lo.pointer, parseFloat(lo.radius), parseFloat(lo.transition)], [1, 'visible', 'auto', radii[0] ?? 0, 0], 'loading: drawn at once (no fade in), taking the pointer, the card\'s corners');
    at = await shot();
    assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], 'loading: the page card opaque edge to edge (whatever opens behind it isn\'t seen)');
    const top = await ev(([x, y]) => { const el = document.elementFromPoint(x, y)!; const cs = getComputedStyle(el); return { loader: !!el.closest('m-page-loader'), cursor: cs.cursor, select: [cs.getPropertyValue('user-select'), cs.getPropertyValue('-webkit-user-select')].includes('none') ? 'none' : 'selectable' }; }, [cx, cy] as const);
    assert.deepEqual(top, { loader: true, cursor: 'default', select: 'none' }, 'loading: the loader takes the pointer over the page\'s place, with the arrow; nothing selectable');
    assert.equal(await ev((s) => T.rtShown(s), o.mark), true, 'the mark drawn');
    // What moves: the loader's own animations, on transform and opacity only.
    const moving = (await ev(() => T.rtAnimations())).filter((a) => a.loader);
    assert.deepEqual([...new Set(moving.map((a) => a.name))].sort(), [...o.animations].sort(), 'loading: the loader\'s animations');
    assert.deepEqual(moving.filter((a) => !a.running || a.props.some((p) => !COMPOSITED.has(p))), [], 'each running, on transform and opacity only');
    const filters = await ev(() => [...(window as any).__rt.runtime.view.rootElement().querySelectorAll('m-page-loader, m-page-loader *')].map((el) => { const cs = getComputedStyle(el as Element); return [cs.backdropFilter ?? (cs as any).webkitBackdropFilter ?? 'none', cs.filter]; }).filter(([b, f]) => (b && b !== 'none') || (f && f !== 'none')));
    assert.deepEqual(filters, [], 'no backdrop-filter, no filter anywhere in it');
    await o.look?.(page, ev);
    const renamed = await ev(() => T.rtPageState('loading', 'Notes'));
    assert.equal(renamed.loader?.text.trim(), 'Opening Notes…', 'another item opening: its name');

    // ---- shown: the part gone at once, the card within 150 ms, then the hole ----
    const shown = await ev(() => T.rtPageState('shown'));
    assert.deepEqual(shown.loader, { own: true, text: '' }, 'shown: the part taken out at once');
    const fading = (await ev(() => T.rtLoader()))!;
    assert.ok(fading.pointer === 'none' && parseFloat(fading.transition) > 0 && parseFloat(fading.transition) <= 0.15, `shown: the pointer let through at once, the card fading in at most 150 ms (${fading.transition})`);
    await page.waitForTimeout(260);
    const gone = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([gone.opacity, gone.visibility], [0, 'hidden'], '… and gone');
    at = await shot();
    assert.deepEqual(inside.filter((p) => px(at, p)[3] !== 0), [], 'shown again: nothing painted in the page\'s place');
    const after = await ev(() => T.rtAnimations());
    assert.deepEqual(after.filter((a) => a.loader), [], 'shown again: no animation of the loader\'s left');
    assert.deepEqual(looping(after), ambient, '… and nothing else looping that wasn\'t before');

    // ---- loading again (a placing again, the next first open): opaque again at once ----
    await ev(() => T.rtPageState('loading', 'Safari'));
    const back = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([back.opacity, back.visibility, back.pointer, back.text.trim()], [1, 'visible', 'auto', 'Opening Safari…'], 'loading again: the card back at once, with its words');
    await page.waitForTimeout(60);
    at = await shot();
    assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], 'loading again: the page card opaque again');

    // ---- elsewhere: its item in another Margin window: the card faded and still, its words, the pointer let through ----
    const away = await ev(() => T.rtPageState('elsewhere', 'Notes'));
    assert.equal(away.attr, 'elsewhere');
    assert.equal(away.loader?.text.trim(), 'Click to show Notes here.', 'elsewhere: Margin\'s words for the card');
    const card = (await ev(() => T.rtLoader()))!;
    assert.ok(card.visibility === 'visible' && card.opacity > 0.3 && card.opacity < 0.8 && card.pointer === 'none', `elsewhere: the card seen, faded, the pointer let through (${JSON.stringify([card.visibility, card.opacity, card.pointer])})`);
    const still = (await ev(() => T.rtAnimations())).filter((a) => a.loader && a.running && !a.name.startsWith('transition:'));
    assert.deepEqual(still.map((a) => a.name), [], `elsewhere: nothing of the loader's moving (${JSON.stringify(still)})`);

    // ---- empty: the launcher; the loader gone, nothing of it running ----
    const empty = await ev(() => T.rtPageState('empty'));
    assert.deepEqual([empty.attr, empty.loader], ['empty', { own: true, text: '' }]);
    await page.waitForTimeout(300);
    const none = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([none.opacity, none.visibility, none.pointer], [0, 'hidden', 'none'], 'empty: the card hidden');
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((a) => a.loader), [], 'empty: no animation of the loader\'s');
    assert.equal(await ev(() => T.rtShown('.launcher')), true, 'empty: the launcher drawn');
    at = await shot();
    assert.deepEqual(inside.filter((p) => px(at, p)[3] < 250), [], 'empty: the launcher over the page\'s place, opaque');
    assert.deepEqual(errors, []);
    await context.close();

    for (const [name, options, check] of o.looks ?? []) {
      const other = await open(browser, o, options);
      await other.hosted();
      await other.ev(() => T.rtPageState('loading', 'Safari'));
      const place = await other.place();
      const img = await other.shot();
      assert.deepEqual(cardPoints(place.box, place.radii).inside.filter((p) => px(img, p)[3] < 250), [], `${name}: the page card opaque`);
      await check(other.page, other.ev);
      assert.deepEqual(other.errors, []);
      await other.context.close();
    }

    // The smallest window Margin.app has (640 × 420), a long name: everything of the loader inside the card, the words cut short.
    const small = await open(browser, o, { viewport: { width: 640, height: 420 } });
    await small.hosted();
    // (With the app's icon beside the words: it fits too.)
    await small.ev((apps) => T.rtApps(apps), APPS);
    await small.ev(() => T.rtPageState('loading', 'A Very Long Application Name That Goes On And On And Then Some More', 'com.apple.Notes'));
    assert.equal((await small.ev(() => T.rtLoaderIcons())).length, 1, 'the smallest window: the icon drawn');
    const fit = await small.ev((sel) => {
      const slot = (window as any).__rt.runtime.view.rootElement().querySelector('m-page-loader') as HTMLElement;
      const box = slot.getBoundingClientRect();
      const label = slot.querySelector(sel) as HTMLElement;
      const past = [...slot.querySelectorAll('*')].filter((el) => !el.children.length).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < box.left + 8 || r.right > box.right - 8 || r.top < box.top + 8 || r.bottom > box.bottom - 8); }).map((el) => el.getAttribute('class'));
      return { width: box.width, past, cut: label.scrollWidth > label.clientWidth, ellipsis: getComputedStyle(label).textOverflow };
    }, o.label);
    assert.ok(fit.width < 400, `a small card (${fit.width} px wide)`);
    assert.deepEqual([fit.past, fit.cut, fit.ellipsis], [[], true, 'ellipsis'], 'the smallest window: nothing of the loader (its icon too) within 8 px of the card\'s sides, a long name cut with an ellipsis');
    await small.context.close();
  });

  await t.test('the page card\'s icon: the opening app\'s (Safari\'s for a web item), loaded, at the theme\'s size; none without one; nothing left moving once shown', async () => {
    const { context, page, ev, hosted, place, errors } = await open(browser, o);
    await hosted();
    const { box } = await place();
    await ev((apps) => T.rtApps(apps), APPS);
    const iconOf = async (name: string, bundleId: string | null) => {
      await ev(([n, b]) => T.rtPageState('loading', n, b), [name, bundleId] as const);
      return ev(() => T.rtLoaderIcons());
    };
    const app = await iconOf('Notes', 'com.apple.Notes');
    assert.equal(app.length, 1, `an app opening: one icon in the loader (${JSON.stringify(app.map((i) => i.src?.slice(0, 30)))})`);
    const [notes] = app;
    assert.equal(notes.src, ICONS.notes, 'the installed app\'s icon, by its bundle id');
    assert.deepEqual([notes.complete, notes.natural, notes.visible], [true, [64, 64], true], 'loaded (64 px), drawn');
    assert.deepEqual(notes.size, [o.icon.size, o.icon.size], `at the theme's size (${o.icon.size} px: the 64 px icon at 2x, never enlarged past it)`);
    assert.ok(o.icon.size <= 32, 'never drawn bigger than the icon is sharp at 2x');
    if (o.icon.rendering) assert.equal(notes.rendering, o.icon.rendering, `scaled as the theme says (${o.icon.rendering})`);
    assert.ok(notes.at[0] >= box.left && notes.at[1] >= box.top && notes.at[2] <= box.right && notes.at[3] <= box.bottom, 'inside the card');
    assert.equal((await ev(() => T.rtLoader()))!.text.trim(), 'Opening Notes…', 'Margin\'s words beside it, as before');
    const web = await iconOf('Example', 'com.apple.Safari');
    assert.deepEqual(web.map((i) => [i.src === ICONS.safari, i.complete, i.size]), [[true, true, [o.icon.size, o.icon.size]]], 'a web item opening: Safari\'s icon (the browser it opens in)');
    for (const [what, id] of [['an app with no icon', 'com.example.NoIcon'], ['an app not installed', 'com.example.Gone'], ['no app named', null]] as const) {
      assert.deepEqual(await iconOf('Something', id), [], `${what}: no icon, the theme's loader as before`);
    }
    assert.equal(await ev((s) => T.rtShown(s), o.mark), true, '… its mark still drawn');
    await iconOf('Notes', 'com.apple.Notes');
    await ev(() => T.rtPageState('shown'));
    assert.deepEqual(await ev(() => T.rtLoaderIcons()), [], 'shown: the icon taken out with the part');
    await page.waitForTimeout(260);
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((a) => a.loader), [], 'shown: nothing of the loader\'s moving');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('the page card with reduced motion: nothing moves, the mark still there, the card goes at once', async () => {
    const { context, page, ev, hosted, place, shot } = await open(browser, o, { reducedMotion: 'reduce' });
    await hosted();
    const { box, radii } = await place();
    await ev(() => T.rtPageState('loading', 'Safari'));
    await page.waitForTimeout(80);
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((a) => a.loader), [], 'no animation in the loader');
    assert.equal(await ev((s) => T.rtShown(s), o.mark), true, 'a static mark');
    assert.deepEqual(await ev((s) => T.rtText(s), o.label), ['Opening Safari…']);
    const still = await shot();
    assert.deepEqual(cardPoints(box, radii).inside.filter((p) => px(still, p)[3] < 250), [], 'opaque');
    await ev(() => T.rtPageState('shown'));
    const lo = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([lo.opacity, lo.visibility, parseFloat(lo.transition)], [0, 'hidden', 0], 'shown: gone at once');
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((a) => a.loader), []);
    // Starting, too: the skeleton and the card's mark stand still.
    await ev(() => T.rtStartEmpty('empty'));
    await page.waitForTimeout(80);
    assert.deepEqual((await ev((names) => T.rtAnimations().filter((a) => a.loader || names.includes(a.name)), o.starting)), [], 'starting: nothing of the skeleton\'s or the card\'s moves');
    await context.close();
  });

  await t.test('starting (m-starting, before the first data): the sidebar\'s skeleton and the loader\'s card with no words; all gone once the data is drawn', async () => {
    const { context, page, ev, frames, place, shot, errors } = await open(browser, o);
    // The usual case first: the data there at the first draw, so nothing of the skeleton's.
    await ev(() => T.mountRuntime({ width: 1440, height: 900, container: 'document', platform: { browser: 'safari', os: 'mac' }, appWindow: true }));
    const drawnOf = (list: LoaderLook['skeleton']) => ev((l) => l.map(([s, p]) => (p ? T.rtPseudo(s, p)?.content ?? 'none' : 'element')), list);
    const pseudos = o.skeleton.filter(([, p]) => p);
    assert.deepEqual(await drawnOf(pseudos), pseudos.map(() => 'none'), 'not starting: none of the skeleton\'s boxes');
    assert.deepEqual((await ev((names) => T.rtAnimations().filter((a) => a.loader || names.includes(a.name)), o.starting)), [], 'not starting: none of its animations');

    // No data at the first draw: the root says so, and the theme draws its skeleton.
    assert.equal(await ev(() => T.rtStartEmpty('empty')), true, 'the root says m-starting');
    await frames();
    const { box, radii } = await place();
    const lo = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([lo.own, lo.text, lo.opacity, lo.visibility], [true, '', 1, 'visible'], 'starting: the loader\'s card, no part in it (no words)');
    assert.ok(over(lo, box), `starting: the card over the page's place (${JSON.stringify(lo)} vs ${JSON.stringify(box)})`);
    const mark = (await ev(() => [T.rtPseudo('m-page-loader', '::before'), T.rtPseudo('m-page-loader', '::after')]));
    assert.ok(mark.every((m) => m && m.content !== 'none' && m.width > 0 && m.height > 0), `starting: the card's mark drawn by the slot's own two boxes (${JSON.stringify(mark)})`);
    const at = await shot();
    assert.deepEqual(cardPoints(box, radii).inside.filter((p) => px(at, p)[3] < 250), [], 'starting: the page card opaque');
    for (const [selector, pseudo] of o.skeleton) {
      const drawn = pseudo ? await ev(([s, p]) => { const b = T.rtPseudo(s, p); return !!b && b.content !== 'none' && b.width > 0 && b.height > 0; }, [selector, pseudo] as const)
        : await ev((s) => { const c = T.rtComputed(s, 'background-color') ?? ''; return T.rtShown(s) && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; }, selector);
      assert.equal(drawn, true, `starting: ${selector}${pseudo} drawn`);
    }
    // A handful of soft pulses at most, on transform and opacity; no gradient swept across the sidebar.
    const moving = (await ev(() => T.rtAnimations())).filter((a) => a.running);
    const own = moving.filter((a) => o.starting.includes(a.name));
    assert.ok(own.length >= 1 && own.length <= 4, `starting: a handful of animations (${own.map((a) => a.name)})`);
    assert.deepEqual(own.filter((a) => a.props.some((p) => !COMPOSITED.has(p))), [], 'each on transform and opacity only');
    assert.deepEqual(moving.filter((a) => a.loader && !o.starting.includes(a.name)), [], 'none other in the card');
    const elements = await ev(() => (window as any).__rt.runtime.view.rootElement().querySelectorAll('*').length);

    // The data: starting until a frame after it's drawn, then nothing of the skeleton left.
    assert.equal(await ev(() => T.rtArrive()), true, 'still starting in the frame the data is drawn');
    await frames();
    await page.waitForTimeout(200);
    assert.equal(await ev(() => (window as any).__rt.runtime.view.rootElement().hasAttribute('m-starting')), false, 'no longer starting');
    assert.deepEqual(await drawnOf(pseudos), pseudos.map(() => 'none'), 'the skeleton\'s boxes gone');
    assert.deepEqual((await ev((names) => T.rtAnimations().filter((a) => a.loader || names.includes(a.name)), o.starting)), [], 'none of its animations left');
    await page.waitForTimeout(160);
    const done = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([done.visibility, done.opacity, done.pointer], ['hidden', 0, 'none'], 'the card gone: the launcher there');
    assert.equal(await ev(() => T.rtShown('.launcher')), true);
    assert.ok(await ev(() => (window as any).__rt.runtime.view.rootElement().querySelectorAll('*').length) > elements, 'the skeleton added no element of its own: the tree only grows with the data');

    // Starting while a hosted window is shown: never a card over it. While one opens: the part, once (no second mark).
    await ev(() => T.rtStartEmpty('shown'));
    const kept = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([kept.visibility, kept.opacity], ['hidden', 0], 'starting with a hosted window shown: the page\'s place left clear');
    assert.deepEqual([(await ev(() => T.rtPseudo('m-page-loader', '::before')))?.content, (await ev(() => T.rtAnimations())).filter((x) => x.loader)], ['none', []], '… with no mark of the slot\'s own drawn or turning under it');
    await ev(() => T.rtStartEmpty('loading', 'Safari'));
    const opening = (await ev(() => T.rtLoader()))!;
    assert.deepEqual([opening.visibility, opening.text.trim(), (await ev(() => T.rtPseudo('m-page-loader', '::before')))?.content], ['visible', 'Opening Safari…', 'none'], 'starting while an item opens: the part with its words, not the slot\'s own mark as well');
    // Outside Margin.app (no m-page-state: the page is the browser's own): never a card, starting or not.
    await ev(() => T.mountRuntime({ width: 1440, height: 900, mode: 'inpage' }));
    const inPage = await ev(() => { const root = (window as any).__rt.runtime.view.rootElement(); const el = root.querySelector('m-page-loader'); const cs = getComputedStyle(el); return [root.hasAttribute('m-page-state'), cs.visibility, cs.pointerEvents]; });
    assert.deepEqual(inPage, [false, 'hidden', 'none'], 'in a page: the slot draws nothing');
    await ev(() => T.rtStartEmpty('empty'));
    await ev(() => (window as any).__rt.runtime.view.rootElement().removeAttribute('m-page-state'));
    assert.deepEqual((await ev(() => T.rtAnimations())).filter((x) => x.loader && !x.name.startsWith('transition:')), [], '… and starting there (no m-page-state), no mark of the card\'s turns (its fade aside)');
    assert.deepEqual(errors, []);
    await context.close();
  });
}
