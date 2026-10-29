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
    // Keep the tabs of the space in front running while Safari is in use
    // (background/keep-ready.js, setting keepTabsReadyMinutes): Safari drops a
    // suspended tab's drawn layers, so switching to it flashes.
    keepTabsReady: true,
    // A tab never in front is brought to the front and straight back, out of
    // sight, before Margin first shows it (background/tabs.js introduceTab):
    // WebKit then keeps the page before on screen while it paints.
    introduceTabs: true,
    // Before Safari swaps web views, refresh the destination tab's own copy
    // of the sidebar while it is still hidden (background/tabs.js +
    // content/core.js). Chrome keeps hidden tabs' last frames and does not
    // need the extra storage read / script round trip.
    prepareSidebar: true,
    // The narrow icon rail on pages Margin can't fit (content/layout.js,
    // setting compactWhenPushed): off for now, per Tirth; such pages are
    // pushed by the full sidebar. True brings it back.
    compactRail: false,
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
    // "Keep open" fits pages beside the sidebar (content/shell.js), using
    // Safari's early content scripts and Navigation API (26.2+).
    shell: true,
    // The content script writes the page into the card itself.
    shellPageWrite: false,
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
    prepareSidebar: false,
    compactRail: false, // as in Safari's profile
    // Wheel deltas are in the page's zoomed pixels (Chromium divides them by
    // the page's zoom).
    zoomedWheel: true,
    nativeApp: false, // no Mac app for Chrome (yet)
    // Not needed (and a page-wide non-passive wheel listener costs scroll
    // performance in Chrome).
    blockGestures: false,
    // chrome.search.query: Chrome's default engine.
    search: 'browser',
    // "Keep open" fits pages beside the sidebar too (content/shell.js).
    shell: true,
    // Chrome runs a document.write from a content script under the
    // extension's CSP, so the page's scripts wouldn't run in the card: a
    // page-world script writes it instead (content/shell-writer.js).
    shellPageWrite: true,
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
// Also on the global, for the console and the E2E tests.
(globalThis.Margin ??= {}).platform = platform;
