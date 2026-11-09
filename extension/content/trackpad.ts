// Margin's trackpad gestures on the page (Safari builds): the guard that keeps
// Safari's swipe, pinch for all tabs and bounce from leaving or distorting the
// page, and Margin's own pull-to-refresh and swipe back/forward. A pinch is
// Safari's own (Margin's own pinch was removed 2026-11-07). Called by content/core.ts.
// Their feedback (how far a pull or a swipe has gone, armed, done) is drawn
// by Margin.app's overlay: told as it goes (`page.tellGesture`, at most every
// GESTURE_TELL_MS but for a change of state; content/core.ts), never drawn here.
import { mark } from '../shared/dom.ts';
import { installGestureGuard, atPageTop, canSwipe } from '../shared/gestures.ts';
import { createPullTracker, createSwipeTracker, DEFAULTS as PULL_DEFAULTS } from '../shared/pull.ts';
import { platform } from '../shared/platform.ts';

export const GESTURE_TELL_MS = 16;
// What a gesture's tracker says (shared/pull.ts: idle, pulling, armed,
// trigger; how far, which way), told when it changes: its state at once, its
// progress in steps of 0.01 at most once a frame (GESTURE_TELL_MS), the last
// one held back told once that's up (`later`), so the overlay's badge, eased
// there every frame (ui/gesture-motion.ts), follows the fingers smoothly
// (Tirth, 2026-11-08: steps of 0.05 every 30 ms looked jumpy). Nothing while
// it stays idle (most wheel events).
export function gestureTeller(kind: 'pull' | 'swipe', tell: (g: { kind: string, state: string, progress: number, direction: number }) => void, now = () => performance.now(), later = (fn: () => void, ms: number) => setTimeout(fn, ms), cancel = (t: number) => clearTimeout(t)) {
  let state = 'idle';
  let key = 'idle';
  let at = -Infinity;
  let held: { key: string; state: string; progress: number; direction: number; } | null = null;
  let timer: number | null = null;
  const say = (g: { key: string; state: string; progress: number; direction: number; }) => {
    if (timer != null) cancel(timer);
    timer = null;
    held = null;
    key = g.key;
    state = g.state;
    at = now();
    tell({ kind, state: g.state, progress: g.progress, direction: g.direction });
  };
  return (view: { state: string, progress?: number, direction?: number }) => {
    const progress = view.state === 'idle' ? 0 : Math.round(Math.max(0, Math.min(1.5, view.progress ?? 0)) * 100) / 100;
    const direction = kind === 'swipe' ? (view.direction ?? 0) : 0;
    const next = { key: view.state === 'idle' ? 'idle' : `${view.state}:${progress}:${direction}`, state: view.state, progress, direction };
    if (next.key === (held?.key ?? key)) return;
    const wait = GESTURE_TELL_MS - (now() - at);
    if (view.state !== state || wait <= 0) return say(next);
    held = next;
    timer ??= later(() => { timer = null; if (held) say(held); }, wait);
  };
}

// `page`: see content/core.ts.
export function startTrackpad(page: any) {
  const { marks } = page;
  // Safari: keep trackpad swipes, pinches and the page bounce from leaving or
  // distorting the page (setting); re-synced on every render.
  // Not in a copy that stood back for a newer one (content/core.ts): that one's guard is enough.
  // Its wheel listener there by the setting alone: a page that stood back is
  // asked per event (it may be shown again before its next render).
  const gestureGuard = !platform?.blockGestures ? null : installGestureGuard({
    getSettings: () => (page.dormant?.() ? { blockGestures: false } : page.state()?.settings),
    wanted: () => page.state()?.settings?.blockGestures !== false,
    // Safari's own (but for what opens its tab overview); none in an element's full screen.
    pinch: () => (document.fullscreenElement ? 'block' : 'native'),
  });
  const updateGestureGuards = () => {
    gestureGuard?.update();
    syncWheelWatch();
  };

  // ---- pull to refresh (Safari builds) ---------------------------------------
  // Safari's own pull-to-refresh goes away with the page bounce (gesture
  // guard); this is Margin's: pull down at the top of a page past the
  // threshold and let go to reload. The gesture logic is shared/pull.ts.
  let pullRefreshing = false;
  let pullStuckTimer: number | null = null;
  // Also while an earlier copy is still in the page (its pull reloads too: the
  // same reload), unlike swipe below (two would go back twice).
  const pullEnabled = () => !page.dormant?.() && page.state()?.settings?.blockGestures !== false && page.state()?.settings?.pullToRefresh !== false;
  const tellPull = gestureTeller('pull', (g) => page.tellGesture?.(g));
  const tellSwipe = gestureTeller('swipe', (g) => page.tellGesture?.(g));
  function showPull(pull: { state: string, progress?: number }) {
    const { state: phase } = pull;
    tellPull(pull);
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
  // right) or forward. The gesture logic is shared/pull.ts (axis x).
  const swipeEnabled = () => !page.dormant?.() && page.state()?.settings?.blockGestures !== false && page.state()?.settings?.swipeNavigation !== false;
  function showSwipe(swipe: { state: string, progress?: number, direction?: number }) {
    const { state: phase, direction } = swipe;
    tellSwipe(swipe);
    if (phase === 'trigger') navigateBySwipe(direction);
  }
  function navigateBySwipe(direction: number | undefined) {
    mark(marks, 'swipe', (direction ?? 0) > 0 ? 'forward' : 'back'); // test/debug hook
    if ((direction ?? 0) > 0) history.forward();
    else history.back();
  }
  // With the Navigation API (Safari 26, Chrome), only swipe where there's
  // history to go to; without it, any swipe may try (as before).
  const nav = globalThis.navigation;
  const historyAllows = (dx: number) => {
    if (!dx || typeof nav?.canGoBack !== 'boolean') return true;
    return dx < 0 ? nav.canGoBack : nav.canGoForward;
  };

  // The page's wheel events, while pull-to-refresh or swipe is on by the
  // settings (synced with the guard: updateGestureGuards).
  let syncWheelWatch: () => void = () => {};
  if (gestureGuard) {
    const pullTracker = createPullTracker();
    const swipeTracker = createSwipeTracker();
    let endTimer: number | null = null;
    // Where the gesture applies is asked lazily (shared/pull.ts): it walks
    // the event's path, which can cost a layout, only while it matters.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // a pinch
      // Pixel deltas only (a trackpad).
      const usable = () => event.deltaMode === 0;
      const wheel = { deltaY: event.deltaY, deltaX: event.deltaX, time: event.timeStamp };
      const zoomed = (visualViewport?.scale ?? 1) > 1.001; // magnified by Safari: the wheel pans it, no gestures
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
