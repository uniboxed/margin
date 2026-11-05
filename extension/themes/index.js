// The themes whose settings and first paint the background knows (theme.js,
// UI-free, so the background, the state model and the build can import this
// registry): Arcadia's placeholders and its sidebar width. What every
// built-in theme looks like is its package (themes/packages.js, drawn by
// ui/runtime.js); a package theme without an entry here (Neo-brutalism)
// keeps its settings as saved and gets Arcadia's first paint until Phase 3.
import arcadia from './arcadia/theme.js';

export const THEMES = Object.freeze({ [arcadia.id]: arcadia });
export const DEFAULT_THEME = arcadia.id;

// The active theme (an unknown or missing id falls back to the default).
export const themeFor = (settings) => THEMES[settings?.theme] ?? THEMES[DEFAULT_THEME];
