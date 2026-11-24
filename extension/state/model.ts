// Pure state functions. No browser APIs: everything here is unit tested
// with `node --test` and called by background.ts. Functions never mutate
// their input; untouched top-level keys keep their identity so the
// background can write only the keys that changed.
import { capabilities } from '../shared/capabilities.ts';
import { NAVIGATION_DEFAULTS } from '../shared/navigation-defaults.ts';
import { THEMES, DEFAULT_THEME } from '../../app/shared/ui/themes/index.ts';
import { PACKAGE_THEMES, USER_THEME_ID } from '../../app/shared/ui/themes/packages.ts';
import { neverSleeps, oldSleepPage, siteList } from '../shared/sleep.ts';
import { isAwayPage } from '../shared/away.ts';
import { normalizePattern } from '../shared/air-traffic.ts';
import { FAVORITES_CAP, MAX_FOLDER_DEPTH, boundElsewhere, favoriteScopeOf, folderDepth } from '../shared/pinned-rules.ts';
import { backgroundOf } from '../shared/space-background.ts';
export { BG_APPEARANCES, BG_FITS, BG_TEXTURES, BG_WHEELS, backgroundOf } from '../shared/space-background.ts';
import type { AirTrafficRule, ArchiveEntry, KeptTab, SplitGroup, State, TabRecord } from '../../types/margin';
// A kept tab lost with its window: where it was (a window that comes back takes it back).
type KeptFrom = KeptTab & { from: NonNullable<KeptTab['from']> };

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
  // (background/sleep.ts; 0: never), except on these sites (hostnames, each
  // with its subdomains: shared/sleep.ts neverSleeps).
  sleepAfterHours: 4,
  neverSleepSites: Object.freeze([]),
  // Searches use the browser's engine (shared/search.ts). Safari: the one
  // learned from Safari's own address-bar searches, { id, name, template, at }.
  safariSearch: null,
  blockGestures: true, // Safari: no swipe back/forward, pinch for all tabs, or page bounce (shared/gestures.ts)
  pullToRefresh: true, // Safari: Margin's pull down at the top to reload (shared/pull.ts)
  swipeNavigation: true, // Safari: Margin's two-finger swipe back/forward (shared/pull.ts)
  sidebarShortcut: 'Alt+KeyS', // show/hide the sidebar (Margin.app's key: background/link.ts keys)
  // Safari: a note when ⌘T seems to open Safari's homepage instead of Margin
  // (extension/engines/webkit/safari/newtab-hint.ts); turned off from the note.
  newTabHint: true,
  // Chrome: whenever a window goes full screen, Margin full screen instead
  // (no toolbar; extension/engines/chromium/fullscreen.ts).
  marginFullscreenAuto: true,
  // Chrome: Margin only in full screen; in a window that isn't, it stays out
  // of the way and offers full screen when reached for (content/core.ts).
  fullscreenOnly: true,
  // Defaults from the build's capabilities (shared/capabilities.ts; loaded
  // before this file in the background). Editable in Settings. Fallback:
  // the Chrome profile's ⌃⌘ + arrows (e.g. in node tests).
  shortcuts: Object.freeze({ ...(capabilities?.navigation ?? LEGACY_SHORTCUTS) }),
  // Which profile's defaults `shortcuts` started from (see normalizeShortcuts).
  shortcutDefaults: capabilities?.navigationId ?? capabilities?.name ?? 'chrome',
  // Favorites bar scope: 'global' across Spaces (default) or 'profile' per browser profile.
  favoritesScope: 'global' as 'global' | 'profile',
  // Auto-open external-domain links from Pinned tabs and Favorites in Peek (OAuth/SSO excluded).
  autoPeekPins: true,
  // What Margin looks like (themes/index.ts), and each theme's own settings
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

// `lostTabs` is the old name of the kept tabs' reclaimable part (Margin 2,
// Phase 2): read once, moved into `keptTabs`, and written as null so it's
// never moved again.
const STATE_KEYS = ['spaces', 'activeSpaceByWindow', 'awayByWindow', 'tabSpace', 'pins', 'favorites', 'airTraffic', 'splits', 'folders', 'archive', 'settings', 'tabs', 'keptTabs', 'favicons', 'lostTabs'];
const FAVICON_CAP = 150;

function defaultState(): State {
  return {
    spaces: [{ ...DEFAULT_SPACE }],
    activeSpaceByWindow: {},
    // The tab each window has chosen while it's live in another window of the profile (the tab follows the
    // window in front, docs/BROWSER-WINDOWS.md §9): { [windowId]: tabId }. That window shows it away (faded), with the
    // stand-in page in front. A window not in it has its own active tab chosen, as ever.
    awayByWindow: {},
    tabSpace: {},
    pins: [],
    favorites: [],
    airTraffic: [],
    splits: [],
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
    // Margin's tabs with no browser tab (not open): { [Margin tab id]: KeptTab }
    // (keepTab). Shown in their space in every window that shows it.
    keptTabs: {},
    // Before Margin 2's kept tabs: tabs from before ids changed that no open
    // tab matched yet. Moved into keptTabs as it's read (normalizeState).
    lostTabs: null,
  };
}

// Fill in anything missing from what storage.local returned.
function normalizeState(raw: any = {}): State {
  const base = defaultState();
  const spaces = Array.isArray(raw.spaces) && raw.spaces.length ? raw.spaces : base.spaces;
  return {
    spaces,
    activeSpaceByWindow: { ...raw.activeSpaceByWindow },
    awayByWindow: Object.fromEntries(Object.entries(raw.awayByWindow ?? {}).filter(([w, t]) => /^\d+$/.test(w) && Number.isInteger(t))) as Record<number, number>, // (whole numbers: filtered)
    tabSpace: { ...raw.tabSpace },
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((f: any) => f && typeof f.id === 'string' && typeof f.url === 'string') : [],
    airTraffic: Array.isArray(raw.airTraffic) ? raw.airTraffic.filter((r: any) => r && typeof r.id === 'string' && typeof r.pattern === 'string' && typeof r.spaceId === 'string') : [],
    splits: Array.isArray(raw.splits) ? raw.splits.filter((g: any) => g && typeof g.id === 'string' && typeof g.spaceId === 'string' && Array.isArray(g.panes) && g.panes.length >= 2) : [],
    folders: Array.isArray(raw.folders) ? raw.folders.filter((f: any) => f && typeof f.id === 'string' && typeof f.spaceId === 'string') : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    settings: {
      ...base.settings,
      ...withoutKeys(raw.settings, REMOVED_SETTINGS),
      neverSleepSites: siteList(raw.settings?.neverSleepSites ?? []),
      shortcuts: normalizeShortcuts(raw.settings, base.settings),
      shortcutDefaults: base.settings.shortcutDefaults,
      theme: themeId(raw.settings?.theme),
      themes: normalizeThemes(raw.settings),
    },
    ...withTabIds(raw.tabs, raw.keptTabs, raw.lostTabs),
    favicons: { ...raw.favicons },
    lostTabs: null,
  };
}

// ---- Margin's tabs ---------------------------------------------------------
// Margin's sidebar is the real list of tabs (Arc's model, PLAN.md §6 "Margin's
// tabs"): each tab has an id of Margin's own (`mid` on an open tab's record,
// `id` on a kept one), lasting across relaunches, updates and closing, unlike
// the browser's tab ids; and a place in the list (`order`: a number, the list
// sorted by it, newest highest). An open tab's record is in `tabs`, keyed by
// the browser's tab id, its space in `tabSpace`; a Margin tab with no browser
// tab (not open) is in `keptTabs`, keyed by its own id, with its space. A
// browser tab is just the open form of a Margin tab.

// A new Margin tab id: 't-' and ten letters or digits (ui/actions.ts takes it
// as an id). Tests can make them predictable (setTabIdMaker).
let makeTabId = () => `t-${(globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`).replace(/-/g, '').slice(0, 10)}`;
function setTabIdMaker(maker: () => string) {
  makeTabId = maker;
}
const newTabId = () => makeTabId();
const isTabId = (id: unknown): id is string => typeof id === 'string' && /^t-[A-Za-z0-9]{1,30}$/.test(id);

// Open records with their Margin ids and places (records from before Margin 2
// have neither: each gets an id, and its place in its window, `index`), the
// kept tabs as stored, and an earlier build's lostTabs (tabs from before the
// ids changed that no open tab matched yet) as kept tabs: shown, not open, in
// their spaces, and still taken back by a window that comes back within a
// day (reclaimTabs), as lostTabs were.
// (`raw…`: as stored, checked here.)
function withTabIds(rawTabs: any, rawKept: any, rawLost: any) {
  const tabs: Record<string, any> = {};
  for (const [id, r] of Object.entries((rawTabs ?? {}) as Record<string, any>)) {
    if (!r || typeof r !== 'object') continue;
    const mid = isTabId(r.mid) ? r.mid : newTabId();
    const order = Number.isFinite(r.order) ? r.order : Number(r.index) || 0;
    tabs[id] = r.mid === mid && r.order === order ? r : { ...r, mid, order };
  }
  const keptTabs: Record<string, any> = {};
  for (const [id, k] of Object.entries((rawKept && typeof rawKept === 'object' ? rawKept : {}) as Record<string, any>)) {
    if (isTabId(id) && k && typeof k === 'object' && typeof k.url === 'string' && typeof k.spaceId === 'string') keptTabs[id] = k.id === id ? k : { ...k, id };
  }
  for (const w of Array.isArray(rawLost?.windows) ? rawLost.windows : []) {
    for (const t of Array.isArray(w?.tabs) ? w.tabs : []) {
      if (!t || typeof t.url !== 'string' || typeof t.spaceId !== 'string') continue;
      const id = newTabId();
      const at = Number(w.at) || 0;
      keptTabs[id] = {
        id, url: t.url, title: '', favIconUrl: '', spaceId: t.spaceId,
        order: Number(t.index) || 0, lastActive: Number(t.lastActive) || at, keptAt: at, why: 'not restored',
        from: { key: typeof w.key === 'string' ? w.key : groupKey(at, t.windowId), at, size: Number(w.size) || w.tabs.length, index: Number(t.index) || 0, windowId: t.windowId },
      };
    }
  }
  return { tabs, keptTabs };
}

// Whether a read state needs writing again for its tab ids: records given a
// Margin id or a place just now, or lostTabs moved into keptTabs (they're
// new each time until written: background/store.ts read).
function tabIdsAdded(raw: any, state: State) {
  if (Array.isArray(raw?.lostTabs?.windows) && raw.lostTabs.windows.length) return true;
  return Object.entries(state.tabs).some(([id, r]) => raw?.tabs?.[id] !== r);
}

// Kept tabs at most (the least recently used beyond it go to the archive).
const KEPT_CAP = 500;
// A web page's address: only those are kept (a new-tab page, a blank page, an
// extension page isn't worth keeping).
const isWebPage = (url: string | null | undefined) => /^(https?|file):/i.test(url ?? '');

// What binds a Margin tab beyond its page (sticky pins and favorites, its own name): carried with
// its Margin tab whichever way it goes, open → kept (keptRecord) and kept → open (linkKept,
// reclaimTabs), so a renamed tab keeps its name and a pin's or favorite's tab stays theirs.
const BINDINGS = ['pinnedBy', 'favoriteId', 'customTitle'] as const;
function bindingsOf(r: Partial<Record<typeof BINDINGS[number], unknown>> | null | undefined) {
  const out: { pinnedBy?: string, favoriteId?: string, customTitle?: string } = {};
  for (const key of BINDINGS) if (typeof r?.[key] === 'string' && r[key]) out[key] = r[key] as string;
  return out;
}

// A kept tab from an open tab's record (`spaceId`: its space). `from`: the
// window it was in, as it was lost with others (a window closing, a relaunch
// that didn't bring it back), so a window that comes back takes it back
// (reclaimTabs); `wasTab`: the browser's id it had, while that can still mean
// it (this session: a close heard after a sync noticed it gone).
function keptRecord(r: TabRecord, spaceId: string, { why, now, from = null, wasTab = null }: { why: string, now: number, from?: KeptTab['from'] | null, wasTab?: number | null }) {
  return {
    id: isTabId(r.mid) ? r.mid : newTabId(),
    url: r.url,
    title: r.title || '',
    favIconUrl: r.favIconUrl || '',
    spaceId,
    order: placeOf(r),
    lastActive: r.lastActive ?? now,
    wasActive: !!r.active,
    ...(r.wokeAt != null ? { wokeAt: r.wokeAt } : {}),
    // Where its page was scrolled (noteScroll), with the address it's for: opened again, it goes
    // back there once (linkKept, takeScroll).
    ...(r.scroll != null && r.scroll > 0 ? { scroll: { y: r.scroll, url: r.url } } : {}),
    ...bindingsOf(r),
    keptAt: now,
    why,
    ...(from ? { from } : {}),
    ...(wasTab != null ? { wasTab } : {}),
  };
}

// An open tab's browser tab is gone, but the tab stays, not open, in its space
// (`why`: 'window' for a window that closed, 'sleep' for one Margin closed to
// free its memory, 'gone' for one a sync found gone). Not a page that isn't a
// web page (forgotten), nor one pinned in its space (its pin is the lasting
// record, and opens it again).
function keepTab(state: State, tabId: number, how: { why: string, now: number, from?: any, wasTab?: number | null }) {
  const r = state.tabs[tabId];
  const spaceId = state.tabSpace[tabId];
  if (!r || !isWebPage(r.url) || !hasSpace(state, spaceId) || pinForUrl(state, r.url, spaceId)) return removeTab(state, tabId);
  const kept = keptRecord(r, spaceId, how);
  return capKept({ ...removeTab(state, tabId), keptTabs: { ...state.keptTabs, [kept.id]: kept } });
}

// The window a tab is lost with (keepTab's `from`): its key and when, and how
// many web pages the window had (a window that comes back needs two of them,
// or one if it had one: reclaimTabs).
function lostWith(state: State, windowId: number, now: number) {
  const size = Object.values(state.tabs).filter((t) => t.windowId === windowId && isWebPage(t.url)).length;
  return { key: groupKey(now, windowId), at: now, size };
}

// What a browser tab's close does to its Margin tab (background.ts
// tabs.onRemoved), PLAN.md §6 "What keeps a tab, and what removes it":
// - closed on its own (Margin's ×, ⌘W, the browser's tab bar: not a window
//   closing, not Margin's own doing): to the archive (a web page; else gone);
// - lost with its window (`windowClosing`): kept, not open, in its space,
//   with the others of that window (a window that comes back takes them back);
// - closed by Margin (`by`): 'keep' (put to sleep: kept), 'done' (the close
//   did what it needed itself: archived already, or a ⌘T tab handed off).
// A close heard after a sync already found the tab gone (it's kept with that
// id, `wasTab`): closed on its own, it goes to the archive then.
function closedTab(state: State, tabId: number, { by = null, windowClosing = false, now, archiveId }: { by?: { how: 'keep' | 'done', why?: string } | null, windowClosing?: boolean, now: number, archiveId: string }) {
  const r = state.tabs[tabId];
  if (!r) {
    const was = keptWasTab(state, tabId);
    if (!was) return state;
    if (by || windowClosing) return { ...state, keptTabs: { ...state.keptTabs, [was.id]: (({ wasTab: _, ...rest }) => rest)(was) } };
    return archiveKept(state, was.id, { id: archiveId, closedAt: now });
  }
  if (by?.how === 'keep') return keepTab(state, tabId, { why: by.why ?? 'sleep', now });
  if (by) return removeTab(state, tabId);
  if (windowClosing) return keepTab(state, tabId, { why: 'window', now, from: { ...windowLoss(state, r.windowId, now), index: r.index } });
  const archived = /^https?:/i.test(r.url) ? archiveTab(state, archiveEntryForTab(state, r, { id: archiveId, closedAt: now })) : state;
  return removeTab(archived, tabId);
}

// The window a closing window's tabs are lost with: the one its first tab
// closing made (its tabs close one by one), else a new one, with how many
// web pages the window has now.
function windowLoss(state: State, windowId: number, now: number) {
  const earlier = Object.values(state.keptTabs ?? {}).find((k): k is KeptFrom => k.why === 'window' && k.from?.windowId === windowId && now - (k.from.at ?? 0) < 10_000);
  if (earlier) return { key: earlier.from.key, at: earlier.from.at, size: earlier.from.size, windowId };
  return { ...lostWith(state, windowId, now), windowId };
}

// No more than KEPT_CAP kept tabs: the least recently used beyond it are
// archived (as auto-archive would).
function capKept(state: State) {
  const kept = Object.values(state.keptTabs ?? {});
  if (kept.length <= KEPT_CAP) return state;
  const old = kept.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).slice(KEPT_CAP);
  return old.reduce((st, k) => archiveKept(st, k.id, { id: `a-${k.id}`, closedAt: k.keptAt ?? 0 }), state);
}

// A kept tab to the archive (closed from Margin, or unused too long).
function archiveKept(state: State, keptId: string, { id, closedAt }: { id: string, closedAt: number }) {
  const k = state.keptTabs?.[keptId];
  if (!k) return state;
  const next = forgetKept(state, keptId);
  return /^https?:/i.test(k.url) ? archiveTab(next, { id, url: k.url, title: k.title, spaceId: hasSpace(state, k.spaceId) ? k.spaceId : state.spaces[0].id, favIconUrl: k.favIconUrl, closedAt }) : next;
}

function forgetKept(state: State, keptId: string) {
  if (!state.keptTabs?.[keptId]) return state;
  const keptTabs = { ...state.keptTabs };
  delete keptTabs[keptId];
  return { ...state, keptTabs };
}

// A kept tab opened in a browser tab (`tabId`, recorded already: Margin opened
// it for it): the open record takes the Margin tab's id, place and space, and
// its title until the page has its own; it's used now.
function linkKept(state: State, tabId: number, keptId: string, now: number) {
  const k = state.keptTabs?.[keptId];
  const r = state.tabs[tabId];
  if (!k || !r) return state;
  const spaceId = hasSpace(state, k.spaceId) ? k.spaceId : state.tabSpace[tabId];
  const record = { ...r, ...bindingsOf(k), mid: k.id, order: k.order, title: r.title && r.title !== r.url ? r.title : k.title || r.title, lastActive: now, placed: true };
  if (!r.favIconUrl && k.favIconUrl) record.favIconUrl = k.favIconUrl;
  // Its page's scroll, for the page to take once as it loads (takeScroll).
  if (k.scroll && k.scroll.y > 0 && sameUrl(k.scroll.url, k.url)) record.restoreScroll = { y: k.scroll.y, url: k.url };
  const next = forgetKept(state, keptId);
  return { ...next, tabs: { ...next.tabs, [tabId]: record }, ...(spaceId ? { tabSpace: { ...next.tabSpace, [tabId]: spaceId } } : {}) };
}

// The kept tab of a space with this address, if any (a pin opened: its tab). `pinId`/`favoriteId`: whose it's
// for: one bound to another pin or favorite isn't taken (boundElsewhere).
function keptForUrl(state: State, url: string, spaceId: string, forWhom: { pinId?: string | null, favoriteId?: string | null } | null = null) {
  const key = normalizeUrl(url);
  return Object.values(state.keptTabs ?? {}).filter((k) => k.spaceId === spaceId && normalizeUrl(k.url) === key && (!forWhom || !boundElsewhere(state, k, spaceId, forWhom)))
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] ?? null;
}

// The kept tab that had this browser tab id this session (a close heard after
// a sync had already found the tab gone: background.ts tabs.onRemoved).
function keptWasTab(state: State, tabId: number) {
  return Object.values(state.keptTabs ?? {}).find((k) => k.wasTab === tabId) ?? null;
}

// ---- the scroll record (docs/DATA.md "The scroll record") -------------------------------
// Where an open tab's page is scrolled, as its page last said (content/core.ts, as it's hidden or
// left; background/sleep.ts, as it's asked before a close): `scroll` on its record, in px, for the
// record's address only. Kept with its Margin tab when the tab closes and is kept (keptRecord), and
// taken once by the page when that Margin tab opens again (linkKept, takeScroll). This device's
// only: never in the data set (shared/data-set.ts names a tab's fields).
const sameUrl = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && normalizeUrl(a) === normalizeUrl(b);

// The page at `url` in tab `tabId` is scrolled to `y`. Not its record's address (it has moved on, or
// the message came late): nothing.
function noteScroll(state: State, tabId: number, { y, url }: { y: number, url: string }): State {
  const r = state.tabs[tabId];
  if (!r || !isWebPage(r.url) || !sameUrl(url, r.url) || !Number.isFinite(y)) return state;
  const at = Math.max(0, Math.round(y));
  if ((r.scroll ?? 0) === at) return state;
  const { scroll: _, ...rest } = r;
  return { ...state, tabs: { ...state.tabs, [tabId]: at > 0 ? { ...rest, scroll: at } : rest } };
}

// The scroll a reopened Margin tab's page takes, once: `y` (null: none, or for another address),
// and the state without it.
function takeScroll(state: State, tabId: number, url: string): { state: State, y: number | null } {
  const r = state.tabs[tabId];
  if (!r?.restoreScroll) return { state, y: null };
  const { restoreScroll, ...rest } = r;
  return { state: { ...state, tabs: { ...state.tabs, [tabId]: rest } }, y: sameUrl(url, restoreScroll.url) ? restoreScroll.y : null };
}

// ---- places in the list ------------------------------------------------------
// An open tab's place follows the browser's tab strip: a new tab takes a place
// between its neighbours there (at the end: after every tab, open or not, so
// it's the newest), and after a move or a sync the tabs whose places no longer
// follow their window's order get new ones between their neighbours, the
// longest run that does keeping theirs. A kept tab keeps its place.
const placeOf = (t: { order?: number, index?: number } | null | undefined): number => (Number.isFinite(t?.order) ? t!.order! : Number(t?.index) || 0);
const lastPlace = (state: State) => Math.max(-1, ...Object.values(state.tabs).map(placeOf), ...Object.values(state.keptTabs ?? {}).map(placeOf));
// Places closer than this are renumbered (0, 1, 2… in the order they're in).
const TIGHT = 1e-6;

// The place for a new tab at `index` in its window (its neighbours there).
function placeNew(state: State, windowId: number, index: number, exceptId: number) {
  const others = Object.values(state.tabs).filter((t) => t.windowId === windowId && t.id !== exceptId);
  const before = others.filter((t) => t.index < index).sort((a, b) => b.index - a.index)[0];
  const after = others.filter((t) => t.index >= index).sort((a, b) => a.index - b.index)[0];
  if (!after) return lastPlace(state) + 1;
  return before ? (placeOf(before) + placeOf(after)) / 2 : placeOf(after) - 1;
}

// Fill missing places. Browser resync keeps saved places; explicit row drags change them with placeOpen.
function orderTabs(state: State, preserve = false) {
  const byWindow = new Map<number, TabRecord[]>();
  for (const t of Object.values(state.tabs)) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
  let tabs: Record<number, TabRecord> | null = null;
  let top = lastPlace(state);
  for (const list of byWindow.values()) {
    list.sort((a, b) => a.index - b.index);
    const keep = preserve ? new Set(list.flatMap((t, i) => Number.isFinite(t.order) ? [i] : [])) : increasingRun(list.map((t) => (Number.isFinite(t.order) ? t.order! : null)));
    const places = list.map((t, i) => (keep.has(i) ? t.order : null));
    for (let i = 0; i < list.length; i++) {
      if (places[i] != null) continue;
      const prev = i > 0 ? places[i - 1] : null;
      let j = i + 1;
      while (j < list.length && places[j] == null) j++;
      const next = j < list.length ? places[j] : null;
      // A run with no place after it: after everything (the newest).
      places[i] = next == null ? (top = Math.max(top, prev ?? -Infinity) + 1) : prev == null ? next - (j - i) : prev + (next - prev) / (j - i + 1);
    }
    list.forEach((t, i) => {
      if (t.order === places[i]) return;
      tabs ??= { ...state.tabs };
      tabs[t.id] = { ...t, order: places[i]! }; // (every place filled above)
    });
  }
  const next = tabs ? { ...state, tabs } : state;
  return tight(next) ? renumber(next) : next;
}

// The indices of the longest strictly increasing run of the known values.
function increasingRun(values: (number | null)[]) {
  const tails: number[] = []; // index into values of the run's last item, by run length - 1
  const prev = new Array(values.length).fill(-1);
  values.forEach((v, i) => {
    if (v == null) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      // (`tails` holds the places of known values only.)
      if (values[tails[mid]]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<any>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

function tight(state: State) {
  const places = [...Object.values(state.tabs), ...Object.values(state.keptTabs ?? {})].map(placeOf).sort((a, b) => a - b);
  return places.some((p, i) => i > 0 && p !== places[i - 1] && p - places[i - 1] < TIGHT);
}
function renumber(state: State) {
  const all: { kind: 'tab' | 'kept', r: any }[] = [...Object.values(state.tabs).map((r) => ({ kind: ('tab' as 'tab'), r })), ...Object.values(state.keptTabs ?? {}).map((r) => ({ kind: ('kept' as 'kept'), r }))];
  all.sort((a, b) => placeOf(a.r) - placeOf(b.r));
  const tabs = { ...state.tabs };
  const keptTabs = { ...state.keptTabs };
  all.forEach(({ kind, r }, i) => {
    if (kind === 'tab') tabs[r.id] = { ...r, order: i };
    else keptTabs[r.id] = { ...r, order: i };
  });
  return { ...state, tabs, keptTabs };
}

// Where in its window's tab strip a tab with this place opens: before the
// first open tab placed after it (undefined: at the end). `live`: the
// window's tabs as the browser has them now (their indexes; the records'
// can be behind after tabs before them closed), else the records'.
function stripIndexFor(state: State, windowId: number, order: number, live: { id: number, index: number }[] | null = null) {
  const strip = (live ?? Object.values(state.tabs).filter((t) => t.windowId === windowId)).filter((t) => state.tabs[t.id]);
  const after = strip.filter((t) => placeOf(state.tabs[t.id]) > order).sort((a, b) => a.index - b.index)[0];
  return after ? after.index : undefined;
}

// A tab dragged in the list next to another (`side` as the list shows them,
// newest at the top: 'before' is above, a later place): a kept tab takes a
// place between that one and its neighbour on that side. Open tabs move in
// the browser's tab strip instead (background/handlers.ts moveTab).
/** @param spaceId the list's space */
function placeKept(state: State, keptId: string, nextTo: number | string, side: 'before' | 'after', spaceId: string) {
  const k = state.keptTabs?.[keptId];
  const order = placeBeside(state, k, nextTo, side, spaceId);
  if (order == null) return state;
  const next = { ...state, keptTabs: { ...state.keptTabs, [keptId]: { ...k, order } } };
  return tight(next) ? renumber(next) : next;
}
// An open tab dragged beside another row (including one in another window): a place
// between that one and its neighbour, for its window's tab strip to follow (background/handlers.ts moveTab moves it
// there: stripIndexFor). The state, unchanged if there's no such place.
function placeOpen(state: State, tabId: number, nextTo: number | string, side: 'before' | 'after', spaceId: string) {
  const t = state.tabs[tabId];
  const order = placeBeside(state, t, nextTo, side, spaceId);
  if (order == null) return state;
  const next = { ...state, tabs: { ...state.tabs, [tabId]: { ...t, order } } };
  return tight(next) ? renumber(next) : next;
}
// The place beside `nextTo` on `side` in the space's list as shown (its kept tabs and its open ones in every
// window), for `moving`; null if `nextTo` isn't in it.
function placeBeside(state: State, moving: any, nextTo: number | string, side: 'before' | 'after', spaceId: string) {
  const other: any = typeof nextTo === 'string' ? state.keptTabs?.[nextTo] : state.tabs[nextTo];
  if (!moving || !other || other === moving) return null;
  const list = [
    ...Object.values(state.keptTabs ?? {}).filter((x) => x.spaceId === spaceId),
    ...Object.values(state.tabs).filter((t) => state.tabSpace[t.id] === spaceId),
  ].filter((x) => x !== moving).sort((a, b) => placeOf(a) - placeOf(b));
  const at = list.indexOf(other);
  if (at < 0) return null;
  const o = placeOf(other);
  const neighbour = side === 'before' ? list[at + 1] : list[at - 1];
  return neighbour == null ? (side === 'before' ? o + 1 : o - 1) : (o + placeOf(neighbour)) / 2;
}

// Settings that no longer exist: `searchEngine` (Margin's own engine
// choice, replaced by the browser's); `sidebarWidth` (now Arcadia's own,
// settings.themes.arcadia; normalizeThemes moves a saved one there);
// `paletteShortcut` (⌥K: ⌘T opens the same palette).
// Not `keepTabsReadyMinutes`, `keepLeftTabReadyMinutes` or `warmUpTabs`
// (keep-ready and the warm-up, gone in Margin 2 Phase 2 step 8): unread here,
// but kept as saved, so a build from before (main, a branch being checked)
// still finds the 0 set there, and doesn't turn the old keep-ready back
// on with its default of 30.
const REMOVED_SETTINGS = ['searchEngine', 'sidebarWidth', 'paletteShortcut'];
const withoutKeys = (obj: Record<string, unknown> | null | undefined, keys: string[]) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)));

// Each theme's settings, filled in by the theme (which also takes over what
// it used to keep among the top-level settings). Themes this build doesn't
// have keep what's saved.
// Arcadia's package was `arcadia-2` while the old theme still ran pages
// (Margin 2, Phase 1): what it saved joins Arcadia's own, Arcadia's
// sidebarWidth first, then the package's, then a top-level one from before
// themes (theme.ts settingsOf snaps it to 10 px, 160–500).
const OLD_NAMES = Object.freeze({ arcadia: ['arcadium', 'arcadia-2'], neubrutalism: ['neo-brutalism'] }); // (Neo-brutalism until 2026-11-10)
// The active theme's id as saved: a built-in's (an earlier name of one: that
// one), or any id an imported theme may have. The index of those (storage.local
// userThemes) isn't read here, and what draws the theme (Margin.app, the
// overlay, Settings) falls back to Arcadia for one that isn't listed.
function themeId(id: unknown) {
  if (typeof id !== 'string') return DEFAULT_THEME;
  const renamed = Object.entries(OLD_NAMES).find(([, names]) => names.includes(id))?.[0];
  if (renamed) return renamed;
  return Object.hasOwn(THEMES, id) || PACKAGE_THEMES.includes(id) || USER_THEME_ID.test(id) ? id : DEFAULT_THEME;
}
const objectOr = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);
function normalizeThemes(rawSettings: any) {
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
  // A package theme renamed (Neo-brutalism → Neubrutalism): its settings as saved, under its earlier name if there are
  // none under this one, and the earlier entry gone.
  for (const [id, names] of Object.entries(OLD_NAMES)) {
    if (Object.hasOwn(THEMES, id)) continue; // (a theme whose settings the background knows: above)
    const earlier = names.map((name) => objectOr(saved[name])).find(Boolean);
    if (earlier && !objectOr(saved[id])) themes[id] = earlier;
    for (const name of names) delete themes[name];
  }
  return themes;
}

// Saved shortcuts include the defaults of the build that saved them. When
// the defaults change (another build, e.g. Safari's ⌥⌘↓/↑ for tabs after
// ⌃⌘↓/↑), a saved value that is still the old default moves to the new
// default; anything the user changed in Settings stays.
function normalizeShortcuts(rawSettings: any, baseSettings: any) {
  const saved = { ...rawSettings?.shortcuts };
  const from = rawSettings?.shortcutDefaults;
  if (from !== baseSettings.shortcutDefaults) {
    // (A build's defaults by the id it saved, today's or a past one: shared/navigation-defaults.ts.)
    const old = (from && (NAVIGATION_DEFAULTS as Record<string, any>)[from]) || LEGACY_SHORTCUTS;
    for (const [name, value] of Object.entries(saved)) if (value === old[name]) delete saved[name];
  }
  return { ...baseSettings.shortcuts, ...saved };
}

// Pins and tabs are matched by URL, ignoring the fragment and a bare
// trailing slash. Keep in sync with shared/view.ts (a test checks parity).
function normalizeUrl(url: string | null | undefined) {
  try {
    const u = new URL(url as string); // (none: it throws, and that's caught)
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url ?? '';
  }
}

const hasSpace = (state: State, spaceId: string | null | undefined) => state.spaces.some((s) => s.id === spaceId);

function activeSpaceId(state: State, windowId: number) {
  const id = state.activeSpaceByWindow[windowId];
  return hasSpace(state, id) ? id : state.spaces[0].id;
}

// (`url` missing, a page Margin can't read: no pin's, since no pin's address is empty.)
function pinForUrl(state: State, url: string | undefined, spaceId?: string) {
  const key = normalizeUrl(url);
  return state.pins.find((p) => normalizeUrl(p.url) === key && (spaceId == null || p.spaceId === spaceId));
}

// ---- sticky bindings (pinnedBy, favoriteId) ---------------------------------------------------
// A tab (open or kept) bound to a pin is that pin's only while both are in the same space (pins are a
// space's); one bound to a favorite, while the favorite is there (favorites aren't a space's).
const pinOfSpace = (state: State, pinId: unknown, spaceId: string | null | undefined) => typeof pinId === 'string' && !!pinId && state.pins.some((p) => p.id === pinId && p.spaceId === spaceId);
const hasFavorite = (state: State, favoriteId: unknown) => typeof favoriteId === 'string' && !!favoriteId && (state.favorites ?? []).some((f) => f.id === favoriteId);

// A record without a binding that no longer holds in `spaceId` (its pin gone or in another space, its favorite gone).
function heldBindings<T extends { pinnedBy?: string, favoriteId?: string }>(state: State, r: T, spaceId: string | null | undefined): T {
  const dropPin = !!r.pinnedBy && !pinOfSpace(state, r.pinnedBy, spaceId);
  const dropFav = !!r.favoriteId && !hasFavorite(state, r.favoriteId);
  if (!dropPin && !dropFav) return r;
  const out = { ...r };
  if (dropPin) delete out.pinnedBy;
  if (dropFav) delete out.favoriteId;
  return out;
}

// Every tab's bindings checked again (after a space is deleted: its duplicate pins dropped).
function settleBindings(state: State) {
  let tabs: Record<number, TabRecord> | null = null;
  for (const [id, t] of Object.entries(state.tabs)) {
    const held = heldBindings(state, t, state.tabSpace[Number(id)]);
    if (held !== t) (tabs ??= { ...state.tabs })[Number(id)] = held;
  }
  let keptTabs: Record<string, KeptTab> | null = null;
  for (const [id, k] of Object.entries(state.keptTabs ?? {})) {
    const held = heldBindings(state, k, k.spaceId);
    if (held !== k) (keptTabs ??= { ...state.keptTabs })[id] = held;
  }
  return tabs || keptTabs ? { ...state, ...(tabs ? { tabs } : {}), ...(keptTabs ? { keptTabs } : {}) } : state;
}

// ---- tabs -----------------------------------------------------------------

// A tab as Margin keeps it: one an earlier build left on Margin's sleep page
// (shared/sleep.ts oldSleepPage) is the page it was, its address and title
// read from the sleep page's address, whichever copy's it is, so the matching
// after the update (matchTabs) and everything else go by the page until
// Margin handles it (background/tabs.ts leftOnSleepPage). `asleep`: how
// ('page'). One whose sleep page has no web address stays as it is. A tab the
// browser discarded (Chrome's tabs.discard, Margin's or its own) keeps its
// address and says `discarded` ('discarded').
function seenTab(tab: any) {
  if (!tab || tab.asleep) return tab;
  const sleep = oldSleepPage(tab.url || tab.pendingUrl);
  if (sleep?.url) return { ...tab, url: sleep.url, pendingUrl: undefined, title: sleep.title || tab.title, asleep: 'page' };
  return tab.discarded === true ? { ...tab, asleep: 'discarded' } : tab;
}

// A page Margin sent a tab to (a search or an address from the palette: goingTo), drawn as that page at once: the
// browser's tab says the page it's leaving (Margin's new-tab page), or none, until the new one commits, so its row
// stayed "+ New Tab" until then (seen 2026-11-08). For GOING_MS at most (a navigation that never commits: the tab
// is what the browser says again).
const GOING_MS = 15000;
const BLANK = /^about:blank$/i;

function tabRecord(tab: BrowserTab, prev: TabRecord | null | undefined, now: number) {
  const seen = seenTab(tab);
  const going = prev?.going && now - prev.going.at < GOING_MS ? prev.going : null;
  const said = seen.url || seen.pendingUrl || '';
  const before = !!going && (!said || BLANK.test(said) || sameUrl(said, going.from));
  return {
    id: seen.id,
    windowId: seen.windowId,
    index: seen.index ?? prev?.index ?? 0,
    // Gone there: its title as soon as the page has one (the search's words until then).
    // (`going` is prev's: with it, there's a prev.)
    title: before ? going.title || prev!.title || '' : going ? seen.title || prev!.title || '' : seen.title ?? prev?.title ?? '',
    url: before ? going.url : seen.url || seen.pendingUrl || prev?.url || '',
    ...(before ? { going } : {}),
    favIconUrl: before ? '' : seen.favIconUrl ?? prev?.favIconUrl ?? '',
    active: !!seen.active,
    // Playing sound (the row's playing mark) and muted state. Only while true: no field otherwise.
    ...(seen.audible ? { audible: true } : {}),
    ...(seen.mutedInfo?.muted ? { muted: true } : {}),
    lastActive: prev?.lastActive ?? seen.lastAccessed ?? now,
    // Its Margin tab's id and place in the list (new ones: upsertTab, syncTabs).
    ...(isTabId(prev?.mid) ? { mid: prev.mid } : {}),
    ...(Number.isFinite(prev?.order) ? { order: prev!.order } : {}),
    ...(prev?.restored ? { restored: true, restoredFrom: prev.restoredFrom } : {}),
    ...(prev?.placed ? { placed: true } : {}),
    // Its page's scroll while it's that page; a scroll to take once while it loads that page, or
    // isn't at a web page yet (a tab made with an address starts blank: noteScroll, takeScroll).
    ...(prev && (prev.scroll ?? 0) > 0 && sameUrl(seen.url || seen.pendingUrl || prev.url, prev.url) ? { scroll: prev.scroll } : {}),
    ...(prev?.restoreScroll && (!isWebPage(seen.url || seen.pendingUrl) || sameUrl(seen.url || seen.pendingUrl, prev.restoreScroll.url)) ? { restoreScroll: prev.restoreScroll } : {}),
    // Asleep since `at`; awake again since `wokeAt` (a tab woken isn't put
    // to sleep again until it's been left that long once more: sleepyTabs).
    ...(seen.asleep ? { sleeping: { at: prev?.sleeping?.at ?? now, how: seen.asleep } } : {}),
    ...(!seen.asleep && prev?.sleeping ? { wokeAt: now } : prev?.wokeAt != null ? { wokeAt: prev.wokeAt } : {}),
    ...(typeof prev?.pinnedBy === 'string' && prev.pinnedBy ? { pinnedBy: prev.pinnedBy } : {}),
    ...(typeof prev?.favoriteId === 'string' && prev.favoriteId ? { favoriteId: prev.favoriteId } : {}),
    ...(typeof prev?.customTitle === 'string' && prev.customTitle ? { customTitle: prev.customTitle } : {}),
  };
}

// New tabs join their window's active space; existing assignments stick.
function assignTab(state: State, tabId: number, windowId: number) {
  if (hasSpace(state, state.tabSpace[tabId])) return state;
  return { ...state, tabSpace: { ...state.tabSpace, [tabId]: activeSpaceId(state, windowId) } };
}

// A window Margin hasn't seen yet (e.g. ⌘N) starts in the space of the
// window used most recently, instead of the first space.
function inheritSpace(state: State, windowId: number) {
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
function upsertTab(state: State, tab: BrowserTab, now: number) {
  // The stand-in page is never a Margin tab (shared/away.ts).
  if (isAwayPage(tab.url) || isAwayPage(tab.pendingUrl)) return state.tabs[tab.id] ? removeTab(state, tab.id) : state;
  const prev = state.tabs[tab.id];
  const record = tabRecord(tab, prev, now);
  if (prev) {
    record.active = prev.active && prev.windowId === record.windowId;
    if (!record.mid) record.mid = newTabId();
    if (!Number.isFinite(record.order)) record.order = placeNew(state, tab.windowId, record.index, tab.id);
    const next = { ...state, tabs: { ...state.tabs, [tab.id]: record } };
    return assignTab(next, tab.id, tab.windowId);
  }
  record.active = false;
  // A new Margin tab, placed between its neighbours in the window.
  record.mid = newTabId();
  record.order = placeNew(state, tab.windowId, record.index, tab.id);
  const newWindow = !Object.values(state.tabs).some((t) => t.windowId === tab.windowId);
  let next = newWindow ? inheritSpace(state, tab.windowId) : state;
  next = { ...next, tabs: { ...next.tabs, [tab.id]: record } };
  if (tight(next)) next = renumber(next);
  // A new tab that opens focused takes over its window's highlight even if
  // the browser never sends onActivated for it.
  if (tab.active) next = activateTab(next, tab.id, tab.windowId, now);
  return assignTab(next, tab.id, tab.windowId);
}

// Tab `tabId` sent to `url` by Margin (background/handlers.ts search, openHere): shown there at once, titled `title`
// (the search's words; else its address shows), while the browser's tab still says the page before (tabRecord).
function goingTo(state: State, tabId: number, { url, title = '' }: { url: string, title?: string }, now: number) {
  const prev = state.tabs[tabId];
  if (!prev || typeof url !== 'string' || !url) return state;
  const from = prev.going?.from ?? prev.url;
  return { ...state, tabs: { ...state.tabs, [tabId]: { ...prev, url, title, favIconUrl: '', going: { url, title, from, at: now } } } };
}

function removeTab(state: State, tabId: number) {
  const tabs = { ...state.tabs };
  const tabSpace = { ...state.tabSpace };
  delete tabs[tabId];
  delete tabSpace[tabId];
  // Chosen away by a window: that window chooses its own front tab again.
  const away = state.awayByWindow ?? {};
  const awayByWindow = Object.values(away).includes(tabId) ? Object.fromEntries(Object.entries(away).filter(([, t]) => t !== tabId)) : away;
  return { ...state, tabs, tabSpace, awayByWindow };
}

// Window `windowId` has tab `tabId` chosen while it's live in another window (docs/BROWSER-WINDOWS.md §9); `tabId` null:
// it chooses its own front tab again.
function setAway(state: State, windowId: number, tabId: number | null) {
  const away = state.awayByWindow ?? {};
  if ((away[windowId] ?? null) === tabId) return state;
  const awayByWindow = { ...away };
  if (tabId == null) delete awayByWindow[windowId];
  else awayByWindow[windowId] = tabId;
  return { ...state, awayByWindow };
}

// The tabs some window shows away: never put to sleep or archived while one does.
const awayTabs = (state: State) => new Set(Object.values(state.awayByWindow ?? {}));

// Exactly one active tab per window. `windowId` may be missing from the
// event; fall back to the tab's own window.
function activateTab(state: State, tabId: number, windowId: number | null | undefined, now: number) {
  windowId ??= state.tabs[tabId]?.windowId;
  if (windowId == null) return state;
  const tabs: Record<string, TabRecord> = {};
  for (const [id, t] of Object.entries(state.tabs)) {
    if (t.windowId !== windowId) tabs[id] = t;
    else if (t.id === tabId) tabs[id] = { ...t, active: true, lastActive: now };
    else tabs[id] = t.active ? { ...t, active: false, lastActive: now } : t;
  }
  // A tab of its own live in the window: it shows nothing away any more (docs/BROWSER-WINDOWS.md §9).
  const next = { ...state, tabs };
  return state.tabs[tabId]?.windowId === windowId ? setAway(next, windowId, null) : next;
}

// A tab moved to another window by Margin (background/away.ts, tabs.move): its record there, at `index`, not in
// front yet (its activation comes next); its place in the list kept.
function movedTab(state: State, tabId: number, windowId: number, index: number) {
  const t = state.tabs[tabId];
  if (!t || (t.windowId === windowId && (index == null || t.index === index))) return state;
  return { ...state, tabs: { ...state.tabs, [tabId]: { ...t, windowId, active: false, ...(Number.isInteger(index) && index >= 0 ? { index } : {}) } } };
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
const webKey = (t: { url?: string, pendingUrl?: string }) => {
  const url = t.url || t.pendingUrl || '';
  return /^(https?|file):/i.test(url) ? normalizeUrl(url) : '';
};
const anyKey = (t: { url?: string, pendingUrl?: string }) => normalizeUrl(t.url || t.pendingUrl || '');
// Options: `minShared(records, tabs)`: web addresses an open window (its
// `tabs`) must share with an old one (its `records`) to be paired (1);
// `anyWindow`: also by address in any window (true).
function matchTabs(old: any[], open: any[], { minShared = () => 1, anyWindow = true }: { minShared?: (records: any[], tabs: any[]) => number, anyWindow?: boolean } = {}) {
  const byWindow = (list: any[]) => {
    const map = new Map();
    for (const t of list) map.set(t.windowId, [...(map.get(t.windowId) ?? []), t]);
    return map;
  };
  const oldWindows = byWindow(old);
  const openWindows = byWindow(open);
  // Pair windows by shared web addresses, most first, one to one.
  const pairs: { openId: number, oldId: number, shared: number }[] = [];
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
  const usedOld = new Set<any>();
  for (const { openId, oldId } of pairs) {
    if (paired.has(openId) || usedOld.has(oldId)) continue;
    paired.set(openId, oldId);
    usedOld.add(oldId);
  }
  /** old record (or lost tab) for each matched open tab */
  const matched: Map<number, any> = new Map();
  const taken = new Set<any>();
  // Same address (by `key`) within `records` for `tabs`; of several (the
  // same page open twice), the one nearest its place in the window.
  const zip = (tabs: any[], records: any[], key: (t: any) => any) => {
    const free = new Map<string, any[]>();
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

// Tabs lost with others (a window closing, a relaunch that didn't bring them
// back) are kept as not-open tabs for good (until archived), and for a day
// (LOST_MS) after they were lost (their `from.at`), a window that comes back
// (reopened from History, Safari's restore of the last session, a restored
// tab whose address comes late) takes them back (reclaimTabs).
const LOST_MS = 24 * 60 * 60 * 1000;
const reclaimable = (state: State, now: number) => Object.values(state.keptTabs ?? {}).filter((k): k is KeptFrom => !!k.from && Number.isFinite(k.from.at) && now - k.from.at <= LOST_MS && !!webKey(k));

// Reconcile with `tabs.query({})`. Tabs Margin knows keep their records; when
// `fresh` (the browser restarted: every id is new, and old ones may be reused
// for other tabs) none are known. When the ids were renumbered (fresh, or no
// open tab is one Margin knows while some it knew are gone: Margin updated),
// the tabs are matched to the records of tabs that are gone (matchTabs) and
// keep their Margin tab (id, place, space); after a restart every last use is
// moved forward so the most recent is now (gaps kept: the space's most recent
// tab is still right, and nothing is archived just for the time the browser
// was closed), the kept tabs' too. Unmatched ones go to a pin's space with
// that address (after a restart), or their window's active space; a window
// Margin doesn't know shows the space of the tab it shows. Records no open
// tab matched stay as kept tabs (not open), in their spaces; windows that
// come back take theirs back (reclaimTabs), as do windows all new to Margin
// later. Tabs gone while nothing was renumbered (closed while a close went
// unheard) are kept too, with the id they had (a close heard later archives
// them: background.ts).
// An old window, as of one renumbering (window ids repeat across them).
const groupKey = (at: number, windowId: number) => `${at}:${windowId}`;

// Did the browser renumber its tabs (a restart, or Margin updated: no open
// tab is one Margin knows, while some it knew are gone)?
function isRenumbered(state: State, openTabs: BrowserTab[], { fresh = false } = {}) {
  if (fresh) return true;
  const open = new Set(openTabs.map((t) => String(t.id)));
  return openTabs.length > 0 && !openTabs.some((t) => state.tabs[t.id]) && Object.keys(state.tabs).some((id) => !open.has(id));
}

function syncTabs(state: State, openTabs: BrowserTab[], { fresh = false, now = Date.now() } = {}) {
  // (The stand-in page isn't a Margin tab: shared/away.ts.)
  openTabs = openTabs.filter((t) => !isAwayPage(t.url) && !isAwayPage(t.pendingUrl)).map(seenTab); // (a sleeping tab by its page's address)
  const open = new Set(openTabs.map((t) => String(t.id)));
  const known = (t: BrowserTab) => !fresh && !!state.tabs[t.id];
  const gone = Object.values(state.tabs).filter((r) => fresh || !open.has(String(r.id)));
  const renumbered = isRenumbered(state, openTabs, { fresh });
  const matched = renumbered ? matchTabs(gone, openTabs.filter((t) => !known(t))) : new Map();
  // After a restart: the last thing used before it (an open tab, or one kept
  // as it closed) is used now (all moved by as much).
  const keptBefore = Object.values(state.keptTabs ?? {});
  const latest = Math.max(0, ...gone.map((r) => r.lastActive ?? 0), ...keptBefore.map((k) => Math.max(k.lastActive ?? 0, k.keptAt ?? 0)));
  const shift = fresh && (gone.length || keptBefore.length) ? Math.max(0, now - latest) : 0;
  const knownWindows = new Set(Object.values(state.tabs).map((t) => t.windowId));
  let next: State = {
    ...state,
    tabs: {},
    tabSpace: {},
    activeSpaceByWindow: fresh ? {} : { ...state.activeSpaceByWindow },
    // (Renumbered: the browser ids kept tabs had mean other tabs now.)
    keptTabs: shift || renumbered ? Object.fromEntries(keptBefore.map((k) => [k.id, withoutTabId(shift ? shifted(k, shift) : k)])) : { ...state.keptTabs },
  };
  const unplaced: any[] = []; // (Safari's tabs, as it gave them)
  for (const tab of openTabs) {
    const same = known(tab) ? state.tabs[tab.id] : undefined;
    const match = matched.get(tab.id);
    // A tab an earlier sync of this session found gone (kept with its id),
    // there after all at the same address: the same Margin tab.
    const back = !same && !match && !renumbered ? keptWasTab(state, tab.id) : null;
    const again = back && normalizeUrl(back.url) === normalizeUrl(tab.url || tab.pendingUrl) ? back : null;
    if (again) delete next.keptTabs[again.id];
    const prev = same ?? (match && { ...match, lastActive: (match.lastActive ?? now) + shift, ...(match.wokeAt != null ? { wokeAt: match.wokeAt + shift } : {}) })
      ?? (again && { ...again, mid: again.id });
    const record = tabRecord(tab, prev, now);
    if (match) Object.assign(record, { restored: true, restoredFrom: groupKey(now, match.windowId) });
    if (!record.mid) record.mid = newTabId();
    next.tabs[tab.id] = record;
    const kept = same ? state.tabSpace[tab.id] : match ? state.tabSpace[match.id] : again?.spaceId;
    const pinned = fresh ? pinForUrl(state, tab.url) : undefined;
    const spaceId = hasSpace(state, kept) ? kept : pinned?.spaceId;
    if (spaceId) next.tabSpace[tab.id] = spaceId;
    else unplaced.push(tab);
  }
  const windows = new Set(openTabs.map((t) => String(t.windowId)));
  for (const w of Object.keys(next.activeSpaceByWindow)) if (!windows.has(w)) delete (next.activeSpaceByWindow as Record<string, string>)[w];
  // Away choices of windows gone, or of tabs gone (a fresh start: every window's own front tab again).
  next.awayByWindow = fresh ? {} : Object.fromEntries(Object.entries(next.awayByWindow ?? {}).filter(([w, t]) => windows.has(w) && open.has(String(t))));
  for (const tab of openTabs) {
    if (tab.active && next.activeSpaceByWindow[tab.windowId] == null && next.tabSpace[tab.id]) {
      next.activeSpaceByWindow = { ...next.activeSpaceByWindow, [tab.windowId]: next.tabSpace[tab.id] };
    }
  }
  for (const tab of unplaced) next = assignTab(next, tab.id, tab.windowId);
  // What's gone and wasn't matched: kept (not open), by its old window.
  const used = new Set(matched.values());
  // `size`: how many web pages its window had (it needs two of them back, or one if it had one).
  const size = (windowId: number) => gone.filter((r) => r.windowId === windowId && webKey(r)).length;
  const keptTabs = { ...next.keptTabs };
  for (const r of gone) {
    if (used.has(r)) continue;
    const spaceId = state.tabSpace[r.id];
    if (!webKey(r) || !hasSpace(state, spaceId)) continue;
    const from = { key: groupKey(now, r.windowId), at: now, size: size(r.windowId), index: r.index, windowId: r.windowId };
    const record = renumbered ? { ...r, lastActive: (r.lastActive ?? now) + shift, ...(r.wokeAt != null ? { wokeAt: r.wokeAt + shift } : {}) } : r;
    const k = keptRecord(record, spaceId, { why: renumbered ? 'not restored' : 'gone', now, from, wasTab: renumbered ? null : r.id });
    keptTabs[k.id] = k;
  }
  next = { ...next, keptTabs };
  next = orderTabs(next, true);
  // Tabs that may be back from before: after a renumbering, the ones nothing
  // matched (a window kept as it closed, before the relaunch); else windows
  // that are all new to Margin (opened while it wasn't running, not a tab
  // dragged out of a window it knew).
  const withKnown = new Set(openTabs.filter(known).map((t) => t.windowId));
  const candidates = renumbered
    ? openTabs.filter((t) => !matched.has(t.id)).map((t) => t.id)
    : openTabs.filter((t) => !known(t) && !knownWindows.has(t.windowId) && !withKnown.has(t.windowId)).map((t) => t.id);
  if (candidates.length) next = reclaimTabs(next, candidates, now);
  return capKept(dropStalePinned(next, now));
}

const withoutTabId = (k: KeptTab) => {
  if (k.wasTab == null) return k;
  const { wasTab: _, ...rest } = k;
  return rest;
};
// A kept tab's times moved forward by `ms` (the time the browser was closed).
const shifted = (k: KeptTab, ms: number) => ({
  ...k,
  lastActive: (k.lastActive ?? 0) + ms,
  ...(k.wokeAt != null ? { wokeAt: k.wokeAt + ms } : {}),
  ...(k.keptAt != null ? { keptAt: k.keptAt + ms } : {}),
  ...(k.from ? { from: { ...k.from, at: (k.from.at ?? 0) + ms } } : {}),
});

// Kept tabs whose address is pinned in their space (kept from before the pin,
// or lost at a relaunch): its pin opens it, so they're dropped once no window
// can take them back.
function dropStalePinned(state: State, now: number) {
  let keptTabs: Record<string, KeptTab> | null = null;
  for (const k of Object.values(state.keptTabs ?? {})) {
    if (!pinForUrl(state, k.url, k.spaceId)) continue;
    if (k.from && now - (k.from.at ?? 0) <= LOST_MS) continue;
    keptTabs ??= { ...state.keptTabs };
    delete keptTabs[k.id];
  }
  return keptTabs ? { ...state, keptTabs } : state;
}

// `tabIds` (tabs that may be back from before: a window reopened from the
// last session or from History, tabs of a window still being restored, a tab
// whose address came late; never ones the user had before or moved) take
// back kept tabs lost with their window within LOST_MS: their Margin tab (id,
// place, space), and their last use moved forward by the time since (the one
// in front keeps its own). Matched as at a restart (matchTabs), window to old
// window only, and a window must share two of its old window's web pages (one
// if it had only one): a page opened anew doesn't take an old tab's place.
// The window then shows its front tab's space.
function reclaimTabs(state: State, tabIds: number[], now: number) {
  const lost = reclaimable(state, now);
  if (!lost.length) return state;
  const old = lost.map((k) => ({ ...k, windowId: `lost:${k.from.key}`, index: Number(k.from.index) || 0 }));
  const open = tabIds.map((id) => state.tabs[id]).filter((t) => t && !t.restored && !t.placed); // placed: by the user or Margin
  // Two of the old window's pages, counting those already back in this window.
  const minShared = (records: any[], tabs: any[]) => {
    const from = records[0].from;
    const back = Object.values(state.tabs).filter((t) => t.windowId === tabs[0].windowId && t.restored && t.restoredFrom === from.key).length;
    return Math.max(1, Math.min(2, Number(from.size) || records.length) - back);
  };
  const matched = matchTabs(old, open, { anyWindow: false, minShared });
  if (!matched.size) return state;
  const tabs = { ...state.tabs };
  const tabSpace = { ...state.tabSpace };
  const keptTabs = { ...state.keptTabs };
  let next = { ...state, tabs, tabSpace, keptTabs };
  for (const [id, k] of matched) {
    const record = tabs[id];
    const lastActive = record.active ? record.lastActive : Math.min(now, (k.lastActive ?? now) + (now - k.from.at));
    tabs[id] = { ...record, ...bindingsOf(k), mid: k.id, order: k.order, lastActive, restored: true, restoredFrom: k.from.key };
    if (hasSpace(state, k.spaceId)) tabSpace[id] = k.spaceId;
    delete keptTabs[k.id];
    if (record.active) next = setActiveSpace(next, record.windowId, tabSpace[id]);
  }
  return orderTabs(next, true);
}

// (Moved to another space, a tab of a pin is that pin's no more: heldBindings.)
function moveTab(state: State, tabId: number | string, spaceId: string) {
  // A kept tab (not open): its space.
  if (typeof tabId === 'string') {
    const k = state.keptTabs?.[tabId];
    if (!k || !hasSpace(state, spaceId) || k.spaceId === spaceId) return state;
    return { ...state, keptTabs: { ...state.keptTabs, [tabId]: heldBindings(state, { ...k, spaceId }, spaceId) } };
  }
  if (!hasSpace(state, spaceId) || !state.tabs[tabId]) return state;
  // Placed on purpose (the user, or Margin opening it there): never taken
  // for a tab coming back from before the ids changed (reclaimTabs).
  const record = state.tabs[tabId].placed ? state.tabs[tabId] : { ...state.tabs[tabId], placed: true };
  const held = heldBindings(state, record, spaceId);
  const tabs = held === state.tabs[tabId] ? state.tabs : { ...state.tabs, [tabId]: held };
  return { ...state, tabs, tabSpace: { ...state.tabSpace, [tabId]: spaceId } };
}

// ---- spaces ---------------------------------------------------------------

function setActiveSpace(state: State, windowId: number, spaceId: string) {
  if (!hasSpace(state, spaceId)) return state;
  return { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId]: spaceId } };
}

// The window shows the space of the tab it shows (Arc): a tab of another
// space brought to the front (from the palette, Safari's own tab bar)
// switches the window to that space.
function followTab(state: State, tabId: number, windowId: number) {
  const spaceId = state.tabSpace[tabId];
  if (!spaceId || !hasSpace(state, spaceId) || activeSpaceId(state, windowId) === spaceId) return state;
  return setActiveSpace(state, windowId, spaceId);
}

// The most recently shown tab of a space in a window (not `exceptId`).
function recentTabOfSpace(state: State, windowId: number, spaceId: string | null | undefined, exceptId: number | null = null) {
  if (!spaceId) return null;
  return Object.values(state.tabs).filter((t) => t.windowId === windowId && t.id !== exceptId && state.tabSpace[t.id] === spaceId)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] ?? null;
}

// A space's theme (2026-11-20, Tirth: a theme per space, chosen as it's made, the one it was made from by default):
// a theme's id (built in or imported: ui/space-theme.ts says which are there), or none, the profile's settings.theme.
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const themeIdOk = (v: unknown): v is string => typeof v === 'string' && THEME_ID.test(v);

// A space's background: extension/shared/space-background.ts (the UI reads it too).

function createSpace(state: State, { id, name, emoji, color, theme }: { id: string; name?: string; emoji?: string; color?: string; theme?: string | null; }) {
  const space: State['spaces'][number] = {
    id,
    name: name?.trim() || 'New space',
    emoji: emoji || '✨',
    color: color || '#00b894',
    ...(themeIdOk(theme) ? { theme } : {}),
  };
  return { ...state, spaces: [...state.spaces, space] };
}

// The spaces in the order given (the library's rule: app/shared/library/library.ts orderSpaces); ones it
// doesn't name keep their places after them.
function orderSpaces(state: State, ids: string[]) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const spaces = [...state.spaces].map((sp, i) => ({ sp, i }))
    .sort((a, b) => (rank.get(a.sp.id) ?? ids.length + a.i) - (rank.get(b.sp.id) ?? ids.length + b.i)).map((x) => x.sp);
  return spaces.every((sp, i) => sp === state.spaces[i]) ? state : { ...state, spaces };
}

// Rename, re-emoji, recolor, another theme (`theme`: an id; null: none, the profile's; left out or not an id:
// unchanged), or another background (`background`: an object, as backgroundOf reads it, none when it reads as null;
// null: none, the theme's own; left out or not an object: unchanged).
function updateSpace(state: State, spaceId: string, patch: { name?: string; emoji?: string; color?: string; theme?: string | null; background?: unknown; }) {
  const allowed: Record<string, string> = {};
  for (const key of ['name', 'emoji', 'color'] as const) {
    const value = typeof patch[key] === 'string' ? patch[key].trim() : '';
    if (value) allowed[key] = value;
  }
  const theme = themeIdOk(patch.theme) ? patch.theme : patch.theme === null ? null : undefined;
  const b = patch.background;
  const background = b && typeof b === 'object' && !Array.isArray(b) ? backgroundOf(b) : patch.background === null ? null : undefined;
  return {
    ...state,
    spaces: state.spaces.map((s) => {
      if (s.id !== spaceId) return s;
      const next = { ...s, ...allowed };
      if (theme === null) delete next.theme;
      else if (theme !== undefined) next.theme = theme;
      if (background === null) delete next.background;
      else if (background !== undefined) next.background = background;
      return next;
    }),
  };
}

// ---- pins -----------------------------------------------------------------

// Pins and folders are ordered per space by `pos`: the space's top level
// mixes folders and the pins in none, and each folder orders its own pins.
// Pins saved before folders existed have no `pos`: their order in the list
// stands in (shared/view.ts does the same). Every change renumbers the
// lists it touches 0, 1, 2…
const posOf = (item: any, i: number) => (Number.isFinite(item?.pos) ? item.pos : i);
const folderIn = (state: State, folderId: string | null | undefined, spaceId: string) => (state.folders ?? []).find((f) => f.id === folderId && f.spaceId === spaceId) ?? null;
// A pin's folder, if that folder exists in the pin's space (else it's loose).
const folderOfPin = (state: State, pin: { folderId?: string | null, spaceId: string }) => (pin.folderId ? folderIn(state, pin.folderId, pin.spaceId) : null);
// A folder's parent folder, if it exists in the same space and doesn't cycle.
function folderParent(state: State, folder: { id: string, parentId?: string | null, spaceId: string }) {
  if (!folder.parentId || folder.parentId === folder.id) return null;
  const parent = folderIn(state, folder.parentId, folder.spaceId);
  if (!parent) return null;
  // Walk up from parent to guard against malformed cycles in stored data.
  const seen = new Set<string>([folder.id]);
  let cur: typeof parent | null = parent;
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    cur = cur.parentId ? folderIn(state, cur.parentId, folder.spaceId) : null;
  }
  return parent;
}
function folderSubtreeHeight(state: State, folderId: string, spaceId: string, seen = new Set<string>()): number {
  if (seen.has(folderId)) return 0;
  seen.add(folderId);
  const children = (state.folders ?? []).filter((f) => f.spaceId === spaceId && f.parentId === folderId);
  if (!children.length) return 1;
  return 1 + Math.max(...children.map((c) => folderSubtreeHeight(state, c.id, spaceId, seen)));
}
function folderHasAncestor(state: State, folderId: string, ancestorId: string, spaceId: string): boolean {
  const seen = new Set<string>();
  let cur = folderIn(state, folderId, spaceId);
  while (cur && !seen.has(cur.id)) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
    cur = cur.parentId ? folderIn(state, cur.parentId, spaceId) : null;
  }
  return false;
}

// One list, in order: [{ kind: 'folder' | 'pin', id }]. `folderId` null: the
// space's top level; a folder id: its child folders and pins mixed in order.
function pinOrder(state: State, spaceId: string, folderId: string | null = null) {
  const items: { kind: 'folder' | 'pin', id: string, pos: number }[] = [];
  // Folders first, so equal positions sort as shared/view.ts shows them.
  (state.folders ?? []).forEach((f, i) => {
    if (f.spaceId !== spaceId) return;
    const parent = folderParent(state, f)?.id ?? null;
    if (parent === folderId) items.push({ kind: 'folder', id: f.id, pos: posOf(f, i) });
  });
  state.pins.forEach((p, i) => {
    if (p.spaceId !== spaceId) return;
    const inFolder = folderOfPin(state, p)?.id ?? null;
    if (inFolder === folderId) items.push({ kind: 'pin', id: p.id, pos: posOf(p, i) });
  });
  return items.sort((a, b) => a.pos - b.pos).map(({ kind, id }) => ({ kind, id }));
}

// Write `list` (pinOrder's shape) as the order of that level, putting its
// pins and subfolders in `folderId` (null: top level).
function writeOrder(state: State, folderId: string | null, list: { kind: "folder" | "pin"; id: string; }[] | { kind: string; id: string; }[]) {
  const pos = new Map(list.map((item, i) => [item.id, i] as [string, number]));
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
    if (!pos.has(f.id) || (f.pos === pos.get(f.id) && (f.parentId ?? null) === (folderId ?? null))) return f;
    foldersChanged = true;
    const { parentId: _old, ...rest } = f;
    return { ...rest, ...(folderId ? { parentId: folderId } : {}), pos: pos.get(f.id) };
  });
  if (!pinsChanged && !foldersChanged) return state;
  return { ...state, ...(pinsChanged ? { pins } : {}), ...(foldersChanged ? { folders } : {}) };
}

// `list` with `item` moved before the entry with id `beforeId` (the end if
// there's none).
function placed(list: { kind: "folder" | "pin"; id: string; }[], item: { kind: string; id: string; }, beforeId: string | null) {
  if (beforeId != null && beforeId === item.id) return list.some((x) => x.id === item.id) ? list : [...list, item]; // before itself: where it is
  const rest = list.filter((x) => x.id !== item.id);
  const at = beforeId == null ? -1 : rest.findIndex((x) => x.id === beforeId);
  if (at < 0) return [...rest, item];
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

const FOLDER_NAME_MAX = 40;
const folderName = (name: string) => String(name ?? '').trim().slice(0, FOLDER_NAME_MAX);
// "New Folder", "New Folder 2"…: menus name folders, so a space's are distinct.
function uniqueName(state: State, spaceId: string, name: string) {
  const taken = new Set((state.folders ?? []).filter((f) => f.spaceId === spaceId).map((f) => f.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

// `folderId`/`beforeId`: where it goes (a folder of its space, before a pin
// or folder at that level); the end of the space's top level by default.
function addPin(state: State, { id, spaceId, url, title, folderId = null, beforeId = null }: { id: string, spaceId: string, url: string, title?: string | null, folderId?: string | null, beforeId?: string | null }) {
  if (!url || !hasSpace(state, spaceId) || pinForUrl(state, url, spaceId)) return state;
  const next = { ...state, pins: [...state.pins, { id, spaceId, url, title: title || url }] };
  const folder = folderId ? folderIn(state, folderId, spaceId) : null;
  return movePin(next, id, { folderId: folder?.id ?? null, beforeId });
}

function removePin(state: State, pinId: string) {
  const pins = state.pins.filter((p) => p.id !== pinId);
  if (pins.length === state.pins.length) return state;
  return unbindPinTab({ ...state, pins }, pinId);
}

// Sticky pin binding: attach a live or kept tab to `pinId` so sub-navigation stays attached to that pin.
function bindTabToPin(state: State, tabId: number | string, pinId: string | null) {
  if (typeof tabId === 'string') {
    const k = state.keptTabs?.[tabId];
    if (!k || (k.pinnedBy ?? null) === pinId) return state;
    const { pinnedBy: _old, ...rest } = k;
    return { ...state, keptTabs: { ...state.keptTabs, [tabId]: { ...rest, ...(pinId ? { pinnedBy: pinId } : {}) } } };
  }
  const t = state.tabs[tabId];
  if (!t || (t.pinnedBy ?? null) === pinId) return state;
  const { pinnedBy: _old, ...rest } = t;
  return { ...state, tabs: { ...state.tabs, [tabId]: { ...rest, ...(pinId ? { pinnedBy: pinId } : {}) } } };
}

function unbindPinTab(state: State, pinId: string) {
  let tabsChanged = false;
  const tabs: Record<number, TabRecord> = {};
  for (const [id, t] of Object.entries(state.tabs)) {
    if (t.pinnedBy === pinId) {
      tabsChanged = true;
      const { pinnedBy: _old, ...rest } = t;
      tabs[Number(id)] = rest;
    } else tabs[Number(id)] = t;
  }
  let keptChanged = false;
  const keptTabs: Record<string, KeptTab> = {};
  for (const [id, k] of Object.entries(state.keptTabs ?? {})) {
    if (k.pinnedBy === pinId) {
      keptChanged = true;
      const { pinnedBy: _old, ...rest } = k;
      keptTabs[id] = rest;
    } else keptTabs[id] = k;
  }
  if (!tabsChanged && !keptChanged) return state;
  return { ...state, ...(tabsChanged ? { tabs } : {}), ...(keptChanged ? { keptTabs } : {}) };
}

// Custom inline title on a pin or tab (blank clears customTitle back to live/saved title).
const CUSTOM_TITLE_MAX = 80;
const cleanCustomTitle = (name: unknown) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_TITLE_MAX);
function renamePin(state: State, pinId: string, title: string) {
  const pin = state.pins.find((p) => p.id === pinId);
  if (!pin) return state;
  const clean = cleanCustomTitle(title);
  if ((pin.customTitle ?? '') === clean) return state;
  return {
    ...state,
    pins: state.pins.map((p) => {
      if (p.id !== pinId) return p;
      const { customTitle: _old, ...rest } = p;
      return clean ? { ...rest, customTitle: clean } : rest;
    }),
  };
}
function renameTab(state: State, tabId: number | string, title: string) {
  const clean = cleanCustomTitle(title);
  if (typeof tabId === 'string') {
    const k = state.keptTabs?.[tabId];
    if (!k || (k.customTitle ?? '') === clean) return state;
    const { customTitle: _old, ...rest } = k;
    return { ...state, keptTabs: { ...state.keptTabs, [tabId]: clean ? { ...rest, customTitle: clean } : rest } };
  }
  const t = state.tabs[tabId];
  if (!t || (t.customTitle ?? '') === clean) return state;
  const { customTitle: _old, ...rest } = t;
  return { ...state, tabs: { ...state.tabs, [tabId]: clean ? { ...rest, customTitle: clean } : rest } };
}

// A pin into a folder of its space (or out of folders: null), before the pin
// or folder `beforeId` there (the end by default).
function movePin(state: State, pinId: string, { folderId = null, beforeId = null }: { folderId?: string | null, beforeId?: string | null } = {}) {
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

// A folder in a space (open), at `parentId` (null: top level) before `beforeId`
// (the end by default), holding `pinIds` (of that space) in that order.
function createFolder(state: State, { id, spaceId, name = 'New Folder', pinIds = [], parentId = null, beforeId = null }: { id: string, spaceId: string, name?: string, pinIds?: string[], parentId?: string | null, beforeId?: string | null }) {
  if (!hasSpace(state, spaceId) || (state.folders ?? []).some((f) => f.id === id)) return state;
  const parent = parentId ? folderIn(state, parentId, spaceId) : null;
  if (parentId && !parent) return state;
  if (parent && folderDepth(state, parent.id, spaceId) + 1 >= MAX_FOLDER_DEPTH) return state;
  const targetParent = parent?.id ?? null;
  let next = { ...state, folders: [...(state.folders ?? []), { id, spaceId, name: uniqueName(state, spaceId, folderName(name) || 'New Folder'), open: true, ...(targetParent ? { parentId: targetParent } : {}) }] };
  next = writeOrder(next, targetParent, placed(pinOrder(next, spaceId, targetParent), { kind: 'folder', id }, beforeId));
  for (const pinId of pinIds) {
    if (next.pins.some((p) => p.id === pinId && p.spaceId === spaceId)) next = movePin(next, pinId, { folderId: id });
  }
  return next;
}

function renameFolder(state: State, folderId: string, name: string) {
  const clean = folderName(name);
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!clean || !folder || folder.name === clean) return state;
  return { ...state, folders: (state.folders ?? []).map((f) => (f.id === folderId ? { ...f, name: clean } : f)) };
}

function setFolderOpen(state: State, folderId: string, open: boolean) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder || (folder.open !== false) === !!open) return state;
  return { ...state, folders: (state.folders ?? []).map((f) => (f.id === folderId ? { ...f, open: !!open } : f)) };
}

// Move a folder within its space, optionally nesting it inside `parentId` (null: top level)
// before `beforeId`. Refuses cycles (moving into itself or a descendant) and depths past MAX_FOLDER_DEPTH.
function moveFolder(state: State, folderId: string, { parentId, beforeId = null }: { parentId?: string | null, beforeId?: string | null } = {}) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder) return state;
  const from = folderParent(state, folder)?.id ?? null;
  const to = parentId === undefined ? from : parentId;
  if (to != null) {
    const parent = folderIn(state, to, folder.spaceId);
    if (!parent) return state;
    if (folderHasAncestor(state, to, folderId, folder.spaceId)) return state; // cycle guard
    const newDepth = folderDepth(state, to, folder.spaceId) + 1;
    const height = folderSubtreeHeight(state, folderId, folder.spaceId);
    if (newDepth + height - 1 >= MAX_FOLDER_DEPTH) return state;
  }
  let next = state;
  if (from !== to) next = writeOrder(next, from, pinOrder(next, folder.spaceId, from).filter((x) => x.id !== folderId));
  return writeOrder(next, to, placed(pinOrder(next, folder.spaceId, to), { kind: 'folder', id: folderId }, beforeId));
}

// Delete a folder; its child pins and subfolders stay, promoted into its parent level in its place.
function deleteFolder(state: State, folderId: string) {
  const folder = (state.folders ?? []).find((f) => f.id === folderId);
  if (!folder) return state;
  const parent = folderParent(state, folder)?.id ?? null;
  const inside = pinOrder(state, folder.spaceId, folderId);
  const level = pinOrder(state, folder.spaceId, parent).flatMap((x) => (x.id === folderId ? inside : [x]));
  const next = { ...state, folders: state.folders.filter((f) => f.id !== folderId) };
  return writeOrder(next, parent, level);
}

// Delete a space; its tabs, pins and archive entries move to the first
// remaining space. The last space can't be deleted.
function deleteSpace(state: State, spaceId: string) {
  if (state.spaces.length < 2 || !hasSpace(state, spaceId)) return state;
  const spaces = state.spaces.filter((s) => s.id !== spaceId);
  const target = spaces[0].id;
  const tabSpace: Record<string, string> = {};
  for (const [tabId, sid] of Object.entries(state.tabSpace)) tabSpace[tabId] = sid === spaceId ? target : sid;
  const activeSpaceByWindow: Record<string, string> = {};
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
  // Its kept (not open) tabs go there too.
  next.keptTabs = Object.fromEntries(Object.entries(state.keptTabs ?? {}).map(([id, k]) => [id, k.spaceId === spaceId ? { ...k, spaceId: target } : k]));
  if (state.airTraffic?.length) {
    next.airTraffic = state.airTraffic.filter((r) => r.spaceId !== spaceId);
  }
  if (state.splits?.length) {
    next.splits = state.splits.map((g) => (g.spaceId === spaceId ? { ...g, spaceId: target } : g));
  }
  // Its pins the first space already had are gone: their tabs (now that space's) are no pin's.
  return settleBindings(next);
}

// ---- favorites ------------------------------------------------------------
// Top-of-sidebar Favorites grid (Arc): global across Spaces by default ('global'),
// or scoped per profile when settings.favoritesScope === 'profile'. Cap 12 per scope.


function favoriteForUrl(state: State, url: string | undefined, scope = 'global') {
  const key = normalizeUrl(url);
  if (!key) return undefined;
  return (state.favorites ?? []).find((f) => (f.scope || 'global') === scope && normalizeUrl(f.url) === key);
}

function renumberFavorites(list: NonNullable<State['favorites']>, scope: string) {
  let i = 0;
  return list.map((f) => ((f.scope || 'global') === scope ? { ...f, pos: i++ } : f));
}

// What a favorite can be: a web page (http, https), or a Mac app (Margin.app's app items: `app://<bundle id>` with an
// app target). Never a browser's own page (an extension's, about:, a new-tab page) nor one of Margin's.
function favoriteUrlOk(url: unknown, target?: { kind: string, bundleId?: string } | null) {
  if (typeof url !== 'string') return false;
  if (/^https?:\/\/[^\s/]/i.test(url)) return !target || target.kind === 'web';
  return target?.kind === 'app' && typeof target.bundleId === 'string' && url === `app://${target.bundleId}`;
}

// The kept tabs bound to a favorite (its tab asleep, or lost with its window), the most recently used first.
function keptOfFavorite(state: State, favoriteId: string) {
  return Object.values(state.keptTabs ?? {}).filter((k) => k.favoriteId === favoriteId)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.id.localeCompare(b.id));
}

// A favorite's one tab is `keepId` (open or kept): any other kept tab bound to it (left by earlier builds, which opened
// a new tab each time) goes to the archive, so they don't pile up unseen (the sidebar never shows a favorite's tabs).
function settleFavorite(state: State, favoriteId: string, keepId: string | null | undefined) {
  return keptOfFavorite(state, favoriteId).filter((k) => k.id !== keepId)
    .reduce((st, k) => archiveKept(st, k.id, { id: `a-${k.id}`, closedAt: k.keptAt ?? k.lastActive ?? 0 }), state);
}

function addFavorite(state: State, { id, scope = 'global', url, title, customTitle, target, beforeId = null }: {
  id: string, scope?: string, url: string, title?: string, customTitle?: string,
  target?: NonNullable<State['favorites']>[number]['target'], beforeId?: string | null,
}) {
  if (!favoriteUrlOk(url, target)) return state;
  const list = state.favorites ?? [];
  const inScope = list.filter((f) => (f.scope || 'global') === scope).sort((a, b) => posOf(a, 0) - posOf(b, 0));
  if (inScope.length >= FAVORITES_CAP) return state;
  if (inScope.some((f) => normalizeUrl(f.url) === normalizeUrl(url))) return state;
  const fav = {
    id, scope, url, title: title || url,
    ...(typeof customTitle === 'string' && customTitle.trim() ? { customTitle: customTitle.trim().slice(0, FOLDER_NAME_MAX) } : {}),
    ...(target ? { target } : {}),
    pos: inScope.length,
  };
  const nextScope = [...inScope];
  const at = beforeId ? nextScope.findIndex((f) => f.id === beforeId) : -1;
  if (at >= 0) nextScope.splice(at, 0, fav);
  else nextScope.push(fav);
  const others = list.filter((f) => (f.scope || 'global') !== scope);
  return { ...state, favorites: renumberFavorites([...others, ...nextScope], scope) };
}

function removeFavorite(state: State, favoriteId: string) {
  const list = state.favorites ?? [];
  const target = list.find((f) => f.id === favoriteId);
  if (!target) return state;
  const scope = target.scope || 'global';
  let next: State = { ...state, favorites: renumberFavorites(list.filter((f) => f.id !== favoriteId), scope) };
  next = unbindFavoriteTab(next, favoriteId);
  return next;
}

function moveFavorite(state: State, favoriteId: string, { beforeId = null }: { beforeId?: string | null } = {}) {
  const list = state.favorites ?? [];
  const fav = list.find((f) => f.id === favoriteId);
  if (!fav) return state;
  const scope = fav.scope || 'global';
  const inScope = list.filter((f) => (f.scope || 'global') === scope).sort((a, b) => posOf(a, 0) - posOf(b, 0));
  const rest = inScope.filter((f) => f.id !== favoriteId);
  const at = beforeId ? rest.findIndex((f) => f.id === beforeId) : -1;
  if (at >= 0) rest.splice(at, 0, fav);
  else rest.push(fav);
  if (rest.every((f, i) => f.id === inScope[i]?.id)) return state;
  const others = list.filter((f) => (f.scope || 'global') !== scope);
  return { ...state, favorites: renumberFavorites([...others, ...rest], scope) };
}

function renameFavorite(state: State, favoriteId: string, customTitle: string | null | undefined) {
  const list = state.favorites ?? [];
  const fav = list.find((f) => f.id === favoriteId);
  if (!fav) return state;
  const clean = typeof customTitle === 'string' ? customTitle.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX) : '';
  if ((fav.customTitle ?? '') === clean) return state;
  return {
    ...state,
    favorites: list.map((f) => {
      if (f.id !== favoriteId) return f;
      if (!clean) { const { customTitle: _, ...rest } = f; return rest; }
      return { ...f, customTitle: clean };
    }),
  };
}

function bindTabToFavorite(state: State, tabId: number | string, favoriteId: string) {
  if (!(state.favorites ?? []).some((f) => f.id === favoriteId)) return state;
  if (typeof tabId === 'string') {
    const k = state.keptTabs?.[tabId];
    if (!k || k.favoriteId === favoriteId) return state;
    const { pinnedBy: _, ...clean } = k;
    return { ...state, keptTabs: { ...state.keptTabs, [tabId]: { ...clean, favoriteId } } };
  }
  const t = state.tabs[tabId];
  if (!t || t.favoriteId === favoriteId) return state;
  const { pinnedBy: _, ...clean } = t;
  return { ...state, tabs: { ...state.tabs, [tabId]: { ...clean, favoriteId } } };
}

function unbindFavoriteTab(state: State, favoriteId: string) {
  let tabsChanged = false;
  const tabs: Record<number, TabRecord> = {};
  for (const [k, t] of Object.entries(state.tabs)) {
    if (t.favoriteId === favoriteId) {
      const { favoriteId: _, ...rest } = t;
      tabs[Number(k)] = rest;
      tabsChanged = true;
    } else tabs[Number(k)] = t;
  }
  let keptChanged = false;
  const keptTabs: Record<string, KeptTab> = {};
  for (const [k, item] of Object.entries(state.keptTabs ?? {})) {
    if (item.favoriteId === favoriteId) {
      const { favoriteId: _, ...rest } = item;
      keptTabs[k] = rest;
      keptChanged = true;
    } else keptTabs[k] = item;
  }
  if (!tabsChanged && !keptChanged) return state;
  return { ...state, ...(tabsChanged ? { tabs } : {}), ...(keptChanged ? { keptTabs } : {}) };
}

// ---- Link rules --------------------------------------------------
const AIR_TRAFFIC_CAP = 100;

function addAirTrafficRule(state: State, { id, pattern, spaceId, enabled = true }: { id: string, pattern: string, spaceId: string, enabled?: boolean }) {
  const norm = normalizePattern(pattern);
  if (!norm || !hasSpace(state, spaceId)) return state;
  const list = state.airTraffic ?? [];
  // Replace existing rule for the exact same pattern so 1-click "Always open in this Space" updates cleanly
  // (at the cap too: a replaced rule doesn't add one).
  const rest = list.filter((r) => normalizePattern(r.pattern) !== norm);
  if (rest.length >= AIR_TRAFFIC_CAP) return state;
  const rule: AirTrafficRule = { id, pattern: norm, spaceId, enabled: enabled !== false, order: rest.length };
  return { ...state, airTraffic: [...rest, rule].map((r, i) => ({ ...r, order: i })) };
}

function removeAirTrafficRule(state: State, ruleId: string) {
  const list = state.airTraffic ?? [];
  if (!list.some((r) => r.id === ruleId)) return state;
  return { ...state, airTraffic: list.filter((r) => r.id !== ruleId).map((r, i) => ({ ...r, order: i })) };
}

function toggleAirTrafficRule(state: State, ruleId: string, enabled?: boolean) {
  const list = state.airTraffic ?? [];
  const cur = list.find((r) => r.id === ruleId);
  if (!cur) return state;
  const nextEnabled = typeof enabled === 'boolean' ? enabled : cur.enabled === false;
  return { ...state, airTraffic: list.map((r) => (r.id === ruleId ? { ...r, enabled: nextEnabled } : r)) };
}

// ---- split view (2–4 panes) -----------------------------------------------
// A split's panes are Margin tabs, by their own lasting ids (`t-…`: an open tab's `mid`, a kept tab's id; the library's
// item ids), never the browser's tab ids, which change at a restart and as Margin updates ("Margin's tabs" above): a
// pane outlives its tab sleeping, its window closing and coming back, the browser renumbering its tabs, as pins' and
// kept tabs' bindings do. A pane whose Margin tab is gone (closed, archived, forgotten) leaves its split
// (settleSplits, after every change); fewer than 2 left: no split.
const MAX_SPLIT_PANES = 4;

function normalizeSplitRatios(ratios: number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  const raw = Array.isArray(ratios) && ratios.length === count
    ? ratios.map((r) => (Number.isFinite(r) && r > 0 ? r : 1))
    : Array.from({ length: count }, () => 1);
  const sum = raw.reduce((acc, v) => acc + v, 0) || count;
  return raw.map((v) => Math.round((v / sum) * 10000) / 10000);
}

// A pane's id for what the UI or a handler names (an open tab by its browser id, a number or its digits; a Margin tab
// by its own id): that Margin tab's id; null for none.
function paneKey(state: State, itemId: string | number | null | undefined): string | null {
  if (typeof itemId === 'number' || (typeof itemId === 'string' && /^\d+$/.test(itemId))) {
    const mid = state.tabs?.[Number(itemId)]?.mid;
    return isTabId(mid) ? mid : null;
  }
  return typeof itemId === 'string' && itemId ? itemId : null;
}

// Whether a Margin tab is there (open, or kept).
const hasMarginTab = (state: State, mid: string) => !!state.keptTabs?.[mid] || Object.values(state.tabs ?? {}).some((t) => t.mid === mid);

function splitForItem(state: State, itemId: string | number): SplitGroup | null {
  const key = paneKey(state, itemId);
  if (!key) return null;
  return (state.splits ?? []).find((g) => g.panes.includes(key)) ?? null;
}

// The split with only `panes` of its own left, in that order, their ratios kept relative to each other; null for fewer
// than 2 (the split goes).
function withPanes(group: SplitGroup, panes: string[]): SplitGroup | null {
  if (panes.length < 2) return null;
  const old = normalizeSplitRatios(group.ratios, group.panes.length);
  return { ...group, panes, ratios: normalizeSplitRatios(panes.map((p) => old[group.panes.indexOf(p)] ?? 1), panes.length) };
}

function createSplit(state: State, { id, spaceId, panes, axis = 'horizontal', ratios }: {
  id: string, spaceId: string, panes: (string | number)[], axis?: 'horizontal' | 'vertical', ratios?: number[],
}) {
  if (!hasSpace(state, spaceId)) return state;
  const unique = [...new Set(panes.map((p) => paneKey(state, p)).filter((k): k is string => !!k && hasMarginTab(state, k)))].slice(0, MAX_SPLIT_PANES);
  if (unique.length < 2) return state;
  // Remove any of these panes from existing splits first so a tab belongs to at most one split.
  let next = state;
  for (const p of unique) {
    const prev = splitForItem(next, p);
    if (prev) next = removeFromSplit(next, prev.id, p);
  }
  const group: SplitGroup = {
    id,
    spaceId,
    axis: axis === 'vertical' ? 'vertical' : 'horizontal',
    panes: unique,
    // (Ratios given for every pane asked for, by the same index; else equal.)
    ratios: normalizeSplitRatios(Array.isArray(ratios) && ratios.length === panes.length && unique.length === panes.length ? ratios : undefined, unique.length),
  };
  return { ...next, splits: [...(next.splits ?? []), group] };
}

function addToSplit(state: State, splitId: string, paneId: string | number) {
  const key = paneKey(state, paneId);
  const list = state.splits ?? [];
  const group = list.find((g) => g.id === splitId);
  if (!group || !key || !hasMarginTab(state, key) || group.panes.includes(key) || group.panes.length >= MAX_SPLIT_PANES) return state;
  let next = state;
  const other = splitForItem(next, key);
  if (other && other.id !== splitId) next = removeFromSplit(next, other.id, key);
  const panes = [...group.panes, key];
  const ratios = normalizeSplitRatios(undefined, panes.length);
  return { ...next, splits: (next.splits ?? []).map((g) => (g.id === splitId ? { ...g, panes, ratios } : g)) };
}

function removeFromSplit(state: State, splitId: string, paneId: string | number) {
  const key = paneKey(state, paneId);
  const list = state.splits ?? [];
  const group = list.find((g) => g.id === splitId);
  if (!group || !key || !group.panes.includes(key)) return state;
  // Fewer than 2 panes remaining: dissolve the split group automatically.
  const left = withPanes(group, group.panes.filter((p) => p !== key));
  return { ...state, splits: left ? list.map((g) => (g.id === splitId ? left : g)) : list.filter((g) => g.id !== splitId) };
}

// Every split checked against the Margin tabs there are now: a pane whose tab is gone leaves (the others' ratios kept
// relative to each other), as does one already in an earlier split; one saved by a browser tab id becomes that open
// tab's Margin tab; a split of fewer than 2 goes. Run after every change (background/store.ts mutate,
// app/shared/library/library.ts perform): a tab closing, archived or forgotten, a renumbering, a space deleted.
function settleSplits(state: State) {
  const list = state.splits ?? [];
  if (!list.length) return state;
  const seen = new Set<string>();
  let changed = false;
  const splits: SplitGroup[] = [];
  for (const g of list) {
    const raw = Array.isArray(g.panes) ? g.panes : [];
    const keys = raw.map((p) => paneKey(state, p));
    const panes: string[] = [];
    const ratios: number[] = [];
    const old = normalizeSplitRatios(g.ratios, raw.length);
    keys.forEach((k, i) => {
      if (!k || seen.has(k) || panes.includes(k) || !hasMarginTab(state, k) || panes.length >= MAX_SPLIT_PANES) return;
      panes.push(k);
      ratios.push(old[i]);
    });
    const same = panes.length === raw.length && panes.every((p, i) => p === raw[i]) && Array.isArray(g.ratios) && g.ratios.length === raw.length;
    if (same && panes.length >= 2) {
      panes.forEach((p) => seen.add(p));
      splits.push(g);
      continue;
    }
    changed = true;
    if (panes.length < 2) continue;
    panes.forEach((p) => seen.add(p));
    splits.push({ ...g, panes, ratios: normalizeSplitRatios(ratios, panes.length) });
  }
  return changed ? { ...state, splits } : state;
}

function swapSplitPanes(state: State, splitId: string, indexA: number, indexB: number) {
  const list = state.splits ?? [];
  const group = list.find((g) => g.id === splitId);
  if (!group || indexA === indexB || indexA < 0 || indexB < 0 || indexA >= group.panes.length || indexB >= group.panes.length) return state;
  const panes = [...group.panes];
  const ratios = [...normalizeSplitRatios(group.ratios, panes.length)];
  [panes[indexA], panes[indexB]] = [panes[indexB], panes[indexA]];
  [ratios[indexA], ratios[indexB]] = [ratios[indexB], ratios[indexA]];
  return { ...state, splits: list.map((g) => (g.id === splitId ? { ...g, panes, ratios } : g)) };
}

function resizeSplit(state: State, splitId: string, ratios: number[]) {
  const list = state.splits ?? [];
  const group = list.find((g) => g.id === splitId);
  if (!group || !Array.isArray(ratios) || ratios.length !== group.panes.length) return state;
  const norm = normalizeSplitRatios(ratios, group.panes.length);
  return { ...state, splits: list.map((g) => (g.id === splitId ? { ...g, ratios: norm } : g)) };
}

function toggleSplitAxis(state: State, splitId: string) {
  const list = state.splits ?? [];
  const group = list.find((g) => g.id === splitId);
  if (!group) return state;
  const axis: 'horizontal' | 'vertical' = group.axis === 'vertical' ? 'horizontal' : 'vertical';
  return { ...state, splits: list.map((g) => (g.id === splitId ? { ...g, axis } : g)) };
}

// ---- archive --------------------------------------------------------------

// Newest first, one entry per URL, capped.
function archiveTab(state: State, { id, url, title, spaceId, favIconUrl, closedAt }: Omit<ArchiveEntry, 'favIconUrl' | 'title'> & { favIconUrl?: string, title?: string }, cap = ARCHIVE_CAP) {
  if (!url) return state;
  const key = normalizeUrl(url);
  const entry = { id, url, title: title || url, spaceId, favIconUrl: favIconUrl || '', closedAt };
  const rest = state.archive.filter((a) => normalizeUrl(a.url) !== key);
  return { ...state, archive: [entry, ...rest].slice(0, cap) };
}

// Remember a site's icon; keeps the most recently fetched FAVICON_CAP sites.
function rememberFavicon(state: State, origin: string | null, { data, href, at }: { data: any; href: any; at: number; }, cap = FAVICON_CAP) {
  if (!origin || !data) return state;
  const entries = Object.entries({ ...state.favicons, [origin]: { data, href, at } })
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, cap);
  return { ...state, favicons: Object.fromEntries(entries) };
}

function removeArchived(state: State, archiveId: string) {
  return { ...state, archive: state.archive.filter((a) => a.id !== archiveId) };
}

// Tabs due for auto-archive: web pages that aren't pinned in their space,
// aren't the active tab of their window, and haven't been active for
// `settings.archiveAfterHours` (0 or less disables it).
function staleTabs(state: State, now: number) {
  const hours = Number(state.settings.archiveAfterHours);
  if (!(hours > 0)) return [];
  const cutoff = now - hours * 3600_000;
  const away = awayTabs(state);
  return Object.values(state.tabs).filter(
    (t) => !t.active && !away.has(t.id) && /^https?:/i.test(t.url) && (t.lastActive ?? now) < cutoff && !pinForUrl(state, t.url, state.tabSpace[t.id]),
  );
}

// Kept tabs (not open) due for auto-archive, by the same rule: open or not,
// a tab unused for `archiveAfterHours` goes to the archive (PLAN.md §6).
function staleKept(state: State, now: number) {
  const hours = Number(state.settings.archiveAfterHours);
  if (!(hours > 0)) return [];
  const cutoff = now - hours * 3600_000;
  return Object.values(state.keptTabs ?? {}).filter((k) => /^https?:/i.test(k.url) && (k.lastActive ?? now) < cutoff && !pinForUrl(state, k.url, k.spaceId));
}

// Tabs due to be put to sleep (background/sleep.ts picks from these, and
// asks each tab itself before it does): web pages that aren't the tab in
// front of their window, aren't asleep, aren't on a site that never sleeps,
// and haven't been used (or woken) for `settings.sleepAfterHours` (0 or less:
// never; `afterMs` in its place, for tests and a pass asked for by hand).
// Pinned tabs too. The time Safari was closed doesn't count: after a restart
// every last use is moved forward (syncTabs). The longest unused first.
function sleepyTabs(state: State, now: number, { afterMs = null }: { afterMs?: number | null } = {}) {
  const ms = afterMs ?? Number(state.settings.sleepAfterHours) * 3600_000;
  if (!(ms > 0)) return [];
  const cutoff = now - ms;
  const lastUse = (t: TabRecord) => Math.max(t.lastActive ?? now, t.wokeAt ?? -Infinity);
  const away = awayTabs(state);
  return Object.values(state.tabs)
    .filter((t) => !t.active && !away.has(t.id) && !t.sleeping && /^https?:/i.test(t.url) && lastUse(t) < cutoff && !neverSleeps(t.url, state.settings.neverSleepSites))
    .sort((a, b) => lastUse(a) - lastUse(b));
}

function archiveEntryForTab(state: State, tab: TabRecord, { id, closedAt }: { id: string; closedAt: number; }) {
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
  boundElsewhere,
  settleBindings,
  assignTab,
  upsertTab,
  goingTo,
  GOING_MS,
  removeTab,
  setAway,
  movedTab,
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
  orderSpaces,
  updateSpace,
  addPin,
  removePin,
  movePin,
  bindTabToPin,
  unbindPinTab,
  renamePin,
  renameTab,
  pinOrder,
  MAX_FOLDER_DEPTH,
  folderDepth,
  folderHasAncestor,
  createFolder,
  renameFolder,
  setFolderOpen,
  moveFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  deleteSpace,
  FAVORITES_CAP,
  favoriteScopeOf,
  favoriteForUrl,
  addFavorite,
  removeFavorite,
  moveFavorite,
  renameFavorite,
  bindTabToFavorite,
  favoriteUrlOk,
  keptOfFavorite,
  settleFavorite,
  unbindFavoriteTab,
  AIR_TRAFFIC_CAP,
  addAirTrafficRule,
  removeAirTrafficRule,
  toggleAirTrafficRule,
  MAX_SPLIT_PANES,
  splitForItem,
  paneKey,
  settleSplits,
  createSplit,
  addToSplit,
  removeFromSplit,
  swapSplitPanes,
  resizeSplit,
  toggleSplitAxis,
  archiveTab,
  removeArchived,
  rememberFavicon,
  inheritSpace,
  FAVICON_CAP,
  staleTabs,
  staleKept,
  sleepyTabs,
  KEPT_CAP,
  LOST_MS,
  setTabIdMaker,
  newTabId,
  isTabId,
  tabIdsAdded,
  keepTab,
  closedTab,
  lostWith,
  archiveKept,
  forgetKept,
  linkKept,
  keptForUrl,
  keptWasTab,
  noteScroll,
  takeScroll,
  placeKept,
  orderTabs,
  stripIndexFor,
  placeOpen,
  placeOf,
  seenTab,
  archiveEntryForTab,
};
