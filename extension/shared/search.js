// Pure input/search helpers shared by the new-tab launcher and the palette.
// Classic script: attaches to globalThis.Margin.
(() => {
  const Margin = (globalThis.Margin ??= {});

  const SEARCH_ENGINES = [
    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
    { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ];
  const DEFAULT_ENGINE = SEARCH_ENGINES[0].url;

  const WITH_SCHEME = /^(https?|file|ftp):\/\//i;
  const OPAQUE_SCHEME = /^(about|data|mailto|view-source):/i;
  const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i;
  const DOMAIN = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;

  // Text typed into the launcher or palette → { kind: 'url' | 'search', url }.
  function resolveInput(text, engine = DEFAULT_ENGINE) {
    const input = (text ?? '').trim();
    if (!input) return null;
    if (WITH_SCHEME.test(input) || OPAQUE_SCHEME.test(input)) return { kind: 'url', url: input };
    if (!/\s/.test(input)) {
      if (LOCAL.test(input)) return { kind: 'url', url: `http://${input}` };
      if (DOMAIN.test(input)) return { kind: 'url', url: `https://${input}` };
    }
    const template = engine?.includes('%s') ? engine : DEFAULT_ENGINE;
    return { kind: 'search', url: template.replace('%s', encodeURIComponent(input)) };
  }

  // ---- fuzzy matching ---------------------------------------------------------

  const isWordStart = (text, i) => i === 0 || /[\s\-_./:]/.test(text[i - 1]);

  // Higher is better; -Infinity means no match. Substrings beat scattered
  // subsequences; prefixes and word starts get a bonus.
  function fuzzyScore(query, text) {
    const q = query.toLowerCase();
    const t = (text ?? '').toLowerCase();
    if (!q) return 0;
    const at = t.indexOf(q);
    if (at >= 0) return 100 + (at === 0 ? 40 : 0) + (isWordStart(t, at) ? 20 : 0) + q.length * 2 - at * 0.1 - t.length * 0.01;
    let score = 0;
    let from = 0;
    let prev = -2;
    for (const ch of q) {
      const found = t.indexOf(ch, from);
      if (found < 0) return -Infinity;
      score += (found === prev + 1 ? 5 : 1) + (isWordStart(t, found) ? 3 : 0);
      prev = found;
      from = found + 1;
    }
    return score - t.length * 0.01;
  }

  // Every whitespace-separated token must match the title or the subtitle.
  function matchScore(query, item) {
    let total = 0;
    for (const token of query.split(/\s+/).filter(Boolean)) {
      const best = Math.max(fuzzyScore(token, item.title), fuzzyScore(token, item.subtitle) - 10);
      if (best === -Infinity) return -Infinity;
      total += best;
    }
    return total;
  }

  // ---- palette items --------------------------------------------------------

  const isWebUrl = (url) => /^https?:/i.test(url ?? '');

  // Everything the palette can offer for this window. `ctx`:
  // { windowId, tabId, inNewTab, canToggleSidebar }.
  function paletteItems(state, ctx) {
    const view = Margin.view;
    const spaceId = view.activeSpaceId(state, ctx.windowId);
    const spaceOf = (id) => state.spaces.find((s) => s.id === id);
    const items = [];

    for (const t of Object.values(state.tabs ?? {})) {
      const space = spaceOf(state.tabSpace?.[t.id]);
      items.push({
        id: `tab:${t.id}`,
        kind: 'tab',
        title: t.title || t.url || 'New Tab',
        subtitle: t.url,
        url: t.url,
        favIconUrl: Margin.view.iconFor(state, t),
        badge: space && space.id !== spaceId ? `${space.emoji} ${space.name}` : '',
        boost: (space?.id === spaceId ? 30 : 10) + (t.id === ctx.tabId ? -25 : 0),
        recency: t.lastActive ?? 0,
        action: { type: 'activateTab', tabId: t.id },
      });
    }
    for (const p of state.pins ?? []) {
      const space = spaceOf(p.spaceId);
      items.push({
        id: `pin:${p.id}`,
        kind: 'pin',
        title: p.title,
        subtitle: p.url,
        url: p.url,
        favIconUrl: Margin.view.iconFor(state, p),
        badge: `📌${space && space.id !== spaceId ? ` ${space.emoji} ${space.name}` : ''}`,
        boost: p.spaceId === spaceId ? 20 : 8,
        action: { type: 'openPin', pinId: p.id, windowId: ctx.windowId },
      });
    }
    for (const a of state.archive ?? []) {
      items.push({
        id: `archive:${a.id}`,
        kind: 'archive',
        title: a.title || a.url,
        subtitle: a.url,
        url: a.url,
        favIconUrl: Margin.view.iconFor(state, a),
        badge: 'Archived',
        boost: 0,
        recency: a.closedAt ?? 0,
        action: { type: 'restoreArchive', archiveId: a.id, windowId: ctx.windowId },
      });
    }

    const action = (id, title, act, extra = {}) =>
      items.push({ id: `action:${id}`, kind: 'action', title, subtitle: '', boost: 12, action: act, ...extra });
    const current = state.tabs?.[ctx.tabId];
    const currentSpace = state.tabSpace?.[ctx.tabId];
    if (current && isWebUrl(current.url) && !state.pins.some((p) => p.spaceId === currentSpace && view.normalizeUrl(p.url) === view.normalizeUrl(current.url))) {
      action('pin-current', 'Pin current tab', { type: 'pinTab', tabId: ctx.tabId }, { emoji: '📌' });
    }
    // ⌘T opens this palette instead of the launcher page, so the launcher
    // (and its Settings) is reachable from here.
    if (!ctx.inNewTab) action('launcher', 'Margin start page & settings', { type: 'openLauncher', windowId: ctx.windowId }, { emoji: '⚙︎' });
    if (ctx.canToggleSidebar) action('toggle-sidebar', 'Toggle sidebar', { local: 'toggleSidebar' }, { emoji: '◧' });
    for (const s of state.spaces) {
      if (s.id === spaceId) continue;
      action(`space:${s.id}`, `Switch to space ${s.name}`, { type: 'setSpace', windowId: ctx.windowId, spaceId: s.id }, { emoji: s.emoji });
    }
    return items;
  }

  const KIND_ORDER = { tab: 0, action: 1, pin: 2, archive: 3 };

  // Ranked palette results for `query`, including an "Open URL / Search for"
  // entry: first when the text is a URL, last when it's a search.
  function rankPalette(state, query, ctx, limit = 40) {
    const q = (query ?? '').trim();
    const items = paletteItems(state, ctx);
    let ranked;
    if (!q) {
      ranked = items
        .filter((i) => i.kind !== 'archive' && i.id !== `tab:${ctx.tabId}`)
        .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.boost - a.boost || (b.recency ?? 0) - (a.recency ?? 0));
    } else {
      ranked = items
        .map((item) => ({ item, score: matchScore(q, item) }))
        .filter((r) => r.score > -Infinity)
        .map((r) => ({ ...r, score: r.score + r.item.boost }))
        .sort((a, b) => b.score - a.score || (b.item.recency ?? 0) - (a.item.recency ?? 0))
        .map((r) => r.item);
    }
    ranked = ranked.slice(0, limit);
    const target = resolveInput(q, state.settings?.searchEngine);
    if (target) {
      const go = {
        id: 'go',
        kind: 'go',
        title: target.kind === 'url' ? `Open ${target.url}` : `Search for “${q}”`,
        subtitle: target.kind === 'url' ? '' : target.url,
        emoji: target.kind === 'url' ? '↗' : '⌕',
        action: ctx.inNewTab ? { local: 'navigate', url: target.url } : { type: 'newTab', windowId: ctx.windowId, url: target.url },
      };
      if (target.kind === 'url') ranked.unshift(go);
      else ranked.push(go);
    }
    return ranked;
  }

  Margin.search = { SEARCH_ENGINES, DEFAULT_ENGINE, resolveInput, fuzzyScore, paletteItems, rankPalette };
})();
