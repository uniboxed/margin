// Pure state functions. No browser APIs: everything here is unit tested
// with `node --test` and called by background.js.

export const ARCHIVE_CAP = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  sidebarPinnedOpen: false,
  archiveAfterHours: 12,
  paletteShortcut: 'Alt+KeyK',
  searchEngine: 'https://duckduckgo.com/?q=%s',
});

export const DEFAULT_SPACE = Object.freeze({
  id: 'personal',
  name: 'Personal',
  emoji: '🏠',
  color: '#6c5ce7',
});

export function defaultState() {
  return {
    spaces: [{ ...DEFAULT_SPACE }],
    activeSpaceByWindow: {},
    tabSpace: {},
    pins: [],
    archive: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

// Fill in anything missing from what storage.local returned.
export function normalizeState(raw = {}) {
  const base = defaultState();
  const spaces = Array.isArray(raw.spaces) && raw.spaces.length ? raw.spaces : base.spaces;
  return {
    spaces,
    activeSpaceByWindow: { ...raw.activeSpaceByWindow },
    tabSpace: { ...raw.tabSpace },
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    settings: { ...base.settings, ...raw.settings },
  };
}
