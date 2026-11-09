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
    // which Safari resets: note it when that looks lost (background/newtab-hint.ts).
    newTabHint: true,
    // How a tab not used for a while is put to sleep (background/sleep.ts):
    // Safari has no tabs.discard, so Margin closes its browser tab and keeps
    // the Margin tab, not open, in its space (Margin 2: PLAN.md §6); a click
    // opens it again.
    sleepTabs: 'close',
    // Wheel deltas are in screen points whatever the page's zoom (WebKit's
    // WheelEvent passes the platform's deltas on as they are).
    zoomedWheel: false,
    // Margin's Mac app (its set-up window) hears from the extension
    // (background/onboarding.ts, native messaging).
    nativeApp: true,
    // Trackpad swipe back/forward and pinch-for-all-tabs can be blocked
    // (shared/gestures.ts; setting `blockGestures`).
    blockGestures: true,
    // No search API: the engine is learned from Safari's own searches
    // (shared/search.ts).
    search: 'learn',
    marginFullscreen: false,
    // Default shortcuts (Settings; Margin's page listener; Margin.app holds them while it draws). Tabs on ⌥⌘↓/↑
    // like Arc, spaces on ⌥⌘→/← (Tirth, 2026-11-08: those, and no ⌃⌘ arrows: the manifest commands have no keys
    // now). Safari's own ⌥⌘←/→ (its tab switching) is Margin's space switching where Margin is.
    navigationId: 'safari-2',
    navigation: {
      nextTab: 'Alt+Meta+ArrowDown',
      prevTab: 'Alt+Meta+ArrowUp',
      nextSpace: 'Alt+Meta+ArrowRight',
      prevSpace: 'Alt+Meta+ArrowLeft',
    },
  },
  chrome: {
    name: 'chrome',
    // Chrome provides tab.favIconUrl: no extra requests.
    fetchFavicons: false,
    // Chrome always gives ⌘T to the extension's new-tab page.
    newTabHint: false,
    sleepTabs: 'discard', // tabs.discard: Chrome loads the tab again as it's shown
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
    // starts it shows none (background/fullscreen.ts).
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

const BUILD_TARGET = null; // set by scripts/build.ts
const detect = () => {
  try {
    const api = globalThis.browser ?? globalThis.chrome;
    return api?.runtime?.getURL?.('').startsWith('safari-web-extension:') ? 'safari' : 'chrome';
  } catch {
    return 'chrome';
  }
};

// Either browser's profile (`navigationId`: only a profile whose shortcut defaults changed has one).
export type Platform = (typeof PROFILES)[keyof typeof PROFILES] & { navigationId?: string };
export const platform: Platform = PROFILES[BUILD_TARGET ?? detect()];
// Defaults a build had before (`shortcutDefaults` then): a saved shortcut still one of them moves to today's
// (state/model.ts normalizeShortcuts).
export const PAST_NAVIGATION = Object.freeze({
  // Safari's until 2026-11-08: spaces on ⌃⌘→/←.
  safari: Object.freeze({ nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Ctrl+Meta+ArrowRight', prevSpace: 'Ctrl+Meta+ArrowLeft' }),
});
// The Mac, by the browser's own word (its user agent says Macintosh): Chrome's and Edge's copies link to
// Margin.app only there (app/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)").
const onMac = () => /\bMacintosh\b/.test(globalThis.navigator?.userAgent ?? '');
// Whether this copy links to Margin.app: Safari's always (`nativeApp`: its extension handler), Chrome's and Edge's
// on the Mac (Margin.app's relay helper, started by native messaging).
export const linksApp = () => !!platform?.nativeApp || (platform?.name === 'chrome' && onMac());
// The browser this copy runs in, as the link names it: Edge's user agent says `Edg/` (the Chrome build runs in both).
export const browserName = (): 'safari' | 'chrome' | 'edge' => (platform?.name === 'safari' ? 'safari' : /\bEdg\//.test(globalThis.navigator?.userAgent ?? '') ? 'edge' : 'chrome');

export { PROFILES };
// Also on the global, for the console and the E2E tests.
(globalThis.Margin ??= {}).platform = platform;
