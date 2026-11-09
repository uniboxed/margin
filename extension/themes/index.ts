// The themes whose settings the background knows (theme.ts, UI-free, so the
// background, the state model and the build can import this registry):
// Arcadia's sidebar width. What every built-in theme looks like is its
// package (themes/packages.ts, drawn by ui/runtime.ts), with its look at a
// page's first paint (themes/<id>/first-paint.css); a package theme without
// an entry here (Neo-brutalism) keeps its settings as saved.
import arcadia from './arcadia/theme.ts';

// (By id: a theme's settings, for the ones whose settings the background knows.)
export const THEMES: Readonly<Record<string, typeof arcadia>> = Object.freeze({ [arcadia.id]: arcadia });
export const DEFAULT_THEME = arcadia.id;

// The active theme (an unknown or missing id falls back to the default).
export const themeFor = (settings: any) => THEMES[settings?.theme] ?? THEMES[DEFAULT_THEME];
