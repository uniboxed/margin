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
export function boxRules(selector, { left, top, right, bottom }, zoom = 1) {
  return `${selector} {
    position: absolute !important; left: 0 !important; top: 0 !important;
    transform: translate(${left}px, ${top}px) !important; transform-origin: 0 0 !important;
    width: calc(${100 / zoom}vw - ${left + right}px) !important; height: calc(${100 / zoom}vh - ${top + bottom}px) !important;
    min-width: 0 !important; max-width: none !important; min-height: 0 !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
    --margin-left: ${left}px; --margin-top: ${top}px; --margin-shift-x: ${-left}px; --margin-shift-y: ${-top}px;
    --margin-out-r: ${-right}px; --margin-out-b: ${-bottom}px;
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
