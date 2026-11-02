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
// before it ends. Holds end by themselves; nothing needs undoing when this
// stops. Measured in the WebKit host: a busy page held hidden used 0.1
// CPU-seconds in 30 s (0.3% of a core); left alone, Safari suspended it.
// A tab Safari unloaded stays unloaded (a hold can't run without a page), and
// isn't tried again until a tab event says it has a page (pageChanged) or
// NO_PAGE_RETRY_MS has passed; a tab never shown has nothing to keep
// (background/tabs.js introduceTab).
import * as V from '../shared/view.js';
import { api, cached, isOwner, isSynced, load } from './store.js';
import { holdTab } from './tabs.js';
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
export const KEEP_READY_ALARM = 'margin-keep-ready'; // ticks if the background was stopped meanwhile

let usedAt = 0;
let savedAt = 0;
let timer = null;
let soon = null;
let ticks = 0; // for tests
let alarmSet = false;
const heldUntil = new Map(); // tabId → when its latest hold ends
const noPage = new Map(); // tabId → when to try it again: a hold found no page there
const pageEvents = new Map(); // tabId → how many times its page changed while a hold was on its way

/** @param {import('../../types/margin').State} s */
const minutesOf = (s) => {
  const minutes = Number(s?.settings?.keepTabsReadyMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
};
// What the background before this one knew: when Safari was last used, and
// the tabs set aside. Read once per background run; a tab whose page changed
// or that was shown before the read isn't set aside again by it.
/** @type {Promise<void> | null} */
let sessionRead = null;
let sessionDone = false;
const putBack = new Set();
function fromSession() {
  return (sessionRead ??= Promise.resolve(api.storage.session?.get([USED_KEY, NO_PAGE_KEY])).catch(() => null).then((stored) => {
    if (Number.isFinite(stored?.[USED_KEY])) usedAt = Math.max(usedAt, stored[USED_KEY]);
    for (const [id, retryAt] of Object.entries(stored?.[NO_PAGE_KEY] ?? {})) {
      const tabId = Number(id);
      if (Number.isFinite(retryAt) && !putBack.has(tabId) && !noPage.has(tabId)) noPage.set(tabId, retryAt);
    }
    sessionDone = true;
    putBack.clear();
  }));
}
let saving = false;
function saveNoPage() {
  if (saving) return;
  saving = true; // once for all the changes of this moment, after the read
  void fromSession().then(() => {
    saving = false;
    return api.storage.session?.set({ [NO_PAGE_KEY]: Object.fromEntries(noPage) });
  }).catch(() => {});
}
// A tab's page changed or it was shown: no longer set aside. Whether it was.
function takeBack(tabId) {
  if (!sessionDone && platform?.keepTabsReady) putBack.add(tabId); // (Chrome never reads it)
  if (!noPage.delete(tabId)) return false;
  saveNoPage();
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
// takes its place at once.
function hold(tabId, now) {
  if ((heldUntil.get(tabId) ?? 0) - now > RENEW_BEFORE_MS) return;
  const until = now + HOLD_MS;
  const events = pageEvents.get(tabId) ?? 0;
  heldUntil.set(tabId, until);
  void holdTab(tabId, HOLD_MS).then((held) => {
    if (heldUntil.get(tabId) !== until) return; // renewed meanwhile
    heldUntil.delete(tabId);
    if (held) return;
    if ((pageEvents.get(tabId) ?? 0) === events) {
      noPage.set(tabId, now + NO_PAGE_RETRY_MS);
      saveNoPage();
    }
    tickSoon();
  });
}

// A tab event says the tab has a page again or is getting one (its status or
// address changed: Margin restored it behind, it navigated): tried at once.
export function pageChanged(tabId) {
  if (heldUntil.has(tabId)) pageEvents.set(tabId, (pageEvents.get(tabId) ?? 0) + 1);
  if (takeBack(tabId)) tickSoon();
}

// A tab shown: whatever held it has ended (keepAwake ends as its page is
// shown, and a hold still on its way is forgotten); held afresh once it's
// left. Safari loads one it had unloaded as it's shown.
export function shown(tabId) {
  heldUntil.delete(tabId);
  takeBack(tabId);
}

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
  hold(tabId, now);
  schedule(now, now + minutesOf(s) * 60_000);
}

export async function tick(now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  ticks++;
  const s = await load();
  // Only the copy that owns the state (another copy's ids are its own:
  // shared/owner.js), and once its ids are matched to the open tabs.
  if (!isOwner()) return stop();
  if (!isSynced()) return;
  const minutes = minutesOf(s);
  await fromSession();
  const until = usedAt + minutes * 60_000;
  if (!minutes || now >= until) return stop();
  const setAside = noPage.size;
  for (const [tabId, retryAt] of noPage) if (retryAt <= now) noPage.delete(tabId);
  const chosen = new Set(chooseTabs(s, new Set(noPage.keys())));
  for (const tabId of chosen) hold(tabId, now);
  // A hold no longer chosen (its tab left the six, or the space changed) is
  // forgotten: it ends by itself, and the next tick isn't set by its end.
  // Kept, it set ticks a second apart from its renewal time until it ended
  // (20 s), on every switch to a tab outside the six.
  for (const tabId of heldUntil.keys()) if (!chosen.has(tabId)) heldUntil.delete(tabId);
  for (const known of [noPage, pageEvents]) for (const tabId of known.keys()) if (!(tabId in s.tabs)) known.delete(tabId);
  if (noPage.size !== setAside) saveNoPage();
  schedule(now, until);
  if (!alarmSet && api.alarms) {
    alarmSet = true;
    api.alarms.create(KEEP_READY_ALARM, { periodInMinutes: 1 });
  }
}

// The next tick: in time to renew the hold that ends first (whenever it was
// placed: a tick, holdNow), at most TICK_MS away, and not past the end.
function schedule(now, until) {
  const ends = [...heldUntil.values()].map((end) => end - RENEW_BEFORE_MS + 500 - now);
  const delay = Math.max(1000, Math.min(TICK_MS, until - now, ...ends));
  clearTimeout(timer);
  timer = setTimeout(() => void tick(), delay);
  /** @type {any} */ (timer)?.unref?.(); // Node (tests) only
}

// Not used for long enough (or turned off): no more holds; the last ones end
// by themselves.
function stop() {
  clearTimeout(timer);
  timer = null;
  heldUntil.clear();
  if (noPage.size) {
    noPage.clear();
    saveNoPage();
  }
  pageEvents.clear();
  alarmSet = false;
  void Promise.resolve(api.alarms?.clear(KEEP_READY_ALARM)).catch(() => {});
}

// The tabs of the space each window shows, but not the one in front, most
// recently used first, at most MAX_HELD in all; none of `skip` (no page).
/** @param {import('../../types/margin').State} s @param {Set<number>} [skip] @returns {number[]} */
export function chooseTabs(s, skip = new Set()) {
  const windows = new Set(Object.values(s.tabs).map((t) => t.windowId));
  const chosen = [];
  for (const windowId of windows) {
    const spaceId = V.activeSpaceId(s, windowId);
    for (const t of Object.values(s.tabs)) if (t.windowId === windowId && !t.active && s.tabSpace[t.id] === spaceId && !skip.has(t.id)) chosen.push(t);
  }
  return chosen.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).slice(0, MAX_HELD).map((t) => t.id);
}

// For tests.
export const keepReadyState = () => ({ usedAt, held: [...heldUntil.keys()], noPage: [...noPage.keys()], alarmSet, ticks });
export function resetKeepReady() {
  clearTimeout(soon);
  soon = null;
  stop();
}
