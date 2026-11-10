// What differs between browsers, as what each one can do: its engine's profile (extension/engines/webkit/safari/
// profile.ts, extension/engines/chromium/profile.ts) answers, and shared code asks it, never which
// browser this is. A build resolves `#engine/profile` to its own engine's profile only (scripts/build.ts), so the
// other's isn't in it; unbuilt (unit tests), extension/shared/any-engine-profile.ts picks one from the
// extension's own URL scheme.
import { profile } from '#engine/profile';
import type { NavigationId } from './navigation-defaults.ts';

type Navigation = { readonly nextTab: string, readonly prevTab: string, readonly nextSpace: string, readonly prevSpace: string };
export type Profile = {
  // The build's name, as saved data and the link know it (one Chromium build runs in Chrome, Edge and the rest).
  name: 'safari' | 'chrome',
  fetchFavicons: boolean,
  newTabHint: boolean,
  sleepTabs: 'close' | 'discard',
  zoomedWheel: boolean,
  nativeApp: boolean,
  blockGestures: boolean,
  search: 'learn' | 'browser',
  marginFullscreen: boolean,
  // The link's socket (background/link.ts): opened from a worker too, and its guard.
  socketInWorker: boolean,
  socketGuard: boolean,
  // Margin's page listener also takes the manifest commands' keys (shared/shortcuts.ts commandKeys).
  pageCommandKeys: boolean,
  // Its default shortcuts, and the id its settings save them under (shared/navigation-defaults.ts).
  navigationId: NavigationId,
  navigation: Navigation,
  // Whether this copy links to Margin's app (Safari's always, Chrome's and Edge's on the Mac and Windows), and the
  // browser it runs in, as the link names it.
  linksApp: () => boolean,
  browser: () => 'safari' | 'chrome' | 'edge',
};

export type Platform = Profile;
export const platform: Platform = profile;
// Whether this copy links to Margin's app: Safari's always (`nativeApp`: its extension handler), Chrome's and Edge's
// on the Mac and Windows (the app's connector, started by native messaging).
export const linksApp = () => !!platform?.linksApp();
// The browser this copy runs in, as the link names it.
export const browserName = (): 'safari' | 'chrome' | 'edge' => platform.browser();

// Also on the global, for the console and the E2E tests.
(globalThis.Margin ??= {}).platform = platform;
