// What differs between the Safari and Chrome builds. One file, both
// profiles: `npm run build` stamps BUILD_TARGET for dist/safari and
// dist/chrome. Unstamped (unit tests), it detects the browser from the
// extension's own URL scheme.

const PROFILES = {
  safari: {
    name: 'safari',
    // Safari gives extensions no tab.favIconUrl: fetch each site's own icon.
    fetchFavicons: true,
    // ⌘T reaches Margin only while Safari's "New tabs open with" is Margin,
    // which Safari resets: note it when that looks lost (background/newtab-hint.js).
    newTabHint: true,
    // Wake a hidden tab's process before showing it (background/tabs.js
    // wakeTab): Safari blanks a suspended tab until it has drawn again.
    wakeTabs: true,
    // Keep the tab just left running for a minute (background/keep-ready.js,
    // setting keepLeftTabReadyMinutes): Safari drops a suspended tab's drawn
    // layers, so switching back to it flashes.
    keepTabsReady: true,
    // A tab never in front is brought to the front and straight back, out of
    // sight, before Margin first shows it (background/tabs.js introduceTab):
    // WebKit then keeps the page before on screen while it paints.
    introduceTabs: true,
    // A tab Safari unloaded is loaded behind the page before Margin shows it,
    // brought to the front and straight back as an introduction is
    // (background/tabs.js restoreTab): Safari shows a dark window until its
    // document arrives otherwise.
    restoreTabs: true,
    // After a relaunch, the tabs likely to be clicked next are loaded behind
    // the page, one at a time, while the user is idle (background/warm-up.js,
    // setting warmUpTabs): Safari brings every tab back unloaded.
    warmUp: true,
    // Before Safari swaps web views, refresh the destination tab's own copy
    // of the sidebar while it is still hidden (background/tabs.js +
    // content/core.js). Chrome keeps hidden tabs' last frames and does not
    // need the extra storage read / script round trip.
    prepareSidebar: true,
    // A page loading hidden still paints and records its first contentful
    // paint (WebKit: shared/page-ready.js), so a tab loading behind is shown
    // once that has come and something of its own is drawn.
    hiddenPaints: true,
    // Wheel deltas are in screen points whatever the page's zoom (WebKit's
    // WheelEvent passes the platform's deltas on as they are).
    zoomedWheel: false,
    // Margin's Mac app (its set-up window) hears from the extension
    // (background/onboarding.js, native messaging).
    nativeApp: true,
    // Trackpad swipe back/forward and pinch-for-all-tabs can be blocked
    // (shared/gestures.js; setting `blockGestures`).
    blockGestures: true,
    // No search API: the engine is learned from Safari's own searches
    // (shared/search.js).
    search: 'learn',
    marginFullscreen: false,
    // Default shortcuts (Settings; Margin's page listener). Tabs on ⌥⌘↓/↑
    // like Arc, on top of the ⌃⌘↓/↑ manifest commands, which stay ⌃⌘ in
    // both builds: verified working in Safari, while ⌥⌘↓/↑ as a manifest
    // command did not respond there. Spaces on ⌃⌘→/← because Safari keeps
    // ⌘⌥←/→ for its own tab switching.
    navigation: {
      nextTab: 'Alt+Meta+ArrowDown',
      prevTab: 'Alt+Meta+ArrowUp',
      nextSpace: 'Ctrl+Meta+ArrowRight',
      prevSpace: 'Ctrl+Meta+ArrowLeft',
    },
  },
  chrome: {
    name: 'chrome',
    // Chrome provides tab.favIconUrl: no extra requests.
    fetchFavicons: false,
    // Chrome always gives ⌘T to the extension's new-tab page.
    newTabHint: false,
    wakeTabs: false,
    keepTabsReady: false, // Chrome keeps hidden tabs' last frames
    introduceTabs: false,
    restoreTabs: false,
    warmUp: false, // Chrome loads restored tabs itself (its session restore), and keeps them drawn
    prepareSidebar: false,
    hiddenPaints: false, // Chrome doesn't paint a hidden tab (no paint entry comes for it): one loading behind is shown once loaded
    // Wheel deltas are in the page's zoomed pixels (Chromium divides them by
    // the page's zoom).
    zoomedWheel: true,
    nativeApp: false, // no Mac app for Chrome (yet)
    // Not needed (and a page-wide non-passive wheel listener costs scroll
    // performance in Chrome).
    blockGestures: false,
    // chrome.search.query: Chrome's default engine.
    search: 'browser',
    // "Margin full screen": full screen with no toolbar at all. In its own
    // full screen Chrome shows the toolbar for a second on every tab change
    // (BrowserView::RevealTopContainerIfNeeded); in full screen an extension
    // starts it shows none (background/fullscreen.js).
    marginFullscreen: true,
    // Same as the manifest commands (⌃⌘ + arrows; Chrome refuses ⌘⌥ there
    // and then won't load the extension at all).
    navigation: {
      nextTab: 'Ctrl+Meta+ArrowDown',
      prevTab: 'Ctrl+Meta+ArrowUp',
      nextSpace: 'Ctrl+Meta+ArrowRight',
      prevSpace: 'Ctrl+Meta+ArrowLeft',
    },
  },
};

const BUILD_TARGET = 'safari'; // set by scripts/build.js
const detect = () => {
  try {
    const api = globalThis.browser ?? globalThis.chrome;
    return api?.runtime?.getURL?.('').startsWith('safari-web-extension:') ? 'safari' : 'chrome';
  } catch {
    return 'chrome';
  }
};

/** @typedef {typeof PROFILES.safari} Platform */
/** @type {Platform} */
export const platform = PROFILES[BUILD_TARGET ?? detect()];
export { PROFILES };
// Whether a page sends the background a request of this type at all
// (content/core.js send, the new-tab page's): a wake ahead of a switch only
// where tabs are woken, and a page's word that it came into view only where
// tabs are introduced (background/tabs.js WebKit's mark). In Chrome each
// would start its service worker (shut down 30 s after its last event) for
// nothing: the sidebar coming out, a pointer resting on a row or a space's
// icon, a swipe, a tab shown.
/** @param {string} type */
export const asksBackground = (type) => (type === 'prewake' ? !!platform?.wakeTabs : type === 'inView' ? !!platform?.introduceTabs : true);
// Whether a page may be a new web view's (content/core.js `made`, background/
// tabs.js WebKit's mark): made from the tab's saved history (`type`, its
// PerformanceNavigationTiming type, 'back_forward': how Safari restores a tab
// it unloaded, or one at a launch), or its tab's first document (a link from
// another app opened in front). A reload is neither, whatever the tab's
// history: WebKit reloads in the same web view, which keeps its mark (counted,
// a reload of a tab with one entry dropped a proof, and its next return was
// flipped for nothing).
/** @param {string | null | undefined} type @param {number} historyLength */
export const madeAfresh = (type, historyLength) => type === 'back_forward' || (historyLength === 1 && (type == null || type === 'navigate'));
// Also on the global, for the console and the E2E tests.
(globalThis.Margin ??= {}).platform = platform;
