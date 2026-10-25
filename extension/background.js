// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Classic service worker: Safari ignores "type": "module" for backgrounds.
importScripts('state/model.js', 'shared/icons.js');
const M = globalThis.Margin.model;
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

resync().then(() => archiveStale());

// ---- tab events -----------------------------------------------------------

const TRACKED_CHANGES = ['title', 'url', 'favIconUrl'];

api.tabs.onCreated.addListener((tab) => mutate((s) => M.upsertTab(s, tab, now())));
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (TRACKED_CHANGES.some((k) => k in change) || change.status === 'complete') {
    mutate((s) => M.upsertTab(s, tab, now()));
  }
});
api.tabs.onRemoved.addListener((tabId) => mutate((s) => M.removeTab(s, tabId)));
api.tabs.onActivated.addListener(({ tabId, windowId }) => {
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

async function focusTab(tabId) {
  const tab = await api.tabs.update(tabId, { active: true });
  if (tab && api.windows) await api.windows.update(tab.windowId, { focused: true });
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

// While "Keep open" is on, register content/docked.css: the browser applies it
// before first paint, ahead of content scripts. Feature-detected; without the
// scripting API the sidebar simply appears when the content script runs.
const DOCKED_ID = 'margin-docked';
async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = !!settings?.sidebarPinnedOpen;
  const have = (await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID] })).length > 0;
  if (want && !have) {
    await api.scripting.registerContentScripts([
      { id: DOCKED_ID, css: ['content/docked.css'], matches: ['<all_urls>'], runAt: 'document_start', allFrames: false },
    ]);
  } else if (!want && have) {
    await api.scripting.unregisterContentScripts({ ids: [DOCKED_ID] });
  }
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
globalThis.margin = { archiveNow: archiveStale, syncDockedCss: queueDockedSync };

// ---- commands -------------------------------------------------------------

api.commands?.onCommand.addListener(async (command) => {
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
