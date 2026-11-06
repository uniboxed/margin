// State owner. Non-persistent: every handler reads state through load(),
// which rehydrates from storage.local after the worker is unloaded.
// Bundled by scripts/build.js into one classic script (background.bundle.js):
// Chrome's service worker, Safari's non-persistent background page (the link
// to Margin.app needs a page: background/link.js). Safari ignores "type":
// "module" for backgrounds.
// The parts live in background/; every listener is registered here, at the
// top level, as a service worker must.
import * as M from './state/model.js';
import * as V from './shared/view.js';
import { api, cached, decided, isOwner, isStale, isSynced, load, markSynced, mutate, newId, now, recheck, recheckSoon, resync, StaleError } from './background/store.js';
import { takeClosing } from './background/closing.js';
import * as restore from './background/restore.js';
import * as onboarding from './background/onboarding.js';
import { ensureCurrent, focusTab, forgetCurrent, handingOff, injectIntoOpenTabs, keepHandedOff, pageChanged, resolveTab, setActivationHook, shownAt, switchAsked, tabClosed, tabLeft, tabShown, userSwitched } from './background/tabs.js';
import { switchLog, switchLogTo } from './background/switch-log.js';
import { learnSearchEngine } from './background/search-engine.js';
import { handlers, newTabHandOff, newTabKey, zoomChanged, zoomStored } from './background/handlers.js';
import * as newTabHint from './background/newtab-hint.js';
import { layoutsChanged, queueRegistrations, setLayoutSource, watchCommits } from './background/registered.js';
import { archiveStale, archiveStaleThrottled, ARCHIVE_ALARM } from './background/archive.js';
import { sleepIdle, sleepIdleThrottled } from './background/sleep.js';
import { navigate, navTarget, NAV_ACTIONS } from './background/navigation.js';
import { followFullscreen } from './background/fullscreen.js';
import { tabGone, tabUpdated } from './background/tab-updates.js';
import { platform } from './shared/platform.js';
import { appLink } from './background/app-link.js';
import * as pageLoads from './background/page-loads.js';
import { linkedAgain } from './background/notices.js';
import { APP_LINK_KEY, appDraws } from './shared/app-link.js';

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
// A request that says when its page stops waiting (`deadline`: a switch)
// waits only so long that SYNC_LEAVES_MS is left for the switch itself; one
// that names its tab by address too (`hint`: found among Safari's open tabs
// without the sync, background/tabs.js resolveTab, by the sync's own
// question if it's still under way), SYNC_HINTED_MS at most: with Safari slow
// after a relaunch, the sync and its write can take seconds.
const SYNC_LEAVES_MS = 2500;
const SYNC_HINTED_MS = 1000;
const untilSynced = (deadline = Infinity, hinted = false) => {
  if (isSynced()) return null;
  const ms = Math.max(0, Math.min(SYNC_WAIT_MS, deadline - SYNC_LEAVES_MS - Date.now(), deadline !== Infinity && hinted ? SYNC_HINTED_MS : Infinity));
  let timer;
  return Promise.race([firstSync, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};
// A background Safari stops and starts again (idle 30 s, then the next event)
// doesn't redo this each time: once per START_WORK_MS.
const START_WORK_MS = 10 * 60_000;
async function startWorkDue() {
  const { startWorkAt } = await Promise.resolve(api.storage.session?.get('startWorkAt')).catch(() => null) ?? {};
  if (Number.isFinite(startWorkAt) && Date.now() - startWorkAt < START_WORK_MS) return false;
  void Promise.resolve(api.storage.session?.set({ startWorkAt: Date.now() })).catch(() => {});
  return true;
}
firstSync.then(async () => {
  if (!isOwner() || !isSynced()) return;
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

api.tabs.onCreated.addListener(owned(async (tab) => {
  // ⌘T (a new tab showing the new-tab page, in front): handed back to the
  // page the user was on at once (handlers.js newTabHandOff); a new tab
  // that stays is tracked as usual.
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
    keepHandedOff(tabId);
  }
  // A tab a script found no page in may have one now (background/tabs.js noPageFound).
  if (change.status || change.url) pageChanged(tabId);
  // Into the state; a hidden tab's written a moment later (background/tab-updates.js).
  tabUpdated(tabId, change, tab);
  // Loading or done, for Margin.app's sidebar (background/page-loads.js: not stored).
  if (change.status) pageLoads.statusChanged(tab, change.status);
  if (change.url || change.status === 'complete') restore.tabChanged(tab); // its address may have come with the load
  // The URL when it changes, and again once loaded (in case Safari reported
  // the change without it, or it redirected). Not a Margin tab opened again
  // from its record: no search was made now (search-engine.js noteReopened).
  const url = change.url ?? (change.status === 'complete' ? tab.url : null);
  if (url) learnSearchEngine([url], { tabId });
  if (change.url) void newTabHint.tabAddress(tabId, change.url);
  if (change.status === 'complete') newTabHint.tabLoaded(tabId);
  // Safari reloading a tab as it's shown: it had unloaded it (diagnostics).
  if (change.status === 'loading' && !change.url && shownAt.get(tabId) > Date.now() - 1000) {
    console.info(`[margin] tab ${tabId} reloaded as it was shown`);
  }
}));
// What becomes of its Margin tab (state/model.js closedTab): closed on its
// own (Margin's ×, ⌘W, Safari's tab bar), it goes to the archive; lost with
// its window (`isWindowClosing`), it stays, not open, in its space; closed by
// Margin itself (background/closing.js), as Margin said (put to sleep: kept).
api.tabs.onRemoved.addListener(owned((tabId, removeInfo) => {
  handingOff.delete(tabId);
  tabClosed(tabId); // gone: forgotten
  newTabHint.tabGone(tabId);
  tabGone(tabId);
  forgetCurrent(tabId);
  const by = takeClosing(tabId);
  const windowClosing = removeInfo?.isWindowClosing === true;
  mutate((s) => {
    const closed = s.tabs[tabId];
    const followed = closed && lastFollow.get(closed.windowId);
    if (followed?.prevTabId === tabId && Date.now() - followed.at < STAY_MS) {
      // The browser already brought a tab of another space to the front (its
      // activation came first) and the window followed it: back.
      lastFollow.delete(closed.windowId);
      stayInSpace(closed.windowId, followed.from, tabId);
    } else if (closed?.active && !windowClosing) {
      closedShown.set(closed.windowId, { spaceId: s.tabSpace[tabId], at: Date.now(), tabId });
    }
    return M.closedTab(s, tabId, { by, windowClosing, now: now(), archiveId: newId() });
  });
  shownAt.delete(tabId);
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
// `left`: the tab it was shown in place of, as the activations came (not the
// state's `active`, which lags a run of quick switches); null if not known.
// Every activation waits for the state, so they go on in the order they came.
/** @param {{ tabId: number, windowId: number }} info @param {number | null} left */
const activated = owned(async ({ tabId, windowId }, left) => {
  await load();
  if (handingOff.has(tabId)) return;
  // One found cut off while in front is loaded again now it's behind (background/tabs.js).
  if (left != null && left !== tabId) tabLeft(left);
  userSwitched(tabId, windowId);
  tabShown(tabId);
  shownAt.set(tabId, Date.now());
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
  if (!api.alarms) {
    archiveStaleThrottled();
    sleepIdleThrottled();
  }
  // After the switch has landed (not in its way).
  setTimeout(() => isOwner() && ensureCurrent(tabId), 300);
});
// The tab in front of each window as the activations come, in order (the tab
// each one leaves): a tab closed or moved away is no longer in front.
/** @type {Map<number, number>} */
const frontByWindow = new Map();
const onActivation = (/** @type {{ tabId: number, windowId: number }} */ info) => {
  const left = handingOff.has(info.tabId) ? null : frontByWindow.get(info.windowId) ?? (Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === info.windowId && t.active && t.id !== info.tabId)?.id ?? null);
  if (!handingOff.has(info.tabId)) frontByWindow.set(info.windowId, info.tabId);
  return activated(info, left);
};
api.tabs.onActivated.addListener((info) => {
  switchLog.activated(info.tabId, info.windowId); // (a switch's line in Margin.app's log)
  return onActivation(info);
});
const notInFront = (/** @type {number} */ tabId) => { for (const [w, id] of frontByWindow) if (id === tabId) frontByWindow.delete(w); };
api.tabs.onRemoved.addListener(notInFront);
api.tabs.onDetached?.addListener(notInFront);
// A ⌘T tab that stays after all: its activation, left out while it was handed off, told now.
setActivationHook(onActivation);
// Each switch's line goes to Margin.app's log (background/switch-log.js).
switchLogTo((line) => appLink.note(line));
// Coming back to a window (or to Safari) shows its tab without onActivated:
// that tab is checked too (a stale copy there: tabs.js ensureCurrent).
api.windows?.onFocusChanged?.addListener(owned((windowId) => {
  if (windowId == null || windowId < 0) return;
  api.tabs.query({ active: true, windowId }).then(([tab]) => tab && setTimeout(() => isOwner() && ensureCurrent(tab.id), 300), () => {});
}));
api.tabs.onMoved.addListener(owned(() => resync({ fresh: false })));
api.tabs.onAttached.addListener(owned(() => resync({ fresh: false })));
api.tabs.onDetached?.addListener(owned(() => resync({ fresh: false })));
// Chrome: a window going full screen becomes Margin full screen.
api.windows?.onBoundsChanged?.addListener(owned((win) => followFullscreen(win.id)));
// A closed window may have been the one in full screen (registered.js syncPage).
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
// The tab found goes with it (`resolved`): a switch doesn't ask Safari for it
// a second time before it starts (handlers.js activateTab).
async function withTab(message, sender) {
  if (!Number.isInteger(message?.tabId) || !message.hint) return message;
  const target = await resolveTab(message.tabId, message.hint, sender.tab?.windowId, { deadline: message.deadline });
  if (!target) throw new Error('That tab is no longer open');
  return { ...message, tabId: target.id, hint: null, resolved: target };
}
// A copy that doesn't own the state answers `stale`: its pages then stay out
// of the way (content/core.js). Requests that name no tab (a page starting,
// its zoom, scroll and icon) don't wait for the first sync.
const BEFORE_SYNC = new Set(['hello', 'owner', 'sidebarScroll', 'setSidebarScroll', 'getZoom', 'pageIcon', 'windowState', 'injectPage', 'fetchStyle', 'appKeyHeard', 'newTabKey', 'startApp', 'pageLoading', 'gesture', 'viewport', 'visibility']);
// Requests whose page stops waiting at their `deadline` (content/core.js
// TIMED_REQUESTS) are answered before it, whatever is still under way: by
// REPLY_GUARD_MS before it, an answer that the switch didn't happen (it
// won't now: background/tabs.js focusTab doesn't start one past its
// deadline). A switch under way answers sooner itself (focusTab), so this
// is for a wait before it: the background starting (decided, the first
// sync), a slow storage (a space's write queued behind others), or a Safari
// call that doesn't answer. Unanswered, the page said the switch didn't
// happen, and a second later that Margin wasn't responding (2026-11-03).
const TIMED = new Set(['activateTab', 'openPin', 'setSpace', 'newTab', 'search']);
const REPLY_GUARD_MS = 500;
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  const deadline = TIMED.has(message.type) && Number.isFinite(message.deadline) ? message.deadline : Infinity;
  // A page that waits past its deadline (content/core.js SWITCH_GRACE_MS):
  // answered by then. Its switch still plans to its deadline (focusTab); the
  // grace is for timers that fire late and a Safari slow to carry out the
  // show, so the page hears it was shown rather than that it didn't happen.
  const latest = deadline !== Infinity && Number.isFinite(message.waitsUntil) ? Math.max(deadline, message.waitsUntil) : deadline;
  let answered = false;
  let guard = null;
  // A switch asked for: work that can wait (background/tabs.js
  // injectIntoOpenTabs) gives way until it's answered (by the guard too).
  const over = TIMED.has(message.type) ? switchAsked() : null;
  const answer = (/** @type {any} */ reply) => {
    if (answered) return;
    answered = true;
    clearTimeout(guard);
    over?.();
    sendResponse(reply);
  };
  if (deadline !== Infinity) {
    guard = setTimeout(() => {
      if (answered) return;
      console.warn(`[margin] ${message.type} still under way at its page's deadline: answered that it didn't happen`);
      answer({ ok: false, error: 'Too late: Margin took too long to answer' });
    }, Math.max(0, latest - REPLY_GUARD_MS - Date.now()));
  }
  if (message.type === 'hello') appLink.poke(); // a page starting: the app asked for again, if it wasn't there
  route(message, sender, deadline).then(answer);
  return true;
});
// A request run by its handler, as a page's (above) or Margin.app's UI's
// (background/link.js, `sender` standing for the app's window) is:
// answered { ok, result } or { ok: false, error, stale? }, never thrown.
/** @param {any} message @param {any} sender @param {number} [deadline] */
function route(message, sender, deadline = Infinity) {
  const handler = handlers[message?.type];
  if (!handler) return Promise.resolve({ ok: false, error: `no such request: ${message?.type}` });
  // DEVELOPMENT DIAGNOSTICS: how much of its page's wait was left as it came,
  // and what it waited for before its switch started (the switch log's
  // `before`: background/tabs.js focusTab).
  const arrival = deadline !== Infinity ? { at: Date.now(), left: deadline - Date.now(), decided: 0, sync: 0, resolve: 0 } : null;
  const since = (/** @type {number} */ from) => Date.now() - from;
  let step = Date.now();
  // A page starting asks whether this copy still owns the state (a newer
  // one may have taken over since: copies don't hear each other's writes).
  return decided()
    .then(() => (message.type === 'hello' || message.type === 'owner' ? recheck() : null))
    .then(() => {
      if (arrival) [arrival.decided, step] = [since(step), Date.now()];
      return isOwner() && !BEFORE_SYNC.has(message.type) ? untilSynced(deadline, Number.isInteger(message.tabId) && !!message.hint?.url) : null;
    })
    .then(() => {
      if (arrival) [arrival.sync, step] = [since(step), Date.now()];
      return isOwner() ? withTab(message, sender) : null;
    })
    .then((request) => {
      if (arrival) arrival.resolve = since(step);
      return isOwner() ? handler(arrival ? { ...request, arrival } : request, sender).then((result) => ({ ok: true, result })) : { ok: false, stale: true, error: 'a newer copy of Margin is running' };
    })
    // A change made while a newer copy took over wasn't written (store.js
    // mutate). Only a copy known not to own the state says `stale` (its pages
    // then stand down for good): a storage error while deciding is an error.
    .then((reply) => reply, (err) => (err instanceof StaleError || isStale() ? { ok: false, stale: true, error: String(err?.message ?? err) } : { ok: false, error: String(err?.message ?? err) }));
}

// ---- Margin.app (background/link.js) ---------------------------------------------
// Started once this copy knows it owns the state, with the settings it has.
firstSync.then(async () => {
  if (!isOwner()) return;
  const s = await load().catch(() => null);
  await appLink.start({ route, settings: s?.settings ?? null });
}).catch((err) => console.warn('[margin] link', err?.message ?? err));
api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && isOwner()) appLink.onStorage(changes); });
api.windows?.onCreated?.addListener((win) => appLink.windowCreated(win?.id));
api.windows?.onRemoved?.addListener((windowId) => appLink.windowClosed(windowId));
api.windows?.onFocusChanged?.addListener((windowId) => appLink.windowFocused(windowId));
api.windows?.onBoundsChanged?.addListener(() => appLink.windowsChanged());
api.tabs.onActivated.addListener((info) => appLink.tabActivated(info?.tabId, info?.windowId));
// What a tab's page said of being shown is forgotten once it's another page, gone or elsewhere.
api.tabs.onRemoved.addListener((tabId) => appLink.tabGone(tabId));
api.tabs.onReplaced?.addListener((_added, removed) => appLink.tabGone(removed));
api.tabs.onAttached.addListener((tabId) => appLink.tabGone(tabId));
api.webNavigation?.onCommitted?.addListener(({ tabId, frameId, timeStamp }) => { if (frameId === 0) appLink.tabGone(tabId, Number.isFinite(timeStamp) ? timeStamp : Infinity); });
// What's loading in each window, for its overlay (background/page-loads.js):
// a tab gone or moved, and every window again when the link comes.
api.tabs.onRemoved.addListener((tabId) => pageLoads.tabMoved(tabId));
api.tabs.onAttached.addListener((tabId, info) => pageLoads.tabMoved(tabId, info?.newWindowId ?? null));
appLink.onPageState((state) => {
  // The notices decided while the link was down, said now (background/notices.js).
  if (state === 'linked') void linkedAgain().catch(() => {});
  if (state === 'linked') void Promise.resolve(api.windows?.getAll?.()).then((wins) => pageLoads.tellAll((wins ?? []).map((w) => w.id)), () => pageLoads.tellAll());
});
// A window's layout: its page in front gets its box at once (the rest read
// it from storage, appLink, as they're shown or start), and new pages get it
// at their first paint (background/registered.js: the registered layout
// follows once layouts settle; a window with another gets its own as each
// page commits).
appLink.onLayout((windowId, layout) => {
  void api.tabs.query({ active: true, windowId }).then(([tab]) => tab && api.tabs.sendMessage(tab.id, { type: 'appLayout', windowId, layout, drawn: appLink.drawn(windowId) }).catch(() => {}), () => {});
  layoutsChanged();
});
// Whether the app draws over a window (its `drawn`): the same way. Its pages lose their box
// where it draws nothing (and get it back from the window's layout when it draws there again),
// and new pages there get none from their first paint (registered.js fixUp).
appLink.onDrawn((windowId, drawn) => {
  void api.tabs.query({ active: true, windowId }).then(([tab]) => tab && api.tabs.sendMessage(tab.id, { type: 'appLayout', windowId, layout: appLink.layout(windowId), drawn }).catch(() => {}), () => {});
  layoutsChanged();
});
setLayoutSource(() => appLink.view());
watchCommits();

// What a page's zoom answer keeps (handlers.js getZoom), in every copy: a
// copy that doesn't own the state now may again.
api.tabs.onZoomChange?.addListener(zoomChanged);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pageZoom) zoomStored();
});
// The first paint follows the settings (the theme) and the link to
// Margin.app (registered only while it's linked: background/registered.js).
const linkTurned = (change) => !!change && appDraws(change.oldValue) !== appDraws(change.newValue);
api.storage.onChanged.addListener(owned((changes, area) => {
  if (area === 'local' && (changes.settings || linkTurned(changes[APP_LINK_KEY]))) queueRegistrations();
}));
owned(queueRegistrations)();

// ---- auto-archive -----------------------------------------------------------

if (api.alarms) {
  // Then the tabs unused for a while put to sleep (background/sleep.js).
  api.alarms.onAlarm.addListener(owned(async (alarm) => {
    if (alarm.name !== ARCHIVE_ALARM) return;
    await archiveStale();
    await sleepIdle();
  }));
  api.alarms.get(ARCHIVE_ALARM).then((alarm) => alarm || api.alarms.create(ARCHIVE_ALARM, { periodInMinutes: 15 }));
  console.log('[margin] auto-archive via browser.alarms');
} else {
  console.log('[margin] auto-archive via tab events (no browser.alarms)');
}

// Debug hook for Web Inspector and tests: `margin.archiveNow()`;
// `margin.sleepNow(ms)`: a pass of sleeping tabs now, for tabs unused for `ms`
// (the setting's hours if left out).
globalThis.margin = { archiveNow: archiveStale, sleepNow: (/** @type {number | undefined} */ ms) => sleepIdle(Number.isFinite(ms) ? { afterMs: ms } : {}), syncRegistrations: queueRegistrations, navigate };

// ---- commands -------------------------------------------------------------

// While Margin.app draws the UI (linked, or reconnecting), its keys are the
// app's (Carbon hot keys following the Settings shortcuts: the `keys`
// message): a UI command that reaches the extension anyway (⌘T, the
// palette's, the sidebar's) does nothing visible here, and the app is told,
// for its diagnostics. In a window the app said it draws nothing over
// (`drawn`), its hot keys aren't on: ⌘T and the palette's key go the
// unlinked way, and the sidebar's is logged (there's no sidebar there).
// Not linked, there's no palette or sidebar to show
// (pages draw none of Margin's UI): ⌘T and the palette's key open Margin's
// new-tab page (its notice that the app isn't running, and an address
// field), the sidebar's does nothing. Navigation works either way: it draws
// nothing.
const APP_KEYS = new Set(['new-tab', 'open-palette', 'toggle-sidebar']);
api.commands?.onCommand.addListener(owned(async (command, tabArg) => {
  if (APP_KEYS.has(command) && appLink.pageState() !== 'off') {
    const windowId = tabArg?.windowId ?? (await Promise.resolve(api.windows?.getLastFocused?.()).catch(() => null))?.id ?? null;
    if (appLink.drawsWindow(windowId)) {
      console.info(`[margin] ${command} heard while Margin.app draws the UI: left to the app`);
      appLink.push(windowId, { type: 'keyHeard', command, from: 'command' });
      return;
    }
    if (command === 'toggle-sidebar') {
      appLink.note(`toggle-sidebar heard in window ${windowId}: Margin.app draws nothing over it, so there's no sidebar to show`);
      return;
    }
    console.info(`[margin] ${command} in window ${windowId}: Margin.app draws nothing over it: Margin's new-tab page`);
  }
  await untilSynced();
  if (command === 'new-tab' || command === 'open-palette') return newTabKey(tabArg);
  if (NAV_ACTIONS.has(command)) {
    const windowId = tabArg?.windowId ?? (await api.windows?.getLastFocused())?.id;
    return navigate(command, 'command', windowId);
  }
  console.info(`[margin] ${command}: nothing to show, Margin.app isn't linked`);
}));
