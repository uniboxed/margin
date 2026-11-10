// Pure input/search helpers shared by the new-tab launcher and the palette.
import type { State } from '../../types/margin';
import * as P from './capabilities.ts';
import * as V from './view.ts';
import { foreignKey, isMultiProfile, profileOf } from './across.ts';
import { cloudShown, deviceNames, onDevice } from './cloud-tabs.ts';


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
    fromSafari: (p: URLSearchParams) => p.get('client') === 'safari',
    template: (host: string) => `https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`,
  },
  bing: {
    name: 'Bing',
    host: /^www\.bing\.com$/,
    path: /^\/search$/,
    fromSafari: (p: URLSearchParams) => /^AP/.test(p.get('form') ?? ''),
    template: (host: string) => `https://${host}/search?q=%s&form=APMCS1&PC=APMC`,
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    host: /^duckduckgo\.com$/,
    path: /^\/$/,
    fromSafari: (p: URLSearchParams) => ['osx', 'iphone', 'ipad'].includes(p.get('t') ?? ''),
    template: (host: string) => `https://${host}/?q=%s&t=osx&ia=web`,
  },
  ecosia: {
    name: 'Ecosia',
    host: /^www\.ecosia\.org$/,
    path: /^\/search$/,
    fromSafari: (p: URLSearchParams) => (p.get('tts') ?? '').startsWith('st_asaf_'),
    template: (host: string) => `https://${host}/search?q=%s&tts=st_asaf_macos`,
  },
  yahoo: {
    name: 'Yahoo',
    host: /^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,
    path: /^\/search(;[^/]*)?$/, // Yahoo adds ;_ylt=…;_ylc=… to the path
    fromSafari: (p: URLSearchParams) => /^(aapl|iphone$|ipad$)/.test(p.get('fr') ?? '') || p.get('.tsrc') === 'apple',
    template: (host: string) => `https://${host}/search?ei=utf-8&fr=aaplw&p=%s`,
  },
};
const SAFARI_DEFAULT = Object.freeze({ id: 'google', name: 'Google', template: SAFARI_ENGINES.google.template('www.google.com') });

// A search Safari made from its address bar → { id, name, template }, else null.
function detectSafariSearch(url: string) {
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
function searchEngineOf(url: string) {
  try {
    const u = new URL(url);
    return Object.values(SAFARI_ENGINES).find((e) => e.host.test(u.hostname) && e.path.test(u.pathname))?.name ?? null;
  } catch {
    return null;
  }
}

// The engine Margin's searches use in Safari: learned, else the default.
// (`settings`: the stored settings.)
const safariEngine = (settings: any) => (settings?.safariSearch?.template?.includes('%s') ? settings.safariSearch : SAFARI_DEFAULT);
const searchUrl = (query: string, settings: any) => safariEngine(settings).template.replace('%s', encodeURIComponent(query));
// For display: which engine a search goes to.
const engineLabel = (settings: any, browserCan: Pick<P.Capabilities, 'search'> = P.capabilities) =>
  (browserCan?.search === 'browser' ? 'Chrome’s search engine' : safariEngine(settings).name);

const WITH_SCHEME = /^(https?|file|ftp):\/\//i;
const OPAQUE_SCHEME = /^(about|data|mailto|view-source):/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;

// Text typed into the launcher or palette → { kind: 'url', url } or
// { kind: 'search', query } (run by the background with the browser's engine).
function resolveInput(text: string): { kind: 'url', url: string } | { kind: 'search', query: string } | null {
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

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_./:]/.test(text[i - 1]);

// Higher is better; -Infinity means no match. Substrings beat scattered
// subsequences; prefixes and word starts get a bonus.
function fuzzyScore(query: string, text: string) {
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
function matchScore(query: string, item: PaletteItem) {
  let total = 0;
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const best = Math.max(fuzzyScore(token, item.title), fuzzyScore(token, item.subtitle) - 10);
    if (best === -Infinity) return -Infinity;
    total += best;
  }
  return total;
}

// ---- palette items --------------------------------------------------------

const isWebUrl = (url: string | null | undefined) => /^https?:/i.test(url ?? '');

// One thing the palette can offer: a tab, a pin, an archived tab, an action, an iCloud tab. `boost` lifts it in
// the ranking, `recency` breaks ties (its last use); `action`, what choosing it asks for.
export type PaletteItem = {
  id: string, kind: string, title: string, subtitle: string, url?: string, favIconUrl?: string, badge?: string,
  spaceColor?: string, boost?: number, recency?: number, section?: string, sectionStart?: boolean, action: any,
  /** a row's emoji (a space's, an action's); `search`: the typed text as a search (the go row) */
  emoji?: string, search?: boolean,
  [extra: string]: unknown,
};

// Everything the palette can offer for this window. `ctx`:
// { windowId, tabId, inNewTab, canToggleSidebar, canFullscreen }.
function paletteItems(state: State, ctx: { windowId: number | null; tabId: number | null; inNewTab: boolean; canToggleSidebar: boolean; canFullscreen: boolean; }) {
  const view = V;
  const spaceId = view.activeSpaceId(state, ctx.windowId);
  const spaceOf = (id: string | undefined) => state.spaces.find((s) => s.id === id);
  // (Each with its boost: the ranking adds it. iCloud tabs, which have none, are ranked apart: cloudMatches.)
  const items: (PaletteItem & { boost: number })[] = [];

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
      spaceColor: space?.color ?? '',
      boost: (space?.id === spaceId ? 30 : 10) + (t.id === ctx.tabId ? -25 : 0),
      recency: t.lastActive ?? 0,
      action: { type: 'activateTab', tabId: t.id },
    });
  }
  // Margin's tabs that aren't open (state/model.ts keptTabs): chosen, one
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
      spaceColor: space?.color ?? '',
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
      spaceColor: space?.color ?? '',
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

  const action = (id: string, title: string, act: Record<string, any>, extra = {}) =>
    items.push({ id: `action:${id}`, kind: 'action', title, subtitle: '', boost: 12, action: act, ...extra });
  // (No tab yet: none current.)
  const current = state.tabs?.[ctx.tabId as number];
  const currentSpace = state.tabSpace?.[ctx.tabId as number];
  if (current && isWebUrl(current.url) && !state.pins.some((p) => p.spaceId === currentSpace && view.normalizeUrl(p.url) === view.normalizeUrl(current.url))) {
    action('pin-current', 'Pin current tab', { type: 'pinTab', tabId: ctx.tabId }, { emoji: '📌' });
  }
  // ⌘T opens this palette instead of the launcher page, so the launcher
  // (and its Settings) is reachable from here.
  // A real window even when macOS turns ⌘N into a tab ("Prefer tabs when
  // opening documents", which defaults to doing that in full screen).
  // A Margin window of its own, in full screen like this one, on its space (background/handlers.ts newWindow).
  action('new-window', 'New window', { type: 'newWindow', ...(ctx.windowId != null ? { fromWindowId: ctx.windowId } : {}) }, { emoji: '⧉' });
  if (!ctx.inNewTab) action('launcher', 'Margin start page & settings', { type: 'openLauncher', windowId: ctx.windowId }, { emoji: '⚙︎' });
  if (ctx.canToggleSidebar) action('toggle-sidebar', 'Toggle sidebar', { local: 'toggleSidebar' }, { emoji: '◧' });
  // Chrome: full screen with no toolbar (extension/engines/chromium/fullscreen.ts).
  if (ctx.canFullscreen) action('fullscreen', 'Margin full screen (no toolbar) on/off', { type: 'toggleFullscreen', windowId: ctx.windowId }, { emoji: '⛶' });
  for (const s of state.spaces) {
    if (s.id === spaceId) continue;
    action(`space:${s.id}`, `Switch to space ${s.name}`, { type: 'setSpace', windowId: ctx.windowId, spaceId: s.id }, { emoji: s.emoji });
  }
  // Other profiles' spaces (Margin.app): the switch to that profile's window.
  const across = (state as any).across;
  if (isMultiProfile(across)) {
    for (const s of across.spaces) {
      if (s.profile === across.profile) continue;
      const key = foreignKey(s.profile, s.id);
      action(`space:${key}`, `Switch to space ${s.name} (${profileOf(across, s.profile)?.name ?? 'another profile'})`, { type: 'setSpace', windowId: ctx.windowId, spaceId: key }, { emoji: s.emoji });
    }
  }
  return items;
}

const KIND_ORDER: Record<string, number> = { tab: 0, action: 1, pin: 2, archive: 3 };

// iCloud Tabs (Margin.app with Safari: shared/cloud-tabs.ts) matching what's
// typed: their own section after Margin's own rows (open tabs, pins, actions,
// the archive) and before "Search for …", one run per device ("On Nora's
// iPhone"), the device with the best match first (as good a match: the one
// used most recently). Never before typing, and
// not a page that's open here already (its tab is the row for it). Chosen,
// one opens as an address typed there would: in a new tab of this window,
// in its space (or in Margin's new-tab page, in place).
const CLOUD_MAX = 8;
const CLOUD_PER_DEVICE = 5;
function cloudMatches(state: State, q: string, ctx: { windowId: number | null; tabId: number | null; inNewTab: boolean; canToggleSidebar: boolean; canFullscreen: boolean; }) {
  const cloud = cloudShown(state);
  if (!q || cloud?.status !== 'ready') return [];
  const open = new Set(Object.values(state.tabs ?? {}).map((t) => V.normalizeUrl(t.url)));
  const names = deviceNames(cloud.devices);
  const groups: { best: number, hits: { item: PaletteItem, score: number }[] }[] = [];
  for (const d of cloud.devices) {
    const section = onDevice(names.get(d.id) ?? d.name);
    const hits = d.tabs
      .filter((t) => !open.has(V.normalizeUrl(t.url)))
      .map((t) => {
        const item = {
          id: `cloud:${t.id}`,
          kind: 'cloud',
          title: t.title || t.url,
          subtitle: t.url,
          url: t.url,
          favIconUrl: V.iconFor(state, { url: t.url }),
          badge: 'iCloud',
          section,
          action: ctx.inNewTab ? { local: 'navigate', url: t.url } : { type: 'newTab', windowId: ctx.windowId, url: t.url },
        };
        return { item, score: matchScore(q, item) };
      })
      .filter((r) => r.score > -Infinity)
      .sort((a, b) => b.score - a.score)
      .slice(0, CLOUD_PER_DEVICE);
    if (hits.length) groups.push({ best: hits[0].score, hits });
  }
  // About as good a match: the device used most recently first (the app's order).
  groups.sort((a, b) => Math.round(b.best) - Math.round(a.best));
  const out = groups.flatMap((g) => g.hits.map((h) => h.item)).slice(0, CLOUD_MAX);
  return out.map((item, i) => ({ ...item, sectionStart: i === 0 || out[i - 1].section !== item.section }));
}

// Ranked palette results for `query`, including an "Open URL / Search for"
// entry: first when the text is a URL, last when it's a search.
function rankPalette(state: State, query: string, ctx: { windowId: number | null; tabId: number | null; inNewTab: boolean; canToggleSidebar: boolean; canFullscreen: boolean; }, limit = 40) {
  const q = (query ?? '').trim();
  const items = paletteItems(state, ctx);
  let ranked: PaletteItem[];
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
  ranked = [...ranked.slice(0, limit), ...cloudMatches(state, q, ctx)];
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
      search: !isUrl,
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
