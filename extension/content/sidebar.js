// Injected overlay. Renders from storage.local, never pushes the page.
import * as V from '../shared/view.js';
import { el, createHost, adoptStyles, createSidebar } from '../shared/ui.js';
import { installGestureGuard, atPageTop, canSwipe, zoomForPinch } from '../shared/gestures.js';
import { createPullTracker, createSwipeTracker, DEFAULTS as PULL_DEFAULTS } from '../shared/pull.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';
import * as styles from './styles.js';

// Starts Margin in this page; false when it shouldn't (or already did).
export function startSidebar() {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return false;

  const Margin = (globalThis.Margin ??= {});
  // Already running in this page: WebKit runs the content scripts again in
  // open pages, in the same world, when Margin's site permissions change.
  if (Margin.content) return false;
  Margin.content = { api, startedAt: Date.now() }; // see background.js injectIntoOpenTabs
  // A sidebar that isn't this world's was left by an earlier copy of Margin:
  // it was installed or updated while the page was open (WebKit adds this
  // copy to open pages in a world of its own; so does background.js
  // injectIntoOpenTabs elsewhere). It no longer works, but its scripts stay:
  // this copy takes over now, leaves swipe and pull-to-refresh to it (they act
  // on the page directly, so both would go back twice), and the page reloads
  // to start clean once that can't lose anything (reloadWhenSafe).
  const replacing = !!document.querySelector('margin-sidebar-host');
  if (replacing) {
    for (const stale of document.querySelectorAll('margin-sidebar-host, margin-palette-host')) {
      stale.style.setProperty('display', 'none', 'important');
      stale.remove();
    }
    reloadWhenSafe();
  }
  // Hidden (not the tab in front, or once the user leaves it), nothing
  // typed into it (judged generously: any text in a field or editor, in any
  // same-origin frame, counts), no media playing or call going, and not done
  // in the last 30s (then it tries again after). Hidden tabs a few at a time.
  // The background loads the page's URL again once it has registered what a
  // page load needs (the fitted layout): a GET, not a reload, which would send
  // a form again; WebKit doesn't add a history entry for the same URL.
  function reloadWhenSafe() {
    const inUse = (doc, depth = 0) => {
      if (!doc || depth > 4) return false;
      const active = doc.activeElement;
      if (active && (active.isContentEditable || active.matches?.('textarea, select, input:not([type=hidden], [type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=image])'))) return true;
      for (const el of doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')) if (el.value.trim()) return true;
      for (const el of doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')) if (el.isContentEditable && el.textContent.trim()) return true;
      for (const el of doc.querySelectorAll('select')) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
      for (const el of doc.querySelectorAll('input[type=checkbox], input[type=radio]')) if (el.checked !== el.defaultChecked) return true;
      for (const el of doc.querySelectorAll('audio, video')) if ((!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream)) return true;
      for (const frame of doc.querySelectorAll('iframe, frame')) {
        let inner;
        try {
          inner = frame.contentDocument;
        } catch {
          continue; // another origin: its own business
        }
        if (inUse(inner, depth + 1)) return true;
      }
      return false;
    };
    const busy = () => {
      try {
        return navigator.mediaSession?.playbackState === 'playing' || inUse(document);
      } catch {
        return true;
      }
    };
    let retry = null;
    const go = () => {
      if (!document.hidden || busy()) return;
      const KEY = 'margin-reloaded-for-update';
      try {
        const wait = 30000 - (Date.now() - (Number(sessionStorage.getItem(KEY)) || 0));
        if (wait > 0) {
          clearTimeout(retry);
          retry = setTimeout(go, wait + 100);
          return;
        }
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {}
      document.removeEventListener('visibilitychange', go);
      clearTimeout(retry);
      console.info('[margin] Margin was updated while this page was open: loading it again');
      api.runtime.sendMessage({ type: 'reloadForUpdate' }).catch(() => {});
    };
    document.addEventListener('visibilitychange', go);
    setTimeout(go, 500 + Math.random() * 3000);
  }

  // Fitted layout (content/shell.js, registered while "Keep open" is on; it
  // runs right after this script): the page moves into a frame, the "card",
  // and this document becomes Margin's shell around it. Whatever must also
  // hear the page (pointer, keys, wheel, pinch) registers with onCard and is
  // attached to the card's window once the page is in it.
  const cardHooks = [];
  Margin.content.onCard = (fn) => {
    cardHooks.push(fn);
    if (Margin.shell?.card) fn(Margin.shell.card);
  };
  Margin.content.cardReady = (win) => {
    for (const fn of cardHooks) fn(win);
  };

  // Reveal zone: 10px, or 24px in a full-screen window, where Safari's own
  // sidebar opens if the cursor rests at the very edge (see view.revealZone).
  const edgePx = () =>
    V.revealZone({ outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height });
  const HIDE_DELAY_MS = 300;
  const FRAME_PX = 8; // keep in sync with sidebar.css (.frame .hole inset, floating inset)
  // The sidebar width is a setting (resizable 160–500px): see sidebar.width().

  const host = createHost(document, 'margin-sidebar-host');
  const shadow = host.attachShadow({ mode: 'closed' });

  // Some pages replace <html>'s children; put the host back if it's removed.
  const attach = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document, { childList: true });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  document.addEventListener('DOMContentLoaded', attach);

  // If the background was unloaded and the first message doesn't wake it in
  // time, retry once.
  async function send(type, payload = {}, retry = true) {
    try {
      const res = await api.runtime.sendMessage({ type, ...payload });
      if (res?.ok) return res.result;
      if (res) return console.warn('[margin]', type, res.error);
    } catch (err) {
      if (!retry) return console.warn('[margin]', type, err);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  const sidebar = createSidebar({
    document,
    send,
    mode: 'overlay',
    // "+ New tab" opens the command palette here (palette.js sets openPalette).
    onNewTab: () => (Margin.content.openPalette ? Margin.content.openPalette() : send('newTab', { windowId })),
    // While resizing: move the frame edge and, with "Keep open", the pushed
    // page along with it (at most once per animation frame).
    onWidth: (width, { done }) => {
      liveWidth = width;
      if (done) return applyLiveWidth();
      widthFrame ??= requestAnimationFrame(applyLiveWidth);
    },
  });
  let liveWidth = null;
  let widthFrame = null;
  function applyLiveWidth() {
    widthFrame = null;
    frame.style.setProperty('--width', `${liveWidth}px`);
    cardEdge.style.setProperty('--width', `${liveWidth}px`);
    loader.style.setProperty('--width', `${liveWidth}px`);
    pull.style.setProperty('--width', `${liveWidth}px`);
    swipe.style.setProperty('--width', `${liveWidth}px`);
    zoomHud.style.setProperty('--width', `${liveWidth}px`);
    if (pushed) setPushed(true, liveWidth);
    Margin.shell?.setLayout({ width: liveWidth });
  }
  // Arc-style frame: sidebar-colored strips around the page card with its
  // corners, shown while the sidebar is open. Never takes clicks.
  const frame = el(document, 'div', { class: 'frame', 'aria-hidden': 'true' }, el(document, 'div', { class: 'hole' }));
  // The page card's continuous corners and soft shadow, above the sidebar so
  // the shadow also falls on its edge (sidebar.css .card-edge).
  const cardEdge = el(document, 'div', { class: 'card-edge', 'aria-hidden': 'true' });
  // Arc-style page-load indicator: a small dark pill, centered over the page
  // (in the frame's top strip when docked), shown while the page loads.
  const loader = el(document, 'div', { class: 'loader', 'aria-hidden': 'true' }, el(document, 'div', { class: 'bar' }));
  // Pull-to-refresh indicator (Safari; shared/pull.js): a dark round badge
  // that slides down with the pull, its ring filling to the threshold, then
  // spins while the page reloads. Built with DOM calls (no innerHTML: some
  // pages enforce Trusted Types).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const pullRing = svg('circle', { class: 'ring', cx: 14, cy: 14, r: 10, pathLength: 100 });
  const pullArrow = svg('path', { class: 'arrow', d: 'M14 8.5v10M9.75 14.5 14 18.75l4.25-4.25' });
  const pullIcon = svg('svg', { viewBox: '0 0 28 28', width: 28, height: 28 });
  pullIcon.append(svg('circle', { class: 'track', cx: 14, cy: 14, r: 10 }), pullRing, pullArrow);
  const pull = el(document, 'div', { class: 'pull', 'aria-hidden': 'true' }, pullIcon);
  // Swipe back/forward badge (Arc): a dark circle centered on the page's left
  // (back) or right (forward) edge, the arrow in its visible half; it darkens
  // as the swipe goes on.
  const swipeIcon = svg('svg', { viewBox: '0 0 36 36', width: 36, height: 36 });
  swipeIcon.append(svg('path', { d: 'M28 18H8.5M17 9.5 8.5 18l8.5 8.5' }));
  const swipe = el(document, 'div', { class: 'swipe', 'aria-hidden': 'true' }, swipeIcon);
  // Pinch-to-zoom readout ("125%"), centered over the page while pinching.
  const zoomHud = el(document, 'div', { class: 'zoom-hud', 'aria-hidden': 'true' });
  shadow.append(frame, sidebar.el, cardEdge, loader, pull, swipe, zoomHud);

  // Styles are bundled in content/styles.js and applied synchronously, so the
  // panel is styled from the first frame (no fetch, no unstyled flash).
  adoptStyles(shadow, styles.sidebar);
  // No slide/fade on the first render: a kept-open sidebar should simply be
  // there when the page appears, not animate in on every navigation.
  sidebar.el.classList.add('instant');
  frame.classList.add('instant');
  cardEdge.classList.add('instant');
  let firstRender = true;

  // ---- theme: follow the page, then the OS -------------------------------

  // One fixed sidebar color: follows only the Mac's Light/Dark appearance,
  // never the page (so it doesn't change from tab to tab).
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const pageTheme = () => (systemDark.matches ? 'dark' : 'light');
  Margin.content.theme = pageTheme;
  const applyTheme = () => {
    const theme = pageTheme();
    sidebar.setTheme(theme);
    frame.dataset.theme = theme;
  };
  applyTheme();
  systemDark.addEventListener?.('change', applyTheme);

  // ---- visibility ---------------------------------------------------------

  let state = null;
  // Safari: keep trackpad swipes, pinches and the page bounce from leaving or
  // distorting the page (setting); re-synced on every render.
  const guardWindow = (win) => installGestureGuard({ getSettings: () => state?.settings, onPinch: (pinch) => handlePinch(pinch), win });
  const gestureGuard = platform?.blockGestures ? guardWindow(window) : null;
  const cardGuards = [];
  if (gestureGuard) Margin.content.onCard((win) => cardGuards.push(guardWindow(win)));
  const updateGestureGuards = () => {
    gestureGuard?.update();
    for (const guard of cardGuards) guard.update();
  };
  let reason = null; // 'hover' | 'toggle' | null
  let hideTimer = null;

  const pinnedOpen = () => !!state?.settings?.sidebarPinnedOpen;
  // Hover: a floating card over the page. Keep open: docked, with the frame
  // around the page and the page pushed right.
  function setOpen(open) {
    const docked = open && pinnedOpen();
    sidebar.el.classList.toggle('open', open);
    sidebar.el.classList.toggle('docked', docked);
    frame.classList.toggle('open', docked);
    cardEdge.classList.toggle('open', docked);
    loader.classList.toggle('in-frame', docked);
    pull.classList.toggle('in-frame', docked);
    swipe.classList.toggle('in-frame', docked);
    zoomHud.classList.toggle('in-frame', docked);
    host.dataset.open = String(open); // test/debug hook; reveals nothing private
    setPushed(docked);
    Margin.shell?.setLayout({ docked, width: sidebar.width() });
    if (state) syncPlaceholder();
    frame.style.setProperty('--width', `${sidebar.width()}px`);
    cardEdge.style.setProperty('--width', `${sidebar.width()}px`);
    loader.style.setProperty('--width', `${sidebar.width()}px`);
    pull.style.setProperty('--width', `${sidebar.width()}px`);
    swipe.style.setProperty('--width', `${sidebar.width()}px`);
    zoomHud.style.setProperty('--width', `${sidebar.width()}px`);
  }

  // ---- page-load indicator --------------------------------------------------
  // Margin's script starts ~0.2s into a load in Safari (it can't draw
  // earlier). If the page is still loading by Margin's first render, show the
  // pill until the load event: at least LOADER_MIN_MS so it never flickers,
  // at most LOADER_MAX_MS in case a page never finishes.
  const LOADER_MIN_MS = 500;
  const LOADER_MAX_MS = 15000;
  let loaderShownAt = null;
  let loaderMaxTimer = null;
  let loaderHideTimer = null;
  let placeholderTookOver = false; // the placeholder's pill was showing until Margin ran
  const showPill = () => {
    clearTimeout(loaderHideTimer);
    loader.classList.add('on');
    host.dataset.loading = 'true'; // test/debug hook
  };
  const hidePill = (delay = 0) => {
    clearTimeout(loaderHideTimer);
    loaderHideTimer = setTimeout(() => {
      loader.classList.remove('on');
      host.dataset.loading = 'false';
    }, delay);
  };
  // Taking over from the placeholder's pill (content/docked/w-*.css), the
  // pill shows at once (no fade-in dip) and fades out normally, even if the
  // page has already finished loading.
  // In the fitted layout the page loads in the card: the top document is
  // complete long before (card hook below).
  const pageComplete = () => (Margin.shell ? Margin.shell.card?.document.readyState === 'complete' : document.readyState === 'complete');
  function startLoader() {
    const complete = pageComplete();
    if (loaderShownAt != null || (complete && !placeholderTookOver)) return;
    loaderShownAt = performance.now();
    if (placeholderTookOver) {
      loader.classList.add('instant');
      showPill();
      requestAnimationFrame(() => requestAnimationFrame(() => loader.classList.remove('instant')));
    } else {
      showPill();
    }
    if (complete) return stopLoader();
    if (!Margin.shell) addEventListener('load', stopLoader, { once: true });
    loaderMaxTimer = setTimeout(stopLoader, LOADER_MAX_MS);
  }
  Margin.content.onCard((win) => win.addEventListener('load', () => stopLoader(), { once: true }));
  function stopLoader() {
    clearTimeout(loaderMaxTimer);
    if (loaderShownAt == null || leaving) return;
    hidePill(Math.max(0, LOADER_MIN_MS - (performance.now() - loaderShownAt)));
  }

  // Leaving the page (⌘R, a link, a form, a script navigation): show the pill
  // on this page at once. Otherwise it would only appear once the next page
  // has arrived and Margin runs there, which in Safari is the server's
  // response time plus ~0.2s. `beforeunload` doesn't keep pages out of the
  // back/forward cache in WebKit or Chrome. If the page stays after all, hide
  // it again: a "Leave page?" prompt (checked once the event is done; while
  // the prompt is up, timers wait), a download, a link that opens another
  // app, or anything the user does on the page meanwhile; at the latest after
  // LEAVING_MAX_MS. Returning from the back/forward cache hides it too.
  const LEAVING_MAX_MS = 10000;
  let leaving = false;
  let leavingTimer = null;
  function stayed() {
    if (!leaving) return;
    leaving = false;
    clearTimeout(leavingTimer);
    hidePill();
  }
  addEventListener('beforeunload', (event) => {
    if (firstRender || pullRefreshing) return; // nothing drawn yet / the pull spinner shows it
    leaving = true;
    showPill();
    clearTimeout(leavingTimer);
    leavingTimer = setTimeout(stayed, LEAVING_MAX_MS);
    setTimeout(() => {
      const prompted = event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== '');
      if (prompted) stayed();
    });
  });
  addEventListener('pageshow', (event) => { if (event.persisted) stayed(); });
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, stayed, true);
  Margin.content.onCard((win) => {
    for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, stayed, true);
  });

  // Same-page navigations a site runs through the Navigation API
  // (navigation.intercept, e.g. some single-page apps): show the pill while
  // one takes longer than TRANSITION_PILL_MS, until it finishes. Without the
  // API (or for sites that don't use it) nothing changes.
  const TRANSITION_PILL_MS = 150;
  const watchTransitions = (navigation) => navigation?.addEventListener?.('navigate', () => {
    setTimeout(() => { // the page decides during the event whether it intercepts
      const transition = navigation.transition;
      if (!transition?.finished || firstRender) return;
      let done = false;
      let shownAt = null;
      const timer = setTimeout(() => {
        if (done || leaving) return;
        shownAt = performance.now();
        showPill();
      }, TRANSITION_PILL_MS);
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (shownAt != null && !leaving) hidePill(Math.max(0, LOADER_MIN_MS - (performance.now() - shownAt)));
      };
      transition.finished.then(finish, finish);
    });
  });
  watchTransitions(globalThis.navigation);
  Margin.content.onCard((win) => watchTransitions(win.navigation));

  // ---- pull to refresh (Safari builds) ---------------------------------------
  // Safari's own pull-to-refresh goes away with the page bounce (gesture
  // guard); this is Margin's: pull down at the top of a page past the
  // threshold and let go to reload. The gesture logic is shared/pull.js.
  let pullRefreshing = false;
  let pullStuckTimer = null;
  const pullEnabled = () => !replacing && state?.settings?.blockGestures !== false && state?.settings?.pullToRefresh !== false;
  function showPull({ state: phase, progress }) {
    if (pullRefreshing) return;
    if (phase === 'trigger') return refreshFromPull();
    if (phase === 'idle') {
      pull.classList.remove('tracking', 'armed');
      pull.style.removeProperty('--pull');
      return;
    }
    pull.classList.add('tracking');
    pull.classList.toggle('armed', phase === 'armed');
    pull.style.setProperty('--pull', String(Math.min(progress, 1.2)));
  }
  function refreshFromPull() {
    pullRefreshing = true;
    pull.classList.remove('tracking');
    pull.classList.add('armed', 'refreshing');
    pull.style.setProperty('--pull', '1');
    host.dataset.pullRefresh = 'true'; // test/debug hook
    // A moment to see it start, then reload (the next page's pill follows).
    setTimeout(() => {
      location.reload();
      // If the page stays (a cancelled "Leave page?" prompt), the next click
      // or key clears it; at the latest after 10s.
      for (const target of [window, Margin.shell?.card].filter(Boolean)) {
        for (const type of ['pointerdown', 'keydown']) target.addEventListener(type, resetPull, { capture: true, once: true });
      }
    }, 300);
    pullStuckTimer = setTimeout(resetPull, 10000);
  }
  function resetPull() {
    if (!pullRefreshing) return;
    pullRefreshing = false;
    clearTimeout(pullStuckTimer);
    pull.classList.remove('armed', 'refreshing', 'tracking');
    pull.style.removeProperty('--pull');
    delete host.dataset.pullRefresh;
  }
  addEventListener('pageshow', (event) => { if (event.persisted) resetPull(); });

  // ---- swipe back/forward (Safari builds) ------------------------------------
  // Safari's two-finger swipe is blocked by the gesture guard; this is
  // Margin's, with Arc's edge badge: swipe sideways where nothing scrolls
  // sideways, past the threshold, and let go to go back (fingers moving
  // right) or forward. The gesture logic is shared/pull.js (axis x).
  const swipeEnabled = () => !replacing && state?.settings?.blockGestures !== false && state?.settings?.swipeNavigation !== false;
  let swipeHideTimer = null;
  function showSwipe({ state: phase, progress, direction }) {
    if (phase === 'trigger') return navigateBySwipe(direction);
    if (phase === 'idle' || !direction) {
      swipe.classList.remove('active', 'tracking', 'armed');
      swipe.style.removeProperty('--swipe');
      return;
    }
    clearTimeout(swipeHideTimer);
    swipe.classList.add('active', 'tracking');
    swipe.classList.toggle('forward', direction > 0);
    swipe.classList.toggle('armed', phase === 'armed');
    swipe.style.setProperty('--swipe', String(Math.min(progress, 1)));
  }
  function navigateBySwipe(direction) {
    swipe.classList.remove('tracking');
    swipe.classList.add('active', 'armed');
    swipe.classList.toggle('forward', direction > 0);
    swipe.style.setProperty('--swipe', '1');
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
      const usable = event.deltaMode === 0 && !path.some((node) => node === host || node.localName === 'margin-palette-host');
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
    Margin.content.onCard((win) => watchWheel(win, win.document));
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
    zoomHud.textContent = `${Math.round(pageZoom * 100)}%`;
    zoomHud.classList.add('show');
    host.dataset.zoom = String(pageZoom); // test/debug hook
  }
  function handlePinch({ phase, scale }) {
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
        send('setZoom', { factor: zoom }, false);
      }
      return showZoomHud();
    }
    zoomHudTimer = setTimeout(() => zoomHud.classList.remove('show'), 700);
  }

  // ---- push (only while "Keep open" is on) ---------------------------------
  // Shifts the page right so it starts where the sidebar ends. A separate
  // adopted stylesheet (never the page's own markup or inline styles), screen
  // media only, removed as soon as "Keep open" is off. Known trade-offs are in
  // DECISIONS.md: position:fixed elements don't move, 100vw elements are
  // clipped on the right.
  const pushCss = (width) => `@media screen {
    html {
      margin-left: ${width}px !important;
      margin-right: ${FRAME_PX}px !important;
      width: auto !important;
      overflow-x: hidden !important;
    }
  }`;
  const canPush = document.documentElement instanceof HTMLHtmlElement;
  let pushed = false;
  let pushedWidth = null;
  let pushSheet = null;
  let pushStyle = null;
  function setPushed(on, width = sidebar.width()) {
    if (!canPush || Margin.shell || (on === pushed && (!on || width === pushedWidth))) return; // the fitted layout needs no push
    pushed = on;
    pushedWidth = on ? width : null;
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      pushSheet ??= new CSSStyleSheet();
      pushSheet.replaceSync(pushCss(width));
      const others = document.adoptedStyleSheets.filter((s) => s !== pushSheet);
      document.adoptedStyleSheets = on ? [...others, pushSheet] : others;
    } else if (on) {
      pushStyle ??= document.createElement('style');
      pushStyle.textContent = pushCss(width);
      if (!pushStyle.isConnected) document.documentElement.appendChild(pushStyle);
    } else {
      pushStyle?.remove();
    }
    host.dataset.pushed = String(on);
  }

  // The first-paint placeholder (content/docked/w-<width>.css, registered
  // while "Keep open" is on) pushes and paints until Margin runs. Once it does,
  // the live push above takes over (same frame, same width, so nothing moves)
  // and the placeholder is switched off on this page, so it can't fight a
  // resize or linger after "Keep open" is turned off. Only touches <html>
  // when the placeholder is present.
  function syncPlaceholder() {
    const html = document.documentElement;
    if (!canPush || html.dataset.marginDocked === 'off') return;
    if (getComputedStyle(html, '::after').content !== 'none') {
      html.dataset.marginDocked = 'off';
      placeholderTookOver = true;
    }
  }

  function show(why) {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!reason || reason === 'peek' || why === 'toggle') reason = why;
    setOpen(true);
  }
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    reason = null;
    setOpen(pinnedOpen());
  }
  function scheduleHide() {
    if (reason !== 'hover' || hideTimer || sidebar.isBusy()) return;
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }
  // With "Keep open" on, the shortcut switches back to auto-hide (hide()
  // alone would leave it pinned open).
  // The shortcut's page listener and a `commands` key can both fire for one
  // press; collapse them.
  let lastToggle = 0;
  function toggle() {
    const now = Date.now();
    if (now - lastToggle < 200) return;
    lastToggle = now;
    if (pinnedOpen()) {
      state = { ...state, settings: { ...state.settings, sidebarPinnedOpen: false } };
      send('updateSettings', { patch: { sidebarPinnedOpen: false } });
      return hide();
    }
    return reason ? hide() : show('toggle');
  }
  Margin.content.sidebar = { show, hide, toggle };
  // Something of Margin's is taking keys (fitted layout: don't hand them to the page).
  Margin.content.uiBusy = () => sidebar.isBusy() || !!Margin.content.paletteOpen?.();

  // Briefly show the sidebar (after ⌘⌥←/→) so the new space is visible even
  // in auto-hide mode. Hovering or toggling during the peek keeps it open.
  let peekTimer = null;
  function peek() {
    if (pinnedOpen() || (reason && reason !== 'peek')) return;
    show('peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => reason === 'peek' && hide(), 1200);
  }

  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space.
  shortcuts.installNavigation({ send, getSettings: () => state?.settings });
  Margin.content.onCard((win) => shortcuts.installNavigation({ send, getSettings: () => state?.settings, target: win }));
  Margin.content.peek = peek;

  // Show/hide shortcut (Settings; default Option+S), in the page itself: the
  // manifest's `commands` can't suggest it (Chrome allows four, taken by the
  // tab and space keys).
  const watchToggleKey = (win) => win.addEventListener('keydown', (e) => {
    // Not a page's synthetic key press: with Keep open on, this changes a setting.
    if (!e.isTrusted || !shortcuts.matches(e, state?.settings?.sidebarShortcut ?? 'Alt+KeyS')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);
  watchToggleKey(window);
  Margin.content.onCard(watchToggleKey);

  // `target`: this document, or the card's window in the fitted layout,
  // whose coordinates start `offsetX` px into the window.
  function watchPointer(target, offsetX = () => 0) {
    target.addEventListener(
      'mousemove',
      (e) => {
        const x = e.clientX + offsetX();
        if (x <= edgePx()) show('hover');
        else if (x > sidebar.width() + FRAME_PX) scheduleHide();
        else if (hideTimer && sidebar.el.classList.contains('open')) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
      },
      { capture: true, passive: true },
    );
    // Cursor left the window: keep open if it left through the left edge.
    target.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget && e.clientX + offsetX() > edgePx()) scheduleHide();
    });
    target.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && reason === 'toggle') hide();
      },
      true,
    );
    // Clicking the page closes a toggled sidebar (clicks inside are retargeted to the host).
    target.addEventListener('mousedown', (e) => {
      if (reason === 'toggle' && e.target !== host) hide();
    }, true);
  }
  watchPointer(document);
  Margin.content.onCard((win) => watchPointer(win, () => Margin.shell?.cardLeft() ?? 0));

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

  function render() {
    if (!state) return;
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    sidebar.update(state, { windowId, tabId });
    Margin.content.onState?.(state, { tabId, windowId });
    if (!reason) setOpen(pinnedOpen());
    updateGestureGuards();
    if (firstRender) {
      firstRender = false;
      startLoader(); // now its position (docked or not) is known
      // performance.now() counts from navigation start: how long the page
      // went without its sidebar (see TESTING.md).
      timing.rendered = Math.round(performance.now());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        sidebar.el.classList.remove('instant');
        frame.classList.remove('instant');
        cardEdge.classList.remove('instant');
      }));
    }
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  async function refresh() {
    const mine = ++version;
    const next = await api.storage.local.get(null);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return; // stale, or background not initialized yet
    state = next;
    render();
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());

  // One debug-level line per page (hidden unless the console shows Debug
  // messages), once it has loaded: where the time before the sidebar
  // went. All numbers are ms since navigation start. If "injected" is late,
  // Safari ran the content script late; if "storage" is late, the
  // storage.local read was slow; "rendered" is when the sidebar appeared.
  function logTiming() {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const fmt = (n) => (n == null ? '–' : `${Math.round(n)}`);
    console.debug(
      `[margin] timing (ms) injected=${fmt(timing.injected)} storage=${fmt(timing.storage)} rendered=${fmt(timing.rendered)}` +
        ` | page DOMContentLoaded=${fmt(nav?.domContentLoadedEventStart)} load=${fmt(nav?.loadEventStart)} keepOpen=${pinnedOpen()} fitted=${!!Margin.shell}`,
    );
  }
  if (document.readyState === 'complete') setTimeout(logTiming);
  else addEventListener('load', () => setTimeout(logTiming), { once: true });
  refresh();
  send('hello').then((ctx) => {
    if (!ctx) return;
    tabId = ctx.tabId;
    Margin.content.instanceId = ctx.instanceId; // see background.js injectIntoOpenTabs
    helloWindowId = ctx.windowId;
    render();
  });

  // Safari gives extensions no favicons: tell the background which icon this
  // page uses (it fetches and stores it once per site). Again on load, for
  // pages that add their icon from script.
  let reportedIcon = null;
  function reportIcon() {
    if (!platform?.fetchFavicons) return; // the browser provides icons (Chrome)
    const links = [...document.querySelectorAll('link[rel]')].map((l) => ({
      rel: l.rel,
      href: l.href,
      sizes: l.getAttribute('sizes') ?? '',
      type: l.type,
    }));
    const href = V.pickIconHref(links, location.href);
    if (!href || href === reportedIcon) return;
    reportedIcon = href;
    send('pageIcon', { href });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportIcon, { once: true });
  else reportIcon();
  addEventListener('load', reportIcon, { once: true });
  // Icons a page adds from script, in the fitted layout (the shell copies them).
  Margin.content.onCard((win) => win.addEventListener('load', () => setTimeout(reportIcon), { once: true }));

  api.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (message?.type === 'ping') return sendResponse('pong'); // background: is Margin running here?
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else if (message.command === 'peek') Margin.content.peek?.();
    else Margin.content.onCommand?.(message.command);
  });
  return true;
}
