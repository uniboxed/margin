// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Bundled by scripts/build.js into a classic service worker
// (background.bundle.js): Safari ignores "type": "module" for backgrounds.
// The parts live in background/; every listener is registered here, at the
// top level, as a service worker must.
import * as M from './state/model.js';
import * as V from './shared/view.js';
import { api, cached, decided, isOwner, isStale, isSynced, load, markSynced, mutate, now, recheck, recheckSoon, resync, StaleError } from './background/store.js';
import * as keepReady from './background/keep-ready.js';
import * as restore from './background/restore.js';
import * as onboarding from './background/onboarding.js';
import { ensureCurrent, focusTab, forgetCurrent, handingOff, injectIntoOpenTabs, isIntroduction, resolveTab, setIntroductionHooks, shownAt, shownUrl, tabOpened, tabShown, userSwitched } from './background/tabs.js';
import { learnSearchEngine } from './background/search-engine.js';
import { handlers, newTabHandOff, newTabKey } from './background/handlers.js';
import * as newTabHint from './background/newtab-hint.js';
import { recordCreated } from './background/diagnostics.js';
import { queueRegistrations } from './background/registered.js';
import { archiveStale, archiveStaleThrottled, ARCHIVE_ALARM } from './background/archive.js';
import { navigate, navTarget, NAV_ACTIONS } from './background/navigation.js';
import { followFullscreen } from './background/fullscreen.js';
import { platform } from './shared/platform.js';

// ---- which copy is in charge ------------------------------------------------
// Safari can keep an older copy of Margin running beside a newer one until it
// quits; the newest owns the state (background/store.js, shared/owner.js).
// Every listener waits until this copy knows, and does nothing in one that
// doesn't own it: the tab events, commands and alarms reach both copies.
/** @template {any[]} A @param {(...args: A) => unknown} fn @returns {(...args: A) => Promise<unknown>} */
// Copies don't hear each other's writes: whether this one still owns the
// state is checked again (at most once a second) before it acts, so a copy a
// newer one replaced doesn't act on the event that tells it (a ⌘T both would
// answer). Events meanwhile wait for the same check, and go on in order
// (store.js recheckSoon). A change a newer copy took over during isn't
// written, and fails: nothing more to do here.
const owned = (fn) => async (...args) => {
  await decided();
  if (isOwner()) await recheckSoon();
  if (!isOwner()) return;
  try {
    return await fn(...args);
  } catch (err) {
    if (!(err instanceof StaleError)) throw err;
  }
};

// ---- lifecycle ------------------------------------------------------------

api.runtime.onInstalled.addListener(owned((details) => {
  console.log('[margin] installed', details.reason);
  if (details.reason === 'install' || details.reason === 'update') injectIntoOpenTabs();
}));

if (!api.storage.session) {
  api.runtime.onStartup.addListener(owned(() => resync({ fresh: true, onSync: restore.synced })));
}

// The open tabs matched to the state, once per background start. Until a
// copy's first one, the state's tab ids can be another copy's or the last
// session's, so requests that name tabs wait for it (at most SYNC_WAIT_MS),
// and pages trust the stored tabs only after (shared/stored.js). A background
// starting again within the same copy (the usual wake) has them matched
// already: nothing waits.
const SYNC_WAIT_MS = 5000;
const firstSyncOnce = () => resync({ onSync: (sync) => {
  restore.synced(sync);
  // A Safari relaunch can restore pages before it injects extensions into
  // them. Repair this session's already-open pages as soon as the background
  // has reconciled their authoritative ids, without waiting for WebKit's
  // delayed static-content-script pass.
  if (sync.fresh) void injectIntoOpenTabs();
} }).then(() => isOwner() && markSynced());
// Tried again if it fails (a storage error), a few times.
const firstSync = (async () => {
  for (let tries = 0; ; tries++) {
    try {
      return await firstSyncOnce();
    } catch (err) {
      // A storage error, also while deciding who owns the state (still not
      // known then): tried again. Not in a copy that doesn't own it.
      if (err instanceof StaleError || isStale() || tries >= 3) return void (err instanceof StaleError || isStale() || console.error('[margin] sync', err));
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** tries));
    }
  }
})();
const untilSynced = () => (isSynced() ? null : Promise.race([firstSync, new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS))]));
// A background Safari stops and starts again (the keep-ready alarm does every
// minute) doesn't redo this each time: once per START_WORK_MS.
const START_WORK_MS = 10 * 60_000;
async function startWorkDue() {
  const { startWorkAt } = await Promise.resolve(api.storage.session?.get('startWorkAt')).catch(() => null) ?? {};
  if (Number.isFinite(startWorkAt) && Date.now() - startWorkAt < START_WORK_MS) return false;
  void Promise.resolve(api.storage.session?.set({ startWorkAt: Date.now() })).catch(() => {});
  return true;
}
firstSync.then(async () => {
  if (!isOwner() || !isSynced()) return;
  void keepReady.tick(); // the tabs of the space in front, if Safari was used recently (a background started again)
  if (!(await startWorkDue())) return;
  void onboarding.reportAccess(); // to Margin's Mac app, if it's open (its set-up window)
  // Safari's search engine from tabs already open, if none is known yet (a
  // stale tab mustn't override one learned since).
  const s = await load();
  if (!s.settings.safariSearch) {
    learnSearchEngine(Object.values(s.tabs).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).map((t) => t.url));
  }
  return archiveStale();
}).catch((err) => { if (!(err instanceof StaleError)) console.error('[margin]', err); });

// Margin allowed on more or fewer sites: the Mac app's set-up window shows it.
api.permissions?.onAdded?.addListener(owned(() => void onboarding.reportAccess()));
api.permissions?.onRemoved?.addListener(owned(() => void onboarding.reportAccess()));

// ---- tab events -----------------------------------------------------------

const TRACKED_CHANGES = ['title', 'url', 'favIconUrl'];

api.tabs.onCreated.addListener(owned(async (tab) => {
  // ⌘T (a new tab showing the new-tab page, in front): handed back to the
  // page the user was on at once (handlers.js newTabHandOff); a new tab
  // that stays is tracked as usual.
  recordCreated(tab);
  tabOpened(tab);
  if (tab.active && V.isNewTabPage(tab.pendingUrl || tab.url)) {
    void newTabHint.newTabPageSeen(tab); // ⌘T reaches Margin: the setting is Margin
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
}));
api.tabs.onUpdated.addListener(owned((tabId, change, tab) => {
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
}));
api.tabs.onRemoved.addListener(owned((tabId) => {
  handingOff.delete(tabId);
  tabShown(tabId); // gone: forgotten
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
}));
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
const activated = owned(({ tabId, windowId }) => {
  if (handingOff.has(tabId)) return;
  // The tab left stays ready to come back to (Safari can suspend it within a
  // second), and the set follows the switch (background/keep-ready.js).
  const left = Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active && t.id !== tabId);
  keepReady.noteUsed();
  keepReady.shown(tabId);
  if (left) keepReady.holdNow(left.id);
  userSwitched(tabId, windowId);
  tabShown(tabId);
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
  setTimeout(() => isOwner() && ensureCurrent(tabId), 300);
});
// Not the two activations of a tab brought to the front for an instant, out of
// sight, and the page in front straight back (tabs.js introduceTab): checked as
// they come, in order, before anything else can.
api.tabs.onActivated.addListener((info) => (isIntroduction(info) ? undefined : activated(info)));
// An activation left out after all (Safari left the tab in front); a tab whose
// hold ended as it was shown for that instant is held afresh if it's still behind.
setIntroductionHooks({ activated, introduced: (tabId) => { keepReady.shown(tabId); keepReady.tickSoon(); } });
// Coming back to a window (or to Safari) shows its tab without onActivated:
// that tab is checked too (a stale copy there: tabs.js ensureCurrent).
api.windows?.onFocusChanged?.addListener(owned((windowId) => {
  if (windowId == null || windowId < 0) return;
  keepReady.noteUsed();
  api.tabs.query({ active: true, windowId }).then(([tab]) => tab && setTimeout(() => isOwner() && ensureCurrent(tab.id), 300), () => {});
}));
api.tabs.onMoved.addListener(owned(() => resync({ fresh: false })));
api.tabs.onAttached.addListener(owned(() => resync({ fresh: false })));
api.tabs.onDetached?.addListener(owned(() => resync({ fresh: false })));
// Chrome: a window going full screen becomes Margin full screen.
api.windows?.onBoundsChanged?.addListener(owned((win) => followFullscreen(win.id)));
// A closed window may have been the one in full screen (registered.js syncShell).
if (platform?.marginFullscreen) api.windows?.onRemoved.addListener(owned(() => queueRegistrations()));
api.windows?.onRemoved.addListener(owned((windowId) =>
  mutate((s) => {
    if (!(windowId in s.activeSpaceByWindow)) return s;
    const activeSpaceByWindow = { ...s.activeSpaceByWindow };
    delete activeSpaceByWindow[windowId];
    return { ...s, activeSpaceByWindow };
  }),
));

// sendResponse + `return true` works in both Safari and Chrome (Chrome
// ignores promises returned from onMessage listeners).
// A request naming a tab by the id its page drew comes with the tab's
// address (content/core.js send): it gets this copy's id for that tab, or
// fails if the tab is gone (no other tab is closed or moved for it).
async function withTab(message, sender) {
  if (!Number.isInteger(message?.tabId) || !message.hint) return message;
  const target = await resolveTab(message.tabId, message.hint, sender.tab?.windowId);
  if (!target) throw new Error('That tab is no longer open');
  return { ...message, tabId: target.id, hint: null };
}
// A copy that doesn't own the state answers `stale`: its pages then stay out
// of the way (content/core.js). Requests that name no tab (a page starting,
// its zoom, scroll and icon) don't wait for the first sync.
const BEFORE_SYNC = new Set(['hello', 'owner', 'prewake', 'used', 'pageBlinked', 'shellShown', 'switchLog', 'sidebarScroll', 'setSidebarScroll', 'restoringTab', 'reloadForUpdate', 'getZoom', 'pageIcon', 'newTabKeyUsed', 'windowState', 'injectTheme']);
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  // A page starting asks whether this copy still owns the state (a newer
  // one may have taken over since: copies don't hear each other's writes).
  decided()
    .then(() => (message.type === 'hello' || message.type === 'owner' ? recheck() : null))
    .then(() => (isOwner() && !BEFORE_SYNC.has(message.type) ? untilSynced() : null))
    .then(() => (isOwner() ? withTab(message, sender) : null))
    .then((request) => (isOwner() ? handler(request, sender).then((result) => ({ ok: true, result })) : { ok: false, stale: true, error: 'a newer copy of Margin is running' }))
    // A change made while a newer copy took over wasn't written (store.js
    // mutate). Only a copy known not to own the state says `stale` (its pages
    // then stand down for good): a storage error while deciding is an error.
    .then(sendResponse, (err) => sendResponse(err instanceof StaleError || isStale() ? { ok: false, stale: true, error: String(err?.message ?? err) } : { ok: false, error: String(err?.message ?? err) }));
  return true;
});

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function keepReadyChanged(changes) {
  if (changes.settings && changes.settings.oldValue?.keepTabsReadyMinutes !== changes.settings.newValue?.keepTabsReadyMinutes) return true;
  const open = changes.openTabs;
  if (!open) return false;
  const before = open.oldValue ?? {}, after = open.newValue ?? {};
  return !sameJson(before.activeSpaceByWindow, after.activeSpaceByWindow) || !sameJson(before.tabSpace, after.tabSpace);
}
// The theme, its placeholder and the fitted layout follow the settings.
api.storage.onChanged.addListener(owned((changes, area) => {
  if (area === 'local' && changes.settings) queueRegistrations();
  // The setting, the space shown or the tabs in it: the set again (not for
  // every title or icon the open tabs change by).
  if (area === 'local' && keepReadyChanged(changes)) keepReady.tickSoon();
}));
owned(queueRegistrations)();

// ---- auto-archive -----------------------------------------------------------

if (api.alarms) {
  api.alarms.onAlarm.addListener(owned((alarm) => alarm.name === ARCHIVE_ALARM && archiveStale()));
  // Not through owned(): a copy that no longer owns the state clears it, or
  // it would keep starting that copy's background every minute.
  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== keepReady.KEEP_READY_ALARM) return;
    await decided().catch(() => {});
    if (isOwner()) return keepReady.tick();
    void Promise.resolve(api.alarms.clear(keepReady.KEEP_READY_ALARM)).catch(() => {});
  });
  api.alarms.get(ARCHIVE_ALARM).then((alarm) => alarm || api.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 15 }));
  console.log('[margin] auto-archive via browser.alarms');
} else {
  console.log('[margin] auto-archive via tab events (no browser.alarms)');
}

// Debug hook for Web Inspector and tests: `margin.archiveNow()`.
globalThis.margin = { archiveNow: archiveStale, syncRegistrations: queueRegistrations, navigate };

// ---- commands -------------------------------------------------------------

api.commands?.onCommand.addListener(owned(async (command, tabArg) => {
  await untilSynced();
  if (command === 'new-tab') return newTabKey(tabArg);
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
}));
