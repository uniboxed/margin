// Stops Safari's trackpad gestures that leave the page, when the setting
// `blockGestures` is on (default): the two-finger swipe to go back/forward
// and the pinch that opens the all-tabs overview. Classic script; attaches
// to globalThis.Margin.gestures. Installed by content/sidebar.js and the new
// tab page, in Safari builds only (shared/platform.js `blockGestures`).
//
// How (from WebKit's source, ViewGestureController / WebViewImpl):
//  - Swipe: Safari starts a back/forward swipe only from a horizontal scroll
//    the page doesn't handle, while the page is scrolled to its edge. If the
//    page has a wheel listener, Safari first asks it; a preventDefault()ed
//    event means "handled", and no swipe starts for that gesture. So a
//    mostly-horizontal wheel event that nothing on the page can scroll is
//    cancelled; one that something can scroll (a carousel, a wide table) is
//    left alone and scrolls as usual.
//  - Pinch: Safari sends pinch events to the page first (gesturestart/
//    change/end) and acts on each one only if the page doesn't handle it.
//    Pinching in at normal zoom is what opens the tab overview, so those
//    events are cancelled. Pinching out (zooming in), and pinching back in
//    while zoomed, still work.
// Limits: frames other than the top page (e.g. an embedded video) get their
// own events, which Margin doesn't see; a swipe that starts mostly vertical
// and turns sideways can still go back.

(() => {
  const Margin = (globalThis.Margin ??= {});

  // Could `node` scroll horizontally by `dx` (sign = direction)?
  function canScrollX(node, dx, scrollingElement) {
    const max = node.scrollWidth - node.clientWidth;
    if (max <= 1) return false;
    const style = getComputedStyle(node);
    if (node !== scrollingElement && style.overflowX !== 'auto' && style.overflowX !== 'scroll') return false;
    if (node === scrollingElement && style.overflowX === 'hidden') return false;
    // scrollLeft runs 0 … max, or -max … 0 in right-to-left content.
    const [lo, hi] = style.direction === 'rtl' ? [-max, 0] : [0, max];
    return dx < 0 ? node.scrollLeft > lo + 0.5 : node.scrollLeft < hi - 0.5;
  }

  function somethingScrollsX(event, doc) {
    const scrollingElement = doc.scrollingElement ?? doc.documentElement;
    for (const node of event.composedPath()) {
      if (node.nodeType === 1 && canScrollX(node, event.deltaX, scrollingElement)) return true;
    }
    return canScrollX(scrollingElement, event.deltaX, scrollingElement);
  }

  // `getSettings()` returns the current settings (or null while unknown).
  function installGestureGuard({ getSettings, win = globalThis.window }) {
    if (!win) return;
    const doc = win.document;
    const enabled = () => getSettings()?.blockGestures !== false;

    win.addEventListener('wheel', (event) => {
      if (!enabled() || !event.cancelable || event.ctrlKey) return; // ctrlKey: a pinch in Chrome
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      if (somethingScrollsX(event, doc)) return;
      event.preventDefault();
    }, { capture: true, passive: false });

    // Safari's pinch events (macOS); `scale` < 1 means pinching in.
    const zoomedIn = () => (win.visualViewport?.scale ?? 1) > 1.01;
    win.addEventListener('gesturechange', (event) => {
      if (!enabled() || zoomedIn() || !(event.scale < 1)) return;
      event.preventDefault();
    }, { capture: true, passive: false });
  }

  Margin.gestures = { installGestureGuard, canScrollX };
})();
