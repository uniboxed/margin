// The command palette's wiring: its shortcut, and on web pages its place in
// Margin.content. The palette itself (what it looks like) is the theme's
// createPalette({ send, getState, getContext, onLocal, colorScheme }) →
// { open, close, toggle, isOpen, refresh }; see themes/arcadium/palette.js.
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';

// Capture-phase listener so the page can't swallow the shortcut first.
// `target`: the window to listen on (the card's, in the fitted layout).
function installShortcut(palette, getShortcut, target = globalThis) {
  target.addEventListener('keydown', (e) => {
    if (!shortcuts.matches(e, getShortcut())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    palette.toggle();
  }, true);
}

export { installShortcut as installPaletteShortcut };

// ---- content-script wiring ----------------------------------------------
// The new-tab page wires its own. `c` is Margin.content (content/core.js);
// `createPalette` comes from the active theme.

export function wirePalette(c, createPalette) {
  const palette = createPalette({
    send: c.send,
    getState: () => c.getState().state,
    getContext: () => ({ ...c.getState(), canToggleSidebar: true, canFullscreen: !!platform?.marginFullscreen, canFit: !!platform?.shell, fitted: !!globalThis.Margin.shell }),
    onLocal: (action) => action.local === 'toggleSidebar' && c.sidebar.toggle(),
    colorScheme: c.colorScheme,
  });
  const paletteKey = () => c.getState().state?.settings?.paletteShortcut ?? 'Alt+KeyK';
  installShortcut(palette, paletteKey);
  c.onCard?.((win) => installShortcut(palette, paletteKey, win));
  c.onCommand = (command) => {
    if (command === 'open-palette') palette.toggle();
    if (command === 'show-palette') palette.open(); // ⌘T, via the new-tab page
  };
  c.openPalette = () => palette.open();
  c.paletteOpen = () => palette.isOpen();
  const prev = c.onState;
  c.onState = (...args) => {
    prev?.(...args);
    palette.refresh();
  };
}
