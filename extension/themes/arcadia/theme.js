// Arcadia, Margin's first theme: Arc's look (a gray frame around the page
// card, a sidebar of space chips, pins and tabs, a dark command palette).
// Its code is in this folder; this file only describes it. UI-free: the
// background, the state model and the build import it, so it must not import
// any UI code.

// Sidebar width: resizable by dragging its right edge. Range measured from
// Arc (Tirth's screenshots): 160–500 CSS px. Stored widths snap to 10px so the
// first-paint placeholder (docked/w-<width>.css) has a file for every width.
const WIDTH = Object.freeze({ min: 160, max: 500, default: 260, step: 10 });
const clampWidth = (w) => Math.min(WIDTH.max, Math.max(WIDTH.min, Number.isFinite(w) ? w : WIDTH.default));
const snapWidth = (w) => clampWidth(Math.round(clampWidth(w) / WIDTH.step) * WIDTH.step);
// "Keep open" on a page that can't be fitted (pushed): a narrow rail of icons
// instead (setting compactWhenPushed; content/layout.js), this wide.
const RAIL = 52;

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
  // Bundles scripts/build.js makes from content.js and newtab.js.
  content: 'themes/arcadia/content.bundle.js',
  newtab: 'themes/arcadia/newtab.bundle.js',
  // The first-paint placeholder while "Keep open" is on (registered CSS,
  // applied before the page's first paint).
  placeholder: (settings) => `themes/arcadia/docked/w-${sidebarWidth(settings)}.css`,
  // While it isn't: the frame around the page, the page where it is.
  closedPlaceholder: 'themes/arcadia/docked/closed.css',
  // The same, for pages known to be pushed with the rail (registered.js).
  railPlaceholder: 'themes/arcadia/docked/rail.css',
});

export { WIDTH, RAIL, clampWidth, snapWidth, settingsOf, sidebarWidth };
