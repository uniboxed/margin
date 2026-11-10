// Pure view derivation shared by the content script and the new-tab page.
// No browser APIs: also importable from node for tests.
import type { Pin, State } from '../../types/margin';

// A pin's or folder's order (state/model.ts): saved, or its place in the list.
const posOf = (item: { pos?: number } | null | undefined, i: number): number => (Number.isFinite(item?.pos) ? item!.pos! : i);

// Keep in sync with state/model.ts normalizeUrl.
function normalizeUrl(url: string | null | undefined) {
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
// browser's own order, reversed (a new tab goes at its end). "+ New Tab" is
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
function sidebar(state: State, windowId: number | null, currentTabId: number | null = null, { newTabPending = false, switchingTo = null, justShown = false, opening = null }: { newTabPending?: boolean, switchingTo?: number | null, justShown?: boolean, opening?: { title?: string, url?: string, from?: number | null } | null } = {}) {
  const has = (id: string) => id != null && state.spaces.some((s) => s.id === id);
  const own = currentTabId != null ? state.tabs?.[currentTabId] : null;
  const going = switchingTo != null ? state.tabs?.[switchingTo] : null;
  const spaceId = going?.windowId === windowId && has(state.tabSpace?.[going.id]) ? state.tabSpace[going.id]
    : justShown && own?.windowId === windowId && !own.active && has(state.tabSpace?.[own.id]) ? state.tabSpace[own.id]
    : activeSpaceId(state, windowId);
  const known = own?.windowId === windowId;
  // The space's tabs in every window of the profile, as one list (docs/BROWSER-WINDOWS.md §9: the tab follows the window
  // in front). Another window's tab is chosen here only when it's this window's away tab: then it's this window's
  // highlight, `away` (faded: it's live in the other window, a stand-in in front here).
  const away = state.awayByWindow?.[windowId as number] ?? null; // (no window yet: none away)
  const shown = Object.values(state.tabs ?? {})
    .filter((t) => t.windowId === windowId || state.tabSpace?.[t.id] === spaceId)
    .map((t) => {
      const active = away != null ? t.id === away : t.windowId === windowId && (known ? t.id === currentTabId : !!t.active);
      const isAway = t.id === away;
      return active === t.active && !isAway ? t : { ...t, active, ...(isAway ? { away: true } : {}) };
    });
  const target = switchingTo != null && shown.some((t) => t.id === switchingTo && !t.active) ? switchingTo : null;
  const front = shown.find((t) => t.active);
  const openingRow = opening && target == null && (front == null || front.id === opening.from)
    ? { id: OPENING_ID, windowId, title: String(opening.title ?? ''), url: String(opening.url ?? ''), favIconUrl: '', active: true, opening: true, status: 'loading', order: Infinity, index: Infinity, lastActive: Date.now() }
    : null;
  const shownNewTab = openingRow ? undefined : shown.find((t) => t.active && isLauncherPage(t.url));
  const windowTabs = shown
    .map((t) => {
      if (openingRow) return t.active ? { ...t, active: false } : t;
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
  const kept = Object.values(state.keptTabs ?? {}).filter((k) => k.spaceId === spaceId).map((k) => ({ ...k, kept: true, active: false }));
  const folders = (state.folders ?? []).filter((f) => f.spaceId === spaceId);
  const folderIds = new Set(folders.map((f) => f.id));
  // A pin as shown: in its folder (if that's still there), bound to the tab it's open in, if any.
  type ShownPin = Omit<Pin, 'folderId'> & { folderId: string | null, pos: number, tabId: number | null, active: boolean, behind: boolean, away: boolean, favIconUrl: string };
  const bound = new Map<string, ShownPin>(); // pin id → the pin as shown
  state.pins.forEach((p, i) => {
    if (p.spaceId !== spaceId) return;
    const key = normalizeUrl(p.url);
    // Open in more than one tab: the one shown or being switched to, else this window's.
    const matches = spaceTabs.filter((t) => normalizeUrl(t.url) === key);
    const tab = matches.find((t) => t.active) ?? matches.find((t) => t.behind) ?? matches.find((t) => t.windowId === windowId) ?? matches[0];
    bound.set(p.id, {
      ...p,
      folderId: p.folderId && folderIds.has(p.folderId) ? p.folderId : null, // its folder gone: loose
      pos: posOf(p, i),
      tabId: tab?.id ?? null, active: !!tab?.active, behind: !!tab?.behind, away: !!tab?.away, favIconUrl: tab?.favIconUrl ?? '',
    });
  });
  const byPos = (a: { pos: number }, b: { pos: number }) => a.pos - b.pos;
  const loose = [...bound.values()].filter((p) => !p.folderId);
  // The pinned area, in order (state/model.ts pinOrder): folders, with their
  // pins, and the pins in none. A closed folder still shows the pin of the
  // tab shown or being switched to (`peek`), so the highlight stays visible.
  const pinned = [
    ...folders.map((f, i) => {
      const inside = [...bound.values()].filter((p) => p.folderId === f.id).sort(byPos);
      return { kind: 'folder' as const, id: f.id, name: f.name, open: f.open !== false, pos: posOf(f, i), pins: inside, peek: f.open === false ? inside.filter((p) => p.active || p.behind) : [] };
    }),
    ...loose.map((p) => ({ kind: 'pin' as const, ...p })),
  ].sort(byPos);
  // Every pin of the space, flat, in the order shown.
  const pins = pinned.flatMap((item) => (item.kind === 'folder' ? item.pins : [item]));
  const pinnedUrls = new Set(pins.map((p) => normalizeUrl(p.url)));
  // Switching to a new-tab page: it's the "+ New Tab" row, as once it's shown.
  const targetIsNewTab = target != null && isNewTabPage(shown.find((t) => t.id === target)?.url);
  return {
    spaceId,
    spaces: state.spaces,
    pins,
    pinned,
    // The new-tab page being shown is this row: softly while switching away.
    newTab: { active: targetIsNewTab || (target == null && !openingRow && (newTabPending || !!shownNewTab)), behind: false }, // behind: never now (kept for the row's class)
    // Reversed here, not sorted that way above: a pin binds to the oldest tab
    // with its URL (unless another is shown or being switched to). Open and
    // not open, in their places (pins bind to open tabs only).
    tabs: [...spaceTabs, ...kept].sort(byPlace).filter((t) => !pinnedUrls.has(normalizeUrl(t.url)) && t.id !== shownNewTab?.id && !(targetIsNewTab && t.id === target)).reverse(),
  };
}

// A tab's place in the list (state/model.ts "places in the list"): its Margin
// tab's `order`, else (a record from before) its place in its window.
const placeOf = (t: { order?: number, index?: number } | null | undefined): number => (Number.isFinite(t?.order) ? t!.order! : Number(t?.index) || 0);
const byPlace = (a: { order?: number, index?: number }, b: { order?: number, index?: number }) => placeOf(a) - placeOf(b) || (Number(a.index) || 0) - (Number(b.index) || 0);

// The tab a pin opens: one of its space with its URL, in this window first
// (as the background's openPin), or null (the pin opens a new tab).
function pinTabId(state: State, pinId: string, windowId: number) {
  const pin = state.pins?.find((p) => p.id === pinId);
  if (!pin) return null;
  const key = normalizeUrl(pin.url);
  const matches = Object.values(state.tabs ?? {}).filter((t) => normalizeUrl(t.url) === key && state.tabSpace?.[t.id] === pin.spaceId);
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
// (open pinned tabs in the rows shown, then the space's open tabs), wrapping around. From a tab
// that isn't in the list, ↓ goes to the first and ↑ to the last. null if
// there's nowhere to go.
function cycleTab(state: State, windowId: number, currentTabId: number | null, dir: number) {
  const v = sidebar(state, windowId, currentTabId);
  // The rows shown: a closed folder's pins only while one is the tab shown.
  const rows = v.pinned.flatMap((item) => (item.kind !== 'folder' ? [item] : item.open ? item.pins : item.peek));
  // Not tabs that aren't open (each would open as it was passed).
  // (Each a browser tab's id: a pin's with one, an open tab's; a kept tab's id is Margin's own.)
  const order = [...rows.filter((p) => p.tabId != null).map((p) => p.tabId as number), ...v.tabs.filter((t) => !t.kept).map((t) => t.id as number)];
  if (!order.length) return null;
  const at = (order as (number | null)[]).indexOf(currentTabId); // (no tab: -1)
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  const next = order[(at + dir + order.length) % order.length];
  return next === currentTabId ? null : next;
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

// What to show for a tab/pin/archive entry: the browser's icon if it gave
// one (Chrome does), else the icon Margin fetched for that site.
function iconFor(state: State, item: { url?: string, favIconUrl?: string } | null | undefined) {
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


export { normalizeUrl, activeSpaceId, sidebar, pinTabId, isNewTabPage, isLauncherPage, guessWindow, revealZone, cycleTab, cycleSpace, originOf, pickIconHref, iconFor, hue, letterAvatar };
