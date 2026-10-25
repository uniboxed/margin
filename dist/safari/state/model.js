// Pure state functions. No browser APIs: everything here is unit tested
// with `node --test` and called by background.js. Functions never mutate
// their input; untouched top-level keys keep their identity so the
// background can write only the keys that changed.
// Classic script, because Safari doesn't support module service workers:
// the background loads it with importScripts(); it attaches to
// globalThis.Margin.model.

(() => {
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
    archiveAfterHours: 12,
    paletteShortcut: 'Alt+KeyK',
    // Searches use the browser's engine (shared/search.js). Safari: the one
    // learned from Safari's own address-bar searches, { id, name, template, at }.
    safariSearch: null,
    sidebarWidth: 260, // px, resizable 160–500 in 10px steps (shared/view.js)
    blockGestures: true, // Safari: no swipe back/forward, pinch for all tabs, or page bounce (shared/gestures.js)
    pullToRefresh: true, // Safari: Margin's pull down at the top to reload (shared/pull.js)
    swipeNavigation: true, // Safari: Margin's two-finger swipe back/forward (shared/pull.js)
    sidebarShortcut: 'Alt+KeyS', // show/hide the sidebar (content/sidebar.js page listener)
    // Safari, with "Keep open": pages go in a frame beside the sidebar, laid
    // out as in a narrower window (content/shell.js). Origins listed in
    // fitPagesExcept keep the push layout.
    fitPages: true,
    fitPagesExcept: [],
    // Defaults from the build's platform profile (shared/platform.js; loaded
    // before this file in the background). Editable in Settings. Fallback:
    // the Chrome profile's ⌃⌘ + arrows (e.g. in node tests).
    shortcuts: Object.freeze({ ...(globalThis.Margin?.platform?.navigation ?? LEGACY_SHORTCUTS) }),
    // Which profile's defaults `shortcuts` started from (see normalizeShortcuts).
    shortcutDefaults: globalThis.Margin?.platform?.name ?? 'chrome',
  });

  const DEFAULT_SPACE = Object.freeze({
    id: 'personal',
    name: 'Personal',
    emoji: '🏠',
    color: '#6c5ce7',
  });

  const STATE_KEYS = ['spaces', 'activeSpaceByWindow', 'tabSpace', 'pins', 'archive', 'settings', 'tabs', 'favicons'];
  const FAVICON_CAP = 150;

  function defaultState() {
    return {
      spaces: [{ ...DEFAULT_SPACE }],
      activeSpaceByWindow: {},
      tabSpace: {},
      pins: [],
      archive: [],
      settings: { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SETTINGS.shortcuts } },
      // Snapshot of open tabs, written by the background so content scripts
      // (which have no `tabs` API) can render from storage alone.
      tabs: {},
      // Site icons Margin fetched itself (Safari gives none): { [origin]: { data, href, at } }.
      favicons: {},
    };
  }

  // Fill in anything missing from what storage.local returned.
  function normalizeState(raw = {}) {
    const base = defaultState();
    const spaces = Array.isArray(raw.spaces) && raw.spaces.length ? raw.spaces : base.spaces;
    return {
      spaces,
      activeSpaceByWindow: { ...raw.activeSpaceByWindow },
      tabSpace: { ...raw.tabSpace },
      pins: Array.isArray(raw.pins) ? raw.pins : [],
      archive: Array.isArray(raw.archive) ? raw.archive : [],
      settings: {
        ...base.settings,
        ...withoutKeys(raw.settings, REMOVED_SETTINGS),
        shortcuts: normalizeShortcuts(raw.settings, base.settings),
        shortcutDefaults: base.settings.shortcutDefaults,
      },
      tabs: { ...raw.tabs },
      favicons: { ...raw.favicons },
    };
  }

  // Settings that no longer exist: `searchEngine` (Margin's own engine
  // choice, replaced by the browser's).
  const REMOVED_SETTINGS = ['searchEngine'];
  const withoutKeys = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)));

  // Saved shortcuts include the defaults of the build that saved them. When
  // the defaults change (another build, e.g. Safari's ⌥⌘↓/↑ for tabs after
  // ⌃⌘↓/↑), a saved value that is still the old default moves to the new
  // default; anything the user changed in Settings stays.
  function normalizeShortcuts(rawSettings, baseSettings) {
    const saved = { ...rawSettings?.shortcuts };
    const from = rawSettings?.shortcutDefaults;
    if (from !== baseSettings.shortcutDefaults) {
      const old = (from && globalThis.Margin?.platformProfiles?.[from]?.navigation) || LEGACY_SHORTCUTS;
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

  function activeSpaceId(state, windowId) {
    const id = state.activeSpaceByWindow[windowId];
    return hasSpace(state, id) ? id : state.spaces[0].id;
  }

  function pinForUrl(state, url, spaceId) {
    const key = normalizeUrl(url);
    return state.pins.find((p) => normalizeUrl(p.url) === key && (spaceId == null || p.spaceId === spaceId));
  }

  // ---- tabs -----------------------------------------------------------------

  function tabRecord(tab, prev, now) {
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index ?? prev?.index ?? 0,
      title: tab.title ?? prev?.title ?? '',
      url: tab.url ?? tab.pendingUrl ?? prev?.url ?? '',
      favIconUrl: tab.favIconUrl ?? prev?.favIconUrl ?? '',
      active: !!tab.active,
      lastActive: prev?.lastActive ?? tab.lastAccessed ?? now,
    };
  }

  // New tabs join their window's active space; existing assignments stick.
  function assignTab(state, tabId, windowId) {
    if (hasSpace(state, state.tabSpace[tabId])) return state;
    return { ...state, tabSpace: { ...state.tabSpace, [tabId]: activeSpaceId(state, windowId) } };
  }

  // A window Margin hasn't seen yet (e.g. ⌘N) starts in the space of the
  // window used most recently, instead of the first space.
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

  function removeTab(state, tabId) {
    const tabs = { ...state.tabs };
    const tabSpace = { ...state.tabSpace };
    delete tabs[tabId];
    delete tabSpace[tabId];
    return { ...state, tabs, tabSpace };
  }

  // Exactly one active tab per window. `windowId` may be missing from the
  // event; fall back to the tab's own window.
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

  // Reconcile with `tabs.query({})`. When `fresh` (browser restart), tab and
  // window ids are new, so old assignments are meaningless: tabs that match a
  // pin by URL go to that pin's space, the rest to their window's active space.
  function syncTabs(state, openTabs, { fresh = false, now = Date.now() } = {}) {
    let next = {
      ...state,
      tabs: {},
      tabSpace: {},
      activeSpaceByWindow: fresh ? {} : { ...state.activeSpaceByWindow },
    };
    for (const tab of openTabs) {
      const prev = fresh ? undefined : state.tabs[tab.id];
      next.tabs[tab.id] = tabRecord(tab, prev, now);
      const kept = fresh ? undefined : state.tabSpace[tab.id];
      const pinned = fresh ? pinForUrl(state, tab.url) : undefined;
      const spaceId = hasSpace(state, kept) ? kept : pinned?.spaceId;
      if (spaceId) next.tabSpace[tab.id] = spaceId;
      else next = assignTab(next, tab.id, tab.windowId);
    }
    const windows = new Set(openTabs.map((t) => String(t.windowId)));
    for (const w of Object.keys(next.activeSpaceByWindow)) if (!windows.has(w)) delete next.activeSpaceByWindow[w];
    return next;
  }

  function moveTab(state, tabId, spaceId) {
    if (!hasSpace(state, spaceId) || !state.tabs[tabId]) return state;
    return { ...state, tabSpace: { ...state.tabSpace, [tabId]: spaceId } };
  }

  // ---- spaces ---------------------------------------------------------------

  function setActiveSpace(state, windowId, spaceId) {
    if (!hasSpace(state, spaceId)) return state;
    return { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId]: spaceId } };
  }

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
  function updateSpace(state, spaceId, patch) {
    const allowed = {};
    for (const key of ['name', 'emoji', 'color']) {
      const value = typeof patch[key] === 'string' ? patch[key].trim() : '';
      if (value) allowed[key] = value;
    }
    return { ...state, spaces: state.spaces.map((s) => (s.id === spaceId ? { ...s, ...allowed } : s)) };
  }

  // ---- pins -----------------------------------------------------------------

  function addPin(state, { id, spaceId, url, title }) {
    if (!url || !hasSpace(state, spaceId) || pinForUrl(state, url, spaceId)) return state;
    return { ...state, pins: [...state.pins, { id, spaceId, url, title: title || url }] };
  }

  function removePin(state, pinId) {
    return { ...state, pins: state.pins.filter((p) => p.id !== pinId) };
  }

  // Delete a space; its tabs, pins and archive entries move to the first
  // remaining space. The last space can't be deleted.
  function deleteSpace(state, spaceId) {
    if (state.spaces.length < 2 || !hasSpace(state, spaceId)) return state;
    const spaces = state.spaces.filter((s) => s.id !== spaceId);
    const target = spaces[0].id;
    const tabSpace = {};
    for (const [tabId, sid] of Object.entries(state.tabSpace)) tabSpace[tabId] = sid === spaceId ? target : sid;
    const activeSpaceByWindow = {};
    for (const [w, sid] of Object.entries(state.activeSpaceByWindow)) activeSpaceByWindow[w] = sid === spaceId ? target : sid;
    let next = { ...state, spaces, tabSpace, activeSpaceByWindow, pins: state.pins.filter((p) => p.spaceId !== spaceId) };
    for (const pin of state.pins.filter((p) => p.spaceId === spaceId)) next = addPin(next, { ...pin, spaceId: target });
    next.archive = state.archive.map((a) => (a.spaceId === spaceId ? { ...a, spaceId: target } : a));
    return next;
  }

  // ---- archive --------------------------------------------------------------

  // Newest first, one entry per URL, capped.
  function archiveTab(state, { id, url, title, spaceId, favIconUrl, closedAt }, cap = ARCHIVE_CAP) {
    if (!url) return state;
    const key = normalizeUrl(url);
    const entry = { id, url, title: title || url, spaceId, favIconUrl: favIconUrl || '', closedAt };
    const rest = state.archive.filter((a) => normalizeUrl(a.url) !== key);
    return { ...state, archive: [entry, ...rest].slice(0, cap) };
  }

  // Remember a site's icon; keeps the most recently fetched FAVICON_CAP sites.
  function rememberFavicon(state, origin, { data, href, at }, cap = FAVICON_CAP) {
    if (!origin || !data) return state;
    const entries = Object.entries({ ...state.favicons, [origin]: { data, href, at } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, cap);
    return { ...state, favicons: Object.fromEntries(entries) };
  }

  function removeArchived(state, archiveId) {
    return { ...state, archive: state.archive.filter((a) => a.id !== archiveId) };
  }

  // Tabs due for auto-archive: web pages that aren't pinned in their space,
  // aren't the active tab of their window, and haven't been active for
  // `settings.archiveAfterHours` (0 or less disables it).
  function staleTabs(state, now) {
    const hours = Number(state.settings.archiveAfterHours);
    if (!(hours > 0)) return [];
    const cutoff = now - hours * 3600_000;
    return Object.values(state.tabs).filter(
      (t) => !t.active && /^https?:/i.test(t.url) && (t.lastActive ?? now) < cutoff && !pinForUrl(state, t.url, state.tabSpace[t.id]),
    );
  }

  function archiveEntryForTab(state, tab, { id, closedAt }) {
    return { id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, spaceId: state.tabSpace[tab.id] ?? state.spaces[0].id, closedAt };
  }

  (globalThis.Margin ??= {}).model = {
    ARCHIVE_CAP,
    DEFAULT_SETTINGS,
    DEFAULT_SPACE,
    STATE_KEYS,
    defaultState,
    normalizeState,
    normalizeShortcuts,
    normalizeUrl,
    activeSpaceId,
    pinForUrl,
    assignTab,
    upsertTab,
    removeTab,
    activateTab,
    syncTabs,
    moveTab,
    setActiveSpace,
    createSpace,
    updateSpace,
    addPin,
    removePin,
    deleteSpace,
    archiveTab,
    removeArchived,
    rememberFavicon,
    inheritSpace,
    FAVICON_CAP,
    staleTabs,
    archiveEntryForTab,
  };
})();
