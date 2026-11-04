// A slow Safari, or a slow Mac. After a reboot and a Safari relaunch (load
// average 74, 2026-11-03), Safari took 2.3–3.3 s to answer a tabs.get, and
// the background's own timers fired seconds late: a switch that started by
// asking Safari for its tab had lost half its time before it began, a
// restore behind the page then waited its full limits, its steps each a
// Safari call that long, and the tab was shown at a stuck step 3–7 s after
// the click (often before it had drawn: dark). So the switch's steps watch
// for it here: a Safari call that hasn't answered within SLOW_CALL_MS, or a
// timer that fired SLOW_LAG_MS late, is a sign, and a switch that finds
// Safari slow plans to show its tab soon after the click, as plain Safari
// would, loading if it must (background/tabs.js focusTab: `slow`).
// Measured where it costs nothing: the calls a switch makes anyway, and the
// timers that bound them.
// One sign isn't Safari slow (a tab's hung process, a background stalled
// once by its own work): that slowed every switch for 20 s, unloaded tabs
// shown before they had drawn. Safari is slow with signs from SLOW_SOURCES
// sources within SLOW_KEEP_MS: two tabs, or a tab and the Mac (timers late,
// a call about no tab in particular); a tab's signs count once, the Mac's
// once per stall (ONE_STALL_MS: a stall makes every timer pending late at
// once). A switch whose own calls are slow (`key`, its tab) is slow itself
// from then (slowFoundAt). A sign ASLEEP_MS or longer is the Mac asleep, not
// slow: left out.
const SLOW_CALL_MS = 500;
const SLOW_LAG_MS = 500;
const SLOW_KEEP_MS = 20_000;
const SLOW_SOURCES = 2;
const ONE_STALL_MS = 1000;
const ASLEEP_MS = 30_000;
/** @typedef {number | string} Key a tab's id (a call about it), or 'timer' and 'safari' (the Mac, Safari as a whole) */
/** @type {{ what: string, ms: number, at: number, key: Key }[]} */
let seen = [];
let warned = false;

// The signs that count apart, oldest first (those older than SLOW_KEEP_MS gone).
function sources(now = Date.now()) {
  seen = seen.filter((o) => now - o.at < SLOW_KEEP_MS);
  /** @type {typeof seen} */
  const out = [];
  for (const o of seen) {
    const same = out.filter((p) => p.key === o.key).at(-1);
    if (same && (typeof o.key === 'number' || o.at - same.at < ONE_STALL_MS)) continue;
    out.push(o);
  }
  return out;
}
// When Safari became slow, as it is now (null: it isn't).
export function slowSince(now = Date.now()) {
  const list = sources(now);
  return list.length >= SLOW_SOURCES ? list[SLOW_SOURCES - 1].at : null;
}
// Whether Safari (or the Mac) is slow now.
export const isSlow = () => slowSince() != null;
// The background's own timers seen late lately: a wait planned to a page's
// deadline can't be trusted to end in time (background/tabs.js focusTab: a
// switch then keeps to the plan for a slow Safari, whatever it waits for).
export const timersLate = (now = Date.now()) => seen.some((o) => o.key === 'timer' && now - o.at < SLOW_KEEP_MS);
// A sign from a call about `key` (a tab's id) since `since`: Safari slow for
// that switch's own calls (its lookups, flips, show).
/** @param {Key} key @param {number} since */
export const ownSign = (key, since) => seen.some((o) => o.key === key && o.at >= since);
// When the last sign came, whatever its source (null: none within
// SLOW_KEEP_MS): work that can wait (background/warm-up.js) waits for a
// Safari with none for a while, not only one that isn't slow.
export const lastSignAt = (now = Date.now()) => {
  const last = seen.at(-1);
  return last && now - last.at < SLOW_KEEP_MS ? last.at : null;
};
// When a switch that started at `since`, for the tab `key`, found Safari
// slow: as it started, if it was then; or when one of its own calls was, or
// Safari became so. null: it hasn't.
/** @param {Key} key @param {number} since */
export function slowFoundAt(key, since) {
  const all = slowSince();
  const own = seen.find((o) => o.key === key && o.at >= since)?.at ?? null;
  const at = Math.min(all ?? Infinity, own ?? Infinity);
  return at === Infinity ? null : Math.max(since, at);
}

/** @param {string} what @param {number} ms @param {Key} key */
function mark(what, ms, key) {
  if (ms >= ASLEEP_MS) return;
  seen.push({ what, ms: Math.round(ms), at: Date.now(), key });
  const slow = isSlow();
  if (slow && !warned) console.warn(`[margin] Safari is slow (${what}: ${Math.round(ms)} ms): switches show their tab soon after the click, as Safari would`);
  warned = slow;
}
// A call (about the tab `key`, or Safari as a whole) that took `ms`.
/** @param {string} what @param {number} ms @param {Key} [key] */
export function noteCall(what, ms, key = 'safari') {
  if (ms >= SLOW_CALL_MS) mark(what, ms, key);
}
// A timer that fired `ms` after it was due.
/** @param {number} ms */
export function noteLag(ms) {
  if (ms >= SLOW_LAG_MS) mark('a timer late', ms, 'timer');
}
// DEVELOPMENT DIAGNOSTICS: what showed it, for the switch log: the last sign
// (its own, if the switch's `key` and `since` are given and it has one), how
// long ago, and how many sources count now.
/** @param {Key | null} [key] @param {number} [since] */
export function slowFacts(key = null, since = 0) {
  const list = sources();
  const own = key != null ? seen.filter((o) => o.key === key && o.at >= since).at(-1) : null;
  const last = own ?? (list.length >= SLOW_SOURCES ? seen.at(-1) : null);
  return last ? { what: last.what, ms: last.ms, ago: Date.now() - last.at, own: !!own, sources: list.length } : null;
}
// `promise`, a Safari call (about the tab `key`), timed: one still
// unanswered at SLOW_CALL_MS is a sign then, not only once it answers
// (seconds later); the timer for that says how late timers fire, too.
/** @template T @param {string} what @param {Promise<T>} promise @param {Key} [key] @returns {Promise<T>} */
export function timed(what, promise, key = 'safari') {
  const at = Date.now();
  let answered = false;
  let noted = false;
  // (A timer can fire a millisecond early by the wall clock: still a sign.)
  const timer = setTimeout(() => {
    if (answered) return;
    noteLag(Date.now() - at - SLOW_CALL_MS);
    noted = true;
    noteCall(what, Math.max(SLOW_CALL_MS, Date.now() - at), key);
  }, SLOW_CALL_MS);
  const done = () => {
    answered = true;
    clearTimeout(timer);
    if (!noted) noteCall(what, Date.now() - at, key);
  };
  promise.then(done, done);
  return promise;
}
// For tests: not slow, as a background starting.
export function resetSlow() {
  seen = [];
  warned = false;
}
