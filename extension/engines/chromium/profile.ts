// Chromium's profile: what Chrome, Edge and the other Chromium browsers can do, as shared code asks it
// (extension/shared/platform.ts). The Chromium build takes only this one (scripts/build.ts `#engine/profile`).
import type { Profile } from '../../shared/platform.ts';
import { NAVIGATION_DEFAULTS } from '../../shared/navigation-defaults.ts';

// Where Margin's app runs, by the browser's own word (its user agent): the Mac (`Macintosh`) and Windows
// (`Windows NT`). Chrome's and Edge's copies link to the app there, through its connector, over the same
// WebSocket as Safari's (docs/PROTOCOL.md "Transport (Chrome and Edge)").
const linksHere = () => /\b(?:Macintosh|Windows NT)\b/.test(globalThis.navigator?.userAgent ?? '');

export const profile: Profile = {
  name: 'chrome',
  // Chrome provides tab.favIconUrl: no extra requests.
  fetchFavicons: false,
  // Chrome always gives ⌘T to the extension's new-tab page.
  newTabHint: false,
  sleepTabs: 'discard', // tabs.discard: Chrome loads the tab again as it's shown
  // Wheel deltas are in the page's zoomed pixels (Chromium divides them by
  // the page's zoom).
  zoomedWheel: true,
  // No extension handler (Safari's set-up messages). Chrome and Edge still link to Margin's app on the Mac and
  // Windows, through its connector (linksApp, below).
  nativeApp: false,
  // Not needed (and a page-wide non-passive wheel listener costs scroll
  // performance in Chrome).
  blockGestures: false,
  // chrome.search.query: Chrome's default engine.
  search: 'browser',
  // "Margin full screen": full screen with no toolbar at all. In its own
  // full screen Chrome shows the toolbar for a second on every tab change
  // (BrowserView::RevealTopContainerIfNeeded); in full screen an extension
  // starts it shows none (fullscreen.ts, here).
  marginFullscreen: true,
  // Chrome's service worker opens WebSockets fine: no socket guard.
  socketInWorker: true,
  socketGuard: false,
  // Chrome matches its commands before the page.
  pageCommandKeys: false,
  navigationId: 'chrome',
  navigation: NAVIGATION_DEFAULTS.chrome,
  linksApp: linksHere,
  // Edge's user agent says `Edg/` (this build runs in both, and in the other Chromium browsers).
  browser: () => (/\bEdg\//.test(globalThis.navigator?.userAgent ?? '') ? 'edge' : 'chrome'),
};
