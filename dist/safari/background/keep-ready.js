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
// a tab never shown still can't be helped (content/core.js arriveCovered).
import * as V from '../shared/view.js';
import { api, cached, isOwner, isSynced, load } from './store.js';
import { holdTab } from './tabs.js';
import { platform } from '../shared/platform.js';

const HOLD_MS = 75_000;
const RENEW_BEFORE_MS = 20_000; // a hold with less than this left is renewed
const TICK_MS = 60_000; // at most this between ticks (the next is set by the holds' ends)
const RETRY_MS = 60_000; // a tab a hold couldn't run in (no page): not before this again
const SOON_MS = 1500; // after a switch or a change of space: the new set, soon
const MAX_HELD = 24;
const USED_KEY = 'keepReadyUsedAt'; // storage.session: the background can stop and start again
export const KEEP_READY_ALARM = 'margin-keep-ready'; // ticks if the background was stopped meanwhile

let usedAt = 0;
let usedRead = false;
let savedAt = 0;
let timer = null;
let soon = null;
let alarmSet = false;
const heldUntil = new Map(); // tabId → when its latest hold ends (or, failed, when to try again)

/** @param {import('../../types/margin').State} s */
const minutesOf = (s) => {
  const minutes = Number(s?.settings?.keepTabsReadyMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
};
async function lastUsed() {
  if (!usedRead) {
    usedRead = true;
    const stored = await Promise.resolve(api.storage.session?.get(USED_KEY)).catch(() => null);
    if (Number.isFinite(stored?.[USED_KEY])) usedAt = Math.max(usedAt, stored[USED_KEY]);
  }
  return usedAt;
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
// couldn't run (no page) waits RETRY_MS rather than being tried every tick.
function hold(tabId, now) {
  if ((heldUntil.get(tabId) ?? 0) - now > RENEW_BEFORE_MS) return;
  const until = now + HOLD_MS;
  heldUntil.set(tabId, until);
  void holdTab(tabId, HOLD_MS).then((held) => {
    if (heldUntil.get(tabId) !== until) return; // renewed meanwhile
    if (held) heldUntil.delete(tabId);
    else heldUntil.set(tabId, now + RETRY_MS);
  });
}

// A tab shown: whatever held it has ended (keepAwake ends as its page is
// shown); held afresh once it's left.
export function shown(tabId) {
  heldUntil.delete(tabId);
}

// The tab just left, at once: Safari can suspend it within a second, before
// the set comes round again.
export function holdNow(tabId, now = Date.now()) {
  const s = cached();
  if (!platform?.keepTabsReady || !s || !isOwner() || !isSynced() || !minutesOf(s) || now - usedAt >= minutesOf(s) * 60_000) return;
  heldUntil.delete(tabId);
  hold(tabId, now);
  schedule(now, now + minutesOf(s) * 60_000);
}

export async function tick(now = Date.now()) {
  if (!platform?.keepTabsReady) return;
  const s = await load();
  // Only the copy that owns the state (another copy's ids are its own:
  // shared/owner.js), and once its ids are matched to the open tabs.
  if (!isOwner()) return stop();
  if (!isSynced()) return;
  const minutes = minutesOf(s);
  const until = (await lastUsed()) + minutes * 60_000;
  if (!minutes || now >= until) return stop();
  for (const tabId of chooseTabs(s)) hold(tabId, now);
  for (const tabId of heldUntil.keys()) if (!(tabId in s.tabs)) heldUntil.delete(tabId);
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
  alarmSet = false;
  void Promise.resolve(api.alarms?.clear(KEEP_READY_ALARM)).catch(() => {});
}

// The tabs of the space each window shows, but not the one in front, most
// recently used first, at most MAX_HELD in all.
/** @param {import('../../types/margin').State} s @returns {number[]} */
export function chooseTabs(s) {
  const windows = new Set(Object.values(s.tabs).map((t) => t.windowId));
  const chosen = [];
  for (const windowId of windows) {
    const spaceId = V.activeSpaceId(s, windowId);
    for (const t of Object.values(s.tabs)) if (t.windowId === windowId && !t.active && s.tabSpace[t.id] === spaceId) chosen.push(t);
  }
  return chosen.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0)).slice(0, MAX_HELD).map((t) => t.id);
}

// For tests.
export const keepReadyState = () => ({ usedAt, held: [...heldUntil.keys()], alarmSet });
