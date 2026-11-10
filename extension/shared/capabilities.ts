// What differs between browsers, as what each one can do: its engine's capabilities (extension/engines/webkit/safari/
// capabilities.ts, extension/engines/chromium/capabilities.ts) answer, and shared code asks them, never which
// browser this is. A build resolves `#engine/capabilities` to its own engine's only (scripts/build.ts), so the
// other's aren't in it; unbuilt (unit tests), extension/shared/any-engine-capabilities.ts picks one from the
// extension's own URL scheme.
import { capabilities } from '#engine/capabilities';
import type { NavigationId } from './navigation-defaults.ts';

type Navigation = { readonly nextTab: string, readonly prevTab: string, readonly nextSpace: string, readonly prevSpace: string };
export type Capabilities = {
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
  // Whether this copy links to Margin.app (Safari's always, Chrome's and Edge's on the Mac), and the browser it
  // runs in, as the link names it.
  linksApp: () => boolean,
  browser: () => 'safari' | 'chrome' | 'edge',
};

// This build's (its engine's object itself, one binding in the bundle).
export { capabilities };
// Whether this copy links to Margin.app: Safari's always (`nativeApp`: its extension handler), Chrome's and Edge's
// on the Mac (Margin.app's connector, started by native messaging).
export const linksApp = () => !!capabilities?.linksApp();
// The browser this copy runs in, as the link names it.
export const browserName = (): 'safari' | 'chrome' | 'edge' => capabilities.browser();

// Also on the global, for the console and the E2E tests.
(globalThis.Margin ??= {}).capabilities = capabilities;
