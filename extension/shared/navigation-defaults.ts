// Every build's default navigation shortcuts, by the id its settings save them under (`shortcutDefaults`:
// state/model.ts normalizeShortcuts): a saved shortcut still the default of the build that saved it moves to
// this build's default, and one the user changed stays. Settings can come from another build (another
// browser's copy, linked through Margin.app), so every build's ids stay here, today's and past ones.
export const NAVIGATION_DEFAULTS = Object.freeze({
  // Safari's (extension/engines/webkit/safari/capabilities.ts). Tabs on ⌥⌘↓/↑ like Arc, spaces on ⌥⌘→/←
  // (decided 2026-11-08: those, and no ⌃⌘ arrows: the manifest commands have no keys now). Safari's own ⌥⌘←/→
  // (its tab switching) is Margin's space switching where Margin is.
  'safari-2': Object.freeze({
    nextTab: 'Alt+Meta+ArrowDown',
    prevTab: 'Alt+Meta+ArrowUp',
    nextSpace: 'Alt+Meta+ArrowRight',
    prevSpace: 'Alt+Meta+ArrowLeft',
  }),
  // Safari's until 2026-11-08: spaces on ⌃⌘→/←.
  safari: Object.freeze({ nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Ctrl+Meta+ArrowRight', prevSpace: 'Ctrl+Meta+ArrowLeft' }),
  // Chromium's (extension/engines/chromium/capabilities.ts): the same as its manifest commands (⌃⌘ + arrows; Chrome
  // refuses ⌘⌥ there and then won't load the extension at all).
  chrome: Object.freeze({
    nextTab: 'Ctrl+Meta+ArrowDown',
    prevTab: 'Ctrl+Meta+ArrowUp',
    nextSpace: 'Ctrl+Meta+ArrowRight',
    prevSpace: 'Ctrl+Meta+ArrowLeft',
  }),
});
export type NavigationId = keyof typeof NAVIGATION_DEFAULTS;
