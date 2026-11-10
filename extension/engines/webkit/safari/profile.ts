// Safari's profile: what it can do, as shared code asks it (extension/shared/platform.ts). The Safari build
// takes only this one (scripts/build.ts `#engine/profile`).
import type { Profile } from '../../../shared/platform.ts';
import { NAVIGATION_DEFAULTS } from '../../../shared/navigation-defaults.ts';

export const profile: Profile = {
  name: 'safari',
  // Safari gives extensions no tab.favIconUrl: fetch each site's own icon.
  fetchFavicons: true,
  // ⌘T reaches Margin only while Safari's "New tabs open with" is Margin,
  // which Safari resets: note it when that looks lost (newtab-hint.ts, here).
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
  // (onboarding.ts, here; native messaging).
  nativeApp: true,
  // Trackpad swipe back/forward and pinch-for-all-tabs can be blocked
  // (shared/gestures.ts; setting `blockGestures`).
  blockGestures: true,
  // No search API: the engine is learned from Safari's own searches
  // (shared/search.ts).
  search: 'learn',
  marginFullscreen: false,
  // A worker's WebSocket hangs WebKit's background (docs/PROTOCOL.md Transport step 9): the link's socket only
  // from a page, and the socket guard (background/link.ts).
  socketInWorker: false,
  socketGuard: true,
  // WebKit gives the focused page every ⌘ key before the menu, so Margin's page listener takes the manifest
  // commands' keys too (shared/shortcuts.ts commandKeys).
  pageCommandKeys: true,
  // Default shortcuts (Settings; Margin's page listener; Margin.app holds them while it draws): shared/navigation-defaults.ts.
  navigationId: 'safari-2',
  navigation: NAVIGATION_DEFAULTS['safari-2'],
  // Always linked to Margin.app, through Safari's extension handler.
  linksApp: () => true,
  browser: () => 'safari',
};
