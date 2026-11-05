// Which tabs are loading, for Margin.app's sidebar (Margin 2 Phase 2 step 7):
// what pages drew as their own load pill before step 5, the app draws from
// this (the view model's `loading`, its rows' and the tab in front's). Three
// signs, any one of them:
//  - the tab's status (tabs.onUpdated 'loading', until 'complete'): a load
//    the browser sees, including one started from Safari's own UI;
//  - the page being left ('leaving'): its `beforeunload`, told by Margin's
//    script in the page (content/loads.js) at once, long before the next
//    page commits and Safari says the tab is loading (the server's response
//    time); taken back if the page stays (a "Leave page?" prompt, a
//    download, input on the page);
//  - a site's own same-page navigation taking a while ('navigating': the
//    Navigation API's transitions), which the browser doesn't count as a load.
// Each lasts at most MAX_MS (a page that never says it's done). Not written
// to storage (every write reaches every page): pushed to the window's
// overlay as the set of its tabs loading (app/PROTOCOL.md `push` `loading`),
// a moment after it changes, and again for every window when the link comes.
import { appLink } from './app-link.js';

export const MAX_MS = { status: 15_000, leaving: 10_000, navigating: 15_000 };
// The link the sets go on (tests put a stand-in: useLinkForTests).
/** @type {{ push: (windowId: number | null, msg: any) => boolean }} */
let link = appLink;
/** @param {typeof link} stand */
export const useLinkForTests = (stand) => { link = stand; };
const PUSH_MS = 16;
/** @typedef {'status' | 'leaving' | 'navigating'} LoadSign */

/** @type {Map<number, { windowId: number | null, signs: Map<LoadSign, number> }>} tab → its window, and each sign until when */
const tabs = new Map();
/** @type {Map<number | null, string>} window → what it was last told */
const told = new Map();
const dirty = new Set();
let pushTimer = null;
let expiry = null;

const loadingIn = (/** @type {number | null} */ windowId, now = Date.now()) => [...tabs].filter(([, t]) => t.windowId === windowId && [...t.signs.values()].some((until) => until > now)).map(([id]) => id).sort((a, b) => a - b);

function changed(/** @type {number | null} */ windowId) {
  dirty.add(windowId);
  pushTimer ??= setTimeout(flush, PUSH_MS);
  expireLater();
}
function flush() {
  pushTimer = null;
  const now = Date.now();
  for (const windowId of dirty) {
    const ids = loadingIn(windowId, now);
    const json = JSON.stringify(ids);
    if (told.get(windowId) === json) continue;
    if (link.push(windowId, { type: 'loading', tabIds: ids })) told.set(windowId, json);
    else told.delete(windowId);
  }
  dirty.clear();
  // Signs past their time go.
  for (const [id, t] of tabs) {
    for (const [sign, until] of t.signs) if (until <= now) t.signs.delete(sign);
    if (!t.signs.size) tabs.delete(id);
  }
}
// The soonest sign to run out: its window told again then.
function expireLater() {
  clearTimeout(expiry);
  let soonest = Infinity;
  for (const t of tabs.values()) for (const until of t.signs.values()) soonest = Math.min(soonest, until);
  if (soonest === Infinity) return;
  expiry = setTimeout(() => {
    expiry = null;
    for (const t of tabs.values()) dirty.add(t.windowId);
    flush();
    expireLater();
  }, Math.max(0, soonest - Date.now()) + 5);
}
/** @param {number} tabId @param {number | null} windowId @param {LoadSign} sign @param {boolean} on */
function mark(tabId, windowId, sign, on) {
  if (!Number.isInteger(tabId)) return;
  let t = tabs.get(tabId);
  if (!on && !t?.signs.has(sign)) return;
  if (!t) tabs.set(tabId, (t = { windowId: windowId ?? null, signs: new Map() }));
  const before = t.windowId;
  if (windowId != null) t.windowId = windowId;
  if (on) t.signs.set(sign, Date.now() + MAX_MS[sign]);
  else t.signs.delete(sign);
  if (before !== t.windowId) changed(before);
  changed(t.windowId);
}

/** tabs.onUpdated: its status. A load done ends the page's leaving too (the next page is here). @param {any} tab @param {string | undefined} status */
export function statusChanged(tab, status) {
  if (tab?.id == null || !status) return;
  if (status === 'loading') return mark(tab.id, tab.windowId ?? null, 'status', true);
  if (status === 'complete') {
    mark(tab.id, tab.windowId ?? null, 'leaving', false);
    mark(tab.id, tab.windowId ?? null, 'status', false);
  }
}

/** What the page in the tab said (handlers.js pageLoading). @param {number} tabId @param {number | null} windowId @param {boolean} on @param {unknown} why */
export function pageSaid(tabId, windowId, on, why) {
  const sign = why === 'navigating' ? 'navigating' : why === 'leaving' ? 'leaving' : null;
  if (sign) mark(tabId, windowId, sign, !!on);
}

/** A tab closed, or moved to another window (its window then). @param {number} tabId @param {number | null} [windowId] */
export function tabMoved(tabId, windowId = null) {
  const t = tabs.get(tabId);
  if (!t) return;
  const before = t.windowId;
  if (windowId == null) tabs.delete(tabId);
  else t.windowId = windowId;
  changed(before);
  if (windowId != null) changed(windowId);
}

/** The link came (again): every window told what's loading in it, even nothing (an overlay kept from before may show a load that ended meanwhile). @param {Iterable<number>} [windowIds] */
export function tellAll(windowIds = []) {
  told.clear();
  for (const id of windowIds) dirty.add(id);
  for (const t of tabs.values()) dirty.add(t.windowId);
  if (dirty.size) pushTimer ??= setTimeout(flush, PUSH_MS);
}

/** The window's tabs loading now (tests, diagnostics). @param {number | null} windowId */
export const loadingTabs = (windowId) => loadingIn(windowId);

/** For tests: nothing loading, nothing told. */
export function resetLoads() {
  tabs.clear();
  told.clear();
  dirty.clear();
  clearTimeout(pushTimer);
  clearTimeout(expiry);
  pushTimer = expiry = null;
}
