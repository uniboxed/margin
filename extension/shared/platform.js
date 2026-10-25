// What differs between the Safari and Chrome builds. One file, both
// profiles: `npm run build` stamps BUILD_TARGET for dist/safari and
// dist/chrome. Loaded unbuilt (straight from extension/), it detects the
// browser from the extension's own URL scheme. Classic script: attaches to
// globalThis.Margin.platform (used by the background, content scripts and the
// new-tab page).
(() => {
  const Margin = (globalThis.Margin ??= {});

  const PROFILES = {
    safari: {
      name: 'safari',
      // Safari gives extensions no tab.favIconUrl: fetch each site's own icon.
      fetchFavicons: true,
      // Default shortcuts, matching platform/safari/manifest.json commands.
      // Tabs on ⌘⌥↓/↑ (WebKit accepts ⌘⌥ in manifest commands); spaces stay
      // on ⌃⌘→/← because Safari keeps ⌘⌥←/→ for its own tab switching.
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
      // Chrome refuses ⌘⌥ in manifest commands (the whole extension fails to
      // load), so all four are ⌃⌘ + arrows, matching platform/chrome/manifest.json.
      navigation: {
        nextTab: 'Ctrl+Meta+ArrowDown',
        prevTab: 'Ctrl+Meta+ArrowUp',
        nextSpace: 'Ctrl+Meta+ArrowRight',
        prevSpace: 'Ctrl+Meta+ArrowLeft',
      },
    },
  };

  const BUILD_TARGET = null; // set by scripts/build.js
  const detect = () => {
    try {
      const api = globalThis.browser ?? globalThis.chrome;
      return api?.runtime?.getURL?.('').startsWith('safari-web-extension:') ? 'safari' : 'chrome';
    } catch {
      return 'chrome';
    }
  };

  Margin.platformProfiles = PROFILES;
  Margin.platform = PROFILES[BUILD_TARGET ?? detect()];
})();
