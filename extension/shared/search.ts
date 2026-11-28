// Pure input/search helpers shared by the new-tab launcher and the palette.
import type { State } from '../../types/margin';
import * as P from './capabilities.ts';
import * as V from './view.ts';
import type { InstalledApp } from './apps.ts';


// ---- the browser's search engine ------------------------------------------
// Margin searches with the browser's engine, never its own choice, and never
// guesses it:
//  - Chrome: the `search` API (chrome.search.query) uses Chrome's default.
//  - Safari: no such API. Margin.app reads the engine chosen in Safari's
//    Settings from macOS's record of it and searches there
//    (core/session/suggest.rs); the extension alone uses Safari's default.
// Safari's engines: their search addresses as Safari makes them on macOS (the
// core's the same: tests/fixtures/search-engines.json) and their results
// pages' hosts and paths (`searchEngineOf`: a page of search results).
const SAFARI_ENGINES = {
  google: {
    name: 'Google',
    host: /^www\.google(\.[a-z]{2,3}){1,2}$/,
    path: /^\/search$/,
    template: (host: string) => `https://${host}/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8`,
  },
  bing: {
    name: 'Bing',
    host: /^www\.bing\.com$/,
    path: /^\/search$/,
    template: (host: string) => `https://${host}/search?q=%s&form=APMCS1&PC=APMC`,
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    host: /^duckduckgo\.com$/,
    path: /^\/$/,
    template: (host: string) => `https://${host}/?q=%s&t=osx&ia=web`,
  },
  ecosia: {
    name: 'Ecosia',
    host: /^www\.ecosia\.org$/,
    path: /^\/search$/,
    template: (host: string) => `https://${host}/search?q=%s&tts=st_asaf_macos`,
  },
  yahoo: {
    name: 'Yahoo',
    host: /^([a-z]{2,10}\.)?search\.yahoo(\.[a-z]{2,3}){1,2}$/,
    path: /^\/search(;[^/]*)?$/, // Yahoo adds ;_ylt=…;_ylc=… to the path
    template: (host: string) => `https://${host}/search?ei=utf-8&fr=aaplw&p=%s`,
  },
};
const SAFARI_DEFAULT = Object.freeze({ id: 'google', name: 'Google', template: SAFARI_ENGINES.google.template('www.google.com') });

// Which engine's site a URL is on (any search there), for diagnostics.
function searchEngineOf(url: string) {
  try {
    const u = new URL(url);
    return Object.values(SAFARI_ENGINES).find((e) => e.host.test(u.hostname) && e.path.test(u.pathname))?.name ?? null;
  } catch {
    return null;
  }
}

// A search the extension makes itself in Safari (its own pages, Margin.app not linked: no engine is known there):
// Safari's default's address. Margin.app's searches go to the engine macOS names (core/session/suggest.rs).
const searchUrl = (query: string) => SAFARI_DEFAULT.template.replace('%s', encodeURIComponent(query));
// For display: which engine a search goes to.
const engineLabel = (browserCan: Pick<P.Capabilities, 'search'> = P.capabilities) =>
  (browserCan?.search === 'browser' ? 'Chrome’s search engine' : SAFARI_DEFAULT.name);

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

// One thing the palette can offer: a tab, a pin, an archived tab, an action, an installed app. `boost` lifts it in
// the ranking, `recency` breaks ties (its last use); `action`, what choosing it asks for.
export type PaletteItem = {
  id: string, kind: string, title: string, subtitle: string, url?: string, favIconUrl?: string, badge?: string,
  spaceColor?: string, boost?: number, recency?: number, section?: string, sectionStart?: boolean, action: any,
  /** a row's emoji (a space's, an action's); `search`: the typed text as a search (the go row) */
  emoji?: string, search?: boolean,
  /**
   * As Arc's command bar shows a row (docs/ARC-COMMAND-BAR.md): `detail`, what follows its title (" — weather.com": a
   * past page's address; none on a tab, a pin, a search); `completion`, the text the field completes what's typed to
   * while it's the selected row (a site's domain, a suggestion's words, an app's name; none: no completion).
   * `subtitle` stays what the typed words are matched against (a page's whole address).
   */
  detail?: string, completion?: string,
  [extra: string]: unknown,
};

// Everything the palette can offer for this window. `ctx`:
// { windowId, tabId, inNewTab, canToggleSidebar, canFullscreen }.
function paletteItems(state: State, ctx: { windowId: number | null; tabId: number | null; inNewTab: boolean; canToggleSidebar: boolean; canFullscreen: boolean; appWindow?: boolean; }) {
  const view = V;
  const spaceId = view.activeSpaceId(state, ctx.windowId);
  const spaceOf = (id: string | undefined) => state.spaces.find((s) => s.id === id);
  // (Each with its boost: the ranking adds it.)
  const items: (PaletteItem & { boost: number })[] = [];

  for (const t of Object.values(state.tabs ?? {})) {
    if (V.isPlaceholderPage(t.url)) continue;
    const space = spaceOf(state.tabSpace?.[t.id]);
    items.push({
      id: `tab:${t.id}`,
      kind: 'tab',
      title: V.isLauncherPage(t.url) && /#settings$/i.test(t.url) ? 'Settings' : t.title || t.url || 'Untitled',
      subtitle: t.url,
      url: t.url,
      favIconUrl: V.iconFor(state, t),
      // (Arc's: "Switch to Tab" in this space, the space's name in another.)
      badge: space?.id === spaceId ? SWITCH_TO_TAB : space?.name ?? '',
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
      badge: space?.id === spaceId ? SWITCH_TO_TAB : space?.name ?? '',
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
      badge: '',
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
  action('settings', 'Settings', { type: 'openLauncher', windowId: ctx.windowId, settings: true }, { emoji: '⚙︎' });
  // Archive: the Library's (Arc's) in Margin.app's own window, which has no launcher page; else the launcher's.
  if (ctx.appWindow) action('launcher', 'Archive', { local: 'archive' }, { emoji: '◷' });
  else if (!ctx.inNewTab) action('launcher', 'Archive', { type: 'openLauncher', windowId: ctx.windowId }, { emoji: '◷' });
  if (ctx.canToggleSidebar) action('toggle-sidebar', 'Toggle sidebar', { local: 'toggleSidebar' }, { emoji: '◧' });
  // Chrome: full screen with no toolbar (extension/engines/chromium/fullscreen.ts).
  if (ctx.canFullscreen) action('fullscreen', 'Margin full screen (no toolbar) on/off', { type: 'toggleFullscreen', windowId: ctx.windowId }, { emoji: '⛶' });
  for (const s of state.spaces) {
    if (s.id === spaceId) continue;
    action(`space:${s.id}`, `Switch to space ${s.name}`, { type: 'setSpace', windowId: ctx.windowId, spaceId: s.id }, { emoji: s.emoji });
  }
  return items;
}

const KIND_ORDER: Record<string, number> = { tab: 0, action: 1, pin: 2, archive: 3 };

// Installed apps (Margin.app with hosting on: shared/apps.ts, the state's
// `apps`) matching what's typed, ranked among Margin's own rows. Never before
// typing, nor for one letter, and only by their names' words: each typed word
// must start a word of the name ("code" finds Visual Studio Code, not Xcode),
// so an ordinary query isn't swamped by apps. The name typed in full ranks
// first (APP_EXACT); typed from its start, about level with a matching tab of
// this space (APP_PREFIX); otherwise below tabs and pins; at most APP_MAX.
// Chosen, the app is asked to open it in the page area (`app.open`).
const APP_MAX = 5;
const APP_EXACT = 60;
const APP_PREFIX = 20;
function wordStartAt(text: string, token: string) {
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) if (isWordStart(text, at)) return at;
  return -1;
}
// A row's id for an app: an action's argument has no dots (ui/actions.ts ID_TEXT), and a bundle id never has a
// colon, so its dots become colons; one too long for an id is named by a hash of it.
function appRowId(bundleId: string) {
  const id = `app:${bundleId.replace(/\./g, ':')}`;
  if (id.length <= 64) return id;
  let h = 0x811c9dc5;
  for (let i = 0; i < bundleId.length; i++) h = Math.imul(h ^ bundleId.charCodeAt(i), 0x01000193);
  return `app-${(h >>> 0).toString(36)}-${bundleId.length}`;
}
function appMatches(state: State, q: string) {
  const apps = (state as { apps?: InstalledApp[] | null }).apps;
  const typed = q.toLowerCase().replace(/\s+/g, ' ');
  if (!Array.isArray(apps) || !apps.length || typed.length < 2) return [];
  const tokens = typed.split(' ');
  const hits: { item: PaletteItem & { boost: number }, score: number }[] = [];
  for (const a of apps) {
    const name = a.name.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (wordStartAt(name, t) < 0) { score = -Infinity; break; }
      score += fuzzyScore(t, a.name);
    }
    if (score === -Infinity) continue;
    const boost = name === typed ? APP_EXACT : name.startsWith(typed) ? APP_PREFIX : 0;
    hits.push({
      item: { id: appRowId(a.bundleId), kind: 'app', title: a.name, subtitle: '', favIconUrl: a.icon ?? undefined, badge: 'App', boost, action: { perform: 'app.open', arg: { bundleId: a.bundleId, name: a.name } } },
      score,
    });
  }
  return hits.sort((x, y) => y.score + y.item.boost - (x.score + x.item.boost) || x.item.title.localeCompare(y.item.title)).slice(0, APP_MAX);
}

// The search engine's suggestions for what's typed (Margin.app's, from the engine macOS names: core/session/suggest.rs),
// as its window's page keeps them (ui/host-app.ts `search`): the query they're for, the engine and the suggestions.
export type SearchSuggestions = { query: string, items: string[], engine?: { id: string, name: string } | null };
// What the palette shows of a query (Arc's and Safari's order): the typed text's own row (Open… or Search for…) first,
// unless one of the person's things is a clear match for it (`topHit`), which goes above it; then the engine's
// suggestions (SUGGEST_MAX); then the person's tabs, pins, apps and actions (OWN_MAX); then archived tabs (ARCHIVE_MAX).
// A page of search results (an engine's, any search) is never a top hit, and archived ones aren't offered while typing:
// the engine's suggestions say those searches, and an old search page isn't what's being looked for.
const SUGGEST_MAX = 4;
const OWN_MAX = 6;
const ARCHIVE_MAX = 3;
// A clear match (at least two characters typed): a tab or pin whose title or site's address (no www.) starts with
// what's typed, or, two words or more typed, each of which starts a word of its title ("quiet city": The Quiet City);
// an app typed from its name's start (APP_PREFIX); an action each typed word of which starts a word of its name
// ("switch work": Switch to space Work); never a search page.
function isTopHit(item: PaletteItem, q: string) {
  if (q.length < 2 || !['tab', 'pin', 'app', 'action'].includes(item.kind)) return false;
  if (item.kind === 'app') return (item.boost ?? 0) >= APP_PREFIX;
  if (isSearchPage(item.url)) return false;
  const typed = q.toLowerCase();
  const words = typed.split(/\s+/);
  const everyWordStarts = () => words.every((t) => wordStartAt(item.title.toLowerCase(), t) >= 0);
  if (item.kind === 'action') return everyWordStarts();
  if (item.title.toLowerCase().startsWith(typed) || (words.length > 1 && everyWordStarts())) return true;
  const host = (() => { try { return new URL(item.url ?? '').hostname.replace(/^www\./, ''); } catch { return ''; } })();
  return !!host && host.startsWith(typed);
}
// A page of an engine's search results.
const isSearchPage = (url: string | undefined) => !!url && searchEngineOf(url) != null;

// The engine's suggestions to show for `q`: the ones kept for it, or for what it was a moment ago (typed on: the
// ones that still start with it), never the typed text itself.
function suggestionsFor(state: State, q: string): string[] {
  const kept = (state as { search?: SearchSuggestions | null }).search;
  if (!kept || !Array.isArray(kept.items) || typeof kept.query !== 'string') return [];
  const typed = q.toLowerCase();
  const asked = kept.query.toLowerCase();
  if (!typed.startsWith(asked)) return [];
  const exact = typed === asked;
  return kept.items
    .filter((s) => typeof s === 'string' && s.toLowerCase() !== typed && (exact || s.toLowerCase().startsWith(typed)))
    .slice(0, SUGGEST_MAX);
}

// What a tab's row says on its right in its own space (Arc's), its space's name in another.
const SWITCH_TO_TAB = 'Switch to Tab';
// A page's address as Arc's rows show it: no scheme, no www., no trailing slash ("youtube.com/watch?v=…").
function humanUrl(url: string | undefined) {
  if (!url || !/^https?:/i.test(url)) return '';
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}
// A page's site, its domain with no www.
function siteOf(url: string | undefined) {
  try { return url && /^https?:/i.test(url) ? new URL(url).hostname.replace(/^www\./i, '') : ''; } catch { return ''; }
}
// A row as Arc's command bar shows it (docs/ARC-COMMAND-BAR.md Part 1): a tab's, a pin's or a search's title alone; a
// past page's with its address after it; each its completion for the field.
function asArc(item: PaletteItem): PaletteItem {
  switch (item.kind) {
    case 'tab': case 'pin': return { ...item, detail: '', completion: siteOf(item.url) };
    case 'archive': return { ...item, detail: humanUrl(item.url), completion: siteOf(item.url) };
    case 'suggestion': return { ...item, detail: '', completion: item.title };
    case 'app': return { ...item, detail: '', completion: item.title };
    case 'go': return { ...item, detail: '' };
    default: return { ...item, detail: item.subtitle ?? '' };
  }
}

// Ranked palette results for `query`: with nothing typed, Margin's own rows; typed, the order above, its "Open URL"
// row first when the text is an address.
function rankPalette(state: State, query: string, ctx: { windowId: number | null; tabId: number | null; inNewTab: boolean; canToggleSidebar: boolean; canFullscreen: boolean; appWindow?: boolean; }, limit = 40) {
  const q = (query ?? '').trim();
  const items = paletteItems(state, ctx);
  if (!q) {
    return items
      .filter((i) => i.kind !== 'archive' && i.id !== `tab:${ctx.tabId}`)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.boost - a.boost || (b.recency ?? 0) - (a.recency ?? 0))
      .slice(0, limit)
      .map(asArc);
  }
  if (/^margin:\/\/settings\/?$/i.test(q)) return items.filter((i) => i.id === 'action:settings').map(asArc);
  const scored = [...items.map((item) => ({ item, score: matchScore(q, item) })).filter((r) => r.score > -Infinity), ...appMatches(state, q)]
    // (A search page below the person's other things.)
    .map((r) => ({ ...r, score: r.score + r.item.boost - (isSearchPage(r.item.url) ? 60 : 0) }))
    .sort((a, b) => b.score - a.score || (b.item.recency ?? 0) - (a.item.recency ?? 0))
    .map((r) => r.item);
  const own = scored.filter((i) => i.kind !== 'archive');
  const archived = scored.filter((i) => i.kind === 'archive' && !isSearchPage(i.url)).slice(0, ARCHIVE_MAX);
  const target = resolveInput(q);
  const isUrl = target?.kind === 'url';
  const top = !isUrl && own.length && isTopHit(own[0], q) ? own[0] : null;
  const searchAction = (text: string) => (ctx.inNewTab ? { local: 'search', query: text } : { type: 'search', query: text, windowId: ctx.windowId });
  const go: PaletteItem | null = target ? {
    id: 'go',
    kind: 'go',
    // (Arc's: what's typed, as it's typed: a search's words, an address.)
    title: q,
    badge: '',
    subtitle: '',
    emoji: isUrl ? '↗' : '⌕',
    search: !isUrl,
    action: isUrl
      ? (ctx.inNewTab ? { local: 'navigate', url: (target as { url: string }).url } : { type: 'newTab', windowId: ctx.windowId, url: (target as { url: string }).url })
      : searchAction((target as { query: string }).query),
  } : null;
  const suggested: PaletteItem[] = isUrl ? [] : suggestionsFor(state, q).map((text, i) => ({
    id: `suggest:${i}`, kind: 'suggestion', title: text, subtitle: '', emoji: '⌕', search: true, action: searchAction(text),
  }));
  const rest = own.filter((i) => i !== top).slice(0, OWN_MAX - (top ? 1 : 0)); // (the top hit one of them)
  return [...(top ? [top] : []), ...(go ? [go] : []), ...suggested, ...rest, ...archived].slice(0, limit).map(asArc);
}

export {
  SAFARI_ENGINES, SAFARI_DEFAULT, searchEngineOf, searchUrl, engineLabel,
  resolveInput, fuzzyScore, paletteItems, rankPalette, isSearchPage,
};
