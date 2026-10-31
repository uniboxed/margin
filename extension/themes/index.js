// The themes Margin ships. Each one is a folder: theme.js describes it (and
// is UI-free, so the background, the state model and the build can import
// this registry), content.js is its part on web pages, newtab.js its new-tab
// page. Only the active theme's code loads: the background registers its
// content bundle (background/registered.js) and the new-tab page imports its
// new-tab bundle (newtab/newtab.js).
import arcadia from './arcadia/theme.js';

export const THEMES = Object.freeze({ [arcadia.id]: arcadia });
export const DEFAULT_THEME = arcadia.id;

// The active theme (an unknown or missing id falls back to the default).
export const themeFor = (settings) => THEMES[settings?.theme] ?? THEMES[DEFAULT_THEME];
