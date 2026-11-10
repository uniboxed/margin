// Showing, opening and reaching into tabs.
//
// A switch is plain (PLAN.md §1, §7; Margin 2 Phase 2 step 8, brought forward
// from Phase 3): `tabs.update(active)`, and the window focused if it isn't.
// Safari's own blink while it draws the tab is accepted. What hid it before
// (wakes and holds, introductions flipping a never-shown tab forward and
// back, restores behind the page, covers and paint barriers, keep-ready,
// the warm-up's wakes, the slow-Safari plan) is gone with its settings: in
// real Safari (2026-11-05) its flips and waits made the overlay's
// highlight go to the new tab, back, and forward again, and every switch
// cost two extra activations and a storage write each. Each switch's
// timeline is one line in Margin.app's log (background/switch-log.ts).
import * as M from '../state/model.ts';
import { api, cached, isOwner, isSynced, mutate, now, openTabsAsked, thisCopy } from './store.ts';
import { commandKeys } from '../shared/shortcuts.ts';
import { appLink } from './app-link.ts';
import { cutOffAction, cutOffInPage, oldOwnPageAddress } from './cut-off.ts';
import { tellNotice } from './notices.ts';
import { oldSleepPage } from '../shared/sleep.ts';
import { noteClosing, takeClosing } from './closing.ts';
import { appLog, switchLog } from './switch-log.ts';
import { noteReopened } from './search-engine.ts';

// When each tab was last shown (a diagnostic in tabs.onUpdated).
export const shownAt = new Map(); // tabId → when it was last activated

// New tabs being handed back (⌘T, handlers.ts newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set<any>();
// background.ts's handler of an activation (set once): a ⌘T tab that stays
// after all has its activation, left out meanwhile, told now.
let activated: ((info: { tabId: number, windowId: number }) => unknown) | null = null;
export function setActivationHook(fn: (info: { tabId: number, windowId: number }) => unknown) {
  activated = fn;
}
// A ⌘T tab that stays after all (its page had no palette in time, it was
// used, Margin couldn't bring the page back: handlers.ts handOff; it went
// somewhere: background.ts): no longer handed off, and its activation, left
// out meanwhile, told now if it's still in front.
export function keepHandedOff(tabId: number) {
  if (!handingOff.delete(tabId)) return;
  void api.tabs.get(tabId).then((t) => t?.active && activated?.({ tabId, windowId: t.windowId }), () => {});
}

// ---- switching -----------------------------------------------------------------
let focusGen = 0;
const focusing = new Map(); // tabId → overlapping Margin focus requests
export const isFocusing = (tabId: number) => (focusing.get(tabId) ?? 0) > 0;
export const anyFocusing = () => focusing.size > 0;
// Switches asked for and not answered yet (background.ts counts each timed
// request from its arrival; focusTab until it answers): the open-tab repair
// gives way to them (giveWay). Each counts for SWITCH_HOLDS_MS at most.
const switchesAsked: Set<{ at: number }> = new Set();
const SWITCH_HOLDS_MS = 8000;
/** background.ts, focusTab: a switch asked for; the function returned says it's answered. */
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
// Tabs Margin itself just brought to the front: their activation isn't the
// user's (userSwitched), which would call off a new tab's wait (openBehind).
const activatedByMargin = new Map(); // tabId → when Margin asked Safari to bring it to the front
const OWN_ACTIVATION_MS = 1500;
// Switches per window (the user's, and Margin's), so a new tab's wait in one
// window (openBehind) isn't called off by a switch in another.
const windowGens = new Map(); // windowId → count
const windowGen = (windowId: number) => windowGens.get(windowId) ?? 0;
function movedOn(windowId: number | null | undefined) {
  if (windowId == null) return 0;
  windowGens.set(windowId, windowGen(windowId) + 1);
  return windowGen(windowId);
}
export function activating(tabId: number) {
  const at = Date.now();
  activatedByMargin.set(tabId, at);
  setTimeout(() => {
    if (Date.now() - (activatedByMargin.get(tabId) ?? 0) >= OWN_ACTIVATION_MS) activatedByMargin.delete(tabId);
  }, OWN_ACTIVATION_MS);
  return at;
}
/** The user chose a tab themselves (Safari's tab bar, ⌘1–9): a new tab's wait in that window stops. */
export function userSwitched(tabId: number | null = null, windowId: number | null = null) {
  if (tabId != null && (isFocusing(tabId) || Date.now() - (activatedByMargin.get(tabId) ?? 0) < OWN_ACTIVATION_MS)) return;
  focusGen++;
  movedOn(windowId);
}

// A page that asked for a switch waits for the answer until its `deadline`:
// nothing that can't be taken back (a tab opened) within REFUSE_MS of it.
const REFUSE_MS = 1000;
const TOO_LATE = 'Too late: the page stopped waiting for this switch';
function tooLate(deadline: number | undefined) {
  if (Number.isFinite(deadline) && Date.now() > (deadline as number) - REFUSE_MS) throw new Error(TOO_LATE);
}
// A Safari call held to `until`: its value, or null if it's not answered by then.
async function answerBy<T>(promise: Promise<T>, until: number): Promise<T | null> {
  let timer: number | undefined;
  const late = new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, until - Date.now())); });
  try {
    return (await Promise.race([promise, late]) as T | null);
  } finally {
    clearTimeout(timer);
  }
}

// The plain switch: the tab to the front of its window, and the window
// focused only if it isn't already (re-focusing the window in front can move
// the keyboard out of the page in Safari). A tab suspected of running a
// copy of Margin that's gone is asked first, briefly (repairCutOff: put out
// of sight, the window's overlay says so). Resolves { tab } once Safari has
// carried it out; fails if it couldn't (the tab is gone). `source`: what
// asked, for the switch's line in the log (switch-log.ts); `raise: false`
// leaves the window's focus alone; `deadline`: when the page that asked stops
// waiting (no switch is started within REFUSE_MS of it).
export type FocusOptions = { source?: string, raise?: boolean, deadline?: number };
const UPDATE_ANSWER_MS = 1000;
// Within a page's deadline, what's left for the answer to reach it: the
// background answers "too late" REPLY_GUARD_MS (500) before the deadline
// (background.ts), so the switch is done 300 ms before that.
const ANSWER_LEAVES_MS = 800;
// A tab suspected of a gone copy (cutOffSuspects): asked this long at most before its switch.
const CUT_OFF_SWITCH_MS = 150;
export async function focusTab(tabId: number, { source = 'other', raise = true, deadline }: FocusOptions = {}): Promise<{ tab: any }> {
  const over = switchAsked();
  focusing.set(tabId, (focusing.get(tabId) ?? 0) + 1);
  focusGen++;
  const line = switchLog.begin(tabId, source, cached()?.tabs[tabId]?.windowId ?? null);
  try {
    tooLate(deadline);
    if (cutOffSuspects.has(tabId)) {
      const known = cached()?.tabs[tabId];
      if (known?.url) {
        const cut = await repairCutOff(known, { ms: CUT_OFF_SWITCH_MS, forSwitch: true }).catch(() => false);
        line.step(`cut off: ${cut || 'no'}`);
      }
    }
    activating(tabId);
    movedOn(cached()?.tabs[tabId]?.windowId ?? null);
    line.step('tabs.update');
    // Safari's answer, UPDATE_ANSWER_MS (1 s) at most: one stuck behind the tab's
    // hung process (2026-11-03) is carried out when Safari gets to it, so the
    // switch is answered as made rather than its page told it failed. A tab
    // that's gone fails at once.
    // Held to the page's deadline too (less what the answer needs to reach
    // it), so a page always hears the switch was made rather than "too late".
    const update = Promise.resolve().then(() => api.tabs.update(tabId, { active: true }));
    const byDeadline = Number.isFinite(deadline) && (deadline as number) - ANSWER_LEAVES_MS < Date.now() + UPDATE_ANSWER_MS;
    const until = byDeadline ? (deadline as number) - ANSWER_LEAVES_MS : Date.now() + UPDATE_ANSWER_MS;
    const answered = await answerBy(update.then((t) => ({ tab: t })), until);
    if (!answered) {
      line.step(byDeadline ? 'no answer by its page\'s deadline' : `no answer in ${UPDATE_ANSWER_MS}`);
      void update.catch(() => {});
    } else line.step('updated');
    const tab = answered?.tab ?? null;
    const windowId = tab?.windowId ?? cached()?.tabs[tabId]?.windowId ?? null;
    line.window(windowId);
    // A tab in a window Margin.app has parked (out of sight, docs/HANDOFF.md
    // §2.5): raising it would focus it and show nothing. The tab is in front
    // there now, and the app is asked to hand off to that window instead. Not
    // linked (the app can't be told), it's raised as before.
    if (raise && parkedRaise(windowId, tabId)) {
      line.step('its window is parked: the app asked to show it');
    } else if (raise) {
      // The window to the front: waited for only while the page's deadline
      // allows (Safari's windows calls can wait behind a stalled tab too); it's
      // carried out either way.
      const raising = focusWindow(windowId, line);
      if (Number.isFinite(deadline)) await answerBy(raising, (deadline as number) - ANSWER_LEAVES_MS);
      else await raising;
    }
    return { tab: { ...(tab ?? {}), id: tabId, active: true, windowId } };
  } catch (err) {
    line.fail(err);
    throw err;
  } finally {
    over();
    const left = (focusing.get(tabId) ?? 1) - 1;
    if (left > 0) focusing.set(tabId, left);
    else focusing.delete(tabId);
  }
}
// A tab Margin's UI asked for in a window the app has parked: the app told (parkedActivity `raise`),
// true once it is; false when the window isn't parked or the app can't be told.
function parkedRaise(windowId: number | null, tabId: number) {
  return windowId != null && appLink.parked?.(windowId) === true && appLink.parkedActivity(windowId, 'raise', tabId);
}
// Whether a tab's window is one the app has parked (out of sight): a tab found for a row is one in a
// window that isn't, when there's a choice.
export const inParkedWindow = (tab: { windowId?: number } | null | undefined) => tab?.windowId != null && appLink.parked?.(tab.windowId) === true;
// The window comes forward only if it isn't already (see focusTab).
async function focusWindow(windowId: number | null, line: { step(what: string): void } | null = null) {
  if (!api.windows || windowId == null) return;
  const win = await api.windows.get(windowId).catch(() => null);
  if (win && !win.focused) {
    await api.windows.update(windowId, { focused: true }).catch(() => {});
    line?.step('window focused');
  }
}

// The tab a page asked for, as this copy has it. Pages draw from storage,
// whose tab ids can be from before this copy's first sync (the last session's,
// another copy's): a row then also says its tab's address and place
// (`hint`), which find it among the open tabs (in the asking page's window
// first, then the nearest place). Null if it's gone.
// The id itself stands only if the page drew this copy's tab ids, matched to
// the open tabs (`hint.from`: whose they were, shared/stored.ts); ids from
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
export async function resolveTab(tabId: number, hint: { url?: string, index?: number, title?: string, from?: { origin?: string, since?: number, synced?: boolean } | null } | null | undefined, preferWindow: number | null | undefined, { deadline }: { deadline?: number } = {}) {
  const me = thisCopy();
  const ours = !hint || ('from' in hint ? hint.from?.origin === me.origin && (hint.from.since == null || hint.from.since === me.since) && hint.from.synced !== false : true);
  let live = null;
  if (Number.isInteger(tabId) && ours) {
    const asking = lookupTab(tabId);
    const timedAsk = Number.isFinite(deadline);
    const known = timedAsk && isSynced() ? cached()?.tabs[tabId] ?? null : null;
    const answered = known ? await answerBy(asking, Date.now() + RESOLVE_KNOWN_MS) : timedAsk ? await answerBy(asking, (deadline as number) - RESOLVE_LEAVES_MS) : await asking;
    if (!answered && !known) console.warn(`[margin] Safari hasn't said where tab ${tabId} is in time: switching to it as Margin last saw it`);
    live = answered ? answered.tab : (known ?? cached()?.tabs[tabId] ?? null);
  }
  if (live || !hint?.url) return live;
  const key = M.normalizeUrl(hint.url);
  const nearest = (tabs: any[]) => {
    // (A sleeping tab by its page's address: model.ts seenTab.)
    let candidates = tabs.filter((t) => { const seen = M.seenTab(t); return M.normalizeUrl(seen.url || seen.pendingUrl || '') === key; });
    // The same page open twice: the one with the row's title, if that tells them apart.
    if (candidates.length > 1 && hint.title && candidates.some((t) => t.title === hint.title)) candidates = candidates.filter((t) => t.title === hint.title);
    if (!candidates.length) return null;
    // The asking page's window first, then a window that isn't parked (docs/HANDOFF.md §2.5), then the nearest place.
    const distance = (t: { windowId?: number, index?: number }) => (t.windowId === preferWindow ? 0 : 2e6) + (inParkedWindow(t) ? 1e6 : 0) + Math.abs((t.index ?? 0) - (hint.index ?? 0));
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
    // (The first sync's own question, if it's under way: store.ts openTabsAsked.)
    const asking: Promise<any[]> = openTabsAsked().catch(() => []);
    const open = Number.isFinite(deadline) ? await answerBy(asking, (deadline as number) - RESOLVE_LEAVES_MS) : await asking;
    if (!open) throw new Error('Safari didn\'t say which tabs are open in time');
    found = nearest(open);
  }
  if (!found) return null;
  console.info(`[margin] tab ${tabId} isn't one this copy of Margin knows: switching to tab ${found.id}, at the same address`);
  return found;
}

// Safari's answer to where a tab is, one question at a time per tab: a
// switch's lookup (resolveTab) and its own look at the tab (focusTab, before) share
// it, so a Safari slow to answer isn't asked twice in a row, the second
// queued behind the first. One unanswered for
// LOOKUP_REUSE_MS (a tab's hung process) isn't shared: the next switch to
// the tab asks again, not shown as it is for good behind a question that
// never answers.
const LOOKUP_REUSE_MS = 3000;
const lookups: Map<number, { asking: Promise<{ tab: any }>, at: number }> = new Map();
function lookupTab(tabId: number): Promise<{ tab: any }> {
  const under = lookups.get(tabId);
  if (under && Date.now() - under.at < LOOKUP_REUSE_MS) return under.asking;
  const asking: Promise<{ tab: any }> = Promise.resolve().then(() => api.tabs.get(tabId)).then((tab) => ({ tab: tab ?? null }), () => ({ tab: null }));
  lookups.set(tabId, { asking, at: Date.now() });
  void asking.then(() => { if (lookups.get(tabId)?.asking === asking) lookups.delete(tabId); });
  return asking;
}

// When Margin last opened a tab or window itself (extension/engines/webkit/safari/newtab-hint.ts
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
async function mayAccessCached(url: string | undefined) {
  let key;
  try {
    const { protocol, hostname } = new URL(url as string); // (none: it throws, caught: no access)
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
export async function mayAccess(url: string | undefined) {
  let pattern;
  try {
    const { protocol, hostname } = new URL(url as string); // (none: it throws, caught: no access)
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    pattern = `${protocol}//${hostname}/*`;
  } catch {
    return false;
  }
  return (await api.permissions?.contains({ origins: [pattern] }).catch(() => false)) ?? false;
}
// Tabs where a script found no page (inPage: 'asleep'): not asked again by
// the open-tab repair (runOpenTabRepair), nor taken as cut off, until the
// tab is shown (tabShown) or a tab event says its page changed (background.ts:
// its status or address).
const noPageFound: Set<number> = new Set();
export function pageChanged(tabId: number) {
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
// (`func` runs in the page: its arguments are `args`.)
export async function inPage<A extends any[]>(tabId: number, url: string | undefined, func: (...args: A) => unknown, args: A = [] as unknown as A, ms = 300) {
  if (!api.scripting?.executeScript || !(await mayAccessCached(url))) return 'unknown';
  let timer: number | undefined;
  const answer = await Promise.race([
    api.scripting.executeScript({ target: { tabId }, func, args }).then((r) => (ranAtAll(r) ? { result: r?.[0]?.result } : 'asleep'), () => 'asleep'),
    new Promise<any>((resolve) => { timer = setTimeout(() => resolve('unknown'), ms); }),
  ]);
  clearTimeout(timer);
  if (answer === 'asleep') noPageFound.add(tabId);
  return answer;
}
/** The open-tab repair found the tab with no page (Safari unloaded it), and nothing has said it has one since. */
export const foundWithNoPage = (tabId: number) => noPageFound.has(tabId);
/** A switch asked for or under way (sleeping tabs wait for it: background/sleep.ts). */
export const switchBusy = () => switchUnderWay() || anyFocusing();
// Whether a script ran at all (WebKit answers a view with no page with an error in place of a result).
const ranAtAll = (rows: any) => !(Array.isArray(rows) && rows.some((row) => row?.error));

// A tab shown: what was found of its page is asked again (it loads as it's
// shown, if it had none). A tab left: one found cut off while in front is
// loaded again now that it's behind (reloadBehind). A tab closed: forgotten.
export function tabShown(tabId: number) {
  noPageFound.delete(tabId);
}
export function tabLeft(tabId: number) {
  reloadBehind(tabId);
}
export function tabClosed(tabId: number) {
  tabShown(tabId);
  reloadWhenLeft.delete(tabId);
  cutOffLoadedAt.delete(tabId);
}

// `deadline`: when the page that asked stops waiting (it's then told it
// didn't happen: background.ts): no tab opens past REFUSE_MS before it.
// `index`: its place in the window's tab strip (the end if left out);
// `keptId`: the Margin tab that isn't open it opens (state/model.ts
// linkKept: the new tab is that Margin tab, its id, place and space).
export async function openTab({ windowId, url, spaceId, deadline, index, keptId }: { windowId?: number, url?: string, spaceId?: string, deadline?: number, index?: number, keptId?: string }) {
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
  if (keptId) noteReopened(url); // (an old search there isn't one made now)
  const tab = await api.tabs.create({ windowId, url, active: true, ...(Number.isInteger(index) && (index as number) >= 0 ? { index } : {}) });
  if (spaceId || keptId) {
    await mutate((s) => {
      let next = M.upsertTab(s, tab, now());
      if (keptId) next = M.linkKept(next, tab.id, keptId, now());
      return spaceId ? M.moveTab(next, tab.id, spaceId) : next;
    });
  }
  return tab;
}

// A page of the tab in front is told about a switch the background makes from
// it ('switching', then 'switch-done' or 'switch-failed': content/core.ts);
// Margin's own pages have no content script, so they hear it as a broadcast
// that says which page it's for (`from`).
// A switch under way, done or failed is told to Margin.app's overlay of the
// window too, while it draws the UI there (it highlights the tab: app/shared/host).
// `app: false`: the page only (the overlay was told already: navigation.ts
// tells it at the key press, with no page to name).
// A switch's `switchId`, `chain` and `seq` (a key's: navigation.ts) go to the
// overlay with it, so only that switch's word settles its highlight.
const APP_TOLD = new Set(['switching', 'switch-done', 'switch-failed']);
export function tellApp(windowId: number | null, message: any) {
  if (!APP_TOLD.has(message?.type) || !appLink.linked()) return false;
  const { type, tabId, switchId, chain, seq, reason } = message;
  return appLink.push(windowId, {
    type, tabId,
    ...(switchId != null ? { switchId: String(switchId) } : {}),
    ...(Number.isInteger(chain) ? { chain } : {}),
    ...(Number.isInteger(seq) ? { seq } : {}),
    ...(type === 'switch-failed' && reason ? { reason: String(reason) } : {}),
  });
}
export const tellPage = (page: { id: number, windowId?: number }, message: any, { app = true } = {}) => {
  if (app) tellApp(page.windowId ?? message.windowId ?? null, message);
  return api.tabs.sendMessage(page.id, message).catch(() => api.runtime.sendMessage(message).catch(() => {}));
};

// ---- a new tab chosen in the palette --------------------------------------------
// ⌘T, an address or a search, Enter: the tab opens behind the page the user
// is on, its row in the sidebar at once, highlighted (the overlay's switch
// highlight); once Safari says it has loaded, or LOADED_MAX_MS at most, it
// comes to the front with the plain switch (Safari's new tab is dark until
// the page arrives; this keeps the wait short without anything of the old
// paint watching, gone in Phase 2 step 8). If the user goes elsewhere
// meanwhile (another tab, their own tab's row), it stays behind, loading, as
// a ⌘-clicked link would. `then(tab)`: what loads it, after the row is in (a
// search: background/handlers.ts); else `url`.
const LOADED_MAX_MS = 1500;
// What bringing it to the front may take, within the page's deadline.
const FOCUS_MS = 1500;
const POLL_MS = 100;
/**
 * `deadline`: when the page that asked stops waiting. `created(tab)`: told
 * as soon as the tab exists. `label`: its row's title until it has its own.
 * */
export async function openBehind({ windowId, url, from, then, created, label, deadline, maxMs = LOADED_MAX_MS }: { windowId?: number | null, url?: string, from: any, then?: (tab: any) => Promise<unknown>, created?: (tab: any) => void, label?: string, deadline?: number, maxMs?: number }): Promise<{ tabId: number, shown: number | null }> {
  const asked = Date.now();
  const win = from.windowId ?? windowId; // the page's own window (the page's idea of it can be a guess)
  focusGen++; // a switch still waiting for its wake doesn't land after this
  const gen = movedOn(win);
  markMarginOpening();
  tooLate(deadline);
  const tab = await api.tabs.create({ windowId: win, url: then ? 'about:blank' : url, active: false });
  created?.(tab);
  // In the window's space (model.ts assignTab), drawn before the page is told.
  await mutate((s) => M.upsertTab(s, label && !tab.title ? { ...tab, title: label } : tab, now())).catch(() => {});
  const told = (type: string, reason: string | null = null) => tellPage(from, { type, tabId: tab.id, from: from.id, ...(reason ? { reason } : {}) });
  const notShown = (reason: string | null = null) => {
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
    return notShown(String((err as Error | undefined)?.message ?? err));
  }
  const until = Math.min(asked + maxMs, (deadline ?? Infinity) - FOCUS_MS);
  const loaded = await untilLoaded(tab.id, () => until, left, from.id);
  // Closed meanwhile, or the user went elsewhere (the page they were on
  // went somewhere else too): it stays where it is.
  if (loaded === 'gone' || loaded === 'moved') return notShown();
  if (loaded === 'left') return leftFor();
  try {
    await focusTab(tab.id, { source: `new tab (${loaded} after ${Date.now() - asked} ms)`, raise: false });
  } catch (err) {
    return notShown(String((err as Error | undefined)?.message ?? err));
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
async function untilLoaded(tabId: number, until: () => number, left: () => boolean, fromId: number | null): Promise<'loaded' | 'timeout' | 'gone' | 'left' | 'moved'> {
  const SLOW = Symbol('slow');
  const ask = (id: number) => {
    let timer: number | undefined;
    return Promise.race([
      Promise.resolve().then(() => api.tabs.get(id)).catch(() => null),
      new Promise<any>((resolve) => { timer = setTimeout(() => resolve(SLOW), Math.max(POLL_MS, until() - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
  };
  let sawLoading = false;
  let fromLoaded: boolean | null = null; // whether the page the user is on had loaded, when first seen
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
    if (Date.now() >= until()) return 'timeout';
    await new Promise<any>((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, until() - Date.now()))));
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
// takes the page over from the stale sidebar (content/core.ts). Each tab is
// checked once per run of the background.
const checkedCurrent = new Set<any>();
const checking = new Map(); // tabId → the check in flight (one at a time)
export function ensureCurrent(tabId: number) {
  if (!checking.has(tabId)) checking.set(tabId, checkCurrent(tabId).finally(() => checking.delete(tabId)));
  return checking.get(tabId);
}
async function checkCurrent(tabId: number) {
  if (checkedCurrent.has(tabId) || !api.scripting?.executeScript) return;
  const files = api.runtime.getManifest().content_scripts?.find((c: { world?: string, js?: string[] }) => c.world !== 'MAIN')?.js;
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (await repairOldOwnPage(tab)) return void checkedCurrent.add(tabId);
  if (!files?.length || !tab?.url || tab.discarded) return;
  // Its world still bound to a copy that's gone (background/cut-off.ts): no
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
export const forgetCurrent = (tabId: number) => {
  checkedCurrent.delete(tabId);
  boundHere.delete(tabId);
  cutOffSuspects.delete(tabId);
};

// ---- pages cut off from Margin (background/cut-off.ts) -----------------------
// This copy's address, as a page's world bound to it says it.
const ownAddress = api.runtime.getURL('');
// Tabs whose page's world was found bound to this copy (or to another copy
// still running: background/cut-off.ts): not asked again.
const boundHere = new Set<any>();
// When each tab was last loaded again for that.
const CUT_OFF_COOLDOWN_MS = 30000;
const cutOffLoadedAt = new Map();
// Loaded again one after another, a little apart (every page open when
// Margin was reloaded can be cut off).
const CUT_OFF_GAP_MS = 150;
const quietened = new Set<any>(); // said once per tab
// Tabs that may be cut off: found so but in use (put out of sight), or
// silent when asked. A switch to one asks again first (focusTab).
const cutOffSuspects = new Set<any>();
let cutOffLoads = Promise.resolve();
async function askCutOff(tabId: number, url: string | undefined, quiet: boolean, ms: number) {
  const answer = await inPage(tabId, url, cutOffInPage, [ownAddress, quiet, Object.values(commandKeys())], ms);
  return typeof answer === 'string' ? null : answer.result ?? null;
}
// A tab whose page is cut off: loaded again ('reloaded') when nothing in it
// would be lost, else its dead Margin put out of sight ('quiet', asked again
// the next time it's checked). False when it isn't cut off (or didn't say).
// `ms`: how long the page is waited for.
// Never the tab in front (2026-11-04): two of the six tabs shown in Safari's
// proof run right after an update were loaded again in front, about 0.75 s
// after Margin showed them (ensureCurrent, 300 ms after their activation),
// one in the middle of a key run: the old page's dead sidebar, then a page
// loading in front for half a second. One in front is put out of sight at
// once, as a page in use is, and loaded again once it's behind (reloadBehind:
// its next leave, asked again then, nothing in it to lose).
// Nor a tab a switch is under way to (`forSwitch`: focusTab's, or
// isFocusing): loaded then, the load would commit in front, the switch
// carrying a page load (review of 2026-11-04: a wake of a tab after an update
// makes it a suspect, and the switch to it loaded it again 150 ms before its
// show). Put out of sight in the same one script (while it's still hidden, as
// a rule), and loaded again once it's left, as one found in front.
export async function repairCutOff(tab: any, { ms = 1000, forSwitch = false }: { ms?: number, forSwitch?: boolean } = {}): Promise<'reloaded' | 'quiet' | false> {
  if (tab?.id == null || tab.discarded || boundHere.has(tab.id) || !/^https?:/i.test(tab.url ?? '')) return false;
  const probe = await askCutOff(tab.id, tab.url, forSwitch, ms);
  const action = cutOffAction(probe);
  if (action === 'none') {
    // (Not a tab with no page: it loads with this copy's scripts.)
    if (probe || noPageFound.has(tab.id)) {
      if (probe) boundHere.add(tab.id);
      cutOffSuspects.delete(tab.id);
    } else cutOffSuspects.add(tab.id);
    // Bound to an older copy Safari keeps running beside this one: its Margin
    // stood back, and loading it again would bind it to that copy again. In
    // front, the window's overlay says only quitting Safari finishes the
    // update (background/notices.ts; the page itself said it before Margin 2).
    if (probe?.otherCopy && (forSwitch || isFocusing(tab.id) || tab.active === true)) tellNotice(tab.windowId, 'updated-while-open', { tabId: tab.id, url: tab.url });
    return false;
  }
  // In front, or about to be (a switch to it), as Margin or Safari has it now
  // (the probe can take a while).
  const showing = () => forSwitch || isFocusing(tab.id);
  const inFront = action === 'reload' && (showing() || tab.active === true || (await api.tabs.get(tab.id).then((t) => t?.active === true, () => false)));
  if (inFront) reloadWhenLeft.add(tab.id);
  if (action === 'reload' && !inFront && Date.now() - (cutOffLoadedAt.get(tab.id) ?? 0) >= CUT_OFF_COOLDOWN_MS) {
    cutOffLoadedAt.set(tab.id, Date.now());
    reloadWhenLeft.delete(tab.id);
    const load = cutOffLoads.then(async () => {
      // (A switch to it started while this waited its turn: not now.)
      if (showing()) return null;
      // A GET of its address (a reload would send a form again); with a
      // #fragment, where that would only scroll, the browser's reload.
      const ok = await (tab.url.includes('#') ? api.tabs.reload(tab.id) : api.tabs.update(tab.id, { url: tab.url })).then(() => true, () => false);
      await new Promise<any>((resolve) => setTimeout(resolve, CUT_OFF_GAP_MS));
      return ok;
    });
    cutOffLoads = load.then(() => {});
    const loaded = await load;
    if (loaded) {
      cutOffSuspects.delete(tab.id);
      console.info(`[margin] tab ${tab.id} still had Margin from before it was reloaded: loaded again`);
      return 'reloaded';
    }
    if (loaded === null) {
      cutOffLoadedAt.delete(tab.id);
      reloadWhenLeft.add(tab.id);
    }
  }
  cutOffSuspects.add(tab.id);
  if (!forSwitch) await askCutOff(tab.id, tab.url, true, ms);
  // In front (or about to be): the window's overlay says Margin isn't
  // responding on this page and offers to reload it (background/notices.ts:
  // once a page; its Reload is handlers.ts noticeAction → reloadCutOff). A
  // page in use is reloaded only by the person; one that isn't, once it's
  // behind, by Margin (reloadBehind).
  const front = inFront || showing() || (await api.tabs.get(tab.id).then((t) => t?.active === true, () => false));
  if (front) tellNotice(tab.windowId, 'not-responding', { tabId: tab.id, url: tab.url });
  if (quietened.has(tab.id)) return 'quiet';
  quietened.add(tab.id);
  console.info(inFront || reloadWhenLeft.has(tab.id) ? `[margin] tab ${tab.id} still has Margin from before it was reloaded, and is in front: its sidebar is put away, and it's loaded again once it's behind` : `[margin] tab ${tab.id} still has Margin from before it was reloaded, and is in use: its sidebar is put away until it's loaded again`);
  return 'quiet';
}
// The person chose Reload on the window's notice that Margin isn't responding
// on a tab's page (handlers.ts noticeAction): loaded again now, in front or
// not, as repairCutOff loads one behind (a GET of its address; with a
// #fragment the browser's reload). Whether it was.
export async function reloadCutOff(tabId: number) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/i.test(tab.url ?? '')) return false;
  cutOffLoadedAt.set(tab.id, Date.now());
  reloadWhenLeft.delete(tab.id);
  // (Its url: checked above.)
  const ok = await (tab.url!.includes('#') ? api.tabs.reload(tab.id) : api.tabs.update(tab.id, { url: tab.url })).then(() => true, () => false);
  if (!ok) return false;
  cutOffSuspects.delete(tab.id);
  quietened.delete(tab.id);
  console.info(`[margin] tab ${tab.id} loaded again from the notice that Margin wasn't responding there`);
  return true;
}
// Cut off and in front when found (repairCutOff): loaded again once left.
const reloadWhenLeft: Set<number> = new Set();
// How long after the tab was left (another tab's activation in its window)
// its load behind waits, at least: the switch away has landed, and no switch
// is under way (giveWay) when it goes.
const RELOAD_BEHIND_MS = 300;
function reloadBehind(tabId: number) {
  if (!reloadWhenLeft.delete(tabId)) return;
  setTimeout(async () => {
    if (!isOwner()) return;
    await giveWay();
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab || tab.discarded) return;
    // In front again meanwhile: next time it's left.
    if (tab.active || isFocusing(tabId)) return void reloadWhenLeft.add(tabId);
    await repairCutOff(tab);
  }, RELOAD_BEHIND_MS);
}
// A tab showing Margin's new-tab page from a copy that's gone (background/
// cut-off.ts oldOwnPageAddress): sent to this copy's. Whether it was. Also a
// tab an earlier build left on Margin's sleep page (leftOnSleepPage).
async function repairOldOwnPage(tab: BrowserTab | null | undefined) {
  if (await leftOnSleepPage(tab)) return true;
  const to = oldOwnPageAddress(tab?.url, ownAddress);
  if (tab?.id == null || !to || Date.now() - (cutOffLoadedAt.get(tab.id) ?? 0) < CUT_OFF_COOLDOWN_MS) return false;
  cutOffLoadedAt.set(tab.id, Date.now());
  const ok = await api.tabs.update(tab.id, { url: to }).then(() => true, () => false);
  if (ok) console.info(`[margin] tab ${tab.id} still had the new-tab page of Margin from before it was reloaded: loaded again`);
  return ok;
}
// A tab on Margin's sleep page, where builds before Margin 2 Phase 2 step 1 put sleeping tabs
// (shared/sleep.ts oldSleepPage). That page is gone (Phase 3), so its address
// opens nothing: found as Margin starts after the update (the open-tab
// repair) or as the tab comes to the front, it's handled once. Hidden, it's
// what sleep is now: its browser tab closed, its Margin tab kept, not open,
// in its space (closing.ts 'keep', as a tab put to sleep: state/model.ts
// keeps it by its page's address, seenTab). In front, it's loaded at its
// page's address. One whose sleep page names no web address is left as it
// is. Whether it was handled.
async function leftOnSleepPage(tab: BrowserTab | null | undefined) {
  const page = oldSleepPage(tab?.url);
  if (tab?.id == null || !page?.url || Date.now() - (cutOffLoadedAt.get(tab.id) ?? 0) < CUT_OFF_COOLDOWN_MS) return false;
  cutOffLoadedAt.set(tab.id, Date.now());
  if (tab.active || isFocusing(tab.id)) {
    const ok = await Promise.resolve(api.tabs.update(tab.id, { url: page.url })).then(() => true, () => false);
    if (ok) console.info(`[margin] tab ${tab.id} was on the sleep page of an earlier Margin, in front: loaded at its address`);
    return ok;
  }
  noteClosing([tab.id], 'keep', 'sleep');
  const ok = await Promise.resolve(api.tabs.remove(tab.id)).then(() => true, () => false);
  if (!ok) takeClosing(tab.id);
  else console.info(`[margin] tab ${tab.id} was on the sleep page of an earlier Margin: closed, kept as its Margin tab (asleep)`);
  return ok;
}

// Pages already open when Margin is installed, updated, or Safari starts a
// fresh session. WebKit normally adds the content scripts itself, but may do
// so seconds late on a cold launch. Repair immediately from the background,
// then retry pages that were busy or whose permission was not ready yet.
// Sleeping tabs are deliberately skipped; ensureCurrent repairs one when it
// is first shown.
// A tab found with no page (noPageFound: Safari unloaded it, and every tab
// after a relaunch) isn't asked again, by this pass or the next, until it's
// shown or its page changes: once it loads it runs this copy anyway. (Each
// was asked twice per pass, over four passes: about 450 failing scripts in
// the first five minutes after a relaunch in real Safari, 2026-11-03.)
// A few tabs at a time, the one in front of each window first, and none
// while a switch is under way (switchUnderWay: asked for, or in focusTab):
// all at once, the repair's scripts queued ahead of the switch's own calls
// in Safari, and after that relaunch five clicks in a row never started a
// switch (each one's request reached focusTab with under 1 s of its page's
// 7 s left: 'expired', stuck 'before').
const REPAIR_RETRY_MS = [350, 1200, 3000];
const REPAIR_AT_ONCE = 2;
const GIVE_WAY_POLL_MS = 50;
let repairOpenTabs: Promise<void> | null = null;
export function injectIntoOpenTabs({ retry = true }: { retry?: boolean } = {}) {
  if (!repairOpenTabs) {
    repairOpenTabs = runOpenTabRepair(retry).finally(() => { repairOpenTabs = null; });
  }
  return repairOpenTabs;
}
async function giveWay() {
  const until = Date.now() + SWITCH_HOLDS_MS;
  while (switchUnderWay() && Date.now() < until) await new Promise<any>((resolve) => setTimeout(resolve, GIVE_WAY_POLL_MS));
}

async function runOpenTabRepair(retry: boolean) {
  // The sidebar's entry, whatever the build named its file.
  const files = api.runtime.getManifest().content_scripts?.find((c: { world?: string, js?: string[] }) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript) return;
  const delays = [0, ...(retry ? REPAIR_RETRY_MS : [])];
  const done = (tab: any) => tab.discarded || checkedCurrent.has(tab.id) || !/^https?:/i.test(tab.url ?? '');
  for (const [pass, delay] of delays.entries()) {
    if (delay) await new Promise<any>((resolve) => setTimeout(resolve, delay));
    const passStart = Date.now();
    let gaveWay = 0;
    const yielded = async () => {
      const from = Date.now();
      await giveWay();
      gaveWay += Date.now() - from;
    };
    await yielded();
    const tabs = await api.tabs.query({}).catch((): BrowserTab[] => []);
    const left = tabs.filter((tab) => !checkedCurrent.has(tab.id) && !noPageFound.has(tab.id)).sort((a, b) => Number(!!b.active) - Number(!!a.active));
    // The tabs this pass asked, and found with no page (its line in Margin.app's log).
    const counts = { asked: 0, noPage: 0 };
    const one = async (tab: any) => {
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
      const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, files }).then(() => true, () => false);
      if (injected) checkedCurrent.add(tab.id);
    };
    await Promise.all(Array.from({ length: REPAIR_AT_ONCE }, async () => {
      for (let tab = left.shift(); tab; tab = left.shift()) {
        await yielded();
        await one(tab);
      }
    }));
    appLog(`the open-tab repair, pass ${pass}: ${tabs.length} tabs, ${counts.asked} asked, ${counts.noPage} with no page, ${Date.now() - passStart} ms (${gaveWay} ms giving way to switches)`);
    // (A tab with no page keeps the passes going: it may load meanwhile, the
    // tab in front at a relaunch most of all, and is then asked again.)
    if (tabs.every(done)) return;
  }
}
