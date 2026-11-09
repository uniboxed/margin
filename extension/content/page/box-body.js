// What the page says about <body>'s size and margins, read and applied, for the
// box (box.js). <body> fills the box and scrolls, so what the page says about its
// size and margins comes back as a height rule and as padding (shared/body-fit.js
// works it out). When to read is box-watch.js's.
import { bodyFitCss, FITTED_BODY, HOLD_ELEMENT, READ_ELEMENT } from '../../shared/page-box.js';
import { EDGES, growsIn, isSized, pixels, resolve, settled, SIZES, topMargin } from '../../shared/body-fit.js';
import { keyframesIn, startMoves } from './moves.js';
import { CHAIN_DEPTH } from './box-chain.js';

// What a read looks at, in the names of transitions and of keyframes: on <html>
// and <body>, and on the first children. `font` and `--`: lengths in `em` or
// through a variable move with them.
const READ_PROPERTY = /^(margin|padding|border|box-?sizing|width|min-?width|max-?width|height|font|zoom|--)/i;
const CHAIN_PROPERTY = /^(margin|font|zoom|--)/i;
const INHERITED_INTO = /^(margin|padding|width|min-?width|max-?width|height|min-?height|max-?height)/i;

/** @param {any} ctx the box's shared parts (box.js) */
export function startBody(ctx) {
  const { box, own, native } = ctx;
  const { append, remove, checkVisibility, computed, parseLength: parse, scrollLeft } = native;
  // To read what the page says, Margin's rules come off <body> for a moment
  // (readWithout). Lengths come from readSaid: style only, so nothing is laid
  // out, nothing scrolls, and it's <body> itself, so `body:has(...)` counts.
  // Numbers come from arithmetic on the box's width. Asking for computed
  // margins or sizes isn't enough for this, in either API: WebKit lays the
  // whole page out for them, at its own height with Margin's rules off. Only
  // what arithmetic can't settle (`fit-content`, a flex or grid <html>) needs
  // that layout (readLaidOut), and only when what's said or the width changed.
  // With no margins at all, what the page sets for its padding stays the page's.
  let padded = false;
  let held = false; // a read started transitions in <body>'s descendants once
  let fit = '';
  let fitted = { grows: false, column: false };
  let paddingCss = '';
  const readFlag = document.createElement(READ_ELEMENT); // in the page only during a read
  const holdFlag = document.createElement(HOLD_ELEMENT);
  // Transitions a read started on what inherits from <body>: Chromium styles
  // the whole page for one read, WebKit only what's asked for. They come as
  // events in the next frame, each started and over at once (moves.js echo),
  // and from then on everything is held for a read. Not by asking the
  // document for its animations (moves.js).
  function noticeStarted(event) {
    const node = event.target;
    if (held || node === document.body || node === ctx.html || !INHERITED_INTO.test(event.propertyName)) return;
    held = true;
    writeFit();
  }
  // The page's style brought up to date before a read, style only. With
  // something still to restyle under <body> as the read's elements come in,
  // WebKit restyles it for the read and not again once they're gone: a flex
  // column's children kept shrinking (host, body-size F and O). Asking for
  // animations did this on the way; `checkVisibility` does it alone, and no
  // more (20,000 rows: the same 25 ms in WebKit as `getAnimations`, 0 if
  // nothing changed). Not `getComputedStyle`: only what's asked for, and its
  // ancestors, is brought up to date.
  const styleNow = checkVisibility ? () => void checkVisibility.call(ctx.html) : () => void computed(document.body).color;
  // Margin's rules off <body> for one read, and back, then `apply` while it's
  // still held: a change of padding mustn't start a page's transition on it.
  // Styled again in the same step: leaving that to the next paint makes WebKit's
  // next layout ten times as long (8 ms against 72 on 20,000 rows).
  function readWithout(read, keepScroll, apply) {
    const { body } = document;
    for (const fn of box.onBeforeRead) fn(); // sheets.js: the page's sheets as they'll be
    const kept = keepScroll ? ctx.scrollOf(body) : null; // laid out narrower, it may not scroll as far
    if (!held) moves.echo();
    styleNow();
    append.call(ctx.html, holdFlag, readFlag);
    try {
      read(body);
    } finally {
      remove.call(readFlag);
      if (kept) ctx.scrollInstantly(body, kept);
      void computed(body).color;
      // What's new is laid out before <body> is let go, in the one layout it
      // needs anyway: let go first, WebKit keeps its children's old width.
      if (apply()) void scrollLeft.get.call(body);
      remove.call(holdFlag);
    }
  }
  function readSaid(body) {
    const { html } = ctx;
    const style = computed(body);
    const seen = computed(body, '::backdrop');
    const lengths = [...EDGES.map((edge) => seen[`margin${edge}`]), ...EDGES.map((edge) => seen[`padding${edge}`]), ...SIZES.map((size) => seen[size])];
    ctx.chain.follow(ctx.chain.read(body));
    const collapses = ctx.chain.tops();
    const zoomed = parseFloat(computed(html).zoom) || 1;
    own.setRootZoom(zoomed);
    const whole = pixels(computed(html, '::backdrop').width, 0, parse); // the box's width, by its own rule
    // A box that doesn't simply fill the width it's given takes a layout to know.
    const block = /^(block|flow-root|flex|grid|list-item)$/.test(style.display) && style.cssFloat === 'none' && style.writingMode === 'horizontal-tb';
    return {
      lengths, collapses, whole, rootZoom: zoomed,
      // <body>'s margin meets its child's only in a plain block with nothing between them.
      meets: /^(block|list-item)$/.test(style.display) && !parseFloat(style.borderTopWidth),
      zoom: parseFloat(style.zoom) || 1,
      borders: parseFloat(seen.borderLeftWidth) + parseFloat(seen.borderRightWidth),
      boxSizing: seen.boxSizing,
      direction: style.direction,
      column: /flex/.test(style.display) && style.flexDirection.startsWith('column'),
      // Where the page moves <body> sideways by its own offset (`left: 50%`, read with the fit sheet off: the used
      // value, `right` counted in): given back with its margins (shared/body-fit.js resolve).
      offset: style.left,
      plain: whole > 0 && computed(html).display === 'block' && block && [...lengths, ...collapses].every((length) => settled(length, parse)),
    };
  }
  function readLaidOut(body, said) {
    const style = computed(body);
    const wide = isSized(said);
    const margins = EDGES.map((edge) => parseFloat(style[`margin${edge}`]) || 0);
    const paddings = EDGES.map((edge) => parseFloat(style[`padding${edge}`]) || 0);
    if (wide) {
      // What the page's width leaves over, with margins that don't take it up.
      const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const inner = style.boxSizing === 'border-box' ? 0 : paddings[1] + paddings[3] + borders;
      const spare = parseFloat(computed(ctx.html).width) / said.zoom - margins[1] - margins[3] - (parseFloat(style.width) || 0) - inner;
      if (spare > 0.5 && style.direction !== 'rtl') margins[1] += spare;
    }
    const shift = parseFloat(style.left) || 0; // the page's own offset sideways (readSaid `offset`)
    margins[3] += shift;
    margins[1] -= shift;
    margins[0] = topMargin(margins[0], said, paddings[0], parseFloat(style.width) || 0, parse);
    return { sized: wide, grows: growsIn(said), column: said.column, margins, paddings };
  }
  function writeFit() {
    const next = bodyFitCss({ ...fitted, held });
    const changed = next !== fit;
    if (changed) own.replace(own.sheets.fit, next);
    fit = next;
    return changed;
  }
  function applyBody({ sized: wide, grows, column, margins, paddings }) {
    ctx.sized = wide;
    fitted = { grows, column };
    const refit = writeFit();
    padded = margins.some(Boolean);
    // Padding can't be negative: what's less than nothing stays a margin.
    const edges = margins.map((n, i) => n + paddings[i]);
    const side = (pick) => edges.map((n) => `${pick(n, 0)}px`).join(' ');
    const padding = !padded ? '' : `@media screen { ${FITTED_BODY} { margin: ${side(Math.min)} !important; padding: ${side(Math.max)} !important; } }`;
    const repadded = padding !== paddingCss;
    if (repadded) own.replace(own.sheets.padding, padding);
    paddingCss = padding;
    return refit || repadded;
  }
  // A length on its way somewhere isn't what the page says: a read during a
  // transition or an animation of one is thrown away and made again as it ends
  // (moves.js). In the meantime it runs on <body> as it would in a window,
  // unless Margin's rule hides it. With no end to it, what shows now is all
  // there'll ever be.
  // Starts are kept for anything as deep as the first children go: a new one
  // can start moving before the next look at them (box-chain.js) finds it.
  const nearBody = (node) => {
    if (node === ctx.html) return true;
    for (let depth = 0; node && depth <= CHAIN_DEPTH; depth++, node = node.parentElement) if (node === document.body) return true;
    return false;
  };
  const moves = startMoves({
    names: (node) => (node === ctx.html || node === document.body ? READ_PROPERTY : ctx.chain.nodes().includes(node) ? CHAIN_PROPERTY : null),
    near: nearBody,
    ended: () => ctx.watch.bodyMayHaveChanged(),
    // Only this reading of its attributes is put in doubt: what others say stays known.
    settle: () => ctx.watch.settleRead(),
    styleOf: (node) => computed(node),
    keyframes: (name) => keyframesIn([...document.styleSheets, ...own.adoptedNow()], name),
    echoed: noticeStarted,
  });
  ctx.moves = moves;
  // `again`: what a layout showed before no longer holds, as when the content
  // has grown. A page known to need the layout has it in the same step, so
  // that's one trip with Margin's rules off. Returns whether anything was new.
  function measureBody(again = true) {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return false;
    if (document.fullscreenElement === body) return false; // read as it comes back (fullscreenchange)
    const inOneGo = again && !ctx.plainPage;
    let said = null;
    let changed = false;
    let next = null;
    const settle = () => !!next && applyBody(next);
    if (moves.moving()) return false;
    readWithout((element) => {
      said = readSaid(element);
      const key = JSON.stringify(said);
      changed = key !== ctx.lastSaid;
      ctx.lastSaid = key;
      const page = JSON.stringify({ ...said, whole: 0 });
      ctx.pageNew = page !== ctx.lastPage;
      ctx.lastPage = page;
      ctx.plainPage = said.plain;
      if (said.plain) {
        if (changed) next = resolve(said, parse);
      } else if (inOneGo) {
        next = readLaidOut(element, said);
      }
    }, inOneGo, settle);
    if (!said) return false;
    moves.read();
    if (!said.plain && !inOneGo && (changed || again)) readWithout((element) => { next = readLaidOut(element, said); }, true, settle);
    ctx.watch.remember(said);
    return changed;
  }
  // What was read before for the same attributes (box-watch.js), applied with
  // <body> held still.
  function applyKnown(said) {
    append.call(ctx.html, holdFlag);
    try {
      void computed(document.body).color;
      if (applyBody(resolve(said, parse))) void scrollLeft.get.call(document.body);
    } finally {
      remove.call(holdFlag);
    }
  }
  // The box off: nothing of these left.
  function reset() {
    own.replace(own.sheets.fit, '');
    own.replace(own.sheets.padding, '');
    fit = '';
    paddingCss = '';
    padded = false;
  }

  return {
    measureBody,
    applyKnown,
    reset,
    /** Margin's own, in the page only during a read. */
    ownFlag: (node) => node === readFlag || node === holdFlag,
  };
}
