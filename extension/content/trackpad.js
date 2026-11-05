// Margin's trackpad gestures on the page (Safari builds): the guard that keeps
// Safari's swipe, pinch for all tabs and bounce from leaving or distorting the
// page, and Margin's own pull-to-refresh and swipe back/forward, and the
// pinch on a page with a box (content/pinch.js). Called by content/core.js.
// (Their badges were drawn by the in-page UI, before Margin 2's app; the app
// doesn't draw them yet.)
import { mark } from '../shared/dom.js';
import { installGestureGuard, atPageTop, canSwipe } from '../shared/gestures.js';
import { createPullTracker, createSwipeTracker, DEFAULTS as PULL_DEFAULTS } from '../shared/pull.js';
import { platform } from '../shared/platform.js';

// `page`: see content/core.js. `replacing`: an earlier copy of Margin is still
// in the page (content/takeover.js); its gestures act on the page, so this
// copy's swipe stays off (its pull-to-refresh doesn't: two reloads are one).
/** @param {any} page @param {{ replacing: () => boolean }} options */
export function startTrackpad(page, { replacing }) {
  const { marks, pinch } = page;
  // Safari: keep trackpad swipes, pinches and the page bounce from leaving or
  // distorting the page (setting); re-synced on every render.
  // Not in a copy that stood back for a newer one (content/core.js): that one's guard is enough.
  // Its wheel listener there by the setting alone: a page that stood back is
  // asked per event (it may be shown again before its next render).
  const gestureGuard = !platform?.blockGestures ? null : installGestureGuard({
    getSettings: () => (page.dormant?.() ? { blockGestures: false } : page.state()?.settings),
    wanted: () => page.state()?.settings?.blockGestures !== false,
    // Safari's own on a page left alone; on a page with a box it would
    // magnify Margin too: Margin's own there.
    pinch: () => (document.fullscreenElement ? 'block' : page.boxed() ? 'own' : 'native'),
    onPinch: ({ phase, scale, x, y }) => {
      if (phase === 'start') pinch.start(x, y);
      else if (phase === 'change') pinch.move(scale);
      else pinch.end();
    },
    onWheelFirst: (event) => pinch.pan(event.deltaX, event.deltaY),
  });
  const updateGestureGuards = () => {
    gestureGuard?.update();
    syncWheelWatch();
    // Gestures off, or this copy stood back: nothing could move or undo a zoomed page.
    if (page.dormant?.() || page.state()?.settings?.blockGestures === false) pinch.reset();
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
  function showPull({ state: phase }) {
    if (pullRefreshing) return;
    if (phase === 'trigger') refreshFromPull();
  }
  function refreshFromPull() {
    pullRefreshing = true;
    mark(marks, 'pullRefresh', 'true'); // test/debug hook
    // A moment for the pull to end, then reload.
    setTimeout(() => {
      location.reload();
      // If the page stays (a cancelled "Leave page?" prompt), the next click
      // or key clears it; at the latest after 10s.
      for (const type of ['pointerdown', 'keydown']) addEventListener(type, resetPull, { capture: true, once: true });
    }, 300);
    pullStuckTimer = setTimeout(resetPull, 10000);
  }
  function resetPull() {
    if (!pullRefreshing) return;
    pullRefreshing = false;
    clearTimeout(pullStuckTimer);
    mark(marks, 'pullRefresh');
  }
  addEventListener('pageshow', (event) => { if (event.persisted) resetPull(); });

  // ---- swipe back/forward (Safari builds) ------------------------------------
  // Safari's two-finger swipe is blocked by the gesture guard; this is
  // Margin's: swipe sideways where nothing scrolls
  // sideways, past the threshold, and let go to go back (fingers moving
  // right) or forward. The gesture logic is shared/pull.js (axis x).
  const swipeEnabled = () => !replacing() && !page.dormant?.() && page.state()?.settings?.blockGestures !== false && page.state()?.settings?.swipeNavigation !== false;
  /** @param {{ state: string, progress?: number, direction?: number }} swipe */
  function showSwipe({ state: phase, direction }) {
    if (phase === 'trigger') navigateBySwipe(direction);
  }
  function navigateBySwipe(direction) {
    mark(marks, 'swipe', direction > 0 ? 'forward' : 'back'); // test/debug hook
    if (direction > 0) history.forward();
    else history.back();
  }
  // With the Navigation API (Safari 26, Chrome), only swipe where there's
  // history to go to; without it, any swipe may try (as before).
  const nav = globalThis.navigation;
  const historyAllows = (dx) => {
    if (!dx || typeof nav?.canGoBack !== 'boolean') return true;
    return dx < 0 ? nav.canGoBack : nav.canGoForward;
  };

  // The page's wheel events, while pull-to-refresh or swipe is on by the
  // settings (synced with the guard: updateGestureGuards).
  /** @type {() => void} */
  let syncWheelWatch = () => {};
  if (gestureGuard) {
    const pullTracker = createPullTracker();
    const swipeTracker = createSwipeTracker();
    let endTimer = null;
    // Where the gesture applies is asked lazily (shared/pull.js): it walks
    // the event's path, which can cost a layout, only while it matters.
    const onWheel = (/** @type {WheelEvent} */ event) => {
      if (event.ctrlKey) return; // a pinch
      // Not over an earlier copy's sidebar; pixel deltas only (a trackpad).
      const usable = () => event.deltaMode === 0 && !event.composedPath().some((node) => /^margin-.*-host$/.test(/** @type {Element} */ (node).localName ?? ''));
      const wheel = { deltaY: event.deltaY, deltaX: event.deltaX, time: event.timeStamp };
      const zoomed = pinch.zoomed(); // the wheel pans it: no gestures
      const pulling = pullEnabled() && !pullRefreshing && !zoomed;
      const swiping = swipeEnabled() && !zoomed;
      if (pulling) showPull(pullTracker.wheel({ ...wheel, eligible: () => usable() && atPageTop(event, document) }));
      if (swiping) showSwipe(swipeTracker.wheel({ ...wheel, eligible: () => usable() && historyAllows(event.deltaX) && canSwipe(event, document) }));
      if (!pulling && !swiping) return;
      clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        if (pulling) showPull(pullTracker.end());
        if (swiping) showSwipe(swipeTracker.end());
      }, PULL_DEFAULTS.GAP_MS + 20);
    };
    const watchOptions = { capture: true, passive: true };
    let watching = false;
    const watchWanted = () => {
      const settings = page.state()?.settings;
      return settings?.blockGestures !== false && (settings?.pullToRefresh !== false || settings?.swipeNavigation !== false);
    };
    syncWheelWatch = () => {
      const on = watchWanted();
      if (on === watching) return;
      watching = on;
      if (on) return addEventListener('wheel', onWheel, watchOptions);
      removeEventListener('wheel', onWheel, watchOptions);
      // A gesture under way when they went off: over.
      clearTimeout(endTimer);
      pullTracker.reset();
      swipeTracker.reset();
      showPull({ state: 'idle' });
      showSwipe({ state: 'idle' });
    };
    syncWheelWatch();
  }

  return {
    update: updateGestureGuards, // after every render (settings may have changed)
    pullRefreshing: () => pullRefreshing,
  };
}
