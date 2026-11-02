// Showing, opening and reaching into tabs.
import * as M from '../state/model.js';
import { api, cached, isOwner, mutate, now, thisCopy } from './store.js';
import { recordSwitch } from './diagnostics.js';
import { platform } from '../shared/platform.js';
import { getScroll } from './scroll.js';
import { themeFor } from '../themes/index.js';
import { cutOffAction, cutOffInPage, oldOwnPageAddress } from './cut-off.js';
import { readyInPage } from '../shared/page-ready.js';

// When each tab was last shown (a
// diagnostic in tabs.onUpdated).
export const shownAt = new Map(); // tabId → when it was last activated

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
// A page that has just loaded behind (restoreTab, waitLoaded) is busy with
// its own start: its preparation gets this long at most (Safari's log had the
// step from introduction to show take a median 370 ms on such pages, against
// the 60 ms meant). One that misses it is shown unprepared: it has said hello
// by then, and draws its own tab.
const PREPARE_LOADED_MS = 500;
// How long a tab about to be introduced waits for the preparation started
// beside its wake to land, at most, before calling it off (mayIntroduce's
// `unseen`).
const UNSEEN_PREPARED_MS = 150;
// Long enough for a reused wake, the wait and tabs.update (~110ms in Safari)
// to land while the process is still kept awake.
const KEEP_AWAKE_MS = WAKE_REUSE_MS + PREPARE_MAX_MS + 300;

// New tabs being handed back (⌘T, handlers.js newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set();

/** @typedef {{ outcome: 'awake' | 'no page' | 'timeout' | 'shown' | 'gone' | 'no access', ms: number, startedAt: number, unseen?: boolean }} Wake `unseen`: its page started visible and hasn't come into view from hidden since (pageThere) */
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
  const result = (/** @type {Wake['outcome']} */ outcome, unseen = false) => ({ outcome, ms: Date.now() - at, startedAt: at, ...(unseen ? { unseen } : {}) });
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
    return api.scripting.executeScript({ target, injectImmediately: true, func: pageThere }).then((rows) => (!ranThere(rows) ? 'no page' : rows[0].result === 'unseen' ? 'unseen' : 'awake'), () => 'no page');
  })();
  let timer;
  const outcome = await Promise.race([ran, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), WAKE_MAX_MS); })]);
  clearTimeout(timer);
  return outcome === 'unseen' ? result('awake', true) : result(/** @type {Wake['outcome']} */ (outcome));
}
// Whether a tab has a page: a script runs there, in a document of its own.
// WebKit answers a script for a tab with a view but no page yet (Safari makes
// a restored tab's view as it's selected, before its load) with an error in
// place of a result, rather than failing (WebExtensionDynamicScriptsCocoa:
// "Failed to execute script."); a page not committed yet is the empty one it
// starts with. 'unseen': a page this copy of Margin runs in that started
// visible in a tab whose page may have just been made, and hasn't come into
// view from hidden since (content/core.js windowSeen: the tab in front at a
// launch, one Safari loaded as it was shown, both made from the tab's saved
// history), whose tab WebKit may never have seen come into the window with a
// process (mayIntroduce). A page with an earlier copy (its world isn't this
// one) counts as seen.
export const pageThere = () => {
  if (/^about:/.test(location.href)) return false;
  try {
    return globalThis.Margin?.content?.windowSeen?.() === false ? 'unseen' : true;
  } catch {
    return true;
  }
};
/** @param {any} rows executeScript's answer */
const ranThere = (rows) => rows?.[0]?.result === true || rows?.[0]?.result === 'unseen';
/** @param {any} rows executeScript's answer, for a script that returns nothing */
const ranAtAll = (rows) => !(Array.isArray(rows) && rows.some((row) => row?.error));
// A wake that found a page there: awake, or too busy to answer in time.
/** @param {Wake | null | undefined} woke */
const hasPage = (woke) => woke?.outcome === 'awake' || woke?.outcome === 'timeout';

// Keeps a hidden tab's process running for `ms` (keepAwake), without waiting
// for it: background/keep-ready.js. False if it can't (no page: Safari
// unloaded it, and a hold doesn't load it; no access to the site).
/** @param {number} tabId @param {number} ms @returns {Promise<boolean>} */
export async function holdTab(tabId, ms) {
  if (!platform?.wakeTabs || !api.scripting?.executeScript) return false;
  const tab = cached()?.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  if (!tab || !(await mayAccessCached(tab.url))) return false;
  return api.scripting.executeScript({ target: { tabId }, world: 'MAIN', injectImmediately: true, func: keepAwake, args: [ms] }).then(ranAtAll, () => false);
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
 * `covered`: the page before is covered (a switch it asked for): a page shown
 * for the first time arrives covered too (content/core.js arriveCovered).
 * @param {any} tab
 * @param {{ token?: string, carry?: 'hover' | 'toggle' | null, scroll?: number | null, budget?: number, covered?: boolean }} [options]
 * @returns {Promise<Preparation>}
 */
async function prepareTabForShow(tab, { token, carry = null, scroll = null, budget = PREPARE_MAX_MS, covered = false } = {}) {
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
      args: [{ token, tabId: tab.id, windowId: tab.windowId, scroll: top, carry, covered, until: at + budget }],
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

// A page shown for the first time, out of sight under its cover before it's
// introduced (focusTabNow): it then paints only the cover in that instant, so
// the paint WebKit asks for lands within a few milliseconds and before the
// show (a heavy page's own first paint took 70–300 ms in Safari's log, and a
// show sent before it lands isn't held for the paint: Safari's empty view).
// Executed in the tab's isolated extension world, as prepareSidebarInPage.
export function coverArrivalInPage() {
  try {
    return globalThis.Margin?.content?.coverArrival?.() === true;
  } catch {
    return false;
  }
}
const COVER_ARRIVAL_MS = 300; // a page too busy to answer by then is introduced as it is
/** @param {any} tab @returns {Promise<boolean>} */
async function coverArrival(tab) {
  if (!platform?.prepareSidebar || !api.scripting?.executeScript) return false;
  let timer;
  const covered = await Promise.race([
    api.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, func: coverArrivalInPage }).then(ranThere, () => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), COVER_ARRIVAL_MS); }),
  ]);
  clearTimeout(timer);
  return /** @type {boolean} */ (covered);
}

// The tab's page has been through two rendering updates since this started:
// a ResizeObserver's first callback for its root comes at the next rendering
// update (an observation starts with one; nothing is added to the page), and
// a second observer, started after that update, at the one after. A hidden
// page runs rendering updates too (WebKit's remote layer tree drawing area
// doesn't stop for one). Two, because the answer to the first can leave the
// page before the commit of the very update it ran in (an observer runs in
// the middle of an update; the commit goes out at its end): in the WebKit
// host, a tab never shown, shown right after one callback, was Safari's empty
// view for 23–30 ms in 4 of 6 runs; after two, in none of 6 (12 runs, 1–2 ms).
// So the paint its introduction asked for has landed, which the fixed 60 ms
// wait before it didn't guarantee either (two shows in Tirth's Safari went out
// before it, 176 and 372 ms of Safari's empty view). Awaited last before a
// tab like that is shown, it also puts the show in a gap after the page's
// main thread drew, not mid-task. The second observer starts from a task of
// its own (a message to itself, which WebKit doesn't hold back in a hidden
// page as it may a timer): one started inside the first's callback is skipped
// in that update, and the page gets an error event for it, "ResizeObserver
// loop completed with undelivered notifications." (twice per restored tab in
// the WebKit host, in the page's own log: a site's error reporting, or a dev
// server's error overlay, would have taken it for its own). Self-contained
// (executeScript sends only its source); its own clock is a hidden page's,
// which WebKit may throttle: the background bounds it too.
/** @param {number} ms @returns {Promise<'drawn' | 'timeout' | 'none'>} */
export function paintBarrierInPage(ms) {
  return new Promise((resolve) => {
    /** @type {ResizeObserver | null} */
    let observer = null;
    /** @type {MessageChannel | null} */
    let channel = null;
    let timer = null;
    let over = false;
    const done = (/** @type {'drawn' | 'timeout' | 'none'} */ how) => {
      if (over) return;
      over = true;
      try { observer?.disconnect(); } catch {}
      try { channel?.port1.close(); } catch {}
      clearTimeout(timer);
      resolve(how);
    };
    const observe = (/** @type {number} */ left) => {
      observer = new ResizeObserver(() => {
        try { observer?.disconnect(); } catch {}
        if (left <= 1) return done('drawn');
        try {
          channel ??= new MessageChannel();
          channel.port1.onmessage = () => {
            if (over) return;
            try { observe(left - 1); } catch { done('none'); }
          };
          channel.port2.postMessage(0);
        } catch {
          done('none');
        }
      });
      observer.observe(document.documentElement);
    };
    timer = setTimeout(() => done('timeout'), ms);
    try {
      observe(2);
    } catch {
      done('none');
    }
  });
}
const BARRIER_MAX_MS = 400; // a page too busy to draw by then is shown as it is
/** @param {any} tab @param {number} ms @returns {Promise<'drawn' | 'timeout' | 'none'>} */
async function paintBarrier(tab, ms) {
  if (!api.scripting?.executeScript) return 'none';
  let timer;
  const drawn = await Promise.race([
    api.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, func: paintBarrierInPage, args: [ms] }).then((rows) => rows?.[0]?.result ?? 'none', () => 'none'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms + 20); }),
  ]);
  clearTimeout(timer);
  return /** @type {'drawn' | 'timeout' | 'none'} */ (drawn);
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
export const anyFocusing = () => focusing.size > 0;
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
  const at = Date.now();
  activatedByMargin.set(tabId, at);
  setTimeout(() => {
    if (Date.now() - (activatedByMargin.get(tabId) ?? 0) >= OWN_ACTIVATION_MS) activatedByMargin.delete(tabId);
  }, OWN_ACTIVATION_MS);
  return at;
}
// That mark taken back (if no newer one replaced it).
function unmark(tabId, at) {
  if (activatedByMargin.get(tabId) === at) activatedByMargin.delete(tabId);
}
export function userSwitched(tabId = null, windowId = null) {
  if (tabId != null && (isFocusing(tabId) || Date.now() - (activatedByMargin.get(tabId) ?? 0) < OWN_ACTIVATION_MS)) return;
  focusGen++;
  movedOn(windowId);
}
// `deadline`: when the page that asked stops waiting (it then says the switch
// didn't happen): no switch after it. `raise: false`: the window isn't
// brought forward (a switch the user didn't just ask for: openBehind).
// `covered`: the page the switch is from is covered meanwhile (prepareTabForShow).
// `hurry()`: true once the switch should stop waiting for its tab to load (a
// key press after it: background/navigation.js); it then gives up, `hurried`.
// `loadWaited`: the caller has waited for the tab to load already (openBehind):
// not waited for again. `retry`: the caller goes on to another tab if this one
// is closed meanwhile (showSpace): that isn't told to the page as a failure.
/** @param {number} tabId @param {{ wake?: boolean, source?: string, carry?: 'hover' | 'toggle' | null, scroll?: number | null, deadline?: number, raise?: boolean, covered?: boolean, hurry?: (() => boolean) | null, loadWaited?: boolean, retry?: boolean }} [options] */
export async function focusTab(tabId, { wake = true, source = 'other', carry = null, scroll = null, deadline, raise = true, covered = false, hurry = null, loadWaited = false, retry = false } = {}) {
  focusing.set(tabId, (focusing.get(tabId) ?? 0) + 1);
  const gen = ++focusGen;
  // The page in front, if the switch covered it while its tab got ready: told how it went.
  /** @type {{ uncover: ((shown: boolean | null, reason?: string | null) => void) | null }} */
  const front = { uncover: null };
  try {
    const result = await focusTabNow(tabId, gen, { wake, source, carry, scroll, deadline, raise, covered, hurry, loadWaited }, front);
    front.uncover?.(result?.tab ? true : null);
    return result;
  } catch (err) {
    const gone = retry && /No tab with id/.test(String(err?.message ?? err));
    front.uncover?.(gone ? null : false, gone ? null : String(err?.message ?? err));
    throw err;
  } finally {
    // An activation of the tab left out after its introduction was answered
    // (the user's, or Safari's late): told if the tab is in front (Margin's
    // own update of it then made none).
    if (endIntroduction(tabId, gen)?.lateTab) void api.tabs.get(tabId).then((t) => t.active && hooks.activated?.({ tabId, windowId: t.windowId }), () => {});
    const left = (focusing.get(tabId) ?? 1) - 1;
    if (left > 0) focusing.set(tabId, left);
    else focusing.delete(tabId);
  }
}

// A restore or introduction of another switch's under way in the window, its
// updates not answered yet: waited for this long at most (below).
const UNDER_WAY_MS = 400;
// What showing a tab takes once it's ready (tabs.update: ~110 ms in Safari).
const SHOW_MS = 150;

async function focusTabNow(tabId, gen, { wake, source, carry, scroll, deadline, raise, covered, hurry, loadWaited }, front) {
  const asked = Date.now();
  const token = `${instanceId}:${gen}:${tabId}`;
  /** @type {Preparation} */
  const skipped = { outcome: 'skipped', ms: 0, token: null };
  // The tab as the browser has it now: whether it's still there, its window,
  // whether it's in front already (then there's nothing to wake or prepare).
  let live = await api.tabs.get(tabId).catch(() => null);
  // Another switch's restore or introduction in its window whose updates
  // Safari hasn't answered yet (a second click on the same row): its answer
  // first, so the tab isn't taken as one with no page, nor the window as busy.
  const under = live && wake ? introductions.get(live.windowId) : null;
  if (under && under.gen !== gen && !under.answered) {
    let timer;
    await Promise.race([under.done, new Promise((resolve) => { timer = setTimeout(resolve, UNDER_WAY_MS); })]);
    clearTimeout(timer);
    live = await api.tabs.get(tabId).catch(() => null);
  }
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
  // A page that may be cut off from Margin (background/cut-off.js: it was,
  // and was in use, or didn't answer when the open tabs were checked): loaded
  // again before it's shown if it's no longer in use, as its old copy would
  // show it under covers that never lift. Asked beside the rest, and waited
  // for only briefly before the show. (Any other is checked as it's shown:
  // ensureCurrent.)
  const cutting = cutOffSuspects.has(tabId) && !live.discarded ? repairCutOff(live, { ms: 400 }) : null;
  // Left in front by Safari (or brought there by the user meanwhile) while
  // being introduced or restored: shown, not prepared as a hidden page (it
  // would wait under its cover for a show that has happened).
  const inFront = async (/** @type {any} */ now, /** @type {Record<string, unknown>} */ how) => {
    if (gen !== focusGen) return { tab: null, preparation: skipped, superseded: true };
    recordSwitch({ source, tabId, asked, ...how, shownAfter: Date.now() - asked });
    if (raise) await focusWindow(now.windowId);
    return { tab: now, preparation: skipped };
  };
  // Not ready to show (restoreTab, above): a tab Safari unloaded (its wake
  // fails at once: no page) is loaded behind the page first; one never shown
  // and still loading is waited for. The page in front is covered meanwhile,
  // within the time the page that asked waits (none left: shown as it is). A
  // tab with a page is prepared beside its wake (one never shown, once
  // introduced: below).
  /** @type {Behind | null} */
  let behind = null;
  /** @type {Record<string, unknown>} */
  let how = {};
  /** @type {Promise<Preparation> | null} */
  let early = wake && !neverShown.has(tabId) ? prepareTabForShow(live, { token, carry, scroll, covered }) : null;
  /** @type {Wait} */
  const wait = { gen, since: asked, until: Math.min(asked + RESTORE_MAX_MS, (deadline ?? Infinity) - RESTORE_RESERVE_MS), hurry };
  const loading = !loadWaited && !!platform?.restoreTabs && neverShown.has(tabId) && live.status === 'loading';
  const restorable = async () => mayRestore(live) && !(await isOff()) && !(await areRestoresOff()) && (await wakeTab(tabId)).outcome === 'no page';
  if (wake && gen === focusGen && wait.until - Date.now() >= RESTORE_START_MS && (loading || (await restorable()))) {
    // Called off or hurried while that was asked (a wake can take a while
    // just after Safari started): the page in front isn't covered for it.
    if (gen !== focusGen) behind = 'left';
    else if (hurry?.()) behind = 'hurried';
    else {
      // Its window first: a tab in another window has its page covered where
      // the user sees it, not behind the window they're in.
      if (raise) await focusWindow(live.windowId);
      const cover = await coverFront(live, gen);
      front.uncover = cover.done;
      if (gen !== focusGen) behind = 'left';
      // Only with the page in front covered: one that isn't (a PDF, Safari's
      // own pages, a site Margin can't reach, an earlier copy of Margin)
      // would show nothing happening for the whole wait. Shown as before.
      else if (cover.covered) {
        early = null; // prepared once it has loaded
        behind = loading ? await waitLoaded(tabId, wait) : await restoreTab(live, wait);
      }
    }
    how = loading ? { loadWait: behind } : { restored: behind };
    if (behind === 'left' || behind === 'hurried') {
      recordSwitch({ source, tabId, asked, ...how, error: 'superseded' });
      return { tab: null, preparation: skipped, superseded: true, hurried: behind === 'hurried' };
    }
    const now = await api.tabs.get(tabId).catch(() => null);
    if (!now) {
      recordSwitch({ source, tabId, asked, ...how, error: 'no such tab' });
      throw new Error(`No tab with id ${tabId}`);
    }
    if (now.active) {
      // Left there by Safari as it was restored: loading in front, as an
      // unloaded tab shown, so its page is told which tab it is (below).
      if (behind === 'in front' && gen === focusGen) await noteShowing(now, { carry, scroll });
      return inFront(now, how);
    }
    live = now;
  }
  // Loaded behind just now (painted, loaded, or as far as it got by the time
  // limit; here, or by the caller: a new tab from the palette, openBehind):
  // introduced even if still loading (mayIntroduce), with a fresh wake (its
  // last one may say it had no page), and its page arrives covered, as the
  // page before is.
  const waited = loadWaited || behind === 'painted' || behind === 'loaded' || behind === 'loading';
  // Never in front yet: introduced first (introduceTab), once it has a page (a
  // tab Safari unloaded has none to introduce: it loads as it's shown). Its
  // wake's hold ends as it's shown for that instant: held afresh. So is a tab
  // whose page started visible and hasn't come into view from hidden since
  // (its wake says `unseen`).
  /** @type {boolean | null} */
  let introduced = null;
  // The token of the preparation that goes with the show (a new one once the
  // early one is called off: a late answer to that call can't be taken for it).
  let prepToken = token;
  if (wake && platform?.introduceTabs && gen === focusGen && !(await isOff())) {
    let tried = false;
    if (waited) {
      // Its wake renewed and its arrival cover asked for together, not one
      // after the other on a page busy with its start (the cover answering
      // proves the page is there); the cover is in place before the instant
      // it's introduced, so the paint that asks for is the cover's, quick.
      if (mayIntroduce(live, { loading: true })) {
        const [renewed, arrived] = await Promise.all([wakeTab(tabId, { renew: true }), coverArrival(live)]);
        if ((arrived || hasPage(renewed)) && gen === focusGen) {
          tried = true;
          introduced = await introduceTab(live, gen, { loading: true });
        }
      }
    } else {
      // A page there, awake or too busy to answer in time: one busy loading
      // times out, and shown without its introduction, two such tabs left
      // Safari's empty view (110 and 230 ms) in Tirth's log. Only 'no page'
      // means no page. (Usually the same wake as restorable()'s, reused.)
      const woke = await wakeTab(tabId);
      const unseen = !!woke.unseen && !neverShown.has(tabId);
      if (hasPage(woke) && mayIntroduce(live, { unseen }) && gen === focusGen) {
        if (unseen && early) {
          // It has painted on screen before (no arrival cover), but that
          // instant on screen would take a preparation (content/core.js
          // shown()): prepared after it, as a tab never shown is. The early
          // one, started beside the wake (its page answered that, so it's
          // done or nearly), is called off first, and again once it has
          // answered, should it land later (its token isn't the new one's).
          let timer;
          const stale = early;
          await Promise.race([stale, new Promise((resolve) => { timer = setTimeout(resolve, UNSEEN_PREPARED_MS); })]);
          clearTimeout(timer);
          cancelPreparation(tabId, { outcome: 'ready', ms: 0, token });
          void stale.then((late) => cancelPreparation(tabId, late));
          early = null;
          prepToken = `${token}:introduced`;
        }
        // Arriving covered: out of sight under its cover before that instant
        // (coverArrival), so the paint it asks for is the cover's, quick.
        if (covered && !unseen) await coverArrival(live);
        tried = true;
        introduced = await introduceTab(live, gen, { unseen });
        if (introduced && unseen) how = { ...how, unseen: true }; // in the switch log
      }
    }
    const now = tried && !introduced ? await api.tabs.get(tabId).catch(() => null) : null;
    if (now?.active) return inFront(now, { introduced, ...how });
  }
  // The preparation's time, within what the page that asked waits (less the
  // show's own): past that the switch would fail as too late. Less for a page
  // that has just loaded behind (PREPARE_LOADED_MS).
  const most = waited ? PREPARE_LOADED_MS : PREPARE_MAX_MS;
  const budget = () => (Number.isFinite(deadline) ? Math.max(0, Math.min(most, deadline - 250 - SHOW_MS - Date.now())) : most);
  // Which of the steps run together answered last: the paint barrier last
  // means the page has just drawn, and nothing else is waited for after it.
  let lastStep = '';
  /** @template T @param {string} name @param {Promise<T>} promise @returns {Promise<T>} */
  const step = (name, promise) => promise.then((value) => { lastStep = name; return value; });
  // Each paint barrier's answer and time, in the switch log: whether the page
  // drew, or the barrier ran to its limit (a page too busy, or held back).
  /** @type {{ how: string, ms: number }[]} */
  const barriers = [];
  const barrier = (/** @type {number} */ ms) => {
    const at = Date.now();
    return paintBarrier(live, ms).then((drawn) => {
      barriers.push({ how: drawn, ms: Date.now() - at });
      return drawn;
    });
  };
  // Run these together. Preparation itself wakes the isolated world, while
  // wakeTab's page-world hold keeps WebKit's layer tree attached through the
  // subsequent tabs.update. A tab just introduced: its page's paint for that
  // instant landed (paintBarrier), in place of a fixed wait.
  let [woke, preparation] = await Promise.all([
    wake ? step('wake', wakeTab(tabId, { renew: !!introduced || waited })) : null,
    step('preparation', early ?? (wake ? prepareTabForShow(live, { token: prepToken, carry, scroll, covered: covered || waited, budget: budget() }) : /** @type {Promise<Preparation>} */ (Promise.resolve(skipped)))),
    introduced ? step('barrier', barrier(BARRIER_MAX_MS)) : null,
  ]);
  // A page still running an earlier copy of Margin (it slept through an
  // update or a rebuild): the current copy goes in now, theme and all, and
  // is prepared in what's left of the wait, so the page doesn't show the old
  // copy's sidebar first.
  const left = () => PREPARE_MAX_MS - (Date.now() - asked);
  if (preparation.outcome === 'not ready' && preparation.reason === 'no current sidebar' && gen === focusGen && left() > 200) {
    lastStep = '';
    const added = await Promise.race([addCurrentCopy(live), new Promise((resolve) => setTimeout(() => resolve(false), Math.min(400, left() - 100)))]);
    if (added && gen === focusGen && left() > 50) preparation = await prepareTabForShow(live, { token: prepToken, carry, scroll, budget: Math.min(left(), budget()), covered: covered || waited });
  }
  if (cutting) {
    lastStep = '';
    let timer;
    await Promise.race([cutting, new Promise((resolve) => { timer = setTimeout(resolve, CUT_OFF_SWITCH_MS); })]);
    clearTimeout(timer);
  }
  // A tab restored, loading, or shown for the first time (or introduced): the
  // last thing before its show is its page drawing (paintBarrier), so the
  // show goes out in a gap of its main thread rather than behind a task (a
  // show whose paint comes after WebKit's 250 ms hold is Safari's empty view).
  const fragile = !!platform?.introduceTabs && wake && hasPage(woke) && (waited || !!introduced || neverShown.has(tabId));
  const barrierMs = Number.isFinite(deadline) ? Math.min(BARRIER_MAX_MS, deadline - 250 - SHOW_MS - Date.now()) : BARRIER_MAX_MS;
  if (fragile && lastStep !== 'barrier' && barrierMs > 0 && gen === focusGen) await barrier(barrierMs);
  if (barriers.length) how = { ...how, barrier: barriers };
  // Another switch was asked for while this one waited (back to the tab in
  // front, say): the latest wins.
  if (gen !== focusGen) {
    cancelPreparation(tabId, preparation);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, introduced, ...how, error: 'superseded' });
    return { tab: null, preparation, superseded: true };
  }
  // A timeout only bounds how long the old page stays covered. Stop the late
  // preparation before activating, otherwise it could finish over the live
  // destination and leave a token for some later switch to consume.
  if (preparation.outcome === 'timeout') cancelPreparation(tabId, preparation);
  if (Number.isFinite(deadline) && Date.now() > deadline - 250) {
    cancelPreparation(tabId, preparation);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, introduced, ...how, error: 'expired' });
    throw new Error('Too late: the page stopped waiting for this switch');
  }
  // A tab Safari unloaded (no page to wake or prepare): its page starts as
  // it's shown and draws Margin before its background has said which tab it
  // is; this says it (content/core.js `showing`).
  if (woke?.outcome === 'no page') await noteShowing(live, { carry, scroll });
  const fail = (err) => {
    cancelPreparation(tabId, preparation);
    forgetShowing(tabId);
    recordSwitch({ source, tabId, asked, wake: woke, preparation, introduced, ...how, error: String(err) });
    throw err;
  };
  const ended = endIntroduction(tabId, gen);
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
  recordSwitch({ source, tabId, asked, wake: woke, preparation, introduced, ...how, shownAfter: Date.now() - asked });
  if (ended?.lateTab) void hooks.activated?.({ tabId, windowId: live.windowId }); // as in focusTab
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
// first frame (content/core.js). Written by the copy that owns the state only
// (shared/owner.js).
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

// Tabs never in front since they opened (behind the page: a new tab from the
// palette, a ⌘-clicked link). Shown for the first time, such a tab can't keep
// the page before on screen while it paints (WebKit does that only for a
// view that has been in a window): it's introduced first (below), and
// arrives covered too (content/core.js arriveCovered). This background's own
// knowledge: a tab it didn't see open (before it started) is taken as shown
// before.
const neverShown = new Set();
export function tabOpened(tab) {
  if (!tab.active) neverShown.add(tab.id);
}
export function tabShown(tabId) {
  neverShown.delete(tabId);
  introduced.delete(tabId);
}
export const isNeverShown = (tabId) => neverShown.has(tabId);

// ---- a tab shown for the first time ------------------------------------------
// WebKit keeps the page before on screen while a tab paints only if the tab's
// view has been in a window before (WebPageProxy::dispatchActivityStateChange
// waits for its paint only then); otherwise it hides the tab's content until
// it has painted (hideContentUntilPendingUpdate): Safari's empty view, for a
// frame or more. So a tab never in front is introduced before Margin first
// shows it: brought to the front and the page in front straight back, two
// tabs.update sent together. Safari selects a tab as tabs.update asks
// (BrowserViewController activateForWebExtensionContext, synchronously), so
// both land in the same run loop turn, and the screen is drawn only once the
// turn is over: the tab has been in the window without reaching the screen.
// The page in front doesn't even notice (WebKit tells a page about its
// visibility at the end of the turn, unchanged by then). Shown once its page
// has drawn for that instant (paintBarrier), the tab is waited for. In the
// WebKit host, a heavy page from the palette's new tab: 16–21 ms of WebKit's
// empty view as it came up without this; with it (and arriving covered too:
// content/core.js arriveCovered) none in most runs, at most 2 ms in the others
// (a race inside WebKit). Only a tab whose page has loaded and has a page
// (awake, or too busy to answer its wake; one still loading its first page
// held the host's window up for 250 ms as it was shown, WebKit waiting for a
// paint; one Safari unloaded loads as it's shown).
// The same for a tab WebKit may never have seen come into the window while it
// had a process: the tab in front at a launch, or one Safari loaded as it was
// shown (its view went into the window before its process existed, and WebKit
// sets its "was in a window" mark only from a change it dispatches to a
// running process). Its first return showed Safari's empty view until it
// painted (four shows of 49–155 ms in Tirth's log; 40–87 ms in the host, none
// with an introduction first). Its page says so (pageThere: `unseen`, a page
// Safari made from the tab's saved history, or the first of a tab opened in
// front, that started visible and hasn't come into view from hidden since:
// content/core.js windowSeen). Not a page that navigated in front in a tab
// WebKit had seen (a link, the address bar): WebKit's mark stays with the
// tab's page, and introduced, such a return took 80 ms in the host against
// 10. A Back in front, or a tab opened in front whose page had a process
// already, is introduced once more than needed: an instant flip and a moment.
// Off for the rest of the Safari session (storage.session) if Safari leaves
// the tab in front instead, or the page in front was hidden for an instant
// (the two updates took two turns: pageBlinked).
const introduced = new Set(); // tabs introduced since they were last shown
const OFF_KEY = 'introductionsOff';
/** @type {Promise<boolean> | null} */
let off = null;
const isOff = () => (off ??= Promise.resolve(api.storage.session?.get(OFF_KEY)).then((stored) => !!stored?.[OFF_KEY], () => false));
let stoppedAt = 0; // when this background turned them off (a wait under way then stops: restoreTab)
function stopIntroductions(why) {
  off = Promise.resolve(true);
  stoppedAt = Date.now();
  console.warn(`[margin] ${why}: no more introductions until Safari restarts`);
  void Promise.resolve().then(() => api.storage.session?.set({ [OFF_KEY]: true })).catch(() => {});
}
// The two activations an introduction makes, per window, in order: not
// switches (background.js leaves them out), until the tab is really shown.
// Safari sends them as it brings each tab to the front, before it answers
// tabs.update; should they come later, they're still left out.
/** @typedef {{ tabId: number, windowId: number }} Activation */
/** @typedef {{ from: number, until: number }} Span when an introduction's updates were sent, and when it ended (its real switch sent, or over) */
/** @typedef {{ tabId: number, gen: number, frontId: number | null, frontMark: number, expected: number[], seen: Activation[], answered: boolean, lateTab: boolean, span: Span | null, done: Promise<void>, settled: () => void }} Introduction `done`: once Safari has answered its updates, or it's over */
/** @type {Map<number, Introduction>} */
const introductions = new Map();
/** @type {Map<number, Span>} */
const lastSpan = new Map(); // per window, its last introduction's
// background.js: `activated` handles an activation left out after all (Safari
// left the tab in front); `introduced` hears of a tab introduced (its hold, if
// keep-ready.js held it, ended as it was shown for that instant).
/** @type {{ activated: ((info: Activation) => unknown) | null, introduced: ((tabId: number) => unknown) | null }} */
let hooks = { activated: null, introduced: null };
/** @param {Partial<typeof hooks>} given */
export function setIntroductionHooks(given) {
  hooks = { ...hooks, ...given };
}
/** @param {Activation} info */
export function isIntroduction(info) {
  const pending = introductions.get(info.windowId);
  if (!pending?.expected.length) return false;
  if (pending.expected[0] !== info.tabId) {
    pending.expected = []; // something else came first: from here, as it comes
    return false;
  }
  pending.expected.shift();
  pending.seen.push(info);
  if (pending.answered && info.tabId === pending.tabId) pending.lateTab = true;
  // The page in front is back: a switch to it from here is the user's again.
  if (info.tabId === pending.frontId) unmark(pending.frontId, pending.frontMark);
  return true;
}
// The tab is being shown by the switch that introduced it (`gen`), or that
// switch is over: its activation from here is the real one. The one ended, if any.
function endIntroduction(tabId, gen) {
  for (const [windowId, pending] of introductions) {
    if (pending.tabId !== tabId || pending.gen !== gen) continue;
    introductions.delete(windowId);
    if (pending.span) pending.span.until = Math.min(pending.span.until, Date.now());
    pending.settled();
    return pending;
  }
  return null;
}
// One under way in the window (one a newer switch superseded, once Safari has
// answered it, doesn't count: it's only waiting to notice, and its events have come).
const windowBusy = (/** @type {number} */ windowId) => {
  const pending = introductions.get(windowId);
  return !!pending && !(pending.answered && pending.gen !== focusGen);
};
// `loading`: one still loading, after waiting for it (restoreTab, waitLoaded):
// introduced all the same (WebKit may then hold the window, the page before
// on it, up to 250 ms for its paint as it's shown, rather than show it empty).
// `unseen`: its wake says its page started visible and hasn't come into view
// from hidden since (above); once per tab until it's shown.
/** @param {any} tab the tab as the browser has it @param {{ loading?: boolean, unseen?: boolean }} [options] */
const mayIntroduce = (tab, { loading = false, unseen = false } = {}) => !!platform?.introduceTabs && (neverShown.has(tab.id) || unseen) && !introduced.has(tab.id) && (tab.status === 'complete' || loading) && !windowBusy(tab.windowId);
/**
 * Whether the tab was introduced. `gen`: the switch it's for (not if another
 * was asked for meanwhile). `loading`, `unseen`: as mayIntroduce's.
 * @param {any} tab @param {number} gen @param {{ loading?: boolean, unseen?: boolean }} [options] @returns {Promise<boolean>}
 */
async function introduceTab(tab, gen, { loading = false, unseen = false } = {}) {
  if ((await isOff()) || !mayIntroduce(tab, { loading, unseen })) return false;
  return forwardAndBack(tab, gen, () => introduced.add(tab.id));
}
// The tab to the front and the page in front straight back, in one run loop
// turn (above). Whether the page in front is back; `sending()` just before
// the updates go out.
/** @param {any} tab @param {number} gen @param {() => void} [sending] @returns {Promise<boolean>} */
async function forwardAndBack(tab, gen, sending = () => {}) {
  const windowId = tab.windowId;
  let settled = () => {};
  /** @type {Promise<void>} */
  const done = new Promise((resolve) => { settled = () => resolve(); });
  /** @type {Introduction} */
  const pending = { tabId: tab.id, gen, frontId: null, frontMark: 0, expected: [], seen: [], answered: false, lateTab: false, span: null, done, settled };
  introductions.set(windowId, pending); // one at a time per window
  const release = () => {
    if (introductions.get(windowId) === pending) introductions.delete(windowId);
    if (pending.span) pending.span.until = Math.min(pending.span.until, Date.now());
    settled();
  };
  // The page in front as Margin has it too: a switch Safari made that Margin
  // hasn't heard of yet (its event on its way) isn't undone.
  const known = Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active)?.id;
  const [front] = await api.tabs.query({ active: true, windowId }).catch(() => []);
  if (!front || front.id === tab.id || front.id !== known || gen !== focusGen) {
    release();
    return false;
  }
  Object.assign(pending, { frontId: front.id, expected: [tab.id, front.id] });
  sending();
  // Not the tab itself marked as Margin's activation: a switch (this one) is
  // under way for it (isFocusing), and once it's over, a switch to it is the
  // user's. The page in front is, until its activation is seen.
  pending.frontMark = activating(front.id);
  pending.span = { from: Date.now(), until: Infinity };
  lastSpan.set(windowId, pending.span);
  await Promise.allSettled([api.tabs.update(tab.id, { active: true }), api.tabs.update(front.id, { active: true })]);
  pending.answered = true;
  settled();
  void hooks.introduced?.(tab.id);
  if (pending.seen.some((info) => info.tabId === front.id)) return true; // both seen: the page is back
  const [now] = await api.tabs.query({ active: true, windowId }).catch(() => []);
  if (now?.id === front.id) return true; // back (its activation still on its way, or none)
  release();
  // Another tab in front: the user's switch, told as it came.
  const tabInFront = now ? now.id === tab.id : await api.tabs.get(tab.id).then((t) => t.active, () => false);
  if (!tabInFront) return false;
  // The tab left in front: its activation, left out, is told after all (as
  // Margin's own: the switch to it is under way, or was just superseded).
  activating(tab.id);
  for (const info of pending.seen) void hooks.activated?.(info);
  // Safari's doing, unless another switch was asked for meanwhile (it may
  // have brought the tab itself) or the page in front is gone.
  if (gen === focusGen && (await api.tabs.get(front.id).then(() => true, () => false))) stopIntroductions(`Safari didn't bring tab ${front.id} back after introducing tab ${tab.id}`);
  return false;
}
// For tests: on again, as after a Safari restart.
export function resetIntroductions() {
  off = null;
  stoppedAt = 0;
}
// The page in front was hidden for an instant during a switch (content:
// shared/switching.js onBlink; the page's clock is the background's). Hidden
// after an introduction's two updates went out in its window, and before its
// real switch did: the updates took two turns in this Safari. (The page dates
// it when it gets to it, late if it's busy; a real switch away and straight
// back hides it only once that real switch has gone out.)
const BLINK_SLACK_MS = 20;
/** @param {number | null | undefined} windowId @param {{ hiddenAt?: number, shownAt?: number }} [times] */
export function pageBlinked(windowId, { hiddenAt, shownAt } = {}) {
  const span = windowId == null ? null : lastSpan.get(windowId);
  if (!span || !Number.isFinite(hiddenAt) || !Number.isFinite(shownAt)) return;
  if (hiddenAt < span.from - BLINK_SLACK_MS || hiddenAt >= span.until) return;
  stopIntroductions('The page in front was hidden for an instant as a tab was introduced');
}

// ---- a tab not ready to show ---------------------------------------------------
// Safari brings its tabs back unloaded (after a relaunch only the tab in front
// of each window loads) and loads one as it's selected: BrowserWindowController
// didSelectTabViewItem → BrowserViewController beginPendingNavigation →
// _restorePendingState (its history, scroll and session storage as they were).
// Shown that way, the window was Safari's empty view, sidebar and all, until
// the page's document arrived: 150–280 ms of dark on each such tab in Tirth's
// recording (2026-10-29), each at the instant Safari's log has the tab's
// restoreFromSessionState. tabs.reload doesn't load it (BrowserViewController
// reload: canReload is false without a page), and tabs.update with its address
// would lose its history. Selecting it does, as tabs.update asks
// (activateForWebExtensionContext → select → didSelectTabViewItem, in the same
// turn), and the load goes on once another tab is selected (it starts in a
// completion block of the view controller's own, after its session storage is
// back: 60–90 ms later in Safari's log). So such a tab is restored behind the
// page: brought to the front and the page in front straight back
// (forwardAndBack), the page in front covered meanwhile (coverFront), until it
// has painted something of its own (its document parsed and its own content
// drawn: shared/page-ready.js) or loaded, at most READY_MAX_MS after its load
// started (a page that paints nothing by then is shown as far as it got, as
// Safari would show it), never past RESTORE_MAX_MS; then introduced
// (Safari puts its view in the window before it has a process, so WebKit
// doesn't count that instant: its log has "Not dispatching because there is no
// running process" for every restored tab) and shown, arriving covered. A tab
// never shown that's still loading (one restored behind and asked for again
// meanwhile, a ⌘-clicked link) is waited for the same way (waitLoaded).
// Waiting for its load event instead, at most 2.5 s, held back a median 2.3 s
// of page already painted in Tirth's log (11 such switches, 1.56–4.73 s from
// the first selection to the show; first non-empty layout a median 0.55 s in,
// the load a median 4.2 s, so most were shown still loading anyway).
// Safari can put off a selected tab's load until its selection update is over
// (BrowserWindowController _finishLoadingTab), and then loads the tab selected
// by then: none of this one. Its load not started within RESTORE_START_MS, the
// switch goes ahead as before; after RESTORE_MISSES such tabs in a row (counted
// in storage.session: the background can stop between them), no more tries for
// the Safari session. A key press after it (`hurry`) cuts the wait short.
const RESTORE_START_MS = 600;
const RESTORE_MAX_MS = 2000;
const READY_MAX_MS = 1500; // from its load's start to its show, at most, for a page that doesn't paint
const RESTORE_RESERVE_MS = 1500; // the page's wait left for the switch after it (introduction, preparation, tabs.update)
const RESTORE_POLL_MS = 40;
const RESTORE_BLINK_MS = 60; // a hide dated this late after the answers is still the restore's (a busy page dates it late)
const RESTORE_MISSES = 2;
const RESTORES_OFF_KEY = 'restoresOff';
const MISSES_KEY = 'restoreMisses';
/** @type {Promise<boolean> | null} */
let restoresOff = null;
/** @type {Promise<number> | null} */
let restoreMisses = null;
const areRestoresOff = () => (restoresOff ??= Promise.resolve(api.storage.session?.get(RESTORES_OFF_KEY)).then((stored) => !!stored?.[RESTORES_OFF_KEY], () => false));
const missesSoFar = () => (restoreMisses ??= Promise.resolve(api.storage.session?.get(MISSES_KEY)).then((stored) => Number(stored?.[MISSES_KEY]) || 0, () => 0));
// A tab Safari didn't load behind (`missed`), or one it did.
async function countMiss(missed, tabId) {
  const before = await missesSoFar();
  const misses = missed ? before + 1 : 0;
  if (misses === before) return;
  restoreMisses = Promise.resolve(misses);
  void Promise.resolve().then(() => api.storage.session?.set({ [MISSES_KEY]: misses })).catch(() => {});
  if (misses < RESTORE_MISSES) return;
  restoresOff = Promise.resolve(true);
  console.warn(`[margin] Safari didn't load tab ${tabId} behind the page: no more tabs restored behind the page until Safari restarts`);
  void Promise.resolve().then(() => api.storage.session?.set({ [RESTORES_OFF_KEY]: true })).catch(() => {});
}
// A page Margin may reach, at rest: Safari says an unloaded tab has loaded.
/** @param {any} tab the tab as the browser has it */
const mayRestore = (tab) => !!platform?.restoreTabs && !!api.scripting?.executeScript && !tab.active && tab.status === 'complete' && /^https?:/.test(tab.url ?? '') && !windowBusy(tab.windowId);
/** @typedef {'painted' | 'loaded' | 'loading' | 'not loaded' | 'in front' | 'left' | 'hurried' | 'gone'} Behind 'painted': its page has painted (still loading); 'loading': still, with nothing painted, at the time limit (or introductions just stopped); 'not loaded': Safari didn't load it behind; 'in front': Safari left it there; 'left': another switch; 'hurried': a key press after it */
/** @typedef {{ gen: number, since: number, until: number, hurry?: (() => boolean) | null }} Wait */
// Why a wait stops early, if it does: another switch, a key press after it,
// or introductions just turned off (the page in front blinked: it stopped
// covering itself, so the switch goes ahead now).
/** @param {Wait} wait @returns {'left' | 'hurried' | 'stopped' | null} */
const stopsWait = ({ gen, since, hurry }) => (gen !== focusGen ? 'left' : hurry?.() ? 'hurried' : stoppedAt >= since ? 'stopped' : null);
/**
 * A tab Safari unloaded, loaded behind the page in front. Null if it wasn't tried.
 * @param {any} tab @param {Wait} wait @returns {Promise<Behind | null>}
 */
async function restoreTab(tab, wait) {
  if ((await isOff()) || (await areRestoresOff()) || !mayRestore(tab)) return null;
  // Shown for the first time yet, from the moment it's selected: introduced
  // once loaded, and arriving covered, should this switch be called off
  // before its load is seen (Safari goes on loading it); its wake said it had no page.
  const selected = () => {
    neverShown.add(tab.id);
    wakes.delete(tab.id);
  };
  if (!(await forwardAndBack(tab, wait.gen, selected))) {
    const now = await api.tabs.get(tab.id).catch(() => null);
    return now?.active ? 'in front' : null;
  }
  // Its two activations are still left out while it loads (should they come
  // late); a blink dated from here on isn't this restore's.
  const span = introductions.get(tab.windowId)?.span;
  if (span) span.until = Math.min(span.until, Date.now() + RESTORE_BLINK_MS);
  try {
    const started = await loadStarted(tab.id, wait);
    if (started === 'gone' || started === 'left' || started === 'hurried') return started;
    if (started !== true) {
      // Not counted when cut short (introductions stopped): it may yet load.
      if (started === false) await countMiss(true, tab.id);
      return 'not loaded';
    }
    await countMiss(false, tab.id);
    wakes.delete(tab.id); // one since, from before its load, said it had no page
    return await waitLoaded(tab.id, wait, Date.now());
  } finally {
    // Its activation, should it have come after Safari's answer, is told if
    // it's in front after all.
    if (endIntroduction(tab.id, wait.gen)?.lateTab) void api.tabs.get(tab.id).then((t) => t.active && hooks.activated?.({ tabId: tab.id, windowId: t.windowId }), () => {});
  }
}
// Whether the tab's load has started: Safari says it's loading, or a script
// runs there (a page from its cache can be complete again by the next look).
/** @param {number} tabId @param {Wait} wait @returns {Promise<boolean | 'stopped' | 'left' | 'hurried' | 'gone'>} */
async function loadStarted(tabId, wait) {
  const until = Math.min(Date.now() + RESTORE_START_MS, wait.until);
  // Not waited for past `until`: a page too busy to answer by then has one (a
  // tab with none fails at once), so its load has started.
  const runs = () => {
    let timer;
    return Promise.race([
      api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: pageThere }).then(ranThere, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), Math.max(0, until - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
  };
  for (let tries = 0; ; tries++) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return 'gone';
    const stop = stopsWait(wait);
    if (stop) return stop;
    if (tab.status === 'loading' || (tries % 2 === 1 && (await runs()))) return stopsWait(wait) ?? true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS));
  }
}
// A tab loading behind, until it has painted or loaded (at most READY_MAX_MS
// from `startedAt`, when its load started; for a tab found loading, from now).
/** @param {number} tabId @param {Wait} wait @param {number} [startedAt] @returns {Promise<Behind>} */
async function waitLoaded(tabId, wait, startedAt = Date.now()) {
  const until = Math.min(wait.until, startedAt + READY_MAX_MS);
  let over = false;
  const painted = untilPainted(tabId, until, () => over || !!stopsWait(wait));
  const loaded = await untilLoaded(tabId, until, () => !!stopsWait(wait), null, painted).finally(() => { over = true; });
  if (loaded === 'left') {
    const stop = stopsWait(wait);
    return stop === 'stopped' ? 'loading' : stop ?? 'left';
  }
  return loaded === 'painted' || loaded === 'loaded' || loaded === 'gone' ? loaded : 'loading';
}
// Whether the tab's page has painted, or loaded (shared/page-ready.js): asked
// there every READY_RETRY_MS until the question reaches its own document
// (before its load commits, a script finds no page, an error in place of a
// result in Safari, or the empty page a tab starts with), then waited for.
// 'loaded' counts only once the tab says so too: a tab going from one page to
// another still has the old one's document, loaded, until the new one commits.
// Null if it can't tell by `until`, or `stopped()`: a page Margin may not run
// in, an address Safari doesn't give (no site access), a page that paints
// nothing (the tab's status still says when it has loaded: untilLoaded). Only
// where a page loading hidden paints (platform.hiddenPaints): Chrome waits
// for the load, as before.
const READY_RETRY_MS = 50;
/** @param {number} tabId @param {number} until @param {() => boolean} stopped @returns {Promise<'painted' | 'loaded' | null>} */
async function untilPainted(tabId, until, stopped) {
  if (!platform?.hiddenPaints || !api.scripting?.executeScript) return null;
  for (;;) {
    if (stopped() || Date.now() >= until) return null;
    const tab = await api.tabs.get(tabId).catch(() => null);
    const url = tab?.url || tab?.pendingUrl;
    if (!url || stopped() || (!/^about:/.test(url) && !(await mayAccessCached(url)))) return null;
    const ms = Math.max(0, until - Date.now());
    let timer;
    const how = await Promise.race([
      api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: readyInPage, args: [ms] }).then((rows) => rows?.[0]?.result ?? null, () => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); }),
    ]);
    clearTimeout(timer);
    if (how === 'painted' || (how === 'loaded' && tab.status === 'complete')) return how;
    if (how === 'timeout') return null;
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
  }
}
// The page in front of the tab's window, covered while the tab gets ready (a
// page covers itself for its own switch, not for the background's: a space,
// a closed tab, another window's tab), told when it's done (`done(shown)`).
// `covered`: the page said it is. The switch (`gen`) goes with each message,
// so the page settles only its own: an older switch to the same tab, called
// off, doesn't end a newer one's cover (shared/switching.js).
const COVER_ANSWER_MS = 200;
/** @param {any} tab @param {number} gen @returns {Promise<{ covered: boolean, done: (shown: boolean | null, reason?: string | null) => void }>} */
async function coverFront(tab, gen) {
  const [front] = await api.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
  if (!front || front.id === tab.id || gen !== focusGen) return { covered: false, done: () => {} };
  const switchId = `${instanceId}:${gen}`;
  let timer;
  const covered = await Promise.race([
    tellPage(front, { type: 'switching', tabId: tab.id, from: front.id, windowId: tab.windowId, cover: 'now', switchId }).then((answer) => answer === true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), COVER_ANSWER_MS); }),
  ]);
  clearTimeout(timer);
  return {
    covered: /** @type {boolean} */ (covered),
    done: (shown, reason = null) => void tellPage(front, { type: shown === false ? 'switch-failed' : 'switch-done', tabId: tab.id, from: front.id, switchId, ...(reason ? { reason } : {}) }),
  };
}
// For tests: on again, as after a Safari restart.
export function resetRestores() {
  restoresOff = null;
  restoreMisses = null;
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
// once the new page has painted or loaded (untilPainted, as for a tab
// restored behind; at most LOADED_MAX_MS, then as far as it got) it comes to
// the front, its sidebar prepared as for any switch. (It waited for the load
// event at first: a page shows long before that.) If the user
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
  let over = false;
  const painted = untilPainted(tab.id, until, () => over || left());
  const loaded = await untilLoaded(tab.id, until, left, from.id, painted).finally(() => { over = true; });
  // The wait itself, in the switch log (the switch after it has its own line).
  const ready = loaded === 'loaded' || loaded === 'painted';
  recordSwitch({ source: 'new tab loading', tabId: tab.id, asked, shownAfter: Date.now() - asked, ready: loaded, error: ready ? null : loaded });
  // Closed meanwhile, or the user went elsewhere (the page they were on
  // went somewhere else too): it stays where it is.
  if (loaded === 'gone' || loaded === 'moved') return notShown();
  if (loaded === 'left') return leftFor();
  try {
    const result = await focusTab(tab.id, { source: 'new tab', deadline: Math.min(asked + maxMs + FOCUS_MS, deadline ?? Infinity), raise: false, covered: true, loadWaited: true });
    if (!result?.tab) return result?.superseded ? leftFor() : notShown();
  } catch (err) {
    return notShown(String(err?.message ?? err));
  }
  void told('switch-done');
  return { tabId: tab.id, shown: tab.id };
}
// 'loaded' (complete at an address of its own, not the blank page a search
// starts from; or, an address Safari doesn't say without site access, once
// it was seen loading), 'painted' (`painted` says so first: untilPainted),
// 'timeout', 'gone' (closed), 'left' (`left()`) or 'moved' (the page the user
// is on, `fromId`, started loading something else: a link, the address bar, a
// reload). A question Safari doesn't answer counts as still loading.
/** @param {number} tabId @param {number} until @param {() => boolean} left @param {number | null} fromId @param {Promise<'painted' | 'loaded' | null> | null} [painted] @returns {Promise<'painted' | 'loaded' | 'timeout' | 'gone' | 'left' | 'moved'>} */
async function untilLoaded(tabId, until, left, fromId, painted = null) {
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
  /** @type {'painted' | 'loaded' | null} */
  let ready = null;
  // Settles once the page has painted (never, if it can't tell).
  const readyNow = painted?.then((how) => (how ? void (ready = how) : new Promise(() => {})));
  for (;;) {
    if (left()) return 'left';
    const [tab, from] = await Promise.all([ask(tabId), fromId != null ? ask(fromId) : null]);
    if (tab === SLOW) return left() ? 'left' : ready ?? 'timeout';
    if (!tab) return 'gone';
    if (left()) return 'left';
    if (from && from !== SLOW) {
      fromLoaded ??= from.status === 'complete';
      if (fromLoaded && from.status === 'loading') return 'moved';
      if (from.status === 'complete') fromLoaded = true;
    }
    if (tab.status === 'loading') sawLoading = true;
    if (tab.status === 'complete' && ((tab.url && tab.url !== 'about:blank') || (!tab.url && sawLoading))) return 'loaded';
    if (ready) return ready;
    if (Date.now() >= until) return 'timeout';
    const pause = new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, until - Date.now()))));
    await (readyNow ? Promise.race([pause, readyNow]) : pause);
  }
}

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
  if (await repairOldOwnPage(tab)) return void checkedCurrent.add(tabId);
  if (!files?.length || !tab?.url || tab.discarded) return;
  // Its world still bound to a copy that's gone (background/cut-off.js): no
  // copy can run there until it's loaded again.
  const cut = await repairCutOff(tab);
  if (cut === 'reloaded') checkedCurrent.add(tabId);
  if (cut) return;
  const here = await inPage(tabId, tab.url, () => !!globalThis.Margin?.content, [], 1000);
  if (typeof here === 'string') return; // asleep, no access or busy: next time
  checkedCurrent.add(tabId);
  if (here.result === true) return;
  console.info(`[margin] tab ${tabId} had no current copy of Margin: added`);
  await api.scripting.executeScript({ target: { tabId }, files }).catch(() => {});
}
export const forgetCurrent = (tabId) => {
  checkedCurrent.delete(tabId);
  boundHere.delete(tabId);
  cutOffSuspects.delete(tabId);
};

// ---- pages cut off from Margin (background/cut-off.js) -----------------------
// This copy's address, as a page's world bound to it says it.
const ownAddress = api.runtime.getURL('');
// Tabs whose page's world was found bound to this copy (or to another copy
// still running: background/cut-off.js): not asked again.
const boundHere = new Set();
// When each tab was last loaded again for that.
const CUT_OFF_COOLDOWN_MS = 30000;
const cutOffLoadedAt = new Map();
// Loaded again one after another, a little apart (every page open when
// Margin was reloaded can be cut off).
const CUT_OFF_GAP_MS = 150;
// How long a switch waits for that answer, at most, before the show.
const CUT_OFF_SWITCH_MS = 150;
const quietened = new Set(); // said once per tab
// Tabs that may be cut off: found so but in use (put out of sight), or
// silent when asked. A switch to one asks again first (focusTabNow).
const cutOffSuspects = new Set();
let cutOffLoads = Promise.resolve();
/** @param {number} tabId @param {boolean} quiet @param {number} ms */
async function askCutOff(tabId, url, quiet, ms) {
  const answer = await inPage(tabId, url, cutOffInPage, [ownAddress, quiet], ms);
  return typeof answer === 'string' ? null : answer.result ?? null;
}
// A tab whose page is cut off: loaded again ('reloaded') when nothing in it
// would be lost, else its dead Margin put out of sight ('quiet', asked again
// the next time it's checked). False when it isn't cut off (or didn't say).
// `ms`: how long the page is waited for.
/** @returns {Promise<'reloaded' | 'quiet' | false>} */
export async function repairCutOff(tab, { ms = 1000 } = {}) {
  if (tab?.id == null || tab.discarded || boundHere.has(tab.id) || !/^https?:/i.test(tab.url ?? '')) return false;
  const probe = await askCutOff(tab.id, tab.url, false, ms);
  const action = cutOffAction(probe);
  if (action === 'none') {
    if (probe) {
      boundHere.add(tab.id);
      cutOffSuspects.delete(tab.id);
    } else cutOffSuspects.add(tab.id);
    return false;
  }
  if (action === 'reload' && Date.now() - (cutOffLoadedAt.get(tab.id) ?? 0) >= CUT_OFF_COOLDOWN_MS) {
    cutOffLoadedAt.set(tab.id, Date.now());
    const load = cutOffLoads.then(async () => {
      // A GET of its address (a reload would send a form again); with a
      // #fragment, where that would only scroll, the browser's reload.
      const ok = await (tab.url.includes('#') ? api.tabs.reload(tab.id) : api.tabs.update(tab.id, { url: tab.url })).then(() => true, () => false);
      await new Promise((resolve) => setTimeout(resolve, CUT_OFF_GAP_MS));
      return ok;
    });
    cutOffLoads = load;
    if (await load) {
      cutOffSuspects.delete(tab.id);
      console.info(`[margin] tab ${tab.id} still had Margin from before it was reloaded: loaded again`);
      return 'reloaded';
    }
  }
  cutOffSuspects.add(tab.id);
  await askCutOff(tab.id, tab.url, true, ms);
  if (quietened.has(tab.id)) return 'quiet';
  quietened.add(tab.id);
  console.info(`[margin] tab ${tab.id} still has Margin from before it was reloaded, and is in use: its sidebar is put away until it's loaded again`);
  return 'quiet';
}
// A tab showing Margin's new-tab page from a copy that's gone (background/
// cut-off.js oldOwnPageAddress): sent to this copy's. Whether it was. A tab
// asleep is too (it'd load the old address, which no longer exists).
async function repairOldOwnPage(tab) {
  const to = oldOwnPageAddress(tab?.url, ownAddress);
  if (tab?.id == null || !to || Date.now() - (cutOffLoadedAt.get(tab.id) ?? 0) < CUT_OFF_COOLDOWN_MS) return false;
  cutOffLoadedAt.set(tab.id, Date.now());
  const ok = await api.tabs.update(tab.id, { url: to }).then(() => true, () => false);
  if (ok) console.info(`[margin] tab ${tab.id} still had the new-tab page of Margin from before it was reloaded: loaded again`);
  return ok;
}
// The current copy's core and its active theme, into a page that has neither
// (focusTabNow, before a switch to it). Whether they went in.
async function addCurrentCopy(tab) {
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript || !(await mayAccessCached(tab.url))) return false;
  const theme = themeFor(cached()?.settings).content;
  const ok = await api.scripting.executeScript({ target: { tabId: tab.id }, files: [...files, theme], injectImmediately: true }).then(ranAtAll, () => false);
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
  for (const node of /** @type {HTMLElement[]} */ ([...(document.documentElement?.children ?? []), ...(document.querySelector?.(':root > margin-app')?.children ?? [])])) {
    if (!/^margin-.*-host$/.test(node.localName)) continue;
    node.style.setProperty('display', 'none', 'important');
    node.style.setProperty('pointer-events', 'none', 'important');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('data-margin-off', ''); // what a host's own styles respect (shared/dom.js)
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
  // The sidebar's entry, whatever the build named its file.
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript) return;
  const delays = [0, ...(retry ? REPAIR_RETRY_MS : [])];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const tabs = await api.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map(async (tab) => {
      if (!checkedCurrent.has(tab.id) && await repairOldOwnPage(tab)) return void checkedCurrent.add(tab.id);
      if (tab.discarded || checkedCurrent.has(tab.id) || checking.has(tab.id) || !/^https?:/i.test(tab.url ?? '')) return;
      const cut = await repairCutOff(tab);
      if (cut === 'reloaded') checkedCurrent.add(tab.id);
      if (cut) return;
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
