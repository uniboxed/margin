// <body>'s scroll bars where they take space, for the box (box.ts): classic scroll bars, which a Mac set to always
// show them (or with a mouse and no trackpad) draws beside the content instead of over it (GitHub issue #17).
//
// In a window, what's fixed is laid out in the window less its scroll bars, and so is <html>. In the box, <body>
// is the scroller, its bars inside it at the box's edges, and what's fixed is laid out in <html>, the whole box:
// fixed bars came out a scroll bar wider than in a window, over <body>'s bar. So while <body>'s bars take space,
// <html> is that much narrower (and shorter, for a bar along the bottom), and <body> reaches past it to the box's
// edge (shared/page-box.ts barsCss and bodyFitCss, box-body.ts's padding sheet): what's fixed, <html> and the
// width <body> is worked out from are as in a window, and <body> and its bar are where they were.
//
// A page's `overflow: scroll` on <html> shows the window's own bars, at the window's edge (the window never
// scrolls): with classic bars they're hidden and <body> shows the page's (box-locks.ts), as a window shows its own.
//
// Overlay scroll bars (a trackpad's, the Mac's default) take no space: every bar measures 0 and nothing here
// writes anything, so the box's sheets are as they were without this. Measured as <body>'s content box changes
// size (a ResizeObserver: a bar coming or going changes it), after layout, so measuring never lays the page out,
// and written only when a value changes (WebKit styles the whole page again for any sheet written).
import { NO_BARS, RELAYOUT_ELEMENT } from '../../shared/page-box.ts';
import type { Bars } from '../../shared/page-box.ts';
import type { Accessor } from './accessor.ts';

/** @param ctx the box's shared parts (box.ts) */
export function startBars(ctx: any) {
  const { box, own, native } = ctx;
  const { computed } = native; // (called as itself: as a method of `native`, an illegal invocation)
  // The browser's own, from before viewport.ts speaks for the box (<body>'s offsetHeight, <html>'s clientWidth).
  const read = (object: object, name: string) => {
    for (let at = object; at; at = Object.getPrototypeOf(at)) {
      const found = Object.getOwnPropertyDescriptor(at, name);
      if (found) return (found as Accessor).get;
    }
    return () => 0; // (every browser Margin runs in has these; without one, no bar is measured)
  };
  const offsetWidth = read(HTMLElement.prototype, 'offsetWidth');
  const offsetHeight = read(HTMLElement.prototype, 'offsetHeight');
  const clientWidth = read(Element.prototype, 'clientWidth');
  const clientHeight = read(Element.prototype, 'clientHeight');
  const clientLeft = read(Element.prototype, 'clientLeft');
  const innerWidth = read(window, 'innerWidth');
  const innerHeight = read(window, 'innerHeight');

  // `seen`: scroll bars have taken space in this page, <body>'s or the window's (for a page's `overflow: scroll` on
  // <html>). Kept once seen: <body> may have none to show for a while, and the window's are hidden from then on.
  let bars: Bars = NO_BARS;
  ctx.bars = bars;
  let rootScrolls = false; // the page says `overflow: scroll` on <html> (box-locks.ts checkLocks)

  function measure() {
    const { body } = document;
    if (!box.on || !body || body !== watched || document.fullscreenElement === body) return;
    const style = computed(body);
    const left = parseFloat(style.borderLeftWidth);
    const wide = offsetWidth.call(body) - clientWidth.call(body) - left - parseFloat(style.borderRightWidth);
    const high = offsetHeight.call(body) - clientHeight.call(body) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    // A bar on the left (a right-to-left page, where the browser puts it there) is left as it is.
    const onLeft = clientLeft.call(body) - left >= 1;
    const windowShows = rootScrolls && !bars.hideWindow && (innerWidth.call(window) - clientWidth.call(ctx.html) >= 1 || innerHeight.call(window) - clientHeight.call(ctx.html) >= 1);
    const seen = bars.seen || wide >= 1 || high >= 1 || windowShows;
    const was = bars.seen;
    set({ right: wide >= 1 && !onLeft ? Math.round(wide) : 0, bottom: high >= 1 ? Math.round(high) : 0, seen, hideWindow: seen && rootScrolls });
    // <body> shows the page's bars now. In the next frame: changing <body>'s overflow here, in the observer's
    // callback, would change its size again, which the page would hear of as an error (the observer's loop).
    if (seen && !was && rootScrolls) requestAnimationFrame(() => ctx.locks.checkLocks());
  }
  // What's written for a change keeps <body>'s content box as it is (<html> narrower by a bar, <body> past it by the
  // same), so the observer has nothing more to say in this frame.
  function set(next: Bars) {
    if (next.right === bars.right && next.bottom === bars.bottom && next.seen === bars.seen && next.hideWindow === bars.hideWindow) return;
    // A bar that went or got thinner (WebKit lays <body>'s children out again by itself as one comes or grows).
    const shrank = next.right < bars.right || next.bottom < bars.bottom;
    bars = Object.freeze(next);
    ctx.bars = bars;
    own.setBars(bars);
    ctx.body.barsChanged();
    if (shrank) relayout();
    for (const fn of box.onBars) fn();
  }
  // <body>'s children laid out again as a bar goes (shared/page-box.ts RELAYOUT_ELEMENT): <body> a pixel narrower
  // for one layout, then as it was. Its scroll kept: laid out narrower, it may not scroll as far.
  const relayoutFlag = document.createElement(RELAYOUT_ELEMENT);
  function relayout() {
    const { body } = document;
    if (!body) return;
    const kept = ctx.scrollOf(body);
    native.append.call(ctx.html, relayoutFlag);
    try {
      void offsetWidth.call(body);
    } finally {
      native.remove.call(relayoutFlag);
      ctx.scrollInstantly(body, kept);
    }
  }

  // <body>'s content box: a bar coming or going, the box moving, the page's own changes.
  const watch = new ResizeObserver(measure);
  let watched: HTMLElement | null = null;
  function follow() {
    const { body } = document;
    if (!box.on || !body || body === watched) return;
    watch.disconnect();
    watched = body;
    watch.observe(body);
  }
  // The box off: nothing measured until it's on again (what was measured stays, for then).
  function stop() {
    watch.disconnect();
    watched = null;
  }
  box.onBody.push(follow);
  box.onToggle.push(() => (box.on ? follow() : stop()));

  /**
   * What the page says about <html>'s overflow (box-locks.ts checkLocks): `scroll` shows the window's bars,
   * looked at in the next frame while it isn't known whether bars take space here.
   * */
  function rootSays(scrolls: boolean) {
    if (scrolls === rootScrolls) return;
    rootScrolls = scrolls;
    if (scrolls && !bars.seen) requestAnimationFrame(measure);
    else set({ ...bars, hideWindow: bars.seen && scrolls });
  }

  return {
    /** Scroll bars take space in this page. */
    classic: () => bars.seen,
    rootSays,
    /** Margin's own, in the page only for one layout. */
    ownFlag: (node: Node) => node === relayoutFlag,
  };
}
