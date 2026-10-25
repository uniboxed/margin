// Trackpad behavior. Classic script; attaches to globalThis.Margin.gestures.
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
//    (gesturestart/change/end) and acts on each one only if the page doesn't
//    handle it. At normal zoom the start is cancelled, every pinch-in
//    update, and the end unless the pinch zoomed in (cancelling only the
//    pinch-in updates wasn't enough in Safari). A page that's already zoomed
//    in keeps all its pinch gestures. Pinch-in as ⌃+wheel (how some browsers
//    report a pinch) is cancelled the same way.
//  - Bounce and pull-to-refresh: the page's top/bottom rubber-band, and
//    Safari's pull-to-refresh (driven only by the top rubber-band stretch,
//    WebViewImpl::topScrollStretchDidChange → NSRefreshController), both stop
//    with `overscroll-behavior-y: none` on <html>, which WebKit reads for the
//    page (LocalFrameView::verticalOverscrollBehavior). Added as a separate
//    stylesheet, never the page's own markup. Margin's own pull-to-refresh
//    (shared/pull.js, content/sidebar.js) replaces Safari's.
// Limits: frames other than the top page (e.g. an embedded video) get their
// own events, which Margin doesn't see; a swipe that starts mostly vertical
// and turns sideways can still go back.
//
// containScroll (always, both browsers): wheel events over Margin's own
// panels (sidebar, palette) scroll only the panel's lists, and only when
// they have more than fits; they never scroll the page behind.

(() => {
  const Margin = (globalThis.Margin ??= {});

  const AXES = {
    x: { size: 'Width', pos: 'scrollLeft', overflow: 'overflowX' },
    y: { size: 'Height', pos: 'scrollTop', overflow: 'overflowY' },
  };

  // Could `node` scroll along `axis` ('x' | 'y') by `delta` (sign = direction)?
  function canScroll(node, axis, delta, scrollingElement) {
    const a = AXES[axis];
    const max = node[`scroll${a.size}`] - node[`client${a.size}`];
    if (max <= 1 || !delta) return false;
    const style = getComputedStyle(node);
    const overflow = style[a.overflow];
    if (node === scrollingElement ? overflow === 'hidden' || overflow === 'clip' : overflow !== 'auto' && overflow !== 'scroll') return false;
    // scrollLeft runs 0 … max, or -max … 0 in right-to-left content.
    const [lo, hi] = axis === 'x' && style.direction === 'rtl' ? [-max, 0] : [0, max];
    return delta < 0 ? node[a.pos] > lo + 0.5 : node[a.pos] < hi - 0.5;
  }
  const canScrollX = (node, dx, scrollingElement) => canScroll(node, 'x', dx, scrollingElement);

  // Does anything the event passes through (up to `stopAt`, else including
  // the page itself) scroll along `axis` in the event's direction?
  function somethingScrolls(event, axis, { doc, stopAt = null } = {}) {
    const delta = axis === 'x' ? event.deltaX : event.deltaY;
    const scrollingElement = doc ? doc.scrollingElement ?? doc.documentElement : null;
    for (const node of event.composedPath()) {
      if (node.nodeType === 1 && canScroll(node, axis, delta, scrollingElement)) return true;
      if (node === stopAt) return false;
    }
    return !!scrollingElement && canScroll(scrollingElement, axis, delta, scrollingElement);
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

  // `getSettings()` returns the current settings (or null while unknown).
  // Returns { update() }: call it when settings change (adds or removes the
  // no-bounce rule).
  function installGestureGuard({ getSettings, win = globalThis.window }) {
    if (!win) return { update() {} };
    const doc = win.document;
    const enabled = () => getSettings()?.blockGestures !== false;

    // Safari's pinch events (macOS); `scale` < 1 means pinching in.
    const zoomedIn = () => (win.visualViewport?.scale ?? 1) > 1.01;

    win.addEventListener('wheel', (event) => {
      if (!enabled() || !event.cancelable) return;
      if (event.ctrlKey) { // a pinch reported as wheel: deltaY > 0 is pinching in
        if (event.deltaY > 0 && !zoomedIn()) event.preventDefault();
        return;
      }
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      if (somethingScrolls(event, 'x', { doc })) return;
      event.preventDefault();
    }, { capture: true, passive: false });

    // One pinch at a time: is it guarded (started at normal zoom), and did
    // any of it go through to Safari (zooming in)?
    let pinch = null; // { passedThrough }
    const options = { capture: true, passive: false };
    win.addEventListener('gesturestart', (event) => {
      pinch = null;
      if (!enabled() || zoomedIn()) return;
      pinch = { passedThrough: false };
      event.preventDefault();
    }, options);
    win.addEventListener('gesturechange', (event) => {
      if (!enabled()) return;
      if (!pinch && zoomedIn()) return; // zoomed in: pinch freely
      if (event.scale < 1) return event.preventDefault();
      if (pinch) pinch.passedThrough = true; // zooming in: Safari's to handle
    }, options);
    win.addEventListener('gestureend', (event) => {
      const guarded = pinch;
      pinch = null;
      if (guarded && !guarded.passedThrough) event.preventDefault();
    }, options);

    // No bounce at the top/bottom (and so no Safari pull-to-refresh).
    let sheet = null;
    let style = null;
    function update() {
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

  Margin.gestures = { installGestureGuard, containScroll, atPageTop, canScroll, canScrollX };
})();
