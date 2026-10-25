// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Classic service worker: Safari ignores "type": "module" for backgrounds.
importScripts('shared/platform.js', 'state/model.js', 'shared/icons.js', 'shared/view.js', 'shared/search.js');
const M = globalThis.Margin.model;
const S = globalThis.Margin.search;
const I = globalThis.Margin.icons;

const api = globalThis.browser ?? globalThis.chrome;

let cache = null;
let queue = Promise.resolve();

async function load() {
  if (cache) return cache;
  const raw = await api.storage.local.get(M.STATE_KEYS);
  cache = M.normalizeState(raw);
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(key in raw));
  // Saved under another build's default shortcuts (normalizeShortcuts moved
  // them): save, so pages, which read storage directly, use the new ones.
  if (raw.settings && raw.settings.shortcutDefaults !== cache.settings.shortcutDefaults) missing.push('settings');
  else if (raw.settings && 'searchEngine' in raw.settings) missing.push('settings'); // drop the removed setting
  if (missing.length) await api.storage.local.set(Object.fromEntries(missing.map((key) => [key, cache[key]])));
  return cache;
}

// Serialize every read-modify-write so concurrent tab events can't clobber
// each other, and persist only the keys that changed.
function mutate(fn) {
  const run = queue.then(async () => {
    const prev = await load();
    const next = (await fn(prev)) ?? prev;
    const changes = {};
    for (const key of M.STATE_KEYS) if (next[key] !== prev[key]) changes[key] = next[key];
    cache = next;
    if (Object.keys(changes).length) await api.storage.local.set(changes);
    return next;
  });
  queue = run.catch((err) => console.error('[margin]', err));
  return run;
}

const newId = () => crypto.randomUUID().slice(0, 8);
const now = () => Date.now();

// A browser restart gives every tab and window a new id. storage.session is
// cleared on restart, so an empty one means "fresh"; without it we fall back
// to runtime.onStartup.
async function isFreshSession() {
  if (!api.storage.session) return false;
  const { alive } = await api.storage.session.get('alive');
  if (alive) return false;
  await api.storage.session.set({ alive: true });
  return true;
}

function resync({ fresh } = {}) {
  return mutate(async (s) => {
    const tabs = await api.tabs.query({});
    const isFresh = fresh ?? (await isFreshSession());
    return M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
  });
}

// ---- lifecycle ------------------------------------------------------------

api.runtime.onInstalled.addListener((details) => {
  console.log('[margin] installed', details.reason);
});

if (!api.storage.session) {
  api.runtime.onStartup.addListener(() => resync({ fresh: true }));
}

resync().then(async () => {
  // Safari's search engine from tabs already open, if none is known yet (a
  // stale tab mustn't override one learned since).
  const s = await load();
  if (!s.settings.safariSearch) {
    learnSearchEngine(Object.values(s.tabs).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).map((t) => t.url));
  }
  return archiveStale();
});

// ---- the browser's search engine -------------------------------------------
// Safari has no search API: follow the engine Safari itself searches with,
// learned from its address-bar searches (shared/search.js). Chrome uses
// chrome.search.query instead (the `search` handler).
// Margin's own searches carry Safari-style URLs too, so they'd "confirm"
// Margin's current engine: a search in a tab Margin just searched in, with
// that same engine, isn't learned from. A different engine there is Safari's
// (the user searched from the address bar) and is.
const OWN_SEARCH_MS = 30000;
const ownSearchTabs = new Map(); // tabId → { at, template }
function isOwnSearch(tabId, found) {
  const own = ownSearchTabs.get(tabId);
  return !!own && now() - own.at < OWN_SEARCH_MS && own.template === found.template;
}
function learnSearchEngine(urls, { tabId } = {}) {
  if (globalThis.Margin.platform?.search !== 'learn') return;
  const found = urls.map(S.detectSafariSearch).find(Boolean);
  if (!found) {
    // On an engine's site but without Safari's parameters: not an address-bar
    // search (or Safari changed them). Visible in the background console.
    const engine = urls.map(S.searchEngineOf).find(Boolean);
    if (engine) console.debug(`[margin] ${engine} search not from Safari's address bar (no Safari parameters), not learned:`, urls.find(S.searchEngineOf));
    return;
  }
  if (tabId != null && isOwnSearch(tabId, found)) return;
  return mutate((s) => (s.settings.safariSearch?.template === found.template
    ? s
    : { ...s, settings: { ...s.settings, safariSearch: { ...found, at: now() } } }));
}

// ---- tab events -----------------------------------------------------------

const TRACKED_CHANGES = ['title', 'url', 'favIconUrl'];

api.tabs.onCreated.addListener((tab) => mutate((s) => M.upsertTab(s, tab, now())));
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (TRACKED_CHANGES.some((k) => k in change) || change.status === 'complete') {
    mutate((s) => M.upsertTab(s, tab, now()));
  }
  // The URL when it changes, and again once loaded (in case Safari reported
  // the change without it, or it redirected).
  const url = change.url ?? (change.status === 'complete' ? tab.url : null);
  if (url) learnSearchEngine([url], { tabId });
});
api.tabs.onRemoved.addListener((tabId) => mutate((s) => M.removeTab(s, tabId)));
api.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // The user switched tabs themselves: shortcut chaining restarts from here.
  if (navTarget.get(windowId)?.tabId !== tabId) navTarget.delete(windowId);
  mutate((s) => M.activateTab(s, tabId, windowId, now()));
  if (!api.alarms) archiveStaleThrottled();
});
api.tabs.onMoved.addListener(() => resync({ fresh: false }));
api.tabs.onAttached.addListener(() => resync({ fresh: false }));
api.tabs.onDetached?.addListener(() => resync({ fresh: false }));
api.windows?.onRemoved.addListener((windowId) =>
  mutate((s) => {
    if (!(windowId in s.activeSpaceByWindow)) return s;
    const activeSpaceByWindow = { ...s.activeSpaceByWindow };
    delete activeSpaceByWindow[windowId];
    return { ...s, activeSpaceByWindow };
  }),
);

// ---- actions --------------------------------------------------------------

// Activate a tab, and focus its window only if it isn't already: re-focusing
// the current window can move keyboard focus out of the page in Safari.
async function focusTab(tabId) {
  const tab = await api.tabs.update(tabId, { active: true });
  if (!tab || !api.windows) return;
  const win = await api.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) await api.windows.update(tab.windowId, { focused: true });
}

async function openTab({ windowId, url, spaceId }) {
  const tab = await api.tabs.create({ windowId, url, active: true });
  if (spaceId) await mutate((s) => M.moveTab(M.upsertTab(s, tab, now()), tab.id, spaceId));
  return tab;
}

const handlers = {
  async hello(_, sender) {
    return { tabId: sender.tab?.id ?? null, windowId: sender.tab?.windowId ?? null };
  },
  async activateTab({ tabId }) {
    await focusTab(tabId);
  },
  // Closing from Margin archives the tab, like Arc.
  async closeTab({ tabId }) {
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
    await api.tabs.remove(tabId);
  },
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
  async setZoom({ factor }, sender) {
    if (!sender.tab || !Number.isFinite(factor)) return;
    await api.tabs.setZoom(sender.tab.id, Math.min(3, Math.max(0.25, factor)));
  },
  // Search with the browser's engine: in `tabId`, else in a new tab.
  async search({ query, windowId, tabId }) {
    const text = String(query ?? '').trim();
    if (!text) return;
    if (globalThis.Margin.platform?.search === 'browser' && api.search?.query) {
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
  async newTab({ windowId, url, spaceId }) {
    const tab = await openTab({ windowId, url, spaceId });
    return { tabId: tab.id };
  },
  async pinTab({ tabId }) {
    const s = await load();
    const tab = s.tabs[tabId];
    if (!tab) return;
    await mutate((st) => M.addPin(st, { id: newId(), spaceId: st.tabSpace[tabId], url: tab.url, title: tab.title }));
  },
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
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
  async setSpace({ windowId, spaceId }) {
    await mutate((s) => M.setActiveSpace(s, windowId, spaceId));
  },
  async createSpace({ windowId, name, emoji, color }) {
    const id = newId();
    await mutate((s) => {
      const next = M.createSpace(s, { id, name, emoji, color });
      return windowId == null ? next : M.setActiveSpace(next, windowId, id);
    });
    return { spaceId: id };
  },
  async renameSpace({ spaceId, name, emoji, color }) {
    await mutate((s) => M.updateSpace(s, spaceId, { name, emoji, color }));
  },
  async deleteSpace({ spaceId }) {
    await mutate((s) => M.deleteSpace(s, spaceId));
  },
  async moveTabToSpace({ tabId, spaceId }) {
    await mutate((s) => M.moveTab(s, tabId, spaceId));
  },
  async pageIcon({ href }, sender) {
    if (!globalThis.Margin.platform?.fetchFavicons) return; // the browser provides icons
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
  async navigate({ action }, sender) {
    if (!NAV_ACTIONS.has(action)) return;
    const windowId = sender.tab?.windowId ?? (await api.windows?.getLastFocused())?.id;
    await navigate(action, 'page', windowId);
  },
  async updateSettings({ patch }) {
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  },
};

// sendResponse + `return true` works in both Safari and Chrome (Chrome
// ignores promises returned from onMessage listeners).
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

// ---- site icons ---------------------------------------------------------------

// Safari gives extensions no tab.favIconUrl. Each page reports its best icon
// link (content/sidebar.js → pageIcon); the background fetches it once per
// site — no cookies, no third-party service — shrinks it to 32×32 where the
// browser can, and stores a data: URL in state.favicons[origin]. Showing it
// later makes no network request.
const ICON_MAX_AGE = 7 * 24 * 3600_000;
const iconInflight = new Map(); // origin → promise
const iconFailed = new Set(); // `${origin} ${href}` that yielded nothing (this worker's lifetime)

const PRIVATE_HOST = /^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i;
// The page chooses the icon URL, and the background can fetch what pages
// can't: another site's icon must be https and not on a local network.
function iconUrlAllowed(href, pageUrl) {
  if (/^data:image\//i.test(href)) return true;
  let u, page;
  try {
    u = new URL(href);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.hostname === page.hostname) return true;
  return u.protocol === 'https:' && !PRIVATE_HOST.test(u.hostname);
}

async function shrinkIcon(bytes, type) {
  if (type === 'image/svg+xml' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const canvas = new OffscreenCanvas(I.SIZE, I.SIZE);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, I.SIZE, I.SIZE);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null; // e.g. a format this browser can't decode here: keep the original if small
  }
}

async function fetchIcon(href) {
  if (/^data:image\//i.test(href)) return href.length <= I.MAX_STORED * 1.4 ? href : null;
  const res = await fetch(href, { credentials: 'omit', signal: AbortSignal.timeout?.(6000) });
  if (!res.ok || Number(res.headers.get('content-length')) > I.MAX_DOWNLOAD) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > I.MAX_DOWNLOAD) return null;
  const type = I.sniffType(bytes);
  if (!type) return null; // not an image (e.g. an HTML 404 page)
  const small = await shrinkIcon(bytes, type);
  if (small) return I.dataUrl('image/png', small);
  return bytes.length <= I.MAX_STORED ? I.dataUrl(type, bytes) : null;
}

async function learnIcon(origin, href) {
  const s = await load();
  const known = s.favicons[origin];
  if (known && known.href === href && now() - known.at < ICON_MAX_AGE) return;
  const candidates = [...new Set([href, `${origin}/favicon.ico`])].filter((c) => !iconFailed.has(`${origin} ${c}`));
  for (const candidate of candidates) {
    const data = await fetchIcon(candidate).catch(() => null);
    if (data) {
      await mutate((st) => M.rememberFavicon(st, origin, { data, href, at: now() }));
      return;
    }
    iconFailed.add(`${origin} ${candidate}`);
  }
}

// ---- docked placeholder ---------------------------------------------------

// Remove the old root-margin placeholder from previous builds. Kept-open pages
// now use a real iframe viewport; registering this CSS would briefly reflow the
// page before that viewport is ready.
const DOCKED_ID = 'margin-docked';
async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID] });
  if (current) await api.scripting.unregisterContentScripts({ ids: [DOCKED_ID] });
}
let dockedSync = Promise.resolve();
const queueDockedSync = () => {
  dockedSync = dockedSync.then(syncDockedCss).catch((err) => console.warn('[margin] docked css', err));
  return dockedSync;
};
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) queueDockedSync();
});
queueDockedSync();

// ---- auto-archive -----------------------------------------------------------

// Close stale tabs and add them to the archive. Runs on wake, on a
// browser.alarms schedule when available, else (throttled) on tab activation.
async function archiveStale() {
  let stale = [];
  await mutate((s) => {
    stale = M.staleTabs(s, now());
    return stale.reduce((st, tab) => M.archiveTab(st, M.archiveEntryForTab(st, tab, { id: newId(), closedAt: now() })), s);
  });
  if (stale.length) {
    console.log('[margin] archived', stale.length, 'tab(s)');
    await api.tabs.remove(stale.map((t) => t.id)).catch((err) => console.warn('[margin] archive', err));
  }
  return stale.length;
}

let lastCheck = 0;
function archiveStaleThrottled() {
  if (now() - lastCheck < 5 * 60_000) return;
  lastCheck = now();
  archiveStale();
}

const ARCHIVE_ALARM = 'margin-archive';
if (api.alarms) {
  api.alarms.onAlarm.addListener((alarm) => alarm.name === ARCHIVE_ALARM && archiveStale());
  api.alarms.get(ARCHIVE_ALARM).then((alarm) => alarm || api.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 15 }));
  console.log('[margin] auto-archive via browser.alarms');
} else {
  console.log('[margin] auto-archive via tab events (no browser.alarms)');
}

// Debug hook for Web Inspector and tests: `margin.archiveNow()`.
globalThis.margin = { archiveNow: archiveStale, syncDockedCss: queueDockedSync, navigate };

// ---- commands -------------------------------------------------------------

// Next/previous tab and space. Two delivery paths land here: the manifest
// `commands` (⌃⌘ + arrows; Safari matches them in the app, so they work
// whatever has focus and before a page's script has loaded) and the page's
// keydown listener (key repeat and custom shortcuts from Settings).
//  - One key press arriving through both paths counts once.
//  - Presses run one at a time, and each continues from the tab the previous
//    one chose (for a moment), so fast presses all count even before Safari
//    has finished switching.
//  - The window isn't re-focused when it already is (that could move keyboard
//    focus out of the page), and the sidebar highlight updates immediately.
const NAV_DEDUPE_MS = 150;
const NAV_CHAIN_MS = 1500;
const lastNav = { action: null, source: null, at: 0 };
const navTarget = new Map(); // windowId → { tabId, at }
let navQueue = Promise.resolve();

function navigate(action, source, windowId) {
  const t = now();
  if (action === lastNav.action && source !== lastNav.source && t - lastNav.at < NAV_DEDUPE_MS) return navQueue;
  Object.assign(lastNav, { action, source, at: t });
  navQueue = navQueue.then(() => runNavigation(action, windowId)).catch((err) => console.warn('[margin] navigate', err));
  return navQueue;
}

async function runNavigation(action, windowId) {
  if (windowId == null) return;
  const s = await load();
  const V = globalThis.Margin.view;
  if (action === 'next-tab' || action === 'prev-tab') {
    const chained = navTarget.get(windowId);
    const current = chained && now() - chained.at < NAV_CHAIN_MS && s.tabs[chained.tabId]
      ? chained.tabId
      : (await api.tabs.query({ active: true, windowId }))[0]?.id;
    const next = V.cycleTab(s, windowId, current, action === 'next-tab' ? 1 : -1);
    if (next == null) return;
    navTarget.set(windowId, { tabId: next, at: now() });
    await api.tabs.update(next, { active: true });
    await mutate((st) => M.activateTab(st, next, windowId, now()));
  } else if (action === 'next-space' || action === 'prev-space') {
    const spaceId = V.cycleSpace(s, windowId, action === 'next-space' ? 1 : -1);
    if (spaceId == null) return;
    await mutate((st) => M.setActiveSpace(st, windowId, spaceId));
    // Show where you landed (auto-hide mode); Margin's own pages ignore it.
    const [tab] = await api.tabs.query({ active: true, windowId });
    if (tab) api.tabs.sendMessage(tab.id, { type: 'command', command: 'peek' }).catch(() => {});
  }
}

const NAV_ACTIONS = new Set(['next-tab', 'prev-tab', 'next-space', 'prev-space']);
api.commands?.onCommand.addListener(async (command, tabArg) => {
  if (NAV_ACTIONS.has(command)) {
    const windowId = tabArg?.windowId ?? (await api.windows?.getLastFocused())?.id;
    return navigate(command, 'command', windowId);
  }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: 'command', command });
  } catch {
    // No content script: maybe our own new-tab page, which listens on
    // runtime messages. Otherwise a Safari internal page, PDF, etc.
    api.runtime.sendMessage({ type: 'command', command, tabId: tab.id }).catch(() => {});
  }
});
