// The page's box: where a page sits beside Margin's sidebar and inside its
// frame, with no iframe. <html> is the box: it holds everything fixed in the
// page, and <body> scrolls inside it. Plain text, shared by the page-world
// script (content/page/box.js) and the first-paint placeholders
// (scripts/build-styles.js), so the two can't drift.

// <html>'s rules. `selector` is <html>'s. Under @media screen: paper has no box.
// `transform-origin`: the pinch's scale starts at the box's corner. `zoom`: the
// page's own on <html>, which scales every length in here, these ones included.
// Not on <html>'s and <body>'s overflow: a rule of the page's has to be seen
// in their computed style (content/page/box.js). Nothing on <body> here: the
// placeholders must leave it alone, because the page's world reads what the
// page says about it (bodyFitCss) with its own rules taken off.
// An inset is a number of pixels, or a CSS length (LAYOUT_BOX: the first-paint
// layout's variables, below), so one sheet fits any insets.
const len = (v) => (typeof v === 'number' ? `${v}px` : v);
const neg = (v) => (typeof v === 'number' ? `${-v}px` : `calc(-1 * ${v})`);
const sum = (a, b) => (typeof a === 'number' && typeof b === 'number' ? `${a + b}px` : `(${len(a)} + ${len(b)})`);
export function boxRules(selector, { left, top, right, bottom }, zoom = 1) {
  return `${selector} {
    position: absolute !important; left: 0 !important; top: 0 !important;
    transform: translate(${len(left)}, ${len(top)}) !important; transform-origin: 0 0 !important;
    width: calc(${100 / zoom}vw - ${sum(left, right)}) !important; height: calc(${100 / zoom}vh - ${sum(top, bottom)}) !important;
    min-width: 0 !important; max-width: none !important; min-height: 0 !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
    --margin-left: ${len(left)}; --margin-top: ${len(top)}; --margin-shift-x: ${neg(left)}; --margin-shift-y: ${neg(top)};
    --margin-out-r: ${neg(right)}; --margin-out-b: ${neg(bottom)};
  }`;
}

// What takes Margin's size rules off <body> for a read (content/page/box.js
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
const WEIGHT = ':not(#m#m#m#m#m)';
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
// transitions in a read (content/page/box.js): all of them are held from then on.
export function bodyFitCss({ grows = false, column = false, held = false } = {}) {
  const height = grows ? 'height: auto !important;' : 'height: 100% !important;';
  return `@media screen {
    html > body:where(:first-of-type) { min-height: 100% !important; max-height: 100% !important; }
    ${FITTED_BODY} { width: auto !important; max-width: none !important; box-sizing: border-box !important; ${height} }
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

// What --margin-dw and --margin-dh are for a box, and for no box. They stay
// defined whatever happens: the page's rewritten values use them.
export const NO_BOX_CSS = ':root { --margin-dw: 0px; --margin-dh: 0px; }';

// The page-world sheet, for { left, top, right, bottom } in the page's pixels.
export function boxCss(box, zoom = 1) {
  const scaled = { left: box.left / zoom, top: box.top / zoom, right: box.right / zoom, bottom: box.bottom / zoom };
  const dw = scaled.left + scaled.right;
  const dh = scaled.top + scaled.bottom;
  return `${NO_BOX_CSS}
  @media screen {
    :root { --margin-dw: ${dw}px; --margin-dh: ${dh}px; }
    ${boxRules('html', scaled, zoom)}
    /* inset: a page's scroll lock (fixed, top: -Ypx) mustn't move the scroller. */
    html > body:where(:first-of-type) {
      position: relative !important; inset: auto !important;
      scroll-padding: inherit !important; scroll-behavior: inherit !important; scroll-snap-type: inherit !important; overscroll-behavior: inherit !important;
    }
    /* Nothing said: html clips, and a page's own value shows. */
    :where(html) { overflow: clip; }
    /* The top layer ignores <html>. Its elements are placed one by one
       (content/page/top-layer.js), their backdrops here. */
    ::backdrop { inset: ${box.top}px ${box.right}px ${box.bottom}px ${box.left}px !important; }
    :fullscreen::backdrop { inset: 0 !important; }
    /* Full screen is the whole window again. */
    :fullscreen { --margin-dw: 0px; --margin-dh: 0px; }
  }`;
}

// ---- the first-paint layout: any insets, from the theme ----------------------
// Registered content-script CSS can only list files, and a registered script
// can't be given a value, so a layout is spelled in files of one decimal
// digit each, of each inset's count of quarter pixels:
// content/layout/<side>-<place>-<digit>.css sets --margin-at-<side>-<place> to
// digit * 10^place quarter pixels, and content/layout/at.css adds a side's
// places up into --margin-at-<side>. The background registers at.css with one
// file for every place of the default layout, zeros too (20 files; 164 in all
// cover every inset from 0 to 1023.75px and a radius to 63.75px). Every
// place, because WebKit keeps applying the CSS of a registration it changed or
// took away to every new page (DECISIONS.md, 2026-11-04: until it relaunches;
// the sheet added last wins): a property set by every registration is the
// newest one's whatever is left over, where a sum of only the bits that are
// set would add the old ones in. A window with other insets gets them as one
// sheet of plain values as its page commits (scripting.insertCSS), which
// outweighs the sums. The first-paint box (a theme's docked/layout*.css) and
// the page's world (content/page/main.js) read the variables. They change
// nothing by themselves, so they're on every page, taken over or not: the page's
// world can read them whenever they come (WebKit applies registered CSS after
// the page's world script has started).
export const LAYOUT_SIDES = Object.freeze(['left', 'top', 'right', 'bottom', 'radius']);
const MAX_QUARTERS = Object.freeze({ left: 4095, top: 4095, right: 4095, bottom: 4095, radius: 255 });
const QUARTER = 0.25;
const placesOf = (side) => String(MAX_QUARTERS[side]).length;
// The box's rules: not on a page an old copy laid out, which stays as it is
// until it reloads, nor once Margin's content script has taken over there
// (content/layout.js).
export const PLACED = 'html:not([data-margin-docked="off"], [data-margin-shell], [data-margin-frameless])';
const VARS = ':root';
const VARS_OWN = 'html:root'; // outweighs VARS: a window's own layout
export const LAYOUT_SUM_FILE = 'content/layout/at.css';
export const layoutDigitFile = (side, place, digit) => `content/layout/${side}-${place}-${digit}.css`;
const placeName = (side, place) => `--margin-at-${side}-${place}`;
const quarters = (side, value) => Math.max(0, Math.min(MAX_QUARTERS[side], Math.round((Number(value) || 0) / QUARTER)));
/** A layout as it's spelled: quarter pixels, within range. @param {Record<string, number>} layout */
export const spelled = (layout) => Object.fromEntries(LAYOUT_SIDES.map((side) => [side, quarters(side, layout?.[side]) * QUARTER]));
/** What to register for a layout: at.css, then one digit file for every place of every side. @param {Record<string, number>} layout */
export function layoutFiles(layout) {
  const files = [LAYOUT_SUM_FILE];
  for (const side of LAYOUT_SIDES) {
    const q = quarters(side, layout?.[side]);
    for (let place = 0; place < placesOf(side); place++) files.push(layoutDigitFile(side, place, Math.floor(q / 10 ** place) % 10));
  }
  return files;
}
/** Every file a layout may list, with its CSS: [path, css]. */
export function allLayoutFiles() {
  const files = [[LAYOUT_SUM_FILE, layoutSumCss()]];
  for (const side of LAYOUT_SIDES) {
    for (let place = 0; place < placesOf(side); place++) {
      const top = Math.min(9, Math.floor(MAX_QUARTERS[side] / 10 ** place));
      for (let digit = 0; digit <= top; digit++) files.push([layoutDigitFile(side, place, digit), `${VARS} { ${placeName(side, place)}: ${digit * 10 ** place * QUARTER}px; }\n`]);
    }
  }
  return files;
}
function layoutSumCss() {
  const sums = LAYOUT_SIDES.map((side) => `--margin-at-${side}: calc(${Array.from({ length: placesOf(side) }, (_, place) => `var(${placeName(side, place)}, 0px)`).join(' + ')});`);
  return `${VARS} { --margin-at: 1; ${sums.join(' ')} }\n`;
}
/** A window's own layout, as one sheet (scripting.insertCSS). @param {Record<string, number>} layout */
export function layoutOwnCss(layout) {
  const values = spelled(layout);
  // --margin-own: when it arrived can be seen (tools/first-paint).
  return `${VARS_OWN} { --margin-at: 1; --margin-own: 1; ${LAYOUT_SIDES.map((side) => `--margin-at-${side}: ${values[side]}px;`).join(' ')} }`;
}
// The box from those variables: one sheet for any layout (boxRules).
export const LAYOUT_BOX = Object.freeze({ left: 'var(--margin-at-left)', top: 'var(--margin-at-top)', right: 'var(--margin-at-right)', bottom: 'var(--margin-at-bottom)' });
// A side's variable as computed: its bits' sum, unworked ("calc(0px + 4px +
// …)"), or a plain value. Every term is added, so its pixels add up.
const pixels = (text) => {
  let total = 0;
  for (const [, n] of text.matchAll(/(-?\d*\.?\d+(?:e[-+]?\d+)?)px/gi)) total += Number(n);
  return total;
};
/** The layout the first-paint CSS gave this page, or null. @param {CSSStyleDeclaration} style <html>'s computed style */
export function readLayoutVars(style) {
  if (style.getPropertyValue('--margin-at').trim() !== '1') return null;
  return /** @type {{ left: number, top: number, right: number, bottom: number, radius: number }} */ (Object.fromEntries(LAYOUT_SIDES.map((side) => [side, pixels(style.getPropertyValue(`--margin-at-${side}`))])));
}
