// What differs between the Safari and Chrome builds. One file, both
// profiles: `npm run build` stamps BUILD_TARGET for dist/safari and
// dist/chrome. Unstamped (unit tests), it detects the browser from the
// extension's own URL scheme.

const PROFILES = {
  safari: {
    name: 'safari',
    // Safari gives extensions no tab.favIconUrl: fetch each site's own icon.
    fetchFavicons: true,
    // Trackpad swipe back/forward and pinch-for-all-tabs can be blocked
    // (shared/gestures.js; setting `blockGestures`).
    blockGestures: true,
    // No search API: the engine is learned from Safari's own searches
    // (shared/search.js).
    search: 'learn',
    // "Keep open" fits pages beside the sidebar (content/shell.js), using
    // Safari's early content scripts and Navigation API (26.2+).
    shell: true,
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
    // Not needed (and a page-wide non-passive wheel listener costs scroll
    // performance in Chrome).
    blockGestures: false,
    // chrome.search.query: Chrome's default engine.
    search: 'browser',
    // Push layout only: Chrome runs a document.write from a content script
    // under the extension's CSP, so the page's scripts wouldn't run.
    shell: false,
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

const BUILD_TARGET = 'chrome'; // set by scripts/build.js
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
