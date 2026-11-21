// Arcadia, Margin's first theme: a sidebar window in the space's colour (the
// page a rounded card in a tinted frame, an address pill, pins, folders and
// tabs, a floating command bar).
// The theme itself is the package in this folder (theme.json, theme.html,
// theme.css: Margin 2, drawn by ui/runtime.ts). This file describes what the
// background needs before anything draws it: its settings, and its sidebar's
// width. UI-free: the background, the state model and the build import it.

// Sidebar width: resizable by dragging its right edge. Range measured from
// Arc (screenshots of it): 160–500 CSS px. Stored widths snap to 10px
// (theme.json's step).
const WIDTH = Object.freeze({ min: 160, max: 500, default: 260, step: 10 });
const clampWidth = (w: number) => Math.min(WIDTH.max, Math.max(WIDTH.min, Number.isFinite(w) ? w : WIDTH.default));
const snapWidth = (w: number) => clampWidth(Math.round(clampWidth(w) / WIDTH.step) * WIDTH.step);

// The theme's own settings (state settings.themes.arcadia).
const defaults = Object.freeze({ sidebarWidth: WIDTH.default });

// Arcadia's settings from the stored settings, filled in and valid. Pages
// read storage directly, so this also accepts settings saved before themes
// existed (sidebarWidth was a top-level setting then).
// (`settings`: the stored settings, as they came.)
function settingsOf(settings: any) {
  const own = settings?.themes?.arcadia ?? settings?.themes?.arcadium; // the theme's earlier name, until saved again
  const stored = own && typeof own === 'object' ? own : {};
  const width = stored.sidebarWidth ?? settings?.sidebarWidth ?? defaults.sidebarWidth;
  return { ...defaults, ...stored, sidebarWidth: snapWidth(Number(width)) };
}
const sidebarWidth = (settings: any) => settingsOf(settings).sidebarWidth;

export default Object.freeze({
  id: 'arcadia',
  name: 'Arcadia',
  description: 'A frame around the page, space chips, pins and tabs.',
  defaults,
  settingsOf,
  // The sidebar's width, from the settings.
  sidebarWidth,
});

export { WIDTH, clampWidth, snapWidth, settingsOf, sidebarWidth };
