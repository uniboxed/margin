// Keeping the tabs of the space in front ready to show (Safari).
//
// Safari suspends a hidden tab's process a few seconds after it's left (a
// median 8 s, 10% within a second, in Tirth's log), and WebKit then drops the
// tab's drawn layers (WebProcessProxy::sendPrepareToSuspend →
// hideContentUntilPendingUpdate). Switching to it later shows Safari's empty
// view until it has painted again (a median 109 ms in his log), whoever
// switches: Safari's own tab bar and shortcuts too, which Margin can't wake a
// tab ahead of (background/tabs.js wakeTab). A tab whose process keeps running
// keeps its layers, and WebKit keeps the page before on screen until it has
// painted: no flash. So while Safari has been used within the last
// `settings.keepTabsReadyMinutes` (default 30; 0: off), the tabs of the space
// each window shows are kept running, most recently used first, at most
// MAX_HELD: the same self-ending hold as a wake (tabs.js keepAwake), renewed
// before it ends. A hold isn't free: WebKit keeps a held process at
// foreground priority, so the site's own work runs on as if it were in front.
// In Tirth's Safari (2026-11-02) held hidden processes used 68% of all web
// content CPU, 18% of a core each, and 1.7 GB for 12 of them (the WebKit
// host's 0.3% of a core for a busy page held hidden was wrong for Safari:
// the host never suspends). And holds couldn't be taken back: one placed
// stayed 75 s, so a run of switches held 11 on average, up to 23. So a hold
// ends as soon as its tab isn't one of the MAX_HELD any more (releaseTab):
// at the next tick, as soon as a switch takes the held set past MAX_HELD
// (holdNow), and all of them when this stops. The tab just left counts among
// them by when it was used, whichever space it's in: a change of space and
// back returns to it (navigation.js showSpace), so it isn't let go for being
// in the space left. A tab a held key only passed through counts by its use
// before (`passed`), not as just used.
// A tab Safari unloaded stays unloaded (a hold can't run without a page), and
// isn't tried again until a tab event says it has a page (pageChanged) or
// NO_PAGE_RETRY_MS has passed; a tab never shown has nothing to keep
// (background/tabs.js introduceTab).
import * as V from '../shared/view.js';
import { api, cached, isOwner, isSynced, load } from './store.js';
import { holdTab, releaseTab } from './tabs.js';
import { platform } from '../shared/platform.js';

const HOLD_MS = 75_000;
const RENEW_BEFORE_MS = 20_000; // a hold with less than this left is renewed
const TICK_MS = 60_000; // at most this between ticks (the next is set by the holds' ends)
// A tab a hold couldn't run in (no page: Safari unloaded it; or no access):
// not tried again before this, unless a tab event says it has a page again
// (pageChanged, shown). Tried every minute before (in fact every 40 s: the
// schedule renewed it like a hold), it was most of the 16–46 failed scripts a
// minute in Tirth's Safari log (2026-11-02; 'Could not execute script on this
// tab', in groups 40–60 s apart, as many as the unloaded tabs held), each one
// a line in Safari's log and a round trip through its extension engine. Safari
// doesn't load a hidden tab by itself, so an event comes first if anything.
const NO_PAGE_RETRY_MS = 10 * 60_000;
const SOON_MS = 1500; // after a switch or a change of space: the new set, soon
// holdNow past MAX_HELD lets the tab used longest ago go once the new hold has
// been sent and hasn't failed for this long: not for a tab that can't be held
// (Margin's start page, a site without access, a tab being closed: ⌘W can
// bring its activation before its removal, and the script then fails at once).
const TRIM_AFTER_MS = 250;
// A tab shown in passing (a held key: navigation.js) whose activation hasn't
// come within this isn't taken for one (the switch never landed).
const PASSING_MS = 5000;
// Six, not every tab of the space (24 before): a held process skips Safari's
// whole suspend path (its layers aren't made volatile, its memory isn't given
// back), and in Tirth's log (2026-11-02, 19 minutes) hidden held processes
// ran at foreground priority for 6039 process-seconds against 346 s of tabs on
// screen, one of them 348 s of CPU, 4–8 held even through 6 minutes with no
// switching. Most returns are to a tab used a moment ago: in his log's tab
// selections (8 hours, 2026-11-01/02), 20 of 25 returns to a tab seen before
// went to one of the six used last; the other 5 went 8–10 back, and such a
// tab shows dark until it paints, as in plain Safari. Tabs with no page don't
// count (chooseTabs's `skip`).
const MAX_HELD = 6;
const USED_KEY = 'keepReadyUsedAt'; // storage.session: the background can stop and start again
// The tabs set aside, in storage.session too: a background Safari stops and
// starts again (idle 30 s, then the alarm) would otherwise try every one of
// them again at each start. Its tab ids hold: storage.session is cleared with
// them (a Safari restart, a new copy of Margin: store.js decideOnce).
const NO_PAGE_KEY = 'keepReadyNoPage';
// The holds placed and not known to be over (their keys and ends), in
// storage.session too: a background that started again releases those a run
// before it placed, once they aren't chosen (it would otherwise leave them to
// run out, 75 s). And when each tab was last left (DEVELOPMENT DIAGNOSTICS: the
// switch log's hiddenForMs).
const HOLDS_KEY = 'keepReadyHolds';
const LEFT_KEY = 'keepReadyLeftAt';
export const KEEP_READY_ALARM = 'margin-keep-ready'; // ticks if the background was stopped meanwhile

let usedAt = 0;
let savedAt = 0;
let timer = null;
let soon = null;
let ticks = 0; // for tests
let alarmSet = false;
const heldUntil = new Map(); // tabId → when its latest hold ends
// tabId → Map(key → { until, sent, sure }): every hold placed there that
// isn't known to be over (a renewal overlaps the hold before it by up to
// RENEW_BEFORE_MS), so a release names them all (tabs.js releaseTab).
// `sent`: its script has gone out (one not sent yet is called off by a
// release instead: holdTab's `sending`). `sure`: it went to a process known
// to be running, the tab just left (holdNow) or one held without a break
// since; a first hold of a tab left a while ago may be waiting behind its
// process's resume (Safari suspended it), and one the background before this
// one placed may have ended with its page.
/** @type {Map<number, Map<string, { until: number, sent: boolean, sure: boolean }>>} */
const holdKeys = new Map();
const leftHolds = new Map(); // tabId → the end of the hold holdNow placed, until it's renewed, released, shown or over
let lingering = new Set(); // left holds kept though their tab isn't chosen (another space's): not renewed
// tabId → { lastActive, at, shown }: a tab a held key shows in passing
// (navigation.js), its last use before (the activation makes it the latest),
// until it's next shown not in passing. `shown`: its passing activation came.
const passed = new Map();
const noPage = new Map(); // tabId → when to try it again: a hold found no page there
const pageEvents = new Map(); // tabId → how many times its page changed while a hold was on its way
const leftAt = new Map(); // tabId → when it was last left (DEVELOPMENT DIAGNOSTICS)

/** @param {import('../../types/margin').State} s */
const minutesOf = (s) => {
  const minutes = Number(s?.settings?.keepTabsReadyMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
};
// What the background before this one knew: when Safari was last used, the
// tabs set aside, the holds it placed and when tabs were left. Read once per
// background run; a tab whose page changed or that was shown before the read
// isn't set aside again by it, and is dropped from storage.session too (the
// next background would read it there).
/** @type {Promise<void> | null} */
let sessionRead = null;
let sessionDone = false;
const putBack = new Set();
function fromSession() {
  return (sessionRead ??= Promise.resolve(api.storage.session?.get([USED_KEY, NO_PAGE_KEY, HOLDS_KEY, LEFT_KEY])).catch(() => null).then((stored) => {
    if (Number.isFinite(stored?.[USED_KEY])) usedAt = Math.max(usedAt, stored[USED_KEY]);
    let takenBack = false;
    for (const [id, retryAt] of Object.entries(stored?.[NO_PAGE_KEY] ?? {})) {
      const tabId = Number(id);
      if (putBack.has(tabId)) takenBack = true;
      else if (Number.isFinite(retryAt) && !noPage.has(tabId)) noPage.set(tabId, retryAt);
    }
    for (const [id, keys] of Object.entries(stored?.[HOLDS_KEY] ?? {})) {
      const tabId = Number(id);
      for (const [key, kept] of Object.entries(keys ?? {})) {
        const [until, sure, left] = Array.isArray(kept) ? kept : [];
        if (!Number.isFinite(until)) continue;
        // (Not for a tab this run has shown or held since.)
        keysOf(tabId).set(key, { until, sent: true, sure: sure === 1 && !putBack.has(tabId) });
        if (left === 1 && !putBack.has(tabId) && until > (leftHolds.get(tabId) ?? 0)) leftHolds.set(tabId, until);
      }
    }
    for (const [id, at] of Object.entries(stored?.[LEFT_KEY] ?? {})) if (Number.isFinite(at) && !leftAt.has(Number(id))) leftAt.set(Number(id), at);
    sessionDone = true;
    putBack.clear();
    if (takenBack) save(NO_PAGE_KEY);
  }));
}
const saved = {
  [NO_PAGE_KEY]: () => Object.fromEntries(noPage),
  // The ones sent, each as [until, sure, left] (1 or 0: a background Safari
  // stopped while a tab of another space was kept would let it go otherwise).
  [HOLDS_KEY]: () => Object.fromEntries([...holdKeys].map(([tabId, keys]) => [tabId, Object.fromEntries([...keys].filter(([, h]) => h.sent).map(([key, h]) => [key, [h.until, h.sure ? 1 : 0, leftHolds.get(tabId) === h.until ? 1 : 0]]))])),
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

// Safari was used just now: a tab switch, a window focused, a click, key or
// scroll in a page (content/core.js, at most once a minute).
export function noteUsed(now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  usedAt = now;
  if (now - savedAt > 30_000) {
    savedAt = now;
    void Promise.resolve().then(() => api.storage.session?.set({ [USED_KEY]: now })).catch(() => {});
  }
  tickSoon();
}

// The set again in a moment (a switch, a change of space or of the setting).
export function tickSoon() {
  if (!platform?.keepTabsReady || soon) return;
  soon = setTimeout(() => {
    soon = null;
    void tick();
  }, SOON_MS);
  /** @type {any} */ (soon)?.unref?.(); // Node (tests) only
}

// A hold ends early when its tab is shown or its page goes away (keepAwake):
// then it's forgotten, so the next tick or holdNow holds it again. One that
// couldn't run (no page) isn't tried again before NO_PAGE_RETRY_MS, unless
// its page changes meanwhile (an event while the script was on its way
// counts: the page may have come just after it), and the next tab with a page
// takes its place at once. Each hold has a key of its own (tabs.js
// keepAwake), for its release. `left`: the tab was just left (holdNow), its
// process running; `onSent` once the script has gone out.
/** @param {number} tabId @param {number} now @param {{ left?: boolean, onSent?: ((until: number) => void) | null }} [options] */
function hold(tabId, now, { left = false, onSent = null } = {}) {
  if ((heldUntil.get(tabId) ?? 0) - now > RENEW_BEFORE_MS) return;
  const until = now + HOLD_MS;
  const key = newKey();
  const events = pageEvents.get(tabId) ?? 0;
  heldUntil.set(tabId, until);
  if (left) leftHolds.set(tabId, until);
  else leftHolds.delete(tabId); // renewed: chosen
  lingering.delete(tabId);
  const record = { until, sent: false, sure: false };
  keysOf(tabId).set(key, record);
  // Sent only if still wanted: a release (or a show) that came first, while
  // holdTab was still finding out whether it may (its round trips), calls it
  // off. Sent after it, it would run its 75 s with nothing left to release it.
  const sending = () => {
    if (holdKeys.get(tabId)?.get(key) !== record) return false;
    record.sent = true;
    record.sure = left || [...holdKeys.get(tabId).values()].some((h) => h !== record && h.sent && h.sure && h.until > Date.now());
    save(HOLDS_KEY);
    onSent?.(until);
    return true;
  };
  void holdTab(tabId, HOLD_MS, key, sending).then((held) => {
    const keys = holdKeys.get(tabId); // that hold is over (or never ran)
    if (keys?.get(key) === record) {
      keys.delete(key);
      if (!keys.size) holdKeys.delete(tabId);
    }
    if (leftHolds.get(tabId) === until) leftHolds.delete(tabId);
    if (heldUntil.get(tabId) !== until) return; // renewed, released or shown meanwhile
    heldUntil.delete(tabId);
    if (held) return;
    if ((pageEvents.get(tabId) ?? 0) === events) {
      noPage.set(tabId, now + NO_PAGE_RETRY_MS);
      save(NO_PAGE_KEY);
    }
    tickSoon();
  });
}

// A tab event says the tab has a page again or is getting one (its status or
// address changed: Margin restored it behind, it navigated): tried at once.
// Its holds aren't sure to run on (keepAwake ends as its page goes away).
export function pageChanged(tabId) {
  if (heldUntil.has(tabId)) pageEvents.set(tabId, (pageEvents.get(tabId) ?? 0) + 1);
  for (const h of holdKeys.get(tabId)?.values() ?? []) h.sure = false;
  if (takeBack(tabId)) tickSoon();
}

// A tab shown: whatever held it has ended (keepAwake ends as its page is
// shown, and a hold still on its way is called off); held afresh once it's
// left. Safari loads one it had unloaded as it's shown. Its holds' keys stay
// until their scripts answer: shown for an instant only (an introduction),
// a page may not have seen itself visible, and a release then still ends them.
// Shown in passing (a held key): marked so; shown again after, not any more.
export function shown(tabId, now = Date.now()) {
  heldUntil.delete(tabId);
  leftHolds.delete(tabId);
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
// When a tab was last used, for choosing which to keep ready.
/** @param {import('../../types/margin').State} s @param {number} tabId */
const lastUse = (s, tabId) => passed.get(tabId)?.lastActive ?? s.tabs[tabId]?.lastActive ?? 0;

// A hold no longer wanted ends now (tabs.js releaseTab), not when it runs out:
// every hold of this copy's that may still run there (one a run of the
// background before this one placed too). Not a tab in front (shown: its
// holds have ended) or closed: forgotten then. Whether it was let go (not
// while a switch to it is under way: it's shown in a moment).
/** @param {number} tabId @param {import('../../types/margin').State | null | undefined} s @param {number} now */
function release(tabId, s, now) {
  const tab = s?.tabs[tabId];
  // (Those not sent yet are called off: hold's `sending`.)
  const keys = tab && !tab.active ? [...(holdKeys.get(tabId) ?? [])].filter(([, h]) => h.sent && h.until > now).map(([key]) => key) : [];
  if (!releaseTab(tabId, keys)) return false;
  const had = heldUntil.delete(tabId);
  leftHolds.delete(tabId);
  lingering.delete(tabId);
  if (holdKeys.delete(tabId) || had) save(HOLDS_KEY);
  return true;
}

// DEVELOPMENT DIAGNOSTICS: when a tab was left (background.js activated), for
// the switch log's hiddenForMs; whether keep-ready holds a tab, as a switch
// to it is asked for (heldAtAsk; a hold ends as its tab is shown).
export function noteLeft(tabId, now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  leftAt.set(tabId, now);
  save(LEFT_KEY);
}
// A hold sure to be running (sent to a running process: `sure`, holdKeys)
// that runs at least a second more. Not one still on its way or only sent to
// a tab left a while ago: that may be waiting behind a suspended process's
// resume, and the tab shows dark all the same.
export const isHeld = (/** @type {number} */ tabId, now = Date.now()) => [...(holdKeys.get(tabId)?.values() ?? [])].some((h) => h.sent && h.sure && h.until > now + 1000);
export const switchFacts = (/** @type {number} */ tabId, now = Date.now()) => ({ heldAtAsk: platform?.keepTabsReady ? isHeld(tabId, now) : null, hiddenForMs: leftAt.has(tabId) ? now - leftAt.get(tabId) : null });

// The tab just left, at once: Safari can suspend it within a second, before
// the set comes round again. It had a page in front. Not before this copy's
// tabs are matched to the open ones (its first start after a Safari restart
// or an update: the id read for the tab left is another session's); a
// background that only stopped and started again has them matched as soon as
// it knows it owns the state (store.js decideOnce).
export function holdNow(tabId, now = Date.now()) {
  const s = cached();
  if (!platform?.keepTabsReady || !s || !isOwner() || !isSynced() || !minutesOf(s) || now - usedAt >= minutesOf(s) * 60_000) return;
  heldUntil.delete(tabId);
  takeBack(tabId);
  // Not a tab a held key only passed through: the tab the key stops on is
  // the one likely to be come back to, and a hold for each tab passed would
  // only push out one that is. The tick may still choose it, by its use
  // before (`passed`).
  if (passed.get(tabId)?.shown) return;
  hold(tabId, now, { left: true, onSent: (until) => trimSoon(tabId, until) });
  schedule(now, now + minutesOf(s) * 60_000);
}
// Past MAX_HELD (a run of switches, before the next tick): the tab used
// longest ago lets go, so no more than that are held at any time. Once the
// new hold has gone out and hasn't failed (TRIM_AFTER_MS), so a tab that
// can't be held doesn't cost a held one its hold (then back at the tick).
/** @param {number} tabId @param {number} until */
function trimSoon(tabId, until) {
  const timer = setTimeout(() => {
    const s = cached();
    if (heldUntil.get(tabId) !== until || !s?.tabs[tabId]) return; // it failed, or the tab's gone
    const holding = new Set([...heldUntil.keys(), ...lingering]);
    const oldestFirst = [...holding].filter((id) => id !== tabId).sort((a, b) => lastUse(s, a) - lastUse(s, b));
    for (const id of oldestFirst) {
      if (holding.size <= MAX_HELD) break;
      if (release(id, s, Date.now())) holding.delete(id);
    }
  }, TRIM_AFTER_MS);
  /** @type {any} */ (timer)?.unref?.(); // Node (tests) only
}

export async function tick(now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  ticks++;
  const s = await load();
  // Only the copy that owns the state (another copy's ids are its own:
  // shared/owner.js), and once its ids are matched to the open tabs.
  if (!isOwner()) return stop(now);
  if (!isSynced()) return;
  const minutes = minutesOf(s);
  await fromSession();
  const until = usedAt + minutes * 60_000;
  if (!minutes || now >= until) return stop(now);
  const setAside = noPage.size;
  for (const [tabId, retryAt] of noPage) if (retryAt <= now) noPage.delete(tabId);
  const chosen = chooseTabs(s, new Set(noPage.keys()));
  // The tabs kept: those chosen, and those just left that aren't (another
  // space's: a change of space and back returns to the tab left there), the
  // MAX_HELD used last of them. A tab left keeps the hold holdNow gave it
  // (75 s, as before the cap), not renewed (`lingering`).
  for (const [tabId, end] of leftHolds) if (end <= now) leftHolds.delete(tabId);
  const left = [...leftHolds.keys()].filter((tabId) => !chosen.includes(tabId) && s.tabs[tabId] && !s.tabs[tabId].active);
  const kept = new Set([...chosen, ...left].sort((a, b) => lastUse(s, b) - lastUse(s, a)).slice(0, MAX_HELD));
  lingering = new Set(left.filter((tabId) => kept.has(tabId)));
  for (const tabId of chosen) if (kept.has(tabId)) hold(tabId, now);
  // A hold no longer kept (its tab left the six, or the space changed) ends
  // now (release), and the next tick isn't set by its end. Left to run out,
  // it kept its process at foreground priority for up to 75 s (and while it
  // was still counted, it set ticks a second apart from its renewal time).
  for (const [tabId, keys] of holdKeys) {
    for (const [key, h] of keys) if (h.until <= now) keys.delete(key); // over by itself
    if (!keys.size) holdKeys.delete(tabId);
  }
  for (const tabId of new Set([...heldUntil.keys(), ...holdKeys.keys()])) if (!kept.has(tabId)) release(tabId, s, now);
  for (const known of [noPage, pageEvents, leftAt, passed]) for (const tabId of known.keys()) if (!(tabId in s.tabs)) known.delete(tabId);
  if (noPage.size !== setAside) save(NO_PAGE_KEY);
  schedule(now, until);
  if (!alarmSet && api.alarms) {
    alarmSet = true;
    api.alarms.create(KEEP_READY_ALARM, { periodInMinutes: 1 });
  }
}

// The next tick: in time to renew the hold that ends first (whenever it was
// placed: a tick, holdNow), or just after a lingering one ends (its place to
// another), at most TICK_MS away, and not past the end.
function schedule(now, until) {
  const ends = [...heldUntil].filter(([tabId]) => !lingering.has(tabId)).map(([, end]) => end - RENEW_BEFORE_MS + 500 - now);
  for (const tabId of lingering) ends.push((leftHolds.get(tabId) ?? 0) + 500 - now);
  const delay = Math.max(1000, Math.min(TICK_MS, until - now, ...ends));
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), delay);
  /** @type {any} */ (timer)?.unref?.(); // Node (tests) only
}

// Not used for long enough, turned off, or this copy no longer owns the
// state: no more holds, and those still running end now (with those of the
// background before this one, once read).
function stop(now = Date.now()) {
  clearTimeout(timer);
  timer = null;
  const releaseAll = () => {
    const s = cached();
    for (const tabId of new Set([...heldUntil.keys(), ...holdKeys.keys()])) release(tabId, s, now);
    if (heldUntil.size || holdKeys.size) save(HOLDS_KEY);
    heldUntil.clear();
    holdKeys.clear();
    leftHolds.clear();
    lingering.clear();
  };
  releaseAll();
  if (!sessionDone && platform?.keepTabsReady) void fromSession().then(releaseAll);
  if (noPage.size) {
    noPage.clear();
    save(NO_PAGE_KEY);
  }
  pageEvents.clear();
  alarmSet = false;
  void Promise.resolve(api.alarms?.clear(KEEP_READY_ALARM)).catch(() => {});
}

// The tabs of the space each window shows, but not the one in front, most
// recently used first (a tab only passed through by its use before: lastUse),
// at most MAX_HELD in all; none of `skip` (no page).
/** @param {import('../../types/margin').State} s @param {Set<number>} [skip] @returns {number[]} */
export function chooseTabs(s, skip = new Set()) {
  const windows = new Set(Object.values(s.tabs).map((t) => t.windowId));
  const chosen = [];
  for (const windowId of windows) {
    const spaceId = V.activeSpaceId(s, windowId);
    for (const t of Object.values(s.tabs)) if (t.windowId === windowId && !t.active && s.tabSpace[t.id] === spaceId && !skip.has(t.id)) chosen.push(t.id);
  }
  return chosen.sort((a, b) => lastUse(s, b) - lastUse(s, a)).slice(0, MAX_HELD);
}

// For tests.
export const keepReadyState = () => ({ usedAt, held: [...heldUntil.keys()], holds: Object.fromEntries([...holdKeys].map(([tabId, keys]) => [tabId, [...keys.keys()]])), lingering: [...lingering], passed: [...passed.keys()], noPage: [...noPage.keys()], alarmSet, ticks });
export function resetKeepReady() {
  clearTimeout(soon);
  soon = null;
  passed.clear();
  stop();
}
