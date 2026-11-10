// The themes Margin ships as HTML and CSS packages (extension/themes/<id>/
// theme.json, theme.html, theme.css: ui/theme-loader.ts loads them). Plain
// data, so the background can check a package theme's id without loading the
// UI code. Arcadia (the default) first.
export const PACKAGE_THEMES = Object.freeze(['arcadia', 'neo-brutalism', 'pixel']);
// Their names, as Settings' theme picker shows them (ui/settings-form.ts).
export const PACKAGE_THEME_NAMES = Object.freeze({ arcadia: 'Arcadia', 'neo-brutalism': 'Neo-brutalism', pixel: 'Pixel' });

// Where the index of the user's imported themes is kept (storage.local).
export const USER_THEMES_KEY = 'userThemes';
// An imported theme's id (app/platforms/macos/shell/ThemeStore.swift idOK checks the same).
export const USER_THEME_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

// A theme's own settings, as the background keeps them (settings.themes[id]):
// names as theme.json's (ui/theme-schema.ts), plain values, a few of them.
// The runtime checks each value against the theme's spec again when it
// applies them (ui/theme-loader.ts resolveSettings).
export const SETTING_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
export const MAX_SETTINGS = 32;
export const plainSetting = (value: any) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 100);
