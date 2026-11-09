// Tabs across Margin windows, as Arc's (app/WINDOWS.md §9). Two windows of the profile on one space list the same
// tabs, and a Safari tab is in one window at a time, so the tab follows the window in front:
// - chosen in window W while it's in V, it moves to W (tabs.move keeps its page: probed in Safari 2026-11-09);
// - V keeps it chosen, away (state/model.ts awayByWindow), with Margin's stand-in page in front of V
//   (away/away.html), which shows the tab's picture, faded;
// - V coming to the front again brings it back, the same way.
// Nothing here runs per frame or per page: only on a choice of a tab in another window, and on a focus change
// between two of this copy's windows.
// Pictures (captureVisibleTab, JPEG) are kept in this background's memory only: never stored, never logged, never
// synced. One per tab at most, dropped once no window shows the tab away.
import * as M from '../state/model.ts';
import * as V from '../shared/view.ts';
import { api, cached, load, mutate, now } from './store.ts';
import { focusTab, markMarginOpening } from './tabs.ts';
import { appLink } from './app-link.ts';
import { handoffMoving, isParked } from './handoff.ts';
import { AWAY_PATH, isAwayPage } from '../shared/away.ts';

// Times (tests shorten them: setAwayTiming).
const TIMING = {
  // A move waits this long at most for the picture of the tab leaving (a window behind: ~210 ms, probed).
  captureMs: 350,
  // A picture taken as its window was left stands for a move this long after.
  freshMs: 20_000,
  // A focus change settles this long before a tab follows it (a handoff's or Safari's own focus bounces).
  settleMs: 120,
};
const PICTURE = { format: 'jpeg', quality: 60 } as const;

/** tab id → its picture */
const pictures: Map<number, { data: string, at: number, windowId: number }> = new Map();
/** window id → its stand-in's tab id */
const standIns: Map<number, number> = new Map();
/** windows whose stand-in is being made: its events come before its id */
const making: Set<number> = new Set();
// Moves under way: the focus changes and activations they cause are Margin's own.
let moves = 0;
let lastFocused: number | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
// What the last focus change came to (for the dev probe: numbers only): 1 heard, 2 another focus since, 3 nothing
// away, 4 a window tabs don't follow into, 5 its tab gone or here already, 6 its window being moved by the handoff,
// 7 brought, 8 the window left pictured (or not needed), 9 a move under way.
const focusSeen = { windowId: (null as number | null), outcome: 0 };

const standInUrl = () => api.runtime.getURL(AWAY_PATH);

// Whether a tab is a stand-in (never a Margin tab: its events are left out, background.ts). `tab`: Safari's,
// when the event has it.
export function isStandIn(tabId: number, windowId: number | null | undefined, tab: any = null) {
  if (tab && (isAwayPage(tab.url) || isAwayPage(tab.pendingUrl))) return true;
  for (const id of standIns.values()) if (id === tabId) return true;
  return windowId != null && making.has(windowId) && !cached()?.tabs?.[tabId];
}

// Whether tabs follow into (and out of) a window: not one the app has parked (out of sight), not one it draws
// nothing over (a plain Safari window, no sidebar), not while its handoff moves it.
export const follows = (windowId: number | null | undefined) => windowId != null && !isParked(windowId) && appLink.drawn?.(windowId) !== false && !handoffMoving(windowId);
// Whether a tab may leave its window for another: not a plain Safari window (the person sees its tab bar there), not
// while the handoff moves it. A parked one may: its tab is in the list of a window in front.
const leaves = (windowId: number | null | undefined) => windowId != null && appLink.drawn?.(windowId) !== false && !handoffMoving(windowId);
/** tab id → its move under way */
const inFlight: Map<number, { to: number, done: Promise<any> }> = new Map();

async function capture(windowId: number, ms: number): Promise<string | null> {
  let timer;
  const shot = Promise.resolve().then(() => api.tabs.captureVisibleTab(windowId, PICTURE)).catch(() => null);
  const late = new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    // One that comes after the move would be of something else: left.
    const data = await Promise.race([shot, late]);
    return typeof data === 'string' && data.startsWith('data:image/') ? data : null;
  } finally {
    clearTimeout(timer);
  }
}
function keepPicture(tabId: number, data: string | null, windowId: number) {
  if (data) pictures.set(tabId, { data, at: Date.now(), windowId });
}
// Pictures of tabs no window shows away, but for ones just taken (a move may come for them).
function prunePictures() {
  const away = new Set(Object.values(cached()?.awayByWindow ?? {}));
  for (const [tabId, p] of pictures) if (!away.has(tabId) && Date.now() - p.at > TIMING.freshMs) pictures.delete(tabId);
}

// The window's stand-in (made, or the one it has), in front unless `front` is false (it's brought there once the
// tab's picture is taken). Its id, or null.
async function standIn(windowId: number, index: number | undefined, { front = true }: { front?: boolean } = {}) {
  let id = standIns.get(windowId) ?? null;
  if (id == null) {
    // One from before this background started (its id not known here).
    const tabs = await Promise.resolve(api.tabs.query({ windowId })).catch((): BrowserTab[] => []);
    id = tabs.find((t) => isAwayPage(t.url) || isAwayPage(t.pendingUrl))?.id ?? null;
  }
  if (id != null) {
    const shown = await Promise.resolve(front ? api.tabs.update(id, { active: true }) : api.tabs.get(id)).catch(() => null);
    if (shown) {
      standIns.set(windowId, id);
      // (Its page draws the window's away tab again: it may be another one now.)
      void Promise.resolve(api.runtime.sendMessage({ type: 'awayChanged' })).catch(() => {});
      return id;
    }
    standIns.delete(windowId);
  }
  making.add(windowId);
  // (A tab made in a parked window is Margin's, not a link from another app: handoff.ts tabCreated.)
  if (isParked(windowId)) markMarginOpening();
  try {
    const tab = await api.tabs.create({ windowId, url: standInUrl(), active: front, ...(Number.isInteger(index) ? { index } : {}) });
    if (tab?.id != null) standIns.set(windowId, tab.id);
    return tab?.id ?? null;
  } finally {
    making.delete(windowId);
  }
}
// A stand-in not needed any more: closed (the window has a tab of its own in front).
function dropStandIn(windowId: number) {
  const id = standIns.get(windowId);
  standIns.delete(windowId);
  if (id != null) void Promise.resolve(api.tabs.remove(id)).catch(() => {});
}

/**
 * The tab to window `to` from the one it's in, which keeps it chosen, away, with its picture in front if it showed
 * it. Then shown there (focusTab). A move Safari refuses (a private window and a plain one): shown where it is.
 * @param tab as Safari has it
 */
export function bringTab(tab: { id: number, windowId: number, active?: boolean, index?: number }, to: number, options: { source?: string, deadline?: number, raise?: boolean } = {}) {
  const under = inFlight.get(tab.id);
  if (under?.to === to) return under.done; // (a click on the stand-in and its window's focus, together)
  const done = move(tab, to, options).finally(() => { if (inFlight.get(tab.id)?.done === done) inFlight.delete(tab.id); });
  inFlight.set(tab.id, { to, done });
  return done;
}
async function move(tab: { id: number, windowId: number, active?: boolean, index?: number }, to: number, { source = 'follow', deadline, raise = true }: { source?: string, deadline?: number, raise?: boolean }) {
  const from = tab.windowId;
  if (from === to || !leaves(from)) return focusTab(tab.id, { source, deadline, raise });
  const toWasAway = cached()?.awayByWindow?.[to] != null;
  moves++;
  let madeAway = false;
  try {
    if (tab.active === true) {
      // Its picture while it's still there (one taken as its window was left stands: precapture), the window's
      // stand-in made behind it and the state written meanwhile; then the stand-in to the front, before the move
      // (Safari would bring a neighbour forward there, or close the window with its last tab gone).
      const had = pictures.get(tab.id);
      const fresh = had && had.windowId === from && Date.now() - had.at < TIMING.freshMs;
      const picturing = fresh || isParked(from) ? Promise.resolve(null) : capture(from, TIMING.captureMs);
      const standing = standIn(from, Number.isInteger(tab.index) ? (tab.index as number) + 1 : undefined, { front: false });
      const marking = mutate((s) => M.setAway(s, from, tab.id));
      madeAway = true;
      keepPicture(tab.id, await picturing, from);
      const id = await standing;
      void marking.catch(() => {}); // (written in order: before anything the move's events write)
      if (id == null || !(await Promise.resolve(api.tabs.update(id, { active: true })).catch(() => null))) throw new Error('no stand-in');
    }
    const s = cached() ?? (await load());
    const order = s.tabs[tab.id]?.order;
    const index = Number.isFinite(order) ? M.stripIndexFor(s, to, (order as number)) : undefined;
    const moved = await api.tabs.move(tab.id, { windowId: to, index: index ?? -1 });
    const landed = Array.isArray(moved) ? moved[0] : moved;
    // Not waited for: the state's writes go one at a time, this one behind the syncs Safari's attach events start
    // (background.ts); it's still before the activation's, which comes after it in the queue.
    void mutate((st) => M.movedTab(st, tab.id, to, landed?.index)).catch(() => {});
  } catch (err) {
    // Not moved: shown in its own window, as before, and nothing left away.
    if (madeAway) {
      await mutate((s) => M.setAway(s, from, null)).catch(() => {});
      dropStandIn(from);
    }
    moves--;
    return focusTab(tab.id, { source, deadline, raise });
  }
  try {
    const shown = await focusTab(tab.id, { source, deadline, raise });
    // Its activation writes this too (background.ts), unless Safari made it active with the move and says
    // nothing more: in front here, the window's space its own, nothing away here, and this window's stand-in gone.
    void mutate((s) => M.followTab(M.activateTab(s, tab.id, to, now()), tab.id, to)).catch(() => {});
    shownIn(to, tab.id, toWasAway);
    return shown;
  } finally {
    moves--;
    prunePictures();
  }
}

// A tab chosen in `windowId` (a row, a pin, the next-tab keys): brought there from another window, else shown.
export function showTab(tabId: number, windowId: number | null | undefined, options: { source?: string, deadline?: number } = {}) {
  const rec = cached()?.tabs?.[tabId];
  if (rec && windowId != null && rec.windowId !== windowId && follows(windowId)) return bringTab(rec, windowId, options);
  return focusTab(tabId, options);
}

// A tab of its own shown in a window (its activation, background.ts): its stand-in goes. `wasAway`: the window
// showed a tab away just before (its stand-in may be one this background didn't make).
export function shownIn(windowId: number, tabId: number, wasAway: boolean) {
  if (standIns.get(windowId) === tabId) return;
  if (standIns.has(windowId)) return void dropStandIn(windowId);
  if (!wasAway) return;
  void Promise.resolve(api.tabs.query({ windowId })).then((tabs) => {
    for (const t of tabs) if (isAwayPage(t.url) || isAwayPage(t.pendingUrl)) void Promise.resolve(api.tabs.remove(t.id)).catch(() => {});
  }, () => {});
}

// A tab closed: each window that showed it away shows its next tab of the space (else its stand-in becomes its
// start page). `awayIn`: those windows, as the state had them before the close.
export async function tabClosed(tabId: number, awayIn: number[]) {
  pictures.delete(tabId);
  for (const [windowId, id] of standIns) if (id === tabId) standIns.delete(windowId); // a stand-in closed itself
  for (const windowId of awayIn) {
    const s = await load();
    const next = M.recentTabOfSpace(s, windowId, V.activeSpaceId(s, windowId), tabId);
    if (next) {
      const shown = await focusTab(next.id, { source: 'away tab closed', raise: false }).catch(() => null);
      if (shown) shownIn(windowId, next.id, true);
      continue;
    }
    const id = standIns.get(windowId);
    standIns.delete(windowId);
    if (id != null) await Promise.resolve(api.tabs.update(id, { url: api.runtime.getURL('newtab/newtab.html#launcher') })).catch(() => null);
  }
}

export function windowGone(windowId: number) {
  standIns.delete(windowId);
  if (lastFocused === windowId) lastFocused = null;
}

// A window of this copy's in front (windows.onFocusChanged): its chosen tab, if it's away, follows it; else the
// window left keeps a picture of its tab in front if this one lists it (a choice here would move it: no wait then).
export function focusChanged(windowId: number) {
  if (!Number.isInteger(windowId) || windowId < 0) return; // Safari left, or another profile's window
  const left = lastFocused;
  lastFocused = windowId;
  focusSeen.windowId = windowId;
  focusSeen.outcome = 1;
  if (moves > 0) return void (focusSeen.outcome = 9); // Margin's own move brought it forward
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusTimer = null;
    void follow(windowId, left).catch(() => {});
  }, TIMING.settleMs);
}
async function follow(windowId: number, left: number | null) {
  const seen = (outcome: number) => { if (focusSeen.windowId === windowId) focusSeen.outcome = outcome; };
  if (lastFocused !== windowId) return seen(2);
  if (moves > 0) return seen(9);
  const s = await load();
  const awayId = s.awayByWindow?.[windowId];
  if (awayId != null) {
    if (!follows(windowId)) return seen(4);
    const live = await Promise.resolve(api.tabs.get(awayId)).catch(() => null);
    if (!live || live.windowId === windowId) return seen(5);
    // (Another window to the front meanwhile, or a move: not this one's.)
    if (lastFocused !== windowId) return seen(2);
    if (moves > 0) return seen(9);
    if (handoffMoving(live.windowId)) return seen(6);
    seen(7);
    await bringTab(live, windowId, { source: 'window in front', raise: false }).catch(() => null);
    return;
  }
  seen(3);
  if (left != null && left !== windowId) await precapture(s, left, windowId);
}
async function precapture(s: any, left: number, front: number) {
  if (!follows(left) || !follows(front)) return;
  const shown = Object.values(s.tabs).find((t) => t.windowId === left && t.active);
  if (!shown || isAwayPage(shown.url)) return;
  const spaceId = s.tabSpace?.[shown.id];
  if (spaceId == null || V.activeSpaceId(s, front) !== spaceId) return;
  const had = pictures.get(shown.id);
  if (had && had.windowId === left && Date.now() - had.at < 5000) return;
  const data = await capture(left, 1000);
  const still = cached()?.tabs?.[shown.id];
  if (still?.windowId === left && still.active) keepPicture(shown.id, data, left);
}

// What a stand-in shows (handlers.ts awayShown): its window's away tab, with its picture if one was taken.
export function shownAway(windowId: number | null | undefined) {
  const s = cached();
  const tabId = windowId != null ? s?.awayByWindow?.[windowId] : null;
  const tab = tabId != null ? s?.tabs?.[tabId] : null;
  if (!tab) return null;
  return { tabId: tab.id, title: String(tab.title || tab.url || ''), url: String(tab.url ?? ''), picture: pictures.get(tab.id)?.data ?? null };
}

// The stand-ins open as this background starts: one whose window shows nothing away (Safari restored it, or its
// tab is gone) is closed, or, the only tab of its window, becomes its start page; a second one in a window closed.
/** @param tabs Safari's open tabs (the start's own sync asked for them: store.ts resync) */
export async function sweep(tabs: any[]) {
  const s = await load();
  const seen = new Set<any>();
  for (const t of tabs) {
    if (!(isAwayPage(t.url) || isAwayPage(t.pendingUrl))) continue;
    const awayId = s.awayByWindow?.[t.windowId];
    const wanted = awayId != null && s.tabs[awayId] && s.tabs[awayId].windowId !== t.windowId && !seen.has(t.windowId);
    if (wanted) {
      seen.add(t.windowId);
      standIns.set(t.windowId, t.id);
      continue;
    }
    const alone = !tabs.some((o) => o.windowId === t.windowId && o.id !== t.id);
    if (alone) await Promise.resolve(api.tabs.update(t.id, { url: api.runtime.getURL('newtab/newtab.html#launcher') })).catch(() => null);
    else await Promise.resolve(api.tabs.remove(t.id)).catch(() => null);
  }
  // A window whose away tab is gone or back in it: nothing away.
  const stale = Object.entries(s.awayByWindow ?? {}).filter(([w, id]) => !seen.has(Number(w)) || !s.tabs[id]).map(([w]) => Number(w));
  if (stale.length) await mutate((st) => stale.reduce((next, w) => M.setAway(next, w, null), st));
}

// For tests.
export function setAwayTiming(given: Partial<typeof TIMING>) {
  Object.assign(TIMING, given);
}
export const awayInternals = { pictures, standIns, focusSeen, reset() { pictures.clear(); standIns.clear(); making.clear(); moves = 0; lastFocused = null; if (focusTimer) clearTimeout(focusTimer); focusTimer = null; } };
