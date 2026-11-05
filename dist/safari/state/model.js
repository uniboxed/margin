// Pure state functions. No browser APIs: everything here is unit tested
// with `node --test` and called by background.js. Functions never mutate
// their input; untouched top-level keys keep their identity so the
// background can write only the keys that changed.
import { platform, PROFILES } from '../shared/platform.js';
import { THEMES, DEFAULT_THEME } from '../themes/index.js';
import { neverSleeps, readSleepAddress, siteList } from '../shared/sleep.js';
/** @import { State } from '../../types/margin' */

const ARCHIVE_CAP = 200;

// The defaults before per-browser builds; settings saved then have no
// `shortcutDefaults`. Same as the Chrome profile's.
const LEGACY_SHORTCUTS = Object.freeze({
  nextTab: 'Ctrl+Meta+ArrowDown',
  prevTab: 'Ctrl+Meta+ArrowUp',
  nextSpace: 'Ctrl+Meta+ArrowRight',
  prevSpace: 'Ctrl+Meta+ArrowLeft',
});

const DEFAULT_SETTINGS = Object.freeze({
  sidebarPinnedOpen: false,
  frameWhenHidden: true, // the sidebar hidden: Margin's frame around the page, the page inside it at its sides
  archiveAfterHours: 12,
  // Tabs not used for this many hours are put to sleep to free their memory
  // (background/sleep.js; 0: never), except on these sites (hostnames, each
  // with its subdomains: shared/sleep.js neverSleeps).
  sleepAfterHours: 4,
  neverSleepSites: Object.freeze([]),
  // Safari: the tab just left is kept ready to show (no flash when switching
  // back to it) for this many minutes, and let go once Safari is left for
  // another app; 0: off (background/keep-ready.js).
  keepLeftTabReadyMinutes: 1,
  // Safari: after a relaunch, this many of the tabs likely to be clicked next
  // are loaded behind the page, one at a time, while the user is idle; 0: off
  // (background/warm-up.js).
  warmUpTabs: 6,
  // Searches use the browser's engine (shared/search.js). Safari: the one
  // learned from Safari's own address-bar searches, { id, name, template, at }.
  safariSearch: null,
  blockGestures: true, // Safari: no swipe back/forward, pinch for all tabs, or page bounce (shared/gestures.js)
  pullToRefresh: true, // Safari: Margin's pull down at the top to reload (shared/pull.js)
  swipeNavigation: true, // Safari: Margin's two-finger swipe back/forward (shared/pull.js)
  sidebarShortcut: 'Alt+KeyS', // show/hide the sidebar (content/core.js page listener)
  // Safari: a note when ⌘T seems to open Safari's homepage instead of Margin
  // (background/newtab-hint.js); turned off from the note.
  newTabHint: true,
  // Chrome: whenever a window goes full screen, Margin full screen instead
  // (no toolbar; background/fullscreen.js).
  marginFullscreenAuto: true,
  // Chrome: Margin only in full screen; in a window that isn't, it stays out
  // of the way and offers full screen when reached for (content/core.js).
  fullscreenOnly: true,
  // Defaults from the build's platform profile (shared/platform.js; loaded
  // before this file in the background). Editable in Settings. Fallback:
  // the Chrome profile's ⌃⌘ + arrows (e.g. in node tests).
  shortcuts: Object.freeze({ ...(platform?.navigation ?? LEGACY_SHORTCUTS) }),
  // Which profile's defaults `shortcuts` started from (see normalizeShortcuts).
  shortcutDefaults: platform?.name ?? 'chrome',
  // What Margin looks like (themes/index.js), and each theme's own settings
  // ({ [themeId]: {...} }; Arcadia: sidebarWidth).
  theme: DEFAULT_THEME,
  themes: Object.freeze(Object.fromEntries(Object.values(THEMES).map((t) => [t.id, t.defaults]))),
});

const DEFAULT_SPACE = Object.freeze({
  id: 'personal',
  name: 'Personal',
  emoji: '🏠',
  color: '#6c5ce7',
});

const STATE_KEYS = ['spaces', 'activeSpaceByWindow', 'tabSpace', 'pins', 'folders', 'archive', 'settings', 'tabs', 'favicons', 'lostTabs'];
const FAVICON_CAP = 150;

/** @returns {State} */
function defaultState() {
  return {
    spaces: [{ ...DEFAULT_SPACE }],
    activeSpaceByWindow: {},
    tabSpace: {},
    pins: [],
    // Folders of pins, per space (Arc): { id, spaceId, name, open, pos }.
    folders: [],
    archive: [],
    settings: {
      ...DEFAULT_SETTINGS,
      neverSleepSites: [],
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
      themes: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.themes).map(([id, own]) => [id, { ...own }])),
    },
    // Snapshot of open tabs, written by the background so content scripts
    // (which have no `tabs` API) can render from storage alone.
    tabs: {},
    // Site icons Margin fetched itself (Safari gives none): { [origin]: { data, href, at } }.
    favicons: {},
    // Tabs from before ids changed that no open tab matched yet (syncTabs).
    lostTabs: null,
  };
}

// Fill in anything missing from what storage.local returned.
/** @param {any} [raw] @returns {State} */
function normalizeState(raw = {}) {
  const base = defaultState();
  const spaces = Array.isArray(raw.spaces) && raw.spaces.length ? raw.spaces : base.spaces;
  return {
    spaces,
    activeSpaceByWindow: { ...raw.activeSpaceByWindow },
    tabSpace: { ...raw.tabSpace },
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    folders: Array.isArray(raw.folders) ? raw.folders.filter((f) => f && typeof f.id === 'string' && typeof f.spaceId === 'string') : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    settings: {
      ...base.settings,
      ...withoutKeys(raw.settings, REMOVED_SETTINGS),
      neverSleepSites: siteList(raw.settings?.neverSleepSites ?? []),
      shortcuts: normalizeShortcuts(raw.settings, base.settings),
      shortcutDefaults: base.settings.shortcutDefaults,
      theme: THEMES[raw.settings?.theme] ? raw.settings.theme : DEFAULT_THEME,
      themes: normalizeThemes(raw.settings),
    },
    tabs: { ...raw.tabs },
    favicons: { ...raw.favicons },
    lostTabs: raw.lostTabs && Array.isArray(raw.lostTabs.windows) ? raw.lostTabs : null,
  };
}

// Settings that no longer exist: `searchEngine` (Margin's own engine
// choice, replaced by the browser's); `sidebarWidth` (now Arcadia's own,
// settings.themes.arcadia; normalizeThemes moves a saved one there);
// `paletteShortcut` (⌥K: ⌘T opens the same palette, content/palette.js).
// Not `keepTabsReadyMinutes` (up to six tabs of the space in front, until
// that long after Safari was last used: most of Tirth's battery; replaced by
// keepLeftTabReadyMinutes, the tab just left only, whose default it doesn't
// change, even turned off: shared/view.js keepReadyMinutes): unread here, but
// kept as saved, so a build from before (main, a branch being checked) still
// finds the 0 Tirth set there, and doesn't turn the old keep-ready back on
// with its default of 30.
const REMOVED_SETTINGS = ['searchEngine', 'sidebarWidth', 'paletteShortcut'];
const withoutKeys = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)));

// Each theme's settings, filled in by the theme (which also takes over what
// it used to keep among the top-level settings). Themes this build doesn't
// have keep what's saved.
// Arcadia's package was `arcadia-2` while the old theme still ran pages
// (Margin 2, Phase 1): what it saved joins Arcadia's own, Arcadia's
// sidebarWidth first, then the package's, then a top-level one from before
// themes (theme.js settingsOf snaps it to 10 px, 160–500).
const OLD_NAMES = Object.freeze({ arcadia: ['arcadium', 'arcadia-2'] });
const objectOr = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
function normalizeThemes(rawSettings) {
  const saved = objectOr(rawSettings?.themes) ?? {};
  const themes = { ...saved };
  for (const theme of Object.values(THEMES)) {
    if (typeof theme.settingsOf !== 'function') continue; // a package theme: its settings as saved
    const earlier = (OLD_NAMES[theme.id] ?? []).map((name) => objectOr(saved[name])).filter(Boolean);
    const own = objectOr(saved[theme.id]);
    const merged = earlier.length ? Object.assign({}, ...[...earlier].reverse(), own ?? {}) : own;
    themes[theme.id] = theme.settingsOf({ ...rawSettings, themes: { ...saved, [theme.id]: merged ?? undefined } });
    for (const name of OLD_NAMES[theme.id] ?? []) delete themes[name]; // taken over just now
  }
  return themes;
}

// Saved shortcuts include the defaults of the build that saved them. When
// the defaults change (another build, e.g. Safari's ⌥⌘↓/↑ for tabs after
// ⌃⌘↓/↑), a saved value that is still the old default moves to the new
// default; anything the user changed in Settings stays.
function normalizeShortcuts(rawSettings, baseSettings) {
  const saved = { ...rawSettings?.shortcuts };
  const from = rawSettings?.shortcutDefaults;
  if (from !== baseSettings.shortcutDefaults) {
    const old = (from && PROFILES[from]?.navigation) || LEGACY_SHORTCUTS;
    for (const [name, value] of Object.entries(saved)) if (value === old[name]) delete saved[name];
  }
  return { ...baseSettings.shortcuts, ...saved };
}

// Pins and tabs are matched by URL, ignoring the fragment and a bare
// trailing slash. Keep in sync with shared/view.js (a test checks parity).
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url ?? '';
  }
}

const hasSpace = (state, spaceId) => state.spaces.some((s) => s.id === spaceId);

/** @param {State} state */
function activeSpaceId(state, windowId) {
  const id = state.activeSpaceByWindow[windowId];
  return hasSpace(state, id) ? id : state.spaces[0].id;
}

/** @param {State} state @param {string} url @param {string} [spaceId] */
function pinForUrl(state, url, spaceId) {
  const key = normalizeUrl(url);
  return state.pins.find((p) => normalizeUrl(p.url) === key && (spaceId == null || p.spaceId === spaceId));
}

// ---- tabs -----------------------------------------------------------------

// A tab as Margin keeps it: one Margin put to sleep (background/sleep.js) is
// the page it was, its address and title read from its sleep page's address
// (shared/sleep.js), whichever copy of Margin's sleep page it is, so the
// sidebar, search, pins, spaces, the archive and the matching after a relaunch
// (matchTabs) all go by the page, never by the sleep page. `asleep`: how
// ('page'). One whose sleep page has no web address to go back to stays as it
// is. A tab the browser discarded (Chrome's tabs.discard, Margin's or its
// own) keeps its address and says `discarded` ('discarded').
/** @param {any} tab */
function seenTab(tab) {
  if (!tab || tab.asleep) return tab;
  const sleep = readSleepAddress(tab.url || tab.pendingUrl);
  if (sleep?.url) return { ...tab, url: sleep.url, pendingUrl: undefined, title: sleep.title || tab.title, asleep: 'page' };
  return tab.discarded === true ? { ...tab, asleep: 'discarded' } : tab;
}

function tabRecord(tab, prev, now) {
  const seen = seenTab(tab);
  return {
    id: seen.id,
    windowId: seen.windowId,
    index: seen.index ?? prev?.index ?? 0,
    title: seen.title ?? prev?.title ?? '',
    url: seen.url || seen.pendingUrl || prev?.url || '',
    favIconUrl: seen.favIconUrl ?? prev?.favIconUrl ?? '',
    active: !!seen.active,
    lastActive: prev?.lastActive ?? seen.lastAccessed ?? now,
    ...(prev?.restored ? { restored: true, restoredFrom: prev.restoredFrom } : {}),
    ...(prev?.placed ? { placed: true } : {}),
    // Asleep since `at`; awake again since `wokeAt` (a tab woken isn't put
    // to sleep again until it's been left that long once more: sleepyTabs).
    ...(seen.asleep ? { sleeping: { at: prev?.sleeping?.at ?? now, how: seen.asleep } } : {}),
    ...(!seen.asleep && prev?.sleeping ? { wokeAt: now } : prev?.wokeAt != null ? { wokeAt: prev.wokeAt } : {}),
  };
}

// New tabs join their window's active space; existing assignments stick.
/** @param {State} state */
function assignTab(state, tabId, windowId) {
  if (hasSpace(state, state.tabSpace[tabId])) return state;
  return { ...state, tabSpace: { ...state.tabSpace, [tabId]: activeSpaceId(state, windowId) } };
}

// A window Margin hasn't seen yet (e.g. ⌘N) starts in the space of the
// window used most recently, instead of the first space.
/** @param {State} state */
function inheritSpace(state, windowId) {
  if (state.activeSpaceByWindow[windowId] != null) return state;
  const others = Object.values(state.tabs).filter((t) => t.windowId !== windowId);
  if (!others.length) return state;
  const recent = others.reduce((a, b) => ((b.lastActive ?? 0) > (a.lastActive ?? 0) ? b : a));
  return setActiveSpace(state, windowId, activeSpaceId(state, recent.windowId));
}

// Record a created/updated tab and give it a space if it has none.
// `active` is only taken from the event for a tab we haven't seen yet: for
// known tabs it's owned by activateTab(), because Safari can deliver an
// update for a page that finished loading *after* the user switched away,
// still saying active: true, which left two tabs highlighted.
/** @param {State} state */
function upsertTab(state, tab, now) {
  const prev = state.tabs[tab.id];
  const record = tabRecord(tab, prev, now);
  if (prev) {
    record.active = prev.active && prev.windowId === record.windowId;
    const next = { ...state, tabs: { ...state.tabs, [tab.id]: record } };
    return assignTab(next, tab.id, tab.windowId);
  }
  record.active = false;
  const newWindow = !Object.values(state.tabs).some((t) => t.windowId === tab.windowId);
  let next = newWindow ? inheritSpace(state, tab.windowId) : state;
  next = { ...next, tabs: { ...next.tabs, [tab.id]: record } };
  // A new tab that opens focused takes over its window's highlight even if
  // the browser never sends onActivated for it.
  if (tab.active) next = activateTab(next, tab.id, tab.windowId, now);
  return assignTab(next, tab.id, tab.windowId);
}

/** @param {State} state */
function removeTab(state, tabId) {
  const tabs = { ...state.tabs };
  const tabSpace = { ...state.tabSpace };
  delete tabs[tabId];
  delete tabSpace[tabId];
  return { ...state, tabs, tabSpace };
}

// Exactly one active tab per window. `windowId` may be missing from the
// event; fall back to the tab's own window.
/** @param {State} state */
function activateTab(state, tabId, windowId, now) {
  windowId ??= state.tabs[tabId]?.windowId;
  if (windowId == null) return state;
  const tabs = {};
  for (const [id, t] of Object.entries(state.tabs)) {
    if (t.windowId !== windowId) tabs[id] = t;
    else if (t.id === tabId) tabs[id] = { ...t, active: true, lastActive: now };
    else tabs[id] = t.active ? { ...t, active: false, lastActive: now } : t;
  }
  return { ...state, tabs };
}

// The same tabs under new ids. A browser restart, and Margin being updated
// (a new copy gets new ids for every tab: checked in WebKit), renumber every
// tab and window, so Margin's records (space, last use) are matched to the
// open tabs: by address, window by window (each open window paired with the
// old one it shares most web addresses with), duplicates in tab order; then
// by web address in any window. New-tab pages, blank and empty addresses
// only match within paired windows, in order (one in a new window isn't the
// old one). Returns open tab id → old record.
// A web page's address (a new-tab page, about:blank or none: '').
const webKey = (t) => {
  const url = t.url || t.pendingUrl || '';
  return /^(https?|file):/i.test(url) ? normalizeUrl(url) : '';
};
const anyKey = (t) => normalizeUrl(t.url || t.pendingUrl || '');
// Options: `minShared(records, tabs)`: web addresses an open window (its
// `tabs`) must share with an old one (its `records`) to be paired (1);
// `anyWindow`: also by address in any window (true).
/** @param {any[]} old @param {any[]} open @param {{ minShared?: (records: any[], tabs: any[]) => number, anyWindow?: boolean }} [options] */
function matchTabs(old, open, { minShared = () => 1, anyWindow = true } = {}) {
  const byWindow = (list) => {
    const map = new Map();
    for (const t of list) map.set(t.windowId, [...(map.get(t.windowId) ?? []), t]);
    return map;
  };
  const oldWindows = byWindow(old);
  const openWindows = byWindow(open);
  // Pair windows by shared web addresses, most first, one to one.
  const pairs = [];
  for (const [openId, tabs] of openWindows) {
    for (const [oldId, records] of oldWindows) {
      const counts = new Map();
      for (const r of records) if (webKey(r)) counts.set(webKey(r), (counts.get(webKey(r)) ?? 0) + 1);
      let shared = 0;
      for (const t of tabs) {
        const n = counts.get(webKey(t)) ?? 0;
        if (n) { shared++; counts.set(webKey(t), n - 1); }
      }
      if (shared && shared >= minShared(records, tabs)) pairs.push({ openId, oldId, shared });
    }
  }
  pairs.sort((a, b) => b.shared - a.shared);
  const paired = new Map(); // open window → old window
  const usedOld = new Set();
  for (const { openId, oldId } of pairs) {
    if (paired.has(openId) || usedOld.has(oldId)) continue;
    paired.set(openId, oldId);
    usedOld.add(oldId);
  }
  /** @type {Map<number, any>} old record (or lost tab) for each matched open tab */
  const matched = new Map();
  const taken = new Set();
  // Same address (by `key`) within `records` for `tabs`; of several (the
  // same page open twice), the one nearest its place in the window.
  const zip = (tabs, records, key) => {
    const free = new Map();
    for (const r of records) if (!taken.has(r) && key(r)) free.set(key(r), [...(free.get(key(r)) ?? []), r]);
    for (const t of [...tabs].sort((a, b) => String(a.windowId).localeCompare(String(b.windowId)) || a.index - b.index)) {
      if (matched.has(t.id) || !key(t)) continue;
      const candidates = free.get(key(t));
      if (!candidates?.length) continue;
      const r = candidates.reduce((best, c) => (Math.abs(c.index - t.index) < Math.abs(best.index - t.index) ? c : best));
      candidates.splice(candidates.indexOf(r), 1);
      matched.set(t.id, r);
      taken.add(r);
    }
  };
  for (const [openId, oldId] of paired) zip(openWindows.get(openId), oldWindows.get(oldId), anyKey);
  if (anyWindow) zip(open, old, webKey);
  return matched;
}

// Old tabs no open tab matched are kept a day (LOST_MS) as lostTabs, by
// their old window ({ windows: [{ at, tabs: [{ url, spaceId, lastActive,
// windowId, index }] }] }, at most LOST_CAP tabs): a window that comes back
// later (reopened from the last session, a restored tab whose address comes
// late) takes them back (reclaimTabs).
const LOST_MS = 24 * 60 * 60 * 1000;
const LOST_CAP = 300;
/** @param {State} state */
const lostWindows = (state, now) => (state.lostTabs?.windows ?? []).filter((w) => now - w.at <= LOST_MS && w.tabs.length);
// `groups` first, then the kept ones still valid, at most LOST_CAP tabs.
const keepLost = (state, groups, now) => {
  let room = LOST_CAP;
  const windows = [];
  for (const w of [...groups, ...lostWindows(state, now)]) {
    if (room <= 0) break;
    const tabs = w.tabs.slice(0, room);
    room -= tabs.length;
    windows.push({ ...w, tabs });
  }
  return windows.length ? { windows } : null;
};

// Reconcile with `tabs.query({})`. Tabs Margin knows keep their records; when
// `fresh` (the browser restarted: every id is new, and old ones may be reused
// for other tabs) none are known. When the ids were renumbered (fresh, or no
// open tab is one Margin knows while some it knew are gone: Margin updated),
// the tabs are matched to the records of tabs that are gone (matchTabs) and
// keep their space; after a restart every last use is moved forward so the
// most recent is now (gaps kept: the space's most recent tab is still right,
// and nothing is archived just for the time the browser was closed). Unmatched
// ones go to a pin's space with that address (after a restart), or their
// window's active space; a window Margin doesn't know shows the space of the
// tab it shows. Old tabs left over wait in lostTabs; windows Margin didn't
// know take theirs back (reclaimTabs).
// An old window, as of one renumbering (window ids repeat across them).
const groupKey = (at, windowId) => `${at}:${windowId}`;

// Did the browser renumber its tabs (a restart, or Margin updated: no open
// tab is one Margin knows, while some it knew are gone)?
/** @param {State} state */
function isRenumbered(state, openTabs, { fresh = false } = {}) {
  if (fresh) return true;
  const open = new Set(openTabs.map((t) => String(t.id)));
  return openTabs.length > 0 && !openTabs.some((t) => state.tabs[t.id]) && Object.keys(state.tabs).some((id) => !open.has(id));
}

/** @param {State} state */
function syncTabs(state, openTabs, { fresh = false, now = Date.now() } = {}) {
  openTabs = openTabs.map(seenTab); // (a sleeping tab by its page's address)
  const open = new Set(openTabs.map((t) => String(t.id)));
  const known = (t) => !fresh && !!state.tabs[t.id];
  const gone = Object.values(state.tabs).filter((r) => fresh || !open.has(String(r.id)));
  const renumbered = isRenumbered(state, openTabs, { fresh });
  const matched = renumbered ? matchTabs(gone, openTabs.filter((t) => !known(t))) : new Map();
  // After a restart: the last tab used before it is used now (all moved by as much).
  const latest = Math.max(0, ...gone.map((r) => r.lastActive ?? 0));
  const shift = fresh && gone.length ? now - latest : 0;
  const knownWindows = new Set(Object.values(state.tabs).map((t) => t.windowId));
  let next = {
    ...state,
    tabs: {},
    tabSpace: {},
    activeSpaceByWindow: fresh ? {} : { ...state.activeSpaceByWindow },
  };
  const unplaced = [];
  for (const tab of openTabs) {
    const same = known(tab) ? state.tabs[tab.id] : undefined;
    const match = matched.get(tab.id);
    const prev = same ?? (match && { ...match, lastActive: (match.lastActive ?? now) + shift, ...(match.wokeAt != null ? { wokeAt: match.wokeAt + shift } : {}) });
    const record = tabRecord(tab, prev, now);
    if (match) Object.assign(record, { restored: true, restoredFrom: groupKey(now, match.windowId) });
    next.tabs[tab.id] = record;
    const kept = same ? state.tabSpace[tab.id] : match ? state.tabSpace[match.id] : undefined;
    const pinned = fresh ? pinForUrl(state, tab.url) : undefined;
    const spaceId = hasSpace(state, kept) ? kept : pinned?.spaceId;
    if (spaceId) next.tabSpace[tab.id] = spaceId;
    else unplaced.push(tab);
  }
  const windows = new Set(openTabs.map((t) => String(t.windowId)));
  for (const w of Object.keys(next.activeSpaceByWindow)) if (!windows.has(w)) delete next.activeSpaceByWindow[w];
  for (const tab of openTabs) {
    if (tab.active && next.activeSpaceByWindow[tab.windowId] == null && next.tabSpace[tab.id]) {
      next.activeSpaceByWindow = { ...next.activeSpaceByWindow, [tab.windowId]: next.tabSpace[tab.id] };
    }
  }
  for (const tab of unplaced) next = assignTab(next, tab.id, tab.windowId);
  if (renumbered) {
    const used = new Set(matched.values());
    const groups = new Map();
    for (const r of gone) {
      if (used.has(r) || !webKey(r) || !hasSpace(state, state.tabSpace[r.id])) continue;
      const lost = { url: r.url, spaceId: state.tabSpace[r.id], lastActive: (r.lastActive ?? now) + shift, windowId: r.windowId, index: r.index };
      groups.set(r.windowId, [...(groups.get(r.windowId) ?? []), lost]);
    }
    // `size`: how many web pages its window had (it needs two of them back, or one if it had one).
    const size = (windowId) => gone.filter((r) => r.windowId === windowId && webKey(r)).length;
    const fresher = [...groups.entries()].map(([windowId, tabs]) => ({ key: groupKey(now, windowId), at: now, size: size(windowId), tabs: tabs.sort((a, b) => a.index - b.index) }));
    return { ...next, lostTabs: keepLost(state, fresher, now) };
  }
  next.lostTabs = keepLost(state, [], now); // expired ones dropped
  // Windows that are all new to Margin (opened while it wasn't running, not
  // a tab dragged out of a window it knew): back from before?
  const withKnown = new Set(openTabs.filter(known).map((t) => t.windowId));
  const candidates = openTabs.filter((t) => !known(t) && !knownWindows.has(t.windowId) && !withKnown.has(t.windowId)).map((t) => t.id);
  return candidates.length ? reclaimTabs(next, candidates, now) : next;
}

// `tabIds` (tabs that may be back from before the ids changed: a window
// reopened from the last session, tabs of a window still being restored, a
// tab whose address came late; never ones the user had before or moved)
// take back old tabs waiting in lostTabs: their space, and their last use
// moved forward by the time since (the one in front keeps its own). Matched
// as at a restart (matchTabs), window to old window only, and a window must
// share two of its old window's web pages (one if it had only one): a page
// opened anew doesn't take an old tab's place. The window then shows its
// front tab's space.
/** @param {State} state @param {number[]} tabIds */
function reclaimTabs(state, tabIds, now) {
  const groups = lostWindows(state, now);
  if (!groups.length) return state;
  const old = groups.flatMap((g, i) => g.tabs.map((t) => ({ ...t, windowId: `lost${i}`, group: g })));
  const open = tabIds.map((id) => state.tabs[id]).filter((t) => t && !t.restored && !t.placed); // placed: by the user or Margin
  // Two of the old window's pages, counting those already back in this window.
  const minShared = (records, tabs) => {
    const group = records[0].group;
    const back = group.key ? Object.values(state.tabs).filter((t) => t.windowId === tabs[0].windowId && t.restored && t.restoredFrom === group.key).length : 0;
    return Math.max(1, Math.min(2, group.size ?? records.filter(webKey).length) - back);
  };
  const matched = matchTabs(old, open, { anyWindow: false, minShared });
  if (!matched.size) return state;
  const tabs = { ...state.tabs };
  const tabSpace = { ...state.tabSpace };
  let next = { ...state, tabs, tabSpace };
  const used = new Set(matched.values());
  for (const [id, lost] of matched) {
    const record = tabs[id];
    const lastActive = record.active ? record.lastActive : Math.min(now, lost.lastActive + (now - lost.group.at));
    tabs[id] = { ...record, lastActive, restored: true, restoredFrom: lost.group.key };
    if (hasSpace(state, lost.spaceId)) tabSpace[id] = lost.spaceId;
    if (record.active) next = setActiveSpace(next, record.windowId, tabSpace[id]);
  }
  const windows = groups.map((g) => ({ ...g, tabs: g.tabs.filter((t) => !old.some((o) => used.has(o) && o.group === g && o.index === t.index && o.url === t.url)) }));
  return { ...next, lostTabs: keepLost({ ...state, lostTabs: null }, windows.filter((w) => w.tabs.length), now) };
}

/** @param {State} state */
function moveTab(state, tabId, spaceId) {
  if (!hasSpace(state, spaceId) || !state.tabs[tabId]) return state;
  // Placed on purpose (the user, or Margin opening it there): never taken
  // for a tab coming back from before the ids changed (reclaimTabs).
  const tabs = state.tabs[tabId].placed ? state.tabs : { ...state.tabs, [tabId]: { ...state.tabs[tabId], placed: true } };
  return { ...state, tabs, tabSpace: { ...state.tabSpace, [tabId]: spaceId } };
}

// ---- spaces ---------------------------------------------------------------

/** @param {State} state */
function setActiveSpace(state, windowId, spaceId) {
  if (!hasSpace(state, spaceId)) return state;
  return { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId]: spaceId } };
}

// The window shows the space of the tab it shows (Arc): a tab of another
// space brought to the front (from the palette, Safari's own tab bar)
// switches the window to that space.
/** @param {State} state */
function followTab(state, tabId, windowId) {
  const spaceId = state.tabSpace[tabId];
  if (!spaceId || !hasSpace(state, spaceId) || activeSpaceId(state, windowId) === spaceId) return state;
  return setActiveSpace(state, windowId, spaceId);
}

// The most recently shown tab of a space in a window (not `exceptId`).
/** @param {State} state */
function recentTabOfSpace(state, windowId, spaceId, exceptId = null) {
  if (!spaceId) return null;
  return Object.values(state.tabs).filter((t) => t.windowId === windowId && t.id !== exceptId && state.tabSpace[t.id] === spaceId)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] ?? null;
}

/** @param {State} state */
function createSpace(state, { id, name, emoji, color }) {
  const space = {
    id,
    name: name?.trim() || 'New space',
    emoji: emoji || '✨',
    color: color || '#00b894',
  };
  return { ...state, spaces: [...state.spaces, space] };
}

// Rename, re-emoji or recolor.
/** @param {State} state */
function updateSpace(state, spaceId, patch) {
  const allowed = {};
  for (const key of ['name', 'emoji', 'color']) {
    const value = typeof patch[key] === 'string' ? patch[key].trim() : '';
    if (value) allowed[key] = value;
  }
  return { ...state, spaces: state.spaces.map((s) => (s.id === spaceId ? { ...s, ...allowed } : s)) };
}

// ---- pins -----------------------------------------------------------------

// Pins and folders are ordered per space by `pos`: the space's top level
// mixes folders and the pins in none, and each folder orders its own pins.
// Pins saved before folders existed have no `pos`: their order in the list
// stands in (shared/view.js does the same). Every change renumbers the
// lists it touches 0, 1, 2…
const posOf = (/** @type {any} */ item, /** @type {number} */ i) => (Number.isFinite(item?.pos) ? item.pos : i);
const folderIn = (state, folderId, spaceId) => (state.folders ?? []).find((f) => f.id === folderId && f.spaceId === spaceId) ?? null;
// A pin's folder, if that folder exists in the pin's space (else it's loose).
const folderOfPin = (state, pin) => (pin.folderId ? folderIn(state, pin.folderId, pin.spaceId) : null);

// One list, in order: [{ kind: 'folder' | 'pin', id }]. `folderId` null: the
// space's top level.
/** @param {State} state */
function pinOrder(state, spaceId, folderId = null) {
  const items = [];
  // Folders first, so equal positions sort as shared/view.js shows them.
  if (folderId == null) {
    (state.folders ?? []).forEach((f, i) => f.spaceId === spaceId && items.push({ kind: 'folder', id: f.id, pos: posOf(f, i) }));
  }
  state.pins.forEach((p, i) => {
    if (p.spaceId !== spaceId) return;
    const inFolder = folderOfPin(state, p)?.id ?? null;
    if (inFolder === folderId) items.push({ kind: 'pin', id: p.id, pos: posOf(p, i) });
  });
  return items.sort((a, b) => a.pos - b.pos).map(({ kind, id }) => ({ kind, id }));
}

// Write `list` (pinOrder's shape) as the order of that level, putting its
// pins in `folderId` (null: none).
/** @param {State} state */
function writeOrder(state, folderId, list) {
  const pos = new Map(list.map((item, i) => [item.id, i]));
  // Unchanged items, and lists, stay as they are (the background saves only
  // what changed, and every page redraws for each save).
  let pinsChanged = false;
  const pins = state.pins.map((p) => {
    if (!pos.has(p.id) || (p.pos === pos.get(p.id) && (p.folderId ?? null) === (folderId ?? null))) return p;
    pinsChanged = true;
    const { folderId: _old, ...rest } = p;
    return { ...rest, ...(folderId ? { folderId } : {}), pos: pos.get(p.id) };
  });
  let foldersChanged = false;
  const folders = (state.folders ?? []).map((f) => {
    if (!pos.has(f.id) || f.pos === pos.get(f.id)) return f;
    foldersChanged = true;
    return { ...f, pos: pos.get(f.id) };
  });
  if (!pinsChanged && !foldersChanged) return state;
  return { ...state, ...(pinsChanged ? { pins } : {}), ...(foldersChanged ? { folders } : {}) };
}

// `list` with `item` moved before the entry with id `beforeId` (the end if
// there's none).
function placed(list, item, beforeId) {
  if (beforeId != null && beforeId === item.id) return list.some((x) => x.id === item.id) ? list : [...list, item]; // before itself: where it is
  const rest = list.filter((x) => x.id !== item.id);
  const at = beforeId == null ? -1 : rest.findIndex((x) => x.id === beforeId);
  if (at < 0) return [...rest, item];
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

const FOLDER_NAME_MAX = 40;
const folderName = (name) => String(name ?? '').trim().slice(0, FOLDER_NAME_MAX);
// "New Folder", "New Folder 2"…: menus name folders, so a space's are distinct.
function uniqueName(state, spaceId, name) {
  const taken = new Set((state.folders ?? []).filter((f) => f.spaceId === spaceId).map((f) => f.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

// `folderId`/`beforeId`: where it goes (a folder of its space, before a pin
// or folder at that level); the end of the space's top level by default.
/** @param {State} state */
function addPin(state, { id, spaceId, url, title, folderId = null, beforeId = null }) {
  if (!url || !hasSpace(state, spaceId) || pinForUrl(state, url, spaceId)) return state;
  const next = { ...state, pins: [...state.pins, { id, spaceId, url, title: title || url }] };
  const folder = folderId ? folderIn(state, folderId, spaceId) : null;
  return movePin(next, id, { folderId: folder?.id ?? null, beforeId });
}

/** @param {State} state */
function removePin(state, pinId) {
  return { ...state, pins: state.pins.filter((p) => p.id !== pinId) };
}

// A pin into a folder of its space (or out of folders: null), before the pin
// or folder `beforeId` there (the end by default).
/** @param {State} state */
function movePin(state, pinId, { folderId = null, beforeId = null } = {}) {
  const pin = state.pins.find((p) => p.id === pinId);
  if (!pin) return state;
  const folder = folderId ? folderIn(state, folderId, pin.spaceId) : null;
  if (folderId && !folder) return state;
  const from = folderOfPin(state, pin)?.id ?? null;
  const to = folder?.id ?? null;
  let next = state;
  if (from !== to) next = writeOrder(next, from, pinOrder(next, pin.spaceId, from).filter((x) => x.id !== pinId));
  return writeOrder(next, to, placed(pinOrder(next, pin.spaceId, to), { kind: 'pin', id: pinId }, beforeId));
}

// ---- folders --------------------------------------------------------------

// A folder in a space (open), at the space's top level before `beforeId`
// (the end by default), holding `pinIds` (of that space) in that order.
/** @param {State} state */
function createFolder(state, { id, spaceId, name = 'New Folder', pinIds = [], beforeId = null }) {
  if (!hasSpace(state, spaceId) || (state.folders ?? []).some((f) => f.id === id)) return state;
  let next = { ...state, folders: [...(state.folders ?? []), { id, spaceId, name: uniqueName(state, spaceId, folderName(name) || 'New Folder'), open: true }] };
  next = writeOrder(next, null, placed(pinOrder(next, spaceId), { kind: 'folder', id }, beforeId));
  for (const pinId of pinIds) {
    if (next.pins.some((p) => p.id === pinId && p.spaceId === spaceId)) next = movePin(next, pinId, { folderId: id });
  }
  return next;
}

/** @param {State} state */
function renameFolder(state, folderId, name) {
  const clean = folderName(name);
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!clean || !folder || folder.name === clean) return state;
  return { ...state, folders: (state.folders ?? []).map((f) => (f.id === folderId ? { ...f, name: clean } : f)) };
}

/** @param {State} state */
function setFolderOpen(state, folderId, open) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder || (folder.open !== false) === !!open) return state;
  return { ...state, folders: (state.folders ?? []).map((f) => (f.id === folderId ? { ...f, open: !!open } : f)) };
}

// A folder at its space's top level before `beforeId` (the end by default).
/** @param {State} state */
function moveFolder(state, folderId, { beforeId = null } = {}) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder) return state;
  return writeOrder(state, null, placed(pinOrder(state, folder.spaceId), { kind: 'folder', id: folderId }, beforeId));
}

// Delete a folder; its pins stay, in its place at the top level.
/** @param {State} state */
function deleteFolder(state, folderId) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder) return state;
  const inside = pinOrder(state, folder.spaceId, folderId);
  const top = pinOrder(state, folder.spaceId).flatMap((x) => (x.id === folderId ? inside : [x]));
  const next = { ...state, folders: state.folders.filter((f) => f.id !== folderId) };
  return writeOrder(next, null, top);
}

// Delete a space; its tabs, pins and archive entries move to the first
// remaining space. The last space can't be deleted.
/** @param {State} state */
function deleteSpace(state, spaceId) {
  if (state.spaces.length < 2 || !hasSpace(state, spaceId)) return state;
  const spaces = state.spaces.filter((s) => s.id !== spaceId);
  const target = spaces[0].id;
  const tabSpace = {};
  for (const [tabId, sid] of Object.entries(state.tabSpace)) tabSpace[tabId] = sid === spaceId ? target : sid;
  const activeSpaceByWindow = {};
  for (const [w, sid] of Object.entries(state.activeSpaceByWindow)) activeSpaceByWindow[w] = sid === spaceId ? target : sid;
  // Its folders go along (after the first space's own items), and its pins
  // with them, unless that space already has their URL.
  const movedTop = pinOrder(state, spaceId);
  const folders = (state.folders ?? []).map((f) => (f.spaceId === spaceId ? { ...f, spaceId: target } : f));
  const pins = state.pins.filter((p) => p.spaceId !== spaceId);
  for (const pin of state.pins.filter((p) => p.spaceId === spaceId)) {
    if (!pinForUrl({ ...state, pins }, pin.url, target)) pins.push({ ...pin, spaceId: target });
  }
  let next = { ...state, spaces, tabSpace, activeSpaceByWindow, pins, folders };
  const kept = new Set(pins.map((p) => p.id));
  const targetTop = pinOrder(state, target);
  next = writeOrder(next, null, [...targetTop, ...movedTop.filter((x) => x.kind === 'folder' || kept.has(x.id))]);
  next.archive = state.archive.map((a) => (a.spaceId === spaceId ? { ...a, spaceId: target } : a));
  if (state.lostTabs) next.lostTabs = { windows: state.lostTabs.windows.map((w) => ({ ...w, tabs: w.tabs.map((t) => (t.spaceId === spaceId ? { ...t, spaceId: target } : t)) })) };
  return next;
}

// ---- archive --------------------------------------------------------------

// Newest first, one entry per URL, capped.
/** @param {State} state */
function archiveTab(state, { id, url, title, spaceId, favIconUrl, closedAt }, cap = ARCHIVE_CAP) {
  if (!url) return state;
  const key = normalizeUrl(url);
  const entry = { id, url, title: title || url, spaceId, favIconUrl: favIconUrl || '', closedAt };
  const rest = state.archive.filter((a) => normalizeUrl(a.url) !== key);
  return { ...state, archive: [entry, ...rest].slice(0, cap) };
}

// Remember a site's icon; keeps the most recently fetched FAVICON_CAP sites.
/** @param {State} state */
function rememberFavicon(state, origin, { data, href, at }, cap = FAVICON_CAP) {
  if (!origin || !data) return state;
  const entries = Object.entries({ ...state.favicons, [origin]: { data, href, at } })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, cap);
  return { ...state, favicons: Object.fromEntries(entries) };
}

/** @param {State} state */
function removeArchived(state, archiveId) {
  return { ...state, archive: state.archive.filter((a) => a.id !== archiveId) };
}

// Tabs due for auto-archive: web pages that aren't pinned in their space,
// aren't the active tab of their window, and haven't been active for
// `settings.archiveAfterHours` (0 or less disables it).
/** @param {State} state */
function staleTabs(state, now) {
  const hours = Number(state.settings.archiveAfterHours);
  if (!(hours > 0)) return [];
  const cutoff = now - hours * 3600_000;
  return Object.values(state.tabs).filter(
    (t) => !t.active && /^https?:/i.test(t.url) && (t.lastActive ?? now) < cutoff && !pinForUrl(state, t.url, state.tabSpace[t.id]),
  );
}

// Tabs due to be put to sleep (background/sleep.js picks from these, and
// asks each tab itself before it does): web pages that aren't the tab in
// front of their window, aren't asleep, aren't on a site that never sleeps,
// and haven't been used (or woken) for `settings.sleepAfterHours` (0 or less:
// never; `afterMs` in its place, for tests and a pass asked for by hand).
// Pinned tabs too. The time Safari was closed doesn't count: after a restart
// every last use is moved forward (syncTabs). The longest unused first.
/** @param {State} state @param {number} now @param {{ afterMs?: number | null }} [options] */
function sleepyTabs(state, now, { afterMs = null } = {}) {
  const ms = afterMs ?? Number(state.settings.sleepAfterHours) * 3600_000;
  if (!(ms > 0)) return [];
  const cutoff = now - ms;
  const lastUse = (t) => Math.max(t.lastActive ?? now, t.wokeAt ?? -Infinity);
  return Object.values(state.tabs)
    .filter((t) => !t.active && !t.sleeping && /^https?:/i.test(t.url) && lastUse(t) < cutoff && !neverSleeps(t.url, state.settings.neverSleepSites))
    .sort((a, b) => lastUse(a) - lastUse(b));
}

/** @param {State} state */
function archiveEntryForTab(state, tab, { id, closedAt }) {
  return { id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, spaceId: state.tabSpace[tab.id] ?? state.spaces[0].id, closedAt };
}

export {
  ARCHIVE_CAP,
  DEFAULT_SETTINGS,
  DEFAULT_SPACE,
  STATE_KEYS,
  defaultState,
  normalizeState,
  normalizeShortcuts,
  normalizeThemes,
  normalizeUrl,
  activeSpaceId,
  pinForUrl,
  assignTab,
  upsertTab,
  removeTab,
  activateTab,
  syncTabs,
  isRenumbered,
  reclaimTabs,
  webKey,
  moveTab,
  setActiveSpace,
  followTab,
  recentTabOfSpace,
  createSpace,
  updateSpace,
  addPin,
  removePin,
  movePin,
  pinOrder,
  createFolder,
  renameFolder,
  setFolderOpen,
  moveFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  deleteSpace,
  archiveTab,
  removeArchived,
  rememberFavicon,
  inheritSpace,
  FAVICON_CAP,
  staleTabs,
  sleepyTabs,
  seenTab,
  archiveEntryForTab,
};
