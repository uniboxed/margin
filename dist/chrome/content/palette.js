// The command palette's wiring: its shortcut, and on web pages its place in
// Margin.content. The palette itself (what it looks like) is the theme's
// createPalette({ send, getState, getContext, onLocal, colorScheme }) →
// { open, close, toggle, isOpen, refresh }; see themes/arcadium/palette.js.
import * as shortcuts from '../shared/shortcuts.js';
import * as V from '../shared/view.js';
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

// The palette opened to choose a new tab is closing: the sidebar's "+ New
// Tab" highlight goes (`setPending(false)`). Right away, unless what was
// chosen shows another tab: then once this page is hidden (or a moment
// later, if it never is), so the highlight doesn't come back to this page's
// tab first. Returns the onClose handler, and `cancel` for a new opening.
const SHOWS_ANOTHER_TAB = new Set(['activateTab', 'newTab', 'openPin', 'restoreArchive', 'search', 'openLauncher']);
export function newTabCloser(setPending, doc = document) {
  let cancel = () => {};
  const onClose = (/** @type {string | undefined} */ reason, /** @type {any} */ action) => {
    cancel();
    if (reason !== 'run' || !action || action.local || !SHOWS_ANOTHER_TAB.has(action.type)) return setPending(false);
    const done = () => {
      cancel();
      setPending(false);
    };
    const onHidden = () => doc.hidden && done();
    const timer = setTimeout(done, 1500);
    doc.addEventListener('visibilitychange', onHidden);
    cancel = () => {
      clearTimeout(timer);
      doc.removeEventListener('visibilitychange', onHidden);
      cancel = () => {};
    };
  };
  return { onClose, cancel: () => cancel() };
}

// A palette's send that also reports switches to another tab (choosing a tab,
// or a pin that has one open): `onSwitch(tabId, request)` highlights it at
// once (shared/switching.js).
export function reportingSwitches(send, getState, onSwitch) {
  return (/** @type {any} */ type, /** @type {any} */ payload) => {
    const request = send(type, payload);
    const tabId = type === 'activateTab' ? payload?.tabId
      : type === 'openPin' && getState() ? V.pinTabId(getState(), payload?.pinId, payload?.windowId) : null;
    if (Number.isInteger(tabId)) onSwitch(tabId, request);
    return request;
  };
}

// ---- content-script wiring ----------------------------------------------
// The new-tab page wires its own. `c` is Margin.content (content/core.js);
// `createPalette` comes from the active theme.

export function wirePalette(c, createPalette) {
  // A new tab being chosen ends with the palette, chosen or not (the
  // sidebar highlights the page's own tab again, or the new one opens).
  const closer = newTabCloser((on) => c.setNewTabPending?.(on));
  const palette = createPalette({
    send: reportingSwitches(c.send, () => c.getState().state, (id, request) => c.startSwitching?.(id, request)),
    onClose: closer.onClose,
    getState: () => c.getState().state,
    getContext: () => ({ ...c.getState(), canToggleSidebar: true, canFullscreen: !!platform?.marginFullscreen, canFit: !!platform?.shell, fitted: !!globalThis.Margin.shell }),
    onLocal: (action) => action.local === 'toggleSidebar' && c.sidebar.toggle(),
    colorScheme: c.colorScheme,
  });
  const paletteKey = () => c.getState().state?.settings?.paletteShortcut ?? 'Alt+KeyK';
  // While Margin is out of the way (content/core.js active()), reaching for
  // the palette offers full screen instead.
  const ready = () => !c.active || c.active() || void c.offerFullscreen();
  const guarded = { toggle: () => ready() && palette.toggle() };
  installShortcut(guarded, paletteKey);
  c.onCard?.((win) => installShortcut(guarded, paletteKey, win));
  // `newTab`: opened to choose a new tab (⌘T, handed here from the new-tab
  // page by the background; the sidebar's "+ New Tab"): the page stays, the
  // sidebar highlights "+ New Tab" instead of this tab until it closes.
  const open = ({ newTab = false } = {}) => {
    closer.cancel();
    c.setNewTabPending?.(newTab);
    palette.open();
  };
  c.onCommand = (command) => {
    if (!ready()) return;
    if (command === 'open-palette') palette.toggle();
  };
  c.openPalette = (options) => ready() && open(options);
  c.paletteOpen = () => palette.isOpen();
  c.closePalette = () => palette.isOpen() && palette.close();
  const prev = c.onState;
  c.onState = (...args) => {
    prev?.(...args);
    palette.refresh();
  };
}
