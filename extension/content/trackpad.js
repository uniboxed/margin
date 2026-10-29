// Margin's trackpad gestures on the page (Safari builds): the guard that keeps
// Safari's swipe, pinch and bounce from leaving or distorting the page, and
// Margin's own pull-to-refresh, swipe back/forward and pinch zoom, which the
// theme draws (view.setPull, setSwipe, setZoom). Called by content/core.js.
import { installGestureGuard, atPageTop, canSwipe, zoomForPinch } from '../shared/gestures.js';
import { createPullTracker, createSwipeTracker, DEFAULTS as PULL_DEFAULTS } from '../shared/pull.js';
import { platform } from '../shared/platform.js';

// `page`: see content/core.js. `replacing`: an earlier copy of Margin is still
// in the page (content/takeover.js); its gestures act on the page, so this
// copy's swipe stays off (its pull-to-refresh doesn't: two reloads are one).
/** @param {any} page @param {{ replacing: () => boolean }} options */
export function startTrackpad(page, { replacing }) {
  const { host, send, onCard } = page;
  // Safari: keep trackpad swipes, pinches and the page bounce from leaving or
  // distorting the page (setting); re-synced on every render.
  // Not in a copy that stood back for a newer one (content/core.js): that one's guard is enough.
  const guardWindow = (win) => installGestureGuard({ getSettings: () => (page.dormant?.() ? { blockGestures: false } : page.state()?.settings), onPinch: (pinch) => handlePinch(pinch), win });
  const gestureGuard = platform?.blockGestures ? guardWindow(window) : null;
  const cardGuards = [];
  if (gestureGuard) onCard((win) => cardGuards.push(guardWindow(win)));
  const updateGestureGuards = () => {
    gestureGuard?.update();
    for (const guard of cardGuards) guard.update();
  };

  // ---- pull to refresh (Safari builds) ---------------------------------------
  // Safari's own pull-to-refresh goes away with the page bounce (gesture
  // guard); this is Margin's: pull down at the top of a page past the
  // threshold and let go to reload. The gesture logic is shared/pull.js.
  let pullRefreshing = false;
  let pullStuckTimer = null;
  // Also while an earlier copy is still in the page (its pull reloads too: the
  // same reload), unlike swipe below (two would go back twice).
  const pullEnabled = () => !page.dormant?.() && page.state()?.settings?.blockGestures !== false && page.state()?.settings?.pullToRefresh !== false;
  /** @param {{ state: string, progress?: number }} pull */
  function showPull({ state: phase, progress }) {
    if (pullRefreshing) return;
    if (phase === 'trigger') return refreshFromPull();
    page.view()?.setPull({ phase, progress }); // 'idle' | 'tracking' | 'armed'
  }
  function refreshFromPull() {
    pullRefreshing = true;
    page.view()?.setPull({ phase: 'refreshing' });
    host.dataset.pullRefresh = 'true'; // test/debug hook
    // A moment to see it start, then reload (the next page's pill follows).
    setTimeout(() => {
      location.reload();
      // If the page stays (a cancelled "Leave page?" prompt), the next click
      // or key clears it; at the latest after 10s.
      for (const target of [window, globalThis.Margin?.shell?.card].filter(Boolean)) {
        for (const type of ['pointerdown', 'keydown']) target.addEventListener(type, resetPull, { capture: true, once: true });
      }
    }, 300);
    pullStuckTimer = setTimeout(resetPull, 10000);
  }
  function resetPull() {
    if (!pullRefreshing) return;
    pullRefreshing = false;
    clearTimeout(pullStuckTimer);
    page.view()?.setPull({ phase: 'idle' });
    delete host.dataset.pullRefresh;
  }
  addEventListener('pageshow', (event) => { if (event.persisted) resetPull(); });

  // ---- swipe back/forward (Safari builds) ------------------------------------
  // Safari's two-finger swipe is blocked by the gesture guard; this is
  // Margin's, with Arc's edge badge: swipe sideways where nothing scrolls
  // sideways, past the threshold, and let go to go back (fingers moving
  // right) or forward. The gesture logic is shared/pull.js (axis x).
  const swipeEnabled = () => !replacing() && !page.dormant?.() && page.state()?.settings?.blockGestures !== false && page.state()?.settings?.swipeNavigation !== false;
  let swipeHideTimer = null;
  /** @param {{ state: string, progress?: number, direction?: number }} swipe */
  function showSwipe({ state: phase, progress, direction }) {
    if (phase === 'trigger') return navigateBySwipe(direction);
    if (phase === 'idle' || !direction) return page.view()?.setSwipe({ phase: 'idle' });
    clearTimeout(swipeHideTimer);
    page.view()?.setSwipe({ phase, progress, direction }); // 'tracking' | 'armed'
  }
  function navigateBySwipe(direction) {
    page.view()?.setSwipe({ phase: 'going', direction });
    host.dataset.swipe = direction > 0 ? 'forward' : 'back'; // test/debug hook
    if (direction > 0) history.forward();
    else history.back();
    // Same-page history (and no history at all) doesn't unload: fade it out.
    clearTimeout(swipeHideTimer);
    swipeHideTimer = setTimeout(() => showSwipe({ state: 'idle' }), 450);
  }
  addEventListener('pageshow', (event) => { if (event.persisted) showSwipe({ state: 'idle' }); });
  // With the Navigation API (Safari 26, Chrome), only swipe where there's
  // history to go to; without it, any swipe may try (as before).
  const nav = globalThis.navigation;
  const historyAllows = (dx) => {
    if (!dx || typeof nav?.canGoBack !== 'boolean') return true;
    return dx < 0 ? nav.canGoBack : nav.canGoForward;
  };

  if (gestureGuard) {
    const pullTracker = createPullTracker();
    const swipeTracker = createSwipeTracker();
    let endTimer = null;
    // The page's document: this one, or the card's in the fitted layout.
    const watchWheel = (win, doc) => win.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return; // a pinch
      const path = event.composedPath();
      // Not over Margin's own panels; pixel deltas only (a trackpad).
      const usable = event.deltaMode === 0 && !path.some((node) => node === host || /^margin-.*-host$/.test(node.localName ?? ''));
      const wheel = { deltaY: event.deltaY, deltaX: event.deltaX, time: event.timeStamp };
      const pulling = pullEnabled() && !pullRefreshing;
      const swiping = swipeEnabled();
      if (pulling) showPull(pullTracker.wheel({ ...wheel, eligible: usable && atPageTop(event, doc) }));
      if (swiping) showSwipe(swipeTracker.wheel({ ...wheel, eligible: usable && historyAllows(event.deltaX) && canSwipe(event, doc) }));
      if (!pulling && !swiping) return;
      clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        if (pulling) showPull(pullTracker.end());
        if (swiping) showSwipe(swipeTracker.end());
      }, PULL_DEFAULTS.GAP_MS + 20);
    }, { capture: true, passive: true });
    watchWheel(window, document);
    onCard((win) => watchWheel(win, win.document));
  }

  // ---- pinch to zoom (Safari builds) -------------------------------------------
  // The gesture guard takes pinches from Safari (pinching in would open the
  // all-tabs overview) and hands them here: Margin zooms the page with
  // Safari's own page zoom (tabs.setZoom), stepping through Safari's zoom
  // levels (shared/gestures.js zoomForPinch), and shows the level.
  let pageZoom = 1;
  let pinchStart = 1;
  let pinchMoved = false;
  let zoomHudTimer = null;
  const readZoom = () => send('getZoom', {}, false).then((z) => (Number.isFinite(z) ? z : null));
  if (gestureGuard) readZoom().then((z) => { if (z) pageZoom = z; });
  function showZoomHud() {
    clearTimeout(zoomHudTimer);
    page.view()?.setZoom(pageZoom);
    host.dataset.zoom = String(pageZoom); // test/debug hook
  }
  // A pinch that starts over Margin's own UI (the sidebar, the frame, the
  // palette) zooms nothing, as over a browser's own (still taken from Safari).
  let pinchOverMargin = false;
  function handlePinch({ phase, scale, overMargin = false }) {
    if (phase === 'start') pinchOverMargin = overMargin;
    if (pinchOverMargin) return;
    if (phase === 'start') {
      pinchStart = pageZoom;
      pinchMoved = false;
      // ⌘+/⌘− may have changed it since: start from the real level unless
      // the pinch already moved on.
      readZoom().then((z) => { if (z && !pinchMoved) pinchStart = pageZoom = z; });
      return showZoomHud();
    }
    if (phase === 'change') {
      const zoom = zoomForPinch(pinchStart, scale);
      if (zoom !== pageZoom) {
        pageZoom = zoom;
        pinchMoved = true;
        send('setZoom', { factor: zoom }, false).then(() => page.zoomed?.(zoom), () => {});
      }
      return showZoomHud();
    }
    zoomHudTimer = setTimeout(() => page.view()?.setZoom(null), 700);
  }

  return {
    update: updateGestureGuards, // after every render (settings may have changed)
    pullRefreshing: () => pullRefreshing,
  };
}
