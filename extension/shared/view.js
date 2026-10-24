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

  // What the sidebar shows for one window.
  function sidebar(state, windowId) {
    const spaceId = activeSpaceId(state, windowId);
    const windowTabs = Object.values(state.tabs ?? {})
      .filter((t) => t.windowId === windowId)
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

  Margin.view = { normalizeUrl, activeSpaceId, sidebar };
})();
