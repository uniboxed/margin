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
import { queueDockedSync, whenDockedSynced } from './registered.js';
import { navigate, NAV_ACTIONS } from './navigation.js';

export const handlers = {
  async hello(_, sender) {
    return { tabId: sender.tab?.id ?? null, windowId: sender.tab?.windowId ?? null, instanceId };
  },
  /** @param {{ tabId: number }} message */
  async activateTab({ tabId }) {
    await focusTab(tabId);
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
  // A page that still had the previous copy of Margin (content/sidebar.js
  // reloadWhenSafe): its URL loaded again once the content scripts a page
  // load needs are registered. A GET (a reload would send a form again), from
  // the browser's side (the old copy's fitted layout would cancel a page's
  // own navigation to its URL); a URL with a #fragment would only scroll, so
  // that page keeps running as it is.
  async reloadForUpdate(_, sender) {
    const { id, url } = sender.tab ?? {};
    if (id == null || !/^https?:/i.test(url ?? '') || url.includes('#')) return;
    await whenDockedSynced();
    await api.tabs.update(id, { url });
  },
  // Closing from Margin archives the tab, like Arc.
  /** @param {{ tabId: number }} message */
  async closeTab({ tabId }) {
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
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
  /** @param {{ pinId: string, windowId?: number }} message */
  async openPin({ pinId, windowId }) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) await focusTab(existing.id);
    else await openTab({ windowId, url: pin.url, spaceId: pin.spaceId });
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
    if (!alive) return log('palette on the new-tab page', `previous tab ${prev.id} has no Margin script`), { openPalette: true };
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
  /** @param {{ patch: object }} message */
  async updateSettings({ patch }) {
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
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
    await queueDockedSync();
    if (sender.tab?.id != null) await api.tabs.reload(sender.tab.id);
  },
};
