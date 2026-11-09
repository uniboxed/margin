// Trackpad behavior.
//
// installGestureGuard (Safari builds, shared/platform.ts `blockGestures`;
// setting `blockGestures`, default on) stops Safari's gestures that leave or
// distort the page:
//  - Swipe back/forward: Safari starts one only from a horizontal scroll the
//    page doesn't handle, while the page is scrolled to its edge. If the
//    page has a wheel listener, Safari first asks it; a preventDefault()ed
//    event means "handled", and no swipe starts for that gesture. So a
//    mostly-horizontal wheel event that nothing on the page can scroll is
//    cancelled; one that something can scroll (a carousel, a wide table) is
//    left alone and scrolls as usual.
//  - Pinch for all tabs: Safari opens the tab overview from one event only:
//    the first of a pinch (Began), moving inward, unhandled by the page, with
//    the page at its normal scale (SearchableWKView
//    _shouldBeginVisualTabPickerTransitionForMagnification, read from Safari
//    27.2, DECISIONS.md). Its own smooth zoom starts from that same one event,
//    unhandled. gesturestart carries the direction (scale = 1 + the first
//    delta), so only that case is cancelled: every other pinch is Safari's,
//    in its own process, with nothing running here (the page gets no more
//    events from it, not even gestureend). A pinch that starts inward at
//    normal scale does nothing. Pinches go by `pinch()`, see the options.
//  - Bounce and pull-to-refresh: the page's top/bottom rubber-band, and
//    Safari's pull-to-refresh (driven only by the top rubber-band stretch,
//    WebViewImpl::topScrollStretchDidChange → NSRefreshController), both stop
//    with `overscroll-behavior-y: none` on <html>, which WebKit reads for the
//    page (LocalFrameView::verticalOverscrollBehavior). Added as a separate
//    stylesheet, never the page's own markup. Margin's own pull-to-refresh
//    (shared/pull.ts, content/core.ts) replaces Safari's.
// Limits: frames other than the top page (e.g. an embedded video) get their
// own events, which Margin doesn't see; a swipe that starts mostly vertical
// and turns sideways can still go back.
//
// containScroll (always, both browsers): wheel events over Margin's own
// panels (sidebar, palette) scroll only the panel's lists, and only when
// they have more than fits; they never scroll the page behind.


const AXES = {
  x: { size: 'Width', pos: 'scrollLeft', overflow: 'overflowX' },
  y: { size: 'Height', pos: 'scrollTop', overflow: 'overflowY' },
};

// Could `node` scroll along `axis` ('x' | 'y') by `delta` (sign = direction)?
// Asked for every wheel event, along the event's path: the cheap questions
// first. No movement that way asks nothing; the overflow style needs at most
// the page's style worked out; only an element that can scroll has its sizes
// read, which makes the browser lay out a page whose layout is out of date.
function canScroll(node, axis, delta, scrollingElement) {
  if (!delta) return false;
  const a = AXES[axis];
  const style = getComputedStyle(node);
  const overflow = style[a.overflow];
  if (node === scrollingElement ? overflow === 'hidden' || overflow === 'clip' : overflow !== 'auto' && overflow !== 'scroll') return false;
  const max = node[`scroll${a.size}`] - node[`client${a.size}`];
  if (max <= 1) return false;
  // scrollLeft runs 0 … max, or -max … 0 in right-to-left content.
  const [lo, hi] = axis === 'x' && style.direction === 'rtl' ? [-max, 0] : [0, max];
  return delta < 0 ? node[a.pos] > lo + 0.5 : node[a.pos] < hi - 0.5;
}
const canScrollX = (node, dx, scrollingElement) => canScroll(node, 'x', dx, scrollingElement);

// Does anything the event passes through (up to `stopAt`, else including
// the page itself) scroll along `axis` in the event's direction?
function somethingScrolls(event: WheelEvent, axis: 'x' | 'y', { doc, stopAt = null }: { doc?: Document, stopAt?: Element | null } = {}) {
  const delta = axis === 'x' ? event.deltaX : event.deltaY;
  if (!delta) return false;
  const scrollingElement = doc ? doc.scrollingElement ?? doc.documentElement : null;
  for (const node of (event.composedPath() as Element[])) {
    if (node.nodeType === 1 && canScroll(node, axis, delta, scrollingElement)) return true;
    if (node === stopAt) return false;
  }
  return !!scrollingElement && canScroll(scrollingElement, axis, delta, scrollingElement);
}

// The page-wide question (nothing to stop at) for the guard and the swipe
// check, which both ask it of the same event: answered once per event.
const sidewaysAnswers: WeakMap<Event, { doc: Document | undefined, scrolls: boolean }> = new WeakMap();
function pageScrollsX(event: WheelEvent, doc: Document | undefined) {
  const known = sidewaysAnswers.get(event);
  if (known && known.doc === doc) return known.scrolls;
  const scrolls = somethingScrolls(event, 'x', { doc });
  sidewaysAnswers.set(event, { doc, scrolls });
  return scrolls;
}

// Keep wheel events over `el` (a panel in a shadow root) from scrolling the
// page: let them scroll a list inside `el` that can move that way, else
// cancel them. Pinches (⌃+wheel) are left to the page-wide guard.
function containScroll(el) {
  el.addEventListener('wheel', (event) => {
    if (!event.cancelable || event.ctrlKey) return;
    const axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'x' : 'y';
    if (!somethingScrolls(event, axis, { stopAt: el })) event.preventDefault();
  }, { passive: false });
}

// For pull-to-refresh: is this upward scroll at the very top of the page, as
// seen under the fingers: the page and everything it passes through that
// scrolls up and down at its top (a list or an editor scrolled down keeps
// its own top: it scrolls up first)? From anywhere in the page: an app-like
// site scrolls a pane of its own, not the page, and a pane at its top is the
// page's top there (Tirth, 2026-11-08: "2 finger swipe down from anywhere in
// the tab content"). The cheap question first: an element not scrolled down
// has nothing to ask of its style.
function atPageTop(event, doc) {
  const scrollingElement = doc.scrollingElement ?? doc.documentElement;
  // (In a page's box, <body> is what scrolls: content/page/box.ts.)
  if (scrollingElement.scrollTop > 0 || doc.body?.scrollTop > 0) return false;
  for (const node of event.composedPath()) {
    if (node.nodeType !== 1 || node === scrollingElement || node === doc.body) continue;
    if (!((node as Element).scrollTop > 0.5)) continue;
    const overflow = getComputedStyle((node as Element)).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return false;
  }
  return true;
}

const NO_BOUNCE_CSS = ':root { overscroll-behavior-y: none !important; }';

// `getSettings()` returns the current settings (or null while unknown).
// `pinch()`, for a pinch starting in `win` with the page at its normal scale:
// 'native' (Safari's, but for what opens its overview) or 'block' (none: the
// new-tab page, full screen). (Margin's own pinch, a page with a box scaled at
// <html>, was removed 2026-11-07: Tirth found it slow next to Safari's own.)
// `wanted()`: whether the guard is on by the settings alone (default:
// getSettings says so). Returns { update() }: call it when settings change
// (adds or removes the no-bounce rule, and the wheel listener).
function installGestureGuard({ getSettings, wanted = undefined, pinch = () => 'block', win = globalThis.window }: { getSettings: () => any, wanted?: () => boolean, pinch?: () => 'native' | 'block', win?: Window & typeof globalThis }) {
  if (!win) return { update() {} };
  const doc = win.document;
  const enabled = () => getSettings()?.blockGestures !== false;
  const wheelWanted = wanted ?? enabled;

  // Magnified by Safari: the top window's scale (a frame's is always 1), as
  // Safari tests it. `scale` < 1 means pinching in.
  const zoomedIn = () => (globalThis.visualViewport?.scale ?? 1) > 1;

  // A cancelable (non-passive) wheel listener makes WebKit hand every wheel
  // event of the page to the page's main thread first, and wait for it at
  // the start of each gesture: only there while the guard is on. Added and
  // removed when the settings change (update), never per gesture: Safari
  // decides on a gesture's first event, and each change makes WebKit work
  // out the page's wheel regions again. Still asked per event (another copy
  // may have taken over without a change of settings).
  const wheelOptions = { capture: true, passive: false };
  const onWheel = (event: WheelEvent) => {
    if (!enabled() || !event.cancelable || event.ctrlKey) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    if (pageScrollsX(event, doc)) return;
    event.preventDefault();
  };
  let listening = false;
  const syncWheel = () => {
    const on = wheelWanted();
    if (on === listening) return;
    listening = on;
    if (on) win.addEventListener('wheel', onWheel, wheelOptions);
    else win.removeEventListener?.('wheel', onWheel, wheelOptions);
  };
  syncWheel();

  // Decided on the first event alone (see the top of this file).
  win.addEventListener('gesturestart', (event) => {
    if (!enabled() || zoomedIn()) return; // magnified: Safari's, both ways
    if (pinch() === 'native' && event.scale >= 1) return;
    event.preventDefault();
  }, { capture: true, passive: false });

  // No bounce at the top/bottom (and so no Safari pull-to-refresh).
  let sheet: CSSStyleSheet | null = null;
  let style: HTMLStyleElement | null = null;
  function update() {
    syncWheel();
    const on = enabled();
    if (doc?.adoptedStyleSheets && typeof win.CSSStyleSheet?.prototype.replaceSync === 'function') {
      if (!sheet) {
        sheet = new win.CSSStyleSheet();
        sheet.replaceSync(NO_BOUNCE_CSS);
      }
      const others = doc.adoptedStyleSheets.filter((s) => s !== sheet);
      const has = others.length !== doc.adoptedStyleSheets.length;
      if (on !== has) doc.adoptedStyleSheets = on ? [...others, sheet] : others;
    } else if (doc?.documentElement) {
      if (on && !style?.isConnected) {
        style ??= Object.assign(doc.createElement('style'), { textContent: NO_BOUNCE_CSS });
        doc.documentElement.appendChild(style);
      } else if (!on) {
        style?.remove();
      }
    }
  }
  update();
  return { update };
}

// For swipe navigation: does nothing under the pointer scroll sideways in
// this event's direction (so the swipe is the page's to go back/forward)?
const canSwipe = (event, doc) => !pageScrollsX(event, doc);

export { installGestureGuard, containScroll, atPageTop, canSwipe, canScroll, canScrollX };
