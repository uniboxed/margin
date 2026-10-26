// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Bundled by scripts/build.js into a classic service worker
// (background.bundle.js): Safari ignores "type": "module" for backgrounds.
// The parts live in background/; every listener is registered here, at the
// top level, as a service worker must.
import * as M from './state/model.js';
import { api, load, mutate, now, resync } from './background/store.js';
import { injectIntoOpenTabs, shownAt, shownUrl } from './background/tabs.js';
import { learnSearchEngine } from './background/search-engine.js';
import { handlers } from './background/handlers.js';
import { queueRegistrations } from './background/registered.js';
import { archiveStale, archiveStaleThrottled, ARCHIVE_ALARM } from './background/archive.js';
import { navigate, navTarget, NAV_ACTIONS } from './background/navigation.js';
import { followFullscreen } from './background/fullscreen.js';

// ---- lifecycle ------------------------------------------------------------

api.runtime.onInstalled.addListener((details) => {
  console.log('[margin] installed', details.reason);
  if (details.reason === 'install' || details.reason === 'update') injectIntoOpenTabs();
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
  // Safari reloading a tab as it's shown: it had unloaded it (diagnostics).
  if (change.status === 'loading' && !change.url && shownAt.get(tabId) > Date.now() - 1000) {
    console.info(`[margin] tab ${tabId} reloaded as it was shown`);
  }
});
api.tabs.onRemoved.addListener((tabId) => {
  mutate((s) => M.removeTab(s, tabId));
  shownAt.delete(tabId);
  shownUrl.delete(tabId);
});
api.tabs.onActivated.addListener(({ tabId, windowId }) => {
  shownAt.set(tabId, Date.now());
  shownUrl.delete(tabId);
  api.tabs.get(tabId).then((tab) => shownUrl.set(tabId, tab.url), () => {});
  // The user switched tabs themselves: shortcut chaining restarts from here.
  if (navTarget.get(windowId)?.tabId !== tabId) navTarget.delete(windowId);
  mutate((s) => M.activateTab(s, tabId, windowId, now()));
  if (!api.alarms) archiveStaleThrottled();
});
api.tabs.onMoved.addListener(() => resync({ fresh: false }));
api.tabs.onAttached.addListener(() => resync({ fresh: false }));
api.tabs.onDetached?.addListener(() => resync({ fresh: false }));
// Chrome: a window going full screen becomes Margin full screen.
api.windows?.onBoundsChanged?.addListener((win) => followFullscreen(win.id));
api.windows?.onRemoved.addListener((windowId) =>
  mutate((s) => {
    if (!(windowId in s.activeSpaceByWindow)) return s;
    const activeSpaceByWindow = { ...s.activeSpaceByWindow };
    delete activeSpaceByWindow[windowId];
    return { ...s, activeSpaceByWindow };
  }),
);

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

// The theme, its placeholder and the fitted layout follow the settings.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) queueRegistrations();
});
queueRegistrations();

// ---- auto-archive -----------------------------------------------------------

if (api.alarms) {
  api.alarms.onAlarm.addListener((alarm) => alarm.name === ARCHIVE_ALARM && archiveStale());
  api.alarms.get(ARCHIVE_ALARM).then((alarm) => alarm || api.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 15 }));
  console.log('[margin] auto-archive via browser.alarms');
} else {
  console.log('[margin] auto-archive via tab events (no browser.alarms)');
}

// Debug hook for Web Inspector and tests: `margin.archiveNow()`.
globalThis.margin = { archiveNow: archiveStale, syncRegistrations: queueRegistrations, navigate };

// ---- commands -------------------------------------------------------------

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
