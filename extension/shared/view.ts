// Pure view derivation shared by the content script and the new-tab page.
// No browser APIs: also importable from node for tests.
import type { Favorite, Pin, State } from '../../types/margin';
import { appIcon, appOfItem } from './apps.ts';
import type { InstalledApp } from './apps.ts';
import { boundElsewhere, favoriteScopeOf } from './pinned-rules.ts';

// A pin's or folder's order (state/model.ts): saved, or its place in the list.
const posOf = (item: { pos?: number } | null | undefined, i: number): number => (Number.isFinite(item?.pos) ? item!.pos! : i);

// Keep in sync with state/model.ts normalizeUrl.
// Each address worked out once (a URL parse is the dear part of a sidebar's build: every pin and favorite is matched
// against every tab), the answers kept until there are this many, then dropped all at once.
const NORMALIZED_KEPT = 4000;
const normalized = new Map<string, string>();
function normalizeUrl(url: string | null | undefined) {
  if (typeof url !== 'string') return parseUrl(url);
  let out = normalized.get(url);
  if (out === undefined) {
    if (normalized.size >= NORMALIZED_KEPT) normalized.clear();
    out = parseUrl(url);
    normalized.set(url, out);
  }
  return out;
}
function parseUrl(url: string | null | undefined) {
  try {
    const u = new URL(url as string); // (none: it throws, and that's caught)
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url ?? '';
  }
}

// (No window yet: the first space.)
function activeSpaceId(state: State, windowId: number | null | undefined) {
  const id = state.activeSpaceByWindow?.[windowId as number];
  return state.spaces.some((s) => s.id === id) ? id : state.spaces[0].id;
}

// What the sidebar shows for one window. `currentTabId` is the tab the
// sidebar is drawn in: the page being looked at is by definition the active
// tab of its window, so it wins over a possibly stale `active` flag.
// Tabs newest first (Arc), below the pins and the "+ New Tab" row: the
// saved Margin places, reversed (a new tab takes the last place). "+ New Tab" is
// highlighted while a new tab is being chosen (`newTabPending`: the palette
// opened by ⌘T or the row), the tab being shown then only softly (`behind`:
// its page is still on screen, under the palette); or when the tab being
// shown is a new-tab page (then it's that row instead of a row of its own).
// `switchingTo`: a tab being switched to (shared/switching.ts), highlighted
// already (the shown one plain, as Arc) until the switch lands; it wins over
// `newTabPending` (the palette chose a tab).
// The space shown is the window's, except: while switching to a tab of
// another space (the palette), that tab's, at once (Arc); and, for a page
// just shown (`justShown`, from content/core.ts), its own tab's while the
// state doesn't say yet that it's in front (the background records an
// activation a moment after the browser shows the tab: until then the
// window's space can still be the one the page before showed).
// `opening`: a new tab the palette is opening (its Enter: ui/runtime.ts), while
// the tab in front is still the one it was opened from (`from`): its row at the
// top of the list, highlighted, at once (Arc), titled with what was asked for
// (`title`, `url`); the tab in front plain, "+ New Tab" not lit (seen
// 2026-11-08: it only lit partly until the page had loaded).
// `pinning`: a pin with no tab being opened (ui/intents.ts), highlighted at once and whole, as a switch's tab is.
function sidebar(state: State, windowId: number | null, currentTabId: number | null = null, { newTabPending = false, switchingTo = null, justShown = false, opening = null, pinning = null }: { newTabPending?: boolean, switchingTo?: number | string | null, justShown?: boolean, opening?: { title?: string, url?: string, from?: number | null } | null, pinning?: string | null } = {}) {
  if (typeof switchingTo === 'string') switchingTo = liveTabId(state, switchingTo) ?? switchingTo;
  const has = (id: string) => id != null && state.spaces.some((s) => s.id === id);
  const own = currentTabId != null ? state.tabs?.[currentTabId] : null;
  const going = switchingTo != null ? state.tabs?.[switchingTo as number] : null;
  const goingKept = typeof switchingTo === 'string' ? state.keptTabs?.[switchingTo] : null;
  const spaceId = going?.windowId === windowId && has(state.tabSpace?.[going.id]) ? state.tabSpace[going.id]
    : justShown && own?.windowId === windowId && !own.active && has(state.tabSpace?.[own.id]) ? state.tabSpace[own.id]
    : goingKept && has(goingKept.spaceId) ? goingKept.spaceId : activeSpaceId(state, windowId);
  const known = own?.windowId === windowId;
  // The space's tabs in every window of the profile, as one list (docs/BROWSER-WINDOWS.md §9: the tab follows the window
  // in front). Another window's tab is chosen here only when it's this window's away tab: then it's this window's
  // highlight, `away` (faded: it's live in the other window, a stand-in in front here).
  const away = state.awayByWindow?.[windowId as number] ?? null; // (no window yet: none away)
  const shown = Object.values(state.tabs ?? {})
    .filter((t) => t.windowId === windowId || state.tabSpace?.[t.id] === spaceId)
    .map((t) => {
      if (/#settings$/i.test(t.url) && isLauncherPage(t.url)) t = { ...t, title: 'Settings' };
      const active = away != null ? t.id === away : t.windowId === windowId && (known ? t.id === currentTabId : !!t.active);
      const isAway = t.id === away;
      return active === t.active && !isAway ? t : { ...t, active, ...(isAway ? { away: true } : {}) };
    });
  const target = goingKept ? switchingTo : switchingTo != null && shown.some((t) => t.id === switchingTo && !t.active) ? switchingTo : null;
  const pinFirst = target == null && pinning != null && state.pins?.some((p) => p.id === pinning && p.spaceId === spaceId) ? pinning : null;
  const front = shown.find((t) => t.active);
  const openingRow = opening && target == null && pinFirst == null && (front == null || front.id === opening.from)
    ? { id: OPENING_ID, windowId, title: String(opening.title ?? ''), url: String(opening.url ?? ''), favIconUrl: '', active: true, opening: true, status: 'loading', order: Infinity, index: Infinity, lastActive: Date.now() }
    : null;
  const shownNewTab = openingRow ? undefined : shown.find((t) => t.active && isPlaceholderPage(t.url));
  const windowTabs = shown
    .map((t) => {
      if (openingRow || pinFirst != null) return t.active ? { ...t, active: false } : t;
      // Switching: the highlight moves at once and whole (Arc), the tab still
      // on screen plain; the new page's sidebar then looks the same.
      if (target != null) return t.id === target ? { ...t, active: true } : t.active ? { ...t, active: false } : t;
      return newTabPending && t.active ? { ...t, active: false, behind: true } : t;
    })
    .sort(byPlace);
  const spaceTabs = windowTabs.filter((t) => state.tabSpace[t.id] === spaceId);
  if (openingRow) spaceTabs.push((openingRow as any));
  // The space's Margin tabs with no browser tab (state/model.ts keptTabs):
  // shown in every window showing the space, not open (`kept`), in their place.
  const kept = Object.values(state.keptTabs ?? {}).filter((k) => k.spaceId === spaceId).map((k) => ({ ...k, kept: true, active: k.id === target }));
  const folders = (state.folders ?? []).filter((f) => f.spaceId === spaceId);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderIds = new Set(folders.map((f) => f.id));
  const parentOfFolder = (f: { id: string, parentId?: string }) => {
    if (!f.parentId || f.parentId === f.id || !folderIds.has(f.parentId)) return null;
    const seen = new Set<string>([f.id]);
    let cur = folderById.get(f.parentId);
    while (cur) {
      if (seen.has(cur.id)) return null;
      seen.add(cur.id);
      cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
    }
    return f.parentId;
  };
  // Favorites in the active scope (global across Spaces by default, or scoped per profile):
  // bound to live tabs via `favoriteId` first (surviving sub-navigation), else URL match.
  const favScope = favoriteScopeOf(state, spaceId);
  const allOpenTabs = shown;
  const allKeptTabs = Object.values(state.keptTabs ?? {});
  type ShownFavorite = Favorite & {
    pos: number, tabId: number | null, active: boolean, behind: boolean, away: boolean,
    drifted: boolean, rootUrl: string, favIconUrl: string,
  };
  const boundFavTabIds = new Set<number>();
  const boundFavKeptIds = new Set<string>();
  // The tabs by what binds them, each list in the tabs' order: worked out once, not once per favorite or pin.
  const group = <T, K>(list: T[], keyOf: (t: T) => K | null | undefined) => {
    const out = new Map<K, T[]>();
    for (const t of list) { const k = keyOf(t); if (k == null) continue; const at = out.get(k); if (at) at.push(t); else out.set(k, [t]); }
    return out;
  };
  const favs = state.favorites ?? [];
  const openByFavorite = favs.length ? group(allOpenTabs, (t) => t.favoriteId) : new Map();
  const openByUrl = favs.length ? group(allOpenTabs, (t) => (!t.favoriteId && !t.pinnedBy ? normalizeUrl(t.url) : null)) : new Map();
  const keptByFavorite = favs.length ? group(allKeptTabs, (k) => k.favoriteId) : new Map();
  const favorites: ShownFavorite[] = favs
    .filter((f) => (f.scope || 'global') === favScope)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => posOf(a.f, a.i) - posOf(b.f, b.i))
    .map(({ f, i }) => {
      const key = normalizeUrl(f.url);
      const sticky = openByFavorite.get(f.id) ?? [];
      const matches: typeof allOpenTabs = sticky.length ? sticky : openByUrl.get(key) ?? [];
      const tab = matches.find((t) => t.active) ?? matches.find((t) => t.behind) ?? matches.find((t) => t.windowId === windowId) ?? matches[0];
      if (tab?.id != null) boundFavTabIds.add(tab.id);
      for (const k of keptByFavorite.get(f.id) ?? []) boundFavKeptIds.add(k.id);
      const drifted = Boolean(tab && normalizeUrl(tab.url) !== key);
      return {
        ...f,
        url: tab?.url || f.url,
        pos: posOf(f, i),
        tabId: tab?.id ?? null,
        active: !!tab?.active || !!(goingKept && (goingKept.favoriteId === f.id || normalizeUrl(goingKept.url) === key)),
        behind: !!tab?.behind,
        away: !!tab?.away,
        drifted,
        rootUrl: f.url,
        favIconUrl: tab?.favIconUrl ?? '',
      };
    });
  const favUrls = new Set(favorites.map((f) => normalizeUrl(f.rootUrl)));

  // A pin as shown: in its folder (if that's still there), bound to the tab it's open in, if any.
  // Sticky pin binding: match tabs with `pinnedBy === p.id` first (even if navigated away from root URL),
  // falling back to URL match for tabs not bound to another pin.
  type ShownPin = Omit<Pin, 'folderId'> & {
    folderId: string | null, pos: number, tabId: number | null, active: boolean, behind: boolean, away: boolean,
    drifted: boolean, rootUrl: string, favIconUrl: string,
  };
  const bound = new Map<string, ShownPin>(); // pin id → the pin as shown
  const boundTabIds = new Set<number>(boundFavTabIds);
  const boundKeptIds = new Set<string>(boundFavKeptIds);
  const spaceByPin = group(spaceTabs, (t) => t.pinnedBy);
  const spaceByUrl = group(spaceTabs, (t) => (!t.pinnedBy && !t.favoriteId ? normalizeUrl(t.url) : null));
  const keptByPin = group(kept, (k) => k.pinnedBy);
  state.pins.forEach((p, i) => {
    if (p.spaceId !== spaceId) return;
    const key = normalizeUrl(p.url);
    const sticky = spaceByPin.get(p.id) ?? [];
    const matches = sticky.length ? sticky : spaceByUrl.get(key) ?? [];
    const tab = matches.find((t) => t.active) ?? matches.find((t) => t.behind) ?? matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (tab?.id != null) boundTabIds.add(tab.id);
    for (const k of keptByPin.get(p.id) ?? []) boundKeptIds.add(k.id);
    const drifted = Boolean(tab && normalizeUrl(tab.url) !== key);
    bound.set(p.id, {
      ...p,
      url: tab?.url || p.url,
      folderId: p.folderId && folderIds.has(p.folderId) ? p.folderId : null, // its folder gone: loose
      pos: posOf(p, i),
      tabId: tab?.id ?? null,
      active: pinFirst != null ? p.id === pinFirst : !!tab?.active || !!(goingKept && (goingKept.pinnedBy === p.id || normalizeUrl(goingKept.url) === key)),
      behind: !!tab?.behind,
      away: !!tab?.away,
      drifted,
      rootUrl: p.url,
      favIconUrl: tab?.favIconUrl ?? '',
    });
  });
  const byPos = (a: { pos: number }, b: { pos: number }) => a.pos - b.pos;
  // Build nested folder tree + pre-order flattened rows (`pinnedFlat`) with depth (0..3).
  type ShownPinItem = { kind: 'pin', depth: number } & ShownPin;
  type ShownFolder = {
    kind: 'folder', id: string, name: string, open: boolean, pos: number,
    parentFolderId: string | null, depth: number, pins: ShownPin[], peek: ShownPin[],
    shownFlat?: (ShownFolder | ShownPinItem)[],
  };
  type TreeFolder = ShownFolder & { allPins: ShownPin[], children: (TreeFolder | ShownPinItem)[] };
  const buildLevel = (parentId: string | null, depth: number): (TreeFolder | ShownPinItem)[] => {
    const childFolders: TreeFolder[] = folders
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => parentOfFolder(f) === parentId)
      .map(({ f, i }) => {
        const directPins = [...bound.values()].filter((p) => p.folderId === f.id).sort(byPos);
        const children = buildLevel(f.id, depth + 1);
        const allPins: ShownPin[] = children.flatMap((c) => (c.kind === 'folder' ? c.allPins : [c]));
        const peek = f.open === false ? allPins.filter((p) => p.active || p.behind) : [];
        return {
          kind: 'folder' as const,
          id: f.id,
          name: f.name,
          open: f.open !== false,
          pos: posOf(f, i),
          parentFolderId: parentId,
          depth,
          pins: directPins,
          allPins,
          children,
          peek,
        };
      });
    const directPins: ShownPinItem[] = [...bound.values()].filter((p) => p.folderId === parentId).map((p) => ({ kind: 'pin' as const, depth, ...p }));
    return [...childFolders, ...directPins].sort(byPos);
  };
  const tree = buildLevel(null, 0);
  // Pre-order flat list for nested folder rendering (respecting collapsed ancestors + active peek).
  const pinnedFlat: (ShownFolder | ShownPinItem)[] = [];
  const flatten = (nodes: (TreeFolder | ShownPinItem)[], visible: boolean, out: (ShownFolder | ShownPinItem)[]) => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        const row: ShownFolder = { kind: 'folder', id: n.id, name: n.name, open: n.open, pos: n.pos, parentFolderId: n.parentFolderId, depth: n.depth, pins: n.allPins, peek: n.peek };
        if (visible) out.push(row);
        flatten(n.children, visible && n.open, out);
        if (visible && !n.open && n.peek.length) {
          for (const p of n.peek) out.push({ kind: 'pin', depth: n.depth + 1, ...p });
        }
      } else if (visible) {
        out.push(n);
      }
    }
  };
  flatten(tree, true, pinnedFlat);
  // Top-level `pinned` stays compatible with card-grouped themes (liquid-glass, neubrutalism, pixel),
  // with `shownFlat` exposing each top-level folder's visible descendants (subfolders + pins up to depth 4).
  const pinned: (ShownFolder | ShownPinItem)[] = tree.map((item) => {
    if (item.kind !== 'folder') return item;
    const sub: (ShownFolder | ShownPinItem)[] = [];
    if (item.open) flatten(item.children, true, sub);
    else for (const p of item.peek) sub.push({ kind: 'pin', depth: item.depth + 1, ...p });
    return { kind: 'folder' as const, id: item.id, name: item.name, open: item.open, pos: item.pos, parentFolderId: item.parentFolderId, depth: item.depth, pins: item.allPins, peek: item.peek, shownFlat: sub };
  });
  // Every pin of the space, flat, in the order shown.
  const pins = pinned.flatMap((item) => (item.kind === 'folder' ? item.pins : [item]));
  const pinnedUrls = new Set(pins.map((p) => normalizeUrl(p.rootUrl)));
  // Switching to a new-tab page: it's the "+ New Tab" row, as once it's shown.
  const targetIsNewTab = target != null && isNewTabPage(shown.find((t) => t.id === target)?.url);
  return {
    spaceId,
    spaces: state.spaces,
    favorites,
    pins,
    pinned,
    pinnedFlat,
    // The new-tab page being shown is this row: softly while switching away.
    newTab: { active: targetIsNewTab || (target == null && pinFirst == null && !openingRow && (newTabPending || !!shownNewTab)), behind: false }, // behind: never now (kept for the row's class)
    // Reversed here, not sorted that way above: a pin binds to the oldest tab
    // with its URL (unless another is shown or being switched to). Open and
    // not open, in their places (sticky-bound tabs stay attached to their pin/favorite even after navigating away).
    tabs: [...spaceTabs, ...kept].sort(byPlace).filter((t: any) => {
      if (isPlaceholderPage(t.url)) return false;
      if (!t.kept && boundTabIds.has(t.id)) return false;
      if (t.kept && boundKeptIds.has(t.id)) return false;
      if (!t.pinnedBy && !t.favoriteId && (pinnedUrls.has(normalizeUrl(t.url)) || favUrls.has(normalizeUrl(t.url)))) return false;
      return true;
    }).reverse(),
  };
}

// The tab a favorite opens: one bound via `favoriteId` first, else URL match, in this window first.
function favoriteTabId(state: State, favoriteId: string, windowId: number) {
  const fav = (state.favorites ?? []).find((f) => f.id === favoriteId);
  if (!fav) return null;
  const sticky = Object.values(state.tabs ?? {}).filter((t) => t.favoriteId === favoriteId);
  if (sticky.length) return (sticky.find((t) => t.windowId === windowId) ?? sticky[0])?.id ?? null;
  const key = normalizeUrl(fav.url);
  const matches = Object.values(state.tabs ?? {}).filter((t) => !t.favoriteId && !t.pinnedBy && normalizeUrl(t.url) === key);
  return (matches.find((t) => t.windowId === windowId) ?? matches[0])?.id ?? null;
}

// A tab's place in the list (state/model.ts "places in the list"): its Margin
// tab's `order`, else (a record from before) its place in its window.
const placeOf = (t: { order?: number, index?: number } | null | undefined): number => (Number.isFinite(t?.order) ? t!.order! : Number(t?.index) || 0);
const byPlace = (a: { order?: number, index?: number }, b: { order?: number, index?: number }) => placeOf(a) - placeOf(b) || (Number(a.index) || 0) - (Number(b.index) || 0);

// The tab a pin opens: one bound via `pinnedBy` first, else one of its space with its URL,
// in this window first (as the background's openPin), or null (the pin opens a new tab).
function pinTabId(state: State, pinId: string, windowId: number) {
  const pin = state.pins?.find((p) => p.id === pinId);
  if (!pin) return null;
  const sticky = Object.values(state.tabs ?? {}).filter((t) => t.pinnedBy === pinId && state.tabSpace?.[t.id] === pin.spaceId);
  if (sticky.length) return (sticky.find((t) => t.windowId === windowId) ?? sticky[0])?.id ?? null;
  const key = normalizeUrl(pin.url);
  const matches = Object.values(state.tabs ?? {}).filter((t) => normalizeUrl(t.url) === key && state.tabSpace?.[t.id] === pin.spaceId && !boundElsewhere(state, t, pin.spaceId, { pinId }));
  return (matches.find((t) => t.windowId === windowId) ?? matches[0])?.id ?? null;
}

// The browser's new-tab page, which Margin replaces (⌘T): Chrome reports it
// as chrome://newtab, Safari as Margin's own page. Not Margin's start page
// opened on purpose (#launcher).
// The row of a tab being opened (sidebar `opening`): not a tab of the browser's yet.
const OPENING_ID = 'opening';
const NEW_TAB_PAGE = /^(chrome:\/\/newtab\/?|[a-z-]+-extension:\/\/[^/]+\/newtab\/newtab\.html)(\?[^#]*)?$/i;
const isNewTabPage = (url: unknown) => NEW_TAB_PAGE.test(String(url ?? ''));
// What the launcher is drawn over (ui/host-app.ts, the sidebar's New Tab row): the browser's new-tab page, and
// Margin's start page opened on purpose (#launcher, #settings: the archive button, a link to it), which isn't a new
// tab to hand off (isNewTabPage, the background's) but is drawn the same (issue #19).
const LAUNCHER_PAGE = /^(chrome:\/\/newtab\/?|[a-z-]+-extension:\/\/[^/]+\/newtab\/newtab\.html)(\?[^#]*)?(#(launcher|settings))?$/i;
const isLauncherPage = (url: unknown) => LAUNCHER_PAGE.test(String(url ?? ''));

// Best guess at the window a page is in, before the background has told the
// content script its tab id (that needs the background awake, which can
// take a while in Safari). Single window → that one; otherwise a tab with
// this URL, preferring active and most recently used.
function guessWindow(state: State, url: string) {
  const tabs = Object.values(state.tabs ?? {});
  const windows = new Set(tabs.map((t) => t.windowId));
  if (windows.size <= 1) return tabs[0]?.windowId ?? null;
  const byUrl = tabs.filter((t) => t.url === url);
  const pool = byUrl.length ? byUrl : tabs.filter((t) => t.active);
  pool.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastActive ?? 0) - (a.lastActive ?? 0));
  return pool[0]?.windowId ?? null;
}

// How close to the left edge (px) the cursor must be to reveal the sidebar.
// In a full-screen window Safari reveals its *own* sidebar when the cursor
// rests at the very edge, and extensions can't turn that off, so Margin
// opens from further out there and the cursor rarely needs to reach it.
const EDGE_PX = 10;
const FULLSCREEN_EDGE_PX = 24;
function revealZone({ outerWidth, outerHeight, screenWidth, screenHeight }: { outerWidth: any; outerHeight: any; screenWidth: any; screenHeight: any; }) {
  const fullScreen = outerWidth >= screenWidth && outerHeight >= screenHeight;
  return fullScreen ? FULLSCREEN_EDGE_PX : EDGE_PX;
}

// ⌘⌥↓ / ⌘⌥↑: the next/previous tab in the order the sidebar shows them
// (open/saved pinned tabs in the rows shown, then the space's open and saved tabs), wrapping around. From a tab
// that isn't in the list, ↓ goes to the first and ↑ to the last. null if
// there's nowhere to go.
function cycleTab(state: State, windowId: number, currentTabId: number | string | null, dir: number) {
  const resolved = currentTabId == null ? null : liveTabId(state, currentTabId) ?? currentTabId;
  const v = sidebar(state, windowId, typeof resolved === 'number' ? resolved : null, { switchingTo: typeof resolved === 'string' ? resolved : null });
  currentTabId = resolved;
  // The rows shown: a closed folder's pins only while one is the tab shown.
  const rows = v.pinned.flatMap((item) => (item.kind !== 'folder' ? [item] : item.open ? item.pins : item.peek));
  // The actual rows, including saved tabs: only the chosen missing tab is reopened.
  const keptByUrl = new Map(Object.values(state.keptTabs ?? {}).filter((k) => k.spaceId === v.spaceId).map((k) => [normalizeUrl(k.url), k.id]));
  const pins = rows.map((p) => p.tabId ?? keptByUrl.get(normalizeUrl(p.url))).filter((id): id is number | string => id != null);
  const order: (number | string)[] = [...pins, ...v.tabs.map((t) => t.id)];
  if (!order.length) return null;
  const at = order.indexOf(currentTabId as number | string); // (no tab: -1)
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  const next = order[(at + dir + order.length) % order.length];
  return next === currentTabId ? null : next;
}

function liveTabId(state: State, id: number | string) {
  if (typeof id === 'number') return state.tabs[id]?.id;
  return state.keptTabs?.[id] ? undefined : Object.values(state.tabs).find((t) => t.mid === id)?.id;
}

// Browser-only anchors do not belong in the list of the person's tabs. Settings does.
function isPlaceholderPage(url: string | null | undefined) {
  return isLauncherPage(url) && !/#settings$/i.test(String(url));
}

// ⌘⌥→ / ⌘⌥←: the next/previous space for this window, wrapping around;
// `from`: the space to count from (a chain of presses: background/navigation.ts),
// else the window's.
function cycleSpace(state: State, windowId: number, dir: number, from: string | null = null) {
  if (state.spaces.length < 2) return null;
  const base = from != null && state.spaces.some((s) => s.id === from) ? from : activeSpaceId(state, windowId);
  const at = state.spaces.findIndex((s) => s.id === base);
  return state.spaces[(at + dir + state.spaces.length) % state.spaces.length].id;
}

// ---- favicons ---------------------------------------------------------------
// Safari never gives extensions tab.favIconUrl. Each page reports its own
// icon link, the background fetches it once per site and stores it as a
// data: URL in state.favicons[origin] (see background.ts pageIcon).

function originOf(url: string | null | undefined) {
  try {
    const u = new URL(url as string); // (none: it throws, and that's caught)
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// Best icon among a page's <link rel=…icon…> elements ({rel, href, sizes,
// type}): a scalable or ~16–64px "icon" first, then any "icon", then
// apple-touch-icon, else /favicon.ico. Returns an absolute http(s) or
// data:image URL, or null for non-web pages.
function pickIconHref(links: { rel: string; href: string; sizes?: string; type?: string; }[], pageUrl: string) {
  const origin = originOf(pageUrl);
  if (!origin) return null;
  const usable = (href: string) => /^https?:/i.test(href ?? '') || /^data:image\//i.test(href ?? '');
  const score = (l: { rel: string; href: string; sizes?: string; type?: string; }) => {
    const rel = (l.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) return -1;
    if (!usable(l.href)) return -1;
    if (!rel.includes('icon')) return 1; // apple-touch-icon: large, last resort
    const sizes = (l.sizes ?? '').toLowerCase();
    if ((l.type ?? '').includes('svg') || sizes === 'any') return 5;
    const px = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map((m) => Number(m[1])));
    if (px >= 16 && px <= 64) return 4;
    return px ? 2 : 3;
  };
  const best = links.map((l) => ({ l, s: score(l) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
  return best ? best.l.href : `${origin}/favicon.ico`;
}

// What to show for a tab/pin/archive entry: an app item's (Margin.app: its
// address app://<bundle id>) the installed app's icon, as the app listed it
// (the state's `apps`: shared/apps.ts); else the browser's icon if it gave
// one (Chrome does), else the icon Margin fetched for that site.
// Margin's own Settings page (Margin.app's Settings tab, margin://settings): a gear, as macOS's System Settings.
const SETTINGS_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNy41IiBmaWxsPSIjOGU4ZTkzIi8+PHBvbHlnb24gcG9pbnRzPSIxMy4xMCw3LjU4IDEzLjc5LDQuNjEgMTguMjEsNC42MSAxOC45MCw3LjU4IDE5LjkwLDguMDAgMjIuNDksNi4zOCAyNS42Miw5LjUxIDI0LjAwLDEyLjEwIDI0LjQyLDEzLjEwIDI3LjM5LDEzLjc5IDI3LjM5LDE4LjIxIDI0LjQyLDE4LjkwIDI0LjAwLDE5LjkwIDI1LjYyLDIyLjQ5IDIyLjQ5LDI1LjYyIDE5LjkwLDI0LjAwIDE4LjkwLDI0LjQyIDE4LjIxLDI3LjM5IDEzLjc5LDI3LjM5IDEzLjEwLDI0LjQyIDEyLjEwLDI0LjAwIDkuNTEsMjUuNjIgNi4zOCwyMi40OSA4LjAwLDE5LjkwIDcuNTgsMTguOTAgNC42MSwxOC4yMSA0LjYxLDEzLjc5IDcuNTgsMTMuMTAgOC4wMCwxMi4xMCA2LjM4LDkuNTEgOS41MSw2LjM4IDEyLjEwLDguMDAiIGZpbGw9IiNmZmYiLz48Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIzLjQiIGZpbGw9IiM4ZThlOTMiLz48L3N2Zz4=';
const isSettingsPage = (url: unknown) => typeof url === 'string' && /^margin:\/\/settings\/?$/i.test(url);

function iconFor(state: State, item: { url?: string, favIconUrl?: string, target?: unknown } | null | undefined) {
  if (isSettingsPage(item?.url)) return SETTINGS_ICON;
  const app = appOfItem(item);
  if (app) return appIcon((state as { apps?: InstalledApp[] | null } | null)?.apps, app) ?? '';
  if (/^(https?|data):/.test(item?.favIconUrl ?? '')) return item!.favIconUrl!; // (an icon matched: it's there)
  const origin = originOf(item?.url);
  return (origin && state?.favicons?.[origin]?.data) || '';
}

// A letter avatar, for a row with no icon: the first letter of its site
// (else its title), on a color worked out from the same text, so a site
// keeps its color everywhere (Arcadia's sidebar and palette, and the theme
// view model: ui/view-model.ts).
function hue(text: string) {
  let h = 0;
  // (`ch` is one character: its code point is there.)
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
function letterAvatar(label: string): { letter: string, color: string } {
  const text = label || '?';
  return { letter: text.charAt(0).toUpperCase(), color: `hsl(${hue(text)} 55% 48%)` };
}


export { normalizeUrl, activeSpaceId, sidebar, pinTabId, favoriteTabId, isNewTabPage, isLauncherPage, isPlaceholderPage, liveTabId, guessWindow, revealZone, cycleTab, cycleSpace, originOf, pickIconHref, iconFor, hue, letterAvatar };
