// The command palette's keys and its place in Margin.content. The palette
// itself is the UI runtime's (ui/runtime.js, the theme's palette part and
// ui/behaviors/palette.js); this is what a page must do around it.

// ⌘T, the palette's key (⌥K before it). The browser keeps it for its own
// File › New Tab, which creates a tab
// first (Margin then hands it back: a flicker). With that menu item given
// another shortcut (macOS System Settings › Keyboard › App Shortcuts), ⌘T
// reaches the page like any key and Margin opens its palette to choose a
// new tab right away, with no tab created (without it, Margin hands the
// browser's new tab back: background/handlers.js). Capture phase, so the
// page can't swallow it first. `run()`: open it. `target`: the window to
// listen on. `skip()`: leave it alone this time (a shortcut being recorded in
// Settings).
/** @param {() => void} run @param {any} [target] @param {() => boolean} [skip] */
function installNewTabKey(run, target = globalThis, skip = () => false) {
  target.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (!e.isTrusted || e.code !== 'KeyT' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || skip()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) run();
  }, true);
}

export { installNewTabKey };

// ---- content-script wiring ----------------------------------------------
// `c` is Margin.content (content/core.js), with the UI as `c.runtime()`.
// The new-tab page wires its own (newtab/newtab.js).

export function wirePalette(c) {
  const ui = () => c.runtime?.() ?? null;
  // While Margin is out of the way (content/core.js active()), reaching for
  // the palette offers full screen instead.
  const ready = () => !c.active || c.active() || void c.offerFullscreen();
  // `newTab`: opened to choose a new tab (⌘T, handed here from the new-tab
  // page by the background; the sidebar's "+ New Tab"): the page stays, the
  // sidebar highlights "+ New Tab" instead of this tab until it closes.
  // A switch still under way from this page is called off: choosing again
  // means staying here meanwhile (content/core.js cancelSwitch).
  const open = ({ newTab = false } = {}) => {
    const r = ui();
    if (!r) return false;
    c.cancelSwitch?.();
    r.openPalette({ newTab });
    return true;
  };
  c.onCommand = (command) => {
    if (!ready() || command !== 'open-palette') return;
    const r = ui();
    if (!r) return;
    if (r.paletteOpen) return void r.closePalette();
    c.cancelSwitch?.();
    r.openPalette({ newTab: false });
  };
  c.openPalette = (options) => !!ready() && open(options);
  // ⌘T (installNewTabKey): the palette for a new tab; while Margin is out of
  // the way (Chrome, not in full screen), a new tab as usual.
  const newTabKey = () => {
    void c.send('newTabKeyUsed', {}, false); // for the Mac app's set-up window (background/onboarding.js)
    return !c.active || c.active() ? open({ newTab: true }) : c.send('newTab', { windowId: c.getState().windowId });
  };
  installNewTabKey(newTabKey);
  c.paletteOpen = () => !!ui()?.paletteOpen;
  c.closePalette = () => { if (ui()?.paletteOpen) ui().closePalette(); };
}
