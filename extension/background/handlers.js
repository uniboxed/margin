// What pages ask the background for: runtime messages { type, ...payload },
// answered { ok, result } or { ok: false, error } (background.js routes
// them). types/margin.d.ts derives the protocol's types from this object.
import { platform } from '../shared/platform.js';
import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import * as S from '../shared/search.js';
import { api, load, mutate, newId, now } from './store.js';
import { focusTab, instanceId, openTab, openedFrom, shownAt, shownUrl } from './tabs.js';
import { ownSearchTabs, OWN_SEARCH_MS } from './search-engine.js';
import { iconInflight, iconUrlAllowed, learnIcon } from './site-icons.js';
import { queueRegistrations, whenRegistered } from './registered.js';
import { navigate, NAV_ACTIONS } from './navigation.js';
import { THEMES, themeFor } from '../themes/index.js';
import { isFullscreen, toggleMarginFullscreen } from './fullscreen.js';
import { getScroll, setScroll } from './scroll.js';

// After a switch from the sidebar while it was open over the page (hovered,
// toggled, or the rail expanded): the page shown next opens it the same way
// (`why`), so the sidebar doesn't vanish and come back on every switch
// (content/layout.js). A page that isn't listening yet (loading, or Safari
// reloading a tab it had unloaded) gets it with `hello` for a few seconds.
const carried = new Map(); // tab id → { why, until }
function carryOpen(tabId, why) {
  const reason = why === 'toggle' ? 'toggle' : 'hover';
  carried.set(tabId, { why: reason, until: now() + 10000 });
  api.tabs.sendMessage(tabId, { type: 'command', command: 'carry-open', why: reason }).then(() => carried.delete(tabId), () => {});
}
function takeCarried(tabId) {
  const entry = carried.get(tabId);
  carried.delete(tabId);
  return entry && entry.until > now() ? entry.why : null;
}
// Only within the window the switch was made from (another window's page
// stays visible, so its own sidebar stays open there).
async function carryIfSameWindow(tabId, why, windowId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (tab && windowId != null && tab.windowId === windowId) carryOpen(tabId, why);
}

export const handlers = {
  async hello(_, sender) {
    const windowId = sender.tab?.windowId ?? null;
    const fullscreen = windowId != null && platform?.marginFullscreen ? await isFullscreen(windowId) : false;
    const carry = sender.tab?.id != null ? takeCarried(sender.tab.id) : null;
    return { tabId: sender.tab?.id ?? null, windowId, instanceId, fullscreen, carry };
  },
  /** @param {{ tabId: number, show?: boolean | 'hover' | 'toggle' }} message `show`: keep the sidebar open there */
  async activateTab({ tabId, show }, sender) {
    await focusTab(tabId);
    if (show) await carryIfSameWindow(tabId, show, sender.tab?.windowId);
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
  /** @param {{ tabId: number, show?: boolean | 'hover' | 'toggle' }} message `show`: closing the shown tab from an open sidebar keeps it open on the next one */
  async closeTab({ tabId, show }) {
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
    const closing = show ? await api.tabs.get(tabId).catch(() => null) : null;
    await api.tabs.remove(tabId);
    if (closing?.active) {
      const [next] = await api.tabs.query({ active: true, windowId: closing.windowId }).catch(() => []);
      if (next?.id != null) carryOpen(next.id, show);
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
  // Page zoom for Margin's pinch-to-zoom (Safari's own zoom, like ⌘+).
  async getZoom(_, sender) {
    return sender.tab ? api.tabs.getZoom(sender.tab.id) : null;
  },
  /** @param {{ factor: number }} message */
  async setZoom({ factor }, sender) {
    if (!sender.tab || !Number.isFinite(factor)) return;
    await api.tabs.setZoom(sender.tab.id, Math.min(3, Math.max(0.25, factor)));
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
    if (inWindow && api.windows?.create) return void (await api.windows.create({ url, focused: !!active }));
    const opener = sender.tab;
    if (!opener) return void (await api.tabs.create({ url, active: !!active }));
    const last = openedFrom.get(opener.id);
    const index = last && now() - last.at < 60_000 ? last.index + 1 : opener.index + 1;
    const tab = await api.tabs.create({ url, active: !!active, windowId: opener.windowId, index })
      .catch(() => api.tabs.create({ url, active: !!active }));
    openedFrom.set(opener.id, { index: tab?.index ?? index, at: now() });
  },
  /** @param {{ tabId: number }} message */
  async pinTab({ tabId }) {
    const s = await load();
    const tab = s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
    if (!tab?.url) return console.warn('[margin] pin: unknown tab', tabId);
    let result = 'pinned';
    await mutate((st) => {
      // A tab Margin hasn't placed in a space yet goes to its window's space.
      const spaceId = st.tabSpace[tabId] ?? V.activeSpaceId(st, tab.windowId);
      const next = M.addPin(st, { id: newId(), spaceId, url: tab.url, title: tab.title });
      if (next === st) result = 'not pinned (already pinned in that space, or no space)';
      return next;
    });
    console.info(`[margin] pin tab ${tabId}: ${result}`);
  },
  /** @param {{ pinId: string }} message */
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  /** @param {{ pinId: string, windowId?: number, show?: boolean | 'hover' | 'toggle' }} message `show`: keep the sidebar open there */
  async openPin({ pinId, windowId, show }) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) {
      await focusTab(existing.id);
      if (show) await carryIfSameWindow(existing.id, show, windowId);
    } else await openTab({ windowId, url: pin.url, spaceId: pin.spaceId });
  },
  /** @param {{ windowId: number, spaceId: string }} message */
  async setSpace({ windowId, spaceId }) {
    await mutate((s) => M.setActiveSpace(s, windowId, spaceId));
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
    await api.windows?.create({ focused: true });
  },
  async newTabPage(_, sender) {
    const tab = sender.tab;
    // One line per new tab, so what Safari did (⌘T vs ⌘N, a new window or a
    // tab — macOS can turn ⌘N into a tab) is visible in the background console.
    const log = (decision, why) => console.info(`[margin] new tab ${tab?.id} in window ${tab?.windowId}: ${decision} (${why})`);
    if (!tab) return log('palette on the new-tab page', 'no sender tab'), { openPalette: true };
    const s = await load();
    const prev = Object.values(s.tabs)
      .filter((t) => t.windowId === tab.windowId && t.id !== tab.id && /^https?:/.test(t.url))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
    if (!prev) return log('palette on the new-tab page', 'no web page in this window: a new window'), { openPalette: true };
    const alive = await api.tabs.sendMessage(prev.id, { type: 'ping' }).then((r) => r === 'pong').catch(() => false);
    if (!alive) return log('palette on the new-tab page', `previous tab ${prev.id} has no Margin palette (yet)`), { openPalette: true };
    log(`palette over tab ${prev.id}, new tab closed`, 'web page in this window: ⌘T (or ⌘N made into a tab by macOS)');
    await focusTab(prev.id);
    await api.tabs.remove(tab.id).catch(() => {});
    await api.tabs.sendMessage(prev.id, { type: 'command', command: 'show-palette' }).catch(() => {});
    return { handled: true };
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
