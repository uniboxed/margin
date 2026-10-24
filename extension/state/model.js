// Pure state functions. No browser APIs: everything here is unit tested
// with `node --test` and called by background.js. Functions never mutate
// their input; untouched top-level keys keep their identity so the
// background can write only the keys that changed.

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

export const STATE_KEYS = ['spaces', 'activeSpaceByWindow', 'tabSpace', 'pins', 'archive', 'settings', 'tabs'];

export function defaultState() {
  return {
    spaces: [{ ...DEFAULT_SPACE }],
    activeSpaceByWindow: {},
    tabSpace: {},
    pins: [],
    archive: [],
    settings: { ...DEFAULT_SETTINGS },
    // Snapshot of open tabs, written by the background so content scripts
    // (which have no `tabs` API) can render from storage alone.
    tabs: {},
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
    tabs: { ...raw.tabs },
  };
}

// Pins and tabs are matched by URL, ignoring the fragment and a bare
// trailing slash. Keep in sync with shared/view.js (a test checks parity).
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url ?? '';
  }
}

const hasSpace = (state, spaceId) => state.spaces.some((s) => s.id === spaceId);

export function activeSpaceId(state, windowId) {
  const id = state.activeSpaceByWindow[windowId];
  return hasSpace(state, id) ? id : state.spaces[0].id;
}

export function pinForUrl(state, url, spaceId) {
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
export function assignTab(state, tabId, windowId) {
  if (hasSpace(state, state.tabSpace[tabId])) return state;
  return { ...state, tabSpace: { ...state.tabSpace, [tabId]: activeSpaceId(state, windowId) } };
}

// Record a created/updated tab and give it a space if it has none.
export function upsertTab(state, tab, now) {
  const record = tabRecord(tab, state.tabs[tab.id], now);
  if (record.active) record.lastActive = now;
  const next = { ...state, tabs: { ...state.tabs, [tab.id]: record } };
  return assignTab(next, tab.id, tab.windowId);
}

export function removeTab(state, tabId) {
  const tabs = { ...state.tabs };
  const tabSpace = { ...state.tabSpace };
  delete tabs[tabId];
  delete tabSpace[tabId];
  return { ...state, tabs, tabSpace };
}

export function activateTab(state, tabId, windowId, now) {
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
export function syncTabs(state, openTabs, { fresh = false, now = Date.now() } = {}) {
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

export function moveTab(state, tabId, spaceId) {
  if (!hasSpace(state, spaceId) || !state.tabs[tabId]) return state;
  return { ...state, tabSpace: { ...state.tabSpace, [tabId]: spaceId } };
}

// ---- spaces ---------------------------------------------------------------

export function setActiveSpace(state, windowId, spaceId) {
  if (!hasSpace(state, spaceId)) return state;
  return { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId]: spaceId } };
}

export function createSpace(state, { id, name, emoji, color }) {
  const space = {
    id,
    name: name?.trim() || 'New space',
    emoji: emoji || '✨',
    color: color || '#00b894',
  };
  return { ...state, spaces: [...state.spaces, space] };
}

// Rename, re-emoji or recolor.
export function updateSpace(state, spaceId, patch) {
  const allowed = {};
  for (const key of ['name', 'emoji', 'color']) {
    const value = typeof patch[key] === 'string' ? patch[key].trim() : '';
    if (value) allowed[key] = value;
  }
  return { ...state, spaces: state.spaces.map((s) => (s.id === spaceId ? { ...s, ...allowed } : s)) };
}

// ---- pins -----------------------------------------------------------------

export function addPin(state, { id, spaceId, url, title }) {
  if (!url || !hasSpace(state, spaceId) || pinForUrl(state, url, spaceId)) return state;
  return { ...state, pins: [...state.pins, { id, spaceId, url, title: title || url }] };
}

export function removePin(state, pinId) {
  return { ...state, pins: state.pins.filter((p) => p.id !== pinId) };
}

// Delete a space; its tabs, pins and archive entries move to the first
// remaining space. The last space can't be deleted.
export function deleteSpace(state, spaceId) {
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
export function archiveTab(state, { id, url, title, spaceId, favIconUrl, closedAt }, cap = ARCHIVE_CAP) {
  if (!url) return state;
  const key = normalizeUrl(url);
  const entry = { id, url, title: title || url, spaceId, favIconUrl: favIconUrl || '', closedAt };
  const rest = state.archive.filter((a) => normalizeUrl(a.url) !== key);
  return { ...state, archive: [entry, ...rest].slice(0, cap) };
}

export function removeArchived(state, archiveId) {
  return { ...state, archive: state.archive.filter((a) => a.id !== archiveId) };
}
