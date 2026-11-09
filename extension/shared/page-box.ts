// The page's box: where a page sits beside Margin's sidebar and inside its
// frame, with no iframe. <html> is the box: it holds everything fixed in the
// page, and <body> scrolls inside it. Plain text, shared by the page-world
// script (content/page/box.ts) and the themes' first-paint files
// (firstPaintCss, below; scripts/build.ts), so the two can't drift.
// What the box promises, and every page pattern it handles: tests/box/README.md.

// <html>'s rules. `selector` is <html>'s. Under @media screen: paper has no box.
// `transform-origin`: the pinch's scale starts at the box's corner. `zoom`: the
// page's own on <html>, which scales every length in here, these ones included.
// Not on <html>'s and <body>'s overflow: a rule of the page's has to be seen
// in their computed style (content/page/box.ts). Nothing on <body> here: the
// first paint must leave it alone, because the page's world reads what the
// page says about it (bodyFitCss) with its own rules taken off.
// An inset is a number of pixels, or a CSS length (the first paint's
// variables, below), so one sheet fits any insets.
const len = (v) => (typeof v === 'number' ? `${v}px` : v);
// The weight of five ids, for Margin's rules a page's mustn't beat: a page's
// `!important` on a class or an id loses to it (`.w-100 { width: 100% !important }`
// on <html>, islonline.net: the box went back to the window's width).
const WEIGHT = ':not(#m#m#m#m#m)';
/** <html>, as the box's own rules name it: outweighing whatever a page says about it. */
export const BOX_ROOT = `html${WEIGHT}`;
const neg = (v) => (typeof v === 'number' ? `${-v}px` : `calc(-1 * ${v})`);
const sum = (a, b) => (typeof a === 'number' && typeof b === 'number' ? `${a + b}px` : `(${len(a)} + ${len(b)})`);
export function boxRules(selector: string, { left, top, right, bottom }: { left: number | string, top: number | string, right: number | string, bottom: number | string }, zoom: number = 1) {
  return `${selector} {
    position: absolute !important; left: 0 !important; top: 0 !important;
    transform: translate(${len(left)}, ${len(top)}) !important; transform-origin: 0 0 !important;
    width: calc(${100 / zoom}vw - ${sum(left, right)}) !important; height: calc(${100 / zoom}vh - ${sum(top, bottom)}) !important;
    min-width: 0 !important; max-width: none !important; min-height: 0 !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
    --margin-box-left: ${len(left)}; --margin-box-top: ${len(top)}; --margin-box-shift-x: ${neg(left)}; --margin-box-shift-y: ${neg(top)};
    --margin-box-out-r: ${neg(right)}; --margin-box-out-b: ${neg(bottom)};
  }`;
}

// What takes Margin's size rules off <body> for a read (content/page/box.ts
// readWithout), within one task: an element of Margin's after <body> while the
// page's own rules show (`read`), and one while <body> is held still (`hold`).
// Neither is ever in the page outside that task, so nothing a page keeps,
// hydrates or serializes has them in it, and being after <body> they leave
// `head + body`, `:first-child` and `:nth-child` as the page wrote them.
// An element is the cheapest of what was tried: `sheet.disabled` makes WebKit
// rebuild every rule of the page (52 ms against 4 on 20,000 rows). Not
// `html:has(...)`: any `:has()` makes adding a child to <body> cost 4 times as
// much in Chromium, on every page. The price is one observer callback for a
// page that watches <html>'s children.
export const READ_ELEMENT = 'margin-read';
export const HOLD_ELEMENT = 'margin-hold';
const BODY = 'html > body:where(:first-of-type)'; // one <body>, not a stray second
// <body> with no such element after it.
const none = (element) => `:nth-last-child(1 of body:first-of-type, ${element})`;
// <body>, while no read is looking. `:where`: no weight, a page's `!important`
// class still wins as it would.
export const FITTED_BODY = `${BODY}:where(${none(READ_ELEMENT)})`;

// <body> held still during a read. Duration and delay, not `transition: none`,
// which would cancel a transition already running. Five ids of weight: a
// page's `html body#b { transition: all 1s !important }` mustn't start one. Its
// pseudo-elements with it, which can inherit what a read changes, at no cost.
const STILL = `${BODY}:not(${none(HOLD_ELEMENT)})${WEIGHT}`;
const NO_TRANSITION = 'transition-duration: 0s !important; transition-delay: 0s !important;';

// <body>'s size in the box. <body> fills the box and is the scroller, so its
// scrollbar stays at the box's edge; what the page meant by a width comes back
// as padding.
// `grows`: the page gives <body> no height, so it would grow with its content.
// Its height stays auto, which keeps a child's percent height auto too, held
// to the box by min and max. Those two aren't read, so they stay through a
// read: a layout during one (a query container makes a browser lay out to
// style it) finds <body> the box's height, and its scroll position survives.
// `column`: such a body is a flex column, which in a window never shrinks its
// children, so they're kept from shrinking here, and held still while a read
// takes that away. `held`: a page whose elements inherit from <body> started
// transitions in a read (content/page/box.ts): all of them are held from then on.
export function bodyFitCss({ grows = false, column = false, held = false } = {}) {
  const height = grows ? 'height: auto !important;' : 'height: 100% !important;';
  return `@media screen {
    html > body:where(:first-of-type) { min-height: 100% !important; max-height: 100% !important; }
    ${FITTED_BODY} { left: auto !important; right: auto !important; width: auto !important; max-width: none !important; box-sizing: border-box !important; ${height} }
    ${grows && column ? `${FITTED_BODY} > * { flex-shrink: 0 !important; flex-basis: auto !important; } ${STILL} > * { ${NO_TRANSITION} }` : ''}
    ${held ? `${STILL} * { ${NO_TRANSITION} }` : ''}
  }`;
}

export const STILL_CSS = `${STILL}, ${STILL}::before, ${STILL}::after { ${NO_TRANSITION} }
  ${READ_ELEMENT}${WEIGHT}, ${HOLD_ELEMENT}${WEIGHT} { display: none !important; }`;

// What the page says about <body>, without a layout: `::backdrop` has no box,
// so what it inherits reads back as the page wrote it (`10%`, `auto`, `50%`),
// and asking for it lays nothing out. Not on an element that has a real
// backdrop, or could while it closes. <html>'s width, which is the box's, and
// any element's top margin, for what collapses with <body>'s. That last rule
// names nothing about siblings: `:first-child` would make the browser look
// again at every parent's first child each time one is added or taken away.
export const SAID_CSS = `html:not(:fullscreen)::backdrop { width: inherit !important; }
  html > body:where(:first-of-type):not(:fullscreen)::backdrop {
    margin: inherit !important; padding: inherit !important; box-sizing: inherit !important;
    width: inherit !important; min-width: inherit !important; max-width: inherit !important; height: inherit !important;
    border-left-width: inherit !important; border-right-width: inherit !important; border-left-style: inherit !important; border-right-style: inherit !important;
  }
  :not(dialog, [popover], :fullscreen)::backdrop { margin-top: inherit !important; }`;

// What --margin-box-dw and --margin-box-dh are for a box, and for no box. They stay
// defined whatever happens: the page's rewritten values use them.
export const NO_BOX_CSS = ':root { --margin-box-dw: 0px; --margin-box-dh: 0px; }';

// The page-world sheet, for { left, top, right, bottom } in the page's pixels.
// `clipY`: <html> clips up and down too (the window never scrolls, and a quirks-mode page's <body> stays a scroller of
// its own, not the document's). Off while the page says <html>'s overflow-x itself (content/page/box.ts checkLocks).
export function boxCss(box, zoom = 1, clipY = true) {
  const scaled = { left: box.left / zoom, top: box.top / zoom, right: box.right / zoom, bottom: box.bottom / zoom };
  const dw = scaled.left + scaled.right;
  const dh = scaled.top + scaled.bottom;
  return `${NO_BOX_CSS}
  @media screen {
    :root { --margin-box-dw: ${dw}px; --margin-box-dh: ${dh}px; }
    ${boxRules(BOX_ROOT, scaled, zoom)}
    /* <html> itself in full screen (YouTube's video: Tirth, 2026-11-07, the video in the box's place, a strip on the
       left): the whole window. The browser's own full-screen rules skip the root (:not(:root):fullscreen), so the
       box's would stay; a <body> or element in full screen is the browser's, its rules outweighing these. <body>
       stays the scroller, as Margin's world says (content/page/viewport.ts). One step heavier than BOX_ROOT. */
    ${BOX_ROOT}:fullscreen {
      transform: none !important; width: ${100 / zoom}vw !important; height: ${100 / zoom}vh !important;
      --margin-box-left: 0px; --margin-box-top: 0px; --margin-box-shift-x: 0px; --margin-box-shift-y: 0px; --margin-box-out-r: 0px; --margin-box-out-b: 0px;
    }
    /* top and bottom: a page's scroll lock (fixed, top: -Ypx) mustn't move the scroller. Not left and right: a page that
       places <body> by its own offset (xkcd.com: absolute, left: 50%, a negative margin) has it read and given back as
       padding (content/page/box-body.ts), and the fit sheet holds the scroller still (bodyFitCss). */
    html > body:where(:first-of-type) {
      position: relative !important; top: auto !important; bottom: auto !important;
      scroll-padding: inherit !important; scroll-behavior: inherit !important; scroll-snap-type: inherit !important; overscroll-behavior: inherit !important;
    }
    /* Nothing said: html clips, and a page's own value shows. A page's overflow-x: hidden (auto, scroll) alone turns
       a weightless clip up and down into hidden, read as the page locking <html> (msu.edu, 2026-11-07: <body> left at
       its own overflow: hidden, the page unscrollable): then only sideways, so what it says up and down shows. */
    :where(html) { ${clipY ? 'overflow: clip' : 'overflow-x: clip'}; }
    /* The top layer ignores <html>. Its elements are placed one by one
       (content/page/top-layer.ts), their backdrops here. */
    ::backdrop { inset: ${box.top}px ${box.right}px ${box.bottom}px ${box.left}px !important; }
    :fullscreen::backdrop { inset: 0 !important; }
    /* Full screen is the whole window again. */
    :fullscreen { --margin-box-dw: 0px; --margin-box-dh: 0px; }
  }`;
}

// ---- the first paint: any layout, from Margin.app's ----------------------------------
// A page has its box before its first paint, at whatever insets the theme's
// layout gives its window (Margin 2: PLAN.md §14, Spike 4), from content
// scripts the background registers (background/registered.ts) while
// Margin.app draws Margin. A registration can list only files, and a script
// registered can't be given a value, so a layout is spelled in files of one
// decimal digit each, of each inset's count of quarter pixels:
// content/layout/<side>-<place>-<digit>.css sets --margin-box-at-<side>-<place>
// to digit × 10^place quarter pixels, and content/layout/at.css adds a side's
// places up into --margin-box-at-<side>. 164 files cover every inset from 0 to
// 1023.75 px and a corner to 63.75 px; a layout registers 19 of them and
// at.css. Every place, zeros too: WebKit keeps applying the CSS of a
// registration it updated or took away to every new page (the WebKit host,
// 2026-11-04 and Phase 2 step 5: until it restarts), and the sheet added last
// wins, so a value every registration sets is the newest one's whatever is
// left over (a sum of only the places that aren't zero would add an old
// registration's in). A window whose layout isn't the registered one gets its
// own as one sheet of plain values as its page commits (scripting.insertCSS:
// layoutOwnCss), which outweighs the sums.
//
// Nothing here draws by itself, so a registration left over can't paint a
// wrong box: the theme's first-paint file (firstPaintCss) applies only to an
// <html> marked `data-margin-at="<theme id>"`, which the page's world sets
// (content/page/main.ts) when the newest registration says that theme
// (`--margin-box-fp: <id>`, in that file) and the page is starting fresh, at a
// layout with a box: not linked any more, the background updates the
// registration to a layout of zeros, and the page's world stays out (a
// window with no box gets `--margin-box-fp: off` as its page commits). The page's world takes the mark off
// once Margin's content script has said where the box goes (its first
// `margin:box`): from then on the box is the page world's own sheet.
export const LAYOUT_SIDES = Object.freeze(['left', 'top', 'right', 'bottom', 'radius']);
const MAX_QUARTERS = Object.freeze({ left: 4095, top: 4095, right: 4095, bottom: 4095, radius: 255 });
const QUARTER = 0.25;
const placesOf = (side) => String(MAX_QUARTERS[side]).length;
export const FIRST_PAINT_MARK = 'data-margin-at';
export const LAYOUT_SUM_FILE = 'content/layout/at.css';
/** @param id a theme's */
export const firstPaintFile = (id: string) => `content/layout/theme-${id}.css`;
export const layoutDigitFile = (side: string, place: number, digit: number) => `content/layout/${side}-${place}-${digit}.css`;
const placeName = (side, place) => `--margin-box-at-${side}-${place}`;
const quarters = (side: string, value: unknown) => Math.max(0, Math.min(MAX_QUARTERS[side], Math.round((Number(value) || 0) / QUARTER)));
/** A layout as it's spelled: quarter pixels, within range. */
export const spelled = (layout: Record<string, unknown> | null | undefined): { left: number, top: number, right: number, bottom: number, radius: number } => (Object.fromEntries(LAYOUT_SIDES.map((side) => [side, quarters(side, layout?.[side]) * QUARTER])) as any);
/** What a layout registers: at.css, then one digit file for every place of every side. */
export function layoutFiles(layout: Record<string, unknown>) {
  const files = [LAYOUT_SUM_FILE];
  for (const side of LAYOUT_SIDES) {
    const q = quarters(side, layout?.[side]);
    for (let place = 0; place < placesOf(side); place++) files.push(layoutDigitFile(side, place, Math.floor(q / 10 ** place) % 10));
  }
  return files;
}
/** The layout a list of registered files spells (layoutFiles read back), or null. */
export function layoutOfFiles(files: unknown) {
  if (!Array.isArray(files) || !files.includes(LAYOUT_SUM_FILE)) return null;
  const q: Record<string, number> = Object.fromEntries(LAYOUT_SIDES.map((side) => [side, 0]));
  for (const file of files) {
    const m = /^content\/layout\/([a-z]+)-(\d)-(\d)\.css$/.exec(String(file));
    if (m && m[1] in q) q[m[1]] += Number(m[3]) * 10 ** Number(m[2]);
  }
  return spelled(Object.fromEntries(LAYOUT_SIDES.map((side) => [side, q[side] * QUARTER])));
}
/** Every file a layout may list, with its CSS: [path, css]. */
export function allLayoutFiles() {
  const files = [[LAYOUT_SUM_FILE, layoutSumCss()]];
  for (const side of LAYOUT_SIDES) {
    for (let place = 0; place < placesOf(side); place++) {
      const top = Math.min(9, Math.floor(MAX_QUARTERS[side] / 10 ** place));
      for (let digit = 0; digit <= top; digit++) files.push([layoutDigitFile(side, place, digit), `:root { ${placeName(side, place)}: ${digit * 10 ** place * QUARTER}px; }\n`]);
    }
  }
  return files;
}
function layoutSumCss() {
  const sums = LAYOUT_SIDES.map((side) => `--margin-box-at-${side}: calc(${Array.from({ length: placesOf(side) }, (_, place) => `var(${placeName(side, place)}, 0px)`).join(' + ')});`);
  return `:root { ${sums.join(' ')} }\n`;
}
/** A window's own layout, as one sheet (scripting.insertCSS): `html:root` outweighs the sums' `:root`. */
export function layoutOwnCss(layout: Record<string, unknown>) {
  const values = spelled(layout);
  return `html:root { ${LAYOUT_SIDES.map((side) => `--margin-box-at-${side}: ${values[side]}px;`).join(' ')} }`;
}
// The box from those variables, for any layout (boxRules takes CSS lengths).
const LAYOUT_BOX = Object.freeze({ left: 'var(--margin-box-at-left)', top: 'var(--margin-box-at-top)', right: 'var(--margin-box-at-right)', bottom: 'var(--margin-box-at-bottom)' });
/** The selector a theme's first paint is under: <html> marked for that theme. */
export const firstPaintRoot = (id: string) => `html[${FIRST_PAINT_MARK}="${id}"]`;
/**
 * A theme's first-paint file (scripts/build.ts writes it): the theme it is
 * (`--margin-box-fp`, read by the page's world), the box from the variables, and
 * the theme's own look around it (`look`: themes/<id>/first-paint.css, every
 * rule under firstPaintRoot(id), checked by a unit test).
 * */
export function firstPaintCss(id: string, look: string) {
  return `/* ${id}'s first paint (scripts/build.ts, from shared/page-box.ts and themes/${id}/first-paint.css). */\n:root { --margin-box-fp: ${id}; }\n@media screen {\n  ${boxRules(`${firstPaintRoot(id)}${WEIGHT}`, LAYOUT_BOX)}\n}\n${look}`;
}
// A side's variable as computed: its places' sum, unworked ("calc(0px + 4px +
// …)"), or a plain value. Every term is added, so its pixels add up.
const pixels = (text: string) => {
  let total = 0;
  for (const [, n] of text.matchAll(/(-?\d*\.?\d+(?:e[-+]?\d+)?)px/gi)) total += Number(n);
  return total;
};
/**
 * What the first-paint CSS says in this page: nothing yet (null: no
 * registration's CSS has come), `off` (Margin.app isn't drawing), or the
 * theme and its layout.
 * @param style <html>'s computed style
 * */
export function readFirstPaint(style: CSSStyleDeclaration): null | { theme: string | null, layout: { left: number, top: number, right: number, bottom: number, radius: number } | null } {
  const theme = style.getPropertyValue('--margin-box-fp').trim();
  if (!theme) return null;
  if (theme === 'off' || !/^[a-z][a-z0-9-]*$/.test(theme)) return { theme: null, layout: null };
  return { theme, layout: (Object.fromEntries(LAYOUT_SIDES.map((side) => [side, pixels(style.getPropertyValue(`--margin-box-at-${side}`))])) as any) };
}

// <body>'s background, with <html> saying none, is the window's canvas's: an
// image in it is laid out at <html>'s size from the window's corner, not moved
// with <html> into the box (a gradient steps at the box's width and repeats
// along its bottom). Any background on <html> keeps it on <body>, which fills
// the box; the canvas keeps <body>'s color. No weight: a page's own rule on
// <html> wins, and then <body>'s is on <body> already. '' with no image.
/** @param body <body>'s computed style */
export function bodyBackgroundCss({ backgroundImage, backgroundColor }: { backgroundImage: string, backgroundColor: string }) {
  if (!backgroundImage || backgroundImage === 'none') return '';
  return `@media screen { :where(html) { background-color: ${backgroundColor}; background-image: linear-gradient(transparent, transparent); } }`;
}
