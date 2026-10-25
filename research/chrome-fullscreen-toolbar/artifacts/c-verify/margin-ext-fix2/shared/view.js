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
  // (open pinned tabs, then the space's tabs), wrapping around. From a tab
  // that isn't in the list, ↓ goes to the first and ↑ to the last. null if
  // there's nowhere to go.
  function cycleTab(state, windowId, currentTabId, dir) {
    const v = sidebar(state, windowId, currentTabId);
    const order = [...v.pins.filter((p) => p.tabId != null).map((p) => p.tabId), ...v.tabs.map((t) => t.id)];
    if (!order.length) return null;
    const at = order.indexOf(currentTabId);
    if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
    const next = order[(at + dir + order.length) % order.length];
    return next === currentTabId ? null : next;
  }

  // ⌘⌥→ / ⌘⌥←: the next/previous space for this window, wrapping around.
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
  function iconFor(state, item) {
    if (/^(https?|data):/.test(item?.favIconUrl ?? '')) return item.favIconUrl;
    const origin = originOf(item?.url);
    return (origin && state?.favicons?.[origin]?.data) || '';
  }

  // ---- sidebar width ---------------------------------------------------------
  // Resizable by dragging its right edge. Range measured from Arc (Tirth's
  // screenshots): 160–500 CSS px. Stored widths snap to 10px so the first-paint
  // placeholder (content/docked/w-<width>.css) has a file for every width.
  const WIDTH = { min: 160, max: 500, default: 260, step: 10 };
  const clampWidth = (w) => Math.min(WIDTH.max, Math.max(WIDTH.min, Number.isFinite(w) ? w : WIDTH.default));
  const snapWidth = (w) => clampWidth(Math.round(clampWidth(w) / WIDTH.step) * WIDTH.step);
  // The width to use for a state (missing or odd values fall back safely).
  const sidebarWidth = (state) => snapWidth(Number(state?.settings?.sidebarWidth ?? WIDTH.default));

  Margin.view = { WIDTH, clampWidth, snapWidth, sidebarWidth, normalizeUrl, activeSpaceId, sidebar, guessWindow, revealZone, cycleTab, cycleSpace, originOf, pickIconHref, iconFor };
})();
