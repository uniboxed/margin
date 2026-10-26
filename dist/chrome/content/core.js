// Margin on web pages: everything it does there, whatever the theme. Renders
// from storage.local; when to show, dock, push the page, follow gestures and
// shortcuts is decided here. What it looks like is the active theme's
// (themes/<id>/content.js, a separate script that runs right after this
// one; see themes/register.js for what a theme provides).
import * as V from '../shared/view.js';
import { createHost } from '../shared/dom.js';
import { installGestureGuard, atPageTop, canSwipe, zoomForPinch } from '../shared/gestures.js';
import { createPullTracker, createSwipeTracker, DEFAULTS as PULL_DEFAULTS } from '../shared/pull.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

// Starts Margin in this page; false when it shouldn't (or already did).
// `onTheme(theme)` runs once the theme is mounted (content/main.js wires the
// palette then).
/** @param {{ onTheme?: (theme: any) => void }} [options] */
export function startCore({ onTheme } = {}) {
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
    // Every host of the earlier copy (any theme's: they're all margin-*-host).
    const hosts = [...(document.documentElement?.children ?? [])].filter((node) => /^margin-.*-host$/.test(node.localName));
    for (const stale of /** @type {HTMLElement[]} */ (hosts)) {
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
  /**
   * @template {MessageType} K
   * @param {K} type a handler in background.js
   * @param {Request<K>} [payload]
   * @param {boolean} [retry]
   * @returns {Promise<Result<K> | undefined>} undefined when it failed
   */
  async function send(type, payload = {}, retry = true) {
    try {
      const res = await api.runtime.sendMessage({ type, ...payload });
      if (res?.ok) return res.result;
      if (res) return void console.warn('[margin]', type, res.error);
    } catch (err) {
      if (!retry) return void console.warn('[margin]', type, err);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  // ---- the theme -------------------------------------------------------------
  // What Margin looks like: the theme's view, mounted into the closed shadow
  // root. Nothing is drawn before it's mounted (usually at once: its script
  // runs right after this one).
  let theme = null;
  let view = null;
  let firstRender = true; // until the first render, nothing has been drawn
  // The theme's frame around the page card (px): the push and the hover hit
  // area end there.
  const inset = () => theme?.geometry?.inset ?? 0;
  // "+ New tab" opens the command palette here (content/palette.js sets openPalette).
  const onNewTab = () => (Margin.content.openPalette ? Margin.content.openPalette() : send('newTab', { windowId }));
  // While resizing: move the frame edge and, with "Keep open", the pushed
  // page along with it (at most once per animation frame).
  let liveWidth = null;
  let widthFrame = null;
  const onWidth = (width, { done }) => {
    liveWidth = width;
    if (done) return applyLiveWidth();
    widthFrame ??= requestAnimationFrame(applyLiveWidth);
  };
  function applyLiveWidth() {
    widthFrame = null;
    view?.setWidth(liveWidth);
    if (pushed) setPushed(true, liveWidth);
    Margin.shell?.setLayout({ width: liveWidth });
  }
  function mountTheme() {
    if (view || !Margin.theme) return;
    try {
      view = Margin.theme.mount({ shadow, document, send, onNewTab, onWidth });
      theme = Margin.theme;
    } catch (err) {
      return console.error('[margin] theme', Margin.theme.id, 'failed to start:', err);
    }
    applyColorScheme();
    onTheme?.(theme);
    if (state) render();
    if (reason) setOpen(true); // hovered or toggled before it was there
  }
  Margin.content.themeArrived = mountTheme;
  // The theme's registered script didn't run on this page (Safari loads
  // stored registrations a moment after it starts, and pages open when Margin
  // was installed only get this script): ask the background for it.
  let themeRequested = false;
  function requestTheme() {
    if (view || themeRequested) return;
    themeRequested = true;
    // If it didn't work, the next state change asks again.
    send('injectTheme').then((ok) => { if (!ok) themeRequested = false; });
  }

  // ---- Light/Dark: follows only the Mac's appearance, never the page ---------

  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const colorScheme = () => (systemDark.matches ? 'dark' : 'light');
  Margin.content.colorScheme = colorScheme;
  const applyColorScheme = () => view?.setColorScheme(colorScheme());
  systemDark.addEventListener?.('change', applyColorScheme);

  // ---- visibility ---------------------------------------------------------

  /** @type {import('../../types/margin').State | null} */
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
  // Hover: floating over the page. Keep open: docked, with the page pushed
  // right (or, in the fitted layout, its card placed beside the sidebar).
  let isOpen = false;
  function setOpen(open) {
    if (!view) return;
    const docked = open && pinnedOpen();
    const width = view.width();
    isOpen = open;
    view.setLayout({ open, docked, width });
    host.dataset.open = String(open); // test/debug hook; reveals nothing private
    setPushed(docked, width);
    Margin.shell?.setLayout({ docked, width, inset: inset(), radius: theme.geometry?.radius });
    if (state) syncPlaceholder();
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
  const showPill = (instant = false) => {
    clearTimeout(loaderHideTimer);
    view?.setLoading(true, { instant });
    host.dataset.loading = 'true'; // test/debug hook
  };
  const hidePill = (delay = 0) => {
    clearTimeout(loaderHideTimer);
    loaderHideTimer = setTimeout(() => {
      view?.setLoading(false);
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
    showPill(placeholderTookOver);
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
  /** @param {{ state: string, progress?: number }} pull */
  function showPull({ state: phase, progress }) {
    if (pullRefreshing) return;
    if (phase === 'trigger') return refreshFromPull();
    view?.setPull({ phase, progress }); // 'idle' | 'tracking' | 'armed'
  }
  function refreshFromPull() {
    pullRefreshing = true;
    view?.setPull({ phase: 'refreshing' });
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
    view?.setPull({ phase: 'idle' });
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
  /** @param {{ state: string, progress?: number, direction?: number }} swipe */
  function showSwipe({ state: phase, progress, direction }) {
    if (phase === 'trigger') return navigateBySwipe(direction);
    if (phase === 'idle' || !direction) return view?.setSwipe({ phase: 'idle' });
    clearTimeout(swipeHideTimer);
    view?.setSwipe({ phase, progress, direction }); // 'tracking' | 'armed'
  }
  function navigateBySwipe(direction) {
    view?.setSwipe({ phase: 'going', direction });
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
    view?.setZoom(pageZoom);
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
    zoomHudTimer = setTimeout(() => view?.setZoom(null), 700);
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
      margin-right: ${inset()}px !important;
      width: auto !important;
      overflow-x: hidden !important;
    }
  }`;
  const canPush = document.documentElement instanceof HTMLHtmlElement;
  let pushed = false;
  let pushedWidth = null;
  let pushSheet = null;
  let pushStyle = null;
  function setPushed(on, width) {
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
    if (reason !== 'hover' || hideTimer || view?.isBusy()) return;
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
  Margin.content.uiBusy = () => !!view?.isBusy() || !!Margin.content.paletteOpen?.();

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
        else if (!view) return;
        else if (x > view.width() + inset()) scheduleHide();
        else if (hideTimer && isOpen) {
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
    if (!state || !view) return;
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    view.update(state, { windowId, tabId });
    Margin.content.onState?.(state, { tabId, windowId });
    if (!reason) setOpen(pinnedOpen());
    updateGestureGuards();
    if (firstRender) {
      firstRender = false;
      startLoader(); // now its position (docked or not) is known
      // performance.now() counts from navigation start: how long the page
      // went without its sidebar (see TESTING.md).
      timing.rendered = Math.round(performance.now());
      view.ready(); // animations may run from now on
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
    requestTheme(); // only if it isn't here by now
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());

  // One debug-level line per page (hidden unless the console shows Debug
  // messages), once it has loaded: where the time before the sidebar
  // went. All numbers are ms since navigation start. If "injected" is late,
  // Safari ran the content script late; if "storage" is late, the
  // storage.local read was slow; "rendered" is when the sidebar appeared.
  function logTiming() {
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
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
    const links = [.../** @type {NodeListOf<HTMLLinkElement>} */ (document.querySelectorAll('link[rel]'))].map((l) => ({
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
    // Background (⌘T hand-off): can Margin open its palette here? Not until
    // the theme is mounted (then the new-tab page opens its own instead).
    if (message?.type === 'ping') return sendResponse(Margin.content.openPalette ? 'pong' : 'starting');
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else if (message.command === 'peek') Margin.content.peek?.();
    else Margin.content.onCommand?.(message.command);
  });
  mountTheme(); // if the theme's script ran first
  return true;
}
