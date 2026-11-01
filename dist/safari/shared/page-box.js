// The page's box: where a page sits beside Margin's sidebar and inside its
// frame, with no iframe. <html> is the box: it holds everything fixed in the
// page, and <body> scrolls inside it. Plain text, shared by the page-world
// script (content/page/box.js) and the first-paint placeholders
// (scripts/build-styles.js), so the two can't drift.

// <html>'s rules. `selector` is <html>'s. Under @media screen: paper has no box.
// `transform-origin`: the pinch's scale starts at the box's corner.
// Not on <html>'s and <body>'s overflow: a rule of the page's has to be seen
// in their computed style (content/page/box.js). Nothing on <body> here: the
// placeholders must leave it alone, because the page's world reads what the
// page says about it (bodyFitCss) with its own sheets out of the way.
export function boxRules(selector, { left, top, right, bottom }) {
  return `${selector} {
    position: absolute !important; left: 0 !important; top: 0 !important;
    transform: translate(${left}px, ${top}px) !important; transform-origin: 0 0 !important;
    width: calc(100vw - ${left + right}px) !important; height: calc(100vh - ${top + bottom}px) !important;
    min-width: 0 !important; max-width: none !important; min-height: 0 !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important; box-sizing: border-box !important;
    --margin-left: ${left}px; --margin-top: ${top}px; --margin-shift-x: ${-left}px; --margin-shift-y: ${-top}px;
    --margin-out-r: ${-right}px; --margin-out-b: ${-bottom}px;
  }`;
}

// <body>'s size in the box. `:first-of-type` (with no weight, a page's
// `!important` class still wins as it would) here and in every rule on <body>:
// a stand-in <body> is the second, and has to show what the page alone says
// about it (content/page/box.js measureBody). <body> fills the box and is the
// scroller, so its scrollbar stays at the box's edge; what the page
// meant by a width comes back as padding.
// `grows`: the page gives <body> no height, so it would grow with its content.
// Its height stays auto, which keeps a child's percent height auto too, held
// to the box by min and max. `column`: such a body is a flex column, which in
// a window never shrinks its children, so they're kept from shrinking here.
export function bodyFitCss({ grows = false, column = false } = {}) {
  const height = grows
    ? 'height: auto !important; min-height: 100% !important; max-height: 100% !important;'
    : 'height: 100% !important; min-height: 0 !important; max-height: none !important;';
  return `@media screen {
    html > body:where(:first-of-type) { width: auto !important; max-width: none !important; box-sizing: border-box !important; ${height} }
    ${grows && column ? 'html > body:where(:first-of-type) > * { flex-shrink: 0 !important; flex-basis: auto !important; }' : ''}
  }`;
}

// What --margin-dw and --margin-dh are for a box, and for no box. They stay
// defined whatever happens: the page's rewritten values use them.
export const NO_BOX_CSS = ':root { --margin-dw: 0px; --margin-dh: 0px; }';

// The page-world sheet, for { left, top, right, bottom } in the page's pixels.
export function boxCss(box) {
  const dw = box.left + box.right;
  const dh = box.top + box.bottom;
  return `${NO_BOX_CSS}
  @media screen {
    :root { --margin-dw: ${dw}px; --margin-dh: ${dh}px; }
    ${boxRules('html', box)}
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
