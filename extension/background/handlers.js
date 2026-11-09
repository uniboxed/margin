// What pages ask the background for: runtime messages { type, ...payload },
// answered { ok, result } or { ok: false, error } (background.js routes
// them). types/margin.d.ts derives the protocol's types from this object.
import { platform } from '../shared/platform.js';
import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import * as S from '../shared/search.js';
import { api, load, mutate, newId, now, thisCopy } from './store.js';
import * as onboarding from './onboarding.js';
import { focusTab, inParkedWindow, reloadCutOff, handingOff, instanceId, keepHandedOff, markMarginOpening, openBehind, openTab, openedByMargin, resolveTab } from './tabs.js';
import { sleepIdle, wakeAll, windowDrafts } from './sleep.js';
import { probeWindow, setWindowState, windowCall } from './handoff.js';
import { newTabPageSeen } from './newtab-hint.js';
import { noteReopened, ownSearchTabs, ownSearchUrls, OWN_SEARCH_MS } from './search-engine.js';
import { iconInflight, iconUrlAllowed, learnIcon, styleUrlAllowed } from './site-icons.js';
import { navigate, NAV_ACTIONS, showSpace } from './navigation.js';
import { THEMES } from '../themes/index.js';
import { isFullscreen, toggleMarginFullscreen } from './fullscreen.js';
import { getScroll, setScroll } from './scroll.js';
import { keepScroll, takeScroll } from './scroll-record.js';
import { closeTabs, noteClosing } from './closing.js';
import * as away from './away.js';
import { isAwayPage } from '../shared/away.js';
import { appLink } from './app-link.js';
import { noticeAnswered } from './notices.js';
import { isNoticeAction } from '../shared/notices.js';
import * as pageLoads from './page-loads.js';
import { moveIndex } from '../ui/behaviors/drop-rules.js';
import { MAX_SETTINGS, PACKAGE_THEMES, SETTING_NAME, USER_THEMES_KEY, USER_THEME_ID, plainSetting } from '../themes/packages.js';

// The tab a nav request is for: the one named, the page's own, or the one
// in front of the window.
async function frontTab(tabId, windowId, sender) {
  if (Number.isInteger(tabId)) return tabId;
  const win = windowId ?? sender?.tab?.windowId;
  if (win == null) return sender?.tab?.id ?? null;
  const [front] = await api.tabs.query({ active: true, windowId: win }).catch(() => []);
  return front?.id ?? null;
}

// A package theme's settings (themes/packages.js: a built-in one, or one the
// user imported), merged into what's saved: names as theme.json's, plain
// values, at most MAX_SETTINGS. The theme's spec checks each value again
// where it's applied (ui/theme-loader.js resolveSettings).
/** Is `id` one of the person's imported themes (Margin.app's index, storage.local userThemes)? @param {unknown} id */
async function userThemeListed(id) {
  if (typeof id !== 'string') return false;
  const index = (await api.storage.local.get(USER_THEMES_KEY).catch(() => ({})))?.[USER_THEMES_KEY];
  return Array.isArray(index) && index.some((e) => e?.id === id);
}

async function updatePackageThemeSettings(themeId, patch) {
  if (typeof themeId !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  if (!PACKAGE_THEMES.includes(themeId) && !(await userThemeListed(themeId))) return; // not a theme Margin has
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => SETTING_NAME.test(k) && plainSetting(v)));
  if (!Object.keys(clean).length) return;
  await mutate((s) => {
    const themes = s.settings.themes ?? {};
    const own = { ...(themes[themeId] && typeof themes[themeId] === 'object' ? themes[themeId] : {}), ...clean };
    if (Object.keys(own).length > MAX_SETTINGS) return s;
    return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
  });
}

// ⌘T: the browser opened a new tab (extensions can't stop it) with Margin's
// new-tab page. Arc keeps the page and opens its palette over it: so, while
// Margin.app is linked, the app's palette opens over the tab the user was
// on, that tab is shown again, and the new one closes. Started as soon as the tab is created when the browser
// says what it shows (background.js onCreated; Chrome does), else when the
// page asks (newTabPage): every moment the new tab is in front shows. In the
// order that shows least of it: out of the sidebar first, the palette ready
// before its page is back, no wake (it was shown a moment ago). False when
// it can't (a new window, a previous tab that isn't a web page, Margin.app
// not linked): the new-tab page stays (linked, the app's palette opens over
// it; not linked, it says the app isn't running: newtab/newtab.js).
const handOffs = new Map(); // tab id → Promise<boolean>, once per tab
let devProbing = false; // DEV-HOOK: devTabMoveProbe running
// Windows where Margin.app couldn't show the palette ⌘T was handed off to (no overlay shown there:
// its window not bound yet, or its binding just gone, before the app said it draws nothing there):
// window id → when the app said so. ⌘T there keeps Safari's new tab for PALETTE_DROPPED_MS.
const paletteDroppedAt = new Map();
const PALETTE_DROPPED_MS = 10_000;
const paletteDroppedRecently = (/** @type {number} */ windowId) => Date.now() - (paletteDroppedAt.get(windowId) ?? -Infinity) < PALETTE_DROPPED_MS;
// The app saying it draws over the window again (its `drawn`, background.js): ⌘T goes to its palette
// again, unless that came within a second of the drop (a binding that holds while its overlay can't
// show yet says drawn at once: it mustn't start the hand-off and its drop over again).
export function drawnChanged(/** @type {number} */ windowId, /** @type {boolean} */ on) {
  if (on && Date.now() - (paletteDroppedAt.get(windowId) ?? Infinity) >= 1000) paletteDroppedAt.delete(windowId);
}

// The zoom each site was last seen at, so its pages place their box at its
// size before they've asked (content/core.js); Safari
// and Chrome keep a site's zoom across its pages. Storage `pageZoom`:
// origin → [zoom, when], only sites zoomed away from the browser's default
// zoom (Chrome's setting; 100% where unknown), which is kept once as '*';
// the ZOOM_CAP most recently changed. Written only when it changes (every
// write redraws Margin's pages); one at a time.
const ZOOM_CAP = 150;
let zoomWrites = Promise.resolve();
// Pages ask for their zoom as they start, on every resize and every time
// they're shown, and it seldom changes: what's stored and each tab's default
// zoom are kept here between asks, so an unchanged zoom costs only the
// browser's answer. Forgotten when the browser says a zoom changed
// (zoomChanged), when `pageZoom` is written (zoomStored), and after
// ZOOM_KEEP_MS (on a clock that only runs forward): copies of Margin don't
// hear each other's writes. Only to tell that nothing changed: a write reads
// storage first.
const ZOOM_KEEP_MS = 60000;
const zoomClock = () => performance.now();
let storedZoom = null; // { pageZoom, at }
let zoomReads = 0; // a read that started before a write is not kept
const tabZoomBase = new Map(); // tab id → { base, at }
async function zoomBase(tabId) {
  const known = tabZoomBase.get(tabId);
  if (known && zoomClock() - known.at < ZOOM_KEEP_MS) return known.base;
  const settings = await api.tabs.getZoomSettings?.(tabId).catch(() => null);
  const base = Number.isFinite(settings?.defaultZoomFactor) && settings.defaultZoomFactor > 0 ? settings.defaultZoomFactor : 1;
  if (tabZoomBase.size > 2 * ZOOM_CAP) tabZoomBase.clear();
  tabZoomBase.set(tabId, { base, at: zoomClock() });
  return base;
}
async function readStoredZoom() {
  if (storedZoom && zoomClock() - storedZoom.at < ZOOM_KEEP_MS) return storedZoom.pageZoom;
  const reads = zoomReads;
  const { pageZoom = {} } = await api.storage.local.get('pageZoom');
  if (reads === zoomReads) storedZoom = { pageZoom, at: zoomClock() };
  return pageZoom;
}
// background.js: tabs.onZoomChange (a tab's zoom changed, or the browser's
// default, which every tab's answer gives) and storage.onChanged with
// `pageZoom` (written here, or cleared).
export const zoomChanged = () => tabZoomBase.clear();
export function zoomStored() {
  zoomReads++;
  storedZoom = null;
}
function rememberZoom(tab, url, zoom) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (!Number.isFinite(zoom) || zoom <= 0 || origin === 'null') return;
  zoomWrites = zoomWrites.then(async () => {
    const base = await zoomBase(tab.id);
    const unchanged = (stored) => ((stored[origin] ?? stored['*'])?.[0] ?? 1) === zoom && (stored['*']?.[0] ?? 1) === base;
    if (unchanged(await readStoredZoom())) return;
    // A write is built from what's stored now, not what's kept: another
    // copy's writes reach storage, never this copy's events, and would be lost.
    zoomStored();
    const pageZoom = await readStoredZoom();
    if (unchanged(pageZoom)) return;
    const next = { ...pageZoom };
    if (base === 1) delete next['*'];
    else next['*'] = [base, Date.now()];
    if (zoom === base) delete next[origin];
    else next[origin] = [zoom, Date.now()];
    const sites = Object.keys(next).filter((key) => key !== '*');
    if (sites.length > ZOOM_CAP) {
      sites.sort((a, b) => next[a][1] - next[b][1]);
      for (const old of sites.slice(0, sites.length - ZOOM_CAP)) delete next[old];
    }
    zoomStored(); // whatever its storage event does, the next ask reads it again
    await api.storage.local.set({ pageZoom: next });
  }).catch(() => {});
}
// The tab the user was on: the window's active one (Chrome reports the new
// tab before activating it), else the one most recently left. Not by
// lastActive alone: a switch gives both its tabs the same one.
function previousTab(s, tab) {
  return Object.values(s.tabs)
    .filter((t) => t.windowId === tab.windowId && t.id !== tab.id)
    .sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
}
export function newTabHandOff(tab) {
  if (!handOffs.has(tab.id)) handOffs.set(tab.id, handOff(tab).finally(() => setTimeout(() => handOffs.delete(tab.id), 30000)));
  return handOffs.get(tab.id);
}
async function handOff(tab) {
  // One line per new tab, so what Safari did (⌘T vs ⌘N, a new window or a
  // tab — macOS can turn ⌘N into a tab) is visible in the background console.
  const log = (decision, why) => console.info(`[margin] new tab ${tab.id} in window ${tab.windowId}: ${decision} (${why})`);
  const prev = previousTab(await load(), tab);
  if (!prev) return log('palette on the new-tab page', 'no other tab in this window: a new window'), false;
  // The Mac app's set-up window: Safari's own New Tab made a tab (its ⌘T, its
  // + button, its File menu). Not a tab Margin opened itself (newTabKey below).
  if (!openedByMargin()) onboarding.reportEvent('safariNewTab');
  if (!/^https?:/.test(prev.url)) return log('palette on the new-tab page', `tab ${prev.id} isn't a web page`), false;
  // Not linked to Margin.app: no palette to hand off to (pages draw none of
  // Margin's UI); the new-tab page stays, with its notice and address field.
  if (!appLink.linked()) return log('kept', 'Margin.app isn\'t linked: no palette'), false;
  // Linked, but the app draws nothing over this window (`drawn`: not in full screen, or not found
  // among the window server's yet): no palette to hand off to there either.
  if (!appLink.drawsWindow(tab.windowId)) return log('kept', 'Margin.app draws nothing over this window: no palette there'), false;
  if (paletteDroppedRecently(tab.windowId)) return log('kept', 'Margin.app couldn\'t show its palette over this window a moment ago'), false;
  handingOff.add(tab.id);
  // The app's palette opens over the page the user was on, in the window's
  // overlay.
  if (!appLink.push(tab.windowId, { type: 'palette', newTab: true })) {
    keepHandedOff(tab.id);
    return log('palette on the new-tab page', 'the link to Margin.app went meanwhile'), false;
  }
  // Still the untouched new tab in front? The user may have typed an address
  // meanwhile, switched away, or another extension opened it to navigate it
  // (background.js onUpdated then lets it go): it stays.
  const cur = handingOff.has(tab.id) ? await api.tabs.get(tab.id).catch(() => null) : null;
  if (!cur?.active || !V.isNewTabPage(cur.pendingUrl || cur.url)) {
    keepHandedOff(tab.id);
    return log('kept', 'the new tab was used or left meanwhile'), false;
  }
  log(`palette over tab ${prev.id}, new tab closed`, 'web page in this window: ⌘T (or ⌘N made into a tab by macOS)');
  try {
    await focusTab(prev.id, { source: 'new tab hand-off' });
  } catch (err) {
    // The page the user was on couldn't come back: the new tab stays, and
    // is tracked from here.
    keepHandedOff(tab.id);
    return log('kept', `tab ${prev.id} didn't come back: ${err?.message ?? err}`), false;
  }
  await mutate((st) => M.removeTab(st, tab.id)).catch(() => {});
  noteClosing([tab.id], 'done');
  await api.tabs.remove(tab.id).catch(() => {});
  return true;
}

// A Margin tab that isn't open (state/model.js keptTabs), clicked: opened in
// the window where it was clicked (the last focused one if none is named),
// at its place in the tab strip, in its space, and from then on that browser
// tab is the Margin tab (linkKept). Its Back history is gone, as for any
// closed tab reopened; its page goes back to where it was scrolled, once (the
// scroll record: background/scroll-record.js). Answers which tab came to the front.
/** @param {string} keptId @param {{ windowId?: number | null, deadline?: number, sidebarTop?: number }} options */
async function openKept(keptId, { windowId = null, deadline, sidebarTop } = {}) {
  const s = await load();
  const kept = s.keptTabs?.[keptId];
  if (!kept) throw new Error('That tab is no longer there');
  const win = windowId ?? (await api.windows?.getLastFocused?.().catch(() => null))?.id ?? undefined;
  if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop);
  const spaceId = s.spaces.some((sp) => sp.id === kept.spaceId) ? kept.spaceId : V.activeSpaceId(s, win);
  // The window's tabs as Safari has them now (Margin's indexes lag after closes).
  const live = win != null ? await api.tabs.query({ windowId: win }).catch(() => null) : null;
  const index = win != null ? M.stripIndexFor(s, win, kept.order, live) : undefined;
  const tab = await openTab({ windowId: win, url: kept.url, spaceId, deadline, index, keptId });
  return { shown: tab.id };
}

// A space's window made by Margin.app's switch: the tabs that were open with
// its front tab open behind it, one at a time, in their old order, each as
// its Margin tab (fresh: no Back history). One gone meanwhile is left.
const SPACE_WINDOW_REST_MS = 1200;
const SPACE_WINDOW_STEP_MS = 150;
async function openKeptBehind(windowId, spaceId, keptIds) {
  for (const keptId of keptIds) {
    const s = await load();
    const kept = s.keptTabs?.[keptId];
    if (!kept || kept.spaceId !== spaceId) continue;
    const win = await api.windows.get(windowId).catch(() => null);
    if (!win) return; // the window closed meanwhile
    markMarginOpening();
    noteReopened(kept.url);
    const tab = await api.tabs.create({ windowId, url: kept.url, active: false }).catch(() => null);
    if (!tab) continue;
    await mutate((st) => {
      let next = M.upsertTab(st, tab, now());
      if (next.keptTabs?.[keptId]) next = M.linkKept(next, tab.id, keptId, now());
      return M.moveTab(next, tab.id, spaceId);
    });
    await new Promise((resolve) => setTimeout(resolve, SPACE_WINDOW_STEP_MS));
  }
}

// ⌘T as Margin's own shortcut (Safari's manifest `new-tab`, with Safari's
// File › New Tab moved to another shortcut, DECISIONS.md): Safari matches it
// in the app, wherever the focus is. The page in front opens its palette to
// choose a new tab (no tab created: no flicker); Margin's new-tab page does
// what its "+ New Tab" does; anything else (Safari's own pages, PDFs, sites
// Margin can't reach) gets a new tab with Margin's new-tab page, as Safari's
// ⌘T did (its palette opens there).
// Not linked to Margin.app (linked, the app holds ⌘T: background.js), so
// with no palette to open: Margin's new-tab page, which says the app isn't
// running and has an address field; on that page already, its field. One
// press can come both as Safari's command and as the key in the page
// (content/core.js): taken once per window.
const NEW_TAB_KEY_ONCE_MS = 600;
const newTabKeyAt = new Map(); // window id → when
export async function newTabKey(tabArg) {
  onboarding.reportEvent('cmdTKey');
  const windowId = tabArg?.windowId ?? (await api.windows?.getLastFocused())?.id;
  const now = Date.now();
  if (now - (newTabKeyAt.get(windowId ?? -1) ?? 0) < NEW_TAB_KEY_ONCE_MS) return;
  newTabKeyAt.set(windowId ?? -1, now);
  const [tab] = await api.tabs.query({ active: true, ...(windowId != null ? { windowId } : { currentWindow: true }) });
  if (!tab) return;
  if (V.isNewTabPage(tab.url || tab.pendingUrl)) {
    return api.runtime.sendMessage({ type: 'command', command: 'new-tab', tabId: tab.id }).catch(() => {});
  }
  markMarginOpening();
  await api.tabs.create({ windowId: tab.windowId, url: api.runtime.getURL('newtab/newtab.html') });
}

// Style sheets fetched for pages (fetchStyle), the latest few.
const styleCache = new Map();
const STYLE_CACHE_SIZE = 50;
const STYLE_CACHE_CHARS = 8_000_000; // and no more than this in all
const STYLE_CACHED_MAX_CHARS = 1_000_000; // a larger one is fetched each time
const STYLE_MAX_CHARS = 8_000_000;


// Whether Margin.app draws the UI for a page's window, and where its box goes
// (background/link.js): in `hello`, so a page knows before it draws.
// `drawn`: whether the app said it draws over the window (left out: not said).
const appState = (windowId) => {
  if (appLink.pageState() === 'off') return null;
  const drawn = appLink.drawn(windowId);
  return { state: appLink.pageState(), layout: windowId != null ? appLink.layout(windowId) : null, ...(typeof drawn === 'boolean' ? { drawn } : {}) };
};

export const handlers = {
  // A page starting: which tab and window it is, this copy, whether the window is in Margin's
  // full screen (Chrome), Margin.app's word on the link and the window's layout.
  async hello(_message, sender) {
    onboarding.pageLoaded();
    const windowId = sender.tab?.windowId ?? null;
    const fullscreen = windowId != null && platform?.marginFullscreen ? await isFullscreen(windowId) : false;
    // `since`: with the page's own address, which copy's tab ids it may trust (shared/stored.js).
    return { tabId: sender.tab?.id ?? null, windowId, instanceId, fullscreen, app: appState(windowId), since: thisCopy().since };
  },
  // Whether this copy owns the state: only an owner answers this (the others
  // say `stale`, background.js), after checking the stored owner again.
  async owner() {
    return true;
  },
  // Answers which tab came to the front ({ shown }), or fails: the tab is
  // gone, or the browser didn't show it (the page then says so).
  // `tabId` a string: a Margin tab that isn't open (state/model.js keptTabs),
  // opened in `windowId` (else the page's own window), in its place.
  /** @param {{ tabId: number | string, windowId?: number, hint?: { url?: string, index?: number, title?: string }, sidebarTop?: number, deadline?: number, resolved?: any }} message `hint`: the row's tab address and place (background/tabs.js resolveTab); `deadline`: when the page stops waiting (no switch after it); `sidebarTop`: the list's scroll, kept for the window; `resolved`: the tab background.js found by that address already (not asked for again) */
  async activateTab({ tabId, windowId, hint, sidebarTop, deadline, resolved = null }, sender) {
    if (typeof tabId === 'string') return openKept(tabId, { windowId: windowId ?? sender?.tab?.windowId, deadline, sidebarTop });
    const target = resolved ?? (await resolveTab(tabId, hint, sender.tab?.windowId, { deadline }));
    if (!target) throw new Error('That tab is no longer open');
    if (Number.isFinite(sidebarTop) && sender.tab?.windowId != null) void setScroll(sender.tab.windowId, sidebarTop);
    // In another window of the profile: it comes to this one, the other keeps it chosen, away (app/WINDOWS.md §9).
    const here = windowId ?? sender?.tab?.windowId;
    if (here != null && target.windowId != null && target.windowId !== here && away.follows(here)) {
      await away.bringTab(target, here, { source: 'activateTab', deadline });
      return { shown: target.id };
    }
    await focusTab(target.id, { source: 'activateTab', deadline });
    return { shown: target.id };
  },
  // Margin's stand-in page (away/away.html): what its window shows away, with its picture (background/away.js).
  async awayShown(_message, sender) {
    return away.shownAway(sender?.tab?.windowId);
  },
  // The stand-in clicked: its window's away tab back to it.
  async bringAway(_message, sender) {
    const windowId = sender?.tab?.windowId;
    const s = await load();
    const tabId = windowId != null ? s.awayByWindow?.[windowId] : null;
    const tab = tabId != null ? await Promise.resolve(api.tabs.get(tabId)).catch(() => null) : null;
    if (!tab || windowId == null) return { shown: null };
    await away.bringTab(tab, windowId, { source: 'stand-in' });
    return { shown: tab.id };
  },
  // Settings' "Wake all sleeping tabs" (background/sleep.js): how many it woke.
  async wakeSleeping() {
    return wakeAll();
  },
  // A pass of sleeping tabs now (background/sleep.js), for tabs unused for
  // `afterMs` (the setting's hours if left out): for checks by hand and the
  // WebKit host. What it did.
  /** @param {{ afterMs?: number, max?: number }} message */
  async sleepNow({ afterMs, max } = {}) {
    return sleepIdle({ ...(Number.isFinite(afterMs) && afterMs >= 0 ? { afterMs } : {}), ...(Number.isInteger(max) && max > 0 ? { max } : {}) });
  },
  // The sidebar's scroll position in this page's window (background/scroll.js).
  /** @param {{ windowId?: number }} message */
  async sidebarScroll({ windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    return id == null ? 0 : getScroll(id);
  },
  /** @param {{ top: number, windowId?: number }} message */
  async setSidebarScroll({ top, windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id != null && Number.isFinite(top)) await setScroll(id, top);
  },
  // Closing from Margin archives the tab, like Arc. One that isn't open (a
  // string id: state/model.js keptTabs) goes to the archive as it is.
  /** @param {{ tabId: number | string }} message */
  async closeTab({ tabId }) {
    if (typeof tabId === 'string') {
      await mutate((s) => M.archiveKept(s, tabId, { id: newId(), closedAt: now() }));
      return;
    }
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
    const closing = await api.tabs.get(tabId).catch(() => null);
    // The tab in front: the space's most recent other tab comes to the front
    // first (Arc stays in the space; the browser would pick a neighbour,
    // maybe of another space).
    if (closing?.active) {
      const s = await load();
      const stay = M.recentTabOfSpace(s, closing.windowId, s.tabSpace[tabId], tabId);
      if (stay) await focusTab(stay.id, { source: 'closeTab' }).catch(() => null);
    }
    // (Archived above: its close, heard, does nothing more.)
    noteClosing([tabId], 'done');
    await api.tabs.remove(tabId);
  },
  /** @param {{ archiveId: string, windowId?: number, replaceTabId?: number }} message */
  async restoreArchive({ archiveId, windowId, replaceTabId }) {
    const s = await load();
    const entry = s.archive.find((a) => a.id === archiveId);
    if (!entry) return;
    const spaceId = s.spaces.some((sp) => sp.id === entry.spaceId) ? entry.spaceId : s.spaces[0].id;
    if (replaceTabId != null) {
      const tab = await api.tabs.update(replaceTabId, { url: entry.url });
      await mutate((st) => M.setActiveSpace(M.moveTab(M.removeArchived(st, archiveId), replaceTabId, spaceId), tab.windowId, spaceId));
    } else {
      const tab = await openTab({ windowId, url: entry.url, spaceId });
      await mutate((st) => M.setActiveSpace(M.removeArchived(st, archiveId), tab.windowId, spaceId));
    }
  },
  // Page zoom (the browser's own, like ⌘+): for the page's box (in the
  // page's zoomed pixels); remembered per site.
  // Where the page in front's area sits in its window, when Safari takes part of it (the docked Web
  // Inspector: content/core.js viewportNow), for Margin.app's overlay (background/link.js viewport).
  // `measured`: the page found where its area starts from a pointer event (else it's a guess).
  // `resizedAt`, `at`: when the page was resized and when it said so (its Date.now()), passed on with when this
  // copy heard it, so Margin.app's log says where the time went (Tirth, 2026-11-07: the layout late beside the inspector).
  /** @param {{ viewport?: { x: number, y: number, width: number, height: number, measured?: boolean } | null, resizedAt?: number, at?: number }} message */
  async viewport({ viewport = null, resizedAt, at } = {}, sender) {
    const tab = sender?.tab;
    if (!tab || tab.active === false || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) return;
    const ok = (v) => Number.isFinite(v) && v >= 0 && v < 100_000;
    const rect = viewport && ok(viewport.x) && ok(viewport.y) && ok(viewport.width) && ok(viewport.height) && viewport.width > 0 && viewport.height > 0
      ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, ...(viewport.measured === true ? { measured: true } : {}) } : null;
    const time = (v) => Number.isFinite(v) && v > 0;
    const times = { ...(time(resizedAt) ? { resized: resizedAt } : {}), ...(time(at) ? { said: at } : {}), heard: Date.now() };
    appLink.viewport(tab.windowId, tab.id, rect, times);
  },
  // A page gone into full screen or back (content/core.js: its own, or Safari's video full screen), for Margin.app to
  // take its layout off that window meanwhile (background/link.js pageFullscreen).
  /** @param {{ on?: boolean }} message */
  async pageFullscreen({ on } = {}, sender) {
    const tab = sender?.tab;
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) || typeof on !== 'boolean') return;
    appLink.pageFullscreen(tab.windowId, tab.id, on);
  },
  // A page saying whether it's shown (content/core.js and the new-tab page: document.visibilityState,
  // at a change, at its start and when asked), for Margin.app to tell same-bounds windows of different
  // profiles apart (background/link.js visibility).
  // `from`: which said it ('page': a web page's content script, 'newtab': Margin's new-tab page), for the log.
  /** @param {{ visible?: boolean, at?: number, from?: string }} message */
  async visibility({ visible, at, from } = {}, sender) {
    const tab = sender?.tab;
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) || typeof visible !== 'boolean') return;
    const source = from === 'page' ? 'content script' : from === 'newtab' ? 'new-tab page' : from === 'away' ? 'stand-in page' : 'unknown';
    appLink.visibility(tab.windowId, tab.id, visible, Number.isFinite(at) ? /** @type {number} */ (at) : Date.now(), source);
  },
  async getZoom(_, sender) {
    if (!sender.tab) return null;
    const zoom = await api.tabs.getZoom(sender.tab.id);
    rememberZoom(sender.tab, sender.url ?? sender.tab.url, zoom);
    return zoom;
  },
  // Search with the browser's engine: in `tabId`, else in a new tab (from a
  // page: behind it until the results have loaded, tabs.js openBehind).
  /** @param {{ query: string, windowId?: number, tabId?: number, deadline?: number }} message */
  async search({ query, windowId, tabId, deadline }, sender) {
    const text = String(query ?? '').trim();
    if (!text) return;
    const from = sender?.tab?.id != null ? sender.tab : null;
    if (platform?.search === 'browser' && api.search?.query) {
      if (tabId != null) return void (await api.search.query({ text, tabId }));
      if (from) return openBehind({ windowId, from, deadline, label: text, then: (tab) => api.search.query({ text, tabId: tab.id }) });
      return void (await api.search.query({ text, disposition: 'NEW_TAB' }));
    }
    const { settings } = await load();
    const url = S.searchUrl(text, settings);
    const own = { at: now(), template: S.safariEngine(settings).template };
    for (const map of [ownSearchTabs, ownSearchUrls]) for (const [key, entry] of map) if (now() - entry.at > OWN_SEARCH_MS) map.delete(key);
    // Its row says the search at once, not the page it leaves (state/model.js goingTo).
    const going = (id) => mutate((s) => M.goingTo(s, id, { url, title: text }, now())).catch(() => {});
    if (tabId != null) {
      ownSearchTabs.set(tabId, own);
      await going(tabId);
      return void (await api.tabs.update(tabId, { url }));
    }
    // From a page: opened at the search's address (its row says so from the
    // start), known as Margin's own by that address until it has an id.
    if (from) {
      ownSearchUrls.set(url, own);
      return openBehind({ windowId, url, from, deadline, created: (tab) => ownSearchTabs.set(tab.id, own) });
    }
    // Else marked before it navigates: created blank, then the search loads.
    const tab = await openTab({ windowId, url: 'about:blank', deadline });
    ownSearchTabs.set(tab.id, own);
    await mutate((s) => M.goingTo(s.tabs[tab.id] ? s : M.upsertTab(s, tab, now()), tab.id, { url, title: text }, now())).catch(() => {});
    await api.tabs.update(tab.id, { url });
    // Shown (opened in front): the UI's switch to it went through (shared/switching.js `failed`).
    return { tabId: tab.id, shown: tab.id };
  },
  // An address from a page (the palette): behind it until loaded (tabs.js
  // openBehind). Margin's new-tab page, or a space's start page, at once.
  /** @param {{ windowId?: number, url?: string, spaceId?: string, deadline?: number }} message */
  async newTab({ windowId, url, spaceId, deadline }, sender) {
    if (url && !spaceId && sender?.tab?.id != null) return openBehind({ windowId, url, from: sender.tab, deadline });
    const tab = await openTab({ windowId, url, spaceId, deadline });
    return { tabId: tab.id };
  },
  // `folderId`/`beforeId`: where the pin goes (a folder of the tab's space,
  // before a pin or folder there; dragged in the sidebar); the end of the
  // pinned area by default. Returns the new pin's id.
  // A tab that isn't open (a string id: state/model.js keptTabs) becomes the
  // pin: its pin opens it from then on.
  /** @param {{ tabId: number | string, folderId?: string | null, beforeId?: string | null }} message */
  async pinTab({ tabId, folderId = null, beforeId = null }) {
    const s = await load();
    const kept = typeof tabId === 'string' ? s.keptTabs?.[tabId] : null;
    const tab = kept ?? (typeof tabId === 'number' ? s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null)) : null);
    if (!tab?.url) return console.warn('[margin] pin: unknown tab', tabId);
    let result = 'pinned';
    const id = newId();
    await mutate((st) => {
      // A tab Margin hasn't placed in a space yet goes to its window's space.
      const spaceId = kept ? kept.spaceId : st.tabSpace[tabId] ?? V.activeSpaceId(st, tab.windowId);
      const next = M.addPin(st, { id, spaceId, url: tab.url, title: tab.title, folderId, beforeId });
      if (next === st) result = 'not pinned (already pinned in that space, or no space)';
      return kept && next !== st ? M.forgetKept(next, kept.id) : next;
    });
    console.info(`[margin] pin tab ${tabId}: ${result}`);
    return result === 'pinned' ? id : null;
  },
  // ---- folders of pins (state/model.js) ----
  // A folder in this window's space (or `spaceId`), holding the pins
  // `pinIds`, or the tab `tabId` pinned into it; at the top level before
  // `beforeId` (else in the place of the first pin it takes, else the end).
  // Returns its id.
  /** @param {{ windowId?: number, spaceId?: string, name?: string, pinIds?: string[], tabId?: number | string, beforeId?: string | null }} message `tabId` a string: a tab that isn't open (pinned into it, it's the pin from then on) */
  async createFolder({ windowId, spaceId, name, pinIds = [], tabId, beforeId = null }, sender) {
    const id = newId();
    const pinFromTab = Number.isInteger(tabId) || typeof tabId === 'string' ? newId() : null;
    const s = pinFromTab ? await load() : null;
    const kept = typeof tabId === 'string' ? s?.keptTabs?.[tabId] ?? null : null;
    const tab = kept ?? (typeof tabId === 'number' ? (s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null))) : null);
    await mutate((st) => {
      const space = spaceId ?? (kept ? kept.spaceId : tab ? st.tabSpace[tab.id] : null) ?? V.activeSpaceId(st, windowId ?? sender?.tab?.windowId);
      const firstPin = st.pins.find((p) => p.id === pinIds[0] && p.spaceId === space);
      // In the place of the first pin it takes, if that's at the top level.
      const before = beforeId ?? (firstPin && !firstPin.folderId ? firstPin.id : null);
      let next = M.createFolder(st, { id, spaceId: space, name, pinIds, beforeId: before });
      if (tab?.url) next = M.addPin(next, { id: pinFromTab, spaceId: space, url: tab.url, title: tab.title, folderId: id });
      return kept ? M.forgetKept(next, kept.id) : next;
    });
    return id;
  },
  /** @param {{ folderId: string, name: string }} message */
  async renameFolder({ folderId, name }) {
    await mutate((s) => M.renameFolder(s, folderId, name));
  },
  /** @param {{ folderId: string, open: boolean }} message */
  async setFolderOpen({ folderId, open }) {
    await mutate((s) => M.setFolderOpen(s, folderId, open));
  },
  /** @param {{ folderId: string }} message the folder goes; its pins stay */
  async deleteFolder({ folderId }) {
    await mutate((s) => M.deleteFolder(s, folderId));
  },
  /** @param {{ pinId: string, folderId?: string | null, beforeId?: string | null }} message */
  async movePin({ pinId, folderId = null, beforeId = null }) {
    await mutate((s) => M.movePin(s, pinId, { folderId, beforeId }));
  },
  /** @param {{ folderId: string, beforeId?: string | null }} message */
  async moveFolder({ folderId, beforeId = null }) {
    await mutate((s) => M.moveFolder(s, folderId, { beforeId }));
  },
  // A tab dragged in the sidebar's list, next to another (`side`: above it,
  // 'before', or below, 'after', as the list shows them: newest at the top,
  // the reverse of the window's order). Safari's own tab order follows, and
  // the sidebar with it (background.js tabs.onMoved).
  // Whether it moved (not: the browser can't, a tab is gone, or one is the
  // browser's own pinned tab, kept apart from the others).
  // A tab that isn't open (a string id) takes a place in the list next to the
  // other (state/model.js placeKept); an open one next to one that isn't
  // open doesn't move (its place follows the browser's tab strip).
  /** @param {{ tabId: number | string, hint?: any, nextTo: number | string, nextToHint?: any, side: 'before' | 'after' }} message */
  async moveTab({ tabId, hint, nextTo, nextToHint, side }, sender) {
    if (typeof tabId === 'string') {
      const before = await load();
      const spaceId = before.keptTabs?.[tabId]?.spaceId;
      if (!spaceId) return false;
      const after = await mutate((s) => M.placeKept(s, tabId, nextTo, side, spaceId));
      return after.keptTabs?.[tabId]?.order !== before.keptTabs?.[tabId]?.order;
    }
    if (typeof nextTo === 'string') return false;
    if (!api.tabs.move) return false;
    const [tab, other] = await Promise.all([resolveTab(tabId, hint, sender?.tab?.windowId), resolveTab(nextTo, nextToHint, sender?.tab?.windowId)]);
    if (!tab || !other || tab.id === other.id || !!tab.pinned !== !!other.pinned) return false;
    if (tab.windowId !== other.windowId) {
      // Next to one in another window (the list is the space's: app/WINDOWS.md §9): a place in the list beside it,
      // and the tab where that place falls in its own window's strip.
      const before = await load();
      const spaceId = before.tabSpace[tab.id];
      if (!spaceId || before.tabSpace[other.id] !== spaceId) return false;
      const after = await mutate((s) => M.placeOpen(s, tab.id, other.id, side, spaceId));
      const order = after.tabs[tab.id]?.order;
      if (!Number.isFinite(order) || order === before.tabs[tab.id]?.order) return false;
      const strip = Object.values(after.tabs).filter((t) => t.windowId === tab.windowId && t.id !== tab.id);
      const index = strip.filter((t) => (Number.isFinite(t.order) ? t.order : t.index) < order).length;
      if (index === tab.index) return true;
      return api.tabs.move(tab.id, { index }).then(() => true, () => false);
    }
    // Above it in the list: just after it in the window; below it: just before.
    const index = moveIndex(tab.index, other.index, side);
    if (index === tab.index) return false;
    return api.tabs.move(tab.id, { index }).then(() => true, () => false);
  },
  // "Clear" (the canvas designs' Today): the window's space's tabs that
  // aren't pinned close, as the sidebar lists them (shared/view.js sidebar),
  // archived as closing one does. The tab in front among them: the space's
  // most recent tab left (an open pin) comes to the front first, else its
  // start page opens, so the window stays in the space and isn't left empty.
  // Returns the tabs closed.
  /** @param {{ windowId?: number }} message */
  async clearToday({ windowId }, sender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (win == null) return [];
    const s = await load();
    const spaceId = V.activeSpaceId(s, win);
    const rows = V.sidebar(s, win).tabs;
    // The space's tabs that aren't open go to the archive with the others.
    const keptIds = rows.filter((t) => t.kept).map((t) => /** @type {string} */ (/** @type {unknown} */ (t.id)));
    const ids = rows.filter((t) => !t.kept).map((t) => /** @type {number} */ (t.id));
    if (!ids.length && !keptIds.length) return [];
    const closing = new Set(ids);
    await mutate((st) => {
      let next = st;
      for (const id of keptIds) next = M.archiveKept(next, id, { id: newId(), closedAt: now() });
      for (const id of ids) {
        const tab = next.tabs[id];
        if (tab && /^https?:/i.test(tab.url)) next = M.archiveTab(next, M.archiveEntryForTab(next, tab, { id: newId(), closedAt: now() }));
      }
      return next;
    });
    if (!ids.length) return keptIds;
    // Each window whose tab in front is closing (this one, and any other of the profile showing the space: its
    // list is the space's, app/WINDOWS.md §9) stays in the space and isn't left empty (Safari closes a window
    // whose last tab closes): its most recent tab of the space it shows comes to the front, else its start page opens.
    const windows = new Set([win, ...ids.map((id) => s.tabs[id]?.windowId).filter((w) => w != null)]);
    for (const w of windows) {
      const [front] = await api.tabs.query({ active: true, windowId: w }).catch(() => []);
      if (!front || !closing.has(front.id)) continue;
      const shows = w === win ? spaceId : V.activeSpaceId(s, w);
      const stay = Object.values(s.tabs).filter((t) => t.windowId === w && !closing.has(t.id) && s.tabSpace[t.id] === shows)
        .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
      if (stay) await focusTab(stay.id, { source: 'clearToday' }).catch(() => null);
      else await openTab({ windowId: w, url: api.runtime.getURL('newtab/newtab.html#launcher'), spaceId: shows }).catch(() => null);
    }
    await closeTabs(ids, 'done');
    return [...ids, ...keptIds];
  },
  // Back, forward and reload for the tab in front of a window (or `tabId`):
  // the runtime's nav.* actions when its host can't do them itself (Margin.app).
  /** @param {{ windowId?: number, tabId?: number }} message */
  async goBack({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goBack) return false;
    return api.tabs.goBack(id).then(() => true, () => false);
  },
  /** @param {{ windowId?: number, tabId?: number }} message */
  async goForward({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goForward) return false;
    return api.tabs.goForward(id).then(() => true, () => false);
  },
  /** @param {{ windowId?: number, tabId?: number }} message */
  async reload({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null) return false;
    return api.tabs.reload(id).then(() => true, () => false);
  },
  /** @param {{ pinId: string }} message */
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  /** @param {{ pinId: string, windowId?: number, sidebarTop?: number, deadline?: number }} message `deadline`: as activateTab's */
  async openPin({ pinId, windowId, sidebarTop, deadline }, sender) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    if (Number.isFinite(sidebarTop) && windowId != null) void setScroll(windowId, sidebarTop);
    // Only a tab of the pin's space (as the sidebar shows it): one elsewhere
    // would switch the window to that space.
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key && s.tabSpace[t.id] === pin.spaceId);
    // The window asking first, then one that isn't parked (out of sight: app/HANDOFF.md §2.5); a tab
    // only in a parked window is shown by the app's handoff to it (focusTab).
    const existing = matches.find((t) => t.windowId === windowId) ?? matches.find((t) => !inParkedWindow(t)) ?? matches[0];
    if (existing) {
      // In another window of the profile: it comes here (app/WINDOWS.md §9).
      await away.showTab(existing.id, windowId ?? sender?.tab?.windowId, { source: 'openPin', deadline });
      return { shown: existing.id };
    }
    // Its tab that isn't open, if the space has one (kept from before it was
    // pinned): opened as that Margin tab.
    const kept = M.keptForUrl(s, pin.url, pin.spaceId);
    const tab = await openTab({ windowId, url: pin.url, spaceId: pin.spaceId, deadline, ...(kept ? { keptId: kept.id } : {}) });
    return { shown: tab.id };
  },
  // A space shown in the window (its tab most used there to the front); `bringTab: false`: only
  // the sidebar's space, the page in front stays. Answers which tab is in front now.
  /** @param {{ windowId?: number, spaceId: string, bringTab?: boolean, sidebarTop?: number, deadline?: number }} message */
  async setSpace({ windowId, spaceId, bringTab = true, sidebarTop, deadline }, sender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop);
    const result = await showSpace(win, spaceId, { bringTab, deadline });
    return { shown: result?.tab?.id ?? null };
  },
  /** @param {{ windowId?: number, name?: string, emoji?: string, color?: string }} message */
  async createSpace({ windowId, name, emoji, color }) {
    const id = newId();
    await mutate((s) => {
      const next = M.createSpace(s, { id, name, emoji, color });
      return windowId == null ? next : M.setActiveSpace(next, windowId, id);
    });
    return { spaceId: id };
  },
  /** @param {{ spaceId: string, name?: string, emoji?: string, color?: string }} message */
  async renameSpace({ spaceId, name, emoji, color }) {
    await mutate((s) => M.updateSpace(s, spaceId, { name, emoji, color }));
  },
  /** @param {{ spaceId: string }} message */
  async deleteSpace({ spaceId }) {
    await mutate((s) => M.deleteSpace(s, spaceId));
  },
  /** @param {{ tabId: number | string, spaceId: string }} message `tabId` a string: a tab that isn't open */
  async moveTabToSpace({ tabId, spaceId }) {
    await mutate((s) => M.moveTab(s, tabId, spaceId));
  },
  /** @param {{ href: string }} message */
  async pageIcon({ href }, sender) {
    if (!platform?.fetchFavicons) return; // the browser provides icons
    const pageUrl = sender.tab?.url ?? sender.url;
    let origin;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return;
    }
    if (!/^https?:/.test(origin) || typeof href !== 'string' || !iconUrlAllowed(href, pageUrl)) return;
    if (!iconInflight.has(origin)) {
      iconInflight.set(origin, learnIcon(origin, href).finally(() => iconInflight.delete(origin)));
    }
    await iconInflight.get(origin);
  },
  // A fresh new-tab page (⌘T, ⌘N, or Safari opening one) asks what to do.
  // ⌘T in a window with a web page: go back to the tab the user was on,
  // close the new tab and open the command palette there (Arc-style, no
  // empty page). Otherwise (⌘N's first tab, or a previous tab without
  // Margin's content script) the new-tab page opens its own palette.
  // The launcher on purpose (#launcher: it doesn't hand off to the palette).
  /** @param {{ windowId?: number }} message */
  /** @param {{ windowId?: number, settings?: boolean }} message `settings`: its Settings open */
  async openLauncher({ windowId, settings = false }) {
    await openTab({ windowId, url: api.runtime.getURL(`newtab/newtab.html#${settings ? 'settings' : 'launcher'}`) });
  },
  // DEV-HOOK: a one-shot probe for tabs following the window in front (app/WINDOWS.md), asked only by the
  // app's dev hook, which asks only Safari's Test A (DevHooks.swift checks the name). One test tab and one
  // full-screen window made, the tab moved there and back; after each move, whether its page survived (a
  // marker in its memory, its scroll, a typed field) and how long the move took; one picture of it timed
  // and dropped. Then exactly what it made closed. Its answer: numbers and booleans only.
  /** @param {{ url?: string }} message the page to open, the app's (a plain https origin) */
  async devTabMoveProbe({ url } = {}, sender) {
    if (!sender?.app) throw new Error('the app only');
    if (!/^https:\/\/[a-z0-9.-]+\/$/.test(String(url ?? ''))) throw new Error('a plain https origin only');
    if (devProbing) throw new Error('a probe is already running');
    devProbing = true;
    const made = { tabId: /** @type {number | null} */ (null), windowId: /** @type {number | null} */ (null), homeId: /** @type {number | null} */ (null), homeFront: /** @type {number | null} */ (null) };
    /** @type {Record<string, any>} */
    const out = { ok: false };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const home = (await api.windows.getAll()).find((w) => w.focused) ?? (await api.windows.getAll())[0];
      if (!home) throw new Error('no window');
      made.homeId = home.id;
      made.homeFront = (await api.tabs.query({ active: true, windowId: home.id }))[0]?.id ?? null;
      const tab = await api.tabs.create({ windowId: home.id, url: String(url), active: false });
      made.tabId = tab.id;
      for (let i = 0; i < 50 && (await api.tabs.get(tab.id)).status !== 'complete'; i++) await wait(200);
      const token = String(Math.random()).slice(2, 12);
      const [marked] = await api.scripting.executeScript({ target: { tabId: tab.id }, args: [token], func: (t) => {
        /** @type {any} */ (window).__marginProbe = t;
        const field = document.createElement('input');
        field.id = '__margin_probe';
        field.value = `typed ${t}`;
        document.body.append(field);
        document.body.style.minHeight = '5000px';
        scrollTo(0, 1234);
        return true;
      } });
      out.marked = marked?.result === true;
      const check = async () => (await api.scripting.executeScript({ target: { tabId: tab.id }, args: [token], func: (t) => ({
        marker: /** @type {any} */ (window).__marginProbe === t,
        field: /** @type {HTMLInputElement | null} */ (document.getElementById('__margin_probe'))?.value === `typed ${t}`,
        scroll: Math.round(scrollY),
      }) }))[0]?.result ?? null;
      // Short (the app's log line is cut at 600 characters): marker, field (1/0) and scroll.
      // As a number: 3 marker and field kept (2 marker only, 1 field only), times 100000, plus the scroll; -1 none.
      const kept = async () => { const c = await check(); return c ? ((c.marker ? 2 : 0) + (c.field ? 1 : 0)) * 100000 + Math.min(99999, c.scroll) : -1; };
      out.before = await kept();
      const second = await api.windows.create({ focused: true, state: 'fullscreen' });
      made.windowId = second.id;
      await wait(2000); // its full-screen Space up
      let t0 = performance.now();
      await api.tabs.move(tab.id, { windowId: second.id, index: -1 });
      out.moveMs = Math.round(performance.now() - t0);
      await api.tabs.update(tab.id, { active: true });
      await wait(1000);
      out.movedThere = (await api.tabs.get(tab.id)).windowId === second.id;
      out.afterMove = await kept();
      t0 = performance.now();
      const picture = await api.tabs.captureVisibleTab(second.id, { format: 'jpeg', quality: 60 }).catch(() => null);
      out.captureMs = Math.round(performance.now() - t0);
      out.captureKB = picture ? Math.round(picture.length / 1024) : 0;
      // The window behind (home, in its own Space now): can its tab in front be pictured from here?
      t0 = performance.now();
      const behind = await api.tabs.captureVisibleTab(home.id, { format: 'jpeg', quality: 60 }).catch(() => null);
      out.captureBehindMs = Math.round(performance.now() - t0);
      out.captureBehindKB = behind ? Math.round(behind.length / 1024) : 0;
      t0 = performance.now();
      await api.tabs.move(tab.id, { windowId: home.id, index: -1 });
      out.backMs = Math.round(performance.now() - t0);
      await wait(1000);
      out.movedBack = (await api.tabs.get(tab.id)).windowId === home.id;
      out.afterBack = await kept();
      // Margin's own follow (background/away.js), with home behind: the tab in front there, then chosen in the
      // window in front (second), then home to the front again. Whether making and showing tabs in a window behind
      // leaves the focus where it was (no slide to its Space), and whether the tab follows home back.
      const focused = async (/** @type {number} */ id) => (await api.windows.get(id).catch(() => null))?.focused === true;
      await api.tabs.update(tab.id, { active: true });
      await wait(500);
      out.shownBehindKeptFocus = (await focused(second.id)) && !(await focused(home.id));
      t0 = performance.now();
      await away.bringTab(await api.tabs.get(tab.id), second.id, { source: 'probe', raise: false });
      out.bringMs = Math.round(performance.now() - t0);
      await wait(800);
      out.bringKeptFocus = (await focused(second.id)) && !(await focused(home.id));
      const standInIn = async (/** @type {number} */ id) => (await api.tabs.query({ windowId: id })).find((t) => isAwayPage(t.url) || isAwayPage(t.pendingUrl)) ?? null;
      const homeStandIn = await standInIn(home.id);
      out.standInInFront = homeStandIn?.active === true;
      const live = await api.tabs.get(tab.id);
      out.broughtThere = live.windowId === second.id && live.active === true;
      out.awayRecorded = (await load()).awayByWindow?.[home.id] === tab.id;
      out.afterBring = await kept();
      t0 = performance.now();
      await api.windows.update(home.id, { focused: true });
      for (let i = 0; i < 30 && (await api.tabs.get(tab.id)).windowId !== home.id; i++) await wait(100);
      out.followMs = Math.round(performance.now() - t0);
      await wait(800);
      out.followedBack = (await api.tabs.get(tab.id)).windowId === home.id;
      out.focusHeard = away.awayInternals.focusSeen.windowId === home.id;
      out.focusOutcome = away.awayInternals.focusSeen.outcome;
      out.homeFocused = await focused(home.id);
      out.homeStandInGone = !(await standInIn(home.id));
      out.secondStandIn = !!(await standInIn(second.id));
      out.afterFollow = await kept();
      out.ok = true;
    } catch (err) {
      out.error = String(/** @type {any} */ (err)?.name ?? 'Error');
    } finally {
      if (made.tabId != null) await api.tabs.remove(made.tabId).catch(() => {});
      if (made.windowId != null) await api.windows.remove(made.windowId).catch(() => {});
      // A stand-in the follow left in home (only the probe's tab was shown away there; nothing else touched).
      if (made.homeId != null) for (const t of await api.tabs.query({ windowId: made.homeId }).catch(() => [])) if (isAwayPage(t.url) || isAwayPage(t.pendingUrl)) await api.tabs.remove(t.id).catch(() => {});
      // Home's tab in front as it was.
      if (made.homeFront != null) await api.tabs.update(made.homeFront, { active: true }).catch(() => {});
      out.cleaned = true;
      devProbing = false;
    }
    return { summary: JSON.stringify(out) };
  },
  // A real new window of this profile (⌘N through Margin.app, the palette's "New window": app/WINDOWS.md §5),
  // a Margin window of its own. With `fromWindowId`: in full screen if that window is (or as `fullscreen`
  // says), on the space it shows, set, not guessed, with its first tab in it too. Without one, the window
  // inherits the space (model.inheritSpace). Its new-tab page opens the palette. Answers its id, state and
  // bounds, which the app binds it by as Margin's.
  /** @param {{ fromWindowId?: number, fullscreen?: boolean }} [message] */
  async newWindow({ fromWindowId, fullscreen } = {}) {
    const from = Number.isInteger(fromWindowId) ? await api.windows.get(fromWindowId).catch(() => null) : null;
    const spaceId = from ? M.activeSpaceId(await load(), from.id) : null;
    const full = fullscreen ?? from?.state === 'fullscreen';
    markMarginOpening();
    let win;
    try {
      win = await api.windows.create({ focused: true, ...(full ? { state: 'fullscreen' } : {}) });
    } catch {
      win = await api.windows.create({ focused: true }); // a browser that won't make it full screen at once
    }
    if (!win) return null;
    if (spaceId) {
      const tabs = win.tabs ?? (await api.tabs.query({ windowId: win.id }).catch(() => []));
      await mutate((st) => {
        let next = M.setActiveSpace(st, win.id, spaceId);
        for (const tab of tabs) next = M.moveTab(M.upsertTab(next, tab, now()), tab.id, spaceId);
        return next;
      });
    }
    void appLink.windowsNow?.();
    const bounds = [win.left, win.top, win.width, win.height].every(Number.isFinite) && win.width > 0 && win.height > 0
      ? { left: win.left, top: win.top, width: win.width, height: win.height } : null;
    return { windowId: win.id, state: win.state ?? 'normal', ...(bounds ? { bounds } : {}) };
  },
  // Margin.app switching to a space of this profile from another profile's
  // window (app/shell/ProfileSwitch.swift, PLAN.md §15): this copy makes a
  // window showing the space, in full screen. In front: the space's tab used
  // last (it isn't open: the window the switch closed kept it); the others
  // that were open with it in that window open behind once it's up. Answers
  // the window's id and state (a browser that comes back with a normal
  // window is asked again by the app).
  /** @param {{ spaceId: string, fullscreen?: boolean }} message */
  async openSpaceWindow({ spaceId, fullscreen = true }) {
    const s = await load();
    if (!s.spaces.some((sp) => sp.id === spaceId)) throw new Error('no such space');
    const { front, rest } = M.spaceWindowTabs(s, spaceId);
    markMarginOpening();
    if (front) noteReopened(front.url);
    const props = { focused: true, ...(front ? { url: front.url } : {}) };
    let win;
    try {
      win = await api.windows.create({ ...props, ...(fullscreen ? { state: 'fullscreen' } : {}) });
    } catch {
      win = await api.windows.create(props); // a browser that won't make it full screen at once
    }
    const tab = win.tabs?.[0] ?? (await api.tabs.query({ windowId: win.id }).catch(() => []))[0] ?? null;
    await mutate((st) => {
      let next = M.setActiveSpace(st, win.id, spaceId);
      if (tab) {
        next = M.upsertTab(next, tab, now());
        if (front && next.keptTabs?.[front.id]) next = M.linkKept(next, tab.id, front.id, now());
        next = M.moveTab(next, tab.id, spaceId);
      }
      return next;
    });
    if (rest.length) setTimeout(() => void openKeptBehind(win.id, spaceId, rest.map((k) => k.id)), SPACE_WINDOW_REST_MS);
    // Its bounds as Safari gave them, and the window list sent now: the app binds the window as made
    // by Margin from them before the list's next look (app/HANDOFF.md §1.6). One full-screen request
    // only: macOS puts a window made while Safari has one in full screen there itself.
    void appLink.windowsNow?.();
    const bounds = [win.left, win.top, win.width, win.height].every(Number.isFinite) && win.width > 0 && win.height > 0
      ? { left: win.left, top: win.top, width: win.width, height: win.height } : null;
    return { windowId: win.id, state: win.state ?? 'normal', tabId: tab?.id ?? null, ...(bounds ? { bounds } : {}) };
  },
  // The app's switch closing this profile's window (its tabs are kept, not open: a window closing).
  // Never past `notAfter`, and not while another windows call for it is pending (handoff.js).
  /** @param {{ windowId: number, notAfter?: number }} message */
  async closeWindow(message) {
    return windowCall('closeWindow', message, async () => {
      await api.windows.remove(message.windowId);
      return null;
    });
  },
  // The app's switch bringing a window of this profile to the front (macOS
  // slides to its Space), in full screen if asked. As closeWindow: never past `notAfter`, one at a time.
  /** @param {{ windowId: number, fullscreen?: boolean, notAfter?: number }} message */
  async focusWindow(message) {
    const { windowId, fullscreen = false } = message;
    return windowCall('focusWindow', message, async () => {
      const w = await api.windows.update(windowId, { focused: true, ...(fullscreen ? { state: 'fullscreen' } : {}) })
        .catch(() => api.windows.update(windowId, { focused: true }));
      return { windowId, state: w?.state ?? null };
    });
  },
  // Margin.app's profile handoff (app/HANDOFF.md §3.3): a window to full screen or normal, its focus
  // left alone unless asked; answered once Safari says it's there (background/handoff.js).
  /** @param {{ windowId: number, state: 'fullscreen' | 'normal', focused?: boolean, notAfter?: number }} message */
  async setWindowState(message) {
    return setWindowState(message);
  },
  // The handoff's look at the window's tab in front (R3): it nudges and counts its frames at the
  // full-screen size (shared/frame-probe.js); `{ none }` when no page answers in `timeoutMs`.
  /** @param {{ windowId: number, width: number, height: number, frames?: number, nudgeMs?: number, timeoutMs?: number }} message */
  async frameProbe({ windowId, width, height, frames = 6, nudgeMs = 80, timeoutMs = 400 }) {
    if (!Number.isInteger(windowId)) throw new Error('no window');
    return probeWindow(windowId, { width, height, frames, nudgeMs, timeoutMs });
  },
  // The window's tabs with typed text not sent, before the app closes it (background/sleep.js).
  /** @param {{ windowId: number }} message */
  async windowDrafts({ windowId }) {
    if (!Number.isInteger(windowId)) throw new Error('no window');
    return windowDrafts(windowId);
  },
  // A page's scroll as it's hidden or left (content/core.js), kept on its tab's record for its
  // Margin tab (background/scroll-record.js, DATA.md "The scroll record").
  /** @param {{ y: number, url: string }} message */
  async pageScroll({ y, url }, sender) {
    await keepScroll(sender?.tab?.id, url, y);
    return null;
  },
  // A reopened Margin tab's page asking where it was scrolled, once: the place, or null.
  /** @param {{ url: string }} message */
  async takeScroll({ url }, sender) {
    return takeScroll(sender?.tab?.id, url);
  },
  // The order of this profile's spaces as the app's order across profiles has them.
  /** @param {{ spaceIds: string[] }} message */
  async orderSpaces({ spaceIds }) {
    if (!Array.isArray(spaceIds)) return;
    await mutate((s) => M.orderSpaces(s, spaceIds));
  },
  // ⌘T: Margin's new-tab page asks (newTabHandOff below), unless the
  // background already handed the tab off as it was created.
  // An address chosen on Margin's new-tab page, drawn by Margin.app's
  // overlay (its launcher): opened in that tab, as the page's own does.
  // A key Margin.app holds while it draws the UI, heard by a page anyway
  // (⌘T: left to the app; a tab or space key: done here, as the page asked
  // with `navigate`): the app is told, for its log (why its keys were off).
  async appKeyHeard({ command }, sender) {
    console.info(`[margin] ${command} heard in a page while Margin.app draws the UI`);
    appLink.push(sender?.tab?.windowId ?? null, { type: 'keyHeard', command: String(command), from: 'page' });
  },
  // A button of one of Margin's notices, chosen in Margin.app's overlay
  // (background/notices.js, shared/notices.js): done here, and the notice
  // isn't said again for that page. Whether it was a notice's button.
  /** @param {{ notice: string, action: string, tabId?: number }} message */
  async noticeAction({ notice, action, tabId }) {
    if (!isNoticeAction(notice, action)) return false;
    const tab = Number.isInteger(tabId) ? await api.tabs.get(/** @type {number} */ (tabId)).catch(() => null) : null;
    noticeAnswered(notice, tab?.id ?? null, notice === 'new-tab-setting' ? null : tab?.url ?? null);
    console.info(`[margin] notice ${notice}: ${action}${tab ? ` (tab ${tab.id})` : ''}`);
    if (notice === 'not-responding' && action === 'reload' && tab) return reloadCutOff(tab.id);
    if (notice === 'new-tab-setting' && action === 'never') await mutate((s) => ({ ...s, settings: { ...s.settings, newTabHint: false } }));
    return true;
  },
  // The page in front being left, or a site's own same-page navigation under
  // way (content/loads.js), for Margin.app's sidebar (background/page-loads.js).
  /** @param {{ on: boolean, why: 'leaving' | 'navigating' }} message */
  async pageLoading({ on, why }, sender) {
    if (sender?.tab?.id == null) return;
    pageLoads.pageSaid(sender.tab.id, sender.tab.windowId ?? null, !!on, why);
  },
  // A trackpad gesture Margin runs in the page (content/trackpad.js), as it
  // goes: its feedback, drawn by Margin.app's overlay of the window.
  /** @param {{ kind: 'pull' | 'swipe', state: string, progress?: number, direction?: number }} message */
  async gesture({ kind, state, progress = 0, direction = 0 }, sender) {
    if (sender?.tab?.id == null || (kind !== 'pull' && kind !== 'swipe')) return;
    appLink.push(sender.tab.windowId ?? null, { type: 'gesture', tabId: sender.tab.id, kind, state: String(state), progress: Number(progress) || 0, direction: Number(direction) || 0 });
  },
  async openHere({ tabId, url }) {
    if (!Number.isInteger(tabId) || typeof url !== 'string' || !/^(https?|file):/i.test(url)) throw new Error('not an address');
    const tab = await api.tabs.get(tabId);
    if (!V.isNewTabPage(tab.url || tab.pendingUrl)) throw new Error('not a new-tab page');
    // Its row is the address at once, not "+ New Tab" (state/model.js goingTo).
    await mutate((s) => M.goingTo(s, tabId, { url, title: '' }, now())).catch(() => {});
    await api.tabs.update(tabId, { url });
    return { shown: tabId };
  },
  async newTabPage(_, sender) {
    void newTabPageSeen(sender.tab);
    if (!sender.tab) return { app: false };
    if (await newTabHandOff(sender.tab)) return { handled: true };
    // Margin.app linked: the new-tab page draws nothing, the app's overlay
    // draws its launcher there and opens the palette over it. Not linked, or
    // in a window the app draws nothing over, the page shows its notice and
    // address field (newtab/newtab.js).
    if (appLink.linked() && appLink.drawsWindow(sender.tab.windowId) && !paletteDroppedRecently(sender.tab.windowId)) return { app: true, openPalette: appLink.push(sender.tab.windowId, { type: 'palette', newTab: false }) };
    return { app: false };
  },
  // Margin.app couldn't show the palette pushed for a window (no overlay shown there within its hold):
  // for ⌘T's hand-off (`newTab`: Safari's new tab already closed), Margin's new-tab page opens there
  // instead, so the key still opens something; and ⌘T there keeps Safari's new tab for a while.
  /** @param {{ windowId?: number, newTab?: boolean }} message */
  async paletteDropped({ windowId, newTab }, sender) {
    if (!sender?.app) return false; // the app's word only
    const id = Number.isInteger(windowId) ? /** @type {number} */ (windowId) : sender?.tab?.windowId;
    if (!Number.isInteger(id)) return false;
    paletteDroppedAt.set(id, Date.now());
    appLink.note(`the app couldn't show the palette over window ${id}${newTab ? ': Margin\'s new-tab page opened there' : ''}`);
    if (newTab) await newTabKey({ windowId: id });
    return true;
  },
  // ⌘T reaching a page while Margin.app isn't linked, or in a window it draws nothing over
  // (content/core.js): Margin's new-tab page.
  async newTabKey(_, sender) {
    await newTabKey(sender?.tab ?? null);
  },
  // The new-tab page's "Start Margin.app" (not linked): the link asked for
  // now, which has Margin's extension handler start the app if it isn't
  // running (background/link.js). False where there's no link (Chrome, a
  // copy that doesn't own the state).
  async startApp() {
    return appLink.askNow();
  },
  // The new-tab page's "Try again" while Margin turned its link off (its socket guard,
  // background/link.js): sockets on again and the link asked for now. A person's choice only.
  async retryLink() {
    return appLink.retrySockets();
  },
  // Escape in the palette of a fresh new tab (⌘T; newtab/newtab.js):
  // back to the tab the user was on, and this one closes, as if no tab had
  // been opened. The window's only tab (⌘N) stays, with the start page.
  async cancelNewTab(_, sender) {
    const tab = sender.tab;
    if (!tab) return;
    const prev = previousTab(await load(), tab);
    if (!prev) return;
    await focusTab(prev.id, { source: 'cancelNewTab' });
    noteClosing([tab.id], 'done');
    await api.tabs.remove(tab.id).catch(() => {});
  },
  // Answered as soon as the press is queued, not once its switch is over: a
  // page's listener that hears nothing back (a page cut off from Margin, its
  // messages going nowhere) stands aside for the keys, and must not take a
  // long switch for that (shared/shortcuts.js). True: taken.
  // `target`, `switchId`: Margin.app's overlay's own pick for a next/previous-tab key, highlighted as it was pressed
  // (background/navigation.js navigate `given`).
  /** @param {{ action: string, target?: number, switchId?: string }} message */
  async navigate({ action, target, switchId }, sender) {
    if (!NAV_ACTIONS.has(action)) return false;
    const windowId = sender.tab?.windowId ?? (await api.windows?.getLastFocused())?.id;
    // The app's key and a page's keydown are two sources (one press heard by both counts once).
    void navigate(action, sender.app ? 'app' : 'page', windowId, { target, switchId });
    return true;
  },
  /** @param {{ patch: Record<string, any> }} message */
  async updateSettings({ patch }) {
    // Not a theme Margin has: a built-in, or one in Margin.app's index of imported themes (userThemes).
    if ('theme' in patch && !THEMES[patch.theme] && !PACKAGE_THEMES.includes(patch.theme) && !(await userThemeListed(patch.theme))) return;
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  },
  // "Margin full screen" on or off for this window (Chrome; background/fullscreen.js).
  /** @param {{ windowId?: number }} message */
  async toggleFullscreen({ windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id == null || !platform?.marginFullscreen) return null;
    return toggleMarginFullscreen(id);
  },
  // Whether this page's window is in full screen (Chrome, "only in full screen").
  async windowState(_, sender) {
    const id = sender.tab?.windowId;
    return { fullscreen: id != null && platform?.marginFullscreen ? await isFullscreen(id) : false };
  },
  // Margin.app's index of the themes the person imported (app/shell/ThemeStore.swift: they're the
  // Mac's, kept by the app; a copy holds only the list, never a package), sent as a copy links and
  // whenever it changes. Kept in storage.local (`userThemes`) for updateSettings and the theme's settings.
  /** @param {{ list: any[] }} message */
  async userThemes({ list }) {
    if (!Array.isArray(list)) return false;
    const clean = list.slice(0, 50).filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && USER_THEME_ID.test(e.id) && !PACKAGE_THEMES.includes(e.id))
      .map((e) => ({ id: e.id, name: String(e.name ?? '').slice(0, 60), version: String(e.version ?? '').slice(0, 16), author: String(e.author ?? '').slice(0, 80) }));
    await api.storage.local.set({ [USER_THEMES_KEY]: clean });
    return true;
  },
  // A theme's own settings (settings.themes[themeId]), merged into what's
  // there (updateSettings replaces whole top-level keys).
  /** @param {{ themeId: string, patch: object }} message */
  async updateThemeSettings({ themeId, patch }) {
    const theme = THEMES[themeId];
    if (!theme) return updatePackageThemeSettings(themeId, patch);
    await mutate((s) => {
      const themes = s.settings.themes ?? {};
      const own = theme.settingsOf({ themes: { [themeId]: { ...themes[themeId], ...patch } } });
      return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
    });
  },
  // The page's script in the page's world, for a page that didn't get it from
  // its registration (content/page-link.js): `left` (where its box starts
  // until it's told: content/page/main.js), then the script.
  /** @param {{ left?: number }} message */
  async injectPage({ left }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null || !api.scripting?.executeScript) return false;
    const target = { tabId };
    await api.scripting.executeScript({
      target, world: 'MAIN', injectImmediately: true, args: [left ?? null],
      func: (at) => { /** @type {any} */ (window)[Symbol.for('margin.page.start')] = { left: at ?? undefined }; },
    });
    await api.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, files: ['content/page.bundle.js'] });
    return true;
  },
  // A style sheet the page can't read (another origin's, no CORS:
  // content/page-link.js). No cookies, as a <link> of another origin needs none.
  // The page gets the text, so this is only for real style sheets that it could
  // load anyway: not a local network's unless it's on one, after any redirect.
  // Null if it can't be had (Safari's per-site grants can refuse it): the
  // sheet then stays as it is.
  /** @param {{ url: string }} message */
  async fetchStyle({ url }, sender) {
    const pageUrl = sender?.tab?.url ?? sender?.url ?? '';
    if (!styleUrlAllowed(url, pageUrl)) return null;
    if (styleCache.has(url)) return styleCache.get(url);
    const text = await fetch(url, { credentials: 'omit' }).then((res) => {
      const css = /^text\/css\b/i.test(res.headers.get('content-type') ?? '');
      return res.ok && css && styleUrlAllowed(res.url, pageUrl) ? res.text() : null;
    }).catch(() => null);
    if (text == null) return null;
    if (text.length > STYLE_MAX_CHARS) {
      console.warn('[margin] a style sheet too large to rewrite', url, text.length);
      return null;
    }
    if (text.length > STYLE_CACHED_MAX_CHARS) return text;
    styleCache.set(url, text);
    let chars = 0;
    for (const kept of styleCache.values()) chars += kept.length;
    for (const oldest of styleCache.keys()) {
      if (styleCache.size <= STYLE_CACHE_SIZE && chars <= STYLE_CACHE_CHARS) break;
      chars -= styleCache.get(oldest).length;
      styleCache.delete(oldest);
    }
    return text;
  },
};
