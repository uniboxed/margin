// Pure input/search helpers shared by the new-tab launcher and the palette.
import * as P from './platform.js';
import * as V from './view.js';


// ---- the browser's search engine ------------------------------------------
// Margin searches with the browser's engine, never its own choice:
//  - Chrome: the `search` API (chrome.search.query) uses Chrome's default.
//  - Safari has no such API and no way to read its settings, so Margin
//    learns the engine from searches Safari makes from its address bar:
//    Safari tags those URLs (Google `client=safari`, Bing `form=AP…`,
//    DuckDuckGo `t=osx`, Ecosia `tts=st_asaf_…`, Yahoo `fr=aapl…`; see
//    DECISIONS.md), so a search made on an engine's own site doesn't count.
//    Until it has seen one, Safari's default (Google). Margin's searches use
//    the same URLs Safari makes on macOS, on the same (regional) host.
const SAFARI_ENGINES = {
  google: {
    name: 'Google',
    host: /^www\.google(\.[a-z]{2,3}){1,2}$/,
    path: /^\/search$/,
    fromSafari: (p) => p.get('client') === 'safari',
    template: (host) => `https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`,
  },
  bing: {
    name: 'Bing',
    host: /^www\.bing\.com$/,
    path: /^\/search$/,
    fromSafari: (p) => /^AP/.test(p.get('form') ?? ''),
    template: (host) => `https://${host}/search?q=%s&form=APMCS1&PC=APMC`,
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    host: /^duckduckgo\.com$/,
    path: /^\/$/,
    fromSafari: (p) => ['osx', 'iphone', 'ipad'].includes(p.get('t')),
    template: (host) => `https://${host}/?q=%s&t=osx&ia=web`,
  },
  ecosia: {
    name: 'Ecosia',
    host: /^www\.ecosia\.org$/,
    path: /^\/search$/,
    fromSafari: (p) => (p.get('tts') ?? '').startsWith('st_asaf_'),
    template: (host) => `https://${host}/search?q=%s&tts=st_asaf_macos`,
  },
  yahoo: {
    name: 'Yahoo',
    host: /^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,
    path: /^\/search(;[^/]*)?$/, // Yahoo adds ;_ylt=…;_ylc=… to the path
    fromSafari: (p) => /^(aapl|iphone$|ipad$)/.test(p.get('fr') ?? '') || p.get('.tsrc') === 'apple',
    template: (host) => `https://${host}/search?ei=utf-8&fr=aaplw&p=%s`,
  },
};
const SAFARI_DEFAULT = Object.freeze({ id: 'google', name: 'Google', template: SAFARI_ENGINES.google.template('www.google.com') });

// A search Safari made from its address bar → { id, name, template }, else null.
function detectSafariSearch(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const [id, e] of Object.entries(SAFARI_ENGINES)) {
    if (e.host.test(u.hostname) && e.path.test(u.pathname) && e.fromSafari(u.searchParams)) {
      return { id, name: e.name, template: e.template(u.hostname) };
    }
  }
  return null;
}

// Which engine's site a URL is on (any search there), for diagnostics.
function searchEngineOf(url) {
  try {
    const u = new URL(url);
    return Object.values(SAFARI_ENGINES).find((e) => e.host.test(u.hostname) && e.path.test(u.pathname))?.name ?? null;
  } catch {
    return null;
  }
}

// The engine Margin's searches use in Safari: learned, else the default.
const safariEngine = (settings) => (settings?.safariSearch?.template?.includes('%s') ? settings.safariSearch : SAFARI_DEFAULT);
const searchUrl = (query, settings) => safariEngine(settings).template.replace('%s', encodeURIComponent(query));
// For display: which engine a search goes to.
const engineLabel = (settings, platform = P.platform) =>
  (platform?.search === 'browser' ? 'Chrome’s search engine' : safariEngine(settings).name);

const WITH_SCHEME = /^(https?|file|ftp):\/\//i;
const OPAQUE_SCHEME = /^(about|data|mailto|view-source):/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;

// Text typed into the launcher or palette → { kind: 'url', url } or
// { kind: 'search', query } (run by the background with the browser's engine).
function resolveInput(text) {
  const input = (text ?? '').trim();
  if (!input) return null;
  if (WITH_SCHEME.test(input) || OPAQUE_SCHEME.test(input)) return { kind: 'url', url: input };
  if (!/\s/.test(input)) {
    if (LOCAL.test(input)) return { kind: 'url', url: `http://${input}` };
    if (DOMAIN.test(input)) return { kind: 'url', url: `https://${input}` };
  }
  return { kind: 'search', query: input };
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
// { windowId, tabId, inNewTab, canToggleSidebar, canFullscreen }.
function paletteItems(state, ctx) {
  const view = V;
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
      favIconUrl: V.iconFor(state, t),
      badge: space?.name ?? '', // Arc-style: the row shows which space it's in
      boost: (space?.id === spaceId ? 30 : 10) + (t.id === ctx.tabId ? -25 : 0),
      recency: t.lastActive ?? 0,
      action: { type: 'activateTab', tabId: t.id },
    });
  }
  // Margin's tabs that aren't open (state/model.js keptTabs): chosen, one
  // opens in this window.
  for (const k of Object.values(state.keptTabs ?? {})) {
    const space = spaceOf(k.spaceId);
    items.push({
      id: `tab:${k.id}`,
      kind: 'tab',
      title: k.title || k.url,
      subtitle: k.url,
      url: k.url,
      favIconUrl: V.iconFor(state, k),
      badge: space?.name ?? '',
      boost: space?.id === spaceId ? 25 : 8,
      recency: k.lastActive ?? 0,
      action: { type: 'activateTab', tabId: k.id, ...(ctx.windowId != null ? { windowId: ctx.windowId } : {}) },
    });
  }
  for (const p of state.pins ?? []) {
    const space = spaceOf(p.spaceId);
    const folder = p.folderId ? (state.folders ?? []).find((f) => f.id === p.folderId && f.spaceId === p.spaceId) : null;
    items.push({
      id: `pin:${p.id}`,
      kind: 'pin',
      title: p.title,
      subtitle: p.url,
      url: p.url,
      favIconUrl: V.iconFor(state, p),
      badge: folder ? `${folder.name} · ${space?.name ?? 'Pinned'}` : space?.name ?? 'Pinned',
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
      favIconUrl: V.iconFor(state, a),
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
  // A real window even when macOS turns ⌘N into a tab ("Prefer tabs when
  // opening documents", which defaults to doing that in full screen).
  action('new-window', 'New window', { type: 'newWindow' }, { emoji: '⧉' });
  if (!ctx.inNewTab) action('launcher', 'Margin start page & settings', { type: 'openLauncher', windowId: ctx.windowId }, { emoji: '⚙︎' });
  if (ctx.canToggleSidebar) action('toggle-sidebar', 'Toggle sidebar', { local: 'toggleSidebar' }, { emoji: '◧' });
  // Chrome: full screen with no toolbar (background/fullscreen.js).
  if (ctx.canFullscreen) action('fullscreen', 'Margin full screen (no toolbar) on/off', { type: 'toggleFullscreen', windowId: ctx.windowId }, { emoji: '⛶' });
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
  const target = resolveInput(q);
  if (target) {
    const isUrl = target.kind === 'url';
    const go = {
      id: 'go',
      kind: 'go',
      title: isUrl ? `Open ${target.url}` : `Search for “${q}”`,
      badge: isUrl ? 'Open' : 'Search',
      subtitle: isUrl ? '' : engineLabel(state.settings),
      emoji: isUrl ? '↗' : '⌕',
      action: isUrl
        ? (ctx.inNewTab ? { local: 'navigate', url: target.url } : { type: 'newTab', windowId: ctx.windowId, url: target.url })
        : (ctx.inNewTab ? { local: 'search', query: target.query } : { type: 'search', query: target.query, windowId: ctx.windowId }),
    };
    if (target.kind === 'url') ranked.unshift(go);
    else ranked.push(go);
  }
  return ranked;
}

export {
  SAFARI_ENGINES, SAFARI_DEFAULT, detectSafariSearch, searchEngineOf, safariEngine, searchUrl, engineLabel,
  resolveInput, fuzzyScore, paletteItems, rankPalette,
};
