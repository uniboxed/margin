// Trackpad behavior.
//
// installGestureGuard (Safari builds, shared/platform.js `blockGestures`;
// setting `blockGestures`, default on) stops Safari's gestures that leave or
// distort the page:
//  - Swipe back/forward: Safari starts one only from a horizontal scroll the
//    page doesn't handle, while the page is scrolled to its edge. If the
//    page has a wheel listener, Safari first asks it; a preventDefault()ed
//    event means "handled", and no swipe starts for that gesture. So a
//    mostly-horizontal wheel event that nothing on the page can scroll is
//    cancelled; one that something can scroll (a carousel, a wide table) is
//    left alone and scrolls as usual.
//  - Pinch for all tabs: Safari sends pinch events to the page first
//    (gesturestart/change/end) and acts on them only if the page doesn't
//    handle them. Once Safari has the start, it handles the rest of the pinch
//    itself (WebKit's magnification gesture then bypasses the page), and
//    pinching in at normal zoom opens the tab overview; so at normal zoom
//    the whole pinch is cancelled and handed to `onPinch` instead: Margin
//    zooms the page itself (Safari's page zoom, tabs.setZoom; zoomForPinch).
//    A page Safari has magnified (smart zoom) keeps its pinch gestures.
//    Pinch-in as ⌃+wheel (how some browsers report a pinch) is cancelled.
//  - Bounce and pull-to-refresh: the page's top/bottom rubber-band, and
//    Safari's pull-to-refresh (driven only by the top rubber-band stretch,
//    WebViewImpl::topScrollStretchDidChange → NSRefreshController), both stop
//    with `overscroll-behavior-y: none` on <html>, which WebKit reads for the
//    page (LocalFrameView::verticalOverscrollBehavior). Added as a separate
//    stylesheet, never the page's own markup. Margin's own pull-to-refresh
//    (shared/pull.js, content/core.js) replaces Safari's.
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
/**
 * @param {WheelEvent} event
 * @param {'x' | 'y'} axis
 * @param {{ doc?: Document, stopAt?: Element | null }} [options]
 */
function somethingScrolls(event, axis, { doc, stopAt = null } = {}) {
  const delta = axis === 'x' ? event.deltaX : event.deltaY;
  if (!delta) return false;
  const scrollingElement = doc ? doc.scrollingElement ?? doc.documentElement : null;
  for (const node of /** @type {Element[]} */ (event.composedPath())) {
    if (node.nodeType === 1 && canScroll(node, axis, delta, scrollingElement)) return true;
    if (node === stopAt) return false;
  }
  return !!scrollingElement && canScroll(scrollingElement, axis, delta, scrollingElement);
}

// The page-wide question (nothing to stop at) for the guard and the swipe
// check, which both ask it of the same event: answered once per event.
/** @type {WeakMap<Event, { doc: Document | undefined, scrolls: boolean }>} */
const sidewaysAnswers = new WeakMap();
/** @param {WheelEvent} event @param {Document | undefined} doc */
function pageScrollsX(event, doc) {
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

// For pull-to-refresh: is this upward scroll at the very top of the page,
// and not over anything else that scrolls vertically (a list, an editor;
// those keep their own top)?
function atPageTop(event, doc) {
  const scrollingElement = doc.scrollingElement ?? doc.documentElement;
  if (scrollingElement.scrollTop > 0) return false;
  for (const node of event.composedPath()) {
    if (node.nodeType !== 1 || node === scrollingElement || node === doc.body) continue;
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight - node.clientHeight > 1) return false;
  }
  return true;
}

const NO_BOUNCE_CSS = ':root { overscroll-behavior-y: none !important; }';

// Pinch → page zoom: the nearest of Safari's zoom levels to where the pinch
// has taken it (start × scale), never below 100% (or below where it
// started, if already zoomed out with ⌘−), at most 300%.
const ZOOM_LEVELS = [0.5, 0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3];
function zoomForPinch(start, scale) {
  const target = start * scale;
  const floor = Math.min(start, 1) - 1e-9;
  return ZOOM_LEVELS.filter((z) => z >= floor)
    .reduce((best, z) => (Math.abs(Math.log(z / target)) < Math.abs(Math.log(best / target)) ? z : best));
}

// `getSettings()` returns the current settings (or null while unknown).
// `onPinch({ phase: 'start' | 'change' | 'end', scale, overMargin? })` gets
// the pinches taken from Safari (`overMargin` on the start: over one of
// Margin's own hosts). `wanted()`: whether the guard is on by the settings
// alone (default: getSettings says so). Returns { update() }: call it when
// settings change (adds or removes the no-bounce rule, and the wheel
// listener).
/**
 * @param {{ getSettings: () => any, wanted?: () => boolean, onPinch?: (pinch: { phase: 'start' | 'change' | 'end', scale: number, overMargin?: boolean }) => void, win?: Window & typeof globalThis }} options
 */
function installGestureGuard({ getSettings, wanted = undefined, onPinch = () => {}, win = globalThis.window }) {
  if (!win) return { update() {} };
  const doc = win.document;
  const enabled = () => getSettings()?.blockGestures !== false;
  const wheelWanted = wanted ?? enabled;

  // Safari's pinch events (macOS); `scale` < 1 means pinching in.
  const zoomedIn = () => (win.visualViewport?.scale ?? 1) > 1.01;

  // A cancelable (non-passive) wheel listener makes WebKit hand every wheel
  // event of the page to the page's main thread first, and wait for it at
  // the start of each gesture: only there while the guard is on. Added and
  // removed when the settings change (update), never per gesture: Safari
  // decides on a gesture's first event, and each change makes WebKit work
  // out the page's wheel regions again. Still asked per event (another copy
  // may have taken over without a change of settings).
  const wheelOptions = { capture: true, passive: false };
  const onWheel = (/** @type {WheelEvent} */ event) => {
    if (!enabled() || !event.cancelable) return;
    if (event.ctrlKey) { // a pinch reported as wheel: deltaY > 0 is pinching in
      if (event.deltaY > 0 && !zoomedIn()) event.preventDefault();
      return;
    }
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

  // A pinch is Margin's if it started at normal (unmagnified) zoom.
  let ours = false;
  const options = { capture: true, passive: false };
  win.addEventListener('gesturestart', (event) => {
    ours = enabled() && !zoomedIn();
    if (!ours) return;
    event.preventDefault();
    // Over Margin's own UI (one of its hosts): the caller zooms nothing.
    const overMargin = event.composedPath().some((node) => /^margin-.*-host$/.test(/** @type {Element} */ (node).localName ?? ''));
    onPinch({ phase: 'start', scale: 1, overMargin });
  }, options);
  win.addEventListener('gesturechange', (event) => {
    if (!ours) return;
    event.preventDefault();
    if (Number.isFinite(event.scale)) onPinch({ phase: 'change', scale: event.scale });
  }, options);
  win.addEventListener('gestureend', (event) => {
    if (!ours) return;
    ours = false;
    event.preventDefault();
    onPinch({ phase: 'end', scale: event.scale });
  }, options);

  // No bounce at the top/bottom (and so no Safari pull-to-refresh).
  let sheet = null;
  let style = null;
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

export { installGestureGuard, containScroll, atPageTop, canSwipe, zoomForPinch, ZOOM_LEVELS, canScroll, canScrollX };
