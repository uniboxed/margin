// Pure view derivation shared by the content script and the new-tab page.
// Classic script (content scripts can't be ES modules): attaches to
// globalThis.Margin. Also importable from node for tests.
(() => {
  const Margin = (globalThis.Margin ??= {});

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

  function activeSpaceId(state, windowId) {
    const id = state.activeSpaceByWindow?.[windowId];
    return state.spaces.some((s) => s.id === id) ? id : state.spaces[0].id;
  }

  // What the sidebar shows for one window. `currentTabId` is the tab the
  // sidebar is drawn in: the page being looked at is by definition the active
  // tab of its window, so it wins over a possibly stale `active` flag.
  function sidebar(state, windowId, currentTabId = null) {
    const spaceId = activeSpaceId(state, windowId);
    const known = currentTabId != null && state.tabs?.[currentTabId]?.windowId === windowId;
    const windowTabs = Object.values(state.tabs ?? {})
      .filter((t) => t.windowId === windowId)
      .map((t) => (known && t.active !== (t.id === currentTabId) ? { ...t, active: t.id === currentTabId } : t))
      .sort((a, b) => a.index - b.index);
    const spaceTabs = windowTabs.filter((t) => state.tabSpace[t.id] === spaceId);
    const pins = state.pins
      .filter((p) => p.spaceId === spaceId)
      .map((p) => {
        const key = normalizeUrl(p.url);
        const tab = spaceTabs.find((t) => normalizeUrl(t.url) === key);
        return { ...p, tabId: tab?.id ?? null, active: !!tab?.active, favIconUrl: tab?.favIconUrl ?? '' };
      });
    const pinnedUrls = new Set(pins.map((p) => normalizeUrl(p.url)));
    return {
      spaceId,
      spaces: state.spaces,
      pins,
      tabs: spaceTabs.filter((t) => !pinnedUrls.has(normalizeUrl(t.url))),
    };
  }

  // Best guess at the window a page is in, before the background has told the
  // content script its tab id (that needs the background awake, which can
  // take a while in Safari). Single window → that one; otherwise a tab with
  // this URL, preferring active and most recently used.
  function guessWindow(state, url) {
    const tabs = Object.values(state.tabs ?? {});
    const windows = new Set(tabs.map((t) => t.windowId));
    if (windows.size <= 1) return tabs[0]?.windowId ?? null;
    const byUrl = tabs.filter((t) => t.url === url);
    const pool = byUrl.length ? byUrl : tabs.filter((t) => t.active);
    pool.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastActive ?? 0) - (a.lastActive ?? 0));
    return pool[0]?.windowId ?? null;
  }

  Margin.view = { normalizeUrl, activeSpaceId, sidebar, guessWindow };
})();
