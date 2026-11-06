// The themes whose settings the background knows (theme.js, UI-free, so the
// background, the state model and the build can import this registry):
// Arcadia's sidebar width. What every built-in theme looks like is its
// package (themes/packages.js, drawn by ui/runtime.js), with its look at a
// page's first paint (themes/<id>/first-paint.css); a package theme without
// an entry here (Neo-brutalism) keeps its settings as saved.
import arcadia from './arcadia/theme.js';

export const THEMES = Object.freeze({ [arcadia.id]: arcadia });
export const DEFAULT_THEME = arcadia.id;

// The active theme (an unknown or missing id falls back to the default).
export const themeFor = (settings) => THEMES[settings?.theme] ?? THEMES[DEFAULT_THEME];
