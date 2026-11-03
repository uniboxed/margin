// Keeping the tab just left ready to show (Safari).
//
// Safari suspends a hidden tab's process a few seconds after it's left (a
// median 8 s, 10% within a second, in Tirth's log), and WebKit then drops the
// tab's drawn layers (WebProcessProxy::sendPrepareToSuspend →
// hideContentUntilPendingUpdate). Switching to it later shows Safari's empty
// view until it has painted again (a median 109 ms in his log; 0.3–1.2 s for
// a heavy tab swapped out), whoever switches: Safari's own tab bar and
// shortcuts too, which Margin can't wake a tab ahead of (background/tabs.js
// wakeTab). A tab whose process keeps running keeps its layers, and WebKit
// keeps the page before on screen until it has painted: no flash. So the tab
// just left is kept running for `settings.keepLeftTabReadyMinutes` (default
// 1; 0: off): one self-ending hold (tabs.js holdTab), never renewed. Most
// returns are to a tab used a moment ago, and the commonest is straight back
// to the one just left (a change of space and back too: navigation.js
// showSpace).
// A hold isn't free. Until 2026-11-03 it was a script left running in the
// page (tabs.js keepAwake), and WebKit keeps a process running a script at
// foreground priority (RunningBoard's UserInteractiveFocal role): the site's
// own work ran on as if it were in front. In Tirth's Safari (2026-11-02) the
// old keep-ready, which held up to six tabs of the space in front and renewed
// them for 30 minutes after Safari was last used, kept about six heavy hidden
// tabs running all the time, at about 22% of a core each: 60–70% of all web
// content CPU, his battery from 45% to 6% in an hour. A hold is now a message
// to Margin's page there, answered only once the hold is over (tabs.js
// holdTab): WebKit keeps that process running too (its layers stay), but at
// background priority (efficiency cores, background QoS, throttled I/O). At
// most MAX_HELD run, each for a minute after it was left. One more past them
// ends the hold of the tab used longest ago at once (trimSoon, releaseTab),
// and all of them end once Safari is left for another app (noteAway): nobody
// switches tabs there, and their sites would run on for nothing. A tab a held
// key only passed through isn't held (`passed`).
// A hold that found no page (Margin's start page, a site without access, a
// tab being closed) marks the tab (hasNoPage) until a tab event says it has
// one (pageChanged, shown) or NO_PAGE_RETRY_MS has passed.
import { api, cached, isOwner, isSynced, load } from './store.js';
import { holdTab, releaseTab } from './tabs.js';
import { platform } from '../shared/platform.js';

// The setting's largest value: one hold runs this long at most.
export const MAX_MINUTES = 10;
// A tab a hold couldn't run in (no page: Safari unloaded it; or no access):
// not tried again before this, unless a tab event says it has a page again
// (pageChanged, shown).
const NO_PAGE_RETRY_MS = 10 * 60_000;
const SOON_MS = 1500; // after a change of the setting: the holds checked, soon
// holdNow past MAX_HELD lets the tab left longest ago go once the new hold has
// been sent and hasn't failed for this long: not for a tab that can't be held
// (Margin's start page, a site without access, a tab being closed: ⌘W can
// bring its activation before its removal, and the script then fails at once).
const TRIM_AFTER_MS = 250;
// A tab shown in passing (a held key: navigation.js) whose activation hasn't
// come within this isn't taken for one (the switch never landed).
const PASSING_MS = 5000;
// Two: the tab just left, and the one left before it (a look at a third tab
// and straight back). In Tirth's tab selections (8 hours, 2026-11-01/02), 20
// of 25 returns to a tab seen before went to one of the six used last; how
// many went to the last two isn't known. A second hold costs one more hidden
// process at foreground priority for the minute after a switch at most,
// nothing once switching stops.
const MAX_HELD = 2;
// Safari left for another app (windows.onFocusChanged with WINDOW_ID_NONE):
// the holds end this long after, unless Safari is back first. Moving from one
// Safari window to another can bring a WINDOW_ID_NONE just before the new
// window's id, and a glance at another app and straight back keeps them.
const AWAY_MS = 3000;
// The page in front losing focus while still in sight (shared/away.js): Safari
// left for another app, or Safari's own find bar or address bar taking the
// keys (⌘F, ⌘L) with the page still in front. Longer, so a search typed there
// doesn't cost the tab just left its hold: a hold costs little now
// (background priority), a dark switch back costs more.
export const PAGE_AWAY_MS = 15_000;
// The tabs set aside, in storage.session: a background Safari stops and
// starts again (idle 30 s) would otherwise forget them. Its tab ids hold:
// storage.session is cleared with them (a Safari restart, a new copy of
// Margin: store.js decideOnce).
const NO_PAGE_KEY = 'keepReadyNoPage';
// The holds placed and not known to be over (their keys and ends), in
// storage.session too: a background that started again still counts them
// toward MAX_HELD and releases them when Safari is left, rather than leaving
// them to run out. And when each tab was last left (tabs.js likelySuspended,
// and the switch log's hiddenForMs).
const HOLDS_KEY = 'keepReadyHolds';
const LEFT_KEY = 'keepReadyLeftAt';
// The alarm the keep-ready before this one renewed its holds by, every minute
// (it started Margin's background once a minute in Safari's other profiles for
// nothing). Nothing is renewed now: background.js clears it if it still comes.
export const KEEP_READY_ALARM = 'margin-keep-ready';

let soon = null;
let ticks = 0; // for tests
let awayTimer = null;
let away = false; // Safari left for another app, and not back since
let focusedAt = 0; // when Safari was last known in use (noteFocused)
/** @type {number | null} */
let focusedWindow = null; // the Safari window focused last, if told (windows.onFocusChanged, a page's focus)
const heldUntil = new Map(); // tabId → when its latest hold ends
// tabId → Map(key → { until, sent, sure }): every hold placed there that
// isn't known to be over, so a release names them all (tabs.js releaseTab).
// `sent`: its script has gone out (one not sent yet is called off by a
// release instead: holdTab's `sending`). `sure`: it went to a process known
// to be running (the tab just left); one the background before this one
// placed may have ended with its page.
/** @type {Map<number, Map<string, { until: number, sent: boolean, sure: boolean }>>} */
const holdKeys = new Map();
// tabId → { lastActive, at, shown }: a tab a held key shows in passing
// (navigation.js), its last use before (the activation makes it the latest),
// until it's next shown not in passing. `shown`: its passing activation came.
const passed = new Map();
const noPage = new Map(); // tabId → when to try it again: a hold found no page there
const pageEvents = new Map(); // tabId → how many times its page changed while a hold was on its way
const leftAt = new Map(); // tabId → when it was last left (hiddenFor)
// The tabs left and not shown since, as the tab events said: not in front,
// whatever the state says (its `active` can lag behind them: an activation
// waits behind writes). Through quick switches in the WebKit host, the state
// still had a tab two switches back in front, and its release kept its hold
// running as a front tab's (release).
const leftSince = new Set();
// The tab in front of each window, by the activations as they come
// (background.js: not an introduction's, nor a ⌘T tab's about to
// close): the tab left at the next switch. The state's `active` can lag
// behind them (an activation's write waits behind the one under way:
// store.js mutate), and through two quick switches it still named the tab
// two back: that tab was held again, and the tab just left never was. null:
// none known in front (it closed, or went to another window).
/** @type {Map<number, number | null>} */
const frontByWindow = new Map();

/** @param {import('../../types/margin').State | null | undefined} s */
const minutesOf = (s) => {
  const minutes = Number(s?.settings?.keepLeftTabReadyMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, MAX_MINUTES) : 0;
};
// What the background before this one knew: the tabs set aside, the holds it
// placed and when tabs were left. Read once per background run; a tab whose
// page changed or that was shown before the read isn't set aside again by
// it, and is dropped from storage.session too (the next background would
// read it there).
/** @type {Promise<void> | null} */
let sessionRead = null;
let sessionDone = false;
const putBack = new Set();
function fromSession() {
  return (sessionRead ??= Promise.resolve().then(() => api.storage.session?.get([NO_PAGE_KEY, HOLDS_KEY, LEFT_KEY])).catch(() => null).then((stored) => {
    let takenBack = false;
    for (const [id, retryAt] of Object.entries(stored?.[NO_PAGE_KEY] ?? {})) {
      const tabId = Number(id);
      if (putBack.has(tabId)) takenBack = true;
      else if (Number.isFinite(retryAt) && !noPage.has(tabId)) noPage.set(tabId, retryAt);
    }
    const now = Date.now();
    for (const [id, keys] of Object.entries(stored?.[HOLDS_KEY] ?? {})) {
      const tabId = Number(id);
      for (const [key, kept] of Object.entries(keys ?? {})) {
        const [until, sure] = Array.isArray(kept) ? kept : [];
        if (!Number.isFinite(until) || until <= now) continue;
        // (Not for a tab this run has shown or held since.)
        keysOf(tabId).set(key, { until, sent: true, sure: sure === 1 && !putBack.has(tabId) });
        // Still running: counted toward MAX_HELD and released with the rest.
        // Left out, a background that started again held two more beside
        // them (the keep-ready before held six afresh at every start).
        if (!putBack.has(tabId) && until > (heldUntil.get(tabId) ?? 0)) heldUntil.set(tabId, until);
      }
    }
    for (const [id, at] of Object.entries(stored?.[LEFT_KEY] ?? {})) if (Number.isFinite(at) && !leftAt.has(Number(id))) leftAt.set(Number(id), at);
    sessionDone = true;
    putBack.clear();
    if (takenBack) save(NO_PAGE_KEY);
  }));
}
// Read as the background starts: the switch that starts a background Safari
// stopped (idle 30 s) needs to know whether its tab is held (background/tabs.js
// mayWait: a tab held isn't waited for), and the switch log when it was
// left. A switch awaits it (sessionKnown): one storage.session read per
// background run, nothing once it has answered. (Chrome keeps no tabs ready:
// nothing to read.)
export const sessionKnown = () => (platform?.keepTabsReady ? fromSession() : Promise.resolve());
void sessionKnown();
const saved = {
  [NO_PAGE_KEY]: () => Object.fromEntries(noPage),
  // The ones sent, each as [until, sure] (sure: 1 or 0).
  [HOLDS_KEY]: () => Object.fromEntries([...holdKeys].map(([tabId, keys]) => [tabId, Object.fromEntries([...keys].filter(([, h]) => h.sent).map(([key, h]) => [key, [h.until, h.sure ? 1 : 0]]))])),
  [LEFT_KEY]: () => Object.fromEntries(leftAt),
};
const unsaved = new Set();
/** @param {keyof typeof saved} key */
function save(key) {
  if (unsaved.size) return void unsaved.add(key);
  unsaved.add(key); // once for all the changes of this moment, after the read
  void fromSession().then(() => {
    const items = Object.fromEntries([...unsaved].map((k) => [k, saved[k]()]));
    unsaved.clear();
    return api.storage.session?.set(items);
  }).catch(() => {});
}
const keysOf = (/** @type {number} */ tabId) => holdKeys.get(tabId) ?? holdKeys.set(tabId, new Map()).get(tabId);
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`.replace('.', '');
// A tab's page changed or it was shown: no longer set aside. Whether it was.
function takeBack(tabId) {
  if (!sessionDone && platform?.keepTabsReady) putBack.add(tabId); // (Chrome never reads it)
  if (!noPage.delete(tabId)) return false;
  save(NO_PAGE_KEY);
  return true;
}

// Holds over by themselves (their script answers then, but not to a
// background that stopped and started again meanwhile) are forgotten.
function expire(now) {
  for (const [tabId, keys] of holdKeys) {
    for (const [key, h] of keys) if (h.until <= now) keys.delete(key);
    if (!keys.size) holdKeys.delete(tabId);
  }
  for (const [tabId, until] of heldUntil) if (until <= now) heldUntil.delete(tabId);
}

// The setting changed, or a background started: the holds checked in a
// moment (all released if it's off, or if this copy doesn't own the state).
export function tickSoon() {
  if (!platform?.keepTabsReady || soon) return;
  soon = setTimeout(() => {
    soon = null;
    void tick();
  }, SOON_MS);
  /** @type {any} */ (soon)?.unref?.(); // Node (tests) only
}

// A hold ends early when its tab is shown or its page goes away (tabs.js
// holdTab): then it's forgotten, in storage.session too (a background started
// again would take it for one still running there, and not wait for the
// tab). One that couldn't run (no page) marks the tab until
// its page changes (an event while the script was on its way counts: the
// page may have come just after it) or NO_PAGE_RETRY_MS has passed. Each hold
// has a key of its own (tabs.js holdTab), for its release. `onSent` once
// the script has gone out.
/** @param {number} tabId @param {number} now @param {number} ms @param {((until: number) => void) | null} [onSent] */
function hold(tabId, now, ms, onSent = null) {
  const until = now + ms;
  const key = newKey();
  const events = pageEvents.get(tabId) ?? 0;
  heldUntil.set(tabId, until);
  const record = { until, sent: false, sure: false };
  keysOf(tabId).set(key, record);
  // Sent only if still wanted: a release (or a show) that came first, while
  // holdTab was still finding out whether it may (its round trips), calls it
  // off. Sent after it, it would run its whole time with nothing left to
  // release it. It goes to the tab just left, whose process is running.
  const sending = () => {
    if (holdKeys.get(tabId)?.get(key) !== record) return false;
    record.sent = true;
    record.sure = true;
    save(HOLDS_KEY);
    onSent?.(until);
    return true;
  };
  void holdTab(tabId, ms, key, sending).then((held) => {
    const keys = holdKeys.get(tabId); // that hold is over (or never ran)
    if (keys?.get(key) === record) {
      keys.delete(key);
      if (!keys.size) holdKeys.delete(tabId);
      if (record.sent) save(HOLDS_KEY);
    }
    if (heldUntil.get(tabId) !== until) return; // held again, released or shown meanwhile
    heldUntil.delete(tabId);
    if (held) return;
    if ((pageEvents.get(tabId) ?? 0) === events) {
      noPage.set(tabId, now + NO_PAGE_RETRY_MS);
      save(NO_PAGE_KEY);
    }
  });
}

// A tab event says the tab has a page again or is getting one (its status or
// address changed: Margin restored it behind, it navigated). Its holds aren't
// sure to run on (a hold ends as its page goes away), in storage.session too:
// a background started again before their scripts answer would take them as
// sure, and a switch to the tab then wouldn't wait for it.
export function pageChanged(tabId) {
  if (heldUntil.has(tabId)) pageEvents.set(tabId, (pageEvents.get(tabId) ?? 0) + 1);
  let unsure = false;
  for (const h of holdKeys.get(tabId)?.values() ?? []) {
    if (h.sent && h.sure) unsure = true;
    h.sure = false;
  }
  if (unsure) save(HOLDS_KEY);
  takeBack(tabId);
}

// A tab shown: whatever held it has ended (keepAwake ends as its page is
// shown, and a hold still on its way is called off); held afresh once it's
// left. Safari loads one it had unloaded as it's shown. Its holds' keys stay
// until their scripts answer: shown for an instant only (an introduction),
// a page may not have seen itself visible, and a release then still ends them.
// Shown in passing (a held key): marked so; shown again after, not any more.
export function shown(tabId, now = Date.now()) {
  // In front now: hidden no longer than since then, should its leave not be
  // noted (a background just started takes the tab left from the state,
  // which can lag behind an activation queued behind a write), or come late.
  // (Written with the leave noted in the same moment: one write.)
  if (platform?.keepTabsReady) {
    leftAt.set(tabId, now);
    save(LEFT_KEY);
  }
  leftSince.delete(tabId);
  heldUntil.delete(tabId);
  takeBack(tabId);
  const keys = holdKeys.get(tabId);
  for (const [key, h] of keys ?? []) {
    if (h.sent) h.sure = false;
    else keys?.delete(key);
  }
  if (keys && !keys.size) holdKeys.delete(tabId);
  const pass = passed.get(tabId);
  if (pass && !pass.shown && now - pass.at < PASSING_MS) pass.shown = true;
  else passed.delete(tabId);
}

// A held key is about to show the tab in passing (navigation.js);
// `lastActive`: its last use before, which it keeps counting by (a tab the
// key went on from was hardly used), until it's shown not in passing.
/** @param {number} tabId @param {number | undefined} lastActive */
export function passing(tabId, lastActive, now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  for (const [id, pass] of passed) if (!pass.shown && now - pass.at >= PASSING_MS) passed.delete(id);
  passed.set(tabId, { lastActive: passed.get(tabId)?.lastActive ?? lastActive ?? 0, at: now, shown: false });
}
// When a tab was last used, for choosing which to let go first.
/** @param {import('../../types/margin').State} s @param {number} tabId */
const lastUse = (s, tabId) => passed.get(tabId)?.lastActive ?? s.tabs[tabId]?.lastActive ?? 0;

// A hold no longer wanted ends now (tabs.js releaseTab), not when it runs out:
// every hold of this copy's that may still run there (one a run of the
// background before this one placed too). Not a closed tab's: forgotten. Nor
// yet a tab in front's (by the state, and not left since: `leftSince`): a
// hold that reached its page only once it was visible (one sent to a process
// Safari suspended waits behind its resume, and the show's resume comes
// first) doesn't end then (keepAwake ends on the page coming into view, not
// on finding it there), and runs on once the tab is left: its sent keys are
// kept (as shown() keeps them), and named at the next release. Whether it was
// let go (not while a switch to it is under way: it's shown in a moment).
/** @param {number} tabId @param {import('../../types/margin').State | null | undefined} s @param {number} now */
function release(tabId, s, now) {
  const tab = s?.tabs[tabId];
  const front = !!tab?.active && !leftSince.has(tabId);
  // (Those not sent yet are called off: hold's `sending`.)
  const open = [...(holdKeys.get(tabId) ?? [])].filter(([, h]) => h.sent && h.until > now);
  const keys = tab && !front ? open.map(([key]) => key) : [];
  if (!releaseTab(tabId, keys)) return false;
  const had = heldUntil.delete(tabId);
  if (front && open.length) {
    const before = holdKeys.get(tabId)?.size;
    holdKeys.set(tabId, new Map(open));
    if (open.length !== before || had) save(HOLDS_KEY);
  } else if (holdKeys.delete(tabId) || had) save(HOLDS_KEY);
  return true;
}
// Every hold, now (with those of the background before this one, once read).
function releaseAll(now = Date.now()) {
  const go = () => {
    const s = cached();
    for (const tabId of new Set([...heldUntil.keys(), ...holdKeys.keys()])) release(tabId, s, now);
    // (Kept: the keys of a tab in front, or one being switched to: release.
    // Named at the next release, once the tab is behind.)
    heldUntil.clear();
  };
  go();
  if (!sessionDone && platform?.keepTabsReady) void fromSession().then(go);
}

// Safari left for another app (background.js: windows.onFocusChanged with
// WINDOW_ID_NONE; handlers.js: the page in front lost focus while in sight).
// WebKit tells extensions of no focused window when Safari says so
// (WebExtensionContext::didFocusWindow(nullptr) fires onFocusChanged with
// WINDOW_ID_NONE); whether Safari does when it's deactivated isn't known, so
// the page in front says so too. The holds end AWAY_MS later (PAGE_AWAY_MS
// for a page's word, which Safari's own find bar brings too), unless Safari
// is used again first (noteFocused), and none are placed until it is.
// A page's word (`tabId`, `windowId`: its tab; `at`: when it lost focus)
// comes through more hops than a window's focus or an activation, and can
// come after the one that says Safari is still in use: then nothing would
// call its wait off. So it doesn't count when it lost focus before Safari was
// last seen in use (a switch to another tab), from a window other than the
// one focused last (a click into another Safari window), or from a tab no
// longer in front.
/** @param {{ at?: number | null, tabId?: number | null, windowId?: number | null }} [from] */
export function noteAway({ at = null, tabId = null, windowId = null } = {}) {
  if (!platform?.keepTabsReady || awayTimer || away) return;
  if (tabId != null) {
    if (Number.isFinite(at) && /** @type {number} */ (at) < focusedAt) return;
    if (windowId != null && focusedWindow != null && windowId !== focusedWindow) return;
    const front = windowId != null ? frontByWindow.get(windowId) : null;
    if (front != null && front !== tabId) return;
  }
  awayTimer = setTimeout(() => {
    awayTimer = null;
    away = true;
    releaseAll();
  }, tabId != null ? PAGE_AWAY_MS : AWAY_MS);
  /** @type {any} */ (awayTimer)?.unref?.(); // Node (tests) only
}
// Safari in use again: a window focused (`windowId`), a tab switch, the page
// in front focused (its window).
export function noteFocused(windowId = null, now = Date.now()) {
  clearTimeout(awayTimer);
  awayTimer = null;
  away = false;
  focusedAt = now;
  if (windowId != null) focusedWindow = windowId;
}

// A tab activated (background.js, as its activation comes): the tab it was
// shown in place of, from the activations before (frontByWindow), or from
// the state for a window this background hasn't seen a switch in (it started
// since). null: none. undefined: not known yet, the state not read yet (the
// activation that starts a background Safari stopped comes before its read):
// background.js asks leftIn once it has read it.
/** @param {number} windowId @param {number} tabId @param {import('../../types/margin').State | null | undefined} s @returns {number | null | undefined} */
export function frontChanged(windowId, tabId, s) {
  const known = frontByWindow.get(windowId);
  frontByWindow.set(windowId, tabId);
  if (known === undefined && !s) return undefined;
  const left = known !== undefined ? known : leftIn(s, windowId, tabId);
  return left === tabId ? null : left;
}
// The tab in front of the window by the state, other than `tabId`: the one
// it was shown in place of, if this background saw no switch there before.
/** @param {import('../../types/margin').State | null | undefined} s @param {number} windowId @param {number} tabId @returns {number | null} */
export const leftIn = (s, windowId, tabId) => Object.values(s?.tabs ?? {}).find((t) => t.windowId === windowId && t.active && t.id !== tabId)?.id ?? null;
// A tab closed, or moved to another window: no longer in front of its own.
export function frontGone(tabId) {
  for (const [windowId, id] of frontByWindow) if (id === tabId) frontByWindow.set(windowId, null);
}

// When a tab was left (background.js activated): how long it has been hidden
// tells a switch to it whether Safari has likely suspended it (tabs.js
// likelySuspended), whether keep-ready is on or not; and the switch log's
// hiddenForMs. Whether keep-ready holds a tab, as a switch to it is asked for
// (heldAtAsk; a hold ends as its tab is shown).
export function noteLeft(tabId, now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  leftSince.add(tabId);
  leftAt.set(tabId, now);
  save(LEFT_KEY);
}
/** @param {number} tabId @returns {number | null} null: not known to this background (nor the one before it) */
export const hiddenFor = (tabId, now = Date.now()) => (leftAt.has(tabId) ? now - /** @type {number} */ (leftAt.get(tabId)) : null);
// A hold found no page there (Safari unloaded the tab), and nothing has said
// it has one since.
export const hasNoPage = (/** @type {number} */ tabId) => noPage.has(tabId);
// A hold sure to be running (sent to a running process: `sure`, holdKeys)
// that runs at least a second more. Not one still on its way, nor one the
// background before this one placed in a tab whose page changed since.
export const isHeld = (/** @type {number} */ tabId, now = Date.now()) => [...(holdKeys.get(tabId)?.values() ?? [])].some((h) => h.sent && h.sure && h.until > now + 1000);
export const switchFacts = (/** @type {number} */ tabId, now = Date.now()) => ({ heldAtAsk: platform?.keepTabsReady ? isHeld(tabId, now) : null, hiddenForMs: hiddenFor(tabId, now) }); // DEVELOPMENT DIAGNOSTICS

// The tab just left, at once: Safari can suspend it within a second. It had a
// page in front. One hold, for the setting's minutes, never renewed. Not while
// Safari is left for another app, and not before this copy's tabs are matched
// to the open ones (its first start after a Safari restart or an update: the
// id read for the tab left is another session's); a background that only
// stopped and started again has them matched as soon as it knows it owns the
// state (store.js decideOnce).
export function holdNow(tabId, now = Date.now()) {
  const s = cached();
  const minutes = minutesOf(s);
  if (platform?.keepTabsReady) leftSince.add(tabId);
  if (!platform?.keepTabsReady || !s || !isOwner() || !isSynced() || !minutes || away) return;
  heldUntil.delete(tabId);
  takeBack(tabId);
  // Not a tab a held key only passed through: the tab the key stops on is
  // the one likely to be come back to, and a hold for each tab passed would
  // only push out one that is.
  if (passed.get(tabId)?.shown) return;
  hold(tabId, now, minutes * 60_000, (until) => trimSoon(tabId, until));
}
// Past MAX_HELD: the tab left longest ago lets go, so no more than that are
// held at any time. Once the new hold has gone out and hasn't failed
// (TRIM_AFTER_MS), so a tab that can't be held doesn't cost a held one its
// hold.
/** @param {number} tabId @param {number} until */
function trimSoon(tabId, until) {
  const timer = setTimeout(() => {
    const s = cached();
    if (heldUntil.get(tabId) !== until || !s?.tabs[tabId]) return; // it failed, or the tab's gone
    trim(s, Date.now());
  }, TRIM_AFTER_MS);
  /** @type {any} */ (timer)?.unref?.(); // Node (tests) only
}
// Which goes first: the tab left longest ago, by the tab events (leftAt; the
// state's last use can lag behind a run of quick switches, and a trim can run
// after later holds were placed), by its last use if this background doesn't
// know when it was left.
/** @param {import('../../types/margin').State} s @param {number} now */
function trim(s, now) {
  expire(now);
  const holding = new Set(heldUntil.keys());
  const leftWhen = (/** @type {number} */ id) => leftAt.get(id) ?? lastUse(s, id);
  const oldestFirst = [...holding].sort((a, b) => leftWhen(a) - leftWhen(b));
  for (const id of oldestFirst) {
    if (holding.size <= MAX_HELD) break;
    if (release(id, s, now)) holding.delete(id);
  }
}

// After a change of the setting or a background start: off, or this copy no
// longer owns the state: every hold ends now. Closed tabs forgotten, with
// keep-ready on or off: when tabs were left is noted either way (noteLeft),
// and written whole at each switch. Nothing is scheduled: no hold is renewed.
export async function tick(now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  ticks++;
  const s = await load();
  // Only the copy that owns the state (another copy's ids are its own:
  // shared/owner.js), and once its ids are matched to the open tabs.
  if (!isOwner()) return stop(now);
  if (!isSynced()) return;
  await fromSession();
  const setAside = noPage.size;
  for (const known of [noPage, pageEvents, leftAt, passed]) for (const tabId of known.keys()) if (!(tabId in s.tabs)) known.delete(tabId);
  if (!minutesOf(s)) return stop(now);
  for (const [tabId, retryAt] of noPage) if (retryAt <= now) noPage.delete(tabId);
  if (noPage.size !== setAside) save(NO_PAGE_KEY);
  trim(s, now); // (a background before this one may have left more)
}

// Turned off, or this copy no longer owns the state: no more holds, and those
// still running end now.
function stop(now = Date.now()) {
  releaseAll(now);
  if (noPage.size) {
    noPage.clear();
    save(NO_PAGE_KEY);
  }
  pageEvents.clear();
}

// A tab closed: forgotten (its holds ended with its page), with keep-ready on
// or off (when tabs were left is noted either way, and written whole at each
// switch).
export function closed(tabId) {
  if (!platform?.keepTabsReady) return;
  heldUntil.delete(tabId);
  leftSince.delete(tabId);
  pageEvents.delete(tabId);
  passed.delete(tabId);
  if (holdKeys.delete(tabId)) save(HOLDS_KEY);
  if (leftAt.delete(tabId)) save(LEFT_KEY);
  if (noPage.delete(tabId)) save(NO_PAGE_KEY);
}

// For tests.
export const keepReadyState = () => ({ held: [...heldUntil.keys()], holds: Object.fromEntries([...holdKeys].map(([tabId, keys]) => [tabId, [...keys.keys()]])), passed: [...passed.keys()], noPage: [...noPage.keys()], away, ticks });
// For tests: as a background Safari stopped and started again (nothing in
// memory, storage.session as it was, its read under way as at a start).
export function startedAgain() {
  clearTimeout(soon);
  soon = null;
  noteFocused();
  focusedAt = 0;
  focusedWindow = null;
  for (const known of [heldUntil, holdKeys, passed, noPage, pageEvents, leftAt, leftSince, frontByWindow]) known.clear();
  sessionRead = null;
  sessionDone = false;
  void sessionKnown();
}
export function resetKeepReady() {
  clearTimeout(soon);
  soon = null;
  noteFocused();
  focusedAt = 0;
  focusedWindow = null;
  passed.clear();
  stop();
  holdKeys.clear();
  leftAt.clear();
  leftSince.clear();
  frontByWindow.clear();
}
