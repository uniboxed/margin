// The themes Margin ships as HTML and CSS packages (extension/themes/<id>/
// theme.json, theme.html, theme.css: ui/theme-loader.js loads them). Plain
// data, so the background can check a package theme's id without loading the
// UI code. Arcadia's package is `arcadia-2` while the old `arcadia` (theme
// JS) still runs today's pages; Phase 1 step 4 renames it.
export const PACKAGE_THEMES = Object.freeze(['neo-brutalism', 'arcadia-2']);

// Where the index of the user's imported themes is kept (storage.local).
export const USER_THEMES_KEY = 'userThemes';

// A theme's own settings, as the background keeps them (settings.themes[id]):
// names as theme.json's (ui/theme-schema.js), plain values, a few of them.
// The runtime checks each value against the theme's spec again when it
// applies them (ui/theme-loader.js resolveSettings).
export const SETTING_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
export const MAX_SETTINGS = 32;
/** @param {any} value */
export const plainSetting = (value) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 100);
