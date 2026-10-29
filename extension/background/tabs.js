// Showing, opening and reaching into tabs.
import * as M from '../state/model.js';
import { api, cached, isOwner, mutate, now, thisCopy } from './store.js';
import { recordSwitch } from './diagnostics.js';
import { platform } from '../shared/platform.js';
import { getScroll } from './scroll.js';
import { themeFor } from '../themes/index.js';

// When each tab was last shown, and its URL then (restoringTab; a
// diagnostic in tabs.onUpdated).
export const shownAt = new Map(); // tabId → when it was last activated
export const shownUrl = new Map(); // tabId → its URL then

// ---- switching tabs without a black frame -----------------------------------
// When a tab is shown, WebKit keeps the previous frame on screen until the tab
// has painted, but only while the tab's drawn layers are attached. Safari
// suspends a hidden tab's process within seconds, and that detaches them
// (WebProcessProxy::sendPrepareToSuspend → hideContentUntilPendingUpdate),
// so the switch showed black (Safari's empty view) until the tab painted.
// Waking the process reattaches them at once (processDidResume →
// unfreezeAllLayerTrees runs the pending redraw on a 0s timer; seen in
// Safari's log: every black switch went to a suspended process). So before
// Margin shows a tab, a script there keeps its process awake (Safari
// suspends it again as soon as nothing needs it), and a second one answers
// as soon as it has run: the process is running again and its layers are
// back, so the switch goes ahead then (at most WAKE_MAX_MS later: a process
// busy releasing memory took up to a second to come back in Safari's log, and
// the old page stays on screen meanwhile). Waiting a fixed 70ms instead left
// 23 of 100 such switches black (Safari's log, 2026-10-26). A tab Safari
// unloaded has no page: the scripts fail at once and the switch doesn't wait
// (Safari loads the page as it's shown). The wake can start early (a press on
// a sidebar row, the palette resting on a row: handlers.js prewake); the
// switch then picks up the same wake, already under way or done.
const WAKE_MAX_MS = 400;
// A wake started this recently still counts: the sidebar renews one every
// 500ms while the pointer rests on a row (sidebar.js), so a click finds one.
const WAKE_REUSE_MS = 600;
// Sidebar preparation (below) is an extra Safari-only round trip. It
// normally takes a few milliseconds once a hover wake has landed; a process
// Safari suspended takes 150ms to a second to come back (Safari's log:
// median 279ms), and the switch waits for it, under its cover, so the page
// arrives with its sidebar already as the one left. Never longer than this,
// for a busy page or a broken content script.
const PREPARE_MAX_MS = 900;
// Long enough for a reused wake, the wait and tabs.update (~110ms in Safari)
// to land while the process is still kept awake.
const KEEP_AWAKE_MS = WAKE_REUSE_MS + PREPARE_MAX_MS + 300;

// New tabs being handed back (⌘T, handlers.js newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set();

/** @typedef {{ outcome: 'awake' | 'no page' | 'timeout' | 'shown' | 'gone' | 'no access', ms: number, startedAt: number }} Wake */
/** @type {Map<number, { at: number, done: Promise<Wake> }>} */
const wakes = new Map();
// `renew`: a fresh wake even if one is recent (the sidebar's renewals while
// the pointer rests on a row, so the one a click finds is never older than
// the renewal interval).
/** @returns {Promise<Wake>} */
export function wakeTab(tabId, { renew = false } = {}) {
  const recent = wakes.get(tabId);
  if (recent && !renew && Date.now() - recent.at < WAKE_REUSE_MS) return recent.done;
  const at = Date.now();
  const done = startWake(tabId, at);
  wakes.set(tabId, { at, done });
  setTimeout(() => wakes.get(tabId)?.at === at && wakes.delete(tabId), WAKE_REUSE_MS + WAKE_MAX_MS);
  return done;
}
// The keep-awake script. WebKit keeps the tab's process awake until it
// finishes, so it must always finish: run in Margin's own world, its timer
// died with the page when the page navigated away (Margin reloads hidden
// pages after an update), and WebKit then waited for a garbage collection
// that may not come for many minutes (a tab held awake 11 minutes in
// Safari's log; reproduced in the WebKit host). So it runs in the page's own
// world (it isn't cleared with Margin's either) and finishes on its timer,
// when the page goes away (pagehide, pageswap), or once it's shown (awake
// then anyway). The page's code shares that world, so nothing here may
// depend on it: a second clock (AbortSignal.timeout, the engine's own) ends
// it if the page broke setTimeout, every page call is guarded, and the
// promise is the engine's (an async function's), whatever window.Promise is.
// Left open only if the page both cancels pagehide and blocks pageswap
// before navigating away. Self-contained: executeScript sends its source.
/** @param {number} ms */
export async function keepAwake(ms) {
  await {
    then(/** @type {() => void} */ resolve) {
      /** @type {(() => void)[]} */
      const undo = [];
      const done = () => {
        for (const step of undo) try { step(); } catch {}
        resolve();
      };
      const shown = () => {
        try { if (document.visibilityState === 'visible') done(); } catch {}
      };
      let timed = false;
      try {
        const timer = setTimeout(done, ms);
        undo.push(() => clearTimeout(timer));
        timed = true;
      } catch {}
      try {
        const signal = AbortSignal.timeout(ms + 500);
        signal.onabort = done;
        undo.push(() => { signal.onabort = null; });
        timed = true;
      } catch {}
      if (!timed) return resolve(); // no clock at all: no hold
      for (const type of ['pagehide', 'pageswap']) {
        try {
          addEventListener(type, done);
          undo.push(() => removeEventListener(type, done));
        } catch {}
      }
      try {
        document.addEventListener('visibilitychange', shown);
        undo.push(() => document.removeEventListener('visibilitychange', shown));
      } catch {}
    },
  };
}

/** @returns {Promise<Wake>} */
async function startWake(tabId, at) {
  const result = (/** @type {Wake['outcome']} */ outcome) => ({ outcome, ms: Date.now() - at, startedAt: at });
  // Only Safari blanks a suspended tab (Chrome keeps its last frame).
  if (!platform?.wakeTabs || !api.scripting?.executeScript) return result('no access');
  // What Margin knows of the tab, if its state is loaded (no round trip to
  // the browser before the wake: every one delays the switch); the
  // browser's answer otherwise. 'shown' (nothing to do) only as the browser
  // says: Margin's flag can be a moment behind.
  const tab = cached()?.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  if (!tab) return result('gone');
  if (tab.active) {
    const live = await api.tabs.get(tabId).catch(() => null);
    if (!live) return result('gone');
    if (live.active) return result('shown');
  }
  // Right away, not once the page has loaded (Chrome's default; WebKit
  // ignores the key and runs it right away anyway). The permission check
  // counts toward the wait too (it can be slow while Safari starts).
  const target = { tabId };
  const ran = (async () => {
    if (!(await mayAccessCached(tab.url))) return 'no access';
    api.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, func: keepAwake, args: [KEEP_AWAKE_MS] }).catch(() => {});
    return api.scripting.executeScript({ target, injectImmediately: true, func: () => true }).then(() => 'awake', () => 'no page');
  })();
  let timer;
  const outcome = await Promise.race([ran, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), WAKE_MAX_MS); })]);
  clearTimeout(timer);
  return result(/** @type {Wake['outcome']} */ (outcome));
}

// Executed in the destination's current isolated extension world. Keeping
// this self-contained matters: scripting.executeScript serializes only the
// function and its arguments. An older install's content script lives in a
// different world, so it cannot accidentally acknowledge this preparation.
export async function prepareSidebarInPage(context) {
  try {
    const prepare = globalThis.Margin?.content?.prepareForShow;
    if (typeof prepare !== 'function') return { ready: false, reason: 'no current sidebar' };
    return await prepare(context);
  } catch (error) {
    return { ready: false, reason: String(error?.message ?? error) };
  }
}

export function cancelSidebarInPage(token) {
  try {
    return globalThis.Margin?.content?.cancelPreparedShow?.(token) ?? false;
  } catch {
    return false;
  }
}

/** @typedef {{ outcome: 'ready' | 'not ready' | 'unavailable' | 'timeout' | 'skipped', ms: number, reason?: string, token: string | null }} Preparation */

/**
 * @param {any} tab
 * @param {{ token?: string, carry?: 'hover' | 'toggle' | null, scroll?: number | null, budget?: number }} [options]
 * @returns {Promise<Preparation>}
 */
async function prepareTabForShow(tab, { token, carry = null, scroll = null, budget = PREPARE_MAX_MS } = {}) {
  const at = Date.now();
  const result = (outcome, reason) => ({ outcome, ms: Date.now() - at, ...(reason ? { reason } : {}), token: token ?? null });
  if (!platform?.prepareSidebar || !api.scripting?.executeScript || !tab?.id || tab.windowId == null || !token) return result('skipped');
  let timer;
  const run = (async () => {
    // Not a page Margin may not run on (asking would only fail, or make
    // Safari ask for access).
    if (!(await mayAccessCached(tab.url))) return result('unavailable', 'no access');
    const top = Number.isFinite(scroll) ? scroll : await getScroll(tab.windowId).catch(() => 0);
    return api.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      func: prepareSidebarInPage,
      args: [{ token, tabId: tab.id, windowId: tab.windowId, scroll: top, carry }],
    }).then((rows) => {
      const answer = rows?.[0]?.result;
      return answer?.ready ? result('ready') : result('not ready', answer?.reason ?? 'no answer');
    }, (error) => result('unavailable', String(error?.message ?? error)));
  })();
  const answer = await Promise.race([
    run,
    new Promise((resolve) => { timer = setTimeout(() => resolve(result('timeout')), budget); }),
  ]);
  clearTimeout(timer);
  return answer;
}

function cancelPreparation(tabId, preparation) {
  if (!preparation?.token || preparation.outcome === 'skipped' || !api.scripting?.executeScript) return;
  api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: cancelSidebarInPage, args: [preparation.token] }).catch(() => {});
}

// Activate a tab, and focus its window only if it isn't already: re-focusing
// the current window can move keyboard focus out of the page in Safari.
// `wake: false` for a tab that was shown a moment ago (nothing to wake).
// `source`: what asked, for the switch log (background/diagnostics.js).
let focusGen = 0;
const focusing = new Map(); // tabId → overlapping Margin focus requests
export const isFocusing = (tabId) => (focusing.get(tabId) ?? 0) > 0;
// The user chose a tab themselves (Safari's tab bar, ⌘1–9, a held key passing
// through): a switch of Margin's still waiting doesn't pull the window back.
// Not for a tab Margin itself just brought to the front: its onActivated can
// come after that switch has ended (and would cancel the next one).
const activatedByMargin = new Map(); // tabId → when Margin asked Safari to bring it to the front
const OWN_ACTIVATION_MS = 1500;
// Switches per window (the user's, and Margin's), so a wait in one window
// (openBehind) isn't called off by a switch in another.
const windowGens = new Map(); // windowId → count
const windowGen = (windowId) => windowGens.get(windowId) ?? 0;
function movedOn(windowId) {
  if (windowId == null) return 0;
  windowGens.set(windowId, windowGen(windowId) + 1);
  return windowGen(windowId);
}
export function activating(tabId) {
  activatedByMargin.set(tabId, Date.now());
  setTimeout(() => {
    if (Date.now() - (activatedByMargin.get(tabId) ?? 0) >= OWN_ACTIVATION_MS) activatedByMargin.delete(tabId);
  }, OWN_ACTIVATION_MS);
}
export function userSwitched(tabId = null, windowId = null) {
  if (tabId != null && (isFocusing(tabId) || Date.now() - (activatedByMargin.get(tabId) ?? 0) < OWN_ACTIVATION_MS)) return;
  focusGen++;
  movedOn(windowId);
}
// `deadline`: when the page that asked stops waiting (it then says the switch
// didn't happen): no switch after it. `raise: false`: the window isn't
// brought forward (a switch the user didn't just ask for: openBehind).
/** @param {number} tabId @param {{ wake?: boolean, source?: string, carry?: 'hover' | 'toggle' | null, scroll?: number | null, deadline?: number, raise?: boolean }} [options] */
export async function focusTab(tabId, { wake = true, source = 'other', carry = null, scroll = null, deadline, raise = true } = {}) {
  focusing.set(tabId, (focusing.get(tabId) ?? 0) + 1);
  try {
    return await focusTabNow(tabId, { wake, source, carry, scroll, deadline, raise });
  } finally {
    const left = (focusing.get(tabId) ?? 1) - 1;
    if (left > 0) focusing.set(tabId, left);
    else focusing.delete(tabId);
  }
}

async function focusTabNow(tabId, { wake, source, carry, scroll, deadline, raise }) {
  const gen = ++focusGen;
  const asked = Date.now();
  const token = `${instanceId}:${gen}:${tabId}`;
  /** @type {Preparation} */
  const skipped = { outcome: 'skipped', ms: 0, token: null };
  // The tab as the browser has it now: whether it's still there, its window,
  // whether it's in front already (then there's nothing to wake or prepare).
  const live = await api.tabs.get(tabId).catch(() => null);
  if (!live) {
    recordSwitch({ source, tabId, asked, error: 'no such tab' });
    throw new Error(`No tab with id ${tabId}`);
  }
  movedOn(live.windowId);
  if (live.active) {
    // Another switch was asked for meanwhile: that one stands.
    if (gen !== focusGen) return { tab: null, preparation: skipped, superseded: true };
    if (raise) await focusWindow(live.windowId);
    return { tab: live, preparation: skipped };
  }
  // Run these together. Preparation itself wakes the isolated world, while
  // wakeTab's page-world hold keeps WebKit's layer tree attached through the
  // subsequent tabs.update.
  let [woke, preparation] = await Promise.all([
    wake ? wakeTab(tabId) : null,
    wake ? prepareTabForShow(live, { token, carry, scroll }) : /** @type {Promise<Preparation>} */ (Promise.resolve(skipped)),
  ]);
  // A page still running an earlier copy of Margin (it slept through an
  // update or a rebuild): the current copy goes in now, theme and all, and
  // is prepared in what's left of the wait, so the page doesn't show the old
  // copy's sidebar first.
  const left = () => PREPARE_MAX_MS - (Date.now() - asked);
  if (preparation.outcome === 'not ready' && preparation.reason === 'no current sidebar' && gen === focusGen && left() > 200) {
    const added = await Promise.race([addCurrentCopy(live), new Promise((resolve) => setTimeout(() => resolve(false), Math.min(400, left() - 100)))]);
    if (added && gen === focusGen && left() > 50) preparation = await prepareTabForShow(live, { token, carry, scroll, budget: left() });
  }
  // Another switch was asked for while this one waited (back to the tab in
  // front, say): the latest wins.
  if (gen !== focusGen) {
    cancelPreparation(tabId, preparation);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, error: 'superseded' });
    return { tab: null, preparation, superseded: true };
  }
  // A timeout only bounds how long the old page stays covered. Stop the late
  // preparation before activating, otherwise it could finish over the live
  // destination and leave a token for some later switch to consume.
  if (preparation.outcome === 'timeout') cancelPreparation(tabId, preparation);
  if (Number.isFinite(deadline) && Date.now() > deadline - 250) {
    cancelPreparation(tabId, preparation);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, error: 'expired' });
    throw new Error('Too late: the page stopped waiting for this switch');
  }
  // A tab Safari unloaded (no page to wake or prepare): its page starts as
  // it's shown and draws Margin before its background has said which tab it
  // is; this says it (content/core.js `showing`).
  if (woke?.outcome === 'no page') await noteShowing(live, { carry, scroll });
  const fail = (err) => {
    cancelPreparation(tabId, preparation);
    forgetShowing(tabId);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, error: String(err) });
    throw err;
  };
  activating(tabId);
  const tab = await api.tabs.update(tabId, { active: true }).catch(fail);
  // Safari can answer without having brought the tab to the front: checked,
  // and asked once more. A switch that didn't happen says so (the page shows
  // it, instead of its highlight going back as if nothing was asked).
  if (!(await isInFront(tabId, tab))) {
    if (gen !== focusGen) return { tab: null, preparation, superseded: true }; // another switch took the front meanwhile
    if (Number.isFinite(deadline) && Date.now() > deadline - 250) fail(new Error('Too late: the page stopped waiting for this switch'));
    activating(tabId);
    await api.tabs.update(tabId, { active: true }).catch(fail);
    if (!(await isInFront(tabId))) fail(new Error(`Safari didn't bring tab ${tabId} to the front`));
  }
  recordSwitch({ source, tabId, asked, wake: woke, preparation, shownAfter: Date.now() - asked });
  if (tab && raise) await focusWindow(tab.windowId);
  return { tab, preparation };
}
// The window comes forward only if it isn't already (see focusTab).
async function focusWindow(windowId) {
  if (!api.windows || windowId == null) return;
  const win = await api.windows.get(windowId).catch(() => null);
  if (win && !win.focused) await api.windows.update(windowId, { focused: true }).catch(() => {});
}
// Whether the tab is the one in front of its window (as tabs.update said, or
// the browser says a moment later).
async function isInFront(tabId, updated = null) {
  if (updated?.active) return true;
  for (const ms of [0, 120]) {
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    if ((await api.tabs.get(tabId).catch(() => null))?.active) return true;
  }
  return false;
}

// ---- the first frame of a page shown without preparation ---------------------
// Storage `showing`: { tabId, windowId, url, carry, scroll, at }, the tab
// Margin is bringing to the front without having prepared its sidebar. Its
// page starts (Safari restoring a tab it had unloaded) before its background
// has said which tab it is: by this, it draws its own tab highlighted, its
// space, and the sidebar open and scrolled as the page before, from its
// first frame (content/core.js); the fitted layout doesn't hold the page back
// for a previous one that isn't on screen (content/shell.js). Written by the
// copy that owns the state only (shared/owner.js).
let noted = null; // { tabId, at } of the last note
// The note goes a moment after its page has said hello (handlers.js: its
// first storage read may still be under way), or when the switch failed:
// another page at that address mustn't take it for itself later.
const FORGET_AFTER_HELLO_MS = 2000;
export function forgetShowing(tabId, { later = false } = {}) {
  const note = noted;
  if (note?.tabId !== tabId) return;
  const forget = () => {
    if (noted !== note) return; // a newer note
    noted = null;
    void Promise.resolve().then(() => api.storage.local.remove('showing')).catch(() => {});
  };
  if (later) setTimeout(forget, FORGET_AFTER_HELLO_MS);
  else forget();
}
async function noteShowing(tab, { carry = null, scroll = null } = {}) {
  if (!isOwner() || !tab?.url) return;
  noted = { tabId: tab.id, at: Date.now() };
  const top = Number.isFinite(scroll) ? scroll : await getScroll(tab.windowId).catch(() => null);
  const showing = { tabId: tab.id, windowId: tab.windowId, url: tab.url, carry, scroll: Number.isFinite(top) ? top : null, at: Date.now() };
  await Promise.race([api.storage.local.set({ showing }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 100))]);
}

// The tab a page asked for, as this copy has it. Pages draw from storage,
// whose tab ids can be from before this copy's first sync (the last session's,
// another copy's): a row then also says its tab's address and place
// (`hint`), which find it among the open tabs (in the asking page's window
// first, then the nearest place). Null if it's gone.
// The id itself stands only if the page drew this copy's tab ids, matched to
// the open tabs (`hint.from`: whose they were, shared/stored.js); ids from
// another copy or another Safari session can name a different tab now.
/** @param {number} tabId @param {{ url?: string, index?: number, title?: string, from?: { origin?: string, since?: number, synced?: boolean } | null } | null | undefined} hint @param {number | null | undefined} preferWindow */
export async function resolveTab(tabId, hint, preferWindow) {
  const me = thisCopy();
  const ours = !hint || ('from' in hint ? hint.from?.origin === me.origin && (hint.from.since == null || hint.from.since === me.since) && hint.from.synced !== false : true);
  const live = Number.isInteger(tabId) && ours ? await api.tabs.get(tabId).catch(() => null) : null;
  if (live || !hint?.url) return live;
  const key = M.normalizeUrl(hint.url);
  let candidates = (await api.tabs.query({}).catch(() => [])).filter((t) => M.normalizeUrl(t.url || t.pendingUrl || '') === key);
  // The same page open twice: the one with the row's title, if that tells them apart.
  if (candidates.length > 1 && hint.title && candidates.some((t) => t.title === hint.title)) candidates = candidates.filter((t) => t.title === hint.title);
  if (!candidates.length) return null;
  const distance = (t) => (t.windowId === preferWindow ? 0 : 1e6) + Math.abs((t.index ?? 0) - (hint.index ?? 0));
  const found = candidates.reduce((best, t) => (distance(t) < distance(best) ? t : best));
  console.info(`[margin] tab ${tabId} isn't one this copy of Margin knows: switching to tab ${found.id}, at the same address`);
  return found;
}

// When Margin last opened a tab or window itself (background/newtab-hint.js
// leaves those out).
let marginOpenedAt = 0;
export function markMarginOpening() {
  marginOpenedAt = Date.now();
}
const OWN_TAB_MS = 2000; // a tab created this soon after Margin opened one is Margin's
export const openedByMargin = () => Date.now() - marginOpenedAt < OWN_TAB_MS;

// ---- pages already open when Margin is installed or updated -----------------
// This run of the background: content scripts keep it from their hello, so
// a page running the current copy (it said hello, or started after this run
// did) can be told from one left by an earlier copy (injectIntoOpenTabs).
export const instanceId = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
export const startedAt = Date.now();
// Whether Margin may run scripts on this page (asks, never prompts). Match
// patterns have no port.
// mayAccess, remembered per site until Margin's permissions change. Only a
// yes: a site granted from Safari's own controls may come with no event.
const access = new Map(); // origin pattern → Promise<boolean>
api.permissions?.onAdded?.addListener(() => access.clear());
api.permissions?.onRemoved?.addListener(() => access.clear());
async function mayAccessCached(url) {
  let key;
  try {
    const { protocol, hostname } = new URL(url);
    key = `${protocol}//${hostname}`;
  } catch {
    return false;
  }
  if (!access.has(key)) {
    const answer = mayAccess(url);
    access.set(key, answer);
    answer.then((ok) => { if (!ok && access.get(key) === answer) access.delete(key); });
  }
  return access.get(key);
}
export async function mayAccess(url) {
  let pattern;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    pattern = `${protocol}//${hostname}/*`;
  } catch {
    return false;
  }
  return (await api.permissions?.contains({ origins: [pattern] }).catch(() => false)) ?? false;
}
// Runs `func` in the tab's page (Margin's content-script world). 'asleep'
// when it can't run because there's no page (WebKit: no web view; a tab
// Safari unloaded), 'unknown' when Margin has no access or no answer came
// within `ms` (a busy page), else { result }. Messages to content scripts
// aren't used for this: after Margin is reinstalled or updated, WebKit can
// stop delivering them to pages that were open (their listeners stay with
// the old copy), while executeScript keeps working.
export async function inPage(tabId, url, func, args = [], ms = 300) {
  if (!api.scripting?.executeScript || !(await mayAccess(url))) return 'unknown';
  return Promise.race([
    api.scripting.executeScript({ target: { tabId }, func, args }).then((r) => ({ result: r?.[0]?.result }), () => 'asleep'),
    new Promise((resolve) => setTimeout(() => resolve('unknown'), ms)),
  ]);
}

/** @param {{ windowId?: number, url?: string, spaceId?: string }} options */
export async function openTab({ windowId, url, spaceId }) {
  focusGen++; // a switch still waiting for its wake doesn't land after this
  movedOn(windowId);
  markMarginOpening();
  // In its space from the start: the window shows that space before the tab
  // exists, so the browser's events for it (created, activated) already put
  // it there, instead of in the space shown before and then moving it (the
  // window could stay on the other one).
  if (spaceId && windowId != null) await mutate((s) => M.setActiveSpace(s, windowId, spaceId));
  const tab = await api.tabs.create({ windowId, url, active: true });
  if (spaceId) await mutate((s) => M.moveTab(M.upsertTab(s, tab, now()), tab.id, spaceId));
  return tab;
}

// A page of the tab in front is told about a switch the background makes from
// it ('switching', then 'switch-done' or 'switch-failed': content/core.js);
// Margin's own pages have no content script, so they hear it as a broadcast
// that says which page it's for (`from`).
export const tellPage = (/** @type {{ id: number }} */ page, /** @type {any} */ message) =>
  api.tabs.sendMessage(page.id, message).catch(() => api.runtime.sendMessage(message).catch(() => {}));

// ---- a new tab chosen in the palette --------------------------------------------
// ⌘T, an address or a search, Enter: as a browser that shows the new page
// once there's something to show, not an empty one while it loads (Safari's
// new tab is dark until the page arrives). The tab opens behind the page the
// user is on, and its row is in the sidebar at once, highlighted, with that
// page covered (the switch's empty screen, its spinner: content/core.js);
// once the new page has loaded (at most LOADED_MAX_MS, then as far as it got)
// it comes to the front, its sidebar prepared as for any switch. If the user
// goes elsewhere meanwhile (another tab, their own tab's row), it stays
// behind, loaded, as a ⌘-clicked link would. `then(tab)`: what loads it,
// after the row is in (a search: background/handlers.js); else `url`.
const LOADED_MAX_MS = 5000;
const FOCUS_MS = 2500; // what bringing it to the front may take, within the page's deadline
const POLL_MS = 100;
/**
 * `deadline`: when the page that asked stops waiting. `created(tab)`: told
 * as soon as the tab exists. `label`: its row's title until it has its own.
 * @param {{ windowId?: number | null, url?: string, from: any, then?: (tab: any) => Promise<unknown>, created?: (tab: any) => void, label?: string, deadline?: number, maxMs?: number }} options
 * @returns {Promise<{ tabId: number, shown: number | null }>}
 */
export async function openBehind({ windowId, url, from, then, created, label, deadline, maxMs = LOADED_MAX_MS }) {
  const asked = Date.now();
  const win = from.windowId ?? windowId; // the page's own window (the page's idea of it can be a guess)
  focusGen++; // a switch still waiting for its wake doesn't land after this
  const gen = movedOn(win);
  markMarginOpening();
  const tab = await api.tabs.create({ windowId: win, url: then ? 'about:blank' : url, active: false });
  created?.(tab);
  // In the window's space (model.js assignTab), drawn before the page is told.
  await mutate((s) => M.upsertTab(s, label && !tab.title ? { ...tab, title: label } : tab, now())).catch(() => {});
  const told = (type, reason = null) => tellPage(from, { type, tabId: tab.id, from: from.id, ...(reason ? { reason } : {}) });
  const notShown = (reason = null) => {
    void told('switch-failed', reason);
    return { tabId: tab.id, shown: null };
  };
  // The user went elsewhere in this window (another tab, their own row, the
  // palette again). If that's to this very tab (its row clicked, a key
  // landing on it), that switch brings it and ends the page's wait itself.
  const left = () => windowGen(win) !== gen;
  const leftFor = () => (isFocusing(tab.id) || Date.now() - (activatedByMargin.get(tab.id) ?? 0) < OWN_ACTIVATION_MS
    ? { tabId: tab.id, shown: null }
    : notShown());
  // Chosen something else while the tab was being made: it just stays behind.
  if (left()) return leftFor();
  void tellPage(from, { type: 'switching', tabId: tab.id, from: from.id, windowId: tab.windowId, cover: 'now' });
  try {
    await then?.(tab);
  } catch (err) {
    return notShown(String(err?.message ?? err));
  }
  const until = Math.min(asked + maxMs, (deadline ?? Infinity) - FOCUS_MS);
  const loaded = await untilLoaded(tab.id, until, left, from.id);
  // The wait itself, in the switch log (the switch after it has its own line).
  recordSwitch({ source: 'new tab loading', tabId: tab.id, asked, shownAfter: Date.now() - asked, error: loaded === 'loaded' ? null : loaded });
  // Closed meanwhile, or the user went elsewhere (the page they were on
  // went somewhere else too): it stays where it is.
  if (loaded === 'gone' || loaded === 'moved') return notShown();
  if (loaded === 'left') return leftFor();
  try {
    const result = await focusTab(tab.id, { source: 'new tab', deadline: Math.min(asked + maxMs + FOCUS_MS, deadline ?? Infinity), raise: false });
    if (!result?.tab) return result?.superseded ? leftFor() : notShown();
  } catch (err) {
    return notShown(String(err?.message ?? err));
  }
  void told('switch-done');
  return { tabId: tab.id, shown: tab.id };
}
// 'loaded' (complete at an address of its own, not the blank page a search
// starts from; or, an address Safari doesn't say without site access, once
// it was seen loading), 'timeout', 'gone' (closed), 'left' (`left()`) or
// 'moved' (the page the user is on, `fromId`, started loading something
// else: a link, the address bar, a reload). A question Safari doesn't answer
// counts as still loading.
async function untilLoaded(tabId, until, left, fromId) {
  const SLOW = Symbol('slow');
  const ask = (id) => {
    let timer;
    return Promise.race([
      api.tabs.get(id).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(SLOW), Math.max(POLL_MS, until - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
  };
  let sawLoading = false;
  let fromLoaded = null; // whether the page the user is on had loaded, when first seen
  for (;;) {
    if (left()) return 'left';
    const [tab, from] = await Promise.all([ask(tabId), fromId != null ? ask(fromId) : null]);
    if (tab === SLOW) return left() ? 'left' : 'timeout';
    if (!tab) return 'gone';
    if (left()) return 'left';
    if (from && from !== SLOW) {
      fromLoaded ??= from.status === 'complete';
      if (fromLoaded && from.status === 'loading') return 'moved';
      if (from.status === 'complete') fromLoaded = true;
    }
    if (tab.status === 'loading') sawLoading = true;
    if (tab.status === 'complete' && ((tab.url && tab.url !== 'about:blank') || (!tab.url && sawLoading))) return 'loaded';
    if (Date.now() >= until) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, until - Date.now()))));
  }
}

// Tabs opened from a page by openLink, so the next one goes after them.
export const openedFrom = new Map(); // opener tab id → { index, at }

// A tab brought to the front runs this copy of Margin, or gets it now. A
// tab asleep when Margin was updated (or reinstalled, as in development)
// isn't given the new copy (injectIntoOpenTabs skips sleeping tabs), and
// when it wakes it may still run the previous one, whose messages go
// nowhere and never fail in WebKit: every click in its sidebar hung (seen in
// Safari's log: nothing reached the background from that tab). A copy in
// Margin's own content-script world is this one (an earlier install's lives
// in a world of its own); without one, the scripts go in, and the new copy
// takes the page over from the stale sidebar (content/core.js). Each tab is
// checked once per run of the background.
const checkedCurrent = new Set();
const checking = new Map(); // tabId → the check in flight (one at a time)
export function ensureCurrent(tabId) {
  if (!checking.has(tabId)) checking.set(tabId, checkCurrent(tabId).finally(() => checking.delete(tabId)));
  return checking.get(tabId);
}
async function checkCurrent(tabId) {
  if (checkedCurrent.has(tabId) || !api.scripting?.executeScript) return;
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!files?.length || !tab?.url || tab.discarded) return;
  const here = await inPage(tabId, tab.url, () => !!globalThis.Margin?.content, [], 1000);
  if (typeof here === 'string') return; // asleep, no access or busy: next time
  checkedCurrent.add(tabId);
  if (here.result === true) return;
  console.info(`[margin] tab ${tabId} had no current copy of Margin: added`);
  await api.scripting.executeScript({ target: { tabId }, files }).catch(() => {});
}
export const forgetCurrent = (tabId) => checkedCurrent.delete(tabId);
// The current copy's core and its active theme, into a page that has neither
// (focusTabNow, before a switch to it). Whether they went in.
async function addCurrentCopy(tab) {
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript || !(await mayAccessCached(tab.url))) return false;
  const theme = themeFor(cached()?.settings).content;
  const ok = await api.scripting.executeScript({ target: { tabId: tab.id }, files: [...files, theme], injectImmediately: true }).then(() => true, () => false);
  if (ok) {
    checkedCurrent.add(tab.id);
    console.info(`[margin] tab ${tab.id} had an earlier copy of Margin: the current one went in before switching to it`);
  }
  return ok;
}

// Executed in this install's isolated world before its content bundle is put
// into an already-open page. A previous temporary install can leave a fully
// drawn, clickable sidebar in the DOM even though its background is gone.
// Disable that UI before the new bundle starts: otherwise its optimistic tab
// highlight waits for a message that WebKit never resolves, then snaps back
// when the old copy's 2.5s switch timer expires.
export function disableStaleSidebarInPage() {
  if (globalThis.Margin?.content) return false;
  let disabled = false;
  for (const node of /** @type {HTMLElement[]} */ ([...(document.documentElement?.children ?? [])])) {
    if (!/^margin-.*-host$/.test(node.localName)) continue;
    node.style.setProperty('display', 'none', 'important');
    node.style.setProperty('pointer-events', 'none', 'important');
    node.setAttribute('aria-hidden', 'true');
    disabled = true;
  }
  return disabled;
}

// Pages already open when Margin is installed, updated, or Safari starts a
// fresh session. WebKit normally adds the content scripts itself, but may do
// so seconds late on a cold launch. Repair immediately from the background,
// then retry pages that were busy or whose permission was not ready yet.
// Sleeping tabs are deliberately skipped; ensureCurrent repairs one when it
// is first shown. A page with a previous copy reloads later, when safe
// (content/core.js), to remove that copy's remaining page-world hooks.
const REPAIR_RETRY_MS = [350, 1200, 3000];
let repairOpenTabs = null;
/** @param {{ retry?: boolean }} [options] */
export function injectIntoOpenTabs({ retry = true } = {}) {
  if (!repairOpenTabs) {
    repairOpenTabs = runOpenTabRepair(retry).finally(() => { repairOpenTabs = null; });
  }
  return repairOpenTabs;
}

async function runOpenTabRepair(retry) {
  // The sidebar's entry: the one not in the page's own world (that's
  // content/shell-main.js), whatever the build named its file.
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript) return;
  const delays = [0, ...(retry ? REPAIR_RETRY_MS : [])];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const tabs = await api.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map(async (tab) => {
      if (tab.discarded || checkedCurrent.has(tab.id) || checking.has(tab.id) || !/^https?:/i.test(tab.url ?? '')) return;
      const current = await inPage(tab.id, tab.url, (id, since) => {
        const content = globalThis.Margin?.content;
        return !!content && (content.instanceId === id || content.startedAt >= since);
      }, [instanceId, startedAt], 1000);
      if (current?.result === true) {
        checkedCurrent.add(tab.id);
        return;
      }
      if (typeof current === 'string') return; // asleep, no access or busy: a retry or activation gets it
      await api.scripting.executeScript({ target: { tabId: tab.id }, func: disableStaleSidebarInPage }).catch(() => {});
      const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, files }).then(() => true, () => false);
      if (injected) checkedCurrent.add(tab.id);
    }));
    if (tabs.every((tab) => tab.discarded || checkedCurrent.has(tab.id) || !/^https?:/i.test(tab.url ?? ''))) return;
  }
}
