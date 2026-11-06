// Arcadia, Margin's first theme: Arc's look (a gray frame around the page
// card, a sidebar of space chips, pins and tabs, a dark command palette).
// The theme itself is the package in this folder (theme.json, theme.html,
// theme.css: Margin 2, drawn by ui/runtime.js; first-paint.css, its look at
// a page's first paint). This file describes what the background needs
// before anything draws it: its settings, and its sidebar's width for the
// first paint when no layout of Margin.app's is known yet
// (background/registered.js). UI-free: the background, the state model and
// the build import it.

// Sidebar width: resizable by dragging its right edge. Range measured from
// Arc (Tirth's screenshots): 160–500 CSS px. Stored widths snap to 10px
// (theme.json's step).
const WIDTH = Object.freeze({ min: 160, max: 500, default: 260, step: 10 });
const clampWidth = (w) => Math.min(WIDTH.max, Math.max(WIDTH.min, Number.isFinite(w) ? w : WIDTH.default));
const snapWidth = (w) => clampWidth(Math.round(clampWidth(w) / WIDTH.step) * WIDTH.step);

// The theme's own settings (state settings.themes.arcadia).
const defaults = Object.freeze({ sidebarWidth: WIDTH.default });

// Arcadia's settings from the stored settings, filled in and valid. Pages
// read storage directly, so this also accepts settings saved before themes
// existed (sidebarWidth was a top-level setting then).
function settingsOf(settings) {
  const own = settings?.themes?.arcadia ?? settings?.themes?.arcadium; // the theme's earlier name, until saved again
  const stored = own && typeof own === 'object' ? own : {};
  const width = stored.sidebarWidth ?? settings?.sidebarWidth ?? defaults.sidebarWidth;
  return { ...defaults, ...stored, sidebarWidth: snapWidth(Number(width)) };
}
const sidebarWidth = (settings) => settingsOf(settings).sidebarWidth;

export default Object.freeze({
  id: 'arcadia',
  name: 'Arcadia',
  description: 'Arc’s look: a frame around the page, space chips, pins and tabs.',
  defaults,
  settingsOf,
  // Where the page's box starts with Keep open: the sidebar's edge (background/registered.js).
  sidebarWidth,
});

export { WIDTH, clampWidth, snapWidth, settingsOf, sidebarWidth };
