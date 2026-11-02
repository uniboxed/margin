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

const BODY = 'html > body:where(:first-of-type)'; // one <body>, not a stray second
export const FITTED_BODY = BODY;
// Five ids of specificity, but an impossible argument. Margin has to win the
// authored `!important` size/margin after it has read and translated it;
// otherwise the authored margin and Margin's equivalent padding both apply.
// Repeating only `#m` would make :not() false on `<body id="m">`.
const WEIGHT = ':not(#m#m#m#m#n)';
// WebKit's fast body-read switch lives on <head>, not <body>: changing an
// attribute there avoids invalidating the page's whole body subtree, while
// leaving `head + body`, `body:last-child`, hydration and serialization tree
// shape exactly as the page made them. Blink uses the empty-attribute form
// and switches the private fit sheet instead (content/page/box.js).
// Keep the engine gate's specificity at zero; the explicit impossible-id
// weight below, rather than the transaction mechanism, owns the cascade.
const headedBody = (readAttribute, state) => `html > :where(head:first-of-type${state}) ~ body:where(:first-of-type)`;
export const fittedBody = (readAttribute = '') => `${readAttribute ? headedBody(readAttribute, `:not([${readAttribute}="read"])`) : BODY}${WEIGHT}`;
// Kept during a body read. Some pages make layout unavoidable (intrinsic body
// width or a size container); the guard keeps their scroller at the box's
// height while the remaining fit declarations are temporarily disabled.
export const BODY_GUARD_CSS = `@media screen {
  ${BODY}${WEIGHT} { min-height: 100% !important; max-height: 100% !important; }
}`;
const WEIGHTED_BODY = `${BODY}${WEIGHT}`;
const NO_TRANSITION = 'transition-duration: 0s !important; transition-delay: 0s !important;';

// Enabled only while a never-shown tab paints Margin's arrival cover. Kept in
// a private constructed sheet so hiding the page creates no authored inline
// style mutation and cannot trip a site's MutationObserver feedback.
export const BODY_COVER_CSS = `@media screen {
  ${WEIGHTED_BODY} { opacity: 0 !important; ${NO_TRANSITION} }
}`;

// <body>'s size in the box. <body> fills the box and is the scroller, so its
// scrollbar stays at the box's edge; what the page meant by a width comes back
// as padding.
// `grows`: the page gives <body> no height, so it would grow with its content.
// Its height stays auto, which keeps a child's percent height auto too, held
// to the box by min and max. Those two aren't read, so they stay through a
// read: a layout during one (a query container makes a browser lay out to
// style it) finds <body> the box's height, and its scroll position survives.
// `column`: such a body is a flex column, which in a window never shrinks its
// children, so they're kept from shrinking here.
export function bodyFitCss({ grows = false, column = false } = {}, readAttribute = '') {
  const fitted = fittedBody(readAttribute);
  const height = grows ? 'height: auto !important;' : 'height: 100% !important;';
  return `@media screen {
    ${fitted} { width: auto !important; max-width: none !important; box-sizing: border-box !important; ${height} }
    ${grows && column ? `${fitted} > * { flex-shrink: 0 !important; flex-basis: auto !important; }` : ''}
  }`;
}

// Enabled only for the synchronous body-read transaction. Duration and delay,
// not `transition: none`, which would cancel a transition already running.
// Five ids of weight: a page's `html body#b { transition: all !important }`
// must not start one while Margin removes and restores its fit declarations.
export function bodyHoldCss({ grows = false, column = false, held = false } = {}, readAttribute = '') {
  const selected = readAttribute ? headedBody(readAttribute, `[${readAttribute}]`) : BODY;
  const heldBody = `${selected}${WEIGHT}`;
  return `@media screen {
    ${heldBody}, ${heldBody}::before, ${heldBody}::after { ${NO_TRANSITION} }
    ${grows && column ? `${heldBody} > * { ${NO_TRANSITION} }` : ''}
    ${held ? `${heldBody} * { ${NO_TRANSITION} }` : ''}
  }`;
}

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
