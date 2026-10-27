// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Bundled by scripts/build.js into a classic service worker
// (background.bundle.js): Safari ignores "type": "module" for backgrounds.
// The parts live in background/; every listener is registered here, at the
// top level, as a service worker must.
import * as M from './state/model.js';
import * as V from './shared/view.js';
import { api, load, mutate, now, resync } from './background/store.js';
import * as restore from './background/restore.js';
import { ensureCurrent, focusTab, forgetCurrent, handingOff, injectIntoOpenTabs, shownAt, shownUrl } from './background/tabs.js';
import { learnSearchEngine } from './background/search-engine.js';
import { handlers, newTabHandOff } from './background/handlers.js';
import * as newTabHint from './background/newtab-hint.js';
import { recordCreated } from './background/diagnostics.js';
import { queueRegistrations } from './background/registered.js';
import { archiveStale, archiveStaleThrottled, ARCHIVE_ALARM } from './background/archive.js';
import { navigate, navTarget, NAV_ACTIONS } from './background/navigation.js';
import { followFullscreen } from './background/fullscreen.js';
import { platform } from './shared/platform.js';

// ---- lifecycle ------------------------------------------------------------

api.runtime.onInstalled.addListener((details) => {
  console.log('[margin] installed', details.reason);
  if (details.reason === 'install' || details.reason === 'update') injectIntoOpenTabs();
});

if (!api.storage.session) {
  api.runtime.onStartup.addListener(() => resync({ fresh: true, onSync: restore.synced }));
}

resync({ onSync: restore.synced }).then(async () => {
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

api.tabs.onCreated.addListener(async (tab) => {
  // ⌘T (a new tab showing the new-tab page, in front): handed back to the
  // page the user was on at once (handlers.js newTabHandOff); a new tab
  // that stays is tracked as usual.
  recordCreated(tab);
  if (tab.active && V.isNewTabPage(tab.pendingUrl || tab.url)) {
    void newTabHint.newTabPageSeen(); // ⌘T reaches Margin: the setting is Margin
    if (await newTabHandOff(tab)) return;
    // As it is now: its events were set aside meanwhile.
    tab = await api.tabs.get(tab.id).catch(() => null);
    if (!tab) return;
  }
  newTabHint.tabCreated(tab);
  mutate((s) => {
    restore.tabCreated(s, tab); // back from before the ids changed?
    return M.upsertTab(s, tab, now());
  });
});
api.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (handingOff.has(tabId)) {
    // A ⌘T tab about to close (handlers.js newTabHandOff), unless it goes
    // somewhere else first: then it stays, and is tracked from here.
    if (!change.url || V.isNewTabPage(change.url)) return;
    handingOff.delete(tabId);
  }
  if (TRACKED_CHANGES.some((k) => k in change) || change.status === 'complete') {
    mutate((s) => M.upsertTab(s, tab, now()));
  }
  if (change.url || change.status === 'complete') restore.tabChanged(tab); // its address may have come with the load
  // The URL when it changes, and again once loaded (in case Safari reported
  // the change without it, or it redirected).
  const url = change.url ?? (change.status === 'complete' ? tab.url : null);
  if (url) learnSearchEngine([url], { tabId });
  if (change.url) void newTabHint.tabAddress(tabId, change.url);
  if (change.status === 'complete') newTabHint.tabLoaded(tabId);
  // Safari reloading a tab as it's shown: it had unloaded it (diagnostics).
  if (change.status === 'loading' && !change.url && shownAt.get(tabId) > Date.now() - 1000) {
    console.info(`[margin] tab ${tabId} reloaded as it was shown`);
  }
});
api.tabs.onRemoved.addListener((tabId) => {
  handingOff.delete(tabId);
  newTabHint.tabGone(tabId);
  forgetCurrent(tabId);
  mutate((s) => {
    const closed = s.tabs[tabId];
    const followed = closed && lastFollow.get(closed.windowId);
    if (followed?.prevTabId === tabId && Date.now() - followed.at < STAY_MS) {
      // The browser already brought a tab of another space to the front (its
      // activation came first) and the window followed it: back.
      lastFollow.delete(closed.windowId);
      stayInSpace(closed.windowId, followed.from, tabId);
    } else if (closed?.active) {
      closedShown.set(closed.windowId, { spaceId: s.tabSpace[tabId], at: Date.now(), tabId });
    }
    return M.removeTab(s, tabId);
  });
  shownAt.delete(tabId);
  shownUrl.delete(tabId);
});
// The tab in front closed (⌘W, Safari's close button): the browser picks the
// next one, maybe of another space. The window stays in the closed tab's
// space when that has other tabs here (Arc), whichever of the two events
// comes first. (The sidebar's × picks the next tab itself: handlers.js closeTab.)
const STAY_MS = 1500;
const closedShown = new Map(); // windowId → { spaceId, at, tabId }: removed while in front
const lastFollow = new Map(); // windowId → { from, at, prevTabId }: the space followTab just left, and the tab in front then
function stayInSpace(windowId, spaceId, closedId) {
  mutate((s) => {
    const stay = M.recentTabOfSpace(s, windowId, spaceId, closedId);
    if (!stay) return s; // nothing left there: the window follows the browser's pick
    focusTab(stay.id, { source: 'close' }).catch(() => {});
    return M.setActiveSpace(s, windowId, spaceId);
  });
}
api.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (handingOff.has(tabId)) return;
  shownAt.set(tabId, Date.now());
  shownUrl.delete(tabId);
  api.tabs.get(tabId).then((tab) => shownUrl.set(tabId, tab.url), () => {});
  // The user switched tabs themselves: shortcut chaining restarts from here.
  if (navTarget.get(windowId)?.tabId !== tabId) navTarget.delete(windowId);
  const closed = closedShown.get(windowId);
  closedShown.delete(windowId);
  mutate((s) => {
    const next = M.activateTab(s, tabId, windowId, now());
    if (closed && Date.now() - closed.at < STAY_MS && next.tabSpace[tabId] !== closed.spaceId) {
      stayInSpace(windowId, closed.spaceId, closed.tabId);
      return next;
    }
    const followed = M.followTab(next, tabId, windowId);
    if (followed !== next) {
      const prev = Object.values(s.tabs).find((t) => t.windowId === windowId && t.active && t.id !== tabId);
      lastFollow.set(windowId, { from: V.activeSpaceId(next, windowId), at: Date.now(), prevTabId: prev?.id ?? null });
    }
    return followed;
  });
  if (!api.alarms) archiveStaleThrottled();
  // After the switch has landed (not in its way).
  setTimeout(() => ensureCurrent(tabId), 300);
});
// Coming back to a window (or to Safari) shows its tab without onActivated:
// that tab is checked too (a stale copy there: tabs.js ensureCurrent).
api.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId == null || windowId < 0) return;
  api.tabs.query({ active: true, windowId }).then(([tab]) => tab && setTimeout(() => ensureCurrent(tab.id), 300), () => {});
});
api.tabs.onMoved.addListener(() => resync({ fresh: false }));
api.tabs.onAttached.addListener(() => resync({ fresh: false }));
api.tabs.onDetached?.addListener(() => resync({ fresh: false }));
// Chrome: a window going full screen becomes Margin full screen.
api.windows?.onBoundsChanged?.addListener((win) => followFullscreen(win.id));
// A closed window may have been the one in full screen (registered.js syncShell).
if (platform?.marginFullscreen) api.windows?.onRemoved.addListener(() => queueRegistrations());
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
