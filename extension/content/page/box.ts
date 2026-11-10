// The box itself (shared/page-box.ts): where it is, moving it, and the bridge
// from Margin's world. What a real window's root does that a box has to do by
// hand is in its parts, each started here and sharing `ctx` (below):
//   box-own-sheets.ts  Margin's sheets in the page, adopted and kept
//   box-locks.ts       <body>'s scrolling, the page's scroll locks, <body>'s background
//   box-body.ts        what the page says about <body>'s size and margins, read and applied
//                      (the arithmetic: shared/body-fit.ts)
//   box-chain.ts       the first children whose top margins count with <body>'s
//   box-watch.ts       when to read again: attributes, children, a new <body> or <html>, resizes
// What the box promises, and every page pattern it handles: tests/box/README.md.
import type { Accessor } from './accessor.ts';
import { createOwnSheets } from './box-own-sheets.ts';
import { startLocks } from './box-locks.ts';
import { startBody } from './box-body.ts';
import { startChain } from './box-chain.ts';
import { startWatch } from './box-watch.ts';

const DEFAULT_LEFT = 260;
const FRAME = 8;
// After the last move of a drag, the page's own layout follows (sheets.ts, a
// resize event): a site's layout at every step of a drag would be too much.
const REST_MS = 150;

// `start`: where the box starts (content/page/main.ts: the first paint's
// layout, or the injection's left edge, inside the frame).
// The box: where the page's box is, what it's told, and the hooks its parts add (main.ts starts them with it).
export type Box = ReturnType<typeof startBox>;

export function startBox({ left = DEFAULT_LEFT, top = FRAME, right = FRAME, bottom = FRAME }: { left?: number, top?: number, right?: number, bottom?: number } = {}) {
  // The browser's own, from before viewport.ts speaks for the box.
  const { matches, append, remove, checkVisibility } = Element.prototype;
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') as Accessor;
  const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft') as Accessor;
  const native = {
    matches, append, remove, checkVisibility, scrollTop, scrollLeft,
    computed: window.getComputedStyle,
    parseLength: window.CSSNumericValue?.parse, // absent: NaN, and a layout tells (shared/body-fit.ts pixels)
  };
  const scrollOf = (node: HTMLElement) => ({ x: scrollLeft.get.call(node), y: scrollTop.get.call(node) });
  function scrollTo(node: HTMLElement, { x, y }: { x: any; y: any; }) {
    if (scrollLeft.get.call(node) !== x) scrollLeft.set.call(node, x);
    if (scrollTop.get.call(node) !== y) scrollTop.set.call(node, y);
  }
  // A page's `scroll-behavior: smooth` would show as a climb from the top.
  const { scrollTo: scrollElement }: { scrollTo: (this: Element, options: ScrollToOptions) => void } = Element.prototype; // (the form used here)
  function scrollInstantly(node: Element, { x, y }: { x: number, y: number }) {
    if (scrollLeft.get.call(node) !== x || scrollTop.get.call(node) !== y) scrollElement.call(node, { left: x, top: y, behavior: 'instant' });
  }
  const own = createOwnSheets();

  // `sizes`: the box at rest, as the page's layout knows it. `offset`: where
  // its origin is in the window, and its scale: what coordinates go through.
  const box = {
    on: true,
    left, top, right, bottom,
    dw: left + right, dh: top + bottom,
    scale: 1, x: left, y: top,
    ours: own.ours,
    body: () => document.body ?? ctx.html,
    // Full screen is the whole window again, read live: the resize that goes
    // with it can reach a page before `fullscreenchange` does. dw and dh stay
    // what they are, for the box it comes back to.
    boxed: () => box.on && !document.fullscreenElement,
    /** How much smaller than the window the page's world is told it is. */
    seenW: () => (box.boxed() ? box.dw : 0),
    seenH: () => (box.boxed() ? box.dh : 0),
    /** A rectangle in the window, in the page's coordinates (set by coords.ts). */
    toPage: ((rect) => rect) as (rect: any) => any,
    /** Runs at once on every move. */
    onMove: [] as ((before: { dw: number, dh: number }) => void)[],
    /** Runs once a move has rested, for the page's own layout. */
    onRest: [] as ((before: { dw: number, dh: number }) => void)[],
    /** Runs when the box comes on or goes off. */
    onToggle: [] as (() => void)[],
    /** Runs when a <body> arrives, the first or one the page swapped in. */
    onBody: [] as (() => void)[],
    /** The page's styles changed: what it says about <body> is read again. */
    bodyMayHaveChanged: () => ctx.watch.bodyMayHaveChanged(),
    /** A rule was edited, whether or not it reaches <body> now: it might once a class changes. */
    rulesEdited: () => ctx.watch.rulesEdited(),
    /** What a rule has to match to matter to a read: see sheets.ts. */
    reachable: () => [ctx.html, document.body, ...ctx.chain.nodes()],
    /** Runs before each read of the page, before anything of it is styled or laid out. */
    onBeforeRead: [] as (() => void)[],
    /** Runs after each read of the page. */
    onRead: [] as (() => void)[],
    /** Children came or went somewhere in the page (sheets.ts's observer). */
    childrenChanged: () => ctx.chain.childrenChanged(),
    /** Margin's own, in the page only during a read. */
    ownFlag: (node: Node) => ctx.body.ownFlag(node),
    loaded: () => ctx.watch.loaded(),
    set,
  };

  // What the box's parts share: the box, the browser's own functions, Margin's
  // sheets, the state more than one part reads or writes (below), and each
  // part's functions the others call, filled in as each starts. Everything else
  // a part keeps to itself.
  const ctx = {
    box, native, own, scrollOf, scrollInstantly, off,
    html: document.documentElement, // a page can replace it (box-watch.ts rootArrived)
    refused: false, // a frameset: nothing to scroll, no box
    sized: false, // <body>'s margins or size depend on the box's width (box-body.ts)
    lastSaid: '', // what the last read found the page says (box-body.ts, box-watch.ts)
    lastPage: '', // the same, without the box's width
    pageNew: false, // the last read found something new the page says, the box's width aside
    plainPage: true, // the page's <body> can be worked out without a layout
     body: null as any,
     chain: null as any,
     locks: null as any,
     watch: null as any,
     moves: null as any,
  };
  own.start(box);
  ctx.body = startBody(ctx);
  ctx.chain = startChain(ctx);
  ctx.locks = startLocks(ctx);
  ctx.watch = startWatch(ctx);

  // ---- moving it ---------------------------------------------------------------
  // The page's own layout follows when the box rests, and once it's in sight:
  // a hidden tab catches up as it's shown.
  let restTimer: Timer | 0 = 0;
  let restFrom: { dw: number, dh: number } | null = null;
  function rest() {
    clearTimeout(restTimer);
    restTimer = 0;
    if (!restFrom) return;
    const before = restFrom;
    restFrom = null;
    for (const fn of box.onRest) fn(before);
    ctx.watch.stale();
    ctx.body.measureBody(ctx.sized); // a media query moved, and a body with auto margins is centred in the new width
    tellResize();
  }
  // The page's own resize listeners, told the box moved.
  const tellResize = () => dispatchEvent(new Event('resize'));
  function restSoon(before: { dw: number; dh: number; }, live: boolean) {
    restFrom ??= before;
    clearTimeout(restTimer);
    if (document.hidden) return;
    if (live) restTimer = setTimeout(rest, REST_MS);
    else rest();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    rest();
    ctx.watch.measureIfDue();
  });
  // In and out of full screen, what the page's world is told changes with no
  // move of the box: its media queries and lists follow now, not after a delay.
  document.addEventListener('fullscreenchange', () => {
    if (!box.on) return;
    clearTimeout(restTimer);
    restFrom ??= { dw: box.dw, dh: box.dh };
    rest();
    ctx.watch.bodyMayHaveChanged();
  });

  function on(next: { left: any; top: any; right: any; bottom: any; }, live: boolean) {
    const wasOn = box.on;
    ctx.watch.rootArrived();
    if (wasOn && next.left === box.left && next.top === box.top && next.right === box.right && next.bottom === box.bottom) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = wasOn ? null : scrollOf(ctx.html);
    Object.assign(box, next, { on: true, dw: next.left + next.right, dh: next.top + next.bottom });
    place();
    own.write();
    if (!wasOn) {
      ctx.body.measureBody();
      ctx.locks.checkLocks();
      scrollTo(box.body(), scrolled!); // (read above while the box was off)
      for (const fn of box.onToggle) fn();
    }
    for (const fn of box.onMove) fn(before);
    restSoon(before, live);
  }
  function off() {
    if (!box.on) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = scrollOf(box.body());
    Object.assign(box, { on: false, left: 0, top: 0, right: 0, bottom: 0, dw: 0, dh: 0 });
    place();
    own.write();
    ctx.body.reset();
    ctx.locks.reset();
    ctx.lastSaid = '';
    ctx.watch.stale();
    scrollTo(ctx.html, scrolled);
    for (const fn of box.onToggle) fn();
    for (const fn of box.onMove) fn(before);
    restSoon(before, false);
  }

  // ---- where the box is in the window ------------------------------------------
  // Its origin, and its scale (always 1: a pinch is Safari's own, which page/coords.js
  // needn't undo; Margin's own pinch, which scaled the page at <html>, was removed 2026-11-07).
  function place() {
    box.x = box.left;
    box.y = box.top;
    box.scale = 1;
  }
  place();

  // ---- the bridge ---------------------------------------------------------------
  // Margin's isolated world (content/page-link.ts), synchronously: a string in
  // `detail`, or "off" (anything else is ignored: an earlier build's
  // "catch-up"). Cancelled to say this world heard it. Kept as it is: an
  // updated Margin talks to a copy of this script still in open pages. A page
  // sending these only moves its own layout.
  function set(message: string) {
    if (message === 'off') return void off();
    let next;
    try {
      next = JSON.parse(message);
    } catch {
      return;
    }
    if (!(next?.left >= 0) || ctx.refused) return;
    on({ left: next.left, top: next.top, right: next.right, bottom: next.bottom }, !!next.live);
  }
  document.addEventListener('margin:box', (event) => {
    event.preventDefault();
    set((event as CustomEvent).detail);
  });
  ctx.watch.bodyArrived();
  return box;
}
