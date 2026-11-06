// The box itself (shared/page-box.js): its sheets, moving it, and what a real
// window's root does that a box has to do by hand: the scroll handed to <body>
// and back, the page's scroll locks, and things put directly under <html>.
import { bodyFitCss, boxCss, FITTED_BODY, HOLD_ELEMENT, NO_BOX_CSS, READ_ELEMENT, SAID_CSS, STILL_CSS } from '../../shared/page-box.js';
import { keyframesIn, startMoves } from './moves.js';

const DEFAULT_LEFT = 260;
const FRAME = 8;
// After the last move of a drag, the page's own layout follows (sheets.js, a
// resize event): a site's layout at every step of a drag would be too much.
const REST_MS = 150;
// Reading what a page says about <body>: at most this often, twice as far apart
// after each read that found nothing new and back at once after one that did,
// at most 1/MEASURE_SHARE of the time, and never put off for longer than MEASURE_WAIT_MS.
const MEASURE_GAP_MS = 200;
const MEASURE_SHARE = 20;
const MEASURE_WAIT_MS = 1000;
// Readings kept by the attributes of <html> and <body>, for a class that comes
// and goes, and how many first children are followed down for their margins,
// out of how many looked at.
const KNOWN_READINGS = 16;
const CHAIN_DEPTH = 8;
const CHAIN_LOOK = 32;
// What a read looks at, in the names of transitions and of keyframes: on <html>
// and <body>, and on the first children. `font` and `--`: lengths in `em` or
// through a variable move with them.
const READ_PROPERTY = /^(margin|padding|border|box-?sizing|width|min-?width|max-?width|height|font|zoom|--)/i;
const CHAIN_PROPERTY = /^(margin|font|zoom|--)/i;
const INHERITED_INTO = /^(margin|padding|width|min-?width|max-?width|height|min-?height|max-?height)/i;

// `start`: where the box starts (content/page/main.js: the first paint's
// layout, or the injection's left edge, inside the frame).
/** @param {{ left?: number, top?: number, right?: number, bottom?: number }} [start] */
export function startBox({ left = DEFAULT_LEFT, top = FRAME, right = FRAME, bottom = FRAME } = {}) {
  let html = document.documentElement; // a page can replace it (rootArrived)
  // Sheets of the page's own world: `<style>` and style attributes are blocked by strict CSPs.
  const { replaceSync } = CSSStyleSheet.prototype;
  const sheet = () => new CSSStyleSheet();
  const boxSheet = sheet();
  const scrollSheet = sheet(); // how <body> scrolls (checkLocks)
  const fitSheet = sheet(); // <body>'s size in the box (measureBody)
  const paddingSheet = sheet(); // <body>'s margin as padding (measureBody)
  const zoomSheet = sheet(); // a pinch (setZoom)
  const readSheet = sheet(); // how <body> is read (readWithout, readSaid)
  const ours = [boxSheet, fitSheet, scrollSheet, paddingSheet, zoomSheet, readSheet];
  const zoom = { scale: 1, x: 0, y: 0 };
  // The browser's own, from before viewport.js speaks for the box.
  const { matches, append, remove, checkVisibility } = Element.prototype;
  const computed = window.getComputedStyle;
  const parseLength = window.CSSNumericValue?.parse; // absent: NaN, and a layout tells (pixels)
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
  const scrollOf = (node) => ({ x: scrollLeft.get.call(node), y: scrollTop.get.call(node) });
  function scrollTo(node, { x, y }) {
    if (scrollLeft.get.call(node) !== x) scrollLeft.set.call(node, x);
    if (scrollTop.get.call(node) !== y) scrollTop.set.call(node, y);
  }
  // A page's `scroll-behavior: smooth` would show as a climb from the top.
  const { scrollTo: scrollElement } = Element.prototype;
  function scrollInstantly(node, { x, y }) {
    if (scrollLeft.get.call(node) !== x || scrollTop.get.call(node) !== y) scrollElement.call(node, { left: x, top: y, behavior: 'instant' });
  }
  let refused = false; // a frameset: nothing to scroll, no box

  // `sizes`: the box at rest, as the page's layout knows it. `offset`: where
  // its origin is in the window, and its scale: what coordinates go through.
  const box = {
    on: true,
    left, top, right, bottom,
    dw: left + right, dh: top + bottom,
    scale: 1, x: left, y: top,
    ours,
    body: () => document.body ?? html,
    // Full screen is the whole window again, read live: the resize that goes
    // with it can reach a page before `fullscreenchange` does. dw and dh stay
    // what they are, for the box it comes back to.
    boxed: () => box.on && !document.fullscreenElement,
    /** How much smaller than the window the page's world is told it is. */
    seenW: () => (box.boxed() ? box.dw : 0),
    seenH: () => (box.boxed() ? box.dh : 0),
    /** A rectangle in the window, in the page's coordinates (set by coords.js). @type {(rect: any) => any} */
    toPage: (rect) => rect,
    /** Runs at once on every move. @type {((before: { dw: number, dh: number }) => void)[]} */
    onMove: [],
    /** Runs once a move has rested, for the page's own layout. @type {((before: { dw: number, dh: number }) => void)[]} */
    onRest: [],
    /** Runs when the box comes on or goes off. @type {(() => void)[]} */
    onToggle: [],
    /** Runs when a <body> arrives, the first or one the page swapped in. @type {(() => void)[]} */
    onBody: [],
    /** Runs first when a hidden tab catches up before it's shown (catchUp). @type {(() => void)[]} */
    onCatchUp: [],
    /** The page's styles changed: what it says about <body> is read again. */
    bodyMayHaveChanged,
    /** A rule was edited, whether or not it reaches <body> now: it might once a class changes. */
    rulesEdited: () => known.clear(),
    /** What a rule has to match to matter to a read: see sheets.js. */
    reachable: () => [html, document.body, ...chain.nodes],
    /** Runs after each read of the page. @type {(() => void)[]} */
    onRead: [],
    childrenChanged,
    /** Margin's own, in the page only during a read. */
    ownFlag: (node) => node === readFlag || node === holdFlag,
    loaded,
    set,
  };

  // Never dropped by a page that assigns its own list, or edits the one it has,
  // which goes through a proxy of it, one that lets the page's edits be seen.
  const adopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
  const adopt = () => adopted.set.call(document, [...adopted.get.call(document).filter((s) => !ours.includes(s)), ...ours]);
  let adoptDue = false;
  function adoptedEdited() {
    if (adoptDue) return;
    adoptDue = true;
    queueMicrotask(() => {
      adoptDue = false;
      adopt();
      box.bodyMayHaveChanged();
    });
  }
  const edit = (act) => (...args) => {
    const done = act(...args);
    adoptedEdited();
    return done;
  };
  const adoptedView = new Proxy(adopted.get.call(document), { set: edit(Reflect.set), deleteProperty: edit(Reflect.deleteProperty) });
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    enumerable: true,
    get() { return adoptedView; },
    set(list) {
      adopted.set.call(this, [...[...list].filter((s) => !ours.includes(s)), ...ours]);
      box.bodyMayHaveChanged();
    },
  });
  let rootZoom = 1; // the page's `zoom` on <html> (readSaid)
  const write = () => replaceSync.call(boxSheet, box.on ? boxCss(box, rootZoom) : NO_BOX_CSS);
  function setRootZoom(next) {
    if (next === rootZoom) return;
    rootZoom = next;
    write();
  }
  write();
  replaceSync.call(fitSheet, bodyFitCss());
  replaceSync.call(readSheet, `${STILL_CSS} ${SAID_CSS}`);
  adopt();

  // ---- <body>'s scrolling and the page's locks --------------------------------
  // What the page says about overflow reads back as computed style: html's
  // rule here has no weight (:where), and body's is only added once it says
  // nothing. Read, rather than a sheet taken away to look, which makes a large
  // page lay out again (69 ms on Reddit).
  let scrollCss = '';
  let wasPinned = false;
  // Our rule on each side: what it sets, and whether it has to win.
  const rule = { x: { value: '', said: '', forced: false, force: false }, y: { value: '', said: '', forced: false, force: false } };
  function checkLocks() {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return;
    if (zoom.scale !== 1) return; // a pinch clips <html>: looked at when it ends (setZoom)
    const root = getComputedStyle(html);
    // A lock that pins <body> (fixed, top: -Ypx) can't be read in computed style
    // (the box's rule holds it relative) and doesn't stop <body> scrolling: its
    // style attribute says so, and <body> is locked where it is.
    const pinned = body.style.position === 'fixed' || parseFloat(body.style.top) < 0;
    if (wasPinned && !pinned) { // our lock mustn't read as the page's
      replaceSync.call(scrollSheet, '');
      scrollCss = '';
    }
    wasPinned = pinned;
    const own = getComputedStyle(body);
    // One side's rule. What the page says shows, unless it's our own rule's
    // value, which stands for the page saying nothing. Forced, its value hides
    // what the page says: what it said then stands.
    const side = (mine, shown, rootSays) => {
      const said = mine.forced ? mine.said : mine.value && shown === mine.value ? 'visible' : shown;
      // Nothing said: as <html> says. It locks the window: locked with it.
      if (said === 'visible') Object.assign(mine, { value: rootSays === 'hidden' ? 'hidden' : 'auto', said, forced: mine.force });
      // <html> scrolls and body only clips: in the box, body is what scrolls.
      else if (said === 'hidden' && /auto|scroll/.test(rootSays)) Object.assign(mine, { value: 'auto', said, forced: true });
      else Object.assign(mine, { value: '', said, forced: false, force: false });
      return mine.value && `${mine.value}${mine.forced ? ' !important' : ''}`;
    };
    const y = pinned ? 'hidden !important' : side(rule.y, own.overflowY, root.overflowY);
    const x = side(rule.x, own.overflowX, root.overflowX);
    const parts = [y && `overflow-y: ${y}`, x && `overflow-x: ${x}`].filter(Boolean);
    // No weight, so the page's own rule can be seen; forced, it has to beat
    // even a page's `body { overflow: visible !important }`.
    const forced = pinned || rule.x.forced || rule.y.forced;
    const css = parts.length ? `@media screen { ${forced ? 'html > body:where(:first-of-type)' : ':where(html > body:where(:first-of-type))'} { ${parts.join('; ')} } }` : '';
    if (css !== scrollCss) replaceSync.call(scrollSheet, css);
    scrollCss = css;
    // A page's own `overflow: visible` beats a rule with no weight: said again, to win.
    const after = getComputedStyle(body);
    if (pinned) return;
    const lost = (mine, shown) => !!mine.value && !mine.forced && shown === 'visible';
    if (!lost(rule.y, after.overflowY) && !lost(rule.x, after.overflowX)) return;
    rule.y.force ||= lost(rule.y, after.overflowY);
    rule.x.force ||= lost(rule.x, after.overflowX);
    checkLocks();
  }

  // <body> fills the box and scrolls, so what the page says about its size and
  // margins comes back as a height rule and as padding. To read that, Margin's
  // rules come off <body> for a moment (readWithout). Lengths come from readSaid:
  // style only, so nothing is laid out, nothing scrolls, and it's <body> itself,
  // so `body:has(...)` counts. Numbers come from arithmetic on the box's width.
  // Asking for computed margins or sizes isn't enough for this, in either API:
  // WebKit lays the whole page out for them, at its own height with Margin's
  // rules off. Only what arithmetic can't settle (`fit-content`, a flex or grid
  // <html>) needs that layout (readLaidOut), and only when what's said or the
  // width changed.
  // With no margins at all, what the page sets for its padding stays the page's.
  let padded = false;
  let sized = false;
  let held = false; // a read started transitions in <body>'s descendants once
  let fit = '';
  let fitted = { grows: false, column: false };
  let paddingCss = '';
  let lastSaid = '';
  let lastPage = ''; // the same, without the box's width
  let pageNew = false; // the last read found something new the page says, the box's width aside
  let plainPage = true;
  const EDGES = ['Top', 'Right', 'Bottom', 'Left'];
  const SIZES = ['width', 'minWidth', 'maxWidth', 'height'];
  const readFlag = document.createElement(READ_ELEMENT); // in the page only during a read
  const holdFlag = document.createElement(HOLD_ELEMENT);
  const NOT_IN_FLOW = 'dialog, [popover], :fullscreen';
  // Transitions a read started on what inherits from <body>: Chromium styles
  // the whole page for one read, WebKit only what's asked for. They come as
  // events in the next frame, each started and over at once (moves.js echo),
  // and from then on everything is held for a read. Not by asking the
  // document for its animations (moves.js).
  function noticeStarted(event) {
    const node = event.target;
    if (held || node === document.body || node === html || !INHERITED_INTO.test(event.propertyName)) return;
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
  const styleNow = checkVisibility ? () => void checkVisibility.call(html) : () => void computed(document.body).color;
  // Margin's rules off <body> for one read, and back, then `apply` while it's
  // still held: a change of padding mustn't start a page's transition on it.
  // Styled again in the same step: leaving that to the next paint makes WebKit's
  // next layout ten times as long (8 ms against 72 on 20,000 rows).
  function readWithout(read, keepScroll, apply) {
    const { body } = document;
    const kept = keepScroll ? scrollOf(body) : null; // laid out narrower, it may not scroll as far
    if (!held) moves.echo();
    styleNow();
    append.call(html, holdFlag, readFlag);
    try {
      read(body);
    } finally {
      remove.call(readFlag);
      if (kept) scrollInstantly(body, kept);
      void computed(body).color;
      // What's new is laid out before <body> is let go, in the one layout it
      // needs anyway: let go first, WebKit keeps its children's old width.
      if (apply()) void scrollLeft.get.call(body);
      remove.call(holdFlag);
    }
  }
  // A length as the page wrote it, in pixels of `whole`: NaN if it takes a
  // layout to know, as `auto` and `fit-content` do.
  function pixels(value, whole) {
    if (value.endsWith('px')) return parseFloat(value);
    if (!value.includes('(')) return value.endsWith('%') ? (parseFloat(value) * whole) / 100 : NaN;
    try { // calc(), min(), clamp(): the browser's own arithmetic, once percents are lengths
      return parseLength(value.replace(/[-+]?[\d.]+(?:e[-+]?\d+)?%/g, (n) => `${(parseFloat(n) * whole) / 100}px`)).to('px').value;
    } catch {
      return NaN;
    }
  }
  const settled = (value) => value === 'auto' || value === 'none' || !Number.isNaN(pixels(value, 0));
  // What <body>'s top margin collapses with, in a window: the first in-flow
  // child's, and that one's first child's while nothing stands between them.
  // Followed (watchChain) so that a class or a new first child is read. `path`:
  // each element the walk left, by going down or to the next one past it. `end`:
  // where it stopped, null if for want of an element.
  /** @type {{ nodes: Element[], tops: string[], path: { node: Element, down: boolean }[], end: Element | null }} */
  let chain = { nodes: [], tops: [], path: [], end: null };
  const textBefore = (parent, node) => {
    for (let text = parent.firstChild; text && text !== node; text = text.nextSibling) if (text.nodeType === 3 && text.data.trim()) return true;
    return false;
  };
  function readChain(body) {
    const nodes = [];
    const tops = [];
    const path = [];
    let parent = body;
    let node = body.firstElementChild;
    while (node && nodes.length < CHAIN_DEPTH && path.length < CHAIN_LOOK && !textBefore(parent, node)) {
      const style = computed(node);
      if (style.display === 'none' || style.cssFloat !== 'none' || /absolute|fixed/.test(style.position) || matches.call(node, NOT_IN_FLOW)) {
        path.push({ node, down: false });
        node = node.nextElementSibling;
        continue;
      }
      // Layout containment: its margins stay its own, whatever they are.
      if (style.display.startsWith('inline') || /layout|paint|strict|content/.test(style.contain)) break;
      nodes.push(node);
      tops.push(computed(node, '::backdrop').marginTop);
      if (!/^(block|list-item)$/.test(style.display) || !/visible|clip/.test(style.overflowY) || parseFloat(style.paddingTop) || parseFloat(style.borderTopWidth)) break;
      path.push({ node, down: true });
      parent = node;
      node = node.firstElementChild;
    }
    return { nodes, tops, path, end: node };
  }
  // A margin collapsed with others, as CSS 2 §8.3.1 adds them up.
  const collapsed = (list) => Math.max(0, ...list) + Math.min(0, ...list);
  function readSaid(body) {
    const style = computed(body);
    const seen = computed(body, '::backdrop');
    const lengths = [...EDGES.map((edge) => seen[`margin${edge}`]), ...EDGES.map((edge) => seen[`padding${edge}`]), ...SIZES.map((size) => seen[size])];
    follow(readChain(body));
    const collapses = chain.tops;
    const zoomed = parseFloat(computed(html).zoom) || 1;
    setRootZoom(zoomed);
    const whole = pixels(computed(html, '::backdrop').width, 0); // the box's width, by its own rule
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
      plain: whole > 0 && computed(html).display === 'block' && block && [...lengths, ...collapses].every(settled),
    };
  }
  // `sized`: its margins or size depend on the box's width.
  function isSized({ lengths }) {
    const [, right, , left, , , , , width, , maxWidth] = lengths;
    return !left.endsWith('px') || !right.endsWith('px') || width !== 'auto' || maxWidth !== 'none' || lengths.slice(0, -1).some((length) => length.includes('%'));
  }
  const growsIn = ({ lengths }) => lengths.at(-1) === 'auto';
  // A margin can't collapse with the first child's as padding does: only what
  // it adds to theirs stays, which can be less than nothing.
  function topMargin(top, { meets, collapses }, padding, width) {
    if (!meets || padding) return top;
    const tops = collapses.map((length) => pixels(length, width) || 0);
    return collapsed([top, ...tops]) - collapsed(tops);
  }
  // The width equation of CSS 2 §10.3.3, for a block in <html>. In <body>'s own
  // pixels: `zoom` scales what it says and the padding that comes back alike.
  function resolve(said) {
    const { lengths, borders, boxSizing, direction, column, zoom } = said;
    const whole = said.whole / zoom;
    const [top, right, bottom, left, ...rest] = lengths.map((length) => pixels(length, whole));
    const paddings = rest.slice(0, 4).map((n) => n || 0);
    const [width, minWidth, maxWidth] = rest.slice(4);
    const extra = paddings[1] + paddings[3] + borders;
    const inner = boxSizing === 'border-box' ? 0 : extra;
    const asked = Number.isNaN(width) ? whole - (left || 0) - (right || 0) : width + inner;
    const used = Math.max(Number.isNaN(maxWidth) ? asked : Math.min(asked, maxWidth + inner), (minWidth || 0) + inner);
    const free = whole - used;
    const margins = [top || 0, right, bottom || 0, left];
    if (Number.isNaN(left) && Number.isNaN(right)) margins[1] = margins[3] = Math.max(0, free / 2);
    else if (Number.isNaN(left)) margins[3] = Math.max(0, free - right);
    else if (Number.isNaN(right)) margins[1] = Math.max(0, free - left);
    else if (direction === 'rtl') margins[3] = Math.max(left, free - right);
    else margins[1] = Math.max(right, free - left);
    margins[0] = topMargin(margins[0], said, paddings[0], used - extra);
    return { sized: isSized(said), grows: growsIn(said), column, margins, paddings };
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
      const spare = parseFloat(computed(html).width) / said.zoom - margins[1] - margins[3] - (parseFloat(style.width) || 0) - inner;
      if (spare > 0.5 && style.direction !== 'rtl') margins[1] += spare;
    }
    margins[0] = topMargin(margins[0], said, paddings[0], parseFloat(style.width) || 0);
    return { sized: wide, grows: growsIn(said), column: said.column, margins, paddings };
  }
  function writeFit() {
    const next = bodyFitCss({ ...fitted, held });
    const changed = next !== fit;
    if (changed) replaceSync.call(fitSheet, next);
    fit = next;
    return changed;
  }
  function applyBody({ sized: wide, grows, column, margins, paddings }) {
    sized = wide;
    fitted = { grows, column };
    const refit = writeFit();
    padded = margins.some(Boolean);
    // Padding can't be negative: what's less than nothing stays a margin.
    const edges = margins.map((n, i) => n + paddings[i]);
    const side = (pick) => edges.map((n) => `${pick(n, 0)}px`).join(' ');
    const padding = !padded ? '' : `@media screen { ${FITTED_BODY} { margin: ${side(Math.min)} !important; padding: ${side(Math.max)} !important; } }`;
    const repadded = padding !== paddingCss;
    if (repadded) replaceSync.call(paddingSheet, padding);
    paddingCss = padding;
    return refit || repadded;
  }
  // A length on its way somewhere isn't what the page says: a read during a
  // transition or an animation of one is thrown away and made again as it ends
  // (moves.js). In the meantime it runs on <body> as it would in a window,
  // unless Margin's rule hides it. With no end to it, what shows now is all
  // there'll ever be.
  // Starts are kept for anything as deep as the first children go: a new one
  // can start moving before the next look at them (chainCheck) finds it.
  const nearBody = (node) => {
    if (node === html) return true;
    for (let depth = 0; node && depth <= CHAIN_DEPTH; depth++, node = node.parentElement) if (node === document.body) return true;
    return false;
  };
  const moves = startMoves({
    names: (node) => (node === html || node === document.body ? READ_PROPERTY : chain.nodes.includes(node) ? CHAIN_PROPERTY : null),
    near: nearBody,
    ended: () => bodyMayHaveChanged(),
    // Only this reading of its attributes is put in doubt: what others say stays known.
    settle: () => {
      known.delete(attributesNow());
      readAt.stale = true;
      measureSoon();
    },
    styleOf: (node) => computed(node),
    keyframes: (name) => keyframesIn([...document.styleSheets, ...adopted.get.call(document)], name),
    echoed: noticeStarted,
  });
  // `again`: what a layout showed before no longer holds, as when the content
  // has grown. A page known to need the layout has it in the same step, so
  // that's one trip with Margin's rules off. Returns whether anything was new.
  function measureBody(again = true) {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return false;
    if (document.fullscreenElement === body) return false; // read as it comes back (fullscreenchange)
    const inOneGo = again && !plainPage;
    let said = null;
    let changed = false;
    let next = null;
    const settle = () => !!next && applyBody(next);
    if (moves.moving()) return false;
    readWithout((element) => {
      said = readSaid(element);
      const key = JSON.stringify(said);
      changed = key !== lastSaid;
      lastSaid = key;
      const page = JSON.stringify({ ...said, whole: 0 });
      pageNew = page !== lastPage;
      lastPage = page;
      plainPage = said.plain;
      if (said.plain) {
        if (changed) next = resolve(said);
      } else if (inOneGo) {
        next = readLaidOut(element, said);
      }
    }, inOneGo, settle);
    if (!said) return false;
    moves.read();
    if (!said.plain && !inOneGo && (changed || again)) readWithout((element) => { next = readLaidOut(element, said); }, true, settle);
    remember(said);
    return changed;
  }

  // What a page has said for these attributes, as long as nothing but the
  // attributes changed: a class that comes and goes costs two reads, and then
  // none. Sheets, rules, the first child, `:has()` or the box's width changing
  // forgets all of it (stale).
  const known = new Map();
  let readAt = { attributes: '', sheets: -1, first: /** @type {Element | null} */ (null), stale: true };
  const attributesNow = () => `${attributesOf(html)} ${attributesOf(document.body)}`;
  function remember(said) {
    const attributes = attributesNow();
    readAt = { attributes, sheets: document.styleSheets.length, first: document.body.firstElementChild, stale: false };
    if (said.plain) {
      if (known.size >= KNOWN_READINGS) known.clear();
      known.set(attributes, { said, key: lastSaid });
    }
    for (const fn of box.onRead) fn();
  }
  function stale() {
    known.clear();
    readAt.stale = true;
    measureGap = MEASURE_GAP_MS;
  }
  function useKnown({ said, key }) {
    lastSaid = key;
    lastPage = JSON.stringify({ ...said, whole: 0 });
    readAt.attributes = attributesNow();
    setRootZoom(said.rootZoom);
    append.call(html, holdFlag);
    try {
      void computed(document.body).color;
      if (applyBody(resolve(said))) void scrollLeft.get.call(document.body);
    } finally {
      remove.call(holdFlag);
    }
  }
  // At the end of parsing and at `load`: a page that needs a layout always, as
  // its width follows the content, and any other only if something changed.
  const nothingSince = () => !readAt.stale && readAt.attributes === attributesNow() && readAt.first === document.body?.firstElementChild && readAt.sheets === document.styleSheets.length;
  function loaded() {
    if (!box.on || !document.body) return;
    bodyArrived();
    if (!plainPage || !nothingSince()) measureBody();
    checkLocks();
  }

  // Apps bring their styles after `load`, by a script, so what was read may no
  // longer be what the page says: read again when its styles change, before
  // the next paint. Out of sight it waits to be shown.
  let measureDue = false;
  let measureTimer = 0;
  let measureFrame = 0;
  let measureAt = 0;
  let measureCost = 0;
  let measureGap = MEASURE_GAP_MS;
  function runMeasure() {
    measureFrame = 0;
    measureDue = false;
    if (nothingSince()) return; // a read came first: the end of parsing, `load`, a moved box
    const reading = known.get(attributesNow());
    if (reading && document.fullscreenElement !== document.body) return useKnown(reading);
    const started = performance.now();
    pageNew = false;
    const changed = measureBody(false);
    moves.found(pageNew);
    measureGap = changed ? MEASURE_GAP_MS : Math.min(MEASURE_WAIT_MS, measureGap * 2);
    checkLocks();
    measureAt = performance.now();
    measureCost = measureAt - started;
  }
  function measureSoon() {
    if (!box.on || measureFrame) return;
    const reading = known.get(attributesNow());
    if (reading?.key === lastSaid) return; // these attributes say what's already in force
    measureDue = true;
    if (document.hidden) return;
    clearTimeout(measureTimer);
    const wait = reading ? 0 : Math.max(0, measureAt + Math.min(MEASURE_WAIT_MS, Math.max(measureGap, measureCost * MEASURE_SHARE)) - performance.now());
    measureTimer = setTimeout(() => { measureFrame = requestAnimationFrame(runMeasure); }, wait);
  }
  function bodyMayHaveChanged() {
    stale();
    measureSoon();
  }

  // The first children whose margins count: a class on one, or a new one, is
  // looked at once a frame, with no read unless their margins changed. Only
  // attributes are observed on them: what's added and removed already comes
  // to the one observer of the document (sheets.js).
  let chainFrame = 0;
  function chainCheck() {
    chainFrame = 0;
    const { body } = document;
    if (!body || !box.on) return;
    const now = readChain(body);
    const moved = now.tops.join() !== chain.tops.join() || now.nodes.length !== chain.nodes.length || now.nodes.some((node, i) => node !== chain.nodes[i]);
    follow(now);
    if (moved && !moves.moving()) bodyMayHaveChanged(); // a margin at the start of its way shows no change yet: read as it ends
  }
  function chainTouched() {
    chainFrame ||= requestAnimationFrame(chainCheck);
  }
  const chainWatch = new MutationObserver(chainTouched);
  let chainBody = null;
  const onChain = ({ path, end }) => [...path.map((step) => step.node), ...(end ? [end] : [])];
  function follow(next) {
    const before = onChain(chain);
    const after = onChain(next);
    const same = after.length === before.length && after.every((node, i) => node === before[i]) && chainBody === document.body;
    chain = next;
    if (same) return;
    chainBody = document.body;
    chainWatch.disconnect();
    for (const node of after) chainWatch.observe(node, { attributes: true });
  }
  // Children came or went somewhere in the page: did they on the chain's walk?
  function childrenChanged() {
    rootArrived();
    let node = document.body?.firstElementChild;
    if (node === undefined) return;
    for (const { node: step, down } of chain.path) {
      if (node !== step) return chainTouched();
      node = down ? step.firstElementChild : step.nextElementSibling;
    }
    if (node !== chain.end) chainTouched();
  }

  // What <html>'s and <body>'s class and style say can lock the page. At most
  // once a frame, and not if neither changed.
  let lockKey = '';
  let lockFrame = 0;
  const attributesOf = (node) => (node ? Array.from(node.attributes, ({ name, value }) => `${name}=${value}`).join(' ') : '');
  const lockChanged = () => {
    const key = `${attributesOf(html)} ${attributesOf(document.body)}`;
    if (key === lockKey) return;
    lockKey = key;
    measureSoon(); // any attribute can select what <body>'s size and margins are
    lockFrame ||= requestAnimationFrame(locksCheck);
  };
  function locksCheck() {
    lockFrame = 0;
    checkLocks();
  }
  const locks = new MutationObserver(lockChanged);
  const LOCK_OPTIONS = { attributes: true };
  locks.observe(html, LOCK_OPTIONS);

  // An absolute element a page puts directly under <html> is placed against
  // the document, which scrolls: it would stay put here, so it goes in <body>.
  const adoptChild = (node) => {
    if (!box.on || !document.body || node === document.body || node.nodeType !== 1 || node.parentNode !== html) return;
    if (/^(head|body|script|style|link|meta|margin-.*)$/.test(node.localName)) return;
    if (getComputedStyle(node).position === 'absolute') document.body.append(node);
  };
  // The <body> in the page: the first one, or one the page swapped in (Turbo
  // and the like), with a margin and locks of its own.
  let bodyNow = null;
  function bodyArrived() {
    const { body } = document;
    if (!body || body === bodyNow) return;
    if (body.localName !== 'body') { // a frameset
      off();
      refused = true;
      return;
    }
    bodyNow = body;
    locks.observe(body, LOCK_OPTIONS);
    replaceSync.call(scrollSheet, ''); // what's said about the old one mustn't read as the new one's
    scrollCss = '';
    for (const mine of [rule.x, rule.y]) Object.assign(mine, { value: '', said: '', forced: false, force: false });
    stale();
    measureBody();
    checkLocks();
    for (const fn of box.onBody) fn();
  }
  function childrenAdded(records) {
    bodyArrived();
    if (!bodyNow) return;
    for (const record of records) for (const node of record.addedNodes) queueMicrotask(() => adoptChild(node));
  }
  const children = new MutationObserver(childrenAdded);
  const CHILDREN = { childList: true };
  children.observe(html, CHILDREN);
  // A new <html>: `document.write`, `document.open`, a framework that rendered
  // the whole document again. Margin's rules go by selector, so they hold; what
  // was watched on the old one has to be watched on this one.
  function rootArrived() {
    const root = document.documentElement;
    if (!root || root === html) return;
    html = root;
    locks.observe(html, LOCK_OPTIONS);
    children.observe(html, CHILDREN);
    bodyArrived();
  }
  // A body sized in percent, or centred, follows the window, at most once a
  // frame. Any other can be crossing a media query or changing with `vw`.
  let resizeFrame = 0;
  addEventListener('resize', (event) => {
    if (!event.isTrusted) return;
    if (!sized) return bodyMayHaveChanged();
    stale();
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(resized);
  });
  function resized() {
    resizeFrame = 0;
    measureBody();
  }

  // ---- moving it ---------------------------------------------------------------
  // The page's own layout follows when the box rests, and once it's in sight:
  // a hidden tab catches up as it's shown.
  let restTimer = 0;
  let restFrom = null;
  function rest(resizeLater = false) {
    clearTimeout(restTimer);
    restTimer = 0;
    if (!restFrom) return;
    const before = restFrom;
    restFrom = null;
    for (const fn of box.onRest) fn(before);
    stale();
    measureBody(sized); // a media query moved, and a body with auto margins is centred in the new width
    if (resizeLater) tellResizeSoon();
    else tellResize();
  }
  // The page's own resize listeners, told the box moved. From a hidden tab's
  // catch-up (below), in a task of their own: the background waits for that
  // preparation, and a page slow to answer (1.2 s in the WebKit host) made it
  // late, cancelled, the switch 4 s long. A message to itself, which WebKit
  // doesn't hold back in a hidden page as it may a timer: before the show, or
  // at the latest as it's shown.
  /** @type {MessageChannel | null} */
  let resizeOwed = null;
  function tellResize() {
    if (resizeOwed) {
      resizeOwed.port1.close();
      resizeOwed = null;
    }
    dispatchEvent(new Event('resize'));
  }
  function tellResizeSoon() {
    if (resizeOwed) return;
    resizeOwed = new MessageChannel();
    resizeOwed.port1.onmessage = tellResize;
    resizeOwed.port2.postMessage(0);
  }
  function restSoon(before, live) {
    restFrom ??= before;
    clearTimeout(restTimer);
    if (document.hidden) return;
    if (live) restTimer = setTimeout(rest, REST_MS);
    else rest();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    rest();
    if (resizeOwed) tellResize();
    if (measureDue) measureSoon();
  });
  // A hidden tab about to be shown (content/core.js prepareForShow): what
  // waits for it to come into sight is done now, out of sight, so its first
  // frame has it, rather than a frame or more after, and its first rendering
  // update has none of it to do: changes made in this very turn and not yet
  // told (the preparation's own, a cover's style on <body>), new sheets
  // rewritten for the box and `:has()` asked (sheets.js), the first children
  // looked at, a move rested (its media queries and a read; the page's resize
  // event right after), a resize's read, a read the page's styles asked for,
  // its locks. A frame a hidden page put off doesn't come till it's shown
  // (WebKit).
  const runNow = (frame, run) => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    run();
  };
  function catchUp() {
    if (!document.hidden) return;
    const told = [locks, children, chainWatch].map((observer) => observer.takeRecords());
    if (told[1].length) childrenAdded(told[1]);
    if (told[2].length) chainTouched();
    if (told[0].length) lockChanged();
    for (const fn of box.onCatchUp) fn();
    runNow(chainFrame, chainCheck);
    rest(true);
    runNow(resizeFrame, resized);
    if (measureDue) {
      clearTimeout(measureTimer);
      cancelAnimationFrame(measureFrame);
      runMeasure();
    }
    runNow(lockFrame, locksCheck);
  }
  // In and out of full screen, what the page's world is told changes with no
  // move of the box: its media queries and lists follow now, not after a delay.
  document.addEventListener('fullscreenchange', () => {
    if (!box.on) return;
    clearTimeout(restTimer);
    restFrom ??= { dw: box.dw, dh: box.dh };
    rest();
    bodyMayHaveChanged();
  });

  function on(next, live) {
    const wasOn = box.on;
    rootArrived();
    if (wasOn && next.left === box.left && next.top === box.top && next.right === box.right && next.bottom === box.bottom) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = wasOn ? null : scrollOf(html);
    Object.assign(box, next, { on: true, dw: next.left + next.right, dh: next.top + next.bottom });
    place();
    write();
    if (!wasOn) {
      measureBody();
      checkLocks();
      scrollTo(box.body(), scrolled);
      for (const fn of box.onToggle) fn();
    }
    for (const fn of box.onMove) fn(before);
    restSoon(before, live);
  }
  function off() {
    if (!box.on) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = scrollOf(box.body());
    setZoom(1, 0, 0);
    Object.assign(box, { on: false, left: 0, top: 0, right: 0, bottom: 0, dw: 0, dh: 0 });
    place();
    write();
    for (const emptied of [fitSheet, scrollSheet, paddingSheet]) replaceSync.call(emptied, '');
    scrollCss = '';
    fit = '';
    paddingCss = '';
    lastSaid = '';
    stale();
    for (const mine of [rule.x, rule.y]) Object.assign(mine, { value: '', said: '', forced: false, force: false });
    padded = false;
    scrollTo(html, scrolled);
    for (const fn of box.onToggle) fn();
    for (const fn of box.onMove) fn(before);
    restSoon(before, false);
  }

  // ---- a pinch (content/pinch.js) ---------------------------------------------
  // The page scaled at <html>, so what's fixed scales with it, moved by (x, y)
  // from the box's corner. `will-change` only during a pinch: at rest WebKit
  // draws the page again at the zoom.
  function place() {
    box.x = box.left + zoom.x;
    box.y = box.top + zoom.y;
    box.scale = zoom.scale;
  }
  function setZoom(scale, x, y, moving = false) {
    const ended = zoom.scale !== 1 && scale === 1;
    Object.assign(zoom, { scale, x, y });
    place();
    const transform = `transform: translate(${box.x}px, ${box.y}px) scale(${scale}) !important;`;
    replaceSync.call(zoomSheet, scale === 1 ? '' : `@media screen { html { ${transform} ${moving ? 'will-change: transform !important;' : ''} overflow: clip !important; } }`);
    if (ended) checkLocks();
  }
  place();

  // ---- the bridge ---------------------------------------------------------------
  // Margin's isolated world (content/page-link.js), synchronously: a string in
  // `detail`, "off", or "catch-up" (a copy of this script from before it
  // ignores that). Cancelled to say this world heard it. Kept as it is: an
  // updated Margin talks to a copy of this script still in open pages. A page
  // sending these only moves its own layout.
  function set(message) {
    if (message === 'off') return void off();
    if (message === 'catch-up') return void catchUp();
    let next;
    try {
      next = JSON.parse(message);
    } catch {
      return;
    }
    if (!(next?.left >= 0) || refused) return;
    on({ left: next.left, top: next.top, right: next.right, bottom: next.bottom }, !!next.live);
    if (next.scale != null) setZoom(next.scale, next.tx ?? 0, next.ty ?? 0, !!next.moving);
  }
  document.addEventListener('margin:box', (event) => {
    event.preventDefault();
    set(/** @type {CustomEvent} */ (event).detail);
  });
  bodyArrived();
  return box;
}
