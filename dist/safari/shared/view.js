// Pure view derivation shared by the content script and the new-tab page.
// No browser APIs: also importable from node for tests.
/** @import { State } from '../../types/margin' */

// A pin's or folder's order (state/model.js): saved, or its place in the list.
const posOf = (item, i) => (Number.isFinite(item?.pos) ? item.pos : i);

// Keep in sync with state/model.js normalizeUrl.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url ?? '';
  }
}

/** @param {State} state */
function activeSpaceId(state, windowId) {
  const id = state.activeSpaceByWindow?.[windowId];
  return state.spaces.some((s) => s.id === id) ? id : state.spaces[0].id;
}

// What the sidebar shows for one window. `currentTabId` is the tab the
// sidebar is drawn in: the page being looked at is by definition the active
// tab of its window, so it wins over a possibly stale `active` flag.
/** @param {State} state */
// Tabs newest first (Arc), below the pins and the "+ New Tab" row: the
// browser's own order, reversed (a new tab goes at its end). "+ New Tab" is
// highlighted while a new tab is being chosen (`newTabPending`: the palette
// opened by ⌘T or the row), the tab being shown then only softly (`behind`:
// its page is still on screen, under the palette); or when the tab being
// shown is a new-tab page (then it's that row instead of a row of its own).
// `switchingTo`: a tab being switched to (shared/switching.js), highlighted
// already (the shown one plain, as Arc) until the switch lands; it wins over
// `newTabPending` (the palette chose a tab).
// The space shown is the window's, except: while switching to a tab of
// another space (the palette), that tab's, at once (Arc); and, for a page
// just shown (`justShown`, from content/core.js), its own tab's while the
// state doesn't say yet that it's in front (the background records an
// activation a moment after the browser shows the tab: until then the
// window's space can still be the one the page before showed).
function sidebar(state, windowId, currentTabId = null, { newTabPending = false, switchingTo = null, justShown = false } = {}) {
  const has = (id) => id != null && state.spaces.some((s) => s.id === id);
  const own = currentTabId != null ? state.tabs?.[currentTabId] : null;
  const going = switchingTo != null ? state.tabs?.[switchingTo] : null;
  const spaceId = going?.windowId === windowId && has(state.tabSpace?.[going.id]) ? state.tabSpace[going.id]
    : justShown && own?.windowId === windowId && !own.active && has(state.tabSpace?.[own.id]) ? state.tabSpace[own.id]
    : activeSpaceId(state, windowId);
  const known = own?.windowId === windowId;
  const shown = Object.values(state.tabs ?? {})
    .filter((t) => t.windowId === windowId)
    .map((t) => (known && t.active !== (t.id === currentTabId) ? { ...t, active: t.id === currentTabId } : t));
  const target = switchingTo != null && shown.some((t) => t.id === switchingTo && !t.active) ? switchingTo : null;
  const shownNewTab = shown.find((t) => t.active && isNewTabPage(t.url));
  const windowTabs = shown
    .map((t) => {
      // Switching: the highlight moves at once and whole (Arc), the tab still
      // on screen plain; the new page's sidebar then looks the same.
      if (target != null) return t.id === target ? { ...t, active: true } : t.active ? { ...t, active: false } : t;
      return newTabPending && t.active ? { ...t, active: false, behind: true } : t;
    })
    .sort((a, b) => a.index - b.index);
  const spaceTabs = windowTabs.filter((t) => state.tabSpace[t.id] === spaceId);
  const folders = (state.folders ?? []).filter((f) => f.spaceId === spaceId);
  const folderIds = new Set(folders.map((f) => f.id));
  const bound = new Map(); // pin id → the pin as shown
  state.pins.forEach((p, i) => {
    if (p.spaceId !== spaceId) return;
    const key = normalizeUrl(p.url);
    // Open in more than one tab: the one shown or being switched to.
    const matches = spaceTabs.filter((t) => normalizeUrl(t.url) === key);
    const tab = matches.find((t) => t.active) ?? matches.find((t) => t.behind) ?? matches[0];
    bound.set(p.id, {
      ...p,
      folderId: p.folderId && folderIds.has(p.folderId) ? p.folderId : null, // its folder gone: loose
      pos: posOf(p, i),
      tabId: tab?.id ?? null, active: !!tab?.active, behind: !!tab?.behind, favIconUrl: tab?.favIconUrl ?? '',
    });
  });
  const byPos = (a, b) => a.pos - b.pos;
  const loose = [...bound.values()].filter((p) => !p.folderId);
  // The pinned area, in order (state/model.js pinOrder): folders, with their
  // pins, and the pins in none. A closed folder still shows the pin of the
  // tab shown or being switched to (`peek`), so the highlight stays visible.
  const pinned = [
    ...folders.map((f, i) => {
      const inside = [...bound.values()].filter((p) => p.folderId === f.id).sort(byPos);
      return { kind: 'folder', id: f.id, name: f.name, open: f.open !== false, pos: posOf(f, i), pins: inside, peek: f.open === false ? inside.filter((p) => p.active || p.behind) : [] };
    }),
    ...loose.map((p) => ({ kind: 'pin', ...p })),
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
    newTab: { active: targetIsNewTab || (target == null && (newTabPending || !!shownNewTab)), behind: false }, // behind: never now (kept for the row's class)
    // Reversed here, not sorted that way above: a pin binds to the oldest tab
    // with its URL (unless another is shown or being switched to).
    tabs: spaceTabs.filter((t) => !pinnedUrls.has(normalizeUrl(t.url)) && t.id !== shownNewTab?.id && !(targetIsNewTab && t.id === target)).reverse(),
  };
}

// The tab a pin opens: one of its space with its URL, in this window first
// (as the background's openPin), or null (the pin opens a new tab).
/** @param {State} state */
function pinTabId(state, pinId, windowId) {
  const pin = state.pins?.find((p) => p.id === pinId);
  if (!pin) return null;
  const key = normalizeUrl(pin.url);
  const matches = Object.values(state.tabs ?? {}).filter((t) => normalizeUrl(t.url) === key && state.tabSpace?.[t.id] === pin.spaceId);
  return (matches.find((t) => t.windowId === windowId) ?? matches[0])?.id ?? null;
}

// The browser's new-tab page, which Margin replaces (⌘T): Chrome reports it
// as chrome://newtab, Safari as Margin's own page. Not Margin's start page
// opened on purpose (#launcher).
const NEW_TAB_PAGE = /^(chrome:\/\/newtab\/?|[a-z-]+-extension:\/\/[^/]+\/newtab\/newtab\.html)(\?[^#]*)?$/i;
const isNewTabPage = (url) => NEW_TAB_PAGE.test(String(url ?? ''));

// Best guess at the window a page is in, before the background has told the
// content script its tab id (that needs the background awake, which can
// take a while in Safari). Single window → that one; otherwise a tab with
// this URL, preferring active and most recently used.
/** @param {State} state */
function guessWindow(state, url) {
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
function revealZone({ outerWidth, outerHeight, screenWidth, screenHeight }) {
  const fullScreen = outerWidth >= screenWidth && outerHeight >= screenHeight;
  return fullScreen ? FULLSCREEN_EDGE_PX : EDGE_PX;
}

// ⌘⌥↓ / ⌘⌥↑: the next/previous tab in the order the sidebar shows them
// (open pinned tabs in the rows shown, then the space's tabs), wrapping around. From a tab
// that isn't in the list, ↓ goes to the first and ↑ to the last. null if
// there's nowhere to go.
/** @param {State} state */
function cycleTab(state, windowId, currentTabId, dir) {
  const v = sidebar(state, windowId, currentTabId);
  // The rows shown: a closed folder's pins only while one is the tab shown.
  const rows = v.pinned.flatMap((item) => (item.kind !== 'folder' ? [item] : item.open ? item.pins : item.peek));
  const order = [...rows.filter((p) => p.tabId != null).map((p) => p.tabId), ...v.tabs.map((t) => t.id)];
  if (!order.length) return null;
  const at = order.indexOf(currentTabId);
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  const next = order[(at + dir + order.length) % order.length];
  return next === currentTabId ? null : next;
}

// ⌘⌥→ / ⌘⌥←: the next/previous space for this window, wrapping around.
/** @param {State} state */
function cycleSpace(state, windowId, dir) {
  if (state.spaces.length < 2) return null;
  const at = state.spaces.findIndex((s) => s.id === activeSpaceId(state, windowId));
  return state.spaces[(at + dir + state.spaces.length) % state.spaces.length].id;
}

// ---- favicons ---------------------------------------------------------------
// Safari never gives extensions tab.favIconUrl. Each page reports its own
// icon link, the background fetches it once per site and stores it as a
// data: URL in state.favicons[origin] (see background.js pageIcon).

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// Best icon among a page's <link rel=…icon…> elements ({rel, href, sizes,
// type}): a scalable or ~16–64px "icon" first, then any "icon", then
// apple-touch-icon, else /favicon.ico. Returns an absolute http(s) or
// data:image URL, or null for non-web pages.
function pickIconHref(links, pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return null;
  const usable = (href) => /^https?:/i.test(href ?? '') || /^data:image\//i.test(href ?? '');
  const score = (l) => {
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
/** @param {State} state */
function iconFor(state, item) {
  if (/^(https?|data):/.test(item?.favIconUrl ?? '')) return item.favIconUrl;
  const origin = originOf(item?.url);
  return (origin && state?.favicons?.[origin]?.data) || '';
}

// A letter avatar, for a row with no icon: the first letter of its site
// (else its title), on a color worked out from the same text, so a site
// keeps its color everywhere (Arcadia's sidebar and palette, and the theme
// view model: ui/view-model.js).
/** @param {string} text */
function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
/** @param {string} label @returns {{ letter: string, color: string }} */
function letterAvatar(label) {
  const text = label || '?';
  return { letter: text.charAt(0).toUpperCase(), color: `hsl(${hue(text)} 55% 48%)` };
}

// How long keep-ready keeps the tab just left ready (minutes; 0: off), from
// the settings as stored. Settings saved by a build before 2026-11-03 have
// only `keepTabsReadyMinutes` (up to six tabs, until that long after Safari
// was last used): it doesn't carry over, not even as off. It measured
// something else, and turning it off was a way out of what it cost (Tirth
// did, to save his battery), which the tab just left alone doesn't: the
// default, 1, until a value is saved. Pages read the settings as stored, so
// they need this too (state/model.js gives the default the same way).
function keepReadyMinutes(settings) {
  if (!settings || !('keepLeftTabReadyMinutes' in settings)) return 1;
  const minutes = Number(settings.keepLeftTabReadyMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

// How many tabs the warm-up after a relaunch loads (settings.warmUpTabs:
// background/warm-up.js), 0 (off) to WARM_UP_MAX; 6 for settings from before it.
const WARM_UP_MAX = 12;
function warmUpCount(settings) {
  if (!settings || !('warmUpTabs' in settings)) return 6;
  const count = Number(settings.warmUpTabs);
  return Number.isFinite(count) && count > 0 ? Math.min(Math.round(count), WARM_UP_MAX) : 0;
}

export { normalizeUrl, activeSpaceId, sidebar, pinTabId, isNewTabPage, guessWindow, revealZone, cycleTab, cycleSpace, originOf, pickIconHref, iconFor, hue, letterAvatar, keepReadyMinutes, warmUpCount, WARM_UP_MAX };
