// Showing, opening and reaching into tabs.
import * as M from '../state/model.js';
import { api, cached, isOwner, isSynced, mutate, now, openTabsAsked, stateRev, thisCopy } from './store.js';
import { recordRepair, recordSwitch } from './diagnostics.js';
import { hasNoPage, hiddenFor, isHeld, sessionKnown, switchFacts } from './keep-ready.js';
import { platform } from '../shared/platform.js';
import { getScroll } from './scroll.js';
import { themeFor } from '../themes/index.js';
import { cutOffAction, cutOffInPage, oldOwnPageAddress } from './cut-off.js';
import { readyInPage } from '../shared/page-ready.js';
import { noteCall, noteLag, ownSign, slowFacts, slowFoundAt, timed as timedCall, timersLate } from './slow.js';

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
// back, so the switch goes ahead then (a wake that says 'timeout' hasn't
// answered within WAKE_MAX_MS; a switch to a tab that may be suspended waits
// for its answer longer, the old page on screen: focusTabNow, mayWait).
// Waiting a fixed 70ms instead left 23 of 100 such switches black (Safari's
// log, 2026-10-26). A tab Safari unloaded has no page: the scripts fail at
// once and the switch doesn't wait (Safari loads the page as it's shown, or
// it's restored behind the page: restoreTab). The wake can start early (a
// press on a sidebar row, the palette resting on a row, the sidebar coming
// out: handlers.js prewake); the switch then picks up the same wake, already
// under way or done.
const WAKE_MAX_MS = 400;
// A wake started this recently still counts, answered or not (a press on a
// row, then its click); one whose page hasn't answered yet, until it has.
const WAKE_REUSE_MS = 600;
// One whose page answered (in time, or late once its process was resumed)
// counts for as long as the hold it placed runs, less what the switch that
// takes it over still needs held (wakeTab's `need`): by default this, for a
// switch whose preparation is bounded by PREPARE_AWAKE_MS (it holds the
// process itself while it's under way; then tabs.update, ~110 ms). Each wake
// that goes out is a script that resumes a process Safari suspended at
// background priority, and 65 of 114 in Tirth's log weren't followed by a
// show (2026-11-02): a switch soon after one, the key run's next tab woken
// ahead, a pointer resting on a row, takes the same wake on.
const HOLD_LEFT_MS = 400;
// A pointer resting on a sidebar row, a space's icon, or the sidebar coming
// out over the page (sidebar.js) holds its tab this long, once: nothing renews
// it, and nothing ends it as the pointer leaves. A held hidden process runs at
// foreground priority (about 18% of a core in Tirth's Safari), and until
// 2026-11-03 the sidebar renewed a row's hold every 1.5 s while the pointer
// stayed. A click after it has run out sends a fresh wake: a process still
// running answers in a few ms, one Safari has suspended again is waited for
// with the page before on screen (focusTabNow).
const HOVER_KEEP_AWAKE_MS = 2000;
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
// the 60 ms meant, before a page that saw the last write drew without reading
// storage first; 500 ms until 2026-11-02, and the step from its paint to its
// show took a median 1.2–1.4 s). One that misses it is shown unprepared: it
// has said hello by then, and draws its own tab.
const PREPARE_LOADED_MS = 300;
// A tab whose wake answered (its process running), not introduced: its
// preparation gets this long from that answer. The page draws from the state
// it has, without reading storage, when it saw the last
// write (content/core.js prepareForShow): a few ms after the script reaches
// it. One later than this is a page busy with its own work, or a read stuck
// behind a loaded Safari (11 of 45 such switches waited 529–1017 ms for it
// in Tirth's log): it's called off, and the page draws
// as it's shown, inside WebKit's hold, as with Safari's own tab bar.
const PREPARE_AWAKE_MS = 250;
// How long a tab about to be introduced waits for the preparation started
// beside its wake to land, at most, before calling it off (mayIntroduce's
// `unseen`).
const UNSEEN_PREPARED_MS = 150;
// What a switch whose preparation isn't bounded by PREPARE_AWAKE_MS still
// needs held (wakeTab's `need`): a whole preparation (a page with an earlier
// copy of Margin is given its current one and prepared again within it), then
// tabs.update.
const SWITCH_HOLD_MS = PREPARE_MAX_MS + 300;
// Long enough for a reused wake, the wait and tabs.update (~110ms in Safari)
// to land while the process is still kept awake: a wake WAKE_REUSE_MS old
// still has SWITCH_HOLD_MS to run.
const KEEP_AWAKE_MS = WAKE_REUSE_MS + SWITCH_HOLD_MS;

// New tabs being handed back (⌘T, handlers.js newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set();
// A ⌘T tab that stays after all (its page had no palette in time, it was
// used, Margin couldn't bring the page back: handlers.js handOff; it went
// somewhere: background.js): no longer handed off, and its activation, left
// out meanwhile, told now if it's still in front. Left out for good, the tab
// before it stayed the one in front by the activations: the next switch held
// that tab (likely suspended by then) and not this one (keep-ready.js
// frontChanged).
/** @param {number} tabId */
export function keepHandedOff(tabId) {
  if (!handingOff.delete(tabId)) return;
  void api.tabs.get(tabId).then((t) => t?.active && hooks.activated?.({ tabId, windowId: t.windowId }), () => {});
}

/** @typedef {'hover' | 'press' | 'reveal' | 'space' | 'keys' | 'switch'} WakeCause what started a wake: a pointer resting on a row (or the palette on one), a press on a row or a space's icon, the sidebar coming out, a space's icon or a swipe toward it, a key run's tab woken ahead, the switch itself */
/** @typedef {{ outcome: 'awake' | 'no page' | 'timeout' | 'shown' | 'gone' | 'no access', ms: number, startedAt: number, by?: WakeCause, unseen?: boolean, seen?: boolean }} Wake `unseen`: its page started visible and hasn't come into view from hidden since (pageThere); `seen`: its page has come into view from hidden (pageThere); `by`: what started it (DEVELOPMENT DIAGNOSTICS) */
// `sent`: when its scripts went out (after the permission check, slow while
// Safari starts), null if none did (nothing to wake): how long the page has
// taken to answer is counted from then (resumedBehind). `pending`: its
// scripts went out and its page hasn't answered yet (held up behind a resume,
// past WAKE_MAX_MS too); kept until it has. `answer`: its page's own answer,
// however late (`done` says 'timeout' past WAKE_MAX_MS), and `settled` once
// it's there: a wake taken on after that says it, not the timeout.
// `holdUntil`: once its page answered, when the hold it placed ends at the
// earliest. The hold's own clock starts as it reaches the page: at its resume
// for a process Safari suspended, just before its answer (keepAwake goes out
// first). So one that came late counts from that answer, less RESUMED_MS
// (counted from `at`, a switch that waited for a late answer sent a second
// wake once it came, and waited up to WAKE_MAX_MS more for it, out of the
// time its page had to draw). `by`: what started it.
/** @typedef {{ at: number, done: Promise<Wake>, answer: Promise<Wake>, settled: Wake | null, sent: Promise<number | null>, pending: boolean, holdUntil: number, by: WakeCause }} WakeEntry */
/** @type {Map<number, WakeEntry>} */
const wakes = new Map();
// `renew`: a fresh wake even if one is recent (a tab whose hold ended as it
// was shown for an instant). `hover`: the sidebar's hold (HOVER_KEEP_AWAKE_MS).
// `need`: how long the caller still needs the process held, at most
// SWITCH_HOLD_MS: a wake taken on has that left of its hold. `by`: what
// starts it (the switch log); one taken on keeps its own.
/** @param {number} tabId @param {{ renew?: boolean, hover?: boolean, need?: number, by?: WakeCause }} [options] @returns {Promise<Wake>} */
export function wakeTab(tabId, { renew = false, hover = false, need = HOLD_LEFT_MS, by = 'switch' } = {}) {
  const recent = wakes.get(tabId);
  const t = Date.now();
  // Taken on: one recent, one whose hold runs long enough, or one whose page
  // hasn't answered yet (held up behind a resume: a second wake would only
  // queue behind it).
  if (recent && !renew && (recent.pending || t - recent.at < WAKE_REUSE_MS || t < recent.holdUntil - need)) return recent.settled ? Promise.resolve(recent.settled) : recent.done;
  const at = t;
  const holdMs = hover ? HOVER_KEEP_AWAKE_MS : KEEP_AWAKE_MS;
  /** @type {(when: number | null) => void} */
  let sending = () => {};
  /** @type {Promise<number | null>} */
  const sent = new Promise((resolve) => { sending = resolve; });
  /** @type {(woke: Wake) => void} */
  let settle = () => {};
  /** @type {(error: unknown) => void} */
  let fail = () => {};
  /** @type {Promise<Wake>} */
  const answer = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  /** @type {WakeEntry} */
  const entry = { at, done: /** @type {any} */ (null), answer, settled: null, sent, pending: false, holdUntil: 0, by };
  // Its page's answer, however late: a wake that found it awake counts for as
  // long as its hold runs; one that no longer counts by then is forgotten.
  // `resumed`: it came past RESUMED_MS, its process resumed just then
  // (resumedBehind), marked only while the wake still counts: one whose tab
  // was shown meanwhile (a switch that stopped waiting for it) is in the
  // window, and drawn for that.
  const answered = (/** @type {Wake} */ woke, resumed = false) => {
    entry.pending = false;
    entry.settled = woke;
    if (wakes.get(tabId) === entry) {
      if (woke.outcome === 'awake') {
        entry.holdUntil = Math.max(entry.holdUntil, Math.max(at, Date.now() - RESUMED_MS) + holdMs);
        if (resumed) resumedBehind.add(tabId); // (drawn before it's shown: focusTabNow)
      }
      if (Date.now() >= wakeEnd(entry)) wakes.delete(tabId);
      else forgetLater(tabId, entry);
    }
    settle(woke);
  };
  const done = startWake(tabId, at, holdMs, by, () => { entry.pending = true; sending(Date.now()); }, answered);
  entry.done = done;
  void done.then(() => sending(null), () => sending(null)); // (no-op once sent)
  // A wake that fails before its scripts go out (its permission check
  // throws): its answer fails with it, and so does a switch waiting for it.
  void done.catch(fail);
  wakes.set(tabId, entry);
  forgetLater(tabId, entry);
  return done;
}
// The page's own answer to the tab's wake under way (or its last one, while
// it counts), however late; null if there's none.
/** @param {number} tabId @returns {Promise<Wake> | null} */
const wakeAnswer = (tabId) => wakes.get(tabId)?.answer ?? null;
// Until when a wake counts (and some, for a switch already holding it).
/** @param {WakeEntry} entry */
const wakeEnd = (entry) => Math.max(entry.at + WAKE_REUSE_MS + WAKE_MAX_MS, entry.holdUntil);
// Forgotten once it no longer counts, and its page has answered (or then).
/** @param {number} tabId @param {WakeEntry} entry */
function forgetLater(tabId, entry) {
  const end = wakeEnd(entry);
  setTimeout(() => {
    if (wakes.get(tabId) === entry && !entry.pending && wakeEnd(entry) <= end) wakes.delete(tabId);
  }, Math.max(0, end - Date.now()));
}
// Its hold over (the tab shown: keepAwake ends then; its page going away):
// a wake there no longer counts.
/** @param {number} tabId */
export function forgetWake(tabId) {
  wakes.delete(tabId);
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
// It keeps the process at foreground priority while it runs: a wake's short
// hold (the switch is about to show the tab); keep-ready's only where Margin's
// page there doesn't answer its message (holdTab).
// `key`: a hold keep-ready.js placed also ends when releaseInPage names it
// (the tab no longer kept ready), not only at its end. Each hold has a key of
// its own, a random one, so a release never ends a newer hold than it means,
// whatever order the scripts land in, and the page sees nothing it could tell
// Margin's copy or another site by. A page that dispatches the event itself
// only ends that hold early.
/** @param {number} ms @param {string | null} [key] */
export async function keepAwake(ms, key = null) {
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
      for (const type of ['pagehide', 'pageswap', ...(typeof key === 'string' ? [`margin-release:${key}`] : [])]) {
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

// The hold alone, sent again with the tab's wake standing: a kick (focusTabNow)
// showed the tab for an instant, which ends a hold that had reached its page
// (keepAwake ends as it's shown). Its wake's own answer still says the page is
// there (one waiting behind the resume the kick started comes first anyway).
/** @param {number} tabId */
function holdAgain(tabId) {
  api.scripting?.executeScript?.({ target: { tabId }, world: 'MAIN', injectImmediately: true, func: keepAwake, args: [KEEP_AWAKE_MS] }).catch(() => {});
}

// `holdMs`: how long its hold runs. `by`: what started it. `sent`: as its
// scripts go out; `answered(wake, resumed)`: with its page's answer to them (or
// their failure, or nothing to wake), past WAKE_MAX_MS too; `resumed` if it
// came past RESUMED_MS.
/** @param {number} tabId @param {number} at @param {number} holdMs @param {WakeCause} by @param {() => void} sent @param {(woke: Wake, resumed?: boolean) => void} answered @returns {Promise<Wake>} */
async function startWake(tabId, at, holdMs, by, sent, answered) {
  const result = (/** @type {Wake['outcome'] | 'unseen' | 'seen'} */ outcome) => /** @type {Wake} */ ({ outcome: outcome === 'unseen' || outcome === 'seen' ? 'awake' : outcome, ms: Date.now() - at, startedAt: at, by, ...(outcome === 'unseen' ? { unseen: true } : outcome === 'seen' ? { seen: true } : {}) });
  const now = (/** @type {Wake['outcome']} */ outcome) => {
    const woke = result(outcome);
    answered(woke);
    return woke;
  };
  // Only Safari blanks a suspended tab (Chrome keeps its last frame).
  if (!platform?.wakeTabs || !api.scripting?.executeScript) return now('no access');
  // What Margin knows of the tab, if its state is loaded (no round trip to
  // the browser before the wake: every one delays the switch); the
  // browser's answer otherwise. 'shown' (nothing to do) only as the browser
  // says: Margin's flag can be a moment behind.
  const tab = cached()?.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  if (!tab) return now('gone');
  if (tab.active) {
    const live = await api.tabs.get(tabId).catch(() => null);
    if (!live) return now('gone');
    if (live.active) return now('shown');
  }
  // Right away, not once the page has loaded (Chrome's default; WebKit
  // ignores the key and runs it right away anyway). The permission check
  // counts toward the wait too (it can be slow while Safari starts).
  const target = { tabId };
  let resumed = false;
  const ran = (async () => {
    if (!(await mayAccessCached(tab.url))) return 'no access';
    sent();
    const sentAt = Date.now();
    api.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, func: keepAwake, args: [holdMs] }).catch(() => {});
    // (A script that finds no page fails within milliseconds: one that takes
    // longer is Safari slow, slow.js. A page's own answer can be slow for
    // its own reasons: a process resumed at background priority.)
    const noPage = () => {
      noteCall('a script finding no page', Date.now() - sentAt, tabId);
      lose(tabId, 'no page'); // Safari unloaded it: a new web view as it's shown or restored
      return 'no page';
    };
    return api.scripting.executeScript({ target, injectImmediately: true, func: pageThere }).then((rows) => {
      if (!ranThere(rows)) return noPage();
      resumed = Date.now() - sentAt > RESUMED_MS;
      return rows[0].result === 'unseen' || rows[0].result === 'seen' ? rows[0].result : 'awake';
    }, noPage);
  })();
  void ran.then((outcome) => {
    if (outcome === 'seen') sawInWindow(tabId);
    else if (outcome === 'unseen') doubt(tabId, 'started unseen');
    answered(result(outcome), resumed);
  }, () => {});
  let timer;
  const outcome = await Promise.race([ran, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), WAKE_MAX_MS); })]);
  clearTimeout(timer);
  return result(/** @type {Wake['outcome'] | 'unseen' | 'seen'} */ (outcome));
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
// process: not marked, whatever Margin knew (WebKit's mark, doubt). A page
// with an earlier copy (its world isn't this one) says neither. 'seen': the
// page has come into view from hidden itself (content/core.js cameIntoView):
// its tab coming into the window only where Margin knows it was out of it
// during that page's life (sawInWindow: a page in front also goes hidden and
// comes back as its window is covered and uncovered, minimized, or on another
// Space, and WebKit marks a tab only as it enters a window).
export const pageThere = () => {
  if (/^about:/.test(location.href)) return false;
  try {
    const content = globalThis.Margin?.content;
    return content?.windowSeen?.() === false ? 'unseen' : content?.cameIntoView?.() === true ? 'seen' : true;
  } catch {
    return true;
  }
};
/** @param {any} rows executeScript's answer */
const ranThere = (rows) => rows?.[0]?.result === true || rows?.[0]?.result === 'unseen' || rows?.[0]?.result === 'seen';
/** @param {any} rows executeScript's answer, for a script that returns nothing */
const ranAtAll = (rows) => !(Array.isArray(rows) && rows.some((row) => row?.error));
// A wake that found a page there: awake, or too busy to answer in time.
/** @param {Wake | null | undefined} woke */
const hasPage = (woke) => woke?.outcome === 'awake' || woke?.outcome === 'timeout';

// Keeps a hidden tab's process running for `ms`, without waiting for it:
// background/keep-ready.js. A message to Margin's page there, answered only
// once the hold is over (content/hold.js): WebKit keeps the process running
// meanwhile at background priority, not at the foreground priority of a
// script left running (keepAwake, the hold until 2026-11-03: about 22% of a
// core per held tab in Tirth's Safari). A message also costs one round trip,
// where a script first asks for each of the page's frames. A page with no
// listener of this copy's (Margin's script from before an update, still in
// the page) answers at once with nothing, or fails: held the old way then, by
// keepAwake, for what's left of the time. Not once the message has waited
// HOLD_ANSWER_MS (a hold that ran, then failed with its page: a crash).
// False if it can't be held (no page: Safari unloaded it, and a hold doesn't
// load it; no access to the site). Answers once the hold is over. `key`:
// what releaseTab names it by. `sending`, just before the hold goes out
// (after the round trips above): false calls it off (released meanwhile),
// and the answer is false.
const HOLD_ANSWER_MS = 2000;
/** @param {number} tabId @param {number} ms @param {string | null} [key] @param {(() => boolean) | null} [sending] @returns {Promise<boolean>} */
export async function holdTab(tabId, ms, key = null, sending = null) {
  if (!platform?.wakeTabs || !api.scripting?.executeScript) return false;
  const tab = cached()?.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  if (!tab || !(await mayAccessCached(tab.url))) return false;
  if (sending && !sending()) return false;
  const byScript = (/** @type {number} */ left) => api.scripting.executeScript({ target: { tabId }, world: 'MAIN', injectImmediately: true, func: keepAwake, args: [left, key] }).then(ranAtAll, () => false);
  if (key == null || !api.tabs?.sendMessage) return byScript(ms);
  const sentAt = Date.now();
  const answer = await Promise.resolve().then(() => api.tabs.sendMessage(tabId, { type: HOLD_MESSAGE, key, ms })).catch(() => null);
  if (answer?.held === true) return true;
  const waited = Date.now() - sentAt;
  return waited < HOLD_ANSWER_MS && waited < ms ? byScript(ms - waited) : false;
}
// What content/hold.js listens for (it can't be imported here: the
// background bundle would take in the page's code).
const HOLD_MESSAGE = 'margin-hold';
const RELEASE_MESSAGE = 'margin-release';
// The holds `keys` names end now, not at their end (keep-ready.js: the tab
// is no longer one of those kept ready): WebKit lets the process go as the
// message is answered. A message to Margin's page (content/hold.js), which
// also ends one placed the old way (keepAwake: a page with Margin's script
// from before); if nothing there answers it, a script in the page's own world
// ends those (releaseInPage). The wakes' own holds aren't named (they have no
// key) and run on. Not while a switch to the tab is under way (it's shown in
// a moment, which ends them): false then, and nothing is sent. The process
// is running (held), so either is quick.
/** @param {number} tabId @param {string[]} keys @returns {boolean} */
export function releaseTab(tabId, keys) {
  if (isFocusing(tabId)) return false;
  if (!keys.length || !platform?.wakeTabs || !api.scripting?.executeScript) return true;
  const byScript = () => api.scripting.executeScript({ target: { tabId }, world: 'MAIN', injectImmediately: true, func: releaseInPage, args: [keys] }).catch(() => {});
  if (!api.tabs?.sendMessage) {
    void byScript();
    return true;
  }
  void Promise.resolve().then(() => api.tabs.sendMessage(tabId, { type: RELEASE_MESSAGE, keys })).then((answer) => answer === true || byScript(), byScript);
  return true;
}
// In the page's own world, as keepAwake. Self-contained.
/** @param {string[]} keys */
export function releaseInPage(keys) {
  for (const key of keys) {
    try { dispatchEvent(new Event(`margin-release:${key}`)); } catch {}
  }
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

export function cancelSidebarInPage(token, keepCover = false) {
  try {
    return globalThis.Margin?.content?.cancelPreparedShow?.(token, { keepCover }) ?? false;
  } catch {
    return false;
  }
}

/** @typedef {{ outcome: 'ready' | 'not ready' | 'unavailable' | 'timeout' | 'skipped', ms: number, reason?: string, token: string | null, timings?: Record<string, number> | null }} Preparation `timings`: DEVELOPMENT DIAGNOSTICS, where the page's time went (content/core.js prepareForShow) */

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
      // `rev`: the state's last write (store.js stateRev), as the script goes
      // out: a page that saw it draws without reading storage.
      // `sentAt`: DEVELOPMENT DIAGNOSTICS (the page's `timings`, in the switch log).
      args: [{ token, tabId: tab.id, windowId: tab.windowId, scroll: top, carry, covered, until: at + budget, rev: stateRev(), sentAt: Date.now() }],
    }).then((rows) => {
      const answer = rows?.[0]?.result;
      return answer?.ready ? { ...result('ready'), timings: answer.timings ?? null } : result('not ready', answer?.reason ?? 'no answer');
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
// which WebKit may throttle: the background bounds it too. It ends when the
// page goes away (pagehide, pageswap): its timer would die with the page, and
// WebKit keep the tab's process awake for it (keepAwake, above).
/** @param {number} ms @returns {Promise<'drawn' | 'timeout' | 'none'>} */
export function paintBarrierInPage(ms) {
  return new Promise((resolve) => {
    /** @type {ResizeObserver | null} */
    let observer = null;
    /** @type {MessageChannel | null} */
    let channel = null;
    let timer = null;
    let over = false;
    const gone = () => done('none');
    const done = (/** @type {'drawn' | 'timeout' | 'none'} */ how) => {
      if (over) return;
      over = true;
      try { observer?.disconnect(); } catch {}
      try { channel?.port1.close(); } catch {}
      clearTimeout(timer);
      for (const type of ['pagehide', 'pageswap']) try { removeEventListener(type, gone); } catch {}
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
    for (const type of ['pagehide', 'pageswap']) try { addEventListener(type, gone); } catch {}
    try {
      observe(2);
    } catch {
      done('none');
    }
  });
}
const BARRIER_MAX_MS = 400; // a page too busy to draw by then is shown as it is
// The same for a tab kicked awake (focusTabNow), 150 ms with the answer's way
// back (paintBarrier): its page has drawn in the window for the kick (WebKit
// holds the kick's first update for that paint, up to 250 ms: `kickMs`), so
// its content isn't hidden any more as a suspended page's is. A tab resumed
// behind (its process resumed by a script, never in the window since) keeps
// BARRIER_MAX_MS: its content stays hidden until it draws, and that's the
// case measured (2026-11-03: 23 of 68 such switches ran the barrier to its
// 400 ms limit, about 520 ms with the timers late, and none was dark; shown
// with no barrier on 2026-11-02, such tabs were Safari's empty view for
// 141–360 ms). Nothing measured a shorter limit there.
const BARRIER_KICKED_MS = 130;
// A barrier that ran to its limit with a flip of the tab's own still to be
// drawn for (hidePending) is followed by one more while the switch's plan
// leaves this much (focusTabNow).
const BARRIER_RETRY_MIN_MS = 50;
// How much longer than its first barrier's limit such a switch waits for its
// tab's page to draw ("a bit longer" under the cover: T2, 2026-11-03), in one
// barrier (each needs two rendering updates of its own).
const LAYERS_EXTRA_MS = 600;
// A switch with no page waiting for it (a key, a command): its tab's drawing
// waited for this long from the ask at most.
const LAYERS_MAX_MS = 3000;
// The tab's content hidden by a flip of its own (an introduction, a kick, a
// restore: WebKit hides a view's content each time it comes into a window,
// until its page's next commit, 72–237 ms after the flip in Safari's log of
// 2026-11-03): its show waits for a paint of its page that started after
// the flip (focusTabNow `fragile`), for FLIP_HIDE_MS after it (by then its
// page has drawn, or its process was suspended since: a wake that resumes it
// says so).
const FLIP_HIDE_MS = 1000;
/** @type {Map<number, number>} */
const flippedAt = new Map(); // tabId → when Safari answered its last flip
/** @type {Map<number, number>} */
const drawnAfter = new Map(); // tabId → when its last paint barrier that drew started
/** @param {number} tabId @param {number} at */
const drewSince = (tabId, at) => void drawnAfter.set(tabId, Math.max(drawnAfter.get(tabId) ?? -Infinity, at));
/** @param {number} tabId */
const hidePending = (tabId) => {
  const at = flippedAt.get(tabId);
  return at != null && Date.now() - at < FLIP_HIDE_MS && (drawnAfter.get(tabId) ?? -Infinity) < at;
};
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

/** @param {number} tabId @param {Preparation | null | undefined} preparation @param {{ keepCover?: boolean }} [options] */
function cancelPreparation(tabId, preparation, { keepCover = false } = {}) {
  if (!preparation?.token || preparation.outcome === 'skipped' || !api.scripting?.executeScript) return;
  api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: cancelSidebarInPage, args: keepCover ? [preparation.token, true] : [preparation.token] }).catch(() => {});
}

// Activate a tab, and focus its window only if it isn't already: re-focusing
// the current window can move keyboard focus out of the page in Safari.
// `wake: false` for a tab that was shown a moment ago (nothing to wake).
// `source`: what asked, for the switch log (background/diagnostics.js).
let focusGen = 0;
const focusing = new Map(); // tabId → overlapping Margin focus requests
export const isFocusing = (tabId) => (focusing.get(tabId) ?? 0) > 0;
export const anyFocusing = () => focusing.size > 0;
// Switches a page asked for and hasn't been answered yet (background.js
// counts each timed request from its arrival: before focusTab, the first
// sync, the tab's lookup), or that focusTab hasn't answered yet: startup work
// that asks Safari for much waits until there are none (runOpenTabRepair
// giveWay). Each counts for SWITCH_HOLDS_MS at most, and focusTab's until it
// answers, not until its steps are over: one whose steps still wait on a
// Safari call that doesn't answer (it's shown as it is at its page's
// deadline) held the repair up for 8 s before every tab.
/** @type {Set<{ at: number }>} */
const switchesAsked = new Set();
const SWITCH_HOLDS_MS = 8000; // a switch is over within its page's 7 s
/** background.js, focusTab: a switch asked for; the function returned says it's answered. */
export function switchAsked() {
  const entry = { at: Date.now() };
  switchesAsked.add(entry);
  return () => void switchesAsked.delete(entry);
}
const switchUnderWay = () => {
  for (const entry of switchesAsked) {
    if (Date.now() - entry.at < SWITCH_HOLDS_MS) return true;
    switchesAsked.delete(entry);
  }
  return false;
};
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
  if (tabId != null && (isFocusing(tabId) || unanswered.has(tabId) || Date.now() - (activatedByMargin.get(tabId) ?? 0) < OWN_ACTIVATION_MS)) return;
  focusGen++;
  movedOn(windowId);
}

// ---- every switch answers its page in time ---------------------------------------
// A page that asks for a switch waits for the answer until its `deadline` (7 s:
// content/core.js), then says the switch didn't happen. Each of the switch's
// own waits is capped (focusTabNow), but Safari's calls (tabs.get, tabs.query,
// tabs.update, windows.*) aren't, and one can wait on a tab's hung process: on
// 2026-11-03, just after a reboot and a Safari relaunch (load average about
// 50, every tab unloaded), a restore's introduction went out 7.33 s after its
// switch began, 14 ms before the tab's process answered again, and the switch
// was dropped as too late, its answer after the page had stopped waiting (and
// the page then said Margin wasn't responding). So the whole run is held to
// the deadline here, whatever Safari does: a switch not shown FORCE_SHOW_MS
// before it is shown as it is (its own steps stand down, as for another
// switch: no flip or show of theirs goes out after), and focusTab answers
// ANSWER_BY_MS before it at the latest (a show that went out and isn't
// answered yet is taken as made: Safari carries it out). The page's answer
// doesn't wait on another tab's script or message past that. A switch asked
// with less than REFUSE_MS left doesn't start (it would land after its page
// said it didn't). Its own steps plan to have shown the tab SHOW_BEFORE_MS
// before the deadline (the budgets in focusTabNow).
// (The answer's own way back to the page, and timers that fire late in a
// background Safari runs at low priority: about 100 ms late in the WebKit
// host at a load average of 3, more on a Mac as loaded as Tirth's was.)
const SHOW_BEFORE_MS = 1800;
const FORCE_SHOW_MS = 1500;
const ANSWER_BY_MS = 800;
const REFUSE_MS = 1000;
// A timed switch that finds Safari or the Mac slow (slow.js: slow as it's
// asked, or its own Safari calls slow on its way) plans to show its tab
// SLOW_SHOW_MS after the ask (a restore behind the page ends by
// SLOW_RESTORE_MS: shown as far as it got, loading if it must, as plain
// Safari would), and focusTab shows it as it is by SLOW_FORCE_MS: after a
// reboot (2026-11-03) restores waited their full limits behind Safari calls
// taking 2–3 s each, and tabs came up 3–7 s after the click, at a stuck step,
// often before they had drawn. Found slow only on its way, those count from
// SLOW_SINCE_MS before then, not from the ask: a step under way isn't cut off
// the moment it's found. A show forced out of time with Safari slow is
// answered once it's out, FORCED_ANSWER_MS for Safari's answer at most; with
// Safari quick, or a tab Safari hasn't said is there, its answer is waited
// for until ANSWER_BY_MS before the deadline, as before (a tab gone fails).
const SLOW_SHOW_MS = 1500;
const SLOW_RESTORE_MS = 1100;
const SLOW_FORCE_MS = 2000;
const SLOW_SINCE_MS = 700;
const FORCE_POLL_MS = 100;
const FORCED_ANSWER_MS = 250;
const TOO_LATE = 'Too late: the page stopped waiting for this switch';
// Nothing that can't be taken back (a tab opened) within REFUSE_MS of the
// page's deadline: it would come after its page was told it didn't happen.
/** @param {number | undefined} deadline */
function tooLate(deadline) {
  if (Number.isFinite(deadline) && Date.now() > /** @type {number} */ (deadline) - REFUSE_MS) throw new Error(TOO_LATE);
}
// A show answered to its page before Safari had answered it (focusTab:
// `unconfirmed`) is carried out whenever Safari gets to it, and if its tab's
// process hung, Safari may hold that update alone while it carries out a
// newer switch (the user's, or Margin's): the tab would then jump back in
// front of the one the user went to since. So once it's answered, if the
// window's activations since it went out (sawActivation) include another
// tab, and this one is in front, the last of those is brought back. Until
// then, its activation isn't taken as the user's (userSwitched: it would call
// off a switch under way), for UNANSWERED_MS at most.
const UNANSWERED_MS = 10_000;
const RECENT_ACTIVATIONS = 8;
/** @type {Map<number, number>} */
const unanswered = new Map(); // tabId → when its show went out
/** @type {Map<number, number>} */
const showAsked = new Map(); // tabId → when a switch to it was last asked for (focusTab)
/** @type {Map<number, { tabId: number, at: number }[]>} */
const recentActivations = new Map(); // windowId → its last activations (not an introduction's), oldest first
/** background.js: an activation that isn't an introduction's. @param {{ tabId: number, windowId: number }} info */
export function sawActivation({ tabId, windowId }) {
  const list = recentActivations.get(windowId) ?? [];
  list.push({ tabId, at: Date.now() });
  if (list.length > RECENT_ACTIVATIONS) list.shift();
  recentActivations.set(windowId, list);
}
/** @param {Promise<{ tab?: any, err?: any }>} update @param {number} tabId @param {number | null | undefined} windowId @param {number} sentAt */
function answeredLate(update, tabId, windowId, sentAt) {
  unanswered.set(tabId, sentAt);
  const forget = () => { if (unanswered.get(tabId) === sentAt) unanswered.delete(tabId); };
  const timer = setTimeout(forget, UNANSWERED_MS);
  void update.then(async (answer) => {
    clearTimeout(timer);
    forget();
    if (answer?.err || windowId == null) return;
    activating(tabId); // (its activation can come just after the answer: Margin's)
    if ((showAsked.get(tabId) ?? 0) > sentAt) return; // asked for again since
    // (After its activation, which Safari sends first, has reached
    // background.js: activations are handled in the order they come.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newer = (recentActivations.get(windowId) ?? []).filter((a) => a.at > sentAt && a.tabId !== tabId).at(-1);
    if (!newer) return;
    const [now] = await api.tabs.query({ active: true, windowId }).catch(() => []);
    if (now?.id !== tabId) return;
    console.warn(`[margin] Safari showed tab ${tabId} ${Date.now() - sentAt} ms after it was asked, after tab ${newer.tabId} was chosen: tab ${newer.tabId} brought back`);
    activating(newer.tabId);
    await api.tabs.update(newer.tabId, { active: true }).catch(() => {});
  });
}
/** @type {Preparation} */
const NOT_PREPARED = { outcome: 'skipped', ms: 0, token: null };
/** @typedef {{ stage: string, sent: boolean, sentAt: number, update: Promise<{ tab?: any, err?: any }> | null, taken: boolean, tab: any, noPage: boolean, preparation: Preparation | null, prepToken: string | null, early: Promise<Preparation> | null, facts: Record<string, unknown>, kick: Kick | null, plain?: 'tab' | 'late' | null, slowFrom: () => number | null, forceAt: () => number, slowPlanAt: (ms: number) => number, onPage: (on: boolean) => void, markReason?: string | null }} Run what focusTabNow has got to, for focusTab's deadline: `stage`, the step it's at (the switch log says where a switch was stuck); `sent`: its show went out (at `sentAt`, `update` its answer); `taken`: focusTab showed the tab itself (focusTabNow logs nothing more); `kick`: its kick, if it had one (the switch log); `plain`: shown as it is without its steps ('tab': Safari too slow to say where it is; 'late': asked past the time for them); `slowFrom()`: what its plan for a slow Safari counts from (null: Safari not found slow; SLOW_SINCE_MS); `forceAt()`: when focusTab shows it as it is; `slowPlanAt(ms)`: when the plan for a slow Safari ends `ms` after its start, the time its steps spent waiting for the tab's own page added (Infinity: Safari not found slow); `onPage(on)`: its steps start (true) or stop (false) waiting for the tab's own page (its wake's answer once its scripts are out, its drawing): that time isn't counted against the slow plan (focusTab) */

// `deadline`: when the page that asked stops waiting (it then says the switch
// didn't happen): no switch after it. `raise: false`: the window isn't
// brought forward (a switch the user didn't just ask for: openBehind).
// `covered`: the page the switch is from is covered meanwhile (prepareTabForShow).
// `hurry()`: true once the switch should stop waiting for its tab to load (a
// key press after it: background/navigation.js); it then gives up, `hurried`.
// `loadWaited`: the caller has waited for the tab to load already (openBehind):
// not waited for again. `retry`: the caller goes on to another tab if this one
// is closed meanwhile (showSpace): that isn't told to the page as a failure.
// `arrival`: how its request came (background.js), for the switch log.
// A switch under way until it answers (switchUnderWay).
/** @typedef {{ at: number, left: number, decided: number, sync: number, resolve: number }} Arrival DEVELOPMENT DIAGNOSTICS: a timed request as it reached background.js (`at`), how much of its page's wait was `left` then, and the ms it waited for this copy's ownership (`decided`), the first sync, and its tab's lookup (`resolve`) */
/** @typedef {{ wake?: boolean, source?: string, carry?: 'hover' | 'toggle' | null, scroll?: number | null, deadline?: number, waitsUntil?: number, raise?: boolean, covered?: boolean, hurry?: (() => boolean) | null, loadWaited?: boolean, retry?: boolean, arrival?: Arrival | null }} FocusOptions `waitsUntil`: when its page really stops waiting, past `deadline` (content/core.js SWITCH_GRACE_MS): a switch asked too late for its steps is still shown, at once */
/** @param {number} tabId @param {FocusOptions} [options] */
export async function focusTab(tabId, options = {}) {
  const answered = switchAsked();
  try {
    return await focusTabAnswered(tabId, options);
  } finally {
    answered();
  }
}
/** @param {number} tabId @param {FocusOptions} [options] */
async function focusTabAnswered(tabId, { wake = true, source = 'other', carry = null, scroll = null, deadline, waitsUntil, raise = true, covered = false, hurry = null, loadWaited = false, retry = false, arrival = null } = {}) {
  const timed = Number.isFinite(deadline);
  const asked = Date.now();
  // When its page stops waiting: its deadline, or the grace it gives after
  // it (late timers, a slow Safari).
  const latest = timed ? Math.max(/** @type {number} */ (deadline), Number.isFinite(waitsUntil) ? /** @type {number} */ (waitsUntil) : -Infinity) : Infinity;
  // DEVELOPMENT DIAGNOSTICS: the request's way here, in its switch's entry.
  const before = arrival ? { left: arrival.left, waited: asked - arrival.at, decided: arrival.decided, sync: arrival.sync, resolve: arrival.resolve } : null;
  if (timed && asked > latest - REFUSE_MS) {
    recordSwitch({ source, tabId, asked, error: 'expired', stuckAt: 'before', before });
    throw new Error(TOO_LATE);
  }
  // Asked with no time left for its steps, but within its page's grace:
  // shown as it is, at once (below), not refused.
  const hurried = timed && asked > /** @type {number} */ (deadline) - REFUSE_MS;
  focusing.set(tabId, (focusing.get(tabId) ?? 0) + 1);
  showAsked.set(tabId, asked);
  const gen = ++focusGen;
  // The page in front, if the switch covered it while its tab got ready: told how it went (once).
  /** @type {{ uncover: ((shown: boolean | null, reason?: string | null) => void) | null }} */
  const front = { uncover: null };
  let told = false;
  const tell = (/** @type {boolean | null} */ shown, /** @type {string | null} */ reason = null) => {
    if (told || !front.uncover) return;
    told = true;
    front.uncover(shown, reason);
  };
  const finish = () => {
    // An activation of the tab left out after its introduction was answered
    // (the user's, or Safari's late): told if the tab is in front (Margin's
    // own update of it then made none).
    if (endIntroduction(tabId, gen)?.lateTab) void api.tabs.get(tabId).then((t) => t.active && hooks.activated?.({ tabId, windowId: t.windowId }), () => {});
    const left = (focusing.get(tabId) ?? 1) - 1;
    if (left > 0) focusing.set(tabId, left);
    else focusing.delete(tabId);
  };
  /** @param {{ result?: any, err?: any }} outcome */
  const conclude = ({ result, err }) => {
    if (!err) {
      tell(result?.tab ? true : null);
      return result;
    }
    const gone = retry && /No tab with id/.test(String(err?.message ?? err));
    tell(gone ? null : false, gone ? null : String(err?.message ?? err));
    throw err;
  };
  // Safari found slow for this switch (slow.js): as it was asked, or by its
  // own calls since its request came (its tab's lookup: background.js), and
  // what its plan for that counts from (SLOW_SINCE_MS). Only a timed switch:
  // one with no page waiting (a key, a command) goes through its steps.
  const since = arrival?.at ?? asked;
  const slowFrom = () => {
    const found = timed ? slowFoundAt(tabId, since) : null;
    return found == null ? null : Math.max(asked, found - SLOW_SINCE_MS);
  };
  // Shown as it is by FORCE_SHOW_MS before the deadline, or, with Safari
  // slow, SLOW_FORCE_MS from its plan's start: looked at every FORCE_POLL_MS
  // (Safari can be found slow during the switch, and a timer that fires late
  // says so too). The time its steps spend waiting for the tab's own page
  // (its wake's answer once its scripts are out, its drawing: `onPage`)
  // isn't counted against that plan: shown before its page has answered or
  // drawn, it would be Safari's empty view, and the page waits until its
  // deadline all the same (2026-11-03). The rest is: Margin's own steps (a
  // permission check, a storage read slow while a background starts) and
  // Safari's calls (a flip, a lookup) are what the slow plan is for, and a
  // switch stuck there is shown about SLOW_FORCE_MS after the ask, as before.
  // All of it counts if the background's own timers are late (a plan to the
  // deadline can't be kept then), or this switch's own Safari calls were slow.
  /** @type {[number, number | null][]} */
  const pageSpans = [];
  let pageDepth = 0;
  const onPage = (/** @type {boolean} */ on) => {
    if (on) {
      if (pageDepth++ === 0) pageSpans.push([Date.now(), null]);
    } else if (pageDepth > 0 && --pageDepth === 0) {
      const last = pageSpans.at(-1);
      if (last) last[1] = Date.now();
    }
  };
  // The time spent waiting for the page since `from`.
  const pageTime = (/** @type {number} */ from) => {
    const t = Date.now();
    let sum = 0;
    for (const [start, end] of pageSpans) sum += Math.max(0, (end ?? t) - Math.max(start, from));
    return sum;
  };
  const slowPlanAt = (/** @type {number} */ ms) => {
    const from = slowFrom();
    if (from == null) return Infinity;
    return from + ms + (timersLate() || ownSign(tabId, since) ? 0 : pageTime(from));
  };
  const forceAt = () => Math.min(timed ? /** @type {number} */ (deadline) - FORCE_SHOW_MS : Infinity, slowPlanAt(SLOW_FORCE_MS));
  /** @type {Run} */
  const run = { stage: hurried ? 'late' : 'start', sent: false, sentAt: 0, update: null, taken: false, tab: null, noPage: false, preparation: null, prepToken: null, early: null, facts: before ? { before } : {}, kick: null, plain: hurried ? 'late' : null, slowFrom, forceAt, slowPlanAt, onPage };
  /** @type {Promise<{ result?: any, err?: any }>} */
  const settled = hurried ? Promise.resolve({ result: { plain: true } }) : focusTabNow(tabId, gen, { wake, source, carry, scroll, deadline, raise, covered, hurry, loadWaited, asked }, front, run).then((result) => ({ result }), (err) => ({ err }));
  /** @type {{ result?: any, err?: any } | null} */
  let inTime = timed ? null : await settled;
  while (!inTime) {
    inTime = await answerBy(settled, Math.min(forceAt(), Date.now() + FORCE_POLL_MS));
    if (Date.now() >= forceAt()) break;
  }
  // (A switch whose steps found Safari too slow to say where its tab is, or
  // asked too late for them: shown as it is, as one out of time.)
  if (inTime && !inTime.result?.plain) {
    finish();
    return conclude(inTime);
  }
  // Time's up. Whatever the steps still waiting on Safari do, they end here
  // (the cover put up meanwhile, if any, is lifted then: told once).
  void settled.then(() => {
    finish();
    tell(run.taken || run.sent ? true : null);
  });
  // (With its kick as far as it got, and what showed Safari slow: DEVELOPMENT DIAGNOSTICS.)
  const slow = slowFrom() != null ? slowFacts(tabId, since) : null;
  const stuck = { source, tabId, asked, ...run.facts, stuckAt: run.stage, ...(run.kick ? { kicked: { ...run.kick } } : {}), ...(run.plain ? { plain: run.plain } : {}), ...(slow ? { slow } : {}), markReason: run.markReason ?? null, pageWaitedMs: pageTime(asked) };
  // Safari's answer to the show: with Safari slow, waited for only
  // FORCED_ANSWER_MS (a tab gone fails at once), so the page is answered as
  // soon as the show is out, not once Safari has carried it out (it does),
  // however late the background's timers fire. Otherwise, or for a tab
  // Safari hasn't said is there (`plain`: Margin's record of it), until
  // ANSWER_BY_MS before the deadline, as before: a tab gone fails, late, and
  // its page says it's no longer open. Never past ANSWER_BY_MS before the
  // page's own end.
  const answerUntil = () => {
    const quick = slowFrom() != null && !!run.tab;
    const until = quick ? Date.now() + FORCED_ANSWER_MS : Math.max(Date.now() + FORCED_ANSWER_MS, /** @type {number} */ (deadline) - ANSWER_BY_MS);
    return Math.max(Date.now(), Math.min(until, latest - ANSWER_BY_MS));
  };
  if (run.sent) {
    // Its show went out: its answer, briefly.
    const late = await answerBy(settled, answerUntil());
    if (late) return conclude(late);
    recordSwitch({ ...stuck, unconfirmed: true, shownAfter: Date.now() - asked });
    tell(true);
    if (run.update) answeredLate(run.update, tabId, run.tab?.windowId ?? cached()?.tabs[tabId]?.windowId, run.sentAt);
    return { tab: { ...(run.tab ?? {}), id: tabId, active: true }, preparation: run.preparation ?? NOT_PREPARED, unconfirmed: true };
  }
  // Another switch asked for since: that one stands.
  if (gen !== focusGen) return { tab: null, preparation: NOT_PREPARED, superseded: true };
  // Shown as it is now. Its steps stand down (the next one each takes sees
  // another switch), its introduction is over (an activation from here is the
  // show's), and its preparation, if it isn't ready, is called off (now, and
  // once it answers), its page's arrival cover kept: its show lifts it.
  focusGen++;
  run.taken = true;
  if (run.plain) movedOn(cached()?.tabs[tabId]?.windowId ?? null); // (as focusTabNow does once it has the tab)
  // (Its updates, if Safari hasn't carried them out yet, still left out as
  // they come: endIntroduction `linger`.)
  if (endIntroduction(tabId, gen, { linger: true })?.lateTab) void api.tabs.get(tabId).then((t) => t.active && hooks.activated?.({ tabId, windowId: t.windowId }), () => {});
  // (One shown without its steps had none sent: no script goes to Safari
  // ahead of its show.)
  if (!run.plain && run.preparation?.outcome !== 'ready') {
    for (const token of new Set([`${instanceId}:${gen}:${tabId}`, run.prepToken])) if (token) cancelPreparation(tabId, { outcome: 'timeout', ms: 0, token }, { keepCover: true });
    void run.early?.then((prep) => cancelPreparation(tabId, prep, { keepCover: true }), () => {});
  }
  // A tab Safari unloaded: noted, as focusTabNow does (not waited for). One
  // shown without a look at it (`plain`): as Margin has it, if the open-tab
  // repair found it with no page.
  const noted = run.tab ?? (run.plain && hasNoPage(tabId) ? cached()?.tabs[tabId] ?? null : null);
  if ((run.noPage || (run.plain && hasNoPage(tabId))) && noted) void noteShowing(noted, { carry, scroll }).catch(() => {});
  activating(tabId);
  run.sent = true;
  const sentAt = Date.now();
  /** @type {Promise<{ tab?: any, err?: any }>} */
  const update = timedCall('tabs.update', api.tabs.update(tabId, { active: true }), tabId).then((tab) => ({ tab: tab ?? null }), (err) => ({ err }));
  // (One Safari hasn't said is there: gone if its lookup, still under way,
  // says so first.)
  const gone = run.tab ? null : lookupTab(tabId).then(({ tab }) => (tab ? new Promise(() => {}) : { err: new Error(`No tab with id ${tabId}`) }));
  const shown = await answerBy(gone ? Promise.race([update, gone]) : update, answerUntil());
  if (shown?.err) {
    forgetShowing(tabId);
    recordSwitch({ ...stuck, forced: true, layersBack: run.plain ? `skipped:plain-${run.plain}` : 'skipped:forced', error: String(shown.err?.message ?? shown.err) });
    return conclude({ err: shown.err });
  }
  // (Shown as it is: its layers not waited for, `layersBack`; a forced show
  // goes out at FORCE_SHOW_MS before the deadline at the latest, its steps
  // having waited to there for the tab's own page.)
  recordSwitch({ ...stuck, forced: true, layersBack: run.plain ? `skipped:plain-${run.plain}` : 'skipped:forced', unconfirmed: !shown, shownAfter: Date.now() - asked });
  tell(true);
  const windowId = shown?.tab?.windowId ?? run.tab?.windowId ?? cached()?.tabs[tabId]?.windowId;
  if (!shown) answeredLate(update, tabId, windowId, sentAt);
  if (raise) void focusWindow(windowId);
  return { tab: { ...(run.tab ?? {}), ...(shown?.tab ?? {}), id: tabId, active: true }, preparation: run.preparation ?? NOT_PREPARED, forced: true, ...(shown ? {} : { unconfirmed: true }) };
}

// A restore or introduction of another switch's under way in the window, its
// updates not answered yet: waited for this long at most (below).
const UNDER_WAY_MS = 400;
// How long a switch waits for Safari to say where its tab is (a few ms
// usually; a tab's hung process, or Safari slow after a reboot, seconds).
const TAB_LOOKUP_MS = 500;
// An introduction (tabs.update twice: ~110 ms in Safari) and the drawing
// after it (paintBarrier, BARRIER_MAX_MS at most), before the show.
const INTRODUCE_MIN_MS = 500;
const SESSION_WAIT_MS = 200;

/** @param {number} tabId @param {number} gen @param {any} options @param {{ uncover: ((shown: boolean | null, reason?: string | null) => void) | null }} front @param {Run} run */
async function focusTabNow(tabId, gen, { wake, source, carry, scroll, deadline, raise, covered, hurry, loadWaited, asked: askedAt }, front, run) {
  const asked = askedAt ?? Date.now();
  // What the background before this one knew of which tabs are held
  // (keep-ready.js sessionKnown: read as this one started): a tab held isn't
  // waited for (mayWait, below), and the switch log says when the tab was
  // left. Not waited for past SESSION_WAIT_MS (a storage stuck behind a
  // loaded Safari).
  await answerBy(sessionKnown(), asked + SESSION_WAIT_MS);
  // DEVELOPMENT DIAGNOSTICS: whether keep-ready held the tab, and how long it
  // had been hidden, as the switch was asked for (a hold ends as it's shown).
  const facts = { ...run.facts, ...switchFacts(tabId, asked) };
  run.facts = facts;
  // (Not once focusTab has shown the tab itself: it says how that went.)
  const logSwitch = (/** @type {Record<string, unknown>} */ entry) => run.taken || recordSwitch({ source, tabId, asked, ...facts, ...(run.slowFrom() != null ? { slow: slowFacts(tabId, asked) } : {}), ...entry });
  // When the page that asked stops waiting, less the show's own time: what
  // the steps below plan within (focusTab holds the whole run to it). With
  // Safari found slow, soon after the ask (SLOW_SHOW_MS, run.slowFrom),
  // however much of the page's wait is left: found slow at any step, the
  // next one plans to it.
  const byDeadline = Number.isFinite(deadline) ? /** @type {number} */ (deadline) - SHOW_BEFORE_MS : Infinity;
  // (The time its steps waited for the tab's own page not counted: run.slowPlanAt.)
  const slowPlan = (/** @type {number} */ ms) => run.slowPlanAt(ms);
  const showBy = () => Math.min(byDeadline, slowPlan(SLOW_SHOW_MS));
  // A step that waits for the tab's own page (its answer, its drawing): not
  // counted against the plan for a slow Safari (focusTab, run.onPage).
  /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
  const pageStep = (promise) => {
    run.onPage(true);
    return promise.finally(() => run.onPage(false));
  };
  const token = `${instanceId}:${gen}:${tabId}`;
  /** @type {Preparation} */
  const skipped = { outcome: 'skipped', ms: 0, token: null };
  // The tab as the browser has it now: whether it's still there, its window,
  // whether it's in front already (then there's nothing to wake or prepare).
  // Safari's answer (the lookup background.js started for the request, if
  // it's still under way), for TAB_LOOKUP_MS at most: a Safari that slow
  // (seconds, after a reboot) would be as slow for every step after, so the
  // tab is shown as it is at once (focusTab: `plain`), as plain Safari
  // shows it. A tab gone fails its show. (A switch with no page waiting for
  // it, a key's or a command's, waits for the answer, as before.)
  run.stage = 'tab';
  const timedRun = Number.isFinite(deadline);
  const looked = timedRun ? await answerBy(lookupTab(tabId), Date.now() + TAB_LOOKUP_MS) : await lookupTab(tabId);
  // Shown by focusTab meanwhile (the request came with little time left):
  // nothing of this switch's goes out.
  if (run.taken) return { tab: null, preparation: skipped, superseded: true };
  if (!looked) {
    run.plain = 'tab';
    return { plain: true };
  }
  let live = looked.tab;
  run.tab = live;
  // Another switch's restore, introduction or kick in its window whose
  // updates Safari hasn't answered yet: its answer first (UNDER_WAY_MS at
  // most), so the tab isn't taken as one with no page (a second click on the
  // same row), nor the window as busy (one at a time per window: forwardAndBack).
  const underWay = (/** @type {Introduction | null | undefined} */ under) => {
    if (!under || under.gen === gen || under.answered) return null;
    let timer;
    return Promise.race([under.done, new Promise((resolve) => { timer = setTimeout(resolve, UNDER_WAY_MS); })]).then(() => clearTimeout(timer));
  };
  // Another tab's kick only before this switch's own flip, if it has one
  // (below): its wake goes out now, not once Safari has answered the kick.
  const under = live && wake ? introductions.get(live.windowId) : null;
  const before = under?.kick && under.tabId !== tabId ? null : underWay(under);
  if (before) {
    await before;
    const again = timedRun ? await answerBy(lookupTab(tabId), Date.now() + TAB_LOOKUP_MS) : await lookupTab(tabId);
    if (again) live = again.tab;
    run.tab = live;
  }
  // (Before its own restore or introduction, below.)
  const flipsClear = async () => { await underWay(introductions.get(live.windowId)); };
  if (!live) {
    logSwitch({ error: 'no such tab' });
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
    logSwitch({ ...how, shownAfter: Date.now() - asked });
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
  // The token of the preparation that goes with the show (a new one once the
  // early one is called off: a late answer to that call can't be taken for it).
  let prepToken = token;
  let loading = !loadWaited && !!platform?.restoreTabs && neverShown.has(tabId) && live.status === 'loading';
  // A tab Safari may have suspended (any not held, at rest: mayWait): its
  // wake's own answer is waited for, below, and the preparation sent beside
  // it is given that long too (it reaches the page just behind the wake, as
  // its process is resumed). Not one the caller has just waited for to load
  // (openBehind): its process runs, and it's introduced as it is.
  const waits = wake && !loading && !loadWaited && gen === focusGen && mayWait(live);
  // Not waited for only because keep-ready holds it (running: its wake
  // answers at once, or a little late if its page is busy). One whose wake
  // doesn't answer in time at all (WAKE_MAX_MS) was likely suspended all the
  // same (a hold that ended unseen; one a background before this one placed,
  // its page changed since): drawn before it's shown, as a tab waited for is
  // (`late`, below), not shown as Safari's empty view.
  const trusted = wake && !waits && !loading && !loadWaited && !!platform?.wakeTabs && live.status === 'complete';
  // (As long as its wake may be waited for: a click's, to its plan's drawing.)
  const earlyBudget = waits ? (timedRun ? Math.max(0, byDeadline - Date.now()) : Math.min(WAIT_AWAKE_MAX_MS + PREPARE_AWAKE_MS, Math.max(0, showBy() - Date.now()))) : undefined;
  /** @type {Promise<Preparation> | null} */
  let early = wake && !neverShown.has(tabId) ? prepareTabForShow(live, { token, carry, scroll, covered, ...(earlyBudget != null ? { budget: earlyBudget } : {}) }) : null;
  run.early = early;
  run.prepToken = token;
  let earlyAt = Date.now();
  // (With Safari found slow, SLOW_RESTORE_MS from the ask at most, as soon
  // as it's found so: read at each look.)
  const slowEnd = () => slowPlan(SLOW_RESTORE_MS);
  const usualUntil = Math.min(asked + RESTORE_MAX_MS, (deadline ?? Infinity) - RESTORE_RESERVE_MS);
  const usualHardUntil = Math.min(asked + RESTORE_HARD_MAX_MS, (deadline ?? Infinity) - RESTORE_RESERVE_MS);
  /** @type {Wait} */
  const wait = { gen, since: asked, get until() { return Math.min(usualUntil, slowEnd()); }, get hardUntil() { return Math.min(usualHardUntil, slowEnd()); }, hurry, arrival: null, thereAt: null, cut: false };
  // A preparation called off now, and again once it answers (its token isn't
  // the next one's), should it land later.
  const callOff = (/** @type {Promise<Preparation>} */ stale, /** @type {string} */ staleToken) => {
    cancelPreparation(tabId, { outcome: 'ready', ms: 0, token: staleToken });
    void stale.then((late) => cancelPreparation(tabId, late));
  };
  // Its wake's own answer, if it was waited for: the page's, however late.
  /** @type {Wake | null} */
  let answered = null;
  // The page in front, covered while that answer was waited for (coverFront):
  // its own answer to that is waited for only by a restore (below), which
  // needs to know it's covered; a switch that goes on to show the tab tells
  // it how it went once it has answered.
  /** @type {Promise<{ covered: boolean, done: (shown: boolean | null, reason?: string | null) => void }> | null} */
  let frontCovering = null;
  // No answer by WAIT_AWAKE_MAX_MS: shown as it is (its show resumes it). A
  // tab never shown, or not proven to have WebKit's mark, goes on as before
  // the wait instead: introduced, its wake taken as too busy to answer (hasPage).
  let capped = false;
  // Answered only once its process was resumed (resumedBehind), or kicked:
  // drawn (paintBarrier) before it's shown.
  let late = false;
  /** @type {Kick | null} */
  let kick = null;
  // Its kick was its introduction (a tab not proven to have WebKit's mark,
  // kicked: below): why it wasn't proven, for the switch log.
  /** @type {string | null} */
  let kickIntroduced = null;
  if (waits) {
    // Its wake, or the one under way it takes on (a pointer resting on its
    // row, a press, the sidebar coming out: wakeTab's `by`).
    void wakeTab(tabId);
    const entry = wakes.get(tabId);
    const answer = wakeAnswer(tabId);
    run.stage = 'wake';
    // (Until focusTab's own show, less the preparation's time after an
    // answer: a tab with no page answers within milliseconds, and is then
    // noted and shown as Safari loads it, not taken as one too busy to answer.)
    // A switch its page waits for (a click) waits on past WAIT_AWAKE_MAX_MS,
    // the page before on screen, until its plan leaves only its drawing and
    // its show (BARRIER_MAX_MS, then SHOW_BEFORE_MS before the deadline), and
    // with Safari slow too (its time waiting for the page isn't counted
    // against the slow plan: run.onPage): shown before its answer, a process
    // still suspended is Safari's empty view until it has resumed and drawn
    // (T2, 2026-11-03). One with no page waiting for it (a key, a command):
    // WAIT_AWAKE_MAX_MS, as before.
    // A tab not proven to have WebKit's mark (or one Margin can't say of yet:
    // its record still being read) is introduced once its wake has answered,
    // so a click's wait ends early enough for that too (INTRODUCE_MIN_MS, its
    // flip and its drawing, after UNSEEN_PREPARED_MS for the preparation sent
    // beside the wake), not only for its drawing: answered at the very
    // end of the wait, it would be shown with no introduction (2026-11-03).
    // Its record is read beside the wait, not before it (a storage read can
    // be slow while a background starts: SESSION_WAIT_MS at most, then it
    // counts as not proven).
    /** @type {{ marked: boolean, how: MarkHow | null, lost: string | null, doc: string | null } | null} */
    let markNow = null;
    const markRead = platform?.introduceTabs ? answerBy(markOf(tabId), Date.now() + SESSION_WAIT_MS).then((proof) => { markNow = proof ?? { marked: false, how: null, lost: 'unknown', doc: null }; }) : null;
    const unprovenNow = () => neverShown.has(tabId) || markNow?.marked !== true;
    const until = () => Number.isFinite(deadline)
      ? Math.min(Math.max(asked + WAIT_AWAKE_MAX_MS, /** @type {number} */ (deadline) - SHOW_BEFORE_MS - (platform?.introduceTabs && unprovenNow() ? INTRODUCE_MIN_MS + UNSEEN_PREPARED_MS + WAIT_POLL_MS : BARRIER_MAX_MS)), /** @type {number} */ (deadline) - FORCE_SHOW_MS - PREPARE_AWAKE_MS)
      : asked + WAIT_AWAKE_MAX_MS;
    // Waiting for the page itself from the moment its scripts are out (not
    // during the permission check before, nor during a kick: Safari's calls).
    let scriptsOut = false;
    let racing = false;
    let pageOpen = false;
    const openPage = () => { if (!pageOpen) { pageOpen = true; run.onPage(true); } };
    const closePage = () => { if (pageOpen) { pageOpen = false; run.onPage(false); } };
    void entry?.sent.then((at) => {
      if (at == null) return;
      scriptsOut = true;
      if (racing) openPage();
    });
    const waitFrom = Date.now();
    /** @type {'left' | 'hurried' | null} */
    let stop = null;
    // One already there (a wake taken on whose page has answered) counts even
    // with no time left to wait: the tab is running.
    answered = entry?.settled ?? null;
    // The kick's time, counted from when the wake's scripts went out (not
    // from a permission check slow while Safari starts); one taken on that
    // went out a while ago and hasn't answered is due at once, and so is one
    // whose scripts haven't gone out by WAKE_MAX_MS (its permission check
    // still under way: `sent` says null then, with no answer).
    const KICK = Symbol('kick');
    let kickTimer;
    /** @type {number | null} */
    let sentAt = null;
    let kickEnd = 0; // when Safari answered the kick
    const likely = (hiddenFor(tabId, asked) ?? 0) >= SUSPEND_LIKELY_MS;
    /** @type {Promise<symbol> | null} */
    // (Whether it may be kicked is asked again as the kick is due: its record
    // may have been read by then, a tab not proven being kicked too.)
    let kickDue = !answered && entry && (mayKick(live) || mayKick(live, { unproven: true }))
      ? entry.sent.then((at) => new Promise((resolve) => {
        sentAt = at;
        if (at == null && entry.settled) return; // nothing to wake (its answer is there)
        const due = at == null ? Date.now() : at + (likely ? KICK_SOON_MS : KICK_AFTER_MS);
        kickTimer = setTimeout(() => resolve(KICK), Math.max(0, due - Date.now()));
      }))
      : null;
    // The page in front covered while it waits, if it doesn't cover itself
    // for this switch (shared/switching.js): a space's icon, ⌃⌘ and an arrow
    // to a space, a tab closed. COVER_AFTER_MS into the wait, on a timer of
    // its own (not at the next look after it, nor once a kick under way is
    // answered). Told how the switch went from then on, whatever happens
    // next: a wake failing after this (its permission check throwing) would
    // leave its cover up for 8 s (switching.js MAX_MS).
    const coverTimer = SELF_COVERED.has(source) ? null : setTimeout(() => {
      if (frontCovering || gen !== focusGen || hurry?.()) return;
      const covering = (frontCovering = coverFront(live, gen));
      front.uncover = (shown, reason = null) => void covering.then((cover) => cover.done(shown, reason));
    }, Math.max(0, waitFrom + COVER_AFTER_MS - Date.now()));
    // A kick of a tab not proven to have WebKit's mark is its introduction
    // (its view in the window with its process there: a suspended process
    // counts, WebPageProxy::hasRunningProcess): one Margin knows has a page
    // (its page said hello in this Safari session, and no wake found it
    // without one since: an unloaded tab, selected, would start loading with
    // no cover), whether or not it was seen left (a tab the warm-up or a
    // restore loaded behind, one Safari restored as it was selected, one
    // never shown). Without it, a tab still suspended was shown as Safari's
    // empty view at the end of the wait (`capped`), or after a wait of seconds.
    const pageKnown = () => markNow?.doc != null && markNow.lost !== 'no page' && markNow.lost !== 'discarded' && !noPageFound.has(tabId) && !hasNoPage(tabId);
    const kickable = () => mayKick(live) || (markNow != null && unprovenNow() && pageKnown() && mayKick(live, { unproven: true }));
    // (Its record not read yet as the kick is due: looked at again once it is.)
    let markWaited = false;
    // Kicked while not proven (its kick its introduction, below): why it wasn't.
    /** @type {string | null} */
    let kickedUnproven = null;
    while (answer && !answered) {
      const left = until() - Date.now();
      if (left <= 0) break;
      racing = true;
      if (scriptsOut) openPage();
      let got;
      try {
        got = await Promise.race([answerBy(answer, Date.now() + Math.min(WAIT_POLL_MS, left)), ...(kickDue ? [kickDue] : [])]);
      } finally {
        racing = false;
        closePage();
      }
      if (got === KICK) {
        got = null;
        kickDue = null;
        const other = introductions.get(live.windowId);
        // Another switch's flip under way in the window (one at a time per
        // window): this one's kick once Safari has answered it.
        if (other && other.gen !== gen && windowBusy(live.windowId)) kickDue = other.done.then(() => KICK);
        else if (markRead && markNow == null && !markWaited && !mayKick(live)) {
          markWaited = true;
          kickDue = markRead.then(() => KICK);
        } else if (gen === focusGen && !hurry?.() && until() - Date.now() >= KICK_ROOM_MS && !windowBusy(live.windowId) && kickable() && !(await isOff())) {
          run.stage = 'kick';
          kickedUnproven = unprovenNow() ? (neverShown.has(tabId) ? 'never shown' : 'unproven') : null;
          const at = Date.now();
          kickedAt.set(tabId, at);
          kick = { at: at - asked, kickMs: null, wakeMs: null, outcome: 'under way' };
          run.kick = kick;
          let flipped = false;
          const back = await forwardAndBack(live, gen, () => { flipped = true; }, { kick: true });
          kickEnd = Date.now();
          Object.assign(kick, { kickMs: kickEnd - at, outcome: back ? 'capped' : 'not back' });
          run.stage = 'wake';
          if (back) {
            // Its wake stands: its scripts reach the page behind the resume
            // the kick started (or reached it already), so its answer comes
            // first; a second wake would only queue behind it. Its hold is
            // sent again (its instant in the window ended the one that had
            // reached the page), and once more only if the wake's scripts
            // went out (its permission check, slow while Safari starts, may
            // still be under way: they then reach the page after the kick).
            // Not for a switch given up meanwhile, unless another switch to
            // the tab is under way (a second click on its row).
            const wanted = gen === focusGen && !hurry?.();
            if (sentAt != null && (wanted || (focusing.get(tabId) ?? 0) > 1)) holdAgain(tabId);
            // The preparation sent beside the wake, if it answered before
            // Safari answered the kick, took the page before its instant in
            // the window, which took it (content/core.js shown()): made
            // again. One still waiting can't be kept either: it may reach the
            // page between the kick's two changes (Safari can send the
            // scripts it held for the resume before the update back), and
            // the hide after it would close the sidebar it carries
            // (layout.leave). A new one, sent now, comes after both (as an
            // introduction's), under a token of its own; the first is called off.
            // (A tab never shown has none yet: prepared after it, as one introduced.)
            if (wanted && early) {
              callOff(early, prepToken);
              prepToken = `${token}:kicked`;
              run.prepToken = prepToken;
              early = prepareTabForShow(live, { token: prepToken, carry, scroll, covered, budget: Math.max(0, Math.min(until() + PREPARE_AWAKE_MS, showBy()) - Date.now()) });
              run.early = early;
              earlyAt = Date.now();
            }
          } else {
            // Left in front by Safari (or the user picked it meanwhile): the
            // preparation sent beside the wake would land on the page on screen.
            const now = await api.tabs.get(tabId).catch(() => null);
            if (now?.active) {
              clearTimeout(coverTimer);
              if (early) callOff(early, prepToken);
              kick.outcome = 'in front';
              return inFront(now, { ...how, wakeStartedBy: entry?.by ?? null, waitedOnOldPage: Date.now() - asked, kicked: kick });
            }
            if (!flipped) {
              // Nothing sent: waited for as before.
              kick = null;
              run.kick = null;
              kickedAt.delete(tabId);
            }
          }
        }
      }
      answered = /** @type {Wake | null} */ (got);
      if (answered) break;
      if (gen !== focusGen) stop = 'left';
      else if (hurry?.()) stop = 'hurried';
      if (stop) break;
    }
    clearTimeout(kickTimer);
    clearTimeout(coverTimer);
    if (kick && kick.outcome !== 'not back') {
      // From Safari's answer to the kick (0: the page answered during it).
      kick.wakeMs = answered ? Math.max(0, answered.startedAt + answered.ms - kickEnd) : null;
      // Answered within RESUMED_MS of its scripts going out: its process was
      // running all along, the kick not needed (its page drew in the window
      // for it anyway): shown as a tab awake, not drawn first.
      const running = !!answered && sentAt != null && answered.startedAt + answered.ms - sentAt <= RESUMED_MS;
      kick.outcome = !answered ? stop ?? 'capped' : !hasPage(answered) ? answered.outcome : running ? 'awake' : 'resumed';
      if (hasPage(answered)) {
        // In the window with its process there (its page answered): proven
        // to have WebKit's mark, as by an introduction.
        if (answered?.outcome === 'awake') prove(tabId, 'kicked');
        resumedBehind.delete(tabId); // (in the window since: a late answer marks it again)
        // Not proven before, its kick was its introduction: not flipped again
        // (its own flip's hide is waited for: the paint barrier, below).
        if (kickedUnproven) {
          noteIntroduced(tabId);
          kickIntroduced = kickedUnproven;
        }
      } else if (!stop) {
        // A tab with no page after all (its process went away while it was
        // suspended): the kick has started its load. Shown at once it would
        // be Safari's empty view: waited for behind the page, as a tab
        // restored (below). With no load seen, and its wake saying so,
        // restored behind the page as any.
        const now = await api.tabs.get(tabId).catch(() => null);
        if (now && !now.active && now.status === 'loading' && gen === focusGen) {
          endIntroduction(tabId, gen);
          neverShown.add(tabId); // (as restoreTab's `selected`)
          wakes.delete(tabId);
          if (early) callOff(early, prepToken);
          early = null; // prepared once it has loaded
          prepToken = `${token}:loaded`;
          run.prepToken = prepToken;
          live = now;
          run.tab = live;
          loading = true;
          kick.outcome = 'loading';
        } else if (kick.outcome === 'no page') endIntroduction(tabId, gen);
      }
    }
    const unanswered = !answered && !stop && !loading;
    // So does one not proven to have WebKit's mark (introductions on): its
    // introduction's flip resumes its process in the foreground, as a kick
    // would have (one it couldn't have: no page of it known to Margin, or
    // kicked just now), and its page draws before it's shown; shown as it is,
    // it would be Safari's empty view until it had resumed and drawn. (The
    // wait ended early enough for that: until().)
    // (Its record read by then: SESSION_WAIT_MS at most. Not with no room
    // left for an introduction: shown as it is at once.)
    if (unanswered && markRead) await markRead;
    const roomLeft = !Number.isFinite(deadline) || /** @type {number} */ (deadline) - SHOW_BEFORE_MS - Date.now() >= INTRODUCE_MIN_MS;
    capped = unanswered && !neverShown.has(tabId) && !(!!platform?.introduceTabs && roomLeft && unprovenNow() && !(await isOff()));
    late = !!answered && hasPage(answered) && (resumedBehind.has(tabId) || kick?.outcome === 'resumed');
    // DEVELOPMENT DIAGNOSTICS: what started the wake the switch waited for,
    // its page's answer (ms from the wake's start; null: none by then), how
    // long the page before stayed on screen for it, how it went, and the
    // kick if there was one.
    const outcome = stop ?? (loading ? 'no page' : unanswered ? 'capped' : !hasPage(answered) ? /** @type {Wake} */ (answered).outcome : late ? 'resumed' : 'awake');
    how = { ...how, wakeStartedBy: entry?.by ?? null, wakeMs: answered?.ms ?? null, waitedOnOldPage: Date.now() - asked, wakeOutcome: outcome, ...(kick ? { kicked: kick } : {}) };
    if (stop) {
      if (early) callOff(early, prepToken);
      logSwitch({ ...how, error: 'superseded' });
      return { tab: null, preparation: skipped, superseded: true, hurried: stop === 'hurried' };
    }
    // Its preparation, still waiting behind the resume, called off (now, and
    // once it answers): no paint barrier either, it would wait behind the
    // resume too.
    if (capped && early) callOff(early, prepToken);
  }
  // The answer it had, however late (the wake's `done` says 'timeout' past
  // WAKE_MAX_MS). Another tab's kick under way in the window (not waited for
  // above) over first: the window isn't free for a restore until then.
  const restorable = async () => {
    if (!mayRestore(live, { busy: true }) || (await isOff()) || (await areRestoresOff()) || (answered ?? (await wakeTab(tabId))).outcome !== 'no page') return false;
    await flipsClear();
    return mayRestore(live);
  };
  if (wake && gen === focusGen && !capped && wait.until - Date.now() >= RESTORE_START_MS && (loading || (await restorable()))) {
    // Called off or hurried while that was asked (a wake can take a while
    // just after Safari started): the page in front isn't covered for it.
    if (gen !== focusGen) behind = 'left';
    else if (hurry?.()) behind = 'hurried';
    else {
      // The whole of it within the wait's own end (its hard limit, or with
      // Safari slow SLOW_RESTORE_MS from the ask), and a little for Safari's
      // answers: a Safari call in it that doesn't answer by then (the
      // window's, the cover's, the restore's flip, a look at the tab) doesn't
      // hold the switch up. It's then shown as far as it got (`cut`: still
      // loading, maybe with nothing drawn, as plain Safari would show it).
      const cutAt = () => Math.max(wait.until, wait.hardUntil ?? wait.until) + RESTORE_CUT_SLACK_MS;
      // Its window first: a tab in another window has its page covered where
      // the user sees it, not behind the window they're in.
      // (A restore's steps are Safari's calls: with Safari slow, its plan
      // stands, its wait for the page's load and paint included.)
      if (raise) await withinWait(focusWindow(live.windowId), cutAt);
      const covering = frontCovering ?? coverFront(live, gen);
      front.uncover = (shown, reason = null) => void covering.then((c) => c.done(shown, reason));
      const cover = await withinWait(covering, cutAt);
      if (gen !== focusGen) behind = 'left';
      else if (cover === CUT) behind = 'cut';
      // Only with the page in front covered: one that isn't (a PDF, Safari's
      // own pages, a site Margin can't reach, an earlier copy of Margin)
      // would show nothing happening for the whole wait. Shown as before.
      else if (cover.covered) {
        early = null; // prepared once it has loaded
        run.stage = loading ? 'load' : 'restore';
        const restoring = loading ? waitLoaded(tabId, wait) : restoreTab(live, wait);
        const got = await withinWait(restoring, cutAt);
        if (got === CUT) {
          // Its steps stand down (stopsWait), and its flip, if Safari hasn't
          // carried it out yet, is over: its activations, still to come,
          // left out as they come (as for a show forced out of time).
          wait.cut = true;
          endIntroduction(tabId, gen, { linger: true });
          behind = 'cut';
        } else behind = got;
      }
    }
    how = { ...how, ...(loading ? { loadWait: behind } : { restored: behind }), ...(wait.started ? { restoreStart: wait.started } : {}) };
    // DEVELOPMENT DIAGNOSTICS: when its own document first answered (null: it
    // never did, and it's shown with none: Safari's empty view until it commits).
    if (wait.thereAt != null || behind === 'loading') how = { ...how, committed: wait.thereAt != null ? wait.thereAt - asked : null };
    if (behind === 'left' || behind === 'hurried') {
      logSwitch({ ...how, error: 'superseded' });
      return { tab: null, preparation: skipped, superseded: true, hurried: behind === 'hurried' };
    }
    run.stage = 'restored';
    // (Safari slow to say: as it was, unless Safari was found to leave it in front.)
    const looked = await answerBy(lookupTab(tabId), Date.now() + (behind === 'cut' || run.slowFrom() != null ? RESTORED_LOOKUP_MS : TAB_LOOKUP_MS));
    const now = looked ? looked.tab : behind === 'in front' ? { ...live, active: true } : live;
    if (!now) {
      logSwitch({ ...how, error: 'no such tab' });
      throw new Error(`No tab with id ${tabId}`);
    }
    if (now.active) {
      // Left there by Safari as it was restored: loading in front, as an
      // unloaded tab shown, so its page is told which tab it is (below).
      if (behind === 'in front' && gen === focusGen) await noteShowing(now, { carry, scroll });
      return inFront(now, how);
    }
    live = now;
    run.tab = live;
  }
  // Loaded behind just now (painted, loaded, or as far as it got by the time
  // limit; here, or by the caller: a new tab from the palette, openBehind):
  // introduced even if still loading (mayIntroduce), with a fresh wake (its
  // last one may say it had no page), and its page arrives covered, as the
  // page before is.
  const waited = loadWaited || behind === 'painted' || behind === 'loaded' || behind === 'loading' || behind === 'cut';
  // Never in front yet, or not proven to have WebKit's mark (above):
  // introduced first (introduceTab), once it has a page (a tab Safari unloaded
  // has none to introduce: it loads as it's shown). Its wake's hold ends as
  // it's shown for that instant: held afresh.
  /** @type {boolean | null} */
  let introduced = kickIntroduced ? true : null;
  // Why it was or wasn't introduced, in the switch log: 'proven:<how>',
  // 'unproven', 'never shown', 'loaded behind', ':kicked' after for one whose
  // kick was its introduction, and for one that needed it and wasn't,
  // ':skipped:<why>' after (':skipped:no wake' for a switch that doesn't wake
  // its tab: the new-tab hand-off, its page there a moment ago).
  /** @type {string | null} */
  let markReason = null;
  // (A storage read slow while a background starts: SESSION_WAIT_MS at most,
  // then not proven.)
  const proofBefore = platform?.introduceTabs ? (await answerBy(markOf(tabId), Date.now() + SESSION_WAIT_MS)) ?? { marked: false, how: null, lost: 'unknown' } : null;
  const reasonFor = (/** @type {{ marked: boolean, how: MarkHow | null } | null} */ proof, unseenNow = false) => (neverShown.has(tabId) ? 'never shown' : waited ? 'loaded behind' : !proof?.marked || unseenNow ? 'unproven' : `proven:${proof.how}`);
  markReason = kickIntroduced ? `${kickIntroduced}:kicked` : proofBefore ? reasonFor(proofBefore) : null;
  run.markReason = markReason;
  // Time left for an introduction and the drawing after it, before the show
  // the page's wait leaves room for (its deadline, not the plan for a slow
  // Safari: shown as it is, a tab not marked is Safari's empty view, and the
  // page waits all the same); none, and it's shown as it is. Its steps that
  // wait for the page aren't counted against the slow plan (pageStep); its
  // flip, Safari's calls, is.
  const roomToIntroduce = () => byDeadline - Date.now() >= INTRODUCE_MIN_MS;
  // (Not looked into at all with no room for it. Nor after a restore cut
  // short: its flip, Safari's calls in it, didn't answer in time, and an
  // introduction is two more.)
  const skipIntro = !platform?.introduceTabs || kickIntroduced ? null : !wake ? 'no wake' : gen !== focusGen ? 'left' : capped ? 'capped' : behind === 'cut' ? 'cut' : !roomToIntroduce() ? 'no room' : (await isOff()) ? 'off' : null;
  if (wake && platform?.introduceTabs && !skipIntro && !kickIntroduced) {
    let tried = false;
    run.stage = 'introduce';
    if (waited) {
      // Its wake renewed and its arrival cover asked for together, not one
      // after the other on a page busy with its start (the cover answering
      // proves the page is there); the cover is in place before the instant
      // it's introduced, so the paint that asks for is the cover's, quick.
      // Asked as its document first answered, while its paint was waited for
      // (waitLoaded): only what that didn't get is asked again now. (The
      // cover's own limit, ARRIVAL_MAX_MS, counts again from its preparation,
      // asked covered, below: content/core.js arriveCovered.)
      await flipsClear();
      if (mayIntroduce(live, { loading: true })) {
        const [early, earlyCovered] = (await wait.arrival) ?? [null, false];
        const [renewed, arrived] = await pageStep(Promise.all([early && hasPage(early) ? early : wakeTab(tabId, { renew: true }), earlyCovered || coverArrival(live)]));
        if ((arrived || hasPage(renewed)) && gen === focusGen && roomToIntroduce()) {
          tried = true;
          introduced = await introduceTab(live, gen, { loading: true, running: !!arrived || renewed?.outcome === 'awake' });
        } else markReason = `${markReason}:skipped:${!(arrived || hasPage(renewed)) ? 'no page' : gen !== focusGen ? 'left' : 'no room'}`;
      } else markReason = `${markReason}:skipped:${introducedBefore(tabId) ? 'introduced already' : windowBusy(live.windowId) ? 'window busy' : 'not ready'}`;
    } else {
      // A page there, awake or too busy to answer in time: one busy loading
      // times out, and shown without its introduction, two such tabs left
      // Safari's empty view (110 and 230 ms) in Tirth's log. Only 'no page'
      // means no page. (Usually the same wake as restorable()'s, reused.)
      // Its proof as it stands once that wake has answered (a page saying it
      // came into view, or that it started unseen, changes it: startWake);
      // one whose page says it started unseen isn't marked, whatever Margin
      // had.
      // (Its wait's own answer if that found no page: a second wake would only
      // fail again, slowly with Safari slow, and say 'timeout'.)
      const woke = answered?.outcome === 'no page' ? answered : await pageStep(wakeTab(tabId));
      const proof = (await answerBy(markOf(tabId), Date.now() + SESSION_WAIT_MS)) ?? { marked: false, how: null, lost: 'unknown' };
      const unseen = !neverShown.has(tabId) && (!proof.marked || !!woke.unseen);
      markReason = reasonFor(proof, !!woke.unseen);
      if (hasPage(woke) && (unseen || neverShown.has(tabId))) await flipsClear();
      if (hasPage(woke) && mayIntroduce(live, { unseen }) && gen === focusGen && roomToIntroduce()) {
        if (unseen && early) {
          // It has painted on screen before (no arrival cover), but that
          // instant on screen would take a preparation (content/core.js
          // shown()): prepared after it, as a tab never shown is. The early
          // one, started beside the wake (its page answered that, so it's
          // done or nearly), is called off first, and again once it has
          // answered, should it land later (its token isn't the new one's).
          let timer;
          const stale = early;
          await pageStep(Promise.race([stale, new Promise((resolve) => { timer = setTimeout(resolve, UNSEEN_PREPARED_MS); })]));
          clearTimeout(timer);
          cancelPreparation(tabId, { outcome: 'ready', ms: 0, token });
          void stale.then((late) => cancelPreparation(tabId, late));
          early = null;
          prepToken = `${token}:introduced`;
          run.prepToken = prepToken;
        }
        // Arriving covered: out of sight under its cover before that instant
        // (coverArrival), so the paint it asks for is the cover's, quick.
        if (covered && !unseen) await pageStep(coverArrival(live));
        tried = true;
        introduced = await introduceTab(live, gen, { unseen, running: woke.outcome === 'awake' });
        if (introduced && unseen) how = { ...how, unseen: true }; // in the switch log
      } else if (unseen || neverShown.has(tabId)) markReason = `${markReason}:skipped:${!hasPage(woke) ? woke.outcome : gen !== focusGen ? 'left' : introducedBefore(tabId) ? 'introduced already' : windowBusy(live.windowId) ? 'window busy' : 'no room'}`;
    }
    if (tried && !introduced && !markReason?.includes(':skipped:') && (markReason === 'unproven' || markReason === 'never shown' || markReason === 'loaded behind')) markReason = `${markReason}:skipped:not back`;
    const now = tried && !introduced ? await api.tabs.get(tabId).catch(() => null) : null;
    if (now?.active) return inFront(now, { introduced, markReason, ...how });
  } else if (skipIntro && markReason && !markReason.startsWith('proven')) markReason = `${markReason}:skipped:${skipIntro}`;
  run.markReason = markReason;
  if (introduced === null && proofBefore) introduced = false; // (the switch log: not introduced, markReason says why)
  // The preparation's time, within what the page that asked waits (less the
  // show's own): past that the switch would fail as too late. Less for a page
  // that has just loaded behind (PREPARE_LOADED_MS).
  const most = waited ? PREPARE_LOADED_MS : PREPARE_MAX_MS;
  const budget = () => Math.max(0, Math.min(most, showBy() - Date.now()));
  run.stage = 'prepare';
  // Which of the steps run together that change or draw the page answered
  // last: the paint barrier after the preparation means the page has just
  // drawn what the show needs, and nothing else is waited for after it. The
  // wake's answer changes nothing in the page: one after the barrier doesn't
  // call for a second (that took ~66 ms more on most tabs restored behind in
  // the WebKit host). A wake that ran out of time does: the page was too busy
  // to run it, so the barrier's answer is old, and the show would go out in
  // the middle of a task.
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
      if (drawn === 'drawn') drewSince(tabId, at);
      return drawn;
    });
  };
  // Run these together. Preparation itself wakes the isolated world, while
  // wakeTab's page-world hold keeps WebKit's layer tree attached through the
  // subsequent tabs.update. A tab just introduced: its page's paint for that
  // instant landed (paintBarrier), in place of a fixed wait. A tab whose wake
  // didn't answer by WAIT_AWAKE_MAX_MS: nothing more waited for, its
  // preparation called off (above). The preparation sent beside the wake, for
  // a tab not introduced: PREPARE_AWAKE_MS at most once its wake says it's
  // awake (awakeBudget: its own answer, however late). The wake it takes on (a
  // pointer resting on its row, a press) has to hold the process to the show:
  // for that short a preparation, HOLD_LEFT_MS; for any other (a tab never
  // shown, or one cut off: the wait for its repair), a whole one's
  // (SWITCH_HOLD_MS).
  const budgeted = !!early && wake && !capped && !introduced && !waited;
  // (Not for a tab whose wake found no page just now, with nothing loaded
  // since: its scripts would only fail again, each a Safari call, slow on a
  // Safari found slow.)
  const noPageYet = answered?.outcome === 'no page' && !waited && !introduced;
  const woken = wake && !capped ? (noPageYet ? Promise.resolve(/** @type {Wake} */ (answered)) : wakeTab(tabId, { renew: !!introduced || waited, need: budgeted && !cutting ? HOLD_LEFT_MS : SWITCH_HOLD_MS })) : null;
  const prepared = budgeted && woken ? awakeBudget(/** @type {Promise<Preparation>} */ (early), answered ? Promise.resolve(answered) : woken, earlyAt, prepToken) : early;
  const preparing = capped ? null : prepared ?? (wake ? prepareTabForShow(live, { token: prepToken, carry, scroll, covered: covered || waited, budget: budget() }) : /** @type {Promise<Preparation>} */ (Promise.resolve(skipped)));
  run.early = preparing;
  // (All of it the page's own steps: not after a restore cut short, Safari's
  // calls having stalled it, where the slow plan stands.)
  /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
  const onPageUnlessCut = (promise) => (behind === 'cut' ? promise : pageStep(promise));
  /** @type {[Wake | null, Preparation, unknown]} */
  let [woke, preparation] = capped ? [{ outcome: 'timeout', ms: Date.now() - asked, startedAt: asked }, early ? { outcome: 'timeout', ms: Date.now() - asked, reason: 'capped', token: prepToken } : skipped, null] : await onPageUnlessCut(Promise.all([
    woken?.then((w) => { if (w?.outcome !== 'awake') lastStep = 'wake'; return w; }) ?? null,
    step('preparation', /** @type {Promise<Preparation>} */ (preparing)),
    introduced ? step('barrier', barrier(BARRIER_MAX_MS)) : null,
  ]));
  if (trusted && !introduced && woke?.outcome === 'timeout') late = true;
  run.preparation = preparation;
  run.noPage = woke?.outcome === 'no page';
  // A page still running an earlier copy of Margin (it slept through an
  // update or a rebuild): the current copy goes in now, theme and all, and
  // is prepared in what's left of the wait, so the page doesn't show the old
  // copy's sidebar first. Its process is held through that too (a wake taken
  // on for a short preparation may end before).
  const left = () => PREPARE_MAX_MS - (Date.now() - asked);
  if (preparation.outcome === 'not ready' && preparation.reason === 'no current sidebar' && gen === focusGen && left() > 200) {
    lastStep = '';
    if (wake) void wakeTab(tabId, { need: SWITCH_HOLD_MS });
    const added = await Promise.race([addCurrentCopy(live), new Promise((resolve) => setTimeout(() => resolve(false), Math.min(400, left() - 100)))]);
    if (added && gen === focusGen && left() > 50) {
      run.early = prepareTabForShow(live, { token: prepToken, carry, scroll, budget: Math.min(left(), budget()), covered: covered || waited });
      run.preparation = preparation = await run.early;
    }
  }
  if (cutting) {
    let timer;
    const cut = await Promise.race([cutting, new Promise((resolve) => { timer = setTimeout(() => resolve('late'), CUT_OFF_SWITCH_MS); })]);
    clearTimeout(timer);
    // Found not cut off (or with no page to ask: a tab Safari unloaded, then
    // restored behind with this copy), nothing in its page changed: the paint
    // barrier it had stands. After a relaunch every tab not loaded yet is
    // such a suspect, and each restore paid a second barrier for it.
    if (cut !== false) lastStep = '';
  }
  // A tab restored, loading, or shown for the first time (or introduced): the
  // last thing before its show is its page drawing (paintBarrier), so the
  // show goes out in a gap of its main thread rather than behind a task (a
  // show whose paint comes after WebKit's 250 ms hold is Safari's empty view).
  // A tab whose wake answered only once its process was resumed too, or that
  // was kicked awake (`late`: WebKit hid its content as it was suspended,
  // until the page draws again: hideContentUntilPendingUpdate), by
  // WAIT_DRAWN_MAX_MS from the ask; a kicked one BARRIER_KICKED_MS at most (it
  // drew in the window for the kick). A tab whose wake answered in time, its
  // process running (not resumed behind), isn't drawn first at all.
  // So is one a flip of its own went to (an introduction, a kick, a restore:
  // this switch's, or one before it) with no paint of its page since:
  // WebKit hid its content as it came into the window for that instant, and
  // shown before its page draws again (72–237 ms after the flip in Safari's
  // log of 2026-11-03) it skips WebKit's hold.
  const fragile = wake && !capped && hasPage(woke) && ((!!platform?.introduceTabs && (waited || !!introduced || neverShown.has(tabId) || hidePending(tabId))) || late);
  const resumedOnly = late && !introduced && !waited;
  const kickedOnly = resumedOnly && kick?.outcome === 'resumed' && !neverShown.has(tabId);
  run.stage = 'barrier';
  // Its page's own drawing isn't counted against the slow plan (pageStep:
  // focusTab doesn't show it as it is at that plan's end): shown before it
  // draws, it's Safari's empty view. Except after a restore cut short
  // (Safari's calls were what stalled: the slow plan stands). A switch with
  // no page waiting for it (a key, a command): LAYERS_MAX_MS from the ask at
  // most, a tab resumed or kicked WAIT_DRAWN_MAX_MS.
  const layersBy = () => (behind === 'cut' ? showBy() : Math.min(byDeadline, run.forceAt() - FORCE_POLL_MS, timedRun ? Infinity : asked + (resumedOnly ? WAIT_DRAWN_MAX_MS : LAYERS_MAX_MS)));
  // A barrier that ran to its limit (a page too busy to draw by then, or one
  // held back) isn't taken as drawn where a flip of the tab's own is still to
  // be drawn for (hidePending: an introduction, a kick, a restore; WebKit hid
  // its content as it came into the window for that instant, and shown before
  // its page draws again it skips the hold): waited for once more under the
  // cover, one barrier for the rest of LAYERS_EXTRA_MS (a new one each
  // BARRIER_MAX_MS would start its two updates over). Not a tab only resumed
  // behind, with no flip of its own: 23 of 68 such switches ran the barrier to
  // its limit on 2026-11-03 and none was dark (BARRIER_KICKED_MS), so it's
  // shown then, as before. The first for a kicked tab BARRIER_KICKED_MS (it
  // drew in the window for the kick, as a rule).
  if (fragile && gen === focusGen && !(lastStep === 'barrier' && barriers.at(-1)?.how === 'drawn')) {
    // (LAYERS_EXTRA_MS from the first barrier that ran out at most: a page
    // too busy to draw for that long is shown as it is.)
    const ranOut = lastStep === 'barrier' && barriers.at(-1)?.how === 'timeout';
    let timedOutAt = ranOut ? Date.now() : null;
    const extraLeft = () => (timedOutAt == null ? Infinity : timedOutAt + LAYERS_EXTRA_MS - Date.now());
    const again = () => (hidePending(tabId) ? Math.min(layersBy() - Date.now(), extraLeft()) : 0);
    let ms = ranOut ? again() : lastStep === 'barrier' ? 0 /* ('none': it can't run there) */ : Math.min(kickedOnly ? BARRIER_KICKED_MS : BARRIER_MAX_MS, layersBy() - Date.now());
    while (ms > (barriers.length ? BARRIER_RETRY_MIN_MS : 0) && gen === focusGen && !hurry?.()) {
      if ((await onPageUnlessCut(barrier(ms))) !== 'timeout') break;
      timedOutAt ??= Date.now();
      ms = again();
    }
  }
  if (barriers.length) how = { ...how, barrier: barriers };
  // Whether the show waited for its layers (DEVELOPMENT DIAGNOSTICS): its
  // page drew since its wake, flip or kick ('barrier'), or ran out of time for
  // that ('timeout'), or wasn't waited for, and why ('skipped:<why>').
  const lastDrawn = barriers.at(-1)?.how;
  const layersBack = !wake ? 'skipped:no wake' : capped ? 'skipped:capped' : !hasPage(woke) ? `skipped:${woke?.outcome ?? 'no wake'}` : !fragile ? 'skipped:running' : lastDrawn === 'drawn' ? 'barrier' : lastDrawn === 'timeout' ? 'timeout' : lastDrawn === 'none' ? 'skipped:no barrier' : 'skipped:no time';
  // Another switch was asked for while this one waited (back to the tab in
  // front, say): the latest wins.
  if (gen !== focusGen) {
    cancelPreparation(tabId, preparation);
    logSwitch({ wake: woke, preparation, introduced, markReason, layersBack, ...how, error: 'superseded' });
    return { tab: null, preparation, superseded: true };
  }
  if (Number.isFinite(deadline) && Date.now() > deadline - 250) {
    cancelPreparation(tabId, preparation);
    logSwitch({ wake: woke, preparation, introduced, markReason, layersBack, ...how, error: 'expired' });
    throw new Error(TOO_LATE);
  }
  // A timeout only bounds how long the old page stays covered. Stop the late
  // preparation before activating, otherwise it could finish over the live
  // destination and leave a token for some later switch to consume. Its page's
  // arrival cover stays (`keepCover`): lifted now, after the last paint
  // barrier, the show's first paint would be the page's own, maybe heavy and
  // past WebKit's 250 ms hold (Safari's empty view), not the cover's; its
  // show lifts it, as for any page arriving covered. (One cancelled again
  // without it, the switch failing, lifts it then: content/core.js.)
  if (preparation.outcome === 'timeout') cancelPreparation(tabId, preparation, { keepCover: true });
  // A tab Safari unloaded (no page to wake or prepare): its page starts as
  // it's shown and draws Margin before its background has said which tab it
  // is; this says it (content/core.js `showing`).
  if (woke?.outcome === 'no page') await noteShowing(live, { carry, scroll });
  // Shown by focusTab meanwhile (its page's deadline came first).
  if (run.taken) return { tab: null, preparation, superseded: true };
  const fail = (err) => {
    cancelPreparation(tabId, preparation);
    forgetShowing(tabId);
    logSwitch({ wake: woke, preparation, introduced, markReason, layersBack, ...how, error: String(err) });
    throw err;
  };
  const ended = endIntroduction(tabId, gen);
  activating(tabId);
  run.stage = 'show';
  run.sent = true;
  run.sentAt = Date.now();
  const showing = timedCall('tabs.update', api.tabs.update(tabId, { active: true }), tabId);
  run.update = showing.then((t) => ({ tab: t ?? null }), (err) => ({ err }));
  const tab = await showing.catch(fail);
  run.stage = 'shown';
  // Safari can answer without having brought the tab to the front: checked,
  // and asked once more. A switch that didn't happen says so (the page shows
  // it, instead of its highlight going back as if nothing was asked).
  if (!(await isInFront(tabId, tab))) {
    if (gen !== focusGen) return { tab: null, preparation, superseded: true }; // another switch took the front meanwhile
    if (Number.isFinite(deadline) && Date.now() > deadline - 250) fail(new Error(TOO_LATE));
    activating(tabId);
    await api.tabs.update(tabId, { active: true }).catch(fail);
    if (!(await isInFront(tabId))) fail(new Error(`Safari didn't bring tab ${tabId} to the front`));
  }
  // In the window with its page there (it answered its wake, or drew since):
  // proven to have WebKit's mark from here (above).
  if (woke?.outcome === 'awake' || lastDrawn === 'drawn') prove(tabId, 'shown');
  logSwitch({ wake: woke, preparation, introduced, markReason, layersBack, ...how, shownAfter: Date.now() - asked });
  if (ended?.lateTab) void hooks.activated?.({ tabId, windowId: live.windowId }); // as in focusTab
  run.stage = 'window';
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
// `deadline`: a switch's (when its page stops waiting). Safari's tabs.get can
// wait on the tab's hung process (2026-11-03): past RESOLVE_LEAVES_MS before
// it, the tab as Margin's state has it stands in, so the switch itself
// starts with time left to show it (focusTab), rather than its page being
// told it didn't happen. A tab Margin's own state has (its tabs matched to
// the open ones) isn't waited for that long: RESOLVE_KNOWN_MS, then the
// switch starts from Margin's record, and its own look at the tab (the same
// question to Safari, still under way: lookupTab) says if it's gone. After a
// reboot (load average 74, 2026-11-03) Safari took 2.3–3.3 s to answer, and
// every switch started with that much of its page's 7 s gone.
const RESOLVE_LEAVES_MS = 2000;
const RESOLVE_KNOWN_MS = 150;
/** @param {number} tabId @param {{ url?: string, index?: number, title?: string, from?: { origin?: string, since?: number, synced?: boolean } | null } | null | undefined} hint @param {number | null | undefined} preferWindow @param {{ deadline?: number }} [options] */
export async function resolveTab(tabId, hint, preferWindow, { deadline } = {}) {
  const me = thisCopy();
  const ours = !hint || ('from' in hint ? hint.from?.origin === me.origin && (hint.from.since == null || hint.from.since === me.since) && hint.from.synced !== false : true);
  let live = null;
  if (Number.isInteger(tabId) && ours) {
    const asking = lookupTab(tabId);
    const timedAsk = Number.isFinite(deadline);
    const known = timedAsk && isSynced() ? cached()?.tabs[tabId] ?? null : null;
    const answered = known ? await answerBy(asking, Date.now() + RESOLVE_KNOWN_MS) : timedAsk ? await answerBy(asking, /** @type {number} */ (deadline) - RESOLVE_LEAVES_MS) : await asking;
    if (!answered && !known) console.warn(`[margin] Safari hasn't said where tab ${tabId} is in time: switching to it as Margin last saw it`);
    live = answered ? answered.tab : (known ?? cached()?.tabs[tabId] ?? null);
  }
  if (live || !hint?.url) return live;
  const key = M.normalizeUrl(hint.url);
  const nearest = (/** @type {any[]} */ tabs) => {
    let candidates = tabs.filter((t) => M.normalizeUrl(t.url || t.pendingUrl || '') === key);
    // The same page open twice: the one with the row's title, if that tells them apart.
    if (candidates.length > 1 && hint.title && candidates.some((t) => t.title === hint.title)) candidates = candidates.filter((t) => t.title === hint.title);
    if (!candidates.length) return null;
    const distance = (t) => (t.windowId === preferWindow ? 0 : 1e6) + Math.abs((t.index ?? 0) - (hint.index ?? 0));
    return candidates.reduce((best, t) => (distance(t) < distance(best) ? t : best));
  };
  // Margin's own tabs first, once they're this copy's (matched to the open
  // tabs): no round trip to Safari before the switch. Safari's list only if
  // they have no such tab, or before the first sync; by RESOLVE_LEAVES_MS
  // before the deadline at the latest (it can wait behind Safari's other
  // calls, as after a relaunch: 2026-11-03). Not the tab Safari just said is
  // gone: Margin's state can have it still (its onRemoved not handled yet).
  let found = isSynced() ? nearest(Object.values(cached()?.tabs ?? {}).filter((t) => !(ours && t.id === tabId))) : null;
  if (!found) {
    // (The first sync's own question, if it's under way: store.js openTabsAsked.)
    /** @type {Promise<any[]>} */
    const asking = openTabsAsked().catch(() => []);
    const open = Number.isFinite(deadline) ? await answerBy(asking, /** @type {number} */ (deadline) - RESOLVE_LEAVES_MS) : await asking;
    if (!open) throw new Error('Safari didn\'t say which tabs are open in time');
    found = nearest(open);
  }
  if (!found) return null;
  console.info(`[margin] tab ${tabId} isn't one this copy of Margin knows: switching to tab ${found.id}, at the same address`);
  return found;
}

// Safari's answer to where a tab is, one question at a time per tab: a
// switch's lookup (resolveTab) and its own look at the tab (focusTabNow) share
// it, so a Safari slow to answer isn't asked twice in a row, the second
// queued behind the first. Timed (slow.js). One unanswered for
// LOOKUP_REUSE_MS (a tab's hung process) isn't shared: the next switch to
// the tab asks again, not shown as it is for good behind a question that
// never answers.
const LOOKUP_REUSE_MS = 3000;
/** @type {Map<number, { asking: Promise<{ tab: any }>, at: number }>} */
const lookups = new Map();
/** @param {number} tabId @returns {Promise<{ tab: any }>} */
function lookupTab(tabId) {
  const under = lookups.get(tabId);
  if (under && Date.now() - under.at < LOOKUP_REUSE_MS) return under.asking;
  /** @type {Promise<{ tab: any }>} */
  const asking = timedCall('tabs.get', Promise.resolve().then(() => api.tabs.get(tabId)), tabId).then((tab) => ({ tab: tab ?? null }), () => ({ tab: null }));
  lookups.set(tabId, { asking, at: Date.now() });
  void asking.then(() => { if (lookups.get(tabId)?.asking === asking) lookups.delete(tabId); });
  return asking;
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
// Tabs where a script found no page (inPage: 'asleep'): not asked again by
// the open-tab repair (runOpenTabRepair), nor taken as cut off, until the
// tab is shown (tabShown) or a tab event says its page changed (background.js:
// its status or address).
/** @type {Set<number>} */
const noPageFound = new Set();
/** @param {number} tabId */
export function pageChanged(tabId) {
  noPageFound.delete(tabId);
}
// Runs `func` in the tab's page (Margin's content-script world). 'asleep'
// when it can't run because there's no page (WebKit: no web view; a tab
// Safari unloaded), 'unknown' when Margin has no access or no answer came
// within `ms` (a busy page), else { result }. Messages to content scripts
// aren't used for this: after Margin is reinstalled or updated, WebKit can
// stop delivering them to pages that were open (their listeners stay with
// the old copy), while executeScript keeps working. A view with no page yet
// (WebKit answers with an error in place of a result) is 'asleep' too. A tab
// found so is remembered (noPageFound). The permission is asked once per
// site (mayAccessCached): after a relaunch every probe asked it again.
export async function inPage(tabId, url, func, args = [], ms = 300) {
  if (!api.scripting?.executeScript || !(await mayAccessCached(url))) return 'unknown';
  let timer;
  const answer = await Promise.race([
    api.scripting.executeScript({ target: { tabId }, func, args }).then((r) => (ranAtAll(r) ? { result: r?.[0]?.result } : 'asleep'), () => 'asleep'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('unknown'), ms); }),
  ]);
  clearTimeout(timer);
  if (answer === 'asleep') {
    noPageFound.add(tabId);
    lose(tabId, 'no page');
  }
  return answer;
}

// `deadline`: when the page that asked stops waiting (it's then told it
// didn't happen: background.js): no tab opens past REFUSE_MS before it.
/** @param {{ windowId?: number, url?: string, spaceId?: string, deadline?: number }} options */
export async function openTab({ windowId, url, spaceId, deadline }) {
  tooLate(deadline);
  focusGen++; // a switch still waiting for its wake doesn't land after this
  movedOn(windowId);
  markMarginOpening();
  // In its space from the start: the window shows that space before the tab
  // exists, so the browser's events for it (created, activated) already put
  // it there, instead of in the space shown before and then moving it (the
  // window could stay on the other one).
  if (spaceId && windowId != null) await mutate((s) => M.setActiveSpace(s, windowId, spaceId));
  tooLate(deadline);
  const tab = await api.tabs.create({ windowId, url, active: true });
  if (spaceId) await mutate((s) => M.moveTab(M.upsertTab(s, tab, now()), tab.id, spaceId));
  return tab;
}

// Tabs never in front since they opened (behind the page: a new tab from the
// palette, a ⌘-clicked link). Shown for the first time, such a tab can't keep
// the page before on screen while it paints (WebKit does that only for a
// view that has been in a window): it's introduced first (below), and
// arrives covered too (content/core.js arriveCovered). This background's own
// knowledge (what a later one knows of them is WebKit's mark, below: not
// proven).
const neverShown = new Set();
export function tabOpened(tab) {
  if (!Number.isInteger(tab?.id)) return;
  // A new web view: never in a window with its page running yet (one opened
  // in front went into the window before its process started).
  if (!tab.active) neverShown.add(tab.id);
  lose(tab.id, tab.active ? 'opened in front' : 'opened behind', { outFromStart: !tab.active });
}
export function tabShown(tabId) {
  neverShown.delete(tabId);
  introduced.delete(tabId);
  resumedBehind.delete(tabId);
  kickedAt.delete(tabId);
  forgetWake(tabId); // its hold ended as it was shown
  noPageFound.delete(tabId); // it loads as it's shown, if it had none
}
// The tab closed: whatever is known of it goes (background.js onRemoved).
/** @param {number} tabId */
export function tabClosed(tabId) {
  tabShown(tabId);
  leftAtOrder.delete(tabId);
  backAtOrder.delete(tabId);
  flippedAt.delete(tabId);
  drawnAfter.delete(tabId);
  void withMark(tabId, () => null);
}
// Its page says it has come into view from hidden (pageThere 'seen'), with
// no word of which page that is or when: it counts as the page's word that it
// came into view (inView, below) only where its tab was out of the window
// from that page's start (behind since it opened, or loaded there), or was
// heard left and back after that page's hello (a page in front also goes
// hidden and comes back as its window is covered and uncovered, minimized, or
// on another Space, and WebKit marks a tab only as it enters a window: in
// Tirth's Safari on 2026-11-03 a tab restored in front at the relaunch was
// covered and uncovered, activity state 30 to 58 and back, before it was
// first left, and its first return showed 420 ms of Safari's empty view).
/** @param {number} tabId */
function sawInWindow(tabId) {
  neverShown.delete(tabId);
  void withMark(tabId, (rec) => (rec && rec.out != null ? proveIf({ ...rec, inView: Math.max(rec.inView ?? -Infinity, rec.out) }) : undefined));
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
// The same for any tab Margin has no proof WebKit has seen come into the
// window while it had a process (WebKit's mark, below): the tab in front at a
// launch, one Safari loaded as it was shown (its view went into the window
// before its process existed, and WebKit sets its "was in a window" mark only
// from a change it dispatches to a running process), one the warm-up or a
// restore loaded behind, one Margin knows nothing of. Its first return showed
// Safari's empty view until it painted (four shows of 49–155 ms in Tirth's
// log; 40–87 ms in the host, none with an introduction first; five of 25–63
// ms on 2026-11-03, tabs Margin then took as marked). Not a page that
// navigated in front in a tab WebKit had seen (a link, the address bar):
// WebKit's mark stays with the tab's web view, and introduced, such a return
// took 80 ms in the host against 10. A Back in front, or a tab opened in front
// whose page had a process already, is introduced once more than needed: an
// instant flip and a moment.
// Off for the rest of the Safari session (storage.session) if Safari leaves
// the tab in front instead, or the page in front was hidden for an instant
// (the two updates took two turns: pageBlinked).
const introduced = new Set(); // tabs introduced since they were last shown

// ---- WebKit's mark: a tab seen come into a window with its page running ------
// WebKit keeps the page before on screen as a tab is shown (it holds Safari's
// window up to 250 ms for the tab's first paint) only for a tab whose view has
// come into a window while its page's process ran: m_viewWasEverInWindow in
// WebPageProxy::dispatchActivityStateChange, set only by a change into the
// window dispatched to a running process, and never cleared. It's the web
// view's: kept through the tab's navigations, process swaps and crashes, gone
// only with the web view itself, when Safari unloads the tab and later makes it
// afresh (as it's selected, or restored behind the page). Safari's log of
// 2026-11-03 matched it to the screen frame by frame: 22 of 22 switches to a
// marked tab with its layers attached held with no dark frame, 34 of 34 others
// were dark for 5–1046 ms. Until then Margin took a tab as marked unless it
// had a reason to doubt it (never shown since it opened, a page that said it
// started unseen, the warm-up's mark), and 5 of its 16 switches that day went
// to tabs it had no doubt about and weren't marked (Safari had restored them as
// they were selected, or the warm-up had loaded them behind), each 25–63 ms of
// Safari's empty view (DECISIONS.md, 2026-11-03). So it's the other way round
// now: a tab counts as marked only once Margin has proof, and is introduced
// before Margin first shows it otherwise (an introduction a tab didn't need
// costs a hold under the cover, at most 250 ms, about 0.3–0.4 s on its first
// return). The proof (`how`):
//  - 'introduced', 'kicked': Margin's own flip of the tab (introduceTab, a
//    kick) with its page answering;
//  - 'shown': Margin's own show of it with its page answering its wake just
//    before (focusTabNow, a key passing through: navigation.js);
//  - 'inView': its page's word that it came into view from hidden (content/
//    core.js 'inView', or its wake's 'seen'), after its tab was known out of
//    the window during that page's life: it started out of it (`outHow`
//    'start': loaded behind, opened behind), or was heard left after the
//    page's hello and back after that ('left': in front, a page goes hidden
//    and comes back for its window too, sawInWindow above).
// Lost (lose) as Safari may have made the tab a new web view: a page made from
// the tab's saved history, or a tab's first page (content/core.js `made`,
// from a copy that started with its document: one put in later can't say),
// a page saying it started visible that way and hasn't come into view since
// (`unseen`), a script finding no page (Safari unloaded it), the tab restored
// behind, opened, or discarded. A Back in front (also made from the tab's
// history) loses it too: one flip more than needed. A tab Margin knows
// nothing of (it opened before this copy, no page of it has said hello
// since) isn't marked. In storage.session (`inWindowTabs`): it ends with the
// Safari session and with the copy (store.js: a new copy has a new `since`,
// and new tab ids: safari-tab-ids), and a background Safari stops when idle
// starts again within it. Each record says which copy wrote it (`copy`,
// store.js thisCopy().since): one from another copy is ignored.
/** @typedef {'introduced' | 'kicked' | 'shown' | 'inView' | 'test'} MarkHow */
/** @typedef {{ marked: boolean, how: MarkHow | null, lost: string | null, doc: string | null, out: number | null, outHow: 'start' | 'left' | null, back: number | null, inView: number | null, copy: number, provenAt?: number }} MarkRecord `provenAt`: when it was proven (a place in the order below: a page whose hello came before that doesn't undo it); `doc`: its page's own id (its hello); `out`: when its tab was known out of the window during that page's life (a place in the order of activations and pages' words: activationsHeard), `back`: its activation heard after that, `inView`: its page's word that it came into view, heard after `out`; `lost`: why it was last taken as not marked (the switch log) */
const MARKS_KEY = 'inWindowTabs';
/** @type {Promise<Map<number, MarkRecord>> | null} */
let marks = null;
// For tests: a tab Margin knows nothing of counts as marked, as every tab did
// before (the tests of switches written before this; their own of the proof
// turn it off).
let unknownMarked = false;
/** @param {boolean} on */
export function assumeMarkedForTests(on) {
  unknownMarked = on;
}
// A place in the order is a clock reading, so the records a background before
// this one left can be ahead of this one's own (the Mac's clock set back
// since: an NTP step after sleep, a change by hand). Such records are moved
// back, all by the same amount, to just before this background's first place
// (`startOrder`): their order among themselves stays, and whatever this one
// heard comes after them, as it did (otherwise a new page's hello would sort
// before a proof of the web view before it, and keep it).
const ORDER_FIELDS = /** @type {const} */ (['out', 'back', 'inView', 'provenAt']);
const startOrder = Date.now() * 1000;
/** @param {MarkRecord[]} records */
function rebaseOrder(records) {
  let latest = -Infinity;
  for (const rec of records) for (const field of ORDER_FIELDS) if (Number.isFinite(rec[field])) latest = Math.max(latest, /** @type {number} */ (rec[field]));
  if (!(latest >= startOrder)) return;
  const shift = latest - startOrder + 1;
  for (const rec of records) for (const field of ORDER_FIELDS) if (Number.isFinite(rec[field])) rec[field] = /** @type {number} */ (rec[field]) - shift;
}
const marksMap = () => (marks ??= Promise.resolve().then(() => api.storage.session?.get(MARKS_KEY)).then((stored) => {
  const copy = thisCopy().since;
  /** @type {Map<number, MarkRecord>} */
  const map = new Map();
  const saved = stored?.[MARKS_KEY]?.tabs;
  if (Array.isArray(saved)) for (const [id, rec] of saved) if (Number.isInteger(id) && rec && typeof rec === 'object' && (!copy || !rec.copy || rec.copy === copy)) map.set(id, { ...rec });
  rebaseOrder([...map.values()]);
  return map;
}, () => new Map()));
let marksDue = false;
let marksEpoch = 0; // (for tests: a write due from before resetMarksForTests isn't made)
/** @param {Map<number, MarkRecord>} map */
function saveMarks(map) {
  if (marksDue) return;
  marksDue = true;
  const epoch = marksEpoch;
  queueMicrotask(() => {
    marksDue = false;
    if (epoch !== marksEpoch) return;
    void Promise.resolve().then(() => api.storage.session?.set({ [MARKS_KEY]: { tabs: [...map] } })).catch(() => {});
  });
}
// For tests: nothing known of any tab's mark, in storage.session too.
export function resetMarksForTests() {
  marksEpoch++;
  marksDue = false;
  marks = Promise.resolve(new Map());
  lastHeard.clear();
  leftAtOrder.clear();
  backAtOrder.clear();
  flippedAt.clear();
  drawnAfter.clear();
  void Promise.resolve().then(() => api.storage.session?.set({ [MARKS_KEY]: { tabs: [] } })).catch(() => {});
}
/** @returns {MarkRecord} */
const blankMark = () => ({ marked: false, how: null, lost: null, doc: null, out: null, outHow: null, back: null, inView: null, copy: thisCopy().since });
// The tab's record changed by `change` (its record, or undefined if there's
// none): a new one, null to forget it, undefined to leave it. In the order
// asked (one map, read once per background).
/** @param {number} tabId @param {(rec: MarkRecord | undefined) => MarkRecord | null | undefined} change */
function withMark(tabId, change) {
  if (!platform?.introduceTabs || !Number.isInteger(tabId)) return Promise.resolve();
  return marksMap().then((map) => {
    const before = map.get(tabId);
    const after = change(before);
    if (after === undefined || after === before) return;
    if (after === null) {
      if (before) map.delete(tabId);
    } else map.set(tabId, { ...after, copy: thisCopy().since || after.copy || 0 });
    saveMarks(map);
  }).catch(() => {});
}
// What Margin knows of the tab's mark: whether it's proven, how, and why it
// was last lost.
// (`doc`: the page that last said hello there, null if none has.)
/** @param {number} tabId @returns {Promise<{ marked: boolean, how: MarkHow | null, lost: string | null, doc: string | null }>} */
const markOf = (tabId) => (!platform?.introduceTabs ? Promise.resolve({ marked: true, how: null, lost: null, doc: null }) : marksMap().then((map) => {
  const rec = map.get(tabId);
  return rec ? { marked: !!rec.marked, how: rec.how ?? null, lost: rec.lost ?? null, doc: rec.doc ?? null } : { marked: unknownMarked, how: unknownMarked ? 'test' : null, lost: null, doc: null };
}, () => ({ marked: false, how: null, lost: 'unknown', doc: null })));
/** @param {number} tabId @param {MarkHow} how */
function prove(tabId, how) {
  const at = activationsHeard();
  void withMark(tabId, (rec) => ({ ...(rec ?? blankMark()), marked: true, how, lost: null, provenAt: at }));
}
// Taken as not marked (a new web view, maybe: above). `outFromStart`: its
// tab is out of the window as its page starts (opened, or restored, behind).
// An introduction it had since it was last shown was for the web view before
// (a switch superseded after it): no longer counts, it's introduced again.
/** @param {number} tabId @param {string} why @param {{ outFromStart?: boolean }} [options] */
function lose(tabId, why, { outFromStart = false } = {}) {
  introduced.delete(tabId);
  const at = activationsHeard();
  void withMark(tabId, (rec) => ({ ...blankMark(), lost: why, ...(outFromStart ? { out: at, outHow: 'start' } : {}), doc: rec?.doc ?? null }));
}
// Its page says it started visible in a tab made afresh and hasn't come into
// view from hidden since (pageThere 'unseen'): not marked, whatever Margin
// knew; the rest of what's known of it stands.
/** @param {number} tabId @param {string} why */
function doubt(tabId, why) {
  void withMark(tabId, (rec) => (rec ? (rec.marked ? { ...rec, marked: false, how: null, lost: why } : undefined) : { ...blankMark(), lost: why }));
}
// Proven by its page's word once its tab was known out of the window and, if
// it was in front as its page started, back since (above).
/** @param {MarkRecord} rec @returns {MarkRecord} */
const proveIf = (rec) => (!rec.marked && rec.out != null && rec.inView != null && rec.inView >= rec.out && (rec.outHow === 'start' || (rec.back != null && rec.back > rec.out)) ? { ...rec, marked: true, how: 'inView', lost: null, provenAt: activationsHeard() } : rec);
// Activations, pages' hellos and their word that they came into view, in the
// order they reach this background (background.js, as each comes, before any
// wait): a page's hello is handled after the ownership check, an activation
// once the state is read, so a hello can be handled after its tab was left and
// came back. A place in that order is a clock reading (µs), so a background
// started again goes on after the one before (its records in storage.session).
let lastOrder = 0;
/** A place in the order now (a hello's or a page's word as it came: background.js). */
export const activationsHeard = () => (lastOrder = Math.max(lastOrder, Date.now() * 1000));
const nextOrder = () => (lastOrder = Math.max(lastOrder + 1, Date.now() * 1000));
/** @type {Map<number, { tabId: number, at: number }>} */
const lastHeard = new Map(); // windowId → its last activation heard
/** @type {Map<number, number>} */
const leftAtOrder = new Map(); // tabId → its last leave heard (another tab's activation in its window just after its own)
/** @type {Map<number, number>} */
const backAtOrder = new Map(); // tabId → its last activation heard
/** background.js: a tab's activation, as it comes (not an introduction's). @param {{ tabId: number, windowId: number }} info */
export function heardActivation({ tabId, windowId }) {
  const at = nextOrder();
  // The tab left: the one heard in front before, or, for this background's
  // first in the window, the one Margin's state has there.
  const left = lastHeard.get(windowId)?.tabId ?? Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active && t.id !== tabId)?.id ?? null;
  lastHeard.set(windowId, { tabId, at });
  if (left != null && left !== tabId) {
    leftAtOrder.set(left, at);
    void withMark(left, (rec) => (rec && rec.out == null ? { ...rec, out: at, outHow: 'left', back: null } : undefined));
  }
  backAtOrder.set(tabId, at);
  void withMark(tabId, (rec) => (rec && rec.out != null && at > rec.out ? proveIf({ ...rec, back: at }) : undefined));
}
// A page has started in the tab (its hello). `doc`: the page's own id;
// `fresh`: its copy of Margin started with it; `made`: it was made from the
// tab's saved history, or is a tab's first page; `unseen`: it started visible
// that way and hasn't come into view from hidden since (content/core.js
// windowSeen); `active`: its tab in front as it said so (Safari's sender);
// `heard`: its place in the order as its hello came (activationsHeard).
/** @param {number | null | undefined} tabId @param {{ unseen?: boolean, heard?: number | null, doc?: string | null, fresh?: boolean, made?: boolean, active?: boolean | null }} [page] */
export function pageStarted(tabId, { unseen = false, heard: at = null, doc = null, fresh = false, made = false, active = null } = {}) {
  if (!platform?.introduceTabs || !Number.isInteger(tabId)) return;
  const id = /** @type {number} */ (tabId);
  const hello = at ?? activationsHeard();
  const anew = unseen || (fresh && made);
  // Out of the window as it started, or heard left since (its hello handled
  // late), and back after that.
  const left = leftAtOrder.get(id);
  const out = active === false ? hello : left != null && left > hello ? left : null;
  const back = backAtOrder.get(id);
  void withMark(id, (rec) => {
    // (A proof that came after this hello, its handling late: this page's
    // own web view was proven, Margin having flipped or shown it running.)
    const after = !!rec?.marked && (rec.provenAt ?? -Infinity) > hello;
    const kept = anew && !after ? { marked: false, how: null, lost: unseen ? 'started unseen' : 'made afresh' } : rec ? { marked: rec.marked, how: rec.how, lost: rec.lost, ...(rec.provenAt != null ? { provenAt: rec.provenAt } : {}) } : { marked: unknownMarked, how: unknownMarked ? /** @type {MarkHow} */ ('test') : null, lost: null };
    return { ...blankMark(), ...kept, doc: typeof doc === 'string' ? doc : null, out, outHow: out == null ? null : active === false ? 'start' : 'left', back: out != null && back != null && back > out ? back : null };
  });
}
// Its page says it has come into view from hidden (content/core.js 'inView':
// `doc`, its own id; `heard`, its place in the order as it came).
// Whether its tab is proven now with this page in it (its page needn't say so again).
/** @param {number | null | undefined} tabId @param {{ doc?: string | null, heard?: number | null }} [word] @returns {Promise<boolean>} */
export async function pageInView(tabId, { doc = null, heard: at = null } = {}) {
  if (!Number.isInteger(tabId) || !platform?.introduceTabs) return false;
  const id = /** @type {number} */ (tabId);
  const when = at ?? activationsHeard();
  await withMark(id, (rec) => (rec && rec.doc != null && rec.doc === doc && rec.out != null && when >= rec.out ? proveIf({ ...rec, inView: Math.max(rec.inView ?? -Infinity, when) }) : undefined));
  const rec = await marksMap().then((map) => map.get(id), () => undefined);
  return !!rec?.marked && rec.doc != null && rec.doc === doc;
}
// A held key passing through tabs (navigation.js) shows each in passing,
// with no introduction and no paint first: only a tab Margin has proof of
// (WebKit's mark), whose wake found it running (not resumed just then, no
// flip of its own still to draw for: its layers attached). Any other is
// passed over (the highlight moves on): shown, it would be Safari's empty
// view until it painted (two warmed tabs on 2026-11-03, 47 and 63 ms). A site
// Margin can't reach is shown as before (nothing could prepare it).
/** @param {number} tabId @param {Wake | null} woke @returns {Promise<boolean>} */
export async function passable(tabId, woke) {
  if (!platform?.introduceTabs || woke?.outcome === 'no access') return true;
  if (woke?.outcome !== 'awake' || woke.unseen || neverShown.has(tabId) || resumedBehind.has(tabId) || hidePending(tabId)) return false;
  return (await markOf(tabId)).marked;
}
// A held key showed it in passing, its page running (passable): proven.
/** @param {number} tabId */
export function shownInPassing(tabId) {
  if (platform?.introduceTabs) prove(tabId, 'shown');
}
// Safari says the tab was discarded (background.js): a new web view as it's
// shown.
/** @param {number} tabId */
export function pageDiscarded(tabId) {
  lose(tabId, 'discarded');
}
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
/** @typedef {{ from: number, until: number, frontId?: number }} Span when an introduction's updates were sent, and when it ended (its real switch sent, or over); `frontId`: the page in front it brought back */
/** @typedef {{ tabId: number, gen: number, frontId: number | null, frontMark: number, expected: number[], seen: Activation[], answered: boolean, lateTab: boolean, taken?: boolean, span: Span | null, done: Promise<void>, settled: () => void, kick: boolean }} Introduction `done`: once Safari has answered its updates, or it's over; `taken`: a forced show ended it before Safari had answered them; `kick`: a switch's kick (forwardAndBack) */
/** @type {Map<number, Introduction>} */
const introductions = new Map();
// One a forced show ended (focusTab) before Safari had carried out its
// updates: its activations, still to come, left out as they come, ahead of
// the show's own (Safari carries out updates in order), until shortly after
// Safari answers them.
/** @type {Map<number, Introduction>} */
const lingering = new Map();
const LINGER_MS = 500;
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
  const left = lingering.get(info.windowId);
  const pending = left?.expected.length ? left : introductions.get(info.windowId);
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
/** @param {number} tabId @param {number} gen @param {{ linger?: boolean }} [options] */
function endIntroduction(tabId, gen, { linger = false } = {}) {
  for (const [windowId, pending] of introductions) {
    if (pending.tabId !== tabId || pending.gen !== gen) continue;
    introductions.delete(windowId);
    if (linger && !pending.answered) {
      pending.taken = true;
      if (pending.expected.length) lingering.set(windowId, pending);
    }
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
// from hidden since, or Margin has no proof of WebKit's mark (below: one
// still loading too, its page there: shown as it is it would be Safari's empty
// view until it paints); once per tab until it's shown.
const introducedBefore = (/** @type {number} */ tabId) => introduced.has(tabId);
const noteIntroduced = (/** @type {number} */ tabId) => void introduced.add(tabId);
/** @param {any} tab the tab as the browser has it @param {{ loading?: boolean, unseen?: boolean }} [options] */
const mayIntroduce = (tab, { loading = false, unseen = false } = {}) => !!platform?.introduceTabs && (neverShown.has(tab.id) || unseen) && !introduced.has(tab.id) && (tab.status === 'complete' || loading || unseen) && !windowBusy(tab.windowId);
/**
 * Whether the tab was introduced. `gen`: the switch it's for (not if another
 * was asked for meanwhile). `loading`, `unseen`: as mayIntroduce's.
 * `running`: its page has just answered (a script ran there): its process ran
 * as it came into the window, so it's proven to have WebKit's mark (below).
 * @param {any} tab @param {number} gen @param {{ loading?: boolean, unseen?: boolean, running?: boolean }} [options] @returns {Promise<boolean>}
 */
async function introduceTab(tab, gen, { loading = false, unseen = false, running = false } = {}) {
  if ((await isOff()) || !mayIntroduce(tab, { loading, unseen })) return false;
  const back = await forwardAndBack(tab, gen, () => { introduced.add(tab.id); });
  if (back && running) prove(tab.id, 'introduced');
  return back;
}
// The tab to the front and the page in front straight back, in one run loop
// turn (above). Whether the page in front is back; `sending()` just before
// the updates go out. `kick`: a switch's kick (focusTabNow), not an
// introduction or a restore: another switch doesn't wait for it before its wake.
// `stop()`: the warm-up's (warmTab), looked at once more just before the
// updates go out: true, and nothing is sent.
/** @param {any} tab @param {number} gen @param {() => void} [sending] @param {{ kick?: boolean, stop?: (() => boolean) | null }} [options] @returns {Promise<boolean>} */
async function forwardAndBack(tab, gen, sending = () => {}, { kick = false, stop = null } = {}) {
  const windowId = tab.windowId;
  let settled = () => {};
  /** @type {Promise<void>} */
  const done = new Promise((resolve) => { settled = () => resolve(); });
  /** @type {Introduction} */
  const pending = { tabId: tab.id, gen, frontId: null, frontMark: 0, expected: [], seen: [], answered: false, lateTab: false, span: null, done, settled, kick };
  introductions.set(windowId, pending); // one at a time per window
  const release = () => {
    if (introductions.get(windowId) === pending) introductions.delete(windowId);
    if (pending.span) pending.span.until = Math.min(pending.span.until, Date.now());
    settled();
  };
  // The page in front as Margin has it too: a switch Safari made that Margin
  // hasn't heard of yet (its event on its way) isn't undone.
  const known = Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active)?.id;
  const [front] = await timedCall('tabs.query', api.tabs.query({ active: true, windowId }), tab.id).catch(() => []);
  // (Not once it was ended meanwhile: its switch went on without it, out of
  // time, and has shown the tab, or is about to: endIntroduction.)
  if (!front || front.id === tab.id || front.id !== known || gen !== focusGen || introductions.get(windowId) !== pending || stop?.()) {
    release();
    return false;
  }
  Object.assign(pending, { frontId: front.id, expected: [tab.id, front.id] });
  sending();
  // Not the tab itself marked as Margin's activation: a switch (this one) is
  // under way for it (isFocusing), and once it's over, a switch to it is the
  // user's. The page in front is, until its activation is seen.
  pending.frontMark = activating(front.id);
  pending.span = { from: Date.now(), until: Infinity, frontId: front.id };
  lastSpan.set(windowId, pending.span);
  // (Timed: a Safari slow to carry out a flip is slow for its switch, slow.js.)
  await Promise.allSettled([timedCall('tabs.update', api.tabs.update(tab.id, { active: true }), tab.id), timedCall('tabs.update', api.tabs.update(front.id, { active: true }), tab.id)]);
  pending.answered = true;
  flippedAt.set(tab.id, Date.now()); // its content hidden until its page draws again (hidePending)
  resumedBehind.delete(tab.id); // in the window for that instant: visible, and drawn for it
  settled();
  void hooks.introduced?.(tab.id);
  // Its switch showed the tab meanwhile, out of time (focusTab): the front
  // is that show's, nothing of this one's to tell.
  if (pending.taken) {
    setTimeout(() => { if (lingering.get(windowId) === pending) lingering.delete(windowId); }, LINGER_MS);
    return false;
  }
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

// ---- a tab whose process Safari suspended --------------------------------------
// A script reaches a suspended process only once WebKit has resumed it, and
// for an extension's script (executeScript asks for the tab's frames first)
// it resumes it at background priority only: under swap, a median 710 ms
// (p90 3.6 s) in Tirth's Safari. WebKit hid the tab's content as it was
// suspended (WebProcessProxy::sendPrepareToSuspend →
// hideContentUntilPendingUpdate), and shown before its page draws again it's
// Safari's empty view. So a switch to a tab that may be suspended (mayWait:
// at rest, not held by keep-ready) waits for its wake's own
// answer, however late (wakeAnswer), with the page before on screen: covered
// by the switch's own cover (the sidebar's or the palette's, a key's after
// 150 ms: shared/switching.js), or by coverFront after COVER_AFTER_MS for a
// switch whose page doesn't cover itself. A wake answered past RESUMED_MS
// was a process resumed just then (resumedBehind; a running one answers in a
// median 17–40 ms): its preparation, just behind the wake, then its page's
// drawing (paintBarrier) come before the show, by WAIT_DRAWN_MAX_MS from the
// ask. In Tirth's Safari, tabs woken that way before their show, then shown
// after a paint barrier, came up clean in 25 of 29 cases (2026-11-02). A wake
// with no answer by WAIT_AWAKE_MAX_MS: the tab is shown as it is (its show's
// own foreground resume takes a median 32–53 ms, then its paint), its
// preparation called off (`capped` in the switch log). Another switch, or a
// key press after it (`hurry`), ends the wait at once. The wake starts early
// where it can: a pointer resting on a row or a space's icon, a press, the
// sidebar coming out, a swipe toward a space (sidebar.js), a key run's next
// tab (navigation.js), each once (wakeTab's `by`, in the switch log).
// A background resume is slow (a median 436 ms, p90 1.7 s in Tirth's Safari
// on 2026-11-03), a foreground one quick (the page drawn a median 110 ms
// after it). So a tab whose wake hasn't answered KICK_AFTER_MS after its
// scripts went out (KICK_SOON_MS for one likely suspended: hidden
// SUSPEND_LIKELY_MS or more) is kicked, once, inside the wait: brought to the
// front and the page in front straight back (forwardAndBack, as an
// introduction, but not counted as one), for the foreground resume its view
// coming into the window takes. Its wake stands (its scripts reach the page
// behind that resume, so its answer comes first): only its hold is sent
// again (that instant in the window ended it). It's prepared afresh under a
// token of its own, and drawn before it's shown, the page before on screen
// all along: nothing is shown before the wake's answer but at the cap, as
// without a kick (`kicked` in the switch log). One that answered within
// RESUMED_MS of its scripts going out was running after all: shown as any
// awake tab, not drawn first. The kick was taken out on 2026-11-03 as
// showing the other tab for 11–148 ms; Safari's own log of the same day says
// such a flip never reaches the screen: in 55 flips (introductions and
// restores) the page in front never left its window, went hidden or lost
// focus, and the first frame Safari committed came 23–51 ms after it was
// back; nor in 7 flips of tabs that had been in a window (a never-shown mark
// left on them), where 3 of the tabs had their content drawn while selected.
// So nothing hides the kicked tab from the screen but Safari committing no
// frame between the two updates; and WebKit can hold the forward update up
// to 250 ms for its paint (WebPageProxy waitForDidUpdateActivityState), which
// none of those 7 had, and which the switch log's `kickMs` shows. Only a tab
// known to have a page (left in this Safari session, not since found without
// one: a tab Safari unloaded, selected, starts loading with no cover), shown
// before, and not kicked in the last KICK_AGAIN_MS; never with introductions
// off (the page in front blinked: pageBlinked), with too little left of the
// wait, or while another switch's flip is under way in the window (this one's
// kick then waits for it). A held key passing through tabs never reaches this
// (navigation.js: only the tab it stops on goes through focusTab).
// So is a tab not proven to have WebKit's mark (never shown, or not seen
// left: one Safari restored as it was selected, one the warm-up or a restore
// loaded behind) whose page said hello in this Safari session and that no
// wake has found without a page since (2026-11-04): its kick is its
// introduction (its view came into the window with its process there, a
// suspended one counting: WebPageProxy::hasRunningProcess is false only once
// it has ended), so it isn't flipped again after it. Until then such a tab was
// waited for until its background resume (seconds), or shown as it was at the
// cap, Safari's empty view (a key's at 1.6 s).
const RESUMED_MS = 60;
const WAIT_AWAKE_MAX_MS = 1600;
const WAIT_DRAWN_MAX_MS = 2000;
const WAIT_POLL_MS = 50; // how often a wait looks for another switch or a key press
const COVER_AFTER_MS = 150;
const KICK_SOON_MS = 40; // a running process answers in a median 17–40 ms
const KICK_AFTER_MS = 60;
const SUSPEND_LIKELY_MS = 8000; // Safari suspends a hidden tab's process a median 8 s after it's left
const KICK_ROOM_MS = 300; // the kick (~110 ms in Safari, 250 ms more if WebKit holds the window), the wake and the drawing after it
// A tab kicked is not kicked again for this long (a second click on its row
// during the wait after the kick: its process resumed and held by then, a
// second flip would only hold Safari's window again; the switch takes on its
// wake). Forgotten once it's shown.
const KICK_AGAIN_MS = KEEP_AWAKE_MS;
const kickedAt = new Map(); // tabId → when it was last kicked
/** @typedef {{ at: number, kickMs: number | null, wakeMs: number | null, outcome: 'under way' | 'resumed' | 'capped' | 'loading' | 'in front' | 'not back' | 'left' | 'hurried' | Wake['outcome'] }} Kick `at`: ms from the ask to the kick; `kickMs`: Safari's answer to its two updates (null: none yet); `wakeMs`: the wake's answer, ms from Safari's answer to the kick (0: during it; null: none by the cap); `outcome`: 'resumed' (it answered: drawn, then shown), 'awake' (it answered within RESUMED_MS of its scripts going out: running all along, shown as any awake tab), 'capped' (no answer by the cap: shown then; also a switch forced at its page's deadline while waiting), 'under way' (forced at its page's deadline during the kick), 'no page' / 'loading' (its page had gone: restored behind the page), 'in front' (Safari left it there), 'not back' (another tab came to the front), 'left' / 'hurried' (another switch, a key press, before its answer) */
// Whether a switch may kick the tab, as far as is known without asking: a
// tab known to have a page, shown before, not kicked just now. (The rest is
// checked as the kick is due: focusTabNow.)
// `unproven`: a tab not proven to have WebKit's mark, whose page Margin knows
// is there (focusTabNow): never shown, or not seen left, all the same (its
// kick is its introduction).
/** @param {any} tab the tab as the browser has it @param {{ unproven?: boolean }} [options] */
const mayKick = (tab, { unproven = false } = {}) => !!platform?.introduceTabs && (unproven || (!neverShown.has(tab.id) && hiddenFor(tab.id) != null)) && !hasNoPage(tab.id) && !(Date.now() - (kickedAt.get(tab.id) ?? -Infinity) < KICK_AGAIN_MS);
// Switches whose page covers itself (content/core.js startSwitching): a row
// in its sidebar or palette, a next/previous key (after 150 ms).
const SELF_COVERED = new Set(['activateTab', 'openPin', 'next-tab', 'prev-tab']);
// Tabs whose wake was answered only past RESUMED_MS (a pointer resting on the
// row, a press, the palette, a key run's tab woken ahead, or the switch's
// own): their process had been suspended, and resumed at background
// priority. Running now, so a switch's wake there answers at once, but their
// content stays hidden until their page draws again: in Tirth's log
// (2026-11-02) such tabs, resumed 0.9–2.6 s before their selection and shown
// with no paint barrier, were Safari's empty view for 141–360 ms. Drawn before
// they're shown (focusTabNow's `late`); marked until they're in the window
// (shown, or introduced: forwardAndBack).
const resumedBehind = new Set();
// Whether a switch waits for the tab's wake to answer: Safari only, a tab at
// rest (one loading runs), that keep-ready doesn't hold (running, if busy). A
// tab Safari unloaded answers at once that it has no page. A tab never shown
// too (a ⌘-clicked link read later): it's introduced once it has answered, so
// its instant in the window is a running process's, and its drawing after it
// isn't held up behind a resume (until 2026-11-03 it was introduced once its
// wake had run out of time, at 400 ms, its process maybe still suspended).
// One with no answer by then is introduced all the same, as before.
/** @param {any} tab the tab as the browser has it */
const mayWait = (tab) => !!platform?.wakeTabs && tab.status === 'complete' && !isHeld(tab.id);
// The preparation `prep`, sent at `since`, once the tab's wake has said its
// page is awake (before the preparation answered): its answer within
// PREPARE_AWAKE_MS of then, else a timeout, called off before the show as any
// (focusTabNow). From the wake's answer, not from `since`: a process Safari
// resumed slowly answers both scripts at once, the preparation just behind.
// A wake that didn't answer that way leaves it its own time.
/** @param {Promise<Preparation>} prep @param {Promise<Wake>} woken @param {number} since @param {string} token @returns {Promise<Preparation>} */
async function awakeBudget(prep, woken, since, token) {
  const first = await Promise.race([prep.then(() => null), woken]);
  if (first?.outcome !== 'awake') return prep;
  return (await answerBy(prep, Date.now() + PREPARE_AWAKE_MS)) ?? { outcome: 'timeout', ms: Date.now() - since, reason: 'awake budget', token };
}
// `promise`'s answer if it comes by `until`, else null. A timer that fires
// late says so (slow.js: the background's timers seconds late on a Mac
// that busy).
/** @template T @param {Promise<T>} promise @param {number} until @returns {Promise<T | null>} */
async function answerBy(promise, until) {
  let timer;
  const due = Math.max(until, Date.now());
  const answer = await Promise.race([promise, new Promise((resolve) => {
    timer = setTimeout(() => {
      if (Number.isFinite(due)) noteLag(Date.now() - due);
      resolve(null);
    }, Math.max(0, due - Date.now()));
  })]);
  clearTimeout(timer);
  return /** @type {T | null} */ (answer);
}

// For tests: what this background alone knows about tabs never shown gone,
// as for a background Safari started again (storage.session read again).
export function forgetNeverShown() {
  neverShown.clear();
  introduced.clear();
  marks = null;
  lastHeard.clear();
  leftAtOrder.clear();
  backAtOrder.clear();
  flippedAt.clear();
  drawnAfter.clear();
}
// For tests: on again, as after a Safari restart.
export function resetIntroductions() {
  off = null;
  stoppedAt = 0;
  marks = null;
}
// A page was hidden for an instant (content: shared/switching.js onBlink,
// said whether or not it knew of a switch; the page's clock is the
// background's). The page in front of a flip (`tabId`: the page that said
// it), hidden after an introduction's, restore's or kick's two updates went
// out in its window, and before its real switch did: the updates took two
// turns in this Safari. (The page dates it when it gets to it, late if it's
// busy; a real switch away and straight back hides it only once that real
// switch has gone out. The tab flipped itself, hidden just before, is shown
// for the flip: not a blink.)
const BLINK_SLACK_MS = 20;
/** @param {number | null | undefined} windowId @param {{ hiddenAt?: number, shownAt?: number }} [times] @param {number | null} [tabId] */
export function pageBlinked(windowId, { hiddenAt, shownAt } = {}, tabId = null) {
  const span = windowId == null ? null : lastSpan.get(windowId);
  if (!span || !Number.isFinite(hiddenAt) || !Number.isFinite(shownAt)) return;
  if (hiddenAt < span.from - BLINK_SLACK_MS || hiddenAt >= span.until) return;
  if (tabId != null && span.frontId != null && tabId !== span.frontId) return;
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
// started once its document is there (a page that paints nothing by then is
// shown as far as it got, as Safari would show it), never past RESTORE_MAX_MS;
// a page whose own document hasn't answered by then (a server slow to
// answer) is waited for up to RESTORE_HARD_MAX_MS: shown with no document, it
// came up as Safari's empty view until it committed (2014 ms of it once in
// Tirth's log, shown at the 2.5 s limit). Escape, another click or a key
// press still end the wait at once (stopsWait). Then introduced
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
const RESTORE_MAX_MS = 2500;
const RESTORE_HARD_MAX_MS = 4000; // for a tab whose own document hasn't answered (within the page's wait, as RESTORE_MAX_MS)
const COMMITTED_PAINT_MS = 1000; // from a document's late arrival, for its paint (most of the commit-to-first-layout times in Tirth's log, 61 ms–1.1 s)
const READY_MAX_MS = 1500; // from its load's start to its show, at most, for a page there that doesn't paint
// The page's wait left for the switch after it (introduction, preparation,
// paint barrier: 1 s, then focusTab's SHOW_BEFORE_MS for the show). 1500 ms
// until 2026-11-03: with a 5 s wait for a document, a restore plus its
// introduction used nearly all the page's 7 s, and Safari's calls after it
// (waiting on a hung process) took it past.
const RESTORE_RESERVE_MS = 2800;
const RESTORE_POLL_MS = 40;
const RESTORE_CUT_SLACK_MS = 200; // past the wait's end, for Safari's answers (focusTabNow)
const RESTORED_LOOKUP_MS = 150; // a look at the tab after a restore cut short, or with Safari slow
// A restore's step, or CUT once its wait is over (`cutAt()`, looked at every
// RESTORE_POLL_MS): the step itself goes on, and stands down at its next
// look (stopsWait, once the wait says `cut`).
const CUT = Symbol('cut');
/** @template T @param {Promise<T>} promise @param {() => number} cutAt @returns {Promise<T | typeof CUT>} */
async function withinWait(promise, cutAt) {
  const settled = promise.then((value) => ({ value }));
  for (;;) {
    const got = await answerBy(settled, Math.min(cutAt(), Date.now() + RESTORE_POLL_MS));
    if (got) return got.value;
    if (Date.now() >= cutAt()) return CUT;
  }
}
const RESTORE_SCRIPT_MIN_MS = 100; // a script's least time to fail or answer in loadStarted
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
// `busy`: whatever is under way in its window (asked before waiting for it).
/** @param {any} tab the tab as the browser has it @param {{ busy?: boolean }} [options] */
const mayRestore = (tab, { busy = false } = {}) => !!platform?.restoreTabs && !!api.scripting?.executeScript && !tab.active && tab.status === 'complete' && /^https?:/.test(tab.url ?? '') && (busy || !windowBusy(tab.windowId));
/** @typedef {'painted' | 'loaded' | 'loading' | 'not loaded' | 'in front' | 'left' | 'hurried' | 'gone' | 'cut'} Behind 'painted': its page has painted (still loading); 'loading': still, with nothing painted, at the time limit (or introductions just stopped); 'cut': its wait over with Safari's answers still to come (a Safari slow: focusTabNow withinWait), shown as far as it got; 'not loaded': Safari didn't load it behind; 'in front': Safari left it there; 'left': another switch; 'hurried': a key press after it */
/** @typedef {{ gen: number, since: number, until: number, hardUntil?: number, hurry?: (() => boolean) | null, arrival?: Promise<[Wake | null, boolean]> | null, thereAt?: number | null, started?: Started | null, cut?: boolean, quiet?: boolean }} Wait `quiet`: the warm-up's (warmTab): nobody waits for the tab, so nothing is covered or held for it, and its flip doesn't go out once `hurry()` says so; `cut`: over (focusTabNow went on without it); `until`: the wait's end; `hardUntil`: its end while the tab's own document hasn't answered; `arrival`: its wake renewed and its arrival cover, asked for as that document answered (waitLoaded); `thereAt`: then; `started`: how its load was found started (loadStarted; DEVELOPMENT DIAGNOSTICS) */
// Why a wait stops early, if it does: another switch, a key press after it,
// or introductions just turned off (the page in front blinked: it stopped
// covering itself, so the switch goes ahead now).
/** @param {Wait} wait @returns {'left' | 'hurried' | 'stopped' | null} */
const stopsWait = ({ gen, since, hurry, cut }) => (gen !== focusGen ? 'left' : hurry?.() ? 'hurried' : stoppedAt >= since || cut ? 'stopped' : null);
/**
 * A tab Safari unloaded, loaded behind the page in front. Null if it wasn't tried.
 * @param {any} tab @param {Wait} wait @returns {Promise<Behind | null>}
 */
async function restoreTab(tab, wait) {
  if ((await isOff()) || (await areRestoresOff()) || !mayRestore(tab)) return null;
  // Shown for the first time yet, from the moment it's selected: introduced
  // once loaded, and arriving covered, should this switch be called off
  // before its load is seen (Safari goes on loading it); its wake said it had no page.
  // Its view goes into the window for that instant with no process yet, and
  // its page then runs behind: not marked (WebKit's mark, above, in
  // storage.session), so its first switch introduces it whichever background
  // makes it (the warm-up's, `quiet`, comes later, maybe from another
  // background: Safari stops an idle one after about 30 s, and neverShown is
  // this background's own).
  const selected = () => {
    neverShown.add(tab.id);
    wakes.delete(tab.id);
    lose(tab.id, 'restored behind', { outFromStart: true });
  };
  if (!(await forwardAndBack(tab, wait.gen, selected, wait.quiet ? { stop: () => !!stopsWait(wait) } : {}))) {
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
    // (The warm-up's, `quiet`, aren't counted: a guess at a tab nobody asked
    // for doesn't turn restores off for the user's own clicks. It counts its
    // own: background/warm-up.js.)
    if (started !== 'loading' && started !== 'ran' && started !== 'waiting') {
      // Not counted when cut short (introductions stopped): it may yet load.
      if (started === false && !wait.quiet) await countMiss(true, tab.id);
      return 'not loaded';
    }
    wait.started = started; // DEVELOPMENT DIAGNOSTICS
    if (!wait.quiet) await countMiss(false, tab.id);
    wakes.delete(tab.id); // one since, from before its load, said it had no page
    return await waitLoaded(tab.id, wait, Date.now(), { seen: started !== 'waiting' });
  } finally {
    // Its activation, should it have come after Safari's answer, is told if
    // it's in front after all.
    if (endIntroduction(tab.id, wait.gen)?.lateTab) void api.tabs.get(tab.id).then((t) => t.active && hooks.activated?.({ tabId: tab.id, windowId: t.windowId }), () => {});
  }
}
// Whether the tab's load has started: Safari says it's loading ('loading'),
// or a script runs in its own document ('ran': a page from its cache can be
// complete again by the next look), or a script hasn't answered by `until`
// ('waiting': a page too busy to answer, or a process still starting; a tab
// with no page fails at once). 'waiting' isn't taken as loaded: Safari says
// 'complete' for a tab it unloaded, so until the tab is seen loading or its
// document answers, its status says nothing (waitLoaded). After a relaunch
// (load average about 50, 2026-11-03) two tabs were shown that way before
// their load had started or committed: 19 ms and 1.0 s of Safari's empty view.
/** @typedef {'loading' | 'ran' | 'waiting'} Started */
/** @param {number} tabId @param {Wait} wait @returns {Promise<Started | false | 'stopped' | 'left' | 'hurried' | 'gone'>} */
async function loadStarted(tabId, wait) {
  const until = Math.min(Date.now() + RESTORE_START_MS, wait.until);
  // Not waited for past `until`, but the script always gets twice as long
  // as Safari took to answer the tabs.get before it, and RESTORE_SCRIPT_MIN_MS:
  // its failure for a tab with no page goes through the same Safari as
  // that answer. With tabs.get taking 350 ms (a Mac busy after a relaunch),
  // the script went out past `until` with no time left, and every tab Safari
  // didn't load behind was 'waiting', held to the usual limit and not
  // counted as a miss (restores never went off).
  const runs = (/** @type {number} */ answerMs) => {
    let timer;
    return Promise.race([
      // (A failure that takes SLOW_CALL_MS is Safari slow: slow.js.)
      ((sentAt) => {
        const noPage = () => (noteCall('a script finding no page', Date.now() - sentAt, tabId), false);
        return api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: pageThere }).then((rows) => (ranThere(rows) ? 'ran' : noPage()), noPage);
      })(Date.now()),
      new Promise((resolve) => { timer = setTimeout(() => resolve('waiting'), Math.max(until - Date.now(), 2 * answerMs, RESTORE_SCRIPT_MIN_MS)); }),
    ]).finally(() => clearTimeout(timer));
  };
  for (let tries = 0; ; tries++) {
    const askedAt = Date.now();
    const tab = await timedCall('tabs.get', api.tabs.get(tabId), tabId).catch(() => null);
    const answerMs = Date.now() - askedAt;
    if (!tab) return 'gone';
    const stop = stopsWait(wait);
    if (stop) return stop;
    if (tab.status === 'loading') return stopsWait(wait) ?? 'loading';
    const ran = tries % 2 === 1 ? /** @type {Started | false} */ (await runs(answerMs)) : false;
    if (ran) return stopsWait(wait) ?? ran;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS));
  }
}
// A tab loading behind, until it has painted or loaded (at most READY_MAX_MS
// from `startedAt`, when its load started, or for a tab found loading from
// now, once its own document has answered: the whole wait before that, up to
// RESTORE_HARD_MAX_MS while it hasn't). As soon as that document answers, its
// wake is renewed and its arrival cover asked for (`wait.arrival`), while its
// paint is still waited for, not after it: on 'painted', it's introduced at once.
// `seen`: its load is known to have started (seen loading, or its document
// answered: loadStarted). Until it is, Safari's 'complete' doesn't count as
// loaded (an unloaded tab says so), and the wait for its document ends at
// the usual limit, not the hard one: it may not be loading at all (Safari
// putting its load off), or be a page too busy to answer.
/** @param {number} tabId @param {Wait} wait @param {number} [startedAt] @param {{ seen?: boolean }} [options] @returns {Promise<Behind>} */
async function waitLoaded(tabId, wait, startedAt = Date.now(), { seen = true } = {}) {
  let there = false;
  /** @type {number | null} */
  let thereAt = null;
  const load = { seen, answered: () => thereAt != null };
  // Once its document is there: READY_MAX_MS from its load's start, or for a
  // document that came late (a server slow to answer) COMMITTED_PAINT_MS from
  // its arrival, within the hard limit, so it has a chance to paint (shown at
  // once, it was a page with nothing drawn yet).
  const until = () => {
    if (!there) return load.seen ? wait.hardUntil ?? wait.until : wait.until;
    const usual = Math.min(wait.until, startedAt + READY_MAX_MS);
    return thereAt == null ? usual : Math.max(usual, Math.min(wait.hardUntil ?? wait.until, thereAt + COMMITTED_PAINT_MS));
  };
  let over = false;
  const arrived = (/** @type {boolean} */ answered) => {
    if (there || over) return;
    there = true;
    if (!answered) return;
    thereAt = Date.now();
    wait.thereAt = thereAt; // DEVELOPMENT DIAGNOSTICS
    if (!platform?.introduceTabs || over || wait.quiet || stopsWait(wait)) return;
    wait.arrival = Promise.all([wakeTab(tabId, { renew: true }), coverArrival({ id: tabId })]).catch(() => /** @type {[Wake | null, boolean]} */ ([null, false]));
  };
  const painted = untilPainted(tabId, until, () => over || !!stopsWait(wait), arrived);
  const loaded = await untilLoaded(tabId, until, () => !!stopsWait(wait), null, painted, load).finally(() => { over = true; });
  if (loaded === 'left') {
    const stop = stopsWait(wait);
    return stop === 'stopped' ? 'loading' : stop ?? 'left';
  }
  return loaded === 'painted' || loaded === 'loaded' || loaded === 'gone' ? loaded : 'loading';
}
// Whether the tab's page has painted, or loaded (shared/page-ready.js): asked
// there until the question reaches its own document (before its load commits,
// a script finds no page, an error in place of a result in Safari, or the
// empty page a tab starts with), then waited for there, READY_ASK_MS at a
// time: a question its document never answers (one that went away as it was
// asked) doesn't take the rest of the wait. Asked again every READY_RETRY_MS
// for the first READY_FAST_MS, then less and less often, at most
// READY_RETRY_MAX_MS apart: a server slow to answer cost a failing script
// every 50 ms (58 in 3 s, each a line in Safari's log). 'loaded' counts only
// once the tab says so too: a tab going from one page to another still has
// the old one's document, loaded, until the new one commits. `there(true)` is
// told once its own document has answered (its own 'timeout', or its paint
// or load, in time or late: a page too busy to run the question in time has
// its document), `there(false)` if it can't be asked. Until it has answered, the
// page's limit, for a wait told so, is READY_FIRST_ASK_MS: a document there
// that hasn't painted says so that soon, and what goes with its show is asked
// for while its paint is waited for (waitLoaded). Null if
// it can't tell by `until()`, or `stopped()`: a page Margin may not run in, an
// address Safari doesn't give (no site access), a page that paints nothing
// (the tab's status still says when it has loaded: untilLoaded). Only where a
// page loading hidden paints (platform.hiddenPaints): Chrome waits for the
// load, as before.
const READY_RETRY_MS = 50;
const READY_FAST_MS = 500;
const READY_RETRY_MAX_MS = 200;
const READY_ASK_MS = 400;
const READY_FIRST_ASK_MS = 150;
const READY_ANSWER_MS = 100; // an answer's way back, after the page's own limit
/** @param {number} tabId @param {() => number} until @param {() => boolean} stopped @param {((answered: boolean) => void) | null} [there] @returns {Promise<'painted' | 'loaded' | null>} */
async function untilPainted(tabId, until, stopped, there = null) {
  if (!platform?.hiddenPaints || !api.scripting?.executeScript) return (there?.(false), null);
  const started = Date.now();
  let pause = READY_RETRY_MS;
  let answered = false;
  // A question answered too late for its own round that says the page has painted.
  let latePaint = false;
  /** @type {() => void} */
  let painted = () => {};
  /** @type {Promise<'painted'>} */
  const paintedLate = new Promise((resolve) => { painted = () => { latePaint = true; resolve('painted'); }; });
  for (;;) {
    if (stopped() || Date.now() >= until()) return null;
    if (latePaint) return 'painted';
    const tab = await timedCall('tabs.get', api.tabs.get(tabId), tabId).catch(() => null);
    const url = tab?.url || tab?.pendingUrl;
    if (!url || stopped() || (!/^about:/.test(url) && !(await mayAccessCached(url)))) return (there?.(false), null);
    const left = Math.max(0, Math.min(READY_ASK_MS, until() - Date.now()));
    // (The answer is waited for as long as before: a page too busy to run the
    // first doesn't get a second queued behind it any sooner.)
    const ms = answered || !there ? left : Math.min(READY_FIRST_ASK_MS, left);
    let timer;
    const asked = api.scripting.executeScript({ target: { tabId }, injectImmediately: true, func: readyInPage, args: [ms] }).then((rows) => rows?.[0]?.result ?? null, () => null);
    const how = await Promise.race([
      asked,
      paintedLate,
      new Promise((resolve) => { timer = setTimeout(() => resolve('late'), left + READY_ANSWER_MS); }),
    ]);
    clearTimeout(timer);
    if (how === 'painted' || (how === 'loaded' && tab.status === 'complete')) {
      there?.(true);
      return how;
    }
    // Its document there and still drawing nothing (its own answer), or too
    // busy or gone before it answered: asked again at once.
    if (how === 'timeout') {
      answered = true;
      there?.(true);
    }
    // Too busy to answer in time, its document is there all the same (before
    // its load commits, a script fails at once): told so as it does answer,
    // and an answer that it has painted ends the wait.
    if (how === 'late') {
      void asked.then((late) => {
        if (late !== 'painted' && late !== 'timeout') return;
        answered = true;
        there?.(true);
        if (late === 'painted') painted();
      });
    }
    if (how === 'timeout' || how === 'late') continue;
    if (Date.now() - started >= READY_FAST_MS) pause = Math.min(READY_RETRY_MAX_MS, pause * 2);
    await new Promise((resolve) => setTimeout(resolve, pause));
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
  const [front] = await timedCall('tabs.query', api.tabs.query({ active: true, windowId: tab.windowId }), tab.id).catch(() => []);
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

// ---- the warm-up after a relaunch (background/warm-up.js) ---------------------
// A tab Safari unloaded, loaded behind the page in front as a switch's
// restore loads it (restoreTab: the same flip, load start, limits and safety
// nets), with nobody waiting for it: no cover on the page in front, no
// arrival cover or renewed hold once its document answers, and a tab Safari
// didn't load not counted toward turning restores off (Wait `quiet`).
// Its wait gives way to any switch (one asked for, under way, or the user's
// own: focusGen) and to `stop()` (input on the page in front, Safari slow),
// and its flip isn't sent once either says so. It's left never shown, as a
// restore leaves it, and marked unseen in storage.session: its first switch,
// from this background or a later one, introduces it, then shows it. Safari
// leaving it in front: introductions go off for the session (forwardAndBack;
// the flip has been seen to fail in this Safari, so the user's own switches
// mustn't flip either), and the page before is brought back at once
// (`frontId`), unless a switch came meanwhile.
// `behind`: the restore's outcome (null: not tried).
/** @param {any} tab @param {{ stop?: () => boolean, frontId?: number | null }} [options] @returns {Promise<{ behind: Behind | null, started: Started | null, committed: number | null }>} */
export async function warmTab(tab, { stop = () => false, frontId = null } = {}) {
  const since = Date.now();
  const gen = focusGen;
  /** @type {Wait} */
  const wait = { gen, since, until: since + RESTORE_MAX_MS, hardUntil: since + RESTORE_HARD_MAX_MS, hurry: () => switchUnderWay() || anyFocusing() || stop(), quiet: true };
  const behind = await restoreTab(tab, wait);
  if (behind === 'in front' && frontId != null && stoppedAt >= since && gen === focusGen && !switchUnderWay()) {
    activating(frontId);
    await timedCall('tabs.update', api.tabs.update(frontId, { active: true }), frontId).catch(() => {});
  }
  return { behind, started: wait.started ?? null, committed: wait.thereAt != null ? wait.thereAt - since : null };
}
// Why the warm-up can't go on now, if it can't: for the Safari session
// ('introductions off': a page in front blinked, or Safari left a tab in
// front; 'restores off': Safari didn't load tabs behind), or for a moment
// ('switch': one asked for or under way).
/** @returns {Promise<'introductions off' | 'restores off' | 'switch' | null>} */
export async function warmUpBlocked() {
  if (!platform?.restoreTabs || !api.scripting?.executeScript) return 'restores off';
  if (await isOff()) return 'introductions off';
  if (await areRestoresOff()) return 'restores off';
  return switchUnderWay() || anyFocusing() ? 'switch' : null;
}
/** The open-tab repair found the tab with no page (Safari unloaded it), and nothing has said it has one since. @param {number} tabId */
export const foundWithNoPage = (tabId) => noPageFound.has(tabId);
/** The open-tab repair found this copy running in the tab's page (it has one). @param {number} tabId */
export const foundWithPage = (tabId) => checkedCurrent.has(tabId);
/** The open-tab repair under way, if it is (not started by asking). */
export const repairUnderWay = () => repairOpenTabs ?? Promise.resolve();
/** A switch asked for or under way (the warm-up's own note: background/warm-up.js). */
export const switchBusy = () => switchUnderWay() || anyFocusing();

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
// What bringing it to the front may take, within the page's deadline: focusTab
// plans its show SHOW_BEFORE_MS before its deadline, so this leaves its steps
// (an introduction, the preparation, a paint barrier) the 2.1 s they had
// before 2026-11-03 (2.5 s then, less the 0.4 s it kept).
const FOCUS_MS = 2100 + SHOW_BEFORE_MS;
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
  tooLate(deadline);
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
  const painted = untilPainted(tab.id, () => until, () => over || left());
  const loaded = await untilLoaded(tab.id, () => until, left, from.id, painted).finally(() => { over = true; });
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
// `load`, for a tab loaded behind (waitLoaded): 'complete' counts only once
// it has been seen loading (`seen`, set here too) or its own document has
// answered (`answered()`): Safari says 'complete' for a tab it unloaded.
/** @param {number} tabId @param {() => number} until @param {() => boolean} left @param {number | null} fromId @param {Promise<'painted' | 'loaded' | null> | null} [painted] @param {{ seen: boolean, answered: () => boolean } | null} [load] @returns {Promise<'painted' | 'loaded' | 'timeout' | 'gone' | 'left' | 'moved'>} */
async function untilLoaded(tabId, until, left, fromId, painted = null, load = null) {
  const SLOW = Symbol('slow');
  const ask = (id) => {
    let timer;
    return Promise.race([
      timedCall('tabs.get', api.tabs.get(id), id).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(SLOW), Math.max(POLL_MS, until() - Date.now())); }),
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
    if (tab.status === 'loading') {
      sawLoading = true;
      if (load) load.seen = true;
    }
    const known = !load || load.seen || load.answered();
    if (tab.status === 'complete' && known && ((tab.url && tab.url !== 'about:blank') || (!tab.url && sawLoading))) return 'loaded';
    if (ready) return ready;
    if (Date.now() >= until()) return 'timeout';
    const pause = new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, until() - Date.now()))));
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
  if (cut || noPageFound.has(tabId)) return; // (no page yet: next time)
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
    // (Not a tab with no page: it loads with this copy's scripts.)
    if (probe || noPageFound.has(tab.id)) {
      if (probe) boundHere.add(tab.id);
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
// A tab found with no page (noPageFound: Safari unloaded it, and every tab
// after a relaunch) isn't asked again, by this pass or the next, until it's
// shown or its page changes: once it loads it runs this copy anyway. (Each
// was asked twice per pass, over four passes: about 450 failing scripts in
// Tirth's first five minutes after a relaunch, 2026-11-03.)
// A few tabs at a time, the one in front of each window first, and none
// while a switch is under way (switchUnderWay: asked for, or in focusTab):
// all at once, the repair's scripts queued ahead of the switch's own calls
// in Safari, and after that relaunch five clicks in a row never started a
// switch (each one's request reached focusTab with under 1 s of its page's
// 7 s left: 'expired', stuck 'before').
const REPAIR_RETRY_MS = [350, 1200, 3000];
const REPAIR_AT_ONCE = 2;
const GIVE_WAY_POLL_MS = 50;
let repairOpenTabs = null;
/** @param {{ retry?: boolean }} [options] */
export function injectIntoOpenTabs({ retry = true } = {}) {
  if (!repairOpenTabs) {
    repairOpenTabs = runOpenTabRepair(retry).finally(() => { repairOpenTabs = null; });
  }
  return repairOpenTabs;
}
async function giveWay() {
  const until = Date.now() + SWITCH_HOLDS_MS;
  while (switchUnderWay() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, GIVE_WAY_POLL_MS));
}

async function runOpenTabRepair(retry) {
  // The sidebar's entry, whatever the build named its file.
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript) return;
  const delays = [0, ...(retry ? REPAIR_RETRY_MS : [])];
  const done = (/** @type {any} */ tab) => tab.discarded || checkedCurrent.has(tab.id) || !/^https?:/i.test(tab.url ?? '');
  for (const [pass, delay] of delays.entries()) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const passStart = Date.now();
    let gaveWay = 0;
    const yielded = async () => {
      const from = Date.now();
      await giveWay();
      gaveWay += Date.now() - from;
    };
    await yielded();
    const tabs = await api.tabs.query({}).catch(() => []);
    const left = tabs.filter((tab) => !checkedCurrent.has(tab.id) && !noPageFound.has(tab.id)).sort((a, b) => Number(!!b.active) - Number(!!a.active));
    // DEVELOPMENT DIAGNOSTICS: the tabs this pass asked, and found with no page.
    const counts = { asked: 0, noPage: 0 };
    const one = async (/** @type {any} */ tab) => {
      if (await repairOldOwnPage(tab)) return void checkedCurrent.add(tab.id);
      if (done(tab) || noPageFound.has(tab.id) || checking.has(tab.id)) return;
      counts.asked++;
      const cut = await repairCutOff(tab);
      if (noPageFound.has(tab.id)) counts.noPage++;
      if (cut === 'reloaded') checkedCurrent.add(tab.id);
      if (cut || noPageFound.has(tab.id)) return; // (no page: no second question)
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
    };
    await Promise.all(Array.from({ length: REPAIR_AT_ONCE }, async () => {
      for (let tab = left.shift(); tab; tab = left.shift()) {
        await yielded();
        await one(tab);
      }
    }));
    recordRepair({ pass, tabs: tabs.length, ...counts, gaveWayMs: gaveWay, ms: Date.now() - passStart });
    // (A tab with no page keeps the passes going: it may load meanwhile, the
    // tab in front at a relaunch most of all, and is then asked again.)
    if (tabs.every(done)) return;
  }
}
