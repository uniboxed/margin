import { openKept } from './kept.ts';
// What pages ask the background for: runtime messages { type, ...payload },
// answered { ok, result } or { ok: false, error } (background.ts routes
// them). types/margin.d.ts derives the protocol's types from this object.
import type { State, TabRecord } from '../../types/margin';
import { capabilities } from '../shared/capabilities.ts';
import * as M from '../state/model.ts';
import * as V from '../shared/view.ts';
import * as S from '../shared/search.ts';
import { api, load, mutate, newId, now, thisCopy } from './store.ts';
import { focusTab, reloadCutOff, handingOff, instanceId, keepHandedOff, markMarginOpening, openBehind, openTab, openedByMargin, resolveTab } from './tabs.ts';
import { sleepIdle, wakeAll } from './sleep.ts';
import { setWindowState, windowCall } from './handoff.ts';
import { ownSearchTabs, ownSearchUrls, OWN_SEARCH_MS } from './search-engine.ts';
import { iconInflight, iconUrlAllowed, learnIcon } from './site-icons.ts';
import { navigate, NAV_ACTIONS, showSpace } from './navigation.ts';
import { THEMES } from '../themes/index.ts';
// This engine's own modules (Safari's set-up messages and new-tab note, Chromium's full screen), or null.
import { engine } from '#engine';
import { getScroll, setScroll } from './scroll.ts';
import { keepScroll, takeScroll } from './scroll-record.ts';
import { closeTabs, noteClosing } from './closing.ts';
import * as away from './away.ts';
import { appLink } from './app-link.ts';
import { createHostedTabs, type HostedTabsApi } from './hosted.ts';
import { createMediaRegistry } from './media.ts';
import { matchAirTrafficRule } from '../shared/air-traffic.ts';
import { shrinkPicture } from './picture.ts';
import { noticeAnswered } from './notices.ts';
import { isNoticeAction } from '../shared/notices.ts';
import * as pageLoads from './page-loads.ts';
import { moveIndex } from '../ui/behaviors/drop-rules.ts';
import { MAX_SETTINGS, PACKAGE_THEMES, SETTING_NAME, USER_THEMES_KEY, USER_THEME_ID, plainSetting } from '../themes/packages.ts';

// The tab a nav request is for: the one named, the page's own, or the one
// in front of the window.
async function frontTab(tabId: number | undefined, windowId: number | undefined, sender: BrowserMessageSender) {
  if (Number.isInteger(tabId)) return tabId;
  const win = windowId ?? sender?.tab?.windowId;
  if (win == null) return sender?.tab?.id ?? null;
  const [front] = await api.tabs.query({ active: true, windowId: win }).catch(() => []);
  return front?.id ?? null;
}

// A package theme's settings (themes/packages.ts: a built-in one, or one the
// user imported), merged into what's saved: names as theme.json's, plain
// values, at most MAX_SETTINGS. The theme's spec checks each value again
// where it's applied (ui/theme-loader.ts resolveSettings).
/** Is `id` one of the person's imported themes (Margin.app's index, storage.local userThemes)? */
async function userThemeListed(id: unknown) {
  if (typeof id !== 'string') return false;
  const index = (await api.storage.local.get(USER_THEMES_KEY).catch((): Record<string, any> => ({})))?.[USER_THEMES_KEY];
  return Array.isArray(index) && index.some((e) => e?.id === id);
}

async function updatePackageThemeSettings(themeId: string, patch: object) {
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
// says what it shows (background.ts onCreated; Chrome does), else when the
// page asks (newTabPage): every moment the new tab is in front shows. In the
// order that shows least of it: out of the sidebar first, the palette ready
// before its page is back, no wake (it was shown a moment ago). False when
// it can't (a new window, a previous tab that isn't a web page, Margin.app
// not linked): the new-tab page stays (linked, the app's palette opens over
// it; not linked, it says the app isn't running: newtab/newtab.ts).
const handOffs = new Map(); // tab id → Promise<boolean>, once per tab
// The tab the user was on: the window's active one (Chrome reports the new
// tab before activating it), else the one most recently left. Not by
// lastActive alone: a switch gives both its tabs the same one.
function previousTab(s: State, tab: BrowserTab) {
  return Object.values(s.tabs)
    .filter((t) => t.windowId === tab.windowId && t.id !== tab.id)
    .sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
}
export function newTabHandOff(tab: BrowserTab) {
  if (!handOffs.has(tab.id)) handOffs.set(tab.id, handOff(tab).finally(() => setTimeout(() => handOffs.delete(tab.id), 30000)));
  return handOffs.get(tab.id);
}
async function handOff(tab: BrowserTab) {
  // One line per new tab, so what Safari did (⌘T vs ⌘N, a new window or a
  // tab — macOS can turn ⌘N into a tab) is visible in the background console.
  const log = (decision: string, why: string) => console.info(`[margin] new tab ${tab.id} in window ${tab.windowId}: ${decision} (${why})`);
  const prev = previousTab(await load(), tab);
  if (!prev) return log('palette on the new-tab page', 'no other tab in this window: a new window'), false;
  // The Mac app's set-up window: Safari's own New Tab made a tab (its ⌘T, its
  // + button, its File menu). Not a tab Margin opened itself (newTabKey below).
  if (!openedByMargin()) engine.onboarding?.reportEvent('safariNewTab');
  if (!/^https?:/.test(prev.url)) return log('palette on the new-tab page', `tab ${prev.id} isn't a web page`), false;
  // Not linked to Margin.app: no palette to hand off to (pages draw none of
  // Margin's UI); the new-tab page stays, with its notice and address field.
  if (!appLink.linked()) return log('kept', 'Margin.app isn\'t linked: no palette'), false;
  // Linked, but the app draws nothing over this window (`drawn`: not in full screen, or not found
  // among the window server's yet): no palette to hand off to there either.
  if (!appLink.drawsWindow(tab.windowId)) return log('kept', 'Margin.app draws nothing over this window: no palette there'), false;
  handingOff.add(tab.id);
  // The app's palette opens over the page the user was on, in the window's
  // overlay.
  if (!appLink.push(tab.windowId, { type: 'palette', newTab: true })) {
    keepHandedOff(tab.id);
    return log('palette on the new-tab page', 'the link to Margin.app went meanwhile'), false;
  }
  // Still the untouched new tab in front? The user may have typed an address
  // meanwhile, switched away, or another extension opened it to navigate it
  // (background.ts onUpdated then lets it go): it stays.
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
    return log('kept', `tab ${prev.id} didn't come back: ${(err as Error | undefined)?.message ?? err}`), false;
  }
  await mutate((st) => M.removeTab(st, tab.id)).catch(() => {});
  noteClosing([tab.id], 'done');
  await api.tabs.remove(tab.id).catch(() => {});
  return true;
}

// ⌘T as Margin's own shortcut (Safari's manifest `new-tab`, with Safari's
// File › New Tab moved to another shortcut, DECISIONS.md): Safari matches it
// in the app, wherever the focus is. The page in front opens its palette to
// choose a new tab (no tab created: no flicker); Margin's new-tab page does
// what its "+ New Tab" does; anything else (Safari's own pages, PDFs, sites
// Margin can't reach) gets a new tab with Margin's new-tab page, as Safari's
// ⌘T did (its palette opens there).
// Not linked to Margin.app (linked, the app holds ⌘T: background.ts), so
// with no palette to open: Margin's new-tab page, which says the app isn't
// running and has an address field; on that page already, its field. One
// press can come both as Safari's command and as the key in the page
// (content/core.ts): taken once per window.
const NEW_TAB_KEY_ONCE_MS = 600;
const newTabKeyAt = new Map(); // window id → when
export async function newTabKey(tabArg: { windowId: number | undefined; } | BrowserTab | null | undefined) {
  engine.onboarding?.reportEvent('cmdTKey');
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


// Whether Margin.app draws the UI for a page's window (background/link.ts):
// in `hello`, so a page knows at once.
// `drawn`: whether the app said it draws over the window (left out: not said).
const appState = (windowId: number | null) => {
  if (appLink.pageState() === 'off') return null;
  const drawn = appLink.drawn(windowId);
  return { state: appLink.pageState(), ...(typeof drawn === 'boolean' ? { drawn } : {}) };
};

const launcherOpening = new Map<string, Promise<{ tabId: number, shown: number }>>();
// Margin.app hosting this profile's window in its page area (background/hosted.ts): its items' tabs.
const hostedTabs = createHostedTabs(() => api.tabs as unknown as HostedTabsApi, shrinkPicture);
const mediaRegistry = createMediaRegistry();

export const handlers = {
  // A page starting: which tab and window it is, this copy, whether the window is in Margin's
  // full screen (Chrome), Margin.app's word on the link and the window's layout.
  async hello(_message: object, sender: BrowserMessageSender) {
    engine.onboarding?.pageLoaded();
    const windowId = sender.tab?.windowId ?? null;
    const fullscreen = windowId != null && capabilities?.marginFullscreen && engine.fullscreen ? await engine.fullscreen.isFullscreen(windowId) : false;
    // `since`: with the page's own address, which copy's tab ids it may trust (shared/stored.ts).
    return { tabId: sender.tab?.id ?? null, windowId, instanceId, fullscreen, app: appState(windowId), since: thisCopy().since };
  },
  // Whether this copy owns the state: only an owner answers this (the others
  // say `stale`, background.ts), after checking the stored owner again.
  async owner() {
    return true;
  },
  // Answers which tab came to the front ({ shown }), or fails: the tab is
  // gone, or the browser didn't show it (the page then says so).
  // `tabId` a string: a Margin tab that isn't open (state/model.ts keptTabs),
  // opened in `windowId` (else the page's own window), in its place.
  /** @param message `hint`: the row's tab address and place (background/tabs.ts resolveTab); `deadline`: when the page stops waiting (no switch after it); `sidebarTop`: the list's scroll, kept for the window; `resolved`: the tab background.ts found by that address already (not asked for again) */
  async activateTab({ tabId, windowId, hint, sidebarTop, deadline, resolved = null }: { tabId: number | string, windowId?: number, hint?: { url?: string, index?: number, title?: string }, sidebarTop?: number, deadline?: number, resolved?: any }, sender: BrowserMessageSender) {
    if (typeof tabId === 'string') return openKept(tabId, { windowId: windowId ?? sender?.tab?.windowId, deadline, sidebarTop });
    const target = resolved ?? (await resolveTab(tabId, hint, sender.tab?.windowId, { deadline }));
    if (!target) throw new Error('That tab is no longer open');
    if (Number.isFinite(sidebarTop) && sender.tab?.windowId != null) void setScroll(sender.tab.windowId, sidebarTop as number); // (finite: checked)
    // In another window of the profile: it comes to this one, the other keeps it chosen, away (docs/BROWSER-WINDOWS.md §9).
    const here = windowId ?? sender?.tab?.windowId;
    if (here != null && target.windowId != null && target.windowId !== here && away.follows(here)) {
      await away.bringTab(target, here, { source: 'activateTab', deadline });
      return { shown: target.id };
    }
    await focusTab(target.id, { source: 'activateTab', deadline });
    return { shown: target.id };
  },
  // Margin's stand-in page (away/away.html): what its window shows away, with its picture (background/away.ts).
  async awayShown(_message: object, sender: BrowserMessageSender) {
    return away.shownAway(sender?.tab?.windowId);
  },
  // The stand-in clicked: its window's away tab back to it.
  async bringAway(_message: object, sender: BrowserMessageSender) {
    const windowId = sender?.tab?.windowId;
    const s = await load();
    const tabId = windowId != null ? s.awayByWindow?.[windowId] : null;
    const tab = tabId != null ? await Promise.resolve(api.tabs.get(tabId)).catch(() => null) : null;
    if (!tab || windowId == null) return { shown: null };
    await away.bringTab(tab, windowId, { source: 'stand-in' });
    return { shown: tab.id };
  },
  // Settings' "Wake all sleeping tabs" (background/sleep.ts): how many it woke.
  async wakeSleeping() {
    return wakeAll();
  },
  // A pass of sleeping tabs now (background/sleep.ts), for tabs unused for
  // `afterMs` (the setting's hours if left out): for checks by hand and the
  // WebKit host. What it did.
  async sleepNow({ afterMs, max }: { afterMs?: number, max?: number } = {}) {
    // (Finite, whole: numbers.)
    return sleepIdle({ ...(Number.isFinite(afterMs) && (afterMs as number) >= 0 ? { afterMs } : {}), ...(Number.isInteger(max) && (max as number) > 0 ? { max } : {}) });
  },
  // The sidebar's scroll position in this page's window (background/scroll.ts).
  async sidebarScroll({ windowId }: { windowId?: number }, sender: BrowserMessageSender) {
    const id = windowId ?? sender.tab?.windowId;
    return id == null ? 0 : getScroll(id);
  },
  async setSidebarScroll({ top, windowId }: { top: number, windowId?: number }, sender: BrowserMessageSender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id != null && Number.isFinite(top)) await setScroll(id, top as number);
  },
  // Closing from Margin archives the tab, like Arc. One that isn't open (a
  // string id: state/model.ts keptTabs) goes to the archive as it is.
  // A sticky-pinned tab unloads & resets without archiving.
  async closeTab({ tabId }: { tabId: number | string }) {
    if (typeof tabId === 'string') {
      await mutate((s) => {
        const k = s.keptTabs[tabId];
        if ((k?.pinnedBy && s.pins.some((p) => p.id === k.pinnedBy)) || (k?.favoriteId && (s.favorites ?? []).some((f) => f.id === k.favoriteId))) return M.forgetKept(s, tabId);
        return M.archiveKept(s, tabId, { id: newId(), closedAt: now() });
      });
      return;
    }
    await mutate((s) => {
      const tab = s.tabs[tabId];
      if (!tab) return s;
      if ((tab.pinnedBy && s.pins.some((p) => p.id === tab.pinnedBy)) || (tab.favoriteId && (s.favorites ?? []).some((f) => f.id === tab.favoriteId))) return s;
      return /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
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
  async restoreArchive({ archiveId, windowId, replaceTabId }: { archiveId: string, windowId?: number, replaceTabId?: number }) {
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
  // Search with the browser's engine: in `tabId`, else in a new tab (from a
  // page: behind it until the results have loaded, tabs.ts openBehind).
  async search({ query, windowId, tabId, deadline }: { query: string, windowId?: number, tabId?: number, deadline?: number }, sender: BrowserMessageSender) {
    const text = String(query ?? '').trim();
    if (!text) return;
    const from = sender?.tab?.id != null ? sender.tab : null;
    if (capabilities?.search === 'browser' && api.search?.query) {
      if (tabId != null) return void (await api.search.query({ text, tabId }));
      if (from) return openBehind({ windowId, from, deadline, label: text, then: (tab) => api.search!.query({ text, tabId: tab.id }) }); // (checked above)
      return void (await api.search.query({ text, disposition: 'NEW_TAB' }));
    }
    const { settings } = await load();
    const url = S.searchUrl(text, settings);
    const own = { at: now(), template: S.safariEngine(settings).template };
    for (const map of [ownSearchTabs, ownSearchUrls]) for (const [key, entry] of map) if (now() - entry.at > OWN_SEARCH_MS) map.delete(key);
    // Its row says the search at once, not the page it leaves (state/model.ts goingTo).
    const going = (id: number) => mutate((s) => M.goingTo(s, id, { url, title: text }, now())).catch(() => {});
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
    // Shown (opened in front): the UI's switch to it went through (shared/switching.ts `failed`).
    return { tabId: tab.id, shown: tab.id };
  },
  // An address from a page (the palette): behind it until loaded (tabs.ts
  // openBehind). Margin's new-tab page, or a space's start page, at once.
  async newTab({ windowId, url, spaceId, deadline }: { windowId?: number, url?: string, spaceId?: string, deadline?: number }, sender: BrowserMessageSender) {
    if (/^margin:\/\/settings\/?$/i.test(url ?? '')) return handlers.openLauncher({ windowId: windowId ?? sender?.tab?.windowId, settings: true });
    let routedSpace = spaceId;
    if (!routedSpace && url) {
      const s = await load();
      const matched = matchAirTrafficRule(url, s.airTraffic, new Set(s.spaces.map((sp) => sp.id)));
      if (matched) routedSpace = matched.spaceId;
    }
    if (url && !routedSpace && sender?.tab?.id != null) return openBehind({ windowId, url, from: sender.tab, deadline });
    const tab = await openTab({ windowId, url, spaceId: routedSpace, deadline });
    return { tabId: tab.id };
  },
  // `folderId`/`beforeId`: where the pin goes (a folder of the tab's space,
  // before a pin or folder there; dragged in the sidebar); the end of the
  // pinned area by default. Returns the new pin's id.
  // A tab that isn't open (a string id: state/model.ts keptTabs) becomes the
  // pin: its pin opens it from then on.
  async pinTab({ tabId, folderId = null, beforeId = null }: { tabId: number | string, folderId?: string | null, beforeId?: string | null }) {
    const s = await load();
    const kept = typeof tabId === 'string' ? s.keptTabs?.[tabId] : null;
    const tab = kept ?? (typeof tabId === 'number' ? s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null)) : null);
    if (!tab?.url) return console.warn('[margin] pin: unknown tab', tabId);
    let result = 'pinned';
    const id = newId();
    await mutate((st) => {
      // A tab Margin hasn't placed in a space yet goes to its window's space.
      // (Not a kept tab: an open one, with its window.)
      const spaceId = kept ? kept.spaceId : st.tabSpace[tabId as number] ?? V.activeSpaceId(st, (tab as TabRecord).windowId);
      let next = M.addPin(st, { id, spaceId, url: tab.url, title: tab.title, folderId, beforeId });
      if (next === st) {
        result = 'not pinned (already pinned in that space, or no space)';
        return st;
      }
      if ((tab as TabRecord).customTitle) next = M.renamePin(next, id, (tab as TabRecord).customTitle!);
      if (kept) return M.forgetKept(next, kept.id);
      if (typeof tabId === 'number') next = M.bindTabToPin(next, tabId, id);
      return next;
    });
    console.info(`[margin] pin tab ${tabId}: ${result}`);
    return result === 'pinned' ? id : null;
  },
  // ---- folders of pins (state/model.ts) ----
  // A folder in this window's space (or `spaceId`), holding the pins
  // `pinIds`, or the tab `tabId` pinned into it; at the top level before
  // `beforeId` (else in the place of the first pin it takes, else the end).
  // Returns its id.
  /** @param message `tabId` a string: a tab that isn't open (pinned into it, it's the pin from then on) */
  async createFolder({ windowId, spaceId, name, pinIds = [], tabId, parentId = null, beforeId = null }: { windowId?: number, spaceId?: string, name?: string, pinIds?: string[], tabId?: number | string, parentId?: string | null, beforeId?: string | null }, sender: BrowserMessageSender) {
    const id = newId();
    const pinFromTab = Number.isInteger(tabId) || typeof tabId === 'string' ? newId() : null;
    const s = pinFromTab ? await load() : null;
    const kept = typeof tabId === 'string' ? s?.keptTabs?.[tabId] ?? null : null;
    // (A number that isn't a whole one names no tab: `s` wasn't read for it.)
    const tab = kept ?? (typeof tabId === 'number' && s ? (s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null))) : null);
    let created = false;
    await mutate((st) => {
      const parent = parentId ? (st.folders ?? []).find((f) => f.id === parentId) : null;
      const space = spaceId ?? parent?.spaceId ?? (kept ? kept.spaceId : tab ? st.tabSpace[tab.id as number] : null) ?? V.activeSpaceId(st, windowId ?? sender?.tab?.windowId);
      const firstPin = st.pins.find((p) => p.id === pinIds[0] && p.spaceId === space);
      // In the place of the first pin it takes, if that's at the top level.
      const before = beforeId ?? (firstPin && !firstPin.folderId ? firstPin.id : null);
      let next = M.createFolder(st, { id, spaceId: space, name, pinIds, parentId: parent?.id ?? null, beforeId: before });
      if (next === st) return st;
      created = true;
      // (A tab is found only when one was asked for: then the pin has its id.)
      if (tab?.url) {
        next = M.addPin(next, { id: pinFromTab!, spaceId: space, url: tab.url, title: tab.title, folderId: id });
        if (typeof tabId === 'number') next = M.bindTabToPin(next, tabId, pinFromTab!);
      }
      return kept ? M.forgetKept(next, kept.id) : next;
    });
    return created ? id : null;
  },
  async renameFolder({ folderId, name }: { folderId: string, name: string }) {
    await mutate((s) => M.renameFolder(s, folderId, name));
  },
  async setFolderOpen({ folderId, open }: { folderId: string, open: boolean }) {
    await mutate((s) => M.setFolderOpen(s, folderId, open));
  },
  /** @param message the folder goes; its pins stay */
  async deleteFolder({ folderId }: { folderId: string }) {
    await mutate((s) => M.deleteFolder(s, folderId));
  },
  async movePin({ pinId, folderId = null, beforeId = null }: { pinId: string, folderId?: string | null, beforeId?: string | null }) {
    await mutate((s) => M.movePin(s, pinId, { folderId, beforeId }));
  },
  async moveFolder({ folderId, parentId = null, beforeId = null }: { folderId: string, parentId?: string | null, beforeId?: string | null }) {
    await mutate((s) => M.moveFolder(s, folderId, { parentId, beforeId }));
  },
  async nestFolder({ folderId, parentId = null, beforeId = null }: { folderId: string, parentId?: string | null, beforeId?: string | null }) {
    await mutate((s) => M.moveFolder(s, folderId, { parentId, beforeId }));
  },
  // A tab dragged in the sidebar's list, next to another (`side`: above it,
  // 'before', or below, 'after', as the list shows them: newest at the top,
  // the reverse of the window's order). Safari's own tab order follows, and
  // the sidebar with it (background.ts tabs.onMoved).
  // Whether it moved (not: the browser can't, a tab is gone, or one is the
  // browser's own pinned tab, kept apart from the others).
  // A tab that isn't open (a string id) takes a place in the list next to the
  // other (state/model.ts placeKept); an open one next to one that isn't
  // open doesn't move (its place follows the browser's tab strip).
  async moveTab({ tabId, hint, nextTo, nextToHint, side }: { tabId: number | string, hint?: any, nextTo: number | string, nextToHint?: any, side: 'before' | 'after' }, sender: BrowserMessageSender) {
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
      // Next to one in another window (the list is the space's: docs/BROWSER-WINDOWS.md §9): a place in the list beside it,
      // and the tab where that place falls in its own window's strip.
      const before = await load();
      const spaceId = before.tabSpace[tab.id];
      if (!spaceId || before.tabSpace[other.id] !== spaceId) return false;
      const after = await mutate((s) => M.placeOpen(s, tab.id, other.id, side, spaceId));
      const order = after.tabs[tab.id]?.order;
      if (!Number.isFinite(order) || order === before.tabs[tab.id]?.order) return false;
      const strip = Object.values(after.tabs).filter((t) => t.windowId === tab.windowId && t.id !== tab.id);
      // (`order` is finite: checked above.)
      const index = strip.filter((t) => (Number.isFinite(t.order) ? (t.order as number) : t.index) < (order as number)).length;
      if (index === tab.index) return true;
      return api.tabs.move(tab.id, { index }).then(() => true, () => false);
    }
    // Above it in the list: just after it in the window; below it: just before.
    const index = moveIndex(tab.index, other.index, side);
    await mutate((s) => M.placeOpen(s, tab.id, other.id, side, s.tabSpace[tab.id]));
    if (index === tab.index) return false;
    return api.tabs.move(tab.id, { index }).then(() => true, () => false);
  },
  // "Clear" (the canvas designs' Today): the window's space's tabs that
  // aren't pinned close, as the sidebar lists them (shared/view.ts sidebar),
  // archived as closing one does. The tab in front among them: the space's
  // most recent tab left (an open pin) comes to the front first, else its
  // start page opens, so the window stays in the space and isn't left empty.
  // Returns the tabs closed.
  async clearToday({ windowId }: { windowId?: number }, sender: BrowserMessageSender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (win == null) return [];
    const s = await load();
    const spaceId = V.activeSpaceId(s, win);
    const rows = V.sidebar(s, win).tabs;
    // The space's tabs that aren't open go to the archive with the others.
    const keptIds = rows.filter((t) => t.kept).map((t) => ((t.id as unknown) as string));
    const ids = rows.filter((t) => !t.kept).map((t) => (t.id as number));
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
    // list is the space's, docs/BROWSER-WINDOWS.md §9) stays in the space and isn't left empty (Safari closes a window
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
  async goBack({ windowId, tabId }: { windowId?: number, tabId?: number }, sender: BrowserMessageSender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goBack) return false;
    return api.tabs.goBack(id).then(() => true, () => false);
  },
  async goForward({ windowId, tabId }: { windowId?: number, tabId?: number }, sender: BrowserMessageSender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goForward) return false;
    return api.tabs.goForward(id).then(() => true, () => false);
  },
  async reload({ windowId, tabId }: { windowId?: number, tabId?: number }, sender: BrowserMessageSender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null) return false;
    return api.tabs.reload(id).then(() => true, () => false);
  },
  async unpin({ pinId }: { pinId: string }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  /** @param message `deadline`: as activateTab's */
  async openPin({ pinId, windowId, sidebarTop, deadline }: { pinId: string, windowId?: number, sidebarTop?: number, deadline?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    if (Number.isFinite(sidebarTop) && windowId != null) void setScroll(windowId, sidebarTop as number); // (finite: checked)
    // Only a tab of the pin's space (as the sidebar shows it): sticky pinnedBy match first, then normalized URL fallback.
    const key = M.normalizeUrl(pin.url);
    const bound = Object.values(s.tabs).filter((t) => t.pinnedBy === pin.id && s.tabSpace[t.id] === pin.spaceId);
    const matches = bound.length ? bound : Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key && s.tabSpace[t.id] === pin.spaceId);
    // The window asking first.
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) {
      if (existing.pinnedBy !== pin.id) await mutate((st) => M.bindTabToPin(st, existing.id, pin.id));
      // In another window of the profile: it comes here (docs/BROWSER-WINDOWS.md §9).
      await away.showTab(existing.id, windowId ?? sender?.tab?.windowId, { source: 'openPin', deadline });
      return { shown: existing.id };
    }
    // Its tab that isn't open, if the space has one (kept from before it was
    // pinned): opened as that Margin tab.
    const kept = Object.values(s.keptTabs ?? {}).find((k) => k.pinnedBy === pin.id && k.spaceId === pin.spaceId) ?? M.keptForUrl(s, pin.url, pin.spaceId);
    const tab = await openTab({ windowId, url: kept?.url ?? pin.url, spaceId: pin.spaceId, deadline, ...(kept ? { keptId: kept.id } : {}) });
    if (tab?.id != null) await mutate((st) => M.bindTabToPin(st, tab.id, pin.id));
    return { shown: tab.id };
  },
  async resetPin({ pinId, windowId, deadline }: { pinId: string, windowId?: number, deadline?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return null;
    const bound = Object.values(s.tabs).filter((t) => t.pinnedBy === pin.id && s.tabSpace[t.id] === pin.spaceId);
    const existing = bound.find((t) => t.windowId === windowId) ?? bound[0];
    if (existing) {
      await api.tabs.update(existing.id, { url: pin.url, active: true }).catch(() => null);
      await away.showTab(existing.id, windowId ?? sender?.tab?.windowId, { source: 'resetPin', deadline });
      return { shown: existing.id };
    }
    const tab = await openTab({ windowId, url: pin.url, spaceId: pin.spaceId, deadline });
    if (tab?.id != null) await mutate((st) => M.bindTabToPin(st, tab.id, pin.id));
    return { shown: tab.id };
  },
  async renamePin({ pinId, title }: { pinId: string, title: string }) {
    await mutate((s) => M.renamePin(s, pinId, title));
  },
  async renameTab({ tabId, title }: { tabId: number | string, title: string }) {
    await mutate((s) => M.renameTab(s, tabId, title));
  },
  async addFavorite({ tabId, pinId, windowId, beforeId = null }: { tabId?: number | string, pinId?: string, windowId?: number, beforeId?: string | null }, sender: BrowserMessageSender) {
    const s = await load();
    const kept = typeof tabId === 'string' ? s.keptTabs?.[tabId] : null;
    const tab = kept ?? (typeof tabId === 'number' ? s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null)) : null);
    const pin = !tab && typeof pinId === 'string' ? s.pins.find((p) => p.id === pinId) : null;
    const url = tab?.url ?? pin?.url;
    if (!url) return null;
    const id = newId();
    let added = false;
    await mutate((st) => {
      const spaceId = kept ? kept.spaceId : pin ? pin.spaceId : typeof tabId === 'number' ? st.tabSpace[tabId] : V.activeSpaceId(st, windowId ?? sender?.tab?.windowId);
      const scope = M.favoriteScopeOf(st, spaceId);
      let next = M.addFavorite(st, { id, scope, url, title: tab?.title ?? pin?.title ?? url, customTitle: (tab as TabRecord | undefined)?.customTitle ?? pin?.customTitle, beforeId });
      if (next === st) return st;
      added = true;
      if (pin) next = M.removePin(next, pin.id);
      if (kept) next = M.bindTabToFavorite(next, kept.id, id);
      else if (typeof tabId === 'number') next = M.bindTabToFavorite(next, tabId, id);
      return next;
    });
    return added ? id : null;
  },
  async removeFavorite({ favoriteId }: { favoriteId: string }) {
    await mutate((s) => M.removeFavorite(s, favoriteId));
  },
  async openFavorite({ favoriteId, windowId, deadline }: { favoriteId: string, windowId?: number, deadline?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const fav = (s.favorites ?? []).find((f) => f.id === favoriteId);
    if (!fav) return null;
    const bound = Object.values(s.tabs).filter((t) => t.favoriteId === fav.id);
    const key = M.normalizeUrl(fav.url);
    const matches = bound.length ? bound : Object.values(s.tabs).filter((t) => !t.favoriteId && !t.pinnedBy && M.normalizeUrl(t.url) === key);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) {
      if (existing.favoriteId !== fav.id) await mutate((st) => M.bindTabToFavorite(st, existing.id, fav.id));
      await away.showTab(existing.id, windowId ?? sender?.tab?.windowId, { source: 'openFavorite', deadline });
      return { shown: existing.id };
    }
    const win = windowId ?? sender?.tab?.windowId;
    const spaceId = V.activeSpaceId(s, win);
    const tab = await openTab({ windowId: win, url: fav.url, spaceId, deadline });
    if (tab?.id != null) await mutate((st) => M.bindTabToFavorite(st, tab.id, fav.id));
    return { shown: tab.id };
  },
  async resetFavorite({ favoriteId, windowId, deadline }: { favoriteId: string, windowId?: number, deadline?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const fav = (s.favorites ?? []).find((f) => f.id === favoriteId);
    if (!fav) return null;
    const bound = Object.values(s.tabs).filter((t) => t.favoriteId === fav.id);
    const existing = bound.find((t) => t.windowId === windowId) ?? bound[0];
    if (existing) {
      await api.tabs.update(existing.id, { url: fav.url, active: true }).catch(() => null);
      await away.showTab(existing.id, windowId ?? sender?.tab?.windowId, { source: 'resetFavorite', deadline });
      return { shown: existing.id };
    }
    const win = windowId ?? sender?.tab?.windowId;
    const spaceId = V.activeSpaceId(s, win);
    const tab = await openTab({ windowId: win, url: fav.url, spaceId, deadline });
    if (tab?.id != null) await mutate((st) => M.bindTabToFavorite(st, tab.id, fav.id));
    return { shown: tab.id };
  },
  async renameFavorite({ favoriteId, title }: { favoriteId: string, title: string }) {
    await mutate((s) => M.renameFavorite(s, favoriteId, title));
  },
  async moveFavorite({ favoriteId, beforeId = null }: { favoriteId: string, beforeId?: string | null }) {
    await mutate((s) => M.moveFavorite(s, favoriteId, { beforeId }));
  },
  async addAirTrafficRule({ pattern, spaceId, windowId }: { pattern: string, spaceId?: string, windowId?: number }, sender: BrowserMessageSender) {
    const id = newId();
    let added = false;
    await mutate((s) => {
      const targetSpace = spaceId && s.spaces.some((sp) => sp.id === spaceId) ? spaceId : V.activeSpaceId(s, windowId ?? sender?.tab?.windowId);
      const next = M.addAirTrafficRule(s, { id, pattern, spaceId: targetSpace });
      if (next !== s) added = true;
      return next;
    });
    return added ? id : null;
  },
  async removeAirTrafficRule({ ruleId }: { ruleId: string }) {
    await mutate((s) => M.removeAirTrafficRule(s, ruleId));
  },
  async toggleAirTrafficRule({ ruleId, enabled }: { ruleId: string, enabled?: boolean }) {
    await mutate((s) => M.toggleAirTrafficRule(s, ruleId, enabled));
  },
  async routeUrl({ url }: { url: string }) {
    const s = await load();
    const rule = matchAirTrafficRule(url, s.airTraffic, new Set(s.spaces.map((sp) => sp.id)));
    return rule ? { ruleId: rule.id, pattern: rule.pattern, spaceId: rule.spaceId } : null;
  },
  // A space shown in the window (its tab most used there to the front); `bringTab: false`: only
  // the sidebar's space, the page in front stays. Answers which tab is in front now.
  async setSpace({ windowId, spaceId, bringTab = true, sidebarTop, deadline }: { windowId?: number, spaceId: string, bringTab?: boolean, sidebarTop?: number, deadline?: number }, sender: BrowserMessageSender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop as number); // (finite: checked)
    const result = await showSpace(win, spaceId, { bringTab, deadline });
    return { shown: result?.tab?.id ?? null };
  },
  async createSpace({ windowId, name, emoji, color, theme }: { windowId?: number, name?: string, emoji?: string, color?: string, theme?: string | null }) {
    const id = newId();
    await mutate((s) => {
      // (Its theme: as asked, else that of the space the window shows: the library's rule, app/shared/library.)
      const from = windowId == null ? null : s.spaces.find((sp) => sp.id === s.activeSpaceByWindow?.[windowId]);
      const next = M.createSpace(s, { id, name, emoji, color, theme: M.themeIdOk(theme) ? theme : from?.theme ?? null });
      return windowId == null ? next : M.setActiveSpace(next, windowId, id);
    });
    return { spaceId: id };
  },
  async renameSpace({ spaceId, name, emoji, color, theme }: { spaceId: string, name?: string, emoji?: string, color?: string, theme?: string | null }) {
    await mutate((s) => M.updateSpace(s, spaceId, { name, emoji, color, ...(theme !== undefined ? { theme } : {}) }));
  },
  async setSpaceTheme({ spaceId, theme }: { spaceId: string, theme: string | null }) {
    if (theme !== null && !M.themeIdOk(theme)) throw new Error('not a theme id');
    await mutate((s) => M.updateSpace(s, spaceId, { theme }));
  },
  async deleteSpace({ spaceId }: { spaceId: string }) {
    await mutate((s) => M.deleteSpace(s, spaceId));
  },
  /** @param message `tabId` a string: a tab that isn't open */
  async moveTabToSpace({ tabId, spaceId }: { tabId: number | string, spaceId: string }) {
    await mutate((s) => M.moveTab(s, tabId, spaceId));
  },
  async pageIcon({ href }: { href: string }, sender: BrowserMessageSender) {
    if (!capabilities?.fetchFavicons) return; // the browser provides icons
    const pageUrl = sender.tab?.url ?? sender.url;
    let origin;
    try {
      origin = new URL(pageUrl as string).origin; // (none: it throws, and that's caught)
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
  /** @param message `settings`: its Settings open */
  async openLauncher({ windowId, settings = false }: { windowId?: number, settings?: boolean }) {
    const win = windowId ?? (await api.windows?.getLastFocused?.().catch(() => null))?.id;
    const key = `${win}:${settings}`;
    const pending = launcherOpening.get(key);
    if (pending) return pending;
    const opening = (async () => {
      const url = api.runtime.getURL(`newtab/newtab.html#${settings ? 'settings' : 'launcher'}`);
      const s = await load();
      const existing = Object.values(s.tabs).find((t) => t.windowId === win && t.url === url);
      if (existing) { await focusTab(existing.id, { source: settings ? 'settings' : 'archive' }); return { tabId: existing.id, shown: existing.id }; }
      const tab = await openTab({ windowId: win, url });
      await mutate((st) => M.upsertTab(st, { ...tab, title: settings ? 'Settings' : 'Margin' }, now()));
      return { tabId: tab.id, shown: tab.id };
    })();
    launcherOpening.set(key, opening);
    try { return await opening; } finally { if (launcherOpening.get(key) === opening) launcherOpening.delete(key); }
  },

  // A real new window of this profile (⌘N through Margin.app, the palette's "New window": docs/BROWSER-WINDOWS.md §5),
  // a Margin window of its own. With `fromWindowId`: in full screen if that window is (or as `fullscreen`
  // says), on the space it shows, set, not guessed, with its first tab in it too. Without one, the window
  // inherits the space (model.inheritSpace). Its new-tab page opens the palette. Answers its id, state and
  // bounds, which the app binds it by as Margin's. `url: 'about:blank'`: a window Margin.app makes ready out of sight
  // at its launch (HostedSession.prepareBrowser): nothing loaded in it. Always focused: a hidden Safari (one Margin.app
  // started) asked for an unfocused window answers its id but never orders it in (the real Mac, 2026-11-16), so the
  // app couldn't find it; the app keeps its own Space current while it's made.
  async newWindow({ fromWindowId, fullscreen, url }: { fromWindowId?: number, fullscreen?: boolean, url?: string } = {}) {
    const from = Number.isInteger(fromWindowId) ? await api.windows.get(fromWindowId as number).catch(() => null) : null;
    const spaceId = from ? M.activeSpaceId(await load(), from.id) : null;
    const full = fullscreen ?? from?.state === 'fullscreen';
    const props = { focused: true, ...(url === 'about:blank' ? { url } : {}) };
    markMarginOpening();
    let win;
    try {
      win = await api.windows.create({ ...props, ...(full ? { state: 'fullscreen' } : {}) });
    } catch {
      win = await api.windows.create(props).catch(() => null) // a browser that won't make it full screen at once
        ?? await api.windows.create({ focused: true }); // (or won't take the blank address)
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
    const bounds = [win.left, win.top, win.width, win.height].every(Number.isFinite) && win.width! > 0 && win.height! > 0 // (finite: there)
      ? { left: win.left, top: win.top, width: win.width, height: win.height } : null;
    return { windowId: win.id, state: win.state ?? 'normal', ...(bounds ? { bounds } : {}) };
  },
  // Margin.app closing a window of this profile it hosts or made (its tabs are kept, not open: a window closing).
  // Never past `notAfter`, and not while another windows call for it is pending (handoff.ts).
  async closeWindow(message: { windowId: number, notAfter?: number }) {
    return windowCall('closeWindow', message, async () => {
      await api.windows.remove(message.windowId);
      return null;
    });
  },
  // Margin.app's host (HostedSession.safariFullScreen): a window to full screen or normal, its focus
  // left alone unless asked; answered once Safari says it's there (background/handoff.ts).
  async setWindowState(message: { windowId: number, state: 'fullscreen' | 'normal', focused?: boolean, notAfter?: number, land?: boolean }) {
    return setWindowState(message);
  },
  // A page's scroll as it's hidden or left (content/core.ts), kept on its tab's record for its
  // Margin tab (background/scroll-record.ts, docs/DATA.md "The scroll record").
  async pageScroll({ y, url }: { y: number, url: string }, sender: BrowserMessageSender) {
    await keepScroll(sender?.tab?.id, url, y);
    return null;
  },
  // A reopened Margin tab's page asking where it was scrolled, once: the place, or null.
  async takeScroll({ url }: { url: string }, sender: BrowserMessageSender) {
    return takeScroll(sender?.tab?.id, url);
  },
  // ⌘T: Margin's new-tab page asks (newTabHandOff below), unless the
  // background already handed the tab off as it was created.
  // An address chosen on Margin's new-tab page, drawn by Margin.app's
  // overlay (its launcher): opened in that tab, as the page's own does.
  // A button of one of Margin's notices, chosen in Margin.app's overlay
  // (background/notices.ts, shared/notices.ts): done here, and the notice
  // isn't said again for that page. Whether it was a notice's button.
  async noticeAction({ notice, action, tabId }: { notice: string, action: string, tabId?: number }) {
    if (!isNoticeAction(notice, action)) return false;
    const tab = Number.isInteger(tabId) ? await api.tabs.get((tabId as number)).catch(() => null) : null;
    noticeAnswered(notice, tab?.id ?? null, notice === 'new-tab-setting' ? null : tab?.url ?? null);
    console.info(`[margin] notice ${notice}: ${action}${tab ? ` (tab ${tab.id})` : ''}`);
    if (notice === 'not-responding' && action === 'reload' && tab) return reloadCutOff(tab.id);
    if (notice === 'new-tab-setting' && action === 'never') await mutate((s) => ({ ...s, settings: { ...s.settings, newTabHint: false } }));
    return true;
  },
  // The page in front being left, or a site's own same-page navigation under
  // way (content/loads.ts), for Margin.app's sidebar (background/page-loads.ts).
  async pageLoading({ on, why }: { on: boolean, why: 'leaving' | 'navigating' }, sender: BrowserMessageSender) {
    if (sender?.tab?.id == null) return;
    pageLoads.pageSaid(sender.tab.id, sender.tab.windowId ?? null, !!on, why);
  },
  // A trackpad gesture Margin runs in the page (content/trackpad.ts), as it
  // goes: its feedback, drawn by Margin.app's overlay of the window.
  async gesture({ kind, state, progress = 0, direction = 0 }: { kind: 'pull' | 'swipe', state: string, progress?: number, direction?: number }, sender: BrowserMessageSender) {
    if (sender?.tab?.id == null || (kind !== 'pull' && kind !== 'swipe')) return;
    appLink.push(sender.tab.windowId ?? null, { type: 'gesture', tabId: sender.tab.id, kind, state: String(state), progress: Number(progress) || 0, direction: Number(direction) || 0 });
  },
  async openHere({ tabId, url }: { tabId: number, url: string }) {
    if (/^margin:\/\/settings\/?$/i.test(url)) url = api.runtime.getURL('newtab/newtab.html#settings');
    if (!Number.isInteger(tabId) || typeof url !== 'string' || !/^(https?|file):/i.test(url)) throw new Error('not an address');
    const tab = await api.tabs.get(tabId);
    if (!V.isNewTabPage(tab.url || tab.pendingUrl)) throw new Error('not a new-tab page');
    // Its row is the address at once, not "+ New Tab" (state/model.ts goingTo).
    await mutate((s) => M.goingTo(s, tabId, { url, title: '' }, now())).catch(() => {});
    await api.tabs.update(tabId, { url });
    return { shown: tabId };
  },
  async newTabPage(_: object, sender: BrowserMessageSender) {
    void engine.newTabHint?.newTabPageSeen(sender.tab);
    if (!sender.tab) return { app: false };
    if (await newTabHandOff(sender.tab)) return { handled: true };
    // Margin.app linked: the new-tab page draws nothing, the app's overlay
    // draws its launcher there and opens the palette over it. Not linked, or
    // in a window the app draws nothing over, the page shows its notice and
    // address field (newtab/newtab.ts).
    if (appLink.linked() && appLink.drawsWindow(sender.tab.windowId)) return { app: true, openPalette: appLink.push(sender.tab.windowId, { type: 'palette', newTab: false }) };
    return { app: false };
  },
  // ⌘T reaching a page while Margin.app isn't linked, or in a window it draws nothing over
  // (content/core.ts): Margin's new-tab page.
  async newTabKey(_: object, sender: BrowserMessageSender) {
    await newTabKey(sender?.tab ?? null);
  },
  // The new-tab page's "Start Margin.app" (not linked): the link asked for
  // now, which has Margin's extension handler start the app if it isn't
  // running (background/link.ts). False where there's no link (Chrome, a
  // copy that doesn't own the state).
  async startApp() {
    return appLink.askNow();
  },
  // The new-tab page's "Try again" while Margin turned its link off (its socket guard,
  // background/link.ts): sockets on again and the link asked for now. A person's choice only.
  async retryLink() {
    return appLink.retrySockets();
  },
  // Escape in the palette of a fresh new tab (⌘T; newtab/newtab.ts):
  // back to the tab the user was on, and this one closes, as if no tab had
  // been opened. The window's only tab (⌘N) stays, with the start page.
  async cancelNewTab(_: object, sender: BrowserMessageSender) {
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
  // long switch for that (shared/shortcuts.ts). True: taken.
  // `target`, `switchId`: Margin.app's overlay's own pick for a next/previous-tab key, highlighted as it was pressed
  // (background/navigation.ts navigate `given`).
  async navigate({ action, target, switchId }: { action: string, target?: number, switchId?: string }, sender: BrowserMessageSender) {
    if (!NAV_ACTIONS.has(action)) return false;
    const windowId = sender.tab?.windowId ?? (await api.windows?.getLastFocused())?.id;
    // The app's key and a page's keydown are two sources (one press heard by both counts once).
    void navigate(action, sender.app ? 'app' : 'page', windowId, { target, switchId });
    return true;
  },
  async updateSettings({ patch }: { patch: Record<string, any> }) {
    // Not a theme Margin has: a built-in, or one in Margin.app's index of imported themes (userThemes).
    if ('theme' in patch && !THEMES[patch.theme] && !PACKAGE_THEMES.includes(patch.theme) && !(await userThemeListed(patch.theme))) return;
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  },
  // "Margin full screen" on or off for this window (Chrome; extension/engines/chromium/fullscreen.ts).
  async toggleFullscreen({ windowId }: { windowId?: number }, sender: BrowserMessageSender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id == null || !capabilities?.marginFullscreen) return null;
    return engine.fullscreen?.toggleMarginFullscreen(id) ?? null;
  },
  // Whether this page's window is in full screen (Chrome, "only in full screen").
  async windowState(_: object, sender: BrowserMessageSender) {
    const id = sender.tab?.windowId;
    return { fullscreen: id != null && capabilities?.marginFullscreen && engine.fullscreen ? await engine.fullscreen.isFullscreen(id) : false };
  },
  // Margin.app hosting Safari in its page area (docs/MARGIN-APP.md, background/hosted.ts): an item of its library
  // shown as a tab of the window it hosts for this profile, and closed. The app's word only.
  async hostShow(message: { windowId?: number, itemId?: string, url?: string }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.show(message);
  },
  async hostPicture(message: { windowId?: number, itemId?: string }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.picture(message);
  },
  async hostClose(message: { itemId?: string }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.close(message);
  },
  async hostMute(message: { itemId?: string, muted?: boolean }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.mute(message);
  },
  async hostNavigate(message: { itemId?: string, url?: string }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.navigate(message);
  },
  async hostPromotePeek(message: { fromItemId?: string, toWindowId?: number, toItemId?: string }, sender: BrowserMessageSender) {
    if (!sender?.app) throw new Error('the app\'s request only');
    return hostedTabs.promotePeek(message);
  },
  async openPeek({ url, source = 'shift-click', spaceId = null }: { url: string, source?: string, spaceId?: string | null }, sender: BrowserMessageSender) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    const win = sender?.tab?.windowId ?? null;
    if (appLink.linked() && win != null && appLink.push(win, { type: 'peekOpen', url, source, spaceId })) {
      return { ok: true, hosted: true };
    }
    // Unlinked fallback: open in a new tab in the current space.
    const tab = await openTab({ windowId: win ?? undefined, url, spaceId: spaceId ?? undefined });
    return { ok: true, hosted: false, tabId: tab?.id ?? null };
  },
  async mediaState(report: { playing: boolean, muted?: boolean, title?: string, artist?: string, artworkUrl?: string }, sender: BrowserMessageSender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return null;
    const artwork = typeof report?.artworkUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(report.artworkUrl) ? report.artworkUrl : null;
    const entry = mediaRegistry.report(tabId, {
      playing: !!report?.playing,
      muted: !!report?.muted,
      title: report?.title,
      artist: report?.artist,
      artwork,
      url: sender.tab?.url ?? '',
    });
    if (sender.tab?.windowId != null) {
      appLink.push(sender.tab.windowId, { type: 'media', media: mediaRegistry.current(null) });
    }
    return entry;
  },
  async mediaControl({ command, tabId }: { command: 'toggle' | 'prev' | 'next' | 'mute' | 'focus', tabId?: number | string | null }, sender: BrowserMessageSender) {
    const targetId = Number.isInteger(tabId) ? (tabId as number) : (mediaRegistry.current(sender?.tab?.id ?? null)?.tabId as number | null);
    if (!Number.isInteger(targetId)) return false;
    const id = targetId as number;
    if (command === 'focus') {
      await focusTab(id, { source: 'mediaFocus' }).catch(() => null);
      return true;
    }
    if (command === 'mute') {
      await handlers.muteTab({ tabId: id });
      return true;
    }
    await api.tabs.sendMessage?.(id, { type: 'mediaCommand', command }).catch(() => null);
    return true;
  },
  async duplicateTab({ tabId, windowId }: { tabId: number | string, windowId?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const kept = typeof tabId === 'string' ? s.keptTabs[tabId] : null;
    const live = Number.isInteger(tabId) ? s.tabs[tabId as number] : null;
    const url = live?.url ?? kept?.url;
    const spaceId = kept ? kept.spaceId : live ? s.tabSpace[live.id] : null;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const win = windowId ?? live?.windowId ?? sender.tab?.windowId;
    if (win == null) return null;
    markMarginOpening();
    const created = await api.tabs.create({ windowId: win, url, active: true });
    if (created?.id != null && spaceId) {
      await mutate((st) => M.moveTab(M.upsertTab(st, created, now()), created.id, spaceId));
    }
    return created?.id ?? null;
  },
  async muteTab({ tabId }: { tabId: number | string }) {
    if (!Number.isInteger(tabId)) return { muted: false };
    const tab = await api.tabs.get(tabId as number).catch(() => null);
    if (!tab) return { muted: false };
    const next = !tab.mutedInfo?.muted;
    const updated = await api.tabs.update(tab.id, { muted: next }).catch(() => null);
    if (updated) await mutate((s) => M.upsertTab(s, updated, now()));
    return { muted: updated?.mutedInfo?.muted ?? next };
  },
  async unloadTab({ tabId }: { tabId: number | string }) {
    if (!Number.isInteger(tabId)) return false;
    const id = tabId as number;
    const s = await load();
    if (!s.tabs[id]) return false;
    if (capabilities?.sleepTabs === 'discard' && typeof api.tabs.discard === 'function') {
      await api.tabs.discard(id).catch(() => null);
      return true;
    }
    await mutate((st) => M.keepTab(st, id, { why: 'sleep', now: now() }));
    noteClosing([id], 'keep', 'sleep');
    await api.tabs.remove(id).catch(() => {});
    return true;
  },
  async restoreLastArchive({ windowId }: { windowId?: number }, sender: BrowserMessageSender) {
    const s = await load();
    const win = windowId ?? sender.tab?.windowId ?? null;
    const spaceId = win != null ? V.activeSpaceId(s, win) : s.spaces[0]?.id ?? null;
    const entry = (spaceId ? s.archive.find((a) => a.spaceId === spaceId) : null) ?? s.archive[0];
    if (!entry) return null;
    return handlers.restoreArchive({ archiveId: entry.id, windowId: win ?? undefined });
  },
  // Margin.app's index of the themes the person imported (app/platforms/macos/shell/ThemeStore.swift: they're the
  // Mac's, kept by the app; a copy holds only the list, never a package), sent as a copy links and
  // whenever it changes. Kept in storage.local (`userThemes`) for updateSettings and the theme's settings.
  async userThemes({ list }: { list: any[] }) {
    if (!Array.isArray(list)) return false;
    const clean = list.slice(0, 50).filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && USER_THEME_ID.test(e.id) && !PACKAGE_THEMES.includes(e.id))
      .map((e) => ({ id: e.id, name: String(e.name ?? '').slice(0, 60), version: String(e.version ?? '').slice(0, 16), author: String(e.author ?? '').slice(0, 80) }));
    await api.storage.local.set({ [USER_THEMES_KEY]: clean });
    return true;
  },
  // A theme's own settings (settings.themes[themeId]), merged into what's
  // there (updateSettings replaces whole top-level keys).
  async updateThemeSettings({ themeId, patch }: { themeId: string, patch: object }) {
    const theme = THEMES[themeId];
    if (!theme) return updatePackageThemeSettings(themeId, patch);
    await mutate((s) => {
      const themes = s.settings.themes ?? {};
      const own = theme.settingsOf({ themes: { [themeId]: { ...themes[themeId], ...patch } } });
      return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
    });
  },
};
