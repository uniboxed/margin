// What pages ask the background for: runtime messages { type, ...payload },
// answered { ok, result } or { ok: false, error } (background.js routes
// them). types/margin.d.ts derives the protocol's types from this object.
import { platform } from '../shared/platform.js';
import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import * as S from '../shared/search.js';
import { api, load, mutate, newId, now } from './store.js';
import * as onboarding from './onboarding.js';
import { focusTab, handingOff, instanceId, markMarginOpening, openTab, openedFrom, shownAt, shownUrl, wakeTab } from './tabs.js';
import { clearLog, readLog, recordShown } from './diagnostics.js';
import { newTabPageSeen } from './newtab-hint.js';
import { ownSearchTabs, OWN_SEARCH_MS } from './search-engine.js';
import { iconInflight, iconUrlAllowed, learnIcon } from './site-icons.js';
import { queueRegistrations, whenRegistered } from './registered.js';
import { navigate, NAV_ACTIONS, showSpace } from './navigation.js';
import { THEMES, themeFor } from '../themes/index.js';
import { isFullscreen, toggleMarginFullscreen } from './fullscreen.js';
import { getScroll, setScroll } from './scroll.js';

// After a switch from the sidebar while it was open over the page (hovered,
// toggled, or the rail expanded): the page shown next opens it the same way
// (`why`), so the sidebar doesn't vanish and come back on every switch
// (content/layout.js). A page that isn't listening yet (loading, or Safari
// reloading a tab it had unloaded) gets it with `hello` for a few seconds.
const carried = new Map(); // tab id → { why, until }
function rememberCarry(tabId, why) {
  const reason = why === 'toggle' ? 'toggle' : 'hover';
  carried.set(tabId, { why: reason, until: now() + 10000 });
  return reason;
}
function deliverCarry(tabId, reason) {
  api.tabs.sendMessage(tabId, { type: 'command', command: 'carry-open', why: reason }).then(() => carried.delete(tabId), () => {});
}
function carryOpen(tabId, why) {
  deliverCarry(tabId, rememberCarry(tabId, why));
}
function takeCarried(tabId) {
  const entry = carried.get(tabId);
  carried.delete(tabId);
  return entry && entry.until > now() ? entry.why : null;
}
// ⌘T: the browser opened a new tab (extensions can't stop it) with Margin's
// new-tab page. Arc keeps the page and opens its palette over it: so the
// palette opens on the tab the user was on (its sidebar highlights "+ New
// Tab" until it closes; content/palette.js), that tab is shown again, and
// the new one closes. Started as soon as the tab is created when the browser
// says what it shows (background.js onCreated; Chrome does), else when the
// page asks (newTabPage): every moment the new tab is in front shows. In the
// order that shows least of it: out of the sidebar first, the palette ready
// before its page is back, no wake (it was shown a moment ago). False when
// it can't (a new window, a previous tab that isn't a web page or has no
// Margin): the palette then opens on the new-tab page.
const handOffs = new Map(); // tab id → Promise<boolean>, once per tab

// The zoom each site was last seen at, so its pages draw Margin at its size
// before they've asked (content/core.js, shared/dom.js setPageZoom); Safari
// and Chrome keep a site's zoom across its pages. Storage `pageZoom`:
// origin → [zoom, when], only sites zoomed away from the browser's default
// zoom (Chrome's setting; 100% where unknown), which is kept once as '*';
// the ZOOM_CAP most recently changed. Written only when it changes (every
// write redraws Margin's pages); one at a time.
const ZOOM_CAP = 150;
let zoomWrites = Promise.resolve();
function rememberZoom(tab, url, zoom) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (!Number.isFinite(zoom) || zoom <= 0 || origin === 'null') return;
  zoomWrites = zoomWrites.then(async () => {
    const settings = await api.tabs.getZoomSettings?.(tab.id).catch(() => null);
    const base = Number.isFinite(settings?.defaultZoomFactor) && settings.defaultZoomFactor > 0 ? settings.defaultZoomFactor : 1;
    const { pageZoom = {} } = await api.storage.local.get('pageZoom');
    const known = (pageZoom[origin] ?? pageZoom['*'])?.[0] ?? 1;
    if (known === zoom && (pageZoom['*']?.[0] ?? 1) === base) return;
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
    await api.storage.local.set({ pageZoom: next });
  }).catch(() => {});
}
const SHOW_PALETTE_MS = 1000;
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
  onboarding.reportEvent('safariNewTab'); // Safari's own New Tab made a tab (its ⌘T, or its + button)
  if (!/^https?:/.test(prev.url)) return log('palette on the new-tab page', `tab ${prev.id} isn't a web page`), false;
  handingOff.add(tab.id);
  // One message: the page opens its palette if it can, and says so. Not
  // waited on for long: a page Safari stopped delivering to (tabs.js) would
  // otherwise leave this tab untracked and the new-tab page without one.
  const opened = await Promise.race([
    api.tabs.sendMessage(prev.id, { type: 'show-palette' }).then((r) => r === true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), SHOW_PALETTE_MS)),
  ]);
  if (!opened) {
    handingOff.delete(tab.id);
    // In case it answers after all, later.
    api.tabs.sendMessage(prev.id, { type: 'hide-palette' }).catch(() => {});
    return log('palette on the new-tab page', `previous tab ${prev.id} has no Margin palette (yet)`), false;
  }
  // Still the untouched new tab in front? The user may have typed an address
  // meanwhile, switched away, or another extension opened it to navigate it
  // (background.js onUpdated then lets it go): it stays, and the palette closes.
  const cur = handingOff.has(tab.id) ? await api.tabs.get(tab.id).catch(() => null) : null;
  if (!cur?.active || !V.isNewTabPage(cur.pendingUrl || cur.url)) {
    handingOff.delete(tab.id);
    api.tabs.sendMessage(prev.id, { type: 'hide-palette' }).catch(() => {});
    return log('kept', 'the new tab was used or left meanwhile'), false;
  }
  log(`palette over tab ${prev.id}, new tab closed`, 'web page in this window: ⌘T (or ⌘N made into a tab by macOS)');
  await Promise.all([mutate((st) => M.removeTab(st, tab.id)), focusTab(prev.id, { wake: false, source: 'new tab hand-off' })]);
  await api.tabs.remove(tab.id).catch(() => {});
  return true;
}

// Only within the window the switch was made from (another window's page
// stays visible, so its own sidebar stays open there).
async function carryIfSameWindow(tabId, why, windowId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (tab && windowId != null && tab.windowId === windowId) carryOpen(tabId, why);
}

// For a sidebar-driven switch, preserve its open state as part of the hidden
// destination preparation. The remembered copy is also the cold-tab path:
// if Safari has discarded the page, its fresh content script receives it in
// `hello`. An already-running page that could not prepare gets the ordinary
// command after activation.
/**
 * @param {number} tabId
 * @param {{ source?: string, show?: boolean | 'hover' | 'toggle', sourceWindowId?: number, sidebarTop?: number }} [options]
 */
async function focusWithSidebar(tabId, { source = 'other', show, sourceWindowId, sidebarTop } = {}) {
  const target = (await load()).tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  const reason = show && sourceWindowId != null && target?.windowId === sourceWindowId ? rememberCarry(tabId, show) : null;
  // Preparation receives the value directly; persistence can finish beside
  // the switch instead of adding a storage.session round trip in front of it.
  if (Number.isFinite(sidebarTop) && sourceWindowId != null) void setScroll(sourceWindowId, sidebarTop);
  try {
    const result = await focusTab(tabId, { source, carry: reason, scroll: Number.isFinite(sidebarTop) ? sidebarTop : null });
    if (!reason) return result;
    if (!result?.tab) carried.delete(tabId);
    else if (result.preparation?.outcome === 'ready') carried.delete(tabId);
    else deliverCarry(tabId, reason);
    return result;
  } catch (error) {
    if (reason) carried.delete(tabId);
    throw error;
  }
}

// ⌘T as Margin's own shortcut (Safari's manifest `new-tab`, with Safari's
// File › New Tab moved to another shortcut, DECISIONS.md): Safari matches it
// in the app, wherever the focus is. The page in front opens its palette to
// choose a new tab (no tab created: no flicker); Margin's new-tab page does
// what its "+ New Tab" does; anything else (Safari's own pages, PDFs, sites
// Margin can't reach) gets a new tab with Margin's new-tab page, as Safari's
// ⌘T did (its palette opens there).
export async function newTabKey(tabArg) {
  onboarding.reportEvent('cmdTKey');
  const windowId = tabArg?.windowId ?? (await api.windows?.getLastFocused())?.id;
  const [tab] = await api.tabs.query({ active: true, ...(windowId != null ? { windowId } : { currentWindow: true }) });
  if (!tab) return;
  if (V.isNewTabPage(tab.url || tab.pendingUrl)) {
    return api.runtime.sendMessage({ type: 'command', command: 'new-tab', tabId: tab.id }).catch(() => {});
  }
  const opened = await Promise.race([
    api.tabs.sendMessage(tab.id, { type: 'show-palette' }).then((r) => r === true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), SHOW_PALETTE_MS)),
  ]);
  if (!opened) await api.tabs.create({ windowId: tab.windowId, url: api.runtime.getURL('newtab/newtab.html') });
}

export const handlers = {
  async hello(_, sender) {
    onboarding.pageLoaded();
    const windowId = sender.tab?.windowId ?? null;
    const fullscreen = windowId != null && platform?.marginFullscreen ? await isFullscreen(windowId) : false;
    const carry = sender.tab?.id != null ? takeCarried(sender.tab.id) : null;
    return { tabId: sender.tab?.id ?? null, windowId, instanceId, fullscreen, carry };
  },
  /** @param {{ tabId: number, show?: boolean | 'hover' | 'toggle', sidebarTop?: number }} message `show`: keep the sidebar open there */
  async activateTab({ tabId, show, sidebarTop }, sender) {
    await focusWithSidebar(tabId, { source: 'activateTab', show, sourceWindowId: sender.tab?.windowId, sidebarTop });
  },
  // About to be shown, probably (a press on a sidebar row, the palette
  // resting on a row): its process is woken now, so the switch that follows
  // doesn't wait for it (background/tabs.js wakeTab). A pin wakes its open tab.
  /** @param {{ tabId?: number, pinId?: string, windowId?: number }} message */
  /** @param {{ tabId?: number, pinId?: string, windowId?: number, renew?: boolean }} message `renew`: a fresh wake (a hover renewal) */
  async prewake({ tabId, pinId, windowId, renew = false }) {
    const id = tabId ?? (pinId ? V.pinTabId(await load(), pinId, windowId) : null);
    if (Number.isInteger(id)) void wakeTab(id, { renew });
  },
  // DEVELOPMENT DIAGNOSTICS (background/diagnostics.js): how a page that was
  // just shown came on screen (content/shell.js), and the log itself for the
  // start page's "Switch log" button.
  /** @param {{ why: string, ms: number, restoring?: boolean }} message */
  async shellShown({ why, ms, restoring }, sender) {
    const id = sender.tab?.id;
    const at = shownAt.get(id);
    if (id == null || !at || Date.now() - at > 5000) return; // not a page that was just shown
    recordShown({ tabId: id, why: String(why).slice(0, 40), sinceStart: Math.round(ms), sinceShown: Date.now() - at, restoring: !!restoring });
  },
  /** @param {{ clear?: boolean }} message */
  async switchLog({ clear } = {}) {
    if (clear) return void (await clearLog());
    return readLog();
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
  // content/shell.js, as a page starts: is this Safari loading, as it's shown,
  // a tab it had unloaded (shown in the last few seconds, same URL)? Then
  // nothing of the tab was on screen before, and holding the page back only
  // kept Safari's empty view up.
  /** @param {{ url: string }} message */
  async restoringTab({ url }, sender) {
    const id = sender.tab?.id;
    const at = shownAt.get(id);
    if (id == null || !at || Date.now() - at > 3000) return false;
    const before = shownUrl.get(id);
    return !before || before.split('#')[0] === String(url).split('#')[0];
  },
  // A page that still had the previous copy of Margin (content/core.js
  // reloadWhenSafe): its URL loaded again once the content scripts a page
  // load needs are registered. A GET (a reload would send a form again), from
  // the browser's side (the old copy's fitted layout would cancel a page's
  // own navigation to its URL); a URL with a #fragment would only scroll, so
  // that page keeps running as it is.
  async reloadForUpdate(_, sender) {
    const { id, url } = sender.tab ?? {};
    if (id == null || !/^https?:/i.test(url ?? '') || url.includes('#')) return;
    await whenRegistered();
    await api.tabs.update(id, { url });
  },
  // Closing from Margin archives the tab, like Arc.
  /** @param {{ tabId: number }} message */
  /** @param {{ tabId: number, show?: boolean | 'hover' | 'toggle', sidebarTop?: number }} message `show`: closing the shown tab from an open sidebar keeps it open on the next one */
  async closeTab({ tabId, show, sidebarTop }) {
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
    const closing = await api.tabs.get(tabId).catch(() => null);
    // The tab in front: the space's most recent other tab comes to the front
    // first (Arc stays in the space; the browser would pick a neighbour,
    // maybe of another space).
    let selected = null;
    if (closing?.active) {
      const s = await load();
      const stay = M.recentTabOfSpace(s, closing.windowId, s.tabSpace[tabId], tabId);
      if (stay) {
        const result = await focusWithSidebar(stay.id, { source: 'closeTab', show, sourceWindowId: closing.windowId, sidebarTop }).catch(() => null);
        if (result?.tab) selected = stay.id;
      }
    }
    await api.tabs.remove(tabId);
    if (show && closing?.active) {
      const [next] = await api.tabs.query({ active: true, windowId: closing.windowId }).catch(() => []);
      // If Margin could not select the space's own next tab above, Safari
      // selected one while removing the old tab. That browser-chosen path
      // cannot be prepared, so retain the established post-switch fallback.
      if (next?.id != null && next.id !== selected) carryOpen(next.id, show);
    }
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
  // Page zoom (the browser's own, like ⌘+): for Margin's pinch, and so
  // Margin's UI keeps its size on a zoomed page; remembered per site.
  // ⌘T reached Margin on a page (content/palette.js installNewTabKey).
  async newTabKeyUsed() {
    onboarding.reportEvent('cmdTKey');
  },
  async getZoom(_, sender) {
    if (!sender.tab) return null;
    const zoom = await api.tabs.getZoom(sender.tab.id);
    rememberZoom(sender.tab, sender.url ?? sender.tab.url, zoom);
    return zoom;
  },
  /** @param {{ factor: number }} message */
  async setZoom({ factor }, sender) {
    if (!sender.tab || !Number.isFinite(factor)) return;
    const zoom = Math.min(3, Math.max(0.25, factor));
    await api.tabs.setZoom(sender.tab.id, zoom);
    rememberZoom(sender.tab, sender.url ?? sender.tab.url, zoom);
  },
  // Search with the browser's engine: in `tabId`, else in a new tab.
  /** @param {{ query: string, windowId?: number, tabId?: number }} message */
  async search({ query, windowId, tabId }) {
    const text = String(query ?? '').trim();
    if (!text) return;
    if (platform?.search === 'browser' && api.search?.query) {
      await (tabId != null ? api.search.query({ text, tabId }) : api.search.query({ text, disposition: 'NEW_TAB' }));
      return;
    }
    const { settings } = await load();
    const url = S.searchUrl(text, settings);
    const own = { at: now(), template: S.safariEngine(settings).template };
    if (tabId != null) {
      ownSearchTabs.set(tabId, own);
      await api.tabs.update(tabId, { url });
    } else {
      // Mark the tab before it navigates: create it blank, then load the search.
      const tab = await openTab({ windowId, url: 'about:blank' });
      ownSearchTabs.set(tab.id, own);
      await api.tabs.update(tab.id, { url });
    }
    for (const [id, entry] of ownSearchTabs) if (now() - entry.at > OWN_SEARCH_MS) ownSearchTabs.delete(id);
  },
  /** @param {{ windowId?: number, url?: string, spaceId?: string }} message */
  async newTab({ windowId, url, spaceId }) {
    const tab = await openTab({ windowId, url, spaceId });
    return { tabId: tab.id };
  },
  // A ⌘- or middle-clicked link in a fitted page that the page's CSP refused
  // before Safari could open its tab (content/shell.js): opened like Safari
  // would, in a tab after the page (later ones after earlier ones, so they
  // keep the click order), in the background unless ⇧ was held; ⌘⌥ opens a
  // window.
  /** @param {{ url: string, window?: boolean, active?: boolean }} message */
  async openLink({ url, window: inWindow, active }, sender) {
    if (!/^https?:/i.test(url ?? '')) return;
    markMarginOpening();
    if (inWindow && api.windows?.create) return void (await api.windows.create({ url, focused: !!active }));
    const opener = sender.tab;
    if (!opener) return void (await api.tabs.create({ url, active: !!active }));
    const last = openedFrom.get(opener.id);
    const index = last && now() - last.at < 60_000 ? last.index + 1 : opener.index + 1;
    const tab = await api.tabs.create({ url, active: !!active, windowId: opener.windowId, index })
      .catch(() => api.tabs.create({ url, active: !!active }));
    openedFrom.set(opener.id, { index: tab?.index ?? index, at: now() });
  },
  // `folderId`/`beforeId`: where the pin goes (a folder of the tab's space,
  // before a pin or folder there; dragged in the sidebar); the end of the
  // pinned area by default. Returns the new pin's id.
  /** @param {{ tabId: number, folderId?: string | null, beforeId?: string | null }} message */
  async pinTab({ tabId, folderId = null, beforeId = null }) {
    const s = await load();
    const tab = s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
    if (!tab?.url) return console.warn('[margin] pin: unknown tab', tabId);
    let result = 'pinned';
    const id = newId();
    await mutate((st) => {
      // A tab Margin hasn't placed in a space yet goes to its window's space.
      const spaceId = st.tabSpace[tabId] ?? V.activeSpaceId(st, tab.windowId);
      const next = M.addPin(st, { id, spaceId, url: tab.url, title: tab.title, folderId, beforeId });
      if (next === st) result = 'not pinned (already pinned in that space, or no space)';
      return next;
    });
    console.info(`[margin] pin tab ${tabId}: ${result}`);
    return result === 'pinned' ? id : null;
  },
  // ---- folders of pins (state/model.js) ----
  // A folder in this window's space (or `spaceId`), holding the pins
  // `pinIds`, or the tab `tabId` pinned into it; at the top level before
  // `beforeId` (else in the place of the first pin it takes, else the end).
  // Returns its id.
  /** @param {{ windowId?: number, spaceId?: string, name?: string, pinIds?: string[], tabId?: number, beforeId?: string | null }} message */
  async createFolder({ windowId, spaceId, name, pinIds = [], tabId, beforeId = null }, sender) {
    const id = newId();
    const pinFromTab = Number.isInteger(tabId) ? newId() : null;
    const tab = pinFromTab ? ((await load()).tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null))) : null;
    await mutate((st) => {
      const space = spaceId ?? (tab ? st.tabSpace[tab.id] : null) ?? V.activeSpaceId(st, windowId ?? sender?.tab?.windowId);
      const firstPin = st.pins.find((p) => p.id === pinIds[0] && p.spaceId === space);
      // In the place of the first pin it takes, if that's at the top level.
      const before = beforeId ?? (firstPin && !firstPin.folderId ? firstPin.id : null);
      let next = M.createFolder(st, { id, spaceId: space, name, pinIds, beforeId: before });
      if (tab?.url) next = M.addPin(next, { id: pinFromTab, spaceId: space, url: tab.url, title: tab.title, folderId: id });
      return next;
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
  /** @param {{ pinId: string }} message */
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  /** @param {{ pinId: string, windowId?: number, show?: boolean | 'hover' | 'toggle', sidebarTop?: number }} message `show`: keep the sidebar open there */
  async openPin({ pinId, windowId, show, sidebarTop }) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    // Only a tab of the pin's space (as the sidebar shows it): one elsewhere
    // would switch the window to that space.
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key && s.tabSpace[t.id] === pin.spaceId);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) {
      await focusWithSidebar(existing.id, { source: 'openPin', show, sourceWindowId: windowId, sidebarTop });
    } else await openTab({ windowId, url: pin.url, spaceId: pin.spaceId });
  },
  /** @param {{ windowId: number, spaceId: string }} message */
  // `bringTab: false`: only the sidebar's space, the page in front stays.
  /** @param {{ windowId?: number, spaceId: string, bringTab?: boolean }} message */
  /** @param {{ windowId?: number, spaceId: string, bringTab?: boolean, show?: boolean | 'hover' | 'toggle', sidebarTop?: number }} message `show`: keep the sidebar open on the tab that comes to the front */
  async setSpace({ windowId, spaceId, bringTab = true, show, sidebarTop }, sender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop);
    const reason = show && win != null && win === sender?.tab?.windowId ? (show === 'toggle' ? 'toggle' : 'hover') : null;
    const result = await showSpace(win, spaceId, { bringTab, carry: reason, scroll: sidebarTop });
    if (!show || win == null) return;
    if (result?.preparation?.outcome === 'ready') return;
    const [front] = await api.tabs.query({ active: true, windowId: win });
    if (front && front.id !== sender?.tab?.id) await carryIfSameWindow(front.id, show, sender?.tab?.windowId);
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
  /** @param {{ tabId: number, spaceId: string }} message */
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
  async openLauncher({ windowId }) {
    await openTab({ windowId, url: api.runtime.getURL('newtab/newtab.html#launcher') });
  },
  // A real new window (the palette's "New window"): its new-tab page opens
  // the palette, and the window inherits the space (model.inheritSpace).
  async newWindow() {
    markMarginOpening();
    await api.windows?.create({ focused: true });
  },
  // ⌘T: Margin's new-tab page asks (newTabHandOff below), unless the
  // background already handed the tab off as it was created.
  async newTabPage(_, sender) {
    void newTabPageSeen();
    if (!sender.tab) return { openPalette: true };
    return (await newTabHandOff(sender.tab)) ? { handled: true } : { openPalette: true };
  },
  // Escape in the palette of a fresh new tab (⌘T; themes/arcadium/newtab.js):
  // back to the tab the user was on, and this one closes, as if no tab had
  // been opened. The window's only tab (⌘N) stays, with the start page.
  async cancelNewTab(_, sender) {
    const tab = sender.tab;
    if (!tab) return;
    const prev = previousTab(await load(), tab);
    if (!prev) return;
    await focusTab(prev.id, { source: 'cancelNewTab' });
    await api.tabs.remove(tab.id).catch(() => {});
  },
  /** @param {{ action: string }} message */
  async navigate({ action }, sender) {
    if (!NAV_ACTIONS.has(action)) return;
    const windowId = sender.tab?.windowId ?? (await api.windows?.getLastFocused())?.id;
    await navigate(action, 'page', windowId);
  },
  /** @param {{ patch: Record<string, any> }} message */
  async updateSettings({ patch }) {
    if ('theme' in patch && !THEMES[patch.theme]) return; // not a theme Margin has
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
  // A theme's own settings (settings.themes[themeId]), merged into what's
  // there (updateSettings replaces whole top-level keys).
  /** @param {{ themeId: string, patch: object }} message */
  async updateThemeSettings({ themeId, patch }) {
    const theme = THEMES[themeId];
    if (!theme) return;
    await mutate((s) => {
      const themes = s.settings.themes ?? {};
      const own = theme.settingsOf({ themes: { [themeId]: { ...themes[themeId], ...patch } } });
      return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
    });
  },
  // A page the active theme's registered script missed (background/
  // registered.js; Safari loads stored registrations a moment after it
  // starts): inject the theme there (top frame, Margin's content-script
  // world, like the registered script).
  async injectTheme(_, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null || !api.scripting?.executeScript) return false;
    const { settings } = await load();
    // At once, not when the page is idle: core already runs there and waits.
    await api.scripting.executeScript({ target: { tabId }, files: [themeFor(settings).content], injectImmediately: true });
    return true;
  },
  // Fitted layout on or off for one site (the palette), then reload the
  // page in the new layout once the registered script matches.
  /** @param {{ origin: string, fit: boolean }} message */
  async setFitSite({ origin, fit }, sender) {
    if (!/^https?:\/\/[^/]+$/.test(origin ?? '')) return;
    await mutate((s) => {
      const except = (s.settings.fitPagesExcept ?? []).filter((o) => o !== origin);
      return { ...s, settings: { ...s.settings, fitPagesExcept: fit ? except : [...except, origin] } };
    });
    await queueRegistrations();
    if (sender.tab?.id != null) await api.tabs.reload(sender.tab.id);
  },
};
